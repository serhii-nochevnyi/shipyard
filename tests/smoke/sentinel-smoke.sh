#!/usr/bin/env bash
set -euo pipefail

# End-to-end contract for the PR sentinel's inputs: state-sync must turn a live
# GitHub snapshot into the two fields the guard's whole mandate hangs on —
# `gate` (the arch-review trailer parsed out of the PR body) and `merge_scope`
# (is this PR landing inside the stack, or on the integration branch?) — and the
# board must name the guard's duty.
#
# `gh` is stubbed: this is about our parsing and our verdicts, not about GitHub.
# No network, no Docker. The fixture is one epic, one root ticket (green, with a
# conform trailer) and one dependent ticket (red, cascading off the root).

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SCRIPTS="$ROOT/plugins/delivery-pipeline/scripts"

W="$(mktemp -d)"
trap 'rm -rf "$W"' EXIT

pass=0; fail=0
ok()  { pass=$((pass + 1)); echo "  ✓ $1"; }
bad() { fail=$((fail + 1)); echo "  ✗ $1"; [[ -n "${2:-}" ]] && echo "$2" | sed 's/^/      /'; }
has() { # has <label> <haystack-file> <needle>
  if grep -qF -- "$3" "$2"; then ok "$1"; else bad "$1" "expected to find: $3"; fi
}
hasnt() {
  if grep -qF -- "$3" "$2"; then bad "$1" "did NOT expect: $3"; else ok "$1"; fi
}

# ── a stub gh that answers exactly the calls state-sync makes ────────────────
mkdir -p "$W/bin"
cat > "$W/bin/gh" <<'STUB'
#!/usr/bin/env bash
# canned GitHub. Args are matched loosely — the point is the payload shape.
argv="$*"
case "$argv" in
  "repo view --json defaultBranchRef"*) echo "main" ;;
  "pr list --state open"*)
    # the open-only pass: reviewDecision + body (the gate_status trailer). PR
    # 101's trailer names the SAME head the row below reports, which is the
    # ordinary path — the mismatch has its own fixture at the end of this file.
    cat <<'JSON'
[{"number":101,"reviewDecision":null,"body":"Ticket: T-01-01\n\nProblem: x\n\ngate_status: arch-review=conform, drift-check=fresh, checks=green, head=1111111111111111111111111111111111111111"},
 {"number":102,"reviewDecision":"CHANGES_REQUESTED","body":"Ticket: T-01-02\n"}]
JSON
    ;;
  "pr list --state all"*)
    # `headRefOid` rides in the bulk window: it is the head the trailer's verdict
    # is bound to, and state-sync records it as head_sha. Without it the board
    # reads a conform verdict and cannot tell which diff it covered.
    cat <<'JSON'
[{"number":101,"state":"OPEN","isDraft":false,"headRefName":"ticket/T-01-01-root","headRefOid":"1111111111111111111111111111111111111111","baseRefName":"epic/01-demo","mergedAt":null,"createdAt":"2026-01-01T00:00:00Z","url":"https://example/101","title":"T-01-01: root"},
 {"number":102,"state":"OPEN","isDraft":false,"headRefName":"ticket/T-01-02-child","headRefOid":"3333333333333333333333333333333333333333","baseRefName":"ticket/T-01-01-root","mergedAt":null,"createdAt":"2026-01-01T00:00:00Z","url":"https://example/102","title":"T-01-02: child"}]
JSON
    ;;
  "api repos/{owner}/{repo}/branches"*) printf 'main\nepic/01-demo\nticket/T-01-01-root\nticket/T-01-02-child\n' ;;
  # epic-branch's ahead_by AND the merge gate's behindBy both land here. The
  # gate's probe is head...base, so a non-zero answer means "the base moved".
  # reviewers.cjs `unresolved` asks GraphQL for the review threads, and the merge
  # gate refuses to merge blind when it cannot read them — so every assertion
  # PAST that point needs this answered. Zero open threads is the clean case.
  # reviewers.cjs resolves the repo slug before anything else; without this every
  # thread read fails and the merge gate refuses "blind" long before the rules
  # under test are reached.
  "repo view --json owner,name"*) echo '{"owner":{"login":"acme"},"name":"demo"}' ;;
  "api graphql"*)
    echo '{"data":{"repository":{"pullRequest":{"reviewThreads":{"nodes":[],"pageInfo":{"hasNextPage":false,"endCursor":null}}}}}}' ;;
  "api repos/{owner}/{repo}/compare/ticket/T-01-02-child...ticket/T-01-01-root"*)
    echo "${SENTINEL_SMOKE_BEHIND:-0}" ;;
  "api repos/{owner}/{repo}/compare"*) echo 0 ;;
  # Every row carries gh's own `bucket` beside its `state`. check-state.cjs reads
  # the bucket and a row WITHOUT one is PENDING by its fail-closed rule, so a
  # bucket-less fixture would park this whole smoke on "checks still running".
  "pr checks 101"*) echo '[{"name":"build","state":"SUCCESS","bucket":"pass"}]' ;;
  # The checkpoint-parent case drives PR 102 to green; the earlier duty cases
  # rely on it being red. Both are served: SENTINEL_SMOKE_GREEN_102 flips it.
  "pr checks 102"*)
    if [ -n "${SENTINEL_SMOKE_GREEN_102:-}" ]; then echo '[{"name":"build","state":"SUCCESS","bucket":"pass"}]';
    # ACTION_REQUIRED on purpose: gh buckets it `fail`, and it was in NO
    # hand-written list on the state-sync/sentinel side — it fell through both
    # filters and the board read the PR as GREEN. This fixture pins the third
    # consumer on that exact row, end to end (tally → ci-fix duty → refusal).
    else echo '[{"name":"build","state":"ACTION_REQUIRED","bucket":"fail"}]'; exit 1; fi ;;
  # The merge gate re-reads the PR from live GitHub by design, so the stub has to
  # answer it for any merge-path assertion. This one reports NO headRefOid and
  # its trailer names no head — deliberately, because that pair is the
  # backwards-compatibility case (a PR verdicted by the previous release on a
  # board synced by it): with nothing to compare, the verdict still stands, and
  # every merge-path assertion below therefore measures its own rule and not the
  # head binding.
  "pr view 102 --json"*)
    echo '{"number":102,"state":"OPEN","isDraft":false,"baseRefName":"ticket/T-01-01-root","headRefName":"ticket/T-01-02-child","mergeStateStatus":"CLEAN","reviewDecision":null,"body":"Ticket: T-01-02\n\ngate_status: arch-review=conform, drift-check=fresh, checks=green"}' ;;
  # The merge path's own three calls. The retarget asks GitHub which open PRs
  # each graph child has RIGHT NOW instead of trusting the last sync — a child
  # whose PR opened after it used to be left pointing at a branch that had just
  # been squashed away. One call per child, on the merge path only.
  "pr list --head "*) echo "${SENTINEL_SMOKE_CHILD_PRS:-[]}" ;;
  "pr merge "*) echo "squash-merged" ;;
  "pr edit "*) echo "retargeted" ;;
  *) echo "stub gh: unhandled call: $argv" >&2; exit 1 ;;
