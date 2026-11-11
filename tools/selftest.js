'use strict';

/**
 * Self-test: bangun sample NXS9 sintetis dari plaintext yang diketahui,
 * jalankan deobfuscate(), lalu buktikan:
 *   1. deteksi berhasil
 *   2. SETIAP string asli kembali byte-exact
 *   3. output lolos parser Lua sungguhan (luajit)
 *
 * Ini round-trip test, bukan "kelihatannya benar".
 *
 * Usage: node tools/selftest.js [--keep]
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const { deobfuscate } = require('../lib/deob');
const { tokenize } = require('../lib/lua');

const LUAJIT = process.env.LUAJIT || 'luajit';

/* --------------------------- encoder NXS9 --------------------------- */

const M1 = 64, ADD = 33, I1 = 28, I2 = 89, M2 = 14, I3 = 50;

function bxor(...a) {
  let r = 0;
  for (const x of a) r = (r ^ (x >>> 0)) >>> 0;
  return r;
}
const mod = (a, b) => ((a % b) + b) % b;

function makeAlphabet() {
  // 85 karakter unik. Kutip dan backslash DIBUANG: base85 asli juga begitu,
  // kalau tidak, literal Lua-nya putus sebelum sempat diparse.
  const all = [];
  for (let c = 33; c <= 126; c++) {
    if (c === 34 || c === 39 || c === 92) continue; // " ' \
    all.push(String.fromCharCode(c));
  }
  let s = 20260101;
  for (let i = all.length - 1; i > 0; i--) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    const j = s % (i + 1);
    [all[i], all[j]] = [all[j], all[i]];
  }
  return all.slice(0, 85).join('');
}

function b85encode(bytes, alpha, order) {
  const out = [];
  const pad = (4 - (bytes.length % 4)) % 4;
  const buf = Buffer.concat([Buffer.from(bytes), Buffer.alloc(pad, 0)]);
  for (let i = 0; i < buf.length; i += 4) {
    let be = [buf[i], buf[i + 1], buf[i + 2], buf[i + 3]];
    if (order === 'le') be = be.slice().reverse();
    let v = ((be[0] << 24) | (be[1] << 16) | (be[2] << 8) | be[3]) >>> 0;
    const chunk = [];
    for (let k = 0; k < 5; k++) {
      chunk.unshift(alpha[v % 85]);
      v = Math.floor(v / 85);
    }
    out.push(...chunk);
  }
  return out.join('');
}

/** Balik dari plaintext ke ciphertext, memakai rumus yang sama dengan dekriptor. */
function encrypt(plainBytes, a2, a3, len, stride, mode, chain) {
  const C = new Array(len).fill(0);
  let k = bxor(a2, a3);
  let o2 = a2;
  const m = mod(mode - 1, 4) + 1;
  for (let i = 1; i <= len; i++) {
    o2 = mod(o2 * M1 + ADD + i * I1, 256);
    const v1 = bxor(o2, mod(i * I2 + a3, 256), k);
    const v2 = mod(a3 * M2 + i * I3 + a2, 256);
    const pos = mod((i - 1) * stride, len);
    const P = plainBytes[i - 1];
    let b;
    if (m === 1) b = mod(bxor(P, v1) + v2, 256);
    else if (m === 2) b = bxor(mod(P + v2, 256), v1);
    else if (m === 3) b = mod(bxor(P, mod(v1 + v2, 256)) + a3, 256);
    else b = bxor(P, mod(v1 + v2 + a3, 256));
    C[pos] = b;
    if (chain) k = b;
  }
  return C;
}

function gcd(a, b) { while (b) { [a, b] = [b, a % b]; } return a; }

function buildEntry(text, alpha, opts) {
  // Plaintext diperlakukan sebagai BYTE UTF-8 — sama seperti isi file .lua asli.
  const bytes = Array.from(Buffer.from(text, 'utf8'));
  const len = bytes.length;
  const a2 = 40 + (opts.seed % 120);
  const a3 = 130 + ((opts.seed * 7) % 110);
  let stride = 2;
  while (gcd(stride, len) !== 1 && stride < len) stride++;
  if (gcd(stride, len) !== 1) stride = 1;
  const mode = opts.mode ?? ((opts.seed % 4) + 1);
  const C = encrypt(bytes, a2, a3, len, stride, mode, opts.chain);
  const raw = b85encode(C, alpha, opts.order);
  return `{"${raw}",${a2},${a3},${len},${stride},${mode}}`;
}

const SAMPLES = [
  'Hello world',
  'Players',
  'game:GetService("Players")',
  'Teks dengan "kutip ganda" di dalam',
  "Teks dengan 'kutip tunggal' di dalam",
  'Backslash \\ dan newline \\n literal',
  'Pola Lua: %d+ dan %s*',
  'Kurung panjang ]] dan [[ di dalam',
  'Komentar palsu -- bukan komentar',
  'Unicode: 日本語 café ñ',
  'Nama panjang _abcdefghijklmnop harus utuh',
  'Variabel v_12 harus utuh',
  'angka 12345 dan 0x1F',
  'Spasi    berlebih',
  '',
  'x',
];

