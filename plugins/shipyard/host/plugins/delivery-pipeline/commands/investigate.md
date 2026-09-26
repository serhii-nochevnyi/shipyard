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
Codex requests carry one line's signals and scoped context, and its host
resolves that line's selection. Each host builds `createDispatchBoundary`,
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
5. **Research fan-out**: prepare the four declared line selections for the fixed
   runtime and route them through its shipped host. Never call the compatibility
   `pipeline-config.cjs model` reader, compose a model or effort in this command,
   or let a session/default selection leak into the launch. For Claude, resolve
   each selection through the routed `pipeline-config.cjs resolveDispatch`
   bridge before launch. The host boundary verifies application of that exact
   selection. The base is Opus/medium and only an explicit
   `complexity: very-complex` signal escalates research to Opus/high; the
   `alternatives` line does not promote the rung. For Codex, the base is
   Sol/high and the same explicit very-complex signal escalates to Sol/xhigh.
   Keep each line's declared signals and context attached to that line. For
   Codex, send each line's signals to its host request — for example,
   `type: alternatives` or `complexity: very-complex`. The host resolves and
   applies the selection; the command does not pass model, agent-file, or
   effort overrides. Do not reuse one line's selection for another.

   For Claude, invoke the fixed investigation entry point once with the bounded
   request file containing the four line selections:

   ```text
   node ${CLAUDE_PLUGIN_ROOT}/scripts/claude-investigation-host.cjs \
     --request-file /absolute/path/investigation-request.json
   ```

   Before the fan-out, build one packet for each research line with
   `${CLAUDE_PLUGIN_ROOT}/scripts/context-packet.cjs`. Use the investigation
   worktree as `root`, role `research`, subject `${invId}:${line.id}`, the
   authenticated `sourceRevision`, the ADR-014 policy object and its
   `policy_hash`, the full problem/contract reference plus every declared
   source reference, and `roleContext: { problem_statement, source_refs }`.
   Include the current backlog selection, source hashes and a
   `whySelected` map. Put the resulting serializable object in
   `line.contextPacket`; the research workflow passes it as
   `context.contextPacket` and fences it as DATA in each line prompt. The
   adapter validates the role, subject, policy hash, root and live source
   digests before the callback runs. Missing ids, altered sources, symlink
   escapes and a packet carrying model/capability/callback fields are hard
   failures. The packet's explicit empty backlog and overflow record remain
   visible to the researcher; required problem, ADR and gate material is never
   summarized away.

   For Codex, call the fixed delivery host once per research line. Each request
   uses `role: research`, that line's signals and context packet. The host
   resolves the runtime-specific selection, crosses `createDispatchBoundary`,
   and records an application receipt. The request file contains only bounded
   serializable inputs; the host owns callbacks, capabilities, recording, and
   application evidence.

   ```bash
   node ${CLAUDE_PLUGIN_ROOT}/scripts/codex-delivery-host.cjs \
     --args-file /absolute/path/research-line-request.json
   ```

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

   The synthesizer reads the four validated references by targeted ranges or
   files and copies every source, constraint, uncertainty, and command-backed
   finding into `RESEARCH.md`, `OPTIONS.md`, `RISKS.md`, and
   `OPEN-QUESTIONS.md`. Missing or duplicated canonical lines remain hard
   errors. The Codex command path uses the same validator and boundary receipt;
   it has no inline or direct researcher fallback.
6. Show the user a summary: how many options, key risks, the list of
   open questions. Next — Step 2.

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
