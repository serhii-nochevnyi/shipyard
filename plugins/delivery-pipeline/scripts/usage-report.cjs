#!/usr/bin/env node
'use strict';

// Read-only transcript accounting. All totals are processing units, never quota.
// The optional usage-attribution ledger adds launch, ticket and model/effort
// provenance without guessing when a runtime hides it.
const fs = require('node:fs');
const path = require('node:path');

const FIELDS = ['input_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens', 'output_tokens'];
const CODEX_FIELDS = ['input_tokens', 'cached_input_tokens', 'cache_write_input_tokens',
  'output_tokens', 'reasoning_output_tokens'];
const number = (v) => Number.isSafeInteger(v) && v >= 0;
const sum = (values) => values.every(number) ? values.reduce((a, b) => a + b, 0) : null;
const RUNTIME_PROVIDER = { claude: 'anthropic', codex: 'openai' };
const concreteEffort = (value) => Boolean(value) && !['unknown', 'unsupported'].includes(value);

function valuesOf(context, key) {
  const plural = `${key}s`;
  const values = [];
  if (context[key] !== undefined && context[key] !== null) values.push(context[key]);
  if (Array.isArray(context[plural])) values.push(...context[plural]);
  return [...new Set(values.filter((value) => value !== undefined && value !== null && value !== ''))];
}

function runtimeOf(record) {
  if (record && record.runtime) return record.runtime;
  if (record && record.provider === 'anthropic') return 'claude';
  if (record && record.provider === 'openai') return 'codex';
  // Older local fixtures used the runtime name in `provider`.
  if (record && (record.provider === 'claude' || record.provider === 'codex')) return record.provider;
  return null;
}

function sourceMatches(record, context) {
  if (!record.source) return true;
  return valuesOf(context, 'source').includes(record.source)
    || valuesOf(context, 'source').some((value) => path.resolve(value) === path.resolve(record.source));
}

function attributionShape(record, index) {
  const runtime = runtimeOf(record);
  if (!runtime || !RUNTIME_PROVIDER[runtime]) return { error: `attribution ${index} has an unknown runtime` };
  if (record.provider && record.provider !== RUNTIME_PROVIDER[runtime]
      && record.provider !== runtime) {
    return { error: `attribution ${index} provider does not match runtime ${runtime}` };
  }
  const kind = record.kind || 'ordinary';
  if (!['ordinary', 'advisor'].includes(kind)) return { error: `attribution ${index} has an unknown kind` };
  return { ...record, runtime, kind };
}

function attributionSignature(record) {
  return JSON.stringify([
    record.dispatch_id || null, record.ticket || null, record.role || null,
    record.model || null, record.effort || null, record.effort_applied || null,
    record.observed_model || null, record.observed_effort || null,
    record.backend || null, record.task_level || null,
  ]);
}

function attributionIndex(records, warn) {
  const latest = new Map();
  for (const [index, raw] of (Array.isArray(records) ? records : []).entries()) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      warn(`attribution ${index + 1} is not an object`);
      continue;
    }
    const value = attributionShape(raw, index + 1);
    if (value.error) { warn(value.error); continue; }
    const id = value.observation_id || JSON.stringify([
      value.dispatch_id || null, value.runtime, value.kind,
      value.source || null, value.session_id || null, value.request_id || null,
      value.message_id || null, value.pass_id || null,
    ]);
    const previous = latest.get(id);
    const revision = Number.isSafeInteger(value.revision) ? value.revision : 1;
    const previousRevision = previous && Number.isSafeInteger(previous.revision) ? previous.revision : 1;
    if (!previous || revision >= previousRevision) latest.set(id, { ...value, observation_id: id });
  }
  return [...latest.values()];
}

