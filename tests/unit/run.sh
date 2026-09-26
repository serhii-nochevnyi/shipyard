#!/usr/bin/env bash
set -euo pipefail

# Unit tests for the deterministic layer. No network or node_modules; run this
# suite on every edit.

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

unset CLAUDE_PLUGIN_ROOT CLAUDE_CODE_ENTRYPOINT CODEX_SANDBOX CODEX_SANDBOX_NETWORK_DISABLED

command -v node >/dev/null 2>&1 || { echo "node not found on PATH"; exit 1; }

# Every .cjs in the deterministic layer must at least parse.
for f in plugins/delivery-pipeline/scripts/*.cjs capabilities/delivery-pipeline/checks/*.cjs scripts/*.cjs; do
  node --check "$f" || { echo "syntax error in $f"; exit 1; }
done
for f in plugins/delivery-pipeline/scripts/*.sh scripts/*.sh tests/smoke/*.sh tests/unit/*.sh; do
  bash -n "$f" || { echo "syntax error in $f"; exit 1; }
done

unit_git_home="$(mktemp -d "${TMPDIR:-/tmp}/shipyard-unit.XXXXXX")"
trap 'rm -rf "$unit_git_home"' EXIT
export GIT_CONFIG_GLOBAL="$unit_git_home/gitconfig"
export GIT_CONFIG_NOSYSTEM=1
git config --file "$GIT_CONFIG_GLOBAL" user.name 'Shipyard Unit Tests'
git config --file "$GIT_CONFIG_GLOBAL" user.email 'unit-tests@shipyard.invalid'
git config --file "$GIT_CONFIG_GLOBAL" commit.gpgsign false
git config --file "$GIT_CONFIG_GLOBAL" tag.gpgsign false
git config --file "$GIT_CONFIG_GLOBAL" init.defaultBranch main

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
