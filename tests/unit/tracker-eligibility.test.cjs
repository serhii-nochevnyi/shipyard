'use strict';

// This suite is intentionally pure: tracker-eligibility must decide from the
// two fields in one default issue response, never from a second request or a
// history-shaped guess.

const path = require('path');
const { suite, test, done, assert } = require('./assert-harness.cjs');
const {
  VERDICTS,
  normalizeStatusName,
  normalizeAssignee,
  normalizeObservation,
  evaluateEligibility,
} = require(path.join(
  __dirname, '..', '..', 'plugins', 'delivery-pipeline', 'scripts', 'tracker-eligibility.cjs'
));

const allowed = ['To Do', 'Backlog'];

suite('tracker eligibility — exact status NAME plus unassigned');

test('a configured status with an explicitly unassigned ticket is eligible', () => {
  const result = evaluateEligibility({ name: ' To Do ' }, null, allowed);
  assert.strictEqual(result.verdict, VERDICTS.ELIGIBLE);
  assert.strictEqual(result.eligible, true);
  assert.strictEqual(result.status, 'To Do');
  assert.strictEqual(result.assignee, null);
  assert.match(result.reason, /To Do/);
  assert.match(result.reason, /unassigned/);
});

test('an assigned ticket is ineligible and names the observed assignee', () => {
  const result = evaluateEligibility('To Do', { accountId: 'user-17', displayName: 'Ada' }, allowed);
  assert.strictEqual(result.verdict, VERDICTS.INELIGIBLE);
  assert.strictEqual(result.eligible, false);
  assert.strictEqual(result.assignee, 'user-17');
  assert.match(result.reason, /user-17/);
});

test('a complete status mismatch is ineligible and names the observed status', () => {
  const result = evaluateEligibility({ name: 'In Progress' }, null, allowed);
  assert.strictEqual(result.verdict, VERDICTS.INELIGIBLE);
  assert.strictEqual(result.eligible, false);
  assert.strictEqual(result.status, 'In Progress');
  assert.match(result.reason, /In Progress/);
});

test('when both complete conditions fail, the reason names both facts', () => {
  const result = evaluateEligibility('In Progress', { name: 'Ada' }, allowed);
  assert.strictEqual(result.verdict, VERDICTS.INELIGIBLE);
  assert.match(result.reason, /In Progress/);
  assert.match(result.reason, /Ada/);
});

test('an empty policy is explicitly disabled and never authorizes work', () => {
  const result = evaluateEligibility('To Do', null, []);
  assert.strictEqual(result.verdict, VERDICTS.INELIGIBLE);
  assert.strictEqual(result.eligible, false);
  assert.match(result.reason, /disabled/);
});

test('missing status is unknown rather than eligible', () => {
  const result = evaluateEligibility(undefined, null, allowed);
  assert.strictEqual(result.verdict, VERDICTS.UNKNOWN);
  assert.strictEqual(result.eligible, null);
  assert.match(result.reason, /status NAME.*unknown/i);
});

test('missing or malformed assignee is unknown rather than unassigned', () => {
  for (const value of [undefined, '', {}, [], false]) {
    const result = evaluateEligibility('To Do', value, allowed);
    assert.strictEqual(result.verdict, VERDICTS.UNKNOWN, JSON.stringify(value));
    assert.strictEqual(result.eligible, null, JSON.stringify(value));
    assert.match(result.reason, /assignee.*unknown/i, JSON.stringify(value));
  }
});

test('a ticket returned to a configured status with assignee cleared is eligible again', () => {
  const assigned = evaluateEligibility('To Do', { accountId: 'user-17' }, allowed);
  const cleared = evaluateEligibility('To Do', null, allowed);
  assert.strictEqual(assigned.verdict, VERDICTS.INELIGIBLE);
  assert.strictEqual(cleared.verdict, VERDICTS.ELIGIBLE);
});

suite('tracker eligibility — shape normalization without history fallbacks');

test('direct issue and fields-wrapped issue shapes yield the same observation', () => {
  const direct = normalizeObservation({ status: { name: 'To Do' }, assignee: null });
  const fields = normalizeObservation({ fields: { status: { name: 'To Do' }, assignee: null } });
  assert.deepStrictEqual(direct, fields);
  assert.deepStrictEqual(
    evaluateEligibility({ status: { name: 'To Do' }, assignee: null }, undefined, allowed),
    evaluateEligibility({ fields: { status: { name: 'To Do' }, assignee: null } }, undefined, allowed)
  );
});

test('status matching is exact after trimming and never uses statusCategory', () => {
  assert.strictEqual(normalizeStatusName({ name: ' To Do ' }), 'To Do');
  assert.strictEqual(normalizeStatusName({ statusCategory: { name: 'To Do' } }), null);
  assert.strictEqual(evaluateEligibility('to do', null, allowed).verdict, VERDICTS.INELIGIBLE);
  assert.strictEqual(evaluateEligibility({ statusCategory: { name: 'To Do' } }, null, allowed).verdict,
    VERDICTS.UNKNOWN);
});

test('assignee null is the only known unassigned observation', () => {
  assert.deepStrictEqual(normalizeAssignee(null), { known: true, assigned: false, value: null });
  assert.strictEqual(normalizeAssignee({ accountId: 'abc' }).assigned, true);
  assert.strictEqual(normalizeAssignee({}).known, false);
});

test('history and unrelated fields cannot change the verdict', () => {
  const plain = evaluateEligibility('To Do', null, allowed);
  const noisy = evaluateEligibility({
    fields: { status: { name: 'To Do' }, assignee: null, priority: { name: 'Highest' } },
    changelog: { histories: [{ items: [{ fromString: 'In Progress', toString: 'To Do' }] }] },
    worklog: { total: 3 },
    statusCategory: { name: 'new' },
  }, undefined, allowed);
  assert.deepStrictEqual(noisy, plain);
});

test('the same input is deterministic and does not mutate the configured set', () => {
  const configured = [' To Do ', 'Backlog', 'To Do'];
  const first = evaluateEligibility('To Do', null, configured);
  const second = evaluateEligibility('To Do', null, configured);
  assert.deepStrictEqual(first, second);
  assert.deepStrictEqual(configured, [' To Do ', 'Backlog', 'To Do']);
});

done();
