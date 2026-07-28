#!/usr/bin/env bash
set -euo pipefail

if [[ ! -f Dockerfile.base ]]; then
  echo "missing Dockerfile.base"
  exit 1
fi

# The git identity is a REQUIRED build arg with no default (a baked-in fallback
# would author every in-container commit as whoever wrote it down), so the suite
# supplies one: the host's own git config, else an explicit test identity.
GIT_USER_NAME="${GIT_USER_NAME:-$(git config --global user.name || true)}"
GIT_USER_EMAIL="${GIT_USER_EMAIL:-$(git config --global user.email || true)}"
GIT_USER_NAME="${GIT_USER_NAME:-shipyard test}"
GIT_USER_EMAIL="${GIT_USER_EMAIL:-shipyard-test@example.invalid}"
export GIT_USER_NAME GIT_USER_EMAIL

LOCAL_SSH_DIR="${LOCAL_SSH_DIR:-$HOME/.ssh}" make build-base >/dev/null

# The image is built via `make build-base`, so the expected version is the
# Makefile pin (or its env override) — never a hardcoded literal here.
EXPECTED_CLAUDE_VERSION="${CLAUDE_CODE_VERSION:-$(sed -n 's/^CLAUDE_CODE_VERSION ?= //p' Makefile)}"
[[ -n "$EXPECTED_CLAUDE_VERSION" ]] || { echo "cannot resolve CLAUDE_CODE_VERSION pin"; exit 1; }

docker run --rm \
  -e EXPECTED_CLAUDE_VERSION="$EXPECTED_CLAUDE_VERSION" \
  -e EXPECTED_GIT_USER_NAME="$GIT_USER_NAME" \
  -e EXPECTED_GIT_USER_EMAIL="$GIT_USER_EMAIL" \
  -v "$PWD/.build/ssh-config:/tmp/expected-ssh:ro" \
  claude-shipyard-base:test bash -lc '
  set -euo pipefail
  for cmd in bash curl git gh gzip helm jq kubectl make node pnpm python3 rsync ssh sudo tar unzip xz yarn zip claude go; do
    command -v "$cmd" >/dev/null
  done

  [[ "$(id -un)" == "dev" ]]
  [[ "$HOME" == "/home/dev" ]]
  [[ -d /workspace ]]

  # whatever the build was given, and never empty — an empty identity makes
  # every commit inside the container fail with "please tell me who you are"
  [[ -n "$(git config --global user.name)" ]]
  [[ -n "$(git config --global user.email)" ]]
  [[ "$(git config --global user.name)" == "$EXPECTED_GIT_USER_NAME" ]]
  [[ "$(git config --global user.email)" == "$EXPECTED_GIT_USER_EMAIL" ]]
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

  test -f /usr/local/share/claude-shipyard/mcp-config.default.json
  command -v context7-mcp >/dev/null
  jq -e ".mcpServers[\"atlassian-rovo\"].url == \"https://mcp.atlassian.com/v1/mcp\"" /usr/local/share/claude-shipyard/mcp-config.default.json >/dev/null
  jq -e ".mcpServers[\"context7\"].command == \"context7-mcp\"" /usr/local/share/claude-shipyard/mcp-config.default.json >/dev/null
  jq -e ".mcpServers[\"context7\"].args == []" /usr/local/share/claude-shipyard/mcp-config.default.json >/dev/null
  command -v typescript-language-server >/dev/null
  command -v tsc >/dev/null
  [[ "$(typescript-language-server --version)" == "5.2.0" ]]
  [[ "$(tsc --version)" == "Version 6.0.3" ]]

  [[ "$(pnpm --version)" == "10.10.0" ]]
  [[ "$(yarn --version)" == "1.22.22" ]]
  [[ "$(node --version)" == "v24.15.0" ]]
  [[ "$(go version)" == go\ version\ go1.26.3* ]]
  [[ "$(kubectl version --client -o json | python3 -c '"'"'import json, sys; print(json.load(sys.stdin)["clientVersion"]["gitVersion"])'"'"')" == "v1.30.10" ]]
  [[ "$(helm version --short | sed "s/+.*//")" == "v3.17.3" ]]
  command -v claude >/dev/null
  [[ "$(claude --version)" == *"$EXPECTED_CLAUDE_VERSION"* ]]
'

echo "base image smoke passed"
