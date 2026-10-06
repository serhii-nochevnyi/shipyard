---
name: investigate
description: "Deep investigation (loop 1): pick up an open INV or create a new one; intake interview, research fan-out, iterative dialogue, Gate 1 → ADR. Use when a topic is unclear, needs research, or the key decisions are not made yet — before any tickets or code."
argument-hint: "[raw problem statement — optional]"
allowed-tools:
  - Read
  - Write
  - Edit
  - Bash
  - Grep
  - Glob
  - Agent
  - Workflow
  - AskUserQuestion
---

# /shipyard:investigate

You run loop 1 of the delivery conveyor (see `docs/gsd_multilevel_delivery_pipeline.md`
if it exists in the repo). State lives ONLY in the artifacts under `.planning/investigations/` —
no dependency on session memory. There may be gaps of weeks between sessions.

> **Communication language.** These instructions and every artifact you produce
> (INV documents, DECISIONS, the ADR, code) are in English. But when you talk to
> the *user* — the intake interview, AskUserQuestion prompts, progress notes,
> closure proposals — reply in the user's language (match the language they write
> to you). English is for the pipeline; the user's language is for the conversation.

## Runtime and host selection

Run `node ${CLAUDE_PLUGIN_ROOT}/scripts/pipeline-config.cjs resolve --json` and
take the active runtime from `config.gsd.runtime`; it must be exactly `claude`
or `codex`. Keep that runtime fixed for the investigation. Claude routes through
`${CLAUDE_PLUGIN_ROOT}/scripts/claude-investigation-host.cjs --request-file
<json>`. Codex routes each research line through
`${CLAUDE_PLUGIN_ROOT}/scripts/codex-delivery-host.cjs --args-file <json>` with
`role: research`. Claude's request carries the four canonical line selections;
Codex's builder request carries the investigation packet and four canonical
lines, and its host resolves each line's selection. Each host builds `createDispatchBoundary`,
calls `boundary.dispatch`, and returns the durable application receipt; accept
research output only after that receipt is verified.

Use `run-rollout.cjs status --json` to read the selected provider's controller
status at `runtimes.<runtime>.launches_enabled`. This flag gates autonomous
controller launches; it does not disable a command-issued research run.
Controller rollout is provider-specific and does not change host selection.
An unavailable or refused host cannot switch to the peer. Never invoke the
native Workflow or Agent surface outside its shipped host; if the selected host
is unavailable, stop that research line and report the runtime status.

On a non-zero exit from a host launch, read its `hint[<CODE>]` stderr line and
explain the hint and its remedy to the user in the user's language; never
propose bypassing the host or switching runtime because of it.
Preserve the original refusal code, cause, command, request digest and recovery
references, including refusals before `controller.begin`. Missing capability or
installed role evidence is an admission refusal; it is never native completion.

## Host evidence directory

Every host this command launches keeps its run state, sealed research
artifacts, and finalization keys under `~/.local/state/shipyard/` — one
family of directories (`claude/`, `claude-decompose/`, `codex/`,
`codex-decompose/`) per runtime and role, always outside the model
worktree. `claude-delivery-host.cjs` (the engine behind
`claude-investigation-host.cjs`) resolves its root under `claude/` in the
user's home directory and does not check it against the worktree;
`codex-delivery-host.cjs` resolves its root under `codex/` and refuses to
start if that root would resolve inside the worktree. A path under
`~/.local/state/shipyard/…` appearing during or after an investigation is
expected host evidence, never the model's own output leaking onto disk —
it is not a leak and not something to clean.

## Step 0 — Determine the mode

Read `.planning/investigations/` (may not exist):

- There are open INVs (without a `CLOSED` marker in the name or `status: closed` in the PROBLEM.md
  frontmatter) AND the user gave no argument → show them with their status
  (how many open questions remain — count `- [ ]` in OPEN-QUESTIONS.md)
  and ask via AskUserQuestion: continue one of them or start a new one.
- The user gave a problem statement as an argument → new INV (Step 1).
- No open ones and no argument → ask for a problem statement.

## Step 1 — Start a new INV

1. Preconditions:
   - `.planning/investigations/` is created if missing; no GSD project is
     required — decompose bootstraps it from the accepted ADR.
   - codebase map: if there is no `.planning/codebase/`, run
     `/gsd-map-codebase` or warn that research will work without a map.
2. Pick a number: the next free `INV-NNN`, a slug of 2–4 words of the topic.
3. Create `.planning/investigations/INV-NNN-slug/`, copying ALL templates from
   `${CLAUDE_PLUGIN_ROOT}/templates/inv/`.
4. **Intake interview**: a raw statement is not accepted silently. Ask via
   AskUserQuestion the questions that are missing for PROBLEM.md: for whom / current
   pain / what success will be / what is definitely out of scope. Ask only what you
   cannot derive from the statement. Fill in PROBLEM.md.
