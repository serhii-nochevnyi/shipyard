'use strict';

// The model policy used to live only as prose in the skills, which is how it came
// to specify model values the Agent tool rejects. These tests pin the two
// properties that matter: only tier aliases are ever emitted, and judgment roles
// are never cheapened by configuration.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { suite, test, done, assert } = require('./assert-harness.cjs');

const mod = path.join(__dirname, '..', '..', 'plugins', 'delivery-pipeline', 'scripts', 'pipeline-config.cjs');
const {
  loadConfig, resolveModel, resolveEffort, strategyFor, fableRoute, signalGaps,
  TIERS, EFFORTS, DEFAULTS, ROLES, SIGNATURE_STATES, DEFAULT_CODEX_MODELS, SONNET_ROLES,
} = require(mod);
const sigMod = path.join(__dirname, '..', '..', 'plugins', 'delivery-pipeline', 'scripts', 'failure-signature.cjs');

function withConfig(pipeline) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-cfg-'));
  fs.mkdirSync(path.join(dir, '.planning'), { recursive: true });
  if (pipeline !== undefined) {
    fs.writeFileSync(path.join(dir, '.planning', 'config.json'), JSON.stringify({ pipeline }, null, 2));
  }
  return loadConfig(dir);
}

// write an arbitrary config.json (to cover GSD's own top-level keys)
function withRaw(raw) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-cfg-'));
  fs.mkdirSync(path.join(dir, '.planning'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.planning', 'config.json'), JSON.stringify(raw, null, 2));
  return loadConfig(dir);
}

suite('loadConfig');

test('no config file → defaults, no warnings', () => {
  const { config, warnings } = withConfig(undefined);
  assert.strictEqual(config.integration_mode, 'epic-stacked');
  assert.strictEqual(config.model_policy, 'balanced');
  assert.strictEqual(config.max_attempts, 5);
  assert.deepStrictEqual(warnings, []);
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

test('malformed JSON degrades to defaults with a warning, never throws', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-cfg-'));
  fs.mkdirSync(path.join(dir, '.planning'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.planning', 'config.json'), '{broken');
  const { config, warnings } = loadConfig(dir);
  assert.strictEqual(config.model_policy, 'balanced');
  assert.ok(warnings.some((w) => /not valid JSON/.test(w)));
});

test('jira defaults are present and unknown jira keys warn', () => {
  const { config, warnings } = withConfig({ jira: { project: 'MYD', nonsense: 1 } });
  assert.strictEqual(config.jira.project, 'MYD');
  assert.strictEqual(config.jira.issue_type, 'Task');
  assert.ok(warnings.some((w) => /pipeline\.jira key "nonsense"/.test(w)));
});

suite('resolveModel — only tier aliases, ever');

const ALL_ROLES = ['integrator', 'arch-review', 'executor', 'ci-fix', 'review-fix', 'drift-check', 'research'];

test('every role × profile × risk combination returns a valid tier alias', () => {
  for (const profile of ['economy', 'balanced', 'premium']) {
    for (const role of ALL_ROLES) {
      for (const risk of ['low', 'medium', 'high']) {
        for (const attempt of [1, 2, 5]) {
          const got = resolveModel(role, { risk, attempt, files: 1, type: 'implementation' },
            { ...DEFAULTS, model_policy: profile, models: {} });
          assert.ok(TIERS.includes(got), `${profile}/${role}/${risk}/${attempt} → ${got}`);
        }
      }
    }
  }
});

suite('the floor is opus, with two named exemptions (ADR-005 D1, amended D2)');

const cfg = (over = {}) => ({ ...DEFAULTS, models: {}, ...over });

// THE TIER MATRIX, EXHAUSTIVELY. Every role at every risk, with and without every
// signal the resolver reads: `opus` for all of them except `pr-sentinel` and
// `drift-check`, which are `sonnet` under every one of those combinations, and
// `haiku`, which no built-in path returns at all. Read this beside SONNET_ROLES
// in pipeline-config.cjs — the two exemptions carry their reason there, because a
// bare exemption is the thing a later reader deletes.
const SONNET_EXEMPT = new Set(['pr-sentinel', 'drift-check']);
const EVERY_SIGNAL = [
  {},
  { risk: 'low' }, { risk: 'medium' }, { risk: 'high' },
  { checkpoint: true }, { risk: 'high', checkpoint: true },
  { type: 'research' }, { type: 'alternatives' }, { type: 'implementation' },
  { files: 1 }, { files: 2 }, { files: 9 },
  { codeChange: false }, { codeChange: true },
  { attempt: 5, previousFailed: true },
  { signatureState: 'first' }, { signatureState: 'progress' }, { signatureState: 'repeat' },
  { signatureState: 'flake_candidate' }, { signatureState: 'plan_defect' },
  { inputTokens: 1000 }, { inputTokens: 250000 },
];

test('every role at every risk under every signal: opus, or sonnet for the two exempt', () => {
  for (const profile of ['economy', 'balanced', 'premium']) {
    for (const role of ROLES) {
      for (const risk of ['low', 'medium', 'high']) {
        for (const extra of EVERY_SIGNAL) {
          const want = SONNET_EXEMPT.has(role) ? 'sonnet' : 'opus';
          const got = resolveModel(role, { risk, ...extra }, cfg({ model_policy: profile }));
          assert.strictEqual(got, want,
            `${profile}/${role}/${risk}/${JSON.stringify(extra)} → ${got}, wanted ${want}`);
        }
      }
    }
  }
});

test('haiku is returned by no built-in path at all — that is the whole of "the floor"', () => {
  for (const profile of ['economy', 'balanced', 'premium']) {
    for (const role of ROLES) {
      for (const risk of ['low', 'medium', 'high']) {
        for (const extra of EVERY_SIGNAL) {
          assert.notStrictEqual(
            resolveModel(role, { risk, ...extra }, cfg({ model_policy: profile })), 'haiku',
            `${profile}/${role}/${risk}/${JSON.stringify(extra)}`);
        }
      }
    }
  }
  // It stays a VALUE a user may configure, which is why TIERS keeps it.
  assert.ok(TIERS.includes('haiku'));
  assert.strictEqual(resolveModel('executor', { risk: 'high' }, cfg({ models: { executor: 'haiku' } })), 'haiku');
});

test('the rows that used to be sonnet, named one by one', () => {
  // Each of these returned `sonnet` before ADR-005 D1, and each is the reason a
  // wrong green could reach an epic on a cheaper model than the gate above it.
  assert.strictEqual(resolveModel('executor', { risk: 'low', files: 2 }, cfg()), 'opus', 'the executor light path');
  assert.strictEqual(resolveModel('executor', { risk: 'low', files: 9, type: 'research' }, cfg()), 'opus');
  assert.strictEqual(resolveModel('executor', { risk: 'medium' }, cfg({ model_policy: 'economy' })), 'opus');
  assert.strictEqual(resolveModel('ci-fix', { risk: 'low' }, cfg()), 'opus', 'a lint fix is still a code change');
  assert.strictEqual(resolveModel('review-fix', { codeChange: false }, cfg()), 'opus', 'a reply is still a judgement');
  assert.strictEqual(resolveModel('research', { type: 'facts' }, cfg()), 'opus');
});

test('the two exemptions hold at high risk and under a checkpoint — the reason is not the stakes', () => {
  // pr-sentinel's merge decision is enforced by sentinel.cjs against live GitHub,
  // so raising the model does not make the gate stricter; drift-check returns a
  // file list. Together they are 57% of all dispatches in the journal, which is
  // why the exemption is worth having at all.
  for (const signals of [{ risk: 'high' }, { checkpoint: true }, { risk: 'high', checkpoint: true }]) {
    assert.strictEqual(resolveModel('pr-sentinel', signals, cfg()), 'sonnet', JSON.stringify(signals));
    assert.strictEqual(resolveModel('drift-check', signals, cfg()), 'sonnet', JSON.stringify(signals));
  }
  assert.strictEqual(resolveModel('drift-check', {}, cfg({ model_policy: 'premium' })), 'sonnet');
});

test('the two judgment roles can never join the exempt set', () => {
  // JUDGMENT_ROLES decides no TIER any more (the floor covers every role) and has
  // one reader left, R3. The other half of what that set used to mean lives here:
  // there is no mechanical safety net above a verdict, which is exactly the
  // opposite of what makes pr-sentinel and drift-check exemptible.
  for (const judge of ['arch-review', 'integrator']) {
    assert.ok(!SONNET_ROLES.has(judge), judge);
  }
  assert.deepStrictEqual([...SONNET_ROLES.keys()].sort(), ['drift-check', 'pr-sentinel']);
  for (const [role, why] of SONNET_ROLES) {
    assert.ok(why && why.length > 40, `${role}: the exemption must carry its reason, not just its name`);
  }
});

test('the profile no longer moves the ladder in either direction — the floor is not a preference', () => {
  // `model_policy` survives because gsd-tune mirrors it onto GSD's own
  // `model_profile`, which governs GSD's agents. It routes none of ours.
  for (const role of ROLES) {
    const balanced = resolveModel(role, { risk: 'medium' }, cfg());
    for (const profile of ['economy', 'premium']) {
      assert.strictEqual(resolveModel(role, { risk: 'medium' }, cfg({ model_policy: profile })), balanced,
        `${role} moved under ${profile}`);
    }
  }
});

test('an explicit per-role override still wins over the floor', () => {
  assert.strictEqual(resolveModel('executor', { risk: 'high' }, cfg({ models: { executor: 'sonnet' } })), 'sonnet');
  assert.strictEqual(resolveModel('drift-check', {}, cfg({ models: { 'drift-check': 'opus' } })), 'opus');
});

test('the attempt count still decides nothing (ADR-001 D1)', () => {
  // Raising the model on a repeat is "try harder", and the loss it produced is
  // one wrong hypothesis re-tried by three models in sequence (phase 19, T-19-05:
  // four attempts, three escalations, one deterministically failing job).
  assert.strictEqual(resolveModel('ci-fix', { attempt: 5, previousFailed: true }, cfg()),
    resolveModel('ci-fix', {}, cfg()));
});

suite('fable — the alias that expresses "top tier with a 1M window"');

test('fable is a valid tier value', () => {
  assert.ok(TIERS.includes('fable'));
});

test('fable is accepted as a per-role override (the old opus[1m] intent)', () => {
  const { config, warnings } = withConfig({ models: { integrator: 'fable', 'arch-review': 'fable' } });
  assert.strictEqual(config.models.integrator, 'fable');
  assert.deepStrictEqual(warnings, []);
  assert.strictEqual(resolveModel('integrator', {}, config), 'fable');
});

test('fable is NOBODY\'s default — not even the integrator, and not on Claude with consent', () => {
  // It was the standing default for the two judgment roles on the window
  // argument. ADR-005 retired that on a measurement: the largest input in the
  // whole system is the phase epic diff at ~52k tokens, and the integrator's one
  // run on 2026-09-08 consumed 291k end to end against `fable` costing exactly
  // 2× `opus` on every component. So the window has to be MEASURED per dispatch
  // (R1), not assumed per role — and `--input-tokens` is absent here.
  for (const profile of ['economy', 'balanced', 'premium']) {
    for (const role of ROLES) {
      const c = { ...cfg({ model_policy: profile }), fable: 'auto', gsd: { runtime: 'claude' } };
      for (const signals of [{}, { risk: 'high' }, { risk: 'high', attempt: 3 }, { checkpoint: true }]) {
        assert.notStrictEqual(resolveModel(role, signals, c), 'fable',
          `${profile}/${role}/${JSON.stringify(signals)} defaulted to fable`);
      }
    }
  }
});

test('the integrator has no standing exception any more: opus/xhigh with no flags', () => {
  // The sentence that justified the exception — "it reads the largest input in
  // the system, runs once per phase, and is the last mechanical judgment before a
  // person merges" — is all true and none of it a measurement. What survives of
  // it is the EFFORT: xhigh, and it never drops.
  const c = { ...cfg(), fable: 'auto', gsd: { runtime: 'claude' } };
  assert.strictEqual(resolveModel('integrator', {}, c), 'opus');
  assert.strictEqual(resolveEffort('integrator', 'opus', c, {}), 'xhigh');
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

suite('resolveEffort — the role-keyed table (ADR-005 D2 as amended 2026-09-08)');

test('every role × model returns an effort Workflow accepts', () => {
  for (const role of ALL_ROLES) {
    for (const model of TIERS) {
      assert.ok(EFFORTS.includes(resolveEffort(role, model, cfg())), `${role}/${model}`);
    }
  }
});

// THE EFFORT TABLE, EXHAUSTIVELY — one row per (role, signal) so a later edit
// cannot move a row quietly. Read it beside EFFORT_ROWS in pipeline-config.cjs:
// the two are meant to be legible side by side.
//
//   role          signals                       effort
const EFFORT_MATRIX = [
  ['drift-check', {},                            'high'],   // was `low`: it now carries the plan-defect burden
  ['drift-check', { risk: 'high' },              'high'],
  ['drift-check', { signatureState: 'repeat' },  'high'],   // not a repair role; history does not deepen it
  ['research',    {},                            'high'],
  ['research',    { type: 'facts' },             'high'],
  ['research',    { type: 'alternatives' },      'xhigh'],  // option design, not fact gathering
  ['executor',    {},                            'high'],
  ['executor',    { risk: 'low' },               'high'],
  ['executor',    { risk: 'medium' },            'high'],
  ['executor',    { risk: 'medium', files: 1 },  'high'],   // `files` is inert now
  ['executor',    { risk: 'high' },              'xhigh'],  // a defect here is expensive, not merely possible
  ['executor',    { checkpoint: true },          'xhigh'],
  ['executor',    { risk: 'low', checkpoint: true }, 'xhigh'],
  ['ci-fix',      {},                            'high'],
  ['ci-fix',      { risk: 'high' },              'high'],
  ['ci-fix',      { signatureState: 'first' },   'high'],
  ['ci-fix',      { signatureState: 'progress' }, 'high'],
  ['review-fix',  {},                            'high'],
  ['review-fix',  { codeChange: false },         'high'],   // `codeChange` is inert now
  ['review-fix',  { codeChange: true },          'high'],
  ['pr-sentinel', {},                            'high'],   // NOT xhigh: sentinel.cjs is the gate, not the model
  ['pr-sentinel', { risk: 'high' },              'high'],
  ['pr-sentinel', { checkpoint: true },          'high'],
  ['arch-review', {},                            'xhigh'],
  ['arch-review', { risk: 'low' },               'xhigh'],
  ['integrator',  {},                            'xhigh'],
  ['integrator',  { risk: 'low' },               'xhigh'],
  // The one built-in path to `max`, and it is EARNED by a repeated failure
  // rather than chosen. `xhigh` stopped being a raise the moment the floor
  // became opus, which is the regression this rung is restored from.
  ['ci-fix',      { signatureState: 'repeat' },  'max'],
  ['review-fix',  { signatureState: 'repeat' },  'max'],
  ['pr-sentinel', { signatureState: 'repeat' },  'max'],
  ['ci-fix',      { signatureState: 'repeat_exhausted' }, 'max'],
];

test('the effort table, row by row', () => {
  for (const [role, signals, want] of EFFORT_MATRIX) {
    const model = resolveModel(role, signals, cfg());
    const got = resolveEffort(role, model, cfg(), signals);
    assert.strictEqual(got, want, `${role} ${JSON.stringify(signals)} → ${got}, wanted ${want}`);
  }
});

test('the judges are xhigh and not max, deliberately', () => {
  // Anthropic's effort guidance names `xhigh` the best setting for most coding
  // and agentic work (it is Claude Code's own default) and says to reach `max`
  // only when measurement shows headroom at the level below. Nothing has measured
  // that here — so `max` stays reserved for the case that IS a measurement.
  for (const role of ['arch-review', 'integrator']) {
    for (const signals of [{}, { risk: 'high' }, { checkpoint: true }, { contested: false }]) {
      assert.strictEqual(resolveEffort(role, resolveModel(role, signals, cfg()), cfg(), signals), 'xhigh',
        `${role} ${JSON.stringify(signals)}`);
    }
  }
});

test('effort no longer follows the MODEL — that dependency is what collapsed', () => {
  // Measured 2026-09-07 with the floor set through `pipeline.models.*`: the old
  // rule read `TOP_TIERS.has(model) → heavy`, so with the tier constant every
  // role except drift-check resolved to xhigh and `--signature-state repeat`
  // stopped deepening anything. The model argument is still accepted and drives
  // nothing, which is what these four assertions pin.
  for (const model of TIERS) {
    assert.strictEqual(resolveEffort('ci-fix', model, cfg()), 'high', model);
    assert.strictEqual(resolveEffort('drift-check', model, cfg()), 'high', model);
  }
});

test('a per-role effort override wins', () => {
  const { config } = withConfig({ effort: { executor: 'max' } });
  assert.strictEqual(resolveEffort('executor', 'sonnet', config), 'max');
});

test('minimal clamps to low (not in Workflow\'s enum); max is no longer clamped on codex', () => {
  const minimal = withConfig({ effort: { executor: 'minimal' } });
  assert.strictEqual(resolveEffort('executor', 'sonnet', minimal.config), 'low');
  const minimalOnCodex = withRaw({ runtime: 'codex', pipeline: { effort: { executor: 'minimal' } } });
  assert.strictEqual(resolveEffort('executor', 'sonnet', minimalOnCodex.config), 'low');
  // ADR-005 D7: both halves of the old clamp's justification were false. GSD's
  // `codexModelEffort._baseline` advertises `max` for every model, and
  // `advertisedCodexEffort` hands that baseline back for a model it does not
  // name — which the palette's ceiling is. No built-in path asks for `max`
  // there, so the clamp only ever rewrote an operator's explicit choice.
  const onCodex = withRaw({ runtime: 'codex', pipeline: { effort: { executor: 'max' } } });
  assert.strictEqual(resolveEffort('executor', 'sonnet', onCodex.config), 'max');
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

suite('pr-sentinel model routing');

test('the guard stays on sonnet at every risk — and that is a reversal of the floor', () => {
  // The exemption is about WHAT DECIDES, not about what is at stake: the merge
  // gate is re-verified against live GitHub inside sentinel.cjs, which refuses on
  // anything unproven, so a bigger model does not make it stricter. It is also
  // 44% of all dispatches, which is why the exemption is worth its explanation.
  const { config } = withConfig(undefined);
  assert.ok(SONNET_ROLES.has('pr-sentinel'), 'and the reason travels with it, in code');
  for (const signals of [{}, { attempt: 2 }, { risk: 'high' }, { checkpoint: true },
    { risk: 'high', checkpoint: true }, { signatureState: 'repeat' }]) {
    assert.strictEqual(resolveModel('pr-sentinel', signals, config), 'sonnet', JSON.stringify(signals));
  }
});

test('it is a real role, so an override for it is honoured rather than warned away', () => {
  const { config, warnings } = withConfig({ models: { 'pr-sentinel': 'opus' } });
  assert.strictEqual(resolveModel('pr-sentinel', {}, config), 'opus');
  assert.deepStrictEqual(warnings, []);
  assert.ok(EFFORTS.includes(resolveEffort('pr-sentinel', 'opus', config)));
});

suite('model ladder — the top tier is runtime-aware');

// `fable` is Opus-tier WITH a 1M window, and only the Claude runtime has it.
// GSD's tier vocabulary is opus|sonnet|haiku, and the Codex agent files are
// rendered through that map, so asking for `fable` there would emit a model id
// nobody can resolve.
const asRuntime = (config, runtime) => ({ ...config, gsd: { ...(config.gsd || {}), runtime } });

test('the 1M tier is reached only through a route, and only on Claude', () => {
  // Nothing about the ROLE unlocks it any more; what unlocks it is a measured
  // input, an exhausted repair or a contested verdict — and consent.
  const { config } = withConfig({ fable: 'auto' });
  for (const role of ['arch-review', 'integrator']) {
    assert.strictEqual(resolveModel(role, {}, asRuntime(config, 'claude')), 'opus', `${role} by default`);
    assert.strictEqual(resolveModel(role, { inputTokens: 300000 }, asRuntime(config, 'claude')), 'fable',
      `${role} with a measured input over the threshold`);
  }
});

test('an UNSET runtime degrades to opus rather than guessing the paid tier', () => {
  // The two failures are not equal, so the default is not symmetric: `opus` on
  // Claude costs a smaller window on work that usually fits, while `fable` on
  // Codex is a model id nothing resolves. The 1M tier is taken only where the
  // runtime says it exists — which is why `runtime` is in gsd-tune's REQUIRED
  // group rather than its tuning half.
  const { config } = withConfig({});
  for (const role of ['arch-review', 'integrator']) {
    assert.strictEqual(resolveModel(role, {}, asRuntime(config, null)), 'opus', role);
  }
});

test('on Codex NO role resolves to the premium TIER — the palette decides the model', () => {
  // GSD gives its top Codex model to exactly two of 34 agents, both planners;
  // its reviewer, executor, fixer and debugger are all on the workhorse. The
  // conveyor has no planner among its ROLES (decomposition is the main loop's),
  // so a straight tier-for-tier mapping was not the same policy on another
  // runtime — it was a more expensive one. What the cap decides is the TIER the
  // generator renders a palette entry for; which concrete model that is comes
  // from `pipeline.codex_models`, and the escalation from its ceiling.
  const { config } = withConfig({});
  const codex = asRuntime(config, 'codex');
  for (const role of ['arch-review', 'integrator', 'executor', 'review-fix']) {
    const m = resolveModel(role, { risk: 'high' }, codex);
    assert.ok(!['opus', 'fable'].includes(m), `${role} must not take the premium tier, got ${m}`);
  }
  for (const role of ['arch-review', 'integrator']) {
    assert.strictEqual(resolveEffort(role, resolveModel(role, {}, codex), codex, {}), 'high',
      `${role}: the working effort, which on this runtime is the deepest one measured to pay`);
  }
});

test('ADR-005 D4 — the judges default to the floor, and Codex gets the capped tier', () => {
  // The reversal of ADR-003 D3, as a test. `fable` was the judges' default on the
  // window argument until the window was measured: the ADR corpus is ~8k tokens,
  // the largest ticket diff of the phase ~16k, the phase epic diff ~52k. Nothing
  // is configured on purpose — an override would prove only that overrides work.
  const { config, warnings } = withConfig({});
  assert.deepStrictEqual(warnings, []);
  assert.strictEqual(config.models['arch-review'], undefined, 'no override — the LADDER decides');
  assert.strictEqual(config.models.integrator, undefined, 'no override — the LADDER decides');
  assert.strictEqual(config.fable, 'off', 'and the ceiling is shut until a person opens it');
  for (const role of ['arch-review', 'integrator']) {
    assert.strictEqual(resolveModel(role, {}, asRuntime(config, 'claude')), 'opus',
      `${role}: the floor with nothing configured, on the runtime that HAS the 1M tier`);
    // The exact capped value, not merely "not the premium tier": what the Codex
    // generator renders is a palette entry for THIS alias, so a change of cap has
    // to be a change of test.
    assert.strictEqual(resolveModel(role, {}, asRuntime(config, 'codex')), 'sonnet',
      `${role}: the workhorse tier, because the premium one is not the policy there`);
  }
});

test('on Codex the effort axis is two values wide — the escalation is the MODEL', () => {
  // ADR-005 D6: measured, not assumed. `xhigh` and `max` cost more there without
  // a better result, and the ceiling model's best results are at `high`. So the
  // ladder that expresses depth through effort does not apply on this runtime,
  // and neither risk nor a repeating signature deepens anything: what escalates
  // is the model, through a second agent FILE per repair role (D8). The strategy
  // half of the repeat rule survives untouched — that is the part that changes
  // the hypothesis rather than the spend.
  const { config } = withConfig({});
  const codex = asRuntime(config, 'codex');
  const at = (signatureState) => resolveEffort(
    'ci-fix', resolveModel('ci-fix', { signatureState }, codex), codex, { signatureState });
  assert.strictEqual(at('first'), 'high', 'first strike');
  assert.strictEqual(at('repeat'), 'high', 'no deeper rung to escalate into');
  assert.strictEqual(strategyFor('repeat'), 'rethink', 'the strategy still changes');
  const risky = { risk: 'high' };
  assert.strictEqual(resolveEffort('ci-fix', resolveModel('ci-fix', risky, codex), codex, risky), 'high');
  // The one distinction that remains on the axis: the mechanical role stays cheap.
  assert.strictEqual(resolveEffort('drift-check', resolveModel('drift-check', {}, codex), codex, {}), 'low');
});

test('an explicit effort override still outranks the flat axis', () => {
  // Otherwise the rule that exists to stop us paying for depth we did not
  // measure would also silence a person who measured something else.
  const onCodex = withRaw({ runtime: 'codex', pipeline: { effort: { 'arch-review': 'xhigh' } } });
  assert.strictEqual(resolveEffort('arch-review', 'sonnet', onCodex.config), 'xhigh');
});

test('an executor whose baseline was already top tier is NOT treated as escalated', () => {
  // The distinction is "did the ladder raise this above its own baseline", not
  // "is the uncapped tier a top one" — otherwise every executor reads as a
  // failed repair and the whole capped ladder flattens to xhigh.
  const { config } = withConfig({});
  const codex = asRuntime(config, 'codex');
  const sig = { risk: 'high' };
  assert.strictEqual(resolveEffort('executor', resolveModel('executor', sig, codex), codex, sig), 'high');
});

test('no OTHER role is silently upgraded to the paid tier', () => {
  // The decision was "context-bound judges only" — an executor on a three-file
  // ticket gains nothing from a 1M window and must not be billed for one.
  const { config } = withConfig({});
  const c = asRuntime(config, 'claude');
  for (const role of ['executor', 'ci-fix', 'review-fix', 'pr-sentinel', 'drift-check', 'research']) {
    assert.notStrictEqual(resolveModel(role, { risk: 'high', attempt: 3 }, c), 'fable', role);
  }
});

test('a judge on the 1M tier still thinks at its own row, not deeper', () => {
  const { config } = withConfig({});
  assert.strictEqual(resolveEffort('arch-review', 'fable', asRuntime(config, 'claude')), 'xhigh');
});

test('premium reaches the paid tier for nobody — the profile cannot buy the ceiling', () => {
  const { config } = withConfig({ model_policy: 'premium', fable: 'auto' });
  const c = asRuntime(config, 'claude');
  for (const role of ROLES) {
    assert.strictEqual(resolveModel(role, { risk: 'high' }, c),
      SONNET_ROLES.has(role) ? 'sonnet' : 'opus', role);
  }
});

test('an explicit override still wins over the runtime default', () => {
  const { config, warnings } = withConfig({ models: { 'arch-review': 'sonnet' } });
  assert.deepStrictEqual(warnings, []);
  assert.strictEqual(resolveModel('arch-review', {}, asRuntime(config, 'claude')), 'sonnet');
});

suite('the repair ladder reads the failure SIGNATURE, not the attempt count (ADR-001 D1)');

const REPAIR_ROLES = ['ci-fix', 'review-fix', 'pr-sentinel'];

test('attempt and previousFailed are inert for every repair role', () => {
  // The removed behaviour is pinned as ABSENT, not merely the new one as present:
  // `attempt >= 2 -> opus` is the rejected "try harder" (ADR-001, Rejected).
  for (const role of REPAIR_ROLES) {
    for (const risk of ['low', 'medium', 'high']) {
      const baseline = resolveModel(role, { risk }, cfg());
      for (const extra of [{ attempt: 2 }, { attempt: 9 }, { previousFailed: true }, { attempt: 4, previousFailed: true }]) {
        const got = resolveModel(role, { risk, ...extra }, cfg());
        assert.strictEqual(got, baseline, `${role}/${risk}/${JSON.stringify(extra)} moved the tier`);
      }
    }
  }
});

test('risk no longer raises a repair tier — the floor got there first', () => {
  assert.strictEqual(resolveModel('ci-fix', { risk: 'high' }, cfg()), 'opus');
  assert.strictEqual(resolveModel('ci-fix', { risk: 'low' }, cfg()), 'opus');
  assert.strictEqual(resolveModel('review-fix', { codeChange: false }, cfg()), 'opus');
  assert.strictEqual(resolveModel('review-fix', {}, cfg()), 'opus');
  // What risk moves now is the DEPTH, and only for the executor (see EFFORT_MATRIX).
  assert.strictEqual(resolveEffort('ci-fix', 'opus', cfg(), { risk: 'high' }), 'high');
});

test('only one signature state moves the TIER, and only through the ceiling', () => {
  // Every other state holds it: a repeat changes the STRATEGY and the depth, not
  // the model, because a bigger model on the hypothesis that just failed is the
  // failure mode rather than the remedy (ADR-001 D1). `repeat_exhausted` is the
  // one exception, and it is the ceiling's own route (R2) rather than a repair
  // rung — the deeper effort has already been spent by then.
  for (const role of REPAIR_ROLES) {
    for (const risk of ['low', 'medium', 'high']) {
      const baseline = resolveModel(role, { risk }, cfg());
      for (const signatureState of SIGNATURE_STATES) {
        const got = resolveModel(role, { risk, signatureState }, cfg());
        assert.ok(TIERS.includes(got), `${got} is not a tier alias`);
        if (signatureState === 'repeat_exhausted') continue;
        assert.strictEqual(got, baseline, `${role}/${risk}/${signatureState} moved the tier`);
      }
    }
  }
});

test('the state vocabulary is failure-signature.cjs verbatim — one enum, two files', () => {
  // A synonym or a seventh word here is a silent no-op in whatever reads it, so
  // the coupling is asserted rather than commented.
  const { VERDICTS } = require(sigMod);
  assert.deepStrictEqual(SIGNATURE_STATES, VERDICTS);
});

test('every state maps to exactly the strategy the loop switches on', () => {
  assert.deepStrictEqual(
    Object.fromEntries(SIGNATURE_STATES.map((s) => [s, strategyFor(s)])),
    {
      first: 'fix',
      progress: 'continue',
      repeat: 'rethink',
      // Deliberately the SAME verb: what changes on an exhausted repeat is the
      // model, and the advice to the fixer is unchanged. A seventh verb would be
      // a contract only the resolver knew about — references/ci-fix.md and
      // references/pr-sentinel.md are what a fixer actually reads.
      repeat_exhausted: 'rethink',
      flake_candidate: 'rerun',
      flake: 'quarantine',
      plan_defect: 'park',
    },
  );
});

test('an unknown state has no strategy — it is ignored, never guessed', () => {
  for (const bogus of ['bogus', '', 'REPEAT', undefined, null]) {
    assert.strictEqual(strategyFor(bogus), undefined, String(bogus));
  }
  // and nothing reaches through Object.prototype
  assert.strictEqual(strategyFor('toString'), undefined);
  assert.strictEqual(strategyFor('constructor'), undefined);
});

test('repeat deepens the EFFORT to max at the held tier — the rung the floor had erased', () => {
  // THE MEASUREMENT THAT MADE THIS TICKET. On 2026-09-07, with the floor set
  // through `pipeline.models.*`, every role except drift-check resolved to
  // opus/xhigh — so `--signature-state repeat` raised the effort to a value it
  // already had, and the repair ladder's depth rung was silently gone. `max` is
  // the restored rung, and it is the only built-in path to `max`.
  for (const role of REPAIR_ROLES) {
    const signals = { signatureState: 'repeat' };
    assert.strictEqual(
      resolveEffort(role, resolveModel(role, signals, cfg()), cfg(), signals), 'max', role);
    assert.notStrictEqual(
      resolveEffort(role, resolveModel(role, {}, cfg()), cfg(), { signatureState: 'first' }), 'max',
      `${role}: a first strike must not already be at the deepest rung, or the raise is not a raise`);
  }
  // ci-fix in particular: same tier as a first strike, deeper thinking on it
  assert.strictEqual(resolveModel('ci-fix', { signatureState: 'repeat' }, cfg()), 'opus');
  assert.strictEqual(resolveEffort('ci-fix', 'opus', cfg(), { signatureState: 'first' }), 'high');
  assert.strictEqual(resolveEffort('ci-fix', 'opus', cfg(), { signatureState: 'progress' }), 'high');
});

test('a non-repair role is not deepened by a signature state', () => {
  const signals = { risk: 'low', files: 1, signatureState: 'repeat' };
  assert.strictEqual(resolveModel('executor', signals, cfg()), 'opus');
  assert.strictEqual(resolveEffort('executor', 'opus', cfg(), signals), 'high');
  // an executor has no failure history to read, and drift-check is not a repair
  assert.strictEqual(resolveEffort('drift-check', 'sonnet', cfg(), { signatureState: 'repeat' }), 'high');
});

test('an explicit effort override still outranks the repeat rule', () => {
  const { config } = withConfig({ effort: { 'ci-fix': 'low' } });
  assert.strictEqual(resolveEffort('ci-fix', 'sonnet', config, { signatureState: 'repeat' }), 'low');
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
  const r = spawnSync(process.execPath, [mod, ...args], { cwd: dir, encoding: 'utf8' });
  return { status: r.status, out: (r.stdout || '').trim(), err: r.stderr || '', json: () => JSON.parse(r.stdout) };
}
// The ceiling exists only where the runtime declares the 1M tier AND a person has
// consented, so every route test needs both. Anything less is the DEGRADED path,
// which is asserted separately — on purpose: that asymmetry is the design.
const CONSENTED = { runtime: 'claude', pipeline: { fable: 'auto' } };

test('without --signature-state the --json shape is unchanged from today', () => {
  const r = runCli(['model', 'ci-fix', '--json']);
  assert.strictEqual(r.status, 0, r.err);
  assert.deepStrictEqual(Object.keys(r.json()).sort(), ['effort', 'model']);
  assert.deepStrictEqual(r.json(), { model: 'opus', effort: 'high' });
});

test('--attempt/--previous-failed are still accepted and resolve the same tier', () => {
  // deliver.md still documents them and telemetry callers still pass --attempt,
  // so they must keep working — silently, without a deprecation notice.
  const plain = runCli(['model', 'ci-fix', '--json']);
  const withAttempt = runCli(['model', 'ci-fix', '--json', '--attempt', '3', '--previous-failed']);
  assert.strictEqual(withAttempt.status, 0, withAttempt.err);
  assert.deepStrictEqual(withAttempt.json(), plain.json());
  assert.strictEqual(withAttempt.err, '', 'a still-documented flag must not start warning');
  assert.strictEqual(runCli(['model', 'ci-fix', '--risk', 'high']).out, 'opus', 'risk still routes');
});

test('--signature-state repeat: same tier, deeper effort, a strategy to change', () => {
  assert.deepStrictEqual(runCli(['model', 'ci-fix', '--json', '--signature-state', 'repeat']).json(),
    { model: 'opus', effort: 'max', strategy: 'rethink' });
  assert.deepStrictEqual(runCli(['model', 'ci-fix', '--json', '--signature-state', 'first']).json(),
    { model: 'opus', effort: 'high', strategy: 'fix' });
});

test('the three do-not-dispatch states surface as their pinned strings', () => {
  const strategy = (role, state) => runCli(['model', role, '--json', '--signature-state', state]).json().strategy;
  assert.strictEqual(strategy('pr-sentinel', 'plan_defect'), 'park');
  assert.strictEqual(strategy('ci-fix', 'flake'), 'quarantine');
  assert.strictEqual(strategy('ci-fix', 'flake_candidate'), 'rerun');
  assert.strictEqual(strategy('review-fix', 'progress'), 'continue');
});

test('an unknown state warns on stderr, omits strategy, and still exits 0', () => {
  const r = runCli(['model', 'ci-fix', '--json', '--signature-state', 'bogus']);
  assert.strictEqual(r.status, 0, 'a resolver that exits non-zero at 3am stops the round');
  assert.ok(/signature-state/.test(r.err) && /bogus/.test(r.err), r.err);
  assert.deepStrictEqual(Object.keys(r.json()).sort(), ['effort', 'model']);
});

test('--signature-state with no value is the same warn-and-ignore, not a crash', () => {
  const r = runCli(['model', 'ci-fix', '--json', '--signature-state']);
  assert.strictEqual(r.status, 0, r.err);
  assert.ok(/signature-state/.test(r.err), r.err);
  assert.deepStrictEqual(Object.keys(r.json()).sort(), ['effort', 'model']);
});

test('resolve reports the new key', () => {
  const r = runCli(['resolve']);
  assert.strictEqual(r.status, 0, r.err);
  assert.strictEqual(JSON.parse(r.out).config.plan_defect_signatures, 3);
});

suite('the ceiling — three mechanical routes, never a default (ADR-005 D4)');

test('R1 window: a measured input over the threshold earns it; under it does not', () => {
  assert.strictEqual(
    runCli(['model', 'arch-review', '--input-tokens', '300000'], CONSENTED).out, 'fable');
  assert.deepStrictEqual(
    runCli(['model', 'arch-review', '--json', '--input-tokens', '200000'], CONSENTED).json(),
    { model: 'opus', effort: 'xhigh' },
    'under the threshold nothing fired, so the role keeps its own row — xhigh, not max');
  // The threshold is configuration: five times the largest input measured here.
  assert.strictEqual(DEFAULTS.fable_window_tokens, 250000);
  assert.strictEqual(
    runCli(['model', 'arch-review', '--input-tokens', '200000'],
      { runtime: 'claude', pipeline: { fable: 'auto', fable_window_tokens: 150000 } }).out, 'fable');
});

test('R1 is measured per dispatch, so every role can reach it — and none does by default', () => {
  for (const role of ROLES) {
    assert.strictEqual(runCli(['model', role, '--input-tokens', '300000'], CONSENTED).out, 'fable', role);
    assert.notStrictEqual(runCli(['model', role], CONSENTED).out, 'fable', `${role} with no measurement`);
  }
});

test('R2 exhausted depth: the third occurrence of one signature, from the journal', () => {
  const r = runCli(['model', 'ci-fix', '--json', '--signature-state', 'repeat_exhausted'], CONSENTED);
  assert.deepStrictEqual(r.json(), { model: 'fable', effort: 'max', strategy: 'rethink' },
    'the model rises and the depth STAYS at max — backing the thinking off here is neither ladder');
  assert.deepStrictEqual(
    runCli(['model', 'ci-fix', '--json', '--signature-state', 'repeat'], CONSENTED).json(),
    { model: 'opus', effort: 'max', strategy: 'rethink' }, 'a second occurrence is not exhausted');
  // It is a REPAIR route: an executor has no failure history to read.
  assert.strictEqual(
    runCli(['model', 'executor', '--signature-state', 'repeat_exhausted'], CONSENTED).out, 'opus');
  // And the verdict itself comes from failure-signature.cjs, not from a threshold
  // re-implemented here — one subject, one owner.
  const { VERDICTS } = require(sigMod);
  assert.ok(VERDICTS.includes('repeat_exhausted'));
});

test('R3 contested judgment: a verdict that has already been faulted once', () => {
  assert.strictEqual(runCli(['model', 'arch-review', '--contested'], CONSENTED).out, 'fable');
  assert.strictEqual(runCli(['model', 'integrator', '--contested'], CONSENTED).out, 'fable');
  assert.strictEqual(runCli(['model', 'arch-review'], CONSENTED).out, 'opus', 'absent, it cannot fire');
});

test('R3 is scoped to the two judgment roles — one stray flag must not open the ceiling', () => {
  // Both facts that set the flag are a JUDGE's own prior verdict (a journalled
  // `arch_review … verdict=violation`, or an integrator `needs-fix` on this
  // epic). A fixer carrying it is not a re-judgement, and a route any role could
  // open with one flag is not a ceiling that has to be earned.
  for (const role of ROLES) {
    const got = runCli(['model', role, '--contested'], CONSENTED).out;
    if (role === 'arch-review' || role === 'integrator') assert.strictEqual(got, 'fable', role);
    else assert.notStrictEqual(got, 'fable', `${role} reached the ceiling on --contested`);
  }
  assert.strictEqual(fableRoute('executor', { contested: true },
    { ...cfg(), fable: 'auto', gsd: { runtime: 'claude' } }), null);
});

test('with pipeline.fable off or absent, a fired route degrades to opus at max and says why', () => {
  // `off` is the default because an unconsented Fable request in a background
  // session waits out `dialogExpiry` and then ends the turn WITHOUT SENDING:
  // silence is not consent. The escalation still happens, one rung lower, on the
  // axis that IS available.
  for (const raw of [{ runtime: 'claude' }, { runtime: 'claude', pipeline: { fable: 'off' } }]) {
    const r = runCli(['model', 'arch-review', '--json', '--input-tokens', '300000'], raw);
    assert.deepStrictEqual(r.json(), { model: 'opus', effort: 'max' }, JSON.stringify(raw));
    assert.ok(/pipeline\.fable/.test(r.err), `the reason must name the setting: ${r.err}`);
  }
  // Under the threshold nothing fired, so there is nothing to degrade and nothing
  // to report — a warning on every dispatch is how a warning gets ignored.
  const quiet = runCli(['model', 'arch-review', '--json', '--input-tokens', '200000'], { runtime: 'claude' });
  assert.deepStrictEqual(quiet.json(), { model: 'opus', effort: 'xhigh' });
  assert.strictEqual(quiet.err, '', quiet.err);
});

test('a fired route outranks the sonnet exemptions — and degrades the same way when shut', () => {
  // The exemptions say "the model is not the gate here"; a route firing is the
  // measured evidence that on THIS dispatch it is. So the guard leaves its
  // exemption behind — to the ceiling with consent, and to the FLOOR at max
  // without it, never to `sonnet` at max.
  assert.deepStrictEqual(
    runCli(['model', 'pr-sentinel', '--json', '--signature-state', 'repeat_exhausted'], CONSENTED).json(),
    { model: 'fable', effort: 'max', strategy: 'rethink' });
  const shut = runCli(['model', 'pr-sentinel', '--json', '--signature-state', 'repeat_exhausted'],
    { runtime: 'claude' });
  assert.deepStrictEqual(shut.json(), { model: 'opus', effort: 'max', strategy: 'rethink' });
  assert.ok(/pipeline\.fable/.test(shut.err), shut.err);
  // With no route, the exemption holds at every depth.
  assert.deepStrictEqual(
    runCli(['model', 'pr-sentinel', '--json', '--signature-state', 'repeat'], CONSENTED).json(),
    { model: 'sonnet', effort: 'max', strategy: 'rethink' });
});

test('a route on a runtime with no 1M tier degrades the same way, naming the runtime', () => {
  // The asymmetry is deliberate: `opus` instead of `fable` costs a smaller window
  // on work that usually fits, while `fable` off Claude is a model id nothing
  // resolves. On Codex the escalation is a `-deep` agent FILE (ADR-005 D8).
  const unset = runCli(['model', 'arch-review', '--json', '--input-tokens', '300000'],
    { pipeline: { fable: 'auto' } });
  assert.deepStrictEqual(unset.json(), { model: 'opus', effort: 'max' });
  assert.ok(/runtime/.test(unset.err), unset.err);
  const codex = runCli(['model', 'arch-review', '--json', '--input-tokens', '300000'],
    { runtime: 'codex', pipeline: { fable: 'auto' } });
  assert.deepStrictEqual(codex.json(), { model: 'sonnet', effort: 'high' },
    'the capped tier and the flat axis — this runtime\'s own ladder, untouched');
});

test('an override outranks a fired route, and the resolver says so rather than swallowing it', () => {
  // Expressing the floor through `pipeline.models.*` — how it was piloted — is
  // exactly this case, and it would have made every escalation unreachable.
  const r = runCli(['model', 'arch-review', '--input-tokens', '300000'],
    { runtime: 'claude', pipeline: { fable: 'auto', models: { 'arch-review': 'opus' } } });
  assert.strictEqual(r.out, 'opus');
  assert.ok(/outranks it/.test(r.err), r.err);
});

test('fableRoute is a pure function of the signals it is given', () => {
  const consented = { ...cfg(), fable: 'auto', gsd: { runtime: 'claude' } };
  assert.strictEqual(fableRoute('arch-review', {}, consented), null);
  assert.strictEqual(fableRoute('arch-review', { inputTokens: 300000 }, consented).route, 'window');
  assert.strictEqual(fableRoute('ci-fix', { signatureState: 'repeat_exhausted' }, consented).route, 'exhausted');
  assert.strictEqual(fableRoute('integrator', { contested: true }, consented).route, 'contested');
  // Nothing numeric, nothing fires: `Number(undefined)` is NaN and NaN > n is
  // false, which is the shape of the defect this whole rule came from.
  for (const bad of [undefined, '', 'lots', null]) {
    assert.strictEqual(fableRoute('arch-review', { inputTokens: bad }, consented), null, String(bad));
  }
});

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

suite('a signal that is ABSENT must never resolve UPWARD (ADR-004, on the ladder)');

test('the two signals whose rows the floor removed are INERT, not upgrades', () => {
  // The measured defects this rule came from: the executor's light path read
  // `Number(signals.files) <= 2`, false on every dispatch that omitted `--files`,
  // so 173 dispatches all bought the dearer answer; and review-fix's cheap branch
  // read `codeChange === false`, which an ABSENT flag and an explicit "yes, code
  // changed" both satisfied identically. Under the opus floor neither row exists,
  // so the fix is structural rather than a branch: all three values agree.
  for (const files of [undefined, 1, 2, 9, 'not a number']) {
    const signals = { risk: 'medium', files };
    assert.strictEqual(resolveModel('executor', signals, cfg()), 'opus', `files=${files}`);
    assert.strictEqual(resolveEffort('executor', 'opus', cfg(), signals), 'high', `files=${files}`);
  }
  for (const codeChange of [undefined, false, true]) {
    const signals = { codeChange };
    assert.strictEqual(resolveModel('review-fix', signals, cfg()), 'opus', `codeChange=${codeChange}`);
    assert.strictEqual(resolveEffort('review-fix', 'opus', cfg(), signals), 'high', `codeChange=${codeChange}`);
  }
});

test('both spellings of the code-change signal are parsed, so silence is distinguishable', () => {
  // The flag routes nothing now, but "no flag" and "yes, code changed" must stop
  // being the same value on the record: the next row keyed on it would inherit
  // the defect otherwise.
  for (const flags of [[], ['--code-change'], ['--no-code-change']]) {
    assert.deepStrictEqual(runCli(['model', 'review-fix', '--json', ...flags]).json(),
      { model: 'opus', effort: 'high' }, flags.join(' '));
  }
});

test('an absent signal resolves DOWN, for every role and every row it reads', () => {
  // The property, stated over the whole table rather than per case: whatever the
  // dispatch omits, the answer is never dearer than the answer it would have got
  // with the signal supplied.
  const DEARER = ['low', 'medium', 'high', 'xhigh', 'max'];
  const withAll = { risk: 'high', type: 'alternatives', checkpoint: true, inputTokens: 300000, contested: true };
  const consented = { ...cfg(), fable: 'auto', gsd: { runtime: 'claude' } };
  for (const role of ROLES) {
    const bare = resolveEffort(role, resolveModel(role, {}, consented), consented, {});
    const full = resolveEffort(role, resolveModel(role, withAll, consented), consented, withAll);
    assert.ok(DEARER.indexOf(bare) <= DEARER.indexOf(full), `${role}: ${bare} > ${full} with nothing passed`);
    assert.notStrictEqual(resolveModel(role, {}, consented), 'fable', `${role} reached the ceiling on silence`);
  }
});

test('a row a dispatch could not reach for want of a signal is named on stderr', () => {
  // The direction of the warning inverted with the table: a missing signal is no
  // longer a cost surprise, it is a DEPTH the dispatch quietly declined. It still
  // has to be visible in a dispatch line rather than only in a shallow verdict.
  const noRisk = runCli(['model', 'executor', '--json']);
  assert.deepStrictEqual(noRisk.json(), { model: 'opus', effort: 'high' });
  assert.ok(/--risk/.test(noRisk.err) && /xhigh/.test(noRisk.err), noRisk.err);
  const noType = runCli(['model', 'research', '--json']);
  assert.ok(/--type/.test(noType.err), noType.err);
  const noTokens = runCli(['model', 'integrator', '--json']);
  assert.ok(/--input-tokens/.test(noTokens.err), noTokens.err);
  // A dispatch that passes what the role reads is SILENT — a warning that fires
  // every time is how a warning teaches its reader to ignore warnings.
  const supplied = runCli(['model', 'executor', '--json', '--risk', 'medium']);
  assert.strictEqual(supplied.err, '', supplied.err);
  assert.deepStrictEqual(supplied.json(), { model: 'opus', effort: 'high' });
  assert.strictEqual(runCli(['model', 'ci-fix', '--json']).err, '', 'a role with no signal-keyed row says nothing');
});

test('signalGaps names the flag and what it decides, for each role that reads one', () => {
  assert.deepStrictEqual(signalGaps('ci-fix', {}), [], 'no signal-keyed row, no gap');
  assert.strictEqual(signalGaps('executor', {}).length, 1);
  assert.deepStrictEqual(signalGaps('executor', { risk: 'low' }), []);
  assert.deepStrictEqual(signalGaps('research', { type: 'facts' }), []);
  assert.deepStrictEqual(signalGaps('arch-review', { inputTokens: 10 }), []);
  assert.strictEqual(signalGaps('arch-review', { inputTokens: 'huge' }).length, 1,
    'a value that is not a number is not a measurement');
  // own-property only: a role name off Object.prototype is not a role
  assert.deepStrictEqual(signalGaps('toString', {}), []);
});

test('an effort override on a repair role is honoured, and warned about (ADR-005 D3)', () => {
  // It is read BEFORE the signature rule, so it also switches off the depth rung
  // a repeated failure earns — which is why the effort TABLE could not be shipped
  // as configuration at all.
  const { config, warnings } = withConfig({ effort: { 'ci-fix': 'low' } });
  assert.strictEqual(resolveEffort('ci-fix', 'opus', config, { signatureState: 'repeat' }), 'low');
  assert.ok(warnings.some((w) => /ci-fix/.test(w) && /max/.test(w)), warnings.join('; '));
  // A non-repair role gets no such warning: there is no escalation to shadow.
  assert.deepStrictEqual(withConfig({ effort: { 'arch-review': 'max' } }).warnings, []);
});

done();
