# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repo is

This repo packages a **remote Claude Code dev environment** as a Docker image, runnable locally via Compose or deployable to Kubernetes. It does not contain application code — it is infrastructure that bakes a toolchain, the Claude Code CLI, two Claude Code plugins (gsd-core and andrej-karpathy-skills), and default MCP server configs into a reproducible container.

The `workspace/` directory is the mount point users do their actual work in at runtime; it is intentionally empty in the repo.

## Build & run

All workflows go through the `Makefile`. The image is built in two stages — base then overlay — and you almost always need both before running:

```bash
make build-base        # Dockerfile.base: OS, Node, Go, kubectl, helm, Claude Code CLI, context7-mcp, typescript-language-server
make build-dev-image   # Dockerfile: overlay that installs gsd-core + registers karpathy + official plugins (skill-creator, code-simplifier, github, typescript-lsp)
make run-docker        # docker compose run --rm dev  (drops you into /workspace)
make deploy-k8s        # kubectl apply of k8s/*.yaml (manifests not yet in repo)
```

`make build-base` runs `sync-ssh-config` first (stages only `config`, `known_hosts`, `known_hosts2` from `~/.ssh` — never private keys). `make build-dev-image` runs `sync-karpathy-skills` first to stage the andrej-karpathy-skills plugin source into `.build/`.

Before first run, copy `.env.example` to `.env`. Key vars: `CLAUDE_CODE_OAUTH_TOKEN` (from `claude setup-token` on the host), `CLAUDE_CREDENTIALS_FILE` (default `./.claude-credentials.json`, holds remote-MCP OAuth), `SSH_AUTH_SOCK`, `GITHUB_TOKEN`/`GH_TOKEN`, `GSD_CORE_VERSION` (optional pin override).

## Tests

Smoke tests live in `tests/smoke/` and each has a `make` target. They build images and assert on their contents/behavior, so they are slow and require Docker:

```bash
make test-base          # base image contents
make test-overlay       # overlay image / plugin install
make test-runtime       # full compose runtime
make test-mcp-runtime   # MCP server config at runtime
make test-docs          # README + .env.example invariants
make test-ssh-sync      # sync-local-ssh-config.sh behavior
```

`tests/smoke/docs-smoke.sh` is effectively a contract on `README.md` and `.env.example`: it greps for required phrases. **If you change documented behavior (MCP servers, LSP coverage, OAuth flow, mount semantics), update the README to match or `make test-docs` will fail.**

## Architecture

**Two-layer image, separated by change frequency.** `Dockerfile.base` (`remote-copilot-base:test`) installs the slow-moving, pinned toolchain — versions are `ARG`s at the top (Node, Go, kubectl, helm, Claude Code CLI via npm `@anthropic-ai/claude-code`, context7-mcp binary, typescript-language-server). Every downloaded binary is checksum-verified. `Dockerfile` (`remote-copilot:test`) is a thin overlay over the base that installs gsd-core and registers the remaining plugins; iterate here when changing plugins, not the base.

**Base image installs Claude Code via npm.** The base image runs `npm install -g @anthropic-ai/claude-code@<version>` with a pinned version controlled by the `CLAUDE_CODE_VERSION` build arg.

**Overlay image installs gsd-core and registers plugins.** The overlay runs `npx --yes @opengsd/gsd-core@<version> --claude --global --profile=full` during build, which writes Claude Code plugin configuration under `~/.claude`. The andrej-karpathy-skills plugin is staged via `scripts/sync-karpathy-skills.sh` (clones at a pinned commit `KARPATHY_SKILLS_REF`) into `.build/karpathy-skills/` and registered with `claude plugin`. Four additional plugins are installed from the official `claude-plugins-official` marketplace (`anthropics/claude-plugins-official`): `skill-creator`, `code-simplifier`, `github` (GitHub MCP server), and `typescript-lsp` (TypeScript/JS LSP via `typescript-language-server`). Plugin versions from the official marketplace are pinned by the marketplace's GitHub ref at clone time. The `host ~/.config/gh` directory is mounted read-only into the container at `/home/dev/.config/gh` so the GitHub CLI (`gh`) can use host authentication.

**Runtime config is merged non-destructively by the entrypoint.** `scripts/entrypoint.sh` is the container ENTRYPOINT. On every start it `jq`-merges baked MCP defaults into `~/.claude.json` using `(.existing // default)` semantics — adding the `atlassian-rovo` (HTTP) and `context7` (stdio, baked binary) MCP servers only if absent, never clobbering user customizations.

**Auth via CLAUDE_CODE_OAUTH_TOKEN.** The `CLAUDE_CODE_OAUTH_TOKEN` environment variable is the Claude Code subscription OAuth token, generated on the host via `claude setup-token` and passed into the container via `.env`. No host `~/.claude` directory is mounted.

**Persistence via single-file credentials mount.** Only `/home/dev/.claude/.credentials.json` is bind-mounted (from the host path in `CLAUDE_CREDENTIALS_FILE`, default `./.claude-credentials.json`). This file holds remote-MCP OAuth state (e.g. Atlassian Rovo tokens). Everything else under `~/.claude` is baked into the image or generated at startup and is ephemeral.

**Atlassian OAuth is bootstrapped in-container.** Because macOS stores OAuth tokens in the system Keychain (not a portable file), the browser-based Atlassian Rovo login must run inside the container via `make bootstrap-atlassian-oauth`. The host's full `~/.claude` is never mounted; the OAuth result is captured into the bind-mounted `.claude-credentials.json`.

**Runtime user is `dev` (uid 1000), home `/home/dev`, workdir `/workspace`.** Git identity and defaults are baked into `/home/dev/.gitconfig` at base-build time via `ARG`s.

## Conventions

- All shell scripts use `set -euo pipefail` and validate inputs/preconditions early with explicit error messages — match this when adding scripts.
- Tool versions are pinned as Dockerfile `ARG`s and surfaced as overridable Makefile variables; never hardcode an unpinned `latest`.
