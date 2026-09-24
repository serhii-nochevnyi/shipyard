#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
CAPABILITY_ONLY=true

for arg in "$@"; do
  case "$arg" in
    --capability-only) ;;
    *) echo "runtime-control-plane-smoke: unknown argument: $arg" >&2; exit 2 ;;
  esac
done

set +e
payload="$(node "$ROOT/plugins/delivery-pipeline/scripts/run-rollout.cjs" probe --json --root "$ROOT" --capability-only)"
command_status=$?
set -e

node -e '
  const value = JSON.parse(process.argv[1]);
  if (value.schema !== "shipyard.autonomous-rollout.v2" || value.rollout_version !== "v2") process.exit(1);
  if (!value.runtimes || !value.runtime_launches_enabled) process.exit(1);
  for (const runtime of ["claude", "codex"]) {
    const item = value.runtimes[runtime];
    if (!item || !value.capabilities || !value.capabilities[runtime]) process.exit(1);
    if (!["disabled", "enabled", "unavailable", "refused"].includes(item.status)) process.exit(1);
    if (!["available", "unavailable", "refused"].includes(item.credential_status.status)) process.exit(1);
    if (!["available", "unavailable", "refused"].includes(item.capability.status)) process.exit(1);
    if (item.launches_enabled !== (item.opted_in && item.capability.status === "available")) process.exit(1);
    if (value.runtime_launches_enabled[runtime] !== item.launches_enabled) process.exit(1);
  }
  if (value.launches_enabled !== Object.values(value.runtime_launches_enabled).some(Boolean)) process.exit(1);
  const forbidden = new Set(["stdout", "stderr", "raw", "token", "secret", "credential_value", "auth_output"]);
  const inspect = (item) => {
    if (!item || typeof item !== "object") return true;
    for (const [key, child] of Object.entries(item)) {
      if (forbidden.has(key.toLowerCase()) || !inspect(child)) return false;
    }
    return true;
  };
  if (!inspect(value)) process.exit(1);
' "$payload"

claude_status="$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).runtimes.claude.status)' "$payload")"
codex_status="$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).runtimes.codex.status)' "$payload")"
claude_credentials="$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).runtimes.claude.credential_status.status)' "$payload")"
codex_credentials="$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).runtimes.codex.credential_status.status)' "$payload")"
rollout_status="$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).status)' "$payload")"

printf 'runtime-control-plane smoke: rollout=%s claude=%s/%s codex=%s/%s command_exit=%s capability_only=%s\n' \
  "$rollout_status" "$claude_status" "$claude_credentials" "$codex_status" "$codex_credentials" "$command_status" "$CAPABILITY_ONLY"

if [[ "$rollout_status" == "disabled" ]]; then
  [[ "$claude_status" == "disabled" && "$codex_status" == "disabled" && "$command_status" == 0 ]]
  echo 'runtime-control-plane smoke: provider-specific rollouts remain opt-in'
  exit 0
fi

if [[ "$rollout_status" == "enabled" && "$command_status" == 0 ]]; then
  echo 'runtime-control-plane smoke passed'
  exit 0
fi

echo 'runtime-control-plane smoke: non-green capability result requires review' >&2
exit 1
