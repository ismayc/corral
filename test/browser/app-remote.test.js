const test = require('node:test');
const assert = require('node:assert/strict');
const { start, stop, flush } = require('../helpers/app');

test.afterEach(stop);

const LINK = 'https://mac.tail.ts.net:8443/';

test('when Tailscale serves Corral the bar offers the phone link and copies it', async () => {
  const p = await start({ routes: { 'GET /api/remote': { url: LINK, machine: 'mac', remote: false } } });
  const b = p.$('#phone');
  assert.equal(b.hidden, false);
  assert.equal(b.title, `Copy ${LINK}m, the link that opens Corral on your phone or another Tailscale device`);
  b.click();
  await flush();
  assert.equal(p.clipboard.text, `${LINK}m`);
  assert.equal(p.toast(), `Copied ${LINK}m. Open it on any device signed in to your Tailscale.`);
});

test('when the clipboard refuses, the toast shows the link to type', async () => {
  const p = await start({ routes: { 'GET /api/remote': { url: LINK, machine: 'mac', remote: false } } });
  p.clipboard.fail = true;
  p.$('#phone').click();
  await flush();
  assert.equal(p.toast(), `Open ${LINK}m on any device signed in to your Tailscale.`);
});

test('no tailnet link, a page opened over the tailnet, or no answer leaves the button hidden', async () => {
  for (const route of [{ url: null, remote: false }, { url: LINK, remote: true }, new Error('offline')]) {
    const p = await start({ routes: { 'GET /api/remote': route } });
    assert.equal(p.$('#phone').hidden, true);
  }
});
