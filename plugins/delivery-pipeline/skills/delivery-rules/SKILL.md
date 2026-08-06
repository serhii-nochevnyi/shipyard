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
   `wave` is documentation for the human reader: the graph is authoritative and
   the validator recomputes the real dependency depth, warning when your value
   disagrees. Keep it truthful rather than decorative.
2. **Delivery block** (additive, never replaces GSD fields):

   ```yaml
   delivery:
     ticket: T-<phase>-<plan>
     risk: low|medium|high        # high REQUIRES human_checkpoint: true
     human_checkpoint: false
     repo: owner/name             # ONLY when the work lives in another repository
   ```

   **`repo` is mandatory for any ticket that does not touch this repo.** Omit it
   and the conveyor tracks the ticket against the wrong repository: its PR can be
   green and merged next door while the board says `pending` forever, and every
   dependent stays blocked behind a ticket that will never move. Paths in
   `files_modified` are then relative to THAT repo — never `../other-repo/x.ts`,
   which no worktree can reach (Gate 2 warns, state-sync parks the ticket).
   Cross-repo dependencies do not cascade: the parent must MERGE first, so slice
   the contract side (types/tool names) into its own ticket rather than making the
   consumer wait for a full feature.

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
5. **Name what already does this, before planning to write it.** Every plan's
   Context reads must either point at the existing implementation the ticket
   extends (`path:line` — the transformer, sorter, middleware, helper, endpoint
   it builds on), or record the check that found none: which behavior you
   searched for and the two or three plausible homes you looked in. Search by
   BEHAVIOR, not by the name you intend to give the new code — a duplicate is
   almost always already called something else, which is exactly why it survives
   review. "I did not see one" is not the same statement as "I looked"; only the
   second is a plan a reader can trust. This is the cheapest gate in the
   conveyor: an unnoticed duplicate is found by the integrator a whole phase
   later, after other tickets have already built on it, and by then removing it
   is its own ticket. Unlike §4 this cannot be machine-checked from
   frontmatter — Gate 2 never sees it, drift-check only backstops the tickets it
   re-judges, so writing it down is the control.
6. **Verification commands are scoped to the ticket, not to the project.** Write
   the narrowest commands that actually cover `files_modified` — the specific
   test files or filters, the typecheck and lint over the touched paths. A bare
   `npm test` / `make test` / the whole e2e suite is NOT a verification command
   here: it belongs to CI, which runs it once per push on hardware built for it.
   The executor runs these on EVERY attempt and the fix roles re-run them on
   every round, so an unscoped command is not slow once — it is the tick rate of
   the whole conveyor, multiplied by every ticket running in parallel in its own
   worktree. Two properties make a command usable: it must run in a bare
   worktree with no external services, and it must fail for THIS ticket's
   mistakes. A command that cannot be scoped (a suite that needs a live
   database, a browser, a deployed environment) is a CI-only check — say so
   under Test strategy and leave it out of Verification commands rather than
   handing the executor something it cannot run.
7. **`depends_on` drives the cascade, not just ordering.** Under epic-stacked
   delivery (the default), a root ticket (empty `depends_on`) PRs into the
   phase epic branch; a dependent ticket cascades — it PRs into its primary
   parent's branch WITHOUT waiting for a merge, so the flow never blocks.
   Declare dependencies precisely: a spurious dep serializes the flow, a
   missing one hands the executor an incomplete base. The validator derives
   the epic (`epic/<phase-dir>`), the primary parent, and `pr_base`; multiple
   same-phase parents (a diamond) get a warning — linearize when practical.
   **Keep dependencies inside one phase.** A cross-phase dependency cannot
   cascade — there is no shared branch to stack on — so the dependent ticket
   stays blocked until the parent's whole phase has landed on the default
   branch. The validator warns about every one of them; re-slice instead.
8. **Ids are canonical**: `T-<2-digit phase>-<2-digit plan>`. Write
   `T-01-02`, never `T-1-2` — the validator normalizes both, but branches,
   PR titles and Jira labels are string-compared everywhere else.
9. **No trailing `#` comments on a value.** Put a comment on its own line.
   `files_modified: [a.ts]  # note` used to fold the comment into the last
   path; the parser now strips it correctly, but Gate 2 still rejects any
   value that contains `#` because that is nearly always a leak.
10. **Gate 2 is mechanical**: it passes only when the graph validator exits 0.
    Jira/GitHub issues, ROLLOUT.md, or prose summaries are never a substitute
    for materialized PLAN files.
11. **Jira is a projection, not the source of truth.** By default (unless
    `pipeline.jira.enabled: false` or no Jira MCP is connected) decompose exports
    the validated graph to Jira (one Epic per phase, one issue per ticket) in
    English, after Gate 2 — never before, never instead. The project is
    auto-resolved and cached; a Jira failure must not block decomposition; PLAN
    files stay canonical.

## For executors (implementing a ticket)

1. **Stay inside `files_modified`.** Out-of-scope changes belong to another
   ticket — escalate instead of expanding scope silently.
2. **Read the existing implementation before writing a new one.** Whatever the
   plan named under §5, plus any `reuse_candidates` the conveyor handed you from
   drift-check: read each one first and extend it rather than adding a parallel
   layer beside it. If a candidate genuinely does not fit, say why in your
   evidence — that is a legitimate outcome, silently ignoring it is not. Reuse
   never licenses leaving `files_modified`: if building on it would take you
   outside scope, that is an out-of-scope escalation (§1), not a wider diff.
3. **Atomic commits** prefixed with the ticket id: `feat(T-01-02): …`.
4. **Run the plan's Verification commands locally to green** before
   declaring done; never claim verification without command output. Run those
   commands — do not "be thorough" by widening them to the whole suite (§6): CI
   owns the full run, and a suite you started here blocks your own worktree and
   every other executor sharing the machine. If the plan's commands are broken
   or plainly do not cover the change, fix or narrow them in the plan and say so
   in your evidence; substituting `npm test` silently is not a fix.
5. Worktree and branch come from the conveyor (`tickets.json`) — do not
   create branches or worktrees ad hoc. Your PR base is likewise resolved by
   the conveyor (`delivery-state.json` → `base`: the epic branch for a root
   ticket, the parent branch for a dependent one) — never open a PR straight
   into main/master under epic-stacked.
6. **Stop at the commit.** Do not `push`, do not open the pull request, do not
   touch reviewers. The orchestrator verifies the worktree mechanically
   (`git log <base>..HEAD`) before publishing anything — that check is what
   catches "the agent reported success and changed nothing", and it only works
   if publishing is not in the hands of the agent being checked. Hand back your
   verification evidence and a PR body instead.
