/**
 * UVoz — Central de Ajuda (tutoriais para os clientes da Unicopag).
 *
 * O conteúdo fica em /ajuda/tutoriais.json e as imagens em /ajuda/img. Para editar um
 * tutorial, altere o JSON; para criar outro, acrescente um item em "tutorials":
 *
 *   { slug, name, blocks: [Bloco] }
 *
 *   Bloco:
 *     { t: 'p', html }                  parágrafo (aceita <b>, <i>, <code>, <br> e <a href>)
 *     { t: 'h', text }                  subtítulo
 *     { t: 'ul' | 'ol', items: [[Bloco]] }
 *     { t: 'img', src, w, h, show? }    arquivo em /ajuda/img; "show" limita a largura exibida
 *     { t: 'code', text }
 *     { t: 'note', tone: 'warn' | 'danger', blocks: [Bloco] }
 *     { t: 'button', text, href }
 *     { t: 'video', id }                vídeo do YouTube
 *
 * Endereços: /ajuda (lista) e /ajuda/<slug> (tutorial).
 */
(() => {
  'use strict';

  const BASE = '/ajuda';
  const SITE = 'Central de Ajuda Unicopag';
  const ui = {
    search: document.getElementById('search'),
    nav: document.getElementById('nav'),
    main: document.getElementById('main'),
  };
  let data = null;
  let tutorials = [];

  // Aberta dentro do widget de suporte, a página dispensa a marca no topo.
  if (window.self !== window.top) document.documentElement.classList.add('is-embed');

  function el(tag, props, ...children) {
    const node = document.createElement(tag);
    if (props) Object.assign(node, props);
    node.append(...children.filter((c) => c != null));
    return node;
  }

  function icon(d) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    p.setAttribute('d', d);
    svg.append(p);
    return svg;
  }

  const fold = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

  // ---------------------------------------------------------------------------
  // Conteúdo
  // ---------------------------------------------------------------------------
  const INLINE_TAGS = new Set(['B', 'I', 'CODE', 'BR', 'A']);

  /** Copia para `target` só o texto e as marcações permitidas de um trecho HTML. */
  function appendInline(target, html) {
    const tpl = document.createElement('template');
    tpl.innerHTML = String(html || '');
    (function copy(from, to) {
      for (const node of from.childNodes) {
        if (node.nodeType === Node.TEXT_NODE) { to.append(node.textContent); continue; }
        if (node.nodeType !== Node.ELEMENT_NODE) continue;
        if (!INLINE_TAGS.has(node.tagName)) { copy(node, to); continue; }
        const out = document.createElement(node.tagName);
        if (node.tagName === 'A') {
          const href = node.getAttribute('href') || '';
          if (!/^https?:\/\//i.test(href)) { copy(node, to); continue; }
          out.href = href; out.target = '_blank'; out.rel = 'noopener noreferrer';
        }
        copy(node, out);
        to.append(out);
      }
    })(tpl.content, target);
    return target;
  }

  function renderBlock(block) {
    switch (block.t) {
      case 'p': {
        const p = appendInline(el('p'), block.html);
        if (/^\d+\s*-/.test(p.textContent)) p.className = 'h-step';
        return p;
      }
      case 'h': return el('h2', { textContent: block.text });
      case 'ul':
      case 'ol':
        return el(block.t, null, ...block.items.map((item) => el('li', null, ...renderBlocks(item))));
      case 'img': {
        const src = `${BASE}/img/${block.src}`;
        const img = el('img', { src, alt: '', loading: 'lazy', width: block.w, height: block.h });
        const link = el('a', { className: 'h-img', href: src, target: '_blank', title: 'Abrir imagem em tamanho real' }, img);
        if (block.show) link.style.maxWidth = `${block.show}px`;
        return link;
      }
      case 'code': return el('pre', null, el('code', { textContent: block.text }));
      case 'note':
        return el('div', { className: `h-note${block.tone === 'danger' ? ' is-danger' : ''}` }, ...renderBlocks(block.blocks));
      case 'button':
        return el('a', { className: 'h-button', href: block.href, target: '_blank', rel: 'noopener noreferrer', textContent: block.text });
      case 'video':
        return el('div', { className: 'h-video' }, el('iframe', {
          src: `https://www.youtube-nocookie.com/embed/${encodeURIComponent(block.id)}`,
          title: 'Tutorial em vídeo', loading: 'lazy', allowFullscreen: true,
          allow: 'accelerometer; clipboard-write; encrypted-media; gyroscope; picture-in-picture',
        }));
      default: return null;
    }
  }
  const renderBlocks = (blocks) => (blocks || []).map(renderBlock).filter(Boolean);

  function blockText(blocks) {
    let out = '';
    for (const b of blocks || []) {
      if (b.html) out += ` ${b.html.replace(/<[^>]+>/g, ' ')}`;
      if (b.text) out += ` ${b.text}`;
      if (b.items) for (const item of b.items) out += blockText(item);
      if (b.blocks) out += blockText(b.blocks);
    }
    return out;
  }

  // ---------------------------------------------------------------------------
  // Busca
  // ---------------------------------------------------------------------------
  /** Tutoriais que contêm todas as palavras buscadas; os que casam pelo nome vêm antes. */
  function matches(query) {
    const words = fold(query).split(/\s+/).filter(Boolean);
    if (!words.length) return tutorials;
    const inName = [];
    const inText = [];
    for (const t of tutorials) {
      if (words.every((w) => t.foldedName.includes(w))) inName.push(t);
      else if (words.every((w) => t.folded.includes(w))) inText.push(t);
    }
    return [...inName, ...inText];
  }

  // ---------------------------------------------------------------------------
  // Telas
  // ---------------------------------------------------------------------------
  const currentSlug = () => decodeURIComponent(location.pathname).slice(BASE.length).replace(/^\/+|\/+$/g, '');

  function renderNav(list, slug) {
    ui.nav.replaceChildren(
      el('h2', { textContent: 'Integrações' }),
      ...(list.length
        ? list.map((t) => {
          const a = el('a', { href: `${BASE}/${t.slug}`, textContent: t.name });
          a.dataset.nav = '';
          if (t.slug === slug) a.setAttribute('aria-current', 'page');
          return a;
        })
        : [el('p', { className: 'h-nav-empty', textContent: 'Nada encontrado.' })]),
    );
  }

  function renderHome(list, query, missing) {
    const count = query
      ? (list.length ? `${list.length} resultado${list.length > 1 ? 's' : ''} para “${query}”` : `Nenhum tutorial encontrado para “${query}”.`)
      : `${list.length} tutoriais`;
    const cards = list.map((t) => {
      const a = el('a', { className: 'h-card', href: `${BASE}/${t.slug}` }, el('span', { textContent: t.name }), icon('M9 6l6 6-6 6'));
      a.dataset.nav = '';
      return el('li', null, a);
    });
    ui.main.replaceChildren(el('div', { className: 'h-home' },
      el('h1', { textContent: data.title }),
      el('p', { className: 'h-lead', textContent: data.description }),
      missing ? el('div', { className: 'h-note is-danger' }, el('p', { textContent: 'Tutorial não encontrado. Escolha um da lista abaixo.' })) : null,
      ...renderBlocks(data.intro),
      el('p', { className: 'h-count', textContent: count }),
      el('ul', { className: 'h-grid' }, ...cards),
    ));
    document.title = SITE;
  }

  function renderArticle(t) {
    const back = el('a', { className: 'h-back', href: BASE }, icon('M15 6l-6 6 6 6'), 'Todos os tutoriais');
    back.dataset.nav = '';
    const foot = el('p', { className: 'h-foot' });
    appendInline(foot, 'Ficou com dúvida ou a plataforma mudou? Fale com o suporte da Unicopag ou da própria plataforma parceira.');
    ui.main.replaceChildren(el('article', { className: 'h-article' },
      back,
      el('h1', { textContent: t.name }),
      ...renderBlocks(t.blocks),
      foot,
    ));
    document.title = `${t.name} — ${SITE}`;
  }

  function render() {
    if (!data) return;
    const query = ui.search.value.trim();
    const slug = currentSlug();
    const tutorial = tutorials.find((t) => t.slug === slug);
    const list = matches(query);
    renderNav(list, tutorial && tutorial.slug);
    if (tutorial) renderArticle(tutorial);
    else renderHome(list, query, !!slug);
  }

  function go(url, replace) {
    if (replace) history.replaceState(null, '', url);
    else history.pushState(null, '', url);
    render();
    window.scrollTo(0, 0);
  }

  // ---------------------------------------------------------------------------
  // Eventos
  // ---------------------------------------------------------------------------
  document.addEventListener('click', (event) => {
    const link = event.target.closest('a[data-nav]');
    if (!link || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    if (link.getAttribute('href') === BASE) ui.search.value = '';
    go(link.getAttribute('href'));
    ui.main.focus({ preventScroll: true });
  });

  ui.search.addEventListener('input', () => {
    // Em telas estreitas a lista lateral some: a busca mostra os resultados na tela inicial.
    const narrow = !ui.nav.offsetParent;
    if (narrow && currentSlug()) go(BASE);
    else render();
  });

  ui.search.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    const list = matches(ui.search.value.trim());
    if (ui.search.value.trim() && list.length) { go(`${BASE}/${list[0].slug}`); ui.search.blur(); }
  });

  window.addEventListener('popstate', render);

  fetch(`${BASE}/tutoriais.json`, { cache: 'no-cache' })
    .then((res) => { if (!res.ok) throw new Error(`HTTP ${res.status}`); return res.json(); })
    .then((json) => {
      data = json;
      tutorials = json.tutorials
        .map((t) => ({ ...t, foldedName: fold(t.name), folded: fold(`${t.name} ${blockText(t.blocks)}`) }))
        .sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));
      render();
    })
    .catch(() => {
      ui.main.replaceChildren(el('p', { className: 'h-loading', textContent: 'Não foi possível carregar os tutoriais. Atualize a página para tentar de novo.' }));
    });
})();
