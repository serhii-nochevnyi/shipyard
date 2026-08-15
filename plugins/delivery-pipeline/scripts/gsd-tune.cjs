#!/usr/bin/env node
'use strict';

// gsd-tune.cjs — the GSD settings a conveyor project needs, for the runtime it is
// actually installed on.
//
//   gsd-tune.cjs [--runtime claude|codex] [--json]     # report the drift (default)
//   gsd-tune.cjs --apply [--runtime …]                 # write it
//
// WHY THIS IS A SEPARATE ACT. `pipeline-config.cjs` reads GSD's settings and
// WARNS — deliberately: they are the user's file, and a conveyor that silently
// rewrites the config of every GSD project on the machine is worse than one that
// complains. But a warning nobody can act on in one step is how
// `workflow.use_worktrees: true` survived: the reader saw it every run and it
// stayed true, because fixing it meant knowing which of ~60 GSD keys to touch and
// what value the conveyor actually needs. So: same knowledge, one button, and the
// button is not pressed by default. `--check` is the default and exits 1 on drift;
// `--apply` writes.
//
// TWO CLASSES OF SETTING, and the distinction is load-bearing:
//
//   REQUIRED — the conveyor is INCORRECT without them. Branch ownership and
//     worktree ownership are not preferences: two orchestrators creating branches
//     or worktrees for the same plans is the collision these values prevent.
//     `runtime` belongs here too, because it decides whether a plugin-namespaced
//     agent_skills entry resolves at all — wrong, and the skill is silently
//     skipped rather than failing loudly.
//
//   TUNING — models and effort. These change cost and quality, never correctness,
//     so they are reported but only written under --apply like the rest, and a
//     value the user has deliberately set to something else is called out as
//     THEIRS rather than as drift to be flattened.
//
// GSD's model vocabulary is opus|sonnet|haiku (plus `inherit`). `fable` is a
// Claude-runtime tier of OURS and is not valid in GSD's `models.*` — mapping it
// through here would write a value GSD rejects.

const fs = require('fs');
const path = require('path');
const { loadConfig } = require(path.join(__dirname, 'pipeline-config.cjs'));

const argv = process.argv.slice(2);
const APPLY = argv.includes('--apply');
const AS_JSON = argv.includes('--json');
const flag = (n) => { const i = argv.indexOf(`--${n}`); return i === -1 ? null : argv[i + 1]; };

// `--global` targets ~/.gsd/defaults.json, which is what an UNCONFIGURED
// directory inherits — a new project before anyone has run /gsd-config in it.
// Verified: with no `.planning/` at all, GSD reads that file; the moment a
// project has its own `config.json`, even an empty one, the global file stops
// contributing. So this is the install-time surface, and the only one: there is
// no project to configure when a plugin is installed.
//
// It is also the file where a dual-runtime machine goes wrong. This one held
// `runtime: "codex"` — written by whichever installer ran last — so on a Claude
// machine every unconfigured directory resolved `gpt-5.6-sol`. Hence the narrow
// global set below, and the loud warning when the runtime changes hands.
const GLOBAL = argv.includes('--global');
const ROOT = process.cwd();
const CONFIG = GLOBAL
  ? path.join(process.env.HOME || '', '.gsd', 'defaults.json')
  : path.join(ROOT, '.planning', 'config.json');

function fail(msg, code = 2) { process.stderr.write(`gsd-tune: ${msg}\n`); process.exit(code); }

let raw;
if (!fs.existsSync(CONFIG)) {
  if (!GLOBAL) fail(`no ${CONFIG} — run this from a GSD project (the conveyor's own project root)`);
  raw = {}; // the global defaults file is ours to create; a project's config is not
} else {
  try { raw = JSON.parse(fs.readFileSync(CONFIG, 'utf8')); }
  catch (e) { fail(`${CONFIG} is not valid JSON (${e.message}) — refusing to rewrite a file I cannot parse`); }
}