esac
STUB
chmod +x "$W/bin/gh"
export PATH="$W/bin:$PATH"

# ── the fixture project ──────────────────────────────────────────────────────
proj="$W/proj"
mkdir -p "$proj/.planning/graph"
cat > "$proj/.planning/graph/tickets.json" <<'JSON'
{
  "epics": { "1": { "branch": "epic/01-demo", "repos": [null] } },
  "tickets": {
    "T-01-01": { "phase": "1", "epic": "epic/01-demo", "branch": "ticket/T-01-01-root",
                 "title": "root", "depends_on": [], "risk": "low" },
    "T-01-02": { "phase": "1", "epic": "epic/01-demo", "branch": "ticket/T-01-02-child",
                 "title": "child", "depends_on": ["T-01-01"], "primary_parent": "T-01-01", "risk": "low" }
  }
}
JSON
echo '{"pipeline":{}}' > "$proj/.planning/config.json"

echo "sentinel / state-sync smoke"

board="$W/board.txt"
( cd "$proj" && node "$SCRIPTS/state-sync.cjs" > "$board" 2>"$W/err.txt" ) || {
  bad "state-sync runs against the stub" "$(cat "$W/err.txt")"
}
state="$proj/.planning/graph/delivery-state.json"

if [[ -f "$state" ]]; then ok "state-sync writes delivery-state.json"; else bad "state-sync writes delivery-state.json"; fi

q() { node -e 'const s=require(process.argv[1]);const v=process.argv.slice(2).reduce((o,k)=>o&&o[k],s);process.stdout.write(String(v))' "$state" "$@"; }

[[ "$(q T-01-01 gate arch-review)" == "conform" ]] \
  && ok "the gate_status trailer is parsed out of the PR body" \
  || bad "the gate_status trailer is parsed out of the PR body" "got: $(q T-01-01 gate arch-review)"

[[ "$(q T-01-01 head_sha)" == "1111111111111111111111111111111111111111" ]] \
  && ok "the head the verdict is bound to is recorded from the bulk window" \
  || bad "the head the verdict is bound to is recorded" "got: $(q T-01-01 head_sha)"

[[ "$(q T-01-01 merge_scope)" == "stacked" ]] \
  && ok "a PR targeting the epic is inside the stack" \
  || bad "a PR targeting the epic is inside the stack" "got: $(q T-01-01 merge_scope)"

[[ "$(q T-01-02 merge_scope)" == "stacked" ]] \
  && ok "a cascade PR targeting the parent branch is inside the stack too" \
  || bad "a cascade PR targeting the parent branch is inside the stack too" "got: $(q T-01-02 merge_scope)"

has "the board names the auto-merge policy" "$board" "auto-merge: epic"
has "the board names the sentinel's duty" "$board" "sentinel:"
# The trailer names the head the PR is actually at, so the verdict counts. This
# is the control for the mismatch fixture at the end of the file: without it, a
# `finalize` there would prove nothing about the head and everything about some
# unrelated gap in the fixture.
has "the green + conform PR is a merge for the guard" "$board" "merge: T-01-01"
# The red child is stacked on T-01-01, whose PR is still open — so it is HELD,
# not offered. The board used to print `fix: T-01-02` here while `duty` (below)
# answered `wait-parent` for the same ticket: the loop dispatched nothing (the
# bucket is the guard's), the guard declined the work the board offered, and the
# run had no move it could take. This pair of assertions is that defect.
has "a red child of an open parent is held behind it, and the parent is named" "$board" "parent: T-01-02→T-01-01"
hasnt "and is never offered as fix while the base is about to move" "$board" "fix: T-01-02"
has "an unmerged mergeable PR is not a fixpoint" "$board" "fixpoint: NO"

