// ntfy (https://ntfy.sh) as a second way to hear from Corral, for a phone where Web Push does not arrive.
// Anyone who knows a topic's name on the public ntfy.sh server can read its messages, so the topic is a long
// random name made here, and a message says only which window and why (no prompt, no reply, no command).
// Settings are kept in ntfy.json in Corral's data folder.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SERVER = 'https://ntfy.sh';
const newTopic = () => `corral-${crypto.randomBytes(18).toString('base64url')}`;

function createNtfy(file) {
  let conf = { on: false, topic: null };
  try {
    const d = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (typeof d?.topic === 'string' && /^corral-[\w-]{20,}$/.test(d.topic)) conf = { on: d.on === true, topic: d.topic };
  } catch {}
  const save = () => {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(conf, null, 2), { mode: 0o600 });
      return true;
    } catch (e) { console.error('ntfy save failed:', e.message); return false; }
  };
  const view = () => ({ on: conf.on, topic: conf.topic, server: SERVER, url: conf.topic ? `${SERVER}/${conf.topic}` : null });
  return {
    view,
    get on() { return conf.on && Boolean(conf.topic); },
    // {on} turns it on or off (a topic is made the first time); {newTopic: true} replaces the topic, so a
    // phone subscribed to the old one stops hearing.
    set(body) {
      if (typeof body?.on !== 'boolean' && body?.newTopic !== true) return { status: 400, error: 'send on (true or false) or newTopic' };
      if (body.newTopic === true || (body.on && !conf.topic)) conf.topic = newTopic();
      if (typeof body.on === 'boolean') conf.on = body.on;
      return save() ? { status: 200, ...view() } : { status: 500, error: 'could not save the setting' };
    },
    // Sends one message: { title, brief, tag }. Answers 'ok', 'off', or 'failed'.
    async send({ title, brief, tag }) {
      if (!conf.on || !conf.topic) return 'off';
      try {
        const r = await fetch(SERVER, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ topic: conf.topic, title, message: brief, tags: [tag === 'permission' ? 'warning' : 'white_check_mark'], priority: tag === 'permission' ? 4 : 3 }),
          signal: AbortSignal.timeout(10000),
        });
        if (r.ok) return 'ok';
        console.error(`ntfy answered ${r.status}`);
        return 'failed';
      } catch (e) {
        console.error('ntfy send failed:', e.message);
        return 'failed';
      }
    },
  };
}

module.exports = { SERVER, createNtfy, newTopic };
