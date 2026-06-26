#!/usr/bin/env bash
set -euo pipefail

PLUGIN_DIR="${1:-/opt/karpathy-skills}"

cd "$PLUGIN_DIR"
copilot plugin marketplace add "$PLUGIN_DIR"
copilot plugin install andrej-karpathy-skills@karpathy-skills