# the guard's own view of the same state
duty="$W/duty.json"
( cd "$proj" && node "$SCRIPTS/sentinel.cjs" duty --json > "$duty" ) || bad "sentinel duty runs"
d() { node -e 'const s=require(process.argv[1]);process.stdout.write(String(s.items.find(i=>i.ticket===process.argv[2])[process.argv[3]]))' "$duty" "$@"; }
[[ "$(d T-01-01 action)" == "merge" ]] && ok "duty: the green + conform PR is a merge" || bad "duty: the green + conform PR is a merge" "got: $(d T-01-01 action)"
# T-01-02 is stacked on T-01-01, whose PR is still open — so the red child is NOT
# ci-fix work yet. Fixing it now buys a green that the parent's merge undoes: the
# base moves, CI re-runs on different code, reviewers re-read a changed diff.
[[ "$(d T-01-02 action)" == "wait-parent" ]] \
  && ok "duty: a red child of an open parent waits instead of being fixed twice" \
  || bad "duty: a red child of an open parent waits" "got: $(d T-01-02 action)"
[[ "$(d T-01-01 depth)" == "0" && "$(d T-01-02 depth)" == "1" ]] \
  && ok "duty carries the stack depth it sorts by" \
  || bad "duty carries the stack depth" "got: $(d T-01-01 depth) / $(d T-01-02 depth)"

# …and the board's own file must place that same ticket in the bucket the guard's
# answer implies. One predicate (parent-moving.cjs), two readers, one state file:
# asserted end to end rather than trusted, because this is the pair that drifted.
front="$proj/.planning/graph/delivery-front.json"
if node -e '
const f = require(process.argv[1]);
const held = (f.waiting && f.waiting.parent) || [];
const actionable = Object.values(f.actionable || {}).flat();
if (!held.includes("T-01-02")) { console.error("waiting.parent=" + JSON.stringify(held)); process.exit(1); }
if (actionable.includes("T-01-02")) { console.error("still actionable: " + actionable.join(", ")); process.exit(1); }
if ((f.parent_of || {})["T-01-02"] !== "T-01-01") { console.error("parent_of=" + JSON.stringify(f.parent_of)); process.exit(1); }
if (!(f.sentinel || {}).waiting_parent || !f.sentinel.waiting_parent.includes("T-01-02")) {
  console.error("sentinel=" + JSON.stringify(f.sentinel)); process.exit(1);
}
process.exit(0);
' "$front" 2>"$W/front.err"; then
  ok "the board file agrees with duty: the child is waiting.parent, and the guard owns it"
else
  bad "the board file agrees with duty" "$(cat "$W/front.err")"
fi

# auto_merge: off must hand the same PR back to a human, and restore the old
# fixpoint semantics (nothing actionable → the run may end)
echo '{"pipeline":{"auto_merge":"off"}}' > "$proj/.planning/config.json"
board2="$W/board2.txt"
( cd "$proj" && node "$SCRIPTS/state-sync.cjs" > "$board2" 2>/dev/null ) || bad "state-sync runs with auto_merge off"
has "auto_merge: off is announced" "$board2" "auto-merge: off"
hasnt "auto_merge: off never offers a merge to the run" "$board2" "merge: T-01-01"

# concurrency: a held state lock must stop a second writer rather than let it
# interleave (the sentinel + main loop case)
locks="$proj/.planning/graph/.locks"
mkdir -p "$locks/state.lock"
node -e 'require("fs").writeFileSync(process.argv[1], JSON.stringify({pid:1,label:"fake guard",at:new Date().toISOString()}))' "$locks/state.lock/owner.json"
if ( cd "$proj" && SHIPYARD_LOCK_WAIT_MS=100 node -e '
  const path=require("path");
  const {withLock}=require(path.join(process.argv[1],"lock.cjs"));
  try { withLock(path.join(process.cwd(),".planning","graph",".locks"), "state", ()=>{}, {waitMs:100}); process.exit(0); }
  catch { process.exit(9); }
' "$SCRIPTS" ); then
  bad "a held state lock blocks a second writer"
else
  ok "a held state lock blocks a second writer"
fi
rm -rf "$locks/state.lock"

# ── pipeline-stats must expose what the journal cannot ───────────────────────
# A raw `gh pr merge` writes nothing to the journal, so a bypassed gate looks
# exactly like an idle ticket. On a real project that hid 22 merges behind a
# confident "sentinel landed 12". The only witness is GitHub's own MERGED state
# against the absence of a `merge` event, and the same blindness applies to an
# attempt logged under a role the ladder never resolved.
sproj="$W/statsproj"
mkdir -p "$sproj/.planning/graph" "$W/bin2"
cat > "$sproj/.planning/graph/tickets.json" <<'JSON'
{
  "epics": { "1": { "branch": "epic/01-demo", "repos": [null] } },
  "tickets": {
    "T-01-01": { "phase": "1", "epic": "epic/01-demo", "branch": "ticket/T-01-01-guarded",
                 "title": "guarded", "depends_on": [], "risk": "low" },
    "T-01-02": { "phase": "1", "epic": "epic/01-demo", "branch": "ticket/T-01-02-raw",
                 "title": "raw", "depends_on": [], "risk": "low" }
  }
}
JSON
echo '{"pipeline":{}}' > "$sproj/.planning/config.json"
# Both merged on GitHub; only the first went through the guard.
# The duplicate on the third line is what a run wrote by hand seconds after the
# guard wrote its own record: same PR, no `by`, no `base`. Counting both
# overstates the guard and prints an empty base in the summary.
# Dated NOW, not at a fixed point: the warnings are windowed (default 14d), so a
# fixture frozen in the past would exercise only the empty case and quietly stop
# testing anything. `--since all` covers the lifetime path separately.
NOW="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
cat > "$sproj/.planning/graph/delivery-log.jsonl" <<JSON
{"ts":"$NOW","event":"merge","ticket":"T-01-01","pr":201,"base":"epic/01-demo","by":"sentinel"}
{"ts":"$NOW","event":"merge","ticket":"T-01-01","pr":201,"outcome":"merged"}
{"ts":"$NOW","event":"attempt","ticket":"T-01-02","role":"frontend-delivery","outcome":"pushed"}
{"ts":"2026-01-02T00:01:00Z","event":"attempt","ticket":"T-01-02","role":"long-ago-role","outcome":"pushed"}
JSON
cat > "$W/bin2/gh" <<STUB
#!/usr/bin/env bash
case "\$*" in
  "pr list --state all"*)
    cat <<JSON
