// Loads a page's HTML into jsdom, makes its window the global scope, stands in for the browser features jsdom
// lacks (xterm.js, WebSocket, service workers, push, notifications), and then requires the page's script, so
// Node's coverage counts it. The fake API answers like the server does; a test changes `api.routes` to steer it.
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..', '..');
const ORIGIN = 'http://127.0.0.1:18777';

class FakeTerminal {
  constructor(opts) {
    this.options = { ...opts }; this.cols = 80; this.rows = 24; this.written = []; this.pasted = [];
    this.dataCbs = []; this.resizeCbs = []; this.addons = []; this.disposed = false; this.resets = 0;
    FakeTerminal.instances.push(this);
  }
  loadAddon(a) { this.addons.push(a); a.term = this; }
  open(el) {
    this.element = el;
    this.textarea = el.ownerDocument.createElement('textarea');
    el.appendChild(this.textarea);
  }
  onData(cb) { this.dataCbs.push(cb); return { dispose() {} }; }
  onResize(cb) { this.resizeCbs.push(cb); return { dispose() {} }; }
  onTitleChange(cb) { this.titleCb = cb; return { dispose() {} }; }
  onSelectionChange(cb) { this.selCb = cb; return { dispose() {} }; }
  attachCustomKeyEventHandler(cb) { this.keyHandler = cb; }
  type(d) { for (const cb of this.dataCbs) cb(d); }
  resize(cols, rows) { this.cols = cols; this.rows = rows; for (const cb of this.resizeCbs) cb({ cols, rows }); }
  write(d) { this.written.push(d); }
  paste(d) { this.pasted.push(d); }
  reset() { this.resets++; }
  focus() { this.focused = true; }
  blur() { this.focused = false; }
  clear() { this.cleared = true; }
  scrollToBottom() {}
  hasSelection() { return Boolean(this.selection); }
  getSelection() { return this.selection || ''; }
  refresh() {}
  dispose() { this.disposed = true; }
}
FakeTerminal.instances = [];

class FakeFit { fit() { this.fits = (this.fits || 0) + 1; } proposeDimensions() { return { cols: 80, rows: 24 }; } }
class FakeLinks { constructor(handler) { this.handler = handler; } }

class FakeWebSocket {
  constructor(url) {
    this.url = url; this.readyState = 0; this.sent = []; FakeWebSocket.instances.push(this);
  }
  send(d) { this.sent.push(d); }
  close() { this.readyState = 3; this.onclose?.({}); }
  // Test helpers.
  open() { this.readyState = 1; this.onopen?.({}); }
  message(data) { this.onmessage?.({ data }); }
  drop() { this.readyState = 3; this.onclose?.({}); }
}
FakeWebSocket.instances = [];

// The fake server: routes keyed "METHOD /path" (no query) -> value, or (req) => value. A value is a body
// (sent as JSON, status 200), or {status, body} via api.reply(), or an Error to make fetch reject.
function fakeApi(routes = {}) {
  const api = {
    calls: [],
    routes: { ...routes },
    reply: (status, body, type) => ({ __reply: true, status, body, type }),
    async fetch(url, opts = {}) {
      const u = new URL(url, ORIGIN);
      const method = (opts.method || 'GET').toUpperCase();
      let body = opts.body;
      if (typeof body === 'string') { try { body = JSON.parse(body); } catch {} }
      const req = { method, path: u.pathname, query: Object.fromEntries(u.searchParams), body, opts };
      api.calls.push(req);
      let r = api.routes[`${method} ${u.pathname}`];
      if (r === undefined) {
        const hit = Object.keys(api.routes).find((k) => k.includes('*') && new RegExp(`^${k.replace(/[.?+^$()[\]{}|\\]/g, '\\$&').replace(/\*/g, '[^/]+')}$`).test(`${method} ${u.pathname}`));
        r = hit ? api.routes[hit] : undefined;
      }
      if (typeof r === 'function') r = await r(req);
      if (r instanceof Error) throw r;
      if (r === undefined) r = api.reply(404, { error: 'not found' });
      const rep = r?.__reply ? r : { status: 200, body: r };
      const text = typeof rep.body === 'string' ? rep.body : JSON.stringify(rep.body ?? null);
      return new Response(text, { status: rep.status, headers: { 'Content-Type': rep.type || 'application/json' } });
    },
    called: (method, p) => api.calls.filter((c) => c.method === method && c.path === p),
  };
  return api;
}

