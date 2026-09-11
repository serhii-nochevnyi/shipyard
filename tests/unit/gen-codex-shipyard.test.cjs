'use strict';

// On Codex an agent is a FILE: one model, one effort, written at install time and
// nothing passed per dispatch. So the whole model policy for that runtime is
// decided HERE, by the generator, and the only way to test it is to look at the
// files it writes.
//
// The fixture is a throwaway HOME holding a FAKE gsd-core — the converter plus
// the two model-resolver entry points and the config loader we call — so this
// suite needs neither network nor an installed gsd-core. The smoke test
// (tests/smoke/codex-shipyard-smoke.sh) is the end-to-end half, against the real
// converter and the real resolver; it is the one that would catch GSD changing
// the API under us, which is why the stubs below mirror gsd-core's semantics
// rather than inventing convenient ones.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { suite, test, done, assert } = require(path.join(__dirname, 'assert-harness.cjs'));

const ROOT = path.join(__dirname, '..', '..');
const GEN = path.join(ROOT, 'scripts', 'gen-codex-shipyard.cjs');
const PLUGIN = path.join(ROOT, 'plugins', 'delivery-pipeline');
const gen = require(GEN);
const pc = require(path.join(PLUGIN, 'scripts', 'pipeline-config.cjs'));

const FLOOR = pc.DEFAULT_CODEX_MODELS[0];
const CEILING = pc.DEFAULT_CODEX_MODELS[pc.DEFAULT_CODEX_MODELS.length - 1];
// The CLI version the ceiling entry declares it needs, read from the palette so
// this file holds no version literal of its own.
const CEILING_FLOOR_CLI = CEILING.min_cli;

// ── the fixture: a HOME with a stub gsd-core ─────────────────────────────────

const STUB_CONVERTER = `'use strict';
// The real converter rewrites Claude-isms; here identity is enough — what is
// under test is the model policy, not the conversion.
module.exports = {
  convertClaudeCommandToCodexSkill: (raw) => raw,
  convertClaudeToCodexMarkdown: (raw) => raw,
};
`;

// Mirrors gsd-core's model-resolver.cjs: resolveTierEntry merges the user's
// model_profile_overrides OVER the builtin catalog entry, and resolveModelPolicy
// reads model_policy.runtime_tiers[runtime][tier] (its "Sub-path A").
const STUB_RESOLVER = `'use strict';
const BUILTIN = { codex: { opus: { model: 'builtin-opus' }, sonnet: { model: 'builtin-sonnet' }, haiku: { model: 'builtin-haiku' } } };
function resolveTierEntry({ runtime, tier, overrides }) {
  if (!runtime || !tier) return null;
  const builtin = (BUILTIN[runtime] || {})[tier] || null;
  const raw = overrides && overrides[runtime] && overrides[runtime][tier];
  const user = raw ? (typeof raw === 'string' ? { model: raw } : raw) : null;
  if (!builtin && !user) return null;
  return { ...(builtin || {}), ...(user || {}) };
}
function resolveModelPolicy(policy, tier) {
  if (!policy || typeof policy !== 'object' || !tier) return null;
  const rt = policy.runtime_tiers;
  const entry = rt && policy.runtime && rt[policy.runtime] && rt[policy.runtime][tier];
  if (!entry) return null;
  const e = typeof entry === 'string' ? { model: entry } : entry;
  return e && e.model ? e.model : null;
}
module.exports = { resolveTierEntry, resolveModelPolicy };
`;

// Mirrors the rule that matters to us: the PROJECT's config wins outright, and
// ~/.gsd/defaults.json is read only when the project has none.
const STUB_LOADER = `'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
function read(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return null; } }
function loadConfig(cwd) {
  const project = read(path.join(cwd || process.cwd(), '.planning', 'config.json'));
  if (project) return project;
  const home = process.env.GSD_HOME || os.homedir();
  return read(path.join(home, '.gsd', 'defaults.json')) || {};
}
module.exports = { loadConfig };
`;

