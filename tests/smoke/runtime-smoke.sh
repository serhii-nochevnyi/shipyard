#!/usr/bin/env bash
set -euo pipefail

[[ -f docker-compose.yml ]] || { echo "missing docker-compose.yml"; exit 1; }
[[ -f Makefile ]] || { echo "missing Makefile"; exit 1; }

mkdir -p workspace .cache-home "$HOME/.config/gh"
touch .claude-credentials.json
repo_path="$(pwd)"
trap 'docker compose down >/dev/null 2>&1 || true' EXIT

[[ -x scripts/bootstrap-atlassian-rovo-oauth.sh ]] || { echo "missing scripts/bootstrap-atlassian-rovo-oauth.sh"; exit 1; }
make -n bootstrap-atlassian-oauth >/dev/null

# Bootstrap must refuse to run inside the container.
if HOME=/home/dev ./scripts/bootstrap-atlassian-rovo-oauth.sh >/dev/null 2>&1; then
  echo "expected bootstrap to refuse when HOME=/home/dev"
  exit 1
fi

make build-base sync-karpathy-skills build-dev-image >/dev/null

DEV_IMAGE=claude-shipyard:test \
BASE_IMAGE=claude-shipyard-base:test \
WORKSPACE_DIR="$(pwd)/workspace" \
HOME_CACHE_DIR="$(pwd)/.cache-home" \
CLAUDE_CREDENTIALS_FILE="$(pwd)/.claude-credentials.json" \
docker compose run --rm dev bash -lc '
  set -euo pipefail
  id -un | grep -qx dev
  test -d /workspace
  test -d "$HOME/.cache"
  test -f "$HOME/.claude.json"
  command -v claude >/dev/null
  # all five plugins appear in installed_plugins.json
  for p in andrej-karpathy-skills@karpathy-skills skill-creator@claude-plugins-official code-simplifier@claude-plugins-official github@claude-plugins-official typescript-lsp@claude-plugins-official; do
    jq -e --arg p "$p" ".plugins[\$p]" "$HOME/.claude/plugins/installed_plugins.json" >/dev/null
  done
  # The whole point of the single-file mount: dev (uid 1000) must be able to WRITE it,
  # else remote-MCP OAuth is silently lost on restart.
  test -f "$HOME/.claude/.credentials.json"
  printf "{}" > "$HOME/.claude/.credentials.json"
'

docker compose down >/dev/null 2>&1 || true
DEV_IMAGE=claude-shipyard:test \
BASE_IMAGE=claude-shipyard-base:test \
WORKSPACE_DIR="$(pwd)/workspace" \
HOME_CACHE_DIR="$(pwd)/.cache-home" \
CLAUDE_CREDENTIALS_FILE="$(pwd)/.claude-credentials.json" \
docker compose up -d >/dev/null

cid="$(docker compose ps -q dev)"
test -n "$cid"
docker exec -w "$repo_path" "$cid" bash -lc 'set -euo pipefail; pwd' | grep -qx "$repo_path"
docker inspect "$cid" --format '{{json .Mounts}}' | jq -e 'map(select(.Destination == "/home/dev/.ssh" and .RW == false)) | length == 1' >/dev/null
docker inspect "$cid" --format '{{json .Mounts}}' | jq -e 'map(select(.Destination == "/home/dev/.config/gh" and .RW == false)) | length == 1' >/dev/null
docker inspect "$cid" --format '{{json .Mounts}}' | jq -e 'map(select(.Destination == "/home/dev/.claude/.credentials.json" and .RW == true)) | length == 1' >/dev/null
docker inspect "$cid" --format '{{json .Mounts}}' | jq -e 'map(select(.Destination == "/home/dev/.claude")) | length == 0' >/dev/null

# Narrow checks: assert the removed artifacts are gone without grepping broad substrings.
for pat in 'COPILOT_' 'DEV_COPILOT' '\.copilot' 'mcp-oauth-config'; do
  if grep -qE "$pat" docker-compose.yml; then
    echo "docker-compose.yml should not mention $pat"
    exit 1
  fi
done

echo "runtime smoke passed"
