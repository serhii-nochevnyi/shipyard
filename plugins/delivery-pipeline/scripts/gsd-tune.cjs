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
//     Runtime is deliberately NOT a required project key: it is an execution
//     context supplied by the active GSD install. A legacy top-level `runtime`
//     is reported and migrated away under --apply so Claude and Codex can share
//     the checkout without a last-write-wins setting.
//
//   TUNING — models and effort. These change cost and quality, never correctness,
//     so they are reported but only written under --apply like the rest, and a
//     value the user has deliberately set to something else is called out as
//     THEIRS rather than as drift to be flattened.
//
//   BLOCKERS — a third class, and the distinction is that NO KEY FIXES THEM. A
//     runtime too old to resolve the model a project has consented to is not
//     drift between two values; it is an install to upgrade. They are REQUIRED
//     (exit 1) and never written, because `--apply` writes keys and there is no
//     key here to write. Two are version floors: below Claude Code 2.1.255 the
//     `fable` alias resolves to Fable 5 (the model the operator ruled out), and
//     below Codex CLI 0.153.1 `gpt-6-astra` cannot be configured at all. A
//     missing binary is silent — an unmeasurable floor is not a finding.
//
//     THE OTHER TWO ARE NOT VERSIONS, and that is ADR-007 D4: a floor has to be
//     measured against what is EFFECTIVE, not against something adjacent to it.
//     `ANTHROPIC_DEFAULT_FABLE_MODEL` bypasses the alias mapping entirely, so a
//     pin naming another model defeats the CLI floor whatever the version says;
//     and the Codex models this host will run live in the agent files
//     `config.toml` REGISTERS, not in `config.toml`, so a registration that does
//     not read is a floor that cannot be measured. Each is reported and never
//     rewritten: an environment and an install are not this script's to write.
//
// GSD's model vocabulary is opus|sonnet|haiku (plus `inherit`). `fable` is a
// Claude-runtime tier of OURS and is not valid in GSD's `models.*` — mapping it
// through here would write a value GSD rejects.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { loadConfig } = require(path.join(__dirname, 'pipeline-config.cjs'));
const { resolveRuntime } = require(path.join(__dirname, 'runtime-context.cjs'));

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
// It is also the file where a dual-runtime machine used to go wrong: a single
// `runtime` value was written by whichever installer ran last. Runtime identity
// now comes from GSD_RUNTIME / the per-install marker, so this script migrates
// that old global key out instead of writing a new last-write-wins value.
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

// The runtime is an execution context, not a project preference. Explicit
// invocation/launcher context wins, then GSD's own environment and install
// marker, and only then the legacy project value. An unresolved context is
// allowed for read-only reporting but cannot be applied: choosing Claude just
// because both runtimes happen to be installed is the exact defect this guard
// closes.
const explicitRuntime = flag('runtime');
const runtimeContext = resolveRuntime(ROOT, {
  runtime: explicitRuntime || undefined,
  scriptPath: __filename,
});
const runtime = runtimeContext.runtime;
const how = explicitRuntime ? '--runtime' : runtimeContext.source;

// GSD's `agent_skills` resolver currently chooses its global skills directory
// from `config.runtime`, and defaults that field to Claude. That is correct for
// a project that pins a runtime, but it is the wrong shared-checkout contract:
// Claude and Codex would have to rewrite the same config.json on every run.
// Keep the injected delivery contract project-relative instead. Both runtimes
// can read it, and its source is deliberately runtime-neutral; the runtime-
// native generated skills remain available for direct `$shipyard-*` calls.
const DELIVERY_RULES = '.shipyard/generated/gsd-delivery-rules';
const LEGACY_DELIVERY_RULES = new Set([
  'global:shipyard:delivery-rules',
  'global:shipyard-delivery-rules',
]);
const DELIVERY_RULES_MARKER = '<!-- shipyard-managed: gsd-delivery-rules -->';

function managedProjectionContent(sourceContent) {
  const source = sourceContent.endsWith('\n') ? sourceContent : `${sourceContent}\n`;
  return `${source}\n${DELIVERY_RULES_MARKER}\n`;
}

function deliveryRulesSource() {
  const candidates = [
    process.env.SHIPYARD_DELIVERY_RULES_SOURCE,
    path.join(__dirname, '..', 'skills', 'delivery-rules', 'SKILL.md'),
    path.join(__dirname, '..', 'bundle', 'skills', 'delivery-rules', 'SKILL.md'),
  ].filter(Boolean);
  return candidates.find((candidate) => fs.existsSync(candidate)) || null;
}

function deliveryRulesTarget() {
  return path.join(ROOT, DELIVERY_RULES, 'SKILL.md');
}

