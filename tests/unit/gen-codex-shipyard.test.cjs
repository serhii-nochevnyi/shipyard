'use strict';

// Exercise the generator and installer as processes against a throwaway home.
// Only GSD's converter and capability installer are stubbed; policy resolution,
// bundle validation, config merging and Shipyard installation are real. The
// separate smoke covers integration with the official GSD converter.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createHash } = require('crypto');
const { spawnSync } = require('child_process');
const { suite, test, done, assert } = require('./assert-harness.cjs');

const ROOT = path.join(__dirname, '..', '..');
const GEN = path.join(ROOT, 'scripts', 'gen-codex-shipyard.cjs');
const PLUGIN = path.join(ROOT, 'plugins', 'delivery-pipeline');
const gen = require(GEN);
const pc = require(path.join(PLUGIN, 'scripts', 'pipeline-config.cjs'));
const policy = require(path.join(PLUGIN, 'scripts', 'model-policy.cjs'));
const { validateCodexCapabilities } = require(path.join(PLUGIN, 'scripts', 'gsd-tune.cjs'));
const selections = Object.values(policy.CODEX_ROLE_RUNG_DEFINITIONS).flat().map((rung) => ({
  model: policy.CODEX_MODEL_IDS[rung.model_key], effort: rung.effort,
}));
const CAPABILITIES = {
  supportedModels: [...new Set(selections.map((s) => s.model))],
  supportedEfforts: [...new Set(selections.map((s) => s.effort))],
  supportedSelections: selections,
};
const STUB_CONVERTER = 'module.exports = { convertClaudeCommandToCodexSkill: x => x, convertClaudeToCodexMarkdown: x => x };\n';
const hash = (text) => createHash('sha256').update(text).digest('hex');
const read = (file) => fs.readFileSync(file, 'utf8');
const json = (file) => JSON.parse(read(file));
function write(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}
function writeJson(file, value) { write(file, JSON.stringify(value, null, 2) + '\n'); }

// Exact bytes, including names, detect overwrites that a length-only snapshot
// misses. Used for both refusal atomicity and foreign ownership assertions.
function snapshot(dir) {
  if (!fs.existsSync(dir)) return null;
  return fs.readdirSync(dir).sort().map((name) => {
    const file = path.join(dir, name);
    const stat = fs.lstatSync(file);
    return [name, stat.isSymbolicLink() ? ['symlink', fs.readlinkSync(file)]
      : stat.isDirectory() ? snapshot(file) : fs.readFileSync(file).toString('base64')];
  });
}

