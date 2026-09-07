#!/usr/bin/env node
'use strict';

// merge-codex-config.cjs — non-destructively merge shipyard's [agents.shipyard-*]
// tables into $CODEX_HOME/config.toml.
//
// Mirrors the entrypoint's `(.existing // default)` philosophy for TOML: never
// touch sections we do not own. Dependency-free (no TOML lib on the host) and
// idempotent — a prior install's shipyard tables are stripped and replaced with
// the fresh fragment, so re-running yields a stable file. Only table headers of
// the form `[agents.shipyard-<name>]` are considered ours; gsd-core's
// `[agents]` (with max_depth) and `[agents.gsd-*]` are left verbatim.
//
// A table header is TOML GRAMMAR, not a line shape. Detecting one with
// `/^\s*\[agents\]\s*$/` made `[agents] # my limits` invisible, so a SECOND
// `[agents]` table was appended and the merge exited 0 having produced a config
// Codex refuses to start (audit F21 / ADR-004 D6). Every header, fence marker
// and gsd-core marker below is therefore resolved through the small scanner in
// this file, which tracks multi-line strings and value brackets so a `[`-leading
// line inside either is never mistaken for a header.
//
// The file writes the user's config, so it writes it the way ADR-004 asks: the
// merged text is checked for duplicate tables in memory, written to a temp file
// beside the target, re-parsed by `python3 -c 'import tomllib'` when that is
// available, and only then renamed into place. Nothing mutates the original
// until there is positive evidence the replacement parses.
//
// Usage: node merge-codex-config.cjs --config <config.toml> --fragment <fragment.toml>

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

function fail(msg) {
  process.stderr.write(`merge-codex-config: ${msg}\n`);
  process.exit(1);
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) out[argv[i].slice(2)] = argv[i + 1];
  }
  return out;
}

const FENCE_BEGIN = /^\s*#\s*shipyard-agents:begin\b/;
const FENCE_END = /^\s*#\s*shipyard-agents:end\b/;
// The pre-fence fragment header. It belongs to no TOML table, so table-shaped
// stripping never removed it and each install left another copy. Recognized here
// so a config polluted by older installs heals on the next run instead of
// accumulating forever.
const LEGACY_HEADER = /^\s*#\s*shipyard delivery-pipeline agents\b/;
// gsd-core's own marker. Its installer's `stripGsdFromCodexConfig` removes
// "everything from marker to EOF" — so anything appended below it is deleted by
// the next `gsd-core --codex` install OR uninstall, silently. Appending is
// therefore not an option: our fragment goes ABOVE this line.
const GSD_MARKER = /^\s*#\s*GSD Agent Configuration\b/;

// ── a small TOML line scanner ────────────────────────────────────────────────
// Not a parser. It answers exactly two questions per physical line — "did this
// line START inside a multi-line string?" and "is this line a table header, and
// of which key?" — because both used to be answered by a regex over raw text.
//
// Known, deliberate limits: a quote run adjacent to a closing `"""` (`""""`) and
// a `\` line-continuation inside a multi-line basic string are not modelled.
// Neither shape occurs in a Codex config, and the tomllib re-parse below is the
// backstop for anything this scanner reads wrong.

const BARE_KEY = /^[A-Za-z0-9_-]+/;

function skipWs(s, i) {
  while (i < s.length && (s[i] === ' ' || s[i] === '\t')) i++;
  return i;
}

// Index just past the closing quote of a single-line string, or -1.
function endOfQuoted(s, i) {
  const q = s[i];
  i++;
  while (i < s.length) {
    if (q === '"' && s[i] === '\\') { i += 2; continue; }
    if (s[i] === q) return i + 1;
    i++;
  }
  return -1;
}

// Index just past the closing delimiter of a multi-line string, or -1.
function endOfMultiline(s, i, delim) {
  const escapes = delim === '"""';
  while (i < s.length) {
    if (escapes && s[i] === '\\') { i += 2; continue; }
    if (s.startsWith(delim, i)) return i + delim.length;
    i++;
  }
  return -1;
}

