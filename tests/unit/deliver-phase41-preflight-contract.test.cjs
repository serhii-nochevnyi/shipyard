'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { suite, test, done, assert } = require('./assert-harness.cjs');

const DELIVER = path.resolve(__dirname, '../../plugins/delivery-pipeline/commands/deliver.md');
const SCRIPT = path.resolve(__dirname, '../../plugins/delivery-pipeline/scripts/phase-integrator-preflight.cjs');
const text = fs.readFileSync(DELIVER, 'utf8');

const gateStart = text.indexOf('**Phase 41 prelaunch gate (both runtimes).**');
const dispatch = text.indexOf('boundary.dispatch(\n       { runtime, role: "integrator"');
const seal = text.indexOf('role-artifact.cjs seal --role integrator');
const gate = gateStart >= 0 && dispatch > gateStart ? text.slice(gateStart, dispatch) : '';

suite('deliver.md: phase-41 preflight ordering');

test('the gate exists and precedes the shared integrator dispatch and the sealer', () => {
  assert.ok(gateStart >= 0, 'phase-41 gate missing');
  assert.ok(dispatch > gateStart, 'integrator boundary.dispatch must follow the gate');
  assert.ok(seal > dispatch, 'sealer must follow dispatch');
  assert.strictEqual(text.split('role: "integrator"').length - 1, 1, 'no alternate integrator dispatch path');
});

test('the gate covers both runtime paths through the one dispatch', () => {
  assert.ok(/runtime: "claude"/.test(gate) && /runtime: "codex"/.test(gate));
  assert.ok(/phase-integrator-preflight\.cjs --phase 41/.test(gate));
  assert.ok(/phase-integrator-preflight\.cjs --verify/.test(gate));
});

suite('deliver.md: fail-closed binding');

test('refusal, moved head and digest mismatch never fall through to dispatch', () => {
  for (const phrase of ['does NOT fall through to `boundary.dispatch`', 'no model is launched', 'moved epic head',
    'ticket-set/digest mismatch', 'never reuse a stale proof', 'non-ancestor']) {
    assert.ok(gate.includes(phrase), `missing: ${phrase}`);
  }
});

test('proof, ticket-set file and integrator input share one digest and pinned commit/tree', () => {
  assert.ok(/--ticket-set-digest <ticket-set-digest>/.test(gate));
  assert.ok(gate.includes('IS the runtime\n     ticket-set file'));
  assert.ok(gate.includes('`epic.commit`/`epic.tree`'));
  assert.ok(/git merge-base --is-ancestor/.test(gate));
});

test('evidence names proof digest and per-ticket merge SHAs beside the receipt', () => {
  assert.ok(gate.includes('`proof_digest`') && gate.includes('per-ticket `merges`'));
  assert.ok(gate.includes('every per-ticket merge\n     SHA in the integration evidence beside the integrator receipt'));
});

test('the gate never authors INTEGRATION.md and keeps native Claude checks', () => {
  assert.ok(gate.includes('The preflight never writes'));
  assert.ok(gate.includes('remains its only author'));
  assert.ok(gate.includes('defense in depth'));
  const src = fs.readFileSync(SCRIPT, 'utf8');
  assert.ok(!/INTEGRATION\.md/.test(src), 'preflight source must not reference INTEGRATION.md');
  assert.ok(!/execSync\(|shell:\s*true/.test(src), 'argument-array process calls only');
});

test('the branch is narrow: other phases skip the gate', () => {
  assert.ok(gate.includes('Other phases skip this gate.'));
});

done();
