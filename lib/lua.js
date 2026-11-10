'use strict';

/* ------------------------------------------------------------------ *
 * Lua/Luau lexer + literal parser + pretty printer.
 * Token-preserving: every token keeps its raw source slice, so string
 * literals are re-emitted byte-for-byte (no escaping bugs).
 * ------------------------------------------------------------------ */

const OPS2 = new Set(['==', '~=', '<=', '>=', '..', '//', '::', '<<', '>>']);
const KW = new Set(['and', 'break', 'do', 'else', 'elseif', 'end', 'false', 'for',
  'function', 'if', 'in', 'local', 'nil', 'not', 'or', 'repeat', 'return',
  'then', 'true', 'until', 'while']);

function isNameStart(c) { return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c === '_'; }
function isNameChar(c) { return isNameStart(c) || (c >= '0' && c <= '9'); }
function isDigit(c) { return c >= '0' && c <= '9'; }

// level of a long bracket starting at i ("[[", "[=[", "[==[" ...), or -1
function longLevel(src, i) {
  if (src[i] !== '[') return -1;
  let j = i + 1, lvl = 0;
  while (src[j] === '=') { lvl++; j++; }
  return src[j] === '[' ? lvl : -1;
}

function longEnd(src, i, lvl) {
  const close = ']' + '='.repeat(lvl) + ']';
  const j = src.indexOf(close, i + lvl + 2);
  return j < 0 ? src.length : j + close.length;
}

function decodeQuoted(raw) {
  const q = raw[0];
  let out = '', i = 1;
  const end = raw.length - 1;
  while (i < end) {
    const c = raw[i];
    if (c !== '\\') { out += c; i++; continue; }
    const e = raw[i + 1];
    i += 2;
    switch (e) {
      case 'n': out += '\n'; break;
      case 't': out += '\t'; break;
      case 'r': out += '\r'; break;
      case 'a': out += '\x07'; break;
      case 'b': out += '\b'; break;
      case 'f': out += '\f'; break;
      case 'v': out += '\v'; break;
      case '\\': out += '\\'; break;
      case '"': out += '"'; break;
      case "'": out += "'"; break;
      case '\n': out += '\n'; break;
      case 'x': out += String.fromCharCode(parseInt(raw.substr(i, 2), 16) || 0); i += 2; break;
      case 'z': while (i < end && /\s/.test(raw[i])) i++; break;
      case 'u': {
        if (raw[i] === '{') {
          const cl = raw.indexOf('}', i);
          const cp = parseInt(raw.slice(i + 1, cl), 16);
          out += Number.isFinite(cp) ? String.fromCodePoint(cp) : '';
          i = cl + 1;
        } else {
          out += String.fromCharCode(parseInt(raw.substr(i, 4), 16) || 0);
          i += 4;
        }
        break;
      }
      default:
        if (isDigit(e)) {
          let d = e;
          while (d.length < 3 && isDigit(raw[i])) { d += raw[i]; i++; }
          out += String.fromCharCode(parseInt(d, 10));
        } else out += e;
    }
  }
  return out;
}

function tokenize(src) {
  const toks = [];
  const n = src.length;
  let i = 0;
  while (i < n) {
    const c = src[i];
    if (c === ' ' || c === '\t' || c === '\r' || c === '\n') { i++; continue; }

    // comments
    if (c === '-' && src[i + 1] === '-') {
      const lvl = longLevel(src, i + 2);
      if (lvl >= 0) { i = longEnd(src, i + 2, lvl); continue; }
      const j = src.indexOf('\n', i);
      i = j < 0 ? n : j + 1;
      continue;
    }

    // long strings
    if (c === '[') {
      const lvl = longLevel(src, i);
      if (lvl >= 0) {
        const e = longEnd(src, i, lvl);
        const raw = src.slice(i, e);
        const inner = raw.slice(lvl + 2, raw.length - (lvl + 2));
        toks.push({ t: 'str', v: inner, raw, s: i, e });
        i = e; continue;
      }
    }

    // quoted strings
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < n && src[j] !== c) {
        if (src[j] === '\\') j++;
        else if (src[j] === '\n') break;
        j++;
      }
      const e = Math.min(j + 1, n);
      const raw = src.slice(i, e);
      toks.push({ t: 'str', v: decodeQuoted(raw), raw, s: i, e });
      i = e; continue;
    }

    // numbers
    if (isDigit(c) || (c === '.' && isDigit(src[i + 1]))) {
      let j = i;
      if (c === '0' && (src[i + 1] === 'x' || src[i + 1] === 'X')) {
        j = i + 2;
        while (j < n && /[0-9a-fA-F.]/.test(src[j])) j++;
        if (src[j] === 'p' || src[j] === 'P') { j++; if (src[j] === '+' || src[j] === '-') j++; while (isDigit(src[j])) j++; }
      } else {
        while (j < n && (isDigit(src[j]) || src[j] === '.')) j++;
        if (src[j] === 'e' || src[j] === 'E') { j++; if (src[j] === '+' || src[j] === '-') j++; while (isDigit(src[j])) j++; }
      }
      toks.push({ t: 'num', v: src.slice(i, j), raw: src.slice(i, j), s: i, e: j });
      i = j; continue;
    }

    // names
    if (isNameStart(c)) {
      let j = i;
      while (j < n && isNameChar(src[j])) j++;
      toks.push({ t: 'name', v: src.slice(i, j), raw: src.slice(i, j), s: i, e: j });
      i = j; continue;
    }

    // operators
    const three = src.slice(i, i + 3);
    if (three === '...') { toks.push({ t: 'op', v: '...', raw: '...', s: i, e: i + 3 }); i += 3; continue; }
    const two = src.slice(i, i + 2);
    if (OPS2.has(two)) { toks.push({ t: 'op', v: two, raw: two, s: i, e: i + 2 }); i += 2; continue; }
    toks.push({ t: 'op', v: c, raw: c, s: i, e: i + 1 });
    i++;
  }
  return toks;
}

