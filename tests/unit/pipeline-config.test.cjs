'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { suite, test, done, assert } = require('./assert-harness.cjs');

const mod = path.join(__dirname, '..', '..', 'plugins', 'delivery-pipeline', 'scripts', 'pipeline-config.cjs');
const repoResolver = require(path.join(__dirname, '..', '..', 'plugins', 'delivery-pipeline', 'scripts', 'repo-resolve.cjs'));
const {
  loadConfig, resolveTaskLevel, taskLevelRoute,
  EFFORTS, DEFAULTS, ROLES, DEFAULT_CODEX_MODELS,
  NUMERIC_KNOBS, TICKET_STATUSES, defaultRepositoryRoot,
  validateRepositoryDestination, resolveDispatch, COMPATIBILITY_ROLES, ROUTED_ROLES, repoValue,
} = require(mod);
const sigMod = path.join(__dirname, '..', '..', 'plugins', 'delivery-pipeline', 'scripts', 'failure-signature.cjs');

function withConfig(pipeline) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-cfg-'));
  fs.mkdirSync(path.join(dir, '.planning'), { recursive: true });
  if (pipeline !== undefined) {
    fs.writeFileSync(path.join(dir, '.planning', 'config.json'), JSON.stringify({ pipeline }, null, 2));
  }
  return loadConfig(dir, { env: {} });
}

// write an arbitrary config.json (to cover GSD's own top-level keys)
function withRaw(raw) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-cfg-'));
  fs.mkdirSync(path.join(dir, '.planning'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.planning', 'config.json'), JSON.stringify(raw, null, 2));
  return loadConfig(dir, { env: {} });
}

function withRawOptions(raw, options) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-cfg-'));
  fs.mkdirSync(path.join(dir, '.planning'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.planning', 'config.json'), JSON.stringify(raw, null, 2));
  return { dir, ...loadConfig(dir, options) };
}

suite('loadConfig');

test('no config file → defaults, no warnings', () => {
  const { config, warnings } = withConfig(undefined);
  assert.strictEqual(config.integration_mode, 'epic-stacked');
  assert.strictEqual(config.model_policy, 'balanced');
  assert.strictEqual(config.model_ladder, 'conservative');
  assert.strictEqual(config.gsd_sync, true);
  assert.strictEqual(config.max_attempts, 5);
  assert.deepStrictEqual(warnings, []);
});

test('model_ladder accepts adaptive and rejects a misspelling', () => {
  const adaptive = withConfig({ model_ladder: 'adaptive' });
  assert.strictEqual(adaptive.config.model_ladder, 'adaptive');
  assert.deepStrictEqual(adaptive.warnings, []);
  const bad = withConfig({ model_ladder: 'aggressive' });
  assert.strictEqual(bad.config.model_ladder, 'conservative');
  assert.ok(bad.warnings.some((w) => /model_ladder/.test(w)), bad.warnings.join('; '));
});

test('unknown key is ignored WITH a warning (a silent typo is a lie)', () => {
  const { config, warnings } = withConfig({ integraton_mode: 'direct-to-main' });
  assert.strictEqual(config.integration_mode, 'epic-stacked');
  assert.ok(warnings.some((w) => /integraton_mode/.test(w)), warnings.join('; '));
});

test('a full model ID in pipeline.models is rejected, not honoured', () => {
  const { config, warnings } = withConfig({ models: { executor: 'claude-opus-4-8[1m]' } });
  assert.strictEqual(config.models.executor, undefined);
  assert.ok(warnings.some((w) => /not a tier alias/.test(w)), warnings.join('; '));
});

test('a valid tier alias override is honoured', () => {
  const { config, warnings } = withConfig({ models: { 'drift-check': 'haiku' } });
  assert.strictEqual(config.models['drift-check'], 'haiku');
  assert.deepStrictEqual(warnings, []);
});

test('unknown role in pipeline.models warns', () => {
  const { warnings } = withConfig({ models: { 'made-up': 'opus' } });
  assert.ok(warnings.some((w) => /not a pipeline role/.test(w)));
});

test('unknown integration_mode falls back to epic-stacked with a warning', () => {
  const { config, warnings } = withConfig({ integration_mode: 'stacked-ish' });
  assert.strictEqual(config.integration_mode, 'epic-stacked');
  assert.ok(warnings.some((w) => /integration_mode/.test(w)));
});

test('a valid integration_mode is passed through untouched', () => {
  const { config, warnings } = withConfig({ integration_mode: 'direct-to-main' });
  assert.strictEqual(config.integration_mode, 'direct-to-main');
  assert.deepStrictEqual(warnings, []);
});

test('non-positive numeric knobs fall back with a warning', () => {
  const { config, warnings } = withConfig({ max_attempts: 0, pr_fetch_limit: -3 });
  assert.strictEqual(config.max_attempts, DEFAULTS.max_attempts);
  assert.strictEqual(config.pr_fetch_limit, DEFAULTS.pr_fetch_limit);
  assert.strictEqual(warnings.filter((w) => /must be a positive number/.test(w)).length, 2);
});

// ── the concurrency cap (ADR-005 D11) ───────────────────────────────────────
//
// No choice of TIER addresses a per-session spend limit: the policy is per
// dispatch and the limit is per session, so the missing axis is how many
// dispatches are open at once. This is that axis, and it rides the SAME numeric
// rule as every other positive-number knob — deliberately, because a bespoke
// coercion here is one more place for the fallback direction to be got wrong.
test('max_concurrent_agents defaults to the largest wave measured on this repo', () => {
  assert.strictEqual(DEFAULTS.max_concurrent_agents, 4);
  assert.strictEqual(withConfig(undefined).config.max_concurrent_agents, 4);
  const set = withConfig({ max_concurrent_agents: 2 });
  assert.strictEqual(set.config.max_concurrent_agents, 2);
  assert.deepStrictEqual(set.warnings, []);
});

test('a cap of 0 or a malformed cap warns and falls back — a broken knob must not stall the run', () => {
  // The knob's OWN failure direction is the default, not zero: a typo in the
  // number is not a decision to dispatch nothing, and a run that stalls on a
  // typo is a run whose operator switches the cap off. (The other direction —
  // a config file that does not PARSE — is front.cjs's, and there the answer is
  // zero, because then no policy is in effect at all.)
  for (const bad of [0, -1, 'lots', null, {}]) {
    const { config, warnings } = withConfig({ max_concurrent_agents: bad });
    assert.strictEqual(config.max_concurrent_agents, DEFAULTS.max_concurrent_agents, JSON.stringify(bad));
    assert.ok(
      warnings.some((w) => /max_concurrent_agents must be a positive number/.test(w)),
      `${JSON.stringify(bad)}: ${warnings.join('; ')}`
    );
  }
});

// ── the shared numeric rule, probed at the ENDPOINTS AND THE MIDDLE ─────────
//
// Both defects below were shipped ACCEPTED because only the endpoints were
// probed, and both come from the one shared rule in `loadConfig` rather than
// from any knob — so `max_attempts` behaves identically and is asserted beside
// the cap on every case. `NUMERIC_KNOBS` is imported from the module itself
// (not re-typed here) — Copilot's review on PR #71 found the list was a
// hand-mirrored duplicate of the rule's own array, which is exactly the kind of
// copy that drifts silently when a knob is added to one and not the other; the
// module now exports the one array both the rule and this test read.

test('a boolean is not a number: `true` must never read as a cap of ONE', () => {
  // `Number(true) === 1`, so `max_concurrent_agents: true` passed the
  // positive-number check and silently capped the whole session at ONE agent,
  // with no warning at all. `false` was the mirror (`Number(false) === 0` → the
  // default), which is why probing only `false` proved nothing.
  for (const knob of NUMERIC_KNOBS) {
    for (const bool of [true, false]) {
      const { config, warnings } = withConfig({ [knob]: bool });
      assert.strictEqual(config[knob], DEFAULTS[knob], `${knob}: ${bool} → ${config[knob]}`);
      assert.ok(warnings.some((w) => new RegExp(`pipeline\\.${knob}`).test(w) && /not a number/.test(w)),
        `${knob}: ${bool} must SAY so — ${warnings.join('; ')}`);
    }
  }
});

test('a fractional value is floored, and the warning names the floor', () => {
  // 4.5 used to survive intact and produce a FRACTIONAL `free` on the board.
  for (const knob of NUMERIC_KNOBS) {
    const { config, warnings } = withConfig({ [knob]: 4.5 });
    assert.strictEqual(config[knob], 4, `${knob}: 4.5 → ${config[knob]}`);
    assert.ok(warnings.some((w) => new RegExp(`pipeline\\.${knob}`).test(w) && /4\.5/.test(w) && /4/.test(w)),
      `${knob}: the floor must be reported — ${warnings.join('; ')}`);
  }
});

test('a fraction below one is a MALFORMED knob, not a cap of zero', () => {
  // The plan asked for `0.5` to floor to 0 so the capacity fixpoint branch
  // fires. It must not: `front.cjs`'s `capMax` reserves `max === 0` for exactly
  // one fact — "no policy could be read" — and `formatFront` words its line off
  // that ("the project config does not parse"). A file that PARSES and says 0.5
  // would then be reported as unparseable, which is a new lie in place of the old
  // one. The defect `0.5` actually carried was the FRACTIONAL `free` (0.5 is
  // truthy, so `free === 0` never fired while nothing could be dispatched); the
  // floor plus this fallback removes fractions from the board entirely, so the
  // branch's premise holds for every cap that can now exist.
  for (const knob of NUMERIC_KNOBS) {
    const { config, warnings } = withConfig({ [knob]: 0.5 });
    assert.strictEqual(config[knob], DEFAULTS[knob], `${knob}: 0.5 → ${config[knob]}`);
    assert.ok(warnings.some((w) => new RegExp(`pipeline\\.${knob} must be a positive number`).test(w)),
      `${knob}: ${warnings.join('; ')}`);
  }
});

test('a numeric STRING still resolves — the type check must not widen past booleans', () => {
  // A hand-edited config.json acquires string values, and every other coercion in
  // this file tolerates them. A type check that rejected them would break real
  // configs to close a hole booleans opened.
  for (const knob of NUMERIC_KNOBS) {
    const { config, warnings } = withConfig({ [knob]: '4' });
    assert.strictEqual(config[knob], 4, `${knob}: "4" → ${config[knob]}`);
    assert.deepStrictEqual(warnings, [], `${knob}: "4" is a value, not a mistake — ${warnings.join('; ')}`);
  }
});

test('the cap is DECLARED in capability.json, so GSD tooling can set it', () => {
  // `pipeline.*` is not a valid GSD config key, so a knob that exists only there
  // cannot be set with `/gsd-config --set`. Declaring it under the capability's
  // own namespace is what makes it settable — and `delivery_pipeline.*` wins
  // over `pipeline.*`, so the declared spelling is also the authoritative one.
  const cap = JSON.parse(fs.readFileSync(
    path.join(__dirname, '..', '..', 'capabilities', 'delivery-pipeline', 'capability.json'), 'utf8'
  ));
  const declared = (cap.config || {})['delivery_pipeline.max_concurrent_agents'];
  assert.ok(declared, 'capability.json must declare delivery_pipeline.max_concurrent_agents');
  assert.strictEqual(declared.type, 'number');
  assert.strictEqual(declared.default, DEFAULTS.max_concurrent_agents);
});

test('the declared namespace wins for the cap, as it does for every other knob', () => {
  const { config } = withRaw({ pipeline: { max_concurrent_agents: 9 }, delivery_pipeline: { max_concurrent_agents: 3 } });
  assert.strictEqual(config.max_concurrent_agents, 3);
});

test('the native GSD synchronization key is understood by the runtime config reader', () => {
  const { config, warnings } = withRaw({ delivery_pipeline: { gsd_sync: false } });
  assert.strictEqual(config.gsd_sync, false);
  assert.ok(!warnings.some((warning) => /gsd_sync/.test(warning)), warnings.join('; '));
});

test('legacy pipeline.gsd_sync is honored with one deprecation warning', () => {
  const { config, warnings } = withRaw({ pipeline: { gsd_sync: false } });
  assert.strictEqual(config.gsd_sync, false);
  assert.deepStrictEqual(warnings, [
    'pipeline.gsd_sync is deprecated — rename it to delivery_pipeline.gsd_sync',
  ]);
});

test('delivery_pipeline.gsd_sync takes precedence over the deprecated alias', () => {
  const { config, warnings } = withRaw({
    pipeline: { gsd_sync: false },
    delivery_pipeline: { gsd_sync: true },
  });
  assert.strictEqual(config.gsd_sync, true);
  assert.deepStrictEqual(warnings, [
    'pipeline.gsd_sync is deprecated — rename it to delivery_pipeline.gsd_sync',
  ]);
});

// ── absent is not the same fact as unparseable (ADR-004 D2, audit F03) ──────
// A truncated config that CONTAINED `auto_merge: off` used to resolve to the
// default `epic` with nothing but a warning, and the sentinel merged under it.
// `config` still carries the defaults (a board has to render) but `valid` is the
// field every writer checks, and it is the ONLY thing that separates "nobody has
// configured this yet" from "what this project decided is unknown".
function withRawText(text) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-cfg-'));
  fs.mkdirSync(path.join(dir, '.planning'), { recursive: true });
  if (text !== undefined) fs.writeFileSync(path.join(dir, '.planning', 'config.json'), text);
  return { dir, ...loadConfig(dir) };
}

test('malformed JSON degrades to defaults with a warning, never throws', () => {
  const { config, warnings } = withRawText('{broken');
  assert.strictEqual(config.model_policy, 'balanced');
  assert.ok(warnings.some((w) => /not valid JSON/.test(w)));
});

test('an ABSENT config is valid — the defaults are the right answer there', () => {
  const { valid, error, warnings } = withRawText(undefined);
  assert.strictEqual(valid, true);
  assert.strictEqual(error, null);
  assert.deepStrictEqual(warnings, []);
});

test('a config that parses to an object is valid', () => {
  const { valid, error } = withRawText('{"pipeline":{"auto_merge":"off"}}');
  assert.strictEqual(valid, true);
  assert.strictEqual(error, null);
});

test('the truncated config that started this: valid:false, and it names the file', () => {
  // The audit's own fixture. It SAID auto_merge: off; the reader cannot know
  // that, which is exactly why nothing may act on the defaults it returns.
  const { config, valid, error, warnings } = withRawText('{"pipeline": {"auto_merge": "off"');
  assert.strictEqual(valid, false, 'a file that exists and does not parse is not valid');
  assert.ok(error, 'and the reason travels with the verdict');
  assert.strictEqual(error.relative, path.join('.planning', 'config.json'));
  assert.ok(path.isAbsolute(error.file), 'the absolute path is the datum — callers run from worktrees');
  assert.ok(/not valid JSON/.test(error.message), error.message);
  assert.strictEqual(config.auto_merge, 'epic', 'readers still get the defaults');
  assert.ok(warnings.some((w) => /INVALID/.test(w) && /no policy is in effect/.test(w)),
    `the warning must not also say "using defaults": ${warnings.join('; ')}`);
});

test('the resolve CLI carries the same verdict — it is loadConfig\'s shell face', () => {
  const { dir } = withRawText('{"pipeline": {"auto_merge": "off"');
  const out = spawnSync(process.execPath, [mod, 'resolve'], { cwd: dir, encoding: 'utf8' });
  assert.strictEqual(out.status, 0, out.stderr);
  const j = JSON.parse(out.stdout);
  assert.strictEqual(j.valid, false, 'a shell reader must be able to see it, not only a require()');
  assert.ok(/not valid JSON/.test(j.error.message), out.stdout);
  assert.strictEqual(j.config.auto_merge, 'epic', 'the defaults are still shown — and now labelled');

  const good = spawnSync(process.execPath, [mod, 'resolve'], { cwd: withRawText(undefined).dir, encoding: 'utf8' });
  const gj = JSON.parse(good.stdout);
  assert.strictEqual(gj.valid, true);
  assert.strictEqual(gj.error, null);
});

test('a config that parses but is not an OBJECT is invalid, never a crash', () => {
  // `JSON.parse('null')` returns null and the next line read `raw.pipeline` off
  // it — a TypeError that took state-sync and the sentinel down with a stack
  // trace instead of a refusal.
  for (const [text, what] of [['null', 'null'], ['[]', 'an array'], ['"x"', 'string'], ['', null]]) {
    const { valid, error, config } = withRawText(text);
    assert.strictEqual(valid, false, `${JSON.stringify(text)} must be invalid`);
    assert.strictEqual(config.model_policy, 'balanced', 'and still readable');
    if (what) assert.ok(error.message.includes(what), `${JSON.stringify(text)} → ${error.message}`);
  }
});

test('jira defaults are present and unknown jira keys warn', () => {
  const { config, warnings } = withConfig({ jira: { project: 'MYD', nonsense: 1 } });
  assert.strictEqual(config.jira.project, 'MYD');
  assert.strictEqual(config.jira.issue_type, 'Task');
  assert.ok(warnings.some((w) => /pipeline\.jira key "nonsense"/.test(w)));
});

suite('GSD profile names are accepted as aliases');

test("GSD's budget/quality map onto economy/premium without a warning", () => {
  const budget = withConfig({ model_policy: 'budget' });
  assert.strictEqual(budget.config.model_policy, 'economy');
  assert.deepStrictEqual(budget.warnings, []);
  const quality = withConfig({ model_policy: 'quality' });
  assert.strictEqual(quality.config.model_policy, 'premium');
  assert.deepStrictEqual(quality.warnings, []);
});

test('a genuinely unknown profile still warns', () => {
  const { warnings } = withConfig({ model_policy: 'turbo' });
  assert.ok(warnings.some((w) => /model_policy/.test(w)));
});

suite('delivery_pipeline.* (GSD-native) outranks pipeline.*');

test('the capability-declared namespace wins on a conflicting key', () => {
  const { config } = withRaw({
    pipeline: { max_attempts: 2, integration_mode: 'direct-to-main' },
    delivery_pipeline: { max_attempts: 9 },
  });
  assert.strictEqual(config.max_attempts, 9);
  // keys only present in pipeline.* are still honoured
  assert.strictEqual(config.integration_mode, 'direct-to-main');
});

suite("GSD's own settings the conveyor must obey");

test('the active runtime context overrides a legacy project runtime without rewriting it', () => {
  const { dir, config, warnings } = withRawOptions(
    { runtime: 'claude', agent_skills: { 'gsd-planner': ['global:shipyard-delivery-rules'] } },
    { env: { SHIPYARD_RUNTIME: 'codex' } },
  );
  assert.equal(config.gsd.runtime, 'codex');
  assert.equal(config.gsd.runtime_source, 'shipyard-env');
  assert.equal(config.gsd.persisted_runtime, 'claude');
  assert.ok(warnings.some((warning) => /legacy persisted value/.test(warning)), warnings.join('; '));
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, '.planning', 'config.json'), 'utf8')).runtime, 'claude');
  assert.ok(!warnings.some((warning) => /only on the claude/.test(warning)), warnings.join('; '));
});

