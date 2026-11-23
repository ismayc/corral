// Prompts waiting their turn in a window. Corral types the next one into the window's Claude Code when
// Claude has finished (its session file says idle), has been idle a few seconds, has changed status since
// the last prompt Corral typed, and its input box holds nothing you typed. Kept in queue.json in Corral's
// data folder, by window id, so a server restart keeps the queue.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const QUIET_MS = 5000; // idle this long before the next prompt goes in
const MAX_ITEMS = 50;
const TEXT_MAX = 4000;

// The text you typed into Claude Code's input box, from the window's screen with its colors (capture-pane -e):
// everything between the last two rules that is not dim. Claude Code draws its suggested next prompt dim
// after the ❯ (seen November 23, 2026: "\x1b[39m❯\xa0\x1b[2mopen the page\x1b[0m"), so a suggestion is not a
// draft. Null when the screen has no input box (a dialog is open, or Claude Code is not drawing one).
function inputDraft(styled) {
  if (!Array.isArray(styled)) return null;
  const plain = styled.map((l) => l.replace(/\x1b\[[0-9;]*m/g, ''));
  const rules = plain.map((l, i) => (/^\s*─{20,}\s*$/.test(l) ? i : -1)).filter((i) => i >= 0);
  if (rules.length < 2) return null;
  const [from, to] = rules.slice(-2);
  if (!plain.slice(from + 1, to).some((l) => l.includes('❯'))) return null;
  let text = '';
  for (const line of styled.slice(from + 1, to)) {
    let dim = false;
    for (const part of line.split(/(\x1b\[[0-9;]*m)/)) {
      const sgr = part.match(/^\x1b\[([0-9;]*)m$/);
      if (sgr) {
        for (const code of (sgr[1] || '0').split(';')) {
          if (code === '2') dim = true;
          else if (code === '0' || code === '22' || code === '') dim = false;
        }
      } else if (!dim) text += part;
    }
    text += '\n';
  }
  return text.replace(/❯/g, '').replace(/[\s ]+/g, ' ').trim();
}

// One line of printable text, at most TEXT_MAX characters, or null. Claude Code sends a prompt on Enter, so a
// queued prompt is one line.
function cleanText(v) {
  if (typeof v !== 'string') return null;
  const t = v.replace(/[\x00-\x1f\x7f]+/g, ' ').replace(/\s+/g, ' ').trim();
  return t ? t.slice(0, TEXT_MAX) : null;
}

function createQueue(file) {
  let data = {};
  try {
    const d = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (d && typeof d === 'object' && d.windows && typeof d.windows === 'object') data = d.windows;
  } catch {}
  const save = () => {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify({ version: 1, windows: data }, null, 2));
    } catch (e) { console.error('queue save failed:', e.message); }
  };
  const entry = (id) => (data[id] ||= { items: [], sentAt: 0 });
  const list = (id) => (data[id]?.items || []).map((x) => ({ ...x }));
  return {
    list,
    count: (id) => data[id]?.items.length || 0,
    add(id, text) {
      const t = cleanText(text);
      if (!t) return { status: 400, error: 'a prompt of 1 to 4000 characters' };
      const e = entry(id);
      if (e.items.length >= MAX_ITEMS) return { status: 409, error: `this window already has ${MAX_ITEMS} prompts waiting` };
      const item = { id: crypto.randomBytes(6).toString('hex'), text: t, added: Date.now() };
      e.items.push(item);
      save();
      return { status: 200, item, items: list(id) };
    },
    remove(id, itemId) {
      const e = data[id];
      const before = e?.items.length || 0;
      if (e) e.items = e.items.filter((x) => x.id !== itemId);
      if (!before || e.items.length === before) return { status: 404, error: 'no such prompt in the queue' };
      save();
      return { status: 200, items: list(id) };
    },
    clear(id) {
      if (data[id]) { data[id].items = []; save(); }
      return { status: 200, items: [] };
    },
    // Forgets the queues of windows that are gone.
    prune(liveIds) {
      let changed = false;
      for (const id of Object.keys(data)) if (!liveIds.has(id)) { delete data[id]; changed = true; }
      if (changed) save();
    },
    // The prompt to type now, or null. `claude` is the window's Claude Code status from its session file.
    due(id, claude, now = Date.now()) {
      const e = data[id];
      if (!e?.items.length || !claude || claude.status !== 'idle' || claude.waitingFor) return null;
      const since = Number(claude.since) || 0;
      if (now - since < QUIET_MS) return null; // just finished; give you a moment to type first
      if (e.sentAt && since <= e.sentAt) return null; // Claude has not taken the last one up yet
      return { ...e.items[0] };
    },
    // The prompt was typed: off the queue, and the time noted so the next waits for Claude to take it up.
    sent(id, itemId, now = Date.now()) {
      const e = data[id];
      if (!e) return;
      e.items = e.items.filter((x) => x.id !== itemId);
      e.sentAt = now;
      save();
    },
  };
}

module.exports = { QUIET_MS, MAX_ITEMS, inputDraft, cleanText, createQueue };
