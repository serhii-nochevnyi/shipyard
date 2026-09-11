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
GSD_CORE_VERSION="${GSD_CORE_VERSION:-1.13.0}"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
export HOME="$WORK"
CODEX_HOME="$WORK/.codex"
SKILLS="$WORK/.agents/skills"

echo "→ installing gsd-core@${GSD_CORE_VERSION} --codex (throwaway HOME)…"
npx --yes "@opengsd/gsd-core@${GSD_CORE_VERSION}" --codex --global </dev/null >/dev/null 2>&1 \
  || { echo "gsd-core --codex install failed (network?)"; exit 1; }
[[ -f "$CODEX_HOME/gsd-core/bin/gsd-tools.cjs" ]] || { echo "gsd-core not installed for codex"; exit 1; }

# ── an agent the operator wrote by hand, seeded before the first install ─────
# The reconciliation at the end of this file removes agent files a previous
# install claimed and this one no longer emits. The tempting implementation is a
# glob over the `shipyard-` prefix: it satisfies every orphan assertion below and
# deletes work that was never ours. So the discriminating case is seeded FIRST
# and asserted after every install — no shipyard manifest ever claims this file,
# and nothing in the installer may take it.
FOREIGN_AGENT="$CODEX_HOME/agents/shipyard-operators-own.toml"
mkdir -p "$CODEX_HOME/agents"
cat > "$FOREIGN_AGENT" <<'EOF'
# Hand-written by the operator. No shipyard manifest has ever claimed this file;
# it carries our prefix only because the operator liked the naming.
name = "shipyard-operators-own"
description = "an agent the operator wrote by hand"
sandbox_mode = "read-only"
EOF

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

# The palette's ceiling entry declares the Codex CLI version that can first
# CONFIGURE it, and below that version the generator writes the floor entry for
# every role — correct behaviour, but it would make every assertion below depend
# on whichever `codex` happens to be on this host (or on none being there at
# all). Pin the probe to exactly the version the palette asks for, read FROM the
# palette so this file carries no version literal of its own. The refusal path is
# unit-tested (tests/unit/gen-codex-shipyard.test.cjs), including the real
# `codex --version` probe against a stub on PATH.
PALETTE_FLOOR_MODEL="$(node -e 'process.stdout.write(require("./plugins/delivery-pipeline/scripts/pipeline-config.cjs").DEFAULT_CODEX_MODELS[0].model)')"
PALETTE_CEILING="$(node -e 'const p=require("./plugins/delivery-pipeline/scripts/pipeline-config.cjs").DEFAULT_CODEX_MODELS; const e=p[p.length-1]; process.stdout.write([e.model, e.effort||"", e.min_cli||"0.0.0"].join(" "))')"
read -r PALETTE_CEILING_MODEL PALETTE_CEILING_EFFORT PALETTE_CEILING_MIN_CLI <<<"$PALETTE_CEILING"
export SHIPYARD_CODEX_CLI_VERSION="$PALETTE_CEILING_MIN_CLI"

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
         scripts/usage-attribution.cjs scripts/usage-report.cjs \
         scripts/codex-agent.cjs \
         scripts/ticket-worktree.sh scripts/epic-branch.sh; do
  [[ -f "$CODEX_HOME/shipyard/$f" ]] || { echo "bundle missing $f"; exit 1; }
done
bash -n "$CODEX_HOME/shipyard/scripts/epic-branch.sh" || { echo "bundled epic-branch.sh syntax error"; exit 1; }
bash -n "$CODEX_HOME/shipyard/scripts/ticket-worktree.sh" || { echo "bundled ticket-worktree.sh syntax error"; exit 1; }
for f in state-sync log-event pipeline-stats usage-attribution usage-report ticket-pr-match frontmatter pipeline-config codex-agent; do
  node --check "$CODEX_HOME/shipyard/scripts/$f.cjs" || { echo "bundle $f.cjs fails node --check"; exit 1; }
