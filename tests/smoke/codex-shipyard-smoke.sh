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
for f in scripts/gen-codex-shipyard.cjs scripts/merge-codex-config.cjs scripts/install-shipyard-codex.sh \
         plugins/delivery-pipeline/scripts/runtime-context.cjs \
         plugins/delivery-pipeline/scripts/gsd-sync.cjs capabilities/delivery-pipeline/checks/gsd-sync-gate.cjs; do
  [[ -f "$f" ]] || { echo "missing $f"; exit 1; }
done
node --check scripts/gen-codex-shipyard.cjs
node --check scripts/merge-codex-config.cjs
node --check plugins/delivery-pipeline/scripts/gsd-tune.cjs
node --check plugins/delivery-pipeline/scripts/dispatch-record.cjs
node --check plugins/delivery-pipeline/scripts/gsd-sync.cjs
node --check capabilities/delivery-pipeline/checks/gsd-sync-gate.cjs
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
# than the one it installed. Most installs use this explicit host fixture; a
# later call deliberately unsets it to exercise the installer's bare-install
# provisioning path.
export SHIPYARD_GSD_AUTO_INSTALL=0

# Explicit host capability fixture, independent of the compatibility palette.
export SHIPYARD_CODEX_CAPABILITIES_FILE="$WORK/codex-capabilities.json"
node - "$SHIPYARD_CODEX_CAPABILITIES_FILE" <<'NODE'
const fs = require('fs');
const policy = require('./plugins/delivery-pipeline/scripts/model-policy.cjs');
const selections = Object.values(policy.CODEX_ROLE_RUNG_DEFINITIONS).flat().map((rung) => ({
  model: policy.CODEX_MODEL_IDS[rung.model_key], effort: rung.effort,
}));
fs.writeFileSync(process.argv[2], JSON.stringify({
  supportedModels: [...new Set(selections.map((s) => s.model))],
  supportedEfforts: [...new Set(selections.map((s) => s.effort))], supportedSelections: selections,
}));
NODE

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
for f in "$SKILLS/shipyard-deliver/SKILL.md" "$CODEX_HOME/agents/shipyard-pr-sentinel.toml"; do
  if grep -Eq 'inv-research-critical|pr-sentinel-deep|arch-review-deep' "$f"; then
    echo "canonical Codex instructions name a non-emitted variant: $f"; exit 1
  fi
done
grep -q 'shipyard-integrator-critical' "$SKILLS/shipyard-deliver/SKILL.md" \
  || { echo "canonical deliver instructions omit integrator-critical"; exit 1; }

# A documented bare install must still pass the same capability gate. The
# installer provisions a complete canonical contract only when no explicit host
# evidence is supplied; it never disables validation.
env -u SHIPYARD_CODEX_CAPABILITIES_FILE bash scripts/install-shipyard-codex.sh --phase 2 >/dev/null
[[ -f "$CODEX_HOME/agents/.shipyard-manifest.json" ]] \
  || { echo "bare install did not produce an ownership manifest"; exit 1; }

# bundle payload carries the deterministic scripts (incl. the telemetry layer)
# and they are valid node — the deliver skill calls them via the rewritten root
for f in scripts/state-sync.cjs scripts/reviewers.cjs scripts/validate-graph.cjs scripts/front.cjs \
         scripts/ticket-pr-match.cjs scripts/log-event.cjs scripts/pipeline-stats.cjs \
         scripts/usage-attribution.cjs scripts/usage-report.cjs \
         scripts/codex-agent.cjs \
         scripts/gsd-sync.cjs \
         scripts/ticket-worktree.sh scripts/epic-branch.sh; do
  [[ -f "$CODEX_HOME/shipyard/$f" ]] || { echo "bundle missing $f"; exit 1; }
done
[[ -f "$CODEX_HOME/shipyard/skills/delivery-rules/SKILL.md" ]] \
  || { echo "bundle missing the runtime-neutral delivery-rules source"; exit 1; }
