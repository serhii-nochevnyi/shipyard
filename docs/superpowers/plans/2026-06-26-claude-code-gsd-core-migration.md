# Claude Code + gsd-core Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Convert this dev-container image from GitHub Copilot CLI (+ `dev-copilot` plugin) to Claude Code CLI (+ `gsd-core`), keeping the `andrej-karpathy-skills` plugin and TypeScript LSP.

**Architecture:** Two-layer Docker build is retained. Base image swaps the Copilot CLI install for `@anthropic-ai/claude-code` (npm, pinned). Overlay swaps the local-clone `dev-copilot` plugin for `gsd-core` (npm/npx, non-interactive), keeps karpathy via `claude plugin`, and adds a tiny baked Claude Code plugin that carries TypeScript LSP wiring (Claude Code has no standalone `lsp-config.json`). Runtime auth moves to `CLAUDE_CODE_OAUTH_TOKEN`; Atlassian MCP OAuth persists via a single-file bind-mount of `~/.claude/.credentials.json`.

**Tech Stack:** Docker, Bash, Make, jq, Node 24/npm, Claude Code CLI, `@opengsd/gsd-core`.

## Global Constraints

- Runtime user inside the image is `dev`, `HOME=/home/dev`, workdir `/workspace`. All `~/.claude*` paths mean `/home/dev/.claude*`.
- Every downloaded/installed tool version is pinned as a Dockerfile `ARG` and surfaced as an overridable Makefile variable. No unpinned `latest` in committed defaults.
- All shell scripts begin with `set -euo pipefail` and validate preconditions early with explicit error messages.
- MCP/LSP config merges into user config must be non-destructive: only add a default key if absent (`(.existing // default)`).
- Image/tag names stay `remote-copilot-base:test` and `remote-copilot:test` (renaming images is out of scope; do not change them).
- Claude Code MCP user config lives in `~/.claude.json` under top-level `mcpServers`. MCP HTTP shape: `{"type":"http","url":...}`. MCP stdio shape: `{"type":"stdio","command":...,"args":[...]}`.
- Do NOT use `claude --bare` anywhere auth is needed — `--bare` skips the `CLAUDE_CODE_OAUTH_TOKEN` read.

## File map

**Create:**
- `config/claude-lsp-plugin/.claude-plugin/plugin.json` — minimal Claude Code plugin metadata (name `dev-lsp`).
- `config/claude-lsp-plugin/.claude-plugin/marketplace.json` — marketplace listing the `dev-lsp` plugin.
- `config/claude-lsp-plugin/.lsp.json` — TypeScript language-server wiring.
- `scripts/install-claude-plugins.sh` — registers marketplaces + enables `andrej-karpathy-skills` and `dev-lsp` non-interactively.
- `.env.example` — env template (currently missing; required by `docs-smoke.sh`).

**Modify:**
- `Dockerfile.base` — Copilot CLI → Claude Code; drop Copilot LSP default copy.
- `Dockerfile` — drop `dev-copilot`; add `gsd-core`, LSP plugin, karpathy-via-claude.
- `scripts/entrypoint.sh` — MCP merge target `~/.claude.json`; remove LSP merge.
- `config/mcp-config.default.json` — reshape `context7` to `type: stdio`.
- `Makefile` — remove `DEV_COPILOT_*`/`sync-plugin`; add `CLAUDE_CODE_VERSION`, `GSD_CORE_VERSION`; fix `run-docker`/`build-dev-image`.
- `docker-compose.yml` — env `CLAUDE_CODE_OAUTH_TOKEN`; single-file credentials mount; drop `DEV_COPILOT_*`.
- `scripts/bootstrap-atlassian-rovo-oauth.sh` — host-side copy → in-container login.
- `tests/smoke/base-image-smoke.sh`, `overlay-image-smoke.sh`, `mcp-runtime-smoke.sh`, `runtime-smoke.sh`, `docs-smoke.sh` — assert Claude Code equivalents.
- `README.md`, `CLAUDE.md` — rewrite Copilot references.

**Delete:**
- `scripts/sync-dev-copilot.sh`
- `scripts/install-dev-copilot.sh`
- `config/lsp-config.default.json`

**Untouched (runtime-agnostic / pre-existing):**
- `tests/smoke/ssh-sync-smoke.sh`, `tests/smoke/k8s-manifest-smoke.sh` (no Copilot references; `k8s/` manifests are absent today, so `test-k8s` is already red — out of scope).
- `scripts/sync-local-ssh-config.sh`, `scripts/sync-karpathy-skills.sh`.

---

### Task 0: Establish git baseline

**Files:** none changed (commits current state).

- [ ] **Step 1: Inspect state**

Run: `cd /Volumes/KINGSTON/gsd && git status && git log --oneline -1`
Expected: many untracked files; `git log` errors / empty (no commits yet).

- [ ] **Step 2: Commit current Copilot-based state as the baseline**

