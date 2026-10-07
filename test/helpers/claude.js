// Helpers for the Claude Code status, prompt, transcript, changes, and push tests.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { loadServer, claudeSession } = require('./server');

const RULE = '─'.repeat(60);
const uuid = (n) => `${String(n).padStart(8, '0')}-aaaa-4bbb-8ccc-dddddddddddd`;

// A loaded server with push state ready, plus shortcuts to open windows and give them a Claude.
function setup(opts = {}) {
  const ctx = loadServer(opts);
  ctx.srv.loadPush();
  let n = 0;
  ctx.pidOf = (s) => (s.tmux ? ctx.tmux.sessions.get(`wt-${s.id}`).panePid : s.pty.pid);
  ctx.open = (label = 'work', dir = ctx.home) => ctx.srv.createSession(dir, label);
  // Writes the session file Claude Code keeps for the window and returns the conversation id.
  ctx.claude = (s, fields = {}) => {
    const sessionId = fields.sessionId || uuid(++n);
    claudeSession(ctx.home, fields.pid || ctx.pidOf(s), { ...fields, sessionId, pid: fields.pid || ctx.pidOf(s) });
    return sessionId;
  };
  ctx.screen = (s, text) => { ctx.tmux.sessions.get(`wt-${s.id}`).screen = text; };
  ctx.transcript = (sessionId, lines, project = 'proj') => {
    const dir = path.join(ctx.home, '.claude', 'projects', project);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${sessionId}.jsonl`);
    fs.writeFileSync(file, lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + '\n');
    return file;
  };
  return ctx;
}

// What Claude Code draws for a permission prompt, as an array of screen lines.
function promptScreen({ title = 'Bash command', body = ['  npm test', '  Run the tests'], question = 'Do you want to proceed?', options, tail = true } = {}) {
  const opts = options || ['Yes', "Yes, and don't ask again for npm test commands in /x", 'No, and tell Claude what to do differently (esc)'];
  return [
    'earlier output', RULE, ` ${title}`, '', ...body, '', ` ${question}`,
    ...opts.map((o, i) => `${i === 0 ? ' ❯ ' : '   '}${i + 1}. ${o}`),
    '', ...(tail ? [' Esc to cancel · Tab to amend'] : []), '', ' ⏵⏵ auto mode on (shift+tab to cycle)',
  ].join('\n');
}

// A push subscription whose keys the test holds, so it can decrypt what the server sends.
function makeSub(endpoint = 'https://web.push.apple.com/abc') {
  const ecdh = crypto.createECDH('prime256v1');
  const pub = ecdh.generateKeys();
  const auth = crypto.randomBytes(16);
  return { ecdh, pub, auth, sub: { endpoint, keys: { p256dh: pub.toString('base64url'), auth: auth.toString('base64url') } } };
}

const hkdf = (secret, salt, info, len) => Buffer.from(crypto.hkdfSync('sha256', secret, salt, info, len));

// RFC 8291 / RFC 8188 aes128gcm decryption, written separately from the server's code.
function decryptPush(ua, body) {
  const salt = body.subarray(0, 16);
  const recordSize = body.readUInt32BE(16);
  const idLen = body[20];
  const asPub = body.subarray(21, 21 + idLen);
  const ct = body.subarray(21 + idLen);
  const secret = ua.ecdh.computeSecret(asPub);
  const ikm = hkdf(secret, ua.auth, Buffer.concat([Buffer.from('WebPush: info\0'), ua.pub, asPub]), 32);
  const cek = hkdf(ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16);
  const nonce = hkdf(ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12);
  const d = crypto.createDecipheriv('aes-128-gcm', cek, nonce);
  d.setAuthTag(ct.subarray(ct.length - 16));
  const plain = Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]);
  return { recordSize, idLen, asPub, delimiter: plain[plain.length - 1], text: plain.subarray(0, plain.length - 1).toString() };
}

// Checks a "vapid t=<jwt>, k=<key>" header: the ES256 signature against the public key it names.
function checkVapid(header) {
  const m = header.match(/^vapid t=([\w-]+)\.([\w-]+)\.([\w-]+), k=([\w-]+)$/);
  if (!m) throw new Error(`not a vapid header: ${header}`);
  const [, head, claims, sig, k] = m;
  const spkiPrefix = Buffer.from('3059301306072a8648ce3d020106082a8648ce3d030107034200', 'hex');
  const key = crypto.createPublicKey({ key: Buffer.concat([spkiPrefix, Buffer.from(k, 'base64url')]), format: 'der', type: 'spki' });
  const valid = crypto.verify('sha256', Buffer.from(`${head}.${claims}`), { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(sig, 'base64url'));
  return { valid, head: JSON.parse(Buffer.from(head, 'base64url')), claims: JSON.parse(Buffer.from(claims, 'base64url')), k };
}

module.exports = { setup, promptScreen, makeSub, decryptPush, checkVapid, uuid, RULE };
