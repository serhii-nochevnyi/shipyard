#!/usr/bin/env bash
set -euo pipefail

if [[ ! -f Dockerfile.base ]]; then
  echo "missing Dockerfile.base"
  exit 1
fi

LOCAL_SSH_DIR="${LOCAL_SSH_DIR:-$HOME/.ssh}" make build-base >/dev/null

docker run --rm \
  -v "$PWD/.build/ssh-config:/tmp/expected-ssh:ro" \
  remote-copilot-base:test bash -lc '
  set -euo pipefail
  for cmd in bash curl git gh gzip helm jq kubectl make node pnpm python3 rsync ssh sudo tar unzip xz yarn zip copilot go; do
    command -v "$cmd" >/dev/null
  done

  [[ "$(id -un)" == "dev" ]]
  [[ "$HOME" == "/home/dev" ]]
  [[ -d /workspace ]]

  [[ "$(git config --global user.name)" == "Nochevnyi Serhii" ]]
  [[ "$(git config --global user.email)" == "nochevnyi.serhii@airslate.com" ]]
  [[ "$(git config --global init.defaultBranch)" == "main" ]]
  [[ "$(git config --global push.autoSetupRemote)" == "true" ]]
  [[ "$(git config --global color.ui)" == "auto" ]]
  [[ "$(git config --global fetch.prune)" == "true" ]]
  [[ "$(git config --global pull.rebase)" == "false" ]]
  [[ "$(git config --global pull.ff)" == "only" ]]

  [[ -d "$HOME/.ssh" ]]
  [[ "$(stat -c %a "$HOME/.ssh")" == "700" ]]

  for file in config known_hosts known_hosts2; do
    if [[ -f "/tmp/expected-ssh/$file" ]]; then
      test -f "$HOME/.ssh/$file"
      [[ "$(stat -c %a "$HOME/.ssh/$file")" == "600" ]]
    fi
  done

  for forbidden in authorized_keys id_rsa id_dsa id_ecdsa id_ed25519; do
    test ! -e "$HOME/.ssh/$forbidden"
  done

  test -f /usr/local/share/remote-copilot/mcp-config.default.json
  command -v context7-mcp >/dev/null
  jq -e ".mcpServers[\"atlassian-rovo\"].url == \"https://mcp.atlassian.com/v1/mcp\"" /usr/local/share/remote-copilot/mcp-config.default.json >/dev/null
  jq -e ".mcpServers[\"context7\"].command == \"context7-mcp\"" /usr/local/share/remote-copilot/mcp-config.default.json >/dev/null
  jq -e ".mcpServers[\"context7\"].args == []" /usr/local/share/remote-copilot/mcp-config.default.json >/dev/null
  test -f /usr/local/share/remote-copilot/lsp-config.default.json
  command -v typescript-language-server >/dev/null
  command -v tsc >/dev/null
  [[ "$(typescript-language-server --version)" == "5.2.0" ]]
  [[ "$(tsc --version)" == "Version 6.0.3" ]]
  jq -e ".lspServers[\"typescript\"].command == \"typescript-language-server\"" /usr/local/share/remote-copilot/lsp-config.default.json >/dev/null
  jq -e ".lspServers[\"typescript\"].args == [\"--stdio\"]" /usr/local/share/remote-copilot/lsp-config.default.json >/dev/null
  jq -e ".lspServers[\"typescript\"].fileExtensions == {
    \".ts\": \"typescript\",
    \".tsx\": \"typescript\",
    \".js\": \"typescript\",
    \".jsx\": \"typescript\"
  }" /usr/local/share/remote-copilot/lsp-config.default.json >/dev/null

  [[ "$(pnpm --version)" == "10.10.0" ]]
  [[ "$(yarn --version)" == "1.22.22" ]]
  [[ "$(node --version)" == "v24.15.0" ]]
  [[ "$(go version)" == go\ version\ go1.26.3* ]]
  [[ "$(kubectl version --client -o json | python3 -c '"'"'import json, sys; print(json.load(sys.stdin)["clientVersion"]["gitVersion"])'"'"')" == "v1.30.10" ]]
  [[ "$(helm version --short | sed "s/+.*//")" == "v3.17.3" ]]
  [[ "$(copilot --version)" == *"1.0.44"* ]]
'

echo "base image smoke passed"
