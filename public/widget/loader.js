/**
 * UVoz — instalador do widget de suporte.
 *
 * Incluído na aplicação do cliente. Cria o botão flutuante e um iframe servido pelo UVoz,
 * dentro de um shadow DOM, para que o estilo da página não interfira no widget e vice-versa.
 *
 * Uso em página renderizada pelo servidor:
 *
 *   <script src="https://SEU-UVOZ/widget/loader.js" data-app="unicopag" data-token="TOKEN_ASSINADO" async></script>
 *
 * Uso em aplicação de página única (depois de carregar o script):
 *
 *   UVozWidget.boot({ app: 'unicopag', token, getToken: () => buscarNovoToken() });
 *   UVozWidget.shutdown();   // ao sair da conta
 *
 * Opções de boot: app, token, getToken (função que devolve um token novo quando o atual expira),
 * side ('right' | 'left'), offsetX, offsetY (pixels), launcher ('light' | 'red'), zIndex.
 */
(() => {
  'use strict';
  if (window.UVozWidget) return;

  const script = document.currentScript;
  const ORIGIN = script ? new URL(script.src, location.href).origin : location.origin;
  const OPEN_KEY = 'uvoz-widget:open';

  const CSS = `
    :host { all: initial; }
    * { box-sizing: border-box; }
    .wrap { font-family: "Inter", system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif; -webkit-font-smoothing: antialiased; }
    .launcher, .panel, .peek { position: fixed; right: var(--x); z-index: var(--z); }
    .wrap.left .launcher, .wrap.left .panel, .wrap.left .peek { right: auto; left: var(--x); }

    .launcher {
      bottom: var(--y); width: 56px; height: 56px; padding: 0; border: 0; border-radius: 50%; cursor: pointer;
      display: grid; place-items: center;
      background: linear-gradient(180deg, #f1f5fb, #cfdaec); color: #0a1830;
      box-shadow: 0 10px 30px rgba(2, 8, 20, .55), 0 0 0 1px rgba(255, 255, 255, .1);
      transition: transform .15s ease;
    }
    .wrap.red .launcher { background: #db3240; color: #fff; }
    .launcher:hover { transform: scale(1.06); }
    .launcher:active { transform: scale(.96); }
    .launcher:focus-visible { outline: 2px solid #e4eaf4; outline-offset: 3px; }
    .launcher svg {
      position: absolute; width: 26px; height: 26px; fill: none; stroke: currentColor;
      stroke-width: 2; stroke-linecap: round; stroke-linejoin: round;
      transition: opacity .18s ease, transform .18s ease;
    }
    .launcher .i-close { opacity: 0; transform: rotate(-45deg) scale(.6); }
    .wrap.open .launcher .i-chat { opacity: 0; transform: rotate(45deg) scale(.6); }
    .wrap.open .launcher .i-close { opacity: 1; transform: none; }

    .badge {
      position: absolute; top: -3px; right: -3px; min-width: 20px; height: 20px; padding: 0 6px;
      border-radius: 10px; background: #db3240; color: #fff;
      font-size: 11px; font-weight: 700; line-height: 20px; text-align: center;
      box-shadow: 0 0 0 2px #0a1830;
    }
    .wrap.open .badge, .badge[hidden], .peek[hidden] { display: none; }

    .panel {
      bottom: calc(var(--y) + 70px); width: 384px; max-width: calc(100vw - 2 * var(--x));
      height: min(640px, calc(100vh - var(--y) - 86px)); height: min(640px, calc(100dvh - var(--y) - 86px));
      border: 1px solid #1e3251; border-radius: 20px; overflow: hidden; background: #0a1830;
      box-shadow: 0 24px 64px rgba(2, 8, 20, .6);
      opacity: 0; visibility: hidden; transform: translateY(12px) scale(.98); transform-origin: bottom right;
      transition: opacity .18s ease, transform .18s ease, visibility 0s linear .18s;
    }
    .wrap.left .panel { transform-origin: bottom left; }
    .wrap.open .panel { opacity: 1; visibility: visible; transform: none; transition-delay: 0s; }
    iframe { display: block; width: 100%; height: 100%; border: 0; color-scheme: dark; }

    .peek {
      bottom: calc(var(--y) + 70px); width: 300px; max-width: calc(100vw - 2 * var(--x));
      display: flex; align-items: flex-start; gap: 4px; padding: 4px;
      border: 1px solid #1e3251; border-radius: 16px; background: #0d2241; color: #f3f6fb;
      box-shadow: 0 16px 40px rgba(2, 8, 20, .55);
      animation: peek-in .2s ease both;
    }
    .wrap.open .peek { display: none; }
    .peek-body {
      flex: 1; min-width: 0; padding: 8px 4px 8px 10px; border: 0; border-radius: 12px; background: none;
      color: inherit; font: inherit; font-size: 13.5px; line-height: 1.4; text-align: left; cursor: pointer;
    }
    .peek-body strong { display: block; margin-bottom: 2px; font-size: 12px; font-weight: 600; color: #a9b8d0; }
    .peek-body span { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; overflow-wrap: anywhere; }
    .peek-close {
      flex: none; width: 28px; height: 28px; padding: 0; border: 0; border-radius: 9px; background: none;
      color: #7c8fae; cursor: pointer; display: grid; place-items: center;
    }
    .peek-close:hover { background: #132b50; color: #f3f6fb; }
    .peek-close svg { width: 14px; height: 14px; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; }
    .peek-body:focus-visible, .peek-close:focus-visible { outline: 2px solid #e4eaf4; outline-offset: -2px; }
    @keyframes peek-in { from { opacity: 0; transform: translateY(8px); } }

    @media (max-width: 480px) {
      .panel { inset: 0; width: auto; max-width: none; height: auto; border: 0; border-radius: 0; }
      .wrap.open .launcher { display: none; }
    }
    @media (prefers-reduced-motion: reduce) {
      .launcher, .launcher svg, .panel { transition: none; }
      .peek { animation: none; }
    }
  `;

  const HTML = `
    <div class="panel"></div>
    <div class="peek" role="status" hidden>
      <button type="button" class="peek-body"><strong></strong><span></span></button>
      <button type="button" class="peek-close" aria-label="Dispensar aviso">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>
      </button>
    </div>
    <button type="button" class="launcher" aria-label="Abrir o chat de suporte" aria-expanded="false">
      <svg class="i-chat" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 4.5h14a2.5 2.5 0 0 1 2.5 2.5v8a2.5 2.5 0 0 1-2.5 2.5h-6.5L7.5 21v-3.5H5A2.5 2.5 0 0 1 2.5 15V7A2.5 2.5 0 0 1 5 4.5z"/><path d="M8 9.5h8M8 13h5"/></svg>
      <svg class="i-close" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>
      <span class="badge" hidden></span>
    </button>
  `;

  let config = null;
  let host = null;
  let parts = null;
  let isOpen = false;

  const store = {
    get() { try { return sessionStorage.getItem(OPEN_KEY) === '1'; } catch { return false; } },
    set(open) { try { sessionStorage.setItem(OPEN_KEY, open ? '1' : '0'); } catch { /* sem armazenamento */ } },
  };

  const numberOr = (value, fallback) => (value != null && Number.isFinite(Number(value)) ? Number(value) : fallback);

  const toFrame = (message) => {
    if (parts && parts.frame.contentWindow) parts.frame.contentWindow.postMessage(message, ORIGIN);
  };

  function setUnread(count, preview) {
    const n = Math.max(0, Number(count) || 0);
    parts.badge.textContent = n > 9 ? '9+' : String(n);
    parts.badge.hidden = !n;
    parts.launcher.setAttribute('aria-label', n
      ? `Abrir o chat de suporte, ${n} ${n === 1 ? 'mensagem nova' : 'mensagens novas'}`
      : 'Abrir o chat de suporte');
    if (n && preview && preview.text && !isOpen) {
      parts.peekName.textContent = String(preview.name || 'Suporte');
      parts.peekText.textContent = String(preview.text);
      parts.peek.hidden = false;
    } else {
      parts.peek.hidden = true;
    }
  }

  function setOpen(open, { focus = true } = {}) {
    if (!parts) return;
    isOpen = open;
    parts.wrap.classList.toggle('open', open);
    parts.launcher.setAttribute('aria-expanded', String(open));
    if (open) parts.peek.hidden = true;
    store.set(open);
    toFrame({ type: 'uvoz:visibility', open });
    if (focus) (open ? parts.frame : parts.launcher).focus();
  }

  function refreshToken() {
    const next = typeof config.getToken === 'function' ? config.getToken() : null;
    Promise.resolve(next).then(
      (token) => { if (token) config.token = token; toFrame({ type: 'uvoz:token', token: token || null }); },
      () => toFrame({ type: 'uvoz:token', token: null }),
    );
  }

  function onMessage(e) {
    if (!parts || e.origin !== ORIGIN || e.source !== parts.frame.contentWindow) return;
    const data = e.data || {};
    if (data.type === 'uvoz:ready') toFrame({ type: 'uvoz:boot', app: config.app, token: config.token, open: isOpen });
    else if (data.type === 'uvoz:unread') setUnread(data.count, data.preview);
    else if (data.type === 'uvoz:close') setOpen(false);
    else if (data.type === 'uvoz:token') refreshToken();
  }

  function boot(options) {
    if (!options || !options.app) throw new Error('UVozWidget.boot: informe "app".');
    if (!options.token && !options.demo) throw new Error('UVozWidget.boot: informe "token".');
    teardown();
    config = { ...options };

    host = document.createElement('div');
    host.id = 'uvoz-widget';
    const root = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = CSS;
    const wrap = document.createElement('div');
    wrap.className = `wrap${config.side === 'left' ? ' left' : ''}${config.launcher === 'red' ? ' red' : ''}`;
    wrap.style.setProperty('--x', `${numberOr(config.offsetX, 24)}px`);
    wrap.style.setProperty('--y', `${numberOr(config.offsetY, 24)}px`);
    wrap.style.setProperty('--z', String(numberOr(config.zIndex, 2147483000)));
    wrap.innerHTML = HTML;
    root.append(style, wrap);

    const frame = document.createElement('iframe');
    frame.title = 'Chat de suporte';
    frame.allow = 'clipboard-write';
    frame.src = `${ORIGIN}/widget/frame.html${config.demo ? `?demo=${encodeURIComponent(config.demo)}` : ''}`;
    wrap.querySelector('.panel').append(frame);

    parts = {
      wrap, frame,
      launcher: wrap.querySelector('.launcher'),
      badge: wrap.querySelector('.badge'),
      peek: wrap.querySelector('.peek'),
      peekName: wrap.querySelector('.peek-body strong'),
      peekText: wrap.querySelector('.peek-body span'),
    };
    parts.launcher.addEventListener('click', () => setOpen(!isOpen));
    wrap.querySelector('.peek-body').addEventListener('click', () => setOpen(true));
    wrap.querySelector('.peek-close').addEventListener('click', () => { parts.peek.hidden = true; });

    window.addEventListener('message', onMessage);
    document.body.append(host);

    // Mantém o chat aberto ao trocar de página, exceto em telas pequenas, onde ele cobre tudo.
    if (store.get() && window.matchMedia('(min-width: 481px)').matches) setOpen(true, { focus: false });
  }

  function teardown() {
    window.removeEventListener('message', onMessage);
    if (host) host.remove();
    host = null;
    parts = null;
    config = null;
    isOpen = false;
  }

  function shutdown() {
    teardown();
    store.set(false);
  }

  window.UVozWidget = {
    boot,
    shutdown,
    open: () => setOpen(true),
    close: () => setOpen(false),
    toggle: () => setOpen(!isOpen),
  };

  if (script && script.dataset.app) {
    const start = () => boot({
      app: script.dataset.app,
      token: script.dataset.token,
      demo: script.dataset.demo,
      side: script.dataset.side,
      launcher: script.dataset.launcher,
      offsetX: script.dataset.offsetX,
      offsetY: script.dataset.offsetY,
    });
    if (document.body) start();
    else document.addEventListener('DOMContentLoaded', start, { once: true });
  }
})();