```bash
cd /Volumes/KINGSTON/gsd
git add -A
git commit -m "chore: baseline Copilot-based dev-container image

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

Expected: a first commit is created. This makes the migration a reviewable diff.

---

### Task 1: Local config artifacts (LSP plugin, MCP default reshape, drop Copilot LSP)

**Files:**
- Create: `config/claude-lsp-plugin/.claude-plugin/plugin.json`
- Create: `config/claude-lsp-plugin/.claude-plugin/marketplace.json`
- Create: `config/claude-lsp-plugin/.lsp.json`
- Modify: `config/mcp-config.default.json`
- Delete: `config/lsp-config.default.json`

**Interfaces:**
- Produces: a plugin dir at `config/claude-lsp-plugin/` whose marketplace name is `dev-lsp-marketplace` and plugin name is `dev-lsp`. Consumed by `Dockerfile` (Task 4) and `scripts/install-claude-plugins.sh` (Task 4).
- Produces: `config/mcp-config.default.json` with `atlassian-rovo` (http) and `context7` (stdio). Consumed by `Dockerfile.base` (Task 2) and `entrypoint.sh` (Task 3).

- [ ] **Step 1: Create the LSP plugin manifest**

Create `config/claude-lsp-plugin/.claude-plugin/plugin.json`:
```json
{
  "name": "dev-lsp",
  "description": "TypeScript/JavaScript LSP wiring for Claude Code dev container",
  "version": "1.0.0",
  "author": { "name": "airslate" },
  "license": "MIT"
}
```

- [ ] **Step 2: Create the LSP plugin marketplace manifest**

Create `config/claude-lsp-plugin/.claude-plugin/marketplace.json`:
```json
{
  "name": "dev-lsp-marketplace",
  "owner": { "name": "airslate" },
  "plugins": [
    {
      "name": "dev-lsp",
      "source": "./",
      "description": "TypeScript/JavaScript LSP wiring for Claude Code dev container",
      "version": "1.0.0",
      "author": { "name": "airslate" }
    }
  ]
}
```

- [ ] **Step 3: Create the `.lsp.json` wiring**

Create `config/claude-lsp-plugin/.lsp.json`:
```json
{
  "typescript": {
    "command": "typescript-language-server",
    "args": ["--stdio"],
    "extensionToLanguage": {
      ".ts": "typescript",
      ".tsx": "typescriptreact",
      ".js": "javascript",
      ".jsx": "javascriptreact"
    }
  }
}
```

- [ ] **Step 4: Reshape the MCP default config**

Overwrite `config/mcp-config.default.json`:
```json
{
  "mcpServers": {
    "atlassian-rovo": {
      "type": "http",
      "url": "https://mcp.atlassian.com/v1/mcp"
    },
    "context7": {
      "type": "stdio",
      "command": "context7-mcp",
      "args": []
    }
  }
}
```

- [ ] **Step 5: Delete the Copilot LSP default**

```bash
cd /Volumes/KINGSTON/gsd
git rm config/lsp-config.default.json
```

- [ ] **Step 6: Validate all JSON**

Run:
```bash
cd /Volumes/KINGSTON/gsd
for f in config/claude-lsp-plugin/.claude-plugin/plugin.json \
         config/claude-lsp-plugin/.claude-plugin/marketplace.json \
         config/claude-lsp-plugin/.lsp.json \
         config/mcp-config.default.json; do jq empty "$f"; done
jq -e '.mcpServers["context7"].type == "stdio"' config/mcp-config.default.json
jq -e '.mcpServers["atlassian-rovo"].type == "http"' config/mcp-config.default.json
echo OK
```
Expected: `OK` (no jq errors).

- [ ] **Step 7: Commit**

```bash
cd /Volumes/KINGSTON/gsd
git add -A
git commit -m "feat: add Claude Code LSP plugin and reshape MCP defaults

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Base image — Claude Code instead of Copilot

**Files:**
- Modify: `Dockerfile.base`
- Modify: `Makefile` (`build-base` target only)
- Modify: `tests/smoke/base-image-smoke.sh`

**Interfaces:**
- Consumes: `config/mcp-config.default.json` (Task 1).
- Produces: image `remote-copilot-base:test` with `claude` on PATH, `typescript-language-server`/`tsc` retained, `mcp-config.default.json` baked at `/usr/local/share/remote-copilot/`. No `copilot` binary, no `lsp-config.default.json`. Consumed by `Dockerfile` (Task 4).

- [ ] **Step 1: Discover and record pinned Claude Code version**

Run: `npm view @anthropic-ai/claude-code version`
Use the printed value as `CLAUDE_CODE_VERSION` below (replace `<CLAUDE_CODE_VERSION>` everywhere in this task with that exact version).

- [ ] **Step 2: Update `tests/smoke/base-image-smoke.sh` (the test) first**

In `tests/smoke/base-image-smoke.sh`:
- In the `for cmd in ...` list (line 15), replace `copilot` with `claude`.
- Delete the `lsp-config.default.json` assertions (lines 51, 56–63) — keep the `typescript-language-server`/`tsc` command + version checks (lines 52–55).
- Replace the final Copilot version assertion (line 71) `[[ "$(copilot --version)" == *"1.0.44"* ]]` with:
```bash
  command -v claude >/dev/null
  [[ "$(claude --version)" == *"<CLAUDE_CODE_VERSION>"* ]]
```

- [ ] **Step 3: Edit `Dockerfile.base`**

- Remove the Copilot ARGs: `COPILOT_VERSION` and `COPILOT_INSTALLER_SHA256`.
- Add a new ARG near the other version ARGs:
```dockerfile
ARG CLAUDE_CODE_VERSION=<CLAUDE_CODE_VERSION>
```
- Remove the Copilot install block from the big `RUN`: the lines fetching `copilot-install.sh`, verifying its SHA, `bash -n`, `PREFIX=/usr/local VERSION=... bash .../copilot-install.sh`, and the `copilot-install.sh` entry in the final `rm -f`.
- In the `npm install -g` group, add `"@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}"` to the installed packages (keep `context7-mcp`, `typescript-language-server`, `typescript`).
- Remove the line `COPY config/lsp-config.default.json /usr/local/share/remote-copilot/lsp-config.default.json`. Keep the `mcp-config.default.json` COPY.

- [ ] **Step 4: Edit `Makefile` `build-base`**

In `build-base`, remove any Copilot build-args if present and add `--build-arg CLAUDE_CODE_VERSION='$(CLAUDE_CODE_VERSION)'`. Add near the top variables:
```make
CLAUDE_CODE_VERSION ?= <CLAUDE_CODE_VERSION>
```

- [ ] **Step 5: Build and run the base smoke test**

