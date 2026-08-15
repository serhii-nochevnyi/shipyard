'use strict';

// The model policy used to live only as prose in the skills, which is how it came
// to specify model values the Agent tool rejects. These tests pin the two
// properties that matter: only tier aliases are ever emitted, and judgment roles
// are never cheapened by configuration.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { suite, test, done, assert } = require('./assert-harness.cjs');

const mod = path.join(__dirname, '..', '..', 'plugins', 'delivery-pipeline', 'scripts', 'pipeline-config.cjs');
const { loadConfig, resolveModel, resolveEffort, TIERS, EFFORTS, DEFAULTS } = require(mod);

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

suite('resolveModel — policy shape');

const cfg = (over = {}) => ({ ...DEFAULTS, models: {}, ...over });

test('judgment stays top tier even under economy', () => {
  // Never cheapened by the profile. cfg() leaves gsd.runtime UNSET, which resolves
  // to opus — the safe default (see topTier): a smaller window on Claude beats an
  // unresolvable model id on Codex.
  for (const role of ['integrator', 'arch-review']) {
    assert.strictEqual(resolveModel(role, { risk: 'low' }, cfg({ model_policy: 'economy' })), 'opus');
  }
});

test('executor: high risk → opus, low risk with a tiny surface → sonnet', () => {
  assert.strictEqual(resolveModel('executor', { risk: 'high', files: 1 }, cfg()), 'opus');
  assert.strictEqual(resolveModel('executor', { risk: 'low', files: 2 }, cfg()), 'sonnet');
  assert.strictEqual(resolveModel('executor', { risk: 'low', files: 9 }, cfg()), 'opus');
  assert.strictEqual(resolveModel('executor', { risk: 'low', files: 9, type: 'research' }, cfg()), 'sonnet');
});

test('executor: human_checkpoint forces opus regardless of risk', () => {
  assert.strictEqual(resolveModel('executor', { risk: 'low', files: 1, checkpoint: true }, cfg()), 'opus');
});

test('executor: economy starts medium risk on sonnet, balanced does not', () => {
  assert.strictEqual(resolveModel('executor', { risk: 'medium', files: 5 }, cfg({ model_policy: 'economy' })), 'sonnet');
  assert.strictEqual(resolveModel('executor', { risk: 'medium', files: 5 }, cfg()), 'opus');
});

test('ci-fix ladder: cheap first strike, escalate on a real failure', () => {
  assert.strictEqual(resolveModel('ci-fix', { attempt: 1 }, cfg()), 'sonnet');
  assert.strictEqual(resolveModel('ci-fix', { attempt: 2 }, cfg()), 'opus');
  assert.strictEqual(resolveModel('ci-fix', { attempt: 1, previousFailed: true }, cfg()), 'opus');
});

test('review-fix: reply-only is cheap, a code change is not; unknown defaults to opus', () => {
  assert.strictEqual(resolveModel('review-fix', { codeChange: false }, cfg()), 'sonnet');
  assert.strictEqual(resolveModel('review-fix', {}, cfg()), 'opus');
});

test('premium raises everything except drift-check', () => {
  assert.strictEqual(resolveModel('executor', { risk: 'low', files: 1 }, cfg({ model_policy: 'premium' })), 'opus');
  assert.strictEqual(resolveModel('ci-fix', { attempt: 1 }, cfg({ model_policy: 'premium' })), 'opus');
  assert.strictEqual(resolveModel('drift-check', {}, cfg({ model_policy: 'premium' })), 'sonnet');
});

test('an explicit per-role override wins over the profile — except for judgment', () => {
  assert.strictEqual(resolveModel('executor', { risk: 'high' }, cfg({ models: { executor: 'haiku' } })), 'haiku');
  // a judgment override is honoured only because it is still a valid alias; the
  // profile can never silently downgrade it
  assert.strictEqual(resolveModel('arch-review', {}, cfg({ model_policy: 'economy' })), 'opus');
});

