#!/usr/bin/env bash
set -euo pipefail

# Guided launcher for the Claude Code dev container.
# Run on the HOST from the repo root:  ./scripts/dev.sh   (or: make dev)
#
# It walks through everything in order, asking at each step:
#   .env -> images -> start container -> Claude login -> MCP auth -> clone repo -> attach.
# Each step is skipped automatically if it is already done, so it is safe to re-run.

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

SERVICE="${DEV_SERVICE:-dev}"
DEV_IMAGE="${DEV_IMAGE:-claude-shipyard:test}"
# Durable state lives in a DIRECTORY (see docker-compose.yml); the credentials
# file inside it is written by the container and mirrored by the entrypoint.
CLAUDE_STATE_DIR="${CLAUDE_STATE_DIR:-$REPO_ROOT/.claude-state}"
CRED_FILE="$CLAUDE_STATE_DIR/credentials.json"

die() { echo "error: $*" >&2; exit 1; }

ask() { # ask "question" -> exit 0 on yes
  local q="$1" a
  read -rp "$q [y/N] " a || return 1
  [[ "$a" =~ ^[Yy]$ ]]
}

dexec() { docker compose exec "$SERVICE" "$@"; }  # interactive (TTY auto when on a terminal)

[[ -f /.dockerenv || "${HOME:-}" == "/home/dev" ]] && die "run this on the host, not inside the container"
command -v docker >/dev/null 2>&1 || die "docker not found on host PATH"
docker info >/dev/null 2>&1 || die "docker daemon is not running"

echo "=== Claude Code dev container launcher ==="

# 1. .env
if [[ ! -f .env ]]; then
  if ask "No .env found — create it from .env.example?"; then
    cp .env.example .env
    echo "  created .env (token left blank; you can log in interactively below)"
  fi
fi

# 2. images
if ! docker image inspect "$DEV_IMAGE" >/dev/null 2>&1; then
  echo "Image '$DEV_IMAGE' is not built yet."
  if ask "Build images now (make build-base build-dev-image)? This is slow."; then
    make build-base build-dev-image
  else
    die "cannot start without the image"
  fi
fi

# 3. start container
echo "Starting the dev container (make up)..."
make up >/dev/null
cid="$(docker compose ps -q "$SERVICE" || true)"
[[ -n "$cid" ]] || die "container did not start"
echo "  container running: ${cid:0:12}"

# 4. Claude (Anthropic) auth
claude_authed() {
  grep -Eq '^CLAUDE_CODE_OAUTH_TOKEN=.+' .env 2>/dev/null && return 0
  jq -e '(.claudeAiOauth.accessToken // "") | length > 0' "$CRED_FILE" >/dev/null 2>&1
}
if claude_authed; then
  echo "Claude auth: present ✓"
elif ask "Claude is not authenticated — log in now (opens claude; type /login, then /exit)?"; then
  dexec claude --dangerously-skip-permissions || true
fi

# 5. MCP servers (remote ones use --no-browser: open the printed URL on the host,
#    then paste the full redirect URL back at the prompt).
if ask "Authenticate the Atlassian Rovo MCP server now?"; then
  dexec claude mcp login atlassian-rovo --no-browser \
    || echo "  (skipped/failed — retry later: make bootstrap-atlassian-oauth)"
fi
read -rp "Authenticate another MCP server? Enter its name (blank to skip): " mcpname || mcpname=""
if [[ -n "${mcpname:-}" ]]; then
  dexec claude mcp login "$mcpname" --no-browser || true
fi

# 6. choose the project to work in: clone a new repo, or pick an existing one in /workspace.
PROJECT_DIR="/workspace"
existing="$(docker compose exec -T "$SERVICE" bash -lc 'cd /workspace 2>/dev/null && ls -d */ 2>/dev/null | sed "s#/\$##"' 2>/dev/null | tr -d "\r" || true)"

echo
echo "Project to work in:"
declare -a projects=()
if [[ -n "$existing" ]]; then
  n=0
  while IFS= read -r d; do
    [[ -z "$d" ]] && continue
    n=$((n + 1)); projects[n]="$d"
    echo "  $n) $d   (existing in /workspace)"
  done <<< "$existing"
fi
echo "  c) clone a new repo"
echo "  s) skip — work in /workspace"
read -rp "Choose: " sel || sel="s"
case "${sel:-s}" in
  c|C)
    read -rp "  Git URL: " repo || repo=""
    if [[ -n "${repo:-}" ]]; then
      name="$(basename "$repo")"; name="${name%.git}"
      if docker compose exec -T "$SERVICE" bash -lc "cd /workspace && git clone '$repo'"; then
        PROJECT_DIR="/workspace/$name"
        echo "  cloned -> $PROJECT_DIR"
      else
        echo "  (clone failed — check the URL / SSH access); staying in /workspace"
      fi
    fi
    ;;
  ''|s|S) PROJECT_DIR="/workspace" ;;
  *)
    if [[ -n "${projects[$sel]:-}" ]]; then
      PROJECT_DIR="/workspace/${projects[$sel]}"
    else
      echo "  invalid choice; staying in /workspace"
    fi
    ;;
esac
echo "  working dir: $PROJECT_DIR"

# 7. attach — starts inside the chosen project directory
echo
echo "What next?  1) claude   2) shell   3) leave running"
read -rp "Choose [1/2/3]: " choice || choice="3"
case "${choice:-3}" in
  1) dexec bash -lc "cd '$PROJECT_DIR' && shipyard-trust '$PROJECT_DIR' >/dev/null 2>&1; exec claude --dangerously-skip-permissions" ;;
  2) dexec bash -lc "cd '$PROJECT_DIR' && shipyard-trust '$PROJECT_DIR' >/dev/null 2>&1; exec bash" ;;
  *) echo "Container left running (work dir: $PROJECT_DIR). Attach later with: make claude | make shell" ;;
esac
