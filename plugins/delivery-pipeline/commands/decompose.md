---
name: decompose
description: "Decomposition (loop 2): ADR → GSD plan-tickets with dependencies → valid graph (Gate 2), then export to Jira. Finds undecomposed ADRs on its own. Use when the user explicitly wants an accepted design/ADR broken into tickets — it creates tickets, so invoke it deliberately, not from idle discussion."
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
  # jira: <KEY>                     # do NOT set by hand — Step 5 writes it back after export
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
5. Approval → proceed to Step 5 (Jira export), then state the next step:
   `/shipyard:deliver` (can be right away or a week later — deliver will do a
   cold start itself).

## Step 5 — Export tickets to Jira (English)

After Gate 2 passes AND the user approves the set, project the validated graph
into Jira. This is a **projection, not the source of truth** (§5.35): PLAN files
remain canonical, deliver never reads Jira, and Gate 2 never depends on it.
**All Jira content — epic and issue summaries, descriptions, comments — is
written in ENGLISH**, regardless of the conversation language (it is a shipped
artifact, per delivery-rules).

**Export is automatic — no hand-written config required.** Run it by default on
every decomposition, resolving everything yourself. It is skipped ONLY when:
- `.planning/config.json` → `pipeline.jira.enabled` is explicitly `false`, OR
- no Jira/Atlassian MCP is connected at runtime (nothing to export to).
In both cases skip with a one-line note. A Jira error never blocks or fails
decomposition (Gate 2 already passed) — report it and continue.

**Auto-resolve the project (once per repo, then persisted).** Config is a CACHE
you fill in, not a precondition the user must author. Resolution order:
1. `.planning/config.json` → `pipeline.jira.project` if already set → use it.
2. Else infer from the repo: scan recent PR titles, branch names, and any prior
   `delivery.jira` keys for a dominant `[A-Z]+-\d+` project prefix (e.g. `MYD`);
   a single clear winner → use it.
3. Else `getVisibleJiraProjects`: exactly one visible → use it; several →
   AskUserQuestion ONCE (in the user's language) to pick.
4. **Persist** the resolved `{ enabled: true, project, issue_type, epic_issue_type }`
   back into `.planning/config.json` → `pipeline.jira` (merge, don't clobber other
   keys) so every later run is non-interactive.
Defaults when unset: `issue_type: "Task"`, `epic_issue_type: "Epic"` — but first
confirm the type exists via project issue-type metadata
(`getJiraProjectIssueTypesMetadata`); if the project has no Epic type, skip epics
and fall back to a `Task` (or the project's default) issue type rather than failing.

The `pipeline.jira` block, once persisted, looks like:

```json
{
  "pipeline": {
    "jira": {
      "enabled": true,
      "project": "MYD",              // auto-resolved & cached; edit to override
      "issue_type": "Task",
      "epic_issue_type": "Epic"      // set null to skip per-phase epics
    }
  }
}
```

**Tooling.** Use whatever Jira/Atlassian MCP is connected at runtime (e.g.
Atlassian Rovo: `getVisibleJiraProjects`, `getJiraProjectIssueTypesMetadata`,
`searchJiraIssuesUsingJql`, `createJiraIssue`, `editJiraIssue`, `createIssueLink`,
`getIssueLinkTypes`). No Jira MCP available → skip with a note; do not hand-roll
REST calls.

**Idempotency by marker label (survives re-runs and frontmatter edits).** Each
issue carries a stable label: `shipyard-<ticket-id>` (e.g. `shipyard-T-01-02`),
the epic carries `shipyard-epic-<phase>`. Always `searchJiraIssuesUsingJql`
(`project = <KEY> AND labels = "shipyard-<id>"`) FIRST — found → update summary/
description if changed; not found → create. Never create a duplicate.

**Tooling.** Use whatever Jira/Atlassian MCP is connected at runtime (e.g.
Atlassian Rovo: `getVisibleJiraProjects`, `searchJiraIssuesUsingJql`,
`createJiraIssue`, `editJiraIssue`, `createIssueLink`, `getIssueLinkTypes`). No
Jira MCP available → skip with a note; do not hand-roll REST calls.

**Idempotency by marker label (survives re-runs and frontmatter edits).** Each
issue carries a stable label: `shipyard-<ticket-id>` (e.g. `shipyard-T-01-02`),
the epic carries `shipyard-epic-<phase>`. Always `searchJiraIssuesUsingJql`
(`project = <KEY> AND labels = "shipyard-<id>"`) FIRST — found → update summary/
description if changed; not found → create. Never create a duplicate.

**Procedure** (read `tickets.json` for the validated graph; process in dependency
order so parents exist before links):

1. Resolve the project (and cloudId) via the MCP; verify it is visible.
2. Per phase (if `epic_issue_type` set): find-or-create the phase Epic.
   Summary `[<phase>] <phase title>`, label `shipyard-epic-<phase>`,
   description: what the phase delivers + its epic branch (`epic/<phase-dir>`).
3. Per ticket, find-or-create the issue:
   - summary: `<ticket-id>: <title>` (English);
   - label: `shipyard-<ticket-id>` (+ optional `shipyard` label);
   - description (English, concise projection — NOT the whole plan): Goal, Scope,
     Acceptance criteria (from the PLAN body), risk, branch (`ticket/...`),
     `pr_base`, and a pointer line "Source of truth: `<plan path>` (this issue is
     a generated projection)";
   - parent/epic link to the phase Epic (when epics are enabled);
   - for each `depends_on`, a "is blocked by" issue link to that dependency's
     issue (`createIssueLink`; pick the link type via `getIssueLinkTypes`).
4. Write the resulting key back into the plan frontmatter under
   `delivery.jira: <KEY>` (best-effort traceability), then re-run
   `validate-graph.cjs` so `tickets.json` carries the `jira` field. The label is
   the primary idempotency key; the frontmatter key is a convenience mirror.
5. Report a compact map to the user (ticket-id → Jira key, epic key) in the
   user's language.

## Rules

- Do not write product code — only plans and frontmatter.
- Every ticket after you is a self-sufficient contract for a fresh-context executor:
  Goal, Context reads, Scope, Out of scope, Acceptance criteria, Test strategy,
  Verification commands.
