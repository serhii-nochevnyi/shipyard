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
#
# The verdict that has to be EARNED is `landed`, because it is the only one
# `--prune` acts on. Positive evidence is delivery-state saying the ticket is
# merged; the ABSENCE of origin/<branch> is not evidence at all, since that is
# also what an executor looks like between Phase B and Phase C (audit F08).
git clone -q "$W/origin" "$W/gcrepo"
GCWT="$W/gcwt"
run_gc() { ( cd "$W/gcrepo" && SHIPYARD_WORKTREE_ROOT="$GCWT" bash "$SCRIPTS/ticket-worktree.sh" "$@" ); }
verdict_of() {  # verdict_of <json> <ticket>
  node -e '
    const r = JSON.parse(process.argv[1]).worktrees.find((w) => w.ticket === process.argv[2]);
    process.stdout.write(r ? r.verdict : "MISSING");
  ' "$1" "$2"
}
reason_of() {  # reason_of <json> <ticket>
  node -e '
    const r = JSON.parse(process.argv[1]).worktrees.find((w) => w.ticket === process.argv[2]);
    process.stdout.write(r ? String(r.reason || "") : "MISSING");
  ' "$1" "$2"
}

run_gc create T-05-01 ticket/T-05-01-live     main >/dev/null 2>&1
run_gc create T-05-02 ticket/T-05-02-unpushed main >/dev/null 2>&1
run_gc create T-05-03 ticket/T-05-03-alien    main >/dev/null 2>&1
run_gc create T-05-04 ticket/T-05-04-dirty    main >/dev/null 2>&1
run_gc create T-05-05 ticket/T-05-05-merged   main >/dev/null 2>&1
# only T-05-01 is published, so origin/<branch> exists for it alone
git -C "$GCWT/T-05-01" push -q -u origin ticket/T-05-01-live >/dev/null 2>&1
# T-05-02 is the F08 repro: work COMMITTED and not yet pushed — the normal state
# of every ticket between Phase B and Phase C. Clean tree, no origin/<branch>.
( cd "$GCWT/T-05-02" && echo unpushed > work.txt && git add work.txt \
  && git commit -qm 'T-05-02: committed, never pushed' ) >/dev/null 2>&1
# T-05-04 is the `dirty` case, and the edit has to be to a TRACKED file: `dirty`
# means unsaved WORK, and gc asks `--untracked-files=no` precisely because every
# executor worktree carries untracked `.shipyard-*.md` scratch. An untracked
# scratch.txt here would pin the old conflation instead of the rule.
echo 'uncommitted' > "$GCWT/T-05-04/file.txt"
mkdir -p "$W/gcrepo/.planning/graph"
echo '{"tickets":{"T-05-02":{},"T-05-04":{},"T-05-05":{}}}' \
  > "$W/gcrepo/.planning/graph/tickets.json"
# delivery-state is the positive evidence. Only T-05-05 is merged; T-05-02 is
# present and NOT merged, which is the whole distinction being pinned here.
cat > "$W/gcrepo/.planning/graph/delivery-state.json" <<'STATE'
{
  "T-05-02": { "branch": "ticket/T-05-02-unpushed", "status": "pr-open", "reapable": false },
  "T-05-05": { "branch": "ticket/T-05-05-merged", "status": "merged", "reapable": true }
}
STATE

report="$(run_gc gc --json 2>/dev/null || echo '{"worktrees":[]}')"
[[ "$(verdict_of "$report" T-05-01)" == "live" ]] \
  && ok "gc: a worktree whose origin/<branch> still exists is live" \
  || bad "gc: published branch is live" "$report"
[[ "$(verdict_of "$report" T-05-02)" == "review" ]] \
  && ok "gc: a committed-but-unpushed worktree is review, not landed" \
  || bad "gc: an unpushed commit must not read as landed" "$report"
grep -q 'push or remove by hand' <<<"$(reason_of "$report" T-05-02)" \
  && ok "gc: …and the reason names the remedy instead of the missing ref" \
  || bad "gc: review names the remedy" "$(reason_of "$report" T-05-02)"
[[ "$(verdict_of "$report" T-05-03)" == "review" ]] \
  && ok "gc: a worktree the graph never heard of is review, not landed" \
  || bad "gc: unknown ticket is review" "$report"
[[ "$(verdict_of "$report" T-05-04)" == "dirty" ]] \
  && ok "gc: uncommitted changes outrank every other verdict" \
  || bad "gc: dirty wins over landed" "$report"
[[ "$(verdict_of "$report" T-05-05)" == "landed" ]] \
  && ok "gc: delivery-state status merged + clean tree = landed" \
  || bad "gc: a merged ticket is landed" "$report"
