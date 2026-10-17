'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const {
  candidateRoots, classifyDriverCheck, validateUiSmokeRecord, resolveFixtureRoots, toolInsideFixture,
} = require('../smoke/installed-launch/scenario-ui-smoke.cjs');

const COMMANDS = ['gsd-ui-phase', 'gsd-ui-review'];
const enoent = () => Object.assign(new Error('missing'), { code: 'ENOENT' });
const live = (p) => ({ path: p, excluded: false });
const gap = (check, extra = {}) => 'GAP: ' + JSON.stringify({
  scenario: 'ui-smoke', commands: COMMANDS, status: 'declared-gap', reason: 'why', driver_check: check, ...extra,
});
const ran = (check, steps) => 'RAN: ' + JSON.stringify({
  scenario: 'ui-smoke', status: 'ran', driver_check: check,
  steps: steps || COMMANDS.map((command) => ({ command, exit: 0 })),
});
const notInstalled = { status: 'not-installed', candidate_roots: [{ path: '/a/gsd-core', excluded: false, exists: false }] };
const absent = { status: 'absent', examined: ['/a/bin/gsd-tools.cjs'], verbs: [] };
const unreadable = { status: 'unreadable', blocked_read: { path: '/a/gsd-core', code: 'EACCES' } };
const found = { status: 'found', invocation: 'node /a/bin/gsd-tools.cjs ui-phase' };

test('candidateRoots honours the documented precedence', () => {
  assert.deepEqual(candidateRoots({}, '/h'), ['/h/.claude/gsd-core', '/h/.codex/gsd-core']);
  assert.deepEqual(candidateRoots({ CLAUDE_HOME: '/ch' }, '/h')[0], '/ch/gsd-core');
  assert.deepEqual(candidateRoots({ CLAUDE_HOME: '/ch', CLAUDE_CONFIG_DIR: '/cc' }, '/h')[0], '/cc/gsd-core');
  assert.deepEqual(candidateRoots({ CODEX_HOME: '/x' }, '/h')[1], '/x/gsd-core');
});

test('classifyDriverCheck yields not-installed when every candidate is absent', () => {
  const probe = { exists: () => { throw enoent(); }, examine: () => assert.fail('must not examine') };
  const check = classifyDriverCheck([live('/a'), live('/b')], probe);
  assert.equal(check.status, 'not-installed');
  assert.ok(check.candidate_roots.every((entry) => entry.exists === false));
});

test('an excluded candidate is never read as evidence', () => {
  const probe = { exists: (p) => { if (p === '/fixture') return {}; throw enoent(); }, examine: () => assert.fail('no') };
  const check = classifyDriverCheck([{ path: '/fixture', excluded: true }, live('/a')], probe);
  assert.equal(check.status, 'not-installed');
  assert.equal(check.candidate_roots[0].exists, false);
});

test('classifyDriverCheck reports unreadable with the blocked path and code', () => {
  for (const code of ['EACCES', 'EPERM']) {
    const probe = { exists: () => { throw Object.assign(new Error('no'), { code }); }, examine: () => ({}) };
    const check = classifyDriverCheck([live('/a')], probe);
    assert.deepEqual(check.blocked_read, { path: '/a', code });
    assert.equal(check.status, 'unreadable');
  }
  const probe = { exists: () => ({}), examine: () => { throw Object.assign(new Error('no'), { code: 'EACCES', path: '/a/x' }); } };
  assert.deepEqual(classifyDriverCheck([live('/a')], probe).blocked_read, { path: '/a/x', code: 'EACCES' });
});

test('classifyDriverCheck yields absent or found from a readable install', () => {
  const base = { exists: () => ({}) };
  const none = classifyDriverCheck([live('/a')], { ...base, examine: () => ({ definitions: ['/a/d.md'], verbs: [], invocation: null }) });
  assert.equal(none.status, 'absent');
  assert.deepEqual(none.examined, ['/a/d.md']);
  const hit = classifyDriverCheck([live('/a')], { ...base, examine: () => ({ definitions: [], verbs: ['ui-phase'], invocation: 'node x ui-phase' }) });
  assert.equal(hit.status, 'found');
  assert.equal(hit.invocation, 'node x ui-phase');
});

