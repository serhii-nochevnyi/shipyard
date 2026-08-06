#!/usr/bin/env bash
set -euo pipefail

[[ -f Dockerfile ]] || { echo "missing Dockerfile"; exit 1; }
[[ -f Makefile ]] || { echo "missing Makefile"; exit 1; }

# `make build-base` below hard-fails without it; the exported vars satisfy the
# Makefile's `?=` defaults.
# shellcheck source=lib/git-identity.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib/git-identity.sh"

make build-base sync-karpathy-skills build-dev-image >/dev/null

docker run --rm claude-shipyard:test bash -lc '
  set -euo pipefail
  test -f "$HOME/.claude.json"
  jq -e ".mcpServers[\"atlassian-rovo\"].url == \"https://mcp.atlassian.com/v1/mcp\"" "$HOME/.claude.json" >/dev/null
  jq -e ".mcpServers[\"atlassian-rovo\"].type == \"http\"" "$HOME/.claude.json" >/dev/null
  jq -e ".mcpServers[\"context7\"].command == \"context7-mcp\"" "$HOME/.claude.json" >/dev/null
  jq -e ".mcpServers[\"context7\"].type == \"stdio\"" "$HOME/.claude.json" >/dev/null
  jq -e ".mcpServers[\"context7\"].args == []" "$HOME/.claude.json" >/dev/null
'

docker run --rm --entrypoint bash claude-shipyard:test -lc '
  set -euo pipefail
  cat > "$HOME/.claude.json" <<'"'"'EOF'"'"'
{
  "mcpServers": {
    "existing": { "type": "http", "url": "https://example.com/mcp" }
  }
}
EOF
  /usr/local/bin/entrypoint.sh bash -lc '"'"'
    set -euo pipefail
    jq -e ".mcpServers[\"existing\"].url == \"https://example.com/mcp\"" "$HOME/.claude.json" >/dev/null
    jq -e ".mcpServers[\"atlassian-rovo\"].url == \"https://mcp.atlassian.com/v1/mcp\"" "$HOME/.claude.json" >/dev/null
    jq -e ".mcpServers[\"context7\"].command == \"context7-mcp\"" "$HOME/.claude.json" >/dev/null
  '"'"'
'

if docker run --rm --entrypoint bash claude-shipyard:test -lc '
  set -euo pipefail
  printf "{broken-json\n" > "$HOME/.claude.json"
  /usr/local/bin/entrypoint.sh true
'; then
  echo "expected invalid .claude.json to fail"
  exit 1
fi

echo "mcp runtime smoke passed"
