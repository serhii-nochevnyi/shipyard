#!/usr/bin/env bash
set -euo pipefail

INPUT="$(cat)"
DATA="$(printf '%s' "$INPUT" | node -e '
let raw="";
process.stdin.on("data", chunk => raw += chunk);
process.stdin.on("end", () => {
  try {
    const payload = JSON.parse(raw);
    const command = String(payload.tool_input?.command || "");
    const cwd = String(payload.cwd || process.cwd());
    const hasPush = /(?:^|[;&|]\s*)git(?:\s+-C\s+(?:"[^"]+"|\x27[^\x27]+\x27|\S+))?\s+push(?:\s|$)/.test(command);
    const path = command.match(/(?:^|[;&|]\s*)git\s+-C\s+(?:"([^"]+)"|\x27([^\x27]+)\x27|(\S+))/);
    const cd = command.match(/(?:^|[;&|]\s*)cd\s+(?:"([^"]+)"|\x27([^\x27]+)\x27|(\S+))/);
    process.stdout.write(JSON.stringify({
      hasPush,
      worktree: path?.[1] || path?.[2] || path?.[3] || cd?.[1] || cd?.[2] || cd?.[3] || cwd,
    }));
  } catch {
    process.stdout.write(JSON.stringify({ hasPush: false }));
  }
});
')"
HAS_PUSH="$(printf '%s' "$DATA" | node -e 'let raw="";process.stdin.on("data",c=>raw+=c);process.stdin.on("end",()=>{try{process.stdout.write(JSON.parse(raw).hasPush?"1":"0")}catch{process.stdout.write("0")}})')"
[[ "$HAS_PUSH" == 1 ]] || exit 0

WORKTREE="$(printf '%s' "$DATA" | node -e 'let raw="";process.stdin.on("data",c=>raw+=c);process.stdin.on("end",()=>{try{process.stdout.write(JSON.parse(raw).worktree||process.cwd())}catch{process.stdout.write(process.cwd())}})')"
PUBLISH_GATE="$(printenv SHIPYARD_PUBLISH_GATE || true)"
if [[ -z "$PUBLISH_GATE" ]]; then
  PUBLISH_GATE="$(cd "$(dirname "$0")/shipyard-stop-gate" && pwd)/publish-gate.cjs"
fi
[[ -f "$PUBLISH_GATE" ]] || { echo "shipyard pre-push: publish gate is not installed" >&2; exit 2; }

if ! node "$PUBLISH_GATE" --worktree "$WORKTREE" --working-tree --ticket publish; then
  echo "shipyard pre-push: push blocked until publish-gate passes" >&2
  exit 2
fi