Run: `cd /Volumes/KINGSTON/gsd && make test-base`
Expected: `base image smoke passed`. (SLOW: full base build — downloads Node/Go/kubectl/helm; budget 10–20 min.)

- [ ] **Step 6: Commit**

```bash
cd /Volumes/KINGSTON/gsd
git add -A
git commit -m "feat: install Claude Code CLI in base image, drop Copilot CLI

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Entrypoint — MCP merge into `~/.claude.json`, drop LSP merge

**Files:**
- Modify: `scripts/entrypoint.sh`
- Modify: `tests/smoke/mcp-runtime-smoke.sh`

**Interfaces:**
- Consumes: baked `/usr/local/share/remote-copilot/mcp-config.default.json` (Task 2).
- Produces: at container start, `~/.claude.json` gains `mcpServers.atlassian-rovo` (http) and `mcpServers.context7` (stdio) only if absent; existing servers preserved; invalid JSON aborts startup.

- [ ] **Step 1: Edit `scripts/entrypoint.sh`**

- Change `mkdir -p "$HOME/.copilot"` to `mkdir -p "$HOME/.claude"`.
- Replace the `user_mcp_config` path: `user_mcp_config="$HOME/.claude.json"` (was `$HOME/.copilot/mcp-config.json`).
- In `merge_default_json` for MCP, change the jq filter to the Claude shapes (drop `tools`, add `type` to context7):
```bash
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
  })
'
```
- Remove the entire LSP block: the `default_lsp_config`/`user_lsp_config` variables and the `merge_default_json "$default_lsp_config" ...` call.
- Keep the `/workspace` writable check and `exec "$@"`.

- [ ] **Step 2: Rewrite `tests/smoke/mcp-runtime-smoke.sh`**

Replace its body so it (a) builds via `make build-base sync-karpathy-skills build-dev-image`, (b) asserts the merged `~/.claude.json`, (c) tests the non-destructive merge and the invalid-JSON abort. Full new content:
```bash
#!/usr/bin/env bash
set -euo pipefail

[[ -f Dockerfile ]] || { echo "missing Dockerfile"; exit 1; }
[[ -f Makefile ]] || { echo "missing Makefile"; exit 1; }

make build-base sync-karpathy-skills build-dev-image >/dev/null

docker run --rm remote-copilot:test bash -lc '
  set -euo pipefail
  test -f "$HOME/.claude.json"
  jq -e ".mcpServers[\"atlassian-rovo\"].url == \"https://mcp.atlassian.com/v1/mcp\"" "$HOME/.claude.json" >/dev/null
  jq -e ".mcpServers[\"atlassian-rovo\"].type == \"http\"" "$HOME/.claude.json" >/dev/null
  jq -e ".mcpServers[\"context7\"].command == \"context7-mcp\"" "$HOME/.claude.json" >/dev/null
  jq -e ".mcpServers[\"context7\"].type == \"stdio\"" "$HOME/.claude.json" >/dev/null
  jq -e ".mcpServers[\"context7\"].args == []" "$HOME/.claude.json" >/dev/null
'

docker run --rm --entrypoint bash remote-copilot:test -lc '
  set -euo pipefail
  cat > "$HOME/.claude.json" <<'"'"'EOF'"'"'
{
  "mcpServers": {
    "existing": { "type": "http", "url": "https://example.com/mcp" }
  }
}
EOF
  /usr/local/bin/entrypoint.sh bash -lc '"'"'
    set -euo pipefail
    jq -e ".mcpServers[\"existing\"].url == \"https://example.com/mcp\"" "$HOME/.claude.json" >/dev/null
    jq -e ".mcpServers[\"atlassian-rovo\"].url == \"https://mcp.atlassian.com/v1/mcp\"" "$HOME/.claude.json" >/dev/null
    jq -e ".mcpServers[\"context7\"].command == \"context7-mcp\"" "$HOME/.claude.json" >/dev/null
  '"'"'
'

if docker run --rm --entrypoint bash remote-copilot:test -lc '
  set -euo pipefail
  printf "{broken-json\n" > "$HOME/.claude.json"
  /usr/local/bin/entrypoint.sh true
'; then
  echo "expected invalid .claude.json to fail"
  exit 1
fi

echo "mcp runtime smoke passed"
```

- [ ] **Step 3: Lint the entrypoint**

Run: `cd /Volumes/KINGSTON/gsd && bash -n scripts/entrypoint.sh && bash -n tests/smoke/mcp-runtime-smoke.sh`
Expected: no output, exit 0.

- [ ] **Step 4: Run the MCP runtime smoke test**

Run: `cd /Volumes/KINGSTON/gsd && make test-mcp-runtime`
Expected: `mcp runtime smoke passed`. (SLOW: builds base + overlay. Requires Task 4's overlay changes to be done; if Task 4 is not yet complete, defer this step and run it after Task 4.)

> NOTE: This step depends on a working overlay build (Task 4). If executing strictly in order, complete the entrypoint + test edits and `bash -n` here, then run `make test-mcp-runtime` at the end of Task 4.

- [ ] **Step 5: Commit**

```bash
cd /Volumes/KINGSTON/gsd
git add -A
git commit -m "feat: merge MCP defaults into ~/.claude.json, drop Copilot LSP merge

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Overlay image — gsd-core + karpathy(claude) + LSP plugin; remove dev-copilot

**Files:**
- Modify: `Dockerfile`
- Create: `scripts/install-claude-plugins.sh`
- Modify: `scripts/install-karpathy-skills.sh`
- Delete: `scripts/install-dev-copilot.sh`, `scripts/sync-dev-copilot.sh`
- Modify: `Makefile`
- Modify: `tests/smoke/overlay-image-smoke.sh`

