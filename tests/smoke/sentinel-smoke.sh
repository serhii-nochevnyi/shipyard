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
# `return 0` is load-bearing under `set -e`: called with no detail argument the
# trailing `[[ -n "" ]] && …` made this function exit 1, which killed the whole
# run at the FIRST such failure — the summary never printed and every assertion
# after it silently stopped being a test. A recorded failure is what the counter
# and the final `exit 1` are for.
bad() { fail=$((fail + 1)); echo "  ✗ $1"; [[ -n "${2:-}" ]] && echo "$2" | sed 's/^/      /'; return 0; }
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
    # the open-only pass: reviewDecision + body (the gate_status trailer) + the
    # merge state. PR 101's trailer names the SAME head the row below reports,
    # which is the ordinary path — the mismatch has its own fixture at the end of
    # this file.
    #
    # `mergeStateStatus` is answered HERE and NOWHERE ELSE, deliberately: the bulk
    # `pr list --state all` row below does not carry it, so a `merge_state` in the
    # written board can only have come from this open-only pass — which is the
    # rule ADR-002 imposes (never a new field in the bulk window) expressed as a
    # fixture rather than as a comment.
    #
    # UNQUOTED heredoc: SENTINEL_SMOKE_MERGE_STATE has to reach the SYNC and not
    # only `pr view 101` below, because one fact read two ways — by the board and
    # by the guard — is what this whole file is about. (`\n` survives an unquoted
    # heredoc; printf would turn it into a real newline and the JSON would stop
    # parsing.)
    cat <<JSON
[{"number":101,"reviewDecision":null,"mergeStateStatus":"${SENTINEL_SMOKE_MERGE_STATE:-CLEAN}","body":"Ticket: T-01-01\n\nProblem: x\n\ngate_status: arch-review=conform, drift-check=fresh, checks=green, head=1111111111111111111111111111111111111111"},
 {"number":102,"reviewDecision":"CHANGES_REQUESTED","mergeStateStatus":"CLEAN","body":"Ticket: T-01-02\n"}]
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
  # `reviewers.cjs unresolved` reads the review decision AND the merge state off
  # one PR view — which is how `duty` learns the base moved without a second call
  # per PR per round. SENTINEL_SMOKE_MERGE_STATE is the moved-base fixture.
  "pr view 101 --json"*)
    printf '{"number":101,"state":"OPEN","isDraft":false,"baseRefName":"epic/01-demo","headRefName":"ticket/T-01-01-root","mergeStateStatus":"%s","reviewDecision":null,"body":"Ticket: T-01-01"}\n' "${SENTINEL_SMOKE_MERGE_STATE:-CLEAN}" ;;
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

# The bulk window does not carry mergeStateStatus (see the stub), so a value here
# proves the open-only pass attached it — and that the board's `baseMoved` is
# finally fed. It shipped reading a field nothing wrote.
[[ "$(q T-01-01 merge_state)" == "CLEAN" ]] \
  && ok "the merge state rides the open-only pass into the board" \
  || bad "the merge state is recorded from the open-only pass" "got: $(q T-01-01 merge_state)"

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
# The guard reads the base's freshness for every PR it is about to walk towards a
# merge, off the same `reviewers.cjs unresolved` call plus one compare. `clean`
# and `unknown` are different answers and only one of them may end in `merge`:
# before this, `duty` said `merge` and the gate — which does ask — refused.
[[ "$(d T-01-01 base_check)" == "clean" ]] \
  && ok "duty records that the base WAS checked, not merely that nothing objected" \
  || bad "duty records the base check" "got: $(d T-01-01 base_check)"

# ── the duty names a remedy that exists ──────────────────────────────────────
# Same fixture, one fact changed: GitHub reports the PR as BEHIND. `mergeOne`
# refused this with a message and no action and `duty` had no action for it at
# all, so the board offered the merge the gate was about to decline and the
# documented fix was reachable by prose alone.
bmduty="$W/bm-duty.json"
( cd "$proj" && SENTINEL_SMOKE_MERGE_STATE=BEHIND \
    node "$SCRIPTS/sentinel.cjs" duty --json > "$bmduty" 2>/dev/null ) || bad "duty runs against a BEHIND PR"
if node -e '
const d = require(process.argv[1]);
const i = (d.items || []).find((x) => x.ticket === "T-01-01");
if (!i) { console.error("no duty item"); process.exit(1); }
if (i.action !== "base-merge") { console.error("action=" + i.action + " why=" + i.why); process.exit(1); }
if (!/base-merge\.cjs/.test(i.why)) { console.error("the remedy must be a command: " + i.why); process.exit(1); }
if (!d.items.some((x) => x.action === "base-merge") || d.actionable_count < 1) {
  console.error("a base merge is work the guard can do NOW: " + JSON.stringify(d.actionable_count)); process.exit(1);
}
process.exit(0);
' "$bmduty" 2>"$W/bm.err"; then
  ok "duty answers base-merge for a PR whose base moved, and names the script"
else
  bad "duty answers base-merge" "$(cat "$W/bm.err"; head -20 "$bmduty")"
fi

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

# ── …and the board written by a REAL sync says the same about a moved base ────
# The duty assertion above passed for a whole epic while the BOARD still offered
# the merge, because `front.cjs baseMoved` reads `merge_state`/`behind_by` and
# `state-sync.cjs` wrote neither: the guard refused what the board offered, every
# round, until the stop-gate ledger ran out of refusals. `front.test.cjs` injects
# those fields by hand, which is exactly how it shipped dead — so this case goes
# through a real state-sync and asserts the FILE the stop gate reads.
bmboard="$W/bm-board.txt"
( cd "$proj" && SENTINEL_SMOKE_MERGE_STATE=BEHIND \
    node "$SCRIPTS/state-sync.cjs" > "$bmboard" 2>"$W/bm-sync.err" ) \
  || bad "state-sync runs against a BEHIND PR" "$(cat "$W/bm-sync.err")"

[[ "$(q T-01-01 merge_state)" == "BEHIND" ]] \
  && ok "state-sync records GitHub's BEHIND verdict" \
  || bad "state-sync records the BEHIND verdict" "got: $(q T-01-01 merge_state)"

if node -e '
const f = require(process.argv[1]);
const fix = (f.actionable || {}).fix || [];
const merge = (f.actionable || {}).merge || [];
if (!fix.includes("T-01-01")) { console.error("actionable.fix=" + JSON.stringify(fix)); process.exit(1); }
if (merge.includes("T-01-01")) { console.error("still offered as a merge the guard refuses"); process.exit(1); }
if (!/base-merge\.cjs/.test(f.why["T-01-01"] || "")) { console.error("why=" + f.why["T-01-01"]); process.exit(1); }
// The guard owns the bucket, so the board must say so — the main loop dispatches
// nothing here and a fix filed under the wrong owner is a fix nobody performs.
if (!((f.sentinel || {}).duty || []).includes("T-01-01")) { console.error("sentinel=" + JSON.stringify(f.sentinel)); process.exit(1); }
process.exit(0);
' "$front" 2>"$W/bm-front.err"; then
  ok "the board files a stale-base PR as the guard's fix work, naming base-merge.cjs"
else
  bad "the board files a stale-base PR as fix work" "$(cat "$W/bm-front.err")"
fi
has "…and the board's own printout says fix, not merge" "$bmboard" "fix: T-01-01"
hasnt "…and never offers the merge alongside it" "$bmboard" "merge: T-01-01"

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

