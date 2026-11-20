// A banner that says Corral was updated. A page keeps running the scripts it loaded until it is reloaded,
// so after a change to Corral's page files an open page (the Mac page, a pop-out, the viewer) can show an
// old fault that is already fixed. This page records GET /api/version when it loads, asks again every
// minute and whenever it comes back into view, and shows the banner when the answer changes. A failed
// check (Corral restarting, say) changes nothing.
(() => {
  let first = null; // the version this page loaded with
  let banner = null;

  async function check() {
    let v;
    try { v = (await (await fetch('/api/version')).json()).version; } catch { return; }
    if (!v) return;
    if (first === null) first = v;
    else if (v !== first && !banner) show();
  }

  function show() {
    const reload = Object.assign(document.createElement('button'), { type: 'button', textContent: 'Reload', onclick: () => location.reload() });
    const close = Object.assign(document.createElement('button'), { type: 'button', className: 'x', textContent: '×', title: 'Hide this until the next update' });
    banner = Object.assign(document.createElement('div'), { className: 'corral-update', role: 'status' });
    banner.append(document.createTextNode('Corral was updated. Reload this page to use the new version.'), reload, close);
    close.onclick = () => {
      banner.remove();
      banner = null;
      first = null; // the next check takes the current version, so only a later update shows the banner again
    };
    document.body.append(banner);
  }

  check();
  setInterval(check, 60000);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') check(); });
})();
