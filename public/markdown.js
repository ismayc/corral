// Markdown drawn as headings, lists, tables, code, and links: Claude's replies on the phone page, and a
// markdown file in the viewer (/view). Built as elements, never as HTML, so text cannot add markup or run
// script. Links go out only for http(s) addresses. A page sets corralMd.onLink to handle a click on one.
// A page that shows a file sets corralMd.local to {link(target), image(target)}; only then are images and
// links to other places drawn. link answers the attributes for the <a>, image the address for the <img>,
// and either answers null to leave the markdown as text.
(() => {
  // Builds an element; strings become text nodes, never HTML.
  function h(tag, attrs = {}, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'class') el.className = v; else if (k.startsWith('on')) el[k] = v; else if (v != null) el.setAttribute(k, v);
    }
    for (const c of kids.flat()) if (c != null) el.append(c);
    return el;
  }

  const md = { h, onLink: null, local: null };
  // A `! command` (Claude Code runs a prompt that starts with ! as a shell command), alone in code or a code block.
  const BANG = /^! +\S/;
  const INLINE = /`([^`]+)`|\*\*(.+?)\*\*|\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)|(?<![\w*])\*(?![\s*])(.+?)(?<!\s)\*(?!\w)|(?<!\w)_(?![\s_])(.+?)(?<!\s)_(?!\w)|(https?:\/\/[^\s<>()]*[^\s<>().,;:!?'"])/g;
  // With corralMd.local: [text](target) for any target (the text may be an image, as a badge is), and ![alt](target).
  const LOCAL = /\[((?:!\[[^\]]*\]\([^)\s]+(?: +"[^"]*")?\)|[^\]])+)\]\(([^)\s]+)(?: +"[^"]*")?\)|!\[([^\]]*)\]\(([^)\s]+)(?: +"[^"]*")?\)/;
  const INLINE_LOCAL = new RegExp(`${LOCAL.source}|${INLINE.source}`, 'g'); // LOCAL first, or a badge's image reads as a link's text
  function mdInline(s) {
    const out = [];
    let at = 0;
    const o = md.local ? 4 : 0; // where INLINE's groups start
    for (const m of s.matchAll(md.local ? INLINE_LOCAL : INLINE)) {
      if (m.index > at) out.push(s.slice(at, m.index));
      if (o && (m[2] || m[4])) {
        const to = m[2] ? md.local.link(m[2]) : md.local.image(m[4]);
        out.push(!to ? m[0] : m[2] ? h('a', to, mdInline(m[1])) : h('img', { src: to, alt: m[3], loading: 'lazy' }));
      } else if (m[o + 1]) out.push(h('code', BANG.test(m[o + 1]) ? { class: 'bang' } : {}, m[o + 1]));
      else if (m[o + 2]) out.push(h('strong', {}, mdInline(m[o + 2])));
      else if (m[o + 3]) out.push(h('a', { href: m[o + 4], target: '_blank', rel: 'noopener', onclick: md.onLink }, mdInline(m[o + 3])));
      else if (m[o + 7]) out.push(h('a', { href: m[o + 7], target: '_blank', rel: 'noopener', onclick: md.onLink }, m[o + 7]));
      else out.push(h('em', {}, mdInline(m[o + 5] || m[o + 6])));
      at = m.index + m[0].length;
    }
    if (at < s.length) out.push(s.slice(at));
    return out;
  }

  const LIST_ITEM = /^( *)([-*+]|\d+[.)]) +(.*)$/;
  const TABLE_RULE = /^ *\|? *:?-+:? *(\| *:?-+:? *)*\|? *$/;
  const cells = (line) => line.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
  function markdown(text) {
    const lines = text.split('\n');
    const out = [];
    let para = [];
    const flush = () => { if (para.length) out.push(h('p', {}, mdInline(para.join('\n')))); para = []; };
    for (let i = 0; i < lines.length;) {
      const line = lines[i];
      let m;
      if ((m = line.match(/^ *(```|~~~)/))) {
        flush();
        const code = [];
        for (i++; i < lines.length && !lines[i].trim().startsWith(m[1]); i++) code.push(lines[i]);
        const body = code.join('\n');
        out.push(h('pre', BANG.test(body.trimStart()) ? { class: 'bang' } : {}, h('code', {}, body)));
        i++;
      } else if ((m = line.match(/^(#{1,6}) +(.*)$/))) {
        flush();
        out.push(h(`h${m[1].length}`, {}, mdInline(m[2])));
        i++;
      } else if (/^ *([-*_])( *\1){2,} *$/.test(line)) {
        flush();
        out.push(h('hr'));
        i++;
      } else if (/^ *>/.test(line)) {
        flush();
        const quote = [];
        for (; i < lines.length && /^ *>/.test(lines[i]); i++) quote.push(lines[i].replace(/^ *> ?/, ''));
        out.push(h('blockquote', {}, markdown(quote.join('\n'))));
      } else if (line.includes('|') && TABLE_RULE.test(lines[i + 1] || '')) {
        flush();
        const head = h('tr', {}, cells(line).map((c) => h('th', {}, mdInline(c))));
        const rows = [];
        for (i += 2; i < lines.length && lines[i].includes('|'); i++) rows.push(h('tr', {}, cells(lines[i]).map((c) => h('td', {}, mdInline(c)))));
        out.push(h('div', { class: 'table' }, h('table', {}, h('thead', {}, head), h('tbody', {}, rows))));
      } else if ((m = line.match(LIST_ITEM))) {
        flush();
        // An item runs until the next marker at its own depth; deeper lines are its contents, nested lists included.
        const depth = m[1].length;
        const ordered = /\d/.test(m[2]);
        const items = [];
        while (i < lines.length) {
          const it = lines[i].match(LIST_ITEM);
          if (!it || it[1].length !== depth || /\d/.test(it[2]) !== ordered) break;
          const body = [it[3]];
          for (i++; i < lines.length; i++) {
            const next = lines[i];
            const indent = next.match(/^ */)[0].length;
            if (next.trim() && indent <= depth) break;
            if (!next.trim() && !(lines[i + 1] || '').match(/^ +\S/)) break;
            body.push(next.slice(Math.min(indent, depth + it[2].length + 1)));
          }
          items.push(h('li', {}, markdown(body.join('\n'))));
        }
        out.push(ordered ? h('ol', { start: parseInt(m[2], 10) }, items) : h('ul', {}, items));
      } else if (!line.trim()) {
        flush();
        i++;
      } else {
        para.push(line);
        i++;
      }
    }
    flush();
    return out;
  }

  md.markdown = markdown;
  globalThis.corralMd = md;
})();