# ── a check state that could not be READ is neither empty nor green ─────────
# The fourth state, end to end across the three readers, because the acceptance
# criterion is about what STATE-SYNC WRITES and no unit test runs that script.
# An unreadable `gh pr checks` (a 503, a rate limit, an old `gh` rejecting
# `--json bucket`) reached the board first as an empty list — `none_reported`,
# which routes to "confirm this repo has no CI", asking a person about a reading
# that never happened — and then as a synthetic unknown-bucket row, which waits
# for the right reason while reporting one running check on a PR nobody read.
#
# The stub answers every call state-sync makes and fails only `pr checks`, so the
# rest of the board is ordinary and the assertions measure this one fact.
URHEAD=5555555555555555555555555555555555555555
urproj="$W/urproj"
mkdir -p "$urproj/.planning/graph" "$W/bin8"
cat > "$urproj/.planning/graph/tickets.json" <<'JSON'
{ "epics": { "5": { "branch": "epic/05-demo", "repos": [null] } },
  "tickets": { "T-05-01": { "phase": "5", "epic": "epic/05-demo", "branch": "ticket/T-05-01-unread",
                            "title": "unreadable checks", "depends_on": [], "risk": "low" } } }
JSON
echo '{"pipeline":{}}' > "$urproj/.planning/config.json"
cat > "$W/bin8/gh" <<STUB
#!/usr/bin/env bash
argv="\$*"
case "\$argv" in
  "repo view --json defaultBranchRef"*) echo "main" ;;
  "repo view --json owner,name"*) echo '{"owner":{"login":"acme"},"name":"demo"}' ;;
  "pr list --state open"*)
    echo '[{"number":501,"reviewDecision":"APPROVED","mergeStateStatus":"CLEAN","body":"Ticket: T-05-01\n\ngate_status: arch-review=conform, checks=green, head=$URHEAD"}]' ;;
  "pr list --state all"*)
    echo '[{"number":501,"state":"OPEN","isDraft":false,"headRefName":"ticket/T-05-01-unread","headRefOid":"$URHEAD","baseRefName":"epic/05-demo","mergedAt":null,"createdAt":"2026-01-01T00:00:00Z","url":"https://example/501","title":"T-05-01: unreadable checks"}]' ;;
  "api repos/{owner}/{repo}/branches"*) printf 'main\nepic/05-demo\nticket/T-05-01-unread\n' ;;
  # The ONE call that does not answer. gh prints the cause to stderr, nothing to
  # stdout, and exits non-zero — which is not the same fact as an empty list.
  # SENTINEL_SMOKE_CHECKS_OK flips it to the exit-1-with-\`[]\` control below:
  # \`gh pr checks\` exits 1 for a PR with no checks AT ALL as well as for a red
  # one, so that exit code is DATA and the two must stay tellable apart.
  "pr checks 501"*)
    # SENTINEL_SMOKE_CHECKS_JUNK is the THIRD mode: gh exits 0 and answers
    # something that is not a JSON array (an API error object, a wrapper, a
    # notice contaminating stdout). Exit 0 certifies that the COMMAND ran, never
    # that the ANSWER was readable, so the exit code must not be consulted at all
    # while stdout is non-empty.
    if [ -n "\${SENTINEL_SMOKE_CHECKS_JUNK:-}" ]; then echo '{"message":"Bad credentials"}'; exit 0; fi
    if [ -n "\${SENTINEL_SMOKE_CHECKS_OK:-}" ]; then echo '[]'; exit 1; fi
    echo "gh: HTTP 503: Service Unavailable (api.github.com)" >&2; exit 1 ;;
  "pr view 501 --json"*)
    echo '{"number":501,"state":"OPEN","isDraft":false,"baseRefName":"epic/05-demo","headRefName":"ticket/T-05-01-unread","headRefOid":"$URHEAD","mergeStateStatus":"CLEAN","reviewDecision":"APPROVED","body":"Ticket: T-05-01\n\ngate_status: arch-review=conform, checks=green, head=$URHEAD"}' ;;
  "api graphql"*)
    echo '{"data":{"repository":{"pullRequest":{"reviewThreads":{"nodes":[],"pageInfo":{"hasNextPage":false,"endCursor":null}}}}}}' ;;
  "api repos/"*"/compare/"*) echo 0 ;;
  "pr list --head "*) echo "[]" ;;
  "pr merge "*) echo "squash-merged" ;;
  *) echo "stub gh8: unhandled call: \$argv" >&2; exit 1 ;;
esac
STUB
chmod +x "$W/bin8/gh"

urboard="$W/ur-board.txt"
urstate="$urproj/.planning/graph/delivery-state.json"
( cd "$urproj" && PATH="$W/bin8:$PATH" node "$SCRIPTS/state-sync.cjs" > "$urboard" 2>"$W/ur-sync.err" ) \
  || bad "state-sync survives a gh pr checks that does not answer" "$(cat "$W/ur-sync.err")"
urq() { node -e 'const s=require(process.argv[1]);const v=process.argv.slice(2).reduce((o,k)=>o&&o[k],s);process.stdout.write(String(v))' "$urstate" "$@"; }

# The acceptance criterion, on the file state-sync writes. All three facts, because
# the bucket alone was already right under the synthetic row this replaces.
[[ "$(urq T-05-01 checks unavailable)" == "true" ]] \
  && ok "state records the reading that did not happen as its own state" \
  || bad "state carries checks.unavailable" "got: $(urq T-05-01 checks unavailable)"
[[ "$(urq T-05-01 checks none_reported)" == "false" ]] \
  && ok "…and NOT as an empty list, which would ask a person to confirm it" \
  || bad "an unreadable answer is not none_reported" "got: $(urq T-05-01 checks none_reported)"
[[ "$(urq T-05-01 checks pending)" == "0" && "$(urq T-05-01 checks total)" == "0" ]] \
  && ok "…and with no phantom check: zero were read, because none were" \
  || bad "the tallies stay at zero" "got: pending=$(urq T-05-01 checks pending) total=$(urq T-05-01 checks total)"
case "$(urq T-05-01 checks note)" in
  *"HTTP 503"*) ok "the cause gh printed is recorded, so every reader can quote it" ;;
  *) bad "the note names the cause" "got: $(urq T-05-01 checks note)" ;;
esac
# The PR is APPROVED in the stub deliberately, and that is what makes this
# assertion discriminate: `mergeable_since` needs approved + not-draft + GREEN, so
# the only remaining input is the green test. It used to be the arithmetic written
# out at this call site, which HOLDS on an all-zero tally — the sync started the
# "approved+green — awaiting merge" clock, and its stale warning, off a call that
# never answered. The paired control below is the same PR with a readable answer.
[[ "$(urq T-05-01 mergeable_since)" == "undefined" ]] \
  && ok "the awaiting-merge clock does not start on checks nobody read" \
  || bad "no mergeable_since on an unreadable read" "got: $(urq T-05-01 mergeable_since)"
has "the sync warns in its own words, not the no-CI ones" "$urboard" "check state UNREADABLE"
hasnt "…and never calls it green" "$urboard" "merge: T-05-01"
has "the board holds it as a wait, which resolves by looking again" "$urboard" "ci: T-05-01"
has "…and a run with a PR in CI is not a fixpoint" "$urboard" "fixpoint: NO"

if node -e '
const f = require(process.argv[1]);
const actionable = Object.values(f.actionable || {}).flat();
if (actionable.includes("T-05-01")) { console.error("still actionable: " + actionable.join(", ")); process.exit(1); }
if (!((f.waiting || {}).ci || []).includes("T-05-01")) { console.error("waiting=" + JSON.stringify(f.waiting)); process.exit(1); }
if (((f.waiting || {}).merge_human || []).includes("T-05-01")) { console.error("asked a human to confirm a reading that did not happen"); process.exit(1); }
const why = f.why["T-05-01"] || "";
if (!/checks unreadable/.test(why) || !/HTTP 503/.test(why)) { console.error("why=" + why); process.exit(1); }
if (/still running/.test(why)) { console.error("phantom pending check: " + why); process.exit(1); }
process.exit(0);
' "$urproj/.planning/graph/delivery-front.json" 2>"$W/ur-front.err"; then
  ok "the front says the checks are unreadable and names the cause"
