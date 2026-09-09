#!/usr/bin/env bash
set -euo pipefail

# Deterministic worktree lifecycle for ticket executors.
#
#   ticket-worktree.sh create <ticket-id> <branch> <base-ref>   # cuts from origin/<base-ref> when it exists, else the given ref
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
# default and prunes only what it can PROVE is safe — delivery-state saying the
# ticket is merged, never the mere absence of a remote branch, which is also what
# an unpushed commit looks like; SHIPYARD_WORKTREE_WARN_AT (default 20) is when
# it starts saying the set is too big.

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

# `stat` disagrees about `-f` across platforms, and the disagreement is NOT a
# clean failure: BSD/macOS reads it as the FORMAT flag, GNU reads it as
# --file-system, so on Linux `stat -f %m <dir>` fails on the operand `%m` and
# STILL prints the filesystem report for <dir> — to STDOUT. Chaining the two
# spellings with `||` therefore concatenates that report onto the real answer,
# and the caller's arithmetic then evaluates the word `File` from `File: "<dir>"`
# as a variable: "File: unbound variable" under `set -u`, which killed the whole
# run the first time anything ever contended this lock. So each spelling is tried
# in isolation and only an all-digits answer is accepted; an unreadable mtime is
# reported as such (non-zero) rather than smuggled through as 0.
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

acquire_git_lock() {
  local ttl=120 waited=0 mtime
  while ! mkdir "$git_lock" 2>/dev/null; do
    # Stealing the lock is a mutation (`rm -rf`) on another process's state, so it
    # needs positive evidence that the holder is gone: an mtime we could actually
    # READ, older than the TTL. An unreadable one used to come back as 0 — epoch,
    # which reads as "ancient" — and would force-remove a live holder's lock.
    # Unknown means keep waiting; the 60s ceiling below is the bounded way out.
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
  trap 'rm -rf "$git_lock"' EXIT INT TERM
}

# WHICH EDITION of <base> a worktree is cut from: ORIGIN's, whenever it exists.
#
# A base ref may exist only on the remote — a bare branch name does not resolve
# through `git rev-parse` unless a local ref exists, so a second delivery run (or
# a fresh clone, or a machine that never created the epic locally) used to die
# with "base ref not found" on every root ticket. That is the case this function
# was written for, and it is the LOUD one.
#
# The quiet one is worse, and it is why origin now comes FIRST: a bare name
# resolves refs/heads before refs/remotes, so a stale local `epic/<phase>` — the
# state every session checkout is in after the sentinel squash-merges through the
# GitHub API, since nothing moves the local ref — silently won the lookup, and
# `create` cut the worktree from the pre-merge tip while reporting success. Four
# separate times in one session, against epics 27 and 31 commits behind the base,
# each containing none of the predicates the plans were written against.
#
# So the board's edition wins, and a divergent local ref is REPORTED rather than
# obeyed: the PR's base and scope-gate both measure `origin/<base>` (see
# graph-dir.cjs's resolveBaseRef), so a worktree cut from a local ref that is
# AHEAD of origin carries commits the base does not have and scope-gate flags
# them as violations — a false failure of the kind that gets a gate switched off.
# The full refs/remotes/ probe makes SHAs and already-prefixed refs fall through.
#
# Prints "<ref-name>\t<sha>"; the NAME is what callers print, because a silently
# substituted base would be a new invisible behaviour.
resolve_base() {
  local ref="$1" out origin_sha local_sha candidate
  origin_sha="$(git -C "$repo_root" rev-parse --verify --quiet "refs/remotes/origin/$ref^{commit}" 2>/dev/null || true)"
  if [[ -n "$origin_sha" ]]; then
    local_sha="$(git -C "$repo_root" rev-parse --verify --quiet "refs/heads/$ref^{commit}" 2>/dev/null || true)"
    if [[ -n "$local_sha" && "$local_sha" != "$origin_sha" ]]; then
      echo "base $ref: measuring origin/$ref (${origin_sha:0:7}); the LOCAL ref of that name is at ${local_sha:0:7} and is not what this worktree is cut from" >&2
    fi
    printf '%s\t%s' "origin/$ref" "$origin_sha"
    return 0
  fi
  # No origin edition at all: a local branch, a sha, a tag, an already-prefixed
  # ref. Nothing here can be stale relative to something that does not exist.
  for candidate in "$ref" "refs/heads/$ref"; do
    if out="$(git -C "$repo_root" rev-parse --verify --quiet "${candidate}^{commit}" 2>/dev/null)"; then
      printf '%s\t%s' "$candidate" "$out"
      return 0
    fi
  done
  return 1
}

