'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const SCRIPTS = path.resolve(__dirname, '../../plugins/delivery-pipeline/scripts');
const script = (name) => path.join(SCRIPTS, name);

const ENTRIES = [
  { file: 'codex-delivery-host.cjs', runtime: 'codex' },
  { file: 'codex-decompose-host.cjs', runtime: 'codex' },
  { file: 'codex-planning-context-host.cjs', runtime: 'codex' },
  { file: 'claude-delivery-host.cjs', runtime: 'claude' },
  { file: 'claude-investigation-host.cjs', runtime: 'claude' },
  { file: 'claude-role-host.cjs', runtime: 'claude' },
  { file: 'claude-decompose-host.cjs', runtime: 'claude' },
];
const LAUNCHERS = [
  { file: 'deliver-dispatch.cjs', reason: 'preflight runs in-process inside launch before the dispatch directory exists' },
];
const PROBES = [
  { file: 'codex-runtime-host.cjs', schema: 'shipyard.codex-runtime-probe.v1', args: ['--capability-only'] },
  { file: 'claude-runtime-host.cjs', schema: 'shipyard.claude-runtime-probe.v1', args: ['--capability-only', '--executable', '/nonexistent/claude'] },
];
const EXCLUDED = [
  { file: 'claude-workflow-host.cjs', reason: 'has a CLI but no controller.begin, no bookkeeping and nothing to preflight' },
];

const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'host-entry-contract-')));
test.after(() => fs.rmSync(scratch, { recursive: true, force: true }));

function cliScripts() {
  return fs.readdirSync(SCRIPTS)
    .filter((name) => (name.endsWith('-host.cjs') || name === 'deliver-dispatch.cjs')
      && fs.readFileSync(script(name), 'utf8').includes('require.main === module'))
    .sort();
}

test('every script with a CLI main is classified exactly once', () => {
  const lists = { ENTRIES, LAUNCHERS, PROBES, EXCLUDED };
  const owners = new Map();
  for (const [name, list] of Object.entries(lists)) {
    for (const item of list) owners.set(item.file, [...(owners.get(item.file) || []), name]);
  }
  for (const file of cliScripts()) {
    const where = owners.get(file) || [];
    assert.equal(where.length, 1, `${file} must be in exactly one of ENTRIES, LAUNCHERS, PROBES or EXCLUDED (found in: ${where.join(', ') || 'none'})`);
  }
  for (const [file, where] of owners) {
    assert.equal(where.length, 1, `${file} is listed more than once: ${where.join(', ')}`);
    assert.ok(fs.existsSync(script(file)), `${file} is listed but does not exist`);
    assert.ok(cliScripts().includes(file), `${file} is listed but has no CLI main`);
  }
  for (const item of [...LAUNCHERS, ...EXCLUDED]) assert.ok(item.reason.length > 10, `${item.file} needs a reason`);
});

function capabilityEvidence(file) {
  const policy = require('../../plugins/delivery-pipeline/scripts/model-policy.cjs');
  const selections = Object.values(policy.CODEX_ROLE_RUNG_DEFINITIONS).flat()
    .map((rung) => ({ model: policy.CODEX_MODEL_IDS[rung.model_key], effort: rung.effort }));
  fs.writeFileSync(file, JSON.stringify({
    supportedModels: [...new Set(selections.map((item) => item.model))],
    supportedEfforts: [...new Set(selections.map((item) => item.effort))],
    supportedSelections: selections,
  }));
}

