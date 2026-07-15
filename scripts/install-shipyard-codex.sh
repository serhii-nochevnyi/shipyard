#!/usr/bin/env bash
set -euo pipefail

# install-shipyard-codex.sh — install the shipyard delivery conveyor onto an
# OpenAI Codex CLI setup on the host.
#
# Generates Codex-native artifacts from the canonical Claude plugin
# (plugins/delivery-pipeline/), places them non-destructively, and registers the
# runtime-agnostic GSD capability that contributes the blocking Gate 2 (ticket
# graph) and UAT gates. The Docker image is NOT involved — this is a host tool.
#
# Prerequisites:
#   - node on PATH
#   - gsd-core already installed for Codex:
#       npx --yes @opengsd/gsd-core@1.7.0 --codex --global
#
# Environment overrides:
#   CODEX_HOME         Codex config home (default: ~/.codex)
#   AGENTS_SKILLS_DIR  Codex/cursor/cline skills dir (default: ~/.agents/skills)
#   SHIPYARD_CODEX_PHASE  1 = investigate+decompose only; 2 = + deliver (default 2)
#
# Usage: bash scripts/install-shipyard-codex.sh [--phase 1|2]

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PLUGIN_DIR="$REPO_ROOT/plugins/delivery-pipeline"
CAP_SRC="$REPO_ROOT/capabilities/delivery-pipeline"
PHASE="${SHIPYARD_CODEX_PHASE:-2}"

CODEX_HOME="${CODEX_HOME:-$HOME/.codex}"
AGENTS_SKILLS="${AGENTS_SKILLS_DIR:-$HOME/.agents/skills}"
BUNDLE_ROOT="$CODEX_HOME/shipyard"
GSD_TOOLS="$CODEX_HOME/gsd-core/bin/gsd-tools.cjs"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --phase) PHASE="${2:?}"; shift 2 ;;
    -h | --help) sed -n '3,25p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

# ── preconditions ────────────────────────────────────────────────────────────
command -v node >/dev/null 2>&1 || { echo "error: node not found on PATH" >&2; exit 1; }
[[ -d "$PLUGIN_DIR" ]] || { echo "error: plugin dir missing: $PLUGIN_DIR" >&2; exit 1; }
[[ -d "$CAP_SRC" ]] || { echo "error: capability dir missing: $CAP_SRC" >&2; exit 1; }
if [[ ! -f "$GSD_TOOLS" ]]; then
  echo "error: gsd-core for Codex not found at $GSD_TOOLS" >&2
  echo "       install it first:" >&2
  echo "       npx --yes @opengsd/gsd-core@1.7.0 --codex --global" >&2
  exit 1
fi

STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
OUT="$STAGE/bundle-out"

# ── generate ─────────────────────────────────────────────────────────────────
echo "→ generating Codex bundle (phase $PHASE)…"
node "$REPO_ROOT/scripts/gen-codex-shipyard.cjs" \
  --plugin "$PLUGIN_DIR" --out "$OUT" \
  --codex-home "$CODEX_HOME" --bundle-root "$BUNDLE_ROOT" --phase "$PHASE"

# ── skills → ~/.agents/skills (only our own shipyard-* dirs are touched) ──────
echo "→ installing skills → $AGENTS_SKILLS"
mkdir -p "$AGENTS_SKILLS"
for d in "$OUT"/skills/*/; do
  name="$(basename "$d")"
  rm -rf "${AGENTS_SKILLS:?}/$name"
  cp -R "${d%/}" "$AGENTS_SKILLS/$name"
done

# ── bundle payload (CLAUDE_PLUGIN_ROOT target: scripts/references/templates) ──
echo "→ installing bundle payload → $BUNDLE_ROOT"
mkdir -p "$BUNDLE_ROOT"
cp -R "$OUT"/bundle/. "$BUNDLE_ROOT/"
find "$BUNDLE_ROOT" -name '*.sh' -exec chmod +x {} +

# ── agents + non-destructive config.toml merge ───────────────────────────────
if compgen -G "$OUT/agents/*.toml" >/dev/null; then
  echo "→ installing agents → $CODEX_HOME/agents"
  mkdir -p "$CODEX_HOME/agents"
  cp "$OUT"/agents/*.toml "$CODEX_HOME/agents/"
  echo "→ merging agent registrations → $CODEX_HOME/config.toml"
  node "$REPO_ROOT/scripts/merge-codex-config.cjs" \
    --config "$CODEX_HOME/config.toml" --fragment "$OUT/config.fragment.toml"
fi

# ── GSD capability (Gate 2 / UAT gates) ──────────────────────────────────────
# Stage the capability with a bundled validator so graph-gate.cjs resolves it
# from its own checks/ dir on a host (there is no /opt/delivery-pipeline here).
echo "→ registering GSD capability (Gate 2 / UAT gates)…"
CAP_STAGE="$STAGE/capability/delivery-pipeline"
mkdir -p "$CAP_STAGE"
cp -R "$CAP_SRC/." "$CAP_STAGE/"
cp "$PLUGIN_DIR/scripts/validate-graph.cjs" "$CAP_STAGE/checks/validate-graph.cjs"
node "$GSD_TOOLS" capability install "$CAP_STAGE" --scope global --yes

deliver_hint=""
[[ "$PHASE" -ge 2 ]] && deliver_hint=' | $shipyard-deliver'
echo "✓ shipyard installed for Codex."
echo "  In Codex: \$shipyard-investigate | \$shipyard-decompose${deliver_hint}"
