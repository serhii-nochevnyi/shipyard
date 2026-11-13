# Shipyard

Shipyard is an artifact-driven delivery pipeline for Claude Code and OpenAI
Codex CLI. It moves a change through investigation, planning, implementation,
verification, review, and delivery while keeping the two runtimes on their own
model providers.

The Claude Code plugin is the canonical source. The Codex installer generates
the equivalent skills, agents, and shared scripts from that source. The graph in
`.planning/graph/` is the durable record of work; a session can end and the
next one can resume from it.

## Requirements

Install these on the host before using Shipyard:

- Node.js 24 or newer
- Git and GitHub CLI (`gh`), authenticated for repositories you deliver
- A Git commit signing key: OpenPGP (`gpg`, the default) or SSH
  (`gpg.format=ssh` with `user.signingkey` set to a public key file, a private
  key with a sibling `.pub`, or a `key::` literal; `ssh-keygen` must be on
  `PATH`). `gpg.format=x509` is not supported
- Claude Code with an Anthropic Pro or Max account, or OpenAI Codex CLI through
  ChatGPT
- GSD Core for the selected runtime; the Shipyard installers refresh it unless
  `SHIPYARD_GSD_AUTO_INSTALL=0` is set

Claude work stays on Anthropic models. Codex work stays on OpenAI models. The
pipeline records the requested tier, concrete model, effort, session identity,
ticket, and outcome so later model tuning is based on measured work.

## Install

### Claude Code

For the published plugin:

```bash
claude plugin marketplace add open-gsd/gsd-core
claude plugin marketplace add serhii-nochevnyi/shipyard
claude plugin install shipyard@shipyard
```

For a complete install or upgrade from this checkout, including GSD, use
`make install-shipyard-marketplace-claude`. It refreshes an unpinned marketplace;
if an older Shipyard marketplace is pinned to a tag, it switches that
registration to the current release source and restores the old registration
if installation fails. Start a new Claude session after upgrading.

For the host hooks and the shared GSD capability, run the installers from this
checkout:

```bash
make install-shipyard-claude-hook
make install-shipyard-capability
make doctor
```

The hook installer writes the auto-route hook and a complete stop-gate module
bundle under `~/.claude/hooks/`. The route hook reads the submitted prompt from
stdin, stays silent for `<task-notification>` turns and expanded slash
commands, and otherwise injects the auto-route policy, which routes unclear or
research-needing work to `/shipyard:investigate`. It updates only the Shipyard
entries in `~/.claude/settings.json`, removes the old single-file stop-gate
entry, and leaves other hooks untouched. Re-run it after updating Shipyard,
then start a new Claude session or reload hooks with `/hooks`.

Use a different Claude home when testing or when several installations must be
kept separate:

```bash
CLAUDE_HOME=/path/to/claude-home make install-shipyard-claude-hook
CLAUDE_HOME=/path/to/claude-home make remove-shipyard-claude-hook
```

### OpenAI Codex CLI

Shipyard is a native marketplace plugin with six discoverable skills. Install
Shipyard, its **GSD marketplace plugin dependency**, native agents, routing,
observer and GSD gates together from this checkout:

```bash
make package-shipyard-codex
bash scripts/ensure-gsd-core.sh --launch-marketplace codex --source "$PWD"
```

For a published release, use the same installer without `--source` to register
`serhii-nochevnyi/shipyard`. It refreshes an existing Git marketplace before
reinstalling Shipyard, or switches an existing local Shipyard marketplace to
that Git source and restores the prior registration if the new marketplace or
plugin cannot be installed. The repository contains separate Claude and Codex
marketplace catalogs; both identify Shipyard as `shipyard@shipyard`.

Codex has no documented declarative plugin dependency installer. Its Install
button installs the package; a trusted `SessionStart` hook or the first Shipyard
skill then runs the same idempotent host bootstrap, which installs/enables
`gsd-core@gsd-core`. Review and trust bundled hooks in Codex to enable startup
setup. The one-command installer above completes setup immediately without
requiring hook trust. It does not bypass that trust decision. Start a new session
after setup so Codex loads newly registered native agents.

