#!/usr/bin/env bash
set -euo pipefail

PLUGIN_DIR="${1:-/opt/karpathy-skills}"

cd "$PLUGIN_DIR"
timeout 120 claude plugin marketplace add "$PLUGIN_DIR" </dev/null || true
timeout 120 claude plugin install andrej-karpathy-skills@karpathy-skills </dev/null || true