done
# The bundled validator must be able to load its siblings from the bundle root.
# Capture first: it exits non-zero here by design, and `set -o pipefail` would
# report that instead of the grep result.
vg_out="$( ( cd "$WORK" && node -e 'require(process.argv[1])' "$CODEX_HOME/shipyard/scripts/validate-graph.cjs" 2>&1 ) || true )"
grep -q 'missing .planning' <<<"$vg_out" || { echo "bundled validate-graph.cjs cannot load its modules: $vg_out"; exit 1; }
# The model resolver travels with the bundle and only emits tier aliases.
# Run it from "$WORK" for the same reason validate-graph is run there: the
# resolver reads `<cwd>/.planning/config.json`, and this smoke's own cwd is the
# repo root, which BECAME a GSD project (`runtime: claude`) after this line was
# written. That config legitimately resolves the two judgment roles to `fable`,
# so the assertion started failing on a correct resolver. What is under test is
# that the bundled copy loads and answers with a tier alias — not what the host
# project happens to configure.
pc_tier="$( cd "$WORK" && node "$CODEX_HOME/shipyard/scripts/pipeline-config.cjs" model arch-review )"
[[ "$pc_tier" == opus ]] \
  || { echo "bundled pipeline-config.cjs does not resolve the judgment tier (got '$pc_tier', want 'opus')"; exit 1; }

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

# Runtime rollback snapshots are indexed in one file. Reject a target path whose
# name would corrupt that record instead of silently recording it twice.
BAD_AGENTS_MD="$(printf '%s' "$WORK")"$'\t'"agents.md"
if CODEX_AGENTS_MD="$BAD_AGENTS_MD" bash scripts/install-shipyard-codex.sh --phase 2 >"$WORK/bad-agents-md.log" 2>&1; then
  echo "installer accepted an AGENTS.md path it cannot snapshot safely"; exit 1
fi
grep -q 'refusing to snapshot a runtime path whose name cannot be recorded safely' "$WORK/bad-agents-md.log" \
  || { echo "unsafe AGENTS.md path was not refused honestly"; cat "$WORK/bad-agents-md.log"; exit 1; }

# agents present + registered; gsd agents intact. The active project policy is
# adaptive, so there are fifteen files: seven base agents, four recovery files,
# and four first-attempt critical files.
for a in shipyard-arch-review shipyard-ci-fix shipyard-drift-check shipyard-integrator shipyard-inv-research shipyard-pr-sentinel shipyard-review-fix \
         shipyard-ci-fix-deep shipyard-review-fix-deep shipyard-pr-sentinel-deep shipyard-arch-review-deep \
         shipyard-inv-research-critical shipyard-arch-review-critical shipyard-ci-fix-critical shipyard-review-fix-critical; do
  [[ -f "$CODEX_HOME/agents/$a.toml" ]] || { echo "missing agent $a.toml"; exit 1; }
  grep -q "^\[agents\.$a\]" "$CODEX_HOME/config.toml" || { echo "agent $a not registered in config.toml"; exit 1; }
done
# The integrator is already at the ceiling on every call — one per phase, largest
# input in the system — so it gets no escalation variant to be a dead file.
[[ ! -e "$CODEX_HOME/agents/shipyard-integrator-deep.toml" ]] \
  || { echo "shipyard-integrator-deep must not exist"; exit 1; }

# Every agent carries the model the palette implies and the effort its role asks
# for. This is the property the whole ticket exists for: before it, all seven
# agents carried whatever GSD's catalog said for one capped tier, so the judge and
# the drift check were the same model and the operator's palette was ignored.
agent_field() { grep -m1 "^$2 = " "$CODEX_HOME/agents/$1.toml" | sed 's/^[^=]*= "//; s/"$//'; }
check_agent() {
  local name="$1" want_model="$2" want_effort="$3" got_model got_effort
  got_model="$(agent_field "$name" model)"
  got_effort="$(agent_field "$name" model_reasoning_effort)"
  [[ "$got_model" == "$want_model" ]] \
    || { echo "$name: model is '$got_model', expected '$want_model'"; exit 1; }
  [[ "$got_effort" == "$want_effort" ]] \
    || { echo "$name: effort is '$got_effort', expected '$want_effort'"; exit 1; }
}
check_agent shipyard-drift-check "$PALETTE_FLOOR_MODEL" low
for a in shipyard-inv-research shipyard-ci-fix shipyard-review-fix shipyard-pr-sentinel shipyard-arch-review; do
  check_agent "$a" "$PALETTE_FLOOR_MODEL" high
done
check_agent shipyard-integrator "$PALETTE_CEILING_MODEL" "$PALETTE_CEILING_EFFORT"
for a in shipyard-ci-fix-deep shipyard-review-fix-deep shipyard-pr-sentinel-deep shipyard-arch-review-deep; do
  check_agent "$a" "$PALETTE_CEILING_MODEL" "$PALETTE_CEILING_EFFORT"
