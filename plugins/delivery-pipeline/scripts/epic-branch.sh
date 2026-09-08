#!/usr/bin/env bash
set -euo pipefail

# Deterministic lifecycle for a phase's epic integration branch (epic-stacked
# delivery). Root tickets PR into the epic; dependent tickets cascade into their
# parent branch; the epic itself gets ONE PR into the repo default branch.
#
#   epic-branch.sh ensure   <epic-branch> [base-ref]   create off base + push if absent; prints branch
#   epic-branch.sh refresh  <epic-branch> [base-ref]   merge origin/<base> into the epic, push, move the local refs
#   epic-branch.sh pr       <epic-branch> [base-ref]   open the draft epic->base PR once the epic has commits
#   epic-branch.sh status   <epic-branch> [base-ref]   print JSON {branch, base, remote, ahead, pr, pr_state}
#   epic-branch.sh retarget <pr-number> <new-base>     repoint an open (cascade) PR onto a new base
#
# base-ref defaults to the repo default branch (origin/HEAD → main|master).
# stdout is the API — human chatter from git/gh is redirected to stderr.

cmd="${1:-}"

repo_root="$(git rev-parse --show-toplevel 2>/dev/null)" || { echo "not inside a git repository" >&2; exit 1; }

default_branch() {
  # GSD's git.base_branch is the project's integration branch (it is what
  # /gsd-ship targets), so it OUTRANKS the repo default: a project that
  # integrates into `develop` must not have its epics cut from main.
  local d
  d="$(node -e '
    const fs=require("fs"),path=require("path");
    const p=path.join(process.argv[1],".planning","config.json");
    try{const c=JSON.parse(fs.readFileSync(p,"utf8"));const b=c&&c.git&&c.git.base_branch;
      if(typeof b==="string"&&b)process.stdout.write(b);}catch{}
  ' "$repo_root" 2>/dev/null)" || true
  # then origin/HEAD symref, else gh, else main
  if [[ -z "$d" ]]; then
    d="$(git -C "$repo_root" symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>/dev/null | sed 's|^origin/||')" || true
  fi
  if [[ -z "$d" ]]; then
    d="$(gh repo view --json defaultBranchRef --jq '.defaultBranchRef.name' 2>/dev/null)" || true
  fi
  echo "${d:-main}"
}

