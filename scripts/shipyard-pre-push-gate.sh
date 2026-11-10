#!/usr/bin/env bash
set -euo pipefail

# @contract: Only Git pre-push argv/stdin supplies the pushed objects; tool JSON is not a push.
if (( $# < 2 )); then
  cat >/dev/null
  exit 0
fi
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
if [[ -n "${SHIPYARD_SCRIPTS:-}" ]]; then
  ADAPTER="$SHIPYARD_SCRIPTS/native-pre-push.cjs"
elif [[ -n "${SHIPYARD_PUBLISH_GATE:-}" ]]; then
  ADAPTER="$(dirname "$SHIPYARD_PUBLISH_GATE")/native-pre-push.cjs"
else
  ADAPTER="$SCRIPT_DIR/shipyard-stop-gate/native-pre-push.cjs"
  [[ -f "$ADAPTER" ]] || ADAPTER="$SCRIPT_DIR/../plugins/delivery-pipeline/scripts/native-pre-push.cjs"
fi
[[ -f "$ADAPTER" ]] || { echo "shipyard native pre-push adapter is unavailable" >&2; exit 2; }
exec node "$ADAPTER" "$@"
