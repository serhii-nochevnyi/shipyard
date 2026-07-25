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
const { loadConfig, resolveModel, TIERS, DEFAULTS } = require(mod);

function withConfig(pipeline) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-cfg-'));
  fs.mkdirSync(path.join(dir, '.planning'), { recursive: true });
  if (pipeline !== undefined) {
    fs.writeFileSync(path.join(dir, '.planning', 'config.json'), JSON.stringify({ pipeline }, null, 2));
  }
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

done();