function withFixture(opts, check) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-codexgen-'));
  try {
    const home = path.join(dir, 'home');
    const codexHome = path.join(home, '.codex');
    const proj = path.join(dir, 'proj');
    const out = path.join(dir, 'out');
    const bin = path.join(dir, 'bin');
    const converter = path.join(codexHome, 'gsd-core/bin/lib/runtime-artifact-conversion.cjs');
    const capabilitiesFile = path.join(dir, 'capabilities.json');
    fs.mkdirSync(proj, { recursive: true });
    fs.mkdirSync(bin);
    fs.symlinkSync(process.execPath, path.join(bin, 'node'));
    // No ambient CLI or package manager is allowed to influence these tests.
    for (const name of ['codex', 'npx']) {
      write(path.join(bin, name), '#!/bin/sh\necho "unexpected CLI probe" >&2\nexit 99\n');
      fs.chmodSync(path.join(bin, name), 0o755);
    }
    write(converter, STUB_CONVERTER);
    writeJson(capabilitiesFile, CAPABILITIES);
    if (opts.projectRaw !== undefined) write(path.join(proj, '.planning/config.json'), opts.projectRaw);
    else if (opts.project) writeJson(path.join(proj, '.planning/config.json'), opts.project);
    if (opts.defaults) writeJson(path.join(home, '.gsd/defaults.json'), opts.defaults);
    const env = {
      HOME: home, GSD_HOME: home, CODEX_HOME: codexHome,
      PATH: [bin, '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(path.delimiter),
      TMPDIR: dir, LANG: 'C', SHIPYARD_GSD_AUTO_INSTALL: '0',
      AGENTS_SKILLS_DIR: path.join(home, '.agents/skills'),
      GSD_CAPABILITIES_DIR: path.join(home, '.gsd/capabilities'),
      GSD_DEFAULTS_PATH: path.join(home, '.gsd/defaults.json'),
      CODEX_AGENTS_MD: path.join(codexHome, 'AGENTS.md'),
    };
    const phase = opts.phase === undefined ? 2 : opts.phase;
    const args = [GEN, '--plugin', PLUGIN, '--out', out, '--codex-home', codexHome,
      '--phase', String(phase), '--project-dir', proj];
    const run = (extra = ['--capabilities', capabilitiesFile], overrides = {}) =>
      spawnSync(process.execPath, [...args, ...extra], {
        cwd: dir, encoding: 'utf8', env: { ...env, ...overrides },
      });
    const options = { codexHome, phase, capabilities: CAPABILITIES };
    check({ dir, home, codexHome, proj, out, converter, capabilitiesFile, env, run, options });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function generated(f) {
  const result = f.run();
  assert.strictEqual(result.status, 0, result.stderr || String(result.error));
  return gen.validateCodexBundle(f.out, f.options);
}

// Expected membership comes directly from canonical policy, independently of
// the generator's codexStaticVariants helper and its returned manifest.
function expectedVariants(phase) {
  return policy.CODEX_STATIC_ROLES.filter((role) => phase === 2 || role === 'research')
    .flatMap((role) => policy.CODEX_ROLE_RUNG_DEFINITIONS[role].map((rung) => ({
      role, rung: rung.name, file: policy.codexAgentFile(role, rung.name),
      model: policy.CODEX_MODEL_IDS[rung.model_key], effort: rung.effort,
      sandbox: ['research', 'arch-review', 'drift-check'].includes(role) ? 'read-only' : 'workspace-write',
    })));
}

function assertCanonical(f) {
  const manifest = gen.validateCodexBundle(f.out, f.options);
  const variants = expectedVariants(f.options.phase);
  assert.ok(variants.length > 0);
  assert.deepStrictEqual(fs.readdirSync(path.join(f.out, 'agents')).sort(), variants.map((v) => v.file).sort());
  assert.deepStrictEqual(manifest.agent_files.slice().sort(), variants.map((v) => v.file).sort());
  for (const v of variants) {
    const text = read(path.join(f.out, 'agents', v.file));
    for (const [key, value] of Object.entries({
      model: v.model, model_reasoning_effort: v.effort, sandbox_mode: v.sandbox,
      '# shipyard-policy-id': policy.POLICY.id,
      '# shipyard-policy-version': policy.POLICY_VERSION,
      '# shipyard-policy-hash': policy.POLICY_HASH,
      '# shipyard-policy-runtime': 'codex',
      '# shipyard-policy-role': v.role, '# shipyard-policy-rung': v.rung,
    })) assert.ok(text.split('\n').includes(key + ' = ' + JSON.stringify(value)), v.file + ': ' + key);
    assert.strictEqual(manifest.agent_digests[v.file], hash(text));
  }
  return manifest;
}

suite('the shipped palette');

test('the capability declares the same palette the reader defaults to', () => {
  // Two homes for one default, so they must be checked against each other: the
  // capability is what GSD can SET (its config vocabulary is
  // boolean|string|number|enum, so the declared form is a string), the reader is
  // what applies when nothing is set.
  const cap = JSON.parse(fs.readFileSync(
    path.join(ROOT, 'capabilities', 'delivery-pipeline', 'capability.json'), 'utf8'));
  const declared = cap.config['delivery_pipeline.codex_models'];
  assert.ok(declared, 'capability.json must declare delivery_pipeline.codex_models');
  assert.strictEqual(declared.type, 'string', 'GSD accepts no array-typed config slice');
  const warnings = [];
  assert.deepStrictEqual(
    pc.normalizeCodexModels(declared.default, warnings),
    pc.DEFAULT_CODEX_MODELS,
  );
  assert.deepStrictEqual(warnings, []);
});

test('the README example is labeled compatibility input, not canonical bundle policy', () => {
  // The compatibility example may quote the DEFAULT, but the surrounding text
  // must keep that input distinct from the ADR-014 static bundle contract.
  const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
  const quoted = readme.match(/"codex_models":\s*"([^"]+)"/);
  assert.ok(quoted, 'README should show a codex_models example');
  assert.deepStrictEqual(pc.normalizeCodexModels(quoted[1], []), pc.DEFAULT_CODEX_MODELS);
  assert.match(readme, /compatibility input[\s\S]*canonical Codex bundle/i);
});

test('a model id is DATA — the palette default, or a comment that quotes a measurement', () => {
  // The palette is the one place a model id belongs as a VALUE. Anywhere else it
  // is a copy that goes stale the next time the operator's palette changes,
  // which is the defect this ticket removes. Comments are the exception the
  // criterion names, and only because they record something that was measured on
  // a given day; prose that instructs an agent is not a comment and gets no
  // exception (markdown has no comment form, so it is held to that here).
  const palette = new Set(pc.DEFAULT_CODEX_MODELS.map((e) => e.model));
  const PALETTE_FILE = path.join(PLUGIN, 'scripts', 'pipeline-config.cjs');
  const RUNTIME_ADAPTER_FILE = path.join(PLUGIN, 'scripts', 'runtime-adapters.cjs');
  const runtimeAdapterModels = new Set(Object.values(require(RUNTIME_ADAPTER_FILE).CODEX_MODEL_IDS));
  const ID = /gpt-[0-9][A-Za-z0-9._-]*/;
  const COMMENT = /^\s*(\/\/|#|\*|\/\*|>)/;
  const walk = (dir, acc = []) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(p, acc);
      else if (ent.isFile()) acc.push(p);
    }
    return acc;
  };
  const offenders = [];
  for (const file of [...walk(PLUGIN), ...walk(path.join(ROOT, 'scripts'))]) {
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, i) => {
      const hit = line.match(ID);
      if (!hit) return;
      if (COMMENT.test(line)) return;
      if (file === PALETTE_FILE && palette.has(hit[0])) return;
      if (file === RUNTIME_ADAPTER_FILE && runtimeAdapterModels.has(hit[0])) return;
      offenders.push(`${path.relative(ROOT, file)}:${i + 1}: ${hit[0]}`);
    });
  }
  assert.deepStrictEqual(offenders, []);
});

