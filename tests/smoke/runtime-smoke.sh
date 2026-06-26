#!/usr/bin/env bash
set -euo pipefail

[[ -f docker-compose.yml ]] || { echo "missing docker-compose.yml"; exit 1; }
[[ -f Makefile ]] || { echo "missing Makefile"; exit 1; }

mkdir -p workspace .cache-home .copilot-mcp-oauth
repo_path="$(pwd)"
tmpdir="$(mktemp -d)"
trap 'rm -rf "$tmpdir"; docker compose down >/dev/null 2>&1 || true' EXIT

[[ -x scripts/bootstrap-atlassian-rovo-oauth.sh ]] || { echo "missing scripts/bootstrap-atlassian-rovo-oauth.sh"; exit 1; }
make -n bootstrap-atlassian-oauth >/dev/null

mkdir -p "$tmpdir/home/.copilot"
if HOME="$tmpdir/home" \
  HOST_COPILOT_DIR="$tmpdir/home/.copilot" \
  MCP_OAUTH_DIR="$tmpdir/out" \
  COPILOT_BIN=/definitely-missing \
  ./scripts/bootstrap-atlassian-rovo-oauth.sh >"$tmpdir/stdout" 2>"$tmpdir/stderr"; then
  echo "expected bootstrap script to fail without copilot CLI"
  exit 1
fi
grep -q "copilot CLI not found on host PATH" "$tmpdir/stderr"

DEV_COPILOT_INSTALL_CMD="${DEV_COPILOT_INSTALL_CMD:-}" make build-base sync-plugin build-dev-image >/dev/null
DEV_IMAGE=remote-copilot:test \
BASE_IMAGE=remote-copilot-base:test \
DEV_COPILOT_INSTALL_CMD="${DEV_COPILOT_INSTALL_CMD:-}" \
WORKSPACE_DIR="$(pwd)/workspace" \
HOME_CACHE_DIR="$(pwd)/.cache-home" \
MCP_OAUTH_DIR="$(pwd)/.copilot-mcp-oauth" \
docker compose run --rm dev bash -lc '
  set -euo pipefail
  id -un | grep -qx dev
  test -d /workspace
  test -d "$HOME/.cache"
  test -d "$HOME/.local/share"
  test -f "$HOME/.copilot/mcp-config.json"
  test -f "$HOME/.copilot/lsp-config.json"
  plugin_list="$(copilot plugin list)"
  grep -q "dev-copilot" <<<"$plugin_list"
  grep -q "andrej-karpathy-skills" <<<"$plugin_list"
  test -d "$HOME/.copilot/mcp-oauth-config"
  touch "$HOME/.copilot/mcp-oauth-config/.write-test"
  rm "$HOME/.copilot/mcp-oauth-config/.write-test"
  jq -e ".lspServers[\"typescript\"].command == \"typescript-language-server\"" "$HOME/.copilot/lsp-config.json" >/dev/null
  jq -e ".lspServers[\"typescript\"].args == [\"--stdio\"]" "$HOME/.copilot/lsp-config.json" >/dev/null
  jq -e ".lspServers[\"typescript\"].fileExtensions[\".ts\"] == \"typescript\"" "$HOME/.copilot/lsp-config.json" >/dev/null
  jq -e ".lspServers[\"typescript\"].fileExtensions[\".tsx\"] == \"typescript\"" "$HOME/.copilot/lsp-config.json" >/dev/null
  jq -e ".lspServers[\"typescript\"].fileExtensions[\".js\"] == \"typescript\"" "$HOME/.copilot/lsp-config.json" >/dev/null
  jq -e ".lspServers[\"typescript\"].fileExtensions[\".jsx\"] == \"typescript\"" "$HOME/.copilot/lsp-config.json" >/dev/null
'