bash -n "$CODEX_HOME/shipyard/scripts/epic-branch.sh" || { echo "bundled epic-branch.sh syntax error"; exit 1; }
bash -n "$CODEX_HOME/shipyard/scripts/ticket-worktree.sh" || { echo "bundled ticket-worktree.sh syntax error"; exit 1; }
for f in state-sync log-event pipeline-stats usage-attribution usage-report ticket-pr-match frontmatter pipeline-config codex-agent gsd-sync; do
  node --check "$CODEX_HOME/shipyard/scripts/$f.cjs" || { echo "bundle $f.cjs fails node --check"; exit 1; }
done
cmp -s plugins/delivery-pipeline/scripts/gsd-sync.cjs "$CODEX_HOME/shipyard/scripts/gsd-sync.cjs" \
  || { echo "bundled gsd-sync.cjs differs from the canonical script"; exit 1; }

# The same bundled synchronizer must execute from an isolated conveyor project,
# not merely exist in the payload. This proves its sibling parser/lock modules
# travel with it and that write/check semantics are runtime-neutral.
SYNC_FIXTURE="$WORK/gsd-sync-fixture"
node - "$SYNC_FIXTURE" <<'NODE'
const fs = require('fs');
const path = require('path');
const root = process.argv[2];
const write = (name, value) => {
  const file = path.join(root, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, value);
};
write('.planning/PROJECT.md', '# Project\n\n## Core Value\nA truthful conveyor\n');
write('.planning/ROADMAP.md', '# Roadmap\n\n## Requirements\n\n- **SYNC-01** — Native state follows delivery evidence.\n\n### Phase 1: Foundation\n**Requirements**: SYNC-01\n');
write('.planning/phases/01-foundation/01-01-PLAN.md', '---\nphase: 1\nplan: 1\ntitle: Foundation\nrequirements: [SYNC-01]\ndelivery:\n  ticket: T-01-01\n  risk: low\n---\n');
write('.planning/phases/01-foundation/INTEGRATION.md', '# Integration\n\nVerdict: passed\n');
write('.planning/graph/tickets.json', JSON.stringify({ tickets: { 'T-01-01': { phase: '1' } } }));
write('.planning/graph/delivery-state.json', JSON.stringify({ 'T-01-01': { status: 'merged', since: '2026-09-10T10:00:00Z' } }));
NODE
SYNC_WRITE=""
SYNC_WRITE="$(cd "$SYNC_FIXTURE" && node "$CODEX_HOME/shipyard/scripts/gsd-sync.cjs" --json)" \
  || { echo "bundled gsd-sync write failed: $SYNC_WRITE"; exit 1; }
grep -q '"ok":true' <<<"$SYNC_WRITE" || { echo "bundled gsd-sync write was not successful: $SYNC_WRITE"; exit 1; }
SYNC_CHECK=""
SYNC_CHECK="$(cd "$SYNC_FIXTURE" && node "$CODEX_HOME/shipyard/scripts/gsd-sync.cjs" --check --json)" \
  || { echo "bundled gsd-sync check failed: $SYNC_CHECK"; exit 1; }
grep -q '"ok":true' <<<"$SYNC_CHECK" || { echo "bundled gsd-sync check was not clean: $SYNC_CHECK"; exit 1; }
# The bundled validator must be able to load its siblings from the bundle root.
# Capture first: it exits non-zero here by design, and `set -o pipefail` would
# report that instead of the grep result.
vg_out="$( ( cd "$WORK" && node -e 'require(process.argv[1])' "$CODEX_HOME/shipyard/scripts/validate-graph.cjs" 2>&1 ) || true )"
grep -q 'missing .planning' <<<"$vg_out" || { echo "bundled validate-graph.cjs cannot load its modules: $vg_out"; exit 1; }
# The model resolver travels with the bundle and only emits tier aliases.
# Run it from "$WORK" for the same reason validate-graph is run there: the
# resolver reads `<cwd>/.planning/config.json`. The bundled script is itself
# under the throwaway Codex home, so runtime-context must identify Codex from
# that path even though the fixture has no persisted project runtime. On Codex
# the runtime cap deliberately maps the judgment tier to `sonnet`; this checks
# the active-runtime policy rather than the old ambiguous-runtime fallback.
pc_tier="$( cd "$WORK" && node "$CODEX_HOME/shipyard/scripts/pipeline-config.cjs" model arch-review )"
[[ "$pc_tier" == sonnet ]] \
  || { echo "bundled pipeline-config.cjs does not resolve the Codex judgment tier (got '$pc_tier', want 'sonnet')"; exit 1; }

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