suite('ADR-014 complete static bundles');

for (const phase of [1, 2]) {
  test('phase ' + phase + ' emits every canonical static role/rung and exact registrations', () => {
    withFixture({ phase }, (f) => {
      generated(f);
      const manifest = assertCanonical(f);
      const names = expectedVariants(phase).map((v) => v.file.replace(/\.toml$/, ''));
      const skills = ['route', 'investigate', 'decompose', ...(phase === 2 ? ['deliver'] : []), 'bench', 'delivery-rules']
        .map((name) => 'shipyard-' + name);
      assert.deepStrictEqual(manifest.agents.slice().sort(), names.slice().sort());
      assert.deepStrictEqual(manifest.registrations.slice().sort(), names.map((n) => 'agents.' + n).sort());
      assert.deepStrictEqual(manifest.skills.slice().sort(), skills.slice().sort());
      assert.deepStrictEqual(manifest.dynamic_roles, policy.DYNAMIC_ROLES);
      assert.strictEqual(manifest.policy_id, policy.POLICY.id);
      assert.strictEqual(manifest.policy_version, policy.POLICY_VERSION);
      assert.strictEqual(manifest.policy_hash, policy.POLICY_HASH);
      const fragment = read(path.join(f.out, 'config.fragment.toml'));
      assert.strictEqual(manifest.config_digest, hash(fragment));
      assert.deepStrictEqual([...fragment.matchAll(/^\[agents\.([^\]]+)\]$/gm)].map((m) => m[1]).sort(), names.slice().sort());
      for (const name of names) {
        assert.ok(fragment.includes('config_file = ' + JSON.stringify(path.join(f.codexHome, 'agents', name + '.toml'))));
      }
      for (const skill of skills) {
        assert.strictEqual(manifest.skill_digests[skill], hash(read(path.join(f.out, 'skills', skill, 'SKILL.md'))));
      }
      assert.ok(manifest.skill_files.length >= skills.length);
      assert.strictEqual(new Set(manifest.skill_files).size, manifest.skill_files.length);
      for (const file of manifest.skill_files) {
        assert.strictEqual(manifest.skill_file_digests[file], hash(read(path.join(f.out, 'skills', file))));
      }
      for (const file of manifest.bundle_files) {
        assert.strictEqual(manifest.bundle_digests[file], hash(read(path.join(f.out, 'bundle', file))));
      }
      assert.strictEqual(manifest.gsd_lib, f.converter);
      assert.strictEqual(manifest.gsd_lib_digest, hash(read(f.converter)));
      for (const role of policy.DYNAMIC_ROLES) {
        for (const rung of policy.CODEX_ROLE_RUNG_DEFINITIONS[role]) {
          assert.ok(!fs.existsSync(path.join(f.out, 'agents', policy.codexAgentFile(role, rung.name))));
        }
      }
      // The canonical repeat_exhausted repair rung retains its -deep filename;
      // judgement and fixed roles no longer get palette-derived -deep agents.
      assert.deepStrictEqual(names.filter((name) => name.endsWith('-deep')).sort(),
        phase === 2 ? ['shipyard-ci-fix-deep', 'shipyard-review-fix-deep'] : []);
    });
  });
}

test('the exported variant helper agrees with every canonical selection', () => {
  for (const phase of [1, 2]) {
    assert.deepStrictEqual(gen.codexStaticVariants(phase), expectedVariants(phase).map((v) => ({
      ...v, reference: v.role === 'research' ? 'inv-research' : v.role,
    })));
  }
  assert.throws(() => gen.codexStaticVariants(3), /phase must be 1 or 2/);
});