# …and it must be landed FOR that reason. T-05-05's origin branch is absent too,
# so the verdict alone cannot tell the new rule from the old one it replaces.
grep -q 'delivery state says merged' <<<"$(reason_of "$report" T-05-05)" \
  && ok "gc: …and cites the delivery state, not the missing remote branch" \
  || bad "gc: landed cites positive evidence" "$(reason_of "$report" T-05-05)"

# a report must never mutate anything
if [[ -d "$GCWT/T-05-02" && -d "$GCWT/T-05-05" ]]; then
  ok "gc without --prune removes nothing"
else
  bad "gc without --prune removes nothing" "a worktree disappeared on a read-only run"
fi

warn="$(SHIPYARD_WORKTREE_WARN_AT=0 run_gc gc 2>&1 >/dev/null || true)"
grep -q 'E2BIG' <<<"$warn" \
  && ok "gc warns past SHIPYARD_WORKTREE_WARN_AT and names the failure it prevents" \
  || bad "gc warns past the threshold" "$warn"

# ── fail closed: no delivery-state means nothing can be PROVEN landed ───────
mv "$W/gcrepo/.planning/graph/delivery-state.json" \
   "$W/gcrepo/.planning/graph/delivery-state.json.bak"
nostate="$(run_gc gc --json 2>/dev/null || echo '{"worktrees":[]}')"
[[ "$(verdict_of "$nostate" T-05-05)" == "review" ]] \
  && ok "gc without delivery-state.json can prove nothing landed" \
  || bad "gc fails closed without delivery-state" "$nostate"
run_gc gc --prune >/dev/null 2>&1 || true
if [[ -d "$GCWT/T-05-05" ]]; then
  ok "gc --prune with no delivery-state removes nothing"
else
  bad "gc --prune with no delivery-state removes nothing" "pruned on the absence of a remote branch"
fi
mv "$W/gcrepo/.planning/graph/delivery-state.json.bak" \
   "$W/gcrepo/.planning/graph/delivery-state.json"

# ── an UNREADABLE store is a different fact from a missing one ──────────────
# Both prove nothing and both must fail closed, but the reason is read by a
# human deciding what to do next: "no delivery-state.json" sends them to run a
# delivery when the actual remedy is to repair a corrupt file.
mv "$W/gcrepo/.planning/graph/delivery-state.json" \
   "$W/gcrepo/.planning/graph/delivery-state.json.bak"
printf '%s\n' '{ this is not json' > "$W/gcrepo/.planning/graph/delivery-state.json"
badstate="$(run_gc gc --json 2>/dev/null || echo '{"worktrees":[]}')"
[[ "$(verdict_of "$badstate" T-05-05)" == "review" ]] \
  && ok "gc with an unreadable delivery-state.json can prove nothing landed" \
  || bad "gc fails closed on an unreadable delivery-state" "$badstate"
grep -q 'unreadable' <<<"$(reason_of "$badstate" T-05-05)" \
  && ok "…and the reason says the store is unreadable, not that it is missing" \
  || bad "gc tells unreadable state from absent state" "$(reason_of "$badstate" T-05-05)"
run_gc gc --prune >/dev/null 2>&1 || true
if [[ -d "$GCWT/T-05-05" ]]; then
  ok "gc --prune with an unreadable delivery-state removes nothing"
else
  bad "gc --prune with an unreadable delivery-state removes nothing" "pruned without evidence"
fi
mv -f "$W/gcrepo/.planning/graph/delivery-state.json.bak" \
   "$W/gcrepo/.planning/graph/delivery-state.json"

# ── fail closed: no graph either ("delete what the graph does not name") ────
mv "$W/gcrepo/.planning/graph/tickets.json" "$W/gcrepo/.planning/graph/tickets.json.bak"
nograph="$(run_gc gc --json 2>/dev/null || echo '{"worktrees":[]}')"
[[ "$(verdict_of "$nograph" T-05-05)" == "review" ]] \
  && ok "gc without tickets.json downgrades landed to review" \
  || bad "gc fails closed without a graph" "$nograph"
run_gc gc --prune >/dev/null 2>&1 || true
if [[ -d "$GCWT/T-05-05" ]]; then
  ok "gc --prune with no graph removes nothing"
else
  bad "gc --prune with no graph removes nothing" "pruned a worktree it could not classify"
fi
mv "$W/gcrepo/.planning/graph/tickets.json.bak" "$W/gcrepo/.planning/graph/tickets.json"