done
for a in shipyard-inv-research-critical shipyard-arch-review-critical shipyard-ci-fix-critical shipyard-review-fix-critical; do
  check_agent "$a" "$PALETTE_CEILING_MODEL" "$PALETTE_CEILING_EFFORT"
done

# The efforts retired on this runtime must not reappear: they cost more without a
# better result (measured), and `ultra` is not in the vocabulary at all.
if grep -hE '^model_reasoning_effort = "(xhigh|max|ultra)"' "$CODEX_HOME/agents"/shipyard-*.toml; then
  echo "a generated agent asks for an effort this runtime retired (above)"; exit 1
fi

# The variants are only reachable if the prose names them. Both artifact kinds
# carry it: the deliver SKILL the operator reads, and the guard's own agent file.
for role in ci-fix review-fix pr-sentinel arch-review; do
  grep -q "shipyard-$role-deep" "$SKILLS/shipyard-deliver/SKILL.md" \
    || { echo "the deliver skill never names shipyard-$role-deep"; exit 1; }
  grep -q "shipyard-$role-deep" "$CODEX_HOME/agents/shipyard-pr-sentinel.toml" \
    || { echo "the pr-sentinel agent never names shipyard-$role-deep"; exit 1; }
done
for role in inv-research arch-review ci-fix review-fix; do
  grep -q "shipyard-$role-critical" "$SKILLS/shipyard-deliver/SKILL.md" \
    || { echo "the deliver skill never names shipyard-$role-critical"; exit 1; }
done
grep -q 'repeat_exhausted' "$SKILLS/shipyard-deliver/SKILL.md" \
  || { echo "the deliver skill states no trigger for the repair escalation"; exit 1; }
grep -q 'repeat_exhausted' "$CODEX_HOME/agents/shipyard-pr-sentinel.toml" \
  || { echo "the pr-sentinel agent states no trigger for the repair escalation"; exit 1; }
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
  const eligible = roles.filter(([, , ph]) => Number(ph) <= 2);
  // …plus the escalation variant each escalating role gets. Derived from the
  // generator, for the same reason the role count is: a literal here rots the
  // moment a role joins either set.
  const deep = require("./scripts/gen-codex-shipyard.cjs").DEEP_ROLES;
  const critical = require("./scripts/gen-codex-shipyard.cjs").CRITICAL_ROLES;
  const pc = require("./plugins/delivery-pipeline/scripts/pipeline-config.cjs");
  const mode = pc.loadConfig(process.cwd()).config.model_ladder;
  const recovery = eligible.filter(([, role]) => deep.has(role)).length;
  const firstAttemptCritical = mode === "adaptive"
    ? eligible.filter(([, role]) => critical.has(role)).length
    : 0;
  console.log(eligible.length + recovery + firstAttemptCritical);
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
# The ownership record has to survive it too. Every real install runs
# `gsd-core --codex` immediately before reconciling (this file opts out with
# SHIPYARD_GSD_AUTO_INSTALL=0 so it can assert against a pinned converter), so if
# that step removed the record, every production install would report "no
# manifest from a previous install", reconcile nothing, and pass the two-stage
# test below forever.
[[ -f "$CODEX_HOME/agents/.shipyard-manifest.json" ]] \
  || { echo "a gsd-core reinstall deleted the ownership record — a real install runs one first, so reconciliation would never fire"; exit 1; }

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
# but still emits the phase-1 inv-research agent and its adaptive critical lane.
node scripts/gen-codex-shipyard.cjs --plugin plugins/delivery-pipeline \
  --out "$WORK/p1" --codex-home "$CODEX_HOME" --phase 1 >/dev/null
