#!/usr/bin/env node
'use strict';

// Capability launcher for the canonical local Shipyard→GSD projection.
// The installed capability carries gsd-sync.cjs beside this file; the source
// checkout fallback keeps the gate directly testable before installation.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = process.cwd();
const mode = (process.argv[2] || 'write').trim();
if (!['write', 'check'].includes(mode)) {
  console.error('gsd-sync-gate: usage: gsd-sync-gate.cjs [write|check]');
  process.exit(2);
}

function pass(reason) {
  console.log(`gsd-sync-gate: not applicable — ${reason}`);
  process.exit(0);
}

function fail(message, code = 1) {
  console.error(`gsd-sync-gate: ${message}`);
  process.exit(code);
}

const configFile = path.join(ROOT, '.planning', 'config.json');
if (fs.existsSync(configFile)) {
  let config;
  try {
    config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
  } catch (error) {
    fail(`invalid .planning/config.json: ${error.message}`);
  }
  if (config && config.delivery_pipeline && config.delivery_pipeline.gsd_sync === false) {
    pass('delivery_pipeline.gsd_sync is false in .planning/config.json');
  }
}

const phasesDir = path.join(ROOT, '.planning', 'phases');
if (!fs.existsSync(phasesDir)) pass('no .planning/phases in this project');
const plans = [];
for (const entry of fs.readdirSync(phasesDir).sort()) {
  const dir = path.join(phasesDir, entry);
  let stat;
  try { stat = fs.statSync(dir); } catch { continue; }
  if (!stat.isDirectory()) continue;
  for (const file of fs.readdirSync(dir).filter((name) => /-PLAN\.md$/.test(name)).sort()) {
    plans.push(path.join(dir, file));
  }
}
if (!plans.length) pass('no *-PLAN.md files under .planning/phases');
const hasDelivery = plans.some((file) => {
  const text = fs.readFileSync(file, 'utf8');
  const frontmatter = text.match(/^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/);
  return frontmatter ? /^delivery:/m.test(frontmatter[1]) : false;
});
if (!hasDelivery) pass(`none of the ${plans.length} plan(s) carry a delivery: block`);

const candidates = [
  path.join(__dirname, 'gsd-sync.cjs'),
  path.join(__dirname, '..', '..', '..', 'plugins', 'delivery-pipeline', 'scripts', 'gsd-sync.cjs'),
];
const script = candidates.find((file) => fs.existsSync(file));
if (!script) fail('gsd-sync.cjs is missing beside the installed gate and in the source plugin; reinstall Shipyard');

const args = [script, '--json'];
if (mode === 'check') args.push('--check');
const result = spawnSync(process.execPath, args, { cwd: ROOT, encoding: 'utf8' });
if (result.error) fail(`could not run ${script}: ${result.error.message}`);
let payload;
try {
  payload = JSON.parse((result.stdout || '').trim());
} catch {
  fail(`gsd-sync returned non-JSON output: ${(result.stdout || result.stderr || '').trim()}`);
}
if (result.status !== 0 || payload.ok !== true) {
  const blockers = Array.isArray(payload.blockers) ? payload.blockers.join('; ') : (payload.error || result.stderr || 'unknown projection failure');
  fail(`${mode} blocked: ${blockers}`);
}
console.log(`gsd-sync-gate: ${mode === 'check' ? 'projection is synchronized' : 'projection published'} (${payload.counts?.generated_files ?? 0} files)`);
