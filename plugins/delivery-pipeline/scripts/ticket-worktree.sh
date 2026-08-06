#!/usr/bin/env bash
set -euo pipefail

# Deterministic worktree lifecycle for ticket executors.
#
#   ticket-worktree.sh create <ticket-id> <branch> <base-ref>
#   ticket-worktree.sh remove <ticket-id>
#   ticket-worktree.sh path   <ticket-id>
#   ticket-worktree.sh list            # human: `git worktree list`
#   ticket-worktree.sh list --json     # machine: [{"ticket","path","branch"}]
#   ticket-worktree.sh gc              # classify every pipeline worktree (report only)
#   ticket-worktree.sh gc --prune      # …and remove the ones proven safe
#   ticket-worktree.sh gc --json       # machine-readable classification
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
#
# `gc` exists because the reaper cannot see everything: it walks the CURRENT
# tickets.json and removes what delivery-state marks `reapable`, so a worktree
# whose ticket was re-decomposed away, one left by a run that died, or one from a
# phase delivered months ago is invisible to it and accumulates forever. That is
# not cosmetic — a large enough worktree set makes the sandbox profile exceed the
# argv limit (E2BIG) and every sandboxed command starts failing. gc reports by
# default and prunes only what it can PROVE is safe; SHIPYARD_WORKTREE_WARN_AT
# (default 20) is when it starts saying the set is too big.

cmd="${1:-}"
ticket="${2:-}"

repo_root="$(git rev-parse --show-toplevel 2>/dev/null)" || { echo "not inside a git repository" >&2; exit 1; }
repo_name="$(basename "$repo_root")"
wt_base="${SHIPYARD_WORKTREE_ROOT:-$(dirname "$repo_root")/.wt-${repo_name}}"