# How far a branch this script is about to REUSE stands from the base it was
# supposed to be cut from. Reuse is the normal resumed-run path and it used to be
# silent, so a branch cut before three ticket merges landed looked identical to
# one cut a second ago. Reported, never acted on: merging the base in is the
# fixer's job (base-merge.cjs) and re-cutting the branch would discard work.
reuse_distance() { # <branch> <base-ref-name>
  local branch="$1" base_name="$2" counts behind ahead
  [[ -n "$base_name" ]] || { printf '%s' "the base does not resolve here, so its distance is unknown"; return 0; }
  counts="$(git -C "$repo_root" rev-list --left-right --count "$base_name...$branch" 2>/dev/null || true)"
  [[ -n "$counts" ]] || { printf '%s' "distance from $base_name unknown (the branch and the base share no history)"; return 0; }
  behind="$(printf '%s' "$counts" | cut -f1)"
  ahead="$(printf '%s' "$counts" | cut -f2)"
  printf '%s commit(s) behind %s, %s ahead' "$behind" "$base_name" "$ahead"
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

    # Measured BEFORE the reuse branches, because both of them report a distance
    # against it — but not fatally here: a resumed run whose base branch has
    # since been reaped must still be able to reuse its own worktree. The create
    # path below is where a base that resolves to nothing is a hard error.
    base_name=""; base_sha=""
    if resolved="$(resolve_base "$base")"; then
      base_name="${resolved%%$'\t'*}"; base_sha="${resolved##*$'\t'}"
      echo "base $base measured as $base_name (${base_sha:0:7})" >&2
    fi

    # Already there? Reuse it when it holds the right branch; refuse only on a
    # genuine mismatch, which is a state a human has to look at.
    if [[ -e "$wt_dir" ]]; then
      current="$(git -C "$wt_dir" rev-parse --abbrev-ref HEAD 2>/dev/null || echo '')"
      if [[ "$current" == "$branch" ]]; then
        echo "reusing existing worktree for $ticket ($wt_dir, branch $branch) — $(reuse_distance "$branch" "$base_name")" >&2
        echo "$wt_dir"
        exit 0
      fi
      echo "worktree $wt_dir exists but is on '${current:-unknown}', expected '$branch' — resolve by hand" >&2
      exit 1
    fi

    [[ -n "$base_sha" ]] || {
      echo "base ref not found: $base (looked for origin/$base, $base, refs/heads/$base)" >&2
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
      # An existing local branch is reused AS IT STANDS — it may hold committed
      # work that exists nowhere else, so it is never re-cut onto the base. Say
      # how far from the base it is instead of reusing it silently.
      echo "reusing existing branch $branch — $(reuse_distance "$branch" "$base_name")" >&2
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

    # POSITIVE EVIDENCE that a worktree's work has landed. The absence of
    # origin/<branch> is not evidence of anything: it is equally what an executor
    # looks like between committing its work and pushing it, which is the normal
    # mid-ticket state of EVERY ticket — so the rule that read "in the graph,
    # clean, no remote branch" as landed force-removed unpushed commits that
    # existed nowhere else. Only delivery-state saying the ticket is merged proves
    # it landed, and when there is no delivery-state nothing is provable, so
    # nothing is landed. (`reapable` is state-sync's stricter flag — merged AND no
    # open PR still hanging off the branch — so it implies `merged`; both are
    # accepted because either one is the store asserting the work is in.)
    # `state_note` is what a ticket's reason says when the store could not answer
    # for it, and MISSING and UNREADABLE are different facts with different
    # remedies — one is "no delivery has run here", the other is "the store is
    # corrupt, repair it". Both mean nothing is provable, so both still fail
    # closed; only the wording differs, and this verdict exists to be read.
    dstate="$repo_root/.planning/graph/delivery-state.json"
    state_rows=""; merged_ids=""; state_present=false
    state_note="no delivery-state.json"
    if [[ -f "$dstate" ]]; then
      if state_rows="$(node -e '
        const s = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
        const rows = [];
        for (const [id, r] of Object.entries(s && typeof s === "object" ? s : {})) {
          if (!r || typeof r !== "object") continue;
          const status = typeof r.status === "string" ? r.status : "unknown";
          const landed = status === "merged" || r.reapable === true;
          rows.push([id, status, landed ? "landed" : "-"].join("\t"));
        }
        process.stdout.write(rows.join("\n"));
      ' "$dstate" 2>/dev/null)"; then
        state_present=true
        merged_ids="$(printf '%s\n' "$state_rows" | awk -F'\t' '$3 == "landed" { print $1 }')"
      else
        state_note="delivery-state.json present but unreadable"
        echo "warning: $dstate is unreadable — nothing can be proven landed, so nothing will be pruned" >&2
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
      verdict=""; reason=""; porcelain=""
      if [[ ! -d "$wt_path" ]]; then
        verdict="gone"; reason="registered but the directory is missing"
      elif ! porcelain="$(git -C "$wt_path" status --porcelain 2>/dev/null)"; then
        # A `git status` that FAILS prints nothing, and the old
        # `[[ -n "$(git … status --porcelain)" ]]` read that silence as a clean
        # tree: a broken worktree, an unreadable gitdir link, an IO error or a
        # permission fault fell through to `live`/`landed`/`review` while the
        # reason claimed "tree clean" about a tree nothing had established
        # anything about. `landed` is the one verdict `--prune` acts on, so it
        # must be EARNED by a check that ANSWERED — the same rule the under-lock
        # re-check below applies one layer later, and this is the layer that
        # decides. Deliberately NOT `dirty`: nobody made any edits to go looking
        # for, and that conflation is exactly what the prune path stopped doing.
        # `review` is the honest verdict — reported, kept, a human's call.
        verdict="review"; reason="git status failed — cannot confirm the tree is clean; inspect by hand"
      elif [[ -n "$porcelain" ]]; then
        verdict="dirty"; reason="uncommitted changes — never removed by gc"
      elif [[ -n "$branch" ]] && git -C "$repo_root" show-ref --verify --quiet "refs/remotes/origin/$branch"; then
        verdict="live"; reason="origin/$branch still exists"
      elif $graph_present && printf '%s\n' "$known" | grep -qxF "$ticket"; then
        if printf '%s\n' "$merged_ids" | grep -qxF "$ticket"; then
          verdict="landed"; reason="delivery state says merged; tree clean"
        else
          # Known, clean, no remote — and nothing says it landed. The commits on
          # this branch may exist nowhere else, so name the remedy rather than the
          # missing ref: a push makes it `live`, and removing it is a human's call.
          st="$state_note"
          if $state_present; then
            st="$(printf '%s\n' "$state_rows" | awk -F'\t' -v t="$ticket" '$1 == t { print $2; exit }')"
            [[ -n "$st" ]] || st="not in delivery-state"
          fi
          verdict="review"
          reason="committed work not on origin — push or remove by hand (origin/${branch:-?} gone; delivery state: $st)"
        fi
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
    removed=0; skipped=0; failed=0
    while IFS=$'\t' read -r verdict ticket branch wt_path reason; do
      [[ "$verdict" == "landed" ]] || continue
      # The classification above is a SNAPSHOT, taken before this lock was held,
      # and `worktree remove --force` discards whatever it finds. Re-read the
      # porcelain here, inside the lock, immediately before the removal: a tree
      # that gained work while gc was deciding is skipped, not destroyed. The exit
      # status is a SEPARATE outcome from a non-empty tree — a `git status` that
      # FAILS prints nothing, and reading that silence as "clean" would fail open
      # straight into `rm -rf` — and it gets its own reason, because "became
      # dirty" sends a reader looking for edits that were never made when the
      # real fault is a permission, an IO error or a broken worktree.
      if [[ -d "$wt_path" ]]; then
        skip_reason=""
        if porcelain="$(git -C "$wt_path" status --porcelain 2>/dev/null)"; then
          [[ -z "$porcelain" ]] \
            || skip_reason="became dirty after it was classified landed"
        else
          skip_reason="git status failed — cannot confirm the tree is clean"
        fi
        if [[ -n "$skip_reason" ]]; then
          skipped=$((skipped + 1))
          echo "skipped $ticket ($wt_path) — $skip_reason; inspect it by hand" >&2
          continue
        fi
      fi
      # A removal is a MUTATION, so its OUTCOME is checked and not assumed —
      # the same rule as the verdict above, one layer later. Both halves can
      # fail (a registration git will not let go of, then `rm -rf` on a
      # non-writable parent, a read-only mount, or a mount point inside the
      # tree), and the exit status of either is the wrong thing to trust: what
      # matters is whether the directory is still there, which is checkable
      # without reasoning about how `rm -rf` reports a partial failure on two
      # platforms. Counting it regardless printed "removed" over a worktree
      # still on disk, under a summary that promises what actually happened.
      # The `|| true` is what keeps `set -e` out of it: a failing `rm` is the
      # last command of the `||` list, so it used to kill the whole prune
      # mid-loop and take the remaining landed worktrees, every skip reason and
      # the summary with it. `rm`'s own stderr is deliberately NOT suppressed —
      # "Permission denied" is the diagnosis.
      git -C "$repo_root" worktree remove --force "$wt_path" 1>&2 2>/dev/null \
        || rm -rf "$wt_path" || true
      if [[ -e "$wt_path" ]]; then
        failed=$((failed + 1))
        echo "FAILED to remove $ticket ($wt_path) — it is still present; remove it by hand" >&2
        continue
      fi
      removed=$((removed + 1))
      echo "removed $ticket ($wt_path)" >&2
    done < <(printf '%s' "$rows")
    git -C "$repo_root" worktree prune 1>&2 2>/dev/null || true
    # Say what was left behind and why: a gc that reports only its successes reads
    # as "everything is clean" when the interesting cases are the ones it skipped.
    # Report what was actually removed, not what was classified: those two
    # numbers differ exactly when a tree changed under the lock or a removal
    # failed outright, which are the two cases worth naming.
    landed_removed=$removed
    removed=$((landed_removed + gone_count))
    kept=$((total - removed))
    skipped_note=""
    if (( skipped > 0 )); then
      skipped_note=" skipped $skipped landed worktree(s) that could not be re-proven clean under the lock (see the per-worktree reason above);"
    fi
    failed_note=""
    if (( failed > 0 )); then
      failed_note=" $failed landed worktree(s) could not be removed and are STILL PRESENT (see the per-worktree line above);"
    fi
    echo "gc: removed $removed ($landed_removed landed, $gone_count stale registration(s)), kept $kept —${failed_note}${skipped_note} dirty/live/review are never removed automatically, inspect them by hand" >&2
    ;;
  *)
    echo "usage: ticket-worktree.sh <create|remove|path|root|list [--json]|gc [--prune] [--json]> ..." >&2
    exit 2
    ;;
esac
