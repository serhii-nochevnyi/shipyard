#!/usr/bin/env bash
set -euo pipefail

[[ -f Dockerfile ]] || { echo "missing Dockerfile"; exit 1; }
[[ -f Makefile ]] || { echo "missing Makefile"; exit 1; }

mkdir -p workspace .cache-home .copilot-mcp-oauth
DEV_COPILOT_INSTALL_CMD="${DEV_COPILOT_INSTALL_CMD:-}" make build-base sync-plugin build-dev-image >/dev/null

docker run --rm remote-copilot:test bash -lc '
  set -euo pipefail
  test -f "$HOME/.copilot/mcp-config.json"
  jq -e ".mcpServers[\"atlassian-rovo\"].url == \"https://mcp.atlassian.com/v1/mcp\"" "$HOME/.copilot/mcp-config.json" >/dev/null
  jq -e ".mcpServers[\"context7\"].command == \"context7-mcp\"" "$HOME/.copilot/mcp-config.json" >/dev/null
  jq -e ".mcpServers[\"context7\"].args == []" "$HOME/.copilot/mcp-config.json" >/dev/null
  mcp_list="$(copilot mcp list)"
  grep -q "atlassian-rovo" <<<"$mcp_list"
  grep -q "context7" <<<"$mcp_list"
'

docker run --rm --entrypoint bash remote-copilot:test -lc '
  set -euo pipefail
  mkdir -p "$HOME/.copilot"
  cat > "$HOME/.copilot/mcp-config.json" <<'"'"'EOF'"'"'
{
  "mcpServers": {
    "existing": {
      "type": "http",
      "url": "https://example.com/mcp",
      "tools": ["*"]
    }
  }
}
EOF
  /usr/local/bin/entrypoint.sh bash -lc '"'"'
    set -euo pipefail
    jq -e ".mcpServers[\"existing\"].url == \"https://example.com/mcp\"" "$HOME/.copilot/mcp-config.json" >/dev/null
    jq -e ".mcpServers[\"atlassian-rovo\"].url == \"https://mcp.atlassian.com/v1/mcp\"" "$HOME/.copilot/mcp-config.json" >/dev/null
    jq -e ".mcpServers[\"context7\"].command == \"context7-mcp\"" "$HOME/.copilot/mcp-config.json" >/dev/null
    jq -e ".mcpServers[\"context7\"].args == []" "$HOME/.copilot/mcp-config.json" >/dev/null
  '"'"'
'

if docker run --rm --entrypoint bash remote-copilot:test -lc '
  set -euo pipefail
  mkdir -p "$HOME/.copilot"
  printf "{broken-json\n" > "$HOME/.copilot/mcp-config.json"
  /usr/local/bin/entrypoint.sh true
'; then
  echo "expected invalid mcp-config.json to fail"
  exit 1
fi

echo "mcp runtime smoke passed"
