'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const lib = require('./lib.cjs');

const COMMANDS = ['gsd-ui-phase', 'gsd-ui-review'];
const STATUSES = ['found', 'absent', 'unreadable', 'not-installed'];
const REFUSAL_CODE = /\b(?:RUNTIME|ARCHIVE|ENV|LEGACY|CAPABILITY)_[A-Z_]+\b/;
const FORBIDDEN_FIELDS = ['content', 'contents', 'body', 'text', 'source', 'data'];

function candidateRoots(env, home) {
  const claude = env.CLAUDE_CONFIG_DIR || env.CLAUDE_HOME || path.join(home, '.claude');
  const codex = env.CODEX_HOME || path.join(home, '.codex');
  return [path.join(claude, 'gsd-core'), path.join(codex, 'gsd-core')];
}

function underRoot(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function markCandidates(roots, workRoot) {
  return roots.map((root) => ({ path: root, excluded: Boolean(workRoot) && underRoot(workRoot, root) }));
}

function blocked(error, target) {
  return error && (error.code === 'EACCES' || error.code === 'EPERM') ? { path: target, code: error.code } : null;
}

function classifyDriverCheck(candidates, probe) {
  const live = candidates.filter((candidate) => !candidate.excluded);
  if (!live.length) throw new Error('driver check needs at least one non-excluded candidate root');
  const listed = candidates.map((candidate) => ({
    path: candidate.path, excluded: Boolean(candidate.excluded), exists: false,
  }));
  const present = [];
  for (const entry of listed) {
    if (entry.excluded) continue;
    try { probe.exists(entry.path); entry.exists = true; present.push(entry); }
    catch (error) {
      if (error && error.code === 'ENOENT') continue;
      const refused = blocked(error, entry.path);
      if (refused) return { status: 'unreadable', candidate_roots: listed, blocked_read: refused };
      throw error;
    }
  }
  if (!present.length) return { status: 'not-installed', candidate_roots: listed };
  const examined = [];
  const verbs = [];
  for (const entry of present) {
    try {
      const result = probe.examine(entry.path);
      examined.push(...result.definitions);
      verbs.push(...result.verbs);
      if (result.invocation) {
        return { status: 'found', candidate_roots: listed, examined, verbs, invocation: result.invocation };
      }
    } catch (error) {
      const refused = blocked(error, error.path || entry.path);
      if (refused) return { status: 'unreadable', candidate_roots: listed, blocked_read: refused };
      throw error;
    }
  }
  return { status: 'absent', candidate_roots: listed, examined: [...new Set(examined)], verbs: [...new Set(verbs)] };
}

function nonEmptyArray(value) {
  return Array.isArray(value) && value.length > 0;
}

function validateDriverCheck(check, kind) {
  assert.ok(check && typeof check === 'object', 'driver_check is required');
  assert.ok(STATUSES.includes(check.status), `driver_check.status must be one of ${STATUSES.join(', ')}`);
  for (const field of FORBIDDEN_FIELDS) assert.ok(!(field in check), `driver_check must not carry ${field}`);
  if (kind === 'RAN') {
    assert.equal(check.status, 'found', 'a RAN record needs a found driver');
    assert.ok(typeof check.invocation === 'string' && check.invocation, 'a RAN record needs the recorded invocation');
    return;
  }
  if (check.status === 'found') assert.fail('a GAP record cannot carry status found');
  if (check.status === 'absent') {
    assert.ok(nonEmptyArray(check.examined), 'absent needs the examined definitions');
    assert.ok(Array.isArray(check.verbs), 'absent needs the verb names examined');
  } else if (check.status === 'unreadable') {
    const read = check.blocked_read;
    assert.ok(read && typeof read.path === 'string' && read.path && typeof read.code === 'string' && read.code,
      'unreadable needs the blocked path and error code');
  } else {
    assert.ok(nonEmptyArray(check.candidate_roots), 'not-installed needs candidate roots');
    const live = check.candidate_roots.filter((entry) => !entry.excluded);
    assert.ok(live.length > 0, 'not-installed needs at least one non-excluded candidate');
    for (const entry of live) assert.equal(entry.exists, false, 'a non-excluded candidate of not-installed must be absent');
  }
}

function validateUiSmokeRecord(lines) {
  const records = lines.filter((line) => /^(RAN|GAP):/.test(line));
  assert.equal(records.length, 1, 'exactly one RAN or GAP record is required');
  const kind = records[0].slice(0, 3);
  const record = JSON.parse(records[0].slice(4).trim());
  assert.equal(record.scenario, 'ui-smoke');
  validateDriverCheck(record.driver_check, kind);
  if (kind === 'RAN') {
    assert.equal(record.status, 'ran');
    assert.deepEqual(record.steps.map((step) => step.command), COMMANDS);
    for (const step of record.steps) assert.equal(step.exit, 0, `${step.command} must exit 0`);
  } else {
    assert.equal(record.status, 'declared-gap');
    assert.deepEqual(record.commands, COMMANDS);
    assert.ok(typeof record.reason === 'string' && record.reason, 'a GAP needs a reason');
  }
  return { kind, record };
}

const PLUMBING_ONLY = 'this scenario checks only the driver-lookup plumbing against a fixture, and A7 on a real install is established by the release live receipt, not by this scenario';

function gapReason(check) {
  if (check.status === 'absent') {
    return `the fixture GSD core carries no non-interactive driver for either command; ${PLUMBING_ONLY}`;
  }
  if (check.status === 'unreadable') {
    return `the fixture install could not be read (${check.blocked_read.code} at ${check.blocked_read.path}); ${PLUMBING_ONLY}`;
  }
  return `the fixture holds no GSD core install; ${PLUMBING_ONLY}`;
}

function realProbe() {
  return {
    exists: (target) => fs.lstatSync(target),
    examine: (root) => {
      const definitions = [];
      const verbs = [];
      const tools = path.join(root, 'bin/gsd-tools.cjs');
      for (const command of COMMANDS) {
        for (const candidate of [path.join(root, 'commands', command + '.md'), path.join(root, 'commands/gsd', command.replace(/^gsd-/, '') + '.md')]) {
          try { fs.lstatSync(candidate); definitions.push(candidate); } catch (error) { if (error.code !== 'ENOENT') throw error; }
        }
      }
      let source = '';
      try { source = fs.readFileSync(tools, 'utf8'); definitions.push(tools); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      for (const match of source.matchAll(/['"](ui-(?:phase|review)(?:-[a-z]+)?)['"]/g)) verbs.push(match[1]);
      const unique = [...new Set(verbs)];
      const driven = COMMANDS.every((command) => unique.includes(command.replace(/^gsd-/, '')));
      return { definitions, verbs: unique, invocation: driven ? `node ${tools} {ui-phase|ui-review} --non-interactive` : null };
    },
  };
}

function resolveFixtureRoots(fixture) {
  // @security: GSD roots come only from the fixture HOME and fixture Codex home, never the process environment.
  return candidateRoots({ CODEX_HOME: fixture.codexHome }, fixture.home);
}

function toolInsideFixture(fixture, invocation) {
  const tools = String(invocation).split(' ')[1];
  const real = fs.realpathSync(tools);
  const root = fs.realpathSync(fixture.workRoot);
  const relative = path.relative(root, real);
  assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative), 'a driver outside the fixture is never executed');
  return real;
}

function runDriverSteps(fixture, check) {
  const tools = toolInsideFixture(fixture, check.invocation);
  return COMMANDS.map((command) => {
    const run = lib.runHost(fixture, tools, [command.replace(/^gsd-/, ''), '--non-interactive']);
    assert.equal(run.status, 0, `${command} failed: ${run.stderr}`);
    assert.ok(!REFUSAL_CODE.test(run.stdout + run.stderr), `${command} printed a refusal code`);
    return { command, exit: run.status };
  });
}

function writeDriverStub(fixture) {
  const root = path.join(fixture.workRoot, 'driver-stub/gsd-core');
  fs.mkdirSync(path.join(root, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(root, 'bin/gsd-tools.cjs'), [
    "const verbs = ['ui-phase', 'ui-review'];",
    'if (!verbs.includes(process.argv[2]) || process.argv[3] !== "--non-interactive") process.exit(64);',
    '',
  ].join('\n'));
  return root;
}

function exerciseStubDriver(fixture) {
  const check = classifyDriverCheck(markCandidates([writeDriverStub(fixture)]), realProbe());
  assert.equal(check.status, 'found', 'the stub driver written by the scenario must be found');
  const steps = runDriverSteps(fixture, check);
  validateUiSmokeRecord(['RAN: ' + JSON.stringify({ scenario: 'ui-smoke', steps, status: 'ran', driver_check: check })]);
  return steps.length;
}

function runScenario() {
  const lib = require('./lib.cjs');
  const fixture = lib.createFixture();
  try {
    const check = classifyDriverCheck(markCandidates(resolveFixtureRoots(fixture)), realProbe());
    let line;
    if (check.status === 'found') {
      const steps = runDriverSteps(fixture, check);
      line = 'RAN: ' + JSON.stringify({ scenario: 'ui-smoke', steps, status: 'ran', driver_check: check });
    } else {
      line = 'GAP: ' + JSON.stringify({
        scenario: 'ui-smoke', commands: COMMANDS, status: 'declared-gap', reason: gapReason(check), driver_check: check,
      });
    }
    validateUiSmokeRecord([line]);
    const stubbed = exerciseStubDriver(fixture);
    lib.assertHarnessIsolation(fixture);
    console.log(line);
    console.log(`ui-smoke control: fixture stub driver ran ${stubbed} commands`);
  } finally {
    fixture.cleanup();
  }
}

module.exports = { candidateRoots, classifyDriverCheck, gapReason, validateUiSmokeRecord, markCandidates, resolveFixtureRoots, toolInsideFixture };

if (require.main === module) runScenario();