# `ensure` creates a branch and pushes it — a write to the SHARED .git, which the
# PR sentinel can be touching at the same time from another worktree. Same lock as
# ticket-worktree.sh, deliberately the same path so the two serialize against each
# other and not just against themselves.
git_dir="$(git -C "$repo_root" rev-parse --git-common-dir)"
[[ "$git_dir" = /* ]] || git_dir="$repo_root/$git_dir"
git_lock="$git_dir/shipyard-git.lock"

# `stat` disagrees about `-f` across platforms, and the disagreement is NOT a
# clean failure: BSD/macOS reads it as the FORMAT flag, GNU reads it as
# --file-system, so on Linux `stat -f %m <dir>` fails on the operand `%m` and
# STILL prints the filesystem report for <dir> — to STDOUT. Chaining the two
# spellings with `||` therefore concatenates that report onto the real answer,
# and the caller's arithmetic then evaluates the word `File` from `File: "<dir>"`
# as a variable. So each spelling is tried in isolation (GNU first, same order as
# ticket-worktree.sh) and only an all-digits answer is accepted; an unreadable
# mtime is reported as such (non-zero) rather than smuggled through as 0.
lock_mtime() {
  local out
  if out="$(stat -c %Y "$1" 2>/dev/null)" && [[ "$out" =~ ^[0-9]+$ ]]; then
    printf '%s' "$out"; return 0
  fi
  if out="$(stat -f %m "$1" 2>/dev/null)" && [[ "$out" =~ ^[0-9]+$ ]]; then
    printf '%s' "$out"; return 0
  fi
  return 1
}

# ONE exit handler for both things this script has to give back: the git lock and
# the temporary worktree `refresh` merges in. Two `trap … EXIT` installations do
# not compose — the second silently replaces the first — so a `refresh` that
# installed its own would have leaked the lock on every conflict.
lock_held=false
refresh_tmp_parent=""
# `set -e` is LIVE inside an EXIT trap (`bash -ec 'trap "false; echo reached" EXIT;
# true'` prints nothing and exits 1), so a handler whose job is to GIVE RESOURCES
# BACK must not be interruptible by it: one failing step would skip every step
# after it — leaking the git lock — and would also turn a refresh that succeeded
# into a non-zero exit. Hence `set +e` here, and `return $st` so the status that
# triggered the trap is the status that survives it.
cleanup() {
  local st=$?
  set +e
  if [[ -n "$refresh_tmp_parent" ]]; then
    if [[ -d "$refresh_tmp_parent/epic-refresh" ]]; then
      git -C "$repo_root" worktree remove --force "$refresh_tmp_parent/epic-refresh" >/dev/null 2>&1
    fi
    rm -rf "$refresh_tmp_parent"
    git -C "$repo_root" worktree prune >/dev/null 2>&1
  fi
  $lock_held && rm -rf "$git_lock"
  return $st
}
trap cleanup EXIT INT TERM

acquire_git_lock() {
  local ttl=120 waited=0 mtime
  while ! mkdir "$git_lock" 2>/dev/null; do
    # Stealing the lock is a mutation (`rm -rf`) on another process's state, so it
    # needs positive evidence the holder is gone: an mtime we could actually READ,
    # older than the TTL. Unknown means keep waiting; the 60s ceiling below is the
    # bounded way out.
    if [[ -d "$git_lock" ]] && mtime="$(lock_mtime "$git_lock")" \
       && (( $(date +%s) - mtime > ttl )); then
      rm -rf "$git_lock"
      continue
    fi
    sleep 0.2
    waited=$((waited + 1))
    if (( waited > 300 )); then
      echo "could not acquire $git_lock after 60s — another shipyard process (the PR sentinel?) is mid-operation" >&2
      return 1
    fi
  done
  lock_held=true
}

ahead_by() { # commits on <epic> not yet in <base>, from the remote's view
  local epic="$1" base="$2"
  gh api "repos/{owner}/{repo}/compare/${base}...${epic}" --jq '.ahead_by' 2>/dev/null || echo 0
}

# Which worktree, if any, has <branch> checked out. A ref that is checked out
# somewhere must NOT be moved with `update-ref`: the ref moves, the index and the
# working tree do not, and that checkout then shows every incoming change as a
# phantom diff in the opposite direction. `merge --ff-only` inside that worktree
# moves all three, and is refused only when the incoming changes would overwrite
# local edits — so it is ATTEMPTED rather than pre-screened for cleanliness.
# The listing is captured before the pipe: awk's `exit` would SIGPIPE git, and
# pipefail reports the LEFT side's status.
worktree_holding() {
  local list
  list="$(git -C "$repo_root" worktree list --porcelain 2>/dev/null || true)"
  printf '%s\n' "$list" | awk -v b="refs/heads/$1" '
    /^worktree /{ p = substr($0, 10) }
    $0 == "branch " b { print p; exit }' || true
}

# The record of which local refs actually moved. `refs_moved` is on stdout for a
# caller and each move is named on stderr for a human, because a ref that moved
# under someone's feet with nothing said is how this whole class stays invisible.
moved_json=""
append_moved() { # <branch> <from-sha|""> <to-sha>
  local from='null'
  [[ -n "$2" ]] && from="\"$2\""
  [[ -n "$moved_json" ]] && moved_json+=","
  moved_json+="$(printf '{"ref":"%s","from":%s,"to":"%s"}' "$1" "$from" "$3")"
}

# Fast-forward a LOCAL branch onto <sha>. This is the half that was broken four
# times in one session: a refresh performed from a detached worktree updates
# origin and leaves the local base and epic exactly where they were, and the next
# `ticket-worktree.sh create` then cuts from the old tip while reporting success.
# Only ever a FAST-FORWARD — a local ref that is not an ancestor of the target
# carries commits origin does not have, and this script has no standing to
# discard them. Every refusal is reported and none is fatal: a refresh that
# pushed correctly must not exit non-zero because one local ref could not follow.
collect_ref_move() { # <branch> <target-sha>
  local branch="$1" target="$2" cur wt
  cur="$(git -C "$repo_root" rev-parse --verify --quiet "refs/heads/$branch^{commit}" 2>/dev/null || true)"
  if [[ -z "$cur" ]]; then
    git -C "$repo_root" branch --no-track "$branch" "$target" 1>&2 || {
      echo "could not create the local ref $branch at ${target:0:7}" >&2; return 0; }
    git -C "$repo_root" branch --set-upstream-to="origin/$branch" "$branch" 1>&2 2>/dev/null || true
    echo "local ref $branch created at ${target:0:7}" >&2
    append_moved "$branch" "" "$target"
    return 0
  fi
  [[ "$cur" != "$target" ]] || return 0
  if ! git -C "$repo_root" merge-base --is-ancestor "$cur" "$target"; then
    echo "local $branch (${cur:0:7}) is not an ancestor of ${target:0:7} — leaving it alone; it carries commits origin does not have" >&2
    return 0
  fi
  wt="$(worktree_holding "$branch")"
  if [[ -n "$wt" ]]; then
    if ! git -C "$wt" merge --ff-only "$target" 1>&2; then
      echo "local $branch is checked out at $wt and could not be fast-forwarded — run: git -C $wt merge --ff-only ${target:0:7}" >&2
      return 0
    fi
  elif ! git -C "$repo_root" update-ref "refs/heads/$branch" "$target" "$cur"; then
    echo "could not fast-forward the local ref $branch (${cur:0:7} → ${target:0:7})" >&2
    return 0
  fi
  echo "local ref $branch moved ${cur:0:7} → ${target:0:7}" >&2
  append_moved "$branch" "$cur" "$target"
}

# stdout for `refresh`. Full forty-character shas, the same rule the gate trailer
# follows: `epic_before` is the BACKOUT TARGET for a refresh that should not have
# happened, and a reader cannot lengthen an abbreviation.
emit_refresh_json() { # <merged> <pushed> [conflicts-json]
  local before='null' after='null'
  if [[ -n "$epic_sha" ]]; then before="\"$epic_sha\""; after="$before"; fi
  if [[ -n "${new_sha:-}" ]]; then after="\"$new_sha\""; fi
  printf '{"branch":"%s","base":"%s","behind_by":%s,"merged":%s,"pushed":%s,"epic_before":%s,"epic_after":%s,"conflicts":%s,"refs_moved":[%s]}\n' \
    "$epic" "$base" "$behind" "$1" "$2" "$before" "$after" "${3:-[]}" "$moved_json"
}

case "$cmd" in
  ensure)
    epic="${2:-}"; base="${3:-$(default_branch)}"
    [[ -n "$epic" ]] || { echo "usage: epic-branch.sh ensure <epic-branch> [base-ref]" >&2; exit 2; }
    acquire_git_lock
    git -C "$repo_root" fetch origin --prune 1>&2
    # `ensure` guarantees BOTH refs: the remote epic and a LOCAL branch tracking
    # it. Ticket worktrees are cut off this name, and a bare branch name that
    # exists only on the remote does not resolve through `git rev-parse` — so
    # short-circuiting on the remote ref alone broke every later
    # `ticket-worktree.sh create <T> <branch> <epic>` with "base ref not found".
    if git -C "$repo_root" show-ref --verify --quiet "refs/remotes/origin/$epic"; then
      if ! git -C "$repo_root" show-ref --verify --quiet "refs/heads/$epic"; then
        git -C "$repo_root" branch --track "$epic" "origin/$epic" 1>&2 || {
          echo "could not create a local branch for existing origin/$epic" >&2; exit 1; }
      fi
      echo "$epic"; exit 0
    fi
    git -C "$repo_root" rev-parse --verify --quiet "origin/$base^{commit}" >/dev/null || {
      echo "base ref not found: origin/$base" >&2; exit 1; }
    # create the ref without disturbing the current checkout, then publish it.
    # A pre-existing LOCAL branch of the same name is reused, but only after we
    # confirm it descends from the base — silently pushing an unrelated local
    # branch as the phase epic would poison the whole integration.
    if git -C "$repo_root" show-ref --verify --quiet "refs/heads/$epic"; then
      git -C "$repo_root" merge-base --is-ancestor "origin/$base" "$epic" || {
        echo "local branch $epic exists but does not contain origin/$base — refusing to publish it as the phase epic; delete or rename it first" >&2
        exit 1; }
      echo "reusing existing local branch $epic" >&2
    else
      git -C "$repo_root" branch --no-track "$epic" "origin/$base" 1>&2
    fi
    git -C "$repo_root" push -u origin "$epic" 1>&2
    echo "$epic"
    ;;
  refresh)
    # An epic learns what landed under it, with a verb of its own. Before this
    # existed nothing in delivery ever merged the base INTO an epic: two epics
    # were measured 27 then 31 commits behind the base, each containing zero
    # occurrences of the predicates their next tickets were written against,
    # while `ticket-worktree.sh create` reported success four separate times.
    #
    # It never resolves a conflict, in either direction. A conflict here is a
    # decision about somebody's work and this script has no standing to make it:
    # it names the paths and refuses, leaving the epic exactly as it found it.
    epic="${2:-}"; base="${3:-$(default_branch)}"
    [[ -n "$epic" ]] || { echo "usage: epic-branch.sh refresh <epic-branch> [base-ref]" >&2; exit 2; }
    acquire_git_lock
    git -C "$repo_root" fetch origin --prune 1>&2

    if ! git -C "$repo_root" show-ref --verify --quiet "refs/remotes/origin/$epic"; then
      # ROUTINE, and it fires on most cold starts: Step 0 refreshes every epic the
      # GRAPH knows, which includes every phase that has not started yet (Step 3.0
      # creates that branch later, with `ensure`) and every phase that shipped and
      # had its epic reaped. There is genuinely nothing to refresh, so this exits
      # 0 — a per-epic non-zero on every run is how a reader learns to ignore exit
      # codes. And it deliberately does NOT name `ensure` as the remedy: an agent
      # obeying that line would recreate a dead epic branch off the base and push
      # it for a phase that shipped weeks ago.
      echo "nothing to refresh: origin/$epic does not exist (the phase has not started, or it shipped and the branch was reaped)" >&2
      epic_sha=""; behind=0
      emit_refresh_json false false
      exit 0
    fi
    base_sha="$(git -C "$repo_root" rev-parse --verify --quiet "refs/remotes/origin/$base^{commit}" 2>/dev/null)" || {
      echo "base ref not found: origin/$base" >&2; exit 1; }
    epic_sha="$(git -C "$repo_root" rev-parse --verify "refs/remotes/origin/$epic^{commit}")"
    # Measured on ORIGIN's edition of both, never on the local names: after the
    # sentinel squash-merges through the GitHub API the local refs do not move,
    # so a local measurement is a snapshot of whenever this checkout last looked.
    behind="$(git -C "$repo_root" rev-list --count "$epic_sha..$base_sha")"

    if [[ "$behind" -eq 0 ]]; then
      # Nothing landed on the base that the epic does not already have, so there
      # is nothing to merge and NOTHING TO PUSH. The LOCAL refs are a separate
      # question and are still fast-forwarded, because this is the other state
      # measured on this very repo: origin/epic two commits ahead after the guard
      # merged two ticket PRs through the API, `behind` 0 because the base itself
      # never moved, and the local epic still sitting at the pre-merge tip with
      # nothing in delivery moving it. A refresh that returned here would do
      # nothing at all for exactly that case.
      collect_ref_move "$epic" "$epic_sha"
      collect_ref_move "$base" "$base_sha"
      echo "already up to date: $epic already contains origin/$base — nothing merged, nothing pushed" >&2
      emit_refresh_json false false
      exit 0
    fi

    # Merge in a DETACHED worktree of its own. The epic is usually checked out
    # nowhere; the main checkout is somebody's working tree and must not be
    # touched; an executor's worktree is not a candidate either (base-merge.cjs
    # refuses on the two untracked files every executor worktree has by design).
    # The trade is that nothing about a detached merge moves the local refs,
    # which is why collect_ref_move below is not optional.
    refresh_tmp_parent="$(mktemp -d)"
    wt="$refresh_tmp_parent/epic-refresh"
    git -C "$repo_root" worktree add --detach "$wt" "$epic_sha" 1>&2
    if ! git -C "$wt" merge --no-edit -m "Merge origin/$base into $epic" "$base_sha" 1>&2; then
      conflicts="$(git -C "$wt" diff --name-only --diff-filter=U 2>/dev/null || true)"
      git -C "$wt" merge --abort >/dev/null 2>&1 || true
      if [[ -z "$conflicts" ]]; then
        # A merge can fail with NO conflicted path — a `merge.ff = only` in the
        # user's gitconfig is the ordinary way. Printing "conflicts in:" over an
        # empty list would describe a conflict that does not exist and send the
        # reader looking for it; git's own message on stderr above is the answer.
        echo "refusing to refresh $epic: merging origin/$base ($behind commit(s)) FAILED with no conflicted path — git's own message is above; $epic is unchanged at ${epic_sha:0:7}" >&2
      else
        echo "refusing to refresh $epic: merging origin/$base ($behind commit(s)) conflicts in:" >&2
        printf '%s\n' "$conflicts" | sed 's/^/  /' >&2
        echo "resolve it by hand on a checkout of $epic — a conflict here is a decision about somebody's work; $epic is unchanged at ${epic_sha:0:7}" >&2
      fi
      # Quoted through node: a path with a space or a quote in it must not turn
      # the machine-readable half into something that no longer parses.
      conflicts_json="$(printf '%s' "$conflicts" | node -e '
        let s = "";
        process.stdin.on("data", (d) => (s += d)).on("end", () => {
          process.stdout.write(JSON.stringify(s.split("\n").filter(Boolean)));
        });')"
      emit_refresh_json false false "$conflicts_json"
      exit 1
    fi
    new_sha="$(git -C "$wt" rev-parse HEAD)"
    git -C "$wt" push origin "HEAD:refs/heads/$epic" 1>&2 || {
      echo "push to origin/$epic was rejected — it moved while this refresh was running; re-run refresh" >&2
      exit 1; }
    collect_ref_move "$epic" "$new_sha"
    collect_ref_move "$base" "$base_sha"
    echo "refreshed $epic: merged origin/$base ($behind commit(s)), pushed ${epic_sha:0:7} → ${new_sha:0:7}" >&2
    emit_refresh_json true true
    ;;
  pr)
    epic="${2:-}"; base="${3:-$(default_branch)}"
    [[ -n "$epic" ]] || { echo "usage: epic-branch.sh pr <epic-branch> [base-ref]" >&2; exit 2; }
    existing="$(gh pr list --state open --head "$epic" --base "$base" --json number --jq '.[0].number' 2>/dev/null || true)"
    if [[ -n "$existing" && "$existing" != "null" ]]; then echo "$existing"; exit 0; fi
    if [[ "$(ahead_by "$epic" "$base")" -eq 0 ]]; then
      echo "no-diff-yet: epic $epic has no commits ahead of $base — open the epic PR after the first ticket lands" >&2
      exit 0
    fi
    gh pr create --base "$base" --head "$epic" --draft \
      --title "epic: ${epic#epic/} integration" \
      --body "$(printf 'Integration branch for the %s epic.\n\nAll ticket PRs in this phase stack into this branch; this PR merges the whole phase into %s once every ticket is green and integrated.\n\nEpic: %s' "${epic#epic/}" "$base" "$epic")" 1>&2
    gh pr list --state open --head "$epic" --base "$base" --json number --jq '.[0].number'
    ;;
  status)
    epic="${2:-}"; base="${3:-$(default_branch)}"
    [[ -n "$epic" ]] || { echo "usage: epic-branch.sh status <epic-branch> [base-ref]" >&2; exit 2; }
    remote=false
    git -C "$repo_root" show-ref --verify --quiet "refs/remotes/origin/$epic" && remote=true || true
    pr="$(gh pr list --state all --head "$epic" --base "$base" --json number,state --jq '.[0]' 2>/dev/null || echo '')"
    prnum=null; prstate=null
    if [[ -n "$pr" && "$pr" != "null" ]]; then
      prnum="$(echo "$pr" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(JSON.parse(s).number)}catch{console.log("null")}})')"
      prstate="\"$(echo "$pr" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(JSON.parse(s).state)}catch{console.log("")}})')\""
    fi
    ahead=0; [[ "$remote" == true ]] && ahead="$(ahead_by "$epic" "$base")"
    printf '{"branch":"%s","base":"%s","remote":%s,"ahead":%s,"pr":%s,"pr_state":%s}\n' \
      "$epic" "$base" "$remote" "$ahead" "$prnum" "$prstate"
    ;;
  retarget)
    pr="${2:-}"; newbase="${3:-}"
    [[ -n "$pr" && -n "$newbase" ]] || { echo "usage: epic-branch.sh retarget <pr-number> <new-base>" >&2; exit 2; }
    gh pr edit "$pr" --base "$newbase" 1>&2
    echo "retargeted PR #$pr onto $newbase"
    ;;
  *)
    echo "usage: epic-branch.sh <ensure|refresh|pr|status|retarget> ..." >&2
    exit 2
    ;;
esac