# Every static role/rung, fingerprint and registration comes from ADR-014.
EXPECTED_AGENTS="$(node - "$CODEX_HOME" <<'NODE'
const fs = require('fs');
const path = require('path');
const assert = require('assert/strict');
const policy = require('./plugins/delivery-pipeline/scripts/model-policy.cjs');
const { codexStaticVariants } = require('./plugins/delivery-pipeline/scripts/gsd-tune.cjs');
const home = process.argv[2];
const manifest = JSON.parse(fs.readFileSync(path.join(home, 'agents/.shipyard-manifest.json')));
assert.equal(manifest.policy_hash, policy.POLICY_HASH);
assert.equal(manifest.policy_version, policy.POLICY_VERSION);
const variants = codexStaticVariants(2);
assert.deepEqual(manifest.agent_files, variants.map((v) => v.file));
const config = fs.readFileSync(path.join(home, 'config.toml'), 'utf8');
for (const v of variants) {
  const text = fs.readFileSync(path.join(home, 'agents', v.file), 'utf8');
  assert.ok(text.includes('model = ' + JSON.stringify(v.model) + '\n'));
  assert.ok(text.includes('model_reasoning_effort = ' + JSON.stringify(v.effort) + '\n'));
  assert.ok(text.includes('# shipyard-policy-rung = ' + JSON.stringify(v.rung)));
  assert.equal(require('crypto').createHash('sha256').update(text).digest('hex'), manifest.agent_digests[v.file]);
  assert.ok(config.includes('[agents.' + v.file.replace(/\.toml$/, '') + ']'));
}
for (const role of policy.DYNAMIC_ROLES) {
  for (const rung of policy.CODEX_ROLE_RUNG_DEFINITIONS[role]) {
    assert.ok(!fs.existsSync(path.join(home, 'agents', policy.codexAgentFile(role, rung.name))));
  }
}
assert.equal(require(path.join(home, 'shipyard/scripts/model-policy.cjs')).POLICY_HASH, policy.POLICY_HASH);
for (const file of manifest.skill_files) {
  const text = fs.readFileSync(path.join(home, '..', '.agents', 'skills', file), 'utf8');
  assert.equal(require('crypto').createHash('sha256').update(text).digest('hex'), manifest.skill_file_digests[file]);
}
for (const file of manifest.bundle_files) {
  const text = fs.readFileSync(path.join(home, 'shipyard', file), 'utf8');
  assert.equal(require('crypto').createHash('sha256').update(text).digest('hex'), manifest.bundle_digests[file]);
}
console.log(variants.length);
NODE
)"
[[ "$(gsd_owned_state)" == "$GSD_BEFORE" ]] \
  || { echo "gsd-core-owned state drifted"; exit 1; }

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
[[ -f "$CAPDIR/checks/gsd-sync-gate.cjs" ]] || { echo "capability missing gsd-sync gate"; exit 1; }

# Exercise the installed lifecycle launcher as well as the bundled writer. The
# launcher must resolve its sibling synchronizer from the installed capability,
# publish a clean projection, and block ship:pre once a source plan drifts.
GATE_WRITE=""
GATE_WRITE="$(cd "$SYNC_FIXTURE" && node "$CAPDIR/checks/gsd-sync-gate.cjs" write)" \
  || { echo "installed gsd-sync gate write failed: $GATE_WRITE"; exit 1; }
grep -q 'projection published' <<<"$GATE_WRITE" \
  || { echo "installed gsd-sync gate did not publish: $GATE_WRITE"; exit 1; }