test('a Codex runtime can use the shared checkout with no runtime key', () => {
  const { config, warnings } = withRawOptions(
    { agent_skills: { 'gsd-planner': ['global:shipyard-delivery-rules'] } },
    { env: { GSD_RUNTIME: 'codex' } },
  );
  assert.equal(config.gsd.runtime, 'codex');
  assert.equal(config.gsd.runtime_source, 'gsd-env');
  assert.deepEqual(warnings, []);
});

test('the runtime-neutral project skill projection is accepted on both runtimes', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-cfg-projection-'));
  fs.mkdirSync(path.join(dir, '.planning'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, '.planning', 'config.json'),
    JSON.stringify({ agent_skills: { 'gsd-planner': ['.shipyard/generated/gsd-delivery-rules'] } }, null, 2),
  );
  fs.mkdirSync(path.join(dir, '.shipyard', 'generated', 'gsd-delivery-rules'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.shipyard', 'generated', 'gsd-delivery-rules', 'SKILL.md'), '# generated\n');
  for (const runtime of ['claude', 'codex']) {
    const { config, warnings } = loadConfig(dir, { runtime });
    assert.equal(config.gsd.runtime, runtime);
    assert.deepEqual(warnings, [], runtime);
  }
});

test('a missing project skill projection is a named warning, not a silent skip', () => {
  const { warnings } = withRawOptions(
    { agent_skills: { 'gsd-planner': ['.shipyard/generated/gsd-delivery-rules'] } },
    { runtime: 'codex' },
  );
  assert.ok(warnings.some((warning) => /SKILL\.md is missing/.test(warning)), warnings.join('; '));
});

test('git.base_branch is read and exposed', () => {
  const { config } = withRaw({ git: { base_branch: 'develop' } });
  assert.strictEqual(config.gsd.base_branch, 'develop');
});

test('git.branching_strategy "none" is fine; phase/milestone warn about the collision', () => {
  assert.deepStrictEqual(withRaw({ git: { branching_strategy: 'none' } }).warnings, []);
  for (const strategy of ['phase', 'milestone']) {
    const { warnings } = withRaw({ git: { branching_strategy: strategy } });
    assert.ok(warnings.some((w) => /owns branching/.test(w)), `${strategy} did not warn`);
  }
});

test('a pipeline.repos checkout nested in the project warns, unless sub_repos claims it', () => {
  // The project root has to be a real directory for the nesting test to mean
  // anything, so build the config in place rather than through withRaw.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-cfg-'));
  fs.mkdirSync(path.join(dir, '.planning'), { recursive: true });
  const write = (raw) => {
    fs.writeFileSync(path.join(dir, '.planning', 'config.json'), JSON.stringify(raw, null, 2));
    return loadConfig(dir);
  };
  const nestedPath = path.join(dir, 'vendor', 'webapp');

  const nested = write({ pipeline: { repos: { 'acme/webapp': nestedPath } } });
  assert.ok(nested.warnings.some((w) => /nested inside this project/.test(w)), nested.warnings.join('; '));
  // still usable — this is advice, not a rejection
  assert.strictEqual(nested.config.repos['acme/webapp'], nestedPath);

  // GSD's own escape hatch silences it: sub_repos is honoured before the
  // git-boundary guard, so the crossing becomes deliberate.
  const claimed = write({ sub_repos: ['vendor'], pipeline: { repos: { 'acme/webapp': nestedPath } } });
  assert.deepStrictEqual(claimed.warnings, []);

  // the ordinary layout — a checkout OUTSIDE the project — must stay silent
  const outside = write({ pipeline: { repos: { 'acme/webapp': path.join(os.tmpdir(), 'elsewhere-webapp') } } });
  assert.deepStrictEqual(outside.warnings, []);
});

test('workflow.use_worktrees is READ but never warned about, at any value', () => {
  // It used to warn on `true`, on the belief that /gsd-code-review --fix would
  // fork a nested worktree inside the ticket's. Checked against GSD 1.9.1's
  // source: code-review never mentions worktrees, and `git worktree add` appears
  // only in execute-phase, new-workspace and worktree-safety.cjs — none of which
  // the conveyor invokes. `true` is also GSD's own default, so warning on it
  // fired for most projects and trained the user to ignore warnings.
  for (const value of [true, false]) {
    const r = withRaw({ workflow: { use_worktrees: value } });
    assert.strictEqual(r.config.gsd.use_worktrees, value, 'still read, for callers that care');
    assert.deepStrictEqual(r.warnings, [], `use_worktrees: ${value} must not warn`);
  }
  assert.deepStrictEqual(withRaw({}).warnings, []);
  assert.strictEqual(withRaw({}).config.gsd.use_worktrees, null);
});

test('a plugin-namespaced agent_skills entry warns on a non-claude runtime', () => {
  const codex = withRaw({ runtime: 'codex', agent_skills: { 'gsd-planner': ['global:shipyard:delivery-rules'] } });
  assert.ok(codex.warnings.some((w) => /only on the claude/i.test(w)), codex.warnings.join('; '));
  // the bare global form is what works there, and must NOT warn
  const bare = withRaw({ runtime: 'codex', agent_skills: { 'gsd-planner': ['global:shipyard-delivery-rules'] } });
  assert.deepStrictEqual(bare.warnings, []);
  // ...and on claude the namespaced form is correct
  const claude = withRaw({ runtime: 'claude', agent_skills: { 'gsd-planner': ['global:shipyard:delivery-rules'] } });
  assert.deepStrictEqual(claude.warnings, []);
});

test('response_language is surfaced (it governs conversation, not artifacts)', () => {
  const { config } = withRaw({ response_language: 'uk' });
  assert.strictEqual(config.gsd.response_language, 'uk');
});

test('an invalid effort value is rejected with a warning, not honoured', () => {
  const { config, warnings } = withConfig({ effort: { executor: 'ludicrous' } });
  assert.strictEqual(config.effort.executor, undefined);
  assert.ok(warnings.some((w) => /effort/.test(w)));
});

suite('codex_models — the palette a static agent file is written from');

test('no config → the shipped palette, floor first and ceiling last', () => {
  const { config, warnings } = withConfig(undefined);
  assert.deepStrictEqual(config.codex_models, DEFAULT_CODEX_MODELS);
  assert.deepStrictEqual(config.codex_models.map(({ model }) => model), ['gpt-6.1-sol', 'gpt-6.1-sol']);
  assert.deepStrictEqual(warnings, []);
  // The order IS the policy: first entry is the workhorse every role gets, last
  // is the ceiling only the integrator and the `-deep` agents reach.
  assert.ok(config.codex_models.length >= 2, 'the shipped palette has a ceiling to escalate to');
});

test('the palette a caller mutates does not become the next caller\'s default', () => {
  const first = withConfig(undefined).config;
  first.codex_models.length = 0;
  assert.deepStrictEqual(withConfig(undefined).config.codex_models, DEFAULT_CODEX_MODELS);
});

test('the string form (the one GSD can set) parses to the same list', () => {
  const { config, warnings } = withConfig({ codex_models: 'a:high, b:low@1.2.3' });
  assert.deepStrictEqual(config.codex_models, [
    { model: 'a', effort: 'high' },
    { model: 'b', effort: 'low', min_cli: '1.2.3' },
  ]);
  assert.deepStrictEqual(warnings, []);
});

test('an entry with no usable model id is skipped, never half-honoured', () => {
  const { config, warnings } = withConfig({ codex_models: [{ effort: 'high' }, { model: 42 }, { model: ' keep ' }] });
  assert.deepStrictEqual(config.codex_models, [{ model: 'keep' }]);
  assert.strictEqual(warnings.filter((w) => /codex_models/.test(w)).length, 2, warnings.join('; '));
});

test('a bad effort or min_cli is dropped with a warning, the model survives', () => {
  const { config, warnings } = withConfig({ codex_models: [{ model: 'm', effort: 'ultra', min_cli: 'soon' }] });
  assert.deepStrictEqual(config.codex_models, [{ model: 'm' }]);
  assert.ok(warnings.some((w) => /ultra/.test(w)), warnings.join('; '));
  assert.ok(warnings.some((w) => /min_cli/.test(w)), warnings.join('; '));
});

test('`ultra` is not in the effort vocabulary — no path selects a model that advertises it', () => {
  assert.ok(!EFFORTS.includes('ultra'));
});

test('an explicitly EMPTY palette is honoured: "write no model" is a choice', () => {
  const { config, warnings } = withConfig({ codex_models: [] });
  assert.deepStrictEqual(config.codex_models, []);
  assert.deepStrictEqual(warnings, []);
});

test('a palette that is not a list at all keeps the shipped one, with a warning', () => {
  const { config, warnings } = withConfig({ codex_models: 7 });
  assert.deepStrictEqual(config.codex_models, DEFAULT_CODEX_MODELS);
  assert.ok(warnings.some((w) => /codex_models/.test(w)), warnings.join('; '));
});

test('an unknown entry field is dropped rather than carried into the agent file', () => {
  const { config, warnings } = withConfig({ codex_models: [{ model: 'm', reasoning: 'deep' }] });
  assert.deepStrictEqual(config.codex_models, [{ model: 'm' }]);
  assert.ok(warnings.some((w) => /reasoning/.test(w)), warnings.join('; '));
});

suite('jira_transitions — the status map, whose empty default means OFF');

test('no config → an empty map and NO warning: the projection is off', () => {
  const { config, warnings } = withConfig(undefined);
  assert.deepStrictEqual(config.jira_transitions, {});
  assert.deepStrictEqual(warnings, []);
});

test('the capability default "" is silent — a warning on every load teaches the reader to skip warnings', () => {
  // `''.split(',')` is `['']`, so an empty segment must be SKIPPED SILENTLY.
  // This is the one place the map deliberately differs from `codex_models`:
  // the declared default of this knob IS the empty string, so a project that
  // GSD has materialised its defaults into would otherwise warn every load.
  const { config, warnings } = withConfig({ jira_transitions: '' });
  assert.deepStrictEqual(config.jira_transitions, {});
  assert.deepStrictEqual(warnings, []);
  // and a trailing comma is the same case
  const trailing = withConfig({ jira_transitions: 'merged:Done,' });
  assert.deepStrictEqual(trailing.config.jira_transitions, { merged: 'Done' });
  assert.deepStrictEqual(trailing.warnings, []);
});

test('the string form (the one GSD can set) parses to two entries', () => {
  const { config, warnings } = withConfig({ jira_transitions: 'pr-open:In Progress, merged:Done' });
  assert.deepStrictEqual(config.jira_transitions, { 'pr-open': 'In Progress', merged: 'Done' });
  assert.deepStrictEqual(warnings, []);
});

test('the object form (a hand-edited config) yields the same map', () => {
  const { config, warnings } = withConfig({ jira_transitions: { 'pr-open': 'In Progress', merged: 'Done' } });
  assert.deepStrictEqual(config.jira_transitions, { 'pr-open': 'In Progress', merged: 'Done' });
  assert.deepStrictEqual(warnings, []);
});

test('a FRONT BUCKET name on the left is one warning naming the four real statuses, and no entry', () => {
  // `fix`, `finalize`, `merge` and `ci` are computed by front.cjs per round and
  // never appear in the `status_change` stream this map is consumed against, so
  // they are the tempting wrong values — the warning has to name the right ones.
  const { config, warnings } = withConfig({ jira_transitions: 'fix:In Progress' });
  assert.deepStrictEqual(config.jira_transitions, {});
  const own = warnings.filter((w) => /jira_transitions/.test(w));
  assert.strictEqual(own.length, 1, warnings.join('; '));
  for (const status of ['pending', 'branched', 'pr-open', 'merged']) {
    assert.ok(own[0].includes(status), `warning must name "${status}": ${own[0]}`);
  }
  assert.ok(own[0].includes('fix'), own[0]);
});

test('the four statuses are the ones state-sync writes, in our own order', () => {
  assert.deepStrictEqual(TICKET_STATUSES, ['pending', 'branched', 'pr-open', 'merged']);
});

test('an empty target status is skipped with a warning — half a mapping is not a mapping', () => {
  const { config, warnings } = withConfig({ jira_transitions: 'merged:   , pr-open:In Progress' });
  assert.deepStrictEqual(config.jira_transitions, { 'pr-open': 'In Progress' });
  assert.strictEqual(warnings.filter((w) => /jira_transitions/.test(w)).length, 1, warnings.join('; '));
});

test('an entry with no colon at all is skipped with a warning', () => {
  const { config, warnings } = withConfig({ jira_transitions: 'merged' });
  assert.deepStrictEqual(config.jira_transitions, {});
  assert.ok(warnings.some((w) => /jira_transitions/.test(w)), warnings.join('; '));
});

test('only the FIRST colon splits — a target status may carry one of its own', () => {
  const { config, warnings } = withConfig({ jira_transitions: 'merged:Done: verified' });
  assert.deepStrictEqual(config.jira_transitions, { merged: 'Done: verified' });
  assert.deepStrictEqual(warnings, []);
});

test('a value that is not a map at all keeps the empty map: the projection stays OFF', () => {
  const { config, warnings } = withConfig({ jira_transitions: 7 });
  assert.deepStrictEqual(config.jira_transitions, {});
  assert.ok(warnings.some((w) => /jira_transitions/.test(w)), warnings.join('; '));
});

test('the map a caller mutates does not become the next caller\'s default', () => {
  // Copied from the `codex_models` case above, which exists: every value
  // value is copied rather than shared with DEFAULTS, or a caller that edits
  // the returned map in place changes what the next loadConfig() returns.
  const first = withConfig(undefined).config;
  first.jira_transitions.merged = 'Done';
  assert.deepStrictEqual(withConfig(undefined).config.jira_transitions, {});
  assert.deepStrictEqual(DEFAULTS.jira_transitions, {});
});

test('it is FLAT, so it survives beside a `jira` object set in the other namespace', () => {
  // The whole argument for a top-level key: `delivery_pipeline` is merged over
  // `pipeline` SHALLOWLY, so an object-valued `jira` in one namespace replaces
  // the other's wholesale. A nested `jira.transitions` would vanish here.
  const { config } = withRaw({
    pipeline: { jira: { project: 'SHIP' } },
    delivery_pipeline: { jira_transitions: 'merged:Done' },
  });
  assert.strictEqual(config.jira.project, 'SHIP');
  assert.deepStrictEqual(config.jira_transitions, { merged: 'Done' });
});

test('the map is DECLARED in capability.json, so GSD tooling can set it', () => {
  const cap = JSON.parse(fs.readFileSync(
    path.join(__dirname, '..', '..', 'capabilities', 'delivery-pipeline', 'capability.json'), 'utf8'
  ));
  const declared = (cap.config || {})['delivery_pipeline.jira_transitions'];
  assert.ok(declared, 'capability.json must declare delivery_pipeline.jira_transitions');
  assert.strictEqual(declared.type, 'string');
  assert.strictEqual(declared.default, '');
  // the declared default must parse to the default the reader ships
  assert.deepStrictEqual(withConfig({ jira_transitions: declared.default }).config.jira_transitions,
    DEFAULTS.jira_transitions);
});

suite('jira_todo_statuses — explicit tracker-name eligibility, empty means OFF');

test('no config or the declared empty default keeps eligibility disabled without warnings', () => {
  assert.deepStrictEqual(withConfig(undefined).config.jira_todo_statuses, []);
  assert.deepStrictEqual(withConfig(undefined).warnings, []);
  const declared = withConfig({ jira_todo_statuses: '' });
  assert.deepStrictEqual(declared.config.jira_todo_statuses, []);
  assert.deepStrictEqual(declared.warnings, []);
});

test('the string form trims names, removes blanks and duplicates, and preserves order and spelling', () => {
  const { config, warnings } = withConfig({
    jira_todo_statuses: ' To Do, Backlog, ,To Do, Selected for Development, Backlog ',
  });
  assert.deepStrictEqual(config.jira_todo_statuses, ['To Do', 'Backlog', 'Selected for Development']);
  assert.deepStrictEqual(warnings, []);
});

test('non-string values are rejected with a warning and cannot enable the gate', () => {
  for (const value of [7, null, {}, [], true]) {
    const { config, warnings } = withConfig({ jira_todo_statuses: value });
    assert.deepStrictEqual(config.jira_todo_statuses, [], JSON.stringify(value));
    assert.ok(
      warnings.some((warning) => /jira_todo_statuses.*comma-separated string/.test(warning)),
      `${JSON.stringify(value)}: ${warnings.join('; ')}`
    );
  }
});

test('the capability declaration matches the reader and uses an empty string default', () => {
  const cap = JSON.parse(fs.readFileSync(
    path.join(__dirname, '..', '..', 'capabilities', 'delivery-pipeline', 'capability.json'), 'utf8'
  ));
  const declared = (cap.config || {})['delivery_pipeline.jira_todo_statuses'];
  assert.ok(declared, 'capability.json must declare delivery_pipeline.jira_todo_statuses');
  assert.strictEqual(declared.type, 'string');
  assert.strictEqual(declared.default, '');
  assert.deepStrictEqual(withConfig({ jira_todo_statuses: declared.default }).config.jira_todo_statuses,
    DEFAULTS.jira_todo_statuses);
});

test('delivery_pipeline.jira_todo_statuses wins over the legacy namespace', () => {
  const { config, warnings } = withRaw({
    pipeline: { jira_todo_statuses: 'Legacy To Do' },
    delivery_pipeline: { jira_todo_statuses: 'To Do, Backlog' },
  });
  assert.deepStrictEqual(config.jira_todo_statuses, ['To Do', 'Backlog']);
  assert.deepStrictEqual(warnings, []);
});

test('a malformed preferred namespace value disables the gate instead of falling back to legacy', () => {
  const { config, warnings } = withRaw({
    pipeline: { jira_todo_statuses: 'Legacy To Do' },
    delivery_pipeline: { jira_todo_statuses: { status: 'To Do' } },
  });
  assert.deepStrictEqual(config.jira_todo_statuses, []);
  assert.ok(warnings.some((warning) => /jira_todo_statuses/.test(warning)), warnings.join('; '));
});

test('the returned status list is not shared with the disabled default', () => {
  const first = withConfig({ jira_todo_statuses: 'To Do' }).config;
  first.jira_todo_statuses.push('Backlog');
  assert.deepStrictEqual(withConfig(undefined).config.jira_todo_statuses, []);
  assert.deepStrictEqual(DEFAULTS.jira_todo_statuses, []);
});

suite('pr_title_format — the target repository\'s own PR title convention (D-45)');

test('unset → null, and no unknown-key warning', () => {
  const { config, warnings } = withConfig(undefined);
  assert.strictEqual(config.pr_title_format, null);
  assert.ok(!warnings.some((w) => /pr_title_format/.test(w)), warnings.join('; '));
});

test('a single template string is accepted as-is', () => {
  const { config, warnings } = withConfig({ pr_title_format: '[{jira}] {type}: {subject}' });
  assert.strictEqual(config.pr_title_format, '[{jira}] {type}: {subject}');
  assert.ok(!warnings.some((w) => /pr_title_format/.test(w)), warnings.join('; '));
});

test('a map keyed by owner/repo and "default" is accepted as-is', () => {
  const map = {
    'pdffiller/pdffiller': '[{jira}] {type}: {subject}',
    default: '{type}{[({scope})]}: {[[{jira}] ]}{subject}',
  };
  const { config, warnings } = withConfig({ pr_title_format: map });
  assert.deepStrictEqual(config.pr_title_format, map);
  assert.ok(!warnings.some((w) => /pr_title_format/.test(w)), warnings.join('; '));
});

test('a non-string map value warns, names the key, and is ignored — the rest of the map survives', () => {
  const { config, warnings } = withConfig({
    pr_title_format: { 'pdffiller/pdffiller': '[{jira}] {type}: {subject}', 'acme/widgets': 7 },
  });
  assert.deepStrictEqual(config.pr_title_format, { 'pdffiller/pdffiller': '[{jira}] {type}: {subject}' });
  assert.ok(warnings.some((w) => /pr_title_format.*"acme\/widgets"/.test(w)), warnings.join('; '));
});

test('a map key that is neither "default" nor an owner/name slug warns and is ignored', () => {
  const { config, warnings } = withConfig({ pr_title_format: { bogus: '{type}: {subject}' } });
  assert.deepStrictEqual(config.pr_title_format, {});
  assert.ok(warnings.some((w) => /pr_title_format\."bogus"/.test(w)), warnings.join('; '));
});

test('a wholly malformed shape warns, names the key, and falls back to null', () => {
  const { config, warnings } = withConfig({ pr_title_format: 42 });
  assert.strictEqual(config.pr_title_format, null);
  assert.ok(warnings.some((w) => /pr_title_format/.test(w)), warnings.join('; '));
});

test('delivery_pipeline.pr_title_format wins over the legacy namespace', () => {
  const { config, warnings } = withRaw({
    pipeline: { pr_title_format: 'legacy: {subject}' },
    delivery_pipeline: { pr_title_format: '{type}: {subject}' },
  });
  assert.strictEqual(config.pr_title_format, '{type}: {subject}');
  assert.deepStrictEqual(warnings, []);
});

suite('per-repository config maps (ADR-020 D-01, D-05, D-07, D-09)');

test('the four keys default to null in an empty configuration', () => {
  for (const key of ['comment_markers', 'reviewer_bots', 'repo_remedies', 'verification_commands']) {
    assert.strictEqual(withConfig({}).config[key], null, `${key} should default to unset`);
  }
});

test('all four keys are registered and accept their declared shapes without unknown-key warnings', () => {
  const { config, warnings } = withConfig({
    comment_markers: { 'acme/widgets': ['P1', '<!--shipyard-->'], default: ['shipyard-ok', '@=-_.:'] },
    reviewer_bots: { 'acme/widgets': ['coderabbitai[bot]', 'copilot-*'] },
    repo_remedies: {
      'acme/widgets': [{ signature: 'ci:failed', workflow: 'repair-ci.yml', inputs: { issue: '123' }, ref: 'main' }],
    },
    verification_commands: {
      'acme/widgets': [{ argv: ['npm', 'test'] }, { argv: ['./verify'], profile: 'host', timeout_s: 30 }],
    },
  });
  assert.deepStrictEqual(warnings, []);
  assert.deepStrictEqual(config.comment_markers, {
    'acme/widgets': ['P1', '<!--shipyard-->'], default: ['shipyard-ok', '@=-_.:'],
  });
  assert.deepStrictEqual(config.reviewer_bots, { 'acme/widgets': ['coderabbitai[bot]', 'copilot-*'] });
  assert.deepStrictEqual(config.repo_remedies, {
    'acme/widgets': [{ signature: 'ci:failed', workflow: 'repair-ci.yml', bot: 'github-actions[bot]',
      inputs: { issue: '123' }, ref: 'main' }],
  });
  assert.deepStrictEqual(config.verification_commands, {
    'acme/widgets': [
      { argv: ['npm', 'test'], profile: 'sandbox' },
      { argv: ['./verify'], profile: 'host', timeout_s: 30 },
    ],
  });
});

test('a non-map shape warns by key and falls back to null for each setting', () => {
  for (const key of ['comment_markers', 'reviewer_bots', 'repo_remedies', 'verification_commands']) {
    const { config, warnings } = withConfig({ [key]: 7 });
    assert.strictEqual(config[key], null, key);
    assert.ok(warnings.some((warning) => new RegExp(`pipeline\\.${key}`).test(warning)),
      `${key}: ${warnings.join('; ')}`);
  }
});

test('comment marker maps drop bad keys, arrays, and tokens with named warnings', () => {
  const { config, warnings } = withConfig({
    comment_markers: {
      'bad/repo/extra': ['P1'],
      'acme/widgets': ['P1', 'two words', 'P[2]', `${'x'.repeat(65)}`],
      default: 'shipyard-ok',
    },
  });
  assert.deepStrictEqual(config.comment_markers, { 'acme/widgets': ['P1'] });
  assert.ok(warnings.some((warning) => /comment_markers.*bad\/repo\/extra/.test(warning)), warnings.join('; '));
  assert.ok(warnings.some((warning) => /comment_markers.*two words/.test(warning)), warnings.join('; '));
  assert.ok(warnings.some((warning) => /comment_markers.*P\[2\]/.test(warning)), warnings.join('; '));
  assert.ok(warnings.some((warning) => warning.includes('x'.repeat(65))), warnings.join('; '));
  assert.ok(warnings.some((warning) => /comment_markers.*default/.test(warning)), warnings.join('; '));
});

test('reviewer bot maps accept exact logins and one trailing prefix star, dropping invalid values', () => {
  const { config, warnings } = withConfig({
    reviewer_bots: {
      'acme/widgets': ['coderabbitai[bot]', 'copilot-*', 'bot*name', 'bot**', 'two words', ''],
      default: 'github-actions[bot]',
    },
  });
  assert.deepStrictEqual(config.reviewer_bots, { 'acme/widgets': ['coderabbitai[bot]', 'copilot-*'] });
  assert.ok(warnings.filter((warning) => /reviewer_bots/.test(warning)).length >= 4, warnings.join('; '));
  assert.ok(warnings.some((warning) => /reviewer_bots.*default/.test(warning)), warnings.join('; '));
});

test('repository remedies drop invalid slugs and entries with a warning naming the key', () => {
  const { config, warnings } = withConfig({
    repo_remedies: {
      default: [{ signature: 'x', workflow: 'repair.yml' }],
      'other/repo': 'not-an-array',
      'acme/widgets': [
        { signature: 'ci:failed', workflow: 'repair-ci.yml', inputs: { issue: '123' } },
        { signature: '', workflow: 'repair.yml' },
        { signature: 'ci:failed', workflow: '../repair.yml' },
        { signature: 'ci:failed', workflow: 'repair.yml', inputs: { issue: 123 } },
        { signature: 'ci:failed', workflow: 'repair.yml', ref: 4 },
      ],
    },
  });
  assert.deepStrictEqual(config.repo_remedies, {
    'acme/widgets': [{ signature: 'ci:failed', workflow: 'repair-ci.yml', bot: 'github-actions[bot]',
      inputs: { issue: '123' } }],
  });
  assert.ok(warnings.some((warning) => /repo_remedies.*default/.test(warning)), warnings.join('; '));
  assert.ok(warnings.some((warning) => /repo_remedies.*other\/repo/.test(warning)), warnings.join('; '));
  assert.ok(warnings.filter((warning) => /repo_remedies.*acme\/widgets/.test(warning)).length >= 4,
    warnings.join('; '));
});

test('repository remedies use exact bot logins and require an explicit repository', () => {
  const { config, warnings } = withConfig({ repo_remedies: {
    default: [{ signature: 'fallback', workflow: 'fallback.yml' }],
    'acme/widgets': [
      { signature: 'explicit', workflow: 'repair.yml', bot: 'repair-bot[bot]' },
      { signature: 'bad', workflow: 'repair.yml', bot: 'repair-*' },
      { signature: 'bad', workflow: 'repair.yml', bot: 'two words' },
    ],
  } });
  assert.strictEqual(repoValue(config, 'repo_remedies', 'acme/widgets')[0].bot, 'repair-bot[bot]');
  assert.strictEqual(repoValue(config, 'repo_remedies', 'other/repo'), null);
  assert.strictEqual(repoValue({ repo_remedies: { default: [{ signature: 'x', workflow: 'fallback.yml' }] } },
    'repo_remedies', 'other/repo'), null);
  assert.strictEqual(config.repo_remedies['acme/widgets'].length, 1);
  assert.ok(warnings.some((warning) => /repo_remedies.*default/.test(warning)), warnings.join('; '));
  assert.ok(warnings.filter((warning) => /repo_remedies.*bot/.test(warning)).length >= 2, warnings.join('; '));
});

test('verification command maps validate argv arrays, profile, and timeout', () => {
  const { config, warnings } = withConfig({
    verification_commands: {
      'acme/widgets': [
        { argv: ['npm', 'test'] },
        { argv: 'npm test' },
        { argv: [] },
        { argv: ['verify'], timeout_s: 1 },
        { argv: ['verify'], timeout_s: 3600 },
        { argv: ['npm'], profile: 'bare' },
        { argv: ['npm'], timeout_s: 3601 },
        { argv: ['npm'], timeout_s: 1.5 },
      ],
      bogus: [{ argv: ['npm'] }],
      'other/repo': 'npm test',
    },
  });
  assert.deepStrictEqual(config.verification_commands, {
    'acme/widgets': [
      { argv: ['npm', 'test'], profile: 'sandbox' },
      { argv: ['verify'], profile: 'sandbox', timeout_s: 1 },
      { argv: ['verify'], profile: 'sandbox', timeout_s: 3600 },
    ],
  });
  assert.ok(warnings.some((warning) => /verification_commands.*argv/.test(warning)), warnings.join('; '));
  assert.ok(warnings.some((warning) => /verification_commands.*bogus/.test(warning)), warnings.join('; '));
  assert.ok(warnings.some((warning) => /verification_commands.*other\/repo/.test(warning)), warnings.join('; '));
  assert.ok(warnings.filter((warning) => /verification_commands.*acme\/widgets/.test(warning)).length >= 5,
    warnings.join('; '));
});

test('a repository verification command cannot use a shell string in place of argv', () => {
  const { config, warnings } = withConfig({
    verification_commands: { 'acme/widgets': [{ argv: 'npm test && echo unsafe' }] },
  });
  assert.deepStrictEqual(config.verification_commands, { 'acme/widgets': [] });
  assert.ok(warnings.some((warning) => /verification_commands.*argv/.test(warning)), warnings.join('; '));
});

test('delivery_pipeline values win over pipeline values for all four maps', () => {
  const legacy = { 'acme/widgets': ['legacy'] };
  const declared = { 'acme/widgets': ['declared'] };
  const { config, warnings } = withRaw({
    pipeline: {
      comment_markers: legacy,
      reviewer_bots: legacy,
      repo_remedies: { 'acme/widgets': [{ signature: 'old', workflow: 'old.yml' }] },
      verification_commands: { 'acme/widgets': [{ argv: ['old'] }] },
    },
    delivery_pipeline: {
      comment_markers: declared,
      reviewer_bots: declared,
      repo_remedies: { 'acme/widgets': [{ signature: 'new', workflow: 'new.yml' }] },
      verification_commands: { 'acme/widgets': [{ argv: ['new'] }] },
    },
  });
  assert.deepStrictEqual(config.comment_markers, declared);
  assert.deepStrictEqual(config.reviewer_bots, declared);
  assert.deepStrictEqual(config.repo_remedies, { 'acme/widgets': [{ signature: 'new', workflow: 'new.yml', bot: 'github-actions[bot]' }] });
  assert.deepStrictEqual(config.verification_commands, { 'acme/widgets': [{ argv: ['new'], profile: 'sandbox' }] });
  assert.deepStrictEqual(warnings, []);
});

test('repoValue picks a repository entry, then default, then null', () => {
  const cfg = { comment_markers: { 'acme/widgets': ['repo'], default: ['fallback'] } };
  assert.deepStrictEqual(repoValue(cfg, 'comment_markers', 'acme/widgets'), ['repo']);
  assert.deepStrictEqual(repoValue(cfg, 'comment_markers', 'other/repo'), ['fallback']);
  assert.strictEqual(repoValue({ reviewer_bots: {} }, 'reviewer_bots', 'acme/widgets'), null);
  assert.strictEqual(repoValue(cfg, 'not_a_key', 'acme/widgets'), null);
});

test('repoValue accepts the result returned by loadConfig', () => {
  const loaded = withRaw({ delivery_pipeline: {
    comment_markers: { 'acme/widgets': ['repo'], default: ['fallback'] },
  } });
  assert.deepStrictEqual(repoValue(loaded, 'comment_markers', 'acme/widgets'), ['repo']);
  assert.deepStrictEqual(repoValue(loaded, 'comment_markers', 'other/repo'), ['fallback']);
});

suite('repos — sibling checkouts a multi-repo phase is driven in');

test('no repos configured → an empty map, not undefined', () => {
  const { config } = withConfig(undefined);
  assert.deepStrictEqual(config.repos, {});
});

test('an owner/name slug with an absolute path is accepted', () => {
  const { config, warnings } = withConfig({ repos: { 'acme/webapp': '/srv/webapp' } });
  assert.strictEqual(config.repos['acme/webapp'], '/srv/webapp');
  assert.deepStrictEqual(warnings, []);
});

test('a relative path is rejected — the run works from many worktrees', () => {
  const { config, warnings } = withConfig({ repos: { 'acme/webapp': '../webapp' } });
  assert.strictEqual(config.repos['acme/webapp'], undefined);
  assert.ok(warnings.some((w) => /ABSOLUTE/.test(w)));
});

test('a key that is not owner/name cannot match delivery.repo, so it warns', () => {
  const { config, warnings } = withConfig({ repos: { webapp: '/srv/webapp' } });
  assert.deepStrictEqual(config.repos, {});
  assert.ok(warnings.some((w) => /owner\/name/.test(w)));
});

test('repos_root defaults to the absolute project parent', () => {
  const { dir, config, warnings } = withRawText(undefined);
  assert.strictEqual(config.repos_root, defaultRepositoryRoot(dir));
  assert.ok(path.isAbsolute(config.repos_root));
  assert.deepStrictEqual(warnings, []);
});

test('repos_root is declared in the capability so GSD tooling can set it', () => {
  const cap = JSON.parse(fs.readFileSync(
    path.join(__dirname, '..', '..', 'capabilities', 'delivery-pipeline', 'capability.json'), 'utf8'
  ));
  const declared = (cap.config || {})['delivery_pipeline.repos_root'];
  assert.ok(declared, 'capability.json must declare delivery_pipeline.repos_root');
  assert.strictEqual(declared.type, 'string');
});

test('an absolute repos_root is accepted and the declared namespace wins', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-repos-root-'));
  fs.mkdirSync(path.join(dir, '.planning'), { recursive: true });
  const root = path.join(dir, 'checkouts');
  fs.writeFileSync(path.join(dir, '.planning', 'config.json'), JSON.stringify({
    pipeline: { repos_root: '/wrong/root' },
    delivery_pipeline: { repos_root: root },
  }, null, 2));
  const { config, warnings } = loadConfig(dir);
  assert.strictEqual(config.repos_root, root);
  assert.deepStrictEqual(warnings, []);
});

