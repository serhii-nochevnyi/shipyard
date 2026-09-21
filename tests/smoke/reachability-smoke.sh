#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SCRIPT="$ROOT/plugins/delivery-pipeline/scripts/run-reachability.cjs"
W="$(mktemp -d)"
trap 'rm -rf "$W"' EXIT

export GIT_CONFIG_GLOBAL="$W/gitconfig"
export GIT_CONFIG_NOSYSTEM=1
git config --file "$GIT_CONFIG_GLOBAL" user.email reachability-smoke@example.com
git config --file "$GIT_CONFIG_GLOBAL" user.name 'Reachability Smoke'
git config --file "$GIT_CONFIG_GLOBAL" init.defaultBranch main
git config --file "$GIT_CONFIG_GLOBAL" protocol.file.allow always

git init -q --bare "$W/origin"
git init -q -b main "$W/seed"
( cd "$W/seed"
  printf 'one\n' > file.txt
  git add file.txt
  git commit -qm initial
  git remote add origin "$W/origin"
  git push -q -u origin main )
git --git-dir="$W/origin" symbolic-ref HEAD refs/heads/main
git clone -q "$W/origin" "$W/clone"

base_json="$(node "$SCRIPT" prove --repo "$W/clone" --base main --branch ticket/fresh --worktree "$W/fresh" --declared file.txt --json)"
node -e 'const v=JSON.parse(process.argv[1]); if(v.status!=="reachable"||v.origin.ref!=="origin/main"||v.declared.matched_files[0]!=="file.txt") process.exit(1)' "$base_json"

old="$(git -C "$W/clone" rev-parse HEAD)"
git -C "$W/clone" branch ticket/stale main
( cd "$W/seed"
  printf 'two\n' > file.txt
  git add file.txt
  git commit -qm moved
  git push -q origin main )
git -C "$W/clone" fetch -q origin

set +e
stale_json="$(node "$SCRIPT" prove --repo "$W/clone" --base main --branch ticket/stale --worktree "$W/stale" --declared file.txt --json)"
rc=$?
set -e
[[ "$rc" == 10 ]]
node -e 'const v=JSON.parse(process.argv[1]); if(v.status!=="retryable_pending"||v.reason.code!=="BASE_NOT_ANCESTOR") process.exit(1)' "$stale_json"
[[ "$(git -C "$W/clone" rev-parse refs/heads/ticket/stale)" == "$old" ]]

printf '%s\n' "$stale_json"
echo 'reachability smoke passed'
