'use strict';

const ENVELOPE_SCHEMA = 'shipyard.subscription-observation.v1';
const SUMMARY_SCHEMA = 'shipyard.subscription-usage.v1';

// @contract: units are normalized by source only, never inferred from magnitude.
const SOURCES = Object.freeze({
  'claude-stream': Object.freeze({ provider: 'anthropic', runtime: 'claude', unit: 'fraction' }),
  'codex-native': Object.freeze({ provider: 'openai', runtime: 'codex', unit: 'percent' }),
  'claude-statusline': Object.freeze({ provider: 'anthropic', runtime: 'claude', unit: 'percent' }),
});

const CLAUDE_WINDOW_MINUTES = Object.freeze({ five_hour: 300, seven_day: 10080 });

const COVERAGE = Object.freeze({ codex_parent: 'unverified', codex_idle_baseline: 'unverified' });

const RESET_TOLERANCE_SECONDS = 60;

const CODEX_SLOTS = Object.freeze(['primary', 'secondary']);

const DISCONTINUITY_REASONS = Object.freeze([
  'reset', 'decrease', 'account_label_change', 'unattributed', 'unknown_concurrency', 'window_change',
]);

const LABEL_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;

const ENVELOPE_FIELDS = Object.freeze([
  'schema', 'provider', 'runtime', 'source', 'account_label', 'attribution',
  'bucket_id', 'window_minutes', 'resets_at', 'used_percent',
  'observed_at', 'freshness', 'concurrency',
]);
const ENVELOPE_FIELD_SET = new Set(ENVELOPE_FIELDS);

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function moduleError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

// @security: throws on any label that does not match the allow-listed pattern.
function normalizeLabel(value) {
  if (value === undefined || value === null) return null;
  if (typeof value === 'string' && LABEL_PATTERN.test(value)) return value;
  throw moduleError('INVALID_LABEL', `account label must match ${LABEL_PATTERN}`);
}

function safeLabel(accountLabels, runtime, warnings) {
  try {
    return normalizeLabel(object(accountLabels) ? accountLabels[runtime] : undefined);
  } catch (error) {
    warnings.push(`ignored an invalid account label for ${runtime}: ${error.message}`);
    return null;
  }
}

// @security: only allow-listed fields are copied; never spread a raw record.
function buildEnvelope(fields) {
  if (!object(fields)) throw moduleError('INVALID_ENVELOPE_FIELDS', 'buildEnvelope requires a fields object');
  const sourceMeta = SOURCES[fields.source];
  if (!sourceMeta) {
    throw moduleError('INVALID_SOURCE', `buildEnvelope: unknown source ${JSON.stringify(fields.source)}`);
  }
  return Object.freeze({
    schema: ENVELOPE_SCHEMA,
    provider: sourceMeta.provider,
    runtime: sourceMeta.runtime,
    source: fields.source,
    account_label: fields.account_label === undefined ? null : fields.account_label,
    attribution: fields.attribution === undefined ? 'unattributed' : fields.attribution,
    bucket_id: fields.bucket_id,
    window_minutes: fields.window_minutes === undefined ? null : fields.window_minutes,
    resets_at: fields.resets_at === undefined ? null : fields.resets_at,
    used_percent: fields.used_percent,
    observed_at: fields.observed_at === undefined ? null : fields.observed_at,
    freshness: fields.freshness === undefined ? 'unknown' : fields.freshness,
    concurrency: fields.concurrency === undefined ? 'unknown' : fields.concurrency,
  });
}

function validateEnvelope(value) {
  if (!object(value)) throw moduleError('INVALID_ENVELOPE', 'envelope must be a plain object');
  for (const key of Object.keys(value)) {
    if (!ENVELOPE_FIELD_SET.has(key)) {
      throw moduleError('INVALID_ENVELOPE', `envelope has an unsupported field: ${key}`);
    }
  }
  if (value.schema !== ENVELOPE_SCHEMA) {
    throw moduleError('INVALID_ENVELOPE', `envelope schema must be ${ENVELOPE_SCHEMA}`);
  }
  return true;
}

function claudePercent(utilization) {
  return Math.round(utilization * 10000) / 100;
}

