/**
 * UVoz — widget de suporte (conteúdo do iframe).
 *
 * Carregado por loader.js dentro da aplicação do cliente. A página hospedeira envia
 * o identificador do aplicativo e o token assinado da conta por postMessage; o token
 * nunca vai na URL.
 *
 * No site público (visitantes sem conta) não há token assinado: o visitante informa nome e
 * WhatsApp e escreve a primeira mensagem (POST /api/widget/visitors), e recebe uma chave que
 * passa a valer como token. A página hospedeira guarda essa chave para as próximas visitas.
 *
 * Contrato com o servidor (namespace "/widget" do Socket.io, auth { app, token }):
 *
 *   servidor -> widget
 *     init                  { contact: { name }, team: { name, online, hours }, topics: [string],
 *                             features: { attachments }, messages: [Mensagem], hasMore, lastReadId }
 *     message:new           Mensagem
 *     typing                { name }
 *     team:updated          { online, hours }
 *
 *   widget -> servidor (com confirmação)
 *     message:send          { text, attachmentIds, clientId }  -> { message } | { error }
 *     messages:get          { before }                         -> { messages, hasMore } | { error }
 *
 *   widget -> servidor (sem confirmação)
 *     typing                {}
 *     read:mark             { messageId }
 *
 *   Mensagem: { id, from: 'contact' | 'agent' | 'system', author: { name } | null, text, ts,
 *               clientId?, attachments: [{ id, name, size, type }] }
 *
 *   Recusa de conexão (connect_error.message): TOKEN_EXPIRADO, TOKEN_INVALIDO, APP_INVALIDO.
 *
 *   Visitantes do site: GET /api/widget/apps/:app -> { team } (antes de se identificar);
 *   POST /api/widget/visitors { app, name, phone, email, message, source } -> { token } | { error }.
 *
 *   Anexos: POST /api/widget/attachments (corpo binário, cabeçalhos Authorization: Bearer <token>,
 *   X-Widget-App e X-File-Name) -> { attachment }; GET /api/widget/attachments/:id com os mesmos
 *   cabeçalhos de autenticação. Resposta 401 com { code: 'TOKEN_EXPIRADO' } pede um token novo.
 *
 *   O lado do servidor está em server.js (seção "Widget de suporte") e lib/support.js.
 */
