#!/usr/bin/env bash
set -euo pipefail

# Completes Atlassian Rovo MCP OAuth INSIDE the running dev container and
# persists it via the bind-mounted ~/.claude/.credentials.json.
#
# Run on the HOST. It execs `claude` inside the running compose container so the
# OAuth credentials are written to the Linux credentials file (portable), not
# the host macOS Keychain.

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd)"
SERVICE="${DEV_SERVICE:-dev}"
SERVER_URL="https://mcp.atlassian.com/v1/mcp"

if [[ -f /.dockerenv ]] || [[ "${HOME:-}" == "/home/dev" ]]; then
  echo "run this script on the host, not inside the container" >&2
  exit 1
fi

if ! command -v docker >/dev/null 2>&1; then
  echo "docker not found on host PATH" >&2
  exit 1
fi

cd "$REPO_ROOT"
cid="$(docker compose ps -q "$SERVICE" || true)"
if [[ -z "$cid" ]]; then
  echo "dev container is not running; start it first (e.g. docker compose up -d)" >&2
  exit 1
fi

echo "Launching in-container Claude session for Atlassian Rovo OAuth..."
echo "Complete the printed browser URL when prompted; credentials persist to ./.claude-credentials.json"

docker exec -it "$cid" bash -lc '
  set -euo pipefail
  claude -p "Use the atlassian-rovo MCP server. If authentication is required, complete the OAuth flow, then reply exactly: atlassian-rovo authenticated." \
    --mcp-config '"'"'{"mcpServers":{"atlassian-rovo":{"type":"http","url":"'"$SERVER_URL"'"}}}'"'"' \
    --permission-mode bypassPermissions \
    --output-format text
'

echo "If authentication completed, ~/.claude/.credentials.json now holds Atlassian Rovo OAuth state (persisted on the host)."
