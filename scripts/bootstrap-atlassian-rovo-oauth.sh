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
SERVER_NAME="${ATLASSIAN_SERVER_NAME:-atlassian-rovo}"

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
  echo "dev container is not running; start it first with: make up" >&2
  exit 1
fi

# MCP remote-server OAuth uses a loopback callback the host browser cannot reach
# inside a container, so a plain `claude -p` flow can never receive the code.
# `claude mcp login --no-browser` (Claude Code >= 2.1.191) instead PRINTS the
# authorization URL and waits for you to paste the full redirect URL back.
# Run interactively (-it) so that paste prompt is reachable. The `atlassian-rovo`
# server is already registered in ~/.claude.json by the container entrypoint.
echo "Starting interactive Atlassian Rovo (${SERVER_NAME}) OAuth inside the container."
echo
echo "  1. Claude will print an authorization URL — open it in your host browser."
echo "  2. Approve access. Your browser will try to redirect to http://localhost:<port>/callback"
echo "     and show a connection error — that is expected."
echo "  3. Copy the FULL redirect URL from the browser address bar and paste it back"
echo "     at the prompt here."
echo
echo "Credentials then land in ~/.claude/.credentials.json (persisted to ./.claude-credentials.json)."
echo "If a previous half-finished attempt blocks you, run: docker compose exec ${SERVICE} claude mcp logout ${SERVER_NAME}"
echo

docker exec -it "$cid" claude mcp login "$SERVER_NAME" --no-browser

echo
echo "Done. Verify with: docker compose exec ${SERVICE} claude mcp list"