function projectSkillStatus() {
  if (GLOBAL) return { required: false, status: 'not-applicable', source: null, file: null };
  const source = deliveryRulesSource();
  const file = deliveryRulesTarget();
  if (!source) return { required: true, status: 'source-missing', source: null, file };
  try {
    const sourceContent = fs.readFileSync(source, 'utf8');
    if (!fs.existsSync(file)) return { required: true, status: 'missing', source, file, sourceContent };
    const content = fs.readFileSync(file, 'utf8');
    return {
      required: true,
      status: content === managedProjectionContent(sourceContent)
        ? 'managed'
        : content.includes(DELIVERY_RULES_MARKER)
          ? 'stale-managed'
          : content === sourceContent ? 'legacy-managed' : 'foreign',
      source,
      file,
      sourceContent,
    };
  } catch (e) {
    return { required: true, status: 'unreadable', source, file, error: e.message };
  }
}

const skillProjection = projectSkillStatus();

// The desired value for an agent_skills.* entry is a MERGE, not a replacement:
// present entries ∪ {project-relative delivery rules} − {legacy runtime forms},
// order preserved and ours appended last. A static one-element array here (the
// earlier shape) is what produced ADR-004 D7 / audit F22: a project's own
// [custom-test-contract, custom-quality] became [delivery-rules] after a
// successful --apply, because the generic `set()` below replaces the whole key
// with whatever "want" is.
function mergedSkills(have) {
  const existing = Array.isArray(have) ? have : [];
  const kept = existing.filter((s) => !LEGACY_DELIVERY_RULES.has(s));
  return kept.includes(DELIVERY_RULES) ? kept : [...kept, DELIVERY_RULES];
}

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

const { config: pipeline, valid: PIPE_VALID, error: PIPE_ERROR } = loadConfig(
  ROOT,
  runtime ? { runtime } : {},
);

// A PROJECT CONFIG THAT DOES NOT PARSE IS NOT READ (ADR-004 D2, audit F03).
//
// Project mode is already immune by accident of arithmetic: `CONFIG` is that
// same file, and the hard fail above ("refusing to rewrite a file I cannot
// parse") fires first. `--global` writes a DIFFERENT file — ~/.gsd/defaults.json
// — while still reading the project's config for `model_profile`, so a corrupt
// one produced `model_profile → "balanced" … mirrors pipeline.model_policy =
// "balanced"`, and would have written it. The values are conservative; the
// MISATTRIBUTION is the defect, because a report that tells the operator what the
// file says is the one thing this script exists to be trusted about.
//
// Withholding the WHOLE write rather than only the derived row, and the reason is
// the scope: this file is inherited by every directory on the machine with no
// `.planning/` of its own. Writing part of a machine-wide policy while the
// project's own policy is unknown is the same misattribution one step further on.
//
// An ABSENT file is `valid: true, error: null` and must NOT refuse — that is the
// commonest case there is here, since an installer runs `--global` before any
// project exists.
const CONFIG_REFUSAL = (GLOBAL && !PIPE_VALID)
  ? `gsd-tune: no policy is in effect — ${PIPE_ERROR.file} ${PIPE_ERROR.message}. `
    + 'The settings below that mirror it are withheld rather than reported off defaults, and '
    + '--apply writes nothing machine-wide until the file parses; the fix is the file, not a flag.'
  : null;

// Project mode only. `git.branching_strategy: none` is a CONVEYOR requirement,
// and the global file is inherited by every unconfigured directory on the
// machine — an ordinary GSD project legitimately wants phase branches, so
// forcing this machine-wide is the same overreach the capability's plan:post
// gate has an applicability check to avoid.
const REQUIRED = GLOBAL ? [] : [
  ['git.branching_strategy', 'none',
    'the conveyor owns branching (epic/<phase> + ticket/<id>); GSD phase/milestone branches would fight it'],
];

