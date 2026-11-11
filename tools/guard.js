'use strict';

/**
 * Guard test: kode ASLI di sekitar blok obfuscated tidak boleh ikut terhapus.
 * Kalau deklarasi hilang tapi pemakaiannya tetap, script hasilnya RUSAK.
 *
 * Usage: node tools/guard.js
 */

const fs = require('fs');
const path = require('path');
const { deobfuscate } = require('../lib/deob');

const sample = path.join(__dirname, '..', 'sample.nxs9.lua');
if (!fs.existsSync(sample)) {
  console.error('sample.nxs9.lua tidak ada — jalankan dulu: node tools/selftest.js --keep');
  process.exit(2);
}
const src = fs.readFileSync(sample, 'utf8');

const prefix = [
  'local Players = game:GetService("Players")',
  'local cfg = { debug = true }',
  '',
].join('\n');
const suffix = '\nprint(Players.LocalPlayer, cfg.debug)\n';

const r = deobfuscate(prefix + src + suffix);

const checks = {
  'deobfuscate ok': r.ok === true,
  'deklarasi Players utuh': r.code.includes('local Players = game:GetService("Players")'),
  'deklarasi cfg utuh': /local cfg = \{\s*debug = true\s*\}/.test(r.code),
  'pemakaian sesudah utuh': r.code.includes('print(Players.LocalPlayer, cfg.debug)'),
  'string hasil dekripsi ada': r.code.includes('local s0 = "Hello world"'),
  'unicode utuh': r.code.includes('日本語 café ñ'),
  'identifier panjang di string utuh': r.code.includes('_abcdefghijklmnop harus utuh'),
};

let pass = true;
for (const [k, v] of Object.entries(checks)) {
  if (!v) pass = false;
  console.log((v ? 'PASS  ' : 'FAIL  ') + k);
}
console.log('notes: ' + JSON.stringify(r.notes || []));
console.log(pass ? '>>> GUARD LULUS' : '>>> GUARD GAGAL');
process.exit(pass ? 0 : 1);