function fixture({ palette, project, projectRaw, defaults, codexStubVersion } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-codexgen-'));
  const home = path.join(dir, 'home');
  const lib = path.join(home, '.codex', 'gsd-core', 'bin', 'lib');
  fs.mkdirSync(lib, { recursive: true });
  fs.writeFileSync(path.join(lib, 'runtime-artifact-conversion.cjs'), STUB_CONVERTER);
  fs.writeFileSync(path.join(lib, 'model-resolver.cjs'), STUB_RESOLVER);
  fs.writeFileSync(path.join(lib, 'config-loader.cjs'), STUB_LOADER);

  if (defaults) {
    fs.mkdirSync(path.join(home, '.gsd'), { recursive: true });
    fs.writeFileSync(path.join(home, '.gsd', 'defaults.json'), JSON.stringify(defaults, null, 2));
  }

  const proj = path.join(dir, 'proj');
  fs.mkdirSync(proj, { recursive: true });
  if (projectRaw !== undefined) {
    // A config that does NOT PARSE cannot be expressed through JSON.stringify,
    // so this one is written verbatim. Deliberately the only way to reach that
    // state in this fixture: an invalid config is a fact about the bytes.
    fs.mkdirSync(path.join(proj, '.planning'), { recursive: true });
    fs.writeFileSync(path.join(proj, '.planning', 'config.json'), projectRaw);
  } else if (palette !== undefined || project) {
    const cfg = { ...(project || {}) };
    if (palette !== undefined) cfg.pipeline = { ...(cfg.pipeline || {}), codex_models: palette };
    fs.mkdirSync(path.join(proj, '.planning'), { recursive: true });
    fs.writeFileSync(path.join(proj, '.planning', 'config.json'), JSON.stringify(cfg, null, 2));
  }

  let stubBin = null;
  if (codexStubVersion) {
    stubBin = path.join(dir, 'bin');
    fs.mkdirSync(stubBin, { recursive: true });
    const p = path.join(stubBin, 'codex');
    fs.writeFileSync(p, `#!/bin/sh\necho "codex-cli ${codexStubVersion}"\n`);
    fs.chmodSync(p, 0o755);
  }

  return { dir, home, proj, codexHome: path.join(home, '.codex'), stubBin };
}

// Run the generator the way the installer does: as a process, from the project's
// cwd. In-process would fight gsd-core's own config caching and os.homedir().
function generate(opts = {}) {
  const f = fixture(opts);
  const out = path.join(f.dir, 'out');
  const env = { ...process.env, HOME: f.home, GSD_HOME: f.home, CODEX_HOME: f.codexHome };
  if (opts.codexStubVersion) {
    // Exercise the real `codex --version` probe.
    delete env.SHIPYARD_CODEX_CLI_VERSION;
    env.PATH = `${f.stubBin}:${env.PATH}`;
  } else {
    env.SHIPYARD_CODEX_CLI_VERSION = opts.cliVersion || CEILING_FLOOR_CLI;
  }
  const r = spawnSync(process.execPath, [
    GEN, '--plugin', PLUGIN, '--out', out, '--codex-home', f.codexHome,
    '--phase', String(opts.phase === undefined ? 2 : opts.phase),
    '--project-dir', f.proj,
  ], { cwd: os.tmpdir(), encoding: 'utf8', env });
  const agentsDir = path.join(out, 'agents');
  const agents = {};
  if (fs.existsSync(agentsDir)) {
    for (const file of fs.readdirSync(agentsDir)) {
      const text = fs.readFileSync(path.join(agentsDir, file), 'utf8');
      const model = text.match(/^model = "(.*)"$/m);
      const effort = text.match(/^model_reasoning_effort = "(.*)"$/m);
      agents[file.replace(/\.toml$/, '')] = {
        model: model ? model[1] : null,
        effort: effort ? effort[1] : null,
        text,
      };
    }
  }
  return { ...f, out, run: r, agents, stderr: r.stderr || '' };
}

test('a foreign caller cwd cannot hide the explicitly selected project policy', () => {
  const f = fixture({ project: { delivery_pipeline: { model_ladder: 'adaptive' } } });
  const out = path.join(f.dir, 'foreign-out');
  const env = {
    ...process.env,
    HOME: f.home,
    GSD_HOME: f.home,
    CODEX_HOME: f.codexHome,
    SHIPYARD_CODEX_CLI_VERSION: CEILING_FLOOR_CLI,
  };
  const r = spawnSync(process.execPath, [
    GEN, '--plugin', PLUGIN, '--out', out, '--codex-home', f.codexHome,
    '--project-dir', f.proj,
  ], { cwd: os.tmpdir(), encoding: 'utf8', env });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.ok(fs.existsSync(path.join(out, 'agents', 'shipyard-arch-review-critical.toml')),
    'the selected project policy must reach generation from another cwd');
});

