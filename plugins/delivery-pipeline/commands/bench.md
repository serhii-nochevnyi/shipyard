---
name: bench
description: "Off-conveyor direct work mode for when /shipyard:deliver does not fit — implement in the CURRENT/given worktree: code, tests, local run; never create branches/worktrees/PRs, never merge/ship, and do NOT commit unless explicitly asked."
argument-hint: "[what to do — optional]"
allowed-tools:
  - Read
  - Write
  - Edit
  - Bash
  - Grep
  - Glob
  - AskUserQuestion
  - Skill
  - Agent
---

# /shipyard:bench

Direct, off-conveyor implementation for when `/shipyard:deliver` does NOT fit:
you are working hands-on inside an existing checkout (e.g. an integration
worktree someone already set up), there is no ticket graph to drive, and often
an explicit "don't commit" constraint. Code, tests, and local verification —
yes; the branch/PR/review/merge conveyor — no.

> **Communication language.** This skill and every artifact you produce (code,
> tests, comments) are in English. But when you talk to the *user* —
> AskUserQuestion prompts, progress notes, the final report — reply in the user's
> language (match the language they write to you). English is for the artifacts;
> the user's language is for the conversation.

## When to use — and when to route elsewhere

Use `/shipyard:bench` when:
- you are already inside a checkout/worktree someone else set up (an integration
  worktree, a teammate's branch, a detached experiment) and must NOT restructure
  its git;
- the task is direct: implement a change, write/adjust tests, run them locally,
  iterate to green — without minting a ticket, a branch, or a PR;
- there is an explicit "do not commit" / "don't push" instruction;
- a quick fix / spike / integration touch-up where the delivery conveyor would
  only get in the way.

Do NOT use it — route to the conveyor instead — when:
- you have `.planning/graph/tickets.json` and want PR-per-ticket delivery →
  `/shipyard:deliver`;
- you need to turn an ADR into tickets → `/shipyard:decompose`;
- you are still researching the problem → `/shipyard:investigate`.

bench never creates the conveyor's artifacts and never reads or writes
`.planning/graph/` delivery state.

## Operating contract (the guardrails that make this mode safe)

1. **Stay in the current worktree.** Work in the current working directory (or a
   path the user names). NEVER `git worktree add`, NEVER create or switch
   branches, NEVER `git checkout -b`. You did not set up this checkout — leave its
   git topology exactly as you found it.
2. **Don't commit by default.** Leave changes in the working tree for the user to
   review. Commit ONLY if the user explicitly asks in this session — and even
   then never `push`, never commit onto the default/integration branch beyond
   what was asked, never force anything. An explicit "do not commit" is absolute
   and overrides any later reflex to "just save progress".
3. **No conveyor actions.** No PRs, no `reviewers.cjs` / reviewer re-init, no
   merge/ship, no epic branch, no `state-sync`, no Jira export. If the work will
   later need to ship, say so and point to `/shipyard:deliver` — do not start
   doing it here.
4. **Scope discipline.** Change only what the task needs. If a correct fix
   requires out-of-scope edits, surface that and ask before sprawling.
5. **Verify for real.** Run the project's tests / build / local run and drive
   them to green; show actual command output. Never claim green without it.
   Reuse the project `verify` / `run` skills or the repo's existing scripts when
   present rather than inventing commands.
6. **Reviewable edits.** Small, coherent changes that match the surrounding
   style, comment density, and idioms (delivery-rules §4 discipline still applies,
   even without a ticket).

## Flow

### Step 0 — Situate
- `git rev-parse --show-toplevel`, `git status --short`, `git branch --show-current`
  (note a detached HEAD) — know which worktree/branch you are in and what is
  already modified. If it is clearly a shared/integration worktree, treat every
  guardrail above as hard.
- Confirm the commit constraint: assume "do not commit" unless the user has
  clearly authorized commits in this session.

### Step 1 — Understand the task
- Take it from the argument, or ask (AskUserQuestion, in the user's language)
  what to do and where. Locate the files/subsystem and read them before editing.

### Step 2 — Implement + tests
- Make the minimal in-scope change; add or adjust tests alongside it.

### Step 3 — Verify locally
- Run tests / build / local run; iterate to green; capture the output. Prefer the
  `verify` / `run` skills or the repo's own commands.

### Step 4 — Report
- Summarize what changed (`git diff --stat`), how you verified it (real command
  output), and state plainly that changes are left UNCOMMITTED (or committed only
  because the user explicitly asked). Offer the next step — keep iterating, hand
  off to `/shipyard:deliver`, or let the user commit — but do not take it
  unprompted.

## Rules
- No branch, worktree, PR, merge, push, or reviewer action — ever, in this mode.
- No commit unless explicitly asked; "do not commit" is absolute.
- Never fabricate conveyor artifacts (tickets, graph, delivery-state).
- Artifacts in English; converse in the user's language.
- If the real need is the delivery conveyor, stop and route to the right skill.