test('the materialized empty repos_root default uses the project parent', () => {
  const { dir, config, warnings } = withRawOptions({ pipeline: { repos_root: '' } }, {});
  assert.strictEqual(config.repos_root, defaultRepositoryRoot(dir));
  assert.deepStrictEqual(warnings, []);
});

test('relative and malformed repos_root values are refused without creating a directory', () => {
  for (const value of ['checkouts', null, {}, true]) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-repos-root-'));
    fs.mkdirSync(path.join(dir, '.planning'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.planning', 'config.json'), JSON.stringify({ pipeline: { repos_root: value } }));
    const before = fs.readdirSync(dir).sort();
    const { config, warnings } = loadConfig(dir);
    assert.strictEqual(config.repos_root, null, JSON.stringify(value));
    assert.ok(warnings.some((warning) => /repos_root.*absolute/.test(warning)), warnings.join('; '));
    assert.deepStrictEqual(fs.readdirSync(dir).sort(), before, 'invalid policy must not create the root');
  }
});

test('an existing file is not accepted as a future repository root', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-repos-root-'));
  fs.mkdirSync(path.join(dir, '.planning'), { recursive: true });
  const file = path.join(dir, 'root-file');
  fs.writeFileSync(file, 'occupied\n');
  fs.writeFileSync(path.join(dir, '.planning', 'config.json'), JSON.stringify({ pipeline: { repos_root: file } }));

  const { config, warnings } = loadConfig(dir);
  assert.strictEqual(config.repos_root, null);
  assert.ok(warnings.some((warning) => /repos_root.*directory/.test(warning)), warnings.join('; '));
});