[[ ! -e "$WORK/p1/skills/shipyard-deliver" ]] || { echo "phase 1 leaked deliver skill"; exit 1; }
[[ ! -e "$WORK/p1/agents/shipyard-arch-review.toml" ]] || { echo "phase 1 leaked a phase-2 agent"; exit 1; }
[[ -e "$WORK/p1/agents/shipyard-inv-research.toml" ]] || { echo "phase 1 missing inv-research agent"; exit 1; }
[[ -e "$WORK/p1/agents/shipyard-inv-research-critical.toml" ]] || { echo "phase 1 missing adaptive critical inv-research agent"; exit 1; }
# `find`, not `ls`: with `set -o pipefail` a glob that matches nothing makes the
# whole substitution fail and takes the script down before it can assert.
P1_DEEP="$(find "$WORK/p1/agents" -name '*-deep.toml' | wc -l | tr -d ' ')"
[[ "$P1_DEEP" -eq 0 ]] || { echo "phase 1 emitted an escalation variant for a role it does not ship"; exit 1; }
# The global instructions must describe the same phase as the installed skills:
# phase 1 may route to decompose, but must not teach a user to invoke the absent
# deliver skill. Reinstall phase 2 afterwards so the rest of this smoke exercises
# the full palette.
PHASE1_AGENTS="$WORK/phase1-AGENTS.md"
CODEX_AGENTS_MD="$PHASE1_AGENTS" bash scripts/install-shipyard-codex.sh --phase 1 >/dev/null
grep -q 'large / multi-ticket -> `\$shipyard-decompose`; install phase 2 before delivery' "$PHASE1_AGENTS" \
  || { echo "phase 1 auto-route advertises an unavailable deliver skill"; exit 1; }
if grep -q '\$shipyard-decompose` -> `\$shipyard-deliver' "$PHASE1_AGENTS"; then
  echo "phase 1 auto-route still advertises shipyard-deliver"; exit 1
fi
bash scripts/install-shipyard-codex.sh --phase 2 >/dev/null

# ── a GSD remap still wins over the palette ──────────────────────────────────
# The claim the docs made and the generator never honoured: it read
# `runtimeTierDefaults` straight out of gsd-core's catalog, where no user key can
# reach, so a custom remap changed nothing. It is now resolved through GSD's OWN
# resolver — which is exactly why this belongs in the smoke and not only in the
# unit test: the unit test stubs that resolver, so only this asserts against the
# gsd-core actually installed. The project root is passed explicitly below, so
# generation can run from a worktree or another caller directory without
# silently selecting that directory's (possibly absent) policy; a project
# config still outranks ~/.gsd/defaults.json entirely.
mkdir -p "$WORK/remapproj/.planning"
cat > "$WORK/remapproj/.planning/config.json" <<'EOF'
{
  "runtime": "codex",
  "model_policy": { "runtime_tiers": { "codex": { "sonnet": "x-model" } } }
}
EOF
( cd "$WORK" && node "$ROOT/scripts/gen-codex-shipyard.cjs" \
    --plugin "$ROOT/plugins/delivery-pipeline" --out "$WORK/remap" \
    --codex-home "$CODEX_HOME" --phase 2 --project-dir "$WORK/remapproj" >/dev/null )
REMAP_AGENTS="$(find "$WORK/remap/agents" -name 'shipyard-*.toml' | wc -l | tr -d ' ')"
[[ "$REMAP_AGENTS" -gt 0 ]] || { echo "the remap run generated no agents at all"; exit 1; }
for f in "$WORK/remap/agents"/shipyard-*.toml; do
  grep -q '^model = "x-model"$' "$f" \
    || { echo "$(basename "$f") ignored the GSD remap: $(grep -m1 '^model = ' "$f" || echo 'no model key')"; exit 1; }
done
# One model for the whole tier leaves the escalation variant nothing to be, and a
# duplicate file that reads as an escalation is worse than no file at all.
REMAP_DEEP="$(find "$WORK/remap/agents" -name '*-deep.toml' | wc -l | tr -d ' ')"
[[ "$REMAP_DEEP" -eq 0 ]] || { echo "a remapped tier still produced $REMAP_DEEP duplicate -deep agents"; exit 1; }

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

