'use strict';

const crypto = require('node:crypto');

const SCHEMA_VERSION = 'shipyard.review-signature.v1';
const UNKNOWN = 'unknown';

function text(value) {
  return String(value == null ? '' : value)
    .replace(/\u001b\[[0-9;?]*[ -\/]*[@-~]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function pathName(value) {
  const input = text(value).replaceAll('\\', '/');
  if (!input) return '';
  const parts = input.split('/').filter(Boolean);
  const anchors = new Set(['src', 'lib', 'pkg', 'internal', 'cmd', 'packages', 'plugins', 'scripts', 'tests', 'test']);
  const at = parts.findIndex((part) => anchors.has(part));
  return (at < 0 ? parts : parts.slice(at)).join('/');
}

function commentsOf(finding) {
  if (Array.isArray(finding && finding.comments)) return finding.comments.map(text).filter(Boolean);
  if (finding && finding.body) return [text(finding.body)];
  return [];
}

function ruleClass(finding) {
  const values = ['rule', 'rule_id', 'category', 'class', 'check', 'code', 'kind', 'name'];
  for (const key of values) {
    const value = text(finding && finding[key]);
    if (value) return { value: value.toLowerCase(), source: key };
  }
  const body = commentsOf(finding).join(' ');
  const marked = /(?:^|[\s[(])(?:rule|check|category|class|code)\s*[:=]\s*([A-Za-z0-9_.:/-]+)/i.exec(body);
  if (marked) return { value: marked[1].toLowerCase(), source: 'comment-marker' };
  const bracket = /^\[([^\]]+)\]/.exec(body);
  if (bracket && text(bracket[1])) return { value: text(bracket[1]).toLowerCase(), source: 'comment-marker' };
  return { value: '', source: 'unknown' };
}

function locationOf(finding) {
  const pathValue = pathName(finding && (finding.path || finding.file || finding.filename));
  const candidates = [finding && finding.line, finding && finding.original_line, finding && finding.originalLine,
    finding && finding.start_line, finding && finding.startLine, finding && finding.position];
  const line = candidates.find((value) => Number.isInteger(value) && value > 0);
  if (!pathValue || !line) return null;
  return { path: pathValue, line };
}

function findingIdentity(finding) {
  const location = locationOf(finding);
  const category = ruleClass(finding);
  if (!location || !category.value) {
    return {
      schema_version: SCHEMA_VERSION,
      known: false,
      signature: null,
      reason: !location ? 'missing-path-or-location' : 'missing-rule-or-class',
      provenance: {
        thread_id: text(finding && (finding.id || finding.thread_id)) || null,
        url: text(finding && finding.url) || null,
      },
    };
  }
  const identity = {
    rule_class: category.value,
    rule_source: category.source,
    path: location.path,
    line: location.line,
  };
  const digest = crypto.createHash('sha256')
    .update(`${identity.rule_class}\n${identity.path}\n${identity.line}`)
    .digest('hex');
  return {
    schema_version: SCHEMA_VERSION,
    known: true,
    signature: `review-${digest.slice(0, 24)}`,
    identity,
    provenance: {
      thread_id: text(finding && (finding.id || finding.thread_id)) || null,
      url: text(finding && finding.url) || null,
    },
  };
}

function decorate(finding) {
  const identity = findingIdentity(finding);
  return {
    ...finding,
    finding_signature: identity.signature,
    finding_identity: identity.known ? identity.identity : null,
    finding_known: identity.known,
  };
}

function snapshot(findings = []) {
  const rows = Array.isArray(findings) ? findings.map(decorate) : [];
  const known = rows.filter((row) => row.finding_known && row.finding_signature);
  const unknown = rows.filter((row) => !row.finding_known);
  const signatures = [...new Set(known.map((row) => row.finding_signature))].sort();
  return {
    schema_version: SCHEMA_VERSION,
    signatures,
    findings: rows,
    coverage: {
      total: rows.length,
      known: known.length,
      unknown: unknown.length,
      complete: unknown.length === 0,
    },
    digest: crypto.createHash('sha256').update(JSON.stringify(signatures)).digest('hex'),
  };
}

function compare(previous, current) {
  const before = new Set(previous && Array.isArray(previous.signatures) ? previous.signatures : []);
  const after = new Set(current && Array.isArray(current.signatures) ? current.signatures : []);
  return {
    added: [...after].filter((value) => !before.has(value)).sort(),
    resolved: [...before].filter((value) => !after.has(value)).sort(),
    unchanged: [...after].filter((value) => before.has(value)).sort(),
    unknown: current && current.coverage ? current.coverage.unknown : null,
  };
}

function progress(history = [], current) {
  const previous = history.length ? history[history.length - 1] : null;
  const delta = compare(previous, current);
  const priorDigests = history.slice(0, -1).map((item) => item && item.digest).filter(Boolean);
  const oscillating = Boolean(current && current.digest && priorDigests.includes(current.digest)
    && previous && current.digest !== previous.digest);
  let state = 'first';
  if (current && current.coverage && current.coverage.unknown > 0) state = UNKNOWN;
  else if (!previous) state = 'first';
  else if (delta.resolved.length) state = 'progress';
  else if (oscillating) state = 'oscillating';
  else if (delta.added.length) state = 'new-finding';
  else state = 'unchanged';
  return {
    schema_version: SCHEMA_VERSION,
    state,
    progress: state === 'progress',
    oscillating,
    delta,
    evidence: {
      previous_digest: previous ? previous.digest || null : null,
      current_digest: current ? current.digest || null : null,
      history_depth: history.length,
    },
  };
}

module.exports = Object.freeze({
  SCHEMA_VERSION,
  UNKNOWN,
  pathName,
  ruleClass,
  locationOf,
  findingIdentity,
  decorate,
  snapshot,
  compare,
  progress,
});