test('the shared destination helper gives the same nesting verdict to callers', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-repos-root-'));
  const nested = path.join(dir, 'vendor', 'service');
  const rejected = validateRepositoryDestination(nested, {
    projectRoot: dir,
    subRepos: [],
    label: 'checkout',
  });
  assert.strictEqual(rejected.valid, false);
  assert.match(rejected.reason, /nested inside this project/);

  const allowed = validateRepositoryDestination(nested, {
    projectRoot: dir,
    subRepos: ['vendor'],
    label: 'checkout',
  });
  assert.strictEqual(allowed.valid, true);
  assert.strictEqual(allowed.repos_root, null);
});

test('a resolver write-back remains readable as the configured checkout on the next load', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-repos-writeback-'));
  fs.mkdirSync(path.join(dir, '.planning'), { recursive: true });
  const checkout = path.join(dir, 'checkout');
  fs.mkdirSync(checkout);
  fs.writeFileSync(path.join(dir, '.planning', 'config.json'), JSON.stringify({
    project_key: 'preserve-me',
    pipeline: { custom_key: 'keep-me' },
  }, null, 2) + '\n');

  const written = repoResolver.persistResolvedRepository(dir, 'acme/service', checkout);
  assert.strictEqual(written.valid, true);
  assert.strictEqual(written.written, true);
  const loaded = loadConfig(dir);
  assert.strictEqual(loaded.valid, true);
  assert.strictEqual(loaded.config.repos['acme/service'], fs.realpathSync(checkout));
  assert.strictEqual(loaded.config.custom_key, undefined);
  const raw = JSON.parse(fs.readFileSync(path.join(dir, '.planning', 'config.json'), 'utf8'));
  assert.strictEqual(raw.project_key, 'preserve-me');
  assert.strictEqual(raw.pipeline.custom_key, 'keep-me');
});

