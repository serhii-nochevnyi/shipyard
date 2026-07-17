#!/usr/bin/env bash
set -euo pipefail

# codex-shipyard smoke — the generator + merge helper + installer produce valid,
# non-destructive Codex artifacts from the canonical Claude plugin.
#
# Dynamic portion installs gsd-core --codex into a throwaway HOME to obtain the
# OFFICIAL converter (so this asserts against real gsd-core behavior, not a
# replica). Requires network + npx, like the image smokes require Docker.

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

# ── static ───────────────────────────────────────────────────────────────────
for f in scripts/gen-codex-shipyard.cjs scripts/merge-codex-config.cjs scripts/install-shipyard-codex.sh; do
  [[ -f "$f" ]] || { echo "missing $f"; exit 1; }
done
node --check scripts/gen-codex-shipyard.cjs
node --check scripts/merge-codex-config.cjs
bash -n scripts/install-shipyard-codex.sh

# ── isolate: throwaway HOME so ~/.codex and ~/.agents never touch the host ────
GSD_CORE_VERSION="${GSD_CORE_VERSION:-1.7.0}"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
export HOME="$WORK"
CODEX_HOME="$WORK/.codex"
SKILLS="$WORK/.agents/skills"

echo "→ installing gsd-core@${GSD_CORE_VERSION} --codex (throwaway HOME)…"
npx --yes "@opengsd/gsd-core@${GSD_CORE_VERSION}" --codex --global </dev/null >/dev/null 2>&1 \
  || { echo "gsd-core --codex install failed (network?)"; exit 1; }
[[ -f "$CODEX_HOME/gsd-core/bin/gsd-tools.cjs" ]] || { echo "gsd-core not installed for codex"; exit 1; }

# ── install shipyard (full, phase 2) ─────────────────────────────────────────
bash scripts/install-shipyard-codex.sh --phase 2 >/dev/null

# skills present
for s in shipyard-investigate shipyard-decompose shipyard-deliver shipyard-delivery-rules; do
  [[ -f "$SKILLS/$s/SKILL.md" ]] || { echo "missing skill $s"; exit 1; }
done
# no Claude-only leaks; self-refs converted; adapter present
grep -rq 'allowed-tools' "$SKILLS"/shipyard-*/SKILL.md && { echo "allowed-tools leaked into a skill"; exit 1; } || true
grep -rq 'CLAUDE_PLUGIN_ROOT' "$SKILLS"/shipyard-*/SKILL.md && { echo "CLAUDE_PLUGIN_ROOT not rewritten"; exit 1; } || true
grep -rq '/shipyard:' "$SKILLS"/shipyard-*/SKILL.md && { echo "unconverted /shipyard: reference"; exit 1; } || true
grep -rq '[$]shipyard-' "$SKILLS"/shipyard-*/SKILL.md || { echo "no \$shipyard- invocations found"; exit 1; }
grep -q 'codex_skill_adapter' "$SKILLS/shipyard-deliver/SKILL.md" || { echo "missing codex adapter header"; exit 1; }

# bundle payload carries the deterministic scripts (incl. the telemetry layer)
# and they are valid node — the deliver skill calls them via the rewritten root
for f in scripts/state-sync.cjs scripts/reviewers.cjs scripts/validate-graph.cjs \
         scripts/ticket-pr-match.cjs scripts/log-event.cjs scripts/pipeline-stats.cjs \
         scripts/ticket-worktree.sh; do
  [[ -f "$CODEX_HOME/shipyard/$f" ]] || { echo "bundle missing $f"; exit 1; }
done
for f in state-sync log-event pipeline-stats ticket-pr-match; do
  node --check "$CODEX_HOME/shipyard/scripts/$f.cjs" || { echo "bundle $f.cjs fails node --check"; exit 1; }
done
# the converted deliver skill references the telemetry scripts at the bundle root
grep -q 'log-event.cjs' "$SKILLS/shipyard-deliver/SKILL.md" || { echo "deliver skill lost log-event.cjs reference"; exit 1; }
grep -q 'pipeline-stats.cjs' "$SKILLS/shipyard-deliver/SKILL.md" || { echo "deliver skill lost pipeline-stats.cjs reference"; exit 1; }

# agents present + registered; gsd agents intact
for a in shipyard-arch-review shipyard-ci-fix shipyard-drift-check shipyard-integrator shipyard-inv-research shipyard-review-fix; do
  [[ -f "$CODEX_HOME/agents/$a.toml" ]] || { echo "missing agent $a.toml"; exit 1; }
  grep -q "^\[agents\.$a\]" "$CODEX_HOME/config.toml" || { echo "agent $a not registered in config.toml"; exit 1; }
done
GSD_AGENTS="$(grep -c '^\[agents\.gsd-' "$CODEX_HOME/config.toml" || true)"
[[ "$GSD_AGENTS" -ge 30 ]] || { echo "gsd agents clobbered (found $GSD_AGENTS)"; exit 1; }

# idempotent merge: re-running keeps exactly 6 shipyard agents
bash scripts/install-shipyard-codex.sh --phase 2 >/dev/null
SHIP_AGENTS="$(grep -c '^\[agents\.shipyard-' "$CODEX_HOME/config.toml" || true)"
[[ "$SHIP_AGENTS" -eq 6 ]] || { echo "merge not idempotent (shipyard agents=$SHIP_AGENTS)"; exit 1; }

# capability installed, self-contained, and Gate 2 mechanic blocks an empty decomposition
node "$CODEX_HOME/gsd-core/bin/gsd-tools.cjs" capability list 2>/dev/null | grep -q 'delivery-pipeline' \
  || { echo "delivery-pipeline capability not listed"; exit 1; }
CAPDIR="$WORK/.gsd/capabilities/delivery-pipeline"
[[ -f "$CAPDIR/checks/validate-graph.cjs" ]] || { echo "capability not self-contained (validate-graph.cjs missing)"; exit 1; }
mkdir -p "$WORK/proj"
if ( cd "$WORK/proj" && GSD_CAP_DIR="$CAPDIR" node "$CAPDIR/checks/graph-gate.cjs" ) >/dev/null 2>&1; then
  echo "Gate 2 did NOT block an empty decomposition"; exit 1
fi

# phase gating: --phase 1 emits neither the deliver skill nor phase-2 agents,
# but still emits the phase-1 inv-research agent.
node scripts/gen-codex-shipyard.cjs --plugin plugins/delivery-pipeline \
  --out "$WORK/p1" --codex-home "$CODEX_HOME" --phase 1 >/dev/null
[[ ! -e "$WORK/p1/skills/shipyard-deliver" ]] || { echo "phase 1 leaked deliver skill"; exit 1; }
[[ ! -e "$WORK/p1/agents/shipyard-arch-review.toml" ]] || { echo "phase 1 leaked a phase-2 agent"; exit 1; }
[[ -e "$WORK/p1/agents/shipyard-inv-research.toml" ]] || { echo "phase 1 missing inv-research agent"; exit 1; }

echo "codex-shipyard smoke: OK"
