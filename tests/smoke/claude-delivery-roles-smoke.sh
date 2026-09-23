#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
repo_root="$(git -C "$script_dir" rev-parse --show-toplevel)"
host="$repo_root/plugins/delivery-pipeline/scripts/claude-role-host.cjs"

mode=""
role=""
scratch_arg=""
while (($#)); do
  case "$1" in
    --capability-only)
      [[ -z "$mode" ]] || { echo "duplicate smoke mode" >&2; exit 2; }
      mode="capability"
      shift
      ;;
    --live)
      [[ -z "$mode" ]] || { echo "duplicate smoke mode" >&2; exit 2; }
      mode="live"
      shift
      ;;
    --role)
      (($# >= 2)) || { echo "--role requires a value" >&2; exit 2; }
      role="$2"
      shift 2
      ;;
    --worktree)
      (($# >= 2)) || { echo "--worktree requires a value" >&2; exit 2; }
      scratch_arg="$2"
      shift 2
      ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

if [[ "$mode" == capability ]]; then
  [[ -z "$role" && -z "$scratch_arg" ]] || { echo "capability-only accepts no role or worktree" >&2; exit 2; }
  node "$host" --capability-only
  exit $?
fi

[[ "$mode" == live && "$role" == arch-review && -n "$scratch_arg" ]] || {
  echo "usage: claude-delivery-roles-smoke.sh --capability-only | --live --role arch-review --worktree <new-temp-path>" >&2
  exit 2
}

source_root="$repo_root"
source_branch="$(git -C "$source_root" symbolic-ref --quiet --short HEAD)"
[[ -n "$source_branch" && "$source_branch" != "main" ]] || {
  echo '{"status":"refused","reason":"source checkout must be on the ticket PR branch"}'
  exit 1
}
[[ -z "$(git -C "$source_root" status --porcelain=v1 --untracked-files=all)" ]] || {
  echo '{"status":"refused","reason":"source checkout must be clean"}'
  exit 1
}
remote_url="$(git -C "$source_root" remote get-url origin)"
scratch_parent="$(dirname "$scratch_arg")"
scratch_name="$(basename "$scratch_arg")"
mkdir -p "$scratch_parent"
scratch_parent="$(cd "$scratch_parent" && pwd -P)"
scratch_root="$scratch_parent/$scratch_name"
tmp_root="$(cd "${TMPDIR:-/tmp}" && pwd -P)"
case "$scratch_root" in
  "$tmp_root"/*) ;;
  *) echo '{"status":"refused","reason":"scratch worktree must be inside the system temporary directory"}'; exit 1 ;;
esac
[[ ! -e "$scratch_root" ]] || { echo '{"status":"refused","reason":"scratch path already exists"}'; exit 1; }
created=false
smoke_tmp=""
cleanup() {
  if [[ "$created" == true ]]; then rm -rf -- "$scratch_root"; fi
  if [[ -n "$smoke_tmp" ]]; then rm -rf -- "$smoke_tmp"; fi
}
trap cleanup EXIT

if ! git clone --shared --no-hardlinks --no-checkout "$source_root" "$scratch_root" >/dev/null 2>&1; then
  echo '{"status":"unavailable","reason":"could not create disposable repository clone"}'
  exit 0
fi
created=true
if ! git -C "$scratch_root" fetch --no-tags "$source_root" "+refs/heads/$source_branch:refs/remotes/origin/$source_branch" >/dev/null 2>&1; then
  echo '{"status":"unavailable","reason":"ticket branch is not available to the disposable clone"}'
  exit 0
fi
git -C "$scratch_root" checkout --quiet -B "$source_branch" "refs/remotes/origin/$source_branch"
git -C "$scratch_root" remote set-url origin "$remote_url"

probe="$(node "$host" --capability-only)"
probe_status="$(node -e 'const x=JSON.parse(process.argv[1]); process.stdout.write(x.status || "unavailable")' "$probe")"
if [[ "$probe_status" != available ]]; then
  node -e 'const x=JSON.parse(process.argv[1]); process.stdout.write(JSON.stringify({status:"unavailable",reason:x.reason || "runtime unavailable",detail:x.detail || null})+"\n")' "$probe"
  exit 0
fi

smoke_tmp="$(mktemp -d "$tmp_root/shipyard-role-smoke.XXXXXX")"
args_file="$smoke_tmp/request.json"
node -e 'const fs=require("node:fs"); fs.writeFileSync(process.argv[1], JSON.stringify({schema:"shipyard.claude-role-request.v1",role:"arch-review",worktree:process.argv[2]}), {mode:0o600})' "$args_file" "$scratch_root"
result_file="$smoke_tmp/result.json"
if node "$host" --args-file "$args_file" >"$result_file" 2>"$smoke_tmp/error"; then
  node -e 'const fs=require("node:fs"); const r=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); process.stdout.write(JSON.stringify({status:"passed",role:r.role,pr:r.pr,model:r.dispatch.receipt.applied_model,effort:r.dispatch.receipt.applied_effort,session_id:r.dispatch.receipt.session_id,dispatch_id:r.dispatch.receipt.dispatch_id,artifact:r.artifact})+"\n")' "$result_file"
else
  error="$(head -c 1200 "$smoke_tmp/error" | tr '\n' ' ')"
  if [[ "$error" == *RUNTIME_UNAVAILABLE* || "$error" == *CREDENTIALS_UNAVAILABLE* || "$error" == *runtime\ unavailable* ]]; then
    node -e 'process.stdout.write(JSON.stringify({status:"unavailable",reason:process.argv[1]})+"\n")' "$error"
    exit 0
  fi
  node -e 'process.stdout.write(JSON.stringify({status:"refused",reason:process.argv[1]})+"\n")' "$error"
  exit 1
fi
