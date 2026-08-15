#!/usr/bin/env bash
set -euo pipefail

# base-merge and scope-gate against REAL git, from the place their documentation
# puts the caller: inside a ticket worktree, in a project that keeps `.planning/`
# untracked (which the proving ground does).
#
# Both resolved tickets.json from `process.cwd()`, so both failed there — and the
# error said "run validate-graph first", naming a cause that was not the cause and
# a command that could not help. base-merge is the one that mattered: ci-fix.md and
# review-fix.md name it as THE remedy for a moved base, and those files are read by
# an agent that has just been told to cd into the worktree.
#
# The merge semantics had also never run against real git at all.

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SCRIPTS="$ROOT/plugins/delivery-pipeline/scripts"
# An isolated global git config, as worktree-smoke.sh does — the tests must not
# depend on, or touch, the developer's own identity.
export GIT_CONFIG_GLOBAL="$(mktemp -d)/gitconfig"
export GIT_CONFIG_NOSYSTEM=1
git config --file "$GIT_CONFIG_GLOBAL" user.email smoke@example.com
git config --file "$GIT_CONFIG_GLOBAL" user.name "Smoke Test"
git config --file "$GIT_CONFIG_GLOBAL" init.defaultBranch main

PASS=0
ok()   { PASS=$((PASS+1)); echo "  ✓ $1"; }
fail() { echo "  ✗ $1"; exit 1; }

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

echo "worktree gates smoke"

# ── a cascade mid-flight ─────────────────────────────────────────────────────
# epic/01 has the parent's work squash-merged in (new SHA, same content), and the
# child branched BEFORE that. The child also carries a stale copy of a file it
# does not declare — the exact shape that conflicts on every cascade.
P="$WORK/proj"
mkdir -p "$P/src" "$P/.planning/graph"
git init -q -b main "$P"
printf '.planning/\n' > "$P/.gitignore"          # untracked, as in the proving ground
printf 'shared v1\n' > "$P/src/shared.ts"
printf 'child v1\n'  > "$P/src/child.ts"
cat > "$P/.planning/graph/tickets.json" <<'JSON'
{"tickets":{
  "T-01":{"files":["src/shared.ts"]},
  "T-02":{"files":["src/child.ts"]}}}
JSON
git -C "$P" add -A && git -C "$P" commit -qm init
git -C "$P" branch epic/01

git -C "$P" checkout -q -b ticket/T-01 epic/01
printf 'shared v2 PARENT\n' > "$P/src/shared.ts"
git -C "$P" commit -qam T-01

git -C "$P" checkout -q -b ticket/T-02 epic/01
printf 'child v2\n' > "$P/src/child.ts"
printf 'shared STALE\n' > "$P/src/shared.ts"
git -C "$P" commit -qam T-02

git -C "$P" checkout -q epic/01
git -C "$P" merge --squash ticket/T-01 -q >/dev/null
git -C "$P" commit -qm "squash T-01"
git -C "$P" checkout -q main

WT="$WORK/wt-T-02"
git -C "$P" worktree add -q "$WT" ticket/T-02

[[ ! -e "$WT/.planning" ]] || fail "fixture is wrong: the worktree must have no .planning of its own"
ok "fixture: a ticket worktree with no graph in it"

# ── base-merge, run from inside the worktree ─────────────────────────────────
out="$(cd "$WT" && node "$SCRIPTS/base-merge.cjs" T-02 --worktree "$WT" --base epic/01 --no-fetch 2>&1)" \
  || fail "base-merge failed from the worktree: $out"
ok "base-merge runs from the worktree (graph found via the worktree's repository)"

grep -q 'shared v2 PARENT' "$WT/src/shared.ts" \
  || fail "the undeclared conflicted file must take the BASE's edition, got: $(cat "$WT/src/shared.ts")"
ok "an undeclared conflict takes the base's edition"

grep -q 'child v2' "$WT/src/child.ts" \
  || fail "the ticket's own declared work must survive the merge"
ok "the ticket's declared work survives"

git -C "$WT" diff --quiet && git -C "$WT" diff --cached --quiet \
  || fail "the merge must be committed, leaving a clean tree"
ok "the merge is committed and the tree is clean"