The package owns the visible skills. Fully converted workflows live privately
in `~/.codex/shipyard-native-skills`, agents in `~/.codex/agents`, and the shared
runtime payload in `~/.codex/shipyard`. These are supporting host components,
not another installed plugin. Migration backs up only unchanged skills owned by
the previous installer; modified or unowned collisions stop setup with their
paths. Backups are outside skill discovery in `~/.codex/shipyard-plugin`.

The bootstrap reads available models from `codex debug models`, validates the
native ADR-014 grid, and installs the GSD runtime payload at the dependency
plugin's version. It uses the existing Codex subscription login and does not
call a model or require an API key. `CODEX_HOME` and `AGENTS_SKILLS_DIR` remain
supported for the installer. Launching needs no exported variable; see
[Launch and upgrade](#launch-and-upgrade).

For a published Git marketplace, upgrade and reinstall, then start a new
session:

```bash
codex plugin marketplace upgrade shipyard
codex plugin add shipyard@shipyard
```

For Claude Code, refresh the marketplace, update the installed plugin, and
restart Claude Code to apply it:

```bash
claude plugin marketplace update shipyard
claude plugin update shipyard
```

For local development, regenerate the package and run the one-command installer
again. The generated version suffix changes when package contents change, so
Codex does not reuse stale cached files. The package fingerprint also causes
the bootstrap to refresh host components. Do not run the
legacy direct bundle installer alongside marketplace installation.

### GSD dependency on both runtimes

Claude declares `gsd-core@gsd-core` in the plugin manifest and allows that
cross-marketplace dependency in its catalog. Add the GSD marketplace once as
shown above; Claude then installs missing dependencies natively. For complete
Claude plugin and host setup from a matching release checkout:

```bash
make install-shipyard-marketplace-claude
```

Both full installers verify that the GSD plugin is installed and enabled. The
npm GSD runtime payload is also needed by host tools; it is not a substitute for
the marketplace plugin. Dependency installation errors are propagated instead
of reporting a partially working Shipyard installation as successful.

### Dogfooding unreleased hosts

Run unreleased worktree code on purpose, through a separate install root that
never overwrites the release cache:

```bash
make install-shipyard-dogfood-claude
make install-shipyard-dogfood-codex
bash scripts/ensure-gsd-core.sh --launch-marketplace codex --source "$PWD"
```

Each of these defaults to a home dedicated to this checkout when no override
is given: `${XDG_STATE_HOME:-$HOME/.local/state}/shipyard/dogfood/<runtime>/<digest>`,
where `<digest>` is the first 16 hex characters of the sha256 of the
checkout's realpath. A second checkout of the same repository hashes to a
different digest, so two dogfood sessions on the same machine never share a
root. Both targets above accept `DOGFOOD_ROOT=/path/to/dogfood` to override
it; the marketplace command instead honors an explicitly set `CODEX_HOME`. An
explicit value always wins over the default. A Codex dogfood install
explicitly aimed at the shared default `CODEX_HOME` (or `~/.codex`) is
refused, and the message names the dedicated path instead.

Codex capability evidence for these installs is covered in
[Launch and upgrade](#launch-and-upgrade). Each writes a `.shipyard-provenance.json` record
(install kind, source sha, source root, dirty flag, version) into the dogfood
root instead of `$CLAUDE_HOME` / `$CODEX_HOME`'s release cache; the Claude
installer prints the `claude --plugin-dir <dir>` launch line and leaves hooks
untouched unless `--wire-hooks` is passed directly to the script. `make doctor`
reports a release cache whose files match no release tag, and reports a
dogfood root as a warning naming its source sha and dirty flag: `own dogfood`
when the recorded source root matches this checkout, `foreign dogfood` when it
was installed from a different one. A dogfood host is refused by the sentinel
the same way every host is when a PR targets the repository's default
integration branch, so dogfooding cannot reach a default-branch merge.

### Launch and upgrade

Hosts locate their own installed bundle, its Codex home and its capability
evidence. A Claude or Codex launch, including a marketplace or dogfood launch,
needs neither `CODEX_HOME` nor `SHIPYARD_CODEX_CAPABILITIES_FILE` exported.

- An explicit `CODEX_HOME` or capability path that disagrees with the installed
  bundle is refused with an `ENV_CONFLICT` message naming both values. Either
  unset the variable, or reinstall into the named home so both agree.
- A source checkout reads the evidence an install left at
  `${CODEX_HOME:-~/.codex}/shipyard/codex-capabilities.json`, so it needs no
  variable, including `codex-agent.cjs select`. The direct installer
  (`scripts/install-shipyard-codex.sh`, `make install-shipyard-dogfood-codex`)
  reads that evidence from `codex debug models` itself, as the marketplace
  bootstrap does. Only a machine with no Codex install and no Codex CLI has
  none: install first, or set `SHIPYARD_CODEX_CAPABILITIES_FILE`
  (`--capabilities-file` for `select`) to a host JSON document, which always
  wins over discovery. Nothing is ever synthesized from the policy.
- Check a host from the project root before launching. Every host entry takes
  `--preflight`, alone or with the host's usual request argument:
  `node <bundle>/scripts/<host>.cjs --preflight`, for `claude-delivery-host.cjs`,
  `claude-investigation-host.cjs`, `claude-decompose-host.cjs`,
  `claude-role-host.cjs`, `codex-delivery-host.cjs`, `codex-decompose-host.cjs`
  and `codex-planning-context-host.cjs`. It is read-only, collects every
  incompatibility, prints `preflight: ok` or `preflight: <n> incompatibilities`
  with a remedy per finding, warnings and notes on stderr, and a
  `shipyard.host-preflight.v1` JSON result on stdout. It exits 0 when nothing is
  incompatible and 1 otherwise. `deliver-dispatch.cjs launch` runs the same check
  in-process and prints the same findings before it spawns anything; it has no
  `--preflight` flag of its own. The Codex capability probe with
  `--capability-only` keeps exiting 0.
- A file in `.planning/graph/provenance/` that the host did not record is not
  adopted and not trusted: admission and preflight refuse it
  (`LEGACY_HISTORY_UNKNOWN_MEMBER`, naming the path). That includes the files an
  older release wrote and the history a Shipyard 0.73 launch adopted. Move those
  files out of the directory (it is untracked runtime state) and re-run; the
  next launch records its own. A `.DS_Store`, a `.gitkeep` and an orphaned
  `<id>.json.<pid>.<uuid>.tmp` staging file are not records and never block. A
  malformed or forged authority catalogue, or a provenance directory that is a
  symlink, refuses with `ARCHIVE_AUTHORITY_INVALID`.
- `make test-installed-launch` runs the installed-launch acceptance core. It
  first checks, against a fixture install only, whether a non-interactive driver
  of the GSD UI path is found and prints either a run record or a declared-gap
  record carrying the check that justified it. It never reads the operator's
  GSD install, so a real install is covered by the live receipts at release.

## First run

Open the target repository and describe the work. The router chooses the
appropriate entry point. You can also invoke it directly:

```text
Claude Code: /shipyard:route "describe the change"
Codex CLI:   $shipyard:shipyard-route "describe the change"
```

`/shipyard:investigate` needs only a `.planning/investigations/` directory and
runs before any other GSD state exists. `/shipyard:decompose` bootstraps a
missing GSD project — `config.json`, `ROADMAP.md`, `REQUIREMENTS.md` — from the
accepted ADR the first time it runs against an uninitialized `.planning/`. To
inspect runtime settings for a target project, run the tuner from that
project's root:

```bash
node /path/to/shipyard/plugins/delivery-pipeline/scripts/gsd-tune.cjs --runtime claude
node /path/to/shipyard/plugins/delivery-pipeline/scripts/gsd-tune.cjs --runtime claude --apply
```

`make gsd-tune` and `make gsd-tune-apply` are equivalent when run from this
checkout against this checkout's own `.planning/config.json`.

## Workflow

The same four entry points exist on both runtimes. Claude uses slash commands;
Codex uses the corresponding `$shipyard:shipyard-*` skill names.

| Entry | Use it when | Result |
| --- | --- | --- |
| `route` | The scope is known but the right loop is not | Read-only classification |
| `investigate` | The problem needs research and decisions | Research package and ADR |
| `decompose` | An accepted ADR must become executable work | GSD plans and a validated ticket graph |
| `deliver` | Tickets are ready for implementation | Worktrees, PRs, review, CI, and merge evidence |
| `bench` | A small change, existing ticket, or explicit no-ticket task | Direct work in the current worktree |

Typical Claude commands:

```text
/shipyard:route "add the requested behavior"
/shipyard:investigate "understand the failure and options"
/shipyard:decompose
/shipyard:deliver
/shipyard:bench "apply this small change in the current worktree"
```

Typical Codex commands:

```text
$shipyard:shipyard-route "add the requested behavior"
$shipyard:shipyard-investigate "understand the failure and options"
$shipyard:shipyard-decompose
$shipyard:shipyard-deliver
$shipyard:shipyard-bench "apply this small change in the current worktree"
```

`route` is advisory. `investigate`, `decompose`, and `deliver` are
deliberate workflow transitions because they create or update durable planning
and delivery artifacts. `bench` follows the full research, plan, implement,
verify, and review discipline for its size, but it stays in the current
worktree and does not create tickets, branches, PRs, merges, or commits unless

The delivery loop cold-starts from the graph and current GitHub state, selects
available work, records dispatch ownership, and repeats implementation,
verification, review, and CI repair until the front reaches a fixpoint. A stop
gate keeps a Claude session alive only when `/shipyard:deliver` armed that
session; other sessions, including forked sessions, are not held open. Codex
resumes from the same graph on the next turn.

## Model ladder

The active policy is ADR-014. Claude Code uses Anthropic models only; Codex
uses OpenAI models only. The two provider grids are independent and a dispatch
never substitutes a model from the other runtime.

Claude keeps Sonnet and Fable aliases, and pins Opus launches to claude-opus-5-5:

- executor work starts on Sonnet and moves to Opus only when critical evidence
  or an explicit checkpoint requires it;
- judgment roles use Opus with role-specific effort;
- Fable is a Claude-only measured ceiling and requires delivery_pipeline.fable:
  auto after the consent decision.

Codex selects generated agents from the OpenAI ladder. The shipped compatibility
palette is:

{
  "delivery_pipeline": {
    "codex_models": "gpt-6.1-sol:high@0.155.1, gpt-6.1-sol:xhigh@0.155.1"
  }
}

The routed policy records the logical rung, concrete model, effort, runtime,
provider, dispatch id and application receipt. A missing or ambiguous runtime,
unsupported model, stale generated agent or missing receipt blocks the launch.

The codex_models value above is compatibility input, not canonical Codex bundle
policy. Routed Codex projects should omit that legacy palette and use the ADR-014
native model grid instead.
Inspect the effective policy from the target project:

    node plugins/delivery-pipeline/scripts/pipeline-config.cjs resolve
    node plugins/delivery-pipeline/scripts/pipeline-config.cjs dispatch '{"role":"executor","runtime":"claude","signals":{}}'

## Usage observability


The attribution ledger connects a dispatch to a Claude or Codex transcript. It
stores routing and identity metadata, never prompts or credentials:

```bash
cat <<'JSON' | node plugins/delivery-pipeline/scripts/usage-attribution.cjs record --stdin
{
  "dispatch_id": "<dispatch id>",
  "runtime": "codex",
  "provider": "openai",
  "session_id": "<session id>",
  "source": "/path/to/transcript.jsonl",
  "ticket": "T-01-01",
  "role": "executor",
  "task_level": "routine",
  "backend": "codex-agent",
  "model": "luna",
  "effort": "max",
  "effort_applied": "max",
  "observed_model": "gpt-6-luna",
  "observed_effort": "max"
}
JSON
```

Use `runtime: "claude"` and `provider: "anthropic"` for Claude. The ledger
rejects a provider mismatch. A Claude message or request id is preferable when
several launches share one session; a Codex session id is sufficient for a
single launch.

Generate a read-only report from explicit transcript files:

```bash
node plugins/delivery-pipeline/scripts/usage-report.cjs \
  /path/to/claude.jsonl /path/to/codex.jsonl \
  --attribution .planning/graph/usage-attribution.jsonl
```

The report separates Anthropic and OpenAI totals, models, effort, ordinary work,
advisor work, ticket attribution, coverage, and comparison eligibility. Codex
counters are cumulative session observations, so they are not added once per
response. Missing or ambiguous attribution is reported instead of being folded
into a model's efficiency result.

### Subscription observation

The interactive Claude session reports its quota windows through a reversible
statusline wrapper. It forwards the statusline input unchanged to your existing
renderer, keeps its stdout, stderr and exit status, and records only the quota
fields:

```bash
ACCOUNT_LABEL=claude-max-1 make install-shipyard-claude-statusline
bash scripts/install-shipyard-claude-statusline.sh --check
make remove-shipyard-claude-statusline
```

The installer changes only `statusLine` in `~/.claude/settings.json`, and only
when it is a `{"type": "command", ...}` object. It keeps an ownership record in
`~/.claude/shipyard-statusline/owned.json`. Removal restores the previous value
only if the installed value is still in place; a statusLine you edited is kept.
`--check` prints `installed`, `foreign` or `absent` and writes nothing.
`ACCOUNT_LABEL` is an operator-declared local label; without one, samples are
`unattributed`. E-mail, user ids and plan details are never stored.
`make test-statusline` runs the collector and installer smoke.

Private per-account samples live in
`~/.local/state/shipyard/<runtime>/subscription/` (files 0600, directories
0700) and are kept after removal. Tracked reports carry only derived values.
The usage reader also reads quota records from host transcripts under
`~/.local/state/shipyard/claude/…`, `~/.local/state/shipyard/claude-decompose/…`
and `$CODEX_HOME/sessions/…`. Codex parent-session and idle observation are
`unverified`, and every result is `inconclusive` until matched cohorts exist.

## Verification and maintenance

Run the deterministic suite from this checkout:

```bash
make test-fast
make test-unit
make test-docs
make test-codex-shipyard
make test-releases
make test
```

Use the smaller checks while editing:

```bash
make test-graph
make test-worktree
make test-worktree-gates
make test-sentinel
make test-hooks
```

The delivery loop bounds host commands so a stalled GitHub, reviewer, GSD, or
projection call cannot hold a session forever. GitHub reads default to 60
seconds, GSD projection and reviewer subprocesses to 120 seconds, and a
timeout remains unavailable evidence rather than green. Operators can tune the
limits with `SHIPYARD_GH_TIMEOUT_MS`, `SHIPYARD_GSD_SYNC_TIMEOUT_MS`,
`SHIPYARD_REVIEWER_TIMEOUT_MS`, `SHIPYARD_GRAPH_GATE_TIMEOUT_MS`, and
`SHIPYARD_UAT_GATE_TIMEOUT_MS`; `SHIPYARD_INTERNAL_COMMAND_TIMEOUT_MS` also
limits synchronous helper calls from `ci-wait.cjs`. Each value is capped by
the runtime.

The full suite keeps network-backed Codex generation outside `test-fast`. The
documentation smoke test checks the supported host commands, plugin command
surface, runtime separation, generated model palette, and removal of retired
execution paths.

Run the host installation diagnostic at any time:

```bash
make doctor
node scripts/shipyard-doctor.cjs --json
```

It checks the source metadata, Claude hook command, complete stop-gate
dependency closure, Codex bundle manifest, version markers, the installed
Claude route hook, and the Codex AGENTS.md route block. A warning means the
installed runtime is older than this checkout or a managed hook has drifted;
an error means the runtime cannot enforce the expected hook or bundle
contract.

Before a delivery ship check, verify the native projection is current:

```bash
node plugins/delivery-pipeline/scripts/gsd-sync.cjs --check --json
```

If it reports stale files, run the write path from the target project and then
repeat the check:

```bash
node plugins/delivery-pipeline/scripts/gsd-sync.cjs
```

Change the pinned digest of a runtime-owned file (`runtime-adapters.cjs`,
`claude-dispatch-adapter.cjs`) only through:

```bash
make refresh-runtime-digests
```

It rewrites `tests/unit/runtime-file-digests.json` and prints one
`Runtime-Digest-Refresh: <path>` line per changed file. The existing refresh
checks and source-contract tests compare actual current runtime bytes against
the checked-in SHA-256 pins and continue rejecting stale pins or corrupted
runtime bytes that do not match those pins.

The legacy `node scripts/check-runtime-digest-trailer.cjs` command delegates to
`refresh-runtime-digests.cjs --check` without writing pins. It checks current
bytes only, ignores the legacy `--base` argument, and does not inspect history.

## Release and live verification

`make test-live` runs one live round per runtime (`bash tests/live/live-round.sh
--runtime claude`, then `--runtime codex`), stopping at the first failure. Each
round needs the runtime CLI and `gh` on `PATH` and authenticated, plus
`SHIPYARD_LIVE_REPO=<owner>/<throwaway-repo>` naming a disposable repository,
and writes a receipt to
`~/.local/state/shipyard/live/<version>/<tree sha>/<runtime>.json`. The Codex round clears `CLAUDECODE`/`CLAUDE_CODE_*` so it can run
from inside a Claude Code session; point `CODEX_HOME` at the Codex install
being released when it is not the default home.

```bash
make release VERSION=<x.y.z>
```

`make release` refuses to tag a release unless both runtimes have a passing,
matching live receipt for the exact plugin version and tree sha, no older than
7 days; it names the missing or stale runtime and the `make test-live` command
to re-run. `VERSION` is required and must match
`plugins/delivery-pipeline/.claude-plugin/plugin.json`.

## Boundary fixtures

```bash
make capture-fixtures BOUNDARY=claude-stream
make capture-fixtures BOUNDARY=codex-agent-stream
```

`make capture-fixtures` runs the real CLI once, scrubs home paths, tokens and
session ids from its output, and writes a provenance-stamped fixture under
`tests/fixtures/captured/` recording the CLI version. Re-capture a boundary
after a CLI upgrade changes its output shape, or when
`tests/unit/boundary-fixtures.test.cjs` warns about a `cli_version` mismatch,
then update that boundary's registry entry under
`tests/fixtures/captured/boundaries/` with the printed fixture paths.

## Planning files in target projects

Stop tracking `.planning/` in a target project once its conveyor is set up
(D-16), the one-time migration `pr-hygiene.cjs` expects:

```bash
node /path/to/shipyard/plugins/delivery-pipeline/scripts/planning-untrack.cjs --project-root <target-project-root>
node /path/to/shipyard/plugins/delivery-pipeline/scripts/planning-untrack.cjs --project-root <target-project-root> --apply --confirm untrack-planning
```

`make untrack-planning` is the equivalent dry run when run from this checkout;
add `CONFIRM=untrack-planning` to apply. It refuses on a dirty worktree, on the
repository's default branch, when `.planning/` is already untracked, or inside
the Shipyard repository itself, which is always exempt.

## Troubleshooting

**The hook does nothing.** Run the Claude installer again, inspect the generated
`~/.claude/hooks/shipyard-stop-gate/` directory, and start a new session. The
installer validates every local module dependency before changing settings.

**A session uses an old route or model.** Finish or restart the session after an
installer update. Existing sessions retain their runtime environment; new
sessions read the refreshed generated bundle. Compare the session transcript
with the usage report and the dispatch ledger instead of inferring a model from
the requested tier alone.

**The board shows no work but delivery cannot finish.** Run `state-sync`, read
`delivery-front.json`, and follow the reported action. A CI wait is still live
work until the watcher returns or records an escalation.

**A worktree is dirty or unavailable.** Preserve its changes, inspect the ticket
state and `git worktree list`, then resume delivery. The reaper refuses to remove
unproven or dirty worktrees.

**The graph check fails.** Run
`node plugins/delivery-pipeline/scripts/validate-graph.cjs` from the target
project, correct the plan dependency or ownership evidence, and rerun the
command. Do not edit generated graph files by hand.

**Migrating an existing project.** Runtime state under `.planning/graph/`
(everything except `tickets.json` and `tickets.yaml`) is no longer tracked, and
pulling the change deletes those files from a checkout that still tracks them.
Migrate first, then update the plugin, while no delivery session, sentinel or
`ci-wait` is running. Copy `.planning/graph` aside; run
`git checkout -- .planning/graph` (local edits to `tickets.json|yaml` are lost,
the copy keeps them); pull or merge; copy every file back except `tickets.json`
and `tickets.yaml`; then run `state-sync`. A project that keeps tracking the
state is refused with `WORKTREE_DIRTY`, which names the untracking command.

## Repository layout

```text
plugins/delivery-pipeline/       Claude commands, rules, and shared scripts
capabilities/delivery-pipeline/  GSD gates and capability metadata
scripts/gen-codex-shipyard.cjs   Codex artifact generator
scripts/install-shipyard-*.sh    Host installers
tests/                           Unit and deterministic smoke checks
docs/                            Pipeline protocol and measurement reference
```

The detailed protocol is in
[`docs/gsd_multilevel_delivery_pipeline.md`](docs/gsd_multilevel_delivery_pipeline.md).

### Bound CI repair requests

Build a CI repair from the ticket worktree with
`node "$SHIPYARD_ROOT/scripts/deliver-dispatch.cjs" build ci-fix T-01-01 --runtime codex --pr 123 --failure-file "$PWD/dist/.shipyard-ci-failure.log" --graph /path/to/project/.planning/graph`.
Use `--runtime claude` for Claude Code. The evidence must be a nonempty regular
file inside the canonical ticket worktree; copy external logs there first. Both
builder and host refuse symlinks and external paths. Save the resulting JSON outside the worktree.
Launch Codex with `codex-delivery-host.cjs --args-file <request.json>` or Claude
with `claude-delivery-host.cjs --workflow fix-round --request-file <request.json>`.
The request carries the canonical graph selector, PR, HEAD, PLAN digest, and
CI evidence path and digest. Both hosts recheck the live open PR and original
inputs immediately before launch. CI repair and base reconciliation run in
separate rounds: after a base merge, capture current CI evidence and build a new
request. Agent output cannot substitute an application receipt; the host verifies
PLAN checks before signing a repair commit.

### Native push checks and review bases

Managed publication installs a real Git `pre-push` hook before pushing. For manual
pushes, install it once in the target checkout:

```bash
node "$SHIPYARD_SCRIPTS/install-shipyard-git-hook.cjs" install \
  --worktree /path/to/checkout --project-root /path/to/planning-project \
  --graph /path/to/planning-project/.planning/graph
```

From this source checkout, `make install-shipyard-git-hook WORKTREE=/path/to/checkout`
installs the same hook. Uninstall with the script's `uninstall --worktree PATH`
command. Installation preserves existing hooks, `core.hooksPath`, argv and stdin;
uninstall restores the previous configuration. Conflicting higher-priority Git
configuration or altered managed files cause a refusal.

The hook checks the actual commit IDs supplied by Git, including non-HEAD and
multiple branch updates. Deletions have no content to check. Tags and other
non-branch refs are reported as unmanaged. Working-tree edits do not affect a
push check. For an existing destination branch, the check compares the remote
commit supplied by Git directly with the pushed commit (`remoteOid..localOid`),
including force pushes; already published comments are not checked again. If the
remote commit is unavailable locally, fetch the destination branch and retry.
For a new destination branch, the review base comes from its open PR, then an explicit
base, a repository-qualified graph/board branch match, or project `git.base_branch`.
A conflicting recorded or explicit base is refused with a diagnostic. A source
branch's own upstream is insufficient. Refusals name `base`, `base_source` and
`file:line` findings. The old Bash tool hook no longer infers pushes from command
text; manual pushes require the native Git hook.

Use `comment-policy.cjs check T-01-01 --worktree PATH --base BASE --head COMMIT`
for a committed snapshot, or `--working-tree` for a consistent disk snapshot.
These flags are mutually exclusive. Functional repository annotations can be
preserved with an exact repository rule in `.planning/config.json`:

```json
{
  "pipeline": {
    "comment_docblocks": {
      "acme/app": {
        "tags": ["@ai-generated", "@dataProvider", "@var", "@param", "@return", "@throws"],
        "public_methods": true
      }
    }
  }
}
```

Rules are opt-in per repository. They permit bounded functional annotations and,
with `public_methods`, PHPDoc immediately before public methods. Unknown tags,
history prose and malformed annotations remain findings; cleanup preserves
accepted annotations.

### Executor recovery and retained scripts

A trusted executor host can finish clean committed work ahead of the ticket base.
It authenticates the dispatch and pinned plan, checks scope and ancestry, verifies
the exact tree again, then adds a signed attestation commit. The original commit
is retained. HEAD, tree, index or verification changes invalidate finalization.
An empty base-to-HEAD delta still cannot be published as work.

New executor manifests retain immutable dispatch history and authenticated receipt
references. The host prepares a successor without deleting the old history. For a
legacy manifest that predates authenticated history, provide its original digest
and receipt store before preparing a successor:

```bash
node "$SHIPYARD_SCRIPTS/role-artifact.cjs" prepare --role executor \
  --worktree /path/to/checkout --boundary-store /path/to/original/receipts \
  --artifact-digest ORIGINAL_MANIFEST_SHA256
```

The digest and original receipt must authenticate the manifest and complete evidence;
changed or missing historical bytes are refused. Dispatch `launch`, `wait` and
`status` return `boundary_store`; a pending launch can report its locator before
an authenticated host dispatch ID is available.

Claude installation retains a content-addressed plugin bundle outside its prunable
version cache and sets `SHIPYARD_SCRIPTS` in Claude settings. Old bundles are retained
for running sessions. Claude commands honor an explicit `SHIPYARD_SCRIPTS` override. Codex
installation keeps its existing stable `$CODEX_HOME/shipyard/scripts` bundle.
Native Git hooks retain their own immutable payload under the repository's common
Git directory and survive removal of the original plugin cache.

### Executor sandbox extensions

Executors and repairs run in the runtime's OS sandbox. They can write only to the
ticket worktree, and network access is off. The host installs locked dependencies
before launch, so `pnpm install` / `npm ci` are not needed inside the sandbox. When
a toolchain still needs to write a cache or reach a registry (corepack, fnm
multishells, a test runner cache), declare it in the project root's
`.planning/config.json`:

```json
{
  "delivery_pipeline": {
    "executor_sandbox": {
      "allow_write": ["~/.cache/node/corepack", "~/.local/state/fnm_multishells"],
      "allowed_domains": ["registry.npmjs.org"]
    }
  }
}
```

`allow_write` takes absolute or `~/` paths, without globs. The host resolves them
before launch and refuses `/`, the home directory, any ancestor of the ticket
worktree, the repository and its Git directory, and paths that overlap host-owned
state such as `~/.ssh`, `~/.gnupg`, `~/.claude`, `~/.codex`, `~/.config/gh` and
`~/.local/state/shipyard`. `allowed_domains` takes host names or `*.domain`
patterns. Claude applies it as `sandbox.network.allowedDomains`. Codex applies
only `allow_write`, keeps executor network access off, and prints a notice.
Read-only review roles never receive these extensions. The configuration is
always read from the project root, never from the ticket worktree.

### Session scope and Jira configuration

Use `front.cjs --run-id RUN --store-dir STORE --graph GRAPH --json` and
`stop-gate-arm.cjs arm --session-id SESSION --run-id RUN --store-dir STORE --graph-dir GRAPH`
to bind a session to an authenticated run. Host results expose `run_id` and
`run_store` for these selectors. The run records its canonical graph,
which can live outside the target checkout. Its front counts owned ticket work
while retaining global dependencies and capacity facts. The stop gate recomputes
that scoped front; unrelated sessions do not hold it open or change its board.
Scoped stop ledgers are stored per run and session; an unchanged repeated stop
does not wake the model or overwrite another session's ledger. Disarm an existing
marker before binding the session to a different run.

`jira-export.cjs plan --ticket T-01-01 --repo acme/app --project APP --json`
exports that ticket, its transitive dependencies and required epics/links. Omitting
`--ticket` retains full-graph export. Descriptions are bounded to 12 KB and retain
the complete source-plan pointer.

Jira transitions are configured by target status **names**, rather than workflow
transition IDs. Projection remains disabled until a map is configured; its local
plan prints a configuration hint when the map is empty. For example:

```json
{
  "pipeline": {
    "jira_transitions": {
      "branched": "In progress",
      "pr-open": "On review",
      "merged": "Done"
    }
  }
}
```

An epic can have its own Jira issue instead of borrowing its first ticket's key.
Map the phase number (`1` and `01` are the same phase) or the phase directory name
to a key under `delivery_pipeline.epic_jira`:

```json
{
  "delivery_pipeline": {
    "epic_jira": { "1": "APP-100", "02-billing": "APP-200" }
  }
}
```

A configured key becomes the epic's `jira` in `tickets.json`, its
`feat/<KEY>-<slug>` branch name and the epic PR title, and `jira-export.cjs plan`
looks the epic up by that key and never creates it. An invalid key or a phase
absent from the graph is reported and skipped. Phases without an entry keep the
key derived from their first ticket.

Export lookups also check the issue's `Source of truth` line: an issue found by
its shipyard label is updated only when that line names this step's exact plan
path, and is otherwise refused as another graph's issue. An issue with no such
line is still updated.

Use names available in the project's Jira workflow and review
`jira-project.cjs plan --json` before applying a projection. No tracker update is
performed by planning or exporting.