else
  bad "the front holds the unreadable PR" "$(cat "$W/ur-front.err")"
fi

( cd "$urproj" && PATH="$W/bin8:$PATH" node "$SCRIPTS/sentinel.cjs" duty --json > "$W/ur-duty.json" 2>/dev/null ) || true
if node -e '
const i = require(process.argv[1]).items.find((x) => x.ticket === "T-05-01");
process.exit(i && i.action === "wait-ci" && /unreadable/.test(i.why) && /HTTP 503/.test(i.why) ? 0 : 1);
' "$W/ur-duty.json" 2>/dev/null; then
  ok "duty agrees with the board rather than offering the merge the gate would refuse"
else
  bad "duty holds the unreadable PR" "$(head -30 "$W/ur-duty.json")"
fi

( cd "$urproj" && PATH="$W/bin8:$PATH" node "$SCRIPTS/sentinel.cjs" merge T-05-01 --json > "$W/ur-merge.json" 2>/dev/null ) || true
if node -e '
const r = require(process.argv[1]).results[0];
const refused = r && r.merged === false && r.would_merge !== true;
process.exit(refused && r.blockers.some((b) => /HTTP 503/.test(b) && /could not be read/.test(b)) ? 0 : 1);
' "$W/ur-merge.json" 2>/dev/null; then
  ok "the gate refuses to land a PR whose checks it could not read, quoting gh"
else
  bad "the gate refuses the unreadable merge" "$(head -30 "$W/ur-merge.json")"
fi

# THE CONTROL, and the rule it pins is `CLAUDE.md`'s: `gh pr checks` reports CI
# state through its EXIT CODE while still printing the JSON, so exit 1 with a
# valid `[]` is a PR that genuinely has no checks — the ordinary no-CI path, and
# the answer a person decides once per repository.
( cd "$urproj" && PATH="$W/bin8:$PATH" SENTINEL_SMOKE_CHECKS_OK=1 \
    node "$SCRIPTS/state-sync.cjs" > "$W/ur-board2.txt" 2>"$W/ur-sync2.err" ) \
  || bad "state-sync runs on the exit-1-with-[] control" "$(cat "$W/ur-sync2.err")"
[[ "$(urq T-05-01 checks none_reported)" == "true" && "$(urq T-05-01 checks unavailable)" == "false" ]] \
  && ok "exit 1 with a valid [] is an OBSERVED empty list — the exit code is data" \
  || bad "exit code is data, not an error" \
     "got: none_reported=$(urq T-05-01 checks none_reported) unavailable=$(urq T-05-01 checks unavailable)"
[[ "$(urq T-05-01 checks note)" == "undefined" ]] \
  && ok "…and it carries no error note, because nothing errored" \
  || bad "no note on an observed empty list" "got: $(urq T-05-01 checks note)"
# The other half of the `mergeable_since` pair, and the one that proves the
# assertion above measures the flag rather than some unrelated gap in the
# fixture: the same approved PR, an answer that WAS read, and the clock starts.
# What "nothing ran" means is the front's decision (`merge_without_ci`), not the
# sync's — this file only records that the checks were readable and empty.
[[ "$(urq T-05-01 mergeable_since)" != "undefined" ]] \
  && ok "…and a readable answer does start that clock (the paired control)" \
  || bad "an observed empty list is green for the merge clock" "got: $(urq T-05-01 mergeable_since)"
has "…and it routes to the no-CI hold instead, unchanged" "$W/ur-board2.txt" "merge (human): T-05-01"

# ── exit 0 is not a certificate that the ANSWER was readable ────────────────
# The remaining cell of the same collapse, and the one ADR-004's F02 names as
# "malformed JSON": `gh` exits 0 and prints something that is not a JSON array.
# `state-sync.cjs` consulted the exit code even when stdout was non-empty, so it
# manufactured `[]` LOCALLY instead of handing the shape to `classify` — while
# `sentinel.cjs` and `ci-wait.cjs`, which both look at the exit code only when
# stdout is empty, called the same `gh` answer unreadable. One `gh` behaviour,
# two verdicts, and the board's was the one that asks a person to confirm that
# this repository has no CI.
#
# Deliberately AFTER the readable control above, which left `mergeable_since` on
# the board: that field is only ever written inside the `if (mergeable)` branch,
# so this run must not merely fail to start the awaiting-merge clock — it has to
# STOP one that is already running.
( cd "$urproj" && PATH="$W/bin8:$PATH" SENTINEL_SMOKE_CHECKS_JUNK=1 \
    node "$SCRIPTS/state-sync.cjs" > "$W/ur-board3.txt" 2>"$W/ur-sync3.err" ) \
  || bad "state-sync survives a gh that exits 0 with a non-array answer" "$(cat "$W/ur-sync3.err")"
[[ "$(urq T-05-01 checks unavailable)" == "true" && "$(urq T-05-01 checks none_reported)" == "false" ]] \
  && ok "exit 0 with non-array stdout is UNREADABLE, not an observed empty list" \
  || bad "exit 0 does not certify that the answer was readable" \
     "got: unavailable=$(urq T-05-01 checks unavailable) none_reported=$(urq T-05-01 checks none_reported)"
[[ "$(urq T-05-01 checks pending)" == "0" && "$(urq T-05-01 checks total)" == "0" ]] \
  && ok "…with no phantom check here either" \
  || bad "the tallies stay at zero" "got: pending=$(urq T-05-01 checks pending) total=$(urq T-05-01 checks total)"
[[ "$(urq T-05-01 mergeable_since)" == "undefined" ]] \
  && ok "…and the awaiting-merge clock the readable run started is STOPPED" \
  || bad "an unreadable read clears mergeable_since" "got: $(urq T-05-01 mergeable_since)"
# THE NOTE, on every surface that quotes it. gh printed nothing to stderr and did
# not fail to spawn, so the exit-code fallback was the only arm left and it said
# "gh pr checks exited 0" — which names no cause whatever. The provenance rule is
# one order stated once (stderr → spawn error → unparseable stdout → exit code),
# so this cell quotes what gh actually answered.
case "$(urq T-05-01 checks note)" in
  *"Bad credentials"*) ok "the note quotes the unparseable answer, not \"exited 0\"" ;;
  *) bad "the note names what gh answered" "got: $(urq T-05-01 checks note)" ;;
esac
has "the sync warns in the UNREADABLE words here too" "$W/ur-board3.txt" "check state UNREADABLE"
hasnt "…and never asks a person to confirm this repo has no CI" "$W/ur-board3.txt" "no CI checks reported"
has "the board holds it as a wait that resolves by looking again" "$W/ur-board3.txt" "ci: T-05-01"
hasnt "…and never offers it as a merge" "$W/ur-board3.txt" "merge: T-05-01"

if node -e '
const f = require(process.argv[1]);
const actionable = Object.values(f.actionable || {}).flat();
if (actionable.includes("T-05-01")) { console.error("still actionable: " + actionable.join(", ")); process.exit(1); }
if (!((f.waiting || {}).ci || []).includes("T-05-01")) { console.error("waiting=" + JSON.stringify(f.waiting)); process.exit(1); }
if (((f.waiting || {}).merge_human || []).includes("T-05-01")) { console.error("asked a human to confirm a reading that did not happen"); process.exit(1); }
const why = f.why["T-05-01"] || "";
if (!/checks unreadable/.test(why) || !/Bad credentials/.test(why)) { console.error("why=" + why); process.exit(1); }
process.exit(0);
' "$urproj/.planning/graph/delivery-front.json" 2>"$W/ur-front3.err"; then
  ok "the front names the answer gh gave as the cause"
