#!/usr/bin/env bash
set -euo pipefail

# Unit tests for the deterministic layer. No Docker, no network, no node_modules —
# this is the suite you can run on every edit.

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

command -v node >/dev/null 2>&1 || { echo "node not found on PATH"; exit 1; }

# Every .cjs in the deterministic layer must at least parse.
for f in plugins/delivery-pipeline/scripts/*.cjs capabilities/delivery-pipeline/checks/*.cjs scripts/*.cjs; do
  node --check "$f" || { echo "syntax error in $f"; exit 1; }
done
for f in plugins/delivery-pipeline/scripts/*.sh scripts/*.sh tests/smoke/*.sh tests/unit/*.sh; do
  bash -n "$f" || { echo "syntax error in $f"; exit 1; }
done

failed=0
for t in tests/unit/*.test.cjs; do
  echo "═══ $t"
  node "$t" || failed=1
done

if [[ "$failed" != 0 ]]; then
  echo
  echo "unit tests FAILED"
  exit 1
fi
echo
echo "unit tests passed"
