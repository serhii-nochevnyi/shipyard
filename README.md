# Shipyard

A delivery conveyor for coding agents: it takes a problem from "we should look
into this" all the way to a set of green PRs — deep investigation → a validated
ticket graph → a worktree and PR per ticket, babysat to green.

It runs on **two runtimes from one source of truth**. The Claude Code plugin
(`plugins/delivery-pipeline/`) is canonical; a generator emits the Codex-native
artifacts from it, so the OpenAI Codex CLI runs the same conveyor and the two
cannot drift. Everything the conveyor must not improvise — git, `gh`, the graph,
the gates — lives in tested Node/bash scripts shared by both.

Three ways to run it:

| | What you get | Start here |
|---|---|---|
| **Container** (Claude Code) | The whole toolchain pinned and baked: Claude Code CLI, gsd-core, shipyard, MCP servers, auto-route hook. Isolated, throwaway, `bypassPermissions` is safe inside it. | [`make dev`](#quick-start) |
| **Host Claude Code** | The conveyor and its gates in your own Claude Code, no container. Installable straight from GitHub: `claude plugin marketplace add serhii-nochevnyi/shipyard`. | [Installing the conveyor into host Claude Code](#installing-the-conveyor-into-host-claude-code) |
| **Host Codex CLI** | The same skills, subagents and gates, generated for Codex. | [Shipyard on the OpenAI Codex CLI](#shipyard-on-the-openai-codex-cli) |

The container is Claude Code only — Codex is a host-side install. Both host paths
leave everything outside shipyard's own files untouched.

## Quick start

This is the **containerized Claude Code** path. For a host install (Claude Code or
Codex CLI) skip to [Shipyard on the OpenAI Codex CLI](#shipyard-on-the-openai-codex-cli)
or [Installing the conveyor into host Claude Code](#installing-the-conveyor-into-host-claude-code).

```bash
make dev
```

`make dev` runs the guided launcher (`scripts/dev.sh`): it creates `.env` if
missing, builds the images if needed, starts the container, and then asks in turn
whether to log in to Claude, authenticate MCP servers (e.g. Atlassian Rovo), and
which project to work in — clone a new repo into `/workspace` or pick an existing
one there. It finally attaches a `claude` or `bash` session **inside that project
directory**. Each step is skipped if already done, so it is safe to re-run.

Inside this isolated container, Claude always runs without per-action permission
prompts: the image bakes `permissions.defaultMode: "bypassPermissions"` into
`~/.claude/settings.json`, and the entrypoint pre-seeds the one-time bypass
acceptance plus per-directory trust for `/workspace` and every project inside it
(the `shipyard-trust` helper covers repos cloned later). So a bare `claude` from
any shell behaves the same as `claude --dangerously-skip-permissions` (which
`make claude` and the launcher's "claude" option still pass explicitly). Use this
only in the throwaway container, never against your host shell.

Individual targets if you prefer to drive it yourself:

| Command | Does |
|---|---|
| `make up` | start the persistent container (`docker compose up -d`; builds the image first if missing) |
| `make claude [DIR=subdir]` | attach a `claude --dangerously-skip-permissions` session (in `/workspace/subdir` if `DIR` is given) |
| `make shell [DIR=subdir]` | attach a `bash` shell (in `/workspace/subdir` if `DIR` is given) |
| `make clone REPO=<git-url>` | clone a repo into `/workspace` (set `WORKSPACE_SUBDIR=name` to rename) |
| `make bootstrap-atlassian-oauth` | authenticate the Atlassian Rovo MCP server |
| `make run-docker` | one-off ephemeral session (`docker compose run --rm`) |
| `make clean-cache` | prune MCP server logs older than 7 days from `.cache-home` |

## Delivery workflow

The conveyor is the same on every runtime — only the invocation differs:
`/shipyard:<cmd>` on Claude Code, `$shipyard-<cmd>` on Codex. This section uses
the Claude Code spelling. You do not have to remember which entry to use —
describe the work and the router picks it:

```text
/shipyard:route "scope of the work"
```

It is read-only and advisory: it sizes the work and hands off to the right loop
(and the auto-route hook — baked into the container, installable on either host
runtime — surfaces it for you, so in practice you just state what you want). Large multi-ticket efforts go through the three conveyor loops
below; a small change, an existing ticket, or explicit "no ticket" goes to
`/shipyard:bench`, which implements directly in the current worktree and never
creates a branch, PR, or commit unless you ask.

```text
/shipyard:investigate "тема або проблема"
```

Deep investigation: an intake interview refines the problem, parallel research
agents draft options/constraints/risks, then you close open questions and lock
decisions in a dialog. Re-run `/shipyard:investigate` anytime — it picks up the
open investigation from its artifacts. When all questions are closed it
generates an ADR package (Gate 1 — the only fully human gate).

```text
/shipyard:decompose
```

Finds undecomposed ADRs, runs the GSD planning chain under the hood, stamps
tickets with branches/risk, validates the dependency graph (Gate 2 — automatic,
mechanical), and shows you the ticket set for approval. Gate 2 is
`scripts/validate-graph.cjs` exiting 0 and nothing else.

```text
/shipyard:deliver
```

Cold-starts from live GitHub state, shows a ticket board (ready /
branched-needs-pr / blocked / pr-open / merged), lets you pick the scope to take
on, then runs each ticket in its own git worktree to its own PR and babysits
every PR to green: CI fixes, review-comment handling, architecture conformance,
with CodeRabbit/Copilot re-review after every push. Green ticket PRs are squashed
into the phase's epic branch by the sentinel (below); it only comes back to you
for high-risk approvals, escalations, and the one merge that matters — the epic
into `main`. Gaps of days between the three
stages are fine — each command re-derives its state from artifacts and GitHub,
not from the chat.

**When the run may stop is code, not judgement.** `state-sync` ends every board
with the actionable front and a verdict — `fixpoint: NO — 12 item(s) are
actionable RIGHT NOW` or `fixpoint: YES` — computed by
`scripts/front.cjs` (also runnable alone, `--json` for the machine view, written to
`.planning/graph/delivery-front.json`). A PR waiting on CI counts as "not a
fixpoint" but never as a reason to block: the run serves the rest of the front and
only waits when that PR is the last thing left.

**A sentinel guards the PRs while the run cascades on.** The moment tickets have
PRs, two jobs run at different speeds — opening the next branches (minutes) and
driving a PR to green (CI rounds, CodeRabbit, Copilot). So the run posts a
background **PR sentinel** over the open PRs and goes back to the cascade. The
guard fixes CI, services every reviewer comment (`reviewers.cjs feedback` returns
threads *and* the bots' PR-level comments), records the arch-review verdict as a
`gate_status:` trailer, and then **lands the ticket PR in the epic branch** —
`scripts/sentinel.cjs merge`, which re-verifies the whole gate against live
GitHub and refuses on anything unproven. It retargets cascade children and
reports back. Knobs: `pipeline.sentinel` (`auto` | `off`), `pipeline.auto_merge`
(`epic` | `off`). **The epic → `main` PR is never auto-merged** — the phase lands
by a human's hand, which is what the epic-as-quarantine is for. Without a
background-agent runtime (Codex) the same duty runs as a mandatory pass at the
top of every round. Both writers take a lock: state files are replaced
atomically, and `git worktree add` is serialized against the guard's pushes.

**Worktrees are garbage-collected, not just reaped.** The reaper walks the current
ticket graph, so it structurally cannot see a worktree whose ticket was
re-decomposed away or one left behind by a killed run — and past a few dozen of
them the sandbox profile exceeds the argv limit (E2BIG) and every sandboxed
command starts failing. `scripts/ticket-worktree.sh gc` classifies every pipeline
worktree (`live` / `landed` / `dirty` / `review` / `gone`) and warns past
`SHIPYARD_WORKTREE_WARN_AT` (default 20); `gc --prune` removes only what it can
prove is safe. Uncommitted work and worktrees the graph cannot account for are
never removed automatically, and with no `tickets.json` present gc prunes nothing
at all.

**A phase can span repositories.** A ticket whose files live in a sibling repo
declares `delivery.repo: owner/name` in its plan; every GitHub query, epic branch
and PR is then scoped to that repo, and the board tags it (`T-06-01@acme/webapp`).
Tracking needs nothing else; *executing* there needs a local checkout —
`pipeline.repos: {"acme/webapp": "/abs/path"}`. Without the declaration the
conveyor watches the wrong repository: a PR merges next door while the board says
`pending` and every dependent stays blocked. Gate 2 warns on that signature.

Full specification: `docs/gsd_multilevel_delivery_pipeline.md`.

### Agent model policy

The conveyor routes agents by **role × risk × attempt**, and that policy is code:

```bash
node plugins/delivery-pipeline/scripts/pipeline-config.cjs model executor --risk high
node plugins/delivery-pipeline/scripts/pipeline-config.cjs model ci-fix --json --attempt 3
node plugins/delivery-pipeline/scripts/pipeline-config.cjs resolve      # effective config
```

It only ever emits the tier aliases `opus`, `sonnet`, `haiku`, `fable` — the values
the Agent tool accepts — and with `--json` it also returns the reasoning `effort`,
which follows the resolved tier (GSD's ladder: light→low, standard→high,
heavy→xhigh). So escalating a repair to the top tier makes it think harder too.

`fable` is Claude Fable 5: Opus-tier with a **1M-token context window** and
adaptive thinking. It is the only alias that expresses "top tier with 1M context".
It is a paid model, so it is never a default — opt in per role:

```json
{ "pipeline": { "models": { "integrator": "fable", "arch-review": "fable" } } }
```

Configuration lives in `.planning/config.json` under two namespaces:
`delivery_pipeline.*` (the capability's own declared config — GSD-native, settable
and validated through GSD's tooling, and it wins) and `pipeline.*` (shipyard's
runtime knobs; note `pipeline` is not a valid GSD config key, so edit the file
directly). Keys: `model_policy` (GSD's own `budget`/`quality` names work as
aliases), `models`, `effort`, `max_attempts`, `pr_fetch_limit`,
`integration_mode`, `use_workflow`, `graph_gate`, `jira`, `repos`.

The conveyor also **obeys GSD's own settings** rather than second-guessing them:
`git.base_branch` decides where epics are cut from and where the integration PR
goes (it outranks the repo default), `git.branching_strategy` must stay `none`
because the conveyor owns branching, and `runtime` decides effort clamping.
`state-sync` echoes the effective settings and warns about anything not in effect.

## Shipyard on the OpenAI Codex CLI

Codex is a **first-class runtime**, not a port: the same conveyor, the same
deterministic scripts, the same blocking gates. It is a host-side install,
separate from the Docker image (which is Claude Code only).

The canonical source stays the Claude plugin
(`plugins/delivery-pipeline/commands/*.md`); a generator emits the Codex-native
artifacts from it, so the two runtimes never drift — change a command once and
re-run the installer. Where the runtimes genuinely differ, the conveyor adapts
instead of pretending: Codex has no Workflow tool, so `deliver` runs its built-in
agent path, and `agent_skills` needs the bare skill form (both spelled out below).

Prerequisite — gsd-core installed for Codex:

```bash
npx --yes @opengsd/gsd-core@1.7.0 --codex --global
```

Then install shipyard from a checkout (the generator and the deterministic scripts
come from the repo, so this path needs the clone — there is no marketplace for
Codex):

```bash
git clone https://github.com/serhii-nochevnyi/shipyard && cd shipyard
make install-shipyard-codex        # or: bash scripts/install-shipyard-codex.sh
```

This generates Codex skills from the Claude commands (via gsd-core's own
converter — `$shipyard-route`, `$shipyard-investigate`, `$shipyard-decompose`,
`$shipyard-deliver`, `$shipyard-bench`), registers the delivery subagents in
`$CODEX_HOME/config.toml` (non-destructively), copies the deterministic
scripts/references/workflows under `$CODEX_HOME/shipyard/`, and installs the
runtime-agnostic GSD capability that contributes the blocking Gate 2 (ticket
graph) and UAT gates — the same gates the Claude runtime uses.
Because Codex has no Workflow tool, `deliver` runs its built-in agent path:
deterministic bookkeeping in Node scripts, agentic work via Codex `spawn_agent`.

<!-- keep in sync with commands/decompose.md -->
**One config detail matters on Codex.** The delivery-rules contract reaches GSD's
planner and executor through `agent_skills` in `.planning/config.json`, and the
working value depends on `runtime`: the plugin-namespaced form
`global:shipyard:delivery-rules` is resolved **only** on the `claude` runtime and
is silently skipped elsewhere. On Codex use the bare form
`global:shipyard-delivery-rules`, which resolves from `~/.agents/skills` — exactly
where this installer puts it. `state-sync` warns when the form cannot resolve on
your runtime.
It also writes a managed "shipyard auto-route" block into
`$CODEX_HOME/AGENTS.md`, so a defined scope of work is routed through shipyard
(research-first, proportionate GSD) without the user invoking `$shipyard-*` by
hand.

### Auto-route on host Claude Code

Both runtimes get the auto-route nudge, by different mechanisms: Codex through the
managed block in `$CODEX_HOME/AGENTS.md` that its installer writes (above), Claude
Code through a `UserPromptSubmit` hook. Inside the container the hook is already
installed by the overlay build, so a scope of work is routed through shipyard
without you invoking anything.

To get the same on your **host** Claude Code (it edits your user settings,
not the plugin):

```bash
make install-shipyard-claude-hook        # or: make remove-shipyard-claude-hook
```

It writes `~/.claude/hooks/shipyard-auto-route.sh` and merges a hook into
`~/.claude/settings.json` (idempotent, preserving your other hooks). On a running
session, open `/hooks` once or restart to load it.

### Installing the conveyor into host Claude Code

**From GitHub, no clone** — the repo is itself a plugin marketplace:

```bash
claude plugin marketplace add serhii-nochevnyi/shipyard
claude plugin install shipyard@shipyard               # restart Claude to apply
```

That gives you the five commands and the delivery-rules skill. The blocking Gate 2
/ UAT gates ship as a **GSD capability**, which needs the checkout (its installer
stages the validator with its sibling modules), as does the Codex install:

```bash
git clone https://github.com/serhii-nochevnyi/shipyard && cd shipyard
make install-shipyard-capability                     # Gate 2 + UAT gates, global scope
make install-shipyard-claude-hook                    # optional: auto-route
```

Developing on the checkout instead? Register it as a directory marketplace and
refresh from disk:

```bash
claude plugin marketplace update delivery-pipeline   # refresh from this checkout
claude plugin update shipyard@delivery-pipeline      # restart Claude to apply
make install-shipyard-capability                     # Gate 2 + UAT gates, global scope
```

The capability installer stages the validator **with its sibling modules**; a
`gsd-tools capability install` pointed straight at `capabilities/` would leave the
gate unable to load its parser. `make install-shipyard-codex` does the equivalent
for Codex as part of its own run.

The `plan:post` gate is installed at global scope but is applicability-scoped: it
stays inert in projects that carry no `delivery:` blocks, and fails closed for
real conveyor projects. Opt a project out entirely with
`.planning/config.json` → `pipeline.graph_gate: false`.

Set `SHIPYARD_CODEX_PHASE=1` to install `investigate`+`decompose` only and leave
`deliver` out. Skills land in `~/.agents/skills`; nothing outside shipyard's own
files is modified.

## Prerequisites

Per path — only the container path needs Docker at all:

- **Container (Claude Code)**: Docker with Compose support; a Claude Pro or Max
  subscription; `kubectl` for the Kubernetes deployment and `make test-k8s`.
- **Host Claude Code**: the `claude` CLI and gsd-core installed for it.
- **Host Codex CLI**: the `codex` CLI with its own access (ChatGPT plan or API
  key) and gsd-core installed for Codex
  (`npx --yes @opengsd/gsd-core@1.7.0 --codex --global`).
- **Any path that opens PRs**: `gh` authenticated, plus a valid `GITHUB_TOKEN` or
  `GH_TOKEN` for git/gh access inside the container (optional there).
- a local SSH agent if you need private Git access at runtime (recommended over
  exposing on-disk keys — see "SSH access" below)

The remaining sections up to [Plugins](#plugins) describe the **container**; the
conveyor itself needs none of it.

## Local build

1. Copy `.env.example` to `.env`.
2. Generate a `CLAUDE_CODE_OAUTH_TOKEN` on the host by running `claude setup-token`, then set it in `.env`.
3. Build the base image:

```bash
make build-base GIT_USER_NAME="Your Name" GIT_USER_EMAIL=you@example.com
```

`GIT_USER_NAME` and `GIT_USER_EMAIL` are **required** and have no default — they
become `/home/dev/.gitconfig` inside the image, so they author every commit made
in the container. To reuse your host identity:

```bash
make build-base \
  GIT_USER_NAME="$(git config --global user.name)" \
  GIT_USER_EMAIL="$(git config --global user.email)"
```

(The Makefile does not read `.env`; export the two variables or pass them per
invocation. `make build-base` and a bare `docker build` both fail with the
explicit reason when either is empty.)

`make build-base` also stages safe SSH client files from your local `~/.ssh` into the build context. It copies only `config`, `known_hosts`, and `known_hosts2`, and it skips private keys. A host with no `~/.ssh` is fine — the staging directory is created empty and the container relies on agent forwarding.

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
- **shipyard** (from the in-repo `delivery-pipeline` marketplace) — a Claude Code
  plugin (`plugins/delivery-pipeline/`) implementing the multilevel delivery
  pipeline from `docs/gsd_multilevel_delivery_pipeline.md`: `/shipyard:route`
  (entry router), `/shipyard:investigate` (deep investigation → ADR),
  `/shipyard:decompose` (ADR → ticket DAG), `/shipyard:deliver` (per-ticket
  worktree → PR babysat to green with CodeRabbit/Copilot reviewer
  re-initialization), and `/shipyard:bench` (off-conveyor direct work).
- **skill-creator**, **code-simplifier**, **github** (GitHub MCP server), and
  **typescript-lsp** — installed from the official `claude-plugins-official` marketplace
  (`anthropics/claude-plugins-official`). Plugin versions are pinned by the marketplace's
  GitHub ref at clone time. The `typescript-lsp` plugin wires `typescript-language-server`
  (already in the base image) into Claude Code, covering `.ts`, `.tsx`, `.js`, and `.jsx`.
- the **shipyard auto-route** `UserPromptSubmit` hook, into the image's own
  `~/.claude/settings.json`.

The base image bakes in:

- Claude Code CLI (`@anthropic-ai/claude-code`, pinned version) installed via npm.
- Git identity: whatever you passed as `GIT_USER_NAME` / `GIT_USER_EMAIL` (required build args, no default)
- Git defaults: `init.defaultBranch=main`, `push.autoSetupRemote=true`, `color.ui=auto`,
  `fetch.prune=true`, `pull.rebase=false`, `pull.ff=only`
- safe SSH client files from your local profile when present
- `context7-mcp` binary (baked in, no runtime `npx -y` needed)
- `typescript-language-server` and `typescript` for LSP support

Private keys are not baked into the image, and by default they are not mounted
into the running container either.

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

The container starts in `/workspace`, which is bind-mounted from `WORKSPACE_DIR`
(default `./workspace`). **The repo checkout itself is deliberately not mounted**
— it holds `.env` with your OAuth token, and the session runs with
`bypassPermissions`. Point `WORKSPACE_DIR` at whatever you want visible instead.

### SSH access

Authentication goes through the **forwarded SSH agent** by default: Compose binds
the agent socket to `/run/host-services/ssh-auth.sock` inside the container and
sets `SSH_AUTH_SOCK` to that path. On macOS, Docker Desktop proxies the host
agent at that magic path automatically — passphrase-protected keys and
certificate-based setups (e.g. Teleport) work without copying anything into the
container. On a Linux host, point the bind at your real agent socket by setting
`SSH_AUTH_SOCK_HOST=$SSH_AUTH_SOCK` in `.env`. Verify from inside the container
with `ssh-add -l`.

Your SSH **client config** is mounted read-only at `/home/dev/.ssh-host` and
copied by the entrypoint into a writable `/home/dev/.ssh` (writable so `ssh` can
record a new host key; existing files are never overwritten). The mount source
defaults to the build-staged safe subset (`config`, `known_hosts`) — so your
private keys stay on the host.

If you genuinely cannot use agent forwarding, set `SSH_DIR=${HOME}/.ssh` in
`.env` to mount your full `~/.ssh` read-only instead. That exposes your private
keys to the container; prefer the agent.

The host `~/.config/gh` directory is mounted read-only at `/home/dev/.config/gh`, so the GitHub CLI (`gh`) can use your existing host authentication inside the container. `make up` and `make run-docker` create `~/.config/gh` on the host if it does not exist (preventing Docker from creating a root-owned directory in its place). The `GITHUB_TOKEN` / `GH_TOKEN` environment variables are also forwarded into the container for token-based access.

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

`make up` creates the host directories the container mounts (including the state
directory) before starting, preventing Docker from creating root-owned paths in
their place.

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

Credentials land in `/home/dev/.claude/.credentials.json` and are mirrored to the
persisted state directory (see below), so they survive container recreation.
(If a half-finished attempt blocks a retry, run
`docker compose exec dev claude mcp logout atlassian-rovo` first.)

## Persistence

One host **directory** is bind-mounted for state that must outlive the container:

- `CLAUDE_STATE_DIR` (default `./.claude-state`) maps to
  `/home/dev/.claude-state`. The entrypoint restores
  `credentials.json` from it into `~/.claude/.credentials.json` at start and
  mirrors the live file back whenever it changes.

It is a directory rather than a single-file mount on purpose: a bind-mounted
*file* cannot be replaced by `rename(2)`, so any writer that saves atomically
would fail on it outright. An older layout used
`CLAUDE_CREDENTIALS_FILE=./.claude-credentials.json`; `make up` migrates that
file into the state directory automatically on first run.

Everything else under `~/.claude` is baked into the image or generated at startup
and is ephemeral — it is not persisted across container recreation.

The host's full `~/.claude` is never mounted.

`.cache-home` (mounted at `~/.cache`) accumulates per-session MCP server logs;
`make clean-cache` prunes the ones older than a week.

## LSP Support

TypeScript/JavaScript LSP support is provided by `typescript-language-server`
(shipped in the base image) and wired into Claude Code via the official `typescript-lsp`
plugin from `claude-plugins-official`. This covers `.ts`, `.tsx`, `.js`, and `.jsx` files.

The plugin is installed from the official marketplace during the overlay build and loaded
when Claude Code starts an interactive session.

## Plugins

Baked into the container image (hence all Claude Code plugins — on Codex the
equivalents are installed as skills/subagents by `make install-shipyard-codex`):

- **gsd-core** (`@opengsd/gsd-core`) — Claude Code delivery plugin with full profile, installed via npx.
- **andrej-karpathy-skills** — staged from pinned commit, registered via `claude plugin`.
- **shipyard** — in-repo (`plugins/delivery-pipeline/`); investigation → ticket DAG →
  per-ticket worktree/PR delivery. Commands: `/shipyard:route`,
  `/shipyard:investigate`, `/shipyard:decompose`, `/shipyard:deliver`,
  `/shipyard:bench`.
- **skill-creator** — from `claude-plugins-official`; helps create new Claude Code skills.
- **code-simplifier** — from `claude-plugins-official`; reviews and simplifies code.
- **github** — from `claude-plugins-official`; the official GitHub MCP server plugin.
- **typescript-lsp** — from `claude-plugins-official`; TypeScript/JS LSP via `typescript-language-server`.

## Deploy to Kubernetes

The manifests in `k8s/` run the same overlay image as a single-replica
StatefulSet you attach to with `kubectl exec`. One PVC backs `/workspace`,
`~/.cache` and the credential state directory via `subPath`.

1. Push the built overlay image to a registry reachable by the cluster and update
   the `image:` field in `k8s/statefulset.yaml`.
2. Create the real secret — `k8s/secret.example.yaml` is a template and is
   deliberately not applied by `make deploy-k8s`:

```bash
kubectl create secret generic claude-shipyard-secrets \
  --from-literal=CLAUDE_CODE_OAUTH_TOKEN="$(claude setup-token)" \
  --from-literal=GITHUB_TOKEN="$GITHUB_TOKEN" \
  --from-literal=GH_TOKEN="$GITHUB_TOKEN"
```

3. Apply manifests:

```bash
make deploy-k8s
```

4. Attach:

```bash
kubectl exec -it claude-shipyard-0 -- bash -lc 'cd /workspace && claude --dangerously-skip-permissions'
```

## Smoke tests

`make test-fast` needs neither Docker nor the network — run it on every edit:

```bash
make test-fast          # unit + graph + worktree + sentinel + docs + ssh-sync
make test-unit          # frontmatter parser, model policy, locks, front + sentinel verdicts
make test-graph         # Gate 2 contract + plan:post gate applicability, on fixtures
make test-worktree      # epic-branch.sh + ticket-worktree.sh against real git repos
make test-sentinel      # state-sync → gate/merge_scope → guard duty, against a stubbed gh
make test-docs          # README + .env.example invariants
make test-ssh-sync      # sync-local-ssh-config.sh behaviour
```

The rest build images or reach the network:

```bash
make test-k8s           # kubectl dry-run over k8s/
make test-base
make test-overlay
make test-runtime
make test-mcp-runtime
make test-codex-shipyard   # generator + installer produce valid Codex artifacts (needs network)
make test                  # everything, in order
```