// The runtime decides two of the settings below, so guessing it wrong is worse
// than not guessing: an explicit flag wins, then the config's own value, then the
// bundle actually installed on this machine.
function detectRuntime() {
  const explicit = flag('runtime');
  if (explicit) return { runtime: explicit, how: '--runtime' };
  if (typeof raw.runtime === 'string' && raw.runtime) return { runtime: raw.runtime, how: 'config' };
  const home = process.env.HOME || '';
  const codex = fs.existsSync(path.join(process.env.CODEX_HOME || path.join(home, '.codex'), 'shipyard'));
  const claude = fs.existsSync(path.join(home, '.claude', 'plugins'));
  if (codex && !claude) return { runtime: 'codex', how: 'installed bundle' };
  if (claude && !codex) return { runtime: 'claude', how: 'installed plugin' };
  // Both (or neither) present: claude is the canonical runtime, and saying which
  // way we guessed matters more than the guess.
  return { runtime: 'claude', how: 'default (both runtimes present)' };
}
const { runtime, how } = detectRuntime();

// The delivery-rules skill resolves under a DIFFERENT NAME per runtime, and the
// difference is not cosmetic: the plugin-namespaced form works only on claude and
// is silently skipped elsewhere.
//
//   claude — `global:<plugin>:<skill>`, and the skill directory is `delivery-rules`
//            (the plugin is `shipyard`), so: global:shipyard:delivery-rules
//   codex  — flat skills dir, and the generator PREFIXES the name, so the
//            installed directory is `shipyard-delivery-rules`
//
// Both names are read from the artifacts rather than assumed. The first draft of
// this script asserted `global:shipyard:shipyard-delivery-rules` — a mix of the
// two — and would have rewritten a correct config into a skill that resolves
// nowhere. The proving ground already had the right value; the tool was wrong.
const DELIVERY_RULES = runtime === 'claude'
  ? 'global:shipyard:delivery-rules'
  : 'global:shipyard-delivery-rules';

// `pipeline.model_policy` and GSD's `model_profile` are the same decision stated
// twice; leaving them to drift means the conveyor's agents and GSD's own agents
// disagree about how much to spend on the same phase.
//
// The RUNTIME vocabulary is `quality | balanced | budget | adaptive | inherit`
// (`VALID_PROFILES`). `golden` is only the raw field name inside
// model-catalog.json: `MODEL_PROFILES` rebuilds each agent entry as
// `quality: meta.golden` at load. Reading the JSON and concluding "the vocabulary
// is golden" is a trap this file already fell into once — and an expensive one,
// because the resolver does `agentModels[profile] || agentModels['balanced']`, so
// a name outside the vocabulary does not fail, it SILENTLY becomes balanced.
// Verify against `VALID_PROFILES`, never against the catalog's field names.
const PROFILE_FOR_POLICY = { economy: 'budget', balanced: 'balanced', premium: 'quality' };

const { config: pipeline } = loadConfig(ROOT);

// Project mode only. `git.branching_strategy: none` is a CONVEYOR requirement,
// and the global file is inherited by every unconfigured directory on the
// machine — an ordinary GSD project legitimately wants phase branches, so
// forcing this machine-wide is the same overreach the capability's plan:post
// gate has an applicability check to avoid.
const REQUIRED = GLOBAL ? [
  ['runtime', runtime,
    'which runtime an unconfigured project should assume on this machine'],
] : [
  ['runtime', runtime,
    'decides whether a plugin-namespaced agent_skills entry resolves at all — wrong, and the skill is silently skipped'],
  ['git.branching_strategy', 'none',
    'the conveyor owns branching (epic/<phase> + ticket/<id>); GSD phase/milestone branches would fight it'],
];

// The 1M-context tier for GSD's OWN agents, on Claude only.
//
// NOT via the tier keys, and that is the whole subtlety. `model_profile_overrides
// .claude.*` and `model_policy.runtime_tiers.claude.*` look like the right lever
// and are INERT here: the resolver's runtime-tier step is guarded by
// `configRuntime !== 'claude'`, and on Claude it returns the bare tier ALIAS,
// which Claude Code's Agent tool resolves itself. The catalog's `claude-opus-4-8`
// is a label for that alias, not a model anyone launches — so remapping it
// changes nothing.
//
// `model_overrides.<agent-id>` is step 1 of the resolver, ahead of all tier
// logic, and it accepts a bare Agent-tool alias (`CLAUDE_AGENT_ALIASES` includes
// `fable`). That is the working lever.
//
// Only the two agents whose work is genuinely context-bound, by the same rule the
// conveyor applies to its own roles: the planner holds RESEARCH + roadmap +
// codebase maps at once, the reviewer holds the whole diff. The executor and the
// fixer work inside one ticket's narrow scope, where a 1M window buys nothing and
// costs money — they keep their profile tiers.
const CLAUDE_1M_AGENTS = ['gsd-planner', 'gsd-code-reviewer'];