# The whole point of merging the base in: the PR's three-dot diff narrows back to
# this ticket's own work. The scope gate is exactly that measurement.
out="$(cd "$WT" && node "$SCRIPTS/scope-gate.cjs" T-02 --worktree "$WT" --base epic/01 2>&1)" \
  || fail "scope-gate failed from the worktree: $out"
grep -q 'all inside files_modified' <<<"$out" \
  || fail "after the base merge the diff must contain only the ticket's files, got: $out"
ok "scope-gate runs from the worktree and sees a narrowed diff"

# ── a real conflict is NOT resolved for you ──────────────────────────────────
# Same setup, but the child declares the contested file: its side is not a stale
# snapshot, so the rule must not silently discard it.
P2="$WORK/proj2"
mkdir -p "$P2/src" "$P2/.planning/graph"
git init -q -b main "$P2"
printf '.planning/\n' > "$P2/.gitignore"
printf 'shared v1\n' > "$P2/src/shared.ts"
cat > "$P2/.planning/graph/tickets.json" <<'JSON'
{"tickets":{"T-01":{"files":["src/shared.ts"]},"T-02":{"files":["src/shared.ts"]}}}
JSON
git -C "$P2" add -A && git -C "$P2" commit -qm init
git -C "$P2" branch epic/01
git -C "$P2" checkout -q -b ticket/T-01 epic/01
printf 'shared PARENT\n' > "$P2/src/shared.ts"; git -C "$P2" commit -qam T-01
git -C "$P2" checkout -q -b ticket/T-02 epic/01
printf 'shared CHILD OWN WORK\n' > "$P2/src/shared.ts"; git -C "$P2" commit -qam T-02
git -C "$P2" checkout -q epic/01
git -C "$P2" merge --squash ticket/T-01 -q >/dev/null && git -C "$P2" commit -qm "squash T-01"
git -C "$P2" checkout -q main
WT2="$WORK/wt2"
git -C "$P2" worktree add -q "$WT2" ticket/T-02

set +e
out="$(cd "$WT2" && node "$SCRIPTS/base-merge.cjs" T-02 --worktree "$WT2" --base epic/01 --no-fetch 2>&1)"
code=$?
set -e
[[ "$code" == 1 ]] || fail "a conflict in a DECLARED file must exit 1, got $code: $out"
grep -q 'REAL conflict' <<<"$out" || fail "the report must name it a real conflict: $out"
ok "a conflict in a declared file is left for judgement, exit 1"

git -C "$WT2" status --porcelain | grep -q '^UU' \
  || fail "the merge must be left IN PROGRESS so the agent can resolve it"
ok "the merge is left in progress, nothing committed"

# ── a dirty worktree is refused, not merged over ─────────────────────────────
git -C "$WT2" merge --abort
printf 'uncommitted\n' >> "$WT2/src/shared.ts"
set +e
out="$(cd "$WT2" && node "$SCRIPTS/base-merge.cjs" T-02 --worktree "$WT2" --base epic/01 --no-fetch 2>&1)"
code=$?
set -e
[[ "$code" != 0 ]] || fail "a dirty worktree must be refused"
grep -q 'uncommitted' <<<"$out" || fail "the refusal must name the reason: $out"
ok "a dirty worktree is refused"

# ── no graph anywhere: the error names the REAL cause ────────────────────────
BARE="$WORK/bare"
mkdir -p "$BARE"
git init -q -b main "$BARE"
printf 'x\n' > "$BARE/f"; git -C "$BARE" add -A; git -C "$BARE" commit -qm i
set +e
out="$(cd "$BARE" && node "$SCRIPTS/base-merge.cjs" T-02 --worktree "$BARE" --base main 2>&1)"
code=$?
set -e
[[ "$code" != 0 ]] || fail "a missing graph must not be ignored"
grep -q -- '--graph' <<<"$out" || fail "the error must name the flag that fixes it: $out"
grep -q 'working-directory' <<<"$out" || fail "the error must name the real cause, not 'run validate-graph': $out"
ok "with no graph anywhere, the error names the cause and the flag"

# ── an explicit --graph still wins (the cross-repo case) ─────────────────────
out="$(cd "$BARE" && node "$SCRIPTS/base-merge.cjs" T-02 --graph "$P/.planning/graph" --worktree "$BARE" --base main 2>&1)" || true
grep -q 'not in the graph\|already up to date\|merged' <<<"$out" \
  || fail "--graph must be honoured over the worktree's own repository: $out"
