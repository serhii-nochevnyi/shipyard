'use strict';

// Predictable YAML-subset parser for GSD plan frontmatter.
//
// Gate 2 reads plan frontmatter written by gsd-planner, by the import path, and
// by humans — three producers this repo does not control. The previous inline
// parser silently mangled anything it did not expect (a trailing `# comment`
// turned the last `files_modified` entry into garbage, which quietly voided the
// file-overlap guarantee) and hard-exited on the first line it could not read.
// This module instead:
//   - supports the constructs those producers actually emit, and
//   - reports what it cannot represent as a structured error, never as a
//     half-parsed value.
//
// Supported: nested block maps (any depth), block sequences (at parent or child
// indent), sequences of maps, flow sequences/maps including multi-line ones,
// single/double-quoted scalars, block scalars (`|` / `>`), quote-aware trailing
// comments, CRLF line endings.
//
//   const { parseFrontmatter } = require('./frontmatter.cjs');
//   const { data, errors } = parseFrontmatter(text);   // data === null: no frontmatter

// ── scalars ─────────────────────────────────────────────────────────────────

// Strip a YAML trailing comment: a `#` that begins a token (start of line or
// preceded by whitespace) and is not inside a quoted scalar. Keeps `#` inside
// quotes ("fixes #42") and inside a word (an URL fragment).
function stripComment(s) {
  let quote = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote) {
      if (c === '\\' && quote === '"') { i++; continue; }
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") { quote = c; continue; }
    if (c === '#' && (i === 0 || /\s/.test(s[i - 1]))) return s.slice(0, i);
  }
  return s;
}

function unquote(s) {
  if (s.length >= 2 && s[0] === '"' && s[s.length - 1] === '"') {
    return s
      .slice(1, -1)
      .replace(/\\n/g, '\n')
      .replace(/\\t/g, '\t')
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, '\\');
  }
  if (s.length >= 2 && s[0] === "'" && s[s.length - 1] === "'") {
    return s.slice(1, -1).replace(/''/g, "'");
  }
  return s;
}

function scalar(raw) {
  const s = String(raw).trim();
  if (s === '') return '';
  const quoted = (s[0] === '"' && s.endsWith('"')) || (s[0] === "'" && s.endsWith("'"));
  const v = unquote(s);
  if (quoted) return v; // an explicitly quoted scalar is always a string
  if (v === 'true' || v === 'True' || v === 'TRUE') return true;
  if (v === 'false' || v === 'False' || v === 'FALSE') return false;
  if (v === 'null' || v === 'Null' || v === 'NULL' || v === '~') return null;
  if (/^-?\d+$/.test(v)) return parseInt(v, 10);
  if (/^-?\d+\.\d+$/.test(v)) return parseFloat(v);
  return v;
}

// ── flow collections ────────────────────────────────────────────────────────

// Split the inside of a flow collection on top-level commas, respecting quotes
// and nesting. `[a, "b, c", [d, e]]` → ['a', '"b, c"', '[d, e]'].
function splitFlow(inner) {
  const out = [];
  let cur = '';
  let quote = null;
  let depth = 0;
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i];
    if (quote) {
      cur += c;
      if (c === '\\' && quote === '"') { cur += inner[++i] ?? ''; continue; }
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") { quote = c; cur += c; continue; }
    if (c === '[' || c === '{') { depth++; cur += c; continue; }
    if (c === ']' || c === '}') { depth--; cur += c; continue; }
    if (c === ',' && depth === 0) { out.push(cur); cur = ''; continue; }
    cur += c;
  }
  if (cur.trim() !== '' || out.length === 0) out.push(cur);
  return out;
}

// Are all flow brackets in `s` balanced (ignoring quoted text)?
function flowBalance(s) {
  let quote = null;
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote) {
      if (c === '\\' && quote === '"') { i++; continue; }
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") { quote = c; continue; }
    if (c === '[' || c === '{') depth++;
    else if (c === ']' || c === '}') depth--;
  }
  return depth;
}

function parseFlow(raw, ctx) {
  const s = raw.trim();
  const open = s[0];
  const close = open === '[' ? ']' : '}';
  if (!s.endsWith(close)) {
    ctx.errors.push({ line: ctx.line, message: `unterminated flow ${open === '[' ? 'sequence' : 'mapping'}: ${s}` });
    return open === '[' ? [] : {};
  }
  const inner = s.slice(1, -1).trim();
  if (open === '[') {
    if (inner === '') return [];
    return splitFlow(inner).map((part) => parseValue(part, ctx));
  }
  const map = {};
  if (inner === '') return map;
  for (const part of splitFlow(inner)) {
    const eq = part.indexOf(':');
    if (eq < 0) {
      ctx.errors.push({ line: ctx.line, message: `flow mapping entry without a key: ${part.trim()}` });
      continue;
    }
    map[scalar(part.slice(0, eq))] = parseValue(part.slice(eq + 1), ctx);
  }
  return map;
}

function parseValue(raw, ctx) {
  const s = raw.trim();
  if (s === '') return '';
  if (s[0] === '[' || s[0] === '{') return parseFlow(s, ctx);
  return scalar(s);
}

// ── tokenizer ───────────────────────────────────────────────────────────────
// One token per logical node: { indent, text, line, seq, block, blockValue }.
// A `- ` sequence marker becomes its own token, and its inline content becomes a
// second token two columns deeper — so a scalar item, a nested map item and a
// nested sequence item are all handled by the same block parser.

