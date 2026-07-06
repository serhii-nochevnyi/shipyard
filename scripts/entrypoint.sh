#!/usr/bin/env bash
set -euo pipefail

mkdir -p /workspace
mkdir -p "$HOME/.cache" "$HOME/.local/share" "$HOME/.config" "$HOME/.claude"

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

default_mcp_config="/usr/local/share/claude-shipyard/mcp-config.default.json"
user_mcp_config="$HOME/.claude.json"

merge_default_json "$default_mcp_config" "$user_mcp_config" '
  .mcpServers |= (. // {}) |
  .mcpServers["atlassian-rovo"] = (.mcpServers["atlassian-rovo"] // {
    type: "http",
    url: "https://mcp.atlassian.com/v1/mcp"
  }) |
  .mcpServers["context7"] = (.mcpServers["context7"] // {
    type: "stdio",
    command: "context7-mcp",
    args: []
  }) |
  # ~/.claude.json is ephemeral (recreated with the container), so one-time
  # acceptances would be re-asked on every recreation. Pre-seed them:
  # bypass-permissions acceptance + trust for the /workspace root.
  .bypassPermissionsModeAccepted = (.bypassPermissionsModeAccepted // true) |
  .projects |= (. // {}) |
  .projects["/workspace"] |= ((. // {}) |
    .hasTrustDialogAccepted = (.hasTrustDialogAccepted // true) |
    .hasCompletedProjectOnboarding = (.hasCompletedProjectOnboarding // true))
'

if [[ ! -w /workspace ]]; then
  echo "/workspace is not writable"
  exit 1
fi

exec "$@"
