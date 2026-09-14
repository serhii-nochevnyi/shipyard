#!/usr/bin/env node
'use strict';

// One pure answer to the holding question from ADR-009 D3/D4:
//
//   status NAME is configured AND the tracker says the ticket is unassigned.
//
// This module deliberately knows nothing about Jira I/O, changelog, worklog,
// statusCategory, or the optional `fields`/`view` arguments of an MCP call. The
// caller hands it the two observations it already has; the small normalizers
// below accept the status/assignee shapes those observations use.

const VERDICTS = Object.freeze({
  ELIGIBLE: 'eligible',
  INELIGIBLE: 'ineligible',
  UNKNOWN: 'unknown',
});

const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value, key);

function trimmedString(value) {
  if (typeof value !== 'string') return null;
  const out = value.trim();
  return out || null;
}

/**
 * Read only a status NAME from a tracker response shape.
 *
 * `statusCategory` is intentionally not a fallback: a category is not the
 * configured status vocabulary. `fields.status` is accepted only to make a
 * direct issue response convenient; no request shape is selected here.
 */
function normalizeStatusName(value) {
  if (typeof value === 'string') return trimmedString(value);
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (hasOwn(value, 'name')) return trimmedString(value.name);
  if (hasOwn(value, 'status')) return normalizeStatusName(value.status);
  if (value.fields && typeof value.fields === 'object' && !Array.isArray(value.fields)) {
    return normalizeStatusName(value.fields.status);
  }
  return null;
}

const ASSIGNEE_KEYS = ['accountId', 'account_id', 'id', 'key', 'name', 'displayName'];

function assignedValue(value) {
  if (typeof value === 'string') return trimmedString(value);
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  for (const key of ASSIGNEE_KEYS) {
    const candidate = value[key];
    const normalized = typeof candidate === 'number' && Number.isFinite(candidate)
      ? String(candidate)
      : trimmedString(candidate);
    if (normalized) return normalized;
  }
  return null;
}

/**
 * Normalize the assignee observation without confusing an unreadable object
 * with an explicitly unassigned ticket. Jira's unassigned value is null;
 * undefined, empty strings, and objects with no identity stay unknown.
 */
function normalizeAssignee(value) {
  if (value === null) return { known: true, assigned: false, value: null };
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    if (hasOwn(value, 'assignee')) return normalizeAssignee(value.assignee);
    if (value.fields && typeof value.fields === 'object' && !Array.isArray(value.fields)
        && hasOwn(value.fields, 'assignee')) {
      return normalizeAssignee(value.fields.assignee);
    }
  }
  const identity = assignedValue(value);
  return identity
    ? { known: true, assigned: true, value: identity }
    : { known: false, assigned: false, value: null };
}

function fieldFromIssue(value, key) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  if (hasOwn(value, key)) return value[key];
  if (value.fields && typeof value.fields === 'object' && !Array.isArray(value.fields)
      && hasOwn(value.fields, key)) {
    return value.fields[key];
  }
  return undefined;
}

/**
 * Normalize the two observations. A complete issue response is accepted as a
 * convenience, while the evaluator's primary contract remains
 * `(status, assignee, configuredStatuses)`.
 */
function normalizeObservation(status, assignee) {
  const issueStatus = fieldFromIssue(status, 'status');
  const issueAssignee = fieldFromIssue(status, 'assignee');
  const rawStatus = issueStatus === undefined ? status : issueStatus;
  const rawAssignee = assignee === undefined && issueAssignee !== undefined
    ? issueAssignee
    : assignee;
  return {
    status: normalizeStatusName(rawStatus),
    assignee: normalizeAssignee(rawAssignee),
  };
}

function configuredStatusNames(value) {
  const raw = typeof value === 'string'
    ? value.split(',')
    : Array.isArray(value)
      ? value
      : value instanceof Set
        ? [...value]
        : [];
  const out = [];
  const seen = new Set();
  for (const item of raw) {
    const status = trimmedString(item);
    if (!status || seen.has(status)) continue;
    seen.add(status);
    out.push(status);
  }
  return out;
}

function verdictResult(verdict, eligible, status, assignee, reason) {
  return {
    verdict,
    eligible,
    status,
    assignee: assignee.value,
    reason,
  };
}

/**
 * Evaluate tracker eligibility using only the current status and assignee.
 *
 * `eligible` is tri-state (`true`, `false`, or `null` for unknown); `verdict`
 * remains the durable string consumers should branch on. The function has no
 * filesystem, network, clock, or mutable global dependency.
 */
function evaluateEligibility(status, assignee, configuredStatuses) {
  const observation = normalizeObservation(status, assignee);
  const allowed = configuredStatusNames(configuredStatuses);

  if (!allowed.length) {
    return verdictResult(
      VERDICTS.INELIGIBLE,
      false,
      observation.status,
      observation.assignee,
      'tracker eligibility is disabled because no status names are configured'
    );
  }
  if (!observation.status) {
    return verdictResult(
      VERDICTS.UNKNOWN,
      null,
      null,
      observation.assignee,
      'tracker status NAME is unknown; eligibility cannot be established'
    );
  }
  if (!observation.assignee.known) {
    return verdictResult(
      VERDICTS.UNKNOWN,
      null,
      observation.status,
      observation.assignee,
      `tracker assignee is unknown for status "${observation.status}"; eligibility cannot be established`
    );
  }

  const reasons = [];
  if (!allowed.includes(observation.status)) {
    reasons.push(`observed tracker status "${observation.status}" is not configured as eligible`);
  }
  if (observation.assignee.assigned) {
    reasons.push(`tracker assignee "${observation.assignee.value}" is present`);
  }
  if (reasons.length) {
    return verdictResult(
      VERDICTS.INELIGIBLE,
      false,
      observation.status,
      observation.assignee,
      reasons.join('; ')
    );
  }
  return verdictResult(
    VERDICTS.ELIGIBLE,
    true,
    observation.status,
    observation.assignee,
    `tracker status "${observation.status}" is configured and the ticket is unassigned`
  );
}

// `evaluate` is a short library-facing alias; the descriptive name remains the
// canonical one in docs and tests.
module.exports = {
  VERDICTS,
  normalizeStatusName,
  normalizeAssignee,
  normalizeObservation,
  configuredStatusNames,
  evaluateEligibility,
  evaluate: evaluateEligibility,
};
