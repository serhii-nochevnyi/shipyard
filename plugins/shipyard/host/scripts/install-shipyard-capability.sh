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
# frontmatter.cjs sibling". The Codex install performs the same staging step in
# install-shipyard-codex.sh; this covers host Claude Code as well.
#
# Environment overrides:
#   CLAUDE_HOME  (default ~/.claude)   GSD tools home for the claude runtime
#   CODEX_HOME   (default ~/.codex)    GSD tools home for the codex runtime

CAPABILITY_RUNTIME="${1:-claude}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PLUGIN_DIR="$REPO_ROOT/plugins/delivery-pipeline"
CAP_SRC="$REPO_ROOT/capabilities/delivery-pipeline"

source "$REPO_ROOT/scripts/ensure-gsd-core.sh" --library
validate_isolated_node_options
CAPABILITY_HOME="${CODEX_HOME:-$HOME/.codex}"
[[ "$CAPABILITY_RUNTIME" != claude ]] || CAPABILITY_HOME="${CLAUDE_CONFIG_DIR:-${CLAUDE_HOME:-$HOME/.claude}}"
prepare_isolation "$CAPABILITY_RUNTIME" "$CAPABILITY_HOME" "${SHIPYARD_ISOLATION_ROOT:-}"
export SHIPYARD_RUNTIME="$CAPABILITY_RUNTIME" GSD_RUNTIME="$CAPABILITY_RUNTIME"

case "$CAPABILITY_RUNTIME" in
  claude) GSD_TOOLS="${CLAUDE_CONFIG_DIR:-${CLAUDE_HOME:-$HOME/.claude}}/gsd-core/bin/gsd-tools.cjs"; HINT='npx --yes @opengsd/gsd-core@latest --claude --global --profile=full' ;;
  codex)  GSD_TOOLS="${CODEX_HOME:-$HOME/.codex}/gsd-core/bin/gsd-tools.cjs";  HINT='npx --yes @opengsd/gsd-core@latest --codex --global' ;;
  *) echo "usage: install-shipyard-capability.sh [claude|codex]" >&2; exit 2 ;;
esac

command -v node >/dev/null 2>&1 || { echo "error: node not found on PATH" >&2; exit 1; }
[[ -d "$CAP_SRC" ]] || { echo "error: capability dir missing: $CAP_SRC" >&2; exit 1; }
[[ -d "$PLUGIN_DIR/scripts" ]] || { echo "error: plugin scripts missing: $PLUGIN_DIR/scripts" >&2; exit 1; }
if [[ ! -f "$GSD_TOOLS" ]]; then
  echo "error: gsd-core for $CAPABILITY_RUNTIME not found at $GSD_TOOLS" >&2
  echo "       install it first: $HINT" >&2
  exit 1
fi

if [[ -n "${SHIPYARD_ISOLATION_ROOT:-}" ]]; then
  STAGE="$(mktemp -d "$TMPDIR/shipyard-capability.XXXXXX")"
else
  STAGE="$(mktemp -d)"
fi
CAPABILITY_STAGE_ID=''
check_capability_boundary() {
  [[ -n "${SHIPYARD_ISOLATION_ROOT:-}" ]] || return 0
  isolation_env "$CAPABILITY_RUNTIME" "$SHIPYARD_ISOLATION_ROOT" >/dev/null || return 3
  local current
  current="$(node - "$STAGE" <<'NODE'
const fs=require('node:fs'),path=require('node:path');
try {
  const root=fs.realpathSync(process.env.SHIPYARD_ISOLATION_ROOT), stage=path.resolve(process.argv[2]), rows=[];
  if(!stage.startsWith(root+path.sep))throw Error('stage outside candidate');
  for(let p=stage;;p=path.dirname(p)) {
    const s=fs.lstatSync(p);
    if(!s.isDirectory()||s.isSymbolicLink()||fs.realpathSync(p)!==p||s.uid!==process.getuid()||(s.mode&0o022))throw Error('unsafe stage ancestor: '+p);
    rows.push([p,String(s.dev),String(s.ino),s.mode]);
    if(p===root)break;
  }
  process.stdout.write(JSON.stringify(rows));
} catch(e) {console.error('isolation refusal: '+e.message);process.exitCode=3;}
NODE
)" || return 3
  if [[ -n "$CAPABILITY_STAGE_ID" && "$current" != "$CAPABILITY_STAGE_ID" ]]; then
    echo 'isolation refusal: capability stage ancestor identity changed' >&2
    return 3
  fi
  CAPABILITY_STAGE_ID="$current"
}
cleanup_capability() {
  local status=$?
  trap - EXIT
  check_capability_boundary || exit 3
  rm -rf "$STAGE"
  exit "$status"
}
trap cleanup_capability EXIT
check_capability_boundary
CAP_STAGE="$STAGE/delivery-pipeline"
mkdir -p "$CAP_STAGE/checks"
cp -R "$CAP_SRC/." "$CAP_STAGE/"
cp "$PLUGIN_DIR"/scripts/*.cjs "$CAP_STAGE/checks/"
chmod +x "$CAP_STAGE"/checks/*.cjs

check_capability_boundary
VERSION="$(node -p "require('$CAP_SRC/capability.json').version")"
check_capability_boundary
echo "→ installing delivery-pipeline capability $VERSION for $CAPABILITY_RUNTIME (global scope)…"
# Keep the runtime in the process context. The capability is shared, but the
# GSD install that is receiving it is not: writing a runtime into shared GSD
# defaults would make the last installer win for both Claude and Codex.
capability_status=0
node "$GSD_TOOLS" capability install "$CAP_STAGE" --scope global --yes || capability_status=$?
check_capability_boundary
[[ "$capability_status" == 0 ]] || exit "$capability_status"

echo "✓ installed. The plan:post gate is applicability-scoped: it stays inert in"
echo "  projects with no delivery: blocks, and fails closed for conveyor projects."
