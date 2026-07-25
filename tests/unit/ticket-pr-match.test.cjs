'use strict';

// Ticket↔PR matching decides `status`, and `status: merged` is what the reaper
// acts on — it force-deletes the branch. So the ranking here is a data-safety
// property, not a preference.

const path = require('path');
const { suite, test, done, assert } = require('./assert-harness.cjs');
const { matchTicketPr, titleSimilarity } =
  require(path.join(__dirname, '..', '..', 'plugins', 'delivery-pipeline', 'scripts', 'ticket-pr-match.cjs'));

const ticket = { branch: 'ticket/T-01-02-add-undo-endpoint', title: 'Add undo endpoint' };
const pr = (over) => ({
  number: 1, state: 'OPEN', title: 'T-01-02: Add undo endpoint',
  headRefName: ticket.branch, createdAt: '2026-01-01T00:00:00Z', ...over,
});

suite('matchTicketPr — branch match');

test('an exact branch match wins and is labelled `branch`', () => {
  const m = matchTicketPr('T-01-02', ticket, [pr({ number: 7 })]);
  assert.strictEqual(m.matchedBy, 'branch');
  assert.strictEqual(m.pr.number, 7);
});

test('an OPEN follow-up outranks an older MERGED PR on the same branch', () => {
  // The regression: preferring MERGED made the ticket read as delivered, and the
  // reaper then removed the worktree and force-deleted a branch that still had an
  // open PR with unmerged commits.
  const rows = [
    pr({ number: 10, state: 'MERGED', createdAt: '2026-01-01T00:00:00Z' }),
    pr({ number: 11, state: 'OPEN', createdAt: '2026-02-01T00:00:00Z' }),
  ];
  assert.strictEqual(matchTicketPr('T-01-02', ticket, rows).pr.number, 11);
  // order of the input must not matter
  assert.strictEqual(matchTicketPr('T-01-02', ticket, rows.slice().reverse()).pr.number, 11);
});

test('with only a MERGED PR the ticket is still recognised as merged', () => {
  const m = matchTicketPr('T-01-02', ticket, [pr({ number: 9, state: 'MERGED' })]);
  assert.strictEqual(m.pr.state, 'MERGED');
});

test('MERGED outranks CLOSED', () => {
  const rows = [pr({ number: 3, state: 'CLOSED' }), pr({ number: 4, state: 'MERGED' })];
  assert.strictEqual(matchTicketPr('T-01-02', ticket, rows).pr.number, 4);
});

test('same state → the newest row wins', () => {
  const rows = [
    pr({ number: 5, createdAt: '2026-01-01T00:00:00Z' }),
    pr({ number: 6, createdAt: '2026-03-01T00:00:00Z' }),
  ];
  assert.strictEqual(matchTicketPr('T-01-02', ticket, rows).pr.number, 6);
});

suite('matchTicketPr — marker fallback (renamed branch)');

test('a title marker matches when the branch was renamed', () => {
  const rows = [pr({ number: 42, headRefName: 'ticket/T-01-02-old-slug' })];
  const m = matchTicketPr('T-01-02', ticket, rows);
  assert.strictEqual(m.matchedBy, 'marker');
  assert.strictEqual(m.pr.number, 42);
});

test('a colliding ticket id from another workspace is rejected by title similarity', () => {
  const rows = [pr({ number: 99, headRefName: 'other/branch', title: 'T-01-02: totally unrelated billing rewrite' })];
  assert.strictEqual(matchTicketPr('T-01-02', ticket, rows), null);
});

test('a ticket-id substring does not match a different id', () => {
  const rows = [pr({ number: 50, headRefName: 'x', title: 'T-01-020: Add undo endpoint' })];
  assert.strictEqual(matchTicketPr('T-01-02', ticket, rows), null);
});

test('no PR at all → null', () => {
  assert.strictEqual(matchTicketPr('T-01-02', ticket, []), null);
});

suite('titleSimilarity');

test('identical titles score 1, unrelated ones score 0', () => {
  assert.strictEqual(titleSimilarity('Add undo endpoint', 'Add undo endpoint'), 1);
  assert.strictEqual(titleSimilarity('Add undo endpoint', 'Rewrite billing module'), 0);
});

test('an empty ticket title scores 0 rather than dividing by zero', () => {
  assert.strictEqual(titleSimilarity('', 'anything'), 0);
});

done();