GATE_CHECK=""
GATE_CHECK="$(cd "$SYNC_FIXTURE" && node "$CAPDIR/checks/gsd-sync-gate.cjs" check)" \
  || { echo "installed gsd-sync gate check failed: $GATE_CHECK"; exit 1; }
printf '\nsource drift\n' >> "$SYNC_FIXTURE/.planning/phases/01-foundation/01-01-PLAN.md"
if ( cd "$SYNC_FIXTURE" && node "$CAPDIR/checks/gsd-sync-gate.cjs" check >/dev/null 2>&1 ); then
  echo "installed gsd-sync gate let stale projection pass"; exit 1
fi

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

# Compatibility remaps must not weaken the canonical runtime ladder.
mkdir -p "$WORK/remapproj/.planning"
node - "$WORK/remapproj/.planning/config.json" <<'NODE'
require('fs').writeFileSync(process.argv[2], JSON.stringify({
  model_policy: { runtime_tiers: { codex: { sonnet: 'x-model' } } },
}));
NODE
SHIPYARD_PROJECT_DIR="$WORK/remapproj" bash scripts/install-shipyard-codex.sh --phase 2 >/dev/null
if grep -q '^model = "x-model"$' "$CODEX_HOME/agents/shipyard-arch-review.toml"; then
  echo "compatibility remap weakened the canonical ladder"; exit 1
fi

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

# A generated agent replaces the destination entry itself. If an operator has
# linked that entry elsewhere, the install must not follow the link and mutate
# the external file while believing it replaced an installer-owned agent.
AGENT_SYMLINK="$CODEX_HOME/agents/shipyard-arch-review.toml"
AGENT_SYMLINK_TARGET="$WORK/operator-agent-target.toml"
printf '# operator-owned agent target\n' > "$AGENT_SYMLINK_TARGET"
rm -f "$AGENT_SYMLINK"
ln -s "$AGENT_SYMLINK_TARGET" "$AGENT_SYMLINK"
bash scripts/install-shipyard-codex.sh --phase 2 >/dev/null
[[ ! -L "$AGENT_SYMLINK" && -f "$AGENT_SYMLINK" ]] \
  || { echo "the generated agent install left a destination symlink in place"; exit 1; }
grep -q '^# operator-owned agent target$' "$AGENT_SYMLINK_TARGET" \
  || { echo "the generated agent install followed a destination symlink"; exit 1; }

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

# Reconcile obsolete owned variants while preserving unclaimed files and GSD.
AGENT_MANIFEST="$CODEX_HOME/agents/.shipyard-manifest.json"
printf '# obsolete owned variant\n' > "$CODEX_HOME/agents/shipyard-obsolete.toml"
node - "$AGENT_MANIFEST" <<'NODE'
const fs = require('fs');
const p = process.argv[2];
const m = JSON.parse(fs.readFileSync(p));
m.agent_files.push('shipyard-obsolete.toml');
m.registrations.push('agents.shipyard-obsolete');
fs.writeFileSync(p, JSON.stringify(m));
NODE
bash scripts/install-shipyard-codex.sh --phase 2 >"$WORK/reconcile.log"
[[ ! -e "$CODEX_HOME/agents/shipyard-obsolete.toml" ]] || { echo "obsolete agent survived"; exit 1; }
[[ -f "$FOREIGN_AGENT" ]] || { echo "foreign agent removed"; exit 1; }
[[ "$(gsd_owned_state)" == "$GSD_BEFORE" ]] || { echo "foreign GSD agents changed"; exit 1; }

# Missing/corrupt ownership records cannot authorize removal of foreign files.
for state in missing corrupt; do
  if [[ "$state" == missing ]]; then rm -f "$AGENT_MANIFEST"; else printf '{' > "$AGENT_MANIFEST"; fi
  bash scripts/install-shipyard-codex.sh --phase 2 >"$WORK/$state.log"
  [[ -f "$FOREIGN_AGENT" ]] || { echo "foreign agent removed with $state manifest"; exit 1; }
  grep -q 'no manifest from a previous install' "$WORK/$state.log" || { echo "missing ownership warning"; exit 1; }
done

