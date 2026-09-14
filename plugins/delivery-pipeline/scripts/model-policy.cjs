#!/usr/bin/env node
'use strict';

// Public policy entrypoint. Boundary-only receipt provenance lives in the
// internal policy module and is deliberately not reachable through this API.

const canonicalPolicy = require('./model-policy-internal.cjs');

function repairInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const signals = input.signals;
  if (!signals || typeof signals !== 'object' || Array.isArray(signals)) return null;
  const runtime = typeof input.runtime === 'string' ? input.runtime.trim() : input.runtime;
  const role = typeof input.role === 'string' ? input.role.trim() : input.role;
  const prerequisites = canonicalPolicy.RUNTIME_REPAIR_PREREQUISITES[runtime];
  return prerequisites && prerequisites[role]
    && prerequisites[role][signals.signatureState]
    ? { role, signatureState: signals.signatureState }
    : null;
}

function resolveDispatch(input) {
  if (arguments.length > 1) {
    throw canonicalPolicy.policyError(
      'UNVERIFIED_RECEIPT',
      'receipt verification options are private to the canonical dispatch boundary',
    );
  }
  const repair = repairInput(input);
  if (repair) {
    const hasPrior = input.signals && Object.prototype.hasOwnProperty.call(input.signals, 'priorApplied')
      || Object.prototype.hasOwnProperty.call(input, 'priorApplied')
      || Object.prototype.hasOwnProperty.call(input, 'priorReceipt');
    throw canonicalPolicy.policyError(
      hasPrior ? 'UNVERIFIED_RECEIPT' : 'MISSING_RECEIPT',
      hasPrior
        ? `${repair.role} ${repair.signatureState} escalation requires a receipt verified by the routed dispatch boundary`
        : `${repair.role} ${repair.signatureState} escalation requires the immediately preceding compliant applied receipt`,
      repair,
    );
  }
  return canonicalPolicy.resolveDispatch(input);
}

module.exports = Object.freeze({
  ...canonicalPolicy,
  resolveDispatch,
});

if (require.main === module) {
  try {
    const command = process.argv[2];
    if (command === 'fingerprint') {
      process.stdout.write(JSON.stringify({
        policy_version: canonicalPolicy.POLICY_VERSION,
        policy_hash: canonicalPolicy.POLICY_HASH,
      }) + '\n');
    } else if (command === 'resolve') {
      const raw = process.argv[3];
      const input = raw
        ? JSON.parse(raw)
        : JSON.parse(require('fs').readFileSync(0, 'utf8'));
      process.stdout.write(JSON.stringify(resolveDispatch(input)) + '\n');
    } else {
      throw canonicalPolicy.policyError('USAGE', 'usage: model-policy.cjs fingerprint | resolve <json>');
    }
  } catch (error) {
    process.stderr.write('model-policy: ' + error.message + '\n');
    process.exitCode = error.exitCode || 1;
  }
}