ok "--graph wins, which is the only thing that works cross-repo"

# ── a STALE LOCAL base must not be the measurement ───────────────────────────
# The sentinel merges a parent into the epic via the GitHub API, so origin/epic
# moves and the local branch of the same name does not. Passed the bare name,
# base-merge answered "already up to date" while the worktree never received the
# parent's work — a silent false SUCCESS — and scope-gate, run right after a
# correct merge, flagged the parent's files — a false FAILURE. Both must measure
# origin's edition when it exists.
git config --file "$GIT_CONFIG_GLOBAL" protocol.file.allow always
O="$WORK/origin"; git init -q --bare "$O"
SEED="$WORK/seed"; git init -q "$SEED"
mkdir -p "$SEED/src"
printf '.planning/\n' > "$SEED/.gitignore"
printf 'shared v1\n' > "$SEED/src/shared.ts"
printf 'child v1\n'  > "$SEED/src/child.ts"
git -C "$SEED" add -A && git -C "$SEED" commit -qm init
git -C "$SEED" branch epic/01
git -C "$SEED" push -q "$O" main epic/01

P3="$WORK/proj3"; git clone -q "$O" "$P3"
mkdir -p "$P3/.planning/graph"
cat > "$P3/.planning/graph/tickets.json" <<'JSON'
{"tickets":{"T-01":{"files":["src/shared.ts"]},"T-02":{"files":["src/child.ts"]}}}
JSON
git -C "$P3" checkout -q -b epic/01 origin/epic/01     # a local snapshot, about to go stale
git -C "$P3" checkout -q -b ticket/T-02 epic/01
printf 'child v2\n' > "$P3/src/child.ts"
git -C "$P3" commit -qam T-02
git -C "$P3" checkout -q main

# the parent lands on ORIGIN's epic — the local epic/01 in proj3 does not move
git -C "$SEED" checkout -q epic/01
printf 'shared v2 PARENT\n' > "$SEED/src/shared.ts"
git -C "$SEED" commit -qam "squash T-01"
git -C "$SEED" push -q "$O" epic/01

WT3="$WORK/wt3"
git -C "$P3" worktree add -q "$WT3" ticket/T-02

out="$(cd "$WT3" && node "$SCRIPTS/base-merge.cjs" T-02 --worktree "$WT3" --base epic/01 2>&1)" \
  || fail "base-merge must succeed against the moved origin base: $out"
grep -q 'origin/epic/01' <<<"$out" \
  || fail "the output must SAY it measured origin/epic/01, not the bare name: $out"
# The assertion that matters is CONTENT, not the message — "already up to date"
# and "merged cleanly" can both lie against a stale ref.
grep -q 'shared v2 PARENT' "$WT3/src/shared.ts" \
  || fail "the worktree must actually receive the parent's work, got: $(cat "$WT3/src/shared.ts")"
ok "a bare base name measures origin's edition, and the parent's work arrives"

out="$(cd "$WT3" && node "$SCRIPTS/scope-gate.cjs" T-02 --worktree "$WT3" --base epic/01 2>&1)" \
  || fail "scope-gate vs the bare name right after a correct base merge must pass: $out"
grep -q 'all inside files_modified' <<<"$out" \
  || fail "the false scope violation is back — the gate measured the stale local ref: $out"
ok "scope-gate after a base merge reads OK against the bare name"

# ── --graph before the positionals must not eat the ticket ───────────────────
out="$(cd "$WT3" && node "$SCRIPTS/base-merge.cjs" --graph "$P3/.planning/graph" T-02 --worktree "$WT3" --base epic/01 --no-fetch 2>&1)" \
  || fail "flag-first base-merge failed: $out"
grep -q 'T-02' <<<"$out" || fail "the ticket must survive flag-first ordering: $out"
out="$(cd "$WT3" && node "$SCRIPTS/scope-gate.cjs" --graph "$P3/.planning/graph" T-02 --worktree "$WT3" --base epic/01 2>&1)" \
  || fail "flag-first scope-gate failed: $out"
ok "--graph before the positionals leaves the ticket intact in both gates"

echo "$PASS passed, 0 failed"
echo "worktree gates smoke passed"
