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
worktree someone already set up), and often under an explicit "don't commit"
constraint. Code, tests, and local verification — yes; the branch/PR/review/merge
conveyor — no.

**Tickets are optional here — three modes:**
- **no ticket** (default): just implement the scope; bench never creates a ticket;
- **against an existing ticket**: point it at a Jira key (`MYD-1234`), an internal
  ticket id (`T-01-02`), or a `*-PLAN.md` path — bench READS it for scope and
  implements against it, without creating or restructuring anything;
- **light touch**: scale the process to the change — a one-line fix needs no
  ceremony, just the edit + a quick local check.

In every mode bench stays off-conveyor: it consumes a ticket at most as a scope
source, never mints one and never drives PR/merge.

**Full GSD, proportionate — driven for you.** bench is not "just edit". It runs a
real, size-scaled loop — **research → implement → verify → review** — leaning on
GSD and the available skills at each step. You do NOT call `/gsd-*` or another
shipyard command yourself; shipyard invokes them under the hood. A one-line fix
gets a one-line recon and a quick check; an unfamiliar or risky change gets
genuine research before any edit and a review after. The rigor scales to the
change — the ceremony does not.

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
- you explicitly do NOT want a ticket created — the work should just happen;
- you already HAVE a ticket (Jira key, internal `T-xx` id, or a PLAN file) and
  want to implement it directly, without running it through the PR/merge conveyor;
- there is an explicit "do not commit" / "don't push" instruction;
- a small change / quick fix / spike / integration touch-up where the delivery
  conveyor would only get in the way — bench scales down to a one-liner.

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

### Step 1 — Understand the task (and its ticket, if any)
- Take the scope from the argument, or ask (AskUserQuestion, in the user's
  language) what to do and where.
- If the scope references an existing ticket, READ it for the contract — do not
  create one:
  - a Jira key (`[A-Z]+-\d+`, e.g. `MYD-1234`) → fetch via the connected
    Atlassian/Jira MCP (`getJiraIssue`); no MCP → ask the user to paste the ticket
    text;
  - an internal id (`T-01-02`) or a `*-PLAN.md` path → read the PLAN file
    (`.planning/graph/tickets.json` maps id → plan);
  - stay read-only on the tracker by default — no status transitions, comments,
    or worklogs unless the user explicitly asks.
- No ticket at all is fine (the default) — the argument/conversation IS the scope.
- Locate the files/subsystem and read them before editing. Scale the depth to the
  change: a trivial edit does not need a full investigation.

### Step 1.5 — Research the change (proportionate — even for small ones)
Before editing, understand WHAT will change and the BEST way to implement it —
this applies even to a small, single-ticket change. shipyard runs this for you;
you never call GSD directly. Scale the effort to the change:
- read the touched code plus its callers and tests;
- unfamiliar subsystem or an architecture question → consult the codebase map
  (`.planning/codebase/` if present) or spawn a quick read-only research/Explore
  agent (the same recon GSD's phase-researcher does) instead of guessing;
- external library / framework / API → pull current docs via context7 (the
  Context7 MCP), not memory;
- a risky unknown or a real design fork → a short `/gsd-spike` to learn by doing;
- capture a 2–5 line approach note: what changes, where, why this way, risks.
For a genuinely trivial edit, a one-line recon is the whole of this step — do not
inflate it.

### Step 2 — Implement + tests
- Make the minimal in-scope change guided by the approach note; add or adjust
  tests alongside it.

### Step 3 — Verify locally
- Run tests / build / local run; iterate to green; capture the output. Prefer the
  `verify` / `run` skills or the repo's own commands.

### Step 3.5 — Review (proportionate)
- For a non-trivial change, run a read-only review of the diff (the `code-review`
  skill, or `/gsd-code-review`) and fold in the fixes — still no commit. Skip for
  a one-liner. shipyard runs this itself; you do not invoke the reviewer.

### Step 4 — Report
- Summarize the approach note (Step 1.5), what changed (`git diff --stat`), how
  you verified it (real command output), and the review outcome. State plainly
  that changes are left UNCOMMITTED (or committed only because the user explicitly
  asked). Offer the next step — keep iterating, hand off to `/shipyard:deliver`,
  or let the user commit — but do not take it unprompted.

## Rules
- No branch, worktree, PR, merge, push, or reviewer action — ever, in this mode.
- No commit unless explicitly asked; "do not commit" is absolute.
- Never CREATE a ticket. Consuming an existing one (Jira/PLAN) as scope is fine;
  mutating the tracker (status/comments) only on explicit request.
- Never fabricate conveyor artifacts (graph, delivery-state).
- Research before editing — proportionate, but real even for small changes.
- Drive GSD and the available skills yourself (research, verify, review); the
  user never invokes GSD or a shipyard command manually.
- Scale process to the change — full rigor, no ceremony for small edits.
- Artifacts in English; converse in the user's language.
- If the real need is the delivery conveyor, stop and route to the right skill.
