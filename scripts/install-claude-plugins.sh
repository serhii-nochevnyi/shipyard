#!/usr/bin/env bash
set -euo pipefail

# Registers plugin marketplaces (local and official) and installs their plugins
# for Claude Code, non-interactively, at image build time. Runs as the `dev` user.

KARPATHY_DIR="${1:-/opt/karpathy-skills}"

[[ -d "$KARPATHY_DIR" ]] || { echo "missing karpathy plugin dir: $KARPATHY_DIR"; exit 1; }

# Register the local karpathy marketplace.
timeout 120 claude plugin marketplace add "$KARPATHY_DIR" </dev/null || true

# Register the official marketplace (clones a large GitHub repo — may take a while).
timeout 600 claude plugin marketplace add anthropics/claude-plugins-official </dev/null || true

# Primary path: explicit install. Redirect stdin from /dev/null and bound with
# `timeout` so an interactive prompt fails fast (no TTY at build time) and falls
# through to the settings.json path below instead of HANGING the docker build.
# Plugins from the official marketplace are pinned by the marketplace's GitHub ref
# at clone time; no separate version pin is fabricated here.
timeout 300 claude plugin install andrej-karpathy-skills@karpathy-skills </dev/null || true
timeout 300 claude plugin install skill-creator@claude-plugins-official </dev/null || true
timeout 300 claude plugin install code-simplifier@claude-plugins-official </dev/null || true
timeout 300 claude plugin install github@claude-plugins-official </dev/null || true
timeout 300 claude plugin install typescript-lsp@claude-plugins-official </dev/null || true

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
  .enabledPlugins["skill-creator@claude-plugins-official"] = true |
  .enabledPlugins["code-simplifier@claude-plugins-official"] = true |
  .enabledPlugins["github@claude-plugins-official"] = true |
  .enabledPlugins["typescript-lsp@claude-plugins-official"] = true
' "$settings" > "$tmp"
mv "$tmp" "$settings"
