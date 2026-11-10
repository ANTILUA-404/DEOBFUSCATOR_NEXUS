'use strict';
const fs = require('fs');
const path = require('path');
const { deobfuscate } = require('../lib/deob');
const { tokenize, checkBalance } = require('../lib/lua');

const dir = process.argv[2] || '.';
const files = fs.readdirSync(dir).filter(f => /\.(luau|lua)$/i.test(f)).sort();

let pass = 0, fail = 0;
const rows = [];

for (const f of files) {
  const src = fs.readFileSync(path.join(dir, f), 'utf8');
  let r;
  const t0 = Date.now();
  try { r = deobfuscate(src); }
  catch (e) { rows.push({ f, status: 'CRASH', err: e.message }); fail++; continue; }
  const ms = Date.now() - t0;

  if (!r.ok) { rows.push({ f, status: 'FAIL', err: r.error }); fail++; continue; }

  const body = r.code.split('\n').filter(l => !l.startsWith('--')).join('\n');
  const bal = checkBalance(tokenize(body));
  const bad = bal.ok ? '' : bal.reason;

  if (bal.ok) pass++; else fail++;
  rows.push({
    f,
    status: bal.ok ? 'OK' : 'UNBALANCED',
    banner: r.fingerprint.banner,
    alpha: r.fingerprint.alphabetLength,
    xor: `${r.fingerprint.xorA}/${r.fingerprint.xorB}${r.fingerprint.transformOp === 'sub' ? '-' : '+'}`,
    variant: `len${r.fingerprint.variant.len} str${r.fingerprint.variant.stride} ${r.fingerprint.variant.order} ${r.fingerprint.variant.chain ? 'chain' : 'plain'}`,
    clean: (r.fingerprint.cleanRatio * 100).toFixed(1) + '%',
    entries: r.stats.tableEntries,
    calls: r.stats.calls,
    uniq: r.stats.uniqueStrings,
    fold: r.stats.constantsFolded,
    lines: r.code.split('\n').length,
    ms,
    notes: (r.notes || []).length,
    err: bad,
  });
}

const pad = (s, n) => String(s).padEnd(n);
console.log(pad('file', 30), pad('status', 11), pad('alpha', 6), pad('xor', 13), pad('variant', 22), pad('clean', 7), pad('entries', 8), pad('calls', 6), pad('uniq', 5), pad('lines', 6), 'ms');
console.log('-'.repeat(140));
for (const r of rows) {
  console.log(
    pad(r.f.replace('NXS9SD57_', '').replace('.luau', ''), 30),
    pad(r.status, 11),
    pad(r.alpha ?? '-', 6),
    pad(r.xor ?? '-', 13),
    pad(r.variant ?? '-', 22),
    pad(r.clean ?? '-', 7),
    pad(r.entries ?? '-', 8),
    pad(r.calls ?? '-', 6),
    pad(r.uniq ?? '-', 5),
    pad(r.lines ?? '-', 6),
    r.ms ?? ''
  );
  if (r.err) console.log('    ↳', r.err);
}
console.log(`\nPASS ${pass} / ${files.length}   FAIL ${fail}`);