[{"number":201,"state":"MERGED","isDraft":false,"headRefName":"ticket/T-01-01-guarded","baseRefName":"epic/01-demo","mergedAt":"$NOW","createdAt":"$NOW","url":"https://example/201","reviewDecision":null,"title":"T-01-01: guarded"},
 {"number":202,"state":"MERGED","isDraft":false,"headRefName":"ticket/T-01-02-raw","baseRefName":"epic/01-demo","mergedAt":"$NOW","createdAt":"$NOW","url":"https://example/202","reviewDecision":null,"title":"T-01-02: raw"}]
JSON
    ;;
  # Asked only for the PRs already flagged — never in the bulk window, where this
  # field costs the same order as reviewDecision.
  "pr view 202 --json mergedBy"*) echo "octo-human" ;;
  *) echo "stub gh2: unhandled: \$*" >&2; exit 1 ;;
esac
STUB
chmod +x "$W/bin2/gh"
( cd "$sproj" && PATH="$W/bin2:$PATH" node "$SCRIPTS/pipeline-stats.cjs" ) > "$W/stats.txt" 2>&1 || true

has "stats names the ticket merged without the guard" "$W/stats.txt" "T-01-02#202"
hasnt "stats does not accuse the guarded merge" "$W/stats.txt" "T-01-01#201"
has "stats still credits the guarded merge" "$W/stats.txt" "sentinel landed 1 ticket PR"
has "stats names the role the ladder does not know" "$W/stats.txt" "frontend-delivery"
# …but only while it is recent. The journal is append-only and the graph is
# regenerated per phase, so an unwindowed warning reports a practice that stopped
# days ago forever — which is how a report teaches its reader to skim it.
hasnt "a role last used months ago is no longer shouted about" "$W/stats.txt" "long-ago-role"
has "the window is stated, so nobody reads a slice as the whole record" "$W/stats.txt" "[since 14d]"
( cd "$sproj" && PATH="$W/bin2:$PATH" node "$SCRIPTS/pipeline-stats.cjs" --since all ) > "$W/stats-all.txt" 2>&1 || true
has "--since all restores the lifetime view" "$W/stats-all.txt" "long-ago-role"
# One merge is one PR landing, however many times it was written down.
has "a double-logged merge is counted once" "$W/stats.txt" "sentinel landed 1 ticket PR"
# Who merged it is the difference between a person deciding and a run evading.
has "the unguarded merge names who did it" "$W/stats.txt" "T-01-02#202 (octo-human)"
hasnt "and mergedBy never enters the bulk window" "$W/stats.txt" "stub gh2: unhandled"
hasnt "and no empty base leaks into the summary" "$W/stats.txt" "stack (, "

# ── unresolved threads outrank a running CI ─────────────────────────────────
# Reviewers answer in a minute; CI takes tens of them; and servicing a thread
# that needs a change ends in a push that cancels the very run we waited for.
# Waiting first buys two CI cycles where one would do, and the first validates
# code nobody intends to keep. `ci-fix` already preempts pending checks for the
# same reason — this pins that review feedback finally does too.
tproj="$W/threadsproj"
mkdir -p "$tproj/.planning/graph" "$W/bin3"
cat > "$tproj/.planning/graph/tickets.json" <<'JSON'
{ "epics": { "1": { "branch": "epic/01-demo", "repos": [null] } },
  "tickets": { "T-01-01": { "phase": "1", "epic": "epic/01-demo", "branch": "ticket/T-01-01-x",
                            "title": "x", "depends_on": [], "risk": "low" } } }
JSON
cat > "$tproj/.planning/graph/delivery-state.json" <<'JSON'
{ "T-01-01": { "status": "pr-open", "pr": 301, "branch": "ticket/T-01-01-x", "base": "epic/01-demo",
               "draft": false, "merge_scope": "stacked", "checks": { "failing": 0, "pending": 2 } } }
