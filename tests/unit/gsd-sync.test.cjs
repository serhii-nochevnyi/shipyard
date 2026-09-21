'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { suite, test, done, assert } = require('./assert-harness.cjs');

const ROOT = path.join(__dirname, '..', '..');
const SCRIPT = path.join(ROOT, 'plugins', 'delivery-pipeline', 'scripts', 'gsd-sync.cjs');
const sync = require(SCRIPT);

function write(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function testEnv(root) {
  const env = { ...process.env, HOME: path.join(root, 'home') };
  for (const key of Object.keys(env)) {
    if (/^(?:SHIPYARD_|GSD_|CLAUDE_|CODEX_)/.test(key)
        || key === 'NODE_OPTIONS' || key === 'NODE_PATH') delete env[key];
  }
  fs.mkdirSync(env.HOME, { recursive: true });
  return env;
}

function project({ integration = 'Verdict: passed\n\n## Verification evidence\n- node --test tests/unit/gsd-sync.test.cjs: exit 0', merged = true, conflict = false, plan = 1, coreValue = 'One truthful workflow' } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-gsd-sync-'));
  const graph = path.join(root, '.planning', 'graph');
  const phase = path.join(root, '.planning', 'phases', '01-foundation');
  write(path.join(root, '.planning', 'PROJECT.md'), `# shipyard\n\n## Core Value\n${coreValue}\n`);
  write(path.join(root, '.planning', 'ROADMAP.md'), [
    '# Roadmap: shipyard', '', '## Requirements', '',
    '- **SYNC-01** — Native GSD state matches the delivery graph.', '',
    '## Phases', '', '### Phase 1: Foundation',
    '**Requirements**: SYNC-01', '',
  ].join('\n'));
  write(path.join(phase, '01-01-PLAN.md'), [
    '---', 'phase: 1', `plan: ${plan}`, 'title: "Projection"',
    'files_modified: [src/example.js]', 'requirements: [SYNC-01]',
    'delivery:', '  ticket: T-01-01', '  risk: low', '---', '',
    '## Goal', '', 'Create the projection.',
  ].join('\n'));
  write(path.join(phase, 'INTEGRATION.md'), `# Integration\n\n${integration}\n`);
  write(path.join(graph, 'tickets.json'), JSON.stringify({ tickets: {
    'T-01-01': { phase: '1', title: 'Projection', files: ['src/example.js'] },
  } }));
  write(path.join(graph, 'delivery-state.json'), JSON.stringify({
    'T-01-01': merged ? { status: 'merged', pr: 7, since: '2026-09-10T10:00:00Z' } : { status: 'pr-open', pr: 7 },
  }));
  if (conflict) write(path.join(root, '.planning', 'STATE.md'), '# human-owned state\n');
  return root;
}

function run(root, args = []) {
  return spawnSync(process.execPath, [SCRIPT, '--json', ...args], {
    cwd: root,
    encoding: 'utf8',
    env: testEnv(root),
  });
}

suite('gsd-sync — evidence projection');

test('canonicalizes ticket identities and rejects malformed CLI flags', () => {
  assert.equal(sync.canonicalTicket('t-1-2'), 'T-01-02');
  assert.equal(sync.canonicalTicket('2', 1), 'T-01-02');
  assert.equal(sync.integrationStatus('Round 1 was needs-fix\n## Verdict — `passed`').status, 'passed');
  assert.equal(sync.integrationStatus('## Verdict — failed (previously passed)').status, 'needs-fix');
  assert.equal(sync.verificationEvidence('## Verdict — `passed`').status, 'pending');
  const r = spawnSync(process.execPath, [SCRIPT, '--phase'], {
    cwd: ROOT,
    encoding: 'utf8',
    env: testEnv(ROOT),
  });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--phase requires/);
});

test('keeps non-numeric plan ids, full core value, and incomplete summaries deterministic', () => {
  const root = project({
    merged: false,
    plan: 'alpha',
    coreValue: 'Keep delivery decisions truthful\nacross every generated artifact.',
  });
  const first = run(root);
  assert.equal(first.status, 0, first.stderr);
  const summaryPath = path.join(root, '.planning', 'phases', '01-foundation', '01-01-SUMMARY.md');
  const summary = fs.readFileSync(summaryPath, 'utf8');
  assert.match(summary, /^plan: alpha$/m);
  assert.doesNotMatch(summary, /NaN/);
  assert.doesNotMatch(summary, /^completed:/m);
  assert.match(fs.readFileSync(path.join(root, '.planning', 'STATE.md'), 'utf8'), /Keep delivery decisions truthful across every generated artifact\./);
  assert.match(fs.readFileSync(path.join(root, '.planning', 'REQUIREMENTS.md'), 'utf8'), /Keep delivery decisions truthful across every generated artifact\./);
  const before = fs.readFileSync(summaryPath, 'utf8');
  assert.equal(run(root).status, 0);
  assert.equal(fs.readFileSync(summaryPath, 'utf8'), before);
});

