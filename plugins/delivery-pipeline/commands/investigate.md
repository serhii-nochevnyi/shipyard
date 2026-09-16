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
   - `.planning/` exists (otherwise suggest `/gsd-new-project` and stop);
   - codebase map: if there is no `.planning/codebase/`, run
     `/gsd-map-codebase` or warn that research will work without a map.
2. Pick a number: the next free `INV-NNN`, a slug of 2–4 words of the topic.
3. Create `.planning/investigations/INV-NNN-slug/`, copying ALL templates from
   `${CLAUDE_PLUGIN_ROOT}/templates/inv/`.
4. **Intake interview**: a raw statement is not accepted silently. Ask via
   AskUserQuestion the questions that are missing for PROBLEM.md: for whom / current
   pain / what success will be / what is definitely out of scope. Ask only what you
   cannot derive from the statement. Fill in PROBLEM.md.
5. **Research fan-out**: resolve the runtime and all four line selections through
   the routed `pipeline-config.cjs` `resolveDispatch` bridge before launching.
   Never call the compatibility `pipeline-config.cjs model` reader, compose a
   model or effort in this command, or let a session/default selection leak into
   the launch. For the Workflow runtime, the base is Opus/medium and only an explicit
   `complexity: very-complex` signal escalates research to Opus/max; the
   `alternatives` line does not promote the rung. For Codex, the base is
   Astra/low and the same explicit very-complex signal escalates to Astra/medium.
   Keep the resolved `{ model, effort, signals }` on every line. For Codex,
   pass those exact signals to the selector for each line — for example,
   `--type alternatives` for the alternatives line and
   `--complexity very-complex` for the explicitly very-complex line — and
   preserve the selector's returned model/file and effort when calling the
   boundary. Do not select once for the fan-out and do not re-resolve a line
   from its model/effort pair.

   For the Workflow runtime, invoke the production entry point
   `${CLAUDE_PLUGIN_ROOT}/scripts/claude-investigation-host.cjs`, which pins
   `${CLAUDE_PLUGIN_ROOT}/workflows/investigation-research.mjs` and delegates to
   the generic host binding. The host call is:

   ```text
   const workflowHost = registerInvestigationWorkflowHost({
     agent, parallel, phase, log,
     capabilities, recorder, applicationEvidence
   })
   await workflowHost.run({ invId, invPath, problemStatement, referencePath,
                            artifactLanguage, lines })
   ```

   `registerInvestigationWorkflowHost` is the production host registration;
   it pins the research DSL and invokes `runClaudeWorkflow` with the native
   callbacks, so this is not a unit-test-only constructor. The typed
   `createClaudeWorkflowDispatch` bridge is injected as the sixth
   workflow binding; the durable recorder, capabilities, and
   application-evidence callback stay outside serializable `args`. The workflow
   dispatches all four lines through that bridge in parallel and refuses if any
   host dependency is absent. Do not use the native Agent tool, a generic
   session, an in-process fallback, or a direct `agent()` call. For Codex, use the generated agent selected by
   `codex-agent.cjs select research --json --capabilities-file
   ${CLAUDE_PLUGIN_ROOT}/codex-capabilities.json [canonical line signals]` and
   the same dispatch boundary via `createCodexDispatchAdapter`; do not call
   `spawn_agent` directly. The selector's `--json` result is preflight
   evidence, not launch authority by itself: the returned selection must still
   cross `createDispatchBoundary` and produce a durable application receipt.

   Accept a research result only after its durable boundary receipt is verified.
   Pass each line the problem statement, the INV path, and the brief
   `${CLAUDE_PLUGIN_ROOT}/references/inv-research.md`. Bring verified results
   into RESEARCH.md, OPTIONS.md, RISKS.md, and OPEN-QUESTIONS.md.
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
   - `ADR-NNN-<slug>.md` — from DECISIONS.md, in a format that
     `/gsd-plan-phase --ingest` parses (Nygard: Status/Context/Decision/Consequences;
     each locked decision — an explicit section, scope fences — a separate block);
   - if there is material: INTERFACES.md, DATA-MODEL.md, ROLLOUT.md.
3. Update the PROBLEM.md frontmatter (the template ships it pre-stubbed):
   `status: closed`, `closed: <YYYY-MM-DD>`, `adr: <path to the ADR>`.
   Step 0 reads exactly these keys to tell an open INV from a closed one.
4. Tell the user the next step: `/shipyard:decompose`.

## Rules

- Do not write code. Investigation is read-only with respect to the codebase (except the artifacts).
- Do not make decisions for the user. Agents prepare options — the human chooses.
- Every statement about the codebase — with a file path.