function parseClaudeRow(row, context, envelopes, warnings) {
  const info = row.rate_limit_info;
  if (!object(info)) { warnings.push('rate_limit_event row is missing rate_limit_info'); return; }
  const windows = info.unifiedWindows;
  if (!object(windows)) { warnings.push('rate_limit_event row is missing unifiedWindows'); return; }
  const label = safeLabel(context.accountLabels, 'claude', warnings);
  const attribution = label ? 'declared' : 'unattributed';
  const observedAt = context.observedAt === undefined || context.observedAt === null ? null : context.observedAt;
  const freshness = observedAt !== null ? (context.freshness || 'unknown') : 'unknown';
  for (const [bucketId, windowValue] of Object.entries(windows)) {
    if (!object(windowValue)) {
      warnings.push(`rate_limit_event unifiedWindows.${bucketId} is not an object`);
      continue;
    }
    const utilization = windowValue.utilization;
    if (typeof utilization !== 'number' || !Number.isFinite(utilization)) {
      warnings.push(`rate_limit_event unifiedWindows.${bucketId} has a missing or non-numeric utilization`);
      continue;
    }
    const resetsAt = Number.isSafeInteger(windowValue.resetsAt) ? windowValue.resetsAt : null;
    envelopes.push(buildEnvelope({
      source: 'claude-stream',
      account_label: label,
      attribution,
      bucket_id: bucketId,
      window_minutes: Object.prototype.hasOwnProperty.call(CLAUDE_WINDOW_MINUTES, bucketId)
        ? CLAUDE_WINDOW_MINUTES[bucketId] : null,
      resets_at: resetsAt,
      used_percent: claudePercent(utilization),
      observed_at: observedAt,
      freshness,
    }));
  }
}

function parseCodexRow(row, context, envelopes, warnings) {
  const payload = row.payload;
  if (!object(payload) || payload.type !== 'token_count') return;
  const rateLimits = payload.rate_limits;
  if (rateLimits === undefined || rateLimits === null) return;
  if (!object(rateLimits)) { warnings.push('codex token_count event has a malformed rate_limits value'); return; }
  const limitId = rateLimits.limit_id;
  if (typeof limitId !== 'string' || !limitId.trim()) {
    warnings.push('codex rate_limits is missing a usable limit_id');
    return;
  }
  const observedAt = typeof row.timestamp === 'string' && Number.isFinite(Date.parse(row.timestamp))
    ? row.timestamp : null;
  const freshness = observedAt !== null ? 'observed' : 'unknown';
  const label = safeLabel(context.accountLabels, 'codex', warnings);
  const attribution = label ? 'declared' : 'unattributed';
  for (const slotName of CODEX_SLOTS) {
    const slot = rateLimits[slotName];
    if (slot === undefined || slot === null) continue;
    if (!object(slot)) { warnings.push(`codex rate_limits.${slotName} is not an object`); continue; }
    const usedPercent = slot.used_percent;
    if (typeof usedPercent !== 'number' || !Number.isFinite(usedPercent)) {
      warnings.push(`codex rate_limits.${slotName} has a missing or non-numeric used_percent`);
      continue;
    }
    envelopes.push(buildEnvelope({
      source: 'codex-native',
      account_label: label,
      attribution,
      bucket_id: `${limitId}:${slotName}`,
      window_minutes: Number.isSafeInteger(slot.window_minutes) ? slot.window_minutes : null,
      resets_at: Number.isSafeInteger(slot.resets_at) ? slot.resets_at : null,
      used_percent: usedPercent,
      observed_at: observedAt,
      freshness,
    }));
  }
}

function fromTranscriptRows(rows, context) {
  const envelopes = [];
  const warnings = [];
  const ctx = object(context) ? context : {};
  if (!Array.isArray(rows)) {
    warnings.push('fromTranscriptRows: rows must be an array');
    return { envelopes, warnings };
  }
  for (const row of rows) {
    if (!object(row)) continue;
    if (row.type === 'rate_limit_event') parseClaudeRow(row, ctx, envelopes, warnings);
    else if (row.type === 'event_msg') parseCodexRow(row, ctx, envelopes, warnings);
  }
  return { envelopes, warnings };
}

function seriesKeyOf(envelope) {
  return JSON.stringify([
    envelope.provider, envelope.runtime, envelope.account_label, envelope.bucket_id, envelope.window_minutes,
  ]);
}

function lineageKeyOf(envelope) {
  return JSON.stringify([envelope.provider, envelope.runtime, envelope.bucket_id]);
}

function round2(value) {
  return Math.round(value * 100) / 100;
}

