// public/view.js: the markdown viewer, a page of its own that shows one file drawn or as text.
const test = require('node:test');
const assert = require('node:assert/strict');
const { mock } = test;
const { loadPage, unloadPage } = require('../helpers/browser');
const { settle } = require('../helpers/m');

test.afterEach(async () => { await settle(); unloadPage(); mock.timers.reset(); });

const DOC = '---\nname: notes\n---\n# Title\n\nSome **bold** text and https://example.com.\n\n- one\n- two\n';
const file = (text = DOC, extra = {}) => ({ name: 'notes.md', text, modified: 1000, ...extra });

async function view(route = file(), opts = {}) {
  const p = loadPage('view', { url: '/view?space=alpha&path=docs%2Fnotes.md', ...opts, routes: { 'GET /api/view': route, ...opts.routes } });
  await settle();
  p.doc = p.window.document;
  p.$ = (s) => p.doc.querySelector(s);
  p.$$ = (s) => [...p.doc.querySelectorAll(s)];
  p.pressed = () => ['rendered', 'raw'].filter((id) => p.$(`#${id}`).getAttribute('aria-pressed') === 'true');
  return p;
}

test('the file is drawn as a page, with its front matter above, and named in the bar and the title', async () => {
  const p = await view();
  assert.deepEqual(p.api.called('GET', '/api/view')[0].query, { space: 'alpha', path: 'docs/notes.md' });
  assert.equal(p.$('#name').textContent, 'notes.md');
  assert.equal(p.$('#path').textContent, 'docs/notes.md');
  assert.equal(p.doc.title, 'notes.md · Corral');
  assert.deepEqual(p.pressed(), ['rendered']);
  assert.equal(p.$('#doc .md pre.front').textContent, 'name: notes');
  assert.equal(p.$('#doc .md h1').textContent, 'Title');
  assert.equal(p.$('#doc .md strong').textContent, 'bold');
  assert.equal(p.$('#doc .md li').textContent, 'one');
  const a = p.$('#doc .md a');
  assert.deepEqual([a.href, a.target, a.onclick], ['https://example.com/', '_blank', null]);
});

test('Raw shows the text as written, Rendered goes back, and the choice is kept for the next file', async () => {
  let p = await view();
  p.$('#raw').click();
  assert.deepEqual(p.pressed(), ['raw']);
  assert.equal(p.$('#doc pre.raw').textContent, DOC);
  assert.equal(p.$('#doc .md'), null);
  assert.equal(p.window.localStorage.getItem('corral.view.mode'), 'raw');
  p.$('#rendered').click();
  assert.deepEqual(p.pressed(), ['rendered']);
  assert.equal(p.$('#doc .md h1').textContent, 'Title');

  p = await view(file(), { storage: { 'corral.view.mode': 'raw' } });
  assert.deepEqual(p.pressed(), ['raw']);
  assert.equal(p.$('#doc pre.raw').textContent, DOC);
});

test('a file with no front matter, or with Windows line ends, is drawn the same way', async () => {
  let p = await view(file('# Plain\n'));
  assert.equal(p.$('#doc .md pre.front'), null);
  assert.equal(p.$('#doc .md h1').textContent, 'Plain');
  p = await view(file('---\r\na: 1\r\n...\r\n# Windows\r\n\r\ntext\r\n'));
  assert.equal(p.$('#doc .md pre.front').textContent, 'a: 1');
  assert.equal(p.$('#doc .md h1').textContent, 'Windows');
  assert.equal(p.$('#doc .md p').textContent, 'text');
});

test('the page works when the browser refuses storage', async () => {
  const p = await view(file(), { setup(w) {
    const refuse = () => { throw new Error('denied'); };
    Object.defineProperty(w, 'localStorage', { value: { getItem: refuse, setItem: refuse }, configurable: true });
  } });
  assert.deepEqual(p.pressed(), ['rendered']);
  p.$('#raw').click();
  assert.deepEqual(p.pressed(), ['raw']);
});