// Machine-wide settings must be about MODELS, never about the conveyor. The
// global file is inherited by every unconfigured directory, so anything
// conveyor-shaped in it (`workflow.use_worktrees`, `agent_skills`, branching)
// would reconfigure GSD for projects that never asked for shipyard.
//
// `model_overrides.*` is deliberately NOT here, and the reason is observed rather
// than argued: the values are `fable`, which exists only on Claude, and this file
// is read by the Codex install too. GSD said so out loud —
//   gsd: warning — Codex agent "gsd-code-reviewer" model "fable" is not a valid
//   Codex model … dropping it
// — twice, about a key we had written. It is dropped safely, but a setting that is
// wrong half the time it is read belongs where the runtime is unambiguous: the
// project config, which the project-mode list still sets on Claude.
//
// `models.*` and `effort.*` stay because they are TIER aliases, meaningful on both
// runtimes; `model_overrides` carries a concrete model name and is not.
const GLOBAL_SAFE = new Set([
  'model_profile', 'models.planning', 'models.execution', 'models.research',
  'models.verification', 'effort.routing_tier_defaults.light',
  'effort.routing_tier_defaults.standard', 'effort.routing_tier_defaults.heavy',
]);

const TUNING_ALL = [
  // GSD's own default, and shipyard has no reason to move it. It was in REQUIRED
  // as `false`, on the belief that `/gsd-code-review --fix` — which the conveyor
  // DOES call from inside a ticket worktree — would fork a nested one. Checked
  // against the source: `code-review.md` does not mention worktrees at all, and
  // `git worktree add` appears only in `execute-phase`, `new-workspace` and
  // `worktree-safety.cjs` — none of which the conveyor invokes. The nesting was
  // never possible on any path we take, so forcing the value was overreach.
  ['workflow.use_worktrees', true,
    'GSD\'s own default; no conveyor path creates a nested worktree, so this is not ours to force'],
  ['model_profile', PROFILE_FOR_POLICY[pipeline.model_policy] || 'balanced',
    `mirrors pipeline.model_policy = "${pipeline.model_policy}"`],
  ...(runtime === 'claude'
    ? CLAUDE_1M_AGENTS.map((agent) => [
      `model_overrides.${agent}`, 'fable',
      'context-bound on Claude: the 1M window is what distinguishes this agent\'s work. ' +
      'Set here rather than via model_profile_overrides.claude.*, which the resolver skips on Claude',
    ])
    : []),
  // GSD's own stage agents. Its vocabulary is opus|sonnet|haiku — `fable` is ours
  // and is not valid here.
  ['models.planning', 'opus', 'planning is judgment; it is never cheapened'],
  ['models.execution', 'opus', 'the writer agent'],
  ['models.research', 'sonnet', 'fact gathering, not option design'],
  ['models.verification', 'sonnet', 'mechanical reconciliation against the plan'],
  ['effort.routing_tier_defaults.light', 'low', 'mirrors the conveyor\'s own effort tiers'],
  ['effort.routing_tier_defaults.standard', 'high', 'mirrors the conveyor\'s own effort tiers'],
  ['effort.routing_tier_defaults.heavy', 'xhigh', 'mirrors the conveyor\'s own effort tiers'],
  [`agent_skills.gsd-executor`, [DELIVERY_RULES],
    `the delivery-rules skill in the form the "${runtime}" runtime resolves`],
];

const TUNING = TUNING_ALL.filter(([key]) => !GLOBAL || GLOBAL_SAFE.has(key));