const KEY_RE = /^([^:#\s][^:]*):(?:\s+(.*))?$/;
const BLOCK_SCALAR_RE = /^[|>][-+]?\d*$/;

function tokenize(lines, ctx) {
  const tokens = [];
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (!raw.trim()) continue;
    const indent = raw.length - raw.trimStart().length;
    if (raw.trimStart().startsWith('#')) continue;
    const lineNo = i + 1;
    let text = raw.trim();
    let seq = false;

    if (text === '-' || text.startsWith('- ')) {
      seq = true;
      const rest = text.slice(1).trim();
      tokens.push({ indent, text: '-', line: lineNo, seq: true });
      if (rest === '') continue;
      text = rest;
      // fall through: emit the item content two columns deeper
    }

    const itemIndent = seq ? indent + 2 : indent;
    const kv = text.match(KEY_RE);
    const valuePart = kv ? (kv[2] ?? '') : null;

    // block scalar: consume the more-indented literal body
    if (kv && BLOCK_SCALAR_RE.test(stripComment(valuePart).trim())) {
      const fold = stripComment(valuePart).trim()[0] === '>';
      const body = [];
      let j = i + 1;
      for (; j < lines.length; j++) {
        if (!lines[j].trim()) { body.push(''); continue; }
        const ind = lines[j].length - lines[j].trimStart().length;
        if (ind <= itemIndent) break;
        body.push(lines[j]);
      }
      const base = body.reduce(
        (min, l) => (l.trim() ? Math.min(min, l.length - l.trimStart().length) : min),
        Infinity
      );
      const dedented = body.map((l) => (l.trim() ? l.slice(Number.isFinite(base) ? base : 0) : ''));
      const value = fold
        ? dedented.join(' ').replace(/\s+/g, ' ').trim()
        : dedented.join('\n').replace(/\n+$/, '');
      tokens.push({ indent: itemIndent, text, line: lineNo, key: kv[1].trim(), block: true, blockValue: value });
      i = j - 1;
      continue;
    }

    // multi-line flow collection: join continuation lines until balanced
    if (valuePart !== null) {
      const head = stripComment(valuePart).trim();
      if ((head[0] === '[' || head[0] === '{') && flowBalance(head) > 0) {
        let joined = head;
        let j = i + 1;
        while (j < lines.length && flowBalance(joined) > 0) {
          joined += ' ' + stripComment(lines[j].trim());
          j++;
        }
        if (flowBalance(joined) !== 0) {
          ctx.errors.push({ line: lineNo, message: `unterminated flow collection starting at "${kv[1].trim()}"` });
        }
        tokens.push({ indent: itemIndent, text: `${kv[1]}: ${joined}`, line: lineNo });
        i = j - 1;
        continue;
      }
    }

    tokens.push({ indent: itemIndent, text, line: lineNo });
  }
  return tokens;
}

// ── block parser ────────────────────────────────────────────────────────────

function parseBlock(tokens, start, indent, ctx) {
  let i = start;
  if (i >= tokens.length || tokens[i].indent < indent) return [null, i];

  if (tokens[i].seq) {
    const arr = [];
    while (i < tokens.length && tokens[i].seq && tokens[i].indent === indent) {
      i++;
      const next = tokens[i];
      if (next && next.indent > indent) {
        const [value, ni] = parseBlock(tokens, i, next.indent, ctx);
        arr.push(value);
        i = ni;
      } else {
        arr.push(null); // empty sequence item
      }
    }
    return [arr, i];
  }

  // A lone scalar at this indent (a sequence item's value).
  if (!KEY_RE.test(tokens[i].text)) {
    return [parseValue(tokens[i].text, { ...ctx, line: tokens[i].line }), i + 1];
  }

  const map = {};
  while (i < tokens.length && !tokens[i].seq && tokens[i].indent === indent) {
    const tok = tokens[i];
    if (tok.block) { map[tok.key] = tok.blockValue; i++; continue; }
    const kv = tok.text.match(KEY_RE);
    if (!kv) {
      ctx.errors.push({ line: tok.line, message: `unparseable frontmatter line "${tok.text}"` });
      i++;
      continue;
    }
    const key = kv[1].trim();
    const rawVal = stripComment(kv[2] ?? '').trim();
    if (rawVal === '') {
      const next = tokens[i + 1];
      const nestedIndent = next && (next.indent > indent || (next.seq && next.indent === indent))
        ? next.indent
        : null;
      if (nestedIndent !== null) {
        const [value, ni] = parseBlock(tokens, i + 1, nestedIndent, ctx);
        map[key] = value;
        i = ni;
      } else {
        map[key] = null;
        i++;
      }
    } else {
      map[key] = parseValue(rawVal, { ...ctx, line: tok.line });
      i++;
    }
  }
  return [map, i];
}

// ── entry point ─────────────────────────────────────────────────────────────

function parseFrontmatter(text) {
  const m = String(text).match(/^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/);
  if (!m) return { data: null, errors: [] };
  const ctx = { errors: [], line: 0 };
  const lines = m[1].split(/\r?\n/);
  const tokens = tokenize(lines, ctx);
  if (!tokens.length) return { data: {}, errors: ctx.errors };
  const baseIndent = Math.min(...tokens.map((t) => t.indent));
  const [data, consumed] = parseBlock(tokens, 0, baseIndent, ctx);
  if (consumed < tokens.length) {
    ctx.errors.push({
      line: tokens[consumed].line,
      message: `unexpected indentation at "${tokens[consumed].text}" — frontmatter must be a single mapping`,
    });
  }
  return { data: data && typeof data === 'object' && !Array.isArray(data) ? data : {}, errors: ctx.errors };
}

module.exports = { parseFrontmatter, stripComment, splitFlow, scalar };