test('the generator writes nothing outside --out and repeat generation is byte-identical', () => {
  withFixture({ project: { agent_skills: { 'gsd-executor': ['foreign'] } } }, (f) => {
    const beforeHome = snapshot(f.home);
    const beforeProject = snapshot(f.proj);
    generated(f);
    const beforeStage = snapshot(f.out);
    generated(f);
    assert.deepStrictEqual(snapshot(f.out), beforeStage);
    assert.deepStrictEqual(snapshot(f.home), beforeHome);
    assert.deepStrictEqual(snapshot(f.proj), beforeProject);
  });
});

test('the bundle carries canonical payloads and rewrites installed Shipyard references', () => {
  withFixture({}, (f) => {
    const manifest = generated(f);
    for (const file of ['model-policy.cjs', 'model-policy-internal.cjs', 'runtime-adapters.cjs']) {
      assert.strictEqual(read(path.join(f.out, 'bundle/scripts', file)), read(path.join(PLUGIN, 'scripts', file)));
    }
    assert.strictEqual(read(path.join(f.out, 'bundle/skills/delivery-rules/SKILL.md')),
      read(path.join(PLUGIN, 'skills/delivery-rules/SKILL.md')));
    const texts = [
      ...manifest.skills.map((name) => read(path.join(f.out, 'skills', name, 'SKILL.md'))),
      ...manifest.agent_files.map((name) => read(path.join(f.out, 'agents', name))),
    ];
    for (const text of texts) assert.ok(!/\$\{CLAUDE_PLUGIN_ROOT\}|\/shipyard:/.test(text));
    assert.ok(texts.some((text) => text.includes(path.join(f.codexHome, 'shipyard'))));
    assert.ok(texts.some((text) => text.includes('$shipyard-')));
  });
});

suite('compatibility settings cannot tune the ADR-014 grid');

const compatibilityConfigs = {
  'empty palette': { pipeline: { codex_models: [] } },
  'one-entry palette': { pipeline: { codex_models: [{ model: 'foreign-model', effort: 'low' }] } },
  'GSD string palette': { delivery_pipeline: { codex_models: 'foreign-floor:low, foreign-ceiling:high' } },
  'malformed palette entries': { pipeline: { codex_models: [{ effort: 'high' }, { model: 42 }] } },
  'adaptive ladder': { delivery_pipeline: { model_ladder: 'adaptive' } },
  'role override': { delivery_pipeline: { models: { 'arch-review': 'sonnet' } } },
  'runtime tier remap': { model_policy: { runtime_tiers: { codex: { sonnet: 'foreign-model' } } } },
  'profile remap': { model_profile_overrides: { codex: { sonnet: 'foreign-model' } } },
};
for (const [name, project] of Object.entries(compatibilityConfigs)) {
  test(name + ' cannot remove, promote or downgrade canonical files', () => {
    withFixture({ project }, (f) => { generated(f); assertCanonical(f); });
  });
}

test('global GSD remaps cannot override the static policy either', () => {
  withFixture({ defaults: {
    model_policy: { runtime_tiers: { codex: { sonnet: 'foreign-model' } } },
    model_profile_overrides: { codex: { sonnet: 'another-model' } },
  } }, (f) => { generated(f); assertCanonical(f); });
});

test('CLI version hints do not substitute for explicit host capability evidence', () => {
  withFixture({}, (f) => {
    for (const version of ['0.0.1', '999.0.0', 'invalid-local']) {
      const result = f.run(['--capabilities', f.capabilitiesFile], { SHIPYARD_CODEX_CLI_VERSION: version });
      assert.strictEqual(result.status, 0, result.stderr);
      assertCanonical(f);
    }
    const before = snapshot(f.out);
    const refused = f.run([], { SHIPYARD_CODEX_CLI_VERSION: '999.0.0' });
    assert.strictEqual(refused.status, 1, refused.stderr);
    assert.match(refused.stderr, /read host capabilities/);
    assert.deepStrictEqual(snapshot(f.out), before);
  });
});

suite('fail-closed inputs');

for (const [name, raw] of Object.entries({
  truncated: '{ "pipeline": {',
  multiline: 'TODO\nfix this later\n',
})) {
  test(name + ' project config refuses fresh generation without a model-less bundle', () => {
    withFixture({ projectRaw: raw }, (f) => {
      const result = f.run();
      assert.strictEqual(result.status, 1, result.stderr);
      assert.match(result.stderr, /cannot read project config/);
      assert.match(result.stderr, /not valid JSON/);
      assert.ok(!fs.existsSync(f.out));
    });
  });
}

