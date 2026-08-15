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
GSD_CORE_VERSION="${GSD_CORE_VERSION:-1.9.1}"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
export HOME="$WORK"
CODEX_HOME="$WORK/.codex"
SKILLS="$WORK/.agents/skills"

echo "→ installing gsd-core@${GSD_CORE_VERSION} --codex (throwaway HOME)…"
npx --yes "@opengsd/gsd-core@${GSD_CORE_VERSION}" --codex --global </dev/null >/dev/null 2>&1 \
  || { echo "gsd-core --codex install failed (network?)"; exit 1; }
[[ -f "$CODEX_HOME/gsd-core/bin/gsd-tools.cjs" ]] || { echo "gsd-core not installed for codex"; exit 1; }

# Snapshot what gsd-core owns BEFORE we touch the config. Asserting a literal
# agent count here pinned us to one gsd-core release: 1.7.0 registered ~34
# `[agents.gsd-*]` tables, 1.9.1 registers none at all (its
# `generateCodexConfigBlock` ignores the agent list and emits only the marker and
# `[agents] max_depth`). The invariant we actually care about is version-free —
# whatever gsd-core wrote, our merge must hand it back untouched.
gsd_owned_state() {
  printf '%s|%s|%s\n' \
    "$(grep -c '^\[agents\.gsd-' "$CODEX_HOME/config.toml" || true)" \
    "$(grep -c '^# GSD Agent Configuration' "$CODEX_HOME/config.toml" || true)" \
    "$(ls "$CODEX_HOME/agents"/gsd-*.toml 2>/dev/null | wc -l | tr -d ' ')"
}
GSD_BEFORE="$(gsd_owned_state)"

# This smoke deliberately PINNED gsd-core above and asserts against that
# version's converter. The installer now refreshes gsd-core to the latest by
# default — correct for a user, wrong here: it would overwrite the setup this
# test just built and make every assertion below describe a different gsd-core
# than the one it installed. Exported once; every install call below inherits it.
export SHIPYARD_GSD_AUTO_INSTALL=0

# ── install shipyard (full, phase 2) ─────────────────────────────────────────
bash scripts/install-shipyard-codex.sh --phase 2 >/dev/null

GSD_AFTER="$(gsd_owned_state)"
[[ "$GSD_BEFORE" == "$GSD_AFTER" ]] \
  || { echo "our merge changed gsd-core-owned state: $GSD_BEFORE -> $GSD_AFTER"; exit 1; }

# skills present
for s in shipyard-route shipyard-investigate shipyard-decompose shipyard-deliver shipyard-bench shipyard-delivery-rules; do
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
for f in scripts/state-sync.cjs scripts/reviewers.cjs scripts/validate-graph.cjs scripts/front.cjs \
         scripts/ticket-pr-match.cjs scripts/log-event.cjs scripts/pipeline-stats.cjs \
         scripts/ticket-worktree.sh scripts/epic-branch.sh; do
  [[ -f "$CODEX_HOME/shipyard/$f" ]] || { echo "bundle missing $f"; exit 1; }
done
bash -n "$CODEX_HOME/shipyard/scripts/epic-branch.sh" || { echo "bundled epic-branch.sh syntax error"; exit 1; }
bash -n "$CODEX_HOME/shipyard/scripts/ticket-worktree.sh" || { echo "bundled ticket-worktree.sh syntax error"; exit 1; }
for f in state-sync log-event pipeline-stats ticket-pr-match frontmatter pipeline-config; do
  node --check "$CODEX_HOME/shipyard/scripts/$f.cjs" || { echo "bundle $f.cjs fails node --check"; exit 1; }
done
# The bundled validator must be able to load its siblings from the bundle root.
# Capture first: it exits non-zero here by design, and `set -o pipefail` would
# report that instead of the grep result.
vg_out="$( ( cd "$WORK" && node -e 'require(process.argv[1])' "$CODEX_HOME/shipyard/scripts/validate-graph.cjs" 2>&1 ) || true )"
grep -q 'missing .planning' <<<"$vg_out" || { echo "bundled validate-graph.cjs cannot load its modules: $vg_out"; exit 1; }
# the model resolver travels with the bundle and only emits tier aliases
[[ "$(node "$CODEX_HOME/shipyard/scripts/pipeline-config.cjs" model arch-review)" == opus ]] \
  || { echo "bundled pipeline-config.cjs does not resolve the judgment tier"; exit 1; }

