#!/usr/bin/env bash
set -euo pipefail

# Registers plugin marketplaces (local and official) and installs their plugins
# for Claude Code, non-interactively, at image build time. Runs as the `dev` user.

KARPATHY_DIR="${1:-/opt/karpathy-skills}"
DELIVERY_DIR="${2:-/opt/delivery-pipeline}"

[[ -d "$KARPATHY_DIR" ]] || { echo "missing karpathy plugin dir: $KARPATHY_DIR"; exit 1; }
[[ -d "$DELIVERY_DIR" ]] || { echo "missing delivery-pipeline plugin dir: $DELIVERY_DIR"; exit 1; }

# Run a plugin command non-interactively. `</dev/null` so an interactive prompt
# fails fast (no TTY at build time) instead of HANGING the docker build; `timeout`
# bounds slow clones. A failure/timeout is non-fatal (the settings.json write below
# is the fallback) but is surfaced as a WARNING rather than silently swallowed, so a
# `make build-dev-image` with no smoke afterwards still shows that a plugin is missing.
pg() {
  local t="$1"; shift
  timeout "$t" "$@" </dev/null || echo "WARNING: '$*' failed or timed out (exit $?)" >&2
}

# Register the local marketplaces (karpathy + in-repo delivery pipeline).
pg 120 claude plugin marketplace add "$KARPATHY_DIR"
pg 120 claude plugin marketplace add "$DELIVERY_DIR"

# Register the official marketplace (clones a large GitHub repo — may take a while).
pg 600 claude plugin marketplace add anthropics/claude-plugins-official

# Install all plugins. Plugins from the official marketplace are pinned by the
# marketplace's GitHub ref at clone time; no separate version pin is fabricated here.
pg 300 claude plugin install andrej-karpathy-skills@karpathy-skills
pg 300 claude plugin install pipeline@delivery-pipeline
pg 300 claude plugin install skill-creator@claude-plugins-official
pg 300 claude plugin install code-simplifier@claude-plugins-official
pg 300 claude plugin install github@claude-plugins-official
pg 300 claude plugin install typescript-lsp@claude-plugins-official

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
  .enabledPlugins["pipeline@delivery-pipeline"] = true |
  .enabledPlugins["skill-creator@claude-plugins-official"] = true |
  .enabledPlugins["code-simplifier@claude-plugins-official"] = true |
  .enabledPlugins["github@claude-plugins-official"] = true |
  .enabledPlugins["typescript-lsp@claude-plugins-official"] = true
' "$settings" > "$tmp"
mv "$tmp" "$settings"