**Interfaces:**
- Consumes: `config/claude-lsp-plugin/` (Task 1, copied to `/opt/claude-lsp`), staged `/opt/karpathy-skills` (existing `sync-karpathy-skills.sh`).
- Produces: image `remote-copilot:test` with gsd-core installed under `/home/dev/.claude`, plugins `andrej-karpathy-skills@karpathy-skills` and `dev-lsp@dev-lsp-marketplace` registered+enabled.

- [ ] **Step 1: Discover and record pinned gsd-core version**

Run: `npm view @opengsd/gsd-core version`
Use the printed value as `GSD_CORE_VERSION` below (replace `<GSD_CORE_VERSION>`).

- [ ] **Step 2: Create `scripts/install-claude-plugins.sh`**

```bash
#!/usr/bin/env bash
set -euo pipefail

# Registers local plugin marketplaces and enables their plugins for Claude Code,
# non-interactively, at image build time. Runs as the `dev` user.

KARPATHY_DIR="${1:-/opt/karpathy-skills}"
LSP_DIR="${2:-/opt/claude-lsp}"

[[ -d "$KARPATHY_DIR" ]] || { echo "missing karpathy plugin dir: $KARPATHY_DIR"; exit 1; }
[[ -d "$LSP_DIR" ]] || { echo "missing lsp plugin dir: $LSP_DIR"; exit 1; }

timeout 120 claude plugin marketplace add "$KARPATHY_DIR" </dev/null || true
timeout 120 claude plugin marketplace add "$LSP_DIR" </dev/null || true

# Primary path: explicit install. Redirect stdin from /dev/null and bound with
# `timeout` so an interactive prompt fails fast (no TTY at build time) and falls
# through to the settings.json path below instead of HANGING the docker build.
timeout 120 claude plugin install andrej-karpathy-skills@karpathy-skills </dev/null || true
timeout 120 claude plugin install dev-lsp@dev-lsp-marketplace </dev/null || true

# Belt-and-suspenders: ensure enablement is recorded in settings.json even if
# `plugin install` is interactive/no-ops at build time.
mkdir -p "$HOME/.claude"
settings="$HOME/.claude/settings.json"
[[ -f "$settings" ]] || echo '{}' > "$settings"
jq empty "$settings"
tmp="$(mktemp)"
jq '
  .enabledPlugins |= (. // {}) |
  .enabledPlugins["andrej-karpathy-skills@karpathy-skills"] = true |
  .enabledPlugins["dev-lsp@dev-lsp-marketplace"] = true
' "$settings" > "$tmp"
mv "$tmp" "$settings"
```

- [ ] **Step 3: Rewrite `scripts/install-karpathy-skills.sh`**

This script is now superseded by `install-claude-plugins.sh`. Replace its body to keep it as a thin Claude-based wrapper (so any external reference still works):
```bash
#!/usr/bin/env bash
set -euo pipefail

PLUGIN_DIR="${1:-/opt/karpathy-skills}"

cd "$PLUGIN_DIR"
timeout 120 claude plugin marketplace add "$PLUGIN_DIR" </dev/null || true
timeout 120 claude plugin install andrej-karpathy-skills@karpathy-skills </dev/null || true
```

- [ ] **Step 4: Delete the dev-copilot scripts**

```bash
cd /Volumes/KINGSTON/gsd
git rm scripts/install-dev-copilot.sh scripts/sync-dev-copilot.sh
```

- [ ] **Step 5: Rewrite `Dockerfile`**

Full new content:
```dockerfile
ARG BASE_IMAGE=remote-copilot-base:test
FROM ${BASE_IMAGE}

ARG KARPATHY_SKILLS_DIR=.build/karpathy-skills
ARG GSD_CORE_VERSION=<GSD_CORE_VERSION>

USER root

COPY scripts/install-claude-plugins.sh /usr/local/bin/install-claude-plugins.sh
COPY scripts/install-karpathy-skills.sh /usr/local/bin/install-karpathy-skills.sh
COPY scripts/entrypoint.sh /usr/local/bin/entrypoint.sh
COPY ${KARPATHY_SKILLS_DIR}/ /opt/karpathy-skills/
COPY config/claude-lsp-plugin/ /opt/claude-lsp/

RUN chmod +x /usr/local/bin/install-claude-plugins.sh /usr/local/bin/install-karpathy-skills.sh /usr/local/bin/entrypoint.sh && \
    chown -R dev:dev /opt/karpathy-skills /opt/claude-lsp

USER dev

# gsd-core: non-interactive, --claude --global writes under /home/dev/.claude
RUN npx --yes "@opengsd/gsd-core@${GSD_CORE_VERSION}" --claude --global --profile=full

RUN /usr/local/bin/install-claude-plugins.sh /opt/karpathy-skills /opt/claude-lsp

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["bash"]
```

- [ ] **Step 6: Update `Makefile` for the overlay**

- Remove variables: `DEV_COPILOT_SOURCE`, `DEV_COPILOT_STAGING`, `DEV_COPILOT_INSTALL_CMD`, `DEV_COPILOT_SOURCE_REV`.
- Add: `GSD_CORE_VERSION ?= <GSD_CORE_VERSION>`.
- Remove the `sync-plugin` target entirely and remove it from `.PHONY`.
- Change `build-dev-image` to depend only on `sync-karpathy-skills` and pass the new args:
```make
build-dev-image: sync-karpathy-skills
	docker build -f Dockerfile -t $(DEV_IMAGE) \
	  --build-arg BASE_IMAGE=$(BASE_IMAGE) \
	  --build-arg KARPATHY_SKILLS_DIR=$(KARPATHY_SKILLS_STAGING) \
	  --build-arg GSD_CORE_VERSION=$(GSD_CORE_VERSION) \
	  .
```
- In `run-docker`, remove the `DEV_COPILOT_*` env passthroughs (the `DEV_COPILOT_DIR`/`DEV_COPILOT_INSTALL_CMD`/`DEV_COPILOT_SOURCE_REV` lines). (The credentials-file change lands in Task 5.)
- Update `.PHONY` to drop `sync-plugin`.