# ${CLAUDE_PLUGIN_ROOT} is rewritten to the bundle root, so every path the skills
# reference must actually EXIST there — including workflows/, which used to be
# omitted from the bundle while the deliver skill still pointed into it.
for wf in drift-gate executors fix-round; do
  [[ -f "$CODEX_HOME/shipyard/workflows/$wf.mjs" ]] || { echo "bundle missing workflows/$wf.mjs"; exit 1; }
done
missing_paths=0
while read -r p; do
  [[ -e "$p" ]] || { echo "converted skill references a non-existent path: $p"; missing_paths=1; }
done < <(grep -rhoE "$CODEX_HOME/shipyard/[A-Za-z0-9_./-]+\.(cjs|mjs|sh|md)" "$SKILLS"/shipyard-*/SKILL.md | sort -u)
[[ "$missing_paths" -eq 0 ]] || exit 1

# the converted deliver skill references the telemetry scripts at the bundle root
grep -q 'log-event.cjs' "$SKILLS/shipyard-deliver/SKILL.md" || { echo "deliver skill lost log-event.cjs reference"; exit 1; }
grep -q 'pipeline-stats.cjs' "$SKILLS/shipyard-deliver/SKILL.md" || { echo "deliver skill lost pipeline-stats.cjs reference"; exit 1; }

# gsd-core's converter substitutes the word "Claude" in prose, so a sentence that
# contrasts the two runtimes by NAME arrives inverted: "…only mean anything on the
# Claude runtime" shipped as "…on the the agent runtime", i.e. the opposite of the
# warning it was. The tell is the doubled article the substitution leaves behind.
for f in "$SKILLS"/shipyard-*/SKILL.md; do
  if grep -nE '\b(the|a) the agent\b' "$f"; then
    echo "$(basename "$(dirname "$f")"): a 'Claude' → 'the agent' substitution mangled a sentence (above). Name the mechanism (the Agent tool / the Workflow tool), not the runtime."
    exit 1
  fi
done
grep -q 'pipeline-config.cjs' "$SKILLS/shipyard-deliver/SKILL.md" || { echo "deliver skill lost the model resolver reference"; exit 1; }

# auto-route lands in the CODEX_HOME being installed into, not a hardcoded ~/.codex
grep -q 'shipyard-auto-route:begin' "$CODEX_HOME/AGENTS.md" \
  || { echo "auto-route block missing from \$CODEX_HOME/AGENTS.md"; exit 1; }

# agents present + registered; gsd agents intact
for a in shipyard-arch-review shipyard-ci-fix shipyard-drift-check shipyard-integrator shipyard-inv-research shipyard-pr-sentinel shipyard-review-fix; do
  [[ -f "$CODEX_HOME/agents/$a.toml" ]] || { echo "missing agent $a.toml"; exit 1; }
  grep -q "^\[agents\.$a\]" "$CODEX_HOME/config.toml" || { echo "agent $a not registered in config.toml"; exit 1; }
done
[[ "$(gsd_owned_state)" == "$GSD_BEFORE" ]] \
  || { echo "gsd-core-owned state drifted after install: $GSD_BEFORE -> $(gsd_owned_state)"; exit 1; }

# How many agents we expect, derived from the generator's own ROLES table rather
# than hardcoded — a literal here silently rots the moment a reference is added
# (it did: pr-sentinel arrived in 0.15.0 and the assertion kept demanding the old
# six, so a correct generator failed the gate).
EXPECTED_AGENTS="$(node -e '
  const src = require("fs").readFileSync("scripts/gen-codex-shipyard.cjs", "utf8");
  const table = src.match(/const ROLES = \{([\s\S]*?)\n  \};/);
  if (!table) { console.error("cannot find the ROLES table"); process.exit(1); }
  const roles = [...table[1].matchAll(/^\s*.([a-z-]+).:\s*\{[^}]*phase:\s*(\d+)/gm)];
  if (!roles.length) { console.error("ROLES table parsed to nothing"); process.exit(1); }
  console.log(roles.filter(([, , ph]) => Number(ph) <= 2).length);
')"