# Agent files and registrations are one transaction. Force the merge helper to
# reject a duplicate foreign table after deliberately editing one generated
# agent. A copy-first installer would leave the fresh agent beside the old
# config; a rollback must preserve both the operator edit and the byte-for-byte
# config when validation fails.
ATOMIC_AGENT="$CODEX_HOME/agents/shipyard-arch-review.toml"
ATOMIC_AGENT_EXPECTED="$WORK/atomic-agent-expected"
ATOMIC_CONFIG_BEFORE="$WORK/atomic-config-before"
ATOMIC_CONFIG_EXPECTED="$WORK/atomic-config-expected"
ATOMIC_BUNDLE_BEFORE="$WORK/atomic-bundle-before"
ATOMIC_SKILL_BEFORE="$WORK/atomic-skill-before"
ATOMIC_MANIFEST_BEFORE="$WORK/atomic-manifest-before"
cp "$CODEX_HOME/config.toml" "$ATOMIC_CONFIG_BEFORE"
cp -a "$CODEX_HOME/shipyard" "$ATOMIC_BUNDLE_BEFORE"
cp -a "$SKILLS/shipyard-deliver" "$ATOMIC_SKILL_BEFORE"
cp "$CODEX_HOME/agents/.shipyard-manifest.json" "$ATOMIC_MANIFEST_BEFORE"
printf '\n# operator edit that a failed install must preserve\n' >> "$ATOMIC_AGENT"
cp "$ATOMIC_AGENT" "$ATOMIC_AGENT_EXPECTED"
printf '\n[shipyard-atomic-failure]\nvalue = "one"\n[shipyard-atomic-failure]\nvalue = "two"\n' >> "$CODEX_HOME/config.toml"
cp "$CODEX_HOME/config.toml" "$ATOMIC_CONFIG_EXPECTED"
if bash scripts/install-shipyard-codex.sh --phase 2 >"$WORK/atomic-failure.log" 2>&1; then
  echo "an invalid config unexpectedly let the installer commit"; exit 1
fi
cmp -s "$ATOMIC_CONFIG_EXPECTED" "$CODEX_HOME/config.toml" \
  || { echo "a failed agent/config transaction changed config.toml"; exit 1; }
cmp -s "$ATOMIC_AGENT_EXPECTED" "$ATOMIC_AGENT" \
  || { echo "a failed agent/config transaction did not roll back the agent file"; exit 1; }
cmp -s "$ATOMIC_MANIFEST_BEFORE" "$CODEX_HOME/agents/.shipyard-manifest.json" \
  || { echo "a failed install changed the agent ownership manifest"; exit 1; }
if ! diff -ruN "$ATOMIC_BUNDLE_BEFORE" "$CODEX_HOME/shipyard" >/dev/null; then
  echo "a failed install changed the bundle payload"; exit 1
fi
if ! diff -ruN "$ATOMIC_SKILL_BEFORE" "$SKILLS/shipyard-deliver" >/dev/null; then
  echo "a failed install changed the installed skill"; exit 1
fi
# Restore the valid fixture and prove the next install can still commit.
cp "$ATOMIC_CONFIG_BEFORE" "$CODEX_HOME/config.toml"
bash scripts/install-shipyard-codex.sh --phase 2 >/dev/null

# A failure AFTER the agent/config transaction must leave the already-installed
# skill, bundle and capability artifacts untouched while rolling back the
# earlier transaction. Force the later AGENTS.md update to fail and prove every
# earlier artifact is byte-identical.
ROLLBACK_SKILL="$SKILLS/shipyard-deliver/SKILL.md"
ROLLBACK_SKILL_EXTRA="$SKILLS/shipyard-deliver/operator-note.txt"
ROLLBACK_BUNDLE="$CODEX_HOME/shipyard/scripts/state-sync.cjs"
ROLLBACK_AGENT="$CODEX_HOME/agents/shipyard-arch-review.toml"
ROLLBACK_CONFIG="$CODEX_HOME/config.toml"
ROLLBACK_OLD_AGENT="$CODEX_HOME/agents/shipyard-old-variant.toml"
ROLLBACK_MANIFEST="$CODEX_HOME/agents/.shipyard-manifest.json"
ROLLBACK_CAPABILITY="$CAPDIR/checks/pipeline-config.cjs"
ROLLBACK_BROKEN_AGENTS_MD="$WORK/broken-agents-md"
printf '\n<!-- operator rollback marker -->\n' >> "$ROLLBACK_SKILL"
printf 'operator-only note\n' > "$ROLLBACK_SKILL_EXTRA"
printf '\n// operator rollback marker\n' >> "$ROLLBACK_BUNDLE"
printf '\n# operator rollback marker\n' >> "$ROLLBACK_AGENT"
printf '# previously generated variant\n' > "$ROLLBACK_OLD_AGENT"
printf '\n// operator capability rollback marker\n' >> "$ROLLBACK_CAPABILITY"
AGENT_MANIFEST="$ROLLBACK_MANIFEST" node - <<'NODE'
const fs = require('fs');
const file = process.env.AGENT_MANIFEST;
const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
manifest.agent_files.push('shipyard-old-variant.toml');
manifest.registrations = Array.isArray(manifest.registrations) ? manifest.registrations : [];
manifest.registrations.push('agents.shipyard-old-variant');
fs.writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
NODE
cp "$ROLLBACK_SKILL" "$WORK/rollback-skill-expected"
cp "$ROLLBACK_BUNDLE" "$WORK/rollback-bundle-expected"
cp "$ROLLBACK_AGENT" "$WORK/rollback-agent-expected"
cp "$ROLLBACK_OLD_AGENT" "$WORK/rollback-old-agent-expected"
cp "$ROLLBACK_CONFIG" "$WORK/rollback-config-expected"
cp "$ROLLBACK_MANIFEST" "$WORK/rollback-manifest-expected"
cp "$ROLLBACK_CAPABILITY" "$WORK/rollback-capability-expected"
mkdir -p "$ROLLBACK_BROKEN_AGENTS_MD"
if CODEX_AGENTS_MD="$ROLLBACK_BROKEN_AGENTS_MD" bash scripts/install-shipyard-codex.sh --phase 2 >"$WORK/late-failure.log" 2>&1; then
  echo "a late installer failure unexpectedly committed"; exit 1