test('a foreign caller cwd cannot hide the explicitly selected invalid project', () => {
  withFixture({}, (f) => {
    generated(f);
    const before = snapshot(f.out);
    write(path.join(f.proj, '.planning/config.json'), '{');
    const result = f.run();
    assert.strictEqual(result.status, 1, result.stderr);
    assert.match(result.stderr, /cannot read project config/);
    assert.deepStrictEqual(snapshot(f.out), before, 'refusal must preserve the complete prior stage');
  });
});

test('an unreadable config refuses generation before replacing a previous stage', () => {
  withFixture({}, (f) => {
    generated(f);
    const before = snapshot(f.out);
    fs.mkdirSync(path.join(f.proj, '.planning/config.json'), { recursive: true });
    const result = f.run();
    assert.strictEqual(result.status, 1, result.stderr);
    assert.match(result.stderr, /cannot read project config/);
    assert.deepStrictEqual(snapshot(f.out), before);
  });
});

test('no project config is valid and still produces a complete model-bearing bundle', () => {
  withFixture({}, (f) => { generated(f); assertCanonical(f); });
});

for (const phase of ['2foo', '0', '3', '1.5', 'NaN']) {
  test('phase validation rejects ' + phase, () => {
    withFixture({ phase }, (f) => {
      const result = f.run();
      assert.strictEqual(result.status, 1, result.stderr);
      assert.match(result.stderr, /--phase must be 1 or 2/);
      assert.ok(!fs.existsSync(f.out));
    });
  });
}

test('an unusable plugin refuses generation instead of inheriting the CLI model', () => {
  withFixture({}, (f) => {
    const result = f.run(['--plugin', path.join(f.dir, 'absent')]);
    assert.strictEqual(result.status, 1, result.stderr);
    assert.match(result.stderr, /plugin dir not found/);
    assert.ok(!fs.existsSync(f.out));
  });
});

test('an incompatible GSD converter refuses generation', () => {
  withFixture({}, (f) => {
    write(f.converter, 'module.exports = {};');
    const result = f.run();
    assert.strictEqual(result.status, 1, result.stderr);
    assert.match(result.stderr, /gsd-core lib missing export/);
    assert.ok(!fs.existsSync(f.out));
  });
});

test('capabilities can be supplied by the installer environment', () => {
  withFixture({}, (f) => {
    const result = f.run([], { SHIPYARD_CODEX_CAPABILITIES_FILE: f.capabilitiesFile });
    assert.strictEqual(result.status, 0, result.stderr);
    assertCanonical(f);
  });
});

const badCapabilities = {
  missing: null,
  malformed: '{',
  'non-object': 'null',
  empty: '{}',
  'missing models': JSON.stringify({ ...CAPABILITIES, supportedModels: [] }),
  'missing efforts': JSON.stringify({ ...CAPABILITIES, supportedEfforts: [] }),
  'missing pairs': JSON.stringify({ ...CAPABILITIES, supportedSelections: [] }),
  'invalid pairs': JSON.stringify({ ...CAPABILITIES, supportedSelections: {} }),
};
for (const [name, raw] of Object.entries(badCapabilities)) {
  test(name + ' capability evidence refuses generation without clearing a good stage', () => {
    withFixture({}, (f) => {
      generated(f);
      const before = snapshot(f.out);
      if (raw === null) fs.unlinkSync(f.capabilitiesFile);
      else write(f.capabilitiesFile, raw);
      const result = f.run();
      assert.strictEqual(result.status, 1, result.stderr);
      assert.match(result.stderr, /capabilities|required/);
      assert.deepStrictEqual(snapshot(f.out), before);
    });
  });
}

test('capability validation includes the dynamic executor, with phase-specific requirements', () => {
  const research = policy.CODEX_ROLE_RUNG_DEFINITIONS.research;
  const capabilities = {
    ...CAPABILITIES,
    supportedSelections: research.map((rung) => ({
      model: policy.CODEX_MODEL_IDS[rung.model_key], effort: rung.effort,
    })),
  };
  // Phase 1's research/decomposition pairs are sufficient for that bundle,
  // but cannot authorize phase 2's dynamic executor at Luna/max.
  validateCodexCapabilities(capabilities, 1);
  assert.throws(() => validateCodexCapabilities(capabilities, 2), /required executor\/base/);
  validateCodexCapabilities(CAPABILITIES, 1);
  validateCodexCapabilities(CAPABILITIES, 2);
  const { supportedSelections, ...modelAndEffortEvidence } = CAPABILITIES;
  validateCodexCapabilities(modelAndEffortEvidence);
  assert.ok(supportedSelections.length > 0);
});