suite('sentinel + auto_merge — the knobs that decide whether PRs land by themselves');

test('the defaults post a guard and land ticket PRs in the epic', () => {
  const { config } = withConfig(undefined);
  assert.strictEqual(config.sentinel, 'auto');
  assert.strictEqual(config.auto_merge, 'epic');
});

test('booleans are accepted as the obvious aliases', () => {
  assert.strictEqual(withConfig({ auto_merge: false }).config.auto_merge, 'off');
  assert.strictEqual(withConfig({ auto_merge: true }).config.auto_merge, 'epic');
  assert.strictEqual(withConfig({ sentinel: false }).config.sentinel, 'off');
});

test('a misspelled auto_merge falls back to OFF and says so — never to merging', () => {
  const { config, warnings } = withConfig({ auto_merge: 'yes-please' });
  assert.strictEqual(config.auto_merge, 'off');
  assert.ok(warnings.some((w) => /auto_merge/.test(w)));
});

test('no sentinel means nothing can auto-merge — the pair is kept consistent', () => {
  const { config, warnings } = withConfig({ sentinel: 'off', auto_merge: 'epic' });
  assert.strictEqual(config.auto_merge, 'off');
  assert.ok(warnings.some((w) => /nothing can auto-merge/.test(w)));
});

test('delivery_pipeline.* still wins over pipeline.* for these keys', () => {
  const { config } = withRaw({ pipeline: { auto_merge: 'epic' }, delivery_pipeline: { auto_merge: 'off' } });
  assert.strictEqual(config.auto_merge, 'off');
});

suite('merge_without_ci — "this repo has no CI" is a claim only the project can make');

// A PR with NO reported checks is not a green PR: nothing ran. The board and the
// guard both refuse to land one, so the escape hatch for a repo that genuinely
// has no pipeline has to be an explicit setting rather than an inference — and
// it fails towards the human, exactly like `preauthorized`.

test('the default is false — absence of checks is never taken as a pass', () => {
  assert.strictEqual(withConfig(undefined).config.merge_without_ci, false);
  assert.strictEqual(DEFAULTS.merge_without_ci, false);
});

test('a real true opts in', () => {
  assert.strictEqual(withConfig({ merge_without_ci: true }).config.merge_without_ci, true);
});

test('the string spellings JSON config files acquire are accepted', () => {
  assert.strictEqual(withConfig({ merge_without_ci: 'true' }).config.merge_without_ci, true);
  assert.strictEqual(withConfig({ merge_without_ci: 'false' }).config.merge_without_ci, false);
});

test('anything else is false WITH a warning — a value that looks like consent is not', () => {
  const { config, warnings } = withConfig({ merge_without_ci: 'yes' });
  assert.strictEqual(config.merge_without_ci, false);
  assert.ok(warnings.some((w) => /merge_without_ci/.test(w)), warnings.join('; '));
});

test('delivery_pipeline.merge_without_ci outranks pipeline.merge_without_ci', () => {
  const { config } = withRaw({
    pipeline: { merge_without_ci: true },
    delivery_pipeline: { merge_without_ci: false },
  });
  assert.strictEqual(config.merge_without_ci, false);
});

suite('adaptive task-level ladder');

test('the classifier keeps mechanical work cheap and guards missing evidence', () => {
  const { config } = withConfig({ model_ladder: 'adaptive' });
  assert.deepStrictEqual(
    [
      resolveTaskLevel('drift-check', { risk: 'high', files: 1 }, config),
      resolveTaskLevel('pr-sentinel', { checkpoint: true }, config),
      resolveTaskLevel('executor', { risk: 'low', files: 1 }, config),
      resolveTaskLevel('research', { risk: 'low', files: 4 }, config),
      resolveTaskLevel('executor', { risk: 'low', files: 5 }, config),
      resolveTaskLevel('executor', { risk: 'low' }, config),
      resolveTaskLevel('executor', { risk: 'high', files: 1 }, config),
      resolveTaskLevel('ci-fix', { signatureState: 'repeat_exhausted' }, config),
      resolveTaskLevel('pr-sentinel', { signatureState: 'repeat_exhausted' }, config),
      resolveTaskLevel('arch-review', { contested: true }, config),
    ],
    ['mechanical', 'mechanical', 'routine', 'routine', 'complex', 'complex', 'critical', 'recovery', 'recovery', 'recovery']
  );
  const guarded = taskLevelRoute('executor', { risk: 'low' , taskLevel: 'routine' }, config);
  assert.strictEqual(guarded.value, 'complex', 'a routine request without file evidence cannot cheapen the task');
  assert.strictEqual(guarded.rule, 'guarded:complex');
});

test('recovery is evidence-backed, including the sentinel exception', () => {
  const { config } = withConfig({ model_ladder: 'adaptive' });
  const missing = taskLevelRoute('ci-fix', { taskLevel: 'recovery' }, config);
  assert.strictEqual(missing.value, 'complex', 'a recovery label without its signature must not reach -deep');
  assert.strictEqual(missing.rule, 'guarded:complex');
  const fixer = taskLevelRoute('ci-fix', {
    taskLevel: 'recovery', signatureState: 'repeat_exhausted',
  }, config);
  assert.strictEqual(fixer.value, 'recovery');
  assert.strictEqual(fixer.rule, 'explicit:recovery');
  const sentinel = taskLevelRoute('pr-sentinel', {
    taskLevel: 'recovery', signatureState: 'repeat_exhausted',
  }, config);
  assert.strictEqual(sentinel.value, 'recovery', 'the evidence-backed mechanical exception reaches -deep');
  assert.strictEqual(sentinel.rule, 'explicit:recovery');
  const contested = taskLevelRoute('arch-review', {
    taskLevel: 'recovery', contested: true,
  }, config);
  assert.strictEqual(contested.value, 'recovery');
  assert.strictEqual(contested.rule, 'explicit:recovery');
});

suite('plan_defect_signatures — the K of the k-distinct rule');

test('it defaults to 3, the same K failure-signature.cjs uses', () => {
  const { DEFAULT_K } = require(sigMod);
  assert.strictEqual(DEFAULTS.plan_defect_signatures, 3);
  assert.strictEqual(withConfig(undefined).config.plan_defect_signatures, 3);
  assert.strictEqual(DEFAULTS.plan_defect_signatures, DEFAULT_K, 'the two files must agree on K');
});

test('a positive value is honoured; a non-positive one warns and falls back', () => {
  assert.strictEqual(withConfig({ plan_defect_signatures: 5 }).config.plan_defect_signatures, 5);
  const bad = withConfig({ plan_defect_signatures: 0 });
  assert.strictEqual(bad.config.plan_defect_signatures, 3);
  assert.ok(bad.warnings.some((w) => /plan_defect_signatures/.test(w) && /positive number/.test(w)),
    bad.warnings.join('; '));
});

suite('the CLI contract the babysit loop calls');

