#!/usr/bin/env node
'use strict';

// ship:pre gate: verification evidence must exist before shipping.
// Wraps the fail-closed first-party predicate `gsd-tools phase uat-passed`.
// Usage: uat-gate.cjs <phase-number>   (interpolated from ${PHASE_NUMBER})
// Exit 0 = pass, non-zero = block. No phase in context -> pass (nothing to gate).

const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');

const phase = (process.argv[2] || '').trim();
if (!phase) {
  console.log('uat-gate: no phase in gate context — skipping');
  process.exit(0);
}

const gsdTools = path.join(process.env.HOME || '', '.claude', 'gsd-core', 'bin', 'gsd-tools.cjs');
if (!fs.existsSync(gsdTools)) {
  console.error(`uat-gate: gsd-tools not found at ${gsdTools}`);
  process.exit(1); // fail closed: cannot verify => do not ship
}

const r = spawnSync(process.execPath, [gsdTools, 'phase', 'uat-passed', phase, '--raw'], {
  encoding: 'utf8',
});
if (r.status !== 0) {
  console.error(`uat-gate: uat-passed exited ${r.status}: ${(r.stderr || '').trim()}`);
  process.exit(1);
}
let verdict;
try {
  verdict = JSON.parse(r.stdout);
} catch {
  console.error('uat-gate: unparseable uat-passed output');
  process.exit(1);
}
if (verdict.passed === true) {
  console.log(`uat-gate: phase ${phase} verification evidence OK`);
  process.exit(0);
}
const why = verdict.no_uat_artifacts
  ? 'no UAT artifacts — run /gsd-verify-work first'
  : `blockers: ${JSON.stringify(verdict.blockers || [])}`;
console.error(`uat-gate: phase ${phase} NOT verified (${why})`);
process.exit(1);