JSON
echo '{"pipeline":{}}' > "$tproj/.planning/config.json"
cat > "$W/bin3/gh" <<'STUB'
#!/usr/bin/env bash
case "$*" in
  "repo view --json owner,name"*) echo '{"owner":{"login":"acme"},"name":"repo"}' ;;
  *"api graphql"*)
    cat <<'JSON'
{"data":{"repository":{"pullRequest":{"reviewThreads":{"pageInfo":{"hasNextPage":false,"endCursor":null},
 "nodes":[{"id":"PRRT_kwAAA","isResolved":false,"isOutdated":false,"path":"src/a.ts","line":7,
 "comments":{"totalCount":1,"pageInfo":{"hasNextPage":false},
 "nodes":[{"author":{"login":"coderabbitai"},"body":"nit: rename this","url":"https://example/1"}]}}]}}}}}
JSON
    ;;
  *) echo "stub gh3: unhandled: $*" >&2; exit 1 ;;
esac
STUB
chmod +x "$W/bin3/gh"
( cd "$tproj" && PATH="$W/bin3:$PATH" node "$SCRIPTS/sentinel.cjs" duty --json ) > "$W/duty.json" 2>"$W/duty.err" || true

if node -e '
  const d = require(process.argv[1]);
  const it = (d.items || []).find((i) => i.ticket === "T-01-01");
  if (!it) { console.error("no duty item"); process.exit(1); }
  if (it.action !== "review-fix") { console.error("action=" + it.action + " why=" + it.why); process.exit(1); }
  process.exit(0);
' "$W/duty.json" 2>>"$W/duty.err"; then
  ok "an unresolved thread beats pending CI (review-fix, not wait-ci)"
else
  bad "an unresolved thread beats pending CI" "$(cat "$W/duty.json" "$W/duty.err" 2>/dev/null | head -12)"
fi
grep -q 'CI still running' "$W/duty.json" \
  && ok "the reason says why servicing now is right, not just what to do" \
  || bad "the reason explains the ordering" "$(cat "$W/duty.json" | head -6)"

# The thread id is what resolving takes; without it the instruction to resolve
# is one nobody can follow — which is exactly how threads got answered and left
# open, and the merge gate then refused on its own reviewers' work.
( cd "$tproj" && PATH="$W/bin3:$PATH" node "$SCRIPTS/reviewers.cjs" unresolved 301 ) > "$W/threads.json" 2>/dev/null || true
node -e '
  const r = require(process.argv[1]);
  const t = (r.threads || [])[0];
  process.exit(t && typeof t.id === "string" && t.id.length ? 0 : 1);
' "$W/threads.json" \
  && ok "unresolved threads carry the id needed to resolve them" \
  || bad "unresolved threads carry their id" "$(head -20 "$W/threads.json")"

# ── the merge gate refuses a base that is an OPEN human_checkpoint parent ────
# Field-found, not invented: three of five escalations in one proving-ground phase
# were manual holds on exactly this, each citing the gate's base check by line.
# The base IS inside the stack, so the existing check passes it — the refusal has
# to come from the parent's checkpoint flag. Needs the stubbed gh, because the
# gate re-reads baseRefName from live GitHub by design.
cpproj="$W/cpproj"
mkdir -p "$cpproj/.planning/graph"
cat > "$cpproj/.planning/graph/tickets.json" <<'JSON'
{
  "epics": { "1": { "branch": "epic/01-demo", "repos": [null] } },
  "tickets": {
    "T-01-01": { "phase": "1", "epic": "epic/01-demo", "branch": "ticket/T-01-01-root",
                 "title": "root", "depends_on": [], "risk": "high", "human_checkpoint": true },
    "T-01-02": { "phase": "1", "epic": "epic/01-demo", "branch": "ticket/T-01-02-child",
                 "title": "child", "depends_on": ["T-01-01"], "primary_parent": "T-01-01", "risk": "low" }
  }
}
JSON
echo '{"pipeline":{}}' > "$cpproj/.planning/config.json"

# The child is green + conform + stacked on the parent's branch; the parent's PR
# is still OPEN. Written directly so the case does not depend on a sync pass.
cat > "$cpproj/.planning/graph/delivery-state.json" <<'JSON'
{
  "T-01-01": { "status": "pr-open", "pr": 101, "draft": false, "branch": "ticket/T-01-01-root",
               "epic": "epic/01-demo", "checks": { "total": 1, "failing": 0, "pending": 0 } },
  "T-01-02": { "status": "pr-open", "pr": 102, "draft": false, "branch": "ticket/T-01-02-child",
               "epic": "epic/01-demo", "pr_base": "ticket/T-01-01-root", "merge_scope": "stacked",
               "gate": { "arch-review": "conform" },
               "checks": { "total": 1, "failing": 0, "pending": 0 } }
}
JSON

cpout="$W/cp-merge.json"
( cd "$cpproj" && SENTINEL_SMOKE_GREEN_102=1 node "$SCRIPTS/sentinel.cjs" merge T-01-02 --json > "$cpout" 2>"$W/cp-err.txt" ) || true
if node -e '
const r = require(process.argv[1]).results[0];
const blocked = r && r.merged === false;
const named = blocked && r.blockers.some((b) => /human_checkpoint/.test(b) && /T-01-01/.test(b));
process.exit(blocked && named ? 0 : 1);
' "$cpout" 2>/dev/null; then
  ok "merge refuses a base that is an OPEN human_checkpoint parent, and names it"
else
  bad "merge refuses an open checkpoint parent" "$(cat "$cpout" 2>/dev/null | head -20)"
fi

