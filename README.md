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
claude plugin marketplace add serhii-nochevnyi/shipyard
claude plugin install shipyard@shipyard
```

For the host hooks and the shared GSD capability, run the installers from this
checkout:

```bash
make install-shipyard-claude-hook
make install-shipyard-capability
make doctor
```

The hook installer writes the auto-route hook and a complete stop-gate module
bundle under `~/.claude/hooks/`. It updates only the Shipyard entries in
`~/.claude/settings.json`, removes the old single-file stop-gate entry, and
leaves other hooks untouched. Re-run it after updating Shipyard, then start a
new Claude session or reload hooks with `/hooks`.

Use a different Claude home when testing or when several installations must be
kept separate:

```bash
CLAUDE_HOME=/path/to/claude-home make install-shipyard-claude-hook
CLAUDE_HOME=/path/to/claude-home make remove-shipyard-claude-hook
```

### OpenAI Codex CLI

```bash
npx --yes @opengsd/gsd-core@latest --codex --global
make install-shipyard-codex
```

The installer replaces Shipyard's generated bundle at `~/.codex/shipyard`,
refreshes only Shipyard-owned skills and agents, and preserves unrelated Codex
configuration. Set `SHIPYARD_CODEX_PHASE=1` when only investigation and
decomposition skills should be installed. Set `CODEX_HOME` or
`AGENTS_SKILLS_DIR` to use non-default locations.

## First run

Open the target repository and describe the work. The router chooses the
appropriate entry point. You can also invoke it directly:

```text
Claude Code: /shipyard:route "describe the change"
Codex CLI:   $shipyard-route "describe the change"
```

The target repository needs an initialized `.planning/` directory. If it is not
initialized, Shipyard runs the required GSD setup before continuing. To inspect
runtime settings for a target project, run the tuner from that project's root:

```bash
node /path/to/shipyard/plugins/delivery-pipeline/scripts/gsd-tune.cjs --runtime claude
node /path/to/shipyard/plugins/delivery-pipeline/scripts/gsd-tune.cjs --runtime claude --apply
```

`make gsd-tune` and `make gsd-tune-apply` are equivalent when run from this
checkout against this checkout's own `.planning/config.json`.

## Workflow

The same four entry points exist on both runtimes. Claude uses slash commands;
Codex uses the corresponding `$shipyard-*` skill names.

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
$shipyard-route "add the requested behavior"
$shipyard-investigate "understand the failure and options"
$shipyard-decompose
$shipyard-deliver
$shipyard-bench "apply this small change in the current worktree"
```

`route` is advisory. `investigate`, `decompose`, and `deliver` are
deliberate workflow transitions because they create or update durable planning
and delivery artifacts. `bench` follows the full research, plan, implement,
verify, and review discipline for its size, but it stays in the current
worktree and does not create tickets, branches, PRs, merges, or commits unless

The delivery loop cold-starts from the graph and current GitHub state, selects
available work, records dispatch ownership, and repeats implementation,
verification, review, and CI repair until the front reaches a fixpoint. A stop
gate keeps a Claude session alive while actionable work or a required CI wait
remains. Codex resumes from the same graph on the next turn.

## Model ladder

The active policy is ADR-014. Claude Code uses Anthropic models only; Codex
uses OpenAI models only. The two provider grids are independent and a dispatch
never substitutes a model from the other runtime.

Claude resolves native aliases at launch:

- executor work starts on Sonnet and moves to Opus only when critical evidence
  or an explicit checkpoint requires it;
- judgment roles use Opus with role-specific effort;
- Fable is a Claude-only measured ceiling and requires delivery_pipeline.fable:
  auto after the consent decision.

Codex selects generated agents from the OpenAI ladder. The shipped compatibility
palette is:

{
  "delivery_pipeline": {
    "codex_models": "gpt-5.6-sol:high@0.153.1, gpt-5.6-sol:xhigh@0.153.1"
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
    node plugins/delivery-pipeline/scripts/pipeline-config.cjs model executor --json
    node plugins/delivery-pipeline/scripts/pipeline-config.cjs model ci-fix --json --signature-state repeat

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
  "model": "opus",
  "effort": "high",
  "effort_applied": "high",
  "observed_model": "gpt-5.6-luna",
  "observed_effort": "high"
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
dependency closure, Codex bundle manifest, and version markers. A warning means
the installed runtime is older than this checkout; an error means the runtime
cannot enforce the expected hook or bundle contract.

Before a delivery ship check, verify the native projection is current:

```bash
node plugins/delivery-pipeline/scripts/gsd-sync.cjs --check --json
```

If it reports stale files, run the write path from the target project and then
repeat the check:

```bash
node plugins/delivery-pipeline/scripts/gsd-sync.cjs
```

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
