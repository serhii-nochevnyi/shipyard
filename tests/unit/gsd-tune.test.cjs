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
const pc = require(path.join(
  __dirname, '..', '..', 'plugins', 'delivery-pipeline', 'scripts', 'pipeline-config.cjs'
));

function project(config = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-gsdtune-'));
  fs.mkdirSync(path.join(dir, '.planning'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.planning', 'config.json'), JSON.stringify(config, null, 2));
  return dir;
}

// The version-floor checks read the machine: `claude --version`, `codex --version`
// and `$CODEX_HOME/config.toml`. A test that inherited those would pass or fail by
// what happens to be installed on the developer's laptop — and it did, on the
// first run: this host's own ~/.codex/config.toml names gpt-6-astra against Codex
// 0.147.0, so an unrelated assertion started failing on a real blocker. So every
// invocation gets an EMPTY CODEX_HOME and a PATH with no CLIs on it, and the
// tests that want a version stub one in deliberately.
const EMPTY_CODEX = fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-nocodex-'));
const hermetic = (extra = {}) => ({
  ...process.env, CODEX_HOME: EMPTY_CODEX, PATH: path.join(EMPTY_CODEX, 'bin'), ...extra,
});
// `process.execPath` and not 'node': the hermetic PATH has no interpreter on it
// either, so a spawn by name would fail to start at all.
const run = (dir, args = [], env = {}) =>
  spawnSync(process.execPath, [SCRIPT, ...args], { cwd: dir, encoding: 'utf8', env: hermetic(env) });

// One CLI on PATH, printing the version we want to test against — the same shape
// the real ones print, because the reader extracts the number rather than taking
// the whole line.
function stubCli(bins) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-stubbin-'));
  for (const [name, line] of Object.entries(bins)) {
    const p = path.join(dir, name);
    fs.writeFileSync(p, `#!/bin/sh\necho "${line}"\n`);
    fs.chmodSync(p, 0o755);
  }
  return dir;
}
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

test('GSD\'s two context-bound agents take the paid tier on the SAME terms as ours', () => {
  // They had `fable` unconditionally, on the identical 1M-window argument that
  // ADR-005 retired for `arch-review` on a measurement. So: `opus` by default,
  // and `fable` only where a person has consented through pipeline.fable.
  const shut = keyed(driftOf(project({}), ['--runtime', 'claude']));
  assert.equal(shut['model_overrides.gsd-planner'].want, 'opus');
  assert.equal(shut['model_overrides.gsd-code-reviewer'].want, 'opus');
  const consented = keyed(driftOf(project({ pipeline: { fable: 'auto' } }), ['--runtime', 'claude']));
  assert.equal(consented['model_overrides.gsd-planner'].want, 'fable');
  assert.equal(consented['model_overrides.gsd-code-reviewer'].want, 'fable');
  // And via model_overrides, NOT the tier keys: the resolver's runtime-tier step
  // is guarded by `configRuntime !== 'claude'`, so model_profile_overrides.claude.*
  // is inert — it looks like the lever and does nothing.
  assert.equal(shut['model_profile_overrides.claude.opus'], undefined,
    'the inert key must not be written — it would read as a working setting');

  const codex = keyed(driftOf(project({ pipeline: { fable: 'auto' } }), ['--runtime', 'codex']));
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

suite('gsd-tune — agent_skills is merged into, never replaced');

// ADR-004 D7, audit F22, reproduced: a project's own executor skills
// [custom-test-contract, custom-quality] became [global:shipyard-delivery-rules]
// after a successful --apply. The desired value was a one-element array and the
// generic `set()` replaced the whole key with it.

test('an existing list gains the delivery-rules entry, appended last', () => {
  const dir = project({ agent_skills: { 'gsd-executor': ['a', 'b'] } });
  const d = keyed(driftOf(dir, ['--runtime', 'claude']));
  assert.deepEqual(d['agent_skills.gsd-executor'].want, ['a', 'b', 'global:shipyard:delivery-rules'],
    'today this reports just [global:shipyard:delivery-rules] and the fixture entries are lost');
  run(dir, ['--runtime', 'claude', '--apply']);
  assert.deepEqual(readCfg(dir).agent_skills['gsd-executor'], ['a', 'b', 'global:shipyard:delivery-rules']);
});

test('reproduces ADR-004 D7 / audit F22 exactly: custom entries survive apply', () => {
  const dir = project({
    agent_skills: { 'gsd-executor': ['custom-test-contract', 'custom-quality'] },
  });
  run(dir, ['--runtime', 'claude', '--apply']);
  assert.deepEqual(readCfg(dir).agent_skills['gsd-executor'],
    ['custom-test-contract', 'custom-quality', 'global:shipyard:delivery-rules'],
    'F22: these became just [global:shipyard-delivery-rules] before this fix');
});

test('gsd-planner merges too — not just the executor path', () => {
  // Copilot review on PR #34: the merge is implemented identically for both
  // TUNING_ALL entries, but every case above exercises only gsd-executor. A
  // future edit that touches one entry and not the other would pass every
  // test here without this one.
  const dir = project({
    agent_skills: { 'gsd-planner': ['custom-test-contract', 'custom-quality'] },
  });
  const d = keyed(driftOf(dir, ['--runtime', 'claude']));
  assert.deepEqual(d['agent_skills.gsd-planner'].want,
    ['custom-test-contract', 'custom-quality', 'global:shipyard:delivery-rules']);
  run(dir, ['--runtime', 'claude', '--apply']);
  assert.deepEqual(readCfg(dir).agent_skills['gsd-planner'],
    ['custom-test-contract', 'custom-quality', 'global:shipyard:delivery-rules'],
    'F22 applies equally to gsd-planner: this must not collapse to [global:shipyard:delivery-rules]');
});

test('the OTHER runtime\'s form is removed while everything else is kept', () => {
  const dir = project({
    agent_skills: {
      'gsd-executor': ['custom-test-contract', 'global:shipyard-delivery-rules', 'custom-quality'],
    },
  });
  const d = keyed(driftOf(dir, ['--runtime', 'claude']));
  assert.deepEqual(d['agent_skills.gsd-executor'].want,
    ['custom-test-contract', 'custom-quality', 'global:shipyard:delivery-rules']);
  run(dir, ['--runtime', 'claude', '--apply']);
  assert.deepEqual(readCfg(dir).agent_skills['gsd-executor'],
    ['custom-test-contract', 'custom-quality', 'global:shipyard:delivery-rules']);
});

test('a list that already has our form and nothing else reports no drift', () => {
  const dir = project({ agent_skills: { 'gsd-executor': ['x', 'global:shipyard:delivery-rules'] } });
  const d = keyed(driftOf(dir, ['--runtime', 'claude']));
  assert.equal(d['agent_skills.gsd-executor'], undefined, 'nothing to add, nothing to remove');
});

test('the report names additions and removals, never a wholesale "set"', () => {
  const dir = project({
    agent_skills: {
      'gsd-executor': ['custom-test-contract', 'global:shipyard-delivery-rules'],
    },
  });
  const r = run(dir, ['--runtime', 'claude']);
  assert.ok(/\+ global:shipyard:delivery-rules/.test(r.stdout), r.stdout);
  assert.ok(/- global:shipyard-delivery-rules/.test(r.stdout), r.stdout);
  assert.ok(!/agent_skills\.gsd-executor →/.test(r.stdout),
    'must not read as a wholesale replacement of the list');
});

suite('gsd-tune --global — creates a missing ~/.gsd directory, not just the file');

test('--global with no ~/.gsd directory at all still succeeds', () => {
  const h = fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-gsdhome-nodir-'));
  assert.ok(!fs.existsSync(path.join(h, '.gsd')), 'precondition: not even the directory exists');
  const r = spawnSync('node', [SCRIPT, '--global', '--runtime', 'claude', '--apply'],
    { cwd: h, encoding: 'utf8', env: { ...process.env, HOME: h } });
  assert.equal(r.status, 0, r.stderr);
  const cfg = JSON.parse(fs.readFileSync(path.join(h, '.gsd', 'defaults.json'), 'utf8'));
  assert.equal(cfg.runtime, 'claude');
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

suite('gsd-tune — the version floors, which no key can fix');

// A third class beside REQUIRED and tuning, and the distinction is that --apply
// has nothing to write: a runtime too old to resolve the model a project has
// consented to is an install to upgrade, not a value to flatten. So they are
// report-only and they keep the exit code non-zero even after a successful write.
const blockersOf = (dir, args = [], env = {}) =>
  JSON.parse(run(dir, ['--json', ...args], env).stdout).blockers;

test('pipeline.fable: auto below Claude Code 2.1.255 is a blocker, and it names the floor', () => {
  // Below that version the `fable` alias resolves to Fable 5 — the model the
  // operator ruled out — and it does so silently, which is the whole reason this
  // check exists rather than a comment.
  const dir = project({ runtime: 'claude', pipeline: { fable: 'auto' } });
  const old = { PATH: stubCli({ claude: '2.1.240 (Claude Code)' }) };
  const r = run(dir, [], old);
  assert.equal(r.status, 1, r.stdout);
  assert.ok(/2\.1\.255/.test(r.stdout), `the floor must be named: ${r.stdout}`);
  assert.ok(/ANTHROPIC_DEFAULT_FABLE_MODEL/.test(r.stdout),
    'and the second way to miss it, which is the stronger guarantee');
  const b = blockersOf(dir, [], old);
  assert.equal(b.length, 1);
  assert.equal(b[0].what, 'fable-floor');
  assert.equal(b[0].have, '2.1.240');
  assert.equal(b[0].need, '2.1.255');
});

test('at or above the floor it is silent, and a project that never consented is silent at any version', () => {
  const consented = project({ runtime: 'claude', pipeline: { fable: 'auto' } });
  assert.deepEqual(blockersOf(consented, [], { PATH: stubCli({ claude: '2.1.263 (Claude Code)' }) }), []);
  assert.deepEqual(blockersOf(consented, [], { PATH: stubCli({ claude: '2.1.255 (Claude Code)' }) }), [],
    'the floor is inclusive — 2.1.255 IS the version that resolves 5.1');
  const noConsent = project({ runtime: 'claude' });
  assert.deepEqual(blockersOf(noConsent, [], { PATH: stubCli({ claude: '2.1.100 (Claude Code)' }) }), [],
    'nothing asks for the paid tier, so its floor is not this project\'s problem');
});

test('a CLI that cannot be read at all is silence, not a finding', () => {
  // An unmeasurable floor asserted as a blocker would fire on every run of a host
  // we know nothing about — a container without the CLI on PATH, say.
  const dir = project({ runtime: 'claude', pipeline: { fable: 'auto' } });
  assert.deepEqual(blockersOf(dir, []), [], 'no claude on PATH');
  assert.deepEqual(blockersOf(dir, [], { PATH: stubCli({ claude: 'not a version at all' }) }), []);
});

// The ceiling model and its floor come from the PALETTE, never from a constant in
// gsd-tune: a second copy of a model id goes stale the next time the operator
// changes the palette, and tests/unit/gen-codex-shipyard.test.cjs enforces that
// the shipped default is the only place an id appears as a value.
const CEILING = pc.DEFAULT_CODEX_MODELS.filter((e) => e.min_cli).slice(-1)[0];
const codexHomeWith = (contents) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-codexhome-'));
  fs.writeFileSync(path.join(dir, 'config.toml'), contents);
  return dir;
};

test('a palette model below its declared min_cli is the mirror blocker, read from config.toml', () => {
  // The floor is the palette's own `min_cli` (the ceiling entry ships with one,
  // because first-class configuration for that model arrived in a specific Codex
  // release). Below it the agent files naming the model may simply be ignored,
  // which looks like a working install running a model nobody chose.
  const codexHome = codexHomeWith(
    `[agents.shipyard-integrator]\nmodel = "${CEILING.model}"\nmodel_reasoning_effort = "high"\n`);
  const dir = project({ runtime: 'codex' });
  const env = { CODEX_HOME: codexHome, PATH: stubCli({ codex: 'codex-cli 0.147.0' }) };
  const r = run(dir, [], env);
  assert.equal(r.status, 1, r.stdout);
  assert.ok(r.stdout.includes(CEILING.min_cli), `the version must be named: ${r.stdout}`);
  const b = blockersOf(dir, [], env);
  assert.equal(b.length, 1);
  assert.equal(b[0].what, 'codex-model-floor');
  assert.equal(b[0].model, CEILING.model);
  assert.equal(b[0].have, '0.147.0');
  assert.equal(b[0].need, CEILING.min_cli);
  // At a release above the floor it is silent…
  assert.deepEqual(blockersOf(dir, [], { ...env, PATH: stubCli({ codex: 'codex-cli 0.153.4' }) }), []);
  // …and so is a config that names only the workhorse, at any version.
  fs.writeFileSync(path.join(codexHome, 'config.toml'),
    `[agents.shipyard-executor]\nmodel = "${pc.DEFAULT_CODEX_MODELS[0].model}"\n`);
  assert.deepEqual(blockersOf(dir, [], env), []);
});

test('a palette entry that declares no floor cannot produce one', () => {
  // The operator declared no version requirement, so there is nothing to measure
  // against — and inventing one would be this file holding an opinion about a
  // model it has never heard of.
  const codexHome = codexHomeWith('model = "some-new-model"\n');
  const dir = project({ runtime: 'codex', pipeline: { codex_models: 'some-new-model:high' } });
  assert.deepEqual(
    blockersOf(dir, [], { CODEX_HOME: codexHome, PATH: stubCli({ codex: 'codex-cli 0.1.0' }) }), []);
});

test('a Codex install elsewhere on the machine is not a Claude project\'s finding', () => {
  // gsd-tune runs at Step 0 of every delivery. A dual-runtime host has a
  // ~/.codex/config.toml whatever this project delivers on, and a Codex version
  // report in front of a Claude run is a report nobody in that session can act
  // on — which is how a report teaches its reader to skip it.
  const codexHome = codexHomeWith(`model = "${CEILING.model}"\n`);
  const dir = project({ runtime: 'claude' });
  assert.deepEqual(
    blockersOf(dir, [], { CODEX_HOME: codexHome, PATH: stubCli({ codex: 'codex-cli 0.147.0' }) }), []);
});

test('a blocker survives --apply: the write happens, the exit code still reports it', () => {
  const dir = project({ runtime: 'claude', pipeline: { fable: 'auto' } });
  const env = { PATH: stubCli({ claude: '2.1.240 (Claude Code)' }) };
  const r = run(dir, ['--apply'], env);
  assert.equal(r.status, 1, 'nothing here can write a CLI version');
  assert.equal(readCfg(dir).git.branching_strategy, 'none', 'and the writable half still landed');
  const again = run(dir, ['--apply'], env);
  assert.equal(again.status, 1, 'with no drift left, the floor alone keeps it non-zero');
  assert.ok(/2\.1\.255/.test(again.stdout), again.stdout);
});

test('version comparison is numeric, not lexical', () => {
  // 2.1.9 vs 2.1.10 is exactly the pair a string compare gets wrong, and exactly
  // the pair a floor check meets.
  const dir = project({ runtime: 'claude', pipeline: { fable: 'auto' } });
  assert.equal(blockersOf(dir, [], { PATH: stubCli({ claude: '2.1.9 (Claude Code)' }) }).length, 1,
    '2.1.9 is BELOW 2.1.255');
  assert.equal(blockersOf(dir, [], { PATH: stubCli({ claude: '2.2.0 (Claude Code)' }) }).length, 0,
    '2.2.0 is above it');
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
  spawnSync(process.execPath, [SCRIPT, '--global', ...args], { cwd: h, encoding: 'utf8', env: hermetic({ HOME: h }) });
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

suite('gsd-tune --global — a project config that does not parse is refused, not read (ADR-004 D2)');

// The third of the three ADR-004 D2 gaps arch-review found on PR #60. PROJECT
// mode is already immune: `CONFIG` is the same file, and the hard fail above
// ("refusing to rewrite a file I cannot parse") catches it. `--global` writes a
// DIFFERENT file — ~/.gsd/defaults.json — while still reading the project's
// `.planning/config.json` for `model_profile`, so a corrupt project config
// produced `model_profile → "balanced" … mirrors pipeline.model_policy =
// "balanced"`: the script telling the operator that the file said something the
// file does not say, and offering to write it machine-wide.
//
// The values it picks are conservative; the MISATTRIBUTION is the defect, and
// the machine-wide scope is what makes it worth a refusal rather than a warning.

// cwd and HOME in one directory: the project config that must be read (or
// refused) is the one at the cwd, and the file written is under HOME.
function globalWorkspace(projectConfigText) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-gsdtune-global-'));
  fs.mkdirSync(path.join(dir, '.planning'), { recursive: true });
  if (projectConfigText !== undefined) {
    fs.writeFileSync(path.join(dir, '.planning', 'config.json'), projectConfigText);
  }
  return dir;
}
const runGlobalIn = (dir, args = []) =>
  spawnSync(process.execPath, [SCRIPT, '--global', ...args], { cwd: dir, encoding: 'utf8', env: hermetic({ HOME: dir }) });
const CORRUPT_PROJECT = '{ "pipeline": { "model_policy": "premium"';

test('the report carries the refusal and drops every row it would have to invent', () => {
  const dir = globalWorkspace(CORRUPT_PROJECT);
  const r = runGlobalIn(dir, ['--runtime', 'claude', '--json']);
  const out = JSON.parse(r.stdout);
  assert.ok(typeof out.config_invalid === 'string' && out.config_invalid,
    `the refusal must ride the machine face: ${JSON.stringify(Object.keys(out))}`);
  assert.ok(/config\.json/.test(out.config_invalid), out.config_invalid);
  const d = keyed(out.drift);
  assert.equal(d['model_profile'], undefined,
    'the only global row that reads the project config must not be reported off defaults');
  assert.notEqual(r.status, 0, 'a refusal is a finding, and the exit code has to say so');
});

test('the human face names the file instead of attributing a value to it', () => {
  const dir = globalWorkspace(CORRUPT_PROJECT);
  const r = runGlobalIn(dir, ['--runtime', 'claude']);
  assert.ok(/mirrors pipeline\.model_policy/.test(r.stdout) === false,
    `this sentence is the misattribution itself: ${r.stdout}`);
  assert.ok(/does not parse|not valid JSON|no policy is in effect/.test(r.stdout), r.stdout);
});

test('--apply writes NOTHING while the policy is unknown', () => {
  const dir = globalWorkspace(CORRUPT_PROJECT);
  const target = path.join(dir, '.gsd', 'defaults.json');
  const r = runGlobalIn(dir, ['--runtime', 'claude', '--apply']);
  assert.ok(!fs.existsSync(target),
    `a machine-wide file must not be written under an unknown policy: ${fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : ''}`);
  assert.notEqual(r.status, 0, r.stdout);
});

test('--apply leaves an EXISTING global file byte-for-byte alone', () => {
  const dir = globalWorkspace(CORRUPT_PROJECT);
  fs.mkdirSync(path.join(dir, '.gsd'), { recursive: true });
  const target = path.join(dir, '.gsd', 'defaults.json');
  fs.writeFileSync(target, JSON.stringify({ runtime: 'codex', models: { planning: 'sonnet' } }, null, 2));
  const before = fs.readFileSync(target, 'utf8');
  runGlobalIn(dir, ['--runtime', 'claude', '--apply']);
  assert.equal(fs.readFileSync(target, 'utf8'), before, 'withholding a mutation means writing no bytes at all');
});

test('a project with NO config file at all behaves exactly as before', () => {
  // `loadConfig` reports an absent file as `valid: true, error: null`: a project
  // nobody has configured has decided nothing, and the shipped defaults are the
  // right answer. This is the regression the refusal could introduce — and the
  // one an installer meets, since it runs before any project exists.
  const dir = globalWorkspace(undefined);
  const r = runGlobalIn(dir, ['--runtime', 'claude', '--json']);
  const out = JSON.parse(r.stdout);
  assert.equal(out.config_invalid, undefined, 'nothing was refused, so nothing is reported');
  const d = keyed(out.drift);
  assert.ok(d['model_profile'], 'the row is reported, off the defaults that legitimately apply');
  assert.equal(d['model_profile'].want, 'balanced');

  const applied = runGlobalIn(dir, ['--runtime', 'claude', '--apply']);
  assert.equal(applied.status, 0, applied.stderr || applied.stdout);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, '.gsd', 'defaults.json'), 'utf8')).model_profile, 'balanced');
});

test('a project config that PARSES is still read, and its policy still mirrors', () => {
  const dir = globalWorkspace(JSON.stringify({ pipeline: { model_policy: 'premium' } }));
  const out = JSON.parse(runGlobalIn(dir, ['--runtime', 'claude', '--json']).stdout);
  assert.equal(out.config_invalid, undefined);
  assert.equal(keyed(out.drift)['model_profile'].want, 'quality', 'premium → quality, from the file');
});

test('PROJECT mode is untouched: the same file is still a hard fail, not a soft refusal', () => {
  const dir = globalWorkspace(CORRUPT_PROJECT);
  const r = spawnSync(process.execPath, [SCRIPT, '--runtime', 'claude'], { cwd: dir, encoding: 'utf8', env: hermetic({ HOME: dir }) });
  assert.equal(r.status, 2, `project mode refuses to rewrite a file it cannot parse: ${r.stdout}${r.stderr}`);
  assert.ok(/not valid JSON/.test(r.stderr), r.stderr);
});


done();