- [ ] **Step 7: Rewrite `tests/smoke/overlay-image-smoke.sh`**

Full new content:
```bash
#!/usr/bin/env bash
set -euo pipefail

[[ -f Dockerfile ]] || { echo "missing Dockerfile"; exit 1; }
[[ -f scripts/sync-karpathy-skills.sh ]] || { echo "missing scripts/sync-karpathy-skills.sh"; exit 1; }
[[ -f scripts/install-claude-plugins.sh ]] || { echo "missing scripts/install-claude-plugins.sh"; exit 1; }
[[ -f scripts/entrypoint.sh ]] || { echo "missing scripts/entrypoint.sh"; exit 1; }
[[ -f config/claude-lsp-plugin/.lsp.json ]] || { echo "missing LSP plugin"; exit 1; }
[[ ! -f scripts/sync-dev-copilot.sh ]] || { echo "sync-dev-copilot.sh should be gone"; exit 1; }
[[ ! -f scripts/install-dev-copilot.sh ]] || { echo "install-dev-copilot.sh should be gone"; exit 1; }

rm -rf .build/karpathy-skills
KARPATHY_SKILLS_REPO="${KARPATHY_SKILLS_REPO:-https://github.com/multica-ai/andrej-karpathy-skills}" \
KARPATHY_SKILLS_REF="${KARPATHY_SKILLS_REF:-2c606141936f1eeef17fa3043a72095b4765b9c2}" \
./scripts/sync-karpathy-skills.sh .build/karpathy-skills

docker build -f Dockerfile.base -t remote-copilot-base:test .
docker build -f Dockerfile -t remote-copilot:test \
  --build-arg BASE_IMAGE=remote-copilot-base:test \
  --build-arg KARPATHY_SKILLS_DIR=.build/karpathy-skills \
  .

docker run --rm remote-copilot:test bash -lc '
  set -euo pipefail
  test -d /opt/karpathy-skills
  test -d /opt/claude-lsp
  test -x /usr/local/bin/install-claude-plugins.sh
  command -v claude >/dev/null
  # gsd-core landed under ~/.claude
  test -d "$HOME/.claude"
  ls -A "$HOME/.claude" | grep -q .
  # plugins enabled in settings.json
  jq -e ".enabledPlugins[\"andrej-karpathy-skills@karpathy-skills\"] == true" "$HOME/.claude/settings.json" >/dev/null
  jq -e ".enabledPlugins[\"dev-lsp@dev-lsp-marketplace\"] == true" "$HOME/.claude/settings.json" >/dev/null
'

echo "overlay image smoke passed"
```

- [ ] **Step 8: Lint scripts**

Run: `cd /Volumes/KINGSTON/gsd && bash -n scripts/install-claude-plugins.sh scripts/install-karpathy-skills.sh tests/smoke/overlay-image-smoke.sh && make -n build-dev-image`
Expected: exit 0; `make -n` prints the new build command with no `DEV_COPILOT` references.

- [ ] **Step 9: Build and run overlay smoke (+ the deferred MCP smoke from Task 3)**

Run:
```bash
cd /Volumes/KINGSTON/gsd
make test-overlay
make test-mcp-runtime
```
Expected: `overlay image smoke passed` then `mcp runtime smoke passed`. (SLOW: base + overlay builds.)

> VERIFY-DURING-IMPLEMENTATION: If `claude plugin install` is interactive at build and the `|| true` path leaves plugins unregistered, confirm the `enabledPlugins` settings entry is sufficient for the plugins to load in an interactive session. Fallback if not: in `install-claude-plugins.sh`, additionally copy `"$KARPATHY_DIR"/skills/.` into `$HOME/.claude/skills/` and copy the `.lsp.json` into an enabled plugin location per current Claude Code plugin docs. Re-run `make test-overlay`.

- [ ] **Step 10: Commit**

```bash
cd /Volumes/KINGSTON/gsd
git add -A
git commit -m "feat: install gsd-core + karpathy + LSP plugin via Claude Code, drop dev-copilot

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Compose, OAuth bootstrap, runtime smoke

**Files:**
- Modify: `docker-compose.yml`
- Modify: `scripts/bootstrap-atlassian-rovo-oauth.sh`
- Modify: `Makefile` (`run-docker`, `bootstrap-atlassian-oauth` targets)
- Modify: `tests/smoke/runtime-smoke.sh`

**Interfaces:**
- Consumes: overlay image (Task 4), env `CLAUDE_CODE_OAUTH_TOKEN`.
- Produces: Compose service `dev` that mounts only `~/.claude/.credentials.json` (single file) RW for persistence, passes `CLAUDE_CODE_OAUTH_TOKEN`, and an in-container Atlassian OAuth helper.

- [ ] **Step 1: Edit `docker-compose.yml`**

- In `environment:`, replace `GITHUB_TOKEN`/`GH_TOKEN` requirement emphasis by adding `CLAUDE_CODE_OAUTH_TOKEN: ${CLAUDE_CODE_OAUTH_TOKEN:-}` (keep `GITHUB_TOKEN`/`GH_TOKEN` as optional passthrough for git/gh; keep `SSH_AUTH_SOCK`).
- In `build.args`, delete ALL `DEV_COPILOT_*` entries. The final `build.args` set is exactly: `BASE_IMAGE`, `KARPATHY_SKILLS_DIR` (default `${KARPATHY_SKILLS_DIR:-.build/karpathy-skills}`), and `GSD_CORE_VERSION` (default `${GSD_CORE_VERSION:-}`). No stale args left behind.
- In `volumes:`, replace the line `- ${MCP_OAUTH_DIR:-./.copilot-mcp-oauth}:/home/dev/.copilot/mcp-oauth-config` with:
```yaml
      - ${CLAUDE_CREDENTIALS_FILE:-./.claude-credentials.json}:/home/dev/.claude/.credentials.json