5. **Research fan-out**: build the initial four-line request once from the
   canonical graph and investigation files with
   `deliver-dispatch.cjs build research <INV-id>`. The builder reads
   `PROBLEM.md`, `RESEARCH-CONTRACT.md`, `DECISIONS.md`, and the canonical
   ticket graph, then attaches a verified context packet with required source
   content and digest-bound optional references. The packet has an explicit
   empty backlog; when optional file bodies exceed the token ceiling, it keeps
   their paths and hashes and the researcher reads only relevant files on
   demand. It rejects an invalid investigation id or a missing input file. It
   never chooses a model or effort. Pass the active runtime explicitly:

   ```bash
   node ${CLAUDE_PLUGIN_ROOT}/scripts/deliver-dispatch.cjs \
     build research "$invId" --runtime "$runtime" > "$requestFile"
   ```

   Pass those unchanged bytes to the selected host with `--request-file
   "$requestFile"` for Claude or `--args-file "$requestFile"` for Codex.
   The builder supplies the investigation scope, phase, canonical worktree and
   a fresh UUID run identity. Keep that identity bound to this attempt's request,
   controller and receipts. Do not patch the envelope, borrow a `T-...` execution
   subject, or reuse a failed controller record with a fresh dispatch scope.
   Before launch, require the selected runtime's capability evidence and installed
   role/policy evidence. The host validates the actual parser, role, repository,
   source and policy bindings before its native launcher.

   Complete context, input and manifest refresh **before** taking the planning
   snapshot and acquiring a writer. While a callback owns its writer, freeze
   all planning inputs and preserve its active run and lease. Do not refresh
   planning manifests merely to update progress. After authenticated writer
   release, a new attempt may refresh inputs and take its own snapshot.

   Use the canonical line names `system-state`, `alternatives`, `constraints`,
   and `risks`. The generated request has already passed its runtime's exported
   validator. The selected host owns runtime selection, model/effort resolution,
   and its durable receipt; do not add model or effort fields to the request.
   Claude gets one targeted packet per research line. Codex gets one packet
   bound to the investigation and all four lines. The builder-created packets
   use the authenticated source revision, ADR-014 policy hash, required problem
   and contract material, and declared source references. The research workflow
   passes each packet as
   `context.contextPacket` and fences it as DATA in each line prompt. The
   adapter validates the role, subject, policy hash, root and live source
   digests before the callback runs. Missing ids, altered sources, symlink
   escapes and a packet carrying model/capability/callback fields are hard
   failures. The packet's explicit empty backlog and token/omission accounting remain
   visible to the researcher; required problem, ADR and gate material is never
   summarized away.

   The Codex request uses the `research` role through
   `codex-delivery-host.cjs`, with the investigation scope and verified packet.
   That host resolves the runtime-specific selection, crosses
   `createDispatchBoundary`, and records an application receipt. The request
   file contains only bounded serializable inputs; the host owns callbacks,
   capabilities, recording, and application evidence.

   Never call `spawn_agent`, the native Agent tool, a generic session, or a
   direct `agent()` function for a research line. There is no unverified
   subprocess or cross-provider fallback.

   Accept a research result only after its durable boundary receipt is verified.
   Pass the workflow `artifactContract: planning.v1`, the absolute worktree and
   investigation paths, the authenticated `sourceRevision`, repository identity,
   policy hash, and one contained `artifactPaths.<line-id>` for each of the four
   lines. The prompt tells each worker to write its complete finding to that
   exact path. The host-owned trusted consumer validates the file bytes and
   seals a `shipyard.role-artifact.v1` envelope with
   `shipyard.research-result.v1`, subject `<INV-ID>:<line-id>`, the exact source
   revision, repository, policy hash, and an `artifact_index` reference. The
   shared runtime adapter rejects a stale subject/source/policy identity, a
   missing or altered index, and a forged application receipt before the
   bounded result is accepted. The callback may return only the line id,
   `completed|blocked`, a summary of at most 500 characters, and the validated
   artifact reference; never return a full draft inline.

   The same shared sealer also produces the sibling
   `shipyard.decomposition-result.v1` envelope for `/shipyard:decompose`'s
   planner and checker callbacks — one contract, both loops, both runtimes.

   The synthesizer reads the four validated references by targeted ranges or
   files and copies every source, constraint, uncertainty, and command-backed
   finding into `RESEARCH.md`, `OPTIONS.md`, `RISKS.md`, and
   `OPEN-QUESTIONS.md`. Missing or duplicated canonical lines remain hard
   errors. The Codex command path uses the same validator and boundary receipt;
   it has no inline or direct researcher fallback.
