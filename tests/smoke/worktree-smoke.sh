#!/usr/bin/env bash
set -euo pipefail

# Contract for the git layer of the conveyor (epic-branch.sh + ticket-worktree.sh),
# exercised against real local repositories. No network, no GitHub, no Docker.
#
# The behaviours pinned here are all resume-path behaviours — the ones that only
# break on the SECOND run, on a fresh clone, or on another machine, which is
# exactly where they used to break silently.

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SCRIPTS="$ROOT/plugins/delivery-pipeline/scripts"

W="$(mktemp -d)"
trap 'rm -rf "$W"' EXIT

pass=0; fail=0
ok()  { pass=$((pass + 1)); echo "  ✓ $1"; }
bad() { fail=$((fail + 1)); echo "  ✗ $1"; [[ -n "${2:-}" ]] && echo "$2" | sed 's/^/      /'; }

export GIT_CONFIG_GLOBAL="$W/gitconfig"
export GIT_CONFIG_NOSYSTEM=1
git config --file "$GIT_CONFIG_GLOBAL" user.email smoke@example.com
git config --file "$GIT_CONFIG_GLOBAL" user.name 'Smoke Test'
git config --file "$GIT_CONFIG_GLOBAL" init.defaultBranch main
git config --file "$GIT_CONFIG_GLOBAL" protocol.file.allow always

# origin + a seed clone that publishes main and an epic branch, then a SECOND
# clone that has never seen the epic locally (the resume / other-machine case).
git init -q --bare "$W/origin"
git init -q "$W/seed"
( cd "$W/seed"
  echo seed > file.txt
  git add file.txt
  git commit -qm 'init'
  git remote add origin "$W/origin"
  git push -q -u origin main
  git checkout -q -b epic/01-demo
  git push -q -u origin epic/01-demo )
git clone -q "$W/origin" "$W/fresh"

WT="$W/worktrees"
run_epic() { ( cd "$W/fresh" && bash "$SCRIPTS/epic-branch.sh" "$@" ); }
run_wt()   { ( cd "$W/fresh" && SHIPYARD_WORKTREE_ROOT="$WT" bash "$SCRIPTS/ticket-worktree.sh" "$@" ); }

echo "worktree/epic smoke"

# ── epic-branch ensure must leave a LOCAL ref behind ────────────────────────
if out="$(run_epic ensure epic/01-demo main 2>&1)"; then
  if git -C "$W/fresh" show-ref --verify --quiet refs/heads/epic/01-demo; then
    ok "ensure creates a local branch when origin/<epic> already exists"
  else
    bad "ensure creates a local branch when origin/<epic> already exists" "$out"
  fi
else
  bad "ensure succeeds on an already-published epic" "$out"
fi

# ── worktree create off a base that only existed on the remote ──────────────
# `git rev-parse <bare-name>` does NOT resolve a remote-only branch, so this used
# to fail with "base ref not found" on every root ticket of a resumed run.
git -C "$W/fresh" branch -D epic/01-demo >/dev/null 2>&1 || true
if out="$(run_wt create T-01-01 ticket/T-01-01-demo epic/01-demo 2>&1)"; then
  ok "create resolves a base that exists only as origin/<base>"
else
  bad "create resolves a base that exists only as origin/<base>" "$out"
fi

# ── idempotency: a resumed run must reuse, not explode ──────────────────────
if out="$(run_wt create T-01-01 ticket/T-01-01-demo epic/01-demo 2>&1)"; then
  grep -q 'reusing existing worktree' <<<"$out" \
    && ok "create is idempotent (reuses the worktree on the same branch)" \
    || bad "create is idempotent" "$out"
else
  bad "create is idempotent (a resumed run must not fail)" "$out"
fi

# ...but a genuine mismatch is a human's problem, not something to paper over
if run_wt create T-01-01 ticket/some-other-branch epic/01-demo >/dev/null 2>&1; then
  bad "create refuses an existing worktree on the WRONG branch"
else
  ok "create refuses an existing worktree on the WRONG branch"
fi

# ── list --json reports only the pipeline's worktrees, keyed by ticket ───────
run_wt create T-01-02 ticket/T-01-02-two epic/01-demo >/dev/null 2>&1 || true
listing="$(run_wt list --json 2>/dev/null || echo '[]')"
count="$(node -e 'const r=JSON.parse(process.argv[1]);console.log(r.length)' "$listing")"
if [[ "$count" == "2" ]]; then
  ok "list --json reports both ticket worktrees and excludes the main checkout"