test('a file that cannot be shown, or a Mac that does not answer, says why', async () => {
  let p = await view({ __reply: true, status: 415, body: { error: 'Corral shows only markdown files' } });
  assert.equal(p.$('#doc .note').textContent, 'Corral shows only markdown files');
  p.$('#raw').click(); // nothing to draw yet
  assert.equal(p.$('#doc .note').textContent, 'Corral shows only markdown files');
  p = await view(new Error('offline'));
  assert.equal(p.$('#doc .note').textContent, 'Could not reach Corral.');
});

test('the file is read again every 2 seconds while the window shows, and a new version keeps the place', async () => {
  mock.timers.enable({ apis: ['setInterval'] });
  const p = await view();
  let state = 'visible';
  Object.defineProperty(p.doc, 'visibilityState', { get: () => state, configurable: true });
  const scrolls = [];
  p.window.scrollTo = (...a) => scrolls.push(a);
  globalThis.scrollTo = p.window.scrollTo;
  Object.defineProperty(p.window, 'scrollY', { value: 240, configurable: true });
  const calls = () => p.api.called('GET', '/api/view');

  p.api.routes['GET /api/view'] = { unchanged: true };
  mock.timers.tick(2000);
  await settle();
  assert.equal(calls().length, 2);
  assert.equal(calls()[1].query.since, '1000');
  assert.equal(p.$('#doc .md h1').textContent, 'Title');
  assert.deepEqual(scrolls, []);

  p.api.routes['GET /api/view'] = file('# Second\n', { modified: 2000 });
  mock.timers.tick(2000);
  await settle();
  assert.equal(p.$('#doc .md h1').textContent, 'Second');
  assert.deepEqual(scrolls, [[0, 240]]);

  // A read that fails leaves the last version up; the next good one clears the notice.
  p.api.routes['GET /api/view'] = { __reply: true, status: 404, body: { error: 'no such file in this space' } };
  mock.timers.tick(2000);
  await settle();
  assert.equal(p.$('#state').textContent, 'Could not read it again: no such file in this space');
  assert.equal(p.$('#doc .md h1').textContent, 'Second');
  p.api.routes['GET /api/view'] = { unchanged: true };
  mock.timers.tick(2000);
  await settle();
  assert.equal(p.$('#state').textContent, '');
  assert.equal(calls().at(-1).query.since, '2000');

  state = 'hidden';
  const before = calls().length;
  mock.timers.tick(2000);
  await settle();
  assert.equal(calls().length, before);
});

test('a page opened with no file named shows the error and keeps the plain title', async () => {
  const p = await view({ __reply: true, status: 404, body: { error: 'no such file in this space' } }, { url: '/view' });
  assert.deepEqual(p.api.called('GET', '/api/view')[0].query, { space: '', path: '' });
  assert.equal(p.doc.title, 'Corral');
  assert.equal(p.$('#doc .note').textContent, 'no such file in this space');
});

// ---- Images and links ----

// Draws one line of markdown in docs/notes.md of space alpha and returns the page.
const line = (text, opts) => view(file(`${text}\n`), opts);
const attrs = (el) => Object.fromEntries([...el.attributes].map((a) => [a.name, a.value]));

test('an image of the project comes from Corral, by its place in the project', async () => {
  let p = await line('![A plot](img/plot.png "The title")');
  assert.deepEqual(attrs(p.$('#doc .md img')), { src: '/api/image?space=alpha&path=docs%2Fimg%2Fplot.png', alt: 'A plot', loading: 'lazy' });
  p = await line('![](../assets/a%20b.svg?raw=1) ![root](/logo.png) ![here](./x.gif)');
  assert.deepEqual(p.$$('#doc .md img').map((i) => i.getAttribute('src')), [
    '/api/image?space=alpha&path=assets%2Fa%20b.svg', '/api/image?space=alpha&path=logo.png', '/api/image?space=alpha&path=docs%2Fx.gif']);
});

test('a web image loads only over https, and one Corral will not load stays as text', async () => {
  const p = await line('![ok](https://example.com/b.svg) ![no](http://example.com/b.png) ![d](data:image/png;base64,AAAA) ![up](../../out.png) ![bad](%E0%A4%A.png) ![h](//example.com/x.png)');
  assert.deepEqual(p.$$('#doc .md img').map((i) => i.getAttribute('src')), ['https://example.com/b.svg']);
  assert.equal(p.$('#doc .md p').textContent, ' ![no](http://example.com/b.png) ![d](data:image/png;base64,AAAA) ![up](../../out.png) ![bad](%E0%A4%A.png) ![h](//example.com/x.png)');
});

