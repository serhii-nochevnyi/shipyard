#!/usr/bin/env bash
set -euo pipefail

# End-to-end contract for Gate 2 (validate-graph.cjs) and its plan:post gate
# launcher (graph-gate.cjs), driven through fixture projects on disk.
#
# Fast: no Docker, no network, no GitHub. Run it on every edit to the validator.

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
VALIDATOR="$ROOT/plugins/delivery-pipeline/scripts/validate-graph.cjs"
GATE="$ROOT/capabilities/delivery-pipeline/checks/graph-gate.cjs"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

pass=0
fail=0
ok()   { pass=$((pass + 1)); echo "  ✓ $1"; }
bad()  { fail=$((fail + 1)); echo "  ✗ $1"; [[ -n "${2:-}" ]] && echo "$2" | sed 's/^/      /'; }

# plan <project> <file> <ticket> <deps> <files> <reqs> [risk] [checkpoint] \
#      [extra frontmatter line] [extra line INSIDE the delivery block]
plan() {
  local proj="$1" file="$2" ticket="$3" deps="$4" files="$5" reqs="$6"
  local risk="${7:-low}" cp="${8:-false}" extra="${9:-}" dextra="${10:-}"
  local dir="$WORK/$proj/.planning/phases/${file%%/*}"
  mkdir -p "$dir"
  {
    echo '---'
    echo "phase: ${file%%-*}"
    echo "title: \"Ticket $ticket\""
    echo 'type: implementation'
    echo "depends_on: [$deps]"
    echo "files_modified: [$files]"
    echo "requirements: [$reqs]"
    [[ -n "$extra" ]] && echo "$extra"
    echo 'delivery:'
    echo "  ticket: $ticket"
    echo "  risk: $risk"
    echo "  human_checkpoint: $cp"
    [[ -n "$dextra" ]] && echo "  $dextra"
    echo '---'
    echo '## Goal'
    echo 'x'
  } > "$WORK/$proj/.planning/phases/${file}"
}

# make a phase dir path helper: plan takes "<phasedir>/<name>-PLAN.md"
mkproj() { mkdir -p "$WORK/$1/.planning/phases"; }

