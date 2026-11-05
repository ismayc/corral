// Sends what goes wrong in this page to the Mac, which appends it to ~/.local/share/corral/client-log.jsonl:
// uncaught errors, failed fetches, and whatever the page reports through clientLog(kind, fields). A repeat of
// a waiting event only raises its count. Events that could not be sent wait for the next send, so a phone that
// lost its connection reports that when it is back. Never pass text the user typed or copied.
(() => {
  const PATH = '/api/clientlog';
  const MAX_WAITING = 50;
  const DELAY_MS = 2000;
  const send = globalThis.fetch;
  const waiting = [];
  let timer = null;

  async function flush() {
    clearTimeout(timer);
    timer = null;
    const items = waiting.splice(0);
    if (!items.length) return;
    try {
      const r = await send(PATH, { method: 'POST', keepalive: true, headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ page: location.pathname, events: items.map((i) => i.event) }) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
    } catch {
      waiting.unshift(...items.slice(0, MAX_WAITING - waiting.length));
    }
  }

  function clientLog(kind, fields = {}) {
    const key = JSON.stringify([kind, fields]);
    const same = waiting.find((e) => e.key === key);
    if (same) same.event.n += 1;
    else if (waiting.length < MAX_WAITING) waiting.push({ key, event: { kind, t: Date.now(), n: 1, ...fields } });
    timer ??= setTimeout(flush, DELAY_MS);
  }
  globalThis.clientLog = clientLog;

  window.addEventListener('error', (e) => clientLog('error', { msg: e.message, src: `${e.filename}:${e.lineno}:${e.colno}` }));
  window.addEventListener('unhandledrejection', (e) => clientLog('rejection', { msg: String(e.reason?.message ?? e.reason) }));
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flush(); });

  globalThis.fetch = (input, init) => {
    const path = String(input).split('?')[0];
    const method = init?.method ?? 'GET';
    return send(input, init).then((r) => {
      if (!r.ok) clientLog('api', { method, path, status: r.status });
      return r;
    }, (err) => {
      clientLog('api', { method, path, err: err.name });
      throw err;
    });
  };
})();