# ── cleanliness is re-checked under the lock, immediately before --force ────
# The classification is a snapshot taken BEFORE the git lock is held, and
# `worktree remove --force` discards whatever it finds. Deterministic here: the
# test holds the lock itself, so gc classifies T-05-05 as landed, blocks, and
# only then does the file appear.
gc_git_dir="$(git -C "$W/gcrepo" rev-parse --git-common-dir)"
[[ "$gc_git_dir" = /* ]] || gc_git_dir="$W/gcrepo/$gc_git_dir"
gc_lock="$gc_git_dir/shipyard-git.lock"
mkdir -p "$gc_lock"
( run_gc gc --prune --json >"$W/race.json" 2>"$W/race.err" || true ) &
racer=$!
waited=0
while [[ ! -s "$W/race.json" ]] && (( waited < 150 )); do sleep 0.2; waited=$((waited + 1)); done
if (( waited >= 150 )); then
  bad "gc --prune classifies before it takes the git lock" "no report after 30s"
fi
# A TRACKED modification, for the same reason as T-05-04 above: the re-check
# asks `--untracked-files=no`, so an untracked late.txt would prove nothing.
echo 'a colleague was mid-edit' > "$GCWT/T-05-05/file.txt"
rm -rf "$gc_lock"
wait "$racer" || true
if [[ -d "$GCWT/T-05-05" ]]; then
  ok "gc --prune skips a worktree that went dirty after it was classified landed"
else
  bad "gc --prune re-checks cleanliness under the lock" "T-05-05 was force-removed with an uncommitted file in it"
fi
grep -q 'became dirty' "$W/race.err" \
  && ok "…and reports the skip with a reason" \
  || bad "gc reports what it skipped" "$(cat "$W/race.err")"
git -C "$GCWT/T-05-05" checkout -q -- file.txt

# ── a status check that FAILS is a different skip from a dirty tree ─────────
# Same lock trick, different injection: the worktree's gitdir link is pointed at
# nothing while gc waits, so the re-check cannot answer at all. Silence is not
# cleanliness — it must still refuse to remove — and it must say WHY, since
# "became dirty" sends a reader hunting for edits nobody made.
mkdir -p "$gc_lock"
rm -f "$W/race2.json" "$W/race2.err"
( run_gc gc --prune --json >"$W/race2.json" 2>"$W/race2.err" || true ) &
racer=$!
waited=0
while [[ ! -s "$W/race2.json" ]] && (( waited < 150 )); do sleep 0.2; waited=$((waited + 1)); done
if (( waited >= 150 )); then
  bad "gc --prune classifies before it takes the git lock" "no second report after 30s"
fi
cp "$GCWT/T-05-05/.git" "$W/t0505-gitlink"
printf 'gitdir: %s\n' "$W/no-such-gitdir" > "$GCWT/T-05-05/.git"
rm -rf "$gc_lock"
wait "$racer" || true
if [[ -d "$GCWT/T-05-05" ]]; then
  ok "gc --prune skips a landed worktree whose cleanliness it cannot re-check"
else
  bad "gc --prune fails closed when git status fails" "T-05-05 was removed on an unanswered check"
fi
grep -q 'cannot confirm the tree is clean' "$W/race2.err" \
  && ok "…and names the check that failed instead of claiming it went dirty" \
  || bad "gc tells a failed status from a dirty tree" "$(cat "$W/race2.err")"
cp "$W/t0505-gitlink" "$GCWT/T-05-05/.git"

# ── the CLASSIFICATION fails closed on an unanswered status too ─────────────
# The re-check above is the last line of defence; this is the first one. Same
# injection, no lock held, so it is gc's own classification pass that cannot
# read the porcelain — and `[[ -n "$(git … status --porcelain)" ]]` read that
# silence as a CLEAN tree, so a ticket delivery-state calls merged came out
# `landed`, reason "tree clean", counted as removable. A check that could not
# answer must earn nothing: `review` (kept, reported), and the reason has to
# name the failed check, because "clean" about an unreadable tree is a lie a
# reader has no way to catch.
printf 'gitdir: %s\n' "$W/no-such-gitdir" > "$GCWT/T-05-05/.git"
blind="$(run_gc gc --json 2>/dev/null || echo '{"worktrees":[]}')"
[[ "$(verdict_of "$blind" T-05-05)" == "review" ]] \
  && ok "gc: a worktree whose git status fails is review, not landed" \
  || bad "gc: an unanswered status check must not read as clean" "$blind"
grep -q 'cannot confirm the tree is clean' <<<"$(reason_of "$blind" T-05-05)" \
  && ok "…and the reason names the check that failed, not a clean tree" \
  || bad "gc: classification names the failed status" "$(reason_of "$blind" T-05-05)"
run_gc gc --prune >/dev/null 2>&1 || true
if [[ -d "$GCWT/T-05-05" ]]; then
  ok "gc --prune removes nothing whose cleanliness classification never established"
else
  bad "gc --prune fails closed on a failed status" "T-05-05 was removed on an unanswered check"
fi
cp "$W/t0505-gitlink" "$GCWT/T-05-05/.git"

# ── --prune removes exactly the landed one ──────────────────────────────────
run_gc gc --prune >/dev/null 2>&1 || true
[[ ! -d "$GCWT/T-05-05" ]] \
  && ok "gc --prune removes the landed worktree" \
  || bad "gc --prune removes the landed worktree" "T-05-05 survived"
if [[ -d "$GCWT/T-05-01" && -d "$GCWT/T-05-02" && -d "$GCWT/T-05-03" && -d "$GCWT/T-05-04" ]]; then
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

# ── a removal that FAILED is not a removal ──────────────────────────────────
# Both halves of the removal can fail — `worktree remove --force` on a
# registration git will not let go of, the `rm -rf` fallback on a non-writable
# parent, a read-only mount, or a mount point inside the tree — and the outcome
# was never looked at: `removed` was incremented and "removed <ticket>" printed
# one line later, under a summary that promises to report what actually
# happened. Worse, the failing `rm` was the last command of a `||` list, so
# `set -e` killed the run mid-loop and took the remaining landed worktrees,
# every skip reason and the summary with it.
#
# Injected with PATH stubs, not file permissions: a chmod proves nothing when
# the suite runs as root, and stubs reproduce identically on macOS and Linux.
# Both stubs are narrowed to the ONE stuck path — a blanket `rm` stub would
# also break the lock's EXIT trap and wedge every later gc.
run_gc create T-05-06 ticket/T-05-06-stuck main >/dev/null 2>&1
run_gc create T-05-07 ticket/T-05-07-next  main >/dev/null 2>&1
echo '{"tickets":{"T-05-02":{},"T-05-04":{},"T-05-06":{},"T-05-07":{}}}' \
  > "$W/gcrepo/.planning/graph/tickets.json"
cat > "$W/gcrepo/.planning/graph/delivery-state.json" <<'STATE'
{
  "T-05-02": { "branch": "ticket/T-05-02-unpushed", "status": "pr-open", "reapable": false },
  "T-05-06": { "branch": "ticket/T-05-06-stuck", "status": "merged", "reapable": true },
  "T-05-07": { "branch": "ticket/T-05-07-next", "status": "merged", "reapable": true }
}
STATE
# the script sees the RESOLVED path (git worktree list --porcelain prints those),
# so the stubs have to match on that spelling, not on $GCWT/T-05-06
STUCK="$(cd "$GCWT/T-05-06" && pwd -P)"
STUB="$W/stub"; mkdir -p "$STUB"
REAL_GIT="$(command -v git)"; REAL_RM="$(command -v rm)"
cat > "$STUB/git" <<EOF
#!/usr/bin/env bash
if [[ "\$*" == *"worktree remove"* && "\$*" == *"$STUCK"* ]]; then
  echo "stub: refusing to remove the worktree registration" >&2
  exit 1
fi
exec "$REAL_GIT" "\$@"
EOF
cat > "$STUB/rm" <<EOF
#!/usr/bin/env bash
for a in "\$@"; do
  [[ "\$a" == "$STUCK" ]] && { echo "stub: rm: Permission denied" >&2; exit 1; }
done
exec "$REAL_RM" "\$@"
EOF
chmod +x "$STUB/git" "$STUB/rm"
( cd "$W/gcrepo" && PATH="$STUB:$PATH" SHIPYARD_WORKTREE_ROOT="$GCWT" \
    bash "$SCRIPTS/ticket-worktree.sh" gc --prune ) \
  >"$W/stuck.out" 2>"$W/stuck.err" || true
if [[ -d "$STUCK" ]]; then
  ok "gc --prune leaves behind a landed worktree it could not remove"
else
  bad "gc --prune leaves behind what it could not remove" "$(cat "$W/stuck.err")"
fi
grep -q 'still present' "$W/stuck.err" \
  && ok "…and reports the failed removal instead of announcing it as removed" \
  || bad "gc reports a removal that failed" "$(cat "$W/stuck.err")"
[[ ! -d "$GCWT/T-05-07" ]] \
  && ok "…and keeps pruning the rest instead of dying on the failure" \
  || bad "gc --prune continues past a failed removal" "$(cat "$W/stuck.err")"
grep -q 'gc: removed .*(1 landed' "$W/stuck.err" \
  && ok "…and the summary counts the one removal that happened, not two" \
  || bad "gc's summary counts removals, not attempts" "$(cat "$W/stuck.err")"
grep -q 'could not be removed' "$W/stuck.err" \
  && ok "…and the summary names the failure a human has to act on" \
  || bad "gc's summary names failed removals" "$(cat "$W/stuck.err")"

if out="$(run_gc gc bogus 2>&1)"; then
  bad "gc rejects an unknown flag"
else
  grep -q 'usage:' <<<"$out" \
    && ok "gc rejects an unknown flag with a usage line" \
    || bad "gc rejects an unknown flag with a usage line" "$out"
fi

# ── untracked scratch is not uncommitted WORK ───────────────────────────────
# `dirty` is the one class gc NEVER prunes, deliberately — and every executor
# worktree carries `.shipyard-pr-body.md` and `.shipyard-evidence.md` as
# untracked scratch (T-26-14), so the bare `git status --porcelain` put EVERY
# delivered ticket in it. Measured: all five phase-27 worktrees `dirty`, two of
# them with merged PRs, `0 removable`; at cold start 32 worktrees, the E2BIG
# warning printed, gc's own verdict still `0 removable`. The count only ever
# came down because the reaper works from `reapable`.
#
# The third file is the point of this block. Narrowing the fix to the two known
# filenames would pass both cases above it and fail this one, which is what a
# list of names always eventually does.
#
# Self-contained fixtures: the graph and the state are rewritten for this block
# so it does not depend on the sequence above it.
run_gc create T-05-08 ticket/T-05-08-scratch main >/dev/null 2>&1
: > "$GCWT/T-05-08/.shipyard-pr-body.md"
: > "$GCWT/T-05-08/.shipyard-evidence.md"
: > "$GCWT/T-05-08/.shipyard-a-scratch-file-invented-tomorrow.md"
echo '{"tickets":{"T-05-08":{}}}' > "$W/gcrepo/.planning/graph/tickets.json"
cat > "$W/gcrepo/.planning/graph/delivery-state.json" <<'STATE'
{
  "T-05-08": { "branch": "ticket/T-05-08-scratch", "status": "merged", "reapable": true }
}
STATE
scratch_report="$(run_gc gc --json 2>/dev/null || echo '{"worktrees":[]}')"
[[ "$(verdict_of "$scratch_report" T-05-08)" == "landed" ]] \
  && ok "gc: a merged worktree holding only untracked scratch is landed, not dirty" \
  || bad "gc: untracked scratch must not read as uncommitted work" "$scratch_report"
scratch_human="$(run_gc gc 2>&1 || true)"
grep -qE '[1-9][0-9]* landed' <<<"$scratch_human" \
  && ok "…and gc's own report counts it as removable" \
  || bad "gc counts a scratch-only landed worktree as removable" "$scratch_human"
run_gc gc --prune >/dev/null 2>&1 || true
[[ ! -d "$GCWT/T-05-08" ]] \
  && ok "…and --prune removes it (the under-lock re-check asks the same question)" \
  || bad "gc --prune removes a scratch-only landed worktree" "T-05-08 survived --prune"

# …and `dirty` keeps its meaning: only the QUESTION changed, not the class. A
# tracked modification is never removed, however merged the ticket is.
run_gc create T-05-09 ticket/T-05-09-real main >/dev/null 2>&1
echo 'real uncommitted work' > "$GCWT/T-05-09/file.txt"
echo '{"tickets":{"T-05-09":{}}}' > "$W/gcrepo/.planning/graph/tickets.json"
cat > "$W/gcrepo/.planning/graph/delivery-state.json" <<'STATE'
{
  "T-05-09": { "branch": "ticket/T-05-09-real", "status": "merged", "reapable": true }
}
STATE
real_report="$(run_gc gc --json 2>/dev/null || echo '{"worktrees":[]}')"
[[ "$(verdict_of "$real_report" T-05-09)" == "dirty" ]] \
  && ok "gc: a tracked modification is dirty even when delivery-state says merged" \
  || bad "gc: dirty keeps its meaning for real uncommitted work" "$real_report"
run_gc gc --prune >/dev/null 2>&1 || true
[[ -d "$GCWT/T-05-09" ]] \
  && ok "…and --prune still never removes it" \
  || bad "gc --prune leaves a dirty worktree alone" "T-05-09 was removed with uncommitted work in it"

# ── create cuts from the ref the BOARD named, not from a stale local one ─────
# Measured four separate times in one session: `origin/epic/<phase>` two commits
# ahead after the guard merged ticket PRs through the API, the local
# `epic/<phase>` still at the pre-merge tip, and `create` reporting success while
# cutting from the local one — so the executor never saw the predicates its plan
# was written against. A bare name resolves refs/heads BEFORE refs/remotes, which
# is what makes a stale local ref worse than a missing one: a missing one fails
# loudly (the case above), a stale one succeeds and lies. Same lesson
# graph-dir.cjs's resolveBaseRef records for the two worktree gates.
git init -q --bare "$W/sorigin"
git init -q "$W/sseed"
( cd "$W/sseed"
  echo one > s.txt
  git add s.txt
  git commit -qm 'init'
  git remote add origin "$W/sorigin"
  git push -q -u origin main
  git checkout -q -b epic/09-stale
  echo epic-tip-a >> s.txt
  git add s.txt
  git commit -qm 'epic tip A'
  git push -q -u origin epic/09-stale )
git clone -q "$W/sorigin" "$W/stale"
git -C "$W/stale" branch --track epic/09-stale origin/epic/09-stale >/dev/null 2>&1
stale_tip_a="$(git -C "$W/stale" rev-parse refs/heads/epic/09-stale)"
# origin moves and the clone is never told — the state a session checkout is in
# after the sentinel merges two PRs through the GitHub API.
( cd "$W/sseed" && echo epic-tip-b >> s.txt && git add s.txt \
  && git commit -qm 'epic tip B' && git push -q origin epic/09-stale ) >/dev/null 2>&1
stale_tip_b="$(git -C "$W/sseed" rev-parse HEAD)"
SWT="$W/stalewt"
run_stale() { ( cd "$W/stale" && SHIPYARD_WORKTREE_ROOT="$SWT" \
  bash "$SCRIPTS/ticket-worktree.sh" "$@" ); }
if out="$(run_stale create T-09-01 ticket/T-09-01-x epic/09-stale 2>&1)"; then
  cut="$(git -C "$SWT/T-09-01" rev-parse HEAD 2>/dev/null || echo none)"
  [[ "$cut" == "$stale_tip_b" ]] \
    && ok "create cuts from origin/<base>, not from a stale local ref of the same name" \
    || bad "create cuts from origin/<base>, not from a stale local ref" \
         "cut from ${cut:0:7} (the stale local tip is ${stale_tip_a:0:7}); expected the origin tip ${stale_tip_b:0:7}"
else
  bad "create cuts from origin/<base> when the local ref is stale" "$out"
fi

# ── …and a branch it REUSES is measured, not reused silently ─────────────────
# Reuse is the normal resumed-run path: an existing worktree on the right branch,
# or an existing local branch with no worktree. Both used to say only "reusing",
# so a branch cut before three ticket merges landed under the epic looked exactly
# like one cut a second ago. The distance is reported and NOT acted on — the
# branch may hold committed work that exists nowhere else.
( cd "$W/sseed" && echo epic-tip-c >> s.txt && git add s.txt \
  && git commit -qm 'epic tip C' && git push -q origin epic/09-stale ) >/dev/null 2>&1
out="$(run_stale create T-09-01 ticket/T-09-01-x epic/09-stale 2>&1 || true)"
grep -qF '1 commit(s) behind origin/epic/09-stale' <<<"$out" \
  && ok "create reports how far a REUSED worktree's branch is from origin/<base>" \
  || bad "create reports the distance of the worktree it reuses" "$out"

# the same for a branch whose worktree is gone but whose ref remains — and the
# branch must be reused where it stands, never re-cut onto the base
run_stale remove T-09-01 >/dev/null 2>&1
( cd "$W/sseed" && echo epic-tip-d >> s.txt && git add s.txt \
  && git commit -qm 'epic tip D' && git push -q origin epic/09-stale ) >/dev/null 2>&1
out="$(run_stale create T-09-01 ticket/T-09-01-x epic/09-stale 2>&1 || true)"
grep -qF '2 commit(s) behind origin/epic/09-stale' <<<"$out" \
  && ok "create reports how far a REUSED local branch is from origin/<base>" \
  || bad "create reports the distance of the branch it reuses" "$out"
[[ "$(git -C "$SWT/T-09-01" rev-parse HEAD 2>/dev/null || echo none)" == "$stale_tip_b" ]] \
  && ok "…and reuses that branch where it stands instead of re-cutting it" \
  || bad "create reuses an existing branch as it stands" \
       "branch moved to $(git -C "$SWT/T-09-01" rev-parse --short HEAD 2>/dev/null || echo none)"

# ── epic-branch refresh: an epic learns what landed under its base ───────────
# Nothing in delivery ever merged the base INTO an epic. Two epics were measured
# 27 then 31 commits behind, each containing zero occurrences of the predicates
# their next tickets were written against. `refresh` is that verb.
git init -q --bare "$W/rorigin"
git init -q "$W/rseed"
( cd "$W/rseed"
  echo base > f.txt
  git add f.txt
  git commit -qm 'init'
  git remote add origin "$W/rorigin"
  git push -q -u origin main
  git checkout -q -b epic/07-refresh
  echo epicwork > e.txt
  git add e.txt
  git commit -qm 'epic work'
  git push -q -u origin epic/07-refresh
  git checkout -q main )
git clone -q "$W/rorigin" "$W/refresh"
git -C "$W/refresh" branch --track epic/07-refresh origin/epic/07-refresh >/dev/null 2>&1
epic_before="$(git -C "$W/refresh" rev-parse refs/heads/epic/07-refresh)"
# the base moves on origin and this checkout is never told
( cd "$W/rseed" && echo more >> f.txt && git add f.txt \
  && git commit -qm 'base moved' && git push -q origin main ) >/dev/null 2>&1
base_after="$(git -C "$W/rseed" rev-parse main)"
run_refresh() { ( cd "$W/refresh" && bash "$SCRIPTS/epic-branch.sh" "$@" ); }

if out="$(run_refresh refresh epic/07-refresh main 2>&1)"; then
  ok "refresh merges a moved base into the epic and exits 0"
else
  bad "refresh merges a moved base into the epic" "$out"
fi
pushed="$(git -C "$W/rorigin" rev-parse epic/07-refresh)"
[[ "$pushed" != "$epic_before" ]] \
  && ok "…and pushes the merge to origin/<epic>" \
  || bad "refresh pushes the merge" "origin/epic/07-refresh is still at ${epic_before:0:7}"
git -C "$W/rorigin" merge-base --is-ancestor "$base_after" "$pushed" 2>/dev/null \
  && ok "…so the pushed epic now contains what landed on the base" \
  || bad "the pushed epic contains the base" "origin/main ${base_after:0:7} is not an ancestor of ${pushed:0:7}"

# THE half that was broken four times. A refresh performed from a detached
# worktree updates origin and leaves the local refs where they were; the next
# `create` then cuts from the old tip and reports success.
[[ "$(git -C "$W/refresh" rev-parse refs/heads/epic/07-refresh)" == "$pushed" ]] \
  && ok "…and the LOCAL epic ref points at the pushed tip" \
  || bad "refresh fast-forwards the local epic ref" \
       "local epic at $(git -C "$W/refresh" rev-parse --short refs/heads/epic/07-refresh), pushed ${pushed:0:7}"
[[ "$(git -C "$W/refresh" rev-parse refs/heads/main)" == "$base_after" ]] \
  && ok "…and the LOCAL base ref points at the base tip" \
  || bad "refresh fast-forwards the local base ref" \
       "local main at $(git -C "$W/refresh" rev-parse --short refs/heads/main), origin ${base_after:0:7}"
# `main` is CHECKED OUT in that clone, so moving its ref has to move the index
# and the tree with it: an `update-ref` there leaves a phantom diff behind, in
# the opposite direction, over files nobody edited.
[[ -z "$(git -C "$W/refresh" status --porcelain)" ]] \
  && ok "…and the checked-out base worktree is left clean, not phantom-dirty" \
  || bad "refresh moves a checked-out ref with the tree" "$(git -C "$W/refresh" status --porcelain)"
grep -q more "$W/refresh/f.txt" \
  && ok "…and that working tree actually holds what landed" \
  || bad "the checked-out base tree holds the base's content" "$(cat "$W/refresh/f.txt")"

# ── refresh of an epic already containing its base: no push, local refs still move ──
# This is the OTHER measured state, and the one a `behind == 0` early return
# would do nothing for: origin/epic two commits ahead after the guard merged two
# ticket PRs through the API, the base itself unmoved (so nothing to merge and
# nothing to push), and the local epic still at the pre-merge tip.
( cd "$W/rseed" && git fetch -q origin && git checkout -q epic/07-refresh \
  && git reset -q --hard origin/epic/07-refresh \
  && echo landed > g.txt && git add g.txt && git commit -qm 'a ticket landed under the epic' \
  && git push -q origin epic/07-refresh && git checkout -q main ) >/dev/null 2>&1
epic_landed="$(git -C "$W/rorigin" rev-parse epic/07-refresh)"
if out="$(run_refresh refresh epic/07-refresh main 2>&1)"; then
  ok "refresh of an epic that already contains its base exits 0"
else
  bad "refresh of a current epic exits 0" "$out"
fi
grep -q 'already up to date' <<<"$out" \
  && ok "…and says so instead of reporting a merge it did not do" \
  || bad "refresh of a current epic says so" "$out"
[[ "$(git -C "$W/rorigin" rev-parse epic/07-refresh)" == "$epic_landed" ]] \
  && ok "…and pushes nothing" \
  || bad "refresh of a current epic pushes nothing" "origin/epic/07-refresh moved"
[[ "$(git -C "$W/refresh" rev-parse refs/heads/epic/07-refresh)" == "$epic_landed" ]] \
  && ok "…and still fast-forwards the stale local epic ref onto what landed under it" \
  || bad "refresh moves a stale local epic ref with nothing to push" \
       "local epic at $(git -C "$W/refresh" rev-parse --short refs/heads/epic/07-refresh), origin ${epic_landed:0:7}"

# ── a conflicting refresh refuses, names the paths, and changes nothing ──────
# A conflict here is a decision about somebody's work; this script has no
# standing to make it in either direction.
( cd "$W/rseed" && git fetch -q origin \
  && git checkout -q -b epic/08-conflict origin/main \
  && echo epicside > c.txt && git add c.txt && git commit -qm 'the epic writes c.txt' \
  && git push -q -u origin epic/08-conflict \
  && git checkout -q main && git reset -q --hard origin/main \
  && echo baseside > c.txt && git add c.txt && git commit -qm 'the base writes c.txt' \
  && git push -q origin main ) >/dev/null 2>&1
git -C "$W/refresh" fetch -q origin >/dev/null 2>&1
git -C "$W/refresh" branch --track epic/08-conflict origin/epic/08-conflict >/dev/null 2>&1
conf_before="$(git -C "$W/refresh" rev-parse refs/heads/epic/08-conflict)"
wt_before="$(git -C "$W/refresh" worktree list --porcelain | grep -c '^worktree ' || true)"
if out="$(run_refresh refresh epic/08-conflict main 2>&1)"; then
  bad "refresh refuses a conflicting merge instead of resolving it" "$out"
else
  ok "refresh refuses a conflicting merge instead of resolving it"
fi
grep -q 'c\.txt' <<<"$out" \
  && ok "…and names the conflicting path" \
  || bad "refresh names the conflicting paths" "$out"
[[ "$(git -C "$W/refresh" rev-parse refs/heads/epic/08-conflict)" == "$conf_before" ]] \
  && ok "…and leaves the local epic branch exactly where it was" \
  || bad "a refused refresh leaves the epic alone" \
       "epic/08-conflict moved to $(git -C "$W/refresh" rev-parse --short refs/heads/epic/08-conflict)"
[[ "$(git -C "$W/rorigin" rev-parse epic/08-conflict)" == "$conf_before" ]] \
  && ok "…and pushes nothing" \
  || bad "a refused refresh pushes nothing" "origin/epic/08-conflict moved"
wt_after="$(git -C "$W/refresh" worktree list --porcelain | grep -c '^worktree ' || true)"
[[ "$wt_after" == "$wt_before" ]] \
  && ok "…and gives back the worktree it merged in, on the failure path too" \
  || bad "a refused refresh leaves no worktree behind" \
       "$wt_before worktree(s) before, $wt_after after: $(git -C "$W/refresh" worktree list)"

# ── an epic that is not on origin is NOTHING TO REFRESH, not a fault ────────
# Step 0 refreshes every epic the GRAPH knows, so this fires on most cold starts:
# a phase that has not started yet (Step 3.0 creates that branch later, with
# `ensure`) and a phase that shipped and had its epic reaped. A per-epic non-zero
# there is how a reader learns to ignore exit codes — and naming `ensure` as the
# remedy is worse than noise, because an agent obeying it would recreate a dead
# epic branch off the base and PUSH it for a phase that shipped weeks ago.
if out="$(run_refresh refresh epic/99-never main 2>&1)"; then
  grep -q 'nothing to refresh' <<<"$out" \
    && ok "refresh of an epic that is not on origin exits 0 and says there is nothing to refresh" \
    || bad "refresh of an absent epic says what is true" "$out"
else
  bad "refresh of an epic that is not on origin exits 0" "$out"
fi
if grep -q 'ensure' <<<"$out"; then
  bad "refresh must not send the reader to recreate a reaped epic" "$out"
else
  ok "…and does not name a verb that would recreate a branch somebody reaped"
fi
if git -C "$W/rorigin" show-ref --verify --quiet refs/heads/epic/99-never \
   || git -C "$W/refresh" show-ref --verify --quiet refs/heads/epic/99-never; then
  bad "refresh creates no branch for an epic that is not on origin" "epic/99-never appeared"
else
  ok "…and creates no branch for it, on origin or locally"
fi

echo
echo "$pass passed, $fail failed"
[[ "$fail" -eq 0 ]] || exit 1
echo "worktree/epic smoke passed"
