#!/usr/bin/env bash
set -euo pipefail

# install-shipyard-capability.sh — install/refresh the delivery-pipeline GSD
# capability (the blocking Gate 2 + UAT gates) for a host runtime.
#
#   bash scripts/install-shipyard-capability.sh [claude|codex]     (default: claude)
#
# Why this exists: the capability's gate launcher delegates to the canonical
# ticket-graph validator, and that validator REQUIRES its sibling modules
# (frontmatter.cjs, pipeline-config.cjs). `gsd-tools capability install` copies
# the folder away, so the whole script set has to be staged into checks/ first —
# otherwise the gate lands half-installed and fails with "installed without its
# frontmatter.cjs sibling". The container does this in the Dockerfile and the
# Codex install does it in install-shipyard-codex.sh; this covers host Claude
# Code, which previously had no installer at all.
#
# Environment overrides:
#   CLAUDE_HOME  (default ~/.claude)   GSD tools home for the claude runtime
#   CODEX_HOME   (default ~/.codex)    GSD tools home for the codex runtime

RUNTIME="${1:-claude}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PLUGIN_DIR="$REPO_ROOT/plugins/delivery-pipeline"
CAP_SRC="$REPO_ROOT/capabilities/delivery-pipeline"

case "$RUNTIME" in
  claude) GSD_TOOLS="${CLAUDE_HOME:-$HOME/.claude}/gsd-core/bin/gsd-tools.cjs"; HINT='npx --yes @opengsd/gsd-core@1.7.0 --claude --global --profile=full' ;;
  codex)  GSD_TOOLS="${CODEX_HOME:-$HOME/.codex}/gsd-core/bin/gsd-tools.cjs";  HINT='npx --yes @opengsd/gsd-core@1.7.0 --codex --global' ;;
  *) echo "usage: install-shipyard-capability.sh [claude|codex]" >&2; exit 2 ;;
esac

command -v node >/dev/null 2>&1 || { echo "error: node not found on PATH" >&2; exit 1; }
[[ -d "$CAP_SRC" ]] || { echo "error: capability dir missing: $CAP_SRC" >&2; exit 1; }
[[ -d "$PLUGIN_DIR/scripts" ]] || { echo "error: plugin scripts missing: $PLUGIN_DIR/scripts" >&2; exit 1; }
if [[ ! -f "$GSD_TOOLS" ]]; then
  echo "error: gsd-core for $RUNTIME not found at $GSD_TOOLS" >&2
  echo "       install it first: $HINT" >&2
  exit 1
fi

STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
CAP_STAGE="$STAGE/delivery-pipeline"
mkdir -p "$CAP_STAGE/checks"
cp -R "$CAP_SRC/." "$CAP_STAGE/"
cp "$PLUGIN_DIR"/scripts/*.cjs "$CAP_STAGE/checks/"
chmod +x "$CAP_STAGE"/checks/*.cjs

VERSION="$(node -p "require('$CAP_SRC/capability.json').version")"
echo "→ installing delivery-pipeline capability $VERSION for $RUNTIME (global scope)…"
node "$GSD_TOOLS" capability install "$CAP_STAGE" --scope global --yes

echo "✓ installed. The plan:post gate is applicability-scoped: it stays inert in"
echo "  projects with no delivery: blocks, and fails closed for conveyor projects."
