#!/usr/bin/env bash
set -euo pipefail

# Registers local plugin marketplaces and enables their plugins for Claude Code,
# non-interactively, at image build time. Runs as the `dev` user.

KARPATHY_DIR="${1:-/opt/karpathy-skills}"
LSP_DIR="${2:-/opt/claude-lsp}"

[[ -d "$KARPATHY_DIR" ]] || { echo "missing karpathy plugin dir: $KARPATHY_DIR"; exit 1; }
[[ -d "$LSP_DIR" ]] || { echo "missing lsp plugin dir: $LSP_DIR"; exit 1; }

timeout 120 claude plugin marketplace add "$KARPATHY_DIR" </dev/null || true
timeout 120 claude plugin marketplace add "$LSP_DIR" </dev/null || true

# Primary path: explicit install. Redirect stdin from /dev/null and bound with
# `timeout` so an interactive prompt fails fast (no TTY at build time) and falls
# through to the settings.json path below instead of HANGING the docker build.
timeout 120 claude plugin install andrej-karpathy-skills@karpathy-skills </dev/null || true
timeout 120 claude plugin install dev-lsp@dev-lsp-marketplace </dev/null || true

# Belt-and-suspenders: ensure enablement is recorded in settings.json even if
# `plugin install` is interactive/no-ops at build time.
mkdir -p "$HOME/.claude"
settings="$HOME/.claude/settings.json"
[[ -f "$settings" ]] || echo '{}' > "$settings"
jq empty "$settings"
tmp="$(mktemp)"
jq '
  .enabledPlugins |= (. // {}) |
  .enabledPlugins["andrej-karpathy-skills@karpathy-skills"] = true |
  .enabledPlugins["dev-lsp@dev-lsp-marketplace"] = true
' "$settings" > "$tmp"
mv "$tmp" "$settings"
