#!/usr/bin/env bash
set -euo pipefail

# ensure-gsd-core.sh — install or upgrade gsd-core for one runtime.
#
#   ensure-gsd-core.sh <claude|codex> [version]
#
# WHY THIS EXISTS. shipyard is a superstructure over GSD: the Codex generator
# requires gsd-core's `runtime-artifact-conversion.cjs` to convert commands, and
# reads its model catalog to map a tier to a concrete model. Until now the
# installers only CHECKED for it and printed a manual `npx` hint, so nothing kept
# the two in step — and they drifted three ways on the same machine:
#
#   Claude plugin (the slash commands actually invoked)  1.10.0
#   ~/.claude/gsd-core (what gsd-tools resolves)          1.9.1
#   ~/.codex/gsd-core  (what OUR generator reads)         older still
#
# The last line is the one that matters: Codex artifacts were being generated
# through the oldest install on the box.
#
# VERSION POLICY. Default is `latest`, because a superstructure that pins GSD
# forever silently rots against it — the skew above is what that looks like.
# Set `GSD_CORE_VERSION` when a project needs a reproducible host toolchain.
#
# This is a NETWORK operation that writes to the user's runtime home, so it says
# what it is doing and what changed.

RUNTIME="${1:-}"
VERSION="${2:-${GSD_CORE_VERSION:-latest}}"

case "$RUNTIME" in
  claude|codex) ;;
  *) echo "usage: ensure-gsd-core.sh <claude|codex> [version]" >&2; exit 2 ;;
esac

command -v node >/dev/null 2>&1 || { echo "error: node not found on PATH" >&2; exit 1; }
command -v npx  >/dev/null 2>&1 || { echo "error: npx not found on PATH" >&2; exit 1; }

if [[ "$RUNTIME" == "claude" ]]; then
  HOME_DIR="${CLAUDE_CONFIG_DIR:-${CLAUDE_HOME:-$HOME/.claude}}"
  export CLAUDE_CONFIG_DIR="$HOME_DIR"
  FLAGS=(--claude --global --profile=full)
else
  HOME_DIR="${CODEX_HOME:-$HOME/.codex}"
  FLAGS=(--codex --global)
fi
CORE="$HOME_DIR/gsd-core"

# The install writes a VERSION file, so before/after is answerable exactly. Use
# it. Comparing directory trees instead is what produced a confidently wrong
# reading earlier — the npm package layout and the installed layout are different
# artifacts, so a file-count diff between them measures nothing.
installed_version() { cat "$CORE/VERSION" 2>/dev/null | tr -d '\n\r' || true; }

resolved="$VERSION"
if [[ "$VERSION" == "latest" ]]; then
  resolved="$(npm view @opengsd/gsd-core version 2>/dev/null || echo latest)"
fi
before="$(installed_version)"

if [[ -n "$before" ]]; then
  if [[ "$before" == "$resolved" ]]; then
    echo "→ gsd-core $before already current for $RUNTIME — reinstalling to be sure"
  else
    echo "→ gsd-core $before → $resolved for $RUNTIME"
  fi
else
  echo "→ gsd-core missing for $RUNTIME — installing $resolved"
fi

# @contract: Both runtimes require the GSD payload and enabled marketplace plugin.
if npx --yes "@opengsd/gsd-core@${VERSION}" "${FLAGS[@]}" </dev/null; then
  after="$(installed_version)"
  # Report what the FILE says, not what was asked for: an install that quietly
  # landed something else is exactly the case worth seeing.
  echo "✓ gsd-core ${after:-$resolved} installed for $RUNTIME → $CORE"
  if [[ -n "$after" && -n "$resolved" && "$resolved" != "latest" && "$after" != "$resolved" ]]; then
    echo "error: asked for $resolved, VERSION says $after" >&2
    exit 1
  fi
  # `[[ cond ]] && func` as the LAST statement returns 1 when cond is false, so on
  # codex this script exited 1 and the caller's `set -e` aborted the whole install
  # right after reporting success. An `if` has no such tail.
  node "$(dirname "${BASH_SOURCE[0]}")/ensure-gsd-plugin.cjs" "$RUNTIME"
else
  echo "⚠ gsd-core install failed for $RUNTIME (offline? npm registry unreachable?)." >&2
  # For Codex this IS fatal further down — the generator cannot convert a command
  # without gsd-core — so say that here rather than failing later with a stack.
  echo "  Dependency setup is incomplete; the Shipyard installation is stopped." >&2
  echo "  Install it manually when you have a network: npx --yes @opengsd/gsd-core@latest --${RUNTIME} --global" >&2
  exit 1
fi
