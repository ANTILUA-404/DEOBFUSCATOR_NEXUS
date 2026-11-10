'use strict';

const { tokenize, parseValue, format, luaQuote, checkBalance, luaMod, sanitizeSemicolons } = require('./lua');

/* ------------------------------ helpers ------------------------------ */

function bxor(...args) {
  let r = 0;
  for (const a of args) r = (r ^ (a >>> 0)) >>> 0;
  return r;
}

function utf8Of(latin1) {
  const buf = Buffer.from(latin1, 'latin1');
  const txt = buf.toString('utf8');
  return Buffer.from(txt, 'utf8').equals(buf) ? txt : null;
}

function isCleanText(latin1) {
  if (latin1 === '') return true;
  const txt = utf8Of(latin1);
  if (txt === null) return false;
  for (const ch of txt) {
    const c = ch.codePointAt(0);
    if (c === 9 || c === 10 || c === 13) continue;
    if (c < 32) return false;
  }
  return true;
}

function findFunctionEnd(toks, funcIdx) {
  let depth = 0, pendingDo = false;
  for (let i = funcIdx; i < toks.length; i++) {
    const tk = toks[i];
    if (tk.t !== 'name') continue;
    const v = tk.v;
    if (v === 'for' || v === 'while') { depth++; pendingDo = true; }
    else if (v === 'do') { if (pendingDo) pendingDo = false; else depth++; }
    else if (v === 'function' || v === 'if' || v === 'repeat') depth++;
    else if (v === 'end' || v === 'until') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function findMatchingParen(toks, openIdx) {
  let depth = 0;
  for (let i = openIdx; i < toks.length; i++) {
    const tk = toks[i];
    if (tk.t !== 'op') continue;              // ignore strings whose value is "("
    if (tk.v === '(') depth++;
    else if (tk.v === ')') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/* ---------------------------- base85 ---------------------------- */

function b85decode(raw, alphaMap, order) {
  const out = [];
  for (let i = 0; i + 4 < raw.length; i += 5) {
    let v = 0;
    for (let j = 0; j < 5; j++) {
      const idx = alphaMap.get(raw.charCodeAt(i + j));
      if (idx === undefined) return null;
      v = v * 85 + idx;
    }
    const be = [Math.floor(v / 16777216) % 256, Math.floor(v / 65536) % 256, Math.floor(v / 256) % 256, v % 256];
    if (order === 'le') be.reverse();
    out.push(...be);
  }
  return out;
}

/* --------------------------- detection --------------------------- */

function detectTable(toks) {
  let best = null;
  for (let i = 1; i < toks.length - 5; i++) {
    if (toks[i].v !== '=' || toks[i - 1].t !== 'name') continue;
    let j = i + 1, braces = 0;
    while (toks[j] && toks[j].v === '{') { braces++; j++; }
    if (braces === 0) continue;
    // fast shape filter: <str> , (<num>|"("|"-")
    const n1 = toks[j + 1], n2 = toks[j + 2];
    if (!(toks[j] && toks[j].t === 'str' && n1 && n1.v === ',' && n2
          && (n2.t === 'num' || n2.v === '(' || n2.v === '-'))) continue;

    const st = { i: i + 1 };
    let val;
    try { val = parseValue(toks, st); } catch { continue; }
    if (!Array.isArray(val) || val.length < 16) continue;
    const ok = val.every(x => Array.isArray(x) && typeof x[0] === 'string'
      && x.length >= 4 && x.slice(1).every(y => typeof y === 'number'));
    if (!ok) continue;
    if (!best || val.length > best.entries.length) {
      const stmtTok = (i >= 2 && toks[i - 2].v === 'local') ? i - 2 : i - 1;
      best = { name: toks[i - 1].v, nameIdx: i - 1, entries: val, startTok: stmtTok, endTok: st.i };
    }
  }
  return best;
}

function detectAlphabet(toks, src) {
  const cands = [];
  for (let i = 1; i < toks.length - 1; i++) {
    if (toks[i].v !== '=' || toks[i - 1].t !== 'name') continue;
    const s = toks[i + 1];
    if (!s || s.t !== 'str') continue;
    const v = s.v;
    if (v.length < 40 || v.length > 100) continue;
    if (new Set(v).size !== v.length) continue;      // all chars unique
    if (!new RegExp('string\\.byte\\(\\s*' + toks[i - 1].v.replace(/[^\w]/g, '') + '\\b').test(src)) continue;
    cands.push({ name: toks[i - 1].v, value: v });
  }
  return cands.length ? cands[0] : null;
}

function detectDecryptor(toks) {
  const defs = [];
  for (let i = 0; i + 1 < toks.length; i++) {
    if (toks[i].v === 'local' && toks[i + 1].v === 'function' && toks[i + 2] && toks[i + 2].t === 'name') {
      defs.push({ name: toks[i + 2].v, funcIdx: i + 1, nameIdx: i + 2 });
    }
  }
  let best = null;
  for (const d of defs) {
    let calls = 0;
    for (let i = 0; i < toks.length; i++) {
      if (toks[i].t === 'name' && toks[i].v === d.name) {
        if (i > 0 && toks[i - 1].v === 'function') continue;
        if (toks[i + 1] && toks[i + 1].v === '(') calls++;
      }
    }
    if (!best || calls > best.calls) best = { ...d, calls };
  }
  return best;
}

function detectTransform(src, decName) {
  const out = [];
  const idx = src.indexOf('function ' + decName);
  const win = src.slice(Math.max(0, idx - 200), idx + 6000);
  const re = /bit32\.bxor\(\s*[A-Za-z_]\w*\s*,\s*(\d+)\s*\)\s*([-+])\s*(\d+)/g;
  let m;
  while ((m = re.exec(win))) {
    out.push({ op: m[2] === '-' ? 'sub' : 'add', a: Number(m[1]), b: Number(m[3]) });
  }
  out.push({ op: 'sub', a: 0, b: 0 });
  return out;
}

/**
 * The keystream constants are re-randomised on every build:
 *   o2 = (o2*M1 + ADD + i*I1) % 256
 *   v1 = bxor(o2, (i*I2 + a3) % 256, k)
 *   v2 = (a3*M2 + i*I3 + entry[2]) % 256
 * Read them straight out of the decryptor body instead of assuming values.
 */
const DEFAULT_CIPHER = { M1: 64, ADD: 33, I1: 28, I2: 89, M2: 14, I3: 50 };

function detectCipherParams(body) {
  const p = { ...DEFAULT_CIPHER };
  let m;
  let found = 0;
  if ((m = body.match(/\((\w+)\*(\d+)\+(\d+)\+(\w+)\*(\d+)\)\s*%\s*256/))) {
    p.M1 = +m[2]; p.ADD = +m[3]; p.I1 = +m[5]; found++;
  }
  if ((m = body.match(/bit32\.bxor\((\w+),\((\w+)\*(\d+)\+(\w+)\)\s*%\s*256,(\w+)\)/))) {
    p.I2 = +m[3]; found++;
  }
  if ((m = body.match(/\((\w+)\*(\d+)\+(\w+)\*(\d+)\+(\w+)\[2\]\)\s*%\s*256/))) {
    p.M2 = +m[2]; p.I3 = +m[4]; found++;
  }
  return { params: p, detected: found === 3 };
}

/* ------------------------- decryption engine ------------------------- */

const VARIANTS = [];
for (const len of [3, 2, 4]) {
  for (const stride of [2, 3, 4]) {
    if (len === stride) continue;
    for (const order of ['be', 'le']) {
      for (const chain of [true, false]) {
        VARIANTS.push({ len, stride, order, chain, mode: 4 });
      }
    }
  }
}

function makeDecryptor(entries, alphaMap, variant, P) {
  return function (idx) {
    if (idx < 1 || idx > entries.length) return null;
    const e = entries[idx - 1];
    const raw = e[0];
    const p = e.slice(1);
    const a2 = p[0], a3 = p[1];
    const len = p[variant.len];
    const stride = p[variant.stride];
    const mode = p[variant.mode] ?? 1;
    if (typeof len !== 'number' || len <= 0) return '';
    const bytes = b85decode(raw, alphaMap, variant.order);
    if (!bytes || bytes.length === 0) return '';
    let k = bxor(a2, a3);
    const out = [];
    let o2 = a2;
    const m = (((mode - 1) % 4) + 4) % 4 + 1;
    for (let i = 1; i <= len; i++) {
      o2 = luaMod(o2 * P.M1 + P.ADD + i * P.I1, 256);
      const v1 = bxor(o2, luaMod(i * P.I2 + a3, 256), k);
      const v2 = luaMod(a3 * P.M2 + i * P.I3 + a2, 256);
      const pos = luaMod((i - 1) * stride, len);
      if (pos >= bytes.length) return null;
      const b = bytes[pos];
      let r;
      if (m === 1) r = bxor(luaMod(b - v2, 256), v1);
      else if (m === 2) r = luaMod(bxor(b, v1) - v2, 256);
      else if (m === 3) r = bxor(luaMod(b - a3, 256), luaMod(v1 + v2, 256));
      else r = bxor(b, luaMod(v1 + v2 + a3, 256));
      out.push(r & 255);
      if (variant.chain) k = b;
    }
    return Buffer.from(out).toString('latin1');   // byte-exact; quoted later
  };
}

function scoreDecryptor(dec, entries) {
  let good = 0, total = 0, empty = 0;
  for (let i = 1; i <= entries.length; i++) {
    const s = dec(i);
    if (s === null) continue;
    total++;
    if (s === '') { empty++; good++; continue; }
    if (isCleanText(s)) good++;
  }
  return total ? { ratio: good / total, good, total, empty } : { ratio: 0, good: 0, total: 0, empty: 0 };
}

/* --------------------------- main pipeline --------------------------- */

function deobfuscate(src) {
  const notes = [];
  const t0 = Date.now();

  // strip the obfuscator banner but remember it
  let banner = '';
  const bm = src.match(/^\s*--\[(=*)\[([\s\S]*?)\]\1\]\s*/);
  if (bm) { banner = bm[2].trim(); src = src.slice(bm[0].length); }

  const toks = tokenize(src);

  const table = detectTable(toks);
  if (!table) {
    return { ok: false, error: 'Tabel string terenkripsi tidak ditemukan. Format tidak dikenali (bukan StudioDev57 / varian lain).' };
  }
  const alpha = detectAlphabet(toks, src);
  if (!alpha) {
    return { ok: false, error: 'Alphabet Base85 tidak ditemukan.' };
  }
  const dec = detectDecryptor(toks);
  if (!dec || dec.calls < 10) {
    return { ok: false, error: 'Fungsi dekriptor string tidak ditemukan.' };
  }

  const decEndIdx = findFunctionEnd(toks, dec.funcIdx);
  const decBody = decEndIdx > 0 ? src.slice(toks[dec.funcIdx].s, toks[decEndIdx].e) : '';
  const { params: cipher, detected: cipherDetected } = detectCipherParams(decBody);
  if (!cipherDetected) {
    notes.push('Konstanta cipher tidak terbaca penuh — sebagian memakai nilai default.');
  }

  const alphaMap = new Map();
  for (let i = 0; i < alpha.value.length; i++) alphaMap.set(alpha.value.charCodeAt(i), i);

  // --- collect call sites (token based, exact offsets) ---
  const calls = [];
  for (let i = 0; i < toks.length; i++) {
    if (toks[i].t !== 'name' || toks[i].v !== dec.name) continue;
    if (i > 0 && toks[i - 1].v === 'function') continue;
    if (!toks[i + 1] || toks[i + 1].v !== '(') continue;
    const close = findMatchingParen(toks, i + 1);
    if (close < 0) continue;
    const st = { i: i + 2 };
    let arg;
    try { arg = parseValue(toks, st); } catch { continue; }
    if (st.i !== close || typeof arg !== 'number') continue;
    calls.push({ arg, s: toks[i].s, e: toks[close].e });
  }
  if (calls.length < 10) {
    return { ok: false, error: 'Tidak ada pemanggilan dekriptor dengan argumen numerik.' };
  }

  // --- pick index transform by hit-rate against table size ---
  const transforms = detectTransform(src, dec.name);
  let bestT = null;
  for (const t of transforms) {
    let hits = 0;
    for (const c of calls) {
      const raw = bxor(c.arg, t.a);
      const idx = t.op === 'sub' ? raw - t.b : t.op === 'add' ? raw + t.b : raw;
      if (idx >= 1 && idx <= table.entries.length) hits++;
    }
    const rate = hits / calls.length;
    if (!bestT || rate > bestT.rate) bestT = { ...t, rate };
  }
  if (!bestT || bestT.rate < 0.9) {
    return { ok: false, error: `Transformasi indeks tidak cocok (hit-rate ${(bestT ? bestT.rate * 100 : 0).toFixed(1)}%).` };
  }
  if (bestT.rate < 0.999) notes.push(`Sebagian kecil argumen indeks di luar jangkauan (${((1 - bestT.rate) * 100).toFixed(2)}%).`);

  // --- pick decryption variant by output cleanliness ---
  let best = null;
  for (const v of VARIANTS) {
    const d = makeDecryptor(table.entries, alphaMap, v, cipher);
    const sc = scoreDecryptor(d, table.entries);
    if (!best || sc.ratio > best.score.ratio) best = { variant: v, dec: d, score: sc };
    if (sc.ratio === 1) break;
  }
  if (!best || best.score.ratio < 0.6) {
    return {
      ok: false,
      error: `Semua varian dekripsi gagal (skor terbaik ${best ? (best.score.ratio * 100).toFixed(1) : 0}%). Kirim sample ini untuk dianalisa.`,
    };
  }
  const decrypt = best.dec;

  // Distinguish "a real byte-pattern string" from "decryption is wrong".
  let nonUtf8 = 0;
  for (let i = 1; i <= table.entries.length; i++) {
    const s = decrypt(i);
    if (s && s !== '' && utf8Of(s) === null) nonUtf8++;
  }
  if (best.score.ratio < 0.99) {
    notes.push(`Rasio string bersih ${(best.score.ratio * 100).toFixed(1)}% — hasil mungkin belum benar, periksa manual.`);
  } else if (nonUtf8 > 0) {
    notes.push(`${nonUtf8} string berisi byte non-UTF8 (pola karakter Lua) — sudah di-escape byte-exact, bukan kerusakan.`);
  }

  // --- build replacements ---
  const reps = [];
  const seen = new Map();
  let missing = 0;
  for (const c of calls) {
    const raw = bxor(c.arg, bestT.a);
    const idx = bestT.op === 'sub' ? raw - bestT.b : bestT.op === 'add' ? raw + bestT.b : raw;
    const str = decrypt(idx);
    if (str === null) { missing++; continue; }
    seen.set(str, (seen.get(str) || 0) + 1);
    reps.push({ s: c.s, e: c.e, text: luaQuote(str) });
  }
  if (missing) notes.push(`${missing} pemanggilan tidak bisa didekripsi dan dibiarkan apa adanya.`);

  // --- apply inlining + bootstrap cut in one exact pass over the source ---
  const cutStart = toks[table.startTok].s;
  let cutEnd = -1;
  if (decEndIdx > 0) {
    const span = src.slice(cutStart, toks[decEndIdx].e);
    const looksLikeBootstrap = !/(game:|require\s*\(|task\.|Instance\.new|GetService)/.test(span);
    if (looksLikeBootstrap) cutEnd = toks[decEndIdx].e;
    else notes.push('Bootstrap tidak dihapus (terdeteksi kode asli di dalamnya).');
  }

  const edits = reps.map(r => ({ s: r.s, e: r.e, text: r.text }));
  if (cutEnd > cutStart) edits.push({ s: cutStart, e: cutEnd, text: '' });
  edits.sort((a, b) => a.s - b.s);

  let out = '';
  let pos = 0;
  for (const ed of edits) {
    if (ed.s < pos) continue;                 // never overlap
    out += src.slice(pos, ed.s) + ed.text;
    pos = ed.e;
  }
  out += src.slice(pos);

  // --- fold constants ---
  const folded = foldConstants(out);

  // --- rename identifiers ---
  const renamed = renameIdentifiers(folded.code);

  // --- format ---
  let code;
  let formatted = true;
  try {
    const ftoks = tokenize(renamed.code);
    const bal = checkBalance(ftoks);
    if (!bal.ok) {
      notes.push(`Format dilewati: ${bal.reason}. Output dikembalikan dalam bentuk minified.`);
      code = renamed.code;
      formatted = false;
    } else {
      code = format(sanitizeSemicolons(ftoks));
    }
  } catch (err) {
    notes.push('Formatter gagal, output dikembalikan minified: ' + err.message);
    code = renamed.code;
    formatted = false;
  }

  const header = [
    '-- Deobfuscated by NXS9 Deobfuscator',
    `-- source banner: ${banner || '(none)'}`,
    `-- decryption: base85(${alpha.value.length} chars) + stream cipher, ${best.variant.chain ? 'chained' : 'unchained'} key, order=${best.variant.order}`,
    `-- cipher params: M1=${cipher.M1} ADD=${cipher.ADD} I1=${cipher.I1} I2=${cipher.I2} M2=${cipher.M2} I3=${cipher.I3}`,
    `-- variant: len=p[${best.variant.len}] stride=p[${best.variant.stride}] mode=p[${best.variant.mode}]`,
    `-- index transform: bit32.bxor(arg, ${bestT.a}) ${bestT.op === 'sub' ? '-' : '+'} ${bestT.b}`,
    '',
  ].join('\n');

  return {
    ok: true,
    code: header + code,
    stats: {
      tableEntries: table.entries.length,
      calls: calls.length,
      replaced: reps.length,
      uniqueStrings: seen.size,
      identifiersRenamed: renamed.count,
      constantsFolded: folded.count,
      inputBytes: src.length,
      outputBytes: code.length,
      ms: Date.now() - t0,
    },
    fingerprint: {
      banner,
      tableName: table.name,
      alphabetLength: alpha.value.length,
      alphabet: alpha.value,
      decryptor: dec.name,
      xorA: bestT.a,
      xorB: bestT.b,
      transformOp: bestT.op,
      cipher,
      cleanRatio: best.score.ratio,
      variant: best.variant,
    },
    notes,
  };
}

/* --------------------- post-processing utilities --------------------- */

function foldConstants(text) {
  let count = 0;
  const INNER = /\(([^()]*)\)/g;
  const ARITH_BODY = /^\s*-?\d+(?:\s*[-+*\/%]\s*-?\d+)+\s*$/;
  const NUM_BODY = /^\s*-?\d+\s*$/;

  const evalBody = (body) => {
    const clean = body.replace(/--/g, '- -');
    try {
      const t = tokenize(clean);
      const st = { i: 0 };
      const v = parseValue(t, st);
      if (st.i !== t.length) return null;
      return typeof v === 'number' && Number.isFinite(v) ? v : null;
    } catch { return null; }
  };

  for (let pass = 0; pass < 64; pass++) {
    let changed = false;
    text = text.replace(INNER, (m, body, off, whole) => {
      let v = null;
      if (ARITH_BODY.test(body)) v = evalBody(body);
      else if (NUM_BODY.test(body)) v = Number(body.trim());
      if (v === null) return m;

      let j = off - 1;
      while (j >= 0 && /\s/.test(whole[j])) j--;
      if (j >= 0) {
        const ch = whole[j];
        if (ch === ']' || ch === ')') return m;          // call / index, not a group
        if (/[A-Za-z0-9_]/.test(ch)) {
          let k = j;
          while (k >= 0 && /[A-Za-z0-9_]/.test(whole[k])) k--;
          const word = whole.slice(k + 1, j + 1);
          const FOLD_OK_KW = new Set(['and', 'or', 'not', 'then', 'do', 'return', 'else',
            'elseif', 'in', 'until', 'local', 'if', 'while', 'for', 'repeat', '=']);
          if (!FOLD_OK_KW.has(word)) return m;           // identifier => function call
        }
      }

      let txt = String(v);
      if (txt.startsWith('-') && j >= 0 && whole[j] === '-') txt = ' ' + txt;   // never emit --
      const nxt = whole[off + m.length];
      if (nxt && /[A-Za-z0-9_.]/.test(nxt)) txt += ' ';                          // never emit 10end
      count++;
      changed = true;
      return txt;
    });
    if (!changed) break;
  }
  return { code: text, count };
}

function renameIdentifiers(text) {
  const re = /\b_[A-Za-z0-9_]{14,}\b/g;
  const order = [];
  const seen = new Set();
  let m;
  while ((m = re.exec(text))) {
    if (!seen.has(m[0])) { seen.add(m[0]); order.push(m[0]); }
  }
  const funcs = new Set();
  const fre = /local\s+function\s+(_[A-Za-z0-9_]{14,})/g;
  while ((m = fre.exec(text))) funcs.add(m[1]);

  const map = new Map();
  let fi = 0, vi = 0;
  for (const nm of order) {
    if (funcs.has(nm)) { fi++; map.set(nm, 'fn_' + fi); }
    else { vi++; map.set(nm, 'v_' + vi); }
  }
  const out = text.replace(re, (x) => map.get(x) || x);
  return { code: out, count: map.size };
}

module.exports = { deobfuscate, tokenize, format };
