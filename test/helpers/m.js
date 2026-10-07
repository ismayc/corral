// Small helpers for the phone page tests (public/m.js), on top of test/helpers/browser.js.
const { loadPage, unloadPage, fire } = require('./browser');

// Lets promises, fetch bodies, and zero-delay work settle. Uses setImmediate, so it also works while
// node:test's mock timers stand in for setTimeout.
const settle = async (n = 20) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };

// A window as /api/overview describes it.
const win = (id, o = {}) => ({
  id, label: id, cwd: `/Users/chester/repos/${id}`, space: null, exited: false, created: 1, persistent: true,
  remote: false, activity: null, claude: null, askKey: null, prompt: null, muted: false, ...o,
});
const claude = (status, o = {}) => ({ status, waitingFor: null, since: null, mode: null, ...o });
const overview = (...sessions) => ({ machine: 'Test Mac', sessions });

// Loads the phone page with these windows and waits for the first list.
async function phone(sessions = [], opts = {}) {
  const p = loadPage('m', { ...opts, routes: { 'GET /api/overview': overview(...sessions), ...opts.routes } });
  await settle();
  const doc = p.window.document;
  p.doc = doc;
  p.$ = (s) => doc.querySelector(s);
  p.$$ = (s) => [...doc.querySelectorAll(s)];
  p.text = (s) => doc.querySelector(s)?.textContent;
  p.toast = () => (doc.querySelector('#toast').hidden ? null : doc.querySelector('#toast').textContent);
  p.card = (id) => doc.querySelector(`.card[data-id="${id}"]`);
  p.sheetTitle = () => (doc.querySelector('#gen').hidden ? null : doc.querySelector('#gentitle').textContent);
  p.button = (label, root = doc) => [...root.querySelectorAll('button')].find((b) => b.textContent === label);
  // Opens a window's terminal from its card and connects its socket.
  p.openWin = async (id) => {
    p.card(id).click();
    await settle();
    const ws = p.sockets.at(-1);
    ws.open();
    return { ws, term: p.terms.at(-1) };
  };
  // What the page sent over a socket, parsed.
  p.sent = (ws) => ws.sent.map((s) => JSON.parse(s));
  p.typed = (ws) => p.sent(ws).filter((m) => m.t === 'in').map((m) => m.d);
  return p;
}

// A promise the test resolves itself, to hold a fake API reply open.
function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

// Goes back as the browser's Back button does, and waits for popstate. jsdom fires popstate from its own
// setTimeout, so a test running mock timers passes `tick` to move them along.
async function goBack(p, tick) {
  const popped = popstate(p, tick);
  p.window.history.back();
  await popped;
}
// Resolves after the page's next popstate has been handled.
async function popstate(p, tick) {
  let popped = false;
  p.window.addEventListener('popstate', () => { popped = true; }, { once: true });
  await settle(1);
  for (let i = 0; i < 200 && !popped; i++) {
    if (tick) { tick(); await settle(1); } else await new Promise((r) => setTimeout(r, 1));
  }
  if (!popped) throw new Error('no popstate');
  await settle();
}

// A stand-in layout for the list, since jsdom does no layout: each section header is 30px tall, each other
// row 100px, stacked in order, and the list shows 500px. Pass as opts.setup.
function listLayout(window) {
  const list = window.document.querySelector('#list');
  const height = (el) => (el.getAttribute('aria-hidden') ? 0 : el.classList.contains('section') ? 30 : 100);
  const proto = window.HTMLElement.prototype;
  Object.defineProperty(proto, 'offsetHeight', { configurable: true, get() { return height(this); } });
  Object.defineProperty(list, 'clientHeight', { configurable: true, get: () => 500 });
  Object.defineProperty(list, 'scrollHeight', { configurable: true, get: () => [...list.children].reduce((s, c) => s + height(c), 0) });
  proto.getBoundingClientRect = function getBoundingClientRect() {
    if (this === list) return { top: 0 };
    let y = 0;
    for (const c of list.children) { if (c === this) break; y += height(c); }
    return { top: y - list.scrollTop };
  };
}

module.exports = { listLayout, settle, win, claude, overview, phone, deferred, goBack, popstate, loadPage, unloadPage, fire };
