#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd)"
COPILOT_BIN="${COPILOT_BIN:-copilot}"
HOST_COPILOT_DIR="${HOST_COPILOT_DIR:-$HOME/.copilot}"
SOURCE_DIR="$HOST_COPILOT_DIR/mcp-oauth-config"
TARGET_DIR="${MCP_OAUTH_DIR:-$REPO_ROOT/.copilot-mcp-oauth}"
SERVER_URL="https://mcp.atlassian.com/v1/mcp"

if [[ -f /.dockerenv ]] || [[ "${HOME:-}" == "/home/dev" ]]; then
  echo "run this script on the host, not inside the container" >&2
  exit 1
fi

if ! command -v "$COPILOT_BIN" >/dev/null 2>&1; then
  echo "copilot CLI not found on host PATH" >&2
  exit 1
fi

if ! command -v jq >/dev/null 2>&1; then
  echo "jq not found on host PATH" >&2
  exit 1
fi

tmpdir="$(mktemp -d)"
trap 'rm -rf "$tmpdir"' EXIT

mkdir -p "$TARGET_DIR"

cat > "$tmpdir/atlassian-mcp.json" <<'EOF'
{
  "mcpServers": {
    "atlassian-rovo": {
      "type": "http",
      "url": "https://mcp.atlassian.com/v1/mcp",
      "tools": ["*"]
    }
  }
}
EOF

echo "Starting host-side Copilot session for Atlassian Rovo OAuth..."
"$COPILOT_BIN" -p "Use the atlassian-rovo MCP server. If authentication is required, complete the browser-based authentication flow and then reply with the exact text: atlassian-rovo authenticated." \
  --allow-all \
  --additional-mcp-config "@$tmpdir/atlassian-mcp.json" \
  --output-format text >/dev/null

if [[ ! -d "$SOURCE_DIR" ]]; then
  echo "host MCP OAuth directory not found at $SOURCE_DIR" >&2
  exit 1
fi

mkdir -p "$tmpdir/selected"
found=0
shopt -s nullglob
for json_file in "$SOURCE_DIR"/*.json; do
  if jq -e --arg url "$SERVER_URL" '.serverUrl == $url' "$json_file" >/dev/null; then
    base_name="$(basename "${json_file%.json}")"
    cp "$json_file" "$tmpdir/selected/$base_name.json"
    if [[ -f "$SOURCE_DIR/$base_name.verifier" ]]; then
      cp "$SOURCE_DIR/$base_name.verifier" "$tmpdir/selected/$base_name.verifier"
    fi
    found=1
  fi
done
shopt -u nullglob

if [[ "$found" -ne 1 ]]; then
  echo "no Atlassian Rovo OAuth state found in $SOURCE_DIR" >&2
  exit 1
fi

rm -rf "$TARGET_DIR"
mkdir -p "$TARGET_DIR"
cp -R "$tmpdir/selected/." "$TARGET_DIR/"
chmod 700 "$TARGET_DIR"
find "$TARGET_DIR" -type f -exec chmod 600 {} \;

echo "Synced Atlassian Rovo OAuth state to $TARGET_DIR"