6. Show the user a summary: how many options, key risks, the list of
   open questions. Next — Step 2.

### Recovering one failed research line

When one line fails, the other three lines' sealed artifacts are kept
untouched: the result names the failed line and its real cause (never a
generic repair message), and the fan-out stays failed until all four lines
are sealed — a partial result is never reported as success. Re-dispatch
only the failed line, carrying the three sealed sibling references (each
one's `id`, `status`, `summary`, and verified artifact reference and
digest) so the host can verify them instead of re-running them.

Inspect the original dispatch/controller recovery and sealed artifacts before
building a failed-line retry. An unknown outcome or foreground timeout requires
recovery against the original identity. If the original run is terminal failed,
keep its request, primary refusal, receipts and artifacts immutable; after
authenticated writer release, build one fresh attempt with matching run id,
repository/worktree, investigation/phase and source bindings. A partial retry
uses the supported host's failed-line and sealed-sibling fields below; it must
not relaunch accepted sibling lines or reopen the old failed controller record.

For Claude, invoke the same entry point again with a request file whose
`args.lines` holds that one line and whose `args.sealedLines` holds the
three sealed sibling references:

```text
node ${CLAUDE_PLUGIN_ROOT}/scripts/claude-investigation-host.cjs \
  --request-file /absolute/path/investigation-request.json
```

For Codex, invoke the same delivery host again with an args file whose
`context.investigation.lines` holds that one line and whose
`context.investigation.sealedLines` holds the same three sealed sibling
references:

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/codex-delivery-host.cjs \
  --args-file /absolute/path/research-line-request.json
```

Both hosts verify every sealed sibling reference before sealing the full
`shipyard.research-result.v1` envelope; a missing or tampered sibling
refuses, naming that sibling, rather than trusting the request.

For subsequent decomposition, use unchanged output from
`deliver-dispatch.cjs build decomposition <INV-id|ADR-id> --phase <phase>
--runtime <runtime>`. Codex's planning context host validates the packet before
delegating to the typed decomposition host. A direct ADR must be accepted and
contain decisions; its decomposition run subject binds the requested phase and
input. ADR research and executor/integrator INV/ADR subjects refuse. Planning
admission does not authorize execution. Continue using the supported linked INV
until the complete direct ADR record/host guard is verified by T-47-06; the
installed native acceptance remains T-47-08's obligation. Preserve the already
accepted INV-014 research lines instead of launching them again.

## Step 2 — Iterative dialogue (the main resume mode)

The goal of each session: close OPEN-QUESTIONS and lock down positions.

- Questions that research can answer — close them with agents yourself.
- Decision questions — bring them to the user (AskUserQuestion, with options from
  OPTIONS.md and trade-offs in the previews, where appropriate).
- EVERY accepted position IMMEDIATELY write into DECISIONS.md in the template format
  (## decision / **Why** / **What was rejected** / **Scope fence**). Mark the
  corresponding question `- [x]` with a link.
- Hypotheses that need verification by code — propose `/gsd-spike "<idea>"`.
- Questions with no reachable answer — move them into RISKS.md with a mitigation
  (with the user's agreement) and close them.

## Step 3 — Closing (Gate 1)

When no `- [ ]` remains in OPEN-QUESTIONS.md — propose closing yourself:

1. `node ${CLAUDE_PLUGIN_ROOT}/scripts/validate-inv.cjs <INV-dir>` — must be OK.
2. Generate the ADR package in `.planning/architecture/`:
   - `ADR-NNN-<slug>.md` — from DECISIONS.md, using
     `${CLAUDE_PLUGIN_ROOT}/templates/adr/ADR.md` as the template, in a format that
     `/gsd-plan-phase --ingest` parses (Nygard: Status/Context/Decision/Consequences;
     each locked decision is one bullet under `## Decision`, and scope fences use
     `## Out of scope`; do not use nested `###` headings for machine-read sections);
   - if there is material: INTERFACES.md, DATA-MODEL.md, ROLLOUT.md.
3. Check the ADR before closing:
   `node ${CLAUDE_PLUGIN_ROOT}/scripts/adr-ingest.cjs --check --input <ADR path>`
   must exit 0; on exit 1, fix the ADR and re-run. The INV does not close until
   this check passes.
4. Update the PROBLEM.md frontmatter (the template ships it pre-stubbed):
   `status: closed`, `closed: <YYYY-MM-DD>`, `adr: <path to the ADR>`.
   Step 0 reads exactly these keys to tell an open INV from a closed one.
5. Tell the user the next step: `/shipyard:decompose`.

## Rules

- Do not write code. Investigation is read-only with respect to the codebase (except the artifacts).
- Do not make decisions for the user. Agents prepare options — the human chooses.
- Every statement about the codebase — with a file path.
