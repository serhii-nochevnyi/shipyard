'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const lib = require('./lib.cjs');

const fixture = lib.createFixture();
try {
  const host = path.join(fixture.scriptsDir, 'codex-delivery-host.cjs');
  const request = path.join(fixture.workRoot, 'request.json');
  fs.writeFileSync(request, JSON.stringify({
    scope: {
      run_id: 'installed-launch-no-env', ticket: 'T-50-01', phase: 50,
      worktree: fixture.project, runtime: 'codex', provider: 'openai',
    },
    role: 'pr-sentinel',
    signals: {},
    context: { prompt: 'Guard the open pull request of ticket T-50-01 and report what you performed or refused.' },
  }));
  const launch = (extraEnv) => lib.runClassified(fixture, host, ['--args-file', request], extraEnv);

  const pristine = fs.readFileSync(fixture.bundleCapabilitiesFile);
  const tampered = Buffer.from(pristine);
  tampered[Math.floor(tampered.length / 2)] ^= 1;
  fs.writeFileSync(fixture.bundleCapabilitiesFile, tampered);
  const stale = launch();
  fs.writeFileSync(fixture.bundleCapabilitiesFile, pristine);
  assert.equal(stale.outcome.kind, 'refused', JSON.stringify(stale.outcome) + stale.run.stderr);
  assert.deepEqual(stale.outcome.labels, ['CAPABILITY_EVIDENCE_STALE'], stale.run.stderr);
  assert.deepEqual(stale.lines, [], 'tampered evidence must never reach the native CLI');
  lib.assertNothingCreated(fixture);

  const foreign = path.join(fixture.workRoot, 'foreign-home');
  fs.mkdirSync(foreign);
  const conflict = launch({ CODEX_HOME: foreign });
  assert.equal(conflict.outcome.kind, 'refused', JSON.stringify(conflict.outcome) + conflict.run.stderr);
  assert.deepEqual(conflict.outcome.labels, ['ENV_CONFLICT'], conflict.run.stderr);
  assert.ok(conflict.run.stderr.includes(foreign) && conflict.run.stderr.includes(fixture.codexHome),
    'the conflict must name both homes');
  assert.deepEqual(conflict.lines, [], 'a conflicting home must never reach the native CLI');
  lib.assertNothingCreated(fixture);

  const admitted = launch();
  assert.equal(admitted.outcome.kind, 'reached', JSON.stringify(admitted.outcome) + admitted.run.stderr);
  assert.equal(admitted.lines.length, 1);
  assert.equal(admitted.lines[0].codexHome, fixture.codexHome, 'the native child receives the bundle home');
  assert.notEqual(admitted.lines[0].codexHome, path.join(fixture.home, '.codex'));
  assert.ok(admitted.lines[0].argv.includes('exec'));

  const probeHost = path.join(fixture.scriptsDir, 'codex-runtime-host.cjs');
  const probe = lib.runHost(fixture, probeHost, ['--capability-only']);
  assert.equal(probe.status, 0, probe.stderr);
  const probed = JSON.parse(probe.stdout);
  assert.equal(probed.status, 'available', probe.stdout);
  assert.deepEqual(probed.capabilities.supportedModels, lib.codexCapabilities().supportedModels);
  fs.writeFileSync(fixture.bundleCapabilitiesFile, tampered);
  const refusedProbe = lib.runHost(fixture, probeHost, ['--capability-only']);
  fs.writeFileSync(fixture.bundleCapabilitiesFile, pristine);
  assert.equal(refusedProbe.status, 0, 'the capability probe reports, it does not fail');
  assert.equal(JSON.parse(refusedProbe.stdout).status, 'unavailable');
  assert.ok(JSON.parse(refusedProbe.stdout).detail.includes('digest'), refusedProbe.stdout);

  lib.assertHarnessIsolation(fixture, { admitted: true });
  const control = lib.runWriteGuardControl(fixture);
  assert.equal(control.length, 1, 'the write guard must record a write beside the work root');
  console.log('installed-launch codex-no-env: OK (child CODEX_HOME=' + admitted.lines[0].codexHome
    + ', terminal=' + admitted.outcome.terminal + ')');
} finally {
  fixture.cleanup();
}
