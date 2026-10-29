'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const core = require('../../plugins/delivery-pipeline/scripts/code-review-core.cjs');

const change = (file, additions = 1, deletions = 0, extra = {}) => ({ status: 'M', old_path: file, new_path: file,
  additions, deletions, paths: [file], ...extra });
const paths = groups => groups.map(group => group.paths);

test('every product path lands in exactly one part, in a deterministic order', () => {
  const changes = ['b/two.js', 'a/one.js', 'c/three.js', 'a/four.js', 'b/five.js'].map(file => change(file, 4));
  const groups = core.pathGroups(changes, 12);
  assert.deepEqual(paths(groups), paths(core.pathGroups([...changes].reverse(), 12)));
  assert.doesNotThrow(() => core.assertPathPartition(changes, groups));
  assert.deepEqual(groups.map(group => group.id), ['part-1', 'part-2', 'part-3']);
});

test('paths are packed in sorted order whatever the input order', () => {
  assert.deepEqual(paths(core.pathGroups([change('c/x.js', 4), change('b/x.js', 4), change('a/x.js', 4)], 10)), [['a/x.js', 'b/x.js'], ['c/x.js']]);
});

test('a directory stays whole while it fits; an oversized one splits and one huge file is its own part', () => {
  assert.deepEqual(paths(core.pathGroups([change('a/x.js', 4), change('a/y.js', 4), change('b/z.js', 4)], 10)),
    [['a/x.js', 'a/y.js'], ['b/z.js']]);
  assert.deepEqual(paths(core.pathGroups([change('a/x.js', 4), change('b/y.js', 4)], 10)), [['a/x.js', 'b/y.js']]);
  assert.deepEqual(paths(core.pathGroups([change('big/a.js', 5), change('big/huge.js', 90), change('big/z.js', 5)], 20)),
    [['big/a.js'], ['big/huge.js'], ['big/z.js']]);
});

test('a rename keeps both of its paths in one part and a binary change weighs one line', () => {
  const renamed = { status: 'R90', old_path: 'old/name.js', new_path: 'new/name.js', additions: 2, deletions: 2,
    paths: ['old/name.js', 'new/name.js'] };
  assert.ok(core.pathGroups([renamed, change('other/file.js', 40)], 10)
    .some(group => group.paths.includes('old/name.js') && group.paths.includes('new/name.js')));
  const binary = file => change(file, null, null, { binary: true });
  assert.deepEqual(paths(core.pathGroups([binary('a.png'), binary('b.png')], 2)), [['a.png', 'b.png']]);
  assert.deepEqual(paths(core.pathGroups([binary('a.png'), binary('b.png')], 1)), [['a.png'], ['b.png']]);
});

test('a part set that omits, repeats or invents a path is refused', () => {
  const changes = [change('a.js'), change('b.js')];
  assert.doesNotThrow(() => core.assertPathPartition(changes, [{ paths: ['a.js'] }, { paths: ['b.js'] }]));
  for (const parts of [[['a.js']], [['a.js'], ['a.js', 'b.js']], [['a.js', 'b.js', 'c.js']]])
    assert.throws(() => core.assertPathPartition(changes, parts.map(list => ({ paths: list }))), { code: 'INVALID_RESULT' });
});

const OPTIONS = { round: 1, scope: 'full', priorFindings: [], readSource: () => null };
const blocker = { id: 'F-1', severity: 'BLOCKER', path: 'a.js', line: 3, summary: 's', failure_scenario: 'f',
  fix_ticket: { title: 't', scope: 'x', files: ['a.js'] } };
const part = (review_completeness, limitations = [], findings = []) => ({ ordinal: 1, review_completeness, limitations, unresolved_sources: [],
  findings: findings.map((finding, index) => finding.severity === 'BLOCKER' ? { ...finding, ref: 'PB-1-' + (index + 1) } : finding) });
const final = (extra = {}) => ({ review_completeness: 'complete', limitations: [], unresolved_sources: [], findings: [], dispositions: [], ...extra });

