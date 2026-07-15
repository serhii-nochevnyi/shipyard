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

// Drop every `[agents.shipyard-*]` table block (header until the next table
// header or EOF). Returns the remaining lines.
function stripOurBlocks(lines) {
  const kept = [];
  let skipping = false;
  for (const line of lines) {
    if (TABLE_HEADER.test(line)) {
      skipping = OURS.test(line);
    }
    if (!skipping) kept.push(line);
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
  let body = lines.join('\n').replace(/\n{3,}/g, '\n\n').replace(/\s+$/, '');
  if (!hasBareAgents) {
    body = `${body}${body ? '\n\n' : ''}[agents]\nmax_depth = 1`;
  }

  const merged = `${body}\n\n${fragment}\n`;
  fs.writeFileSync(args.config, merged);
  process.stdout.write(`merged shipyard agents into ${args.config}\n`);
}

main();
