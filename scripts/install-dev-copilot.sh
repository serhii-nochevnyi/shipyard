#!/usr/bin/env bash
set -euo pipefail

PLUGIN_DIR="${1:-/opt/dev-copilot}"

cd "$PLUGIN_DIR"

if [[ -n "${DEV_COPILOT_INSTALL_CMD:-}" ]]; then
  bash -lc "$DEV_COPILOT_INSTALL_CMD"
  exit 0
fi

copilot plugin marketplace add "$PLUGIN_DIR"
copilot plugin install dev-copilot@dev-copilot-marketplace
