#!/usr/bin/env bash
set -euo pipefail

# Pre-seed Claude Code's per-directory trust for a project inside the container.
#
#   shipyard-trust [<dir>]        (default: the current directory)
#
# ~/.claude.json is ephemeral — it is recreated with the container — so a repo
# cloned into /workspace after startup would face the trust dialog again on every
# recreation. The entrypoint seeds the directories that exist at boot; this helper
# covers the rest and is called by `make claude` / `make shell` / the launcher
# before attaching. Non-destructive: an existing value is never overwritten.

dir="${1:-$PWD}"
[[ -d "$dir" ]] || { echo "shipyard-trust: not a directory: $dir" >&2; exit 1; }
dir="$(cd -- "$dir" && pwd)"

config="$HOME/.claude.json"
[[ -f "$config" ]] || echo '{}' > "$config"
jq empty "$config" >/dev/null

tmp="$(mktemp)"
jq --arg dir "$dir" '
  .projects |= (. // {}) |
  .projects[$dir] |= ((. // {}) |
    .hasTrustDialogAccepted = (.hasTrustDialogAccepted // true) |
    .hasCompletedProjectOnboarding = (.hasCompletedProjectOnboarding // true))
' "$config" > "$tmp"
mv "$tmp" "$config"
echo "trusted $dir"