// ── the version floors (BLOCKERS) ────────────────────────────────────────────
//
// PIN THE ALIAS, DO NOT MERELY CHECK THE VERSION. The ladder can only emit an
// ALIAS — the Agent tool's `model` is enum-validated to the four of them, so no
// dispatch can name a full id — and below CLI 2.1.255 `fable` resolves to Fable
// 5. Verified 2026-09-07: this host at 2.1.263 resolves 5.1, while an image built
// from `main` that same day carried the 2.1.200 pin and would have resolved Fable
// 5 SILENTLY. `ANTHROPIC_DEFAULT_FABLE_MODEL=claude-fable-5-1` bypasses the
// built-in mapping and is therefore the stronger guarantee (it is set in
// .env.example, docker-compose.yml and the k8s configmap); this check is the
// second half, for a host neither of those governs — and it names both ways the
// floor can be missed, because a reader who only raises the CLI can still have
// the env var pointing elsewhere.
const FABLE_FLOOR = '2.1.255';
// The id that pin must name, and the ONE place this file states it: it was quoted
// twice in prose and read nowhere, which is the defect ADR-007 D4 names. Declared
// beside the floor because the remedy for one is the remedy for the other.
const FABLE_MODEL_PIN = 'claude-fable-5-1';
// The environment variable that carries that pin. Named once, read once.
const FABLE_PIN_VAR = 'ANTHROPIC_DEFAULT_FABLE_MODEL';
// The Codex mirror has NO constant here on purpose. Its floors live in the
// operator's own palette — `pipeline.codex_models` entries carry `min_cli`, e.g.
// `<ceiling-model>:high@0.153.1` — and a second copy in this file would go stale
// the next time that palette changes. `tests/unit/gen-codex-shipyard.test.cjs`
// enforces that: the palette default is the one place a model id may appear as a
// value.

// Numeric, segment by segment. `localeCompare` gets 2.1.9 vs 2.1.10 wrong, which
// is exactly the pair a floor check meets.
function cmpVersion(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] || 0;
    const y = pb[i] || 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

// The version a CLI reports, or null when it cannot be read. Null is SILENCE, not
// a finding: `claude --version` prints "2.1.263 (Claude Code)" and
// `codex --version` prints "codex-cli 0.147.0", so the number is extracted rather
// than parsed positionally — but a missing binary, a non-zero exit or an
// unrecognizable line all mean "not measured", and a blocker asserted from an
// unreadable version would fire on every run of a host we know nothing about.
function cliVersion(bin) {
  let r;
  try {
    r = spawnSync(bin, ['--version'], { encoding: 'utf8', timeout: 10000 });
  } catch { return null; }
  if (!r || r.error || r.status !== 0) return null;
  const m = /(\d+\.\d+(?:\.\d+)*)/.exec(`${r.stdout || ''} ${r.stderr || ''}`);
  return m ? m[1] : null;
}

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
// Only the two agents whose work is genuinely context-bound: the planner holds
// RESEARCH + roadmap + codebase maps at once, the reviewer holds the whole diff.
// The executor and the fixer work inside one ticket's narrow scope, where a 1M
// window buys nothing and costs money — they keep their profile tiers.
//
// And they take `fable` on the SAME TERMS as the conveyor's own roles, which is
// the correction ADR-005 makes here: the 1M-window argument was retired for
// `arch-review` on a measurement (the largest input in the system is the phase
// epic diff at ~52k tokens), and it cannot survive for these two on the strength
// of the same sentence. So the want is `opus` unless `pipeline.fable` is `auto` —
// a person's consent — exactly as the conveyor's ceiling works. Neither agent
// fires on the conveyor's own path (measured over a full three-phase session:
// zero runs each), so this governs what a `/gsd-*` command costs OUTSIDE the
// conveyor rather than a delivery session's bill.
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
      `model_overrides.${agent}`, pipeline.fable === 'auto' ? 'fable' : 'opus',
      pipeline.fable === 'auto'
        ? 'context-bound on Claude, and pipeline.fable is "auto" — a person has consented to the paid ' +
          '1M tier. Set here rather than via model_profile_overrides.claude.*, which the resolver skips on Claude'
        : 'context-bound, but the 1M window is not a measured need (the largest input in the system is ' +
          'the phase epic diff, ~52k tokens): `opus` until pipeline.fable is "auto", exactly as the ' +
          'conveyor\'s own judges work. Set here because model_profile_overrides.claude.* is inert',
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
  // BOTH agents, and the planner is the one that matters most: it writes the
  // `delivery:` frontmatter block the whole graph is built from, so a planner
  // without delivery-rules produces tickets Gate 2 then rejects. Only the
  // executor was set here until decomposing this repo through the conveyor
  // surfaced the omission — the skill's own template lists both.
  [`agent_skills.gsd-planner`, mergedSkills,
    'the frontmatter contract, through the runtime-neutral project skill projection — merged in, not replacing what is already there'],
  [`agent_skills.gsd-executor`, mergedSkills,
    'the delivery-rules contract, through the runtime-neutral project skill projection — merged in, not replacing what is already there'],
];

// The rows whose WANT is derived from the project's `pipeline.*` — the only ones
// a refusal has to withhold. Named as a set rather than tested by regex so that a
// row added here is a deliberate act: a new pipeline-derived want that is not
// listed would be reported off the defaults again, which is the whole defect.
const PIPELINE_DERIVED = new Set([
  'model_profile',                       // mirrors pipeline.model_policy
  ...CLAUDE_1M_AGENTS.map((a) => `model_overrides.${a}`), // reads pipeline.fable
]);

