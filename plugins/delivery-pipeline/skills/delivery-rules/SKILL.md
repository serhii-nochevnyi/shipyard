---
name: delivery-rules
description: Delivery-conveyor rules for GSD planner/executor agents — plan frontmatter contract, delivery block, branch naming, scope discipline. Injected via agent_skills (global:shipyard:delivery-rules); also useful when authoring or editing PLAN.md files by hand.
---

# Delivery conveyor rules

This project runs a per-ticket delivery conveyor on top of GSD
(see `docs/gsd_multilevel_delivery_pipeline.md`). Plans double as tickets;
these rules keep them machine-consumable by the conveyor's deterministic layer.

**Language.** All artifacts — plans, frontmatter, commits, code, PR bodies — are
written in English. When addressing the user directly, reply in the user's
language; English is for the artifacts, the user's language is for conversation.

## For planners (writing PLAN.md)

1. **Full frontmatter, always**: `phase`, `plan`, `title`, `type`, `wave`,
   `depends_on: []`, `files_modified: []`, `requirements: []`. Empty
   `requirements` is a BLOCKER — both GSD's plan-checker and Gate 2
   (`validate-graph`) reject it; reference ROADMAP requirement ids, or the
   external tracker id when the plan was imported.
2. **Delivery block** (additive, never replaces GSD fields):

   ```yaml
   delivery:
     ticket: T-<phase>-<plan>
     risk: low|medium|high        # high REQUIRES human_checkpoint: true
     human_checkpoint: false
   ```

3. **Do not invent branch names.** The canonical branch is
   `ticket/<ID>-<slug>` where the slug is the sanitized ticket title
   (lowercase, transliterated, non-alphanumerics collapsed to single
   hyphens, ≤40 chars). Omit `delivery.branch` — the graph validator
   generates it; an explicit value is validated against the same rule.
4. **files_modified is a contract, not a guess** — list every path the plan
   touches. An EMPTY `files_modified` fails Gate 2 (it is what makes
   "dependency-unordered tickets never collide" checkable, and it is the
   executor's scope). Dependency-unordered plans with overlapping paths also
   fail Gate 2; resolve with a dependency or a re-slice, never by widening
   globs (a bare glob that matches everything is flagged).
5. **`depends_on` drives the cascade, not just ordering.** Under epic-stacked
   delivery (the default), a root ticket (empty `depends_on`) PRs into the
   phase epic branch; a dependent ticket cascades — it PRs into its primary
   parent's branch WITHOUT waiting for a merge, so the flow never blocks.
   Declare dependencies precisely: a spurious dep serializes the flow, a
   missing one hands the executor an incomplete base. The validator derives
   the epic (`epic/<phase-dir>`), the primary parent, and `pr_base`; multiple
   same-phase parents (a diamond) get a warning — linearize when practical.
5. **Gate 2 is mechanical**: it passes only when the graph validator exits 0.
   Jira/GitHub issues, ROLLOUT.md, or prose summaries are never a substitute
   for materialized PLAN files.

## For executors (implementing a ticket)

1. **Stay inside `files_modified`.** Out-of-scope changes belong to another
   ticket — escalate instead of expanding scope silently.
2. **Atomic commits** prefixed with the ticket id: `feat(T-01-02): …`.
3. **Run the plan's Verification commands locally to green** before
   declaring done; never claim verification without command output.
4. Worktree and branch come from the conveyor (`tickets.json`) — do not
   create branches or worktrees ad hoc. Your PR base is likewise resolved by
   the conveyor (`delivery-state.json` → `base`: the epic branch for a root
   ticket, the parent branch for a dependent one) — never open a PR straight
   into main/master under epic-stacked.
