# Phase 38 Research: runtime model ladder recovery

## Scope

Phase 38 reconnects the native Claude and Codex model ladders to production
Shipyard delivery, investigation, and decomposition. The phase stays intact;
ticket plans remain the implementation contract, and Jira is not used.

## Current evidence

### Claude Code 2.1.280

A real CLI launch confirmed that the `SessionStart` payload contains the exact
`session_id` and `transcript_path`, and identifies a custom GSD agent through
`agent_type`. The native transcript records the loaded custom agent as
`agentSetting`. The host should capture the hook payload and read the returned
transcript path; scanning `projects/*` is unnecessary and can select an
ambiguous file. Anthropic's current hook reference documents the common
`session_id`/`transcript_path` fields and optional SessionStart `agent_type`:
https://code.claude.com/docs/en/hooks.

`--restricted --agent gsd-plan-checker` alone refuses because restricted mode
hides ambient custom agents. A later live check showed that supplying the
installed agent definition through `--agents` permits `--agent gsd-planner`
under `--restricted`. The scoped edit and Bash operations succeeded, outside
writes were denied, and a project SessionStart hook was ignored. Typed launches
therefore retain `--restricted` and the explicit tool, prompt, and sandbox
limits. Claude Code 2.1.280 emits the loaded role in a separate
`type: "agent-setting"` transcript record with the same `sessionId`, rather
than in every assistant record. Every typed result must match that record and
the hook's `agent_type`.

Installed GSD role files declare independent `effort` values. The restricted
`--agents` launch supplies only their prompt and scoped tools, so those source
values are inert. T-38-06 removes `model` and `effort` from the temporary role
definition and verifies the CLI-applied values in native assistant records;
it never rewrites installed GSD files.

Claude's sandbox applies to Bash but not command hooks or Read/Write/Edit tools.
Keep SessionStart evidence outside the model's Bash writable paths and deny
Claude filesystem-tool access to its absolute temporary path. Reference:
https://github.com/anthropics/claude-code/blob/main/examples/settings/README.md

### Codex CLI 0.155.1

`codex exec --help` exposes no top-level `--agent` option. The native
multi-agent feature is enabled with `--enable multi_agent`; registered agents
are spawned as child threads. OpenAI's Codex CLI protocol documents
`ThreadSpawn` parent-thread and agent-role metadata and custom role definitions:
https://github.com/openai/codex/blob/rust-v0.155.1/codex-rs/protocol/src/protocol.rs.

T-38-04 resolved the earlier label-only callback gap. Its Codex host launches
the exact typed child role, supplies the resolver's model and effort, and binds
the child transcript to the parent thread. The host verifies the installed
agent definition and its developer instructions before accepting the receipt.

Two live Codex 0.155.1 typed spawns showed that the child `session_meta.agent_path`
is the native task path, such as `/root/plan_checker_ready`, not the role TOML
path. The child transcript's developer-role response item contains the exact
installed `developer_instructions`. T-38-04 now correlates the parent spawn
task, child `agent_path`, role, and parent thread, and uses that developer record
to prove the invocation-pinned role definition actually loaded. It validates
the installed role file and digest before launch, compares any native path the
CLI supplies, and verifies the child's own model and effort metadata. Missing
children and role/config overrides fail closed; installed GSD files remain
read-only.

### Sandboxed Git commits

The configured host has global `commit.gpgsign=true` and a local GPG agent; the
Codex `workspace-write` sandbox treats Git metadata as read-only on macOS.
T-38-03 added the shared host-side finalizer: model workers return
ready/blocked without committing or pushing, and the trusted host validates
scope, branch, base, and declared file delta before creating and verifying the
signed commit. T-38-04 reuses the finalizer. Missing signing capability or an
out-of-scope delta blocks publication. The live proving-ground check must
verify that children cannot access the GPG agent or signing credentials.

### Plugin references under the child sandbox

Claude children cannot read plugin reference files outside their worktree.
T-38-03 now resolves fixed workflow references from a host allowlist, embeds
their contents in prompts, and rejects arbitrary paths, traversal, and symlink
escapes. Executable helpers remain host-owned; the trusted host reads review
state and performs publish/reinitialization actions itself.

## Existing implementation seams

- `plugins/delivery-pipeline/scripts/dispatch-boundary.cjs` owns
  resolve → validate → launch → receipt and remains the common authorization
  boundary.
- `plugins/delivery-pipeline/scripts/claude-runtime-host.cjs` and
  `codex-runtime-host.cjs` own native CLI launches and session evidence.
- `claude-workflow-host.cjs` supplies the binding through the shipped Claude
  delivery host for executor, repair, drift, and investigation workflows.
- `claude-decompose-host.cjs` supplies the typed GSD decomposition entrypoint.
- `codex-delivery-host.cjs` and `codex-decompose-host.cjs` are production
  entrypoints for delivery and typed GSD roles.
- `context-packet.cjs` intentionally admits project-root sources only. It is
  not the plugin-reference loader; T-38-03 added a separate fixed allowlist.
- `role-artifact.cjs` validates role artifacts; the shared T-38-03 finalizer
  verifies host-created commit signatures before publication.

## Remaining delivery host gap

`/shipyard:deliver` dispatches `pr-sentinel`, `arch-review`, and `integrator`
through the mandatory boundary. T-38-07 adds the Claude host for the two
judgement roles. The sentinel also needs a round-to-ticket membership bridge:
the current dispatch overlay is ticket-bound, while its evidence and launch
identity cover a round. The command and reference docs attribute that bridge to
T-33-08, but T-33-08 implements fenced session ownership; it does not implement
membership projection. T-38-08 adds the sentinel host path and authenticated,
atomic round projection. T-38-05 waits for both tickets before documenting a
complete route.

## Ticket boundaries and order

1. T-38-01 pins current runtime model identifiers.
2. T-38-02 proves Claude model/effort from exact hook and transcript evidence.
3. T-38-03 connects Claude delivery and investigation, resolves approved
   references, and supplies the shared signed-commit finalizer.
4. T-38-04 connects Codex delivery and typed GSD children through native
   subagent evidence.
5. T-38-06 connects Claude typed GSD decomposition.
6. T-38-07 adds Claude architecture-review and integration host entrypoints.
7. T-38-08 adds the Claude sentinel host and authenticated round-membership
   projection.
8. T-38-05 waits for T-38-04, T-38-06, T-38-07, and T-38-08, then routes all
   delivery roles, investigation, and decomposition through provider-specific
   hosts and completes independent rollout.

T-38-01 through T-38-04 and T-38-06 have merged into the epic (PRs #190–195,
including the live-smoke receipt follow-up). T-38-05 remains in progress;
T-38-07 and T-38-08 close the remaining Claude host and round-ownership gaps.
The generated verification and UAT projections were refreshed after those two
ticket plans were added.

## Verification constraints

- Unit fixtures may validate native event parsing, but only the opt-in live
  smoke can report a live pass.
- Keep capability probes allowance-free. Run the runtime, typed-GSD, and
  remaining-role live smokes in disposable worktrees only by explicit opt-in;
  each must prove model, effort, role where relevant, scoped edit/Bash access,
  and host-created commit signatures where the role publishes code.
- A missing, changed, ambiguous, or cross-session native evidence field is a
  refusal, not an inferred success.
- Provider credentials and model selection remain separate. Codex uses OpenAI
  models only; Claude uses Anthropic models only. Codex executor baseline stays
  Luna/max, Sol requires existing promotion signals, and Claude Opus remains
  `claude-opus-5-5`.
- Every merge still requires green checks and review; a merged PR or a capability
  probe does not prove live agent application.