// A minimal line-level TOML shape check — no full parser, but enough to catch
// the class of bug a regex-only assertion cannot: every non-blank line must
// either be a `#` comment or a `key = value` pair. A raw line of prose (a
// verbatim JSON.parse error can embed one) is neither, and a regex like
// `/^model = "(.*)"$/m` finds its target line regardless of what garbage sits
// beside it — which is exactly why `agents[name].text` matching that regex was
// never evidence the FILE parses.
function assertLooksLikeToml(text, label) {
  // `developer_instructions = '''…'''` legitimately spans many raw lines (the
  // agent's own prose body) — those are content, not structure, and the check
  // below is about STRUCTURE lines only, so everything between a `'''` that
  // opens one and the `'''` that closes it is skipped.
  let inMultiline = false;
  for (const line of text.split('\n')) {
    if (inMultiline) {
      if (line.trim() === "'''") inMultiline = false;
      continue;
    }
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    if (/=\s*'''$/.test(trimmed)) { inMultiline = true; continue; }
    assert.ok(/^[A-Za-z0-9_-]+\s*=\s*.+$/.test(trimmed),
      `${label}: line is neither a comment nor a key = value pair: ${JSON.stringify(line)}`);
  }
  assert.ok(!inMultiline, `${label}: an opened ''' block never closed`);
}

// ── the palette, and what each role gets from it ─────────────────────────────

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

test('the README example is the shipped palette, not a snapshot of one', () => {
  // The docs may quote the DEFAULT — that is the carve-out — but a quote that
  // stops matching the default is exactly the staleness this ticket removes, so
  // it is checked rather than trusted.
  const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
  const quoted = readme.match(/"codex_models":\s*"([^"]+)"/);
  assert.ok(quoted, 'README should show a codex_models example');
  assert.deepStrictEqual(pc.normalizeCodexModels(quoted[1], []), pc.DEFAULT_CODEX_MODELS);
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
      offenders.push(`${path.relative(ROOT, file)}:${i + 1}: ${hit[0]}`);
    });
  }
  assert.deepStrictEqual(offenders, []);
});

suite('codexModelFor — the role a file is written for');

test('the executor takes the palette floor at the working effort', () => {
  // The executor has no agent FILE (the main loop dispatches it), so the
  // function's answer is the whole contract for that role.
  const f = fixture();
  const policy = gen.codexModelPolicy(PLUGIN, f.codexHome, {
    cwd: f.proj, env: { SHIPYARD_CODEX_CLI_VERSION: CEILING_FLOOR_CLI }, log: () => {},
  });
  assert.deepStrictEqual(policy.forRole('executor'), { model: FLOOR.model, effort: 'high' });
});

test('the integrator takes the ceiling, unconditionally', () => {
  const f = fixture();
  const policy = gen.codexModelPolicy(PLUGIN, f.codexHome, {
    cwd: f.proj, env: { SHIPYARD_CODEX_CLI_VERSION: CEILING_FLOOR_CLI }, log: () => {},
  });
  assert.deepStrictEqual(policy.forRole('integrator'), { model: CEILING.model, effort: CEILING.effort });
});

test('an unusable plugin dir leaves the agent on the CLI default, loudly', () => {
  const lines = [];
  const got = gen.codexModelFor('ci-fix', path.join(os.tmpdir(), 'no-such-plugin'), '/nope', {
    log: (m) => lines.push(m),
  });
  assert.deepStrictEqual(got, { model: null, effort: null });
  assert.ok(lines.join('').includes('CLI default'), lines.join(''));
});

suite('the generated agent files');

test('every role carries the model and effort the palette implies', () => {
  const g = generate();
  assert.strictEqual(g.run.status, 0, g.stderr);
  const want = {
    'shipyard-drift-check': [FLOOR.model, 'low'],
    'shipyard-inv-research': [FLOOR.model, 'high'],
    'shipyard-ci-fix': [FLOOR.model, 'high'],
    'shipyard-review-fix': [FLOOR.model, 'high'],
    'shipyard-pr-sentinel': [FLOOR.model, 'high'],
    'shipyard-arch-review': [FLOOR.model, 'high'],
    'shipyard-integrator': [CEILING.model, CEILING.effort],
  };
  for (const [name, [model, effort]] of Object.entries(want)) {
    assert.ok(g.agents[name], `missing ${name}`);
    assert.strictEqual(g.agents[name].model, model, `${name} model`);
    assert.strictEqual(g.agents[name].effort, effort, `${name} effort`);
  }
});

test('the four escalating roles get a -deep file at the ceiling; the integrator does not', () => {
  const g = generate();
  for (const role of ['ci-fix', 'review-fix', 'pr-sentinel', 'arch-review']) {
    const a = g.agents[`shipyard-${role}-deep`];
    assert.ok(a, `missing shipyard-${role}-deep`);
    assert.strictEqual(a.model, CEILING.model, `${role}-deep model`);
    assert.strictEqual(a.effort, CEILING.effort, `${role}-deep effort`);
    assert.ok(/Escalation variant/.test(a.text), `${role}-deep says nothing about being one`);
  }
  assert.ok(!g.agents['shipyard-integrator-deep'], 'the integrator is already at the ceiling');
  assert.strictEqual(Object.keys(g.agents).length, 11, Object.keys(g.agents).join(', '));
});

test('the -deep agents are registered, so a dispatch can name them', () => {
  const g = generate();
  const frag = fs.readFileSync(path.join(g.out, 'config.fragment.toml'), 'utf8');
  for (const role of ['ci-fix', 'review-fix', 'pr-sentinel', 'arch-review']) {
    assert.ok(frag.includes(`[agents.shipyard-${role}-deep]`), `${role}-deep not registered`);
  }
  const manifest = JSON.parse(fs.readFileSync(path.join(g.out, 'manifest.json'), 'utf8'));
  assert.strictEqual(manifest.agents.length, 11);
});

test('adaptive mode adds distinct critical files while keeping the integrator at the ceiling', () => {
  const g = generate({ project: { delivery_pipeline: { model_ladder: 'adaptive' } } });
  assert.strictEqual(g.run.status, 0, g.stderr);
  assert.strictEqual(g.agents['shipyard-integrator'].model, CEILING.model);
  for (const role of ['inv-research', 'arch-review', 'ci-fix', 'review-fix']) {
    const a = g.agents[`shipyard-${role}-critical`];
    assert.ok(a, `missing critical variant for ${role}`);
    assert.strictEqual(a.model, CEILING.model, `${role}-critical model`);
    assert.strictEqual(a.effort, CEILING.effort, `${role}-critical effort`);
    assert.ok(/Critical task variant/.test(a.text), `${role}-critical says why it exists`);
  }
  assert.ok(!g.agents['shipyard-pr-sentinel-critical'], 'mechanical sentinel has no premium variant');
  assert.ok(!g.agents['shipyard-drift-check-critical'], 'mechanical drift check has no premium variant');
  assert.ok(!g.agents['shipyard-integrator-critical'], 'integrator is already at the ceiling');
  assert.strictEqual(Object.keys(g.agents).length, 15, Object.keys(g.agents).join(', '));
});

test('an explicit pipeline model override keeps generated variants on its chosen lane', () => {
  const g = generate({
    project: {
      delivery_pipeline: {
        model_ladder: 'adaptive',
        models: { 'arch-review': 'sonnet' },
      },
    },
  });
  assert.strictEqual(g.run.status, 0, g.stderr);
  assert.strictEqual(g.agents['shipyard-arch-review'].model, FLOOR.model, g.stderr);
  assert.ok(!g.agents['shipyard-arch-review-deep'], 'override must not create a promoted recovery file');
  assert.ok(!g.agents['shipyard-arch-review-critical'], 'override must not create a promoted critical file');
});

test('no generated file asks for a retired effort', () => {
  // ADR-005 D6: on this runtime the axis is two values wide. `xhigh`/`max` cost
  // more for no better result, and `ultra` is not in the vocabulary at all.
  const g = generate();
  for (const [name, a] of Object.entries(g.agents)) {
    assert.ok(['low', 'high'].includes(a.effort), `${name} carries effort "${a.effort}"`);
    assert.ok(!/model_reasoning_effort = "(xhigh|max|ultra)"/.test(a.text), name);
  }
});

test('a one-entry palette produces seven agents and no dead -deep files', () => {
  const g = generate({ palette: [{ model: 'only-model', effort: 'high' }] });
  assert.strictEqual(g.run.status, 0, g.stderr);
  assert.strictEqual(Object.keys(g.agents).length, 7, Object.keys(g.agents).join(', '));
  assert.ok(!Object.keys(g.agents).some((n) => n.endsWith('-deep')), 'a -deep duplicate is worse than none');
  assert.strictEqual(g.agents['shipyard-integrator'].model, 'only-model');
});

test('an empty palette writes no model at all — the previous behaviour, kept as the floor', () => {
  const g = generate({ palette: [] });
  assert.strictEqual(g.run.status, 0, g.stderr);
  assert.strictEqual(Object.keys(g.agents).length, 7);
  for (const [name, a] of Object.entries(g.agents)) {
    assert.strictEqual(a.model, null, `${name} should carry no model key`);
    assert.ok(a.effort, `${name} still carries an effort`);
  }
});

test('a malformed entry is skipped with a line, and the rest still ship', () => {
  const g = generate({ palette: [{ effort: 'high' }, { model: '' }, { model: 42 }, { model: 'survivor', effort: 'high' }] });
  assert.strictEqual(g.run.status, 0, g.stderr);
  assert.strictEqual(g.agents['shipyard-integrator'].model, 'survivor');
  assert.ok(/codex_models/.test(g.stderr), g.stderr);
  assert.ok((g.stderr.match(/skipped/g) || []).length >= 3, g.stderr);
});

test('the palette also accepts the string form GSD can set', () => {
  const g = generate({ palette: 'a-floor:low, a-ceiling:high' });
  assert.strictEqual(g.agents['shipyard-drift-check'].model, 'a-floor');
  assert.strictEqual(g.agents['shipyard-drift-check'].effort, 'low');
  // The entry's declared effort is a ceiling the role rule may go under, never
  // over: the floor entry says `low`, so even the working roles get `low`.
  assert.strictEqual(g.agents['shipyard-ci-fix'].effort, 'low');
  assert.strictEqual(g.agents['shipyard-integrator'].model, 'a-ceiling');
  assert.strictEqual(g.agents['shipyard-integrator'].effort, 'high');
});

suite('the CLI version floor');

test('below the floor the ceiling is refused and the floor entry ships instead', () => {
  const g = generate({ cliVersion: '0.147.0' });
  assert.strictEqual(g.run.status, 0, g.stderr);
  assert.ok(!Object.values(g.agents).some((a) => a.model === CEILING.model),
    `no agent may name ${CEILING.model} below the floor`);
  assert.strictEqual(g.agents['shipyard-integrator'].model, FLOOR.model);
  assert.ok(!Object.keys(g.agents).some((n) => n.endsWith('-deep')));
  assert.ok(g.stderr.includes(CEILING_FLOOR_CLI), `stderr must name the version it needs: ${g.stderr}`);
});

test('the version comes from the CLI itself when nothing pins it', () => {
  // The probe, not the override: a stub `codex` on PATH reporting a version
  // below the floor must produce the same refusal.
  const g = generate({ codexStubVersion: '0.147.0' });
  assert.strictEqual(g.run.status, 0, g.stderr);
  assert.strictEqual(g.agents['shipyard-integrator'].model, FLOOR.model);
  assert.ok(g.stderr.includes(CEILING_FLOOR_CLI), g.stderr);
  const ok = generate({ codexStubVersion: '0.153.4' });
  assert.strictEqual(ok.agents['shipyard-integrator'].model, CEILING.model, ok.stderr);
});

test('a floor entry above the CLI floor reorders the survivors', () => {
  const g = generate({
    cliVersion: '1.0.0',
    palette: [
      { model: 'too-new', effort: 'high', min_cli: '2.0.0' },
      { model: 'usable', effort: 'high' },
    ],
  });
  assert.strictEqual(g.agents['shipyard-ci-fix'].model, 'usable');
  assert.strictEqual(g.agents['shipyard-integrator'].model, 'usable');
  assert.ok(!Object.keys(g.agents).some((n) => n.endsWith('-deep')));
});

test('an entry with no min_cli is never filtered, whatever the CLI reports', () => {
  const g = generate({ cliVersion: '0.0.1', palette: [{ model: 'floor-x', effort: 'high' }, { model: 'ceiling-x', effort: 'high' }] });
  assert.strictEqual(g.agents['shipyard-integrator'].model, 'ceiling-x');
  assert.strictEqual(g.agents['shipyard-ci-fix-deep'].model, 'ceiling-x');
});

test('compareVersions is numeric, not lexical', () => {
  assert.strictEqual(gen.compareVersions('0.153.10', '0.153.9'), 1);
  assert.strictEqual(gen.compareVersions('0.153.1', '0.153.1'), 0);
  assert.strictEqual(gen.compareVersions('0.99.0', '0.153.0'), -1);
  assert.strictEqual(gen.compareVersions('1.0', '1.0.0'), 0);
});

test('a malformed SHIPYARD_CODEX_CLI_VERSION is treated as unknown', () => {
  assert.strictEqual(gen.detectCodexCliVersion({ SHIPYARD_CODEX_CLI_VERSION: '0.999.0-local' }), null);
});

suite('a project config that does not parse is refused, not baked (ADR-004 D2)');

// The generator is the LAST of ADR-004 D2's readers. `pc.loadConfig` answers
// `{ valid: false }` for a file that exists and does not parse, and returns
// DEFAULTS in `config` so a reader still has something to render — so a reader
// that ignores `valid` bakes this repo's shipped palette into eleven agent files
// and presents it as the operator's decision. On this runtime that is written
// ONCE, at install time, and then every dispatch for the life of the install
// reads it back out of a `.toml`.
//
// Install time is the lowest of the three severities the backlog ranks (it is
// not a delivery mutation), and that cuts BOTH ways: the refusal must withhold
// the tiers without turning a working install into a broken one. So exit 0,
// every skill, every agent and the fragment still written — asserted below
// rather than promised in a sentence.
const CORRUPT = '{ "pipeline": { "codex_models": "a-floor:low, a-ceiling:high"';

test('a corrupt config bakes NO tier, and every agent file carries the reason', () => {
  const g = generate({ projectRaw: CORRUPT });
  assert.strictEqual(g.run.status, 0, g.stderr);
  assert.ok(Object.keys(g.agents).length >= 7, Object.keys(g.agents).join(', '));
  for (const [name, a] of Object.entries(g.agents)) {
    assert.strictEqual(a.model, null, `${name} must carry no model key`);
    // The EFFORT is withheld too, and for the same reason as the model: it is
    // resolved off `loaded.config`, which is DEFAULTS here. A written effort
    // would be a default presented as something the file said.
    assert.strictEqual(a.effort, null, `${name} must carry no effort key`);
    assert.ok(/no policy is in effect/.test(a.text), `${name} does not say why it has no model`);
  }
  assert.ok(/no policy is in effect/.test(g.stderr), g.stderr);
  assert.ok(g.stderr.includes(path.join('.planning', 'config.json')), `stderr must name the file: ${g.stderr}`);
  assert.ok(/not valid JSON/.test(g.stderr), g.stderr);
});

test('the refused answer is never the DEFAULT palette answer', () => {
  // The defect, stated as an assertion: on base the integrator was written at
  // the shipped ceiling off a file that says nothing readable at all.
  const g = generate({ projectRaw: CORRUPT });
  for (const [name, a] of Object.entries(g.agents)) {
    assert.ok(a.model !== FLOOR.model, `${name} names the default floor off an unreadable config`);
    assert.ok(a.model !== CEILING.model, `${name} names the default ceiling off an unreadable config`);
  }
  // Nothing to escalate TO, so no dead -deep file either.
  assert.ok(!Object.keys(g.agents).some((n) => n.endsWith('-deep')), Object.keys(g.agents).join(', '));
});

test('an install still completes — the refusal withholds tiers, not the install', () => {
  const g = generate({ projectRaw: CORRUPT });
  assert.strictEqual(g.run.status, 0, g.stderr);
  for (const skill of ['shipyard-route', 'shipyard-deliver', 'shipyard-delivery-rules']) {
    assert.ok(fs.existsSync(path.join(g.out, 'skills', skill, 'SKILL.md')), `missing skill ${skill}`);
  }
  assert.ok(fs.existsSync(path.join(g.out, 'config.fragment.toml')), 'the agents must still be registered');
  const manifest = JSON.parse(fs.readFileSync(path.join(g.out, 'manifest.json'), 'utf8'));
  assert.strictEqual(manifest.agents.length, 7);
});

test('the manifest carries the reason, so a caller need not scrape stderr', () => {
  const g = generate({ projectRaw: CORRUPT });
  const manifest = JSON.parse(fs.readFileSync(path.join(g.out, 'manifest.json'), 'utf8'));
  assert.ok(manifest.config_invalid, 'manifest.json must carry the refusal');
  assert.ok(/no policy is in effect/.test(manifest.config_invalid), manifest.config_invalid);
});

// `CORRUPT` above is truncated JSON: V8 answers a short, POSITIONAL message
// ("Unexpected end of JSON input") with no snippet of the file's own bytes, so
// it never reaches the multi-line form the reason-comment embeds verbatim. A
// short file that is not JSON AT ALL (never even starts parsing a structure)
// gets the other shape: V8 quotes the offending bytes back, newlines included —
// this is the shape a human hand-typing a placeholder into the file produces,
// and it is a `# ` comment away from splitting into a bare, unparseable line
// (Copilot round; arch-review, PR #71, ADR-004 D6 / audit F21).
const CORRUPT_MULTILINE = 'TODO\nfix this later\n';

test('a config whose parse error embeds a multi-line snippet still yields parseable TOML', () => {
  const g = generate({ projectRaw: CORRUPT_MULTILINE });
  assert.strictEqual(g.run.status, 0, g.stderr);
  assert.ok(Object.keys(g.agents).length >= 7, Object.keys(g.agents).join(', '));
  for (const [name, a] of Object.entries(g.agents)) {
    assert.strictEqual(a.model, null, `${name} must carry no model key`);
    assert.ok(/no policy is in effect/.test(a.text), `${name} does not say why it has no model`);
    // The refusal reason is multi-line at the source (loadConfig's JSON.parse
    // message quotes the file's own "TODO\nfix this later\n" back), so a file
    // that still line-parses is the whole of what this test is proving.
    assertLooksLikeToml(a.text, name);
  }
});

test('NO config file at all is not a refusal — the regression the guard could introduce', () => {
  // A fresh project has no `.planning/config.json`, and an installer runs before
  // any project exists: `valid: true, error: null, warnings: []`. If this ever
  // refuses, installation stops working for the commonest case there is.
  const g = generate();
  assert.strictEqual(g.run.status, 0, g.stderr);
  assert.strictEqual(g.agents['shipyard-integrator'].model, CEILING.model, g.stderr);
  assert.strictEqual(g.agents['shipyard-ci-fix'].model, FLOOR.model, g.stderr);
  assert.ok(!/no policy is in effect/.test(g.stderr), g.stderr);
  const manifest = JSON.parse(fs.readFileSync(path.join(g.out, 'manifest.json'), 'utf8'));
  assert.strictEqual(manifest.config_invalid, undefined, 'an absent config is not an invalid one');
  for (const [name, a] of Object.entries(g.agents)) {
    assert.ok(!/no policy is in effect/.test(a.text), `${name} must carry no refusal`);
  }
});

test('a config that PARSES is still read, palette and all', () => {
  const g = generate({ palette: 'p-floor:low, p-ceiling:high' });
  assert.strictEqual(g.agents['shipyard-integrator'].model, 'p-ceiling', g.stderr);
  assert.ok(!/no policy is in effect/.test(g.stderr), g.stderr);
});

test('codexModelPolicy carries the reason on its own result, and answers inert', () => {
  // The unit under the process: one role in, one `{model, effort}` out. Both
  // halves are null, exactly as the "could not load the model policy" branch
  // beside it answers — the previous, safe behaviour, reached deliberately.
  const f = fixture({ projectRaw: CORRUPT });
  const lines = [];
  const policy = gen.codexModelPolicy(PLUGIN, f.codexHome, {
    cwd: f.proj, env: { SHIPYARD_CODEX_CLI_VERSION: CEILING_FLOOR_CLI }, log: (m) => lines.push(m),
  });
  assert.ok(policy.configInvalid, 'the policy object must carry the reason');
  assert.deepStrictEqual(policy.palette, []);
  assert.deepStrictEqual(policy.forRole('executor'), { model: null, effort: null });
  assert.deepStrictEqual(policy.forRole('integrator'), { model: null, effort: null });
  assert.ok(/no policy is in effect/.test(lines.join('')), lines.join(''));
});

suite('a GSD remap still wins');

test('model_policy.runtime_tiers.codex.<tier> outranks the palette', () => {
  // The claim the docs made and the generator never honoured (audit F23): it
  // read runtimeTierDefaults straight out of the catalog, where no user key can
  // reach. Resolved through GSD's own resolver, a remap takes effect again.
  const g = generate({ defaults: { model_policy: { runtime_tiers: { codex: { sonnet: 'x-model' } } } } });
  assert.strictEqual(g.run.status, 0, g.stderr);
  for (const [name, a] of Object.entries(g.agents)) {
    assert.strictEqual(a.model, 'x-model', `${name} should follow the remap`);
  }
  // One model for the whole tier leaves the escalation nothing to be.
  assert.ok(!Object.keys(g.agents).some((n) => n.endsWith('-deep')));
});

test('model_profile_overrides.codex.<tier> outranks the palette too', () => {
  const g = generate({ defaults: { model_profile_overrides: { codex: { sonnet: 'y-model' } } } });
  assert.strictEqual(g.agents['shipyard-ci-fix'].model, 'y-model', g.stderr);
});

test('the catalog default is NOT a remap — that is what the palette replaces', () => {
  // The stub resolver returns `builtin-sonnet` for an unremapped tier, exactly
  // as gsd-core's catalog does. Honouring that would put us back where this
  // ticket started: the operator's palette ignored in favour of GSD's own map.
  const g = generate({ defaults: { model_profile_overrides: { codex: {} } } });
  assert.strictEqual(g.agents['shipyard-ci-fix'].model, FLOOR.model, g.stderr);
});

suite('the prose that makes the -deep agents reachable');

test('the deliver skill and the sentinel agent both name all four', () => {
  const g = generate();
  const skill = fs.readFileSync(path.join(g.out, 'skills', 'shipyard-deliver', 'SKILL.md'), 'utf8');
  const sentinel = g.agents['shipyard-pr-sentinel'].text;
  for (const role of ['ci-fix', 'review-fix', 'pr-sentinel', 'arch-review']) {
    assert.ok(skill.includes(`shipyard-${role}-deep`), `deliver skill does not name shipyard-${role}-deep`);
    assert.ok(sentinel.includes(`shipyard-${role}-deep`), `pr-sentinel does not name shipyard-${role}-deep`);
  }
  for (const text of [skill, sentinel]) {
    assert.ok(/repeat_exhausted/.test(text), 'the repair escalation has no named trigger');
    assert.ok(/violation/.test(text), 'the judge escalation has no named trigger');
  }
});

test('phase 1 emits no -deep file — none of those roles exists yet', () => {
  const g = generate({ phase: 1 });
  assert.strictEqual(g.run.status, 0, g.stderr);
  assert.deepStrictEqual(Object.keys(g.agents), ['shipyard-inv-research']);
});

test('phase validation rejects numeric prefixes instead of accepting a partial integer', () => {
  const g = generate({ phase: '2foo' });
  assert.notStrictEqual(g.run.status, 0);
  assert.match(g.stderr, /--phase must be 1 or 2/);
});

suite('the CLI floor is measured against what is EFFECTIVE (ADR-007 D4)');

// The remap wins over the palette — deliberately, and that stays. What does NOT
// follow is that it wins over the CLI: `forRole` returned the remapped model
// before any `min_cli` comparison, so a version refusal that had just removed an
// entry from the palette was undone by a key the same run read afterwards.
// Measured on this repository: CLI 0.147.0 correctly drops the ceiling entry and
// `model_profile_overrides.codex.sonnet.model` puts it straight back at `high`,
// with the "not writing" line printed in the same run.
//
// Every role resolves to ONE tier on this runtime (capForRuntime caps them to the
// workhorse), which is why remapping a single tier reaches all eleven files.

test('a remap naming a palette model the CLI cannot configure is refused', () => {
  const g = generate({
    cliVersion: '0.147.0',
    defaults: { model_profile_overrides: { codex: { sonnet: CEILING.model } } },
  });
  assert.strictEqual(g.run.status, 0, g.stderr);
  assert.ok(!Object.values(g.agents).some((a) => a.model === CEILING.model),
    `no agent may name ${CEILING.model} below its declared floor, however it was chosen: `
    + Object.entries(g.agents).map(([n, a]) => `${n}=${a.model}`).join(', '));
  // One line, naming the model and the version it needs — the same shape the
  // palette refusal prints, because it is the same fact one step later.
  assert.ok(g.stderr.includes(CEILING_FLOOR_CLI), `stderr must name the version needed: ${g.stderr}`);
  assert.ok(g.stderr.includes(CEILING.model), `stderr must name the model refused: ${g.stderr}`);
  assert.strictEqual((g.stderr.match(/not writing the remapped/g) || []).length, 1,
    `one line, not one per role: ${g.stderr}`);
  // The fallback is the palette entry the role would otherwise have taken — the
  // same answer the palette's own refusal gives ("every role gets the previous
  // palette entry instead"), and it always works.
  assert.strictEqual(g.agents['shipyard-ci-fix'].model, FLOOR.model, g.stderr);
  assert.strictEqual(g.agents['shipyard-integrator'].model, FLOOR.model, g.stderr);
  assert.ok(!Object.keys(g.agents).some((n) => n.endsWith('-deep')),
    'one usable entry leaves the escalation nothing to be');
});

test('a remapped model with NO palette entry is still written, at any CLI version', () => {
  // The guard against over-correcting this into an allowlist, which ADR-005 D8
  // rejected outright: GSD's catalog does not carry every model an operator has,
  // so an unknown id cannot be told from a new one. Only a floor the palette
  // itself DECLARES may refuse anything.
  const g = generate({
    cliVersion: '0.1.0',
    defaults: { model_profile_overrides: { codex: { sonnet: 'operators-own-model' } } },
  });
  assert.strictEqual(g.run.status, 0, g.stderr);
  for (const [name, a] of Object.entries(g.agents)) {
    assert.strictEqual(a.model, 'operators-own-model', `${name} must keep the operator's remap`);
  }
  assert.ok(!/not writing the remapped/.test(g.stderr), `nothing to refuse: ${g.stderr}`);
});

test('a remap to a palette model the CLI CAN configure is written untouched', () => {
  const g = generate({
    cliVersion: CEILING_FLOOR_CLI,
    defaults: { model_profile_overrides: { codex: { sonnet: CEILING.model } } },
  });
  assert.strictEqual(g.agents['shipyard-ci-fix'].model, CEILING.model, g.stderr);
  assert.ok(!/not writing the remapped/.test(g.stderr), g.stderr);
});

test('the floor is read from the palette entry, not from the surviving palette', () => {
  // The entry the filter DROPPED is the only place the remapped model's floor is
  // declared, so the map has to be built before the filter runs. A lookup over
  // the survivors alone finds nothing and the refusal never fires.
  // Both in the PROJECT config: GSD's loader returns it outright when it exists,
  // so a remap parked in ~/.gsd/defaults.json beside a project palette would
  // never be read at all.
  const g = generate({
    cliVersion: '1.0.0',
    palette: [
      { model: 'usable', effort: 'high' },
      { model: 'too-new', effort: 'high', min_cli: '2.0.0' },
    ],
    project: { model_profile_overrides: { codex: { sonnet: 'too-new' } } },
  });
  assert.strictEqual(g.agents['shipyard-ci-fix'].model, 'usable', g.stderr);
  assert.ok(g.stderr.includes('2.0.0'), g.stderr);
});

test('the generator writes nothing outside --out', () => {
  // It is told where the Codex home is and never touches it: placing files there
  // is the installer's act, and this ticket adds two reads of that tree.
  const snapshot = (dir) => {
    const out = [];
    const walk = (d, rel) => {
      for (const ent of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        const p = path.join(d, ent.name);
        const r = path.join(rel, ent.name);
        if (ent.isDirectory()) walk(p, r);
        else out.push(`${r}:${fs.readFileSync(p, 'utf8').length}`);
      }
    };
    walk(dir, '');
    return out;
  };
  const f = fixture({ defaults: { model_profile_overrides: { codex: { sonnet: CEILING.model } } } });
  const before = snapshot(f.home);
  gen.codexModelPolicy(PLUGIN, f.codexHome, {
    cwd: f.proj, env: { SHIPYARD_CODEX_CLI_VERSION: '0.147.0' }, log: () => {},
  }).forRole('integrator');
  assert.deepStrictEqual(snapshot(f.home), before, 'reading a config is not writing one');
});

done();
