const test = require('node:test');
const assert = require('node:assert/strict');
const desktop = require('../helpers/app');
const { phone, settle, unloadPage } = require('../helpers/m');

test.afterEach(async () => { await desktop.stop(); await settle(); unloadPage(); });

const HUB = 'https://hub.example/';

for (const [name, open] of [
  ['Mac page', (route) => desktop.start({ routes: { 'GET /api/hub': route } })],
  ['phone page', (route) => phone([], { routes: { 'GET /api/hub': route } })],
]) {
  test(`${name}: the header links to the hub in the same tab when the server has its address`, async () => {
    const p = await open({ url: HUB });
    await settle();
    const a = p.$('#hub');
    assert.equal(a.hidden, false);
    assert.equal(a.textContent, 'All tailnet pages');
    assert.equal(a.getAttribute('href'), HUB);
    assert.equal(a.getAttribute('target'), null);
  });

  test(`${name}: no address, a non-http address, or no answer shows no link`, async () => {
    for (const route of [{ url: null }, { url: 'javascript:alert(1)' }, new Error('offline')]) {
      const p = await open(route);
      await settle();
      assert.equal(p.$('#hub').hidden, true);
      assert.equal(p.$('#hub').getAttribute('href'), null);
      await desktop.stop(); await settle(); unloadPage();
    }
  });
}