test('a path that names nothing in the project stays as text', async () => {
  const p = await line('![none](.) [top](/)', { url: '/view?space=alpha&path=notes.md' });
  assert.equal(p.$('#doc .md p').textContent, '![none](.) [top](/)');
});

test('a web or mail link opens in a new tab, and a badge is an image inside a link', async () => {
  const p = await line('[site](https://example.com/a "t") [mail](mailto:me@example.com) [![build](https://example.com/b.svg)](https://example.com/ci)');
  const [site, mail, badge] = p.$$('#doc .md a');
  assert.deepEqual(attrs(site), { href: 'https://example.com/a', target: '_blank', rel: 'noopener' });
  assert.equal(mail.getAttribute('href'), 'mailto:me@example.com');
  assert.equal(badge.getAttribute('href'), 'https://example.com/ci');
  assert.equal(badge.querySelector('img').getAttribute('src'), 'https://example.com/b.svg');
});

test('a link to another markdown file of the project opens it in the viewer, at its heading if one is named', async () => {
  const p = await line('[next](other.md) [up](../README.md#Install) [q](/docs/paper.QMD) [**bold** one](./sub/deep.markdown)');
  assert.deepEqual(p.$$('#doc .md a').map(attrs), [
    { href: '/view?space=alpha&path=docs%2Fother.md' },
    { href: '/view?space=alpha&path=README.md#install' },
    { href: '/view?space=alpha&path=docs%2Fpaper.QMD' },
    { href: '/view?space=alpha&path=docs%2Fsub%2Fdeep.markdown' },
  ]);
  assert.equal(p.$$('#doc .md a')[3].querySelector('strong').textContent, 'bold');
});

test('a link Corral will not follow stays as text', async () => {
  const p = await line('[x](javascript:alert(1)) [f](file:///etc/hosts) [out](../../secret.md) [h](//example.com/a.md)');
  assert.equal(p.$('#doc .md a'), null);
  assert.equal(p.$('#doc .md p').textContent, '[x](javascript:alert(1)) [f](file:///etc/hosts) [out](../../secret.md) [h](//example.com/a.md)');
});

test('headings get ids as GitHub names them, and a #heading link points at one', async () => {
  const p = await view(file('# Getting Started!\n\n## What\'s new, in 2.0?\n\n## Setup\n\n### Setup\n\n[go](#Setup-1)\n'));
  assert.deepEqual(p.$$('#doc .md :is(h1,h2,h3)').map((x) => x.id), ['getting-started', 'whats-new-in-20', 'setup', 'setup-1']);
  assert.deepEqual(attrs(p.$('#doc .md a')), { href: '#setup-1' });
});

test('a page opened at a heading goes to it, and a bad or unknown one is ignored', async () => {
  let p = await view(file('# One\n\n## Café notes\n'), { url: '/view?space=alpha&path=docs%2Fnotes.md#caf%C3%A9-notes' });
  assert.equal(p.$('#doc .md h2').scrolledIntoView, true);
  assert.equal(p.$('#doc .md h1').scrolledIntoView, undefined);
  p = await view(file('# One\n'), { url: '/view?space=alpha&path=docs%2Fnotes.md#%E0%A4%A' });
  assert.equal(p.$('#doc .md h1').scrolledIntoView, undefined);
  p = await view(file('# One\n'), { url: '/view?space=alpha&path=docs%2Fnotes.md#one', storage: { 'corral.view.mode': 'raw' } });
  assert.equal(p.$('#doc pre.raw').textContent, '# One\n'); // Raw has no headings to go to
});