function findAttribution(context, records, warn) {
  if (!records.length) return null;
  const candidates = [];
  for (const record of records) {
    if (record.runtime !== context.runtime || record.kind !== context.kind) continue;
    if (!sourceMatches(record, context)) continue;
    // A pass-specific record cannot be safely applied to a response aggregate
    // because the transcript adapter does not expose a matching pass id.
    if (record.pass_id && !valuesOf(context, 'pass_id').includes(record.pass_id)) continue;
    let score = 0;
    let level = null;
    for (const [key, weight, name] of [
      ['message_id', 3, 'message'], ['request_id', 2, 'request'], ['session_id', 1, 'session'],
    ]) {
      const wanted = valuesOf(context, key);
      if (record[key] && wanted.includes(record[key]) && weight > score) {
        score = weight;
        level = name;
      }
    }
    if (score) candidates.push({ record, score, level });
  }
  if (!candidates.length) return null;
  const bestScore = Math.max(...candidates.map((candidate) => candidate.score));
  const best = candidates.filter((candidate) => candidate.score === bestScore);
  const signatures = new Set(best.map((candidate) => attributionSignature(candidate.record)));
  if (signatures.size > 1) {
    warn(`ambiguous ${context.runtime} ${context.kind} attribution at ${valuesOf(context, 'session_id').join(',') || 'unknown session'}`);
    return { status: 'ambiguous', level: best[0].level, record: null };
  }
  return { status: best[0].level === 'session' ? 'session' : 'exact', level: best[0].level, record: best[0].record };
}

function metadataFor(context, rawModel, rawEffort, match, warn) {
  const record = match && match.record;
  const attributedModel = record && record.observed_model ? record.observed_model : null;
  const attributedEffort = record && record.observed_effort ? record.observed_effort : null;
  if (rawModel && attributedModel && rawModel !== attributedModel) {
    warn(`${context.runtime} model mismatch for ${valuesOf(context, 'session_id').join(',') || 'unknown session'}: transcript=${rawModel}, attribution=${attributedModel}`);
  }
  if (rawEffort && attributedEffort && rawEffort !== attributedEffort) {
    warn(`${context.runtime} effort mismatch for ${valuesOf(context, 'session_id').join(',') || 'unknown session'}: transcript=${rawEffort}, attribution=${attributedEffort}`);
  }
  const model = rawModel || attributedModel || null;
  const observedEffort = rawEffort || attributedEffort || null;
  const modelSource = rawModel ? 'transcript' : attributedModel ? 'attribution' : 'unknown';
  const effortSource = rawEffort ? 'transcript' : attributedEffort ? 'attribution' : 'unknown';
  const mismatch = (rawModel && attributedModel && rawModel !== attributedModel)
    || (rawEffort && attributedEffort && rawEffort !== attributedEffort);
  const status = match ? (match.status === 'exact' || match.status === 'session'
    ? (mismatch ? 'mismatch' : match.status)
    : match.status) : 'unattributed';
  return {
    source: valuesOf(context, 'source')[0] || null,
    runtime: context.runtime,
    provider_family: RUNTIME_PROVIDER[context.runtime],
    session_id: valuesOf(context, 'session_id')[0] || null,
    request_id: valuesOf(context, 'request_id')[0] || null,
    message_id: valuesOf(context, 'message_id')[0] || null,
    dispatch_id: record?.dispatch_id || null,
    project_id: record?.project_id || null,
    run_id: record?.run_id || null,
    ticket: record?.ticket || null,
    role: record?.role || null,
    task_level: record?.task_level || null,
    backend: record?.backend || null,
    requested_model: record?.model || null,
    requested_effort: record?.effort || null,
    effort_applied: record?.effort_applied || null,
    observed_effort: observedEffort,
    effort_source: effortSource,
    model,
    observed_model: model,
    model_source: modelSource,
    attribution_status: status,
    attribution_level: match?.level || null,
    completion_status: record?.completion_status || null,
  };
}

