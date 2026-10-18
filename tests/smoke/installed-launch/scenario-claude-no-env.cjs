'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const lib = require('./lib.cjs');

const ENTRIES = ['claude-delivery-host.cjs', 'claude-investigation-host.cjs', 'claude-role-host.cjs', 'claude-decompose-host.cjs'];

const fixture = lib.createFixture();
try {
  const layout = lib.stageClaudeLayout(fixture);
  const claude = lib.installFakeClaude(fixture);
  const gh = lib.installFakeGh(fixture);
  const project = lib.stageClaudeProject(fixture, 'claude-no-env');
  const request = lib.writeClaudeRoleRequest(fixture, project);
  const host = path.join(layout.scriptsDir, 'claude-role-host.cjs');

  const before = claude.readLog().length;
  const run = lib.runHost(fixture, host, ['--args-file', request], layout.env);
  const lines = claude.readLog().slice(before);
  const outcome = lib.classifyLaunch(run, lines);
  const calls = gh.readCalls();
  const firstStderr = String(run.stderr).split('\n').find(Boolean) || '';
  assert.equal(outcome.kind, 'reached', `finding against T-50-28: ${JSON.stringify(outcome)}; first stderr line: ${firstStderr}; `
    + `last gh call: ${JSON.stringify(calls[calls.length - 1] || null)}`);
  assert.equal(lines.length, 1);
  assert.deepEqual(calls.filter((call) => call.status === 2), [], 'the fake gh logged an unmodelled call');
  assert.ok(fs.existsSync(path.join(project.root, '.planning/graph/provenance')), 'provenance sidecar sits in the project graph');

  for (const entry of ENTRIES) {
    const result = lib.runHost(fixture, path.join(layout.scriptsDir, entry), ['--preflight'], layout.env);
    assert.equal(result.status, 0, `${entry} --preflight: ${result.stdout}${result.stderr}`);
  }

  const provenance = path.join(project.root, '.planning/graph/provenance');
  const member = fs.readdirSync(provenance).sort()[0];
  const memberPath = path.join(provenance, member);
  const saved = fs.readFileSync(memberPath);
  const decoy = path.join(fixture.workRoot, 'provenance-decoy');
  fs.writeFileSync(decoy, saved);
  fs.rmSync(memberPath);
  fs.symlinkSync(decoy, memberPath);
  let incompatible;
  try {
    incompatible = lib.runHost(fixture, host, ['--preflight', '--args-file', request], layout.env);
  } finally {
    fs.rmSync(memberPath);
    fs.writeFileSync(memberPath, saved);
  }
  assert.equal(incompatible.status, 1, incompatible.stdout + incompatible.stderr);
  assert.match(incompatible.stdout + incompatible.stderr, /hint/i, 'an incompatible fixture must print hint lines');

  const homeProbe = lib.runHost(fixture, host, ['--preflight'], { ...layout.env, CLAUDE_HOME: path.join(fixture.workRoot, 'foreign-claude-home') });
  assert.equal(homeProbe.status, 0, 'CLAUDE_HOME must have no effect: ' + homeProbe.stdout + homeProbe.stderr);

  const homeReaders = fs.readdirSync(layout.scriptsDir).filter((name) => name.endsWith('.cjs')).filter((name) => fs.readFileSync(
    path.join(layout.scriptsDir, name), 'utf8').split('\n').some((line) => !/^\s*(\/\/|\*|\/\*)/.test(line)
    && line.includes('CLAUDE_HOME')));
  const names = lines[0].envNames;
  const measure = {
    claudeVariablesSeen: names.filter((name) => name.startsWith('CLAUDE_')),
    shipyardVariablesSeen: names.filter((name) => name.startsWith('SHIPYARD_')),
    configRoot: path.join(fixture.home, '.claude'),
    claudeHomeReaders: homeReaders,
    terminal: outcome.terminal,
  };
  assert.deepEqual(measure.shipyardVariablesSeen, []);
  assert.deepEqual(measure.claudeHomeReaders, [], 'no script may read CLAUDE_HOME');
  console.log('MEASURE: ' + JSON.stringify(measure));

  lib.assertHarnessIsolation(fixture, { admitted: true });
  console.log('installed-launch claude-no-env: OK (terminal=' + outcome.terminal + ')');
} finally {
  fixture.cleanup();
}