test('coverage comes from the parts and a complete verdict needs every part reviewed', () => {
  const parts = [part('complete'), part('incomplete', ['unreadable']), part('complete', ['skipped'])];
  assert.deepEqual(core.normalizeFinal(final(), [], OPTIONS).coverage, []);
  assert.deepEqual(core.normalizeFinal(final({ review_completeness: 'incomplete', limitations: ['x'], coverage: [{ partition: 9, status: 'reviewed' }] }),
    parts, OPTIONS).coverage.map(entry => entry.status), ['reviewed', 'not-reviewed', 'not-reviewed']);
  assert.throws(() => core.normalizeFinal(final(), parts, OPTIONS), { code: 'INVALID_RESULT' });
});

test('a part BLOCKER needs a justified disposition from the final and an unresolved one keeps the verdict blocking', () => {
  const parts = [part('complete', [], [blocker])];
  const disposition = (value, justification = 'Verified in the handler.') => final({ dispositions: [{ ref: 'PB-1-1', disposition: value, justification }] });
  assert.equal(core.normalizeFinal(disposition('resolved'), parts, OPTIONS).verdict, 'pass');
  assert.equal(core.normalizeFinal(disposition('resolved'), parts, OPTIONS).dispositions.length, 0);
  assert.throws(() => core.normalizeFinal(final(), parts, OPTIONS), { code: 'JUDGMENT_OUTCOME_MISMATCH' });
  assert.throws(() => core.normalizeFinal(disposition('resolved', ''), parts, OPTIONS), { code: 'JUDGMENT_OUTCOME_MISMATCH' });
  assert.throws(() => core.normalizeFinal(disposition('maybe'), parts, OPTIONS), { code: 'JUDGMENT_OUTCOME_MISMATCH' });
  assert.throws(() => core.normalizeFinal(disposition('unresolved'), parts, OPTIONS), { code: 'JUDGMENT_OUTCOME_MISMATCH' });
  assert.equal(core.normalizeFinal(final({ ...disposition('unresolved'), findings: [blocker] }), parts, OPTIONS).verdict, 'needs-fix');
});

test('a part BLOCKER written as the CR alias still needs a disposition and an invalid severity refuses the part', () => {
  const group = { id: 'part-1', ordinal: 1, paths: ['a.js'] };
  const result = severity => ({ part: 'part-1', review_completeness: 'complete', limitations: [], unresolved_sources: [], summary: 'ok',
    findings: [{ ...blocker, severity }] });
  const normalized = core.normalizePart(result('CR'), group);
  assert.equal(normalized.findings[0].severity, 'BLOCKER');
  assert.equal(normalized.findings[0].ref, 'PB-1-1');
  assert.throws(() => core.normalizeFinal(final(), [normalized], OPTIONS), { code: 'JUDGMENT_OUTCOME_MISMATCH' });
  for (const bad of ['blocker', 'Blocker', 'HIGH', undefined])
    assert.throws(() => core.normalizePart(result(bad), group), { code: 'INVALID_RESULT' });
});

test('a part result must echo its part and keeps only bounded finding fields', () => {
  const group = { id: 'part-2', ordinal: 2, paths: ['a.js'] };
  const result = { part: 'part-2', review_completeness: 'complete', limitations: [], unresolved_sources: [], summary: 'No defects.',
    findings: [{ id: 'F-1', severity: 'BLOCKER', path: 'a.js', line: 3, summary: 's', model: 'forged', fix_ticket: { title: 't' } }] };
  assert.deepEqual(core.normalizePart(result, group).findings, [{ id: 'F-1', severity: 'BLOCKER', path: 'a.js', line: 3, summary: 's',
    ref: 'PB-2-1', fix_ticket: { title: 't' } }]);
  for (const changed of [{ part: 'part-1' }, { findings: 'none' }, { limitations: ['x'.repeat(2000)] }, { summary: '' }])
    assert.throws(() => core.normalizePart({ ...result, ...changed }, group), { code: 'INVALID_RESULT' });
});
