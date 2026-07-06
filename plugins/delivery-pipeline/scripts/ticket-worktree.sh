#!/usr/bin/env bash
set -euo pipefail

# Deterministic worktree lifecycle for ticket executors.
#
#   ticket-worktree.sh create <ticket-id> <branch> <base-ref>
#   ticket-worktree.sh remove <ticket-id>
#   ticket-worktree.sh path   <ticket-id>
#   ticket-worktree.sh list
#
# Worktrees live in <repo>/../.wt-<repo-name>/<ticket-id> so parallel executors
# never touch each other's checkout or the main working tree.

cmd="${1:-}"
ticket="${2:-}"

repo_root="$(git rev-parse --show-toplevel 2>/dev/null)" || { echo "not inside a git repository" >&2; exit 1; }
repo_name="$(basename "$repo_root")"
wt_base="$(dirname "$repo_root")/.wt-${repo_name}"

case "$cmd" in
  create)
    branch="${3:-}"
    base="${4:-}"
    [[ -n "$ticket" && -n "$branch" && -n "$base" ]] || {
      echo "usage: ticket-worktree.sh create <ticket-id> <branch> <base-ref>" >&2; exit 2; }
    wt_dir="$wt_base/$ticket"
    [[ ! -e "$wt_dir" ]] || { echo "worktree already exists: $wt_dir" >&2; exit 1; }
    git -C "$repo_root" fetch origin --prune
    git -C "$repo_root" rev-parse --verify --quiet "$base^{commit}" >/dev/null || {
      echo "base ref not found: $base" >&2; exit 1; }
    mkdir -p "$wt_base"
    # git worktree add chats on stdout; keep stdout clean — it is the API
    # (the orchestrator consumes the printed path).
    if git -C "$repo_root" show-ref --verify --quiet "refs/heads/$branch"; then
      git -C "$repo_root" worktree add "$wt_dir" "$branch" 1>&2
    else
      git -C "$repo_root" worktree add -b "$branch" "$wt_dir" "$base" 1>&2
    fi
    echo "$wt_dir"
    ;;
  remove)
    [[ -n "$ticket" ]] || { echo "usage: ticket-worktree.sh remove <ticket-id>" >&2; exit 2; }
    wt_dir="$wt_base/$ticket"
    [[ -d "$wt_dir" ]] || { echo "no worktree for $ticket at $wt_dir" >&2; exit 1; }
    git -C "$repo_root" worktree remove --force "$wt_dir"
    echo "removed $wt_dir"
    ;;
  path)
    [[ -n "$ticket" ]] || { echo "usage: ticket-worktree.sh path <ticket-id>" >&2; exit 2; }
    echo "$wt_base/$ticket"
    ;;
  list)
    git -C "$repo_root" worktree list
    ;;
  *)
    echo "usage: ticket-worktree.sh <create|remove|path|list> ..." >&2
    exit 2
    ;;
esac
