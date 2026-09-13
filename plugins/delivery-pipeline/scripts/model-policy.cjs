#!/usr/bin/env node
'use strict';

// Public policy entrypoint. Boundary-only receipt provenance lives in the
// internal policy module and is deliberately not reachable through this API.

const canonicalPolicy = require('./model-policy-internal.cjs');

function resolveDispatch(input) {
  if (arguments.length > 1) {
    throw canonicalPolicy.policyError(
      'UNVERIFIED_RECEIPT',
      'receipt verification options are private to the canonical dispatch boundary',
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
