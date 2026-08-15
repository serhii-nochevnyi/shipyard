'use strict';

// gsd-tune turns three standing WARNINGS into one applicable act. The warnings
// existed and were ignored for exactly the reason a warning gets ignored: acting
// on it meant knowing which of ~60 GSD keys to touch and what value the conveyor
// needs. The proving ground had none of the three REQUIRED settings set.
//
// Because it writes a file the user owns, the properties worth pinning are as
// much about restraint as about correctness: it must not touch anything it was
// not asked to, it must not write at all without --apply, and it must be right
// about the runtime-dependent values — the first draft was not, and would have
// rewritten a correct agent_skills entry into a skill that resolves nowhere.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { suite, test, done, assert } = require(path.join(__dirname, 'assert-harness.cjs'));

const SCRIPT = path.join(
  __dirname, '..', '..', 'plugins', 'delivery-pipeline', 'scripts', 'gsd-tune.cjs'
);

function project(config = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-gsdtune-'));
  fs.mkdirSync(path.join(dir, '.planning'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.planning', 'config.json'), JSON.stringify(config, null, 2));
  return dir;
}
const run = (dir, args = []) => spawnSync('node', [SCRIPT, ...args], { cwd: dir, encoding: 'utf8' });
const readCfg = (dir) => JSON.parse(fs.readFileSync(path.join(dir, '.planning', 'config.json'), 'utf8'));
const driftOf = (dir, args = []) => JSON.parse(run(dir, ['--json', ...args]).stdout).drift;
const keyed = (drift) => Object.fromEntries(drift.map((d) => [d.key, d]));

suite('gsd-tune — the required settings');

test('a bare project is missing both required settings, and they are marked so', () => {
  const d = keyed(driftOf(project({}), ['--runtime', 'claude']));
  assert.equal(d['git.branching_strategy'].want, 'none');
  assert.equal(d['runtime'].want, 'claude');
  for (const k of ['git.branching_strategy', 'runtime']) {
    assert.equal(d[k].group, 'required', `${k} is correctness, not taste`);
  }
  // use_worktrees is NOT required. It was, on a nesting scenario that GSD 1.9.1's
  // source does not support: code-review never mentions worktrees, and
  // `git worktree add` lives only in execute-phase/new-workspace/worktree-safety,
  // none of which the conveyor invokes. It is tuning, and it wants GSD's default.
  assert.equal(d['workflow.use_worktrees'].group, 'tuning');
  assert.equal(d['workflow.use_worktrees'].want, true);
});

test('a project that already agrees reports nothing and exits 0', () => {
  const dir = project({});
  assert.equal(run(dir, ['--runtime', 'claude', '--apply']).status, 0);
  const second = run(dir, ['--runtime', 'claude']);
  assert.equal(second.status, 0, 'idempotent');
  assert.ok(/nothing to change/.test(second.stdout), second.stdout);
});

test('a wrong value is reported as the user\'s, not as an absence', () => {
  // The distinction decides whether --apply is a fix or an override, so it has to
  // survive into the report.
  const d = keyed(driftOf(project({ git: { branching_strategy: 'phase' } }), ['--runtime', 'claude']));
  assert.equal(d['git.branching_strategy'].set, true, 'it was deliberately set');
  assert.equal(d['git.branching_strategy'].have, 'phase');
});

suite('gsd-tune — the runtime decides two values');

test('the delivery-rules skill takes the form each runtime actually resolves', () => {
  // claude: plugin-namespaced, `global:<plugin>:<skill>` — the plugin is
  // `shipyard` and the skill directory is `delivery-rules`.
  // codex: flat skills dir, and the generator prefixes the name.
  // A mix of the two resolves nowhere and is silently skipped, never failed.
  const claude = keyed(driftOf(project({}), ['--runtime', 'claude']));
  assert.deepEqual(claude['agent_skills.gsd-executor'].want, ['global:shipyard:delivery-rules']);
  const codex = keyed(driftOf(project({}), ['--runtime', 'codex']));
  assert.deepEqual(codex['agent_skills.gsd-executor'].want, ['global:shipyard-delivery-rules']);
});

test('an already-correct skill entry is left alone', () => {
  const dir = project({ agent_skills: { 'gsd-executor': ['global:shipyard:delivery-rules'] } });
  const d = keyed(driftOf(dir, ['--runtime', 'claude']));
  assert.equal(d['agent_skills.gsd-executor'], undefined, 'no drift on a correct value');
});

test('the 1M tier for GSD\'s agents is set on Claude, and only there', () => {
  // And via model_overrides, NOT the tier keys: the resolver's runtime-tier step
  // is guarded by `configRuntime !== 'claude'`, so model_profile_overrides.claude.*
  // is inert — it looks like the lever and does nothing.
  const claude = keyed(driftOf(project({}), ['--runtime', 'claude']));
  assert.equal(claude['model_overrides.gsd-planner'].want, 'fable');
  assert.equal(claude['model_overrides.gsd-code-reviewer'].want, 'fable');
  assert.equal(claude['model_profile_overrides.claude.opus'], undefined,
    'the inert key must not be written — it would read as a working setting');

  const codex = keyed(driftOf(project({}), ['--runtime', 'codex']));
  for (const k of Object.keys(codex)) {
    assert.ok(!k.startsWith('model_overrides.'), `${k}: fable does not exist off Claude`);
  }
});

test('only context-bound GSD agents get it — not the executor or the fixer', () => {
  // Same rule the conveyor applies to its own roles: those two work inside one
  // ticket's narrow scope, where a 1M window buys nothing and costs money.
  const d = keyed(driftOf(project({}), ['--runtime', 'claude']));
  for (const agent of ['gsd-executor', 'gsd-code-fixer', 'gsd-codebase-mapper']) {
    assert.equal(d[`model_overrides.${agent}`], undefined, agent);
  }
});

test('the config\'s own runtime is honoured when no flag is given', () => {
  const d = keyed(driftOf(project({ runtime: 'codex' })));
  assert.equal(d['runtime'], undefined, 'it already matches, so it is not drift');
  assert.deepEqual(d['agent_skills.gsd-executor'].want, ['global:shipyard-delivery-rules'],
    'and the skill form follows that runtime');
});

suite('gsd-tune — restraint');

test('nothing is written without --apply, and the exit code reports drift', () => {
  const dir = project({});
  const before = fs.readFileSync(path.join(dir, '.planning', 'config.json'), 'utf8');
  const r = run(dir, ['--runtime', 'claude']);
  assert.equal(r.status, 1, 'a caller must be able to gate on it, like the other conveyor gates');
  assert.equal(fs.readFileSync(path.join(dir, '.planning', 'config.json'), 'utf8'), before,
    'the report must not be a write');
});

test('--apply preserves every key it was not asked about', () => {
  const dir = project({
    pipeline: { repos: { 'a/b': '/tmp/x' }, pr_fetch_limit: 3000 },
    ship: { pr_body_sections: ['x'] },
    context_window: 200000,
  });
  run(dir, ['--runtime', 'claude', '--apply']);
  const after = readCfg(dir);
  assert.deepEqual(after.pipeline.repos, { 'a/b': '/tmp/x' }, 'the conveyor\'s own namespace survives');
  assert.equal(after.pipeline.pr_fetch_limit, 3000);
  assert.deepEqual(after.ship.pr_body_sections, ['x']);
  assert.equal(after.context_window, 200000);
  assert.equal(after.git.branching_strategy, 'none', 'and the required ones landed');
});

test('a config that is not valid JSON is refused, not rewritten', () => {
  const dir = project({});
  fs.writeFileSync(path.join(dir, '.planning', 'config.json'), '{ not json');
  const r = run(dir, ['--runtime', 'claude', '--apply']);
  assert.notEqual(r.status, 0);
  assert.ok(/refusing/.test(r.stderr), r.stderr);
  assert.equal(fs.readFileSync(path.join(dir, '.planning', 'config.json'), 'utf8'), '{ not json',
    'the unparseable file is left exactly as it was');
});

test('a project with no GSD config at all is refused', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-nogsd-'));
  const r = run(dir, ['--runtime', 'claude', '--apply']);
  assert.notEqual(r.status, 0);
  assert.ok(!fs.existsSync(path.join(dir, '.planning', 'config.json')), 'no config is conjured');
});

suite('gsd-tune — the tuning half never claims a GSD-invalid tier');

test('models.* stay inside GSD\'s vocabulary', () => {
  // `fable` is OUR Claude-runtime tier. GSD's models.* accepts opus|sonnet|haiku
  // (plus inherit), so mapping our top tier through here would write a value GSD
  // rejects outright.
  const d = driftOf(project({}), ['--runtime', 'claude']);
  const VALID = new Set(['opus', 'sonnet', 'haiku', 'inherit']);
  for (const row of d.filter((x) => x.key.startsWith('models.'))) {
    assert.ok(VALID.has(row.want), `${row.key} = ${row.want} is not a GSD tier`);
  }
});

test('model_profile mirrors the conveyor\'s own policy, in GSD\'s vocabulary', () => {
  // The RUNTIME vocabulary is quality|balanced|budget|adaptive|inherit
  // (VALID_PROFILES). `golden` is only the raw field name in
  // model-catalog.json — MODEL_PROFILES rebuilds it as `quality: meta.golden` at
  // load. Reading the JSON and concluding "the vocabulary is golden" is a trap
  // this file fell into once, and an expensive one: the resolver does
  // `agentModels[profile] || agentModels['balanced']`, so a name outside the
  // vocabulary does not fail — it silently becomes balanced.
  const PROFILES = new Set(['quality', 'balanced', 'budget', 'adaptive', 'inherit']);
  const eco = keyed(driftOf(project({ pipeline: { model_policy: 'economy' } }), ['--runtime', 'claude']));
  assert.equal(eco['model_profile'].want, 'budget');
  const prem = keyed(driftOf(project({ pipeline: { model_policy: 'premium' } }), ['--runtime', 'claude']));
  assert.equal(prem['model_profile'].want, 'quality');
  for (const policy of ['economy', 'balanced', 'premium']) {
    const d = keyed(driftOf(project({ pipeline: { model_policy: policy } }), ['--runtime', 'claude']));
    const want = d['model_profile'] ? d['model_profile'].want : 'balanced';
    assert.ok(PROFILES.has(want), `${policy} → "${want}" is not a GSD profile`);
  }
});

suite('gsd-tune --global — the install-time surface');

// ~/.gsd/defaults.json is what a directory with NO .planning/ inherits. Verified
// against GSD: with no project config it supplies `runtime`; the moment a project
// has its own config.json, even an empty one, it stops contributing. So it is the
// only thing an installer can configure — there is no project at install time.
function home(defaults) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-gsdhome-'));
  fs.mkdirSync(path.join(dir, '.gsd'), { recursive: true });
  if (defaults !== undefined) {
    fs.writeFileSync(path.join(dir, '.gsd', 'defaults.json'), JSON.stringify(defaults, null, 2));
  }
  return dir;
}
const runGlobal = (h, args = []) =>
  spawnSync('node', [SCRIPT, '--global', ...args], { cwd: h, encoding: 'utf8', env: { ...process.env, HOME: h } });
