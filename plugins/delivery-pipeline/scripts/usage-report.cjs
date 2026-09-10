#!/usr/bin/env node
'use strict';
// Read-only transcript accounting. All totals are processing units, never quota.
const fs = require('node:fs');
const path = require('node:path');
const FIELDS = ['input_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens', 'output_tokens'];
const number = (v) => Number.isSafeInteger(v) && v >= 0;
const sum = (values) => values.every(number) ? values.reduce((a, b) => a + b, 0) : null;

function report(sources) {
  const warnings = [], requests = new Map(), sessions = new Map(), observations = [];
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
    for (const row of source.rows) {
      if (!row || typeof row !== 'object') continue;
      if (row.type === 'session_meta') session = row.payload?.id || null;
      const msg = row.message;
      if (row.type === 'assistant' && msg?.usage && msg.model !== '<synthetic>') {
        usageRows++;
        const key = msg.id ? JSON.stringify([row.requestId || null, msg.id]) : row.uuid;
        if (!key) { warn('Claude usage without stable identity was skipped'); continue; }
        let q = requests.get(key);
        if (!q) {
          q = { model: msg.model || null, usage: {}, iterations: [], complete: false };
          requests.set(key, q);
        }
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
          mergeUsage(dest.usage, it, FIELDS, 'Claude iteration');
        });
      } else if (row.type === 'event_msg' && row.payload?.type === 'token_count') {
        const u = row.payload.info?.total_token_usage;
        if (!u) continue;
        usageRows++;
        if (!session) { warn('Codex cumulative usage without session identity was skipped'); continue; }
        if (!row.timestamp || !Number.isFinite(Date.parse(row.timestamp))) {
          warn('Codex cumulative usage without valid timestamp was skipped'); continue;
        }
        const values = {};
        mergeUsage(values, u, ['input_tokens', 'cached_input_tokens', 'cache_write_input_tokens',
          'output_tokens', 'reasoning_output_tokens'], 'Codex');
        const entries = sessions.get(session) || [];
        entries.push({ at: row.timestamp, values }); sessions.set(session, entries);
      }
    }
  }
  function claudeObservation(q, u, kind, model, unit = 'model_pass') {
    observations.push({ provider: 'claude', kind, model, unit, finalized: q.complete,
      input_tokens: sum(FIELDS.slice(0, 3).map(f => u[f])),
      uncached_input_tokens: u.input_tokens ?? null,
      cache_read_input_tokens: u.cache_read_input_tokens ?? null,
      cache_creation_input_tokens: u.cache_creation_input_tokens ?? null,
      output_tokens: u.output_tokens ?? null, reasoning_output_tokens: null });
  }
  for (const q of requests.values()) {
    if (q.iterations.length) {
      for (const it of q.iterations.filter(Boolean))
        claudeObservation(q, it.usage, it.type === 'advisor_message' ? 'advisor' : 'ordinary', it.type === 'advisor_message' ? it.model : (it.model || q.model));
    } else claudeObservation(q, q.usage, 'ordinary', q.model, 'response_aggregate');
  }
  for (const entries of sessions.values()) {
    // A resumed file can replay a partial update at the same timestamp.
    const byTime = new Map();
    for (const { at, values } of entries) {
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
    if (invalid) warn('Codex cumulative counters decreased; session totals are unknown');
    const read = prior.cached_input_tokens, write = prior.cache_write_input_tokens;
    const input = prior.input_tokens;
    if (number(input) && number(read) && read > input) { invalid = true; warn('Codex cached input exceeds input'); }
    // Preserve cache writes without assuming they partition this schema's input.
    // The observed zero-write shape permits an uncached-input derivation.
    const uncached = number(input) && number(read) && write === 0 && read <= input
      ? input - read : null;
    observations.push({ provider: 'codex', kind: 'ordinary', model: null, unit: 'session_cumulative',
      finalized: false, input_tokens: invalid ? null : input ?? null,
      uncached_input_tokens: invalid ? null : uncached,
      cache_read_input_tokens: invalid ? null : read ?? null,
      cache_creation_input_tokens: invalid ? null : write ?? null,
      output_tokens: invalid ? null : prior.output_tokens ?? null,
      reasoning_output_tokens: invalid ? null : prior.reasoning_output_tokens ?? null });
  }
  const groups = new Map();
  const counters = ['input_tokens', 'uncached_input_tokens', 'cache_read_input_tokens',
    'cache_creation_input_tokens', 'output_tokens', 'reasoning_output_tokens'];
  for (const o of observations) {
    const key = JSON.stringify([o.provider, o.kind, o.model, o.unit]);
    let g = groups.get(key);
    if (!g) {
      g = { provider:o.provider, kind:o.kind, model:o.model, unit:o.unit, observations:0, finalized:0,
        ...Object.fromEntries(counters.map(f => [f, 0])), missing:{} };
      groups.set(key, g);
    }
    g.observations++; if (o.finalized) g.finalized++;
    for (const f of counters) {
      if (o[f] === null) { g[f] = null; g.missing[f] = (g.missing[f] || 0) + 1; }
      else if (g[f] !== null) g[f] += o[f];
    }
  }
  if (!usageRows || !observations.length) warn('No attributable supported usage observations');
  if ([...groups.values()].some(g => g.input_tokens === null)) warn('Input coverage is incomplete; totals are not comparable');
  return { schema_version:1, units:'tokens processed; not subscription quota', subscription_usage:null,
    usage_rows:usageRows, comparison_scope:'raw input only; not finalized cost or subscription', comparable:warnings.length === 0, warnings:[...new Set(warnings)],
    groups:[...groups.values()], coverage:{claude_responses:requests.size,codex_sessions:sessions.size},
    limitations:['Missing counters are unknown; finalized Claude output requires a stop marker.',
      'Codex totals are cumulative session observations, not request counts; model attribution is unavailable.',
      'Full-file rescans incorporate earlier partial updates. No billing or account attribution is inferred.'] };
}