# Our fragment must sit ABOVE gsd-core's marker. Its installer removes
# "everything from marker to EOF", so a fragment appended below is deleted by the
# next gsd-core install OR uninstall — silently, taking every shipyard agent with
# it. Placement is the fix; this asserts it.
MARKER_LINE="$(grep -n '^# GSD Agent Configuration' "$CODEX_HOME/config.toml" | head -1 | cut -d: -f1)"
FENCE_LINE="$(grep -n 'shipyard-agents:end' "$CODEX_HOME/config.toml" | head -1 | cut -d: -f1)"
if [[ -n "$MARKER_LINE" ]]; then
  [[ -n "$FENCE_LINE" && "$FENCE_LINE" -lt "$MARKER_LINE" ]] \
    || { echo "shipyard fragment (line ${FENCE_LINE:-none}) is not above the gsd-core marker (line $MARKER_LINE) — a gsd-core reinstall would delete it"; exit 1; }
fi

# The end-to-end version of the same property: reinstall gsd-core AFTER shipyard
# and require our registrations to still be there.
npx --yes "@opengsd/gsd-core@${GSD_CORE_VERSION}" --codex --global </dev/null >/dev/null 2>&1 \
  || { echo "gsd-core reinstall failed (network?)"; exit 1; }
SURVIVED="$(grep -c '^\[agents\.shipyard-' "$CODEX_HOME/config.toml" || true)"
[[ "$SURVIVED" -eq "$EXPECTED_AGENTS" ]] \
  || { echo "a gsd-core reinstall wiped shipyard agents ($SURVIVED left, expected $EXPECTED_AGENTS)"; exit 1; }

# idempotent merge: re-running registers each agent once, never a duplicate.
bash scripts/install-shipyard-codex.sh --phase 2 >/dev/null
SHIP_AGENTS="$(grep -c '^\[agents\.shipyard-' "$CODEX_HOME/config.toml" || true)"
[[ "$SHIP_AGENTS" -eq "$EXPECTED_AGENTS" ]] \
  || { echo "merge not idempotent (shipyard agents=$SHIP_AGENTS, expected $EXPECTED_AGENTS)"; exit 1; }

# Idempotency is about the WHOLE fragment, not just its tables. Counting tables
# missed a leading comment that belongs to no table: it survived every strip and
# a third install left three copies of it. Assert the fence markers are unique,
# and that no pre-fence legacy header lingers.
for marker in 'shipyard-agents:begin' 'shipyard-agents:end'; do
  n="$(grep -c "$marker" "$CODEX_HOME/config.toml" || true)"
  [[ "$n" -eq 1 ]] || { echo "merge left $n copies of '$marker' (expected 1)"; exit 1; }
done
LEGACY="$(grep -c '^# shipyard delivery-pipeline agents' "$CODEX_HOME/config.toml" || true)"
[[ "$LEGACY" -eq 0 ]] || { echo "legacy fragment header still present ($LEGACY)"; exit 1; }

# A config polluted by pre-fence installs must HEAL, not accumulate: seed the old
# shape, re-merge, and require it gone.
printf '\n# shipyard delivery-pipeline agents — merged into $CODEX_HOME/config.toml\n' >> "$CODEX_HOME/config.toml"
bash scripts/install-shipyard-codex.sh --phase 2 >/dev/null
LEGACY="$(grep -c '^# shipyard delivery-pipeline agents' "$CODEX_HOME/config.toml" || true)"
[[ "$LEGACY" -eq 0 ]] || { echo "legacy header not cleaned up on re-merge ($LEGACY)"; exit 1; }

# An UNTERMINATED fence must not swallow the rest of the file — the config also
# holds the user's own MCP servers and model settings.
printf '\n# shipyard-agents:begin\n\n[mcp_servers.canary]\ncommand = "true"\n' >> "$CODEX_HOME/config.toml"
bash scripts/install-shipyard-codex.sh --phase 2 >/dev/null
grep -q '^\[mcp_servers.canary\]' "$CODEX_HOME/config.toml" \
  || { echo "an orphan fence marker swallowed a foreign table"; exit 1; }

# capability installed and self-contained
cap_list="$(node "$CODEX_HOME/gsd-core/bin/gsd-tools.cjs" capability list 2>/dev/null || true)"
grep -q 'delivery-pipeline' <<<"$cap_list" || { echo "delivery-pipeline capability not listed"; exit 1; }
CAPDIR="$WORK/.gsd/capabilities/delivery-pipeline"
for f in validate-graph.cjs frontmatter.cjs pipeline-config.cjs; do
  [[ -f "$CAPDIR/checks/$f" ]] || { echo "capability not self-contained ($f missing)"; exit 1; }
done

