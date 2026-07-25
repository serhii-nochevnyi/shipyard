#!/usr/bin/env bash
set -euo pipefail

[[ -f docker-compose.yml ]] || { echo "missing docker-compose.yml"; exit 1; }
[[ -f Makefile ]] || { echo "missing Makefile"; exit 1; }

STATE_DIR="$(pwd)/.claude-state"
mkdir -p workspace .cache-home "$STATE_DIR" "$HOME/.config/gh"
trap 'docker compose down >/dev/null 2>&1 || true' EXIT

[[ -x scripts/bootstrap-atlassian-rovo-oauth.sh ]] || { echo "missing scripts/bootstrap-atlassian-rovo-oauth.sh"; exit 1; }
make -n bootstrap-atlassian-oauth >/dev/null

# Bootstrap must refuse to run inside the container.
if HOME=/home/dev ./scripts/bootstrap-atlassian-rovo-oauth.sh >/dev/null 2>&1; then
  echo "expected bootstrap to refuse when HOME=/home/dev"
  exit 1
fi

make build-base sync-karpathy-skills build-dev-image >/dev/null

COMPOSE_ENV=(
  DEV_IMAGE=claude-shipyard:test
  BASE_IMAGE=claude-shipyard-base:test
  WORKSPACE_DIR="$(pwd)/workspace"
  HOME_CACHE_DIR="$(pwd)/.cache-home"
  CLAUDE_STATE_DIR="$STATE_DIR"
)

# ── credential persistence: seed the store, assert the entrypoint restores it ──
# The store is a DIRECTORY, not a single-file bind: a mount point cannot be
# replaced by rename(2), so an atomic writer would fail on the old layout. This
# asserts the round trip that layout exists for.
printf '{"seeded":true}' > "$STATE_DIR/credentials.json"

env "${COMPOSE_ENV[@]}" docker compose run --rm dev bash -lc '
  set -euo pipefail
  id -un | grep -qx dev
  test -d /workspace
  test -d "$HOME/.cache"
  test -f "$HOME/.claude.json"
  command -v claude >/dev/null
  command -v shipyard-trust >/dev/null
  # all six plugins appear in installed_plugins.json — the in-repo shipyard
  # plugin included: it is the product, so it must be verified at RUNTIME too.
  for p in andrej-karpathy-skills@karpathy-skills shipyard@delivery-pipeline skill-creator@claude-plugins-official code-simplifier@claude-plugins-official github@claude-plugins-official typescript-lsp@claude-plugins-official; do
    jq -e --arg p "$p" ".plugins[\$p]" "$HOME/.claude/plugins/installed_plugins.json" >/dev/null
  done

  # the seeded credentials were restored into the ephemeral ~/.claude
  jq -e ".seeded == true" "$HOME/.claude/.credentials.json" >/dev/null
  # ...and the live file must be writable by dev (uid 1000)
  printf "{\"written\":true}" > "$HOME/.claude/.credentials.json"
  # give the entrypoint mirror one cycle to copy it back to the store
  sleep 7
  jq -e ".written == true" "$HOME/.claude-state/credentials.json" >/dev/null

  # ~/.ssh must be WRITABLE (ssh has to be able to record a new host key) and
  # must NOT contain private keys by default.
  test -w "$HOME/.ssh"
  for forbidden in id_rsa id_dsa id_ecdsa id_ed25519 authorized_keys; do
    test ! -e "$HOME/.ssh/$forbidden"
  done

  # the auto-route hook is baked in, so the container needs no manual install
  test -x "$HOME/.claude/hooks/shipyard-auto-route.sh"
  jq -e "[.hooks.UserPromptSubmit[]?.hooks[]?.command] | any(contains(\"shipyard-auto-route.sh\"))" \
    "$HOME/.claude/settings.json" >/dev/null

  # the delivery scripts are runnable and self-contained
  node -e "require(\"/opt/delivery-pipeline/scripts/frontmatter.cjs\")"
  test "$(node /opt/delivery-pipeline/scripts/pipeline-config.cjs model arch-review)" = opus
'

# the mirror must have persisted the write on the HOST side too
jq -e '.written == true' "$STATE_DIR/credentials.json" >/dev/null \
  || { echo "credentials written in the container did not reach the host state dir"; exit 1; }

docker compose down >/dev/null 2>&1 || true
env "${COMPOSE_ENV[@]}" docker compose up -d >/dev/null

cid="$(docker compose ps -q dev)"
test -n "$cid"
mounts="$(docker inspect "$cid" --format '{{json .Mounts}}')"

# SSH client files arrive read-only at a NON-shadowing path; the entrypoint copies
# them into a writable ~/.ssh.
jq -e 'map(select(.Destination == "/home/dev/.ssh-host" and .RW == false)) | length == 1' <<<"$mounts" >/dev/null
jq -e 'map(select(.Destination == "/home/dev/.ssh")) | length == 0' <<<"$mounts" >/dev/null
jq -e 'map(select(.Destination == "/home/dev/.config/gh" and .RW == false)) | length == 1' <<<"$mounts" >/dev/null
# durable state is a writable DIRECTORY, and ~/.claude itself is never mounted
jq -e 'map(select(.Destination == "/home/dev/.claude-state" and .RW == true)) | length == 1' <<<"$mounts" >/dev/null
jq -e 'map(select(.Destination == "/home/dev/.claude")) | length == 0' <<<"$mounts" >/dev/null
jq -e 'map(select(.Destination == "/home/dev/.claude/.credentials.json")) | length == 0' <<<"$mounts" >/dev/null
# the repo checkout (holding .env with the OAuth token) must NOT be mounted
repo_path="$(pwd)"
jq -e --arg p "$repo_path" 'map(select(.Destination == $p)) | length == 0' <<<"$mounts" >/dev/null \
  || { echo "the repo root is mounted into the container — .env would be exposed"; exit 1; }

# Narrow checks: assert the removed artifacts are gone without grepping broad substrings.
for pat in 'COPILOT_' 'DEV_COPILOT' '\.copilot' 'mcp-oauth-config'; do
  if grep -qE "$pat" docker-compose.yml; then
    echo "docker-compose.yml should not mention $pat"
    exit 1
  fi
done
# and that the removed PWD passthrough has not crept back in
if grep -qE '^\s*-\s*\$\{PWD\}' docker-compose.yml; then
  echo "docker-compose.yml must not mount \${PWD} (exposes .env to a bypassPermissions session)"
  exit 1
fi

echo "runtime smoke passed"