# Stage the capability exactly as the installers do (Dockerfile / install-shipyard-codex.sh):
# the gate plus the WHOLE .cjs set, so the validator can load its siblings.
CAP_STAGE="$WORK/capability/delivery-pipeline"
mkdir -p "$CAP_STAGE/checks"
cp -R "$ROOT/capabilities/delivery-pipeline/." "$CAP_STAGE/"
cp "$ROOT"/plugins/delivery-pipeline/scripts/*.cjs "$CAP_STAGE/checks/"
STAGED_GATE="$CAP_STAGE/checks/graph-gate.cjs"

run_validator() { ( cd "$WORK/$1" && node "$VALIDATOR" 2>&1 ); }
# HOME is redirected at a scratch dir so the host's real ~/.claude plugin cache
# (possibly holding an older shipyard release) can never be picked up instead.
run_gate() {
  mkdir -p "$WORK/fakehome"
  ( cd "$WORK/$1" && HOME="$WORK/fakehome" GSD_CAP_DIR="$CAP_STAGE" node "$STAGED_GATE" 2>&1 )
}

# `set -o pipefail` is on, so `run_validator x | grep …` would report the
# validator's own non-zero exit rather than the grep result. Capture, then match.
# rejects <project> <expected substring> <label>
rejects() {
  local out
  if out="$(run_validator "$1")"; then
    bad "$3" "expected a non-zero exit, got:
$out"
    return
  fi
  if grep -q "$2" <<<"$out"; then ok "$3"; else bad "$3 (wrong reason)" "$out"; fi
}

echo "graph-validator smoke"

# ── 1. the diamond regression ───────────────────────────────────────────────
# Apex has the LOWEST id, and the two mid tickets share a file with the root they
# both properly depend on. The old shared-visited memo cached an EMPTY ancestor
# set for the second branch and reported the ordered pair as unordered.
mkproj diamond
mkdir -p "$WORK/diamond/.planning/phases/01-x"
plan diamond '01-x/01-PLAN.md' T-01-01 'T-01-02, T-01-03' 'src/a.ts'      REQ-1
plan diamond '01-x/02-PLAN.md' T-01-02 'T-01-04'          'src/b.ts'      REQ-2
plan diamond '01-x/03-PLAN.md' T-01-03 'T-01-04'          'src/shared.ts' REQ-3
plan diamond '01-x/04-PLAN.md' T-01-04 ''                 'src/shared.ts' REQ-4
if out="$(run_validator diamond)"; then
  ok "a diamond with an ordered overlapping pair passes"
else
  bad "a diamond with an ordered overlapping pair passes" "$out"
fi

# ── 2. a genuinely unordered overlap must still be caught ───────────────────
mkproj overlap
mkdir -p "$WORK/overlap/.planning/phases/01-x"
plan overlap '01-x/01-PLAN.md' T-01-01 '' 'src/same.ts' REQ-1
plan overlap '01-x/02-PLAN.md' T-01-02 '' 'src/same.ts' REQ-2
if out="$(run_validator overlap)"; then
  bad "an unordered overlapping pair is rejected" "$out"
else
  grep -q 'dependency-unordered' <<<"$out" \
    && ok "an unordered overlapping pair is rejected" \
    || bad "an unordered overlapping pair is rejected (wrong reason)" "$out"
fi

# ── 3. trailing comments must not corrupt values ────────────────────────────
mkproj comments
mkdir -p "$WORK/comments/.planning/phases/01-x"
cat > "$WORK/comments/.planning/phases/01-x/01-PLAN.md" <<'EOF'
---
phase: 01
plan: 01
title: "Add API endpoint (v2): auth"
type: implementation
wave: 1                       # 1 + max(wave of dependencies)
depends_on: []
files_modified: [src/api/auth.ts, src/api/index.ts]   # what this plan touches
requirements: [REQ-1]         # from ROADMAP.md
delivery:
  ticket: T-01-01
  risk: low
  human_checkpoint: false
---
## Goal
x
EOF
if out="$(run_validator comments)"; then
  files="$(node -e 'console.log(JSON.stringify(require(process.argv[1]).tickets["T-01-01"].files))' \
    "$WORK/comments/.planning/graph/tickets.json")"
  [[ "$files" == '["src/api/auth.ts","src/api/index.ts"]' ]] \
    && ok "inline # comments are stripped, not folded into the last path" \
    || bad "inline # comments are stripped" "got $files"
else
  bad "a plan with inline comments passes" "$out"
fi

# a '#' that really is inside a value stays an error rather than silent garbage
mkproj hashleak
mkdir -p "$WORK/hashleak/.planning/phases/01-x"
plan hashleak '01-x/01-PLAN.md' T-01-01 '' '"src/a.ts # note"' REQ-1
if out="$(run_validator hashleak)"; then
  bad "a '#' inside a quoted path is rejected" "$out"
else
  grep -q 'trailing comment leaked' <<<"$out" \
    && ok "a '#' inside a quoted path is rejected with an explicit reason" \
    || bad "a '#' inside a quoted path is rejected (wrong reason)" "$out"
fi

# ── 4. ticket-id normalisation ──────────────────────────────────────────────
mkproj padding
mkdir -p "$WORK/padding/.planning/phases/01-x"
plan padding '01-x/01-PLAN.md' T-01-01 ''       'src/a.ts' REQ-1
plan padding '01-x/02-PLAN.md' T-01-02 'T-1-1'  'src/b.ts' REQ-2
if out="$(run_validator padding)"; then
  ok "an unpadded dependency id (T-1-1) resolves to T-01-01"
else
  bad "an unpadded dependency id resolves" "$out"
fi

# ── 5. cycles, and no phantom cycle from a duplicated dependency ────────────
mkproj cycle
mkdir -p "$WORK/cycle/.planning/phases/01-x"
plan cycle '01-x/01-PLAN.md' T-01-01 'T-01-02' 'src/a.ts' REQ-1
plan cycle '01-x/02-PLAN.md' T-01-02 'T-01-01' 'src/b.ts' REQ-2
if out="$(run_validator cycle)"; then
  bad "a real cycle is rejected" "$out"
else
  grep -q 'cycle' <<<"$out" && ok "a real cycle is rejected" || bad "a real cycle is rejected" "$out"
fi

mkproj dupdep
mkdir -p "$WORK/dupdep/.planning/phases/01-x"
plan dupdep '01-x/01-PLAN.md' T-01-01 ''                    'src/a.ts' REQ-1
plan dupdep '01-x/02-PLAN.md' T-01-02 'T-01-01, T-01-01'    'src/b.ts' REQ-2
if out="$(run_validator dupdep)"; then
  grep -q 'more than once' <<<"$out" \
    && ok "a duplicated dependency warns instead of faking a cycle" \
    || bad "a duplicated dependency warns" "$out"
else
  bad "a duplicated dependency does not fake a cycle" "$out"
fi

mkproj selfdep
mkdir -p "$WORK/selfdep/.planning/phases/01-x"
plan selfdep '01-x/01-PLAN.md' T-01-01 'T-01-01' 'src/a.ts' REQ-1
run_validator selfdep >/dev/null 2>&1 \
  && bad "a self-dependency is rejected" \
  || ok "a self-dependency is rejected"

# ── 6. the hard contract fields ─────────────────────────────────────────────
mkproj noreq
mkdir -p "$WORK/noreq/.planning/phases/01-x"
plan noreq '01-x/01-PLAN.md' T-01-01 '' 'src/a.ts' ''
rejects noreq 'requirements' "an empty requirements[] blocks Gate 2"

mkproj nofiles
mkdir -p "$WORK/nofiles/.planning/phases/01-x"
plan nofiles '01-x/01-PLAN.md' T-01-01 '' '' REQ-1
rejects nofiles 'files_modified is empty' "an empty files_modified blocks Gate 2"

mkproj risky
mkdir -p "$WORK/risky/.planning/phases/01-x"
plan risky '01-x/01-PLAN.md' T-01-01 '' 'src/a.ts' REQ-1 high false
rejects risky 'human_checkpoint' "high risk without human_checkpoint blocks Gate 2"

mkproj badrisk
mkdir -p "$WORK/badrisk/.planning/phases/01-x"
plan badrisk '01-x/01-PLAN.md' T-01-01 '' 'src/a.ts' REQ-1 critical false
rejects badrisk 'is not one of low|medium|high' "an unknown delivery.risk blocks Gate 2"

mkproj badbranch
mkdir -p "$WORK/badbranch/.planning/phases/01-x"
plan badbranch '01-x/01-PLAN.md' T-01-01 '' 'src/a.ts' REQ-1
# inject an invalid explicit branch
node - "$WORK/badbranch/.planning/phases/01-x/01-PLAN.md" <<'NODE'
const fs = require('fs');
const p = process.argv[2];
fs.writeFileSync(p, fs.readFileSync(p, 'utf8').replace('  risk: low', '  branch: "bad branch name"\n  risk: low'));
NODE
rejects badbranch 'invalid characters' "an invalid explicit delivery.branch blocks Gate 2"

mkproj dupticket
mkdir -p "$WORK/dupticket/.planning/phases/01-x"
plan dupticket '01-x/01-PLAN.md' T-01-01 '' 'src/a.ts' REQ-1
plan dupticket '01-x/02-PLAN.md' T-01-01 '' 'src/b.ts' REQ-2
rejects dupticket 'duplicate ticket id' "two plans claiming one ticket id block Gate 2"

mkproj missingdep
mkdir -p "$WORK/missingdep/.planning/phases/01-x"
plan missingdep '01-x/01-PLAN.md' T-01-01 'T-09-09' 'src/a.ts' REQ-1
rejects missingdep 'does not exist' "a dangling dependency blocks Gate 2"

mkproj brokenfm
mkdir -p "$WORK/brokenfm/.planning/phases/01-x"
cat > "$WORK/brokenfm/.planning/phases/01-x/01-PLAN.md" <<'EOF'
---
phase: 01
files_modified: [src/a.ts
requirements: [REQ-1]
delivery:
  ticket: T-01-01
---
x
EOF
rejects brokenfm 'unterminated flow' "a malformed frontmatter line is reported with its location"

# ── 7. cross-phase dependency is surfaced, not silently reinterpreted ───────
mkproj crossphase
mkdir -p "$WORK/crossphase/.planning/phases/01-a" "$WORK/crossphase/.planning/phases/02-b"
plan crossphase '01-a/01-PLAN.md' T-01-01 ''        'src/a.ts' REQ-1
plan crossphase '02-b/02-PLAN.md' T-02-01 'T-01-01' 'src/b.ts' REQ-2
if out="$(run_validator crossphase)"; then
  grep -q 'cross-phase dependency' <<<"$out" \
    && ok "a cross-phase dependency is warned about" \
    || bad "a cross-phase dependency is warned about" "$out"
else
  bad "a cross-phase dependency still validates" "$out"
fi

# ── 7b. multi-repo tickets (delivery.repo) ──────────────────────────────────
# A ticket in a sibling repository is a normal part of a phase. Getting the repo
# boundary wrong is what made a merged PR read as `pending` forever and pointed a
# cascade base at a branch that does not exist in the ticket's repo.
mkproj tworepos
mkdir -p "$WORK/tworepos/.planning/phases/01-a"
plan tworepos '01-a/01-PLAN.md' T-01-01 '' 'src/shared/x.ts' REQ-1 low false '' ''
plan tworepos '01-a/02-PLAN.md' T-01-02 '' 'src/shared/x.ts' REQ-2 low false '' 'repo: acme/webapp'
if out="$(run_validator tworepos)"; then
  ok "identical paths in DIFFERENT repos are not an overlap conflict"
  j="$WORK/tworepos/.planning/graph/tickets.json"
  node -e '
    const t = require(process.argv[1]).tickets;
    if (t["T-01-02"].repo !== "acme/webapp") throw new Error("repo not carried into tickets.json");
    if (t["T-01-01"].repo !== null) throw new Error("a same-repo ticket must have repo: null");
  ' "$j" && ok "delivery.repo lands in tickets.json (null for this repo)" \
         || bad "delivery.repo lands in tickets.json"
  node -e '
    const g = require(process.argv[1]);
    const repos = g.epics["1"].repos || [];
    if (!repos.includes(null) || !repos.includes("acme/webapp")) {
      throw new Error("epic must list every repo the phase touches, got " + JSON.stringify(repos));
    }
  ' "$j" && ok "the epic records every repo the phase spans" \
         || bad "the epic records every repo the phase spans"
else
  bad "a two-repo phase validates" "$out"
fi

# same repo, same path, dependency-unordered → still a Gate 2 error
mkproj samerepo
mkdir -p "$WORK/samerepo/.planning/phases/01-a"
plan samerepo '01-a/01-PLAN.md' T-01-01 '' 'src/shared/x.ts' REQ-1 low false '' 'repo: acme/webapp'
plan samerepo '01-a/02-PLAN.md' T-01-02 '' 'src/shared/x.ts' REQ-2 low false '' 'repo: acme/webapp'
rejects samerepo 'contested path "src/shared/x.ts"' "identical paths in the SAME foreign repo are still rejected"
rejects samerepo 'T-01-01, T-01-02' "the contested-path error names every ticket touching it, not one pair"
rejects samerepo 'add a dependency between them' "a SAME-phase clash may be resolved by a dependency"

# A clash ACROSS phases must not be told to add a dependency: delivery-rules §7
# says a cross-phase dependency cannot cascade, so the old blanket advice sent the
# reader straight into the construct the validator warns about one check later.
mkproj crossphase
plan crossphase '01-a/01-PLAN.md' T-01-01 '' 'src/shared/hot.ts' REQ-1
plan crossphase '02-b/01-PLAN.md' T-02-01 '' 'src/shared/hot.ts' REQ-2
rejects crossphase 'RE-SLICE' "a cross-phase contested path demands a re-slice"
rejects crossphase 'cannot cascade' "and says why a dependency would not work"

# A DELIVERED phase must not own its files forever. Same clash as `crossphase`
# above, except phase 01 is already merged: its diff has landed, so there is
# nothing left for it to write and nothing to collide with. Without this, the
# second phase to touch any module is rejected and the reader is sent at a
# remedy that cannot exist — the path legitimately belongs to both phases, at
# different times.
mkproj mergedphase
plan mergedphase '01-a/01-PLAN.md' T-01-01 '' 'src/shared/hot.ts' REQ-1
plan mergedphase '02-b/01-PLAN.md' T-02-01 '' 'src/shared/hot.ts' REQ-2
mkdir -p "$WORK/mergedphase/.planning/graph"
printf '{"tickets":{"T-01-01":{"status":"merged"}}}\n' \
  > "$WORK/mergedphase/.planning/graph/delivery-state.json"
if out="$(run_validator mergedphase)"; then
  grep -q 'validate-graph: OK' <<<"$out" \
    && ok "a merged ticket does not contest a path a later phase needs" \
    || bad "a merged ticket does not contest a path a later phase needs (wrong reason)" "$out"
else
  bad "a merged ticket does not contest a path a later phase needs" "expected exit 0, got:
$out"
fi

# ...but only `merged`. Live work with an unwritten diff still contests, or the
# gate would switch itself off for every ticket that merely has a branch.
mkproj openphase
plan openphase '01-a/01-PLAN.md' T-01-01 '' 'src/shared/hot.ts' REQ-1
plan openphase '02-b/01-PLAN.md' T-02-01 '' 'src/shared/hot.ts' REQ-2
mkdir -p "$WORK/openphase/.planning/graph"
printf '{"tickets":{"T-01-01":{"status":"pr-open"}}}\n' \
  > "$WORK/openphase/.planning/graph/delivery-state.json"
rejects openphase 'contested path' "an OPEN ticket still contests — only merged work is spent"

# A state file that is missing, empty or corrupt must leave every ticket LIVE.
# Failing open here would let an unreadable byte disable the file-overlap
# guarantee for a whole project, silently.
mkproj corruptstate
plan corruptstate '01-a/01-PLAN.md' T-01-01 '' 'src/shared/hot.ts' REQ-1
plan corruptstate '02-b/01-PLAN.md' T-02-01 '' 'src/shared/hot.ts' REQ-2
mkdir -p "$WORK/corruptstate/.planning/graph"
printf 'not json at all' > "$WORK/corruptstate/.planning/graph/delivery-state.json"
rejects corruptstate 'contested path' "an unreadable delivery-state leaves every ticket live"

out="$(run_validator crossphase 2>&1 || true)"
if grep -q 'add a dependency between them' <<<"$out"; then
  bad "a cross-phase clash must NOT suggest adding a dependency" "$out"
else
  ok "a cross-phase clash must NOT suggest adding a dependency"
fi

# One contested file touched by three tickets is ONE error, not three pairs —
# a real graph produced 52 lines restating a handful of files.
mkproj hotfile
plan hotfile '01-a/01-PLAN.md' T-01-01 '' 'evals/qa/cases.mjs' REQ-1
plan hotfile '01-a/02-PLAN.md' T-01-02 '' 'evals/qa/cases.mjs' REQ-2
plan hotfile '01-a/03-PLAN.md' T-01-03 '' 'evals/qa/cases.mjs' REQ-3
out="$(run_validator hotfile 2>&1 || true)"
n="$(grep -c 'contested path' <<<"$out" || true)"
if [[ "$n" == "1" ]]; then
  ok "three tickets contesting one path produce ONE grouped error"
else
  bad "three tickets contesting one path produce ONE grouped error" "got $n lines:
$out"
fi
grep -q 'T-01-01, T-01-02, T-01-03' <<<"$out" \
  && ok "the grouped error names all three tickets" \
  || bad "the grouped error names all three tickets" "$out"

# a cross-repo dependency cannot cascade: no primary parent, base stays the epic
mkproj crossrepo
mkdir -p "$WORK/crossrepo/.planning/phases/01-a"
plan crossrepo '01-a/01-PLAN.md' T-01-01 ''        'packages/api/types.ts' REQ-1 low false '' 'repo: acme/webapp'
plan crossrepo '01-a/02-PLAN.md' T-01-02 'T-01-01' 'src/consumer.ts'       REQ-2
if out="$(run_validator crossrepo)"; then
  grep -q 'crosses a repository boundary' <<<"$out" \
    && ok "a cross-repo dependency is warned about" \
    || bad "a cross-repo dependency is warned about" "$out"
  node -e '
    const t = require(process.argv[1]).tickets;
    const c = t["T-01-02"];
    if (c.primary_parent !== null) throw new Error("a foreign parent must not become the cascade parent");
    if (c.pr_base !== c.epic) throw new Error("pr_base must stay the epic, got " + c.pr_base);
    if (!c.cross_repo_deps.includes("T-01-01")) throw new Error("cross_repo_deps not recorded");
  ' "$WORK/crossrepo/.planning/graph/tickets.json" \
    && ok "a cross-repo parent never becomes a cascade base" \
    || bad "a cross-repo parent never becomes a cascade base"
else
  bad "a cross-repo dependency still validates" "$out"
fi

# paths that escape the repo root: warn + flag, but do NOT fail the whole gate
mkproj escapes
mkdir -p "$WORK/escapes/.planning/phases/01-a"
plan escapes '01-a/01-PLAN.md' T-01-01 '' '"../other-repo/src/x.ts", "src/ok.ts"' REQ-1
if out="$(run_validator escapes)"; then
  grep -q 'point OUTSIDE the repo' <<<"$out" \
    && ok "a path escaping the repo is surfaced" \
    || bad "a path escaping the repo is surfaced" "$out"
  node -e '
    const t = require(process.argv[1]).tickets;
    if (t["T-01-01"].unreachable_paths !== true) throw new Error("unreachable_paths flag missing");
  ' "$WORK/escapes/.planning/graph/tickets.json" \
    && ok "the ticket is flagged unreachable_paths (state-sync parks it)" \
    || bad "the ticket is flagged unreachable_paths"
else
  bad "an escaping path parks ONE ticket instead of failing Gate 2 for all" "$out"
fi

# a malformed repo slug is a hard error — it would silently target nothing
mkproj badrepo
mkdir -p "$WORK/badrepo/.planning/phases/01-a"
plan badrepo '01-a/01-PLAN.md' T-01-01 '' 'src/a.ts' REQ-1 low false '' 'repo: not-a-slug'
rejects badrepo 'is not an owner/name slug' "an invalid delivery.repo value is rejected"

# ── 8. the generated YAML view must be parseable ────────────────────────────
mkproj globs
mkdir -p "$WORK/globs/.planning/phases/01-x"
plan globs '01-x/01-PLAN.md' T-01-01 '' '"src/**/*.ts", "docs/*.md"' REQ-1
if run_validator globs >/dev/null 2>&1; then
  y="$WORK/globs/.planning/graph/tickets.yaml"
  files_line="$(grep '    files:' "$y" || true)"
  # an unquoted '*' at the start of a flow entry is a YAML alias indicator
  if grep -Eq "\[\*|, \*" <<<"$files_line"; then
    bad "generated tickets.yaml quotes glob values" "$files_line"
  else
    ok "generated tickets.yaml quotes glob values"
  fi
  if grep -q "^    files: \['src/\*\*/\*\.ts', 'docs/\*\.md'\]$" <<<"$files_line"; then
    ok "generated tickets.yaml renders globs as single-quoted scalars"
  else
    bad "generated tickets.yaml renders globs as single-quoted scalars" "$files_line"
  fi