test('research: option design is heavy, fact gathering is not', () => {
  assert.strictEqual(resolveModel('research', { type: 'alternatives' }, cfg()), 'opus');
  assert.strictEqual(resolveModel('research', { type: 'facts' }, cfg()), 'sonnet');
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

test('fable is the default for the context-bound judges, and for nobody else', () => {
  // It was opt-in only until the 1M window was recognised as the thing that
  // actually distinguishes arch-review and integrator: both read the entire diff
  // against every ADR at once. No other role gains from the window, so none may
  // be billed for it — not even at high risk on a third attempt.
  const JUDGES = new Set(['arch-review', 'integrator']);
  for (const profile of ['economy', 'balanced', 'premium']) {
    for (const role of ALL_ROLES) {
      const c = cfg({ model_policy: profile });
      const got = resolveModel(role, { risk: 'high', attempt: 3 }, { ...c, gsd: { ...(c.gsd||{}), runtime: 'claude' } });
      if (JUDGES.has(role)) assert.strictEqual(got, 'fable', `${profile}/${role} must take the 1M tier`);
      else assert.notStrictEqual(got, 'fable', `${profile}/${role} defaulted to fable`);
    }
  }
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

test('workflow.use_worktrees true warns — the conveyor already owns the worktree', () => {
  const on = withRaw({ workflow: { use_worktrees: true } });
  assert.strictEqual(on.config.gsd.use_worktrees, true);
  assert.ok(on.warnings.some((w) => /NESTED worktree/.test(w)), on.warnings.join('; '));
  // false is the correct value, and absent must stay silent — most projects never
  // set it, and a warning on every run would train the user to ignore warnings.
  assert.deepStrictEqual(withRaw({ workflow: { use_worktrees: false } }).warnings, []);
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

suite('resolveEffort — mirrors GSD light/standard/heavy defaults');

test('every role × model returns an effort Workflow accepts', () => {
  for (const role of ALL_ROLES) {
    for (const model of TIERS) {
      assert.ok(EFFORTS.includes(resolveEffort(role, model, cfg())), `${role}/${model}`);
    }
  }
});

test('effort follows the resolved tier, so an escalated repair thinks harder', () => {
  assert.strictEqual(resolveEffort('ci-fix', 'sonnet', cfg()), 'high');
  assert.strictEqual(resolveEffort('ci-fix', 'opus', cfg()), 'xhigh');
  assert.strictEqual(resolveEffort('integrator', 'fable', cfg()), 'xhigh');
  assert.strictEqual(resolveEffort('executor', 'haiku', cfg()), 'low');
});

test('mechanical roles stay cheap even when the tier is raised', () => {
  assert.strictEqual(resolveEffort('drift-check', 'opus', cfg()), 'low');
});

test('a per-role effort override wins', () => {
  const { config } = withConfig({ effort: { executor: 'max' } });
  assert.strictEqual(resolveEffort('executor', 'sonnet', config), 'max');
});

test('minimal clamps to low (not in Workflow\'s enum) and max clamps on codex', () => {
  const minimal = withConfig({ effort: { executor: 'minimal' } });
  assert.strictEqual(resolveEffort('executor', 'sonnet', minimal.config), 'low');
  const onCodex = withRaw({ runtime: 'codex', pipeline: { effort: { executor: 'max' } } });
  assert.strictEqual(resolveEffort('executor', 'sonnet', onCodex.config), 'xhigh');
});

test('an invalid effort value is rejected with a warning, not honoured', () => {
  const { config, warnings } = withConfig({ effort: { executor: 'ludicrous' } });
  assert.strictEqual(config.effort.executor, undefined);
  assert.ok(warnings.some((w) => /effort/.test(w)));
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

suite('pr-sentinel model routing');

test('the guard starts cheap and escalates like ci-fix', () => {
  const { config } = withConfig(undefined);
  assert.strictEqual(resolveModel('pr-sentinel', {}, config), 'sonnet');
  assert.strictEqual(resolveModel('pr-sentinel', { attempt: 2 }, config), 'opus');
  assert.strictEqual(resolveModel('pr-sentinel', { risk: 'high' }, config), 'opus');
  assert.strictEqual(resolveModel('pr-sentinel', { checkpoint: true }, config), 'opus');
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

test('the two judgment roles take the 1M tier on Claude', () => {
  // These are the roles the window actually distinguishes: arch-review reads the
  // whole diff against every ADR at once, the integrator reconciles across repos.
  const { config } = withConfig({});
  for (const role of ['arch-review', 'integrator']) {
    assert.strictEqual(resolveModel(role, {}, asRuntime(config, 'claude')), 'fable', role);
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

test('and degrade to opus on Codex, which has no such tier', () => {
  const { config } = withConfig({});
  for (const role of ['arch-review', 'integrator']) {
    assert.strictEqual(resolveModel(role, {}, asRuntime(config, 'codex')), 'opus', role);
  }
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

test('the 1M tier still resolves heavy effort, like any top tier', () => {
  const { config } = withConfig({});
  assert.strictEqual(resolveEffort('arch-review', 'fable', asRuntime(config, 'claude')), 'xhigh');
});

test('premium does not widen the paid tier beyond the judges', () => {
  const { config } = withConfig({ model_policy: 'premium' });
  const c = asRuntime(config, 'claude');
  assert.strictEqual(resolveModel('arch-review', {}, c), 'fable', 'judges keep it');
  assert.strictEqual(resolveModel('executor', {}, c), 'opus', 'premium raises to opus, not to fable');
});

test('an explicit override still wins over the runtime default', () => {
  const { config, warnings } = withConfig({ models: { 'arch-review': 'sonnet' } });
  assert.deepStrictEqual(warnings, []);
  assert.strictEqual(resolveModel('arch-review', {}, asRuntime(config, 'claude')), 'sonnet');
});

done();
