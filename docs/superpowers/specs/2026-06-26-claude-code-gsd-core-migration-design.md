# Design: Migrate dev-container image from GitHub Copilot CLI to Claude Code + gsd-core

**Date:** 2026-06-26
**Status:** Approved (brainstorming)

## Goal

Convert this repository's dev-container image so that:

- The agent runtime is **Claude Code CLI** instead of GitHub Copilot CLI.
- The "delivery pipeline" plugin (`dev-copilot`, whose commands are `delivery-pipeline`, `delivery-waves`, etc.) is replaced by **[gsd-core](https://github.com/open-gsd/gsd-core)** (`@opengsd/gsd-core`).
- The second plugin (`andrej-karpathy-skills`) is kept, installed for Claude Code.
- TypeScript LSP capability is preserved (the container is interactive).
- The existing two-layer build, Compose runtime, k8s flow, SSH staging, and version pinning conventions are retained.

Non-goals: changing the toolchain unrelated to the agent (Node, Go, kubectl, helm, gh), restructuring k8s, or adding new MCP servers beyond what exists today.

## Key facts established (cited from Claude Code docs)

1. **Install:** `npm install -g @anthropic-ai/claude-code@<version>` — reproducible, matches the existing npm-global pattern (context7-mcp, typescript-language-server). Preferred over SHA-verifying `install.sh` (that script's hash changes on every Anthropic edit).
2. **Auth (OAuth token):** `CLAUDE_CODE_OAUTH_TOKEN` env var fully authenticates a headless `claude -p` run **without** `--bare`. Token generated once on host via `claude setup-token` (prints token — portable, not a file). Requires Claude Pro/Max subscription.
3. **Headless flags:** `claude -p "..."`, `--permission-mode bypassPermissions`, `--mcp-config <file|json>`, `--output-format text`. Do **not** use `--bare` when relying on `CLAUDE_CODE_OAUTH_TOKEN`.
4. **User-scope MCP config:** `~/.claude.json`, top-level `mcpServers`. HTTP shape `{"type":"http","url":...}`; stdio shape `{"type":"stdio","command":...,"args":[]}`. `~/.claude.json` is **not** relocated by `CLAUDE_CONFIG_DIR`.
5. **MCP OAuth storage:** Linux → `~/.claude/.credentials.json` (file, `0600`, portable). macOS → Keychain (**not** file-portable). Host is macOS → host-side file-copy bootstrap is impossible for Claude.
6. **Plugins:** `claude plugin marketplace add <dir>` registers a local marketplace; there is **no** official non-interactive `claude plugin install`. Non-interactive enablement = `enabledPlugins` in `settings.json`. Fallback for skills-only plugins: copy `skills/` into `~/.claude/skills/`.
7. **LSP:** No standalone `lsp-config.json`. LSP exists only as a **plugin component** (`.lsp.json` inside a plugin) and loads only in **interactive** sessions (after workspace trust), never in headless `-p`. This container is interactive, so LSP is worth keeping.
8. **gsd-core:** `npx @opengsd/gsd-core@<version> --claude --global --profile=full` — fully non-interactive, writes to `~/.claude/` (honors `CLAUDE_CONFIG_DIR`).
9. **Config dir:** `CLAUDE_CONFIG_DIR` relocates the whole `~/.claude` dir (settings, credentials) on Linux — but not `~/.claude.json`.

## Architecture

Retain the two-layer image split by change frequency.

### Base image (`Dockerfile.base`)

- **Remove:** Copilot CLI install (`copilot-install.sh` + its SHA256 verification, `COPILOT_VERSION`, `COPILOT_INSTALLER_SHA256` ARGs).
- **Add:** `npm install -g @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}` (new pinned ARG), alongside the existing global installs.
- **Keep:** Node, Go, kubectl, helm, gh, jq, rsync, context7-mcp, **typescript-language-server + typescript** (now consumed by Claude Code via the LSP plugin, not Copilot).
- **Config defaults copied in:** `config/mcp-config.default.json` (reshaped for Claude). The Copilot `config/lsp-config.default.json` is **removed** (replaced by the LSP plugin, see below).
- Git identity / git defaults / SSH staging: unchanged.

### Overlay image (`Dockerfile`)

- **Remove:** all `dev-copilot` machinery — `COPY ${DEV_COPILOT_DIR}`, `install-dev-copilot.sh`, `DEV_COPILOT_SOURCE_REV` plumbing, the `/opt/dev-copilot` + `/usr/local/share/dev-copilot/source-rev` steps.
- **Add gsd-core:** `RUN npx @opengsd/gsd-core@${GSD_CORE_VERSION} --claude --global --profile=full` (new pinned ARG). Runs as user `dev` so it writes to `/home/dev/.claude`.
- **Keep karpathy:** staged from pinned git ref (existing `sync-karpathy-skills.sh`), installed via `claude plugin marketplace add /opt/karpathy-skills` + enablement in `settings.json`. Fallback: copy `skills/` into `~/.claude/skills/` if marketplace-add proves interactive at build (verify during implementation).
- **Add LSP plugin:** `COPY config/claude-lsp-plugin/ /opt/claude-lsp/` then register via marketplace-add + enable. The plugin carries a `.lsp.json` wiring `typescript-language-server` for `.ts/.tsx/.js/.jsx`.

### Local LSP plugin (new: `config/claude-lsp-plugin/`)

Minimal Claude Code plugin baked into the repo:

```
config/claude-lsp-plugin/
  .claude-plugin/plugin.json    # name: "dev-lsp", minimal metadata
  .lsp.json                     # typescript-language-server wiring
```

`.lsp.json`:
```json
{
  "typescript": {
    "command": "typescript-language-server",
    "args": ["--stdio"],
    "extensionToLanguage": {
      ".ts": "typescript", ".tsx": "typescriptreact",
      ".js": "javascript", ".jsx": "javascriptreact"
    }
  }
}
```

### Entrypoint (`scripts/entrypoint.sh`)

- **MCP merge:** keep the non-destructive `jq` merge pattern, but target `~/.claude.json` `mcpServers` (was `~/.copilot/mcp-config.json`). Default servers, added only if absent:
  - `atlassian-rovo`: `{"type":"http","url":"https://mcp.atlassian.com/v1/mcp"}`
  - `context7`: `{"type":"stdio","command":"context7-mcp","args":[]}`
- **Remove** the LSP `jq` merge block (LSP now comes from the plugin).
- Keep the `/workspace` writable check.

### Auth & persistence

- **Anthropic auth:** `CLAUDE_CODE_OAUTH_TOKEN` passed via env (Compose + k8s). Replaces `GITHUB_TOKEN`/`GH_TOKEN` as the agent auth. `GITHUB_TOKEN` retained as optional passthrough for git/gh.
- **MCP OAuth persistence (Atlassian):** persist **only** `~/.claude/.credentials.json` via a narrow single-file bind-mount, mirroring the current "mount only the `mcp-oauth-config` subdir" pattern. A whole-`~/.claude` mount would shadow the baked gsd-core/karpathy/LSP plugin — explicitly avoided.
  - Host file must pre-exist (else Docker creates a directory). `make run-docker` will `touch` it, replacing the current `mkdir -p .copilot-mcp-oauth`.
  - Compose var `MCP_OAUTH_DIR` → `CLAUDE_CREDENTIALS_FILE` (default `./.claude-credentials.json`), bind-mounted to `/home/dev/.claude/.credentials.json`.

### Atlassian OAuth bootstrap (`scripts/bootstrap-atlassian-rovo-oauth.sh`)

The host-side file-copy bootstrap **cannot work** for Claude on a macOS host (Keychain, not a file). The user's intent (Atlassian works, persists, no re-auth per restart) is preserved by **moving the OAuth to an in-container interactive login**, persisted via the `.credentials.json` mount above.

- Rewrite the script to perform/trigger the Atlassian OAuth **inside the running container** (`claude` completes the flow on Linux → writes `.credentials.json`).
- **Open risk (verify by building/running):** whether Claude Code's remote-HTTP-MCP OAuth supports a headless paste-URL flow. **Fallback:** one interactive `claude` login in the running container; credentials then persist via the mount. The design does not promise a fully scripted host-side bootstrap.

## Contracts that must change in lockstep

These are grep/path contracts that will break unless updated together:

- **`README.md`:** rewrite all Copilot references (install, plugins, MCP, LSP, OAuth, mounts) to Claude Code + gsd-core.
- **`tests/smoke/*`:** `docs-smoke.sh` greps the README for Copilot phrases; `runtime-smoke.sh`, `mcp-runtime-smoke.sh`, `overlay-image-smoke.sh`, `base-image-smoke.sh`, `ssh-sync-smoke.sh`, `k8s-manifest-smoke.sh` assert on Copilot binaries/paths/configs. All updated to assert Claude Code equivalents.
- **`.env.example`:** add (currently missing, but referenced by README and required by `docs-smoke.sh`). Vars: `CLAUDE_CODE_OAUTH_TOKEN`, `GSD_CORE_VERSION` (optional override), `CLAUDE_CREDENTIALS_FILE`, `SSH_AUTH_SOCK`, optional `GITHUB_TOKEN`. Remove `DEV_COPILOT_SOURCE`, `DEV_COPILOT_INSTALL_CMD`, `MCP_OAUTH_DIR`.
- **`Makefile`:** remove `sync-plugin`, `DEV_COPILOT_SOURCE`/`DEV_COPILOT_STAGING`/`DEV_COPILOT_INSTALL_CMD`/`DEV_COPILOT_SOURCE_REV`; add `CLAUDE_CODE_VERSION`, `GSD_CORE_VERSION`. `build-dev-image` no longer depends on `sync-plugin` (gsd-core is npm). `sync-karpathy-skills` retained.
- **`docker-compose.yml`:** swap env (`CLAUDE_CODE_OAUTH_TOKEN`), swap the OAuth mount to the single-file `.credentials.json`.
- **`CLAUDE.md`:** update the repo guide written earlier to reflect the new architecture.
- **`k8s/` manifests:** referenced by `make deploy-k8s`/`test-k8s` but absent today; the k8s smoke test currently has nothing to validate. Out of scope to author here unless required to make `test-k8s` pass — flag during planning.

## Removed (Copilot-specific)

- Copilot CLI + installer + SHA ARGs.
- `dev-copilot` plugin and all `DEV_COPILOT_*` staging/sync (`scripts/sync-dev-copilot.sh`, `scripts/install-dev-copilot.sh`).
- `config/lsp-config.default.json` and the entrypoint LSP merge.

## Verify-during-implementation checklist

1. Exact path Claude writes MCP OAuth to inside the Linux container (assumed `~/.claude/.credentials.json`).
2. Whether `claude plugin marketplace add` + `enabledPlugins` is non-interactive at build (fallback: copy skills dirs).
3. Whether remote-MCP OAuth supports a scriptable flow or requires one interactive login.
4. gsd-core `--profile=full` actually writes under `/home/dev/.claude` when run as `dev`.
5. LSP plugin loads in an interactive session and resolves `typescript-language-server`.

These are confirmed by actually building and running the image, not by inspection alone.