docker compose down >/dev/null 2>&1 || true
DEV_IMAGE=remote-copilot:test \
BASE_IMAGE=remote-copilot-base:test \
DEV_COPILOT_INSTALL_CMD="${DEV_COPILOT_INSTALL_CMD:-}" \
WORKSPACE_DIR="$(pwd)/workspace" \
HOME_CACHE_DIR="$(pwd)/.cache-home" \
MCP_OAUTH_DIR="$(pwd)/.copilot-mcp-oauth" \
docker compose up -d >/dev/null

cid="$(docker compose ps -q dev)"
test -n "$cid"
docker exec -w "$repo_path" "$cid" bash -lc 'set -euo pipefail; pwd' | grep -qx "$repo_path"
docker inspect "$cid" --format '{{json .Mounts}}' | jq -e 'map(select(.Destination == "/home/dev/.ssh" and .RW == false)) | length == 1' >/dev/null
docker inspect "$cid" --format '{{json .Mounts}}' | jq -e 'map(select(.Destination == "/home/dev/.copilot/mcp-oauth-config" and .RW == true)) | length == 1' >/dev/null
docker inspect "$cid" --format '{{json .Mounts}}' | jq -e 'map(select(.Destination == "/home/dev/.copilot")) | length == 0' >/dev/null

docker run --rm --entrypoint bash remote-copilot:test -lc '
  set -euo pipefail
  mkdir -p "$HOME/.copilot"
  cat > "$HOME/.copilot/lsp-config.json" <<'"'"'EOF'"'"'
{
  "lspServers": {
    "eslint": {
      "command": "vscode-eslint-language-server",
      "args": ["--stdio"],
      "fileExtensions": {
        ".js": "javascript"
      }
    }
  }
}
EOF
  /usr/local/bin/entrypoint.sh bash -lc '"'"'
    set -euo pipefail
    jq -e ".lspServers[\"eslint\"].command == \"vscode-eslint-language-server\"" "$HOME/.copilot/lsp-config.json" >/dev/null
    jq -e ".lspServers[\"typescript\"].command == \"typescript-language-server\"" "$HOME/.copilot/lsp-config.json" >/dev/null
    jq -e ".lspServers[\"typescript\"].args == [\"--stdio\"]" "$HOME/.copilot/lsp-config.json" >/dev/null
    jq -e ".lspServers[\"typescript\"].fileExtensions[\".jsx\"] == \"typescript\"" "$HOME/.copilot/lsp-config.json" >/dev/null
  '"'"'
'

docker run --rm --entrypoint bash remote-copilot:test -lc '
  set -euo pipefail
  mkdir -p "$HOME/.copilot"
  cat > "$HOME/.copilot/lsp-config.json" <<'"'"'EOF'"'"'
{
  "lspServers": {
    "typescript": {
      "command": "custom-ts-lsp",
      "args": ["--custom-stdio"],
      "fileExtensions": {
        ".ts": "custom-typescript"
      }
    }
  }
}
EOF
  /usr/local/bin/entrypoint.sh bash -lc '"'"'
    set -euo pipefail
    jq -e ".lspServers[\"typescript\"].command == \"custom-ts-lsp\"" "$HOME/.copilot/lsp-config.json" >/dev/null
    jq -e ".lspServers[\"typescript\"].args == [\"--custom-stdio\"]" "$HOME/.copilot/lsp-config.json" >/dev/null
    jq -e ".lspServers[\"typescript\"].fileExtensions[\".ts\"] == \"custom-typescript\"" "$HOME/.copilot/lsp-config.json" >/dev/null
  '"'"'
'

if docker run --rm --entrypoint bash remote-copilot:test -lc '
  set -euo pipefail
  mkdir -p "$HOME/.copilot"
  printf "{broken-json\n" > "$HOME/.copilot/lsp-config.json"
  /usr/local/bin/entrypoint.sh true
'; then
  echo "expected invalid lsp-config.json to fail"
  exit 1
fi

if grep -q "COPILOT_PROFILE_DIR" docker-compose.yml; then
  echo "docker-compose.yml should not mention COPILOT_PROFILE_DIR"
  exit 1
fi

echo "runtime smoke passed"
