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
  } catch {
    // Config syntax is not an applicability signal. A globally installed gate
    // must stay inert for an ordinary GSD project even when its config is
    // malformed; a conveyor project will still fail closed in gsd-sync.
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
  // A truncated plan can contain the delivery marker but no closing
  // frontmatter fence. Keep it applicable so the canonical synchronizer can
  // report malformed source instead of letting ship:pre pass as a no-op.
  return /^\s*delivery\s*:/m.test(frontmatter ? frontmatter[1] : text);
});
if (!hasDelivery) pass(`none of the ${plans.length} plan(s) carry a delivery: block`);

const candidates = [
  path.join(__dirname, 'gsd-sync.cjs'),
  '/opt/delivery-pipeline/scripts/gsd-sync.cjs',
  path.join(__dirname, '..', '..', '..', 'plugins', 'delivery-pipeline', 'scripts', 'gsd-sync.cjs'),
];
// Host installs may leave the capability launcher in the GSD installation while
// the canonical script is supplied by the Shipyard plugin cache. Keep the scan
// aligned with graph-gate: plugin name and version are installation details.
const pluginCache = path.join(process.env.HOME || '', '.claude', 'plugins', 'cache', 'delivery-pipeline');
if (fs.existsSync(pluginCache)) {
  for (const plugin of fs.readdirSync(pluginCache).sort()) {
    const pluginDir = path.join(pluginCache, plugin);
    let stat;
    try { stat = fs.statSync(pluginDir); } catch { continue; }
    if (!stat.isDirectory()) continue;
    for (const version of fs.readdirSync(pluginDir).sort().reverse()) {
      candidates.push(path.join(pluginDir, version, 'scripts', 'gsd-sync.cjs'));
    }
  }
}
const requiredSiblings = ['frontmatter.cjs', 'lock.cjs'];
const script = candidates.find((file) => fs.existsSync(file) && requiredSiblings.every((sibling) =>
  fs.existsSync(path.join(path.dirname(file), sibling))
));
if (!script) fail('gsd-sync.cjs is missing beside the installed gate and in the source plugin; reinstall Shipyard');

// Lifecycle gates must preserve the synchronizer's ownership refusal. Native
// GSD files that are already present without our marker are human-owned until
// an operator explicitly runs `gsd-sync.cjs --adopt-native`; a gate is not that
// operator and must never turn a hard error into an overwrite.
const args = [script, '--json'];
if (mode === 'check') args.push('--check');
const result = spawnSync(process.execPath, args, { cwd: ROOT, encoding: 'utf8' });
if (result.error) fail(`could not run ${script}: ${result.error.message}`);
const childExit = Number.isInteger(result.status) && result.status >= 0 ? result.status : 1;
let payload;
try {
  payload = JSON.parse((result.stdout || '').trim());
} catch {
  fail(`gsd-sync returned non-JSON output: ${(result.stdout || result.stderr || '').trim()}`, childExit);
}
if (result.status !== 0) {
  const blockers = payload.applicable === false
    ? 'gsd-sync reported that the delivery project is not applicable'
    : Array.isArray(payload.blockers) ? payload.blockers.join('; ') : (payload.error || result.stderr || 'unknown projection failure');
  fail(`${mode} blocked: ${blockers}`, childExit);
}
if (payload.ok !== true || payload.applicable !== true) {
  const blockers = payload.applicable === false
    ? 'gsd-sync reported that the delivery project is not applicable'
    : Array.isArray(payload.blockers) ? payload.blockers.join('; ') : (payload.error || result.stderr || 'unknown projection failure');
  fail(`${mode} blocked: ${blockers}`);
}
console.log(`gsd-sync-gate: ${mode === 'check' ? 'projection is synchronized' : 'projection published'} (${payload.counts?.generated_files ?? 0} files)`);
