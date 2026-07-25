#!/usr/bin/env node
'use strict';

// plan:post gate launcher. Delegates to the canonical ticket-graph validator
// (Gate 2 of the delivery conveyor). Exit 0 = pass, non-zero = block.
//
// APPLICABILITY FIRST. The capability installs at GLOBAL scope, so this gate
// runs at plan:post in EVERY GSD project on the machine. Gate 2's contract
// (a `delivery:` block, non-empty files_modified, non-empty requirements, no
// file overlap between unordered plans) belongs to the delivery conveyor — a
// plain GSD project satisfies none of it, and a blocking gate made planning
// impossible there. So the gate first asks whether this project uses the
// conveyor at all, and stays inert when it does not:
//
//   - no .planning/phases or no *-PLAN.md      → pass (nothing to gate)
//   - no plan carries a `delivery:` block      → pass (not a conveyor project)
//   - pipeline.graph_gate === false in config  → pass (explicit opt-out)
//   - otherwise                                → run the validator, fail closed
//
// Resolution order for the validator: a copy bundled next to this file at
// image-build/install time, then the baked Claude-plugin path, then the plugin
// cache. cwd is the project root (gate contract).

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = process.cwd();

function pass(reason) {
  console.log(`graph-gate: not applicable — ${reason}`);
  process.exit(0);
}

// ── explicit opt-out ────────────────────────────────────────────────────────
const configFile = path.join(ROOT, '.planning', 'config.json');
if (fs.existsSync(configFile)) {
  try {
    const cfg = JSON.parse(fs.readFileSync(configFile, 'utf8'));
    if (cfg && cfg.pipeline && cfg.pipeline.graph_gate === false) {
      pass('pipeline.graph_gate is false in .planning/config.json');
    }
  } catch {
    // an unreadable config is not this gate's business; the validator will
    // surface real problems if the project turns out to be a conveyor project.
  }
}

// ── applicability: does this project run the delivery conveyor? ──────────────
const phasesDir = path.join(ROOT, '.planning', 'phases');
if (!fs.existsSync(phasesDir)) pass('no .planning/phases in this project');

const plans = [];
for (const entry of fs.readdirSync(phasesDir).sort()) {
  const dir = path.join(phasesDir, entry);
  let stat;
  try { stat = fs.statSync(dir); } catch { continue; }
  if (!stat.isDirectory()) continue;
  for (const f of fs.readdirSync(dir).sort()) {
    if (/-PLAN\.md$/.test(f)) plans.push(path.join(dir, f));
  }
}
if (!plans.length) pass('no *-PLAN.md files under .planning/phases');

// A `delivery:` key at the top level of the frontmatter is the conveyor's
// opt-in marker: /shipyard:decompose stamps it, nothing else does. Matched
// loosely (block form or inline) so a hand-written variant still opts in.
const DELIVERY_KEY = /^delivery:/m;
const hasDeliveryBlock = plans.some((f) => {
  const text = fs.readFileSync(f, 'utf8');
  const m = text.match(/^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/);
  return m ? DELIVERY_KEY.test(m[1]) : false;
});
if (!hasDeliveryBlock) {
  pass(`none of the ${plans.length} plan(s) carry a delivery: block — this is not a delivery-conveyor project`);
}

// ── run the validator (fail closed from here on) ─────────────────────────────
const candidates = [
  path.join(__dirname, 'validate-graph.cjs'),
  '/opt/delivery-pipeline/scripts/validate-graph.cjs',
];
// Host installs: the validator ships inside the Claude plugin cache under
// <marketplace>/<plugin>/<version>/. Scan every plugin dir (the plugin may be
// renamed — e.g. pipeline -> shipyard) and every version, newest first, so this
// launcher never hardcodes the plugin name.
const mpCache = path.join(process.env.HOME || '', '.claude', 'plugins', 'cache', 'delivery-pipeline');
if (fs.existsSync(mpCache)) {
  for (const plugin of fs.readdirSync(mpCache).sort()) {
    const pluginDir = path.join(mpCache, plugin);
    let stat;
    try { stat = fs.statSync(pluginDir); } catch { continue; }
    if (!stat.isDirectory()) continue;
    for (const v of fs.readdirSync(pluginDir).sort().reverse()) {
      candidates.push(path.join(pluginDir, v, 'scripts', 'validate-graph.cjs'));
    }
  }
}
const target = candidates.find((f) => fs.existsSync(f));
if (!target) {
  console.error('graph-gate: validate-graph.cjs not found (checked the bundled copy, /opt/delivery-pipeline and the plugin cache)');
  process.exit(1);
}
// The validator requires sibling modules (frontmatter.cjs); every install path
// copies the whole scripts/ set next to it, so a missing sibling is a packaging
// bug worth reporting loudly rather than silently degrading.
const sibling = path.join(path.dirname(target), 'frontmatter.cjs');
if (!fs.existsSync(sibling)) {
  console.error(`graph-gate: ${target} is installed without its frontmatter.cjs sibling — reinstall the capability`);
  process.exit(1);
}
const r = spawnSync(process.execPath, [target], { stdio: 'inherit' });
process.exit(r.status === null ? 1 : r.status);