const TUNING = TUNING_ALL
  .filter(([key]) => !GLOBAL || GLOBAL_SAFE.has(key))
  .filter(([key]) => !CONFIG_REFUSAL || !PIPELINE_DERIVED.has(key));

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

// Most desired values are static. agent_skills.* is a MERGE, computed from
// whatever is already there, so its "want" is a function of `have` rather than
// a constant — the only way to add our entry without clobbering the rest.
const isMergeKey = (key) => key.startsWith('agent_skills.');

const drift = [];
for (const [group, list] of [['required', REQUIRED], ['tuning', TUNING]]) {
  for (const [key, wantSpec, why] of list) {
    const have = get(raw, key);
    const want = typeof wantSpec === 'function' ? wantSpec(have) : wantSpec;
    if (same(have, want)) continue;
    const entry = { group, key, have: have === undefined ? null : have, want, why, set: have !== undefined };
    if (isMergeKey(key)) {
      const haveArr = Array.isArray(have) ? have : [];
      entry.added = want.filter((s) => !haveArr.includes(s));
      entry.removed = haveArr.filter((s) => !want.includes(s));
    }
    drift.push(entry);
  }
}

const projectionNeedsAction = !GLOBAL && skillProjection.status !== 'managed';

// ── the blockers: floors no key can fix ──────────────────────────────────────
//
// Measured only where the project has actually asked for the model in question,
// so a project that never consented to Fable never sees the Fable floor, and a
// machine with no Codex install never sees Astra's.
const blockers = [];

// A floor keyed on a value the file does not say is a finding invented from a
// default. Under a refusal `pipeline.fable` is the shipped `off`, so the check
// would simply not fire — but stating the guard keeps it that way if the default
// ever moves, and it is the same rule the derived rows above obey.
if (!CONFIG_REFUSAL && runtime === 'claude' && pipeline.fable === 'auto') {
  const have = cliVersion('claude');
  if (have && cmpVersion(have, FABLE_FLOOR) < 0) {
    blockers.push({
      what: 'fable-floor',
      have,
      need: FABLE_FLOOR,
      head: `this host has ${have}, the floor is ${FABLE_FLOOR}`,
      why:
        `pipeline.fable is "auto", but Claude Code ${have} resolves the \`fable\` alias to Fable 5 — ` +
        `Fable 5.1 needs ${FABLE_FLOOR}. TWO ways to miss this floor, and both must be closed: upgrade ` +
        `the CLI, and/or set ${FABLE_PIN_VAR}=${FABLE_MODEL_PIN}, which bypasses the built-in ` +
        'mapping and passes the id straight to the API (the stronger guarantee, and the one that protects ' +
        'a host the image pin does not govern).',
    });
  }
}

// THE PIN IS THE STRONGER GUARANTEE, SO IT IS THE ONE THAT GETS MEASURED.
//
// `ANTHROPIC_DEFAULT_FABLE_MODEL` bypasses the built-in alias mapping and passes
// the id straight to the API. That is why the remedy above names it — and it is
// also why a check that reads only the CLI version answers about the WEAKER of
// the two guarantees: the pin outranks the mapping the version decides. It
// appeared in this file twice, both times as comment or remedy prose, and was
// read nowhere. Measured: pipeline.fable "auto", CLI 2.1.263 and
// ANTHROPIC_DEFAULT_FABLE_MODEL=claude-fable-5 gave exit 0 and no blockers while
// the environment pinned the model ADR-005 ruled out.
//
// INDEPENDENT OF THE CLI VERSION, in both directions: an up-to-date CLI does not
// rescue a wrong pin, and an unreadable one does not excuse it. (Unreadability is
// silence for the FLOOR because the floor is a fact about the CLI; the pin is a
// fact about this environment, and it reads either way.)
//
// REPORTED, never rewritten. A user's environment is not this script's to write,
// and `--apply` has no key for it — which is exactly what makes it a blocker
// rather than drift. An UNSET pin is not a finding: the built-in mapping then
// applies, and the floor above already governs that.
if (!CONFIG_REFUSAL && runtime === 'claude' && pipeline.fable === 'auto') {
  const pinned = String(process.env[FABLE_PIN_VAR] || '').trim();
  if (pinned && pinned !== FABLE_MODEL_PIN) {
    blockers.push({
      what: 'fable-pin',
      have: pinned,
      need: FABLE_MODEL_PIN,
      head: `${FABLE_PIN_VAR} pins "${pinned}", and this project consented to "${FABLE_MODEL_PIN}"`,
      why:
        `pipeline.fable is "auto", so a person has consented to the paid tier — but ${FABLE_PIN_VAR} ` +
        `is exported as "${pinned}", and that variable BYPASSES the alias mapping entirely: the id goes ` +
        `straight to the API, whatever the CLI version resolves. So every \`fable\` dispatch on this host ` +
        `runs "${pinned}" rather than "${FABLE_MODEL_PIN}". Export ${FABLE_PIN_VAR}=${FABLE_MODEL_PIN} ` +
        'or unset it and let the CLI resolve the alias (the floor above then applies). Nothing here ' +
        'rewrites your environment.',
    });
  }
}