// `[a.b]`, `[ agents ]`, `["agents"]`, `[agents] # comment`, `[[array.table]]`.
// Returns { key: [...parts], arrayTable } or null when the line is not a header.
function parseTableHeader(line) {
  let i = skipWs(line, 0);
  if (line[i] !== '[') return null;
  i++;
  let arrayTable = false;
  if (line[i] === '[') { arrayTable = true; i++; }
  const key = [];
  for (;;) {
    i = skipWs(line, i);
    const c = line[i];
    if (c === '"' || c === "'") {
      const end = endOfQuoted(line, i);
      if (end === -1) return null;
      key.push(line.slice(i + 1, end - 1));
      i = end;
    } else {
      const m = BARE_KEY.exec(line.slice(i));
      if (!m) return null;
      key.push(m[0]);
      i += m[0].length;
    }
    i = skipWs(line, i);
    if (line[i] === '.') { i++; continue; }
    break;
  }
  const close = arrayTable ? ']]' : ']';
  if (line.slice(i, i + close.length) !== close) return null;
  i = skipWs(line, i + close.length);
  // Anything but a comment after the closing bracket means this was never a
  // header — an inline array element, say — and treating it as one is how a
  // false positive gets written into a user's config.
  if (i < line.length && line[i] !== '#') return null;
  return { key, arrayTable };
}

// Advance the carry state (multi-line string, value-bracket depth) across the
// code portion of one line, starting at `i`.
function scanCode(line, i, st) {
  while (i < line.length) {
    const c = line[i];
    if (c === '#') return;
    if (line.startsWith('"""', i) || line.startsWith("'''", i)) {
      const delim = line.slice(i, i + 3);
      const end = endOfMultiline(line, i + 3, delim);
      if (end === -1) { st.ml = delim; return; }
      i = end;
      continue;
    }
    if (c === '"' || c === "'") {
      const end = endOfQuoted(line, i);
      if (end === -1) return; // unterminated: the rest of this line is unreadable
      i = end;
      continue;
    }
    if (c === '[') { st.depth++; i++; continue; }
    if (c === ']') { if (st.depth > 0) st.depth--; i++; continue; }
    i++;
  }
}

// One record per physical line: { raw, inString, atDepth, header }.
// `inString` / `atDepth` describe the state the line BEGAN in, which is what
// decides whether its first `[` or `#` means anything.
function scanLines(lines) {
  const st = { ml: null, depth: 0 };
  return lines.map((raw) => {
    const inString = st.ml !== null;
    const atDepth = st.depth;
    let i = 0;
    if (st.ml) {
      const end = endOfMultiline(raw, 0, st.ml);
      if (end === -1) return { raw, inString: true, atDepth, header: null };
      i = end;
      st.ml = null;
    }
    // A header line carries nothing but an optional comment, so it is not
    // scanned for brackets — its own `[`/`]` would otherwise skew the depth.
    const header = !inString && atDepth === 0 ? parseTableHeader(raw) : null;
    if (header) return { raw, inString: false, atDepth, header };
    scanCode(raw, i, st);
    return { raw, inString, atDepth, header: null };
  });
}

const isCode = (rec) => !rec.inString && rec.atDepth === 0;

function isOurTable(header) {
  return !!header && !header.arrayTable && header.key.length === 2
    && header.key[0] === 'agents' && header.key[1].startsWith('shipyard-');
}