const get = (o, dotted) => dotted.split('.').reduce((a, k) => (a == null ? a : a[k]), o);
function set(o, dotted, value) {
  const parts = dotted.split('.');
  const last = parts.pop();
  let cur = o;
  for (const p of parts) {
    if (cur[p] == null || typeof cur[p] !== 'object') cur[p] = {};
    cur = cur[p];
  }
  cur[last] = value;
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// A narrow migration, not a general remover. An earlier version of THIS script
// wrote `model_overrides.<agent>: "fable"` into the global defaults; the value is
// Claude-only and the file is read by the Codex install too, which made GSD warn
// on every Codex install about a key we had put there. Only those exact
// agent/value pairs are withdrawn — a user's own override is left alone, and
// nothing is removed outside `--global`.
const OUR_OLD_GLOBAL_OVERRIDES = ['gsd-planner', 'gsd-code-reviewer'];
const staleGlobalOverrides = GLOBAL && raw.model_overrides && typeof raw.model_overrides === 'object'
  ? OUR_OLD_GLOBAL_OVERRIDES.filter((a) => raw.model_overrides[a] === 'fable')
  : [];

const drift = [];
for (const [group, list] of [['required', REQUIRED], ['tuning', TUNING]]) {
  for (const [key, want, why] of list) {
    const have = get(raw, key);
    if (same(have, want)) continue;
    drift.push({ group, key, have: have === undefined ? null : have, want, why, set: have !== undefined });
  }
}

// A machine can have BOTH runtimes installed, and this file holds one `runtime`.
// Whichever installer ran last wins — which is exactly how it came to say
// "codex" on a Claude machine, making every unconfigured directory resolve
// gpt-5.6-sol. Silent last-write-wins is the defect; saying so is the fix.
const runtimeHandover = GLOBAL && typeof raw.runtime === 'string' && raw.runtime && raw.runtime !== runtime
  ? raw.runtime : null;

if (AS_JSON) {
  console.log(JSON.stringify({
    runtime, detected_by: how, applied: APPLY, scope: GLOBAL ? 'global' : 'project',
    runtime_handover: runtimeHandover, drift,
  }, null, 2));
} else {
  console.log(`gsd-tune: runtime "${runtime}" (${how}) — ${CONFIG}${GLOBAL ? '  [global defaults]' : ''}`);
  if (runtimeHandover) {
    console.log(
      `\n  ⚠ these global defaults currently say runtime "${runtimeHandover}".\n` +
      `    This file is ONE value shared by both installs, and it is inherited by every\n` +
      '    directory that has no .planning/ of its own — so the wrong one there makes an\n' +
      `    unconfigured project resolve ${runtimeHandover}'s models. Applying sets it to "${runtime}".\n` +
      '    A project with its own config.json is unaffected either way.'
    );
  }
  if (!drift.length) console.log('  nothing to change: this project already agrees with the conveyor');
  for (const g of ['required', 'tuning']) {
    const rows = drift.filter((d) => d.group === g);
    if (!rows.length) continue;
    console.log(`\n  ${g === 'required' ? 'REQUIRED — the conveyor is incorrect without these' : 'tuning — cost and quality, never correctness'}:`);
    for (const d of rows) {
      // A value the user deliberately set is named as theirs, not flattened as
      // "drift": the difference decides whether --apply is a fix or an override.
      const state = d.set ? `currently ${JSON.stringify(d.have)} (yours)` : 'unset';
      console.log(`    ${d.key} → ${JSON.stringify(d.want)}   [${state}]`);
      console.log(`        ${d.why}`);
    }
  }
}

if (staleGlobalOverrides.length && !AS_JSON) {
  console.log(
    `\n  withdrawing ${staleGlobalOverrides.length} machine-wide model_overrides an earlier` +
    ' version of this script wrote:\n    ' + staleGlobalOverrides.join(', ') +
    ' = "fable"\n    `fable` exists only on Claude and this file is read by the Codex install too,' +
    '\n    so GSD warned about it on every Codex install. It still applies to Claude PROJECTS.'
  );
}

if (!drift.length && !staleGlobalOverrides.length) process.exit(0);

if (!APPLY) {
  if (!AS_JSON) {
    console.log('\n  reported only. `gsd-tune.cjs --apply` writes them; every other key in the file is left alone.');
  }
  // Non-zero so a caller can gate on it, the same way the other conveyor gates do.
  process.exit(1);
}

for (const d of drift) set(raw, d.key, d.want);
for (const agent of staleGlobalOverrides) delete raw.model_overrides[agent];
// Leave no empty husk behind — an empty object reads as "someone configured this".
if (raw.model_overrides && !Object.keys(raw.model_overrides).length) delete raw.model_overrides;

const tmp = `${CONFIG}.gsd-tune.tmp`;
fs.writeFileSync(tmp, JSON.stringify(raw, null, 2) + '\n');
fs.renameSync(tmp, CONFIG); // atomic: a reader sees the old file or the new one
if (!AS_JSON) {
  const parts = [];
  if (drift.length) parts.push(`wrote ${drift.length} setting(s)`);
  if (staleGlobalOverrides.length) parts.push(`withdrew ${staleGlobalOverrides.length} stale override(s)`);
  console.log(`\n✓ ${parts.join(', ')} in ${CONFIG}`);
}
process.exit(0);
