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
// Usage: node merge-codex-config.cjs --config <config.toml> --fragment <fragment.toml>

const fs = require('fs');

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

const TABLE_HEADER = /^\s*\[/;
const OURS = /^\s*\[agents\.shipyard-[^\]]*\]/;
const BARE_AGENTS = /^\s*\[agents\]\s*$/;
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

// Drop everything shipyard owns: the fenced fragment (inclusive), plus — for
// configs written before the fence existed — every `[agents.shipyard-*]` table
// block (header until the next table header or EOF) and the legacy header
// comment. Returns the remaining lines.
function stripOurBlocks(lines) {
  const kept = [];
  let skipping = false;
  let fenceEnd = -1;
  for (let i = 0; i < lines.length; i++) {
    if (i <= fenceEnd) continue;
    if (FENCE_BEGIN.test(lines[i])) {
      // Only consume the fence when a matching end exists below it. An
      // unterminated one (a hand-edited config, an interrupted write) would
      // otherwise swallow every table after it — deleting the user's own MCP
      // servers and model settings to fix a duplicated comment.
      const end = lines.findIndex((l, j) => j > i && FENCE_END.test(l));
      if (end !== -1) { fenceEnd = end; continue; }
      continue; // treat the orphan marker as a stray comment: drop just this line
    }
    if (LEGACY_HEADER.test(lines[i])) continue;
    if (TABLE_HEADER.test(lines[i])) {
      skipping = OURS.test(lines[i]);
    }
    if (!skipping) kept.push(lines[i]);
  }
  return kept;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.config || !args.fragment) fail('need --config and --fragment');
  if (!fs.existsSync(args.fragment)) fail(`fragment not found: ${args.fragment}`);
  const fragment = fs.readFileSync(args.fragment, 'utf8').trim();

  let existing = fs.existsSync(args.config) ? fs.readFileSync(args.config, 'utf8') : '';
  let lines = existing.length ? existing.replace(/\r\n/g, '\n').split('\n') : [];
  lines = stripOurBlocks(lines);

  // Ensure a bare [agents] parent exists so our sub-tables are valid children.
  // gsd-core normally writes it; guard for a bare/absent config.
  const hasBareAgents = lines.some((l) => BARE_AGENTS.test(l));
  if (!hasBareAgents) {
    lines.push('', '[agents]', 'max_depth = 1');
  }

  // Place the fragment ABOVE gsd-core's marker when there is one. Everything
  // below that marker is gsd-core's to delete — appending at EOF is what made a
  // routine `gsd-core --codex` upgrade wipe every shipyard agent registration
  // without a word. Sub-tables preceding their `[agents]` super-table is
  // out-of-order but valid TOML, and the alternative is losing the block.
  const markerAt = lines.findIndex((l) => GSD_MARKER.test(l));
  if (markerAt === -1) {
    lines.push('', ...fragment.split('\n'));
  } else {
    lines.splice(markerAt, 0, ...fragment.split('\n'), '');
  }

  const merged = `${lines.join('\n').replace(/\n{3,}/g, '\n\n').replace(/\s+$/, '')}\n`;
  fs.writeFileSync(args.config, merged);
  process.stdout.write(
    `merged shipyard agents into ${args.config}` +
    (markerAt === -1 ? '\n' : ' (above the gsd-core marker)\n')
  );
}

main();