// Drop everything shipyard owns: the fenced fragment (inclusive), plus — for
// configs written before the fence existed — every `[agents.shipyard-*]` table
// block (header until the next table header or EOF) and the legacy header
// comment. Returns the remaining lines.
function stripOurBlocks(lines) {
  const scan = scanLines(lines);
  const kept = [];
  let skipping = false;
  let fenceEnd = -1;
  for (let i = 0; i < lines.length; i++) {
    if (i <= fenceEnd) continue;
    const rec = scan[i];
    if (isCode(rec) && FENCE_BEGIN.test(rec.raw)) {
      // Only consume the fence when a matching end exists below it. An
      // unterminated one (a hand-edited config, an interrupted write) would
      // otherwise swallow every table after it — deleting the user's own MCP
      // servers and model settings to fix a duplicated comment.
      const end = lines.findIndex((l, j) => j > i && isCode(scan[j]) && FENCE_END.test(l));
      if (end !== -1) { fenceEnd = end; skipping = false; continue; }
      continue; // treat the orphan marker as a stray comment: drop just this line
    }
    if (isCode(rec) && LEGACY_HEADER.test(rec.raw)) continue;
    if (rec.header) {
      skipping = isOurTable(rec.header);
    } else if (isCode(rec) && /^\s*\[/.test(rec.raw)) {
      // A `[`-leading code line the grammar could not parse is still the end of
      // whatever block preceded it. Bounding the skip this way is what keeps a
      // header shape we read wrong from deleting a foreign table below it.
      skipping = false;
    }
    if (!skipping) kept.push(rec.raw);
  }
  return kept;
}

// Collapse runs of blank lines and drop leading/trailing ones — but only where
// "blank" is a fact about the file rather than about a string it contains. The
// old `/\n{3,}/` over the whole text rewrote the body of any multi-line string
// that happened to hold an empty line.
function normalize(lines) {
  const scan = scanLines(lines);
  const out = [];
  let prevBlank = false;
  for (let i = 0; i < lines.length; i++) {
    const blank = isCode(scan[i]) && lines[i].trim() === '';
    if (blank && (prevBlank || out.length === 0)) continue;
    out.push({ raw: lines[i], blank });
    prevBlank = blank;
  }
  while (out.length && out[out.length - 1].blank) out.pop();
  return out.map((r) => r.raw);
}

// Tables TOML forbids declaring twice. Narrow on purpose: this is the
// dependency-free guard for the one class the merge itself can create (a second
// `[agents]`), not a validator. Array-of-tables headers repeat legitimately, and
// so does any plain header underneath one — each `[[fruits]]` element may carry
// its own `[fruits.physical]` — so both are excluded rather than flagged.
function duplicateTables(lines) {
  const scan = scanLines(lines);
  const arrayKeys = new Set();
  for (const rec of scan) {
    if (rec.header && rec.header.arrayTable) arrayKeys.add(JSON.stringify(rec.header.key));
  }
  const underArrayTable = (key) => {
    for (let n = 1; n < key.length; n++) {
      if (arrayKeys.has(JSON.stringify(key.slice(0, n)))) return true;
    }
    return false;
  };
  const seen = new Map();
  const dups = [];
  for (let i = 0; i < scan.length; i++) {
    const h = scan[i].header;
    if (!h || h.arrayTable || underArrayTable(h.key)) continue;
    // Compared as a structure, not as a dotted string: `["a.b"]` and `[a.b]`
    // name different tables.
    const id = JSON.stringify(h.key);
    if (seen.has(id)) dups.push({ name: h.key.join('.'), first: seen.get(id) + 1, second: i + 1 });
    else seen.set(id, i);
  }
  return dups;
}

// ── the re-parse: positive evidence, never an unhealthy checker's opinion ────
// A REFUSAL requires the parser to have spoken (exit 3). No python3, a python3
// without tomllib (< 3.11), and the macOS `/usr/bin/python3` stub that exits 1
// with an xcode-select note are all "skipped": an installer must not fail
// because the optional deep checker is broken.
const PY_TOMLLIB = [
  'import sys',
  'try:',
  '    import tomllib',
  'except Exception:',
  '    sys.exit(2)',
  'try:',
  '    with open(sys.argv[1], "rb") as f:',
  '        tomllib.load(f)',
  'except Exception as e:',
  '    sys.stderr.write(str(e))',
  '    sys.exit(3)',
].join('\n');

function reparse(file) {
  const r = spawnSync('python3', ['-c', PY_TOMLLIB, file], { encoding: 'utf8' });
  if (r.error) return { ok: true, note: 'skipped (no python3 on PATH)' };
  if (r.status === 0) return { ok: true, note: 'verified (python3 tomllib)' };
  if (r.status === 2) return { ok: true, note: 'skipped (python3 has no tomllib — needs 3.11+)' };
  if (r.status === 3) return { ok: false, note: 'failed', error: (r.stderr || '').trim() || 'unspecified parse error' };
  const why = `${r.stderr || ''}${r.stdout || ''}`.split('\n').map((l) => l.trim()).find(Boolean)
    || `exit ${r.status === null ? r.signal : r.status}`;
  return { ok: true, note: `skipped (python3 present but unusable: ${why})` };
}

// The path the bytes must land on. `rename` over a symlink replaces the link
// with a regular file, so the link is resolved first and the merge reaches the
// file the user actually keeps their config in.
//
// `realpathSync` answers that only for a link that RESOLVES. A DANGLING one — a
// dotfiles repo not checked out yet, a target on a volume that is not mounted —
// makes it throw, and the old fallback then named the LINK itself: the rename
// swapped the dotfile manager's symlink for a regular file, exit 0, and the
// config it was meant to write never reached the target at all. So the chain is
// walked by hand: a link is followed to what it NAMES even when that does not
// exist yet, which is what the ordinary write this rename replaced would have
// done — only `rename(2)` refuses to follow links.
//
// Returns `{ target }` when there is a path the bytes can go to, or
// `{ dangling, why }` when the walk ends somewhere they cannot. Writing anyway
// is the one outcome ruled out, because it changes what the config file IS.
const SYMLINK_HOPS = 40;

function resolveTarget(p) {
  try { return { target: fs.realpathSync(p) }; } catch { /* absent, or a dangling link */ }
  const abs = path.resolve(p);
  let dir = path.dirname(abs);
  try { dir = fs.realpathSync(dir); } catch { /* the directory is absent too */ }
  let cur = path.join(dir, path.basename(abs));
  let link = null;
  for (let hop = 0; ; hop++) {
    let st = null;
    try { st = fs.lstatSync(cur); } catch { break; } // nothing there: the path to create
    if (!st.isSymbolicLink()) break;                 // a real file: write to it
    if (link === null) link = cur;
    // A loop (`a` -> `b` -> `a`) has no end to walk to, and an installer must
    // refuse rather than spin: lstat never fails on either hop.
    if (hop >= SYMLINK_HOPS) {
      return { dangling: link, why: `it never resolves (a symlink loop, or a chain deeper than ${SYMLINK_HOPS})` };
    }
    try { cur = path.resolve(path.dirname(cur), fs.readlinkSync(cur)); } catch (e) {
      return { dangling: link, why: `its target could not be read: ${e && e.message}` };
    }
  }
  // Only the LINK case is refused here. An ordinary absent path under an absent
  // directory keeps the write's own ENOENT, as before — the installer mkdir -p's
  // that directory a few lines earlier, so it is not a case we have to explain.
  if (link !== null && !fs.existsSync(path.dirname(cur))) {
    return { dangling: link, why: `it points at ${cur}, whose directory does not exist` };
  }
  return { target: cur };
}

// tmp + re-parse + rename. The original is never opened for writing, so every
// refusal path leaves it byte-identical by construction rather than by restore.
function writeVerified(target, data) {
  const tmp = path.join(path.dirname(target), `.${path.basename(target)}.tmp-${process.pid}`);
  const discard = () => { try { fs.unlinkSync(tmp); } catch { /* nothing to clean */ } };
  let mode = null;
  try { mode = fs.statSync(target).mode & 0o777; } catch { /* a new file */ }
  try {
    discard();
    // Created private, then widened to whatever the config already was: a file
    // that may hold MCP secrets must not be world-readable even briefly.
    fs.writeFileSync(tmp, data, { mode: 0o600 });
    if (mode !== null) fs.chmodSync(tmp, mode);
    const verdict = reparse(tmp);
    if (!verdict.ok) { discard(); return verdict; }
    fs.renameSync(tmp, target);
    return verdict;
  } catch (e) {
    discard();
    throw e;
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.config || !args.fragment) fail('need --config and --fragment');
  if (!fs.existsSync(args.fragment)) fail(`fragment not found: ${args.fragment}`);
  const fragment = fs.readFileSync(args.fragment, 'utf8').trim();

  const existing = fs.existsSync(args.config) ? fs.readFileSync(args.config, 'utf8') : '';
  const original = existing.length ? existing.replace(/\r\n/g, '\n').split('\n') : [];
  const kept = stripOurBlocks(original);

  // Every question below is asked of the CURRENT line array, re-scanned. The
  // strip removed lines, so an index carried over from the first scan names a
  // different line.
  const keptScan = scanLines(kept);

  // Ensure an `[agents]` parent exists so our sub-tables are valid children.
  // gsd-core normally writes it; guard for a bare/absent config. Any
  // `[agents…]` header is evidence enough — TOML lets a super-table stay
  // implicit, so `[agents.gsd-planner]` alone means appending a bare `[agents]`
  // is not "adding the parent" but declaring a table that may already exist.
  const hasAgentsTable = keptScan.some((rec) => rec.header && rec.header.key[0] === 'agents');

  // Place the fragment ABOVE gsd-core's marker when there is one. Everything
  // below that marker is gsd-core's to delete — appending at EOF is what made a
  // routine `gsd-core --codex` upgrade wipe every shipyard agent registration
  // without a word. Sub-tables preceding their `[agents]` super-table is
  // out-of-order but valid TOML, and the alternative is losing the block.
  const markerAt = keptScan.findIndex((rec) => isCode(rec) && GSD_MARKER.test(rec.raw));

  const lines = kept.slice();
  // Appends only, so `markerAt` still names the same line.
  if (!hasAgentsTable) lines.push('', '[agents]', 'max_depth = 1');
  if (markerAt === -1) lines.push('', ...fragment.split('\n'));
  else lines.splice(markerAt, 0, ...fragment.split('\n'), '');

  const mergedLines = normalize(lines);
  const merged = `${mergedLines.join('\n')}\n`;

  const dups = duplicateTables(mergedLines);
  if (dups.length) {
    const preexisting = new Set(duplicateTables(original).map((d) => d.name));
    const detail = dups
      .map((d) => `[${d.name}] (lines ${d.first} and ${d.second})` + (preexisting.has(d.name) ? ' — already duplicated in your config' : ''))
      .join('; ');
    fail(
      `refusing to write ${args.config}: the merged config would carry a duplicate table: ${detail}.\n` +
      '  TOML forbids declaring a table twice and Codex would refuse to start, so nothing was written —\n' +
      `  ${args.config} is byte-identical. Remove the extra declaration by hand, then re-run.`
    );
  }

  const resolved = resolveTarget(args.config);
  if (resolved.dangling) {
    fail(
      `refusing to write ${args.config}: it is a symlink that does not resolve — ${resolved.why}.\n` +
      '  An atomic write lands with rename(2), which does not follow a symlink, so writing here would\n' +
      '  replace the link with a regular file — whatever manages it (a dotfiles repo, say) would\n' +
      `  silently stop owning your config. Nothing was written; ${resolved.dangling} is untouched.\n` +
      '  Create the target the link names (or fix the link), then re-run.'
    );
    return;
  }

  let verdict;
  try {
    verdict = writeVerified(resolved.target, merged);
  } catch (e) {
    fail(`could not write ${args.config}: ${e && e.message}`);
    return;
  }
  if (!verdict.ok) {
    fail(
      `refusing to write ${args.config}: the merged config does not parse as TOML — ${verdict.error}\n` +
      `  Nothing was written; ${args.config} is byte-identical.`
    );
  }

  process.stdout.write(`re-parse: ${verdict.note}\n`);
  process.stdout.write(
    `merged shipyard agents into ${args.config}` +
    (markerAt === -1 ? '\n' : ' (above the gsd-core marker)\n')
  );
}

main();
