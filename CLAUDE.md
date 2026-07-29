# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repo is

This repo ships **the shipyard delivery conveyor** plus the environment it runs in. It contains no application code — it is infrastructure. Two deliverables, and they are frequently confused:

1. **The conveyor** (`plugins/delivery-pipeline/` + `capabilities/delivery-pipeline/`) — investigate → decompose → deliver, with its deterministic git/`gh`/graph layer and blocking GSD gates. It targets **two runtimes**: Claude Code (canonical) and the OpenAI Codex CLI (generated from the same commands by `scripts/gen-codex-shipyard.cjs`, installed host-side by `make install-shipyard-codex`). It also installs into host Claude Code (`make install-shipyard-claude-hook`, `make install-shipyard-capability`).
2. **The container** (`Dockerfile.base` + `Dockerfile`) — a remote **Claude Code** dev environment, runnable via Compose or deployable to Kubernetes, baking a pinned toolchain, the Claude Code CLI, Claude Code plugins (gsd-core, andrej-karpathy-skills, the in-repo `shipyard` conveyor, four official plugins) and default MCP server configs. The image is Claude-Code-only by design; Codex is never installed into it.

**Consequence for edits:** a behavior change to a command doc or a script belongs to the conveyor and therefore reaches BOTH runtimes — so it must not assume Claude-only capabilities (the Workflow tool is the standing example: absent on Codex, hence the Agent fallback). Codex artifacts are generated, never hand-edited; edit the Claude command and re-run the installer.

The `workspace/` directory is the mount point users do their actual work in at runtime; it is intentionally empty in the repo.

## Build & run

All workflows go through the `Makefile`. The image is built in two stages — base then overlay — and you almost always need both before running:

```bash
make build-base        # Dockerfile.base: OS, Node, Go, kubectl, helm, Claude Code CLI, context7-mcp, typescript-language-server
make build-dev-image   # Dockerfile: overlay that installs gsd-core + registers karpathy/shipyard + official plugins + the auto-route hook
make run-docker        # docker compose run --rm dev  (drops you into /workspace)
make deploy-k8s        # kubectl apply of k8s/{configmap,pvc,service,statefulset}.yaml
```

`make build-base` runs `sync-ssh-config` first (stages only `config`, `known_hosts`, `known_hosts2` from `~/.ssh` — never private keys; a host with no `~/.ssh` is fine and produces an empty staging dir). `make build-dev-image` runs `sync-karpathy-skills` first to stage the andrej-karpathy-skills plugin source into `.build/`. `make up` / `make run-docker` depend on `ensure-image` (builds when the overlay tag is missing) and `runtime-dirs` (creates every host path the compose mounts need, and migrates the legacy credentials file).

Before first run, copy `.env.example` to `.env`. Key vars: `CLAUDE_CODE_OAUTH_TOKEN` (from `claude setup-token` on the host), `CLAUDE_STATE_DIR` (default `./.claude-state`, the persisted remote-MCP OAuth state), `SSH_AUTH_SOCK_HOST`, `SSH_DIR` (opt-in: expose real `~/.ssh` including private keys — leave unset to use agent forwarding), `GITHUB_TOKEN`/`GH_TOKEN`, `GSD_CORE_VERSION` (optional pin override).

## Tests

```bash
make test-fast          # unit + graph + worktree + docs + ssh-sync — no Docker, no network
make test-unit          # frontmatter parser, model policy, ticket↔PR matching
make test-graph         # Gate 2 contract + plan:post gate applicability, on fixture projects
make test-worktree      # epic-branch.sh + ticket-worktree.sh against real local git repos
make test-sentinel      # state-sync → gate/merge_scope → sentinel duty, against a stubbed gh
make test-docs          # README + .env.example invariants
make test-ssh-sync      # sync-local-ssh-config.sh behavior
make test-k8s           # kubectl dry-run over k8s/
make test-base          # base image contents
make test-overlay       # overlay image / plugin install
make test-runtime       # full compose runtime (mounts, credential round-trip, hook)
make test-mcp-runtime   # MCP server config at runtime
make test-codex-shipyard# Codex generator + installer (needs network)
make test               # everything, in order
```

**Run `make test-fast` on every edit** — it is seconds, needs nothing installed, and covers the deterministic layer where the sharp bugs live.