else
  bad "list --json reports both ticket worktrees" "$listing"
fi
if node -e '
  const r = JSON.parse(process.argv[1]);
  const t = r.find((x) => x.ticket === "T-01-02");
  process.exit(t && t.branch === "ticket/T-01-02-two" ? 0 : 1);
' "$listing"; then
  ok "list --json maps ticket id → branch"
else
  bad "list --json maps ticket id → branch" "$listing"
fi

# ── remove is idempotent (the reaper re-enters after interrupted runs) ───────
run_wt remove T-01-02 >/dev/null 2>&1
if run_wt remove T-01-02 >/dev/null 2>&1; then
  ok "remove on a missing worktree exits 0"
else
  bad "remove on a missing worktree exits 0"
fi

# ── an unwritable worktree root fails with an ACTIONABLE message ─────────────
out="$( ( cd "$W/fresh" && SHIPYARD_WORKTREE_ROOT=/proc/nope/wt bash "$SCRIPTS/ticket-worktree.sh" \
  create T-09-09 ticket/T-09-09-x main 2>&1 ) || true )"
grep -q 'SHIPYARD_WORKTREE_ROOT' <<<"$out" \
  && ok "an unwritable worktree root names the override to set" \
  || bad "an unwritable worktree root names the override" "$out"

# ── a missing base is still a hard error ────────────────────────────────────
if run_wt create T-02-01 ticket/T-02-01-x does/not/exist >/dev/null 2>&1; then
  bad "create rejects a base that exists nowhere"
else
  ok "create rejects a base that exists nowhere"
fi

# ── git.base_branch outranks the repo default ───────────────────────────────
# GSD's git.base_branch IS the project's integration branch (it is what /gsd-ship
# targets). A repo that integrates into `develop` must not have its epics cut from
# main just because origin/HEAD points there.
( cd "$W/seed" && git checkout -q main && git checkout -q -b develop && echo dev > d.txt \
  && git add d.txt && git commit -qm 'develop only' && git push -q -u origin develop ) >/dev/null 2>&1
( cd "$W/fresh" && git fetch -q origin ) >/dev/null 2>&1
mkdir -p "$W/fresh/.planning"
echo '{"git":{"base_branch":"develop"}}' > "$W/fresh/.planning/config.json"
if out="$(run_epic ensure epic/03-based 2>&1)"; then
  # the epic must contain develop's commit, not just main's
  if git -C "$W/fresh" merge-base --is-ancestor origin/develop epic/03-based 2>/dev/null; then
    ok "ensure cuts the epic from git.base_branch when set"
  else
    bad "ensure cuts the epic from git.base_branch when set" "epic does not contain origin/develop"
  fi
else
  bad "ensure honours git.base_branch" "$out"
fi
rm -f "$W/fresh/.planning/config.json"

# ── ensure refuses to publish an unrelated local branch as the phase epic ────
( cd "$W/fresh"
  git checkout -q --orphan epic/02-unrelated
  git rm -rqf . >/dev/null 2>&1 || true
  echo unrelated > other.txt
  git add other.txt
  git commit -qm 'unrelated history'
  git checkout -q main ) >/dev/null 2>&1
if run_epic ensure epic/02-unrelated main >/dev/null 2>&1; then
  bad "ensure refuses a local epic branch that does not contain the base"
else
  ok "ensure refuses a local epic branch that does not contain the base"
fi

# ── gc: classify and reap what the reaper cannot see ────────────────────────
# The reaper walks the CURRENT tickets.json and acts on delivery-state's
# `reapable`. gc covers the rest — worktrees the graph forgot, runs that died —
# so its safety properties are the contract: it must never remove work that
# exists nowhere else, and it must fail CLOSED when it cannot tell.
git clone -q "$W/origin" "$W/gcrepo"
GCWT="$W/gcwt"
run_gc() { ( cd "$W/gcrepo" && SHIPYARD_WORKTREE_ROOT="$GCWT" bash "$SCRIPTS/ticket-worktree.sh" "$@" ); }
verdict_of() {  # verdict_of <json> <ticket>
  node -e '
    const r = JSON.parse(process.argv[1]).worktrees.find((w) => w.ticket === process.argv[2]);
    process.stdout.write(r ? r.verdict : "MISSING");
  ' "$1" "$2"
}

