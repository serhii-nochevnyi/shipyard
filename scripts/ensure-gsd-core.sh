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
# VERSION POLICY. Default is `latest`, because a superstructure that pins its
# base silently rots against it — the skew above is what that looks like. The
# repo's "never an unpinned latest" convention governs the IMAGE toolchain, where
# a reproducible build is the point; this is a host install of the thing shipyard
# extends, and there the current version is the correct one. `GSD_CORE_VERSION`
# pins it when reproducibility matters, which is exactly what the Dockerfile does.
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
  HOME_DIR="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
  FLAGS=(--claude --global --profile=full)
else
  HOME_DIR="${CODEX_HOME:-$HOME/.codex}"
  FLAGS=(--codex --global)
fi
CORE="$HOME_DIR/gsd-core"

# The installed tree carries no version marker of its own, so "what is installed"
# is only answerable as present/absent. Report the resolved target instead of
# guessing at the current one — a wrong version claim is worse than none.
resolved="$VERSION"
if [[ "$VERSION" == "latest" ]]; then
  resolved="$(npm view @opengsd/gsd-core version 2>/dev/null || echo latest)"
fi

if [[ -d "$CORE" ]]; then
  echo "→ gsd-core present at $CORE — reinstalling at $resolved"
else
  echo "→ gsd-core missing for $RUNTIME — installing $resolved"
fi

# `</dev/null` because the installer prompts when it can; the whole point here is
# an unattended install.
if npx --yes "@opengsd/gsd-core@${VERSION}" "${FLAGS[@]}" </dev/null; then
  echo "✓ gsd-core $resolved installed for $RUNTIME → $CORE"
else
  echo "⚠ gsd-core install failed for $RUNTIME (offline? npm registry unreachable?)." >&2
  if [[ -d "$CORE" ]]; then
    echo "  The existing install at $CORE is untouched and shipyard will use it." >&2
    exit 0
  fi
  # For Codex this IS fatal further down — the generator cannot convert a command
  # without gsd-core — so say that here rather than failing later with a stack.
  echo "  Nothing is installed there, so the Codex generator has no converter to call." >&2
  echo "  Install it manually when you have a network: npx --yes @opengsd/gsd-core@latest --${RUNTIME} --global" >&2
  exit 1
fi