const globalCfg = (h) => JSON.parse(fs.readFileSync(path.join(h, '.gsd', 'defaults.json'), 'utf8'));

test('nothing conveyor-shaped is ever written machine-wide', () => {
  // The file is inherited by GSD projects that never asked for shipyard. An
  // ordinary one legitimately wants phase branches, so forcing branching,
  // worktrees or agent_skills here is the overreach the capability's plan:post
  // gate has an applicability check to avoid.
  const h = home({});
  runGlobal(h, ['--runtime', 'claude', '--apply']);
  const cfg = globalCfg(h);
  for (const key of ['git', 'agent_skills', 'workflow']) {
    assert.equal(cfg[key], undefined, `${key} must not reach the global defaults`);
  }
  assert.equal(cfg.models.planning, 'opus', 'but TIER settings do — they mean something on both runtimes');
  // model_overrides carries `fable`, which exists only on Claude, while this file
  // is read by the Codex install too. GSD said so itself during a real install:
  // "Codex agent gsd-code-reviewer model fable is not a valid Codex model …
  // dropping it" — twice, about a key we had written.
  assert.equal(cfg.model_overrides, undefined, 'a Claude-only value must not go machine-wide');
});

test('a runtime handover is announced, not performed silently', () => {
  // One `runtime` shared by two installers means last-write-wins. That is how
  // the real file came to say "codex" on a Claude machine, where every
  // unconfigured directory then resolved gpt-5.6-sol.
  const h = home({ runtime: 'codex', resolve_model_ids: 'omit' });
  const r = runGlobal(h, ['--runtime', 'claude']);
  assert.ok(/currently say runtime "codex"/.test(r.stdout), r.stdout);
  assert.equal(r.status, 1, 'drift is reported, and reporting is not writing');
  assert.equal(globalCfg(h).runtime, 'codex', 'nothing written without --apply');

  runGlobal(h, ['--runtime', 'claude', '--apply']);
  assert.equal(globalCfg(h).runtime, 'claude');
  assert.equal(globalCfg(h).resolve_model_ids, 'omit', 'unrelated keys survive');
});