test('classifyDriverCheck throws when nothing non-excluded was given', () => {
  assert.throws(() => classifyDriverCheck([], {}));
  assert.throws(() => classifyDriverCheck([{ path: '/f', excluded: true }], {}));
});

test('validateUiSmokeRecord accepts one valid record per status', () => {
  assert.equal(validateUiSmokeRecord([gap(notInstalled)]).kind, 'GAP');
  assert.equal(validateUiSmokeRecord([gap(absent)]).kind, 'GAP');
  assert.equal(validateUiSmokeRecord([gap(unreadable)]).kind, 'GAP');
  assert.equal(validateUiSmokeRecord([ran(found)]).kind, 'RAN');
});

test('validateUiSmokeRecord rejects weakened or malformed records', () => {
  const rejects = (lines) => assert.throws(() => validateUiSmokeRecord(lines));
  rejects([gap(found)]);
  rejects([gap({ ...absent, examined: [] })]);
  rejects([gap({ status: 'unreadable' })]);
  rejects([gap({ ...notInstalled, candidate_roots: [] })]);
  rejects([gap({ status: 'not-installed', candidate_roots: [{ path: '/a', excluded: false, exists: true }] })]);
  rejects([gap({ status: 'not-installed', candidate_roots: [{ path: '/a', excluded: true, exists: false }] })]);
  rejects([ran(absent)]);
  rejects([ran({ status: 'found' })]);
  rejects([ran(found, [{ command: 'gsd-ui-phase', exit: 0 }, { command: 'gsd-ui-review', exit: 1 }])]);
  rejects([gap(notInstalled), ran(found)]);
  rejects([]);
  rejects([gap({ ...absent, contents: 'secret' })]);
  rejects([gap({ ...absent, content: 'secret' })]);
});

test('fixture roots ignore the process environment', () => {
  const saved = { CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR, CODEX_HOME: process.env.CODEX_HOME };
  process.env.CLAUDE_CONFIG_DIR = '/real/claude';
  process.env.CODEX_HOME = '/real/codex';
  try {
    assert.deepEqual(resolveFixtureRoots({ home: '/f/home', codexHome: '/f/codex' }),
      ['/f/home/.claude/gsd-core', '/f/codex/gsd-core']);
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});

test('a driver outside the fixture is refused before it can run', () => {
  const work = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ui-smoke-unit-')));
  const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ui-smoke-outside-')));
  try {
    const inner = path.join(work, 'tools.cjs');
    const stray = path.join(outside, 'tools.cjs');
    fs.writeFileSync(inner, '');
    fs.writeFileSync(stray, '');
    assert.equal(toolInsideFixture({ workRoot: work }, `node ${inner} {ui-phase}`), inner);
    assert.throws(() => toolInsideFixture({ workRoot: work }, `node ${stray} {ui-phase}`), /outside the fixture/);
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('the scenario never reads or runs a driver installed under the real home', () => {
  const decoy = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ui-smoke-decoy-')));
  try {
    const marker = path.join(decoy, 'executed');
    for (const base of [path.join(decoy, '.claude/gsd-core'), path.join(decoy, '.codex/gsd-core')]) {
      fs.mkdirSync(path.join(base, 'bin'), { recursive: true });
      fs.writeFileSync(path.join(base, 'bin/gsd-tools.cjs'),
        `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'x');\n// 'ui-phase' 'ui-review'\n`);
    }
    const result = spawnSync(process.execPath, [path.join(__dirname, '../smoke/installed-launch/scenario-ui-smoke.cjs')], {
      encoding: 'utf8', timeout: 120000,
      env: { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR || os.tmpdir(), HOME: decoy,
        CLAUDE_CONFIG_DIR: path.join(decoy, '.claude'), CLAUDE_HOME: path.join(decoy, '.claude'), CODEX_HOME: path.join(decoy, '.codex') },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.existsSync(marker), false, 'a decoy driver outside the fixture was executed');
    assert.ok(!result.stdout.includes(decoy), 'the record named a path outside the fixture');
    assert.match(result.stdout, /^GAP: /m);
  } finally {
    fs.rmSync(decoy, { recursive: true, force: true });
  }
});
