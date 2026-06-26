# Remote Copilot Dev Environment

## Prerequisites

- Docker with Compose support
- `kubectl`
- access to `/Volumes/KINGSTON/PhpstormProjects/dev-copilot`
- valid `GITHUB_TOKEN` or `GH_TOKEN` for Copilot CLI authentication
- optional local SSH agent if you need private Git access at runtime
- host `copilot` CLI and `jq` if you want to bootstrap Atlassian Rovo OAuth outside the container

## Local build

1. Copy `.env.example` to `.env`.
2. If you need a custom install flow from `dev-copilot`, set `DEV_COPILOT_INSTALL_CMD` in `.env`. Leave it empty to use the default Copilot marketplace install baked into `scripts/install-dev-copilot.sh`.
3. Build the base image:

```bash
make build-base
```

`make build-base` also stages safe SSH client files from your local `~/.ssh` into the build context. It copies only `config`, `known_hosts`, and `known_hosts2`, and it skips private keys.

4. Build the overlay image:

```bash
make build-dev-image
```

The overlay image installs two Copilot plugins during build:

- the local `dev-copilot` plugin
- the baked `andrej-karpathy-skills` plugin staged from the pinned Git ref `2c606141936f1eeef17fa3043a72095b4765b9c2`

The base image bakes in:

- Git identity: `Nochevnyi Serhii <nochevnyi.serhii@airslate.com>`
- Git defaults: `init.defaultBranch=main`, `push.autoSetupRemote=true`, `color.ui=auto`, `fetch.prune=true`, `pull.rebase=false`, `pull.ff=only`
- safe SSH client files from your local profile when present

Private keys are not baked into the image.

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

## Default MCP Servers

The image preconfigures two remote MCP servers by default:

- Atlassian Rovo via `https://mcp.atlassian.com/v1/mcp`
- Context7 via the baked `context7-mcp` binary from `@upstash/context7-mcp@2.2.5`

The image installs `context7-mcp` during build, so Context7 does not rely on `npx -y` or runtime npm downloads.

The Docker runtime does not mount the host user's `~/.copilot`. Instead, the container creates container-local Copilot state under `/home/dev/.copilot`.

Compose persists only Atlassian OAuth state by bind-mounting `${MCP_OAUTH_DIR:-./.copilot-mcp-oauth}` to `/home/dev/.copilot/mcp-oauth-config`. This lets you persist only Atlassian OAuth state across container restarts without mounting the full Copilot profile.

If you need Atlassian access, complete the first Atlassian Rovo host-side interactive OAuth login before starting the container:

```bash
make bootstrap-atlassian-oauth
```

This host-side bootstrap uses the local `copilot` CLI to complete browser-based Atlassian authentication and then syncs only the Atlassian MCP OAuth cache into `./.copilot-mcp-oauth`.

After that, start or recreate the container normally:

```bash
docker compose up -d
```

The broader Copilot state remains ephemeral, but the project-local `./.copilot-mcp-oauth` cache persists only Atlassian OAuth state across container recreation.

## Default LSP Servers

The base image also bakes in TypeScript/JavaScript LSP support through:

- `typescript-language-server@5.2.0`
- `typescript@6.0.3`

At container startup, the entrypoint creates `/home/dev/.copilot/lsp-config.json` when it is missing and ensures a default `typescript` server exists for `.ts`, `.tsx`, `.js`, and `.jsx`.

If you already customized `/home/dev/.copilot/lsp-config.json` inside the container, the entrypoint preserves unrelated LSP servers and does not overwrite an existing `typescript` entry.

## Deploy to Kubernetes

1. Push the built overlay image to a registry reachable by the cluster and update `k8s/statefulset.yaml` if needed.
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
make test-k8s
make test-docs
```