else
  bad "the front holds the exit-0 unreadable PR" "$(cat "$W/ur-front3.err")"
fi

( cd "$urproj" && PATH="$W/bin8:$PATH" SENTINEL_SMOKE_CHECKS_JUNK=1 \
    node "$SCRIPTS/sentinel.cjs" duty --json > "$W/ur-duty3.json" 2>/dev/null ) || true
if node -e '
const i = require(process.argv[1]).items.find((x) => x.ticket === "T-05-01");
process.exit(i && i.action === "wait-ci" && /unreadable/.test(i.why) && /Bad credentials/.test(i.why) ? 0 : 1);
' "$W/ur-duty3.json" 2>/dev/null; then
  ok "the guard's duty quotes the same cause the board does"
else
  bad "duty names the exit-0 unreadable cause" "$(head -30 "$W/ur-duty3.json")"
fi

( cd "$urproj" && PATH="$W/bin8:$PATH" SENTINEL_SMOKE_CHECKS_JUNK=1 \
    node "$SCRIPTS/sentinel.cjs" merge T-05-01 --json > "$W/ur-merge3.json" 2>/dev/null ) || true
if node -e '
const r = require(process.argv[1]).results[0];
const refused = r && r.merged === false && r.would_merge !== true;
process.exit(refused && r.blockers.some((b) => /Bad credentials/.test(b) && /could not be read/.test(b)) ? 0 : 1);
' "$W/ur-merge3.json" 2>/dev/null; then
  ok "the gate refuses it quoting the answer, so the remedy is not a guess"
else
  bad "the gate refuses the exit-0 unreadable merge" "$(head -30 "$W/ur-merge3.json")"
fi

# ── a resync writes the front it means ───────────────────────────────────────
# THREE writers produce delivery-front.json — front.cjs's CLI, dispatch-record's
# `refreshFront` and state-sync — and only the last one was blind to the two
# durable overlays. Measured 2026-09-07 while delivering this phase: a background
# guard ran state-sync while six to ten tickets were with agents, the board came
# back `execute: …/finalize: …` with `waiting.dispatched: []`, and the stop gate
# blocked over work in flight THREE times in one session — each time repaired by
# hand with `dispatch-record.cjs mark`. The guards sync on their own schedule, so
# no sequencing of the main loop's calls closes that window; only state-sync
# applying the overlay itself does.
#
# Its own fixture, deliberately: the assertions above share `$proj` and this case
# has to run state-sync three times over a mutating store.
dproj="$W/dispproj"
mkdir -p "$dproj/.planning/graph"
cp "$proj/.planning/graph/tickets.json" "$dproj/.planning/graph/tickets.json"
echo '{"pipeline":{}}' > "$dproj/.planning/config.json"
dfront="$dproj/.planning/graph/delivery-front.json"
dstore="$dproj/.planning/graph/dispatches.json"
dboard="$W/disp-board.txt"
sync_d() { ( cd "$dproj" && node "$SCRIPTS/state-sync.cjs" > "$dboard" 2>"$W/disp-err.txt" ) \
  || bad "state-sync runs on the dispatch fixture" "$(cat "$W/disp-err.txt")"; }

# The control, and acceptance criterion "without a dispatch record the board is
# unchanged": the same verdict the shared fixture produces at the top of the file.
sync_d
has "no dispatch record: the board offers the merge as before" "$dboard" "merge: T-01-01"
has "no dispatch record: one item is actionable" "$dboard" "front: 1 actionable now"

# A live record for the ticket the board would otherwise offer.
node -e '
const fs = require("fs");
fs.writeFileSync(process.argv[1], JSON.stringify({
  tickets: { "T-01-01": { role: "pr-sentinel", at: new Date().toISOString() } },
}, null, 2) + "\n");
' "$dstore"
sync_d
has "a resync keeps a dispatched ticket off the board" "$dboard" "dispatched: T-01-01"
has "…and reports nothing actionable rather than re-offering it" "$dboard" "front: 0 actionable now"
if node -e '
const f = require(process.argv[1]);
if (!f.dispatches_applied_at) { console.error("no dispatches_applied_at: " + Object.keys(f).join(", ")); process.exit(1); }
if (!((f.waiting || {}).dispatched || []).includes("T-01-01")) { console.error("waiting=" + JSON.stringify(f.waiting)); process.exit(1); }
const actionable = Object.values(f.actionable || {}).flat();
if (actionable.includes("T-01-01")) { console.error("still actionable: " + actionable.join(", ")); process.exit(1); }
process.exit(0);
' "$dfront" 2>"$W/disp-front.err"; then
  ok "the written front carries the overlay and stamps when it was applied"
else
  bad "the written front carries the overlay" "$(cat "$W/disp-front.err")"
fi

# Expiry stays the store's decision and nothing else's: an out-of-TTL record must
# suppress nothing, or a killed session parks a ticket forever.
node -e '
const fs = require("fs");
fs.writeFileSync(process.argv[1], JSON.stringify({
  tickets: { "T-01-01": { role: "pr-sentinel", at: "2020-01-01T00:00:00Z" } },
}, null, 2) + "\n");
' "$dstore"
sync_d
has "an expired dispatch suppresses nothing" "$dboard" "merge: T-01-01"
hasnt "…and never reaches the waiting line" "$dboard" "dispatched: T-01-01"

# ── the same sync must not flatten a park's lifetime ─────────────────────────
# state-sync read `activeEscalations` — the flat {ticket: reason} view, which has
# already discarded the kind — where both other writers read `activeParks`. A
# plan_defect park therefore reached the board wearing the ESCALATION sentence
# ("it lifts once the PR moves"), which is false for a verdict bound to the plan
# hash: pushing to the PR lifts nothing, and the person told otherwise waits.
# `formatFront` never prints `why`, so the board being asserted here is the FILE.
rm -f "$dstore"
mkdir -p "$dproj/.planning/phases/01-demo"
dplan="$dproj/.planning/phases/01-demo/01-01-PLAN.md"
printf -- '---\nphase: 1\nplan: 1\n---\n\n## Goal\n\nroot\n' > "$dplan"
( cd "$dproj" && node "$SCRIPTS/escalation-record.cjs" mark-plan-defect T-01-01 "$dplan" \
    "the plan names an endpoint that does not exist" > /dev/null 2>"$W/disp-park.err" ) \
  || bad "mark-plan-defect records the park" "$(cat "$W/disp-park.err")"
sync_d
if node -e '
const why = (require(process.argv[1]).why || {})["T-01-01"] || "";
if (!/the park lifts when the plan file changes/.test(why)) { console.error("why=" + why); process.exit(1); }
if (/It lifts by itself once the PR moves/.test(why)) { console.error("the PR sentence: " + why); process.exit(1); }
process.exit(0);
' "$dfront" 2>"$W/disp-park2.err"; then
  ok "a plan_defect park is described by the rule that actually expires it"
else
  bad "a plan_defect park keeps its own lifetime through a resync" "$(cat "$W/disp-park2.err")"
fi

