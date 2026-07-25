#!/usr/bin/env bash
set -euo pipefail

mkdir -p /workspace
mkdir -p "$HOME/.cache" "$HOME/.local/share" "$HOME/.config" "$HOME/.claude"

# ── SSH client files ────────────────────────────────────────────────────────
# The host's SSH material arrives read-only at ~/.ssh-host and is COPIED into a
# writable ~/.ssh, never mounted over it. Two reasons:
#   1. mounting the host directory straight onto ~/.ssh shadowed the baked
#      config/known_hosts, and made ~/.ssh read-only — so ssh could not record a
#      new host key and every first connection to an unknown host failed;
#   2. by default the mount source is the build-staged SAFE subset (config,
#      known_hosts), so private keys stay on the host and authentication goes
#      through the forwarded agent. Exposing real keys is opt-in (SSH_DIR).
# Existing files are never overwritten: the image's baked defaults lose to the
# host's, and anything already in ~/.ssh wins over both.
if [[ -d "$HOME/.ssh-host" ]]; then
  mkdir -p "$HOME/.ssh"
  while IFS= read -r -d '' src; do
    dest="$HOME/.ssh/$(basename "$src")"
    [[ -e "$dest" ]] || cp "$src" "$dest" 2>/dev/null || true
  done < <(find "$HOME/.ssh-host" -maxdepth 1 -type f -print0 2>/dev/null)
fi
if [[ -d "$HOME/.ssh" ]]; then
  chmod 700 "$HOME/.ssh" 2>/dev/null || true
  find "$HOME/.ssh" -maxdepth 1 -type f -exec chmod 600 {} + 2>/dev/null || true
fi

# ── remote-MCP credential persistence ───────────────────────────────────────
# ~/.claude is baked into the image (plugins, gsd-core) so it cannot be mounted
# wholesale, but the OAuth credentials inside it must survive `docker compose
# down`. This used to be a single-file bind mount at
# ~/.claude/.credentials.json; a mount point cannot be replaced by rename(2), so
# any writer that saves atomically (write temp + rename) would fail outright
# there. Instead a plain DIRECTORY is mounted next to it and the file is copied
# in at start and mirrored back on change — persistence that is independent of
# how the credentials are written.
CRED_LIVE="$HOME/.claude/.credentials.json"
CRED_STORE="$HOME/.claude-state/credentials.json"
if [[ -d "$(dirname "$CRED_STORE")" ]]; then
  if [[ -s "$CRED_STORE" && ! -s "$CRED_LIVE" ]]; then
    cp "$CRED_STORE" "$CRED_LIVE" 2>/dev/null || true
    chmod 600 "$CRED_LIVE" 2>/dev/null || true
  fi
  if [[ -w "$(dirname "$CRED_STORE")" ]]; then
    # mirror live -> store whenever it changes; dies with the container
    (
      while true; do
        if [[ -s "$CRED_LIVE" ]] && ! cmp -s "$CRED_LIVE" "$CRED_STORE" 2>/dev/null; then
          cp "$CRED_LIVE" "$CRED_STORE" 2>/dev/null || true
          chmod 600 "$CRED_STORE" 2>/dev/null || true
        fi
        sleep 5
      done
    ) >/dev/null 2>&1 &
  else
    echo "warning: $(dirname "$CRED_STORE") is not writable — MCP OAuth will NOT persist across container recreation" >&2
  fi
fi

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

# Trust is recorded PER project directory, and sessions actually start inside
# /workspace/<repo> (make claude DIR=…, the launcher, a plain cd) — seeding only
# /workspace left a trust prompt on every container recreation. Seed every repo
# that already exists; `shipyard-trust` covers ones cloned later.
while IFS= read -r -d '' project; do
  shipyard-trust "$project" >/dev/null 2>&1 || true
done < <(find /workspace -mindepth 1 -maxdepth 1 -type d -print0 2>/dev/null)

if [[ ! -w /workspace ]]; then
  echo "/workspace is not writable"
  exit 1
fi

exec "$@"
