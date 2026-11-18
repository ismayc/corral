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
  // image answers), <br> breaks the line, the text tags (<b>, <i>, <code>, <kbd>, <sub>, <sup>, <del>, and the like) are drawn as themselves, and the tags
  // that only wrap things (<p>, <div>, <center>, <picture>, <span>) and comments are left out. <h1> to <h6>,
  // <hr>, and the HTML blocks below (tables, lists, <details>) are drawn by markdown(). Any other tag stays
  // as text.
  const HTML = /(<img\b[^>]*>)|<a\b([^>]*)>([\s\S]*?)<\/a>|(<br\s*\/?>)|(<\/?(?:p|div|center|picture|span)\b[^>]*>|<!--[\s\S]*?-->)|<(?<t>b|strong|i|em|code|kbd|sub|sup|del|s|u|mark|small)(?:\s[^>]*)?>([\s\S]*?)<\/\k<t>>/;
  const INLINE_LOCAL = new RegExp(`${LOCAL.source}|${HTML.source}|${INLINE.source}`, 'gi'); // LOCAL first, or a badge's image reads as a link's text
  const attr = (tag, name) => { const m = tag.match(new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i')); return m ? m[1] ?? m[2] ?? m[3] : null; };
  const size = (v) => (/^\d+(px|%)?$/.test(v || '') ? v.replace('px', '') : null);
  const ALIGN_CENTER = /\salign\s*=\s*["']?center/i;
  const CENTERED = /^\s*<(?:(?:p|div)\b[^>]*\salign\s*=\s*["']?center|center\b)/i;
  const HTML_HEADING = /^ *<h([1-6])\b([^>]*)>/i;
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
    if (m[10]) {
      const tag = m[10].toLowerCase();
      return [h(tag, {}, tag === 'code' || tag === 'kbd' ? m[11] : mdInline(m[11], local))]; // code is shown as written
    }
    return m[8] ? [h('br')] : [];
  }
  function mdInline(s, local) {
    const out = [];
    let at = 0;
    const o = local ? 11 : 0; // where INLINE's groups start
    for (const m of s.matchAll(local ? INLINE_LOCAL : INLINE)) {
      if (m.index > at) out.push(s.slice(at, m.index));
      if (o && (m[2] || m[4])) {
        const to = m[2] ? local.link(m[2]) : local.image(m[4]);
        out.push(!to ? m[0] : m[2] ? h('a', to, mdInline(m[1], local)) : h('img', { src: to, alt: m[3], loading: 'lazy' }));
      } else if (o && (m[5] || m[7] !== undefined || m[8] || m[9] || m[10])) out.push(...htmlPiece(m, local));
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

  // The line after the one that closes the <hN> opened on line i, or 0 when a blank line or the end comes first.
  function htmlHeading(lines, i, n) {
    for (let j = i; j < lines.length && lines[j].trim(); j++) if (lines[j].toLowerCase().includes(`</h${n}>`)) return j + 1;
    return 0;
  }

  // ---- HTML blocks: <table>, <ul>, <ol>, and <details>, with what goes inside them ----
  // The block's tags are read into a tree, and each element is built here, never handed to the browser as
  // HTML, so nothing but these tags and a few plain attributes can come out. Text inside a list item or
  // <details> is drawn as markdown; text inside a cell, caption, or summary as one line of it.
  const HTML_BLOCK = /^ *<(table|ul|ol|details)\b[^>]*>/i;
  const STRUCT = /<(\/?)(table|thead|tbody|tfoot|tr|th|td|caption|ul|ol|li|details|summary)\b([^>]*)>/gi;
  // An opening tag ends these when one is still open, as a browser does: <li>one<li>two, <tr><td>a<td>b.
  const ROWS = ['td', 'th', 'tr'];
  const ENDS = { li: ['li'], td: ['td', 'th'], th: ['td', 'th'], tr: ROWS, thead: [...ROWS, 'thead', 'tbody', 'tfoot'], tbody: [...ROWS, 'thead', 'tbody', 'tfoot'], tfoot: [...ROWS, 'thead', 'tbody', 'tfoot'] };
  const FLOW = new Set(['root', 'li', 'details']);

  // The line after the one where the block opened on line i closes (nested blocks of its kind counted), or
  // 0 when it never closes.
  function htmlBlockEnd(lines, i, tag) {
    const re = new RegExp(`<(/?)${tag}\\b`, 'gi');
    let depth = 0;
    for (let j = i; j < lines.length; j++) {
      for (const t of lines[j].matchAll(re)) {
        depth += t[1] ? -1 : 1;
        if (!depth) return j + 1;
      }
    }
    return 0;
  }

  function htmlTree(html) {
    const root = { tag: 'root', attrs: '', kids: [] };
    const stack = [root];
    let at = 0;
    for (const m of html.matchAll(STRUCT)) {
      stack.at(-1).kids.push(html.slice(at, m.index));
      at = m.index + m[0].length;
      const tag = m[2].toLowerCase();
      if (m[1]) {
        const open = stack.findLastIndex((n) => n.tag === tag);
        if (open > 0) stack.length = open; // a closing tag with nothing open is passed over
        continue;
      }
      while ((ENDS[tag] || []).includes(stack.at(-1).tag)) stack.pop();
      const node = { tag, attrs: m[3], kids: [] };
      stack.at(-1).kids.push(node);
      stack.push(node);
    }
    root.kids.push(html.slice(at));
    return root;
  }

  // Text indented with its tags loses that indent, so markdown reads it as written at the margin.
  function dedent(text) {
    const lines = text.replace(/^\n+|\s+$/g, '').split('\n');
    const n = Math.min(...lines.filter((l) => l.trim()).map((l) => l.match(/^ */)[0].length));
    return lines.map((l) => l.slice(n)).join('\n');
  }
  const digits = (v) => (/^\d+$/.test(v || '') ? v : null);

  // The elements for a tree node: an array for the root, one element otherwise.
  function htmlNode(node, local) {
    const kids = [];
    let text = '';
    const flush = () => {
      if (text.trim()) kids.push(...(FLOW.has(node.tag) ? markdown(dedent(text), local) : mdInline(text.trim(), local)));
      text = '';
    };
    for (const k of node.kids) {
      if (typeof k === 'string') text += k;
      else { flush(); kids.push(htmlNode(k, local)); }
    }
    flush();
    if (node.tag === 'root') return kids;
    const align = attr(node.attrs, 'align')?.toLowerCase();
    const el = h(node.tag, {
      colspan: digits(attr(node.attrs, 'colspan')), rowspan: digits(attr(node.attrs, 'rowspan')), start: digits(attr(node.attrs, 'start')),
      align: ['left', 'center', 'right'].includes(align) ? align : null, open: node.tag === 'details' && /\sopen\b/i.test(node.attrs) ? '' : null,
    }, kids);
    return node.tag === 'table' ? h('div', { class: 'table' }, el) : el; // the div lets a wide table scroll
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
      const kids = mdInline(text, local);
      // A paragraph that held only a comment or wrapping tags draws nothing.
      if (kids.some((k) => typeof k !== 'string' || k.trim())) out.push(h('p', local && CENTERED.test(text) ? { class: 'center' } : {}, kids));
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
      } else if (local && (m = line.match(HTML_HEADING)) && htmlHeading(lines, i, m[1])) {
        // <h2 align="center">...</h2>, on one line or several (a logo above a title, say).
        flush();
        const end = htmlHeading(lines, i, m[1]);
        const inside = lines.slice(i, end).join('\n').replace(HTML_HEADING, '').replace(new RegExp(`</h${m[1]}>[^]*$`, 'i'), '');
        out.push(h(`h${m[1]}`, ALIGN_CENTER.test(m[2]) ? { class: 'center' } : {}, mdInline(inside.trim(), local)));
        i = end;
      } else if (local && (m = line.match(HTML_BLOCK)) && htmlBlockEnd(lines, i, m[1])) {
        flush();
        const end = htmlBlockEnd(lines, i, m[1]);
        out.push(...htmlNode(htmlTree(lines.slice(i, end).join('\n')), local));
        i = end;
      } else if (/^ *([-*_])( *\1){2,} *$/.test(line) || (local && /^ *<hr\b[^>]*> *$/i.test(line))) {
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