# ── a slower sync never rolls a newer board back ─────────────────────────────
# Everything a sync knows — the previous state, its timestamps and every GitHub
# observation — is gathered OUTSIDE the write lock, because those are minutes of
# network calls. Two syncs run concurrently BY DESIGN (the main loop and the
# guard), so the one that started earlier can finish later and then publish
# valid, coherent, OLDER JSON over the newer board: apparent status reversals,
# duplicated transitions, reap and ownership decisions taken off superseded facts
# (audit F13). Atomic writes do not help — each write is whole, and the WRONG one
# wins. So the snapshot carries `observed_at` plus a `generation`, and the
# publish is a compare-and-swap performed INSIDE the lock.
#
# `SHIPYARD_STATE_OBSERVED_AT` is what makes the losing run reproducible: a real
# race is scheduling-dependent, and the fact under test is not "who reached the
# lock first" but "whose facts are older".
genproj="$W/genproj"
mkdir -p "$genproj/.planning/graph"
cp "$proj/.planning/graph/tickets.json" "$genproj/.planning/graph/tickets.json"
echo '{"pipeline":{}}' > "$genproj/.planning/config.json"
genmeta="$genproj/.planning/graph/delivery-state-meta.json"
genstate="$genproj/.planning/graph/delivery-state.json"
genfront="$genproj/.planning/graph/delivery-front.json"
sync_g() { ( cd "$genproj" && env "$@" node "$SCRIPTS/state-sync.cjs" > "$W/gen-board.txt" 2>"$W/gen-err.txt" ); }
# Reads a key path out of a JSON file WITHOUT dying when the file is absent —
# unlike the `require`-based readers above, the very existence of what this one
# reads is under test, and a helper that throws there would abort the suite and
# hide every assertion after it.
jget() { node -e '
  const fs = require("fs");
  let s = null;
  try { s = JSON.parse(fs.readFileSync(process.argv[1], "utf8")); } catch { process.stdout.write("<unreadable>"); process.exit(0); }
  const v = process.argv.slice(2).reduce((o, k) => (o == null ? o : o[k]), s);
  process.stdout.write(String(v));
' "$@"; }

sync_g || bad "the first sync runs" "$(cat "$W/gen-err.txt")"
[[ -f "$genmeta" ]] \
  && ok "a sync publishes the snapshot's own identity beside the board" \
  || bad "the snapshot carries a generation"
[[ "$(jget "$genmeta" generation)" == "1" ]] \
  && ok "the first published snapshot is generation 1" \
  || bad "the first snapshot is generation 1" "got: $(jget "$genmeta" generation)"
# The metadata must NOT be a key in delivery-state.json: every top-level key
# there is a ticket id, and front.cjs iterates them without checking tickets.json
# — so an `observed_at` sibling would become a phantom ticket in the buckets the
# stop gate reads.
if node -e '
const s = require(process.argv[1]);
const strays = Object.entries(s).filter(([, v]) => !v || typeof v !== "object");
if (strays.length) { console.error("non-ticket keys: " + strays.map(([k]) => k).join(", ")); process.exit(1); }
process.exit(0);
' "$genstate" 2>"$W/gen-stray.err"; then
  ok "…and never as a phantom ticket inside the state map"
else
  bad "the state map holds ticket entries only" "$(cat "$W/gen-stray.err")"
fi
[[ "$(jget "$genfront" generation)" == "1" ]] \
  && ok "the front the stop gate reads names the same generation" \
  || bad "the front carries the generation" "got: $(jget "$genfront" generation)"

# A value a real write would overwrite: the strongest possible proof that the
# losing run wrote NOTHING, rather than writing something that happens to match.
node -e '
const fs = require("fs"); const f = process.argv[1];
const s = JSON.parse(fs.readFileSync(f, "utf8"));
s["T-01-01"].status = "TAMPERED";
fs.writeFileSync(f, JSON.stringify(s, null, 2) + "\n");
' "$genstate"

# The slower sync: its facts are from 2020, the board on disk was observed today.
if sync_g SHIPYARD_STATE_OBSERVED_AT=2020-01-01T00:00:00Z; then
  ok "a sync that lost the race exits 0 — a refusal is an outcome, not a failure"
else
  bad "the losing sync exits 0" "$(cat "$W/gen-board.txt" "$W/gen-err.txt")"
fi
has "…and says a newer snapshot landed while it was reading" "$W/gen-board.txt" "a newer snapshot"
has "…that the newer one was kept" "$W/gen-board.txt" "kept the newer one"
has "…naming the generation it deferred to" "$W/gen-board.txt" "generation 1"
[[ "$(jget "$genstate" T-01-01 status)" == "TAMPERED" ]] \
  && ok "…and wrote nothing at all: the newer board is untouched" \
  || bad "the losing sync must not write" "got: $(jget "$genstate" T-01-01 status)"
[[ "$(jget "$genmeta" generation)" == "1" ]] \
  && ok "…so the generation on disk never moved" \
  || bad "a refused publish must not bump the generation" "got: $(jget "$genmeta" generation)"
hasnt "…and it prints no board summary off facts it declined to publish" "$W/gen-board.txt" "integration mode:"

# The control, and it is what proves the refusal is the COMPARISON and not a
# freeze: the same fixture, observations of its own, publishes generation 2 and
# repairs the tampered row.
sync_g || bad "the next sync runs" "$(cat "$W/gen-err.txt")"
[[ "$(jget "$genmeta" generation)" == "2" ]] \
  && ok "a sync with fresher facts publishes the next generation" \
  || bad "the counter advances for a fresher sync" "got: $(jget "$genmeta" generation)"
[[ "$(jget "$genstate" T-01-01 status)" == "pr-open" ]] \
  && ok "…and rewrites the board it is entitled to rewrite" \
  || bad "the winning sync writes the board" "got: $(jget "$genstate" T-01-01 status)"
has "…and reports which snapshot it published" "$W/gen-board.txt" "snapshot generation 2"

# An equal observation window is not a newer one: a re-run of the same read must
# still publish, or an idempotent resync would refuse itself.
same="$(jget "$genmeta" observed_at)"
sync_g SHIPYARD_STATE_OBSERVED_AT="$same" || bad "a re-run of the same observation runs" "$(cat "$W/gen-err.txt")"
[[ "$(jget "$genmeta" generation)" == "3" ]] \
  && ok "an equally-fresh sync still publishes — only a STRICTLY newer board wins" \
  || bad "an equal observation window must not be refused" "got: $(jget "$genmeta" generation)"

# ── a review verdict with nothing behind it, through a real sync ─────────────
# The other half of the pair T-24-06 shared between the board and the guard, and
# deliberately NOT symmetrical with the case above. `front.cjs reviewStandsAlone`
# reads `unresolved_count`, and state-sync does not write it and must not: a
# thread count is a per-PR GraphQL query, the class of field that made a monorepo
# sync cost 41s instead of 7s, and this sync runs on every babysit round. So the
# board cannot see a real zero at all — the guard reads it live, answers
# `wait-human`, and the DURABLE form of that answer is a park the board then
# reads like any other park. All of it asserted through a real state-sync,
# because `front.test.cjs` injects the field by hand and that is precisely how
# the dead branch passed eleven reviews.
rsproj="$W/reviewstands"
RSHEAD=5555555555555555555555555555555555555555
mkdir -p "$rsproj/.planning/graph" "$W/bin5"
cat > "$W/bin5/gh" <<'STUB'
#!/usr/bin/env bash
argv="$*"
case "$argv" in
  "repo view --json defaultBranchRef"*) echo "main" ;;
  "repo view --json owner,name"*) echo '{"owner":{"login":"acme"},"name":"demo"}' ;;
  "pr list --state all"*)
    echo '[{"number":501,"state":"OPEN","isDraft":false,"headRefName":"ticket/T-04-01-x","headRefOid":"5555555555555555555555555555555555555555","baseRefName":"epic/04-demo","mergedAt":null,"createdAt":"2026-01-01T00:00:00Z","url":"https://example/501","title":"T-04-01: x"}]' ;;
  # The review verdict is the ONE fact this fixture varies, and it is answered on
  # both calls that read it — the sync's open-only pass and the guard's own PR
  # view — because a fixture where the two disagree tests neither.
  "pr list --state open"*)
    cat <<JSON