`tests/smoke/docs-smoke.sh` is a contract on `README.md`, `.env.example`, `docker-compose.yml`, `Makefile` and `k8s/`: it greps for required phrases, checks the documented command surface against `plugin.json`, verifies every `make <target>` the README names exists, and asserts the mount invariants (no `${PWD}` mount, no single-file credentials mount, no mount over `/home/dev/.ssh`). **If you change documented behavior, update the README to match or `make test-docs` will fail.**

## Architecture

**Two-layer image, separated by change frequency.** `Dockerfile.base` (`claude-shipyard-base:test`) installs the slow-moving, pinned toolchain — versions are `ARG`s at the top (Node, Go, kubectl, helm, Claude Code CLI via npm `@anthropic-ai/claude-code`, context7-mcp binary, typescript-language-server). Every downloaded binary is checksum-verified. `Dockerfile` (`claude-shipyard:test`) is a thin overlay over the base that installs gsd-core and registers the remaining plugins; iterate here when changing plugins, not the base.

**Base image installs Claude Code via npm.** The base image runs `npm install -g @anthropic-ai/claude-code@<version>` with a pinned version controlled by the `CLAUDE_CODE_VERSION` build arg.

**Overlay image installs gsd-core and registers plugins.** The overlay runs `npx --yes @opengsd/gsd-core@<version> --claude --global --profile=full` during build, which writes Claude Code plugin configuration under `~/.claude`. The andrej-karpathy-skills plugin is staged via `scripts/sync-karpathy-skills.sh` (clones at a pinned commit `KARPATHY_SKILLS_REF`) into `.build/karpathy-skills/` and registered with `claude plugin`. The in-repo `shipyard` plugin (`plugins/delivery-pipeline/`) is copied to `/opt/delivery-pipeline` and registered the same way; it implements the delivery conveyor from `docs/gsd_multilevel_delivery_pipeline.md` (`/shipyard:route`, `/shipyard:investigate`, `/shipyard:decompose`, `/shipyard:deliver`, `/shipyard:bench`, plus deterministic scripts under `plugins/delivery-pipeline/scripts/`). Four additional plugins come from the official `claude-plugins-official` marketplace (`anthropics/claude-plugins-official`): `skill-creator`, `code-simplifier`, `github` (GitHub MCP server), and `typescript-lsp`. Their versions are pinned by the marketplace's GitHub ref at clone time. The overlay also installs the **shipyard auto-route `UserPromptSubmit` hook** into the image's own `~/.claude/settings.json`, so the container needs no manual setup for the router to surface. The host `~/.config/gh` directory is mounted read-only at `/home/dev/.config/gh` so `gh` can use host authentication.

**The GSD capability's plan:post gate is applicability-scoped.** The companion capability (`capabilities/delivery-pipeline/`) is installed at **global** scope, so its blocking `plan:post` gate runs in every GSD project on the machine. Gate 2's contract (a `delivery:` block, non-empty `files_modified`/`requirements`, no file overlap) belongs to the conveyor alone, so `checks/graph-gate.cjs` decides applicability **before** strictness: it passes when there are no plans, when no plan carries a `delivery:` block, or when `pipeline.graph_gate` is `false` — and fails closed for real conveyor projects. Adding a gate here without an applicability check breaks planning for every unrelated project in the container.

**The deterministic layer is shared and tested.** `plugins/delivery-pipeline/scripts/` holds the code the skills call instead of improvising git/gh:
- `frontmatter.cjs` — the YAML-subset parser for plan frontmatter. It either represents a construct or reports a structured error; it never half-parses. A trailing `# comment` used to be folded into the last `files_modified` entry, which silently voided Gate 2's file-overlap guarantee.
- `pipeline-config.cjs` — the single config reader plus the role × risk × attempt model policy and its matching reasoning effort (`model <role> [--json] [flags]`). **It only ever emits the tier aliases `opus`/`sonnet`/`haiku`/`fable`, because the Agent tool validates `model` against exactly that set** — a full model ID or a suffixed alias like `opus[1m]` is rejected on input. `fable` (Claude Fable 5, Opus-tier + 1M context) is the alias that expresses what `opus[1m]` was reaching for; it is paid, so it is opt-in only. Effort mirrors GSD's light/standard/heavy defaults and follows the resolved tier. Unknown config keys and non-alias values produce warnings rather than silent no-ops.

  **Config namespaces:** `delivery_pipeline.*` is the capability's own declared config — GSD-native, readable by the gate's `when:` clauses, settable through GSD's tooling — and it WINS over `pipeline.*`, which is shipyard's own namespace (`pipeline` is not a valid GSD config key, so `/gsd-config --set pipeline.x` is rejected). Prefer declaring new knobs in `capability.json` so they become GSD-settable.

  **GSD settings the conveyor obeys** (read, never written): `git.base_branch` outranks the repo default for epic cut/target — a project integrating into `develop` must not get epics off `main`; `git.branching_strategy` must be `none` or GSD creates its own branches while the conveyor owns branching (warned); `runtime` decides effort clamping AND whether a plugin-namespaced `agent_skills` entry resolves at all — `global:<plugin>:<skill>` works only on `claude` and is silently skipped elsewhere, so Codex needs the bare `global:shipyard-delivery-rules`; `response_language` governs how agents talk to the user, while shipped artifacts stay English.