```
Keep the `${HOME}/.ssh:/home/dev/.ssh:ro`, `${PWD}:${PWD}`, workspace and cache mounts.

- [ ] **Step 2: Rewrite `scripts/bootstrap-atlassian-rovo-oauth.sh`**

The host-side file copy cannot work for Claude on macOS (Keychain). Replace with an in-container helper that authenticates Atlassian and persists into the mounted `.credentials.json`. Full new content:
```bash
#!/usr/bin/env bash
set -euo pipefail

# Completes Atlassian Rovo MCP OAuth INSIDE the running dev container and
# persists it via the bind-mounted ~/.claude/.credentials.json.
#
# Run on the HOST. It execs `claude` inside the running compose container so the
# OAuth credentials are written to the Linux credentials file (portable), not
# the host macOS Keychain.

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd)"
SERVICE="${DEV_SERVICE:-dev}"
SERVER_URL="https://mcp.atlassian.com/v1/mcp"

if [[ -f /.dockerenv ]] || [[ "${HOME:-}" == "/home/dev" ]]; then
  echo "run this script on the host, not inside the container" >&2
  exit 1
fi

if ! command -v docker >/dev/null 2>&1; then
  echo "docker not found on host PATH" >&2
  exit 1
fi

cd "$REPO_ROOT"
cid="$(docker compose ps -q "$SERVICE" || true)"
if [[ -z "$cid" ]]; then
  echo "dev container is not running; start it first (e.g. docker compose up -d)" >&2
  exit 1
fi

echo "Launching in-container Claude session for Atlassian Rovo OAuth..."
echo "Complete the printed browser URL when prompted; credentials persist to ./.claude-credentials.json"

docker exec -it "$cid" bash -lc '
  set -euo pipefail
  claude -p "Use the atlassian-rovo MCP server. If authentication is required, complete the OAuth flow, then reply exactly: atlassian-rovo authenticated." \
    --mcp-config '"'"'{"mcpServers":{"atlassian-rovo":{"type":"http","url":"'"$SERVER_URL"'"}}}'"'"' \
    --permission-mode bypassPermissions \
    --output-format text
'

echo "If authentication completed, ~/.claude/.credentials.json now holds Atlassian Rovo OAuth state (persisted on the host)."
```

> VERIFY-DURING-IMPLEMENTATION: confirm whether `claude -p` can complete remote-MCP OAuth via a paste-URL flow. FALLBACK: instruct the user to run `claude` interactively once inside the container (`docker compose exec dev claude`), trigger an atlassian-rovo tool, complete OAuth; credentials then persist via the mount.

- [ ] **Step 3: Update `Makefile` `run-docker` and `bootstrap-atlassian-oauth`**

- In `run-docker`, before `docker compose run`, ensure the credentials file exists (Docker needs an existing file for a single-file bind-mount):
```make
run-docker:
	mkdir -p "$(WORKSPACE_DIR)" "$(HOME_CACHE_DIR)"
	touch "$(CURDIR)/.claude-credentials.json"
	BASE_IMAGE=$(BASE_IMAGE) \
	DEV_IMAGE=$(DEV_IMAGE) \
	WORKSPACE_DIR="$(WORKSPACE_DIR)" \
	HOME_CACHE_DIR="$(HOME_CACHE_DIR)" \
	CLAUDE_CREDENTIALS_FILE="$(CURDIR)/.claude-credentials.json" \
	docker compose run --rm dev
```
- `bootstrap-atlassian-oauth` target stays as `./scripts/bootstrap-atlassian-rovo-oauth.sh` (script body changed in Step 2).

- [ ] **Step 4: Rewrite `tests/smoke/runtime-smoke.sh`**

Full new content (drops all Copilot LSP entrypoint tests; new mount + bootstrap-guard checks):
```bash
#!/usr/bin/env bash
set -euo pipefail

[[ -f docker-compose.yml ]] || { echo "missing docker-compose.yml"; exit 1; }
[[ -f Makefile ]] || { echo "missing Makefile"; exit 1; }

mkdir -p workspace .cache-home
touch .claude-credentials.json
repo_path="$(pwd)"
trap 'docker compose down >/dev/null 2>&1 || true' EXIT

[[ -x scripts/bootstrap-atlassian-rovo-oauth.sh ]] || { echo "missing scripts/bootstrap-atlassian-rovo-oauth.sh"; exit 1; }
make -n bootstrap-atlassian-oauth >/dev/null

# Bootstrap must refuse to run inside the container.
if HOME=/home/dev ./scripts/bootstrap-atlassian-rovo-oauth.sh >/dev/null 2>&1; then
  echo "expected bootstrap to refuse when HOME=/home/dev"
  exit 1
fi

make build-base sync-karpathy-skills build-dev-image >/dev/null

DEV_IMAGE=remote-copilot:test \
BASE_IMAGE=remote-copilot-base:test \
WORKSPACE_DIR="$(pwd)/workspace" \
HOME_CACHE_DIR="$(pwd)/.cache-home" \
CLAUDE_CREDENTIALS_FILE="$(pwd)/.claude-credentials.json" \
docker compose run --rm dev bash -lc '
  set -euo pipefail
  id -un | grep -qx dev
  test -d /workspace
  test -d "$HOME/.cache"
  test -f "$HOME/.claude.json"
  command -v claude >/dev/null
  jq -e ".enabledPlugins[\"andrej-karpathy-skills@karpathy-skills\"] == true" "$HOME/.claude/settings.json" >/dev/null
  jq -e ".enabledPlugins[\"dev-lsp@dev-lsp-marketplace\"] == true" "$HOME/.claude/settings.json" >/dev/null
  # The whole point of the single-file mount: dev (uid 1000) must be able to WRITE it,
  # else remote-MCP OAuth is silently lost on restart.
  test -f "$HOME/.claude/.credentials.json"
  printf "{}" > "$HOME/.claude/.credentials.json"