// The Codex mirror, and it is keyed the same way the Fable floor is: only where
// THIS project would actually reach for the model. A dual-runtime machine has a
// `~/.codex/config.toml` whatever this project delivers on, so measuring it
// unconditionally would put a Codex finding in front of every Claude delivery on
// this host — a report nobody in that session can act on, which is how a report
// teaches its reader to skip it.
const codexConfig = path.join(process.env.CODEX_HOME || path.join(process.env.HOME || '', '.codex'), 'config.toml');
const codexDir = path.dirname(codexConfig);
let codexToml = '';
// ENOENT is silence, honestly: no config.toml yet is not a finding. Any other
// read failure (permissions, EISDIR, …) is NOT the same fact as absence — the
// file exists and names something, but this run cannot see it, so every floor
// and registration below is unmeasurable and would silently report nothing:
// the exact false-green class this ticket removes one layer along.
if (runtime === 'codex') {
  try {
    codexToml = fs.readFileSync(codexConfig, 'utf8');
  } catch (e) {
    codexToml = '';
    if (e.code !== 'ENOENT' && !CONFIG_REFUSAL) {
      blockers.push({
        what: 'codex-config-unreadable',
        file: codexConfig,
        head: `${codexConfig} exists and cannot be read (${e.code || e.message})`,
        why:
          `runtime is "codex", so floors and registrations are measured against ${codexConfig} — but it ` +
          `cannot be read (${e.code || e.message}), so nothing below can be measured and none of it would ` +
          'be reported: the same false-green class this ticket removes one layer along. Fix the file\'s ' +
          'permissions or ownership so it can be read. Nothing here rewrites your config.',
      });
    }
  }
}