test('a link to another kind of file opens it on the Mac, with the saved app or the macOS default', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  const replies = [{ ok: true, kind: '.r', app: 'Positron', remembered: true }];
  const p = await line('[script](../R/fit.R)', { routes: { 'POST /api/open': () => replies.shift() } });
  const a = p.$('#doc .md a');
  assert.deepEqual(attrs(a), { href: '#R/fit.R', title: 'Open R/fit.R on the Mac' });
  const opens = () => p.api.called('POST', '/api/open').map((c) => c.body);
  const click = async () => { const e = new p.window.MouseEvent('click', { bubbles: true, cancelable: true }); a.dispatchEvent(e); await settle(); return e; };

  assert.equal((await click()).defaultPrevented, true);
  assert.deepEqual(opens(), [{ space: 'alpha', path: 'R/fit.R' }]);
  assert.equal(p.$('#state').textContent, 'Opened fit.R in Positron.');
  mock.timers.tick(4000);
  assert.equal(p.$('#state').textContent, '');

  // With no app saved for the type, the macOS default is asked for.
  replies.push({ needsChoice: true }, { ok: true, kind: '.r', app: 'its macOS default app', remembered: false });
  await click();
  assert.deepEqual(opens().slice(1), [{ space: 'alpha', path: 'R/fit.R' }, { space: 'alpha', path: 'R/fit.R', app: 'system' }]);
  assert.equal(p.$('#state').textContent, 'Opened fit.R in its macOS default app.');

  replies.push({ needsChoice: true }, { error: 'macOS has no default app for this file' });
  await click();
  assert.equal(p.$('#state').textContent, 'Could not open fit.R: macOS has no default app for this file');
  p.api.routes['POST /api/open'] = new Error('offline');
  await click();
  assert.equal(p.$('#state').textContent, 'Could not open fit.R: Could not reach Corral.');
});

// ---- HTML in a file: <img>, <a>, <br>, and the tags that wrap them ----

test('an HTML img tag is drawn like a markdown image, with its size, alt, and title', async () => {
  const p = await line('<img src="img/plot.png" alt="A plot" width="200px" height=100 title=\'Fig 1\'> <IMG SRC=https://example.com/b.svg width="50%" /> <img src="x.png" width="big" height="1e3">');
  assert.deepEqual(p.$$('#doc .md img').map(attrs), [
    { src: '/api/image?space=alpha&path=docs%2Fimg%2Fplot.png', alt: 'A plot', title: 'Fig 1', width: '200', height: '100', loading: 'lazy' },
    { src: 'https://example.com/b.svg', alt: '', width: '50%', loading: 'lazy' },
    { src: '/api/image?space=alpha&path=docs%2Fx.png', alt: '', loading: 'lazy' },
  ]);
});

test('an img tag Corral will not load, or one with no src, stays as text', async () => {
  const p = await line('<img src="http://example.com/a.png"> <img alt="none"> <img data-src="lazy.png">');
  assert.equal(p.$('#doc .md img'), null);
  assert.equal(p.$('#doc .md p').textContent, '<img src="http://example.com/a.png"> <img alt="none"> <img data-src="lazy.png">');
});

test('a centered block, as a README has, is drawn centered without its wrapping tags', async () => {
  const p = await view(file('<p align="center">\n  <a href="https://example.com"><img src="logo.png" width="120"></a><br/>\n  <span>The <b>caption</b></span>\n</p>\n\n<center><img src="a.png"></center>\n\n<div align=\'center\'>text</div>\n\n<div align="left">left</div>\n'));
  const [first, second, third, fourth] = p.$$('#doc .md p');
  assert.deepEqual([first, second, third, fourth].map((x) => x.className), ['center', 'center', 'center', '']);
  assert.equal(first.querySelector('a').getAttribute('href'), 'https://example.com');
  assert.equal(first.querySelector('a img').getAttribute('src'), '/api/image?space=alpha&path=docs%2Flogo.png');
  assert.equal(first.querySelectorAll('br').length, 1);
  assert.equal(first.textContent.trim(), 'The caption');
  assert.equal(first.querySelector('b').textContent, 'caption');
  assert.equal(second.querySelector('img').getAttribute('src'), '/api/image?space=alpha&path=docs%2Fa.png');
  assert.deepEqual([third.textContent, fourth.textContent], ['text', 'left']);
});