// @invariant: resets_at differing by <= 60s counts as the same reset, never a discontinuity.
function withinSeriesContinuous(entry, discontinuities) {
  const samples = entry.samples;
  let continuous = true;
  for (let i = 1; i < samples.length; i++) {
    const prev = samples[i - 1];
    const cur = samples[i];
    let isReset = false;
    if (Number.isSafeInteger(prev.resets_at) && Number.isSafeInteger(cur.resets_at)
        && Math.abs(cur.resets_at - prev.resets_at) > RESET_TOLERANCE_SECONDS) {
      isReset = true;
      continuous = false;
      discontinuities.push({
        reason: 'reset', provider: entry.provider, runtime: entry.runtime, account_label: entry.account_label,
        bucket_id: entry.bucket_id, window_minutes: entry.window_minutes,
        from_resets_at: prev.resets_at, to_resets_at: cur.resets_at,
      });
    }
    if (!isReset && typeof prev.used_percent === 'number' && typeof cur.used_percent === 'number'
        && cur.used_percent < prev.used_percent) {
      continuous = false;
      discontinuities.push({
        reason: 'decrease', provider: entry.provider, runtime: entry.runtime, account_label: entry.account_label,
        bucket_id: entry.bucket_id, window_minutes: entry.window_minutes,
        from_used_percent: prev.used_percent, to_used_percent: cur.used_percent,
      });
    }
  }
  if (new Set(samples.map((sample) => sample.concurrency)).size > 1) {
    discontinuities.push({
      reason: 'unknown_concurrency', provider: entry.provider, runtime: entry.runtime,
      account_label: entry.account_label, bucket_id: entry.bucket_id, window_minutes: entry.window_minutes,
    });
  }
  return continuous && samples.every((sample) => sample.concurrency === 'exclusive');
}

function lineageDiscontinuities(envelopes, discontinuities) {
  const lastSeen = new Map();
  for (const envelope of envelopes) {
    const key = lineageKeyOf(envelope);
    const prior = lastSeen.get(key);
    if (prior) {
      if (prior.window_minutes !== envelope.window_minutes) {
        discontinuities.push({
          reason: 'window_change', provider: envelope.provider, runtime: envelope.runtime,
          bucket_id: envelope.bucket_id,
          from_window_minutes: prior.window_minutes, to_window_minutes: envelope.window_minutes,
        });
      } else if (prior.account_label !== envelope.account_label) {
        const reason = prior.account_label === null || envelope.account_label === null
          ? 'unattributed' : 'account_label_change';
        discontinuities.push({
          reason, provider: envelope.provider, runtime: envelope.runtime, bucket_id: envelope.bucket_id,
          from_account_label: prior.account_label, to_account_label: envelope.account_label,
        });
      }
    }
    lastSeen.set(key, { account_label: envelope.account_label, window_minutes: envelope.window_minutes });
  }
}

// @invariant: series are never summed; there is no scalar total across series.
function summarize(envelopes, options) {
  void options;
  const list = Array.isArray(envelopes) ? envelopes : [];
  const warnings = [];
  const order = [];
  const groups = new Map();
  const valid = [];
  for (const envelope of list) {
    if (!object(envelope)) { warnings.push('summarize: skipped a non-object value'); continue; }
    try {
      validateEnvelope(envelope);
    } catch (error) {
      warnings.push(`summarize: skipped an invalid envelope (${error.message})`);
      continue;
    }
    valid.push(envelope);
    const key = seriesKeyOf(envelope);
    let entry = groups.get(key);
    if (!entry) {
      entry = {
        provider: envelope.provider, runtime: envelope.runtime, account_label: envelope.account_label,
        bucket_id: envelope.bucket_id, window_minutes: envelope.window_minutes, samples: [],
      };
      groups.set(key, entry);
      order.push(entry);
    }
    entry.samples.push({
      used_percent: envelope.used_percent, resets_at: envelope.resets_at, concurrency: envelope.concurrency,
    });
  }

  const discontinuities = [];
  const series = order.map((entry) => {
    const continuous = withinSeriesContinuous(entry, discontinuities);
    const first = { used_percent: entry.samples[0].used_percent, resets_at: entry.samples[0].resets_at };
    const lastSample = entry.samples[entry.samples.length - 1];
    const last = { used_percent: lastSample.used_percent, resets_at: lastSample.resets_at };
    return {
      provider: entry.provider, runtime: entry.runtime, account_label: entry.account_label,
      bucket_id: entry.bucket_id, window_minutes: entry.window_minutes,
      samples: entry.samples.length, first, last,
      delta: continuous ? round2(last.used_percent - first.used_percent) : null,
      segment: continuous ? 'measured' : 'inconclusive',
    };
  });

  lineageDiscontinuities(valid, discontinuities);

  const status = Object.freeze({
    implemented: true, installed: list.length > 0, behaviorally_verified: false, efficiency_measured: false,
  });

  return Object.freeze({
    schema: SUMMARY_SCHEMA,
    version: 1,
    series,
    discontinuities,
    coverage: COVERAGE,
    verdict: 'inconclusive',
    status,
    warnings,
  });
}

module.exports = Object.freeze({
  ENVELOPE_SCHEMA,
  SUMMARY_SCHEMA,
  SOURCES,
  CLAUDE_WINDOW_MINUTES,
  COVERAGE,
  RESET_TOLERANCE_SECONDS,
  DISCONTINUITY_REASONS,
  LABEL_PATTERN,
  normalizeLabel,
  buildEnvelope,
  validateEnvelope,
  fromTranscriptRows,
  summarize,
});