- `validate-graph.cjs` — Gate 2. Collects every error before exiting; ancestor closures are computed over the topological order (a shared-visited recursion once cached truncated closures and rejected valid diamond graphs). It also owns the **repo boundary**: `delivery.repo` (a ticket in a sibling repository) makes identical paths in two repos not an overlap, keeps a cross-repo parent out of the cascade (`pr_base` must never name a branch from another repo), and flags `files_modified` entries that escape the repo root as `unreachable_paths` — a warning plus a flag rather than a gate failure, because one unreachable ticket must not stop delivery for the valid rest.
- `state-sync.cjs` — rebuilds delivery state from live GitHub. Note `gh pr checks` reports CI state through its **exit code** (8 = pending, 1 = failing/no checks) while still printing JSON, so a non-zero exit there is data, not an error. It also computes `reapable` — the reaper force-deletes branches, so that decision must be mechanical, not inferred. Every query is scoped to the ticket's **own repo** (`--repo`, `repos/<owner>/<name>/…`): watching the wrong repository made a ticket whose PR was merged next door read as `pending` forever, which blocked every dependent behind work that was already done. An unreachable foreign repo is a parked ticket, never an aborted sync. **Never add `reviewDecision` back to the bulk `gh pr list` window** — it is the one field that dominates the call (the same 1000 rows cost 41s with it and 7s without on a monorepo) and it is only read for OPEN PRs, so it comes from a separate open-only pass. state-sync runs on every babysit round, so its wall time is the conveyor's tick rate; `SHIPYARD_TIME=1` prints per-`gh`-call timings when it regresses.
- `front.cjs` — the **stop condition as code**. `computeFront(tickets, state, {parked, autoMerge})` sorts everything into actionable (execute/publish/fix/finalize/merge), waiting (ci/merge_human/checkpoint) and parked, and prints `fixpoint: YES|NO`; it also names the OWNER of each bucket (`sentinel.duty` = fix/finalize/merge — the guard's; execute/publish — the main loop's), which is the split that lets the two run at once. `merge` only becomes actionable with `autoMerge` AND a conform gate AND `merge_scope: 'stacked'`; state-sync ends every board with it and writes `.planning/graph/delivery-front.json`. This exists because prose could not hold the rule: runs serialized on `gh pr checks --watch` and read a `human_checkpoint` as "do nothing", then reported a fixpoint with a dozen tickets executable. Waiting on CI is deliberately "not a fixpoint, and not a reason to block". Session-only facts (an `escalate`, attempts > max) are invisible to GitHub, so they come in via `--parked` — without that the babysit loop re-offers an escalated PR forever.
- `sentinel.cjs` — the **PR sentinel's** core: `duty` (one action per open PR, plus the guard's own `clear` verdict), `merge` (the guarded ticket-PR → stack merge), `report`. The guard is what lets delivery cascade onward while open PRs are still being driven to green; before it, the run either serialized on CI or declared a fixpoint over a pile of unmerged green PRs. **`merge` re-verifies everything against LIVE GitHub** (open, undrafted, checks green, unresolved threads 0, a `gate_status: arch-review=conform` trailer in the body, not CHANGES_REQUESTED, not `human_checkpoint`) and refuses outside the stack — the base must be the phase epic or a parent ticket branch in the same repo. **The epic → integration-branch PR is never auto-merged**, whatever the config says: that boundary is what makes the epic a quarantine. Gated by `pipeline.auto_merge` (`epic` default | `off`) and `pipeline.sentinel` (`auto` | `off`), which the config reader keeps consistent with each other.
- `lock.cjs` — cross-process locking (`withLock`) and atomic replacement (`writeAtomic`). The sentinel runs CONCURRENTLY with the main loop, so `state-sync` writes state/yaml/front in one locked section, and `ticket-worktree.sh`/`epic-branch.sh` serialize anything that writes the shared `.git` (index.lock). A lock directory with no `owner.json`, or one older than the TTL, is taken over — a killed session must not wedge the next run.
- `ticket-worktree.sh` / `epic-branch.sh` — idempotent worktree and epic lifecycle. Both resolve refs that exist only as `origin/<name>`; a bare remote-only branch name does not resolve through `git rev-parse`, which used to break every resumed run.

