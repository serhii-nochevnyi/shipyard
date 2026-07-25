#!/usr/bin/env bash
set -euo pipefail

# Deterministic lifecycle for a phase's epic integration branch (epic-stacked
# delivery). Root tickets PR into the epic; dependent tickets cascade into their
# parent branch; the epic itself gets ONE PR into the repo default branch.
#
#   epic-branch.sh ensure   <epic-branch> [base-ref]   create off base + push if absent; prints branch
#   epic-branch.sh pr       <epic-branch> [base-ref]   open the draft epic->base PR once the epic has commits
#   epic-branch.sh status   <epic-branch> [base-ref]   print JSON {branch, base, remote, ahead, pr, pr_state}
#   epic-branch.sh retarget <pr-number> <new-base>     repoint an open (cascade) PR onto a new base
#
# base-ref defaults to the repo default branch (origin/HEAD → main|master).
# stdout is the API — human chatter from git/gh is redirected to stderr.

cmd="${1:-}"

repo_root="$(git rev-parse --show-toplevel 2>/dev/null)" || { echo "not inside a git repository" >&2; exit 1; }

default_branch() {
  # origin/HEAD symref, else gh, else main
  local d
  d="$(git -C "$repo_root" symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>/dev/null | sed 's|^origin/||')" || true
  if [[ -z "$d" ]]; then
    d="$(gh repo view --json defaultBranchRef --jq '.defaultBranchRef.name' 2>/dev/null)" || true
  fi
  echo "${d:-main}"
}

ahead_by() { # commits on <epic> not yet in <base>, from the remote's view
  local epic="$1" base="$2"
  gh api "repos/{owner}/{repo}/compare/${base}...${epic}" --jq '.ahead_by' 2>/dev/null || echo 0
}

case "$cmd" in
  ensure)
    epic="${2:-}"; base="${3:-$(default_branch)}"
    [[ -n "$epic" ]] || { echo "usage: epic-branch.sh ensure <epic-branch> [base-ref]" >&2; exit 2; }
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
    echo "usage: epic-branch.sh <ensure|pr|status|retarget> ..." >&2
    exit 2
    ;;
esac