fi
cmp -s "$WORK/rollback-skill-expected" "$ROLLBACK_SKILL" \
  || { echo "a late installer failure changed the installed skill"; exit 1; }
[[ -f "$ROLLBACK_SKILL_EXTRA" ]] \
  || { echo "a late installer failure unexpectedly touched operator-owned files inside the skill dir"; exit 1; }
cmp -s "$WORK/rollback-bundle-expected" "$ROLLBACK_BUNDLE" \
  || { echo "a late installer failure changed the installed bundle"; exit 1; }
cmp -s "$WORK/rollback-agent-expected" "$ROLLBACK_AGENT" \
  || { echo "a late installer failure changed the installed agent"; exit 1; }
cmp -s "$WORK/rollback-old-agent-expected" "$ROLLBACK_OLD_AGENT" \
  || { echo "a late installer failure did not restore an older manifest-owned agent"; exit 1; }
cmp -s "$WORK/rollback-config-expected" "$ROLLBACK_CONFIG" \
  || { echo "a late installer failure changed config.toml"; exit 1; }
cmp -s "$WORK/rollback-manifest-expected" "$ROLLBACK_MANIFEST" \
  || { echo "a late installer failure changed the ownership manifest"; exit 1; }
cmp -s "$WORK/rollback-capability-expected" "$ROLLBACK_CAPABILITY" \
  || { echo "a late installer failure changed the installed capability"; exit 1; }
bash scripts/install-shipyard-codex.sh --phase 2 >/dev/null

# ── an installer owns what it wrote (ADR-007 D5) ──────────────────────────────
# The palette's ceiling entry declares the Codex CLI version that can first
# CONFIGURE it, and below that version every role takes the floor — which leaves
# both kinds of adaptive variant nothing to BE (a `-deep` recovery file and a
# `-critical` first-attempt file are written only when they differ). Legitimate
# output, and exactly why removal cannot be inferred from a fixed agent count:
# the copy-over install left variant files behind, still registered, with "the
# file exists" certifying nothing.
#
# Derived from the palette, so this file still carries no version literal of its
# own — and it refuses loudly rather than silently testing nothing if the
# ceiling ever stops declaring a floor.
CLI_BELOW_CEILING="$(node -e '
  const p = require("./plugins/delivery-pipeline/scripts/pipeline-config.cjs").DEFAULT_CODEX_MODELS;
  const need = String((p[p.length - 1] || {}).min_cli || "");
  if (!need) { console.error("the palette ceiling declares no min_cli — nothing to shrink the palette with"); process.exit(1); }
  const parts = need.split(".").map(Number);
  if (!parts.every((n) => Number.isFinite(n))) { console.error("cannot parse version " + need); process.exit(1); }
  // Decrement the RIGHTMOST NON-ZERO component, not always the last one: a
  // ceiling of x.y.0 has no valid "below" version at the last component alone
  // (it would go negative), so borrow from the next component leftward — the
  // same rule a version number carries every time a patch digit rolls under.
  // Trailing components are then set high so the borrow cannot be erased by
  // them: comparison here is numeric, component by component (gen-codex-
  // shipyards own compareVersions), so 1.1.999 < 1.2.0 exactly as 1.2.0 < 1.2.1.
  let i = parts.length - 1;
  while (i >= 0 && parts[i] === 0) i -= 1;
  if (i < 0) { console.error("cannot derive a version below " + need); process.exit(1); }
  parts[i] -= 1;
  for (let j = i + 1; j < parts.length; j++) parts[j] = 999;
  process.stdout.write(parts.join("."));