// A temp cwd with no .planning/: default config, runtime UNSET — which is the
// state the acceptance criteria are written against.
function runCli(args, raw) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-cli-'));
  if (raw !== undefined) {
    fs.mkdirSync(path.join(dir, '.planning'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.planning', 'config.json'), JSON.stringify(raw, null, 2));
  }
  const r = spawnSync(process.execPath, [mod, ...args], { cwd: dir, env: {}, encoding: 'utf8' });
  return { status: r.status, out: (r.stdout || '').trim(), err: r.stderr || '', json: () => JSON.parse(r.stdout) };
}
test('resolve reports the new key', () => {
  const r = runCli(['resolve']);
  assert.strictEqual(r.status, 0, r.err);
  assert.strictEqual(JSON.parse(r.out).config.plan_defect_signatures, 3);
});

suite('the ceiling — three mechanical routes, never a default (ADR-005 D4)');

test('pipeline.fable is coerced like every other consent knob: only a real value opts in', () => {
  assert.strictEqual(withConfig({}).config.fable, 'off', 'the default is shut');
  assert.strictEqual(withConfig({ fable: 'auto' }).config.fable, 'auto');
  assert.strictEqual(withConfig({ fable: true }).config.fable, 'auto');
  const bad = withConfig({ fable: 'yes please' });
  assert.strictEqual(bad.config.fable, 'off');
  assert.ok(bad.warnings.some((w) => /pipeline\.fable/.test(w)), bad.warnings.join('; '));
  const window = withConfig({ fable_window_tokens: 0 });
  assert.strictEqual(window.config.fable_window_tokens, 250000);
  assert.ok(window.warnings.some((w) => /fable_window_tokens/.test(w)), window.warnings.join('; '));
  assert.strictEqual(withConfig({ fable_window_tokens: 400000 }).config.fable_window_tokens, 400000);
  // and the GSD-native namespace wins here as everywhere
  assert.strictEqual(withRaw({ pipeline: { fable: 'off' }, delivery_pipeline: { fable: 'auto' } }).config.fable, 'auto');
});

suite('ADR-014 authoritative configuration bridge');

const canonicalPolicy = require('../../plugins/delivery-pipeline/scripts/model-policy.cjs');
const routedConfig = (raw = {}, runtime = 'codex', options = {}) =>
  withRawOptions(raw, { runtime, env: {}, routed: true, ...options });
const refusesSource = (fn, source) => assert.throws(fn, (error) =>
  error.name === 'DispatchPolicyError' && error.details.source === source && error.message.includes(source));

test('shares the canonical role vocabulary including decomposition', () => {
  assert.strictEqual(ROUTED_ROLES, canonicalPolicy.ROLES);
  assert.ok(ROUTED_ROLES.includes('decomposition'));
});

test('legacy role consumers retain the compatibility vocabulary', () => {
  assert.strictEqual(ROLES, COMPATIBILITY_ROLES);
  assert.deepStrictEqual(ROLES, [
    'integrator', 'arch-review', 'code-review', 'executor', 'ci-fix', 'review-fix',
    'drift-check', 'research', 'pr-sentinel',
  ]);
  for (const role of ROLES) assert.ok(ROUTED_ROLES.includes(role), role);
});

test('the routed mode marker is frozen and outranks a mutable compatibility flag', () => {
  const compatibility = withRawOptions({}, { runtime: 'codex', env: {} }).config;
  assert.equal(compatibility.dispatch_context.mode, 'compatibility');
  assert.equal(compatibility.dispatch_context.routed, false);
  assert.ok(Object.isFrozen(compatibility.dispatch_context));
  compatibility.routed = true;
  assert.throws(() => resolveDispatch({ config: compatibility, role: 'executor' }), /compatibility-only/);

  const routed = routedConfig().config;
  assert.equal(routed.dispatch_context.mode, 'routed');
  assert.equal(routed.dispatch_context.routed, true);
  assert.ok(Object.isFrozen(routed.dispatch_context));
  assert.throws(() => { routed.dispatch_context.mode = 'compatibility'; }, TypeError);
  routed.routed = false;
  assert.equal(resolveDispatch({ config: routed, role: 'executor' }).model, 'gpt-6.1-sol');
});

test('routed readers reject a replacement context before compatibility fallback', () => {
  const { config } = routedConfig();
  config.dispatch_context = { mode: 'compatibility', routed: false };
  refusesSource(() => resolveDispatch({ config, role: 'executor' }), 'config.dispatch_context');
});

for (const [name, copy] of [
  ['spread', (config) => ({ ...config })],
  ['serialized', (config) => JSON.parse(JSON.stringify(config))],
  ['context-omitted', (config) => {
    const { dispatch_context, ...copy } = config;
    return copy;
  }],
  ['context-null', (config) => ({ ...config, dispatch_context: null })],
]) {
  test(`routed readers reject an unbound ${name} copy before compatibility fallback`, () => {
    const original = routedConfig().config;
    const config = copy(original);
    assert.equal(config.routed, true);
    assert.equal(resolveDispatch({ config: original, role: 'executor' }).model, 'gpt-6.1-sol');
    for (const read of [
      () => resolveDispatch({ config, role: 'executor' }),
      () => taskLevelRoute('executor', {}, config),
    ]) {
      assert.throws(read, (error) => error.name === 'DispatchPolicyError'
        && error.code === 'INVALID_CONFIG'
        && error.details.source === 'config.dispatch_context'
        && error.message.includes('config.dispatch_context'));
    }
    const compatibility = copy(withRawOptions({}, { runtime: 'codex', env: {} }).config);
    assert.equal(taskLevelRoute('executor', {}, compatibility).value, 'complex');
  });
}

test('compatibility parsing cannot hide a conflicting routed decomposition override', () => {
  for (const [key, value] of [['models', 'gpt-6-luna'], ['effort', 'medium']]) {
    const { config, warnings } = withRawOptions({ pipeline: { [key]: { decomposition: value } } },
      { runtime: 'codex', env: {} });
    assert.equal(config[key].decomposition, undefined);
    assert.ok(warnings.some((warning) => warning.includes(`pipeline.${key}."decomposition"`)));
    assert.throws(() => resolveDispatch({ role: 'decomposition', config }), /compatibility-only/);
    const routed = routedConfig({ pipeline: { [key]: { decomposition: value } } });
    refusesSource(() => resolveDispatch({ role: 'decomposition', config: routed.config }), `pipeline.${key}.decomposition`);
  }
});

test('every runtime and role delegates base and escalation decisions with full identity', () => {
  for (const runtime of ['claude', 'codex']) {
    const { config } = routedConfig(runtime === 'claude' ? { pipeline: { fable: 'auto' } } : {}, runtime,
      { dispatch_id: 'T-36-02-launch' });
    assert.equal(config.policy_hash, canonicalPolicy.POLICY_HASH);
    assert.equal(config.policy_version, canonicalPolicy.POLICY_VERSION);
    assert.equal(config.dispatch_context.runtime.dispatch_id, 'T-36-02-launch');
    for (const role of ROUTED_ROLES) {
      for (const signals of [{}, { checkpoint: true }, { type: 'alternatives' }, { complexity: 'very-complex' }, { inputTokens: 300001 }]) {
        const expected = canonicalPolicy.resolveDispatch({ runtime, role, signals, dispatch_id: 'T-36-02-launch' });
        const got = resolveDispatch({ config, role, signals });
        assert.deepStrictEqual(got, expected);
        assert.ok(Object.isFrozen(got));
      }
    }
  }
});

test('canonical model_policy runtime and role model sources are captured and validated', () => {
  const raw = {
    model_policy: {
      runtime: 'codex',
      models: { executor: 'gpt-6.1-sol' },
    },
  };
  const { config } = routedConfig(raw);
  assert.deepStrictEqual(config.dispatch_context.configuration.model_policy, raw.model_policy);
  assert.equal(resolveDispatch({ config, role: 'executor' }).model, 'gpt-6.1-sol');

  for (const [field, value, source] of [
    ['runtime', 'claude', 'config.model_policy.runtime'],
    ['models', { executor: 'another-model' }, 'config.model_policy.models.executor'],
  ]) {
    const next = routedConfig({ model_policy: { ...raw.model_policy, [field]: value } });
    refusesSource(() => resolveDispatch({ config: next.config, role: 'executor' }), source);
  }
});

test('model_profile must match the normalized pipeline policy at the routed boundary', () => {
  const matching = routedConfig({ model_profile: 'balanced' });
  assert.equal(resolveDispatch({ config: matching.config, role: 'executor' }).model, 'gpt-6.1-sol');

  for (const profile of ['quality', 'budget', 'adaptive', 'inherit', 'golden', null]) {
    const { config } = routedConfig({ model_profile: profile });
    refusesSource(() => resolveDispatch({ config, role: 'executor' }), 'config.model_profile');
  }

  const economy = routedConfig({
    model_profile: 'budget',
    pipeline: { model_policy: 'economy' },
  });
  assert.equal(resolveDispatch({ config: economy.config, role: 'executor' }).model, 'gpt-6.1-sol');
  const missing = routedConfig({ pipeline: { model_policy: 'premium' } });
  refusesSource(() => resolveDispatch({ config: missing.config, role: 'executor' }), 'config.model_profile');
});

test('routed profile controls reject raw nested values hidden by compatibility normalization', () => {
  for (const namespace of ['pipeline', 'delivery_pipeline', 'gsd']) {
    for (const value of ['bogus', null, false, 0, '', {}, []]) {
      const { config } = routedConfig({ [namespace]: { model_policy: value } });
      assert.throws(() => resolveDispatch({ config, role: 'executor' }), (error) =>
        error.code === 'UNSUPPORTED_SELECTION' && error.details.source === `${namespace}.model_policy`);
    }
  }
});

test('raw GSD model policy must match the normalized routed policy', () => {
  for (const runtime of ['codex', 'claude']) {
    for (const [policy, model_profile, alias] of [
      ['balanced', 'balanced', 'adaptive'], ['economy', 'budget', 'budget'], ['premium', 'quality', 'quality'],
    ]) {
      for (const value of [policy, alias]) {
        const { config } = routedConfig({
          model_profile, pipeline: { model_policy: policy }, gsd: { model_policy: value },
        }, runtime);
        assert.deepStrictEqual(resolveDispatch({ config, role: 'executor' }),
          canonicalPolicy.resolveDispatch({ runtime, role: 'executor' }));
      }
      for (const value of ['balanced', 'economy', 'premium'].filter((value) => value !== policy)) {
        const { config } = routedConfig({
          model_profile, pipeline: { model_policy: policy }, gsd: { model_policy: value },
        }, runtime);
        assert.throws(() => resolveDispatch({ config, role: 'executor' }), (error) =>
          error.code === 'CONFLICTING_OVERRIDE' && error.details.source === 'gsd.model_policy'
          && error.details.expected === policy && error.details.actual === value);
      }
    }
    const { config } = routedConfig({ gsd: { model_policy: 'economy' } }, runtime);
    refusesSource(() => resolveDispatch({ config, role: 'executor' }), 'gsd.model_policy');
  }
});

test('routed Codex CLI refuses malformed or conflicting GSD model policies without a decision', () => {
  for (const [value, code] of [
    ['bogus', 'UNSUPPORTED_SELECTION'], [null, 'UNSUPPORTED_SELECTION'], ['economy', 'CONFLICTING_OVERRIDE'],
    ['balanced', null],
  ]) {
    const { dir } = routedConfig({ gsd: { model_policy: value } });
    const result = spawnSync(process.execPath, [mod, 'dispatch', JSON.stringify({ runtime: 'codex', role: 'executor' })],
      { cwd: dir, env: {}, encoding: 'utf8' });
    if (code) {
      assert.equal(result.status, 1, result.stderr);
      assert.equal(result.stdout, '');
      assert.ok(result.stderr.includes(code) && result.stderr.includes('gsd.model_policy'), result.stderr);
    } else {
      assert.equal(result.status, 0, result.stderr);
      const decision = JSON.parse(result.stdout);
      assert.equal(decision.model, 'gpt-6.1-sol');
      assert.equal(decision.effort, 'low');
    }
  }
});

test('routed Fable controls are normalized, carried, and cannot be bypassed', () => {
  const shut = routedConfig({}, 'claude');
  assert.deepStrictEqual(shut.config.dispatch_context.normalized, {
    fable: 'off',
    fable_window_tokens: 250000,
    model_policy: 'balanced',
  });
  refusesSource(() => resolveDispatch({
    config: shut.config,
    role: 'arch-review',
    signals: { inputTokens: 300001 },
  }), 'pipeline.fable');

  const consented = routedConfig({ pipeline: { fable: 'auto' } }, 'claude');
  assert.equal(resolveDispatch({
    config: consented.config,
    role: 'arch-review',
    signals: { inputTokens: 300001 },
  }).model, 'fable');

  const customThreshold = routedConfig({
    pipeline: { fable: 'auto', fable_window_tokens: 1000 },
  }, 'claude');
  refusesSource(() => resolveDispatch({ config: customThreshold.config, role: 'executor' }),
    'pipeline.fable_window_tokens');
});

test('refuses original overrides before compatibility parsing or namespace merging can hide them', () => {
  const cases = [
    [{ pipeline: { models: { executor: 'unknown-full-model-id' } } }, 'pipeline.models.executor'],
    [{ pipeline: { effort: { executor: 'ultra' } } }, 'pipeline.effort.executor'],
    [{ pipeline: { models: { executor: 'opus' } }, delivery_pipeline: { models: {} } }, 'pipeline.models.executor'],
    [{ delivery_pipeline: { models: { executor: 'opus' } } }, 'delivery_pipeline.models.executor'],
    [{ models: { execution: 'gpt-6-astra' } }, 'config.models.execution'],
    [{ model_overrides: { 'gsd-executor': 'opus' } }, 'config.model_overrides.gsd-executor'],
    [{ effort: { agent_overrides: { 'gsd-executor': 'max' } } }, 'config.effort.agent_overrides.gsd-executor'],
    [{ effort: { routing_tier_defaults: { standard: 'ultra' } } }, 'config.effort.routing_tier_defaults.standard'],
    [{ gsd: { models: { executor: 'opus' } } }, 'gsd.models.executor'],
    [{ pipeline: { models: null } }, 'pipeline.models'],
    [{ pipeline: { inline: true } }, 'pipeline.inline'],
  ];
  for (const [raw, source] of cases) {
    const { config } = routedConfig(raw);
    refusesSource(() => resolveDispatch({ role: 'executor', config }), source);
  }
});

test('decomposition validates planner and checker GSD override keys for both runtimes', () => {
  for (const runtime of ['codex', 'claude']) {
    const effort = runtime === 'codex' ? 'xhigh' : 'low';
    const cases = [
      [{ model_overrides: { 'gsd-plan-checker': 'haiku' } }, 'config.model_overrides.gsd-plan-checker'],
      [{ effort: { agent_overrides: { 'gsd-plan-checker': effort } } }, 'config.effort.agent_overrides.gsd-plan-checker'],
    ];
    for (const [raw, source] of cases) {
      const { config } = routedConfig(
        runtime === 'claude' ? { ...raw, pipeline: { fable: 'auto' } } : raw,
        runtime,
      );
      refusesSource(() => resolveDispatch({ config, role: 'decomposition', dispatch_id: `checker-${runtime}` }), source);
    }
  }
});

test('GSD tuning tiers and defaults defer to both runtime ladders for every role', () => {
  const tuning = {
    models: { planning: 'opus', execution: 'opus', research: 'sonnet', verification: 'sonnet' },
    effort: { routing_tier_defaults: { light: 'low', standard: 'high', heavy: 'xhigh' } },
  };
  for (const runtime of ['codex', 'claude']) {
    for (const raw of [tuning, { gsd: tuning }]) {
      const { config } = routedConfig({ ...raw, pipeline: { fable: 'auto' } }, runtime);
      for (const role of ROUTED_ROLES) {
        for (const signals of [{}, { checkpoint: true }]) {
          assert.deepStrictEqual(resolveDispatch({ config, role, signals }),
            canonicalPolicy.resolveDispatch({ runtime, role, signals }));
        }
      }
    }
    const raw = { ...tuning, model_profile: 'balanced' };
    const { config } = routedConfig(raw, runtime);
    for (const role of ROUTED_ROLES) {
      assert.deepStrictEqual(resolveDispatch({ config, role }),
        canonicalPolicy.resolveDispatch({ runtime, role }));
    }
  }
});

test('minimal is harmless only as a generic GSD routing tier default', () => {
  const tuning = {
    effort: { routing_tier_defaults: { light: 'minimal', standard: 'high', heavy: 'xhigh' } },
  };
  for (const runtime of ['codex', 'claude']) {
    for (const raw of [tuning, { gsd: tuning }]) {
      const { config } = routedConfig(raw, runtime);
      assert.deepStrictEqual(resolveDispatch({ config, role: 'executor' }),
        canonicalPolicy.resolveDispatch({ runtime, role: 'executor' }));
    }
  }
});

test('only GSD stage tier aliases are exempt, not concrete or inherited selections', () => {
  for (const runtime of ['codex', 'claude']) {
    for (const prefix of ['config', 'gsd']) {
      const wrap = (value) => prefix === 'config' ? value : { gsd: value };
      for (const alias of ['haiku', 'sonnet', 'opus']) {
        const { config } = routedConfig(wrap({ models: { execution: alias } }), runtime);
        assert.deepStrictEqual(resolveDispatch({ config, role: 'executor' }),
          canonicalPolicy.resolveDispatch({ runtime, role: 'executor' }));
      }
      for (const [value, source] of [
        [{ models: { execution: 'inherit' } }, 'models.execution'],
        [{ models: { execution: 'not-a-model' } }, 'models.execution'],
        [{ models: { executor: 'haiku' } }, 'models.executor'],
        [{ models: { 'gsd-executor': 'haiku' } }, 'models.gsd-executor'],
        [{ model_overrides: { execution: 'haiku' } }, 'model_overrides.execution'],
        [{ model_overrides: { 'gsd-executor': 'haiku' } }, 'model_overrides.gsd-executor'],
        [{ effort: { execution: 'max' } }, 'effort.execution'],
        [{ effort: { agent_overrides: { 'gsd-executor': 'max' } } }, 'effort.agent_overrides.gsd-executor'],
      ]) {
        const { config } = routedConfig(wrap(value), runtime);
        refusesSource(() => resolveDispatch({ config, role: 'executor' }), `${prefix}.${source}`);
      }
    }
  }
  const { config } = routedConfig({ model_overrides: { 'gsd-planner': 'haiku' } }, 'claude');
  refusesSource(() => resolveDispatch({ config, role: 'decomposition' }), 'config.model_overrides.gsd-planner');
});

test('GSD code-reviewer overrides do not select arch-review or code-review, while direct overrides still refuse', () => {
  for (const reviewRole of ['arch-review', 'code-review']) for (const runtime of ['claude', 'codex']) {
    for (const signals of [{}, { critical: true }]) {
      const expected = canonicalPolicy.resolveDispatch({ runtime, role: reviewRole, signals });
      for (const [namespace, wrap, sourcePrefix] of [
        ['root', (value) => value, 'config'],
        ['gsd', (value) => ({ gsd: value }), 'gsd'],
      ]) {
        for (const selection of [
          { model_overrides: { 'gsd-code-reviewer': 'haiku' } },
          { effort: { agent_overrides: { 'gsd-code-reviewer': 'low' } } },
        ]) {
          const { config } = routedConfig(wrap(selection), runtime);
          assert.deepStrictEqual(resolveDispatch({ config, role: reviewRole, signals }), expected,
            `${runtime} ${reviewRole} ${JSON.stringify(signals)} ${namespace} GSD code-reviewer preference`);
        }

        for (const [selection, source] of [
          [{ model_overrides: { [reviewRole]: 'haiku' } }, `${sourcePrefix}.model_overrides.${reviewRole}`],
          [{ effort: { agent_overrides: { [reviewRole]: 'low' } } },
            `${sourcePrefix}.effort.agent_overrides.${reviewRole}`],
        ]) {
          const { config } = routedConfig(wrap(selection), runtime);
          refusesSource(() => resolveDispatch({ config, role: reviewRole, signals }), source);
        }
      }
    }
  }
});

test('inherited GSD tuning defaults retain the canonical selections on both runtimes', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-tuning-root-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-tuning-home-'));
  fs.mkdirSync(path.join(home, '.gsd'));
  fs.writeFileSync(path.join(home, '.gsd', 'defaults.json'), JSON.stringify({
    model_profile: 'balanced',
    models: { planning: 'opus', execution: 'opus', research: 'sonnet', verification: 'sonnet' },
    effort: { routing_tier_defaults: { light: 'minimal', standard: 'high', heavy: 'xhigh' } },
  }));
  for (const runtime of ['codex', 'claude']) {
    const { config } = loadConfig(root, { runtime, routed: true, env: { GSD_HOME: home } });
    for (const role of ROUTED_ROLES) {
      assert.deepStrictEqual(resolveDispatch({ config, role }),
        canonicalPolicy.resolveDispatch({ runtime, role }));
    }
  }
});

