'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const isolatedHome = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'host-preflight-home-')));
const originalHomedir = os.homedir;
os.homedir = () => isolatedHome;
for (const key of ['HOME', 'XDG_STATE_HOME', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR']) process.env[key] = isolatedHome;
process.on('exit', () => { os.homedir = originalHomedir; fs.rmSync(isolatedHome, { recursive: true, force: true }); });

const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { after, describe, it, mock } = require('node:test');
const scripts = '../../plugins/delivery-pipeline/scripts/';
const { preflight, emitPreflight, PREFLIGHT_CODES } = require(scripts + 'runtime-context.cjs');
const { LAUNCH_CODES, HINTS, formatHint } = require(scripts + 'refusal-hints.cjs');
const { POLICY_HASH } = require(scripts + 'model-policy.cjs');
const roleArtifact = require(scripts + 'role-artifact.cjs');
const { codexCapabilities } = require('../smoke/installed-launch/lib.cjs');

const roots = [];
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const tmp = (label) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'host-preflight-' + label + '-')));
  roots.push(root);
  return root;
};
after(() => { for (const root of roots) fs.rmSync(root, { recursive: true, force: true }); });

function installedLayout({ stale = false, cliVersion } = {}) {
  const root = tmp('install');
  const home = path.join(root, 'codex-home');
  const bundle = path.join(home, 'shipyard');
  const scriptDir = path.join(bundle, 'scripts');
  fs.mkdirSync(scriptDir, { recursive: true });
  fs.mkdirSync(path.join(home, 'agents'));
  const evidence = Buffer.from(JSON.stringify(codexCapabilities()));
  fs.writeFileSync(path.join(bundle, 'codex-capabilities.json'), evidence);
  const agent = Buffer.from('name = "x"\n');
  fs.writeFileSync(path.join(home, 'agents', 'a.toml'), agent);
  fs.writeFileSync(path.join(home, 'agents', '.shipyard-manifest.json'), JSON.stringify({
    phase: 2, codexHome: home, scriptsRoot: bundle, capabilities_file: 'codex-capabilities.json',
    capabilities_digest: digest(evidence), policy_hash: stale ? 'old' : POLICY_HASH,
    agent_files: ['a.toml'], agent_digests: { 'a.toml': digest(agent) },
    ...(cliVersion === undefined ? {} : { codex_cli_version: cliVersion }),
  }));
  return { root, home, bundle, scriptDir };
}

function project(members = {}) {
  const root = tmp('project');
  execFileSync('git', ['init', '-q', root]);
  fs.mkdirSync(path.join(root, '.planning', 'graph', 'provenance'), { recursive: true });
  for (const [name, body] of Object.entries(members)) {
    fs.writeFileSync(path.join(root, '.planning', 'graph', 'provenance', name), body);
  }
  return { root, graphDir: path.join(root, '.planning', 'graph'), provenance: path.join(root, '.planning', 'graph', 'provenance') };
}

function snapshot(...dirs) {
  const out = {};
  const walk = (entry) => {
    let stat;
    try { stat = fs.lstatSync(entry); } catch { return; }
    if (stat.isDirectory()) { out[entry] = 'dir'; for (const name of fs.readdirSync(entry).sort()) walk(path.join(entry, name)); }
    else out[entry] = stat.isSymbolicLink() ? 'link' : digest(fs.readFileSync(entry));
  };
  for (const dir of dirs) walk(dir);
  return out;
}

const base = (layout, extra = {}) => ({
  runtime: 'codex', scriptDir: layout.scriptDir, worktree: layout.root, env: {}, graphDir: null, ...extra,
});
const codes = (result) => result.findings.map((finding) => finding.code);

