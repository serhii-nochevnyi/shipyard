# Remote Claude Code Dev Environment

## Quick start

```bash
make dev
```

`make dev` runs the guided launcher (`scripts/dev.sh`): it creates `.env` if
missing, builds the images if needed, starts the container, and then asks in turn
whether to log in to Claude, authenticate MCP servers (e.g. Atlassian Rovo), clone
a repo into `/workspace`, and finally attach a `claude` or `bash` session. Each step
is skipped if already done, so it is safe to re-run.

Individual targets if you prefer to drive it yourself:

| Command | Does |
|---|---|
| `make up` | start the persistent container (`docker compose up -d`) |
| `make claude` | attach a `claude` session in the running container |
| `make shell` | attach a `bash` shell in the running container |
| `make clone REPO=<git-url>` | clone a repo into `/workspace` (set `WORKSPACE_SUBDIR=name` to rename) |
| `make bootstrap-atlassian-oauth` | authenticate the Atlassian Rovo MCP server |
| `make run-docker` | one-off ephemeral session (`docker compose run --rm`) |

## Prerequisites

- Docker with Compose support
- `kubectl`
- Claude Pro or Max subscription (required for Claude Code)
- valid `GITHUB_TOKEN` or `GH_TOKEN` for git/gh access inside the container (optional)
- optional local SSH agent if you need private Git access at runtime

## Local build

1. Copy `.env.example` to `.env`.
2. Generate a `CLAUDE_CODE_OAUTH_TOKEN` on the host by running `claude setup-token`, then set it in `.env`.
3. Build the base image:

```bash
make build-base
```

`make build-base` also stages safe SSH client files from your local `~/.ssh` into the build context. It copies only `config`, `known_hosts`, and `known_hosts2`, and it skips private keys.

4. Build the overlay image:

```bash
make build-dev-image
```

The overlay image installs the following during build:

- **gsd-core** — the Claude Code delivery plugin, installed from npm via
  `npx --yes @opengsd/gsd-core@<version> --claude --global --profile=full`.
  This writes Claude Code plugin configuration under `~/.claude` inside the image.
  gsd-core is NOT installed from the Claude Code marketplace; it is installed via npx.
- **andrej-karpathy-skills** — a Claude Code plugin staged from a pinned Git ref
  (`2c606141936f1eeef17fa3043a72095b4765b9c2`) and registered with `claude plugin`.
- **dev-lsp** — a local Claude Code plugin (from `config/claude-lsp-plugin/`)
  that configures TypeScript LSP support inside Claude Code.

The base image bakes in:

- Claude Code CLI (`@anthropic-ai/claude-code`, pinned version) installed via npm.
- Git identity: `Nochevnyi Serhii <nochevnyi.serhii@airslate.com>`
- Git defaults: `init.defaultBranch=main`, `push.autoSetupRemote=true`, `color.ui=auto`,
  `fetch.prune=true`, `pull.rebase=false`, `pull.ff=only`
- safe SSH client files from your local profile when present
- `context7-mcp` binary (baked in, no runtime `npx -y` needed)
- `typescript-language-server` and `typescript` for LSP support

Private keys are not baked into the image.

## Authentication

Claude Code requires a valid OAuth token. Generate one on your host machine before starting the container:

```bash
claude setup-token
```

Copy the token into `.env` as `CLAUDE_CODE_OAUTH_TOKEN=<token>`. The container reads this variable at startup.

## Run with Docker

```bash
make run-docker
```

The container starts in `/workspace`. If you want a host bind mount there, keep the `WORKSPACE_DIR` volume enabled in `docker-compose.yml`.

The Compose runtime mounts the host user's `~/.ssh` directory read-only at `/home/dev/.ssh`, so SSH Git access can use your existing host keys inside the container.

If `SSH_AUTH_SOCK` is set on the host, Compose forwards that environment variable into the container. The agent socket itself is not bind-mounted by default; if you need agent-based auth instead of key files, add a matching bind mount in a local Compose override or run the image directly:

```bash
docker run --rm -it \
  -e SSH_AUTH_SOCK \
  -v "$SSH_AUTH_SOCK:$SSH_AUTH_SOCK" \
  remote-copilot:test
```

## MCP Servers

The image preconfigures two MCP servers by default:

- **Atlassian Rovo** — via HTTP (`https://mcp.atlassian.com/v1/mcp`)
- **Context7** — via stdio using the baked `context7-mcp` binary from
  `@upstash/context7-mcp`. Context7 does not rely on `npx -y` or runtime npm
  downloads.

At container startup, the entrypoint merges these MCP server configurations
non-destructively into `~/.claude.json` — adding missing entries without
overwriting user customizations.

## Atlassian OAuth

Because macOS stores OAuth tokens in the Keychain (not a portable file), Atlassian
Rovo authentication must run inside the container. The documented flow is:

1. Copy `.env.example` to `.env` and set `CLAUDE_CODE_OAUTH_TOKEN`.
2. Start a persistent container: `make up`
3. Run the bootstrap: `make bootstrap-atlassian-oauth`

`make up` creates `.claude-credentials.json` on the host (if it does not already
exist) before starting the container with `docker compose up -d`, preventing Docker
from silently creating a directory mount in its place.

`make bootstrap-atlassian-oauth` runs `scripts/bootstrap-atlassian-rovo-oauth.sh`
on the host. That script `docker exec -it`s into the running `dev` container and
executes:

```
claude mcp login atlassian-rovo --no-browser
```

A remote MCP server authenticates over an OAuth loopback callback that the host
browser cannot reach inside a container, so a headless `claude -p` flow can never
receive the authorization code. `claude mcp login --no-browser` (Claude Code
>= 2.1.191) instead prints the authorization URL and waits. The flow is:

1. Open the printed URL in your host browser and approve access.
2. The browser tries to redirect to `http://localhost:<port>/callback` and shows a
   connection error — this is expected (the callback server is inside the container).
3. Copy the full redirect URL from the address bar and paste it back at the prompt.

Credentials then land in `/home/dev/.claude/.credentials.json`, which is bind-mounted
from the host file `.claude-credentials.json` — persisting across container restarts.
(If a half-finished attempt blocks a retry, run
`docker compose exec dev claude mcp logout atlassian-rovo` first.)

## Persistence

Only a single file is bind-mounted for persistence between container restarts:

- `.claude-credentials.json` on the host (controlled by `CLAUDE_CREDENTIALS_FILE`
  in `.env`, default `./.claude-credentials.json`) maps to
  `/home/dev/.claude/.credentials.json` inside the container.

This file holds remote-MCP OAuth state (e.g. Atlassian Rovo tokens).

Everything else under `~/.claude` is baked into the image or generated at startup
and is ephemeral — it is not persisted across container recreation.

The host's full `~/.claude` is never mounted.

## LSP Support

TypeScript/JavaScript LSP support is provided by `typescript-language-server`
(shipped in the base image) and wired into Claude Code via the `dev-lsp` plugin
(`config/claude-lsp-plugin/`). This covers `.ts`, `.tsx`, `.js`, and `.jsx` files.

The LSP plugin is registered during the overlay build and loaded when Claude Code
starts an interactive session.

## Plugins

- **gsd-core** (`@opengsd/gsd-core`) — Claude Code delivery plugin with full profile.
- **andrej-karpathy-skills** — staged from pinned commit, registered via `claude plugin`.
- **dev-lsp** — local plugin supplying TypeScript LSP config to Claude Code.

## Deploy to Kubernetes

1. Push the built overlay image to a registry reachable by the cluster and update
   `k8s/statefulset.yaml` if needed.
2. Create the real secret from `k8s/secret.example.yaml`.
3. Apply manifests:

```bash
make deploy-k8s
```

## Smoke tests

```bash
make test-base
make test-overlay
make test-runtime
make test-mcp-runtime
make test-docs
make test-ssh-sync
```