function report(sources, options = {}) {
  const warnings = [], requests = new Map(), sessions = new Map(), codexTurnMetadata = new Map(), observations = [];
  const attributionRecords = attributionIndex(options.attributions || [], (message) => warnings.push(message));
  const attributionEnabled = options.attributions !== undefined;
  let usageRows = 0;
  const warn = (s) => warnings.push(s);
  function mergeUsage(dest, src, fields, label) {
    for (const f of fields) {
      if (src[f] === undefined || src[f] === null) continue;
      if (!number(src[f])) { warn(`${label}: invalid ${f}`); continue; }
      dest[f] = Math.max(dest[f] ?? 0, src[f]);
    }
  }
  for (const source of sources) {
    let session = null;
    // Recent Codex transcripts contain both the legacy event_msg snapshot and
    // the newer token_usage_record for the same response. They expose related
    // but different cumulative views, so combining them makes counters appear
    // to go backwards. Prefer the thread-level records for that source and
    // retain the legacy adapter for older files that have no current records.
    const hasCurrentCodexUsage = source.rows.some((row) =>
      row?.type === 'token_usage_record' && row.payload?.thread_token_usage);
    const sourceName = source.source || null;
    for (const row of source.rows) {
      if (!row || typeof row !== 'object') continue;
      if (row.type === 'session_meta') session = row.payload?.id || row.payload?.session_id || null;
      if (row.type === 'turn_context' && row.payload?.turn_id) {
        codexTurnMetadata.set(row.payload.turn_id, {
          model: row.payload.model || null,
          effort: row.payload.effort || null,
        });
      }
      const msg = row.message;
      if (row.type === 'assistant' && msg?.usage != null && msg.model !== '<synthetic>') {
        usageRows++;
        if (typeof msg.usage !== 'object' || Array.isArray(msg.usage)) { warn('Claude usage object is malformed'); continue; }
        const key = msg.id ? JSON.stringify(['message', msg.id]) : row.uuid ? JSON.stringify(['uuid', row.uuid]) : null;
        if (!key) { warn('Claude usage without stable identity was skipped'); continue; }
        let q = requests.get(key);
        if (!q) {
          q = {
            model: msg.model || null, usage: {}, iterations: [], complete: false,
            efforts: new Set(), sources: new Set(), sessionIds: new Set(), requestIds: new Set(), messageIds: new Set(),
          };
          requests.set(key, q);
        }
        const rowSession = row.sessionId || row.session_id || session;
        if (sourceName) q.sources.add(sourceName);
        if (rowSession) q.sessionIds.add(rowSession);
        if (row.requestId || row.request_id) q.requestIds.add(row.requestId || row.request_id);
        if (msg.id) q.messageIds.add(msg.id);
        if (row.effort) q.efforts.add(row.effort);
        if (!q.model && msg.model) q.model = msg.model;
        if (q.model && msg.model && q.model !== msg.model) warn('Claude response changed model identity');
        mergeUsage(q.usage, msg.usage, FIELDS, 'Claude');
        q.complete ||= Boolean(msg.stop_reason);
        const iterations = msg.usage.iterations;
        if (iterations !== undefined && !Array.isArray(iterations)) warn('Claude iterations is not an array');
        if (Array.isArray(iterations)) iterations.forEach((it, i) => {
          if (!it || !['message', 'advisor_message'].includes(it.type)) {
            warn('Unknown Claude iteration type'); return;
          }
          const dest = q.iterations[i] ||= { type: it.type, model: it.model || null, usage: {} };
          if (dest.type !== it.type) warn('Claude iteration changed type');
          if (!dest.model && it.model) dest.model = it.model;
          mergeUsage(dest.usage, it, FIELDS, 'Claude iteration');
        });
      } else if (
        (row.type === 'event_msg' && row.payload?.type === 'token_count')
        || row.type === 'token_usage_record'
      ) {
        if (row.type === 'event_msg' && hasCurrentCodexUsage) continue;
        // The current record carries per-response `usage`, per-turn totals and
        // a thread-level cumulative total. Only the thread-level total is safe
        // for a session aggregate; the per-response value is retained below for
        // model/effort attribution and is never treated as a lifetime counter.
        const payload = row.payload || {};
        const u = row.type === 'token_usage_record'
          ? (payload.thread_token_usage || payload.total_token_usage)
          : payload.info?.total_token_usage;
        if (!u) continue;
        usageRows++;
        if (row.type === 'token_usage_record' && !payload.thread_token_usage && !payload.total_token_usage) {
          warn('Codex token usage record has no cumulative thread usage; skipped'); continue;
        }
        if (payload.session_id) session = payload.session_id;
        if (typeof u !== 'object' || Array.isArray(u)) { warn('Codex usage object is malformed'); continue; }
        if (!session) { warn('Codex cumulative usage without session identity was skipped'); continue; }
        if (!row.timestamp || !Number.isFinite(Date.parse(row.timestamp))) {
          warn('Codex cumulative usage without valid timestamp was skipped'); continue;
        }
        const values = {};
        mergeUsage(values, u, CODEX_FIELDS, 'Codex');
        const current = sessions.get(session) || {
          entries: [], sources: new Set(), format: 'legacy', responses: new Map(), responseUsageComplete: true,
        };
        if (sourceName) current.sources.add(sourceName);
        if (row.type === 'token_usage_record' && payload.thread_token_usage) {
          current.format = 'current';
          const responseId = payload.response_id;
          const responseUsage = payload.usage;
          if (!responseId || typeof responseUsage !== 'object' || Array.isArray(responseUsage)) {
            current.responseUsageComplete = false;
            if (!responseId) warn('Codex current usage record has no response identity');
            if (responseUsage !== undefined && (typeof responseUsage !== 'object' || Array.isArray(responseUsage))) {
              warn('Codex response usage object is malformed');
            }
          } else {
            const response = current.responses.get(responseId) || {
              at: row.timestamp, response_id: responseId, turn_id: payload.turn_id || null, values: {},
            };
            response.at = response.at && Date.parse(response.at) >= Date.parse(row.timestamp) ? response.at : row.timestamp;
            response.turn_id ||= payload.turn_id || null;
            mergeUsage(response.values, responseUsage, CODEX_FIELDS, 'Codex response');
            current.responses.set(responseId, response);
          }
        }
        current.entries.push({ at: row.timestamp, values });
        sessions.set(session, current);
      }
    }
  }

  function claudeContext(q, kind) {
    return {
      runtime: 'claude', kind,
      sources: [...q.sources], session_ids: [...q.sessionIds],
      request_ids: [...q.requestIds], message_ids: [...q.messageIds],
    };
  }

  const one = (values) => values.size === 1 ? [...values][0] : null;

  const codexTotals = (usage) => {
    const input = usage.input_tokens;
    const read = usage.cached_input_tokens;
    const write = usage.cache_write_input_tokens;
    return {
      input_tokens: number(input) ? input : null,
      uncached_input_tokens: number(input) && number(read) && write === 0 && read <= input
        ? input - read : null,
      cache_read_input_tokens: number(read) ? read : null,
      cache_creation_input_tokens: number(write) ? write : null,
      output_tokens: number(usage.output_tokens) ? usage.output_tokens : null,
      reasoning_output_tokens: number(usage.reasoning_output_tokens) ? usage.reasoning_output_tokens : null,
    };
  };

  function addObservation(context, usage, rawModel, rawEffort, unit, finalized, fallbackCompletion, totals = null) {
    const match = findAttribution(context, attributionRecords, warn);
    const metadata = metadataFor(context, rawModel, rawEffort, match, warn);
    observations.push({
      provider: context.runtime,
      kind: context.kind,
      unit,
      finalized,
      ...metadata,
      completion_status: metadata.completion_status || fallbackCompletion || 'unknown',
      input_tokens: totals?.input_tokens ?? sum(FIELDS.slice(0, 3).map(f => usage[f])),
      uncached_input_tokens: totals?.uncached_input_tokens ?? usage.input_tokens ?? null,
      cache_read_input_tokens: totals?.cache_read_input_tokens ?? usage.cache_read_input_tokens ?? null,
      cache_creation_input_tokens: totals?.cache_creation_input_tokens ?? usage.cache_creation_input_tokens ?? null,
      output_tokens: totals?.output_tokens ?? usage.output_tokens ?? null,
      reasoning_output_tokens: totals?.reasoning_output_tokens ?? null,
    });
  }

  function codexCumulative(current) {
    // A resumed file can replay a partial update at the same timestamp. Merge
    // those snapshots before checking monotonicity or taking the final total.
    const byTime = new Map();
    for (const { at, values } of current.entries) {
      const key = Date.parse(at), merged = byTime.get(key) || {};
      for (const [f, v] of Object.entries(values)) merged[f] = Math.max(merged[f] ?? 0, v);
      byTime.set(key, merged);
    }
    let prior = {}, invalid = false;
    for (const [, values] of [...byTime].sort((a, b) => a[0] - b[0])) {
      for (const [f, v] of Object.entries(values)) {
        if (number(prior[f]) && v < prior[f]) invalid = true;
        prior[f] = v;
      }
    }
    const ordered = [...byTime].sort((a, b) => a[0] - b[0]);
    return { latest: ordered.at(-1)?.[1] || {}, invalid };
  }

  for (const q of requests.values()) {
    if (q.iterations.length) {
      const iterations = q.iterations.filter(Boolean);
      const ordinary = iterations.filter(it => it.type === 'message');
      const reconciled = ordinary.length > 0 && FIELDS.every(f =>
        !number(q.usage[f]) || sum(ordinary.map(it => it.usage[f])) === q.usage[f]);
      if (!reconciled) {
        warn('Claude ordinary iterations do not reconcile; retaining response aggregate with unknown pass attribution');
        addObservation({ ...claudeContext(q, 'ordinary') }, q.usage, q.model, one(q.efforts), 'response_aggregate', q.complete,
          q.complete ? 'completed' : 'unknown');
      }
      for (const it of iterations) {
        if (it.type === 'advisor_message') {
          addObservation(claudeContext(q, 'advisor'), it.usage, it.model, one(q.efforts), 'model_pass', q.complete,
            q.complete ? 'completed' : 'unknown');
        } else if (reconciled) {
          addObservation(claudeContext(q, 'ordinary'), it.usage, it.model || q.model, one(q.efforts), 'model_pass', q.complete,
            q.complete ? 'completed' : 'unknown');
        }
      }
    } else {
      addObservation(claudeContext(q, 'ordinary'), q.usage, q.model, one(q.efforts), 'response_aggregate', q.complete,
        q.complete ? 'completed' : 'unknown');
    }
  }

  for (const [sessionId, current] of sessions.entries()) {
    const cumulative = codexCumulative(current);
    // The current Codex schema gives each response its own usage and the
    // turn_context row names the concrete model and effort. Summing those
    // response usages is safe only after it matches the final thread snapshot.
    // This keeps a session that moved from a reserve model to Luna split by the
    // model that actually consumed the tokens without hiding a partial log.
    const responseTotals = {};
    const normalizedResponses = new Map();
    let responseFieldsComplete = true;
    for (const response of current.responses.values()) {
      const values = { ...response.values };
      // Codex may omit a zero-valued component from a response while the
      // cumulative thread record makes that zero explicit. It is safe to fill
      // only that shape: nonnegative response components cannot sum to zero
      // unless every omitted component is zero.
      for (const field of CODEX_FIELDS) {
        if (values[field] === undefined && cumulative.latest[field] === 0) values[field] = 0;
      }
      normalizedResponses.set(response.response_id, values);
      for (const field of CODEX_FIELDS) {
        if (!number(values[field])) responseFieldsComplete = false;
        else responseTotals[field] = (responseTotals[field] || 0) + values[field];
      }
    }
    const responsesReconcile = CODEX_FIELDS.every((field) =>
      number(cumulative.latest[field]) && responseTotals[field] === cumulative.latest[field]);
    if (current.format === 'current' && current.responses.size && current.responseUsageComplete
        && responseFieldsComplete && !cumulative.invalid && responsesReconcile) {
      for (const response of [...current.responses.values()].sort((a, b) => Date.parse(a.at) - Date.parse(b.at))) {
        const turn = response.turn_id ? codexTurnMetadata.get(response.turn_id) : null;
        addObservation({
          runtime: 'codex', kind: 'ordinary', sources: [...current.sources],
          session_id: sessionId,
          request_ids: response.turn_id ? [response.turn_id] : [],
          message_ids: [response.response_id],
        }, normalizedResponses.get(response.response_id) || response.values,
        turn?.model || null, turn?.effort || null, 'model_pass', false, 'unknown',
        codexTotals(normalizedResponses.get(response.response_id) || response.values));
      }
      continue;
    }

    if (current.format === 'current') {
      const reason = !current.responseUsageComplete || !responseFieldsComplete
        ? 'incomplete response usage'
        : cumulative.invalid
          ? 'decreased cumulative counters'
          : 'response usage did not reconcile with cumulative thread usage';
      warn(`Codex current ${reason}; using the cumulative session total`);
    }
    const prior = cumulative.latest;
    let invalid = cumulative.invalid;
    if (invalid) warn('Codex cumulative counters decreased; session totals are unknown');
    const read = prior.cached_input_tokens, write = prior.cache_write_input_tokens;
    const input = prior.input_tokens;
    if (number(input) && number(read) && read > input) { invalid = true; warn('Codex cached input exceeds input'); }
    // Preserve cache writes without assuming they partition this schema's input.
    // The observed zero-write shape permits an uncached-input derivation.
    const uncached = number(input) && number(read) && write === 0 && read <= input
      ? input - read : null;
    addObservation({
      runtime: 'codex', kind: 'ordinary', sources: [...current.sources], session_id: sessionId,
    }, {
      input_tokens: null,
      cache_read_input_tokens: null,
      cache_creation_input_tokens: null,
      output_tokens: null,
    }, null, null, 'session_cumulative', false, 'unknown', {
      input_tokens: invalid ? null : input ?? null,
      uncached_input_tokens: invalid ? null : uncached,
      cache_read_input_tokens: invalid ? null : read ?? null,
      cache_creation_input_tokens: invalid ? null : write ?? null,
      output_tokens: invalid ? null : prior.output_tokens ?? null,
      reasoning_output_tokens: invalid ? null : prior.reasoning_output_tokens ?? null,
    });
  }

  const counters = ['input_tokens', 'uncached_input_tokens', 'cache_read_input_tokens',
    'cache_creation_input_tokens', 'output_tokens', 'reasoning_output_tokens'];
  const dimensions = ['provider', 'provider_family', 'runtime', 'kind', 'model', 'observed_effort',
    'requested_model', 'requested_effort', 'effort_applied', 'role', 'task_level', 'backend', 'unit'];
  const groups = new Map();
  for (const o of observations) {
    const key = JSON.stringify(dimensions.map((field) => o[field] ?? null));
    let g = groups.get(key);
    if (!g) {
      g = Object.fromEntries(dimensions.map((field) => [field, o[field] ?? null]));
      Object.assign(g, {
        observations: 0, finalized: 0, attributed: 0, model_sources: {}, effort_sources: {},
        attribution_statuses: {}, ticket_count: 0, dispatch_count: 0,
        ...Object.fromEntries(counters.map(f => [f, 0])), missing: {},
      });
      groups.set(key, g);
    }
    g.observations++;
    if (o.finalized) g.finalized++;
    if (o.attribution_status === 'exact' || o.attribution_status === 'session') g.attributed++;
    g.model_sources[o.model_source] = (g.model_sources[o.model_source] || 0) + 1;
    g.effort_sources[o.effort_source] = (g.effort_sources[o.effort_source] || 0) + 1;
    g.attribution_statuses[o.attribution_status] = (g.attribution_statuses[o.attribution_status] || 0) + 1;
    if (o.ticket) g.ticket_count++;
    if (o.dispatch_id) g.dispatch_count++;
    for (const f of counters) {
      if (o[f] === null) { g[f] = null; g.missing[f] = (g.missing[f] || 0) + 1; }
      else if (g[f] !== null) g[f] += o[f];
    }
  }

  const count = (predicate) => observations.filter(predicate).length;
  const ratio = (n) => observations.length ? Math.round((n / observations.length) * 10000) / 100 : null;
  const attributed = count((o) => o.attribution_status === 'exact' || o.attribution_status === 'session');
  const modelEffort = count((o) => (o.attribution_status === 'exact' || o.attribution_status === 'session')
    && o.model && concreteEffort(o.observed_effort) && o.dispatch_id);
  const ticketReady = count((o) => (o.attribution_status === 'exact' || o.attribution_status === 'session')
    && o.model && concreteEffort(o.observed_effort) && o.dispatch_id && o.ticket && o.input_tokens !== null);
  const efficiencyEligible = (o) => (o.attribution_status === 'exact' || o.attribution_status === 'session')
    && o.model && concreteEffort(o.observed_effort) && o.dispatch_id && o.ticket && o.input_tokens !== null;
  const efficiencyExclusionReasons = (o) => [
    ...(o.attribution_status !== 'exact' && o.attribution_status !== 'session'
      ? [`attribution_${o.attribution_status}`] : []),
    ...(!o.model ? ['missing_model'] : []),
    ...(!concreteEffort(o.observed_effort) ? ['missing_or_nonconcrete_effort'] : []),
    ...(!o.dispatch_id ? ['missing_dispatch_id'] : []),
    ...(!o.ticket ? ['missing_ticket'] : []),
    ...(o.input_tokens === null ? ['missing_input_tokens'] : []),
  ];
  const finalizedOutput = count((o) => o.finalized && o.output_tokens !== null);
  const statusCounts = Object.fromEntries(
    [...new Set(observations.map((o) => o.attribution_status))].sort()
      .map((status) => [status, count((o) => o.attribution_status === status)])
  );
  const efficiencyRows = [...new Map(observations
    .filter((o) => o.ticket && o.dispatch_id)
    .map((o) => [JSON.stringify([o.ticket, o.dispatch_id, o.kind, o.model, o.observed_effort,
      o.role, o.task_level, o.unit]), o])
  ).values()].map((seed) => {
    const same = observations.filter((o) => o.ticket === seed.ticket && o.dispatch_id === seed.dispatch_id
      && o.kind === seed.kind && o.model === seed.model && o.observed_effort === seed.observed_effort
      && o.role === seed.role && o.task_level === seed.task_level && o.unit === seed.unit);
    const row = {
      ticket: seed.ticket, dispatch_id: seed.dispatch_id, provider: seed.provider,
      runtime: seed.runtime, kind: seed.kind, model: seed.model,
      observed_effort: seed.observed_effort, role: seed.role, task_level: seed.task_level,
      observations: same.length,
      eligible: same.every(efficiencyEligible),
      exclusion_reasons: [...new Set(same.flatMap(efficiencyExclusionReasons))].sort(),
      attribution_statuses: Object.fromEntries(
        [...new Set(same.map((o) => o.attribution_status))].sort()
          .map((status) => [status, same.filter((o) => o.attribution_status === status).length])
      ),
    };
    for (const field of counters) row[field] = same.every((o) => o[field] !== null)
      ? same.reduce((total, o) => total + o[field], 0) : null;
    return row;
  });

  if (!usageRows || !observations.length) warn('No attributable supported usage observations');
  if ([...groups.values()].some(g => g.input_tokens === null)) warn('Input coverage is incomplete; totals are not comparable');
  const uniqueWarnings = [...new Set(warnings)];
  return {
    schema_version: 2,
    units: 'tokens processed; not subscription quota',
    subscription_usage: null,
    usage_rows: usageRows,
    comparison_scope: 'provider-normalized processing units; model/effort comparison only for attributed observations; not subscription billing',
    comparable: uniqueWarnings.length === 0,
    warnings: uniqueWarnings,
    groups: [...groups.values()],
    observations,
    efficiency: {
      comparison_ready: observations.length > 0 && modelEffort === observations.length,
      eligible_model_effort_observations: modelEffort,
      eligible_ticket_observations: ticketReady,
      eligible_rows: efficiencyRows.filter((row) => row.eligible).length,
      ineligible_rows: efficiencyRows.filter((row) => !row.eligible).length,
      input_per_verified_completion: null,
      rows: efficiencyRows,
      limitation: 'verified completion must be joined from delivery outcomes; no completion is inferred from a transcript stop marker',
    },
    coverage: {
      claude_responses: requests.size,
      codex_sessions: sessions.size,
      usage_observations: observations.length,
      attribution_records: attributionEnabled ? attributionRecords.length : null,
      attribution_status: statusCounts,
      attributed_observations: attributed,
      unattributed_observations: count((o) => o.attribution_status === 'unattributed'),
      ambiguous_observations: count((o) => o.attribution_status === 'ambiguous'),
      model_observed: count((o) => Boolean(o.model)),
      effort_observed: count((o) => concreteEffort(o.observed_effort)),
      dispatch_attributed: count((o) => Boolean(o.dispatch_id)),
      ticket_attributed: count((o) => Boolean(o.ticket)),
      finalized_output: finalizedOutput,
      attribution_rate_percent: ratio(attributed),
      model_effort_rate_percent: ratio(modelEffort),
      ticket_efficiency_rate_percent: ratio(ticketReady),
      finalized_output_rate_percent: ratio(finalizedOutput),
    },
    limitations: [
      'Missing counters are unknown; finalized Claude output requires a stop marker.',
      'Codex totals are cumulative session observations, not request counts; model/effort come from turn_context when present and otherwise stay unknown until the attribution ledger links a session.',
      'Full-file rescans incorporate earlier partial updates. No billing or account attribution is inferred.',
      'Claude and Codex records are kept in separate runtime/provider groups; a provider mismatch is a coverage error.',
    ],
  };
}