function main(args) {
  if (args.length === 1 && args[0] === '--help') {
    console.log('usage: node usage-report.cjs <transcript.jsonl> [more.jsonl ...]\nRead-only; explicit files only. JSON to stdout; no prompts or quota estimates.'); return;
  }
  if (!args.length || args.some(a => a.startsWith('--'))) throw new Error('Expected explicit JSONL file paths; see --help');
  const malformed = [];
  function* rows(file) {
    const { StringDecoder } = require('node:string_decoder');
    const decoder = new StringDecoder('utf8'), buffer = Buffer.alloc(65536);
    const fd = fs.openSync(file, 'r');
    let pending = '', lineNo = 0;
    function parse(line) {
      lineNo++;
      if (!line.trim()) return null;
      try { return JSON.parse(line); }
      catch { malformed.push(`${path.basename(file)}:${lineNo}: malformed JSON (possibly an incomplete active write)`); return null; }
    }
    try {
      let n;
      while ((n = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) {
        pending += decoder.write(buffer.subarray(0, n));
        let at;
        while ((at = pending.indexOf('\n')) !== -1) {
          const row = parse(pending.slice(0, at)); pending = pending.slice(at + 1);
          if (row !== null) yield row;
        }
      }
      pending += decoder.end();
      if (pending.length) { const row = parse(pending); if (row !== null) yield row; }
    } finally { fs.closeSync(fd); }
  }
  const sources = [...new Set(args.map(f => fs.realpathSync(f)))].map(file => ({source:file, rows:rows(file)}));
  const result = report(sources);
  result.warnings.push(...malformed); if (malformed.length) result.comparable = false;
  console.log(JSON.stringify(result, null, 2));
  if (!result.comparable) process.exitCode = 1;
}
if (require.main === module) {
  try { main(process.argv.slice(2)); }
  catch (e) { console.error(`usage-report: ${e.message}`); process.exitCode = 2; }
}
module.exports = { report };
