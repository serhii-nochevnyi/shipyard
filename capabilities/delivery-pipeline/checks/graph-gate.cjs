#!/usr/bin/env node
'use strict';

// plan:post gate launcher. Delegates to the canonical ticket-graph validator
// (Gate 2 of the delivery conveyor). Exit 0 = pass, non-zero = block.
//
// Resolution order: a copy bundled next to this file at image-build time,
// then the baked Claude-plugin path. cwd is the project root (gate contract).

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const candidates = [
  path.join(__dirname, 'validate-graph.cjs'),
  '/opt/delivery-pipeline/scripts/validate-graph.cjs',
];
const target = candidates.find((f) => fs.existsSync(f));
if (!target) {
  console.error('graph-gate: validate-graph.cjs not found (checked bundled copy and /opt/delivery-pipeline)');
  process.exit(1);
}
const r = spawnSync(process.execPath, [target], { stdio: 'inherit' });
process.exit(r.status === null ? 1 : r.status);