function fakeRuntimes(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const markers = ['--model', '--effort', '--output-format', 'stream-json', '--session-id', '--permission-mode',
    '--permission-prompts', '--allowedTools', '--tools', '--restricted', '--strict-mcp-config', '--settings',
    '--setting-sources', '--agent', '--agents'].join(' ');
  fs.writeFileSync(path.join(dir, 'claude'),
    `#!/bin/sh\ncase "$1" in\n  --version) echo "9.9.9 (Claude Code)";;\n  --help) echo "${markers}";;\n  auth) echo '{"loggedIn":true}';;\nesac\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(dir, 'codex'),
    '#!/bin/sh\ncase "$1" in\n  --version) echo "codex-cli 9.9.9";;\n  exec) echo "--json --model --config --cd --ignore-user-config";;\nesac\n', { mode: 0o755 });
}

function world(name) {
  const root = path.join(scratch, name);
  const project = path.join(root, 'project');
  fs.mkdirSync(path.join(project, '.planning/graph/provenance'), { recursive: true });
  fs.mkdirSync(path.join(root, 'home'));
  fs.mkdirSync(path.join(root, 'xdg'));
  fs.writeFileSync(path.join(project, '.planning/graph/tickets.json'), '{"tickets":{}}\n');
  execFileSync('git', ['-C', project, 'init', '-q'], { stdio: 'ignore' });
  capabilityEvidence(path.join(root, 'capabilities.json'));
  fakeRuntimes(path.join(root, 'bin'));
  return { root, project, home: path.join(root, 'home'), xdg: path.join(root, 'xdg') };
}

function environmentFor(w, runtime, { evidence = true } = {}) {
  return {
    PATH: `${path.join(w.root, 'bin')}:/usr/bin:/bin`,
    HOME: w.home, XDG_STATE_HOME: w.xdg, XDG_CONFIG_HOME: w.xdg, SHIPYARD_RUNTIME: runtime,
    ...(runtime === 'codex' && evidence ? { SHIPYARD_CODEX_CAPABILITIES_FILE: path.join(w.root, 'capabilities.json') } : {}),
  };
}

function snapshot(...roots) {
  const rows = [];
  const walk = (entry) => {
    if (path.basename(entry) === '.git') return;
    const stat = fs.lstatSync(entry);
    if (stat.isDirectory()) {
      rows.push(`d ${entry}`);
      for (const name of fs.readdirSync(entry).sort()) walk(path.join(entry, name));
    } else if (stat.isSymbolicLink()) rows.push(`l ${entry} ${fs.readlinkSync(entry)}`);
    else rows.push(`f ${entry} ${crypto.createHash('sha256').update(fs.readFileSync(entry)).digest('hex')}`);
  };
  roots.forEach(walk);
  return rows.join('\n');
}

function runPreflight(entry, w, options) {
  const result = spawnSync(process.execPath, [script(entry.file), '--preflight'], {
    cwd: w.project, env: environmentFor(w, entry.runtime, options), encoding: 'utf8', timeout: 60000 });
  const json = result.stdout.trim().split('\n').filter(Boolean).map((line) => { try { return JSON.parse(line); } catch { return null; } })
    .find((value) => value && value.schema === 'shipyard.host-preflight.v1');
  return { ...result, json };
}

function assertHintPerFinding(entry, outcome) {
  assert.ok(outcome.json, `${entry.file}: no preflight JSON on stdout: ${outcome.stdout}${outcome.stderr}`);
  const hints = outcome.stderr.split('\n').filter((line) => line.startsWith('hint['));
  assert.equal(hints.length, outcome.json.findings.length, `${entry.file}: one hint line per finding`);
  outcome.json.findings.forEach((finding, index) => assert.ok(hints[index].startsWith(`hint[${finding.code}]`), `${entry.file}: ${hints[index]}`));
}

for (const entry of ENTRIES) {
  test(`${entry.file} accepts --preflight alone, passes a clean fixture and refuses a broken one without writing state`, () => {
    const w = world(`entry-${entry.file}`);
    const before = snapshot(w.project, w.home, w.xdg);
    const clean = runPreflight(entry, w);
    assert.equal(clean.status, 0, `${entry.file} clean: ${clean.stderr}`);
    assert.equal(clean.json.ok, true);
    assert.equal(clean.json.findings.length, 0);
    assert.equal(snapshot(w.project, w.home, w.xdg), before, `${entry.file} changed the clean fixture`);

    fs.symlinkSync(path.join(w.root, 'capabilities.json'), path.join(w.project, '.planning/graph/provenance/member.json'));
    const brokenBefore = snapshot(w.project, w.home, w.xdg);
    const broken = runPreflight(entry, w);
    assert.equal(broken.status, 1, `${entry.file} broken: ${broken.stdout}${broken.stderr}`);
    assert.equal(broken.json.ok, false);
    assert.ok(broken.json.findings.some((finding) => finding.code === 'LEGACY_HISTORY_UNSAFE'), `${entry.file} must report the symlinked provenance member`);
    assertHintPerFinding(entry, broken);
    assert.equal(snapshot(w.project, w.home, w.xdg), brokenBefore, `${entry.file} wrote state while refusing`);
    assert.equal(fs.readdirSync(w.home).length + fs.readdirSync(w.xdg).length, 0, `${entry.file} created an authority or run-store directory`);
  });
}

for (const entry of ENTRIES.filter((item) => item.runtime === 'codex')) {
  test(`${entry.file} refuses missing capability evidence with a hint`, () => {
    const w = world(`evidence-${entry.file}`);
    const outcome = runPreflight(entry, w, { evidence: false });
    assert.equal(outcome.status, 1, outcome.stderr);
    assert.ok(outcome.json.findings.some((finding) => finding.code === 'RUNTIME_CAPABILITY_MISSING'));
    assertHintPerFinding(entry, outcome);
  });
}

test('deliver-dispatch calls the shared preflight before it creates a dispatch directory', () => {
  const source = fs.readFileSync(script('deliver-dispatch.cjs'), 'utf8');
  assert.match(source, /require\('\.\/runtime-context\.cjs'\)/);
  const start = source.indexOf('async function launch(');
  assert.ok(start >= 0, 'launch function exists');
  const body = source.slice(start);
  const gate = body.indexOf('preflight(');
  const create = body.indexOf('prepareDispatchDir(');
  assert.ok(gate >= 0 && create >= 0, 'launch calls both preflight and prepareDispatchDir');
  assert.ok(gate < create, 'preflight must precede prepareDispatchDir inside launch');
});

for (const probe of PROBES) {
  test(`${probe.file} stays a probe: exit 0 with its JSON when the runtime is unavailable`, () => {
    const w = world(`probe-${probe.file}`);
    const result = spawnSync(process.execPath, [script(probe.file), ...probe.args], {
      cwd: w.project, encoding: 'utf8', timeout: 60000,
      env: { PATH: '/usr/bin:/bin', HOME: w.home, XDG_STATE_HOME: w.xdg } });
    assert.equal(result.status, 0, result.stderr);
    const json = JSON.parse(result.stdout.trim().split('\n')[0]);
    assert.equal(json.schema, probe.schema);
    assert.equal(json.status, 'unavailable');
    assert.ok(!fs.readdirSync(w.xdg).length, 'a probe writes no state');
  });
}

test('claude-role-host --capability-only exits 0 with the Claude probe JSON when the runtime is unavailable', () => {
  const w = world('probe-role-host');
  const result = spawnSync(process.execPath, [script('claude-role-host.cjs'), '--capability-only'], {
    cwd: w.project, encoding: 'utf8', timeout: 60000, env: { PATH: '/usr/bin:/bin', HOME: w.home, XDG_STATE_HOME: w.xdg } });
  assert.equal(result.status, 0, result.stderr);
  const json = JSON.parse(result.stdout.trim().split('\n')[0]);
  assert.equal(json.schema, 'shipyard.claude-runtime-probe.v1');
  assert.equal(json.status, 'unavailable');
});

test('every emitted launch, preflight, legacy and identity code has a hint and a remedy', () => {
  const { RESOLVER_CODES, PREFLIGHT_CODES } = require('../../plugins/delivery-pipeline/scripts/runtime-context.cjs');
  const { LAUNCH_CODES, HINTS } = require('../../plugins/delivery-pipeline/scripts/refusal-hints.cjs');
  const legacy = ['LEGACY_HISTORY_UNSAFE', 'LEGACY_HISTORY_CHANGED', 'LEGACY_HISTORY_UNKNOWN_MEMBER', 'LEGACY_HISTORY_COLLISION',
    'LEGACY_HISTORY_MISSING', 'LEGACY_WRITER_STATE', 'ARCHIVE_AUTHORITY_INVALID', 'ARCHIVE_AUTHORITY_REQUIRED', 'ARCHIVE_AUTHORITY_BUSY'];
  const identity = ['REPOSITORY_IDENTITY_INVALID', 'DECOMPOSITION_SUBJECT_INVALID'];
  for (const code of new Set([...RESOLVER_CODES, ...PREFLIGHT_CODES, ...legacy, ...identity])) {
    assert.ok(LAUNCH_CODES.includes(code), `${code} is missing from LAUNCH_CODES`);
    assert.ok(Object.hasOwn(HINTS, code), `${code} has no hint entry`);
    assert.ok(HINTS[code].hint.trim() && HINTS[code].remedy.trim(), `${code} needs a non-empty hint and remedy`);
  }
});

const HOME_EXPRESSION = /(?:process\.env|\benv|\benvironment)\s*(?:\.\s*(?:CODEX_HOME|CLAUDE_CONFIG_DIR)\b|\[\s*['"](?:CODEX_HOME|CLAUDE_CONFIG_DIR)['"]\s*\])/;
const HOME_ALLOWLIST = new Map([
  ['runtime-context.cjs', 'the one implementation of the home rule'],
  ['codex-notify.cjs', 'derives its home from its install location when the variable is absent'],
  ['claude-runtime-host.cjs', 'forwards the variable into the child environment and builds no home path'],
  ['codex-runtime-host.cjs', 'source-layout fallback to explicit CODEX_HOME evidence when no installed bundle resolves'],
]);

test('no module builds its own Codex or Claude home expression outside the allowlist', () => {
  const offenders = [];
  for (const name of fs.readdirSync(SCRIPTS).filter((file) => file.endsWith('.cjs'))) {
    if (HOME_ALLOWLIST.has(name)) continue;
    fs.readFileSync(script(name), 'utf8').split('\n').forEach((line, index) => {
      const trimmed = line.trim();
      if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) return;
      if (HOME_EXPRESSION.test(line)) offenders.push(`${name}:${index + 1}`);
    });
  }
  assert.deepEqual(offenders, [], 'home expressions outside runtime-context.cjs and the allowlist');
  for (const [name, reason] of HOME_ALLOWLIST) {
    assert.ok(fs.existsSync(script(name)), `${name} is allowlisted but missing`);
    assert.ok(reason.length > 10);
  }
});