')"
DEEP_AGENTS=(shipyard-ci-fix-deep shipyard-review-fix-deep shipyard-pr-sentinel-deep shipyard-arch-review-deep)
CRITICAL_AGENTS=(shipyard-inv-research-critical shipyard-arch-review-critical shipyard-ci-fix-critical shipyard-review-fix-critical)
VARIANT_AGENTS=("${DEEP_AGENTS[@]}" "${CRITICAL_AGENTS[@]}")
PLAIN_AGENTS=(shipyard-arch-review shipyard-ci-fix shipyard-drift-check shipyard-integrator
              shipyard-inv-research shipyard-pr-sentinel shipyard-review-fix)
AGENT_MANIFEST="$CODEX_HOME/agents/.shipyard-manifest.json"
manifest_claims() {
  node -e '
    const fs = require("fs");
    let m = {};
    try { m = JSON.parse(fs.readFileSync(process.argv[1], "utf8")); } catch { process.stdout.write("unreadable"); process.exit(0); }
    const list = Array.isArray(m[process.argv[2]]) ? m[process.argv[2]] : [];
    process.stdout.write(list.includes(process.argv[3]) ? "yes" : "no");
  ' "$AGENT_MANIFEST" "$1" "$2"
}

# stage 1: the whole palette. The active adaptive policy emits all variants, and
# the ownership record must claim them before the shrink can reconcile them.
bash scripts/install-shipyard-codex.sh --phase 2 >/dev/null
for a in "${VARIANT_AGENTS[@]}"; do
  [[ -f "$CODEX_HOME/agents/$a.toml" ]] \
    || { echo "stage 1 emitted no $a.toml — the two-stage reconciliation test has nothing to reconcile"; exit 1; }
done

# stage 2: the same install with the ceiling out of the CLI's reach.
SHIPYARD_CODEX_CLI_VERSION="$CLI_BELOW_CEILING" \
  bash scripts/install-shipyard-codex.sh --phase 2 >"$WORK/shrunk.log" 2>&1 \
  || { echo "the shrunk-palette install failed:"; cat "$WORK/shrunk.log"; exit 1; }
for a in "${VARIANT_AGENTS[@]}"; do
  [[ ! -e "$CODEX_HOME/agents/$a.toml" ]] \
    || { echo "orphan agent file survived a shrunk palette: $a.toml"; exit 1; }
  # Both halves, because either alone is a broken host: a registration whose
  # file is gone cannot start, and a file whose registration is gone is inert.
  grep -q "^\[agents\.$a\]" "$CODEX_HOME/config.toml" \
    && { echo "orphan registration survived a shrunk palette: [agents.$a]"; exit 1; } || true
  grep -q "$a.toml" "$WORK/shrunk.log" \
    || { echo "the installer removed $a.toml without saying so"; exit 1; }
  # …and it names the registration that went with it, from the record's own
  # `registrations` list — a field the generator writes and nobody reads is a
  # mechanism nobody connected.
  grep -q "their registrations went with the fragment above:.*agents\.$a" "$WORK/shrunk.log" \
    || { echo "the installer never named the registration removed with $a.toml"; exit 1; }
done
# …and the shrink was real, not a generator that quietly emitted nothing: the
# manifest is the record of what this install claims, and it is what the NEXT
# one reconciles against.
[[ -f "$AGENT_MANIFEST" ]] || { echo "the installer wrote no ownership manifest ($AGENT_MANIFEST)"; exit 1; }
for a in "${VARIANT_AGENTS[@]}"; do
  [[ "$(manifest_claims agent_files "$a.toml")" == no ]] \
    || { echo "the shrunk install still claims $a.toml — the palette never shrank, so nothing was under test"; exit 1; }