test('validates GSD decomposition overrides and leaves unrelated role overrides alone', () => {
  const { config } = routedConfig({ model_overrides: { 'gsd-planner': 'opus' } });
  refusesSource(() => resolveDispatch({ role: 'decomposition', config }), 'config.model_overrides.gsd-planner');
  assert.equal(resolveDispatch({ role: 'executor', config }).model, 'gpt-6.1-sol');
});

test('matching configured selections are harmless and cannot pin a later rung', () => {
  for (const runtime of ['codex', 'claude']) {
    const expected = canonicalPolicy.resolveDispatch({ runtime, role: 'executor' });
    const { config } = routedConfig({
      pipeline: { models: { executor: expected.model }, effort: { executor: expected.effort } },
      model_overrides: { 'gsd-executor': expected.model },
      effort: { agent_overrides: { 'gsd-executor': expected.effort } },
    }, runtime);
    assert.deepStrictEqual(resolveDispatch({ config, role: 'executor' }), expected);
    refusesSource(() => resolveDispatch({ config, role: 'executor', signals: { checkpoint: true } }), 'config.effort.agent_overrides.gsd-executor');
  }
});

test('inline and inherited selections cannot replace an explicit launch', () => {
  const { config } = routedConfig();
  for (const field of ['inline', 'inherit', 'session_inherited']) {
    refusesSource(() => resolveDispatch({ config, role: 'executor', [field]: true }), `input.${field}`);
  }
  for (const field of ['session', 'sessionOverride', 'inlineOverride', 'inherited']) {
    refusesSource(() => resolveDispatch({ config, role: 'executor', [field]: { model: 'parent-model' } }), `input.${field}`);
  }
  for (const field of ['gsdOverride', 'perRoleOverride', 'override', 'selection', 'launch_arguments']) {
    assert.throws(() => resolveDispatch({ config, role: 'executor', [field]: { effort: 'max' } }), /selects effort/);
  }
});

test('compatibility defaults and corrupt configuration can never become routed fallback', () => {
  const { config, dir } = withRawOptions({ runtime: 'codex' }, { env: {} });
  assert.throws(() => resolveDispatch({ config, role: 'executor' }), /compatibility-only/);
  refusesSource(() => resolveDispatch({ config: DEFAULTS, role: 'executor' }), 'config');
  fs.writeFileSync(path.join(dir, '.planning', 'config.json'), '{');
  const loaded = loadConfig(dir, { runtime: 'codex', env: {} });
  assert.equal(loaded.valid, false);
  assert.throws(() => resolveDispatch({ config: loaded.config, role: 'executor' }), /compatibility-only/);
  assert.throws(() => loadConfig(dir, { routed: true, runtime: 'codex', env: {} }), { code: 'INVALID_CONFIG' });
});

test('a compatibility load retains rejected model input for a later routed call', () => {
  const { config } = withRawOptions({ pipeline: { models: { executor: 'not-a-tier' } } }, { runtime: 'codex', env: {} });
  assert.equal(config.models.executor, undefined);
  assert.throws(() => resolveDispatch({ config, role: 'executor' }), /compatibility-only/);
});

test('captures and validates Codex remap namespaces at the routed boundary', () => {
  const cases = [
    [{ model_policy: { runtime_tiers: { codex: { sonnet: 'remapped-agent' } } } },
      'config.model_policy.runtime_tiers.codex.sonnet'],
    [{ model_profile_overrides: { codex: { sonnet: { model: 'remapped-agent' } } } },
      'config.model_profile_overrides.codex.sonnet'],
  ];
    for (const [raw, source] of cases) {
      const { config } = routedConfig(raw);
      assert.deepStrictEqual(config.dispatch_context.configuration.model_policy, raw.model_policy);
      assert.deepStrictEqual(config.dispatch_context.configuration.model_profile_overrides, raw.model_profile_overrides);
      refusesSource(() => resolveDispatch({ config, role: 'pr-sentinel' }), source);
  }
});

test('matching Codex remaps are accepted while contradictory entries fail closed', () => {
  for (const remap of [
    { model_policy: { runtime_tiers: { codex: { sonnet: 'gpt-6-luna' } } } },
    { model_profile_overrides: { codex: { sonnet: { model: 'gpt-6-luna' } } } },
  ]) {
    const { config } = routedConfig(remap);
    assert.equal(resolveDispatch({ config, role: 'pr-sentinel' }).model, 'gpt-6-luna');
  }
  const { config } = routedConfig({
    model_policy: { runtime_tiers: { codex: { sonnet: 'gpt-6-luna' } } },
    model_profile_overrides: { codex: { sonnet: 'remapped-agent' } },
  });
  refusesSource(() => resolveDispatch({ config, role: 'pr-sentinel' }),
    'config.model_profile_overrides.codex.sonnet');
});

test('Codex remaps remain inert for Claude routed dispatches and compatibility loads', () => {
  const raw = { model_profile_overrides: { codex: { sonnet: 'remapped-agent' } } };
  const { config: claude } = routedConfig(raw, 'claude');
  assert.equal(resolveDispatch({ config: claude, role: 'executor' }).model, 'claude-sonnet-5-5');
  const { config: compatibility } = withRawOptions(raw, { runtime: 'codex', env: {} });
  assert.deepStrictEqual(compatibility.dispatch_context.configuration.model_profile_overrides,
    raw.model_profile_overrides);
  assert.throws(() => resolveDispatch({ config: compatibility, role: 'executor' }), /compatibility-only/);
});

test('refuses post-load selection changes, stale fingerprints and identity conflicts', () => {
  const { config } = routedConfig({}, 'codex', { dispatch_id: 'first' });
  config.models.executor = 'opus';
  refusesSource(() => resolveDispatch({ config, role: 'executor' }), 'pipeline.models.executor');
  delete config.models.executor;
  refusesSource(() => resolveDispatch({ config, role: 'executor', dispatch_id: 'second' }), 'input.dispatch_id');
  assert.throws(() => resolveDispatch({ config, role: 'executor', runtime: 'claude' }), { code: 'AMBIGUOUS_RUNTIME' });
  config.policy_hash = 'stale';
  refusesSource(() => resolveDispatch({ config, role: 'executor' }), 'config.policy_hash');
});

test('refuses incomplete or stale policy pairs in config and runtime context', () => {
  for (const runtime of ['codex', 'claude']) {
    for (const source of ['config', 'config.dispatch_context.runtime']) {
      for (const field of ['policy_version', 'policy_hash']) {
        for (const value of ['stale', null, undefined, 42]) {
          const { config } = routedConfig({}, runtime);
          const target = source === 'config' ? config : { ...config.dispatch_context.runtime };
          if (value === undefined) delete target[field];
          else target[field] = value;
          if (source !== 'config') {
            config.dispatch_context = { ...config.dispatch_context, runtime: target };
          }
          const expectedSource = source === 'config'
            ? `${source}.${field}`
            : 'config.dispatch_context';
          assert.throws(() => resolveDispatch({ config, role: 'executor' }), (error) =>
            error.name === 'DispatchPolicyError' && error.code === 'INVALID_CONFIG'
              && error.details.source === expectedSource && error.message.includes(expectedSource),
          `${runtime}: ${expectedSource}=${JSON.stringify(value)}`);
        }
      }
    }
  }
});

test('repair escalation never gains receipt authority through configuration', () => {
  const { config } = routedConfig();
  assert.throws(() => resolveDispatch({ config, role: 'ci-fix', signals: { signatureState: 'repeat' } }), { code: 'MISSING_RECEIPT' });
  assert.throws(() => resolveDispatch({ config, role: 'ci-fix', signals: { signatureState: 'repeat', priorApplied: {} } }), { code: 'UNVERIFIED_RECEIPT' });
});