/* --------------------------- literal parser --------------------------- */

function luaMod(a, b) { return ((a % b) + b) % b; }

function numValue(txt) {
  if (/^0[xX]/.test(txt)) return parseInt(txt, 16);
  const v = Number(txt);
  return Number.isFinite(v) ? v : 0;
}

function parseValue(toks, st) {
  let left = parsePrimary(toks, st);
  for (;;) {
    const tk = toks[st.i];
    if (!tk || tk.t !== 'op') break;
    const op = tk.v;
    if (op !== '+' && op !== '-' && op !== '*' && op !== '/' && op !== '%' && op !== '..') break;
    st.i++;
    const right = parsePrimary(toks, st);
    if (op === '+') left = left + right;
    else if (op === '-') left = left - right;
    else if (op === '*') left = left * right;
    else if (op === '/') left = left / right;
    else if (op === '%') left = luaMod(left, right);
    else left = String(left) + String(right);
  }
  return left;
}

function parsePrimary(toks, st) {
  const tk = toks[st.i];
  if (!tk) throw new Error('unexpected end');
  if (tk.t === 'num') { st.i++; return numValue(tk.v); }
  if (tk.t === 'str') { st.i++; return tk.v; }
  if (tk.t === 'op' && tk.v === '-') { st.i++; return -parsePrimary(toks, st); }
  if (tk.t === 'op' && tk.v === '(') {
    st.i++;
    const v = parseValue(toks, st);
    if (!toks[st.i] || toks[st.i].v !== ')') throw new Error('expected )');
    st.i++;
    return v;
  }
  if (tk.t === 'op' && tk.v === '{') {
    st.i++;
    const arr = [];
    for (;;) {
      const cur = toks[st.i];
      if (!cur) throw new Error('unterminated table');
      if (cur.v === '}') { st.i++; break; }
      arr.push(parseValue(toks, st));
      const sep = toks[st.i];
      if (sep && sep.v === ',') st.i++;
      else if (sep && sep.v === '}') { st.i++; break; }
      else throw new Error('bad table');
    }
    return arr;
  }
  throw new Error('unexpected token ' + tk.v);
}

/* ------------------------------ printer ------------------------------ */

/**
 * Quote a string as a Lua literal. Input is a *Latin-1 byte string* (one char
 * per byte), which keeps decrypted payloads byte-exact. If those bytes happen
 * to be valid UTF-8 we emit readable text; otherwise every non-ASCII byte is
 * escaped as \ddd so nothing is lost or mangled.
 */
function luaQuote(s) {
  const buf = Buffer.from(s, 'latin1');
  const asText = buf.toString('utf8');
  const isUtf8 = Buffer.from(asText, 'utf8').equals(buf);

  if (isUtf8) {
    let out = '"';
    for (const ch of asText) {
      const c = ch.codePointAt(0);
      if (ch === '"') out += '\\"';
      else if (ch === '\\') out += '\\\\';
      else if (ch === '\n') out += '\\n';
      else if (ch === '\r') out += '\\r';
      else if (ch === '\t') out += '\\t';
      else if (c < 32 || c === 127) out += '\\' + String(c).padStart(3, '0');
      else out += ch;
    }
    return out + '"';
  }

  let out = '"';
  for (const b of buf) {
    if (b === 0x22) out += '\\"';
    else if (b === 0x5c) out += '\\\\';
    else if (b === 0x0a) out += '\\n';
    else if (b === 0x0d) out += '\\r';
    else if (b === 0x09) out += '\\t';
    else if (b < 32 || b > 126) out += '\\' + String(b).padStart(3, '0');
    else out += String.fromCharCode(b);
  }
  return out + '"';
}