# Serialize everything that writes to the SHARED .git. `git worktree add` and
# branch creation both take index.lock, and since the PR sentinel guards open PRs
# CONCURRENTLY with the main loop creating new worktrees, two of them can collide
# on it. mkdir is atomic on every POSIX filesystem; a holder older than the TTL is
# presumed dead, so a killed run cannot wedge the next one forever.
git_dir="$(git -C "$repo_root" rev-parse --git-common-dir)"
[[ "$git_dir" = /* ]] || git_dir="$repo_root/$git_dir"
git_lock="$git_dir/shipyard-git.lock"

lock_mtime() { stat -f %m "$1" 2>/dev/null || stat -c %Y "$1" 2>/dev/null || echo 0; }

acquire_git_lock() {
  local ttl=120 waited=0
  while ! mkdir "$git_lock" 2>/dev/null; do
    if [[ -d "$git_lock" ]] && (( $(date +%s) - $(lock_mtime "$git_lock") > ttl )); then
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
  trap 'rm -rf "$git_lock"' EXIT INT TERM
}

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

# The pipeline's own worktrees, keyed by ticket id, as JSON. Shared by `list --json`
# and `gc` so both see exactly the same set.
#
# `git worktree list` prints RESOLVED paths, so the prefix we compare against must
# be resolved too — otherwise a root reached through a symlink (a macOS
# /var -> /private/var TMPDIR, a symlinked home) matches nothing and the caller
# concludes there are no worktrees at all.
list_json() {
  local list_base="$wt_base"
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
}

case "$cmd" in
  create)
    branch="${3:-}"
    base="${4:-}"
    [[ -n "$ticket" && -n "$branch" && -n "$base" ]] || {
      echo "usage: ticket-worktree.sh create <ticket-id> <branch> <base-ref>" >&2; exit 2; }
    wt_dir="$wt_base/$ticket"
    acquire_git_lock

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
    acquire_git_lock
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
      list_json
    else
      git -C "$repo_root" worktree list
    fi
    ;;
  gc)
    do_prune=false; as_json=false
    for arg in "${@:2}"; do
      case "$arg" in
        --prune) do_prune=true ;;
        --json)  as_json=true ;;
        *) echo "usage: ticket-worktree.sh gc [--prune] [--json]" >&2; exit 2 ;;
      esac
    done

    warn_at="${SHIPYARD_WORKTREE_WARN_AT:-20}"
    [[ "$warn_at" =~ ^[0-9]+$ ]] || {
      echo "SHIPYARD_WORKTREE_WARN_AT must be a non-negative integer, got '$warn_at'" >&2; exit 2; }

    # Which tickets the CURRENT graph knows about. Its absence is the fail-closed
    # case: with no graph every worktree looks foreign, and "delete everything the
    # graph does not name" is precisely the mistake that loses a colleague's work.
    graph="$repo_root/.planning/graph/tickets.json"
    known=""; graph_present=false
    if [[ -f "$graph" ]]; then
      if known="$(node -e '
        const t = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
        const ids = t && t.tickets ? Object.keys(t.tickets) : [];
        process.stdout.write(ids.join("\n"));
      ' "$graph" 2>/dev/null)"; then
        graph_present=true
      else
        echo "warning: $graph is unreadable — classifying every worktree as 'review' (nothing will be pruned)" >&2
      fi
    fi

    # Refresh remote refs once: the whole classification turns on whether
    # origin/<branch> still exists, and a stale remote-tracking ref would make a
    # merged-and-deleted branch look alive (nothing pruned, silently).
    git -C "$repo_root" fetch origin --prune 1>&2 2>/dev/null || \
      echo "warning: git fetch origin failed — origin/* may be stale, so gc is being conservative" >&2

    rows=""; total=0; gone_count=0; landed_count=0
    while IFS=$'\t' read -r ticket wt_path branch; do
      [[ -n "$ticket" ]] || continue
      total=$((total + 1))
      verdict=""; reason=""
      if [[ ! -d "$wt_path" ]]; then
        verdict="gone"; reason="registered but the directory is missing"
      elif [[ -n "$(git -C "$wt_path" status --porcelain 2>/dev/null)" ]]; then
        verdict="dirty"; reason="uncommitted changes — never removed by gc"
      elif [[ -n "$branch" ]] && git -C "$repo_root" show-ref --verify --quiet "refs/remotes/origin/$branch"; then
        verdict="live"; reason="origin/$branch still exists"
      elif $graph_present && printf '%s\n' "$known" | grep -qxF "$ticket"; then
        # The conveyor deletes a ticket's remote branch only after it has landed,
        # so "in the graph, clean, and origin/<branch> gone" is a merged ticket.
        verdict="landed"; reason="origin/${branch:-?} gone and the tree is clean"
      else
        # Foreign or abandoned: possibly the only copy of real commits. gc reports
        # it and stops — deciding this is a human's call, not a script's.
        verdict="review"
        reason="$($graph_present && echo "unknown to tickets.json" || echo "no tickets.json to check against"), origin/${branch:-?} gone"
      fi
      case "$verdict" in
        gone)   gone_count=$((gone_count + 1)) ;;
        landed) landed_count=$((landed_count + 1)) ;;
      esac
      rows+="$verdict"$'\t'"$ticket"$'\t'"${branch:-?}"$'\t'"$wt_path"$'\t'"$reason"$'\n'
    done < <(list_json | node -e '
      let raw = "";
      process.stdin.on("data", (d) => (raw += d)).on("end", () => {
        for (const w of JSON.parse(raw || "[]")) {
          process.stdout.write([w.ticket, w.path, w.branch || ""].join("\t") + "\n");
        }
      });
    ')

    if $as_json; then
      printf '%s' "$rows" | node -e '
        let raw = "";
        process.stdin.on("data", (d) => (raw += d)).on("end", () => {
          const items = raw.split("\n").filter(Boolean).map((l) => {
            const [verdict, ticket, branch, path, reason] = l.split("\t");
            return { verdict, ticket, branch: branch === "?" ? null : branch, path, reason };
          });
          process.stdout.write(JSON.stringify({
            root: process.argv[1],
            total: items.length,
            warn_at: Number(process.argv[2]),
            over_threshold: items.length > Number(process.argv[2]),
            pruned: process.argv[3] === "true",
            worktrees: items,
          }, null, 2) + "\n");
        });
      ' "$wt_base" "$warn_at" "$do_prune"
    else
      if (( total == 0 )); then
        echo "no pipeline worktrees under $wt_base"
      else
        printf '%s' "$rows" | sort | awk -F'\t' '{ printf "  %-7s %-12s %-34s %s\n", $1, $2, $3, $5 }'
        echo "  ── $total worktree(s); $((gone_count + landed_count)) removable ($landed_count landed, $gone_count gone)"
      fi
      if (( total > warn_at )); then
        echo "⚠ $total worktrees exceeds SHIPYARD_WORKTREE_WARN_AT=$warn_at — a large enough set makes the sandbox profile exceed the argv limit (E2BIG) and every sandboxed command starts failing. Run: ticket-worktree.sh gc --prune" >&2
      fi
    fi

    if ! $do_prune; then
      if (( gone_count + landed_count > 0 )); then
        echo "report only — re-run with --prune to remove the $((gone_count + landed_count)) safe one(s); 'dirty' and 'review' are never removed automatically" >&2
      fi
      exit 0
    fi

    acquire_git_lock
    # A registration whose directory is already gone has no tree to lose work in.
    git -C "$repo_root" worktree prune 1>&2 2>/dev/null || true
    removed=0
    while IFS=$'\t' read -r verdict ticket branch wt_path reason; do
      [[ "$verdict" == "landed" ]] || continue
      git -C "$repo_root" worktree remove --force "$wt_path" 1>&2 2>/dev/null || rm -rf "$wt_path"
      removed=$((removed + 1))
      echo "removed $ticket ($wt_path)" >&2
    done < <(printf '%s' "$rows")
    git -C "$repo_root" worktree prune 1>&2 2>/dev/null || true
    # Say what was left behind and why: a gc that reports only its successes reads
    # as "everything is clean" when the interesting cases are the ones it skipped.
    removed=$((removed + gone_count))
    kept=$((total - removed))
    echo "gc: removed $removed ($landed_count landed, $gone_count stale registration(s)), kept $kept — dirty/live/review are never removed automatically, inspect them by hand" >&2
    ;;
  *)
    echo "usage: ticket-worktree.sh <create|remove|path|root|list [--json]|gc [--prune] [--json]> ..." >&2
    exit 2
    ;;
esac