function buildObfuscated(alpha, entries, calls, opts) {
  const L = [];
  L.push('--[=[ NXS9 synthetic sample ]=]');
  L.push(`local A = "${alpha}"`);
  L.push('local AM = {}');
  L.push('for q = 1, #A do AM[string.byte(A, q)] = q - 1 end');
  L.push('local B = string.byte');
  L.push('local T = {');
  L.push(entries.join(',\n'));
  L.push('}');
  L.push('local function D(i)');
  L.push('  i = bit32.bxor(i, 123) - 5');
  L.push('  local e = T[i]');
  L.push('  if not e then return "" end');
  L.push('  local s = e[1]');
  L.push('  local a2, a3 = e[2], e[3]');
  L.push('  local len, stride = e[4], e[5]');
  L.push('  local o = {}');
  L.push('  local k = bit32.bxor(a2, a3)');
  L.push('  local o2 = a2');
  L.push('  for n = 1, len do');
  L.push(`    o2 = (o2 * ${M1} + ${ADD} + n * ${I1}) % 256`);
  L.push(`    local v1 = bit32.bxor(o2, (n * ${I2} + a3) % 256, k)`);
  L.push(`    local v2 = (a3 * ${M2} + n * ${I3} + e[2]) % 256`);
  L.push('    local p = ((n - 1) * stride) % len');
  L.push('    local b = B(s, p + 1)');
  L.push('    o[n] = bit32.bxor((b - v2) % 256, v1)');
  L.push('    k = b');
  L.push('  end');
  L.push('  return string.char(unpack(o))');
  L.push('end');
  L.push(calls.join('\n'));
  L.push('print("done")');
  return L.join('\n');
}

/* ------------------------------ verifikasi ------------------------------ */

function stringValues(code) {
  return tokenize(code).filter((t) => t.t === 'str').map((t) => t.v);
}

function syntaxCheck(code) {
  const tmp = path.join(os.tmpdir(), 'selftest_' + process.pid + '.lua');
  fs.writeFileSync(tmp, code, 'utf8');
  const r = cp.spawnSync(LUAJIT, ['-e',
    `local f,e=loadfile(${JSON.stringify(tmp)}); io.write(f and "OK" or ("ERR\\t"..tostring(e)))`],
    { encoding: 'utf8' });
  try { fs.unlinkSync(tmp); } catch { /* ignore */ }
  if (r.error) return { ok: false, err: 'luajit tidak ada: ' + r.error.message };
  const out = (r.stdout || '').trim();
  return out === 'OK' ? { ok: true } : { ok: false, err: out.replace(/^ERR\t/, '') };
}

/* -------------------------------- main -------------------------------- */

function main() {
  const sweep = process.argv.includes('--sweep');
  const keep = process.argv.includes('--keep');
  if (sweep) return runSweep();

  const alpha = makeAlphabet();
  const res = runOnce({ alpha, opts: { seed: 7, chain: true, order: 'be' }, keep });
  return res.pass ? 0 : 1;
}

/** Satu putaran penuh: bangun sample -> deobfuscate -> verifikasi. */
function runOnce({ alpha, opts, keep }) {
  const texts = SAMPLES;
  const entries = texts.map((t, i) =>
    buildEntry(t, alpha, { ...opts, seed: 11 + i * 3 }));

  const calls = texts.map((t, i) => {
    const real = i + 1;
    const arg = bxor(mod(real + 5, 256), 123);
    return `local s${i} = D(${arg})`;
  });

  const src = buildObfuscated(alpha, entries, calls, opts);
  if (keep) fs.writeFileSync(path.join(__dirname, '..', 'sample.nxs9.lua'), src, 'utf8');

  const res = deobfuscate(src);
  if (!res.ok) {
    return { pass: false, miss: texts.length, syn: { ok: false, err: res.error }, error: res.error, stats: null };
  }

  const got = new Set(stringValues(res.code));
  let miss = 0;
  const missing = [];
  for (const t of texts) {
    if (t === '') continue;
    if (!got.has(t)) { miss++; missing.push(t); }
  }
  const syn = syntaxCheck(res.code);
  if (keep) fs.writeFileSync(path.join(__dirname, '..', 'out.luau'), res.code, 'utf8');
  return { pass: miss === 0 && syn.ok, miss, missing, syn, stats: res.stats, notes: res.notes };
}

/** Sweep: semua kombinasi order x chain x mode. */
function runSweep() {
  const alpha = makeAlphabet();
  const combos = [];
  for (const order of ['be', 'le']) {
    for (const chain of [true, false]) {
      for (const mode of [1, 2, 3, 4]) combos.push({ order, chain, mode });
    }
  }

  console.log('=== SWEEP: ' + combos.length + ' kombinasi order x chain x mode ===');
  let pass = 0;
  for (const c of combos) {
    const r = runOnce({ alpha, opts: { seed: 7, ...c }, keep: false });
    const tag = `${c.order} chain=${c.chain ? 'y' : 'n'} mode=${c.mode}`;
    if (r.pass) { pass++; console.log(`  PASS  ${tag}`); }
    else {
      const why = r.error ? 'deteksi: ' + r.error : `miss ${r.miss} | ${r.syn.ok ? 'sintaks ok' : 'sintaks: ' + r.syn.err}`;
      console.log(`  FAIL  ${tag}  ->  ${why}`);
      if (r.missing && r.missing.length) console.log('        hilang: ' + JSON.stringify(r.missing.slice(0, 3)));
    }
  }
  console.log('---------------------------------------');
  console.log(`lulus ${pass}/${combos.length}`);
  return pass === combos.length ? 0 : 1;
}

process.exit(main());