Anything the skills are told to "decide" that can be computed belongs here instead. When adding to it, add a case to `tests/unit/` or the matching fixture smoke test in the same change.

**The Workflow path bypasses the skills' prose.** `workflows/*.mjs` build agent prompts deterministically, so anything the skill states in Markdown — the anti-injection framing, the artifact language — does NOT reach those agents unless the script says it too. That is the whole point of the path (no context leakage), and also its trap: a rule that lives only in a command doc is not in force there.

**Runtime config is merged non-destructively by the entrypoint.** `scripts/entrypoint.sh` is the container ENTRYPOINT. On every start it `jq`-merges baked MCP defaults into `~/.claude.json` using `(.existing // default)` semantics — adding `atlassian-rovo` (HTTP) and `context7` (stdio, baked binary) only if absent — pre-seeds bypass-permissions acceptance and per-directory trust for `/workspace` and each project inside it (`shipyard-trust <dir>` covers repos cloned later), copies SSH client files in from the read-only mount, and restores/mirrors the MCP credentials.

**Auth via CLAUDE_CODE_OAUTH_TOKEN.** The `CLAUDE_CODE_OAUTH_TOKEN` environment variable is the Claude Code subscription OAuth token, generated on the host via `claude setup-token` and passed into the container via `.env`. No host `~/.claude` directory is mounted.

**Persistence via a state DIRECTORY, not a file.** `CLAUDE_STATE_DIR` (default `./.claude-state`) is mounted at `/home/dev/.claude-state`; the entrypoint restores `credentials.json` from it into `~/.claude/.credentials.json` at start and mirrors the live file back whenever it changes. It must stay a directory: a bind-mounted *file* cannot be replaced by `rename(2)`, so any writer that saves atomically would fail on it. Everything else under `~/.claude` is baked into the image or generated at startup and is ephemeral.

**Mounts are deliberately narrow.** The repo checkout is **not** mounted (it holds `.env` with the OAuth token, and sessions run with `bypassPermissions`). SSH client files arrive read-only at `/home/dev/.ssh-host` — never over `/home/dev/.ssh`, which must stay writable so `ssh` can record host keys, and whose baked defaults must not be shadowed. The default `.ssh-host` source is the build-staged safe subset, so private keys are not in the container unless `SSH_DIR` opts in.

**Atlassian OAuth is bootstrapped in-container.** Because macOS stores OAuth tokens in the system Keychain (not a portable file), the browser-based Atlassian Rovo login must run inside the container via `make bootstrap-atlassian-oauth`. The host's full `~/.claude` is never mounted; the result is mirrored into `CLAUDE_STATE_DIR`.

**Runtime user is `dev` (uid 1000), home `/home/dev`, workdir `/workspace`.** Git identity and defaults are baked into `/home/dev/.gitconfig` at base-build time via `ARG`s.

## Conventions

- All shell scripts use `set -euo pipefail` and validate inputs/preconditions early with explicit error messages — match this when adding scripts.
- Tool versions are pinned as Dockerfile `ARG`s and surfaced as overridable Makefile variables; never hardcode an unpinned `latest`.
- The plugin (`plugins/delivery-pipeline/.claude-plugin/plugin.json`) and its capability (`capabilities/delivery-pipeline/capability.json`) ship as one product: bump both versions together, or `make test-overlay` fails on the drift check.
- In a `cmd | grep -q` assertion, remember `set -o pipefail` reports `cmd`'s exit status — capture the output first when the command is expected to fail.
