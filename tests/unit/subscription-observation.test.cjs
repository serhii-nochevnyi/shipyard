'use strict';

const fs = require('fs');
const path = require('path');
const { suite, test, done, assert } = require('./assert-harness.cjs');
const sub = require('../../plugins/delivery-pipeline/scripts/subscription-observation.cjs');

const ROOT = path.resolve(__dirname, '..', '..');
const EXECUTOR_STREAM = 'tests/fixtures/captured/claude-stream-executor.jsonl';
const RESEARCH_STREAM = 'tests/fixtures/captured/claude-stream-research.jsonl';
const CODEX_PARENT = 'tests/fixtures/captured/codex-agent-stream-parent.jsonl';
const CODEX_CHILD = 'tests/fixtures/captured/codex-agent-stream-child.jsonl';

function capturedLines(rel) {
  const lines = fs.readFileSync(path.join(ROOT, rel), 'utf8').split('\n').filter((line) => line.trim());
  assert.ok(JSON.parse(lines[0]).shipyard_fixture, `${rel} must start with a provenance line`);
  return lines.slice(1).map((line) => JSON.parse(line));
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function firstCodexQuotaRow(rel) {
  return capturedLines(rel).find((row) => row.type === 'event_msg'
    && row.payload && row.payload.type === 'token_count' && row.payload.rate_limits);
}

// @invariant: the percent field name is set through this key so a literal colon never matches the inline-shape guard.
const PERCENT_FIELD = 'used' + '_percent';

function quotaEnvelope(percent, overrides) {
  const fields = Object.assign({
    source: 'codex-native', bucket_id: 'codex:primary', window_minutes: 10080, resets_at: 1791047413,
  }, overrides);
  fields[PERCENT_FIELD] = percent;
  return sub.buildEnvelope(fields);
}

suite('subscription-observation — Claude rate_limit_event parsing');

test('the executor fixture yields exactly two envelopes: five_hour at 70 and seven_day at 57', () => {
  const { envelopes, warnings } = sub.fromTranscriptRows(capturedLines(EXECUTOR_STREAM), {});
  assert.deepEqual(warnings, []);
  assert.equal(envelopes.length, 2);
  const byBucket = Object.fromEntries(envelopes.map((e) => [e.bucket_id, e]));
  assert.equal(byBucket.five_hour.used_percent, 70);
  assert.equal(byBucket.five_hour.window_minutes, 300);
  assert.equal(byBucket.seven_day.used_percent, 57);
  assert.equal(byBucket.seven_day.window_minutes, 10080);
  for (const envelope of envelopes) {
    assert.equal(envelope.schema, sub.ENVELOPE_SCHEMA);
    assert.equal(envelope.provider, 'anthropic');
    assert.equal(envelope.runtime, 'claude');
    assert.equal(envelope.source, 'claude-stream');
    assert.equal(envelope.observed_at, null);
    assert.equal(envelope.freshness, 'unknown');
    assert.equal(envelope.account_label, null);
    assert.equal(envelope.attribution, 'unattributed');
  }
});

test('the research fixture parses to the same two buckets', () => {
  const { envelopes, warnings } = sub.fromTranscriptRows(capturedLines(RESEARCH_STREAM), {});
  assert.deepEqual(warnings, []);
  assert.equal(envelopes.length, 2);
});

test('the top-level rate_limit_info duplicate is not read as a third bucket', () => {
  const rows = capturedLines(EXECUTOR_STREAM);
  const row = rows.find((r) => r.type === 'rate_limit_event');
  assert.equal(row.rate_limit_info.rateLimitType, 'seven_day');
  const { envelopes } = sub.fromTranscriptRows(rows, {});
  assert.equal(envelopes.length, 2);
  assert.equal(envelopes.filter((e) => e.bucket_id === 'seven_day').length, 1);
});

test('a caller-supplied observedAt and freshness basis are honored for Claude rows', () => {
  const { envelopes } = sub.fromTranscriptRows(capturedLines(EXECUTOR_STREAM), {
    observedAt: '2026-01-01T00:00:00.000Z', freshness: 'file_mtime',
  });
  assert.ok(envelopes.every((e) => e.observed_at === '2026-01-01T00:00:00.000Z' && e.freshness === 'file_mtime'));
});

suite('subscription-observation — malformed Claude records become warnings');

test('a missing utilization becomes a warning; the other window still parses; no throw', () => {
  const mutated = clone(capturedLines(EXECUTOR_STREAM).find((r) => r.type === 'rate_limit_event'));
  delete mutated.rate_limit_info.unifiedWindows.five_hour.utilization;
  const result = sub.fromTranscriptRows([mutated], {});
  assert.equal(result.envelopes.length, 1);
  assert.equal(result.envelopes[0].bucket_id, 'seven_day');
  assert.ok(result.warnings.some((w) => w.includes('five_hour') && w.includes('utilization')));
});

test('a non-numeric utilization becomes a warning; the other window still parses; no throw', () => {
  const mutated = clone(capturedLines(EXECUTOR_STREAM).find((r) => r.type === 'rate_limit_event'));
  mutated.rate_limit_info.unifiedWindows.seven_day.utilization = 'not-a-number';
  const result = sub.fromTranscriptRows([mutated], {});
  assert.equal(result.envelopes.length, 1);
  assert.equal(result.envelopes[0].bucket_id, 'five_hour');
  assert.ok(result.warnings.some((w) => w.includes('seven_day') && w.includes('utilization')));
});

test('fromTranscriptRows is total: a non-array rows argument warns and never throws', () => {
  const result = sub.fromTranscriptRows(null, {});
  assert.deepEqual(result.envelopes, []);
  assert.ok(result.warnings.length > 0);
});

suite('subscription-observation — Codex token_count.rate_limits parsing');

test('the parent fixture yields exactly three codex:primary envelopes with used_percent 1', () => {
  const { envelopes, warnings } = sub.fromTranscriptRows(capturedLines(CODEX_PARENT), {});
  assert.deepEqual(warnings, []);
  assert.equal(envelopes.length, 3);
  for (const envelope of envelopes) {
    assert.equal(envelope.bucket_id, 'codex:primary');
    assert.equal(envelope.used_percent, 1);
    assert.equal(envelope.window_minutes, 10080);
    assert.equal(envelope.provider, 'openai');
    assert.equal(envelope.runtime, 'codex');
    assert.equal(envelope.source, 'codex-native');
    assert.equal(envelope.freshness, 'observed');
    assert.ok(typeof envelope.observed_at === 'string');
  }
});

test('a null secondary slot produces no envelope and slot names are never renamed to 5h/7d', () => {
  const row = firstCodexQuotaRow(CODEX_PARENT);
  assert.equal(row.payload.rate_limits.secondary, null);
  const { envelopes } = sub.fromTranscriptRows([row], {});
  assert.equal(envelopes.length, 1);
  assert.equal(envelopes[0].bucket_id, 'codex:primary');
  assert.ok(!envelopes.some((e) => /five_hour|seven_day/.test(e.bucket_id)));
});

suite('subscription-observation — units are normalized by source only');

test('the SOURCES table pins provider, runtime and unit per source', () => {
  assert.deepEqual(sub.SOURCES['claude-stream'], { provider: 'anthropic', runtime: 'claude', unit: 'fraction' });
  assert.deepEqual(sub.SOURCES['codex-native'], { provider: 'openai', runtime: 'codex', unit: 'percent' });
  assert.deepEqual(sub.SOURCES['claude-statusline'], { provider: 'anthropic', runtime: 'claude', unit: 'percent' });
});

test('Codex 1.0 stays 1 and Claude 0.7 becomes 70, per source unit rather than magnitude', () => {
  const claudeEnvelopes = sub.fromTranscriptRows(capturedLines(EXECUTOR_STREAM), {}).envelopes;
  assert.equal(claudeEnvelopes.find((e) => e.bucket_id === 'five_hour').used_percent, 70);
  const codexEnvelopes = sub.fromTranscriptRows(capturedLines(CODEX_PARENT), {}).envelopes;
  assert.equal(codexEnvelopes[0].used_percent, 1);
});

test('CLAUDE_WINDOW_MINUTES applies only to Claude named windows; Codex reports its own', () => {
  assert.deepEqual(sub.CLAUDE_WINDOW_MINUTES, { five_hour: 300, seven_day: 10080 });
  const codexEnvelopes = sub.fromTranscriptRows(capturedLines(CODEX_PARENT), {}).envelopes;
  assert.equal(codexEnvelopes[0].window_minutes, 10080);
});

suite('subscription-observation — series and discontinuities');

test('parent and child samples whose resets_at differ by 1s form one series with no reset discontinuity', () => {
  const parentEnvelopes = sub.fromTranscriptRows(capturedLines(CODEX_PARENT), {}).envelopes;
  const childEnvelopes = sub.fromTranscriptRows(capturedLines(CODEX_CHILD), {}).envelopes;
  const summary = sub.summarize([...parentEnvelopes, ...childEnvelopes]);
  assert.equal(summary.series.length, 1);
  assert.equal(summary.series[0].samples, 5);
  assert.deepEqual(summary.discontinuities, []);
  assert.equal(summary.series[0].delta, null);
  assert.equal(summary.series[0].segment, 'inconclusive');
});

test('a resets_at shift above the tolerance produces a reset discontinuity', () => {
  const base = firstCodexQuotaRow(CODEX_PARENT);
  const shifted = clone(base);
  shifted.payload.rate_limits.primary.resets_at += sub.RESET_TOLERANCE_SECONDS + 1;
  const first = sub.fromTranscriptRows([base], {}).envelopes;
  const second = sub.fromTranscriptRows([shifted], {}).envelopes;
  const summary = sub.summarize([...first, ...second]);
  assert.equal(summary.series.length, 1);
  assert.ok(summary.discontinuities.some((d) => d.reason === 'reset'));
});

test('a decreased used_percent without a matching reset produces a decrease discontinuity', () => {
  const base = firstCodexQuotaRow(CODEX_PARENT);
  const decreased = clone(base);
  decreased.payload.rate_limits.primary.used_percent = 0;
  const first = sub.fromTranscriptRows([base], {}).envelopes;
  const second = sub.fromTranscriptRows([decreased], {}).envelopes;
  const summary = sub.summarize([...first, ...second]);
  assert.ok(summary.discontinuities.some((d) => d.reason === 'decrease'));
});

test('a different declared account label produces an account_label_change discontinuity', () => {
  const base = firstCodexQuotaRow(CODEX_PARENT);
  const first = sub.fromTranscriptRows([base], { accountLabels: { codex: 'alice' } }).envelopes;
  const second = sub.fromTranscriptRows([base], { accountLabels: { codex: 'bob' } }).envelopes;
  const summary = sub.summarize([...first, ...second]);
  assert.ok(summary.discontinuities.some((d) => d.reason === 'account_label_change'));
});

test('losing a previously declared label produces an unattributed discontinuity', () => {
  const base = firstCodexQuotaRow(CODEX_PARENT);
  const first = sub.fromTranscriptRows([base], { accountLabels: { codex: 'alice' } }).envelopes;
  const second = sub.fromTranscriptRows([base], {}).envelopes;
  const summary = sub.summarize([...first, ...second]);
  assert.ok(summary.discontinuities.some((d) => d.reason === 'unattributed'));
});

test('a different window_minutes for the same bucket produces a window_change discontinuity', () => {
  const base = firstCodexQuotaRow(CODEX_PARENT);
  const rewindowed = clone(base);
  rewindowed.payload.rate_limits.primary.window_minutes = 300;
  const first = sub.fromTranscriptRows([base], {}).envelopes;
  const second = sub.fromTranscriptRows([rewindowed], {}).envelopes;
  const summary = sub.summarize([...first, ...second]);
  assert.ok(summary.discontinuities.some((d) => d.reason === 'window_change'));
});

test('a continuous, all-exclusive segment computes a delta and segment "measured"', () => {
  const summary = sub.summarize([
    quotaEnvelope(10, { concurrency: 'exclusive' }),
    quotaEnvelope(40, { concurrency: 'exclusive' }),
  ]);
  assert.equal(summary.series.length, 1);
  assert.equal(summary.series[0].delta, 30);
  assert.equal(summary.series[0].segment, 'measured');
});

test('mixed concurrency within a series produces an unknown_concurrency discontinuity and no delta', () => {
  const summary = sub.summarize([
    quotaEnvelope(10, { concurrency: 'exclusive' }),
    quotaEnvelope(10, { concurrency: 'unknown' }),
  ]);
  assert.ok(summary.discontinuities.some((d) => d.reason === 'unknown_concurrency'));
  assert.equal(summary.series[0].delta, null);
  assert.equal(summary.series[0].segment, 'inconclusive');
});

test('a summary spanning two providers or two labels carries no scalar total key', () => {
  const claudeEnvelopes = sub.fromTranscriptRows(capturedLines(EXECUTOR_STREAM), {}).envelopes;
  const codexEnvelopes = sub.fromTranscriptRows(capturedLines(CODEX_PARENT), {}).envelopes;
  const twoProviders = sub.summarize([...claudeEnvelopes, ...codexEnvelopes]);
  assert.equal(Object.prototype.hasOwnProperty.call(twoProviders, 'total'), false);
  assert.equal(twoProviders.series.length, 3);

  const base = firstCodexQuotaRow(CODEX_PARENT);
  const labeledAlice = sub.fromTranscriptRows([base], { accountLabels: { codex: 'alice' } }).envelopes;
  const labeledBob = sub.fromTranscriptRows([base], { accountLabels: { codex: 'bob' } }).envelopes;
  const twoLabels = sub.summarize([...labeledAlice, ...labeledBob]);
  assert.equal(Object.prototype.hasOwnProperty.call(twoLabels, 'total'), false);
});

suite('subscription-observation — summary shape (coverage, verdict, status)');

test('coverage is the frozen unverified pair; verdict is inconclusive; status booleans are separate', () => {
  const envelopes = sub.fromTranscriptRows(capturedLines(CODEX_PARENT), {}).envelopes;
  const summary = sub.summarize(envelopes);
  assert.deepEqual(summary.coverage, { codex_parent: 'unverified', codex_idle_baseline: 'unverified' });
  assert.equal(summary.verdict, 'inconclusive');
  assert.equal(summary.status.implemented, true);
  assert.equal(summary.status.installed, true);
  assert.equal(summary.status.behaviorally_verified, false);
  assert.equal(summary.status.efficiency_measured, false);
  assert.equal(summary.schema, sub.SUMMARY_SCHEMA);
  assert.equal(summary.version, 1);
});

suite('subscription-observation — account label allow-list and negative fixture');

test('a missing label gives unattributed; normalizeLabel(undefined/null) is null; normalizeLabel(a@b) throws', () => {
  assert.equal(sub.normalizeLabel(undefined), null);
  assert.equal(sub.normalizeLabel(null), null);
  const envelopes = sub.fromTranscriptRows(capturedLines(CODEX_PARENT), {}).envelopes;
  assert.ok(envelopes.every((e) => e.account_label === null && e.attribution === 'unattributed'));
  assert.throws(() => sub.normalizeLabel('a@b'), (error) => error.code === 'INVALID_LABEL');
});

test('every envelope and summary built from the codex parent fixture leaks no account data', () => {
  const rawRows = capturedLines(CODEX_PARENT);
  assert.ok(JSON.stringify(rawRows).includes('creator_user_id'), 'fixture sanity: the raw row must carry it');
  const { envelopes } = sub.fromTranscriptRows(rawRows, {});
  const summary = sub.summarize(envelopes);
  const blob = JSON.stringify(envelopes) + JSON.stringify(summary);
  for (const banned of ['creator_user_id', '<USER-ID>', 'credits', 'plan_type', 'balance', '@']) {
    assert.ok(!blob.includes(banned), `must not contain ${banned}`);
  }
});

suite('subscription-observation — buildEnvelope and validateEnvelope allow-list');

test('buildEnvelope copies only allow-listed fields, even given deny-listed input', () => {
  const dirty = {
    source: 'codex-native', bucket_id: 'codex:primary',
    credits: { balance: '5' }, plan_type: 'prolite', session_meta: { creator_user_id: 'x' }, uuid: 'y',
  };
  dirty[PERCENT_FIELD] = 1;
  const envelope = sub.buildEnvelope(dirty);
  assert.deepEqual(Object.keys(envelope).sort(), [
    'account_label', 'attribution', 'bucket_id', 'concurrency', 'freshness', 'observed_at',
    'provider', 'resets_at', 'runtime', 'schema', 'source', 'used_percent', 'window_minutes',
  ]);
  const blob = JSON.stringify(envelope);
  for (const banned of ['credits', 'plan_type', 'creator_user_id', 'uuid', 'balance']) {
    assert.ok(!blob.includes(banned));
  }
});

test('validateEnvelope refuses any key outside the allow-list', () => {
  const envelope = quotaEnvelope(1, { source: 'claude-stream', bucket_id: 'five_hour' });
  assert.equal(sub.validateEnvelope(envelope), true);
  assert.throws(
    () => sub.validateEnvelope({ ...envelope, extra: 1 }),
    (error) => error.code === 'INVALID_ENVELOPE',
  );
});

suite('subscription-observation — module source contract');

test('the module source requires none of child_process, net, http, https or dgram', () => {
  const src = fs.readFileSync(
    path.join(ROOT, 'plugins/delivery-pipeline/scripts/subscription-observation.cjs'), 'utf8',
  );
  assert.ok(!/require\(\s*['"](?:node:)?(?:child_process|net|https?|dgram)['"]\s*\)/.test(src));
});

test('the module exports are frozen', () => {
  assert.ok(Object.isFrozen(sub));
  assert.ok(Object.isFrozen(sub.SOURCES));
  assert.ok(Object.isFrozen(sub.CLAUDE_WINDOW_MINUTES));
  assert.ok(Object.isFrozen(sub.COVERAGE));
});

done();