test('an HTML link goes where a markdown link does, and one Corral will not follow keeps only its text', async () => {
  const p = await line('<a href="other.md">next</a> <a href="javascript:alert(1)">bad</a> <a name="top">anchor</a> <a>bare</a> <abbr>x</abbr>');
  assert.deepEqual(p.$$('#doc .md a').map(attrs), [{ href: '/view?space=alpha&path=docs%2Fother.md' }]);
  assert.equal(p.$('#doc .md p').textContent, 'next bad anchor bare <abbr>x</abbr>');
});

test('HTML inside code is left as written', async () => {
  const p = await view(file('Use `<img src="a.png">` here.\n\n```html\n<p align="center"><img src="a.png"></p>\n```\n'));
  assert.equal(p.$('#doc .md img'), null);
  assert.equal(p.$('#doc .md p code').textContent, '<img src="a.png">');
  assert.equal(p.$('#doc .md pre code').textContent, '<p align="center"><img src="a.png"></p>');
});

test('HTML text tags are drawn as themselves, and code is shown as written', async () => {
  const p = await line('<b>bold</b> <STRONG>strong</STRONG> <i>it</i> <em class="x">em</em> <kbd>Ctrl</kbd>+<kbd>C</kbd> H<sub>2</sub>O x<sup>2</sup> <del>old</del> <s>gone</s> <u>under</u> <mark>hi</mark> <small>fine</small> <code>a **b** <i>c</i></code> <b>with **md** and `code`</b>');
  const drawn = (tag) => p.$$(`#doc .md p > ${tag}`).map((x) => x.textContent);
  assert.deepEqual(drawn('b'), ['bold', 'with md and code']);
  assert.deepEqual([drawn('strong'), drawn('i'), drawn('em'), drawn('kbd')], [['strong'], ['it'], ['em'], ['Ctrl', 'C']]);
  assert.deepEqual([drawn('sub'), drawn('sup'), drawn('del'), drawn('s'), drawn('u'), drawn('mark'), drawn('small')], [['2'], ['2'], ['old'], ['gone'], ['under'], ['hi'], ['fine']]);
  assert.equal(p.$('#doc .md p > code').textContent, 'a **b** <i>c</i>');
  assert.equal(p.$$('#doc .md p > b')[1].querySelector('strong').textContent, 'md');
  assert.equal(p.$('#doc .md p > em').className, '');
});

test('a tag Corral does not draw, or one left open, stays as text', async () => {
  const p = await line('<blink>no</blink> <b>open <script>alert(1)</script> <font color="red">x</font>');
  assert.equal(p.$('#doc .md p').children.length, 0);
  assert.equal(p.$('#doc .md p').textContent, '<blink>no</blink> <b>open <script>alert(1)</script> <font color="red">x</font>');
});

test('HTML headings are headings, centered when they say so, with ids, on one line or several', async () => {
  const p = await view(file('<h1 align="center">\n  <img src="logo.png" width="80"><br>\n  My <i>Project</i>\n</h1>\n\n<h2>Plain two</h2>\ntext after\n\n<H3 ALIGN=center>Three</H3> trailing\n\n<h4>never closed\n\nnext para\n\n<h5>closed too late\n\n</h5>\n'));
  const heads = p.$$('#doc .md :is(h1,h2,h3,h4,h5)');
  assert.deepEqual(heads.map((x) => [x.tagName, x.className, x.textContent.trim(), x.id]), [
    ['H1', 'center', 'My Project', 'my-project'], ['H2', '', 'Plain two', 'plain-two'], ['H3', 'center', 'Three', 'three']]);
  assert.equal(heads[0].querySelector('img').getAttribute('width'), '80');
  assert.equal(heads[0].querySelector('i').textContent, 'Project');
  assert.deepEqual(p.$$('#doc .md p').map((x) => x.textContent), ['text after', '<h4>never closed', 'next para', '<h5>closed too late', '</h5>']);
});

test('an HTML rule is a rule, and comments draw nothing', async () => {
  const p = await view(file('one <!-- hidden --> two\n\n<!-- badges: start -->\n\n<hr>\n\n<HR />\n\n<p></p>\n\nlast\n'));
  assert.equal(p.$$('#doc .md hr').length, 2);
  assert.deepEqual(p.$$('#doc .md p').map((x) => x.textContent), ['one  two', 'last']);
});