# ...and the duty says so with the true reason rather than routing to human-merge.
cpduty="$W/cp-duty.json"
( cd "$cpproj" && node "$SCRIPTS/sentinel.cjs" duty --json > "$cpduty" 2>/dev/null ) || true
if node -e '
const items = require(process.argv[1]).items;
const c = items.find((i) => i.ticket === "T-01-02");
process.exit(c && c.action === "wait-parent" && /human_checkpoint/.test(c.why) ? 0 : 1);
' "$cpduty" 2>/dev/null; then
  ok "duty holds that child as wait-parent, naming the checkpoint"
else
  bad "duty holds the checkpoint-parented child" "$(cat "$cpduty" 2>/dev/null | head -20)"
fi

# ── a green measured against a base that has since moved ─────────────────────
# The quietest failure of an unattended run: retargeting a cascade child updates
# where it points and re-runs nothing, so its check result still describes a
# merge base that no longer exists. The gate's own comment had named BEHIND
# since it was written, and nothing checked it.
mergeout="$W/behind.json"
run_merge() {
  ( cd "$cpproj" && env "$@" SENTINEL_SMOKE_GREEN_102=1 \
      node "$SCRIPTS/sentinel.cjs" merge T-01-02 --json > "$mergeout" 2>/dev/null ) || true
}
blockers_match() { node -e '
const r = require(process.argv[1]).results[0];
process.exit(r && r.merged === false && r.blockers.some((b) => new RegExp(process.argv[2]).test(b)) ? 0 : 1);
' "$mergeout" "$1" 2>/dev/null; }

# The checkpoint parent would refuse first, so this case gives it a landed one.
node -e '
const f = process.argv[1]; const s = JSON.parse(require("fs").readFileSync(f, "utf8"));
s["T-01-01"].status = "merged"; require("fs").writeFileSync(f, JSON.stringify(s));
' "$cpproj/.planning/graph/delivery-state.json"

run_merge SENTINEL_SMOKE_BEHIND=3
if blockers_match 'the base moved'; then
  ok "merge refuses a branch whose base moved under it, even with green checks"
else
  bad "merge refuses a stale base" "$(head -20 "$mergeout")"
fi
if blockers_match '3 commit'; then
  ok "and says HOW far behind, so the fix is one merge and not a guess"
else
  bad "the refusal counts the commits" "$(head -20 "$mergeout")"
fi

# Zero behind: the staleness rule must not become a blanket refusal.
run_merge SENTINEL_SMOKE_BEHIND=0
if blockers_match 'the base moved'; then
  bad "an up-to-date branch is not called stale" "$(head -20 "$mergeout")"
else
  ok "an up-to-date branch is not called stale"
fi
# …and it actually LANDS, end to end through the stub. The negative assertion
# above passed for years while the merge died one line later on a `gh pr merge`
# the stub did not answer, which proved only that the refusal text differed.
if node -e '
const r = require(process.argv[1]).results[0];
process.exit(r && r.merged === true ? 0 : 1);
' "$mergeout" 2>/dev/null; then
  ok "an up-to-date, green, conform PR inside the stack is squashed in"
else
  bad "the guard lands the PR it accepted" "$(head -20 "$mergeout")"
fi

# ── a conform verdict is bound to the head it judged ────────────────────────
# Field-found on PR #31 and twice after it: verdict → undraft → a bot review lands
# on the now-undrafted PR → review-fix pushes → CI goes green again, and the
# untouched trailer still read `conform`. The guards were stripping it BY HAND to
# force a re-review. End to end here, because the defect spanned all three
# consumers: state-sync must RECORD the head, the board must not offer the merge,
# the duty must name the work, and the gate must refuse against the LIVE head.
JUDGED=1111111111111111111111111111111111111111
LIVE=2222222222222222222222222222222222222222
hbproj="$W/hbproj"
mkdir -p "$hbproj/.planning/graph" "$W/bin3"
cat > "$W/bin3/gh" <<STUB
#!/usr/bin/env bash
argv="\$*"
case "\$argv" in
  "repo view --json defaultBranchRef"*) echo "main" ;;
  "repo view --json owner,name"*) echo '{"owner":{"login":"acme"},"name":"demo"}' ;;
  # The row reports the head the branch is at NOW; the body's trailer names the
  # head the verdict was rendered against. That is the whole fixture.
  "pr list --state all"*)
    echo '[{"number":301,"state":"OPEN","isDraft":false,"headRefName":"ticket/T-02-01-moved","headRefOid":"$LIVE","baseRefName":"epic/02-demo","mergedAt":null,"createdAt":"2026-01-01T00:00:00Z","url":"https://example/301","title":"T-02-01: moved"}]' ;;
  "pr list --state open"*)
    echo '[{"number":301,"reviewDecision":null,"body":"Ticket: T-02-01\n\ngate_status: arch-review=conform, drift-check=fresh, degenerate-green=clean, checks=green, head=$JUDGED"}]' ;;
  "api repos/{owner}/{repo}/branches"*) printf 'main\nepic/02-demo\nticket/T-02-01-moved\n' ;;
  "api repos/{owner}/{repo}/compare"*) echo 0 ;;
  "api graphql"*)
    echo '{"data":{"repository":{"pullRequest":{"reviewThreads":{"nodes":[],"pageInfo":{"hasNextPage":false,"endCursor":null}}}}}}' ;;
  "pr checks 301"*) echo '[{"name":"build","state":"SUCCESS","bucket":"pass"}]' ;;
  # The merge gate compares against the LIVE head, not the board's — the cached
  # one is minutes old, which is the same reasoning the whole live
  # re-verification exists to refuse.
  "pr view 301 --json"*)
    echo '{"number":301,"state":"OPEN","isDraft":false,"baseRefName":"epic/02-demo","headRefName":"ticket/T-02-01-moved","headRefOid":"$LIVE","mergeStateStatus":"CLEAN","reviewDecision":null,"body":"Ticket: T-02-01\n\ngate_status: arch-review=conform, drift-check=fresh, degenerate-green=clean, checks=green, head=$JUDGED"}' ;;
  *) echo "stub gh: unhandled call: \$argv" >&2; exit 1 ;;