describe('host preflight', () => {
  it('runs with the isolated authority home', () => {
    assert.equal(require('node:os').homedir(), isolatedHome);
  });

  it('is ok on a clean installed fixture', () => {
    const layout = installedLayout();
    const result = preflight(base(layout, { env: { SHIPYARD_RUNTIME: 'codex' } }));
    assert.deepEqual(result.findings, []);
    assert.equal(result.ok, true);
    assert.equal(result.schema, 'shipyard.host-preflight.v1');
  });

  it('reports two simultaneous defects in one call', () => {
    const layout = installedLayout();
    const other = tmp('other');
    const first = preflight(base(layout, { env: { CODEX_HOME: other } }));
    assert.deepEqual(codes(first), ['ENV_CONFLICT']);
    const stale = installedLayout({ stale: true });
    fs.writeFileSync(path.join(stale.home, 'agents', 'a.toml'), 'changed');
    const result = preflight(base(stale, { probe: () => ({ status: 'unavailable', reason: 'runtime_missing' }) }));
    assert.deepEqual(codes(result).sort(), ['RUNTIME_UNAVAILABLE', 'STALE_GENERATED_AGENT']);
    assert.equal(result.ok, false);
    assert.ok(result.findings.find((f) => f.code === 'STALE_GENERATED_AGENT').detail.includes('a.toml'));
  });

  it('maps a capability probe reason to RUNTIME_CAPABILITY_MISSING', () => {
    const layout = installedLayout();
    const result = preflight(base(layout, { probe: () => ({ status: 'unavailable', reason: 'capability_evidence_missing' }) }));
    assert.deepEqual(codes(result), ['RUNTIME_CAPABILITY_MISSING']);
  });

  it('does not probe when the environment failed to resolve', () => {
    const probe = mock.fn(() => ({ status: 'unavailable', reason: 'capability_evidence_missing' }));
    const layout = installedLayout();
    const conflict = preflight(base(layout, { env: { CODEX_HOME: tmp('other') }, probe }));
    assert.deepEqual(codes(conflict), ['ENV_CONFLICT']);
    const stale = installedLayout();
    fs.appendFileSync(path.join(stale.bundle, 'codex-capabilities.json'), ' ');
    const aged = preflight(base(stale, { probe }));
    assert.deepEqual(codes(aged), ['CAPABILITY_EVIDENCE_STALE']);
    assert.equal(probe.mock.callCount(), 0);
    assert.ok(aged.notes.some((n) => /runtime probe: not evaluated/.test(n.detail)));
  });

  it('refuses an installed bundle whose evidence file is missing', () => {
    const layout = installedLayout();
    fs.rmSync(path.join(layout.bundle, 'codex-capabilities.json'));
    const result = preflight(base(layout, { env: { SHIPYARD_RUNTIME: 'codex' } }));
    assert.deepEqual(codes(result), ['CAPABILITY_EVIDENCE_STALE']);
    assert.equal(result.ok, false);
    const source = preflight({ runtime: 'codex', scriptDir: path.join(tmp('src'), 'scripts'), env: {}, graphDir: null });
    assert.equal(source.ok, true);
  });

  it('treats a throwing probe as a not-evaluated note while other checks still report', () => {
    const stale = installedLayout({ stale: true });
    const result = preflight(base(stale, { probe: () => { throw new Error('boom'); } }));
    assert.deepEqual(codes(result), ['STALE_GENERATED_AGENT']);
    assert.ok(result.notes.some((n) => n.kind === 'not-evaluated' && /runtime probe/.test(n.detail)));
    const only = preflight(base(installedLayout(), { probe: () => { throw new Error('boom'); } }));
    assert.equal(only.ok, true);
    const streams = { stdout: { write() {} }, stderr: { text: '', write(t) { this.text += t; } } };
    assert.equal(emitPreflight(only, streams), 0);
    assert.ok(!/hint\[/.test(streams.stderr.text));
  });

  it('classifies legacy history read from the host graph directory, not the worktree', () => {
    const layout = installedLayout();
    const a = project();
    const b = project({ 'one.json': '{}', 'two.json': '{}' });
    const onB = preflight(base(layout, { worktree: a.root, graphDir: b.graphDir }));
    assert.equal(onB.ok, true);
    assert.ok(onB.notes.some((n) => n.kind === 'adoptable' && n.detail.includes('2')));
    const onlyA = project({ 'one.json': '{}' });
    const empty = project();
    const result = preflight(base(layout, { worktree: onlyA.root, graphDir: empty.graphDir }));
    assert.deepEqual(result.notes.filter((n) => n.kind === 'adoptable'), []);
  });

  it('resolves an omitted graphDir through SHIPYARD_GRAPH_DIR and records a missing one', () => {
    const layout = installedLayout();
    const b = project({ 'one.json': '{}' });
    const viaEnv = preflight(base(layout, { graphDir: undefined, env: { SHIPYARD_GRAPH_DIR: b.graphDir } }));
    assert.ok(viaEnv.notes.some((n) => n.kind === 'adoptable'));
    const noGraph = 'legacy history: not evaluated, no graph directory';
    for (const graphDir of [null, path.join(tmp('x'), 'elsewhere'), path.join(tmp('y'), '.planning', 'graph')]) {
      const result = preflight(base(layout, { graphDir }));
      assert.ok(result.notes.some((n) => n.detail === noGraph), String(graphDir));
      assert.equal(result.ok, true);
    }
  });

  it('flags unsafe, changed and unknown legacy members', () => {
    const layout = installedLayout();
    const unsafe = project({ 'one.json': '{}' });
    fs.symlinkSync('one.json', path.join(unsafe.provenance, 'link.json'));
    assert.ok(codes(preflight(base(layout, { graphDir: unsafe.graphDir }))).includes('LEGACY_HISTORY_UNSAFE'));

    const adopted = project({ 'one.json': '{}' });
    roleArtifact.trustedBookkeepingMutation(adopted.root, () => {}, []);
    assert.equal(preflight(base(layout, { graphDir: adopted.graphDir })).ok, true);
    fs.writeFileSync(path.join(adopted.provenance, 'forged.json'), '{}');
    assert.ok(codes(preflight(base(layout, { graphDir: adopted.graphDir }))).includes('LEGACY_HISTORY_UNKNOWN_MEMBER'));
    fs.rmSync(path.join(adopted.provenance, 'forged.json'));
    fs.writeFileSync(path.join(adopted.provenance, 'one.json'), '{"changed":1}');
    assert.ok(codes(preflight(base(layout, { graphDir: adopted.graphDir }))).includes('LEGACY_HISTORY_CHANGED'));
  });

  it('reports an unreadable authority namespace as a note and still reports other defects', () => {
    const layout = installedLayout();
    const legacy = project({ 'one.json': '{}' });
    const real = fs.lstatSync;
    const mocked = mock.method(fs, 'lstatSync', (target, ...rest) => {
      if (String(target).includes('role-artifact-authority')) {
        throw Object.assign(new Error('denied'), { code: 'EPERM', syscall: 'lstat' });
      }
      return real(target, ...rest);
    });
    try {
      const result = preflight(base(layout, { graphDir: legacy.graphDir, env: { CODEX_HOME: tmp('other') } }));
      assert.deepEqual(codes(result), ['ENV_CONFLICT']);
      assert.ok(result.notes.some((n) => n.detail === 'legacy history: not evaluated, authority namespace unreadable (EPERM)'));
      const clean = preflight(base(layout, { graphDir: legacy.graphDir }));
      assert.equal(clean.ok, true);
    } finally { mocked.mock.restore(); }
  });

  it('keeps a forged catalogue a finding', () => {
    const layout = installedLayout();
    const forged = project({ 'one.json': '{}' });
    roleArtifact.trustedBookkeepingMutation(forged.root, () => {}, []);
    const directory = roleArtifact.archiveAuthorityDirectory(forged.root);
    fs.writeFileSync(path.join(directory, 'catalogue.json'), '{"payload":{},"mac":"x"}', { mode: 0o600 });
    const result = preflight(base(layout, { graphDir: forged.graphDir }));
    assert.deepEqual(codes(result), ['ARCHIVE_AUTHORITY_INVALID']);
  });

  it('reports a malformed catalogue as a finding, exits 1 and refuses a launch with the coded hint', () => {
    for (const body of ['garbage text', '{}', '[]', 'null']) {
      const layout = installedLayout();
      const broken = project({ 'one.json': '{}' });
      roleArtifact.trustedBookkeepingMutation(broken.root, () => {}, []);
      const directory = roleArtifact.archiveAuthorityDirectory(broken.root);
      fs.writeFileSync(path.join(directory, 'catalogue.json'), body, { mode: 0o600 });
      const result = preflight(base(layout, { graphDir: broken.graphDir }));
      assert.deepEqual(codes(result), ['ARCHIVE_AUTHORITY_INVALID'], body);
      assert.equal(result.ok, false, body);
      assert.ok(!result.notes.some((n) => /not evaluated/.test(n.detail) && /legacy history/.test(n.detail)), body);
      assert.match(result.findings[0].detail, /archive catalogue is not (valid JSON|an authenticated envelope)/, body);
      const streams = { stdout: { write() {} }, stderr: { text: '', write(t) { this.text += t; } } };
      assert.equal(emitPreflight(result, streams), 1);
      assert.match(streams.stderr.text, /hint\[ARCHIVE_AUTHORITY_INVALID\]/);
      assert.throws(() => roleArtifact.trustedBookkeepingMutation(broken.root, () => {}, []),
        (error) => error.code === 'ARCHIVE_AUTHORITY_INVALID' && !(error instanceof SyntaxError) && !(error instanceof TypeError), body);
    }
  });

  it('flags an invalid run store and a legacy planning writer', () => {
    const layout = installedLayout();
    const file = path.join(tmp('store'), 'store.json');
    fs.writeFileSync(file, '{"schema":"nope"}');
    assert.deepEqual(codes(preflight(base(layout, { runStoreFile: file }))), ['INVALID_STORE']);
    assert.deepEqual(codes(preflight(base(layout, { runStoreFile: file, scope: 'environment' }))), []);
    const phaseDir = tmp('phase');
    const worktree = tmp('wt');
    const writers = tmp('writers');
    const key = digest(`${fs.realpathSync(worktree)}\n${fs.realpathSync(phaseDir)}`);
    fs.mkdirSync(path.join(writers, key));
    fs.writeFileSync(path.join(writers, key, 'lease.json'), '{bad');
    const result = preflight(base(layout, { worktree, phaseDir, gsdRole: 'gsd-planner', writerRoots: [writers], graphDir: null }));
    assert.deepEqual(codes(result), ['LEGACY_WRITER_STATE']);
  });

  it('is read-only', () => {
    const layout = installedLayout();
    const legacy = project({ 'one.json': '{}' });
    const before = snapshot(legacy.root, layout.root, isolatedHome);
    preflight(base(layout, { graphDir: legacy.graphDir, probe: () => ({ status: 'ok' }) }));
    preflight(base(layout, { graphDir: legacy.graphDir, env: { CODEX_HOME: tmp('o') } }));
    assert.deepEqual(snapshot(legacy.root, layout.root, isolatedHome), before);
  });

  it('uses only codes the hint map knows', () => {
    for (const code of PREFLIGHT_CODES) assert.ok(LAUNCH_CODES.includes(code), code);
  });

  it('renders hint lines and exit codes', () => {
    const layout = installedLayout({ stale: true });
    const streams = { stdout: { text: '', write(t) { this.text += t; } }, stderr: { text: '', write(t) { this.text += t; } } };
    const result = preflight(base(layout, { host: 'codex-delivery-host.cjs' }));
    assert.equal(emitPreflight(result, streams), 1);
    assert.match(streams.stderr.text, /^preflight: 1 incompatibilities/);
    assert.match(streams.stderr.text, /hint\[STALE_GENERATED_AGENT\]/);
    assert.equal(JSON.parse(streams.stdout.text.trim()).ok, false);
    const ok = { schema: 'x', ok: true, findings: [], warnings: [{ code: 'LEGACY_HISTORY_MISSING', detail: 'p', vars: {} }], notes: [] };
    const quiet = { stdout: { write() {} }, stderr: { text: '', write(t) { this.text += t; } } };
    assert.equal(emitPreflight(ok, quiet), 0);
    assert.match(quiet.stderr.text, /preflight: warning\[LEGACY_HISTORY_MISSING\]/);
  });

  it('warns once when the installed Codex CLI differs from the recorded version', () => {
    const layout = installedLayout({ cliVersion: '0.147.0' });
    const result = preflight(base(layout, { cliVersion: () => '0.150.0' }));
    assert.deepEqual(result.findings, []);
    assert.equal(result.ok, true);
    const aged = result.warnings.filter((w) => w.code === 'CAPABILITY_SNAPSHOT_AGED');
    assert.equal(aged.length, 1);
    assert.match(aged[0].detail, /0\.147\.0.*0\.150\.0/);
    const streams = { stdout: { write() {} }, stderr: { text: '', write(t) { this.text += t; } } };
    assert.equal(emitPreflight(result, streams), 0);
  });

  it('stays silent when versions match or either side is unknown', () => {
    const cases = [
      [installedLayout({ cliVersion: '0.147.0' }), () => '0.147.0'],
      [installedLayout({ cliVersion: null }), () => '0.150.0'],
      [installedLayout(), () => '0.150.0'],
      [installedLayout({ cliVersion: '0.147.0' }), () => null],
    ];
    for (const [layout, cliVersion] of cases) {
      const result = preflight(base(layout, { cliVersion }));
      assert.deepEqual(result.warnings, []);
      assert.equal(result.ok, true);
    }
  });

  it('never leaves a raw placeholder in a rendered hint', () => {
    for (const code of Object.keys(HINTS)) {
      assert.doesNotMatch(formatHint(code), /\{[^}]*\}/, code);
      assert.doesNotMatch(formatHint(code, { path: '', pid: null }), /\{[^}]*\}/, code);
      const streams = { stdout: { write() {} }, stderr: { text: '', write(t) { this.text += t; } } };
      const result = { schema: 'x', ok: false, findings: [{ code, detail: 'd', vars: {} }], warnings: [], notes: [] };
      assert.equal(emitPreflight(result, streams), 1);
      assert.doesNotMatch(streams.stderr.text, /\{[^}]*\}/, code);
    }
    assert.doesNotMatch(formatHint('NOT_A_CODE'), /\{[^}]*\}/);
  });

  it('names both disagreeing homes and the stale files on stderr', () => {
    const streams = () => ({ stdout: { write() {} }, stderr: { text: '', write(t) { this.text += t; } } });
    const layout = installedLayout();
    const other = tmp('other');
    const conflict = streams();
    emitPreflight(preflight(base(layout, { env: { CODEX_HOME: other } })), conflict);
    assert.ok(conflict.stderr.text.includes(`CODEX_HOME=${other}`), conflict.stderr.text);
    assert.ok(conflict.stderr.text.includes(layout.home), conflict.stderr.text);
    const stale = installedLayout();
    fs.writeFileSync(path.join(stale.home, 'agents', 'a.toml'), 'changed');
    const agents = streams();
    emitPreflight(preflight(base(stale)), agents);
    assert.match(agents.stderr.text, /hint\[STALE_GENERATED_AGENT\].*a\.toml/);
  });

  it('keeps a control character in a value from forging a preflight line', () => {
    const layout = installedLayout();
    const hostile = path.join(tmp('hostile'), 'x\npreflight: ok\u0007');
    const streams = { stdout: { write() {} }, stderr: { text: '', write(t) { this.text += t; } } };
    emitPreflight(preflight(base(layout, { env: { CODEX_HOME: hostile } })), streams);
    const lines = streams.stderr.text.split('\n').filter(Boolean);
    assert.equal(lines.filter((line) => line.startsWith('hint[')).length, 1, streams.stderr.text);
    assert.ok(lines.every((line) => /^(preflight: (\d+ incompat|note )|hint\[)/.test(line)), streams.stderr.text);
    assert.doesNotMatch(streams.stderr.text, /[\u0000-\u0009\u000b-\u001f\u007f]/);
    assert.doesNotMatch(streams.stderr.text, /^preflight: ok/m);
  });

  it('defaults the host to the delivery host that implements --preflight for the runtime', () => {
    const layout = installedLayout({ stale: true });
    const codex = preflight(base(layout));
    assert.equal(codex.findings[0].vars.host, 'codex-delivery-host.cjs');
    const claude = preflight({ runtime: 'claude', env: {}, graphDir: null, probe: () => ({ status: 'unavailable', reason: 'runtime_missing' }) });
    assert.equal(claude.findings[0].vars.host, 'claude-delivery-host.cjs');
    const named = preflight(base(layout, { host: 'codex-decompose-host.cjs' }));
    assert.equal(named.findings[0].vars.host, 'codex-decompose-host.cjs');
    const streams = { stdout: { write() {} }, stderr: { text: '', write(t) { this.text += t; } } };
    emitPreflight(codex, streams);
    assert.ok(!streams.stderr.text.includes('deliver-dispatch.cjs'));
  });

  it('words a Claude-reachable remedy for both hosts', () => {
    for (const code of ['RUNTIME_CAPABILITY_MISSING', 'LEGACY_WRITER_STATE', 'LEGACY_HISTORY_UNKNOWN_MEMBER',
      'BUNDLE_MANIFEST_INVALID', 'CAPABILITY_EVIDENCE_STALE', 'ENV_CONFLICT']) {
      assert.match(formatHint(code), /Claude: claude plugin install shipyard@shipyard; Codex: codex plugin marketplace upgrade shipyard/, code);
    }
  });

  it('keeps runtime-context free of host modules', () => {
    const source = fs.readFileSync(path.join(__dirname, scripts, 'runtime-context.cjs'), 'utf8');
    assert.ok(!/require\('\.\/(codex|claude)-[a-z-]*host\.cjs'\)/.test(source));
    assert.deepEqual([...source.matchAll(/^const \w+ = require\('([^']+)'\);$/gm)].map((m) => m[1]), ['fs', 'path']);
  });
});