const DEFAULT_ROUTES = {
  'GET /api/overview': { machine: 'Test Mac', sessions: [] },
  'GET /api/sessions': { sessions: [] },
  'GET /api/herdr': { available: true, spaces: [] },
  'GET /api/projects': { projects: [] },
  'GET /api/categories': { version: 1, categories: [], uncatCollapsed: false, assign: {} },
  'GET /api/remote': { url: null, machine: null, remote: false },
  'GET /api/restore': { savedAt: null, windows: [] },
  'GET /api/push': { key: 'BKey', devices: 0, prefs: { turn: true, permission: true, away: true, awake: true } },
};

let current = null;

// page: 'm' (the phone page) or 'app' (the Mac page). Options: url (path and query), routes, storage
// (localStorage contents), width/height, setup(window) to adjust the window before the script runs.
function loadPage(page, opts = {}) {
  if (current) unloadPage();
  const html = fs.readFileSync(path.join(ROOT, 'public', page === 'm' ? 'm.html' : 'index.html'), 'utf8')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, ''); // the page's own scripts are required below instead
  const dom = new JSDOM(html, { url: ORIGIN + (opts.url || (page === 'm' ? '/m' : '/')), pretendToBeVisual: true });
  const { window } = dom;
  const api = fakeApi({ ...DEFAULT_ROUTES, ...opts.routes });
  for (const [k, v] of Object.entries(opts.storage || {})) window.localStorage.setItem(k, typeof v === 'string' ? v : JSON.stringify(v));
  Object.defineProperty(window, 'innerWidth', { value: opts.width || (page === 'm' ? 390 : 1400), configurable: true, writable: true });
  Object.defineProperty(window, 'innerHeight', { value: opts.height || (page === 'm' ? 844 : 900), configurable: true, writable: true });

  const notifications = [];
  const sw = {
    listeners: {},
    addEventListener(type, cb) { (sw.listeners[type] ||= []).push(cb); },
    emit(type, data) { for (const cb of sw.listeners[type] || []) cb({ data }); },
    registrations: [],
    subscription: null,
    register: async (url) => { const reg = sw.makeReg(url); sw.registrations.push(reg); return reg; },
    makeReg: (url) => ({
      scope: '/', url,
      pushManager: {
        getSubscription: async () => sw.subscription,
        subscribe: async (o) => {
          if (sw.subscribeError) throw sw.subscribeError;
          sw.subscription = { endpoint: 'https://web.push.apple.com/abc', options: o, toJSON() { return { endpoint: this.endpoint, keys: { p256dh: 'p', auth: 'a' } }; }, unsubscribe: async () => { sw.subscription = null; return true; } };
          return sw.subscription;
        },
      },
      showNotification: async (title, o) => notifications.push({ title, ...o }),
    }),
  };
  sw.ready = Promise.resolve().then(() => sw.registrations[0] || sw.makeReg('/sw.js'));
  const nav = window.navigator;
  // A feature the test turns off is absent altogether, since the pages test for it with `in`.
  if (!opts.noServiceWorker) Object.defineProperty(nav, 'serviceWorker', { value: sw, configurable: true });
  const clipboard = { text: null, fail: false, writeText: async (t) => { if (clipboard.fail) throw new Error('denied'); clipboard.text = t; } };
  Object.defineProperty(nav, 'clipboard', { value: clipboard, configurable: true });
  if (opts.standalone !== undefined) Object.defineProperty(nav, 'standalone', { value: opts.standalone, configurable: true });
  if (opts.userAgent) Object.defineProperty(nav, 'userAgent', { value: opts.userAgent, configurable: true });

  class Notification {
    constructor(title, o) { this.title = title; this.opts = o; Notification.shown.push(this); }
    close() { this.closed = true; }
    static async requestPermission() { Notification.permission = Notification.answer; return Notification.answer; }
  }
  Notification.permission = opts.notificationPermission || 'default';
  Notification.answer = 'granted';
  Notification.shown = [];
  const observers = [];
  class ResizeObserver { constructor(cb) { this.cb = cb; this.els = []; observers.push(this); } observe(el) { this.els.push(el); } unobserve() {} disconnect() {} fire() { this.cb([]); } }
  FakeTerminal.instances = [];
  FakeWebSocket.instances = [];

  const extras = {
    fetch: api.fetch,
    WebSocket: FakeWebSocket,
    Terminal: FakeTerminal,
    FitAddon: { FitAddon: FakeFit },
    WebLinksAddon: { WebLinksAddon: FakeLinks },
    ResizeObserver,
    Notification: opts.noNotification ? undefined : Notification,
    PushManager: opts.noPush ? undefined : function PushManager() {},
    matchMedia: (q) => ({ matches: Boolean(opts.media?.[q]), media: q, addEventListener() {}, removeEventListener() {}, addListener() {} }),
    createImageBitmap: opts.createImageBitmap || (async () => ({ width: 4000, height: 3000, close() {} })),
    scrollTo: () => {},
    isSecureContext: opts.secure !== false,
    visualViewport: opts.visualViewport === null ? undefined : Object.assign(new window.EventTarget(), { height: window.innerHeight, width: window.innerWidth, offsetTop: 0 }),
  };
  for (const [k, v] of Object.entries(extras)) {
    if (v === undefined) delete window[k];
    else Object.defineProperty(window, k, { value: v, configurable: true, writable: true });
  }
  window.HTMLElement.prototype.scrollIntoView = function scrollIntoView() { this.scrolledIntoView = true; };
  window.HTMLElement.prototype.scrollTo = function scrollTo(o) { if (o && typeof o === 'object') this.scrollTop = o.top ?? this.scrollTop; };
  window.HTMLCanvasElement.prototype.getContext = () => ({ drawImage() {} });
  window.HTMLCanvasElement.prototype.toBlob = function toBlob(cb, type) { cb(opts.toBlobNull ? null : new window.Blob(['jpeg'], { type })); };
  opts.setup?.(window);

  // The page's script sees the jsdom window as its global scope.
  const saved = {};
  const names = new Set([...Object.getOwnPropertyNames(window), 'window', 'self', 'document', 'navigator', 'location', 'history', 'localStorage', 'sessionStorage', 'Notification', 'PushManager']);
  for (const k of names) {
    if (/^(globalThis|global|process|Buffer|console|setTimeout|clearTimeout|setInterval|clearInterval|queueMicrotask|URL|URLSearchParams|Response|Request|Headers|TextEncoder|TextDecoder|structuredClone|AbortController|AbortSignal|Promise|JSON|Math|Date|Object|Array|String|Number|Boolean|Symbol|Error|Map|Set|WeakMap|RegExp|Reflect|Proxy|Intl|require|module|exports|undefined|NaN|Infinity|eval|isNaN|parseInt|parseFloat|encodeURIComponent|decodeURIComponent|atob|btoa|crypto|performance)$/.test(k)) continue;
    saved[k] = Object.getOwnPropertyDescriptor(globalThis, k);
    if (k !== 'window' && k !== 'self' && !(k in window)) { delete globalThis[k]; continue; }
    Object.defineProperty(globalThis, k, { value: k === 'window' || k === 'self' ? window : window[k], configurable: true, writable: true });
  }
  // The page's timers are tracked, so unloading the page stops its polling and the test process can exit.
  const timers = new Set();
  const track = (set, clear) => (...a) => { const t = set(...a); timers.add([t, clear]); return t; };
  for (const [name, set, clear] of [['setTimeout', setTimeout, clearTimeout], ['setInterval', setInterval, clearInterval]]) {
    saved[name] = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { value: track(set, clear), configurable: true, writable: true });
  }
  const file = path.join(ROOT, 'public', page === 'm' ? 'm.js' : 'app.js');
  delete require.cache[file];
  current = { dom, window, api, saved, timers, file, notifications, sw, clipboard, observers, Notification, terms: FakeTerminal.instances, sockets: FakeWebSocket.instances };
  current.exports = require(file);
  return current;
}