esac
STUB
chmod +x "$W/bin3/gh"
cat > "$hbproj/.planning/graph/tickets.json" <<'JSON'
{
  "epics": { "2": { "branch": "epic/02-demo", "repos": [null] } },
  "tickets": {
    "T-02-01": { "phase": "2", "epic": "epic/02-demo", "branch": "ticket/T-02-01-moved",
                 "title": "moved", "depends_on": [], "risk": "low" }
  }
}
JSON
echo '{"pipeline":{}}' > "$hbproj/.planning/config.json"

hbboard="$W/hb-board.txt"
( cd "$hbproj" && PATH="$W/bin3:$PATH" node "$SCRIPTS/state-sync.cjs" > "$hbboard" 2>"$W/hb-err.txt" ) \
  || bad "state-sync runs against the moved-head stub" "$(cat "$W/hb-err.txt")"
hbstate="$hbproj/.planning/graph/delivery-state.json"
hq() { node -e 'const s=require(process.argv[1]);const v=process.argv.slice(2).reduce((o,k)=>o&&o[k],s);process.stdout.write(String(v))' "$hbstate" "$@"; }

[[ "$(hq T-02-01 head_sha)" == "$LIVE" ]] \
  && ok "state-sync records the PR's current head, not the trailer's" \
  || bad "state-sync records the current head" "got: $(hq T-02-01 head_sha)"
[[ "$(hq T-02-01 gate head)" == "$JUDGED" ]] \
  && ok "and keeps the head the trailer claims, so the two can be compared" \
  || bad "the trailer's head is parsed" "got: $(hq T-02-01 gate head)"

hasnt "the board does not offer a merge for a verdict about another diff" "$hbboard" "merge: T-02-01"
has "it offers the arch-review instead" "$hbboard" "finalize: T-02-01"

hbduty="$W/hb-duty.json"
( cd "$hbproj" && PATH="$W/bin3:$PATH" node "$SCRIPTS/sentinel.cjs" duty --json > "$hbduty" 2>/dev/null ) \
  || bad "duty runs against the moved-head stub"
if node -e '
const i = require(process.argv[1]).items.find((x) => x.ticket === "T-02-01");
// Both SHAs, or the remedy ("re-judge THIS head") is a guess — and "no conform
// trailer" would be a lie about a body that visibly carries one.
process.exit(i && i.action === "arch-review" && /1111111/.test(i.why) && /2222222/.test(i.why) ? 0 : 1);
' "$hbduty" 2>/dev/null; then
  ok "duty owes arch-review again and names both heads"
else
  bad "duty owes arch-review again" "$(head -20 "$hbduty")"
fi

hbmerge="$W/hb-merge.json"
( cd "$hbproj" && PATH="$W/bin3:$PATH" node "$SCRIPTS/sentinel.cjs" merge T-02-01 --dry-run --json > "$hbmerge" 2>/dev/null ) || true
if node -e '
const r = require(process.argv[1]).results[0];
const refused = r && r.merged === false && r.would_merge !== true;
const named = refused && r.blockers.some((b) => /1111111/.test(b) && /2222222/.test(b) && /arch-review/.test(b));
process.exit(named ? 0 : 1);
' "$hbmerge" 2>/dev/null; then
  ok "the gate refuses the merge against the live head, naming both"
else
  bad "the gate refuses a superseded verdict" "$(head -20 "$hbmerge")"
fi

# ── a PR where nothing ran is not a green PR ─────────────────────────────────
# Б3, end to end across the three readers. `failing === 0 && pending === 0` is
# the green test, and an EMPTY check list satisfies it without anything having
# run: such a PR reached `actionable.merge` and was squashed into the epic with
# no test having executed. state-sync warns about it in a line nobody reads at
# 3am, so the board, the duty and the gate now all answer "a human's merge"
# unless the project has declared the repo has no CI.
NCHEAD=4444444444444444444444444444444444444444
ncproj="$W/nociproj"
mkdir -p "$ncproj/.planning/graph" "$W/bin4"
cat > "$ncproj/.planning/graph/tickets.json" <<'JSON'
{ "epics": { "3": { "branch": "epic/03-demo", "repos": [null] } },
  "tickets": { "T-03-01": { "phase": "3", "epic": "epic/03-demo", "branch": "ticket/T-03-01-noci",
                            "title": "no ci here", "depends_on": [], "risk": "low" } } }
JSON
cat > "$ncproj/.planning/graph/delivery-state.json" <<JSON
{ "T-03-01": { "status": "pr-open", "pr": 401, "draft": false, "branch": "ticket/T-03-01-noci",
               "epic": "epic/03-demo", "pr_base": "epic/03-demo", "merge_scope": "stacked",
               "gate": { "arch-review": "conform", "head": "$NCHEAD" }, "head_sha": "$NCHEAD",
               "checks": { "total": 0, "failing": 0, "pending": 0, "none_reported": true } } }