# ── the plan:post gate is GLOBAL, so applicability matters as much as strictness ──
run_gate() { ( cd "$1" && GSD_CAP_DIR="$CAPDIR" node "$CAPDIR/checks/graph-gate.cjs" ); }

# A plain GSD project (plans, but no delivery: block) must NOT be blocked: the
# gate is installed globally and Gate 2's contract belongs to the conveyor only.
mkdir -p "$WORK/plaingsd/.planning/phases/01-x"
cat > "$WORK/plaingsd/.planning/phases/01-x/01-PLAN.md" <<'EOF'
---
phase: 01
plan: 01
title: "A plain GSD plan"
type: implementation
depends_on: []
---
## Goal
Nothing to do with the delivery conveyor.
EOF
run_gate "$WORK/plaingsd" >/dev/null 2>&1 \
  || { echo "the global plan:post gate blocks a plain GSD project"; exit 1; }

# An empty project has nothing to gate.
mkdir -p "$WORK/proj"
run_gate "$WORK/proj" >/dev/null 2>&1 \
  || { echo "the global plan:post gate blocks a project with no plans"; exit 1; }

# A CONVEYOR project with an invalid graph must still be blocked (fail closed).
mkdir -p "$WORK/conveyor/.planning/phases/01-x"
cat > "$WORK/conveyor/.planning/phases/01-x/01-PLAN.md" <<'EOF'
---
phase: 01
plan: 01
title: "A conveyor ticket with no scope"
type: implementation
depends_on: []
files_modified: []
requirements: []
delivery:
  ticket: T-01-01
  risk: low
  human_checkpoint: false
---
## Goal
x
EOF
if run_gate "$WORK/conveyor" >/dev/null 2>&1; then
  echo "Gate 2 did NOT block an invalid conveyor decomposition"; exit 1
fi

# phase gating: --phase 1 emits neither the deliver skill nor phase-2 agents,
# but still emits the phase-1 inv-research agent.
node scripts/gen-codex-shipyard.cjs --plugin plugins/delivery-pipeline \
  --out "$WORK/p1" --codex-home "$CODEX_HOME" --phase 1 >/dev/null
[[ ! -e "$WORK/p1/skills/shipyard-deliver" ]] || { echo "phase 1 leaked deliver skill"; exit 1; }
[[ ! -e "$WORK/p1/agents/shipyard-arch-review.toml" ]] || { echo "phase 1 leaked a phase-2 agent"; exit 1; }
[[ -e "$WORK/p1/agents/shipyard-inv-research.toml" ]] || { echo "phase 1 missing inv-research agent"; exit 1; }

# The bundle carries no editor leftovers. Three `*.mjs.bak` files — stale copies
# of the Workflow prompt builders — reached both installed runtimes before the
# generator learned to skip them, and nothing would ever have said so.
STRAY="$(find "$CODEX_HOME/shipyard" \( -name '*.bak' -o -name '*.orig' -o -name '*~' -o -name '.DS_Store' \) 2>/dev/null)"
[[ -z "$STRAY" ]] || { echo "generated bundle carries editor leftovers:"; echo "$STRAY"; exit 1; }

# ...and a re-install REPLACES the bundle rather than merging onto it. Copying
# over leaves everything the plugin has since deleted or renamed in place, still
# reachable by path — which is how the .bak files above survived an upgrade even
# after the generator learned to skip them.
touch "$CODEX_HOME/shipyard/scripts/removed-last-release.cjs"
bash scripts/install-shipyard-codex.sh --phase 2 >/dev/null
[[ ! -e "$CODEX_HOME/shipyard/scripts/removed-last-release.cjs" ]] \
  || { echo "re-install left a file the plugin no longer ships"; exit 1; }
[[ -e "$CODEX_HOME/shipyard/scripts/state-sync.cjs" ]] \
  || { echo "re-install lost the real payload"; exit 1; }

# The installer refreshes gsd-core by default — a superstructure that pins its
# base rots against it. But the opt-out must WORK, because the image relies on it
# to keep a pinned, reproducible toolchain (and because this smoke runs offline-ish
# against a throwaway HOME it prepared itself).
grep -q SHIPYARD_GSD_AUTO_INSTALL scripts/install-shipyard-codex.sh \
  || { echo "codex installer lost its gsd-core opt-out"; exit 1; }
grep -q SHIPYARD_GSD_AUTO_INSTALL=0 Dockerfile \
  || { echo "the image must opt out of the latest-gsd pull — it installs a pinned one"; exit 1; }

echo "codex-shipyard smoke: OK"