[{"number":501,"reviewDecision":"${SENTINEL_SMOKE_REVIEW:-CHANGES_REQUESTED}","mergeStateStatus":"CLEAN","body":"Ticket: T-04-01\n\ngate_status: arch-review=conform, drift-check=fresh, checks=green, head=5555555555555555555555555555555555555555"}]
JSON
    ;;
  "api repos/{owner}/{repo}/branches"*) printf 'main\nepic/04-demo\nticket/T-04-01-x\n' ;;
  "api repos/{owner}/{repo}/compare"*) echo 0 ;;
  # ZERO review threads: every thread the reviewer filed is resolved and the
  # verdict still stands. This is the state a fixer cannot service — the threads
  # are closed, and the verdict is lifted neither by resolving them nor by
  # pushing.
  "api graphql"*)
    echo '{"data":{"repository":{"pullRequest":{"reviewThreads":{"nodes":[],"pageInfo":{"hasNextPage":false,"endCursor":null}}}}}}' ;;
  "pr checks 501"*) echo '[{"name":"build","state":"SUCCESS","bucket":"pass"}]' ;;
  "pr view 501 --json"*)
    cat <<JSON
{"number":501,"state":"OPEN","isDraft":false,"baseRefName":"epic/04-demo","headRefName":"ticket/T-04-01-x","headRefOid":"5555555555555555555555555555555555555555","mergeStateStatus":"CLEAN","reviewDecision":"${SENTINEL_SMOKE_REVIEW:-CHANGES_REQUESTED}","body":"Ticket: T-04-01\n\ngate_status: arch-review=conform, drift-check=fresh, checks=green, head=5555555555555555555555555555555555555555"}
JSON
    ;;
  "pr list --head "*) echo "[]" ;;
  *) echo "stub gh5: unhandled call: $argv" >&2; exit 1 ;;
esac
STUB
chmod +x "$W/bin5/gh"
cat > "$rsproj/.planning/graph/tickets.json" <<'JSON'
{ "epics": { "4": { "branch": "epic/04-demo", "repos": [null] } },
  "tickets": { "T-04-01": { "phase": "4", "epic": "epic/04-demo", "branch": "ticket/T-04-01-x",
                            "title": "x", "depends_on": [], "risk": "low" } } }
JSON
echo '{"pipeline":{}}' > "$rsproj/.planning/config.json"
rsstate="$rsproj/.planning/graph/delivery-state.json"
rsfront="$rsproj/.planning/graph/delivery-front.json"
rssync() { ( cd "$rsproj" && PATH="$W/bin5:$PATH" env "$@" node "$SCRIPTS/state-sync.cjs" \
    > "$W/rs-board.txt" 2>"$W/rs-sync.err" ) \
  || bad "state-sync runs on the review-stands fixture" "$(cat "$W/rs-sync.err")"; }
rsduty() { ( cd "$rsproj" && PATH="$W/bin5:$PATH" env "$@" node "$SCRIPTS/sentinel.cjs" duty --json \
    > "$W/rs-duty.json" 2>"$W/rs-duty.err" ) || true; }
rsitem() { node -e '
const d = require(process.argv[1]);
const i = (d.items || []).find((x) => x.ticket === "T-04-01");
if (!i) { console.error("no duty item: " + JSON.stringify(d.items)); process.exit(1); }
if (i.action !== process.argv[2]) { console.error("action=" + i.action + " why=" + i.why); process.exit(1); }
if (process.argv[3] && !new RegExp(process.argv[3]).test(i.why)) { console.error("why=" + i.why); process.exit(1); }
process.exit(0);
' "$W/rs-duty.json" "$@" 2>>"$W/rs-duty.err"; }

rssync
# The design fork, as an assertion rather than a comment: whatever else this sync
# grows, it never grows a per-PR thread query.
if node -e '
const s = require(process.argv[1]);
const carriers = Object.entries(s).filter(([, v]) => v && Object.prototype.hasOwnProperty.call(v, "unresolved_count"));
if (carriers.length) { console.error("unresolved_count written for: " + carriers.map(([k]) => k).join(", ")); process.exit(1); }
process.exit(0);
' "$rsstate" 2>"$W/rs-uc.err"; then
  ok "the thread count is never a sync field — it would cost a GraphQL call per PR per round"
else
  bad "the sync must not grow a per-PR thread query" "$(cat "$W/rs-uc.err")"
fi

# The guard, live: zero threads behind a standing verdict is nobody's work.
rsduty
if rsitem wait-human 're-review or dismiss'; then
  ok "duty: CHANGES_REQUESTED with zero threads is a reviewer's, not a fixer's"
else
  bad "duty answers wait-human" "$(cat "$W/rs-duty.err"; head -20 "$W/rs-duty.json")"
fi

# …and the board, which cannot read the threads, keeps the work rather than
# parking on a guess. This is the disagreement, and it is the correct half of it:
# "we could not read the threads" must fail towards the work.
if node -e '
const f = require(process.argv[1]);
const actionable = Object.values(f.actionable || {}).flat();
if (!actionable.includes("T-04-01")) { console.error("actionable=" + JSON.stringify(f.actionable)); process.exit(1); }
if (((f.waiting || {}).human || []).includes("T-04-01")) { console.error("the board parked on a guess"); process.exit(1); }
process.exit(0);
' "$rsfront" 2>"$W/rs-front.err"; then
  ok "the board does not invent the count it cannot read (it keeps the work)"
else
  bad "the board must not park on a guess" "$(cat "$W/rs-front.err")"
fi

# The durable form of the guard's answer. This is the act the design fork names,
# and it is what makes the fact reach a board rebuilt from GitHub.
( cd "$rsproj" && node "$SCRIPTS/escalation-record.cjs" mark T-04-01 \
    "CHANGES_REQUESTED stands with no unresolved thread — a reviewer must re-review or dismiss the verdict" \
    > /dev/null 2>"$W/rs-park.err" ) || bad "the park is recorded" "$(cat "$W/rs-park.err")"

rssync
if node -e '
const f = require(process.argv[1]);
const actionable = Object.values(f.actionable || {}).flat();
if (actionable.includes("T-04-01")) { console.error("still actionable: " + actionable.join(", ")); process.exit(1); }
if (!((f.parked || {}).blocked || []).includes("T-04-01")) { console.error("parked=" + JSON.stringify(f.parked)); process.exit(1); }
if (!/re-review or dismiss/.test(f.why["T-04-01"] || "")) { console.error("why=" + f.why["T-04-01"]); process.exit(1); }
process.exit(0);
' "$rsfront" 2>"$W/rs-front2.err"; then
  ok "the board reads the guard's park like any other park, and quotes its reason"
else
  bad "the board reads the park" "$(cat "$W/rs-front2.err")"
fi
rsduty
if rsitem parked 're-review or dismiss'; then
  ok "…and the guard holds the same PR on the same reason — one fact, two readers"
else
  bad "the guard holds the parked PR" "$(cat "$W/rs-duty.err"; head -20 "$W/rs-duty.json")"
fi

# The lifting rule is the whole reason a park is the right channel for this fact:
# the reviewer answers, and the board learns it from GitHub on the next sync with
# nobody remembering to unpark anything (parkFingerprint hashes review_decision).
rssync SENTINEL_SMOKE_REVIEW=APPROVED
if node -e '
const f = require(process.argv[1]);
if (((f.parked || {}).blocked || []).includes("T-04-01")) { console.error("still parked: " + JSON.stringify(f.parked)); process.exit(1); }
if (!((f.actionable || {}).merge || []).includes("T-04-01")) { console.error("actionable=" + JSON.stringify(f.actionable)); process.exit(1); }
process.exit(0);
' "$rsfront" 2>"$W/rs-front3.err"; then
  ok "answering the review lifts the park by itself — the board offers the merge again"
else
  bad "the park lifts when the verdict moves" "$(cat "$W/rs-front3.err")"
fi
rsduty SENTINEL_SMOKE_REVIEW=APPROVED
if rsitem merge; then
  ok "…and the guard agrees it is landable again"
else
  bad "the guard agrees the park lifted" "$(cat "$W/rs-duty.err"; head -20 "$W/rs-duty.json")"
fi

# ── a cross-phase parent is landed only when the comparison SAID so ──────────
# `landed` was `!exists || ahead === 0` over `parseInt(cmp) || 0`, so a failed or
# unparseable `gh api compare` — a rate limit, a network blip, an empty answer —
# arrived as the number 0 and read as "the whole phase is already on main".
# Reproduced in the audit (F07): parent P merged into its epic, the epic still
# ahead of main, a rate-limited compare, and every phase-N+1 child of P became
# `ready: true` on a base that does not contain P. Integration state is
# `landed | not-landed | unknown`, and `unknown` parks the dependents with the
# reason instead of being mapped to landed.
#
# Its own fixture and its own stub: this needs a MERGED parent in phase 1, a
# second phase whose epic does not exist yet, and a compare it can fail on
# demand — none of which the shared `$proj` above has.
xproj="$W/crossphase"
mkdir -p "$xproj/.planning/graph" "$W/bin6"
cat > "$W/bin6/gh" <<'STUB'
#!/usr/bin/env bash
argv="$*"
case "$argv" in
  "repo view --json defaultBranchRef"*) echo "main" ;;
  "repo view --json owner,name"*) echo '{"owner":{"login":"acme"},"name":"demo"}' ;;
  "pr list --state all"*)
    echo '[{"number":601,"state":"MERGED","isDraft":false,"headRefName":"ticket/T-01-01-parent","headRefOid":"6666666666666666666666666666666666666666","baseRefName":"epic/01-demo","mergedAt":"2026-01-02T00:00:00Z","createdAt":"2026-01-01T00:00:00Z","url":"https://example/601","title":"T-01-01: parent"}]' ;;
  "pr list --state open"*) echo '[]' ;;
  # phase 2's epic is deliberately absent: an epic that never started is landed
  # by construction and is never compared, so the ONE compare this fixture makes
  # is phase 1's — the fact under test.
  "api repos/{owner}/{repo}/branches"*) printf 'main\nepic/01-demo\nticket/T-01-01-parent\n' ;;
  # Ordered BEFORE the generic compare below, and the only call this fixture
  # varies. Exit 1 with the message GitHub actually sends: `gh` fails, the
  # tolerant helper returns null, and nothing about the phase has been observed.
  "api repos/{owner}/{repo}/compare/main...epic/01-demo"*)
    case "${SMOKE_COMPARE:-0}" in
      fail) echo "gh: API rate limit exceeded (HTTP 403)" >&2; exit 1 ;;
      # An exit-0 answer that is not a commit count is the same absence of
      # evidence: `parseInt("null") || 0` was the other half of the collapse.
      garbage) echo "null" ;;
      *) echo "${SMOKE_COMPARE:-0}" ;;
    esac ;;
  "api repos/{owner}/{repo}/compare"*) echo 0 ;;
  "pr list --head "*) echo "[]" ;;
  *) echo "stub gh6: unhandled call: $argv" >&2; exit 1 ;;