function parseCli(args) {
  const transcripts = [], attribution = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--attribution') {
      const value = args[++i];
      if (!value || value.startsWith('--')) throw new Error('--attribution needs a JSONL ledger path');
      attribution.push(value);
    } else if (arg.startsWith('--')) {
      throw new Error(`unsupported option ${arg}; see --help`);
    } else transcripts.push(arg);
  }
  return { transcripts, attribution };
}

function readJsonl(file, malformed, label) {
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  return lines.flatMap((line, index) => {
    if (!line.trim()) return [];
    try { return [JSON.parse(line)]; }
    catch (error) {
      malformed.push(`${path.basename(file)}:${index + 1}: malformed ${label} JSON (${error.message})`);
      return [];
    }
  });
}

function main(args) {
  if (args.length === 1 && args[0] === '--help') {
    console.log('usage: node usage-report.cjs <transcript.jsonl> [more.jsonl ...] [--attribution ledger.jsonl]');
    console.log('Read-only; explicit transcript and attribution files only. JSON to stdout; no prompts or quota estimates.');
    return;
  }
  const parsed = parseCli(args);
  if (!parsed.transcripts.length) throw new Error('Expected at least one explicit transcript JSONL path; see --help');
  const malformed = [];
  const sources = [...new Set(parsed.transcripts.map((file) => fs.realpathSync(file)))].map((file) => ({
    source: file,
    rows: readJsonl(file, malformed, 'transcript'),
  }));
  const attributions = parsed.attribution.length
    ? [...new Set(parsed.attribution.map((file) => fs.realpathSync(file)))].flatMap((file) => readJsonl(file, malformed, 'attribution'))
    : undefined;
  const result = report(sources, { ...(attributions === undefined ? {} : { attributions }) });
  result.warnings.push(...malformed);
  result.warnings = [...new Set(result.warnings)];
  if (malformed.length) result.comparable = false;
  console.log(JSON.stringify(result, null, 2));
  if (!result.comparable) process.exitCode = 1;
}

if (require.main === module) {
  try { main(process.argv.slice(2)); }
  catch (e) { console.error(`usage-report: ${e.message}`); process.exitCode = 2; }
}

module.exports = { report, findAttribution, attributionIndex };
