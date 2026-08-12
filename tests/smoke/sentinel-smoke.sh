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
    # the open-only pass: reviewDecision + body (the gate_status trailer)
    cat <<'JSON'
[{"number":101,"reviewDecision":null,"body":"Ticket: T-01-01\n\nProblem: x\n\ngate_status: arch-review=conform, drift-check=fresh, checks=green"},
 {"number":102,"reviewDecision":"CHANGES_REQUESTED","body":"Ticket: T-01-02\n"}]
JSON
    ;;
  "pr list --state all"*)
    cat <<'JSON'
[{"number":101,"state":"OPEN","isDraft":false,"headRefName":"ticket/T-01-01-root","baseRefName":"epic/01-demo","mergedAt":null,"createdAt":"2026-01-01T00:00:00Z","url":"https://example/101","title":"T-01-01: root"},
 {"number":102,"state":"OPEN","isDraft":false,"headRefName":"ticket/T-01-02-child","baseRefName":"ticket/T-01-01-root","mergedAt":null,"createdAt":"2026-01-01T00:00:00Z","url":"https://example/102","title":"T-01-02: child"}]
JSON
    ;;
  "api repos/{owner}/{repo}/branches"*) printf 'main\nepic/01-demo\nticket/T-01-01-root\nticket/T-01-02-child\n' ;;
  "api repos/{owner}/{repo}/compare"*) echo 0 ;;
  "pr checks 101"*) echo '[{"name":"build","state":"SUCCESS"}]' ;;
  "pr checks 102"*) echo '[{"name":"build","state":"FAILURE"}]'; exit 1 ;;
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

[[ "$(q T-01-01 merge_scope)" == "stacked" ]] \
  && ok "a PR targeting the epic is inside the stack" \
  || bad "a PR targeting the epic is inside the stack" "got: $(q T-01-01 merge_scope)"

[[ "$(q T-01-02 merge_scope)" == "stacked" ]] \
  && ok "a cascade PR targeting the parent branch is inside the stack too" \
  || bad "a cascade PR targeting the parent branch is inside the stack too" "got: $(q T-01-02 merge_scope)"

has "the board names the auto-merge policy" "$board" "auto-merge: epic"
has "the board names the sentinel's duty" "$board" "sentinel:"
has "the green + conform PR is a merge for the guard" "$board" "merge: T-01-01"
has "the red PR is fix work" "$board" "fix: T-01-02"
has "an unmerged mergeable PR is not a fixpoint" "$board" "fixpoint: NO"

# the guard's own view of the same state
duty="$W/duty.json"
( cd "$proj" && node "$SCRIPTS/sentinel.cjs" duty --json > "$duty" ) || bad "sentinel duty runs"
d() { node -e 'const s=require(process.argv[1]);process.stdout.write(String(s.items.find(i=>i.ticket===process.argv[2])[process.argv[3]]))' "$duty" "$@"; }
[[ "$(d T-01-01 action)" == "merge" ]] && ok "duty: the green + conform PR is a merge" || bad "duty: the green + conform PR is a merge" "got: $(d T-01-01 action)"
[[ "$(d T-01-02 action)" == "ci-fix" ]] && ok "duty: the red PR is ci-fix" || bad "duty: the red PR is ci-fix" "got: $(d T-01-02 action)"

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
cat > "$sproj/.planning/graph/delivery-log.jsonl" <<'JSON'
{"ts":"2026-01-02T00:00:00Z","event":"merge","ticket":"T-01-01","pr":201,"base":"epic/01-demo","by":"sentinel"}
{"ts":"2026-01-02T00:00:05Z","event":"merge","ticket":"T-01-01","pr":201,"outcome":"merged"}
{"ts":"2026-01-02T00:01:00Z","event":"attempt","ticket":"T-01-02","role":"frontend-delivery","outcome":"pushed"}
JSON
cat > "$W/bin2/gh" <<'STUB'
#!/usr/bin/env bash
case "$*" in
  "pr list --state all"*)
    cat <<'JSON'
[{"number":201,"state":"MERGED","isDraft":false,"headRefName":"ticket/T-01-01-guarded","baseRefName":"epic/01-demo","mergedAt":"2026-01-02T01:00:00Z","createdAt":"2026-01-02T00:00:00Z","url":"https://example/201","reviewDecision":null,"title":"T-01-01: guarded"},
 {"number":202,"state":"MERGED","isDraft":false,"headRefName":"ticket/T-01-02-raw","baseRefName":"epic/01-demo","mergedAt":"2026-01-02T01:00:00Z","createdAt":"2026-01-02T00:00:00Z","url":"https://example/202","reviewDecision":null,"title":"T-01-02: raw"}]
JSON
    ;;
  # Asked only for the PRs already flagged — never in the bulk window, where this
  # field costs the same order as reviewDecision.
  "pr view 202 --json mergedBy"*) echo "octo-human" ;;
  *) echo "stub gh2: unhandled: $*" >&2; exit 1 ;;
esac
STUB
chmod +x "$W/bin2/gh"
( cd "$sproj" && PATH="$W/bin2:$PATH" node "$SCRIPTS/pipeline-stats.cjs" ) > "$W/stats.txt" 2>&1 || true

has "stats names the ticket merged without the guard" "$W/stats.txt" "T-01-02#202"
hasnt "stats does not accuse the guarded merge" "$W/stats.txt" "T-01-01#201"
has "stats still credits the guarded merge" "$W/stats.txt" "sentinel landed 1 ticket PR"
has "stats names the role the ladder does not know" "$W/stats.txt" "frontend-delivery"
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

echo
echo "$pass passed, $fail failed"
[[ "$fail" == 0 ]] || exit 1