else
  bad "a plan with glob paths validates" "$(run_validator globs || true)"
fi

# ── 9. graph-gate applicability (it runs at plan:post in EVERY GSD project) ──
echo "graph-gate applicability"

mkdir -p "$WORK/empty"
run_gate empty >/dev/null 2>&1 \
  && ok "a project with no .planning/phases passes (nothing to gate)" \
  || bad "a project with no .planning/phases passes" "$(run_gate empty)"

# a plain GSD project: plans exist, but no delivery: block anywhere
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
if out="$(run_gate plaingsd)"; then
  grep -q 'not a delivery-conveyor project' <<<"$out" \
    && ok "a plain GSD project is NOT blocked at plan:post" \
    || ok "a plain GSD project is not blocked at plan:post"
else
  bad "a plain GSD project is not blocked at plan:post" "$out"
fi

# a conveyor project with an invalid graph MUST still be blocked (fail closed)
run_gate nofiles >/dev/null 2>&1 \
  && bad "a conveyor project with an invalid graph is blocked" \
  || ok "a conveyor project with an invalid graph is blocked (fail closed)"

# a conveyor project with a valid graph passes
run_gate diamond >/dev/null 2>&1 \
  && ok "a conveyor project with a valid graph passes" \
  || bad "a conveyor project with a valid graph passes" "$(run_gate diamond)"

