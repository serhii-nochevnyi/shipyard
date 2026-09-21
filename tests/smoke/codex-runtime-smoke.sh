#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
[[ "${1:-}" == "--capability-only" && $# -eq 1 ]] || {
  echo "usage: codex-runtime-smoke.sh --capability-only" >&2
  exit 2
}

probe="$(node "$ROOT/plugins/delivery-pipeline/scripts/codex-runtime-host.cjs" --capability-only)"
node - "$probe" <<'NODE'
'use strict';
const result = JSON.parse(process.argv[2]);
if (result.schema !== 'shipyard.codex-runtime-probe.v1' || result.version !== 1) {
  throw new Error('invalid Codex runtime probe schema');
}
if (result.status === 'available') {
  if (typeof result.runtime_version !== 'string' || !result.runtime_version) throw new Error('available probe lacks runtime version');
  if (!result.capabilities || !Array.isArray(result.capabilities.supportedModels)
      || !result.capabilities.supportedModels.length) throw new Error('available probe lacks Codex model capability');
  if (!Array.isArray(result.capabilities.supportedEfforts)
      || !result.capabilities.supportedEfforts.includes('max')) throw new Error('available probe lacks effort capability');
  console.log(JSON.stringify({ status: 'available', runtime_version: result.runtime_version }));
} else if (result.status === 'unavailable') {
  if (typeof result.reason !== 'string' || !result.reason) throw new Error('unavailable probe lacks a machine reason');
  if (Object.prototype.hasOwnProperty.call(result, 'receipt')) throw new Error('unavailable probe fabricated a receipt');
  console.log(JSON.stringify({ status: 'unavailable', reason: result.reason }));
} else {
  throw new Error('unknown Codex probe status ' + JSON.stringify(result.status));
}
NODE

node - "$ROOT" <<'NODE'
'use strict';
const path = require('node:path');
const host = require(path.join(process.argv[2], 'plugins/delivery-pipeline/scripts/codex-runtime-host.cjs'));
try {
  host.createCodexRuntimeHost({
    scope: {
      run_id: 'run-smoke',
      ticket: 'T-37-04',
      phase: 37,
      worktree: process.cwd(),
      runtime: 'claude',
      provider: 'anthropic',
    },
    probe: {
      status: 'available',
      runtime_version: 'fixture',
      capabilities: { supportedModels: ['gpt-5.6-luna'], supportedEfforts: ['max'] },
    },
    recorder: () => true,
  });
  throw new Error('cross-provider scope unexpectedly passed');
} catch (error) {
  if (error.code !== 'RUNTIME_PROVIDER_MISMATCH') throw error;
  console.log(JSON.stringify({ status: 'policy_refusal', code: error.code }));
}
NODE