const PRE_FLUSH = new Set(['local', 'if', 'for', 'while', 'return', 'break', 'repeat', 'end', 'else', 'elseif', 'until']);
const NO_FLUSH_AFTER_END = new Set([')', ',', ';', '.', ':', '(', '[', '}', 'end', 'else', 'elseif', 'until']);
const NO_SPACE_BEFORE = new Set([',', ';', ')', ']', '}', '.', ':']);

/**
 * Pretty-print a token stream. Newlines are only ever inserted at
 * statement boundaries, which is always safe in Lua (never before '(').
 */
function format(toks) {
  const lines = [];
  let cur = [];
  let indent = 0, curIndent = 0;
  let prev = null;

  const flush = () => {
    if (cur.length) {
      lines.push('  '.repeat(curIndent) + cur.join('').trim());
      cur = [];
    }
  };

  for (let idx = 0; idx < toks.length; idx++) {
    const tk = toks[idx];
    const nxt = toks[idx + 1];
    const v = tk.v;

    if (tk.t === 'name' && PRE_FLUSH.has(v)) {
      const suppress = (v === 'end' && nxt && NO_FLUSH_AFTER_END.has(nxt.v));
      if (!suppress) flush();
      if (v === 'end' || v === 'until' || v === 'else' || v === 'elseif') {
        indent = Math.max(0, indent - 1);
      }
    }

    // A new statement may start right after an expression with no separator.
    // Breaking before a NAME is always safe (never triggers Lua's
    // "ambiguous syntax" error, which only happens before "(").
    if (tk.t === 'name' && !KW.has(v) && prev && !KW.has(prev.v)
        && (prev.t === 'name' || prev.t === 'num' || prev.t === 'str'
            || prev.v === ')' || prev.v === ']' || prev.v === '}')) {
      flush();
    }

    const txt = tk.t === 'str' ? tk.raw : v;
    if (!cur.length) curIndent = indent;

    if (cur.length) {
      let noSpace = NO_SPACE_BEFORE.has(v);
      if ((v === '(' || v === '[') && prev) {
        if ((prev.t === 'name' && !KW.has(prev.v)) || prev.v === ')' || prev.v === ']' || prev.v === '}') noSpace = true;
      }
      if (prev && (prev.v === '(' || prev.v === '[' || prev.v === '{' || prev.v === '.' || prev.v === ':' || prev.v === '..')) noSpace = true;
      if (tk.t === 'op' && v === '..') noSpace = false;
      cur.push(noSpace ? txt : ' ' + txt);
    } else {
      cur.push(txt);
    }

    if (tk.t === 'name') {
      if (v === 'then' || v === 'else') { flush(); indent++; }
      else if (v === 'do') { flush(); indent++; }
      else if (v === 'function') indent++;
      else if (v === 'repeat') indent++;
    }
    if (tk.t === 'op' && v === ';') flush();
    if (tk.t === 'name' && v === 'end' && nxt && !NO_FLUSH_AFTER_END.has(nxt.v)) flush();

    prev = tk;
  }
  flush();
  return lines.join('\n');
}

/** Cheap structural sanity check: block keywords must balance. */
function checkBalance(toks) {
  let depth = 0, pendingDo = false;
  for (const tk of toks) {
    if (tk.t !== 'name') continue;
    const v = tk.v;
    if (v === 'for' || v === 'while') { depth++; pendingDo = true; }
    else if (v === 'do') { if (pendingDo) pendingDo = false; else depth++; }
    else if (v === 'function' || v === 'if' || v === 'repeat') depth++;
    else if (v === 'end') depth--;
    else if (v === 'until') depth--;
    if (depth < 0) return { ok: false, reason: 'unbalanced "end" (too many closes)' };
  }
  if (depth !== 0) return { ok: false, reason: `unbalanced blocks (depth ${depth})` };
  return { ok: true };
}

/**
 * Drop semicolons that no longer follow a statement (left over after
 * removing the bootstrap). A leading ";" is a syntax error in Lua 5.1.
 */
function sanitizeSemicolons(toks) {
  const out = [];
  for (const tk of toks) {
    if (tk.t === 'op' && tk.v === ';') {
      const prev = out.length ? out[out.length - 1] : null;
      if (!prev) continue;
      if (prev.v === ';' || prev.v === 'do' || prev.v === 'then' || prev.v === 'else'
          || prev.v === '(' || prev.v === '{' || prev.v === ',' || prev.v === 'repeat') continue;
    }
    out.push(tk);
  }
  return out;
}

module.exports = {
  tokenize, parseValue, format, luaQuote, checkBalance, luaMod,
  sanitizeSemicolons, longLevel, longEnd, KW,
};
