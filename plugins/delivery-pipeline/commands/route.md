---
name: route
description: "Entry router for shipyard — surface this automatically whenever a scope of work has been defined in conversation and no shipyard loop is already running. It sizes the work and routes it: large/heavy multi-ticket efforts → investigate/decompose/deliver; small changes, an existing ticket, or 'no ticket' → bench; a one-liner → inline. Read-only and advisory: it classifies and hands off, and never creates tickets, branches, PRs, or commits itself (so it is safe to trigger on its own). Triggers: a defined scope of work, 'route this', 'what should we do with this', 'here's the scope — take it', 'kick off shipyard for this', or any implement/build/fix request where the right entry is unclear."
argument-hint: "[scope — optional; falls back to the scope just discussed]"
allowed-tools:
  - Read
  - Bash
  - Grep
  - Glob
  - AskUserQuestion
  - Skill
---

# /shipyard:route

The deliberate bridge from "we just discussed a scope" to the right shipyard
entry. The four loops are invoked explicitly on purpose —
`decompose`/`deliver` create tickets, branches, PRs, and Jira issues, so they
must NOT fire from idle conversation. This router closes the gap: it reads the
scope, classifies it, and hands off to the loop that fits — or tells you it is
too small to bother with a loop at all.

This skill is **advisory and side-effect-free**: it only reads `.planning/` and
git state to classify, then recommends and (on your confirmation) invokes the
chosen loop. It never creates tickets, branches, PRs, or commits itself — that
is why it is safe for the model to surface on its own when you sketch a scope.

**GSD is applied at full, driven for you — every path, every size.** Whichever
target it picks, shipyard runs the GSD-backed loop under the hood —
**research → plan → implement → verify → review**, proportionate to the work —
so you never call `/gsd-*` or a shipyard command by hand. Research happens even
on the light path: `bench` does proportionate recon before editing, exactly as
the conveyor's plan-phase runs a researcher before planning. The user describes
the work; shipyard picks the entry and orchestrates GSD.

> **Communication language.** This skill and any shipyard artifact are in
> English. But when you talk to the *user* — AskUserQuestion prompts, the
> recommendation, hand-off notes — reply in the user's language (match what they
> write). English is for the artifacts; the user's language is for the conversation.

## Step 0 — Get the scope
- From the argument if given; otherwise use the scope just discussed in this
  conversation. If neither is clear, ask one line (AskUserQuestion, in the user's
  language) to restate what should be done.

## Step 1 — Read state (to inform the route, read-only)
Cheap signals — do not modify anything:
- `.planning/investigations/` — an open INV already in progress?
- `.planning/architecture/ADR-*.md` — accepted decisions exist?
- `.planning/phases/**/*-PLAN.md` and `.planning/graph/tickets.json` — tickets
  already materialized?
- `git rev-parse --show-toplevel`, `git status --short`, current branch — are you
  inside a shared/integration worktree, are there uncommitted changes, is there a
  "don't commit" expectation?

## Step 2 — Classify and route
First **size** the work — is it a large, multi-unit effort that needs the ticket
graph and PR-per-ticket delivery, or a small/direct change? Then pick the FIRST
row that matches the scope (rows are ordered heavy → light):

| The scope is… | Route to |
|---|---|
| unclear, needs research, decisions not yet made, or a raw problem | `/shipyard:investigate` |
| an accepted design / ADR to be broken into tickets (no tickets yet) | `/shipyard:decompose` |
| tickets already exist and you want them shipped as PRs | `/shipyard:deliver` |
| direct hands-on work in the current worktree, no PR/ship, or "don't commit" | `/shipyard:bench` |
| you explicitly do NOT want a ticket — just get the work done | `/shipyard:bench` |
| an existing ticket (Jira key / `T-xx` / PLAN) to implement, without the PR conveyor | `/shipyard:bench` (pass the ticket as its scope) |
| a small change / quick fix — light touch | `/shipyard:bench` (or inline if truly one-line) |
| a single trivial edit / one command | do it inline (or `/gsd-fast`) — no loop |

**Default toward the lighter option.** Creating a ticket / running the conveyor
is the heavier path — pick it only when the scope genuinely needs the ticket
graph and PR-per-ticket delivery. "No ticket", "work this existing ticket
directly", and "small change" all land on `bench` or inline; do not push work
onto decompose/deliver just because it exists.

Genuinely ambiguous between two → present them (AskUserQuestion) with a one-line
why for each, and recommend the lighter one.

## Step 3 — Hand off
- State the recommended route, one line of why, and the exact command to run.
- For **bench** or **inline/trivial** → you may proceed directly (no
  side-effecting conveyor action involved).
- For **investigate / decompose / deliver** → confirm with the user FIRST (these
  are deliberate, side-effecting entries), then invoke the chosen skill (Skill
  tool) passing the scope as its argument.
- Never do the target loop's own work here — route and hand off.

## Rules
- Advisory only: classify + recommend; never create tickets/branches/PRs/commits.
- Do NOT auto-launch a side-effecting loop (decompose/deliver) without the user's
  confirmation.
- One clear recommendation beats a menu — offer alternatives only when the scope
  is genuinely ambiguous between loops.
- Artifacts in English; converse in the user's language.