'

docker compose down >/dev/null 2>&1 || true
DEV_IMAGE=remote-copilot:test \
BASE_IMAGE=remote-copilot-base:test \
WORKSPACE_DIR="$(pwd)/workspace" \
HOME_CACHE_DIR="$(pwd)/.cache-home" \
CLAUDE_CREDENTIALS_FILE="$(pwd)/.claude-credentials.json" \
docker compose up -d >/dev/null

cid="$(docker compose ps -q dev)"
test -n "$cid"
docker exec -w "$repo_path" "$cid" bash -lc 'set -euo pipefail; pwd' | grep -qx "$repo_path"
docker inspect "$cid" --format '{{json .Mounts}}' | jq -e 'map(select(.Destination == "/home/dev/.ssh" and .RW == false)) | length == 1' >/dev/null
docker inspect "$cid" --format '{{json .Mounts}}' | jq -e 'map(select(.Destination == "/home/dev/.claude/.credentials.json" and .RW == true)) | length == 1' >/dev/null
docker inspect "$cid" --format '{{json .Mounts}}' | jq -e 'map(select(.Destination == "/home/dev/.claude")) | length == 0' >/dev/null

# Narrow checks: the image tags `remote-copilot[-base]:test` are intentionally kept,
# so do NOT grep the bare substring "copilot". Assert the removed artifacts are gone.
for pat in 'COPILOT_' 'DEV_COPILOT' '\.copilot' 'mcp-oauth-config'; do
  if grep -qE "$pat" docker-compose.yml; then
    echo "docker-compose.yml should not mention $pat"
    exit 1
  fi
done

echo "runtime smoke passed"
```

- [ ] **Step 5: Lint**

Run: `cd /Volumes/KINGSTON/gsd && bash -n scripts/bootstrap-atlassian-rovo-oauth.sh tests/smoke/runtime-smoke.sh && docker compose config >/dev/null`
Expected: exit 0; `docker compose config` prints merged config without error.

- [ ] **Step 6: Run runtime smoke**

Run: `cd /Volumes/KINGSTON/gsd && make test-runtime`
Expected: `runtime smoke passed`. (SLOW: builds + compose up.)

- [ ] **Step 7: Commit**

```bash
cd /Volumes/KINGSTON/gsd
git add -A
git commit -m "feat: Claude OAuth env + single-file credentials persistence + in-container Atlassian bootstrap

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Docs — `.env.example`, README, docs-smoke, CLAUDE.md

**Files:**
- Create: `.env.example`
- Modify: `README.md`
- Modify: `tests/smoke/docs-smoke.sh`
- Modify: `CLAUDE.md`

**Interfaces:**
- Consumes: all prior tasks (documents the final state).
- Produces: README + `.env.example` satisfying the new `docs-smoke.sh` grep contract.

- [ ] **Step 1: Create `.env.example`**

```bash
# Claude Code subscription OAuth token (from `claude setup-token` on the host).
CLAUDE_CODE_OAUTH_TOKEN=

# Optional: GitHub auth passthrough for git/gh inside the container.
GITHUB_TOKEN=
GH_TOKEN=

# Optional: forward host SSH agent socket.
SSH_AUTH_SOCK=

# Persisted Claude credentials file (holds remote-MCP OAuth, e.g. Atlassian Rovo).
CLAUDE_CREDENTIALS_FILE=./.claude-credentials.json

# Pin overrides (optional).
GSD_CORE_VERSION=
```

- [ ] **Step 2: Rewrite `tests/smoke/docs-smoke.sh` (the test) to the new contract**

Full new content:
```bash
#!/usr/bin/env bash
set -euo pipefail

[[ -f README.md ]] || { echo "missing README.md"; exit 1; }
[[ -f .env.example ]] || { echo "missing .env.example"; exit 1; }

grep -q "make build-base" README.md || { echo "README missing make build-base"; exit 1; }
grep -q "make build-dev-image" README.md || { echo "README missing make build-dev-image"; exit 1; }
grep -q "make deploy-k8s" README.md || { echo "README missing make deploy-k8s"; exit 1; }
grep -q "Claude Code" README.md || { echo "README missing Claude Code"; exit 1; }
grep -q "gsd-core" README.md || { echo "README missing gsd-core note"; exit 1; }
grep -q "@opengsd/gsd-core" README.md || { echo "README missing gsd-core package"; exit 1; }
grep -q "Atlassian Rovo" README.md || { echo "README missing Atlassian Rovo MCP note"; exit 1; }
grep -q "Context7" README.md || { echo "README missing Context7 MCP note"; exit 1; }
grep -q "context7-mcp" README.md || { echo "README missing baked context7-mcp note"; exit 1; }
grep -q "typescript-language-server" README.md || { echo "README missing typescript-language-server note"; exit 1; }
grep -q "andrej-karpathy-skills" README.md || { echo "README missing Karpathy plugin note"; exit 1; }
grep -q "CLAUDE_CODE_OAUTH_TOKEN" README.md || { echo "README missing OAuth token note"; exit 1; }
grep -q "claude setup-token" README.md || { echo "README missing setup-token note"; exit 1; }
grep -q "host user's \`~/.ssh\` directory read-only" README.md || { echo "README missing compose SSH mount note"; exit 1; }
grep -q "make bootstrap-atlassian-oauth" README.md || { echo "README missing bootstrap-atlassian-oauth flow"; exit 1; }
grep -q ".claude-credentials.json" README.md || { echo "README missing credentials persistence note"; exit 1; }
grep -q "ephemeral" README.md || { echo "README missing ephemeral state note"; exit 1; }

grep -q '^CLAUDE_CODE_OAUTH_TOKEN=' .env.example || { echo ".env.example missing CLAUDE_CODE_OAUTH_TOKEN"; exit 1; }
grep -q '^CLAUDE_CREDENTIALS_FILE=' .env.example || { echo ".env.example missing CLAUDE_CREDENTIALS_FILE"; exit 1; }
grep -q '^SSH_AUTH_SOCK=' .env.example || { echo ".env.example missing SSH_AUTH_SOCK"; exit 1; }

if grep -q 'DEV_COPILOT' .env.example; then
  echo ".env.example should not contain DEV_COPILOT vars"
  exit 1
fi
# The image tag `remote-copilot:test` may legitimately appear in a `docker run`
# example, so assert the removed artifacts are gone rather than the bare substring.
for pat in 'dev-copilot' 'copilot plugin' '\.copilot' 'COPILOT_'; do
  if grep -qE "$pat" README.md; then
    echo "README should not mention $pat anymore"
    exit 1
  fi
done

echo "docs smoke passed"
```

