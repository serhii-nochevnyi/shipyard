#!/usr/bin/env bash
set -euo pipefail

# Deterministic worktree lifecycle for ticket executors.
#
#   ticket-worktree.sh create <ticket-id> <branch> <base-ref>
#   ticket-worktree.sh remove <ticket-id>
#   ticket-worktree.sh path   <ticket-id>
#   ticket-worktree.sh list            # human: `git worktree list`
#   ticket-worktree.sh list --json     # machine: [{"ticket","path","branch"}]
#   ticket-worktree.sh root            # print the worktree root directory
#
# Worktrees live in <repo>/../.wt-<repo-name>/<ticket-id> so parallel executors
# never touch each other's checkout or the main working tree. Override the
# location with SHIPYARD_WORKTREE_ROOT (needed when the repo's parent directory
# is not writable — e.g. a repo checked out directly at /workspace).
#
# create/remove are IDEMPOTENT: re-running a partially finished delivery must not
# fail on "already exists"/"nothing to remove", because the babysit loop and the
# reaper both re-enter after an interrupted run.

cmd="${1:-}"
ticket="${2:-}"

repo_root="$(git rev-parse --show-toplevel 2>/dev/null)" || { echo "not inside a git repository" >&2; exit 1; }
repo_name="$(basename "$repo_root")"
wt_base="${SHIPYARD_WORKTREE_ROOT:-$(dirname "$repo_root")/.wt-${repo_name}}"

# Resolve a base ref that may exist only on the remote. A bare branch name does
# NOT resolve through `git rev-parse` unless a local ref exists, so a second
# delivery run (or a fresh clone, or a machine that never created the epic
# locally) used to die with "base ref not found" on every root ticket.
resolve_ref() {
  local ref="$1" out
  for candidate in "$ref" "refs/heads/$ref" "origin/$ref" "refs/remotes/origin/$ref"; do
    if out="$(git -C "$repo_root" rev-parse --verify --quiet "${candidate}^{commit}" 2>/dev/null)"; then
      printf '%s' "$out"
      return 0
    fi
  done
  return 1
}

case "$cmd" in
  create)
    branch="${3:-}"
    base="${4:-}"
    [[ -n "$ticket" && -n "$branch" && -n "$base" ]] || {
      echo "usage: ticket-worktree.sh create <ticket-id> <branch> <base-ref>" >&2; exit 2; }
    wt_dir="$wt_base/$ticket"

    git -C "$repo_root" fetch origin --prune 1>&2 2>/dev/null || \
      echo "warning: git fetch origin failed — working from the local refs" >&2

    # Already there? Reuse it when it holds the right branch; refuse only on a
    # genuine mismatch, which is a state a human has to look at.
    if [[ -e "$wt_dir" ]]; then
      current="$(git -C "$wt_dir" rev-parse --abbrev-ref HEAD 2>/dev/null || echo '')"
      if [[ "$current" == "$branch" ]]; then
        echo "reusing existing worktree for $ticket ($wt_dir, branch $branch)" >&2
        echo "$wt_dir"
        exit 0
      fi
      echo "worktree $wt_dir exists but is on '${current:-unknown}', expected '$branch' — resolve by hand" >&2
      exit 1
    fi

    base_sha="$(resolve_ref "$base")" || {
      echo "base ref not found: $base (looked for $base, refs/heads/$base, origin/$base)" >&2
      exit 1; }

    if ! mkdir -p "$wt_base" 2>/dev/null; then
      echo "cannot create the worktree root $wt_base — set SHIPYARD_WORKTREE_ROOT to a writable path" >&2
      exit 1
    fi
    [[ -w "$wt_base" ]] || {
      echo "worktree root $wt_base is not writable — set SHIPYARD_WORKTREE_ROOT to a writable path" >&2
      exit 1; }

    # git worktree add chats on stdout; keep stdout clean — it is the API
    # (the orchestrator consumes the printed path).
    if git -C "$repo_root" show-ref --verify --quiet "refs/heads/$branch"; then
      git -C "$repo_root" worktree add "$wt_dir" "$branch" 1>&2
    else
      git -C "$repo_root" worktree add -b "$branch" "$wt_dir" "$base_sha" 1>&2
      # track the remote base's branch name so `git push` / `@{u}` behave
      git -C "$wt_dir" branch --set-upstream-to="origin/$branch" "$branch" 1>&2 2>/dev/null || true
    fi
    echo "$wt_dir"
    ;;
  remove)
    [[ -n "$ticket" ]] || { echo "usage: ticket-worktree.sh remove <ticket-id>" >&2; exit 2; }
    wt_dir="$wt_base/$ticket"
    if [[ ! -d "$wt_dir" ]]; then
      echo "no worktree for $ticket at $wt_dir — nothing to remove" >&2
      exit 0
    fi
    git -C "$repo_root" worktree remove --force "$wt_dir" 1>&2 2>/dev/null || rm -rf "$wt_dir"
    git -C "$repo_root" worktree prune 1>&2 2>/dev/null || true
    echo "removed $wt_dir"
    ;;
  path)
    [[ -n "$ticket" ]] || { echo "usage: ticket-worktree.sh path <ticket-id>" >&2; exit 2; }
    echo "$wt_base/$ticket"
    ;;
  root)
    echo "$wt_base"
    ;;
  list)
    # `list --json` reports only the PIPELINE's worktrees, keyed by ticket id, so
    # the reaper can act on data instead of parsing `git worktree list` prose.
    if [[ "${2:-}" == "--json" ]]; then
      # `git worktree list` prints RESOLVED paths, so the prefix we compare against
      # must be resolved too — otherwise a root reached through a symlink (a macOS
      # /var -> /private/var TMPDIR, a symlinked home) matches nothing and the
      # reaper concludes there are no worktrees to clean up.
      list_base="$wt_base"
      [[ -d "$wt_base" ]] && list_base="$(cd "$wt_base" && pwd -P)"
      # the root is passed as an argv, not an env prefix: a `VAR=x a | b`
      # assignment applies to `a` only, so `node` would never have seen it.
      git -C "$repo_root" worktree list --porcelain | node -e '
        let raw = "";
        process.stdin.on("data", (d) => (raw += d)).on("end", () => {
          const base = String(process.argv[1] || "").replace(/\/+$/, "");
          const out = [];
          let cur = {};
          const flush = () => {
            if (!cur.worktree) return;
            const p = cur.worktree;
            if (p === base || !p.startsWith(base + "/")) { cur = {}; return; }
            const rest = p.slice(base.length + 1);
            if (rest.includes("/")) { cur = {}; return; }
            out.push({ ticket: rest, path: p, branch: (cur.branch || "").replace(/^refs\/heads\//, "") || null });
            cur = {};
          };
          for (const line of raw.split("\n")) {
            if (line === "") { flush(); continue; }
            const sp = line.indexOf(" ");
            const k = sp === -1 ? line : line.slice(0, sp);
            const v = sp === -1 ? "" : line.slice(sp + 1);
            cur[k] = v;
          }
          flush();
          process.stdout.write(JSON.stringify(out, null, 2) + "\n");
        });
      ' "$list_base"
    else
      git -C "$repo_root" worktree list
    fi
    ;;
  *)
    echo "usage: ticket-worktree.sh <create|remove|path|root|list [--json]> ..." >&2
    exit 2
    ;;
esac
