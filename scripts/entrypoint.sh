#!/usr/bin/env bash
set -euo pipefail

mkdir -p /workspace
mkdir -p "$HOME/.cache" "$HOME/.local/share" "$HOME/.config" "$HOME/.copilot"

merge_default_json() {
  local default_config="$1"
  local user_config="$2"
  local jq_filter="$3"

  if [[ ! -f "$default_config" ]]; then
    return
  fi

  if [[ ! -f "$user_config" ]]; then
    cp "$default_config" "$user_config"
  else
    jq empty "$user_config" >/dev/null
  fi

  local tmp_config
  tmp_config="$(mktemp)"
  jq "$jq_filter" "$user_config" > "$tmp_config"
  mv "$tmp_config" "$user_config"
}

default_mcp_config="/usr/local/share/remote-copilot/mcp-config.default.json"
user_mcp_config="$HOME/.copilot/mcp-config.json"
default_lsp_config="/usr/local/share/remote-copilot/lsp-config.default.json"
user_lsp_config="$HOME/.copilot/lsp-config.json"

merge_default_json "$default_mcp_config" "$user_mcp_config" '
  .mcpServers |= (. // {}) |
  .mcpServers["atlassian-rovo"] = (.mcpServers["atlassian-rovo"] // {
    type: "http",
    url: "https://mcp.atlassian.com/v1/mcp",
    tools: ["*"]
  }) |
  .mcpServers["context7"] = (.mcpServers["context7"] // {
    command: "context7-mcp",
    args: []
  })
'

merge_default_json "$default_lsp_config" "$user_lsp_config" '
  .lspServers |= (. // {}) |
  .lspServers["typescript"] = (.lspServers["typescript"] // {
    command: "typescript-language-server",
    args: ["--stdio"],
    fileExtensions: {
      ".ts": "typescript",
      ".tsx": "typescript",
      ".js": "typescript",
      ".jsx": "typescript"
    }
  })
'

if [[ ! -w /workspace ]]; then
  echo "/workspace is not writable"
  exit 1
fi

exec "$@"
