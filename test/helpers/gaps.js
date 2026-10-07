// Prints what coverage/lcov.info says is not covered: each line that never ran, each branch that was never
// taken, and each function never called, with the source line beside it. Usage: npm run coverage:gaps [file]
// With --check (as `npm test` runs it), it also fails when a file in scope is missing from the report: Node
// reports only the files a test loaded, so a file no test loads would otherwise drop out unnoticed.
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const check = process.argv.includes('--check');
const only = process.argv.slice(2).find((a) => !a.startsWith('--'));
const SCOPE = ['server.js', 'public/app.js', 'public/m.js', 'public/sw.js', 'scripts/apps-for-file.js'];
const lcov = fs.readFileSync(path.join(ROOT, 'coverage', 'lcov.info'), 'utf8');
let total = 0;
for (const rec of lcov.split('end_of_record')) {
  const file = rec.match(/^SF:(.*)$/m)?.[1];
  if (!file || (only && !file.endsWith(only))) continue;
  const src = fs.readFileSync(file, 'utf8').split('\n');
  const gaps = new Map(); // line -> reasons
  const note = (line, why) => gaps.set(line, [...(gaps.get(line) || []), why]);
  for (const [, line, hits] of rec.matchAll(/^DA:(\d+),(\d+)/gm)) if (hits === '0') note(Number(line), 'line');
  for (const [, line, , branch, taken] of rec.matchAll(/^BRDA:(\d+),(\d+),(\d+),(-|\d+)/gm)) if (taken === '-' || taken === '0') note(Number(line), `branch ${branch}`);
  const fnLines = new Map([...rec.matchAll(/^FN:(\d+),(.*)$/gm)].map(([, l, n]) => [n, Number(l)]));
  for (const [, hits, name] of rec.matchAll(/^FNDA:(\d+),(.*)$/gm)) if (hits === '0') note(fnLines.get(name), `function ${name}`);
  if (!gaps.size) continue;
  console.log(`\n${path.relative(ROOT, file)}: ${gaps.size} line(s) with gaps`);
  for (const line of [...gaps.keys()].sort((a, b) => a - b)) {
    console.log(`  ${String(line).padStart(5)} [${gaps.get(line).join(', ')}] ${(src[line - 1] || '').trim().slice(0, 110)}`);
  }
  total += gaps.size;
}
const reported = new Set([...lcov.matchAll(/^SF:(.*)$/gm)].map(([, f]) => path.relative(ROOT, f)));
const missing = SCOPE.filter((f) => !reported.has(f));
for (const f of missing) console.log(`\n${f}: not loaded by any test, so it has no coverage at all`);
if (!total && !missing.length) console.log('No coverage gaps.');
if (check && (total || missing.length)) process.exit(1);