test('is not applicable when a project has no delivery plans', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-gsd-no-delivery-'));
  write(path.join(root, '.planning', 'PROJECT.md'), '# shipyard\n');
  write(path.join(root, '.planning', 'ROADMAP.md'), '# Roadmap\n');
  const result = run(root);
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ok, true);
  assert.equal(payload.applicable, false);
});

test('does not treat a body delivery marker as conveyor applicability', () => {
  const root = project();
  const plan = path.join(root, '.planning', 'phases', '01-foundation', '01-01-PLAN.md');
  write(plan, [
    '---', 'phase: 1', 'plan: 1', 'title: Foundation',
    'files_modified: [src/example.js]', 'requirements: [SYNC-01]', '---', '',
    '## Notes', '', 'The prose mentions delivery: but is not a delivery plan.',
  ].join('\n'));
  const result = run(root);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).applicable, false);
});

test('fails closed when delivery state is missing or has no plan observation', () => {
  const root = project();
  const state = path.join(root, '.planning', 'graph', 'delivery-state.json');
  fs.unlinkSync(state);
  const missing = run(root);
  assert.equal(missing.status, 1);
  assert.match(missing.stdout, /delivery-state\.json must be an object/);

  write(state, JSON.stringify({}));
  const absent = run(root);
  assert.equal(absent.status, 1);
  assert.match(absent.stdout, /T-01-01: delivery-state\.json has no observation/);
});

test('requires positive verification evidence before a passed phase', () => {
  const root = project({ integration: 'Verdict: passed' });
  assert.equal(run(root).status, 0);
  const dir = path.join(root, '.planning', 'phases', '01-foundation');
  const uat = fs.readFileSync(path.join(dir, '01-foundation-UAT.md'), 'utf8');
  const verification = fs.readFileSync(path.join(dir, '01-foundation-VERIFICATION.md'), 'utf8');
  assert.match(uat, /status: pending/);
  assert.match(verification, /status: human_needed/);
  assert.match(verification, /no verification evidence/i);
});

test('does not treat the uat-passed command name as a verification result', () => {
  const root = project({
    integration: 'Verdict: passed\n\n## Verification evidence\n- `gsd-tools phase uat-passed 1 --raw`',
  });
  assert.equal(run(root).status, 0);
  const verification = fs.readFileSync(
    path.join(root, '.planning', 'phases', '01-foundation', '01-foundation-VERIFICATION.md'),
    'utf8',
  );
  assert.match(verification, /status: human_needed/);
  assert.match(verification, /no positive repository-local verification result/i);
});

test('surfaces failed verification evidence as a phase gap', () => {
  const root = project({
    integration: 'Verdict: passed\n\n## Verification evidence\n- test-fast: failed',
  });
  assert.equal(run(root).status, 0);
  const dir = path.join(root, '.planning', 'phases', '01-foundation');
  const uat = fs.readFileSync(path.join(dir, '01-foundation-UAT.md'), 'utf8');
  const verification = fs.readFileSync(path.join(dir, '01-foundation-VERIFICATION.md'), 'utf8');
  assert.match(uat, /^status: failed$/m);
  assert.match(verification, /^status: gaps_found$/m);
  assert.match(verification, /verification evidence records a failed check/i);
});