test('losing any single required model, effort or pair refuses the complete bundle', () => {
  for (const field of ['supportedModels', 'supportedEfforts', 'supportedSelections']) {
    const values = [...new Set(CAPABILITIES[field].map((value) => JSON.stringify(value)))];
    for (const removed of values) {
      const capabilities = {
        ...CAPABILITIES,
        [field]: CAPABILITIES[field].filter((value) => JSON.stringify(value) !== removed),
      };
      assert.throws(() => validateCodexCapabilities(capabilities), /cannot apply required/,
        field + ' missing ' + removed);
    }
  }
});

suite('manifest and artifact validation');

const manifestMutations = {
  'policy id': (m) => { m.policy_id = 'foreign'; },
  'policy version': (m) => { m.policy_version = 'obsolete'; },
  'policy fingerprint': (m) => { m.policy_hash = '0'.repeat(64); },
  destination: (m) => { m.codexHome += '-foreign'; },
  phase: (m) => { m.phase = 1; },
  'invalid config marker': (m) => { m.config_invalid = 'invalid'; },
  'omitted file': (m) => { m.agent_files.pop(); },
  'duplicate file': (m) => { m.agent_files.push(m.agent_files[0]); },
  'missing agent': (m) => { m.agents.pop(); },
  'missing registration': (m) => { m.registrations.pop(); },
  'dynamic role declaration': (m) => { m.dynamic_roles = []; },
  'agent digest': (m) => { m.agent_digests[m.agent_files[0]] = '0'.repeat(64); },
  'missing digests': (m) => { delete m.agent_digests; },
  'skill digest': (m) => { m.skill_digests[m.skills[0]] = '0'.repeat(64); },
  'skill payload digest': (m) => { m.skill_file_digests[m.skill_files[0]] = '0'.repeat(64); },
  'bundle payload digest': (m) => { m.bundle_digests[m.bundle_files[0]] = '0'.repeat(64); },
  'missing payload manifest': (m) => { delete m.bundle_files; },
  'converter path binding': (m) => { m.gsdLib += '-foreign'; },
  'converter digest binding': (m) => { m.gsd_lib_digest = '0'.repeat(64); },
  'config digest': (m) => { m.config_digest = '0'.repeat(64); },
};
for (const [name, mutate] of Object.entries(manifestMutations)) {
  test('rejects manifest with ' + name, () => {
    withFixture({}, (f) => {
      const manifest = generated(f);
      mutate(manifest);
      writeJson(path.join(f.out, 'manifest.json'), manifest);
      assert.throws(() => gen.validateCodexBundle(f.out, f.options), /Codex|GSD converter/);
    });
  });
}

const artifactMutations = {
  'missing agent': (f, m) => fs.unlinkSync(path.join(f.out, 'agents', m.agent_files[0])),
  'dynamic agent': (f) => write(path.join(f.out, 'agents', policy.codexAgentFile('executor', 'base')), 'foreign'),
  'foreign GSD skill': (f) => write(path.join(f.out, 'skills/gsd-executor/SKILL.md'), 'foreign'),
  'tampered skill': (f, m) => write(path.join(f.out, 'skills', m.skills[0], 'SKILL.md'), 'tampered'),
  'missing skill': (f, m) => fs.unlinkSync(path.join(f.out, 'skills', m.skills[0], 'SKILL.md')),
  'stale policy payload': (f) => fs.appendFileSync(path.join(f.out, 'bundle/scripts/model-policy.cjs'), '// stale'),
  'tampered nested payload': (f, m) => fs.appendFileSync(
    path.join(f.out, 'bundle', m.bundle_files.find((file) => file.startsWith('references/'))), '// stale'),
  'extra nested payload': (f) => write(path.join(f.out, 'bundle/references/foreign-review.md'), 'foreign'),
  'extra nested skill payload': (f, m) => write(
    path.join(f.out, 'skills', m.skills[0], 'references/foreign.md'), 'foreign'),
  'unregistered agents': (f, m) => {
    write(path.join(f.out, 'config.fragment.toml'), '');
    m.config_digest = hash('');
  },
  'misdirected registration': (f, m) => {
    const file = path.join(f.out, 'config.fragment.toml');
    const text = read(file).replace(f.codexHome, f.codexHome + '-foreign');
    write(file, text);
    m.config_digest = hash(text);
  },
  'symlinked agent': (f, m) => {
    const file = path.join(f.out, 'agents', m.agent_files[0]);
    const target = path.join(f.dir, 'foreign.toml');
    fs.renameSync(file, target);
    fs.symlinkSync(target, file);
  },
};
for (const [name, mutate] of Object.entries(artifactMutations)) {
  test('rejects ' + name + ' even with an otherwise valid manifest', () => {
    withFixture({}, (f) => {
      const manifest = generated(f);
      mutate(f, manifest);
      writeJson(path.join(f.out, 'manifest.json'), manifest);
      assert.throws(() => gen.validateCodexBundle(f.out, f.options), /Codex|ENOENT/);
    });
  });
}

