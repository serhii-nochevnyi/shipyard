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

test('dispositions that are not an array are a coded refusal, not a TypeError', () => {
  for (const dispositions of [{ ref: 'PB-1-1' }, 'resolved', 7, true])
    assert.throws(() => core.normalizeFinal(final({ dispositions }), [part('complete')], OPTIONS), { code: 'JUDGMENT_OUTCOME_MISMATCH' });
  assert.equal(core.normalizeFinal(final({ dispositions: undefined }), [], OPTIONS).verdict, 'pass');
});

test('a part result over its byte share is refused so the final always fits', () => {
  const group = { id: 'part-1', ordinal: 1, paths: ['a.js'] };
  const result = { part: 'part-1', review_completeness: 'complete', limitations: [], unresolved_sources: [], summary: 'ok',
    findings: Array.from({ length: 40 }, (_, index) => ({ id: 'F-' + index, severity: 'WARNING', path: 'a.js', line: 3, summary: 'x'.repeat(1000) })) };
  assert.throws(() => core.normalizePart(result, group), { code: 'INVALID_RESULT', message: /32 KiB/ });
  assert.doesNotThrow(() => core.normalizePart({ ...result, findings: result.findings.slice(0, 10) }, group));
});

test('the runner checks the final at upper-bound size, then runs every part in order before the final', async () => {
  const groups = [1, 2, 3].map(ordinal => ({ id: 'part-' + ordinal, ordinal, paths: ['p' + ordinal] }));
  const changes = groups.map(group => change(group.paths[0]));
  const log = [];
  const result = await core.runParts(groups, { changes, check: parts => { log.push(['check', parts.length, parts[0].summary.length]); },
    part: async group => { log.push(['part', group.ordinal]); return { id: group.id, paths: group.paths }; },
    final: async parts => { log.push(['final', parts.map(entry => entry.id)]); return 'sealed'; } });
  assert.equal(result, 'sealed');
  assert.deepEqual(log, [['check', 3, 32768], ['part', 1], ['part', 2], ['part', 3], ['final', ['part-1', 'part-2', 'part-3']]]);
  const refused = [];
  await assert.rejects(core.runParts(groups, { changes, check() { throw Object.assign(new Error('too big'), { code: 'CONTEXT_OVER_BOUND' }); },
    part: group => refused.push(group), final: () => refused.push('final') }), { code: 'CONTEXT_OVER_BOUND' });
  assert.deepEqual(refused, []);
});

test('a part packet drops prior findings and carries only its own changes; the final carries the parts', () => {
  const base = { subject: 's', identity: { id: 's', repository: 'r', pr: 1, head: 'h', base_commit: 'b', merge_base: 'm', base_tree: 't', ticket_set_digest: 'd' },
    exactDiff: { base: 'm', head: 'h' }, integrationBase: {}, ticketSet: [], planAcceptance: [], round: { round: 1, scope: 'full' }, referenceDigest: 'x',
    priorFindings: [{ ref: 'P-01' }], changeMetadata: { changes: [change('a.js'), change('b.js')] } };
  const groups = core.pathGroups(base.changeMetadata.changes, 2);
  const forPart = core.assemblePacket({ ...base, part: groups[0], groups });
  assert.deepEqual(forPart.prior_findings, []);
  assert.deepEqual(forPart.change_metadata.changes.map(entry => entry.new_path), ['a.js']);
  assert.deepEqual(forPart.part, { id: 'part-1', ordinal: 1, of: 2, paths: ['a.js'] });
  const forFinal = core.assemblePacket({ ...base, parts: [{ id: 'part-1' }], groups });
  assert.equal(forFinal.prior_findings.length, 1);
  assert.equal(forFinal.change_metadata.changes.length, 2);
  assert.deepEqual(forFinal.parts, [{ id: 'part-1' }]);
  assert.equal(Object.hasOwn(core.assemblePacket(base), 'parts'), false);
});

test('the runner refuses parts that do not cover every changed path once, before the final', async () => {
  const groups = [{ id: 'part-1', ordinal: 1, paths: ['a.js'] }];
  const launched = [];
  await assert.rejects(core.runParts(groups, { changes: [change('a.js'), change('b.js')], check() {},
    part: async group => ({ id: group.id, paths: group.paths }), final: () => launched.push('final') }), { code: 'INVALID_RESULT' });
  assert.deepEqual(launched, []);
});
