---
name: decompose
description: "Decomposition (loop 2): ADR → GSD plan-tickets with dependencies → valid graph (Gate 2). Finds undecomposed ADRs on its own."
argument-hint: "[phase number — optional]"
allowed-tools:
  - Read
  - Write
  - Edit
  - Bash
  - Grep
  - Glob
  - AskUserQuestion
  - Skill
---

# /shipyard:decompose

You run loop 2: turning accepted architecture into tickets with an explicit DAG.
A ticket = a GSD plan + a `delivery:` block in the frontmatter. Dependencies live in
the plans' frontmatter; `graph/tickets.yaml` is a generated view.

> **Communication language.** These instructions and every artifact you produce
> (PLAN files, frontmatter, branch names, the graph) are in English. But when you
> talk to the *user* — AskUserQuestion prompts, the ticket-summary for approval,
> progress notes — reply in the user's language (match the language they write to
> you). English is for the pipeline; the user's language is for the conversation.

**The SINGLE source of truth is the files `.planning/phases/<N>-*/<N>-<M>-PLAN.md`.**
Jira/GitHub issues, ROLLOUT.md, chat lists are NOT conveyor tickets — at most they are
export projections. Decomposition without materialized PLAN files does not
exist: /shipyard:deliver reads only those. Declaring Gate 2 passed on the
basis of any other artifacts is FORBIDDEN — Gate 2 is exclusively
exit 0 from validate-graph.cjs.

## Step 0 — Find the input

1. Read `.planning/architecture/` — the list of `ADR-*.md`.
2. Determine which ADRs are not yet decomposed: check ROADMAP.md and the existing
   `phases/*/`*-PLAN.md for mentions of ADRs. If ambiguous — ask.
3. No ADR at all → say to run `/shipyard:investigate` first, and stop.
4. Multiple candidates → AskUserQuestion: which ADR (or several into one phase).

## Step 0.5 — GSD agent models

Decomposition is performed by GSD agents — their models are governed NOT by this skill
but by `.planning/config.json`. Check it and, if absent, propose adding it
(project policy: role × risk × attempt routing — judgment is always
Opus 4.8 1M `claude-opus-4-8[1m]`, code by risk, repair via an escalation ladder,
mechanics → Sonnet 5; profile — `pipeline.model_policy: economy|balanced|premium`,
details in /shipyard:deliver):

```json
{
  "model_profile": "balanced",
  "models": { "planning": "opus", "research": "sonnet", "verification": "sonnet" },
  "model_overrides": {
    "gsd-planner": "claude-opus-4-8[1m]",
    "gsd-executor": "claude-opus-4-8[1m]"
  },
  "context_window": 1000000,
  "agent_skills": {
    "gsd-planner": ["global:shipyard:delivery-rules"],
    "gsd-executor": ["global:shipyard:delivery-rules"]
  },
  "ship": {
    "pr_body_sections": [
      { "heading": "Acceptance Criteria", "enabled": true,
        "source": "PLAN.md ## Acceptance criteria",
        "fallback": "- Covered by linked requirements and verification evidence." },
      { "heading": "Risks & Dependencies", "enabled": true,
        "source": "PLAN.md ## Risks || PLAN.md ## Dependencies",
        "fallback": "- No known high-risk rollout dependencies." }
    ]
  }
}
```