JSON
echo '{"pipeline":{}}' > "$ncproj/.planning/config.json"
cat > "$W/bin4/gh" <<STUB
#!/usr/bin/env bash
argv="\$*"
if [ -n "\${SENTINEL_SMOKE_LOG:-}" ]; then printf '%s\n' "\$argv" >> "\$SENTINEL_SMOKE_LOG"; fi
case "\$argv" in
  "repo view --json defaultBranchRef"*) echo "main" ;;
  "repo view --json owner,name"*) echo '{"owner":{"login":"acme"},"name":"demo"}' ;;
  # The repo has no CI configured at all: gh exits 0 and reports nothing, which
  # is the one case that genuinely means "no checks" (see sentinel.cjs ghChecks).
  "pr checks 401"*) echo -n "" ;;
  "pr view 401 --json"*)
    echo '{"number":401,"state":"OPEN","isDraft":false,"baseRefName":"epic/03-demo","headRefName":"ticket/T-03-01-noci","headRefOid":"$NCHEAD","mergeStateStatus":"CLEAN","reviewDecision":null,"body":"Ticket: T-03-01\n\ngate_status: arch-review=conform, checks=green, head=$NCHEAD"}' ;;
  "api graphql"*)
    echo '{"data":{"repository":{"pullRequest":{"reviewThreads":{"nodes":[],"pageInfo":{"hasNextPage":false,"endCursor":null}}}}}}' ;;
  "api repos/"*"/compare/"*) echo 0 ;;
  "pr list --head "*) echo "[]" ;;
  "pr merge "*) echo "squash-merged" ;;
  *) echo "stub gh4: unhandled call: \$argv" >&2; exit 1 ;;
esac
STUB
chmod +x "$W/bin4/gh"

# The board, from the state file alone — front.cjs needs no GitHub at all.
( cd "$ncproj" && node "$SCRIPTS/front.cjs" --json > "$W/nc-front.json" 2>"$W/nc-front.err" ) \
  || bad "front.cjs runs on the no-CI fixture" "$(cat "$W/nc-front.err")"
if node -e '
const f = require(process.argv[1]);
const actionable = Object.values(f.actionable || {}).flat();
if (actionable.includes("T-03-01")) { console.error("still actionable: " + actionable.join(", ")); process.exit(1); }
if (!((f.waiting || {}).merge_human || []).includes("T-03-01")) { console.error("waiting=" + JSON.stringify(f.waiting)); process.exit(1); }
if (!/merge_without_ci/.test(f.why["T-03-01"] || "")) { console.error("why=" + f.why["T-03-01"]); process.exit(1); }
process.exit(0);
' "$W/nc-front.json" 2>"$W/nc-front.err2"; then
  ok "the board calls a PR with no reported checks a human's merge, and names the setting"
else
  bad "the board holds the no-CI PR" "$(cat "$W/nc-front.err2")"
fi

( cd "$ncproj" && PATH="$W/bin4:$PATH" node "$SCRIPTS/sentinel.cjs" duty --json > "$W/nc-duty.json" 2>/dev/null ) || true
if node -e '
const i = require(process.argv[1]).items.find((x) => x.ticket === "T-03-01");
process.exit(i && i.action === "human-merge" && /merge_without_ci/.test(i.why) ? 0 : 1);
' "$W/nc-duty.json" 2>/dev/null; then
  ok "duty agrees with the board rather than offering the merge it would refuse"
else
  bad "duty holds the no-CI PR" "$(head -30 "$W/nc-duty.json")"
fi

( cd "$ncproj" && PATH="$W/bin4:$PATH" node "$SCRIPTS/sentinel.cjs" merge T-03-01 --json > "$W/nc-merge.json" 2>/dev/null ) || true
if node -e '
const r = require(process.argv[1]).results[0];
process.exit(r && r.merged === false && r.blockers.some((b) => /merge_without_ci/.test(b)) ? 0 : 1);
' "$W/nc-merge.json" 2>/dev/null; then
  ok "the gate refuses to land a PR where nothing ran"
else
  bad "the gate refuses the no-CI merge" "$(head -30 "$W/nc-merge.json")"
fi

# …and the project that genuinely has no CI says so and gets its merge — with
# the squash pinned to the head every gate above it was checked against.
echo '{"pipeline":{"merge_without_ci":true}}' > "$ncproj/.planning/config.json"
( cd "$ncproj" && PATH="$W/bin4:$PATH" SENTINEL_SMOKE_LOG="$W/nc-argv.log" \
    node "$SCRIPTS/sentinel.cjs" merge T-03-01 --json > "$W/nc-merge2.json" 2>/dev/null ) || true
if node -e '
const r = require(process.argv[1]).results[0];
process.exit(r && r.merged === true ? 0 : 1);
' "$W/nc-merge2.json" 2>/dev/null; then
  ok "merge_without_ci lets the same PR land (the control)"
else
  bad "merge_without_ci lets the PR land" "$(head -30 "$W/nc-merge2.json")"
fi
if grep -q -- "pr merge 401 --squash --match-head-commit $NCHEAD" "$W/nc-argv.log"; then
  ok "the squash pins the head the gate was checked against"
else
  bad "the squash pins the verified head" "$(grep '^pr merge' "$W/nc-argv.log" || echo 'no pr merge call logged')"
fi

echo
echo "$pass passed, $fail failed"
[[ "$fail" == 0 ]] || exit 1