// WHAT THIS HOST WILL ACTUALLY RUN IS NOT IN config.toml.
//
// The check below was never missing — every palette `min_cli` was already
// measured against the host. It was ATTACHED TO THE WRONG FILE. A normal install
// writes a REGISTRATION:
//   [agents.shipyard-integrator]
//   config_file = "…/.codex/agents/shipyard-integrator.toml"
// and the MODEL lives in that second file, so a gate on `config.toml`'s own bytes
// is false on every normally-installed host (measured on this machine: seven
// registrations, every model in a file of its own — ADR-007 Family C). So the
// registered files are read too, and `config.toml`'s own inline models still
// count: a hand-written host legitimately puts one there, and this one does.
//
// Only `config_file` INSIDE an `[agents.*]` table. A same-named key in some
// unrelated table is not an agent registration, and treating one as such would
// put a false blocker in front of every Codex delivery — the unsafe direction for
// a preflight, and the one that gets a gate switched off.
// A `[agents.*]`-shaped or `config_file = "..."`-shaped LITERAL inside a
// multi-line string is TEXT, not TOML grammar — the same class of bug
// `merge-codex-config.cjs`'s scanner exists to prevent (ADR-004 D6, "a table
// header is TOML grammar, not a line shape"). This reader is read-only and
// report-only (never a reason to reach for that scanner's full machinery, and
// this file's own `files_modified` does not extend there), so it carries just
// enough of the same idea: blank out the CONTENT of every triple-quoted
// multi-line string before the line-shaped scan below ever sees it. A `[` or
// `config_file` inside one can then never be mistaken for a header or an
// assignment — the unsafe direction for a preflight, since a false header
// here produces a false `codex-agent-unreadable`/`codex-model-floor` blocker
// on an otherwise-valid config.
function blankMultilineStrings(toml) {
  const lines = toml.split('\n');
  const out = [];
  let delim = null;
  for (const raw of lines) {
    if (delim) {
      const end = raw.indexOf(delim);
      if (end === -1) { out.push(''); continue; }
      out.push(raw.slice(end + delim.length));
      delim = null;
      continue;
    }
    let line = '';
    let rest = raw;
    for (;;) {
      const m = rest.match(/"""|'''/);
      if (!m) { line += rest; break; }
      line += rest.slice(0, m.index);
      const after = rest.slice(m.index + 3);
      const close = after.indexOf(m[0]);
      if (close === -1) { delim = m[0]; break; }
      rest = after.slice(close + 3);
    }
    out.push(line);
  }
  return out.join('\n');
}

function registeredAgentFiles(toml) {
  const files = [];
  let inAgents = false;
  for (const line of blankMultilineStrings(toml).split('\n')) {
    const header = line.match(/^\s*\[([^\]]+)\]/);
    if (header) { inAgents = /^agents\./.test(header[1].trim()); continue; }
    if (!inAgents) continue;
    const m = line.match(/^\s*config_file\s*=\s*["']([^"']+)["']/);
    if (!m) continue;
    const raw = m[1].startsWith('~/') ? path.join(process.env.HOME || '', m[1].slice(2)) : m[1];
    files.push(path.isAbsolute(raw) ? raw : path.join(codexDir, raw));
  }
  return files;
}

// Every file that could NAME a model, and every registration that could not be
// read. Reads only — placing files under the Codex home is the installer's act.
const codexModelSources = [];
const codexUnreadable = [];
if (codexToml) {
  codexModelSources.push({ file: codexConfig, text: codexToml });
  for (const file of registeredAgentFiles(codexToml)) {
    try { codexModelSources.push({ file, text: fs.readFileSync(file, 'utf8') }); }
    catch (e) { codexUnreadable.push({ file, message: e.code || e.message }); }
  }
}

// Every palette entry that declares a floor, measured against the host — but only
// where the installed agent files actually NAME that model, because an entry the
// generator did not write is nothing to report. The generator refuses such an
// entry at install time; this is the same fact one layer later, for a host that
// was downgraded, or an agent file written before the palette gained the floor.
if (codexToml && !CONFIG_REFUSAL) {
  // A registration whose file cannot be read is REPORTED, never skipped: the
  // model that agent would run is unknown, so every floor below is measured
  // against an incomplete set, and silence would be the same false green this
  // ticket removes one layer along. Independent of the CLI version — nothing
  // about a missing file is a version fact.
  for (const miss of codexUnreadable) {
    blockers.push({
      what: 'codex-agent-unreadable',
      file: miss.file,
      head: `${miss.file} is registered and cannot be read (${miss.message})`,
      why:
        `${codexConfig} registers an agent whose config_file does not read, so the model that agent ` +
        'would run is unknown and no version floor here can be measured against it. Regenerate and ' +
        'reinstall the Codex bundle (make install-shipyard-codex) so every registration names a file ' +
        'that exists, or remove the registration. Nothing here rewrites your config.',
    });
  }
  const codexHave = cliVersion('codex');
  for (const entry of Array.isArray(pipeline.codex_models) ? pipeline.codex_models : []) {
    if (!entry || !entry.min_cli || !entry.model) continue;
    // One palette entry is ONE finding however many files name it — the report is
    // about the model's floor, and the files are the evidence for it.
    const named = codexModelSources.filter((s) => s.text.includes(entry.model));
    if (!named.length) continue;
    if (!codexHave || cmpVersion(codexHave, entry.min_cli) >= 0) continue;
    blockers.push({
      what: 'codex-model-floor',
      model: entry.model,
      files: named.map((s) => s.file),
      have: codexHave,
      need: entry.min_cli,
      head: `this host has ${codexHave}, the floor is ${entry.min_cli}`,
      why:
        `${named.map((s) => s.file).join(', ')} configures "${entry.model}", and pipeline.codex_models ` +
        `declares that it needs Codex CLI ${entry.min_cli} while this host runs ${codexHave} — the agent ` +
        'files naming it may simply be ignored, which looks like a working install running a model nobody ' +
        'chose. Upgrade the CLI, or drop that entry from the palette so the generator writes the previous ' +
        'one instead.',
    });
  }
}

// A machine and a checkout can have BOTH runtimes installed. The old global or
// project `runtime` key was shared by both installers, so whichever one ran last
// won for every unconfigured directory or shared checkout. It is migration debt,
// not a new setting: remove it and let GSD use the per-install `.gsd-runtime`
// marker (or GSD_RUNTIME for an explicit run).
const legacyRuntime = typeof raw.runtime === 'string' && raw.runtime.trim()
  ? raw.runtime.trim() : null;
const legacyRuntimeScope = GLOBAL ? 'global' : 'project';
const runtimeDisplay = runtime || 'unresolved';

if (AS_JSON) {
  console.log(JSON.stringify({
    runtime: runtime || null, runtime_source: how, applied: APPLY, scope: GLOBAL ? 'global' : 'project',
    runtime_legacy: legacyRuntime,
    runtime_legacy_scope: legacyRuntime ? legacyRuntimeScope : null,
    runtime_conflict: runtimeContext.conflict,
    runtime_ambiguous: !runtime,
    skill_projection: {
      path: skillProjection.file ? path.relative(ROOT, skillProjection.file) : null,
      status: skillProjection.status,
      source: skillProjection.source,
    },
    // Carried on the result rather than only where it came due — ci-wait.cjs's
    // template. A caller reading `drift` cannot otherwise tell a row that was
    // withheld from a row that already agrees.
    ...(CONFIG_REFUSAL ? { config_invalid: CONFIG_REFUSAL } : {}),
    drift, blockers,
  }, null, 2));
} else {
  console.log(`gsd-tune: runtime "${runtimeDisplay}" (${how}) — ${CONFIG}${GLOBAL ? '  [global defaults]' : ''}`);
  // FIRST, before any row a reader might act on: the project's own policy could
  // not be read, so the rows that mirror it are absent rather than defaulted.
  if (CONFIG_REFUSAL) console.log(`\n  ${CONFIG_REFUSAL}`);
  if (legacyRuntime) {
    console.log(
      `\n  ⚠ legacy ${legacyRuntimeScope} runtime "${legacyRuntime}" is present.\n` +
      (GLOBAL
        ? '    ~/.gsd/defaults.json is shared by both installs, so this key makes the\n' +
          '    active runtime depend on which installer ran last. Applying removes the key; GSD then uses the\n'
        : '    .planning/config.json is shared by both runtimes, so this key overrides\n' +
          '    the active install marker. Applying removes the key; GSD then uses the\n') +
      '    per-install marker or GSD_RUNTIME.'
    );
  }
  if (!runtime) {
    console.log(
      '\n  ⚠ runtime is ambiguous. Read-only output uses the Claude-compatible policy, but --apply is refused.\n' +
      '    Run with --runtime claude|codex, or set SHIPYARD_RUNTIME/GSD_RUNTIME for the active host.'
    );
  }
  if (projectionNeedsAction) {
    const projectionMessage = {
      missing: 'the project-relative delivery-rules skill has not been generated yet',
      'legacy-managed': 'the project-relative delivery-rules skill predates Shipyard ownership marking',
      'stale-managed': 'the project-relative delivery-rules skill is out of date with the canonical source',
      'source-missing': 'the Shipyard delivery-rules source is not present beside this installer',
      foreign: 'the project-relative delivery-rules path exists but is not Shipyard-managed',
      unreadable: `the project-relative delivery-rules skill cannot be read${skillProjection.error ? ` (${skillProjection.error})` : ''}`,
    }[skillProjection.status] || `the project-relative delivery-rules skill is ${skillProjection.status}`;
    console.log(
      `\n  ⚠ GSD skill projection: ${projectionMessage}.\n` +
      `    Expected at ${path.relative(ROOT, skillProjection.file)}. ` +
      'Applying generates or refreshes it; a foreign file is never overwritten.'
    );
  }
  if (blockers.length) {
    // Not every blocker is a VERSION any more: a pin in the environment and a
    // registration that does not read are the same class (no key fixes them, and
    // `--apply` has nothing to write) with a different subject, so each states its
    // own headline rather than being forced through "have/floor".
    console.log('\n  REQUIRED — no config key can fix these:');
    for (const b of blockers) {
      console.log(`    ${b.what}: ${b.head}`);
      console.log(`        ${b.why}`);
    }
  }
  if (!drift.length && !legacyRuntime && !blockers.length && runtime && !projectionNeedsAction) {
    console.log('  nothing to change: this project already agrees with the conveyor');
  }
  for (const g of ['required', 'tuning']) {
    const rows = drift.filter((d) => d.group === g);
    if (!rows.length) continue;
    console.log(`\n  ${g === 'required' ? 'REQUIRED — the conveyor is incorrect without these' : 'tuning — cost and quality, never correctness'}:`);
    for (const d of rows) {
      // A value the user deliberately set is named as theirs, not flattened as
      // "drift": the difference decides whether --apply is a fix or an override.
      if (isMergeKey(d.key)) {
        // A merge is never "set to X" — that reads as a replacement of whatever
        // the project already put there. Say only what changes.
        const bits = [];
        if (d.added.length) bits.push(`+ ${d.added.join(', ')}`);
        if (d.removed.length) bits.push(`- ${d.removed.join(', ')}`);
        console.log(`    ${d.key}:  ${bits.join('   ')}`);
      } else {
        const state = d.set ? `currently ${JSON.stringify(d.have)} (yours)` : 'unset';
        console.log(`    ${d.key} → ${JSON.stringify(d.want)}   [${state}]`);
      }
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

// The mutation, withheld. A refusal is not a failed write and must not read as
// one (ci-wait.cjs's rule): nothing was attempted, and the remedy is the project
// file rather than a retry or a flag. Checked BEFORE the empty-drift exit below:
// a machine whose global defaults already match every non-derived row (drift
// empty) and whose Codex toml has no version-floor issue (blockers empty, itself
// gated on `!CONFIG_REFUSAL`) would otherwise fall through to that `exit(0)` and
// report success on a run that printed a refusal — Copilot's finding on this
// PR (the exit-0 the tests never exercised, because every fixture here starts
// from a bare global file, so drift is never empty in them). A refusal is a
// finding regardless of what else this run would have changed.
if (CONFIG_REFUSAL) {
  if (!AS_JSON) {
    console.log(`\n  NOT ${APPLY ? 'applied' : 'reported in full'}: ${CONFIG}${APPLY ? ' is unchanged' : ''}.`);
    console.log('  Fix the project config and run this again — from a directory whose'
      + ' .planning/config.json parses,\n  since that is the file these values mirror.');
  }
  process.exit(1);
}

if (!drift.length && !staleGlobalOverrides.length && !legacyRuntime && !blockers.length && !projectionNeedsAction) {
  if (!runtime && APPLY) process.exit(2);
  process.exit(0);
}

// A blocker survives --apply, because there is nothing to apply: the exit code
// has to keep saying so, or the one finding a write cannot fix would be the one
// finding a caller stops seeing.
if (!drift.length && !staleGlobalOverrides.length && !legacyRuntime && !projectionNeedsAction) process.exit(1);

if (!APPLY) {
  if (!AS_JSON) {
    console.log('\n  reported only. `gsd-tune.cjs --apply` writes them; every other key in the file is left alone.');
  }
  // Non-zero so a caller can gate on it, the same way the other conveyor gates do.
  process.exit(1);
}

if (!runtime) {
  process.stderr.write(
    'gsd-tune: refusing --apply because the active runtime is ambiguous; ' +
    'set --runtime claude|codex or SHIPYARD_RUNTIME/GSD_RUNTIME\n'
  );
  process.exit(2);
}

if (projectionNeedsAction && ['source-missing', 'unreadable', 'foreign'].includes(skillProjection.status)) {
  process.stderr.write(
    `gsd-tune: refusing --apply because the delivery-rules projection is ${skillProjection.status}; ` +
    'provide the Shipyard source or resolve the existing file before applying\n'
  );
  process.exit(2);
}

if (projectionNeedsAction) {
  const target = skillProjection.file;
  const body = managedProjectionContent(skillProjection.sourceContent);
  const tmpSkill = `${target}.gsd-tune.tmp`;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(tmpSkill, body);
  fs.renameSync(tmpSkill, target);
}

for (const d of drift) set(raw, d.key, d.want);
for (const agent of staleGlobalOverrides) delete raw.model_overrides[agent];
// Leave no empty husk behind — an empty object reads as "someone configured this".
if (raw.model_overrides && !Object.keys(raw.model_overrides).length) delete raw.model_overrides;
if (legacyRuntime) delete raw.runtime;

const tmp = `${CONFIG}.gsd-tune.tmp`;
// `--global` on a machine that never ran GSD has no ~/.gsd at all, not just a
// missing defaults.json — the directory itself is ours to create.
fs.mkdirSync(path.dirname(CONFIG), { recursive: true });
fs.writeFileSync(tmp, JSON.stringify(raw, null, 2) + '\n');
fs.renameSync(tmp, CONFIG); // atomic: a reader sees the old file or the new one
if (!AS_JSON) {
  const parts = [];
  if (drift.length) parts.push(`wrote ${drift.length} setting(s)`);
  if (staleGlobalOverrides.length) parts.push(`withdrew ${staleGlobalOverrides.length} stale override(s)`);
  if (legacyRuntime) parts.push(`removed legacy ${legacyRuntimeScope} runtime`);
  if (projectionNeedsAction) parts.push(`generated ${DELIVERY_RULES}/SKILL.md`);
  console.log(`\n✓ ${parts.join(', ')} in ${CONFIG}`);
  if (blockers.length) {
    console.log(`  ${blockers.length} version floor(s) remain — nothing here can write those.`);
  }
}
// Everything writable was written; the floors are still unmet, so the exit code
// must not report success.
process.exit(blockers.length ? 1 : 0);
