#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
[[ "${1:-}" == "--capability-only" && $# -eq 1 ]] || {
  echo "usage: claude-runtime-smoke.sh --capability-only" >&2
  exit 2
}

probe="$(node "$ROOT/plugins/delivery-pipeline/scripts/claude-runtime-host.cjs" --capability-only)"
node - "$probe" <<'NODE'
'use strict';
const result = JSON.parse(process.argv[2]);
if (result.schema !== 'shipyard.claude-runtime-probe.v1' || result.version !== 1) {
  throw new Error('invalid Claude runtime probe schema');
}
if (result.status === 'available') {
  if (typeof result.runtime_version !== 'string' || !result.runtime_version) throw new Error('available probe lacks runtime version');
  if (!result.capabilities || !result.capabilities.supportedModels.includes('sonnet')) throw new Error('available probe lacks Claude model capability');
  if (!result.capabilities.supportedEfforts.includes('max')) throw new Error('available probe lacks effort capability');
  console.log(JSON.stringify({ status: 'available', runtime_version: result.runtime_version }));
} else if (result.status === 'unavailable') {
  if (typeof result.reason !== 'string' || !result.reason) throw new Error('unavailable probe lacks a machine reason');
  if (Object.prototype.hasOwnProperty.call(result, 'receipt')) throw new Error('unavailable probe fabricated a receipt');
  console.error(JSON.stringify({ status: 'unavailable', reason: result.reason }));
} else {
  throw new Error(`unknown Claude probe status ${JSON.stringify(result.status)}`);
}
NODE
