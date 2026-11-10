'use strict';

/**
 * Dev-only syntax check for deobfuscated output.
 *
 * The output is Luau, so a plain Lua 5.1 parser rejects Luau-only constructs
 * (+=, -=, continue, ...). We rewrite just those tokens to Lua 5.1 equivalents
 * and then let a real Lua parser decide whether the rest is well-formed.
 *
 * Usage:  node tools/syntaxcheck.js <file.luau> [...]
 *         LUAJIT=/path/to/luajit node tools/syntaxcheck.js <file>
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const { tokenize } = require('../lib/lua');

const LUAJIT = process.env.LUAJIT || 'luajit';

const ASSIGN_OPS = new Set(['+=', '-=', '*=', '/=', '%=', '^=', '..=', '//=']);

/** Rewrite Luau-only tokens into Lua 5.1 equivalents, keeping everything else. */
function toLua51(src) {
  const toks = tokenize(src);
  const out = [];
  for (const t of toks) {
    if (t.t === 'op' && ASSIGN_OPS.has(t.v)) { out.push('='); continue; }
    if (t.t === 'name' && t.v === 'continue') { out.push('break'); continue; }
    out.push(t.t === 'str' ? t.raw : t.v);
  }
  return out.join(' ');
}

function check(file) {
  const src = fs.readFileSync(file, 'utf8');
  const tmp = path.join(os.tmpdir(), 'luau51_' + process.pid + '_' + path.basename(file) + '.lua');
  fs.writeFileSync(tmp, toLua51(src), 'utf8');

  const r = cp.spawnSync(LUAJIT, ['-e',
    `local f,e = loadfile(${JSON.stringify(tmp)}); io.write(f and "OK" or ("ERR\\t"..tostring(e)))`],
    { encoding: 'utf8' });

  try { fs.unlinkSync(tmp); } catch { /* ignore */ }

  if (r.error) return { ok: false, err: 'luajit tidak ditemukan: ' + r.error.message };
  const out = (r.stdout || '').trim();
  if (out === 'OK') return { ok: true };
  return { ok: false, err: out.replace(/^ERR\t/, '') || (r.stderr || '').trim() };
}

if (require.main === module) {
  const files = process.argv.slice(2);
  if (!files.length) { console.error('usage: node tools/syntaxcheck.js <file.luau> [...]'); process.exit(2); }
  let bad = 0;
  for (const f of files) {
    const res = check(f);
    if (res.ok) console.log('OK    ' + f);
    else { bad++; console.log('FAIL  ' + f + '\n      ' + res.err); }
  }
  process.exit(bad ? 1 : 0);
}

module.exports = { check, toLua51 };