test('the global file is created when absent — unlike a project config', () => {
  // A missing project config means "you are in the wrong directory" and is
  // refused. A missing global defaults file just means nobody has written one.
  const h = home(undefined);
  assert.equal(runGlobal(h, ['--runtime', 'codex', '--apply']).status, 0);
  assert.equal(globalCfg(h).runtime, 'codex');
});

test('an override this script wrote machine-wide earlier is withdrawn', () => {
  // Not a general remover: only our exact agent/value pairs. GSD warned about
  // these on every Codex install, and we are the ones who wrote them.
  const h = home({
    model_overrides: { 'gsd-planner': 'fable', 'gsd-code-reviewer': 'fable', 'gsd-verifier': 'opus' },
  });
  runGlobal(h, ['--runtime', 'claude', '--apply']);
  const cfg = globalCfg(h);
  assert.equal(cfg.model_overrides['gsd-planner'], undefined, 'ours is withdrawn');
  assert.equal(cfg.model_overrides['gsd-verifier'], 'opus', 'a user\'s is not');
});

test('a user override with a different value on the same agent survives', () => {
  const h = home({ model_overrides: { 'gsd-planner': 'sonnet' } });
  runGlobal(h, ['--runtime', 'claude', '--apply']);
  assert.equal(globalCfg(h).model_overrides['gsd-planner'], 'sonnet');
});

test('NEITHER runtime gets model_overrides machine-wide', () => {
  // Claude-only by value, shared by file — the combination GSD warns about. It
  // still reaches Claude PROJECTS through the project-mode list, where the
  // runtime is unambiguous.
  for (const rt of ['claude', 'codex']) {
    const h = home({});
    runGlobal(h, ['--runtime', rt, '--apply']);
    assert.equal(globalCfg(h).model_overrides, undefined, rt);
  }
});

done();