run_gc create T-05-01 ticket/T-05-01-live   main >/dev/null 2>&1
run_gc create T-05-02 ticket/T-05-02-landed main >/dev/null 2>&1
run_gc create T-05-03 ticket/T-05-03-alien  main >/dev/null 2>&1
run_gc create T-05-04 ticket/T-05-04-dirty  main >/dev/null 2>&1
# only T-05-01 is published, so origin/<branch> exists for it alone
git -C "$GCWT/T-05-01" push -q -u origin ticket/T-05-01-live >/dev/null 2>&1
echo 'uncommitted' > "$GCWT/T-05-04/scratch.txt"
mkdir -p "$W/gcrepo/.planning/graph"
graph_json='{"tickets":{"T-05-02":{},"T-05-04":{}}}'
echo "$graph_json" > "$W/gcrepo/.planning/graph/tickets.json"

report="$(run_gc gc --json 2>/dev/null || echo '{"worktrees":[]}')"
[[ "$(verdict_of "$report" T-05-01)" == "live" ]] \
  && ok "gc: a worktree whose origin/<branch> still exists is live" \
  || bad "gc: published branch is live" "$report"
[[ "$(verdict_of "$report" T-05-02)" == "landed" ]] \
  && ok "gc: in the graph + origin/<branch> gone + clean = landed" \
  || bad "gc: merged ticket is landed" "$report"
[[ "$(verdict_of "$report" T-05-03)" == "review" ]] \
  && ok "gc: a worktree the graph never heard of is review, not landed" \
  || bad "gc: unknown ticket is review" "$report"
[[ "$(verdict_of "$report" T-05-04)" == "dirty" ]] \
  && ok "gc: uncommitted changes outrank every other verdict" \
  || bad "gc: dirty wins over landed" "$report"

# a report must never mutate anything
if [[ -d "$GCWT/T-05-02" ]]; then
  ok "gc without --prune removes nothing"
else
  bad "gc without --prune removes nothing" "T-05-02 disappeared on a read-only run"
fi

warn="$(SHIPYARD_WORKTREE_WARN_AT=0 run_gc gc 2>&1 >/dev/null || true)"
grep -q 'E2BIG' <<<"$warn" \
  && ok "gc warns past SHIPYARD_WORKTREE_WARN_AT and names the failure it prevents" \
  || bad "gc warns past the threshold" "$warn"

# ── fail closed: no graph means nothing can be proven landed ────────────────
mv "$W/gcrepo/.planning/graph/tickets.json" "$W/gcrepo/.planning/graph/tickets.json.bak"
nograph="$(run_gc gc --json 2>/dev/null || echo '{"worktrees":[]}')"
[[ "$(verdict_of "$nograph" T-05-02)" == "review" ]] \
  && ok "gc without tickets.json downgrades landed to review" \
  || bad "gc fails closed without a graph" "$nograph"
run_gc gc --prune >/dev/null 2>&1 || true
if [[ -d "$GCWT/T-05-02" ]]; then
  ok "gc --prune with no graph removes nothing"
else
  bad "gc --prune with no graph removes nothing" "pruned a worktree it could not classify"
fi
mv "$W/gcrepo/.planning/graph/tickets.json.bak" "$W/gcrepo/.planning/graph/tickets.json"

# ── --prune removes exactly the landed one ──────────────────────────────────
run_gc gc --prune >/dev/null 2>&1 || true
[[ ! -d "$GCWT/T-05-02" ]] \
  && ok "gc --prune removes the landed worktree" \
  || bad "gc --prune removes the landed worktree" "T-05-02 survived"
if [[ -d "$GCWT/T-05-01" && -d "$GCWT/T-05-03" && -d "$GCWT/T-05-04" ]]; then
  ok "gc --prune leaves live, review and dirty worktrees untouched"
else
  bad "gc --prune leaves live/review/dirty alone" "$(ls "$GCWT")"
fi

# ── a registration whose directory vanished is always safe to drop ──────────
rm -rf "$GCWT/T-05-03"
gone="$(run_gc gc --json 2>/dev/null || echo '{"worktrees":[]}')"
[[ "$(verdict_of "$gone" T-05-03)" == "gone" ]] \
  && ok "gc reports a registration whose directory is missing as gone" \
  || bad "gc reports a missing directory as gone" "$gone"

if out="$(run_gc gc bogus 2>&1)"; then
  bad "gc rejects an unknown flag"
else
  grep -q 'usage:' <<<"$out" \
    && ok "gc rejects an unknown flag with a usage line" \
    || bad "gc rejects an unknown flag with a usage line" "$out"
fi

echo
echo "$pass passed, $fail failed"
[[ "$fail" -eq 0 ]] || exit 1
echo "worktree/epic smoke passed"
