#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
CAPABILITY_ONLY=false

for arg in "$@"; do
  case "$arg" in
    --capability-only) CAPABILITY_ONLY=true ;;
    *) echo "runtime-control-plane-smoke: unknown argument: $arg" >&2; exit 2 ;;
  esac
done

set +e
payload="$(node "$ROOT/plugins/delivery-pipeline/scripts/run-rollout.cjs" probe --json --root "$ROOT" --capability-only)"
command_status=$?
set -e

node -e '
  const value = JSON.parse(process.argv[1]);
  if (value.schema !== "shipyard.autonomous-rollout.v1" || value.rollout_version !== "v1") process.exit(1);
  for (const runtime of ["claude", "codex"]) {
    if (!value.capabilities || !value.capabilities[runtime]) process.exit(1);
    if (!["available", "unavailable", "refused"].includes(value.capabilities[runtime].status)) process.exit(1);
  }
  if (value.launches_enabled && Object.values(value.capabilities).some((item) => item.status !== "available")) process.exit(1);
  if (JSON.stringify(value).match(/(?:api[_-]?key|token|secret|credential_value)/i)) process.exit(1);
' "$payload"

claude_status="$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).capabilities.claude.status)' "$payload")"
codex_status="$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).capabilities.codex.status)' "$payload")"
rollout_status="$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).status)' "$payload")"

printf 'runtime-control-plane smoke: rollout=%s claude=%s codex=%s command_exit=%s capability_only=%s\n' \
  "$rollout_status" "$claude_status" "$codex_status" "$command_status" "$CAPABILITY_ONLY"

if [[ "$rollout_status" == "enabled" ]]; then
  [[ "$claude_status" == "available" && "$codex_status" == "available" && "$command_status" == 0 ]]
  echo 'runtime-control-plane smoke passed'
  exit 0
fi

if [[ "$rollout_status" == "disabled" && "$claude_status" == "unavailable" && "$codex_status" == "unavailable" ]]; then
  echo 'runtime-control-plane smoke: rollout remains disabled until live capability evidence exists'
  exit 0
fi

echo 'runtime-control-plane smoke: non-green capability result requires review' >&2
exit 1