done
for a in "${PLAIN_AGENTS[@]}"; do
  [[ -f "$CODEX_HOME/agents/$a.toml" ]] \
    || { echo "the reconciliation removed an agent this install DOES emit: $a.toml"; exit 1; }
  grep -q "^\[agents\.$a\]" "$CODEX_HOME/config.toml" \
    || { echo "the shrunk install left $a unregistered"; exit 1; }
  [[ "$(manifest_claims agent_files "$a.toml")" == yes ]] \
    || { echo "the manifest does not claim $a.toml, so the next install cannot take it back"; exit 1; }
  [[ "$(manifest_claims registrations "agents.$a")" == yes ]] \
    || { echo "the manifest does not claim the registration agents.$a"; exit 1; }
done
# OWNERSHIP IS THE MANIFEST'S, NOT THE PREFIX'S. This is the assertion a glob
# implementation fails and every other one here passes.
[[ -f "$FOREIGN_AGENT" ]] \
  || { echo "the reconciliation deleted $FOREIGN_AGENT — an agent file no manifest ever claimed"; exit 1; }

# NO PREVIOUS MANIFEST IS NOT LICENCE TO SWEEP. A first install, or an install
# over a hand-made ~/.codex, removes nothing — the alternative deletes an
# operator's own agents — and says which files it is leaving alone, because
# silence here reads as "there was nothing there".
bash scripts/install-shipyard-codex.sh --phase 2 >/dev/null
rm -f "$AGENT_MANIFEST"
SHIPYARD_CODEX_CLI_VERSION="$CLI_BELOW_CEILING" \
  bash scripts/install-shipyard-codex.sh --phase 2 >"$WORK/nomanifest.log" 2>&1 \
  || { echo "the install over a manifest-less agents dir failed:"; cat "$WORK/nomanifest.log"; exit 1; }
for a in "${VARIANT_AGENTS[@]}"; do
  [[ -f "$CODEX_HOME/agents/$a.toml" ]] \
    || { echo "with no previous manifest the installer removed $a.toml anyway"; exit 1; }
done
[[ -f "$FOREIGN_AGENT" ]] || { echo "an install with no previous manifest deleted $FOREIGN_AGENT"; exit 1; }
grep -q 'no manifest from a previous install' "$WORK/nomanifest.log" \
  || { echo "the installer removed nothing and never said why"; exit 1; }
for f in shipyard-ci-fix-deep.toml shipyard-ci-fix-critical.toml "$(basename "$FOREIGN_AGENT")"; do
  grep -q "Leaving alone:.*$f" "$WORK/nomanifest.log" \
    || { echo "the installer left $f in place without naming it"; exit 1; }
done

# A record that cannot be READ is not a record. `copyFileSync` is not atomic, so
# an install killed mid-write leaves a truncated manifest on a real host — and a
# half-parsed claim must land in the same place as no claim at all rather than in
# a list of files to delete.
bash scripts/install-shipyard-codex.sh --phase 2 >/dev/null
printf '{ "agent_files": [ "shipyard-ci-f' > "$AGENT_MANIFEST"
SHIPYARD_CODEX_CLI_VERSION="$CLI_BELOW_CEILING" \
  bash scripts/install-shipyard-codex.sh --phase 2 >"$WORK/corrupt.log" 2>&1 \
  || { echo "an install over a truncated manifest failed:"; cat "$WORK/corrupt.log"; exit 1; }
for a in "${VARIANT_AGENTS[@]}"; do
  [[ -f "$CODEX_HOME/agents/$a.toml" ]] \
    || { echo "a truncated manifest was read as licence to remove $a.toml"; exit 1; }
done
[[ -f "$FOREIGN_AGENT" ]] || { echo "an install over a truncated manifest deleted $FOREIGN_AGENT"; exit 1; }
# …and it heals: the record is rewritten, so the NEXT install reconciles again.
[[ "$(manifest_claims agent_files "shipyard-drift-check.toml")" == yes ]] \
  || { echo "the installer left the truncated manifest in place — the next install would reconcile against nothing"; exit 1; }

# The installer refreshes gsd-core by default — a superstructure that pins its
# base rots against it. But the opt-out must WORK, because the image relies on it
# to keep a pinned, reproducible toolchain (and because this smoke runs offline-ish
# against a throwaway HOME it prepared itself).
grep -q SHIPYARD_GSD_AUTO_INSTALL scripts/install-shipyard-codex.sh \
  || { echo "codex installer lost its gsd-core opt-out"; exit 1; }
grep -q SHIPYARD_GSD_AUTO_INSTALL=0 Dockerfile \
  || { echo "the image must opt out of the latest-gsd pull — it installs a pinned one"; exit 1; }

echo "codex-shipyard smoke: OK"