test('a converter swap after generation invalidates the staged bundle', () => {
  withFixture({}, (f) => {
    generated(f);
    fs.appendFileSync(f.converter, '// converter changed after validation\n');
    assert.throws(() => gen.validateCodexBundle(f.out, f.options), /converter/);
  });
});

const agentMutations = {
  'model-less file': (s) => s.replace(/^model = .*\n/m, ''),
  'foreign model': (s) => s.replace(/^model = .*$/m, 'model = "foreign-model"'),
  'downgraded effort': (s) => s.replace(/^model_reasoning_effort = .*$/m, 'model_reasoning_effort = "low"'),
  'wrong role': (s) => s.replace(/^# shipyard-policy-role = .*$/m, '# shipyard-policy-role = "executor"'),
  'wrong rung': (s) => s.replace(/^# shipyard-policy-rung = .*$/m, '# shipyard-policy-rung = "unknown"'),
  'wrong sandbox': (s) => s.replace(/^sandbox_mode = .*$/m, 'sandbox_mode = "danger-full-access"'),
  'duplicate model': (s) => s.replace(/^model = .*$/m, (line) => line + '\n' + line),
  'trailing configuration': (s) => s + '\nmodel = "foreign-model"\n',
  'unterminated instructions': (s) => s.replace(/'''\n$/, ''),
};
for (const [name, mutate] of Object.entries(agentMutations)) {
  test('a recomputed digest cannot authorize: ' + name, () => {
    withFixture({}, (f) => {
      const manifest = generated(f);
      const name = manifest.agent_files[0];
      const file = path.join(f.out, 'agents', name);
      const before = read(file);
      const after = mutate(before);
      assert.notStrictEqual(after, before, 'mutation must actually change the fixture');
      write(file, after);
      manifest.agent_digests[name] = hash(after);
      writeJson(path.join(f.out, 'manifest.json'), manifest);
      assert.throws(() => gen.validateCodexBundle(f.out, f.options), /Codex/);
    });
  });
}

suite('offline installation preserves foreign ownership');

function install(f, phase = 2, { capabilities = true } = {}) {
  // GSD's capability boundary is the only external installer dependency.
  write(path.join(f.codexHome, 'gsd-core/bin/gsd-tools.cjs'), [
    "const fs = require('fs'); const path = require('path');",
    "const args = process.argv.slice(2);",
    "if (args[0] !== 'capability' || args[1] !== 'install') process.exit(99);",
    "fs.cpSync(args[2], path.join(process.env.GSD_CAPABILITIES_DIR, 'delivery-pipeline'), { recursive: true });",
  ].join('\n'));
  const env = { ...f.env };
  if (capabilities) env.SHIPYARD_CODEX_CAPABILITIES_FILE = f.capabilitiesFile;
  return spawnSync('/bin/bash', [path.join(ROOT, 'scripts/install-shipyard-codex.sh'),
    '--phase', String(phase), '--project-dir', f.proj], {
    cwd: f.dir, encoding: 'utf8',
    env,
  });
}

function seedForeign(f) {
  for (const role of ['gsd-planner', 'gsd-executor']) {
    write(path.join(f.env.AGENTS_SKILLS_DIR, role, 'SKILL.md'), '# Foreign ' + role + '\n');
    write(path.join(f.env.AGENTS_SKILLS_DIR, role, 'references/context.md'), 'foreign context\n');
    write(path.join(f.codexHome, 'agents', role + '.toml'), 'name = "' + role + '"\n');
  }
  write(path.join(f.codexHome, 'agents/shipyard-operators-own.toml'), 'name = "operator"\n');
  write(path.join(f.codexHome, 'config.toml'), [
    'model = "operators-model"', '[agents.gsd-planner]',
    'description = "foreign planner"', 'config_file = "agents/gsd-planner.toml"', '',
  ].join('\n'));
}

test('install and reinstall preserve foreign GSD skills, agents and registrations', () => {
  withFixture({}, (f) => {
    seedForeign(f);
    const foreignSkills = snapshot(f.env.AGENTS_SKILLS_DIR);
    const planner = read(path.join(f.codexHome, 'agents/gsd-planner.toml'));
    for (let iteration = 0; iteration < 2; iteration++) {
      const result = install(f);
      assert.strictEqual(result.status, 0, result.stderr + result.stdout);
      const manifest = json(path.join(f.codexHome, 'agents/.shipyard-manifest.json'));
      assert.strictEqual(manifest.policy_hash, policy.POLICY_HASH);
      assert.deepStrictEqual(manifest.agent_files.slice().sort(), expectedVariants(2).map((v) => v.file).sort());
      for (const [name, contents] of foreignSkills) {
        assert.deepStrictEqual(snapshot(path.join(f.env.AGENTS_SKILLS_DIR, name)), contents);
      }
      assert.strictEqual(read(path.join(f.codexHome, 'agents/gsd-planner.toml')), planner);
      assert.strictEqual(read(path.join(f.codexHome, 'agents/gsd-executor.toml')), 'name = "gsd-executor"\n');
      assert.strictEqual(read(path.join(f.codexHome, 'agents/shipyard-operators-own.toml')), 'name = "operator"\n');
      const config = read(path.join(f.codexHome, 'config.toml'));
      assert.ok(config.includes('model = "operators-model"'));
      assert.ok(config.includes('[agents.gsd-planner]\ndescription = "foreign planner"\nconfig_file = "agents/gsd-planner.toml"'));
      assert.strictEqual((config.match(/^# shipyard-agents:begin/gm) || []).length, 1);
      for (const name of manifest.agent_files) {
        assert.strictEqual(hash(read(path.join(f.codexHome, 'agents', name))), manifest.agent_digests[name]);
      }
      for (const name of manifest.skills) {
        assert.strictEqual(hash(read(path.join(f.env.AGENTS_SKILLS_DIR, name, 'SKILL.md'))), manifest.skill_digests[name]);
      }
      for (const role of policy.DYNAMIC_ROLES) {
        assert.ok(!fs.existsSync(path.join(f.codexHome, 'agents', policy.codexAgentFile(role, 'base'))));
      }
    }
  });
});

test('a bare install provisions the canonical capability contract', () => {
  withFixture({}, (f) => {
    const result = install(f, 2, { capabilities: false });
    assert.strictEqual(result.status, 0, result.stderr + result.stdout);
    const manifest = json(path.join(f.codexHome, 'agents/.shipyard-manifest.json'));
    assert.deepStrictEqual(manifest.agent_files.slice().sort(), expectedVariants(2).map((v) => v.file).sort());
  });
});

test('the installer bootstraps GSD before rejecting a missing converter/tools install', () => {
  withFixture({}, (f) => {
    fs.rmSync(f.converter);
    const bootstrap = path.join(f.dir, 'bootstrap-gsd.cjs');
    write(bootstrap, [
      "const fs = require('fs'); const path = require('path');",
      `fs.mkdirSync(${JSON.stringify(path.dirname(f.converter))}, { recursive: true });`,
      `fs.writeFileSync(${JSON.stringify(f.converter)}, ${JSON.stringify(STUB_CONVERTER)});`,
      `fs.writeFileSync(${JSON.stringify(path.join(f.codexHome, 'gsd-core/bin/gsd-tools.cjs'))}, ${JSON.stringify([
        "const fs = require('fs'); const path = require('path');",
        "const args = process.argv.slice(2);",
        "if (args[0] !== 'capability' || args[1] !== 'install') process.exit(99);",
        "fs.cpSync(args[2], path.join(process.env.GSD_CAPABILITIES_DIR, 'delivery-pipeline'), { recursive: true });",
      ].join('\n'))});`,
    ].join('\n'));
    write(path.join(f.dir, 'bin/npm'), '#!/bin/sh\nprintf "1.13.0\\n"\n');
    write(path.join(f.dir, 'bin/npx'), `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(bootstrap)}\n`);
    fs.chmodSync(path.join(f.dir, 'bin/npm'), 0o755);
    fs.chmodSync(path.join(f.dir, 'bin/npx'), 0o755);
    const result = spawnSync('/bin/bash', [path.join(ROOT, 'scripts/install-shipyard-codex.sh'),
      '--phase', '2', '--project-dir', f.proj], {
      cwd: f.dir, encoding: 'utf8', env: { ...f.env, SHIPYARD_GSD_AUTO_INSTALL: '1' },
    });
    assert.strictEqual(result.status, 0, result.stderr + result.stdout);
    assert.ok(fs.existsSync(path.join(f.codexHome, 'agents/.shipyard-manifest.json')));
  });
});

test('refused installation leaves existing skills and runtime bytes untouched', () => {
  withFixture({}, (f) => {
    seedForeign(f);
    const first = install(f);
    assert.strictEqual(first.status, 0, first.stderr + first.stdout);
    const before = snapshot(f.home);
    writeJson(f.capabilitiesFile, {});
    const refused = install(f);
    assert.strictEqual(refused.status, 1, refused.stderr);
    assert.match(refused.stderr, /cannot apply required/);
    assert.deepStrictEqual(snapshot(f.home), before);
  });
});

done();