esac
STUB
chmod +x "$W/bin6/gh"
cat > "$xproj/.planning/graph/tickets.json" <<'JSON'
{
  "epics": {
    "1": { "branch": "epic/01-demo", "repos": [null] },
    "2": { "branch": "epic/02-demo", "repos": [null] }
  },
  "tickets": {
    "T-01-01": { "phase": "1", "epic": "epic/01-demo", "branch": "ticket/T-01-01-parent",
                 "title": "parent", "depends_on": [], "risk": "low" },
    "T-02-01": { "phase": "2", "epic": "epic/02-demo", "branch": "ticket/T-02-01-child",
                 "title": "child", "depends_on": ["T-01-01"], "risk": "low" }
  }
}
JSON
echo '{"pipeline":{}}' > "$xproj/.planning/config.json"
xboard="$W/x-board.txt"
xstate="$xproj/.planning/graph/delivery-state.json"
xsync() { ( cd "$xproj" && PATH="$W/bin6:$PATH" env "$@" node "$SCRIPTS/state-sync.cjs" \
    > "$xboard" 2>"$W/x-sync.err" ) \
  || bad "state-sync runs on the cross-phase fixture" "$(cat "$W/x-sync.err")"; }
xq() { node -e 'const s=require(process.argv[1]);const v=process.argv.slice(2).reduce((o,k)=>o&&o[k],s);process.stdout.write(String(v))' "$xstate" "$@"; }

# The control first: a compare that answers 0 is positive evidence, and the child
# is ready. This is the behaviour that must NOT change.
xsync SMOKE_COMPARE=0
has "a compare that answers 0 lands the phase and readies the child" "$xboard" "ready: T-02-01"
[[ "$(xq T-02-01 ready)" == "true" ]] \
  && ok "…and the board file says so too" \
  || bad "an observed 0 readies the cross-phase child" "got: $(xq T-02-01 ready)"

# A phase still ahead of main is not-landed — the existing block, kept honest.
xsync SMOKE_COMPARE=3
has "a phase still ahead of the base blocks its cross-phase children" "$xboard" "blocked: T-02-01"
has "…and says the epic is what they are waiting for" "$xboard" "epic still ahead"

# The defect: a compare that never answered.
xsync SMOKE_COMPARE=fail
has "a FAILED compare blocks the child instead of readying it" "$xboard" "blocked: T-02-01"
has "…and names the reason a person can act on" "$xboard" "integration state unknown"
has "…including the command that could not answer" "$xboard" "gh compare failed"
has "…and that it is retried rather than final" "$xboard" "retried next sync"
hasnt "…and never offers it as ready" "$xboard" "ready: T-02-01"
[[ "$(xq T-02-01 ready)" == "false" ]] \
  && ok "the board file agrees: nothing was proven, so nothing is ready" \
  || bad "a failed compare must not ready the child" "got: $(xq T-02-01 ready)"

# An exit-0 answer that is not a commit count is the same absence of evidence.
xsync SMOKE_COMPARE=garbage
has "an unparseable compare is unknown too, not zero" "$xboard" "integration state unknown"
hasnt "…and its child is not ready either" "$xboard" "ready: T-02-01"

# The board's epic line must not report a count it does not have: `null ahead of
# main` is how "we could not tell" gets read as "nothing to land".
xsync SMOKE_COMPARE=fail
hasnt "the epic line never prints a null commit count" "$xboard" "null ahead of"
has "…it says the state is unknown, and why" "$xboard" "integration state unknown"

# …and the front the stop gate reads must place the child in the parked bucket,
# not in `execute`. One fact, both readers.
xfront="$xproj/.planning/graph/delivery-front.json"
if node -e '
const f = require(process.argv[1]);
const actionable = Object.values(f.actionable || {}).flat();
if (actionable.includes("T-02-01")) { console.error("actionable=" + JSON.stringify(f.actionable)); process.exit(1); }
if (!((f.parked || {}).blocked || []).includes("T-02-01")) { console.error("parked=" + JSON.stringify(f.parked)); process.exit(1); }
if (!/integration state unknown/.test(f.why["T-02-01"] || "")) { console.error("why=" + f.why["T-02-01"]); process.exit(1); }
process.exit(0);
' "$xfront" 2>"$W/x-front.err"; then
  ok "the front parks the child on the unknown state and quotes the reason"
else
  bad "the front parks the child on an unknown integration state" "$(cat "$W/x-front.err")"
fi