(() => {
  'use strict';

  const DEMO = new URLSearchParams(location.search).get('demo');
  const MAX_FILES = 5;
  const MAX_TOTAL_SIZE = 10 * 1024 * 1024;
  const GROUP_WINDOW_MS = 5 * 60 * 1000;

  const $ = (id) => document.getElementById(id);
  const ui = {
    title: $('title'), status: $('status'), statusText: $('status-text'), close: $('close'), banner: $('banner'),
    scroll: $('scroll'), older: $('older'), welcome: $('welcome'), welcomeTitle: $('welcome-title'),
    welcomeText: $('welcome-text'), topics: $('topics'), list: $('messages'), typing: $('typing'),
    typingText: $('typing-text'), jump: $('jump'), composer: $('composer'), staged: $('staged'),
    attach: $('attach'), input: $('input'), send: $('send'), file: $('file'),
    lead: $('lead'), leadText: $('lead-text'), leadName: $('lead-name'), leadPhone: $('lead-phone'),
    leadEmail: $('lead-email'), leadMessage: $('lead-message'), leadError: $('lead-error'), leadSubmit: $('lead-submit'),
  };

  const state = {
    open: false, ready: false, connected: false, fatal: false,
    identifying: false, // visitante do site preenchendo nome e contato, antes de a conversa existir
    teamKnown: false, // o nome e a situação da equipe já chegaram do servidor
    contact: null, team: { name: 'Suporte', online: false, hours: null },
    features: { attachments: false }, topics: [],
    messages: [], hasMore: false, lastReadId: 0, unread: 0,
    staged: [],
  };
  let transport = null;
  let visitorApi = null;
  let config = null;
  let parentOrigin = null;
  let booted = false;

  // ---------------------------------------------------------------------------
  // Utilidades
  // ---------------------------------------------------------------------------
  function el(tag, props, ...children) {
    const node = document.createElement(tag);
    if (props) Object.assign(node, props);
    node.append(...children.filter((c) => c != null));
    return node;
  }

  function icon(path, viewBox = '0 0 24 24') {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', viewBox);
    svg.setAttribute('aria-hidden', 'true');
    const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    p.setAttribute('d', path);
    svg.append(p);
    return svg;
  }

  const timeFormat = new Intl.DateTimeFormat('pt-BR', { hour: '2-digit', minute: '2-digit' });
  const dayFormat = new Intl.DateTimeFormat('pt-BR', { day: 'numeric', month: 'long' });
  const dayYearFormat = new Intl.DateTimeFormat('pt-BR', { day: 'numeric', month: 'long', year: 'numeric' });
  const fullFormat = new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short' });
  const dayKey = (ts) => { const d = new Date(ts); return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`; };

  function dayLabel(ts) {
    const now = new Date();
    if (dayKey(ts) === dayKey(now)) return 'Hoje';
    if (dayKey(ts) === dayKey(now.getTime() - 24 * 3600 * 1000)) return 'Ontem';
    return (new Date(ts).getFullYear() === now.getFullYear() ? dayFormat : dayYearFormat).format(ts);
  }

  function formatSize(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(1).replace('.', ',')} MB`;
  }

  /** Escreve o texto no elemento, transformando endereços http(s) em links. */
  function linkify(node, text) {
    const pattern = /https?:\/\/[^\s<]+[^\s<.,;:!?)\]}'"]/g;
    let last = 0;
    for (const match of String(text || '').matchAll(pattern)) {
      node.append(text.slice(last, match.index));
      node.append(el('a', { href: match[0], target: '_blank', rel: 'noopener noreferrer', textContent: match[0] }));
      last = match.index + match[0].length;
    }
    node.append(String(text || '').slice(last));
  }

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const s = el('script', { src, onload: resolve, onerror: () => reject(new Error(`Falha ao carregar ${src}`)) });
      document.head.append(s);
    });
  }

  const post = (message) => { if (parentOrigin) window.parent.postMessage(message, parentOrigin); };

  let demoScript = null;
  const loadDemo = () => (demoScript = demoScript || loadScript('demo-transport.js'));

  // ---------------------------------------------------------------------------
  // Visitantes do site (HTTP, antes de existir uma conversa)
  // ---------------------------------------------------------------------------
  const offline = () => { throw new Error('Sem conexão. Tente de novo em instantes.'); };
  const httpVisitorApi = {
    async info(app) {
      const res = await fetch(`/api/widget/apps/${encodeURIComponent(app)}`);
      if (!res.ok) throw new Error('Chat indisponível.');
      return res.json();
    },
    async create(lead) {
      const res = await fetch('/api/widget/visitors', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(lead),
      }).catch(offline);
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.token) throw new Error(data.error || 'Não foi possível enviar. Tente de novo.');
      return data;
    },
  };

  // ---------------------------------------------------------------------------
  // Transporte real (Socket.io)
  // ---------------------------------------------------------------------------
  function socketTransport(config) {
    const handlers = new Map();
    const fire = (event, payload) => (handlers.get(event) || []).forEach((fn) => fn(payload));
    const authHeaders = () => ({ Authorization: `Bearer ${config.token}`, 'X-Widget-App': config.app });
    let socket = null;
    let retryTimer = null;
    let tokenWaiters = [];

    const retryLater = () => {
      clearTimeout(retryTimer);
      retryTimer = setTimeout(() => socket.connect(), 5000);
    };
    /** Pede um token novo à página e espera por ele (setToken) por alguns segundos. */
    const freshToken = () => new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Sua sessão expirou. Recarregue a página.')), 8000);
      tokenWaiters.push(() => { clearTimeout(timer); resolve(); });
      fire('token:expired');
    });
    const sendFile = (file) => fetch('/api/widget/attachments', {
      method: 'POST',
      headers: { ...authHeaders(), 'Content-Type': 'application/octet-stream', 'X-File-Name': encodeURIComponent(file.name) },
      body: file,
    });

    return {
      on(event, fn) { handlers.set(event, [...(handlers.get(event) || []), fn]); },

      start() {
        loadScript('/vendor/socket.io/socket.io.min.js').then(() => {
          socket = window.io('/widget', { auth: (cb) => cb({ app: config.app, token: config.token }) });
          socket.on('connect', () => fire('status', { connected: true }));
          socket.on('disconnect', (reason) => {
            fire('status', { connected: false });
            if (reason === 'io server disconnect') retryLater(); // o Socket.io não reconecta sozinho neste caso
          });
          socket.on('connect_error', (err) => {
            fire('status', { connected: false });
            if (err.message === 'TOKEN_EXPIRADO') return fire('token:expired');
            if (err.message === 'TOKEN_INVALIDO' || err.message === 'APP_INVALIDO') return fire('fatal', { code: err.message });
            // Recusa pelo servidor não dispara a reconexão automática do Socket.io.
            if (!socket.active) retryLater();
          });
          for (const event of ['init', 'message:new', 'typing', 'team:updated']) {
            socket.on(event, (payload) => fire(event, payload));
          }
        }).catch(() => fire('fatal', { code: 'CARREGAMENTO' }));
      },

      setToken(token) {
        config.token = token;
        tokenWaiters.splice(0).forEach((resume) => resume());
        if (socket && !socket.connected) socket.connect();
      },

      request(event, payload) {
        return new Promise((resolve) => {
          if (!socket || !socket.connected) return resolve({ error: 'Sem conexão. Tente de novo em instantes.' });
          socket.timeout(15000).emit(event, payload, (err, res) => {
            resolve(err ? { error: 'O servidor não respondeu. Tente de novo.' } : (res || { ok: true }));
          });
        });
      },

      notify(event, payload) { if (socket && socket.connected) socket.emit(event, payload); },

      async upload(file) {
        let res = await sendFile(file);
        let data = await res.json().catch(() => ({}));
        if (res.status === 401 && data.code === 'TOKEN_EXPIRADO') {
          await freshToken();
          res = await sendFile(file);
          data = await res.json().catch(() => ({}));
        }
        if (!res.ok || !data.attachment) throw new Error(data.error || 'Não foi possível enviar o arquivo.');
        return data.attachment;
      },

      async fileBlob(attachment) {
        const res = await fetch(`/api/widget/attachments/${encodeURIComponent(attachment.id)}`, { headers: authHeaders() });
        if (!res.ok) throw new Error('Arquivo indisponível.');
        return res.blob();
      },
    };
  }

  // ---------------------------------------------------------------------------
  // Cabeçalho, avisos e boas-vindas
  // ---------------------------------------------------------------------------
  function renderStatus() {
    let text = 'Conectando…';
    if (state.teamKnown) {
      text = state.team.online ? 'Online agora' : (state.team.hours || 'Respondemos assim que possível');
      ui.title.textContent = state.team.name;
      document.title = state.team.name;
    }
    ui.statusText.textContent = text;
    ui.status.classList.toggle('is-online', state.teamKnown && !!state.team.online);
  }

  function setTeam(team) {
    state.team = { ...state.team, ...(team || {}) };
    state.teamKnown = true;
    renderStatus();
  }

  let flashTimer = null;
  function renderBanner(flash) {
    clearTimeout(flashTimer);
    let text = '';
    let error = false;
    if (state.fatal) { text = state.fatal; error = true; }
    else if (flash) { text = flash; flashTimer = setTimeout(() => renderBanner(), 5000); }
    else if (state.ready && !state.connected) text = 'Sem conexão. Tentando reconectar…';
    ui.banner.textContent = text;
    ui.banner.hidden = !text;
    ui.banner.classList.toggle('is-error', error);
  }

  function renderComposerState() {
    const usable = state.ready && !state.fatal;
    ui.composer.hidden = state.identifying;
    ui.input.disabled = !usable;
    ui.attach.hidden = !state.features.attachments;
    ui.attach.disabled = !usable;
    ui.send.disabled = !usable || (!ui.input.value.trim() && !state.staged.length);
  }

  function renderWelcome() {
    const empty = state.ready && !state.messages.length;
    ui.welcome.hidden = !empty;
    if (!empty) return;
    const first = String(state.contact?.name || '').trim().split(/\s+/)[0];
    ui.welcomeTitle.textContent = first ? `Olá, ${first}. Como podemos ajudar?` : 'Olá. Como podemos ajudar?';
    ui.welcomeText.textContent = state.team.online
      ? 'Escreva sua dúvida e nossa equipe responde por aqui.'
      : 'Deixe sua mensagem. Nossa equipe responde por aqui assim que voltar.';
    ui.topics.replaceChildren(...state.topics.map((topic) => el('button', {
      type: 'button', className: 'w-topic', textContent: topic, onclick: () => sendMessage(topic, []),
    })));
    ui.topics.hidden = !state.topics.length;
  }

  // ---------------------------------------------------------------------------
  // Lista de mensagens
  // ---------------------------------------------------------------------------
  const nearBottom = () => ui.scroll.scrollHeight - ui.scroll.scrollTop - ui.scroll.clientHeight < 60;
  const scrollToBottom = () => { ui.scroll.scrollTop = ui.scroll.scrollHeight; };

  function fileNode(message, attachment) {
    const blob = () => (attachment.file ? Promise.resolve(attachment.file) : transport.fileBlob(attachment));
    if (String(attachment.type || '').startsWith('image/')) {
      const img = el('img', { alt: attachment.name, loading: 'lazy' });
      const button = el('button', { type: 'button', className: 'm-image', title: 'Abrir imagem' }, img);
      button.setAttribute('aria-label', `Abrir imagem ${attachment.name}`);
      blob().then((data) => {
        const url = URL.createObjectURL(data);
        img.src = url;
        button.onclick = () => window.open(url, '_blank', 'noopener');
      }).catch(() => button.replaceWith(el('span', { className: 'm-file', textContent: 'Imagem indisponível' })));
      return button;
    }
    const button = el('button', { type: 'button', className: 'm-file', title: 'Baixar arquivo' },
      icon('M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8zM14 3v5h5'),
      el('span', null,
        el('span', { className: 'm-file-name', textContent: attachment.name }),
        el('span', { className: 'm-file-size', textContent: formatSize(attachment.size || 0) })));
    button.onclick = () => blob().then((data) => {
      const url = URL.createObjectURL(data);
      el('a', { href: url, download: attachment.name }).click();
      setTimeout(() => URL.revokeObjectURL(url), 30000);
    }).catch(() => renderBanner('Não foi possível baixar o arquivo.'));
    return button;
  }

  function messageNode(message) {
    if (message.from === 'system') return el('li', { className: 'm-system', textContent: message.text });

    const mine = message.from === 'contact';
    const li = el('li', { className: `m ${mine ? 'm-me' : 'm-agent'}` });
    li.dataset.group = mine ? 'me' : `agent:${message.author?.name || ''}`;
    li.dataset.ts = message.ts;

    if (!mine) {
      li.append(el('div', { className: 'm-author' },
        el('strong', { textContent: message.author?.name || state.team.name }), ` · ${timeFormat.format(message.ts)}`));
    }
    const bubble = el('div', { className: 'm-bubble', title: fullFormat.format(message.ts) });
    linkify(bubble, message.text);
    li.append(bubble);

    if (message.attachments?.length) {
      li.append(el('div', { className: 'm-files' }, ...message.attachments.map((a) => fileNode(message, a))));
    }

    if (mine) {
      const foot = el('div', { className: 'm-foot' });
      if (message.state === 'pending') {
        li.classList.add('is-pending');
        foot.textContent = 'Enviando…';
      } else if (message.state === 'failed') {
        li.classList.add('is-failed');
        foot.append(`${message.error || 'Não enviada.'} `,
          el('button', { type: 'button', className: 'm-retry', textContent: 'Tentar de novo', onclick: () => deliver(message) }));
      } else {
        foot.textContent = timeFormat.format(message.ts);
      }
      li.append(foot);
    }
    return li;
  }

  /** Marca o início e o fim de cada sequência de mensagens do mesmo autor. */
  function refreshGroups() {
    const items = [...ui.list.children];
    const sameGroup = (a, b) => a && b && a.classList.contains('m') && b.classList.contains('m')
      && a.dataset.group === b.dataset.group && Math.abs(Number(b.dataset.ts) - Number(a.dataset.ts)) < GROUP_WINDOW_MS;
    items.forEach((item, i) => {
      if (!item.classList.contains('m')) return;
      item.classList.toggle('is-first', !sameGroup(items[i - 1], item));
      item.classList.toggle('is-last', !sameGroup(item, items[i + 1]));
    });
  }

  function renderMessages() {
    const nodes = [];
    let lastDay = null;
    for (const message of state.messages) {
      const day = dayKey(message.ts);
      if (day !== lastDay) {
        nodes.push(el('li', { className: 'w-day', textContent: dayLabel(message.ts) }));
        lastDay = day;
      }
      const node = messageNode(message);
      node.dataset.id = message.id;
      nodes.push(node);
    }
    ui.list.replaceChildren(...nodes);
    refreshGroups();
    ui.older.hidden = !state.hasMore;
    renderWelcome();
  }

  function appendMessage(message) {
    const previous = state.messages[state.messages.length - 1];
    state.messages.push(message);
    if (!previous || dayKey(previous.ts) !== dayKey(message.ts)) {
      ui.list.append(el('li', { className: 'w-day', textContent: dayLabel(message.ts) }));
    }
    const node = messageNode(message);
    node.dataset.id = message.id;
    ui.list.append(node);
    refreshGroups();
    renderWelcome();
  }

  function replaceMessage(index, message) {
    const old = state.messages[index];
    state.messages[index] = message;
    const current = [...ui.list.children].find((n) => n.dataset.id === String(old.id));
    if (!current) return renderMessages();
    const node = messageNode(message);
    node.dataset.id = message.id;
    current.replaceWith(node);
    refreshGroups();
  }

  // ---------------------------------------------------------------------------
  // Leitura e não lidas
  // ---------------------------------------------------------------------------
  const isWatching = () => state.open && !document.hidden && nearBottom();

  function previewOf(message) {
    if (!message) return null;
    const text = message.text || (message.attachments?.length ? 'Enviou um arquivo' : '');
    return { name: message.author?.name || state.team.name, text: text.slice(0, 160) };
  }

  function markRead() {
    const last = [...state.messages].reverse().find((m) => typeof m.id === 'number');
    if (last && last.id > state.lastReadId) {
      state.lastReadId = last.id;
      transport.notify('read:mark', { messageId: last.id });
    }
    if (state.unread) {
      state.unread = 0;
      post({ type: 'uvoz:unread', count: 0 });
    }
    ui.jump.hidden = true;
  }

  function setOpen(open) {
    state.open = open;
    if (open && state.identifying && window.matchMedia('(pointer: fine)').matches) ui.leadName.focus();
    if (!open || !state.ready) return;
    scrollToBottom();
    markRead();
    if (window.matchMedia('(pointer: fine)').matches) ui.input.focus();
  }

  // ---------------------------------------------------------------------------
  // Eventos do servidor
  // ---------------------------------------------------------------------------
  function onInit(data) {
    // Mensagens que ainda não foram confirmadas continuam na tela após uma reconexão.
    const serverMessages = Array.isArray(data.messages) ? data.messages : [];
    const confirmed = new Set(serverMessages.map((m) => m.clientId).filter(Boolean));
    const unsent = state.messages.filter((m) => m.state && !confirmed.has(m.clientId));

    state.ready = true;
    state.connected = true;
    state.contact = data.contact || null;
    setTeam(data.team);
    state.features = { attachments: !!data.features?.attachments };
    state.topics = Array.isArray(data.topics) ? data.topics.slice(0, 6).map(String) : [];
    state.hasMore = !!data.hasMore;
    state.lastReadId = Number(data.lastReadId) || 0;
    state.messages = [...serverMessages, ...unsent];

    renderBanner();
    renderComposerState();
    renderMessages();
    scrollToBottom();

    const unreadMessages = serverMessages.filter((m) => m.from === 'agent' && m.id > state.lastReadId);
    state.unread = unreadMessages.length;
    if (isWatching()) markRead();
    else post({ type: 'uvoz:unread', count: state.unread, preview: previewOf(unreadMessages[unreadMessages.length - 1]) });
    if (state.open && window.matchMedia('(pointer: fine)').matches) ui.input.focus();
  }

  function onMessageNew(message) {
    if (!message || state.messages.some((m) => m.id === message.id)) return;
    const pendingIndex = message.clientId
      ? state.messages.findIndex((m) => m.state && m.clientId === message.clientId) : -1;
    if (pendingIndex !== -1) return replaceMessage(pendingIndex, message);

    const stick = nearBottom();
    if (message.from === 'agent') hideTyping();
    appendMessage(message);
    if (stick) scrollToBottom();
    if (message.from === 'contact') return;

    if (isWatching()) return markRead();
    if (message.from === 'agent') {
      state.unread += 1;
      post({ type: 'uvoz:unread', count: state.unread, preview: previewOf(message) });
    }
    if (state.open && !stick) ui.jump.hidden = false;
  }

  let typingTimer = null;
  function hideTyping() { clearTimeout(typingTimer); ui.typing.hidden = true; }
  function onTyping(data) {
    const stick = nearBottom();
    ui.typingText.textContent = `${data?.name || state.team.name} está digitando…`;
    ui.typing.hidden = false;
    if (stick) scrollToBottom();
    clearTimeout(typingTimer);
    typingTimer = setTimeout(hideTyping, 4000);
  }

  function onFatal(code) {
    state.fatal = code === 'CARREGAMENTO'
      ? 'Não foi possível abrir o chat. Recarregue a página para tentar de novo.'
      : 'Sua sessão expirou. Recarregue a página para continuar a conversa.';
    renderBanner();
    renderComposerState();
    renderStatus();
  }

  let tokenTimer = null;
  function requestToken() {
    post({ type: 'uvoz:token' });
    clearTimeout(tokenTimer);
    tokenTimer = setTimeout(() => onFatal('TOKEN_EXPIRADO'), 8000);
  }
  function onToken(token) {
    clearTimeout(tokenTimer);
    if (!token) return onFatal('TOKEN_EXPIRADO');
    transport.setToken(String(token));
  }

  // ---------------------------------------------------------------------------
  // Identificação do visitante do site
  // ---------------------------------------------------------------------------
  function showLeadForm() {
    state.identifying = true;
    state.ready = false;
    state.messages = [];
    renderMessages();
    ui.leadText.textContent = state.team.online
      ? 'Deixe seu contato e sua mensagem. Nossa equipe responde por aqui.'
      : 'Deixe seu contato e sua mensagem. Nossa equipe responde por aqui assim que voltar.';
    ui.lead.hidden = false;
    renderComposerState();
    if (state.open && window.matchMedia('(pointer: fine)').matches) ui.leadName.focus();
  }

  function leadError(text, field) {
    ui.leadError.textContent = text || '';
    ui.leadError.hidden = !text;
    if (field) field.focus();
  }

  /** A chave guardada não vale mais (contato removido): o visitante se identifica de novo. */
  function forgetVisitor() {
    config.token = '';
    post({ type: 'uvoz:visitor', token: null });
    showLeadForm();
  }

  ui.lead.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (ui.leadSubmit.disabled) return;
    const lead = {
      app: config.app, source: config.page,
      name: ui.leadName.value.trim(), phone: ui.leadPhone.value.trim(),
      email: ui.leadEmail.value.trim(), message: ui.leadMessage.value.trim(),
    };
    if (lead.name.length < 2) return leadError('Informe seu nome.', ui.leadName);
    if (lead.phone.replace(/\D/g, '').length < 10) return leadError('Informe um WhatsApp com DDD.', ui.leadPhone);
    if (lead.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(lead.email)) return leadError('Informe um e-mail válido ou deixe em branco.', ui.leadEmail);
    if (!lead.message) return leadError('Escreva sua mensagem.', ui.leadMessage);

    leadError('');
    ui.leadSubmit.disabled = true;
    ui.leadSubmit.textContent = 'Enviando…';
    try {
      const { token } = await visitorApi.create(lead);
      config.token = token;
      post({ type: 'uvoz:visitor', token });
      state.identifying = false;
      ui.lead.hidden = true;
      ui.lead.reset();
      renderComposerState();
      if (transport) transport.setToken(token); // a conversa chega no "init", já com a primeira mensagem
      else connect();
    } catch (err) {
      leadError(err.message || 'Não foi possível enviar. Tente de novo.');
    } finally {
      ui.leadSubmit.disabled = false;
      ui.leadSubmit.textContent = 'Iniciar conversa';
    }
  });

  // ---------------------------------------------------------------------------
  // Envio
  // ---------------------------------------------------------------------------
  function sendMessage(text, files) {
    const clientId = `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    const message = {
      id: clientId, clientId, from: 'contact', author: null, text, ts: Date.now(), state: 'pending',
      attachments: files.map((file) => ({ name: file.name, size: file.size, type: file.type, file })),
      uploadedIds: [],
    };
    appendMessage(message);
    scrollToBottom();
    deliver(message);
  }

  async function deliver(message) {
    const index = () => state.messages.indexOf(message);
    const update = (changes) => {
      Object.assign(message, changes);
      if (index() !== -1) replaceMessage(index(), message);
    };
    update({ state: 'pending', error: null });
    try {
      // Em uma nova tentativa, só sobem os arquivos que ainda não foram enviados.
      for (let i = message.uploadedIds.length; i < message.attachments.length; i++) {
        const uploaded = await transport.upload(message.attachments[i].file);
        message.uploadedIds.push(uploaded.id);
      }
      const res = await transport.request('message:send', {
        text: message.text, attachmentIds: message.uploadedIds, clientId: message.clientId,
      });
      if (res.error || !res.message) throw new Error(res.error || 'Não enviada.');
      if (index() !== -1) replaceMessage(index(), res.message); // senão, message:new já confirmou
    } catch (err) {
      update({ state: 'failed', error: err.message || 'Não enviada.' });
    }
  }

  function renderStaged() {
    ui.staged.replaceChildren(...state.staged.map((file, i) => {
      const remove = el('button', { type: 'button', onclick: () => { state.staged.splice(i, 1); renderStaged(); } },
        icon('M6 6l12 12M18 6L6 18'));
      remove.setAttribute('aria-label', `Remover ${file.name}`);
      return el('li', null, el('span', { textContent: file.name }), remove);
    }));
    ui.staged.hidden = !state.staged.length;
    renderComposerState();
  }

  function stageFiles(files) {
    const next = [...state.staged, ...files];
    if (next.length > MAX_FILES) return renderBanner(`Envie no máximo ${MAX_FILES} arquivos por mensagem.`);
    if (next.reduce((total, f) => total + f.size, 0) > MAX_TOTAL_SIZE) return renderBanner('Os arquivos somam mais de 10 MB.');
    state.staged = next;
    renderStaged();
  }

  function resizeInput() {
    ui.input.style.height = 'auto';
    ui.input.style.height = `${Math.min(ui.input.scrollHeight, 120)}px`;
  }

  // ---------------------------------------------------------------------------
  // Interação
  // ---------------------------------------------------------------------------
  let lastTypingSent = 0;
  ui.input.addEventListener('input', () => {
    resizeInput();
    renderComposerState();
    if (ui.input.value && Date.now() - lastTypingSent > 3000) {
      lastTypingSent = Date.now();
      transport.notify('typing', {});
    }
  });

  ui.input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      ui.composer.requestSubmit();
    }
  });

  ui.composer.addEventListener('submit', (e) => {
    e.preventDefault();
    const text = ui.input.value.trim();
    if (ui.send.disabled || (!text && !state.staged.length)) return;
    const files = state.staged;
    state.staged = [];
    ui.input.value = '';
    resizeInput();
    renderStaged();
    sendMessage(text, files);
    ui.input.focus();
  });

  ui.attach.addEventListener('click', () => ui.file.click());
  ui.file.addEventListener('change', () => {
    stageFiles([...ui.file.files]);
    ui.file.value = '';
  });

  ui.close.addEventListener('click', () => post({ type: 'uvoz:close' }));
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') post({ type: 'uvoz:close' }); });

  ui.scroll.addEventListener('scroll', () => { if (state.ready && isWatching()) markRead(); }, { passive: true });
  document.addEventListener('visibilitychange', () => { if (state.ready && isWatching()) markRead(); });
  ui.jump.addEventListener('click', () => { scrollToBottom(); markRead(); });

  ui.older.addEventListener('click', async () => {
    const first = state.messages.find((m) => typeof m.id === 'number');
    if (!first) return;
    ui.older.disabled = true;
    const res = await transport.request('messages:get', { before: first.id });
    ui.older.disabled = false;
    if (res.error || !Array.isArray(res.messages)) return renderBanner(res.error || 'Não foi possível carregar as mensagens.');
    const heightBefore = ui.scroll.scrollHeight;
    state.messages = [...res.messages, ...state.messages];
    state.hasMore = !!res.hasMore;
    renderMessages();
    ui.scroll.scrollTop += ui.scroll.scrollHeight - heightBefore;
  });

  // ---------------------------------------------------------------------------
  // Inicialização
  // ---------------------------------------------------------------------------
  async function boot(options) {
    booted = true;
    state.open = !!options.open;
    config = {
      app: String(options.app || ''), token: String(options.token || ''),
      visitor: !!options.visitor, page: String(options.page || '').slice(0, 500),
    };
    if (!config.visitor) return connect();

    // Visitante do site: mostra a equipe e, se ainda não se identificou, o formulário de contato.
    try {
      if (DEMO) await loadDemo();
      visitorApi = DEMO ? window.UVozDemoVisitor(DEMO) : httpVisitorApi;
      setTeam((await visitorApi.info(config.app)).team);
    } catch {
      return onFatal('CARREGAMENTO');
    }
    if (config.token) connect();
    else showLeadForm();
  }

  async function connect() {
    try {
      if (DEMO) await loadDemo();
      transport = DEMO ? window.UVozDemoTransport(config, DEMO) : socketTransport(config);
    } catch {
      return onFatal('CARREGAMENTO');
    }
    transport.on('init', onInit);
    transport.on('message:new', onMessageNew);
    transport.on('typing', onTyping);
    transport.on('team:updated', (team) => { setTeam(team); renderWelcome(); });
    transport.on('status', ({ connected }) => { state.connected = connected; renderBanner(); });
    transport.on('token:expired', requestToken);
    transport.on('fatal', ({ code }) => (config.visitor && code === 'TOKEN_INVALIDO' ? forgetVisitor() : onFatal(code)));
    transport.start();
  }

  window.addEventListener('message', (e) => {
    if (e.source !== window.parent || !e.data || typeof e.data.type !== 'string') return;
    const data = e.data;
    if (data.type === 'uvoz:boot') {
      if (booted) return;
      parentOrigin = e.origin;
      boot(data);
    } else if (e.origin === parentOrigin) {
      if (data.type === 'uvoz:visibility') setOpen(!!data.open);
      else if (data.type === 'uvoz:token') onToken(data.token);
    }
  });

  renderStatus();
  if (window.parent !== window) window.parent.postMessage({ type: 'uvoz:ready' }, '*');
  else if (DEMO) boot({ app: 'demo', open: true }); // aberto direto no navegador, para desenvolvimento
})();
