// How a window's token use reads on the Mac page and the phone: a short tag ("18% · $2.21") and the lines a
// hover or tap shows. The server works the numbers out from the transcript (lib/usage.js).
window.CorralUsage = (() => {
  const short = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e4 ? `${Math.round(n / 1e3)}k` : String(n));
  const dollars = (c) => (c < 0.01 ? '<$0.01' : `$${c.toFixed(2)}`);
  function text(u) {
    if (!u) return '';
    const ctx = u.context?.pct != null ? `${u.context.pct}%` : u.context ? `${short(u.context.used)} tokens` : '';
    return [ctx, u.cost != null ? dollars(u.cost) : ''].filter(Boolean).join(' · ');
  }
  function lines(u) {
    if (!u) return [];
    const out = [];
    if (u.context) {
      out.push(u.context.size
        ? `Context: ${u.context.used.toLocaleString()} of ${u.context.size.toLocaleString()} tokens (${u.context.pct}%)`
        : `Context: ${u.context.used.toLocaleString()} tokens`);
    }
    out.push(`Tokens so far: ${short(u.input)} input, ${short(u.output)} output, ${short(u.cacheRead)} cache read, ${short(u.cacheWrite)} cache write`);
    out.push(u.cost != null
      ? `About ${dollars(u.cost)} at API prices${u.model ? ` (${u.model})` : ''}. A Claude plan does not bill each token.`
      : 'No cost estimate: a model in this conversation is not in Corral\'s price table.');
    return out;
  }
  return { text, lines, title: (u) => lines(u).join('\n') };
})();