test('keeps integration and verification UAT results independent', () => {
  const root = project({ integration: 'Verdict: passed\n\n## Verification\n- no repository-local result yet' });
  assert.equal(run(root).status, 0);
  const uat = fs.readFileSync(
    path.join(root, '.planning', 'phases', '01-foundation', '01-foundation-UAT.md'),
    'utf8',
  );
  assert.match(uat, /### 2\. Integration evidence is explicit[\s\S]*result: passed/);
  assert.match(uat, /### 3\. Phase verification is evidence-backed[\s\S]*result: pending/);
  assert.match(uat, /actual: pending — integration evidence has no positive repository-local verification result/);
});

test('preserves wrapped roadmap requirement descriptions', () => {
  const root = project();
  write(path.join(root, '.planning', 'ROADMAP.md'), [
    '# Roadmap: shipyard', '', '## Requirements', '',
    '- **SYNC-01** — Native GSD state matches',
    '  the delivery graph across every runtime.', '',
    '## Phases', '', '### Phase 1: Foundation',
    '**Requirements**: SYNC-01', '',
  ].join('\n'));
  assert.equal(run(root).status, 0);
  const requirements = fs.readFileSync(path.join(root, '.planning', 'REQUIREMENTS.md'), 'utf8');
  assert.match(requirements, /Native GSD state matches the delivery graph across every runtime\./);
});

test('writes a complete native projection and is idempotent', () => {
  const root = project();
  const first = run(root);
  assert.equal(first.status, 0, first.stderr);
  const result = JSON.parse(first.stdout);
  assert.equal(result.ok, true);
  assert.equal(result.counts.plans, 1);
  assert.ok(fs.existsSync(path.join(root, '.planning', 'STATE.md')));
  assert.ok(fs.existsSync(path.join(root, '.planning', 'REQUIREMENTS.md')));
  assert.ok(fs.existsSync(path.join(root, '.planning', 'phases', '01-foundation', '01-01-SUMMARY.md')));
  const state = fs.readFileSync(path.join(root, '.planning', 'STATE.md'), 'utf8');
  assert.match(state, /completed_plans: 1/);
  const before = fs.readFileSync(path.join(root, '.planning', 'ROADMAP.md'), 'utf8');
  const second = run(root);
  assert.equal(second.status, 0, second.stderr);
  assert.equal(fs.readFileSync(path.join(root, '.planning', 'ROADMAP.md'), 'utf8'), before);
  const check = run(root, ['--check', '--phase', '1']);
  assert.equal(check.status, 0, check.stderr);
});

test('check mode detects source drift without rewriting the projection', () => {
  const root = project();
  assert.equal(run(root).status, 0);
  const requirements = path.join(root, '.planning', 'REQUIREMENTS.md');
  const before = fs.readFileSync(requirements, 'utf8');
  const plan = path.join(root, '.planning', 'phases', '01-foundation', '01-01-PLAN.md');
  fs.appendFileSync(plan, '\nchanged source\n');
  const check = run(root, ['--check']);
  assert.equal(check.status, 1);
  assert.match(check.stdout, /stale|missing/);
  assert.equal(fs.readFileSync(requirements, 'utf8'), before);
});

test('ignores volatile delivery-front metadata in the source fingerprint', () => {
  const root = project();
  assert.equal(run(root).status, 0);
  write(path.join(root, '.planning', 'graph', 'delivery-front.json'), JSON.stringify({
    generated_at: '2026-09-11T07:00:00.000Z',
    observed_at: '2026-09-11T07:00:00.000Z',
    generation: 1,
    dispatches_applied_at: '2026-09-11T07:00:00.000Z',
    actionable: { execute: [], publish: [], fix: [], finalize: [], merge: [] },
  }));
  const before = fs.readFileSync(path.join(root, '.planning', 'ROADMAP.md'), 'utf8');
  write(path.join(root, '.planning', 'graph', 'delivery-front.json'), JSON.stringify({
    generated_at: '2026-09-11T08:00:00.000Z',
    observed_at: '2026-09-11T08:00:00.000Z',
    generation: 2,
    dispatches_applied_at: '2026-09-11T08:00:00.000Z',
    actionable: { execute: [], publish: [], fix: [], finalize: [], merge: [] },
  }));
  const check = run(root, ['--check']);
  assert.equal(check.status, 0, check.stderr || check.stdout);
  assert.equal(fs.readFileSync(path.join(root, '.planning', 'ROADMAP.md'), 'utf8'), before);
});

test('ignores heartbeat fields in delivery-state while tracking rendered facts', () => {
  const root = project();
  const first = run(root);
  assert.equal(first.status, 0, first.stderr);
  const initial = JSON.parse(first.stdout);
  const stateFile = path.join(root, '.planning', 'graph', 'delivery-state.json');
  const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  state['T-01-01'].merge_state = 'CLEAN';
  state['T-01-01'].review_decision = 'APPROVED';
  state['T-01-01'].checks = { state: 'green', checked_at: '2026-09-11T08:00:00Z' };
  state['T-01-01'].head_sha = '1111111111111111111111111111111111111111';
  fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));

  const check = run(root, ['--check']);
  assert.equal(check.status, 0, check.stderr || check.stdout);
  const current = JSON.parse(check.stdout);
  assert.equal(current.source_fingerprint, initial.source_fingerprint);
});