(`context_window: 1000000` — GSD 1.7 enables adaptive-context enrichment for
1M models, aligned with the conveyor's opus[1m] policy.)

(`models.*` accepts only the tier aliases opus/sonnet/haiku; full IDs are set
only via per-agent `model_overrides`. The planner is the heaviest role in decomposition,
so it is raised to Opus 4.8 with 1M context via override; the executor likewise.)

## Step 1 — Clarify the mode

One question (AskUserQuestion), with a recommendation based on the type of work:
- `--tdd` — when the work is well testable at the unit level (recommend for
  backend logic);
- `--mvp` — vertical slices UI→API→DB (recommend for new features with UI);
- no flags — standard planning.

## Step 2 — GSD chain

1. Pick the phase number: the next free one (or the user's argument).
2. Run `/gsd-plan-phase <N> --ingest <adr-paths> [--tdd|--mvp]`
   (via the Skill tool if GSD commands are available as skills, otherwise prompt
   the user to run it and wait).
3. **Verify materialization**: `ls .planning/phases/<N>-*/*-PLAN.md` — the files
   MUST exist. If the GSD chain is unavailable or did not create the files —
   do NOT substitute Jira tickets for them: create the PLAN.md files yourself, one per
   ticket, using the template:

   ```markdown
   ---
   phase: <NN>
   plan: <MM>
   title: "<ticket title>"
   type: implementation
   wave: <N>                    # 1 + max(wave of dependencies); no dependencies = 1
   depends_on: [<T-...>]
   files_modified: [<globs>]
   requirements: [<REQ-ids>]    # REQUIRED in GSD 1.7: requirement ids from ROADMAP.md;
                                # an empty array = BLOCKER in the plan-checker.
                                # No ROADMAP requirements (import from Jira) — create
                                # a REQ entry in ROADMAP or set the Jira ticket id
   delivery:
     ticket: T-<NN>-<MM>
     risk: low|medium|high
     human_checkpoint: false
   ---
   ## Goal / ## Context (Reads) / ## Scope / ## Out of scope /
   ## Acceptance criteria / ## Test strategy / ## Verification commands
   ```
4. Run `/gsd-plan-review-convergence <N> --all --max-cycles 3`
   (if available; skipping convergence is a TUNE, skipping files is a BLOCK).

## Step 3 — Delivery frontmatter extension

For EACH generated `phases/<N>-*/**-PLAN.md`, add to the frontmatter:

```yaml
delivery:
  ticket: T-<phase>-<plan>          # e.g. T-01-02
  branch: ticket/T-<phase>-<plan>-<slug-from-title>   # can be omitted — validate-graph will generate it
  risk: low|medium|high             # assess from the plan content
  human_checkpoint: true|false      # true is MANDATORY if risk: high
```

**Branch naming**: the branch is the ticket title after sanitization:
lowercase, Cyrillic is transliterated, ALL characters except letters and digits
(spaces, `: , ( ) / ' " …`) are replaced with a single hyphen, edge hyphens
are trimmed, slug length ≤ 40. Example: the title `Add API endpoint (v2): auth`
→ `ticket/T-02-01-add-api-endpoint-v2-auth`. Do NOT invent the format yourself —
the simplest option is to not fill in `branch` at all: `validate-graph` will generate the
canonical name from the title, and an explicitly provided one it will validate.

Make sure `files_modified` and `requirements` are filled in every plan —
empty ones fail Gate 2 (an error, not a warning): without `files_modified` there is
neither a guarantee that "independent tickets do not conflict" nor an executor scope. `depends_on`
being empty is legal only for the root ticket. If the planner left the fields
empty — fill them from the plan content.

**`depends_on` is the backbone of the cascade, not just ordering.** In delivery (epic-stacked)
dependencies determine where a PR is directed: the root ticket (empty
`depends_on`) → PR into the phase epic branch; a dependent one → cascaded PR into the branch of the
primary parent (the deepest dependency of the same phase), WITHOUT waiting for merge. So
set dependencies deliberately and precisely: an extra dependency needlessly serializes the flow,
a missing one gives the executor an incomplete base. `validate-graph` will itself compute the epic
(`epic/<phase-dir>`), the primary parent, and `pr_base`; multiple dependencies of the same
phase (diamond) it will flag as a warning — linearize the chain where possible.

## Step 4 — Gate 2

Gate 2 is a MECHANICAL check, not a judgment. It passes if and only if
`validate-graph.cjs` finished with exit 0 and `.planning/graph/tickets.json` is
freshly written. Do not report decomposition success without this.

1. `node ${CLAUDE_PLUGIN_ROOT}/scripts/validate-graph.cjs`
2. Errors (cycle, file conflict, empty files_modified/requirements,
   high-risk without checkpoint) → fix the frontmatter/slicing and retry. A file
   conflict is more honestly resolved by a dependency or re-slicing than by extending
   files_modified.
3. OK → show the user a summary for approval:
   - the phase epic branch (`tickets.json.epics`) — where the whole phase integrates;
   - a table of tickets: id / title / wave / depends_on / pr_base (epic or parent
     branch) / risk;
   - who is high-risk and will wait for a human;
   - how many waves and what will run in parallel; any diamond warnings of the graph.
4. The user wants changes ("split T-03 into two") → targeted edit of the plans →
   back to Step 4.1.
5. Approval → state the next step: `/shipyard:deliver` (can be right away or
   a week later — deliver will do a cold start itself).

## Rules

- Do not write product code — only plans and frontmatter.
- Every ticket after you is a self-sufficient contract for a fresh-context executor:
  Goal, Context reads, Scope, Out of scope, Acceptance criteria, Test strategy,
  Verification commands.
