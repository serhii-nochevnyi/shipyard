# Phase 38 Research: runtime model ladder recovery

## Scope

Phase 38 reconnects the native Claude and Codex model ladders to production
Shipyard delivery, investigation, and decomposition. The phase stays intact;
there is no Phase 39. Ticket plans remain the implementation contract, and Jira
is not used.

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

The current T-38-04 path accepts `gsd_role`, then records
`gsd_launch_mechanism: typed-gsd-callback`; `codex-runtime-host.cjs` does not
apply that role to a child. Its receipt is therefore not proof of a GSD agent.
T-38-04 must request a native child with the exact configured role, bind child
session evidence to its parent, and verify role, model, and effort. Recent
native 0.155.1 session records provide the parent ID, typed role, and
`source.subagent.thread_spawn` fields. Their optional `agent_path` can be null,
so the host must validate the exact installed role file and digest before
launch, then compare any native path when the CLI supplies one. A missing child
or a role/config override must fail closed. GSD-owned agent files are read-only
inputs and must not be rewritten by Shipyard. Native spawn requests accept an
explicit model and reasoning effort; require those values to equal the
resolver's selection and verify them again from the child session's own turn
metadata. The parent session's model is not evidence for the child.

### Sandboxed Git commits

The configured host has global `commit.gpgsign=true` and a local GPG agent; the
Codex `workspace-write` sandbox treats Git metadata as read-only on macOS. The
pipeline nevertheless asks model workers to commit and has no signed-commit
verification gate. Environment scrubbing by itself cannot make the worker a
trusted signer. T-38-03 will add the shared host-side finalizer; workers return
ready/blocked without committing or pushing. The host validates the worktree,
ticket scope, branch and base, creates a signed commit with the configured
signer, verifies its signature, and only then accepts the artifact or performs
a required repair push. Missing signing capability or an out-of-scope delta
blocks publication. The child must not receive the GPG agent socket or signing
credentials; the live proving-ground check must verify that boundary.

### Plugin references under the child sandbox

Workflow prompts currently pass absolute `${CLAUDE_PLUGIN_ROOT}` paths such as
`inv-research.md`, `drift-check.md`, `ci-fix.md`, and `review-fix.md`. Claude's
child runs with outside-worktree reads blocked, so it cannot read those
references. T-38-03 will resolve only exact workflow-to-file mappings from a
host allowlist, embed the reference contents in the prompt, and reject arbitrary
paths, traversal, and symlink escapes. Executable files such as the PR
reinitialization helper are not reference documents: the trusted host reads
review state and performs publish/reinitialization actions itself.

## Existing implementation seams

- `plugins/delivery-pipeline/scripts/dispatch-boundary.cjs` owns
  resolve → validate → launch → receipt and remains the common authorization
  boundary.
- `plugins/delivery-pipeline/scripts/claude-runtime-host.cjs` and
  `codex-runtime-host.cjs` own native CLI launches and session evidence.
- `claude-workflow-host.cjs` registers typed Workflow bindings; its scripts
  fail when the binding is absent, which is the correct fail-closed behavior.
- `codex-delivery-host.cjs` is a production entrypoint for static and dynamic
  roles, but its typed GSD callback currently labels rather than launches the
  named role.
- `context-packet.cjs` intentionally admits project-root sources only. It is
  not the plugin-reference loader; T-38-03 adds a separate fixed allowlist.
- `role-artifact.cjs` validates worktree and commit identity but does not verify
  GPG signatures. T-38-03's signed finalizer must run before artifact
  acceptance.

## Ticket boundaries and order

1. T-38-01 pins the runtime model identifiers and is merged into the epic.
2. T-38-02 proves Claude model/effort from exact hook/transcript evidence and
   adds the typed-agent launch mode needed by the Claude decomposition host.
3. T-38-03 connects Claude delivery and investigation, safely supplies
   references, and creates the shared host-side signed-commit finalizer.
4. T-38-04 depends on T-38-03, connects Codex delivery and native typed GSD
   children, adds the Codex decomposition entrypoint, and uses the shared
   finalizer.
5. T-38-06 depends on T-38-02 and connects Claude typed GSD decomposition. It
   can run alongside T-38-03/T-38-04 because its production entrypoint and tests
   are separate.
6. T-38-05 waits for T-38-04 and T-38-06, then routes deliver, investigate,
   and decompose through only connected provider hosts and completes independent
   provider rollout.

This keeps investigation in the already-planned T-38-03 and adds one
Claude-decomposition ticket. Signed commit finalization is shared by the two
runtime host tickets rather than becoming another phase or ticket.

## Verification constraints

- Unit fixtures may validate native event parsing, but only the opt-in live
  smoke can report a live pass.
- Keep capability probes allowance-free. Use one real Claude smoke and one
  real Codex smoke in disposable worktrees; each must prove model, effort,
  named-agent application where relevant, scoped edit/Bash access, and commit
  signature behavior.
- A missing, changed, ambiguous, or cross-session native evidence field is a
  refusal, not an inferred success.
- Provider credentials and model selection remain separate. Codex uses OpenAI
  models only; Claude uses Anthropic models only. Codex executor baseline stays
  Luna/max, Sol requires existing promotion signals, and Claude Opus remains
  `claude-opus-5-5`.
- Every merge still requires green checks and review; a merged PR or a capability
  probe does not prove live agent application.