test('delivery facts invalidate the projection fingerprint', () => {
  const root = project();
  const first = run(root);
  assert.equal(first.status, 0, first.stderr);
  const initial = JSON.parse(first.stdout);
  const stateFile = path.join(root, '.planning', 'graph', 'delivery-state.json');
  const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  state['T-01-01'].status = 'pr-open';
  fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));

  const check = run(root, ['--check']);
  assert.equal(check.status, 1);
  const current = JSON.parse(check.stdout);
  assert.notEqual(current.source_fingerprint, initial.source_fingerprint);
  assert.ok(current.blockers.some((item) => /stale|missing/.test(item)), current.blockers.join('; '));
});

test('does not convert needs-fix integration into a green phase', () => {
  const root = project({ integration: 'Verdict: needs-fix' });
  assert.equal(run(root).status, 0);
  const dir = path.join(root, '.planning', 'phases', '01-foundation');
  const uat = fs.readFileSync(path.join(dir, '01-foundation-UAT.md'), 'utf8');
  const verification = fs.readFileSync(path.join(dir, '01-foundation-VERIFICATION.md'), 'utf8');
  assert.match(uat, /status: failed/);
  assert.match(uat, /result: failed/);
  assert.match(verification, /status: gaps_found/);
  assert.match(verification, /needs-fix|finding/i);
});

test('refuses to overwrite an unowned generated artifact', () => {
  const root = project({ conflict: true });
  const r = run(root);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /not owned/);
  assert.equal(fs.readFileSync(path.join(root, '.planning', 'STATE.md'), 'utf8'), '# human-owned state\n');
});

test('requires the ownership marker at the generated header', () => {
  const root = project();
  write(path.join(root, '.planning', 'STATE.md'), '# human-authored note\n\nThe shipyard:gsd-sync generated phrase is only documentation.\n');
  const r = run(root);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /not owned/);
});

test('malformed delivery plans remain applicable and block publication', () => {
  const root = project();
  const plan = path.join(root, '.planning', 'phases', '01-foundation', '01-01-PLAN.md');
  const raw = fs.readFileSync(plan, 'utf8').replace(/\n---\n\n## Goal/, '\n\n## Goal');
  write(plan, raw);
  const r = run(root);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /malformed frontmatter/);
});

test('rejects plans whose phase is absent from the roadmap', () => {
  const root = project();
  const plan = path.join(root, '.planning', 'phases', '01-foundation', '01-01-PLAN.md');
  const raw = fs.readFileSync(plan, 'utf8').replace('phase: 1', 'phase: 2');
  write(plan, raw);
  const r = run(root);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /phase 2 is not declared/);
});

test('renders open delivery records as uncertain rather than failed', () => {
  const root = project({ merged: false });
  assert.equal(run(root).status, 0);
  const verification = fs.readFileSync(path.join(root, '.planning', 'phases', '01-foundation', '01-foundation-VERIFICATION.md'), 'utf8');
  assert.match(verification, /\? UNCERTAIN/);
  assert.doesNotMatch(verification, /T-01-01 \| pr-open \| ✗ FAILED/);
  assert.match(fs.readFileSync(path.join(root, '.planning', 'STATE.md'), 'utf8'), /T-01-01: delivery status is pr-open/);
});

test('does not stamp a global activity date as phase verification', () => {
  const root = project();
  assert.equal(run(root).status, 0);
  const verification = fs.readFileSync(path.join(root, '.planning', 'phases', '01-foundation', '01-foundation-VERIFICATION.md'), 'utf8');
  assert.doesNotMatch(verification, /^verified:/m);
});

test('adopts existing native artifacts only when explicitly requested', () => {
  const humanRoot = project({ conflict: true });
  const human = spawnSync(process.execPath, [SCRIPT, '--adopt-native'], {
    cwd: humanRoot,
    encoding: 'utf8',
    env: testEnv(humanRoot),
  });
  assert.equal(human.status, 0, human.stderr);
  assert.match(human.stdout, /native adoption — \.planning\/STATE\.md/);

  const root = project({ conflict: true });
  const r = run(root, ['--adopt-native']);
  assert.equal(r.status, 0, r.stderr);
  const payload = JSON.parse(r.stdout);
  assert.deepStrictEqual(payload.adopted_files, ['.planning/STATE.md']);
  assert.match(fs.readFileSync(path.join(root, '.planning', 'STATE.md'), 'utf8'), /shipyard:gsd-sync generated/);
});

test('publishes under the shared state lock', () => {
  assert.match(sync.run.toString(), /withLock\(lockDirFor\(ROOT\), 'state'/);
});

done();