- [ ] **Step 3: Rewrite `README.md`**

Rewrite so every required phrase above is present and no `copilot` substring remains (case-insensitive). Cover: title (e.g. "Remote Claude Code Dev Environment"); prerequisites (Docker, kubectl, `GITHUB_TOKEN` optional, Claude Pro/Max subscription); local build (`make build-base`, `make build-dev-image`, note the karpathy git-ref staging and that **gsd-core** is installed from npm `@opengsd/gsd-core` via `npx ... --claude --global --profile=full`); run (`make run-docker`, starts in `/workspace`, `~/.ssh` mounted read-only); **auth** (generate `CLAUDE_CODE_OAUTH_TOKEN` on host via `claude setup-token`, pass via `.env`); **MCP** (Atlassian Rovo http + Context7 stdio via baked `context7-mcp`, merged non-destructively into `~/.claude.json` at start); **LSP** (TypeScript via `typescript-language-server` shipped as the `dev-lsp` Claude Code plugin); **plugins** (`andrej-karpathy-skills`); **persistence** (only `.claude-credentials.json` is bind-mounted; the rest of `~/.claude` is baked/ephemeral); **Atlassian OAuth** (`make bootstrap-atlassian-oauth` runs an in-container login because macOS host stores OAuth in Keychain, not a file); deploy-to-k8s section (`make deploy-k8s`). Keep the existing factual tone.

- [ ] **Step 4: Update `CLAUDE.md`**

Update the repo guide to describe the Claude Code + gsd-core architecture: base installs Claude Code via npm; overlay installs gsd-core via npx (`--claude --global --profile=full`) and registers karpathy + the `dev-lsp` plugin; entrypoint merges MCP defaults into `~/.claude.json`; auth via `CLAUDE_CODE_OAUTH_TOKEN`; persistence via single-file `.credentials.json` mount; bootstrap is in-container. Remove the Copilot/dev-copilot/lsp-config descriptions and the `DEV_COPILOT_SOURCE` staging text. Update the test list (no `sync-plugin`).

- [ ] **Step 5: Run docs smoke**

Run: `cd /Volumes/KINGSTON/gsd && make test-docs`
Expected: `docs smoke passed`.

- [ ] **Step 6: Full test sweep**

Run:
```bash
cd /Volumes/KINGSTON/gsd
make test-base && make test-overlay && make test-mcp-runtime && make test-runtime && make test-docs && make test-ssh-sync
```
Expected: each prints its `... passed` line. (`make test-k8s` is intentionally excluded — `k8s/` manifests do not exist and that is pre-existing, out of scope.)

> HONEST CLAIM after a green sweep: "image builds, all configs/plugins/mounts are in place, MCP merges correctly." It does NOT prove karpathy/LSP plugins functionally load — `enabledPlugins == true` is written by our own jq, and LSP loads only in an interactive trusted session the smoke never runs. Confirm those by launching `claude` interactively in the container (per T4 S9 / T5 S2 callouts) before claiming "plugins work."

- [ ] **Step 7: Commit**

```bash
cd /Volumes/KINGSTON/gsd
git add -A
git commit -m "docs: rewrite README/.env.example/docs-smoke/CLAUDE.md for Claude Code + gsd-core

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-review notes

- **Spec coverage:** Base→Claude (T2), gsd-core (T4), karpathy kept (T4), LSP plugin (T1/T4), OAuth token (T5), `.credentials.json` single-file mount (T5), MCP merge to `~/.claude.json` (T3), in-container bootstrap (T5), all contracts/tests/.env/README/CLAUDE.md (T2–T6), removed Copilot artifacts (T1/T2/T4). All spec sections map to a task.
- **Verify-during-implementation items** from the spec are embedded as explicit VERIFY/FALLBACK callouts in T4 (plugin install non-interactivity) and T5 (remote-MCP OAuth flow), and are confirmed by `make test-*` rather than inspection.
- **Cross-task naming consistency:** plugin marketplace/plugin names `karpathy-skills`/`andrej-karpathy-skills` and `dev-lsp-marketplace`/`dev-lsp` are used identically in T1, T4 (`install-claude-plugins.sh`, overlay smoke), and T5 (runtime smoke). Image tags unchanged. Credentials var `CLAUDE_CREDENTIALS_FILE` and path `/home/dev/.claude/.credentials.json` consistent across compose, Makefile, T5 smoke.
- **Pinned versions** (`CLAUDE_CODE_VERSION`, `GSD_CORE_VERSION`) are discovered via `npm view` in T2-S1 / T4-S1 and substituted as literal values — not left as `latest`.
