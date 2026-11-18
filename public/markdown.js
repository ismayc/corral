// Markdown drawn as headings, lists, tables, code, and links: Claude's replies on the phone page, and a
// markdown file in the viewer (/view). Built as elements, never as HTML, so text cannot add markup or run
// script. Links go out only for http(s) addresses. A page sets corralMd.onLink to handle a click on one.
// markdown(text, local) with local = {link(target), image(target)} also draws images and links to other
// places: link answers the attributes for the <a>, image the address for the <img>, and either answers null
// to leave the markdown as text. corralMd.fileDoc draws a file of a project that way.
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

  const md = { h, onLink: null };
  // A `! command` (Claude Code runs a prompt that starts with ! as a shell command), alone in code or a code block.
  const BANG = /^! +\S/;
  const INLINE = /`([^`]+)`|\*\*(.+?)\*\*|\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)|(?<![\w*])\*(?![\s*])(.+?)(?<!\s)\*(?!\w)|(?<!\w)_(?![\s_])(.+?)(?<!\s)_(?!\w)|(https?:\/\/[^\s<>()]*[^\s<>().,;:!?'"])/g;
  // With local: [text](target) for any target (the text may be an image, as a badge is), and ![alt](target).
  const LOCAL = /\[((?:!\[[^\]]*\]\([^)\s]+(?: +"[^"]*")?\)|[^\]])+)\]\(([^)\s]+)(?: +"[^"]*")?\)|!\[([^\]]*)\]\(([^)\s]+)(?: +"[^"]*")?\)/;
  // Also with local, the HTML a README often holds: <img> and <a href> are drawn (through the same link and
  // image answers), <br> breaks the line, and the tags that only wrap them (<p>, <div>, <center>, <picture>,
  // <span>) are left out. Any other tag stays as text.
  const HTML = /(<img\b[^>]*>)|<a\b([^>]*)>([\s\S]*?)<\/a>|(<br\s*\/?>)|(<\/?(?:p|div|center|picture|span)\b[^>]*>)/;
  const INLINE_LOCAL = new RegExp(`${LOCAL.source}|${HTML.source}|${INLINE.source}`, 'gi'); // LOCAL first, or a badge's image reads as a link's text
  const attr = (tag, name) => { const m = tag.match(new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i')); return m ? m[1] ?? m[2] ?? m[3] : null; };
  const size = (v) => (/^\d+(px|%)?$/.test(v || '') ? v.replace('px', '') : null);
  const CENTERED = /^\s*<(?:(?:p|div)\b[^>]*\salign\s*=\s*["']?center|center\b)/i;
  function htmlPiece(m, local) {
    if (m[5]) {
      const src = attr(m[5], 'src');
      const to = src && local.image(src);
      return to ? [h('img', { src: to, alt: attr(m[5], 'alt') || '', title: attr(m[5], 'title'), width: size(attr(m[5], 'width')), height: size(attr(m[5], 'height')), loading: 'lazy' })] : [m[0]];
    }
    if (m[7] !== undefined) {
      const href = attr(m[6], 'href');
      const to = href && local.link(href);
      const inside = mdInline(m[7], local);
      return to ? [h('a', to, inside)] : inside; // a link Corral will not follow keeps its text
    }
    return m[8] ? [h('br')] : [];
  }
  function mdInline(s, local) {
    const out = [];
    let at = 0;
    const o = local ? 9 : 0; // where INLINE's groups start
    for (const m of s.matchAll(local ? INLINE_LOCAL : INLINE)) {
      if (m.index > at) out.push(s.slice(at, m.index));
      if (o && (m[2] || m[4])) {
        const to = m[2] ? local.link(m[2]) : local.image(m[4]);
        out.push(!to ? m[0] : m[2] ? h('a', to, mdInline(m[1], local)) : h('img', { src: to, alt: m[3], loading: 'lazy' }));
      } else if (o && (m[5] || m[7] !== undefined || m[8] || m[9])) out.push(...htmlPiece(m, local));
      else if (m[o + 1]) out.push(h('code', BANG.test(m[o + 1]) ? { class: 'bang' } : {}, m[o + 1]));
      else if (m[o + 2]) out.push(h('strong', {}, mdInline(m[o + 2], local)));
      else if (m[o + 3]) out.push(h('a', { href: m[o + 4], target: '_blank', rel: 'noopener', onclick: md.onLink }, mdInline(m[o + 3], local)));
      else if (m[o + 7]) out.push(h('a', { href: m[o + 7], target: '_blank', rel: 'noopener', onclick: md.onLink }, m[o + 7]));
      else out.push(h('em', {}, mdInline(m[o + 5] || m[o + 6], local)));
      at = m.index + m[0].length;
    }
    if (at < s.length) out.push(s.slice(at));
    return out;
  }

  const LIST_ITEM = /^( *)([-*+]|\d+[.)]) +(.*)$/;
  const TABLE_RULE = /^ *\|? *:?-+:? *(\| *:?-+:? *)*\|? *$/;
  const cells = (line) => line.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
  function markdown(text, local = null) {
    const lines = text.split('\n');
    const out = [];
    let para = [];
    const flush = () => {
      const text = para.join('\n');
      if (para.length) out.push(h('p', local && CENTERED.test(text) ? { class: 'center' } : {}, mdInline(text, local)));
      para = [];
    };
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
        out.push(h(`h${m[1].length}`, {}, mdInline(m[2], local)));
        i++;
      } else if (/^ *([-*_])( *\1){2,} *$/.test(line)) {
        flush();
        out.push(h('hr'));
        i++;
      } else if (/^ *>/.test(line)) {
        flush();
        const quote = [];
        for (; i < lines.length && /^ *>/.test(lines[i]); i++) quote.push(lines[i].replace(/^ *> ?/, ''));
        out.push(h('blockquote', {}, markdown(quote.join('\n'), local)));
      } else if (line.includes('|') && TABLE_RULE.test(lines[i + 1] || '')) {
        flush();
        const head = h('tr', {}, cells(line).map((c) => h('th', {}, mdInline(c, local))));
        const rows = [];
        for (i += 2; i < lines.length && lines[i].includes('|'); i++) rows.push(h('tr', {}, cells(lines[i]).map((c) => h('td', {}, mdInline(c, local)))));
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
          items.push(h('li', {}, markdown(body.join('\n'), local)));
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

  // ---- A markdown file of a project, drawn with its images and links ----
  // o.rel is the file's path in the project and o.base the query that names the project to Corral
  // ("space=..." or "window=..."). Web and mail links open in a new tab (corralMd.onLink handles the click,
  // if set). #heading jumps on the page. A link to another markdown file of the project goes to /view, or to
  // o.openMd(path, heading) if given; a link to any other file of the project calls o.openFile(path). An
  // image of the project comes from Corral; one on the web loads only over https.
  const OTHER_PLACE = /^([a-z][a-z0-9+.-]*:|\/\/)/i; // an address with a scheme, or //host
  const decoded = (s) => { try { return decodeURIComponent(s); } catch { return null; } };
  const HEADINGS = 'h1, h2, h3, h4, h5, h6';

  // Scrolls to the heading with this id (as a #heading link writes it), if the page has one.
  function jump(root, id) {
    const want = decoded(id)?.toLowerCase();
    [...root.querySelectorAll(HEADINGS)].find((x) => x.id === want)?.scrollIntoView();
  }

  function fileDoc(text, o) {
    // A path written in the file, as a path in the project: relative to the file's folder, or to the
    // project's folder when it starts with /. Null for one that leaves the project or names nothing.
    const inProject = (target) => {
      const p = decoded(target.replace(/[?#].*$/, ''));
      if (p === null) return null;
      const parts = p.startsWith('/') ? [] : o.rel.split('/').slice(0, -1);
      for (const seg of p.split('/')) {
        if (seg === '' || seg === '.') continue;
        if (seg !== '..') parts.push(seg);
        else if (!parts.pop()) return null;
      }
      return parts.join('/') || null;
    };
    const at = (p) => `${o.base}&path=${encodeURIComponent(p)}`;
    let root;
    const local = {
      link(target) {
        if (/^(https?:\/\/|mailto:)/i.test(target)) return { href: target, target: '_blank', rel: 'noopener', onclick: md.onLink };
        if (OTHER_PLACE.test(target)) return null;
        if (target.startsWith('#')) return { href: target.toLowerCase(), onclick: (e) => { e.preventDefault(); jump(root, target.slice(1)); } };
        const to = inProject(target);
        if (!to) return null;
        if (!/\.(md|markdown|qmd|rmd)$/i.test(to)) return { href: `#${to}`, title: o.fileTitle?.(to), onclick: (e) => { e.preventDefault(); o.openFile(to); } };
        const hash = (target.match(/#.*$/) || [''])[0].toLowerCase();
        return { href: `/view?${at(to)}${hash}`, onclick: o.openMd && ((e) => { e.preventDefault(); o.openMd(to, hash.slice(1)); }) };
      },
      image(target) {
        if (/^https:\/\//i.test(target)) return target;
        if (OTHER_PLACE.test(target)) return null;
        const to = inProject(target);
        return to && `/api/image?${at(to)}`;
      },
    };
    // Front matter (a YAML block between --- lines at the top) is shown as it is written, above the page.
    const body = text.replace(/\r\n/g, '\n');
    const front = body.match(/^---\n([\s\S]*?)\n(?:---|\.\.\.)[ \t]*(?:\n|$)/);
    root = h('div', { class: 'md' }, front ? h('pre', { class: 'front' }, front[1]) : null, markdown(front ? body.slice(front[0].length) : body, local));
    // Each heading gets the id GitHub gives it, so a #heading link has a place to go.
    const used = new Map();
    for (const hd of root.querySelectorAll(HEADINGS)) {
      const id = hd.textContent.trim().toLowerCase().replace(/[^\p{L}\p{N} _-]/gu, '').replace(/ /g, '-');
      const n = used.get(id) || 0;
      used.set(id, n + 1);
      hd.id = n ? `${id}-${n}` : id;
    }
    return root;
  }

  md.markdown = markdown;
  md.fileDoc = fileDoc;
  md.jump = jump;
  globalThis.corralMd = md;
})();