# ── direct-to-main applies the same preconditions as epic-stacked ────────────
# The availability and `unreachable_paths` checks lived INSIDE the epic-stacked
# branch (audit F27), so in direct-to-main — including the legacy fallback a
# pre-epic tickets.json triggers — a dependency-free ticket became `ready` while
# its declared paths escaped the repo or its repository was unreachable. Both are
# facts about whether the ticket can be executed AT ALL, so they belong above the
# mode split.
dmproj="$W/directmain"
mkdir -p "$dmproj/.planning/graph" "$W/bin7"
cat > "$W/bin7/gh" <<'STUB'
#!/usr/bin/env bash
argv="$*"
case "$argv" in
  "repo view --json defaultBranchRef"*) echo "main" ;;
  "repo view --json owner,name"*) echo '{"owner":{"login":"acme"},"name":"demo"}' ;;
  # The foreign repo answers nothing: no access, or a typo in delivery.repo.
  # loadRepo tolerates that and marks the repo unavailable.
  *"--repo acme/other"*) echo "gh: Could not resolve to a Repository (HTTP 404)" >&2; exit 1 ;;
  "api repos/acme/other/"*) echo "gh: Could not resolve to a Repository (HTTP 404)" >&2; exit 1 ;;
  "pr list --state all"*) echo '[]' ;;
  "pr list --state open"*) echo '[]' ;;
  "api repos/{owner}/{repo}/branches"*) printf 'main\n' ;;
  "api repos/{owner}/{repo}/compare"*) echo 0 ;;
  "pr list --head "*) echo "[]" ;;
  *) echo "stub gh7: unhandled call: $argv" >&2; exit 1 ;;
esac
STUB
chmod +x "$W/bin7/gh"
cat > "$dmproj/.planning/graph/tickets.json" <<'JSON'
{
  "epics": {},
  "tickets": {
    "T-03-01": { "phase": "3", "branch": "ticket/T-03-01-escapes", "title": "escapes",
                 "depends_on": [], "risk": "low", "unreachable_paths": true },
    "T-03-02": { "phase": "3", "branch": "ticket/T-03-02-foreign", "title": "foreign",
                 "depends_on": [], "risk": "low", "repo": "acme/other" }
  }
}
JSON
echo '{"pipeline":{"integration_mode":"direct-to-main"}}' > "$dmproj/.planning/config.json"
dmboard="$W/dm-board.txt"
dmstate="$dmproj/.planning/graph/delivery-state.json"
( cd "$dmproj" && PATH="$W/bin7:$PATH" node "$SCRIPTS/state-sync.cjs" > "$dmboard" 2>"$W/dm-sync.err" ) \
  || bad "state-sync runs in direct-to-main" "$(cat "$W/dm-sync.err")"
dmq() { node -e 'const s=require(process.argv[1]);const v=process.argv.slice(2).reduce((o,k)=>o&&o[k],s);process.stdout.write(String(v))' "$dmstate" "$@"; }

has "direct-to-main is the mode under test" "$dmboard" "integration mode: direct-to-main"
has "a ticket whose paths escape the repo is blocked in direct-to-main too" "$dmboard" "blocked: T-03-01"
has "…with the plan blocker, not a dependency one" "$dmboard" "awaiting plan"
[[ "$(dmq T-03-01 ready)" == "false" ]] \
  && ok "…and the board file never calls it ready" \
  || bad "an unreachable-paths ticket is not ready in direct-to-main" "got: $(dmq T-03-01 ready)"
has "an unreachable repository blocks its ticket in direct-to-main too" "$dmboard" "awaiting repo"
[[ "$(dmq T-03-02 ready)" == "false" ]] \
  && ok "…and that ticket is not ready either" \
  || bad "a ticket in an unreachable repo is not ready in direct-to-main" "got: $(dmq T-03-02 ready)"
hasnt "neither is offered to an executor that would find nothing" "$dmboard" "ready: T-03-01"


# ── a corrupt configuration permits no mutation (ADR-004 D2, audit F03) ──────
# The audit's own fixture: a config TRUNCATED mid-object that CONTAINED
# `auto_merge: "off"`. loadConfig turned it into the DEFAULTS — `auto_merge:
# epic` — with only a warning, so the board published the policy the file forbade
# and the guard offered T-01-01 as a merge. End to end here, across all three
# readers, because the defect was that each of them read the same broken file and
# none of them refused.
cfgproj="$W/corrupt"
cp -r "$proj" "$cfgproj"
printf '%s' '{"pipeline": {"auto_merge": "off"' > "$cfgproj/.planning/config.json"
cfgboard="$W/corrupt-board.txt"
( cd "$cfgproj" && node "$SCRIPTS/state-sync.cjs" > "$cfgboard" 2>"$W/corrupt-sync.err" ) \
  || bad "state-sync still runs on a corrupt config" "$(cat "$W/corrupt-sync.err")"

has "the board says the config is INVALID" "$cfgboard" "INVALID"
has "…and that no policy is in effect" "$cfgboard" "no policy is in effect"
has "…and the auto-merge policy is off, not the default epic" "$cfgboard" "auto-merge: off"
hasnt "…and never says the defaults are in use" "$cfgboard" "using defaults"
hasnt "the green + conform PR is NOT offered as a merge" "$cfgboard" "merge: T-01-01"

cfgfront="$cfgproj/.planning/graph/delivery-front.json"
[[ "$(node -e 'process.stdout.write(String(require(process.argv[1]).auto_merge))' "$cfgfront")" == "off" ]] \
  && ok "the board FILE the loop reads carries auto_merge: off" \
  || bad "the front must not publish a policy read off an unparseable file"

cfgduty="$W/corrupt-duty.json"
( cd "$cfgproj" && node "$SCRIPTS/sentinel.cjs" duty --json > "$cfgduty" 2>/dev/null ) \
  || bad "sentinel duty still runs on a corrupt config"
if node -e '
const d = require(process.argv[1]);
if (d.config_valid !== false) { console.error("config_valid=" + d.config_valid); process.exit(1); }
if ((d.items || []).length !== 0) { console.error("items=" + JSON.stringify(d.items)); process.exit(1); }
if (d.auto_merge !== "off") { console.error("auto_merge=" + d.auto_merge); process.exit(1); }
process.exit(0);
' "$cfgduty" 2>"$W/corrupt-duty.err"; then
  ok "duty hands out no actions at all while the config does not parse"
else
  bad "duty must stand down on a corrupt config" "$(cat "$W/corrupt-duty.err")"
fi

cfgtext="$W/corrupt-duty.txt"
( cd "$cfgproj" && node "$SCRIPTS/sentinel.cjs" duty > "$cfgtext" 2>/dev/null ) || bad "duty prints on a corrupt config"
has "duty says config-invalid" "$cfgtext" "config-invalid:"
[[ "$(grep -c . "$cfgtext")" == "1" ]] \
  && ok "…in exactly one line, not a board built from defaults" \
  || bad "duty must print one line on a corrupt config" "$(cat "$cfgtext")"

cfgmerge="$W/corrupt-merge.json"
( cd "$cfgproj" && node "$SCRIPTS/sentinel.cjs" merge T-01-01 --dry-run --json > "$cfgmerge" 2>/dev/null ) \
  || bad "sentinel merge exits 0 on a corrupt config — a refusal is data"
if node -e '
const j = require(process.argv[1]);
const r = (j.results || [])[0] || {};
if (r.would_merge) { console.error("would_merge on an unreadable config"); process.exit(1); }
if (!(r.blockers || []).some((b) => /config unreadable/.test(b) && b.includes("config.json"))) {
  console.error("blockers=" + JSON.stringify(r.blockers)); process.exit(1);
}
process.exit(0);
' "$cfgmerge" 2>"$W/corrupt-merge.err"; then
  ok "merge --dry-run refuses and names the file a person can open"
else
  bad "merge must refuse on a corrupt config" "$(cat "$W/corrupt-merge.err"; cat "$cfgmerge")"
fi

echo
echo "$pass passed, $fail failed"
[[ "$fail" == 0 ]] || exit 1