test('routed CLI returns full decisions and exits nonzero without stdout on invalid input', () => {
  const { dir } = routedConfig();
  const cli = (args) => spawnSync(process.execPath, [mod, ...args], { cwd: dir, env: {}, encoding: 'utf8' });
  const dispatch = (input) => cli(['dispatch', JSON.stringify(input)]);
  const good = dispatch({ role: 'decomposition', runtime: 'codex', signals: { checkpoint: true }, dispatch_id: 'cli-launch' });
  assert.equal(good.status, 0, good.stderr);
  const decision = JSON.parse(good.stdout);
  assert.equal(decision.model, 'gpt-6.1-sol');
  assert.equal(decision.policy_hash, canonicalPolicy.POLICY_HASH);
  assert.equal(decision.dispatch_id, 'cli-launch');
  for (const input of [
    { runtime: 'future' }, { runtime: 'codex', signals: { signatureState: 'typo' } },
    { runtime: 'codex', effort: 'medium' }, { runtime: 'codex', inline: true },
  ]) {
    const result = dispatch({ role: 'executor', ...input });
    assert.notEqual(result.status, 0, JSON.stringify(input));
    assert.equal(result.stdout, '');
    assert.ok(result.stderr.includes('pipeline-config:'));
  }
  assert.notEqual(cli(['model', 'executor']).status, 0, 'the removed model command is a usage error');
});

test('routed CLI preserves explicit whitespace input tokens for canonical rejection', () => {
  const { dir } = routedConfig();
  const api = routedConfig({}, 'codex').config;
  assert.throws(() => resolveDispatch({ config: api, role: 'arch-review', signals: { inputTokens: '   ' } }),
    { code: 'INVALID_SIGNAL' });
  const result = spawnSync(process.execPath, [mod, 'dispatch',
    JSON.stringify({ role: 'arch-review', runtime: 'codex', signals: { inputTokens: '   ' } })],
  { cwd: dir, env: {}, encoding: 'utf8' });
  assert.equal(result.status, 1, result.stderr);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /INVALID_SIGNAL/);
  assert.match(result.stderr, /inputTokens/);
});

test('routed loading reports malformed configuration before missing runtime evidence', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-routed-invalid-config-'));
  const file = path.join(dir, '.planning', 'config.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '{');
  assert.throws(() => loadConfig(dir, { routed: true, env: {} }), (error) =>
    error.code === 'INVALID_CONFIG' && error.details.source === file);
});

suite('T-36-02 escalated boundary reproductions');

test('raw Fable controls fail closed in both namespaces and runtimes', () => {
  for (const runtime of ['codex', 'claude']) {
    for (const namespace of ['pipeline', 'delivery_pipeline']) {
      for (const [field, values] of [
        ['fable', ['bogus', 0, false, true, null, '', {}, []]],
        ['fable_window_tokens', [0, -1, 1000, 'garbage', '250000', 250000.9, false, null, {}, []]],
      ]) {
        for (const value of values) {
          const raw = { [namespace]: { [field]: value } };
          const { config } = routedConfig(raw, runtime);
          refusesSource(() => resolveDispatch({ config, role: 'executor' }), `${namespace}.${field}`);
          assert.doesNotThrow(() => withRaw(raw));
          // A higher-precedence valid value cannot hide malformed input.
          if (namespace === 'pipeline') {
            raw.delivery_pipeline = { [field]: field === 'fable' ? 'off' : 250000 };
            const shadowed = routedConfig(raw, runtime).config;
            refusesSource(() => resolveDispatch({ config: shadowed, role: 'executor' }), `${namespace}.${field}`);
          }
        }
      }
      for (const fable of ['auto', 'off']) {
        const { config } = routedConfig({ [namespace]: { fable, fable_window_tokens: 250000 } }, runtime);
        assert.equal(resolveDispatch({ config, role: 'executor' }).rung, 'base');
      }
    }
  }
});

test('routed Fable controls reject contradictory namespace values before precedence hides them', () => {
  const { config } = routedConfig({
    pipeline: { fable: 'off' },
    delivery_pipeline: { fable: 'auto' },
  }, 'claude');
  refusesSource(() => resolveDispatch({
    config,
    role: 'arch-review',
    signals: { inputTokens: canonicalPolicy.WINDOW_THRESHOLD_TOKENS + 1 },
  }), 'pipeline.fable');
});

test('every routed reader rejects explicit malformed signals but accepts omission', () => {
  for (const runtime of ['claude', 'codex']) {
    const { config } = routedConfig({}, runtime);
    assert.equal(resolveDispatch({ config, role: 'executor' }).effort,
      canonicalPolicy.resolveDispatch({ runtime, role: 'executor' }).effort);
    for (const signals of [null, false, 0, '', 'garbage', [], { critical: 'yes' }]) {
      assert.throws(() => resolveDispatch({ config, role: 'executor', signals }),
        { code: signals && !Array.isArray(signals) && typeof signals === 'object' ? 'INVALID_SIGNAL' : 'INVALID_INPUT' });
    }
  }
});

test('effective profiles from inputs and mutable or nested config cannot escape validation', () => {
  for (const runtime of ['codex', 'claude']) {
    for (const value of ['inherit', 'adaptive', 'quality', 'budget', 'bogus', null, false, 0, '', {}, []]) {
      const { config } = routedConfig({}, runtime);
      refusesSource(() => resolveDispatch({ config, role: 'executor', model_profile: value }), 'input.model_profile');
      config.model_profile = value;
      refusesSource(() => resolveDispatch({ config, role: 'executor' }), 'config.model_profile');
      for (const namespace of ['pipeline', 'delivery_pipeline', 'gsd']) {
        const nested = routedConfig({ [namespace]: { model_profile: value } }, runtime).config;
        refusesSource(() => resolveDispatch({ config: nested, role: 'executor' }), `${namespace}.model_profile`);
      }
    }
    const { config } = routedConfig({}, runtime);
    config.model_profile = 'balanced';
    assert.equal(resolveDispatch({ config, role: 'executor', model_profile: 'balanced' }).rung, 'base');
  }
});

test('JSON dispatch validates the complete invocation including empty and trailing arguments', () => {
  const { dir } = routedConfig();
  const request = JSON.stringify({ runtime: 'codex', role: 'executor' });
  const cli = (args, input = request) => spawnSync(process.execPath, [mod, 'dispatch', ...args],
    { cwd: dir, env: {}, input, encoding: 'utf8' });
  for (const args of [[request, '--runtime', 'claude'], [request, '--model', 'opus'],
    [request, request], [request, ''], [''], [request, '--routed']]) {
    const result = cli(args);
    assert.equal(result.status, 1, JSON.stringify(args));
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /INVALID_INPUT/);
  }
  for (const args of [[], [request]]) {
    const result = cli(args);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).model, 'gpt-6.1-sol');
  }
});

test('JSON dispatch rejects unknown top-level fields instead of losing escalation signals', () => {
  const { dir } = routedConfig();
  const cli = (args, input) => spawnSync(process.execPath, [mod, 'dispatch', ...args],
    { cwd: dir, env: {}, input, encoding: 'utf8' });
  const typo = JSON.stringify({
    runtime: 'codex', role: 'executor', singals: { critical: true },
  });
  for (const [args, input] of [[[typo], undefined], [[], typo]]) {
    const result = cli(args, input);
    assert.equal(result.status, 1, result.stderr);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /INVALID_INPUT/);
    assert.match(result.stderr, /singals/);
  }

  const valid = JSON.stringify({
    runtime: 'codex', role: 'executor', signals: { critical: true }, dispatch_id: 'critical-json',
  });
  for (const [args, input] of [[[valid], undefined], [[], valid]]) {
    const result = cli(args, input);
    assert.equal(result.status, 0, result.stderr);
    const decision = JSON.parse(result.stdout);
    assert.equal(decision.rung, 'critical');
    assert.equal(decision.model, 'gpt-6.1-sol');
    assert.equal(decision.dispatch_id, 'critical-json');
  }
});

test('custom or malformed palettes cannot be sanitized or mutated into routed selection', () => {
  for (const namespace of ['pipeline', 'delivery_pipeline']) {
    for (const value of [null, [], 'bogus', ['custom-model'], [{ model: 'custom-model', effort: 'high' }]]) {
      const raw = { [namespace]: { codex_models: value } };
      const { config } = routedConfig(raw);
      refusesSource(() => resolveDispatch({ config, role: 'executor' }), `${namespace}.codex_models`);
      assert.doesNotThrow(() => withRaw(raw));
      const claude = routedConfig(raw, 'claude').config;
      assert.equal(resolveDispatch({ config: claude, role: 'executor' }).model, 'claude-sonnet-5-5');
    }
  }
  const { config } = routedConfig();
  config.codex_models[0].model = 'custom-model';
  refusesSource(() => resolveDispatch({ config, role: 'executor' }), 'config.codex_models');
});

test('Codex remaps validate the selected tier without rejecting unrelated tiers', () => {
  for (const namespace of ['model_policy', 'model_profile_overrides']) {
    const tiers = { sol: 'gpt-6.1-sol', opus: 'gpt-6-astra', haiku: 'unrelated' };
    const raw = namespace === 'model_policy'
      ? { model_policy: { runtime_tiers: { codex: tiers } } }
      : { model_profile_overrides: { codex: tiers } };
    const { config } = routedConfig(raw);
    assert.equal(resolveDispatch({ config, role: 'executor' }).model, 'gpt-6.1-sol');
    assert.equal(resolveDispatch({ config, role: 'executor', signals: { critical: true } }).model, 'gpt-6.1-sol');
    assert.doesNotThrow(() => resolveDispatch({ config, role: 'research' }));
  }
});

test('native Codex remaps validate model and compound effort assertions', () => {
  for (const namespace of ['model_policy', 'model_profile_overrides']) {
    const wrap = (tiers) => namespace === 'model_policy'
      ? { model_policy: { runtime_tiers: { codex: tiers } } }
      : { model_profile_overrides: { codex: tiers } };
    const prefix = namespace === 'model_policy'
      ? 'config.model_policy.runtime_tiers.codex' : 'config.model_profile_overrides.codex';
    for (const role of ['executor', 'pr-sentinel', 'research']) {
      const expected = canonicalPolicy.resolveDispatch({ runtime: 'codex', role });
      const key = expected.model_key;
      for (const entry of ['remapped-agent', { model: expected.model, effort: 'ultra' }]) {
        const { config } = routedConfig(wrap({ [key]: entry }));
        refusesSource(() => resolveDispatch({ config, role }), `${prefix}.${key}`);
      }
      const { config } = routedConfig(wrap({ [key]: { model: expected.model, effort: expected.effort } }));
      assert.deepStrictEqual(resolveDispatch({ config, role }), expected);
    }
  }
});

test('obsolete compatibility palettes fail closed at the routed boundary', () => {
  for (const namespace of ['pipeline', 'delivery_pipeline']) {
    const { config } = routedConfig({ [namespace]: {
      codex_models: [{ model: 'gpt-6-sol', effort: 'high' }, { model: 'gpt-6-sol', effort: 'xhigh' }],
    } });
    refusesSource(() => resolveDispatch({ config, role: 'executor' }), `${namespace}.codex_models`);
  }
});

test('unconfigured projects inspect inherited GSD selection and reject conflicting defaults', () => {
  for (const raw of [{ model_profile: 'inherit' }, { model_overrides: { 'gsd-planner': 'opus' } },
    { model_profile: 'balanced' }]) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-inherited-project-'));
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-inherited-home-'));
    fs.mkdirSync(path.join(home, '.gsd'));
    fs.writeFileSync(path.join(home, '.gsd', 'defaults.json'), JSON.stringify(raw));
    const { config } = loadConfig(dir, { routed: true, runtime: 'codex', env: { GSD_HOME: home } });
    if (raw.model_profile === 'balanced') {
      assert.equal(resolveDispatch({ config, role: 'decomposition' }).model, 'gpt-6.1-sol');
    } else {
      refusesSource(() => resolveDispatch({ config, role: 'decomposition' }),
        raw.model_profile ? 'config.model_profile' : 'config.model_overrides.gsd-planner');
    }
  }
});

test('code_review defaults to hold, accepts report and warns on unknown values', () => {
  assert.strictEqual(withConfig(undefined).config.code_review, 'hold');
  for (const mode of ['report', 'hold']) {
    const result = withRaw({ delivery_pipeline: { code_review: mode } });
    assert.strictEqual(result.config.code_review, mode);
    assert.deepStrictEqual(result.warnings, []);
  }
  const bad = withRaw({ delivery_pipeline: { code_review: 'waive' } });
  assert.strictEqual(bad.config.code_review, 'hold');
  assert.ok(bad.warnings.some(warning => /code_review.*hold/.test(warning)));
  const capability = require('../../capabilities/delivery-pipeline/capability.json');
  const key = capability.config['delivery_pipeline.code_review'];
  assert.strictEqual(key.type, 'string'); assert.strictEqual(key.default, 'hold');
  assert.ok(/hold/.test(key.description) && /project root/.test(key.description));
});

done();