# explicit opt-out — the GSD-native key is the capability's own declared one
mkdir -p "$WORK/optout/.planning/phases/01-x"
cp "$WORK/nofiles/.planning/phases/01-x/01-PLAN.md" "$WORK/optout/.planning/phases/01-x/01-PLAN.md"
echo '{"delivery_pipeline":{"graph_gate":false}}' > "$WORK/optout/.planning/config.json"
run_gate optout >/dev/null 2>&1 \
  && ok "delivery_pipeline.graph_gate:false opts a project out (GSD-native key)" \
  || bad "delivery_pipeline.graph_gate:false opts a project out" "$(run_gate optout)"

# the legacy shipyard-namespaced key still works
echo '{"pipeline":{"graph_gate":false}}' > "$WORK/optout/.planning/config.json"
run_gate optout >/dev/null 2>&1 \
  && ok "pipeline.graph_gate:false still opts out (legacy alias)" \
  || bad "pipeline.graph_gate:false still opts out" "$(run_gate optout)"

# ...and the GSD-native key wins when the two disagree
echo '{"delivery_pipeline":{"graph_gate":true},"pipeline":{"graph_gate":false}}' > "$WORK/optout/.planning/config.json"
run_gate optout >/dev/null 2>&1 \
  && bad "delivery_pipeline.graph_gate:true overrides the legacy opt-out" \
  || ok "delivery_pipeline.graph_gate:true overrides the legacy opt-out"

echo
echo "$pass passed, $fail failed"
[[ "$fail" -eq 0 ]] || exit 1
echo "graph validator smoke passed"
