# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repo is

This repo packages a **remote GitHub Copilot CLI dev environment** as a Docker image, runnable locally via Compose or deployable to Kubernetes. It does not contain application code — it is infrastructure that bakes a toolchain, the Copilot CLI, two Copilot plugins, and default MCP/LSP server configs into a reproducible container.

The `workspace/` directory is the mount point users do their actual work in at runtime; it is intentionally empty in the repo.

## Build & run

All workflows go through the `Makefile`. The image is built in two stages — base then overlay — and you almost always need both before running:

```bash
make build-base        # Dockerfile.base: OS, Node, Go, kubectl, helm, copilot CLI, MCP/LSP tooling
make build-dev-image   # Dockerfile: overlay that installs the two Copilot plugins
make run-docker        # docker compose run --rm dev  (drops you into /workspace)
make deploy-k8s        # kubectl apply of k8s/*.yaml (manifests not yet in repo)
```

`make build-base` runs `sync-ssh-config` first (stages only `config`, `known_hosts`, `known_hosts2` from `~/.ssh` — never private keys). `make build-dev-image` runs `sync-plugin` + `sync-karpathy-skills` first to stage plugin sources into `.build/`.

Before first run, copy `.env.example` to `.env`. Key vars: `DEV_COPILOT_SOURCE`, `DEV_COPILOT_INSTALL_CMD` (leave empty to use the default marketplace install), `MCP_OAUTH_DIR`, `SSH_AUTH_SOCK`, `GITHUB_TOKEN`/`GH_TOKEN`.

## Tests

Smoke tests live in `tests/smoke/` and each has a `make` target. They build images and assert on their contents/behavior, so they are slow and require Docker:

```bash
make test-base          # base image contents
make test-overlay       # overlay image / plugin install
make test-runtime       # full compose runtime
make test-mcp-runtime   # MCP server config at runtime
make test-k8s           # k8s manifest validity
make test-docs          # README + .env.example invariants
make test-ssh-sync      # sync-local-ssh-config.sh behavior
```

`tests/smoke/docs-smoke.sh` is effectively a contract on `README.md` and `.env.example`: it greps for required phrases. **If you change documented behavior (MCP servers, LSP coverage, OAuth flow, mount semantics), update the README to match or `make test-docs` will fail.**

## Architecture

**Two-layer image, separated by change frequency.** `Dockerfile.base` (`remote-copilot-base:test`) installs the slow-moving, pinned toolchain — versions are `ARG`s at the top (Node, Go, kubectl, helm, Copilot CLI with SHA256-verified installer, context7-mcp, typescript-language-server). Every downloaded binary is checksum-verified. `Dockerfile` (`remote-copilot:test`) is a thin overlay over the base that only installs the two Copilot plugins; iterate here when changing plugins, not the base.

**Plugins are staged, not fetched at build time.** `scripts/sync-dev-copilot.sh` rsyncs a *local* checkout (`DEV_COPILOT_SOURCE`, default `/Volumes/KINGSTON/PhpstormProjects/dev-copilot`) into `.build/dev-copilot/`, and `scripts/sync-karpathy-skills.sh` clones the `andrej-karpathy-skills` repo at a **pinned commit** (`KARPATHY_SKILLS_REF`) into `.build/karpathy-skills/`. Both validate that `.claude-plugin/{plugin,marketplace}.json` exist before the build proceeds. The Dockerfile then copies these staged dirs in and runs `install-dev-copilot.sh` / `install-karpathy-skills.sh` (which call `copilot plugin marketplace add` + `copilot plugin install`).

**Runtime config is merged non-destructively by the entrypoint.** `scripts/entrypoint.sh` is the container ENTRYPOINT. On every start it `jq`-merges baked defaults (`config/mcp-config.default.json`, `config/lsp-config.default.json` → copied to `/usr/local/share/remote-copilot/`) into the user's `~/.copilot/{mcp-config,lsp-config}.json` using `(.existing // default)` semantics — so it adds the default `atlassian-rovo` + `context7` MCP servers and `typescript` LSP server **only if absent**, never clobbering user customizations. When editing defaults, change both `config/*.default.json` and the inline `jq` filter in `entrypoint.sh`; they must agree.

**Atlassian OAuth is bootstrapped host-side, persisted selectively.** Browser-based OAuth can't happen inside the headless container, so `scripts/bootstrap-atlassian-rovo-oauth.sh` runs the host's `copilot` CLI to authenticate, then copies *only* the Atlassian Rovo OAuth state (matched by `serverUrl`) into `./.copilot-mcp-oauth/`. That dir is the only piece of Copilot state Compose bind-mounts persistently (`docker-compose.yml`); the rest of `~/.copilot` is ephemeral and the host's full `~/.copilot` is never mounted. The script refuses to run inside the container (`/.dockerenv` / `HOME=/home/dev` guard).

**Runtime user is `dev` (uid 1000), home `/home/dev`, workdir `/workspace`.** Git identity and defaults are baked into `/home/dev/.gitconfig` at base-build time via `ARG`s.

## Conventions

- All shell scripts use `set -euo pipefail` and validate inputs/preconditions early with explicit error messages — match this when adding scripts.
- Tool versions are pinned as Dockerfile `ARG`s and surfaced as overridable Makefile variables; never hardcode an unpinned `latest`.