function unloadPage() {
  if (!current) return;
  for (const [t, clear] of current.timers) clear(t);
  for (const [k, d] of Object.entries(current.saved)) {
    if (d) Object.defineProperty(globalThis, k, d); else delete globalThis[k];
  }
  current.window.close();
  current = null;
}

// Waits for pending promises and timers of 0 ms to settle.
const flush = async (n = 5) => { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0)); };

// Fires a DOM event of the window's own kind.
function fire(el, type, init = {}) {
  const w = el.ownerDocument.defaultView;
  const Ctor = /^(click|dblclick|mousedown|mouseup|mousemove|contextmenu|mouseenter|mouseleave)$/.test(type) ? w.MouseEvent
    : /^pointer/.test(type) ? (w.PointerEvent || w.MouseEvent)
      : /^key/.test(type) ? w.KeyboardEvent
        : /^touch/.test(type) ? w.Event
          : /^(input|change)$/.test(type) ? w.Event : w.Event;
  const e = new Ctor(type, { bubbles: true, cancelable: true, ...init });
  for (const [k, v] of Object.entries(init)) if (!(k in e) || ['touches', 'changedTouches', 'dataTransfer'].includes(k)) Object.defineProperty(e, k, { value: v });
  el.dispatchEvent(e);
  return e;
}

module.exports = { loadPage, unloadPage, flush, fire, fakeApi, FakeTerminal, FakeWebSocket, ORIGIN };
