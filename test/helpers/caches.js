// A stand-in for Cache Storage holding one cache, enough for the notification tap that sw.js leaves
// for m.js. `entries` maps a request path to the body text stored for it.
function fakeCaches(entries = new Map()) {
  const opened = [];
  const cache = {
    put: async (k, res) => { entries.set(k, await res.text()); },
    match: async (k) => (entries.has(k) ? new Response(entries.get(k)) : undefined),
    delete: async (k) => entries.delete(k),
  };
  return { entries, opened, open: async (name) => { opened.push(name); return cache; } };
}

module.exports = { fakeCaches };