# Exercise installer preflight, not just the validator API: corrupt the stage
# immediately after generation, then compare the entire destination on refusal.
REAL_NODE="$(command -v node)"
export REAL_NODE
mkdir -p "$WORK/preflight-bin"
node - "$WORK/preflight-bin/node" <<'NODE'
const fs = require('fs');
fs.writeFileSync(process.argv[2], '#!/usr/bin/env bash\n' +
  '"$REAL_NODE" "$@"\nstatus=$?\n[[ "$status" == 0 ]] || exit "$status"\n' +
  'if [[ "$1" == */scripts/gen-codex-shipyard.cjs ]]; then\n' +
  '  shift; while [[ "$#" -gt 0 ]]; do if [[ "$1" == --out ]]; then out="$2"; break; fi; shift; done\n' +
  '  "$REAL_NODE" "$SHIPYARD_TAMPER_SCRIPT" "$out" "$SHIPYARD_TAMPER_MODE"\nfi\n');
fs.chmodSync(process.argv[2], 0o755);
NODE
export SHIPYARD_TAMPER_SCRIPT="$WORK/tamper.cjs"
node - "$SHIPYARD_TAMPER_SCRIPT" <<'NODE'
require('fs').writeFileSync(process.argv[2], `
const fs = require('fs'), path = require('path');
const root = process.argv[2], mode = process.argv[3];
const p = path.join(root, 'manifest.json');
const m = JSON.parse(fs.readFileSync(p));
if (mode === 'missing') fs.unlinkSync(path.join(root, 'agents', m.agent_files[0]));
if (mode === 'stale') m.policy_hash = '0'.repeat(64);
if (mode === 'unregistered') fs.writeFileSync(path.join(root, 'config.fragment.toml'), '');
if (mode === 'model-less') {
  const file = path.join(root, 'agents', m.agent_files[0]);
  const text = fs.readFileSync(file, 'utf8').replace(/^model = .*\\n/m, '');
  fs.writeFileSync(file, text);
  m.agent_digests[m.agent_files[0]] = require('crypto').createHash('sha256').update(text).digest('hex');
}
fs.writeFileSync(p, JSON.stringify(m));
`);
NODE
cp -a "$CODEX_HOME" "$WORK/preflight-before"
for mode in missing stale unregistered model-less; do
  if PATH="$WORK/preflight-bin:$PATH" SHIPYARD_TAMPER_MODE="$mode" \
    bash scripts/install-shipyard-codex.sh --phase 2 >"$WORK/preflight-$mode.log" 2>&1; then
    echo "installer accepted $mode bundle"; exit 1
  fi
  grep -q 'Codex bundle refused' "$WORK/preflight-$mode.log" || { cat "$WORK/preflight-$mode.log"; exit 1; }
  diff -ruN "$WORK/preflight-before" "$CODEX_HOME" >/dev/null || { echo "$mode refusal changed destination"; exit 1; }
done
printf '{"supportedModels":[],"supportedEfforts":[]}' > "$WORK/incapable.json"
if SHIPYARD_CODEX_CAPABILITIES_FILE="$WORK/incapable.json" \
  bash scripts/install-shipyard-codex.sh --phase 2 >"$WORK/incapable.log" 2>&1; then
  echo "installer accepted incapable host"; exit 1
fi
diff -ruN "$WORK/preflight-before" "$CODEX_HOME" >/dev/null || { echo "capability refusal changed destination"; exit 1; }

# The installer refreshes gsd-core by default — a superstructure that pins its
# base rots against it. But the opt-out must WORK, because the image relies on it
# to keep a pinned, reproducible toolchain (and because this smoke runs offline-ish
# against a throwaway HOME it prepared itself).
grep -q SHIPYARD_GSD_AUTO_INSTALL scripts/install-shipyard-codex.sh \
  || { echo "codex installer lost its gsd-core opt-out"; exit 1; }
grep -q SHIPYARD_GSD_AUTO_INSTALL=0 Dockerfile \
  || { echo "the image must opt out of the latest-gsd pull — it installs a pinned one"; exit 1; }

echo "codex-shipyard smoke: OK"
