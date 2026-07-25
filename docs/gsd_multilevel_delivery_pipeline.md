# Multilevel delivery pipeline built on GSD

> Version 3. Current pin: `@opengsd/gsd-core@1.7.0` (commands and flags
> verified against the package and the next documentation; adaptation status — section 10.5).
> Target scenario:
> **deep investigation → decomposition into tickets with dependencies → implementation
> of each ticket in a separate git worktree → PR per ticket → automatic driving of the PR
> to green with reviewer re-initialization (CodeRabbit, Copilot).**

---

## 0. Pipeline requirements

1. **Deep investigation** — a separate mode in which the topic is fully studied and
   the accepted positions (decisions/ADR) are recorded. No code is written at this stage.
2. **Decomposition into tickets with dependencies** — an explicit DAG, each ticket is an
   execution contract, not a task title.
3. **Delivery mechanism** — a separate loop that takes a set of tickets and:
   - executes each ticket in a **separate git worktree** while respecting dependencies;
   - drives each ticket to a **separate PR** (branch per ticket, stacked PRs for
     unmerged dependencies);
   - tracks PR state via git/GitHub (`gh`);
   - drives the PR to a **green state**: CI checks + a fix cycle based on
     reviewer comments;
   - after each push **re-initializes the reviewers**: CodeRabbit
     (`@coderabbitai full review`) and Copilot (re-request review via API).

---

## 1. Division: what GSD 1.6 provides out of the box, what we build ourselves

GSD should not be duplicated. The verified boundary:

| Need | GSD 1.6 out of the box | We build ourselves |
|---|---|---|
| Ideation / early thinking | `/gsd-explore` (Socratic ideation) | — |
| Research with experiment | `/gsd-spike` → `.planning/spikes/SPIKE-NNN/` | Investigation package (INV templates) |
| Codebase map | `/gsd-map-codebase` (architecture/conventions/concerns) | — |
| Knowledge graph | `/gsd-graphify` (opt-in in `.planning/config.json`) | — |
| Ingesting an ADR into planning | `/gsd-plan-phase --ingest <adr>` (parses locked decisions + scope fences) | ADR package as the investigation output |
| Plans with dependencies | plan frontmatter: `phase, plan, type, wave, depends_on, files_modified` | Graph validator + generating `tickets.yaml` as a view |
| Plan quality review | `/gsd-plan-review-convergence <phase> --all --max-cycles N` | — |
| Parallel execution in worktrees | `/gsd-execute-phase` (waves, `Agent(isolation="worktree")`) — but **merge into a single branch** | **Delivery loop: PR per ticket** (section 5) |
| Clean PR branch without `.planning/` | `/gsd-pr-branch` | Used as a utility in delivery |
| UAT | `/gsd-verify-work` (conversational UAT) | Mechanical verification lives in CI + babysit loop |
| PR / ship | `/gsd-ship <phase>` — one PR per phase | **PR-per-ticket + babysit to green** |
| Running the review cycle | — | **Reviewer re-init + fix loop (CodeRabbit/Copilot)** |

The conclusion is the same as in v1, but with a more precise boundary:

```text
GSD          = investigation support + planning + plan quality convergence
Overlay      = ticket discipline + PR-per-ticket delivery + review babysitting
```

**Entry points.** Three loops (investigate → decompose → deliver) plus two
non-loop entries: `/shipyard:bench` for off-conveyor direct work (§6.6) and
`/shipyard:route`, a read-only *entry router*. The loops are invoked
deliberately — decompose/deliver create tickets, branches, PRs, and Jira issues,
so they never fire from idle conversation. When you have sketched a scope in
conversation and want to know which flow fits, `/shipyard:route` classifies it
(needs research → investigate; an ADR to break down → decompose; tickets to ship
→ deliver; direct worktree work → bench; trivial → inline) and hands off. Being
side-effect-free, the router is the one entry the model may safely surface on its
own from a scope discussion.

Across every entry and every size, shipyard applies GSD at full — research →
plan → implement → verify → review — proportionate to the work, and drives those
GSD helpers itself: the user never calls `/gsd-*` or a shipyard command by hand.
Research is not conveyor-only — the light `bench` path does proportionate recon
before editing (codebase map / a research agent / context7 docs / a spike),
mirroring how plan-phase runs a researcher before planning. Small change, full
rigor; no ceremony.

---

## 2. Principles (essentially unchanged)

1. **The chat is not the source of truth.** The source of truth is the artifacts in `.planning/`.
   A session may die; the artifacts are the stable memory of the process.
2. **Each stage leaves a contract for the next one.** Investigation → decisions.
   Decisions → ADR. ADR → tickets. Ticket → PR. PR → merge evidence.
3. **Different cognitive modes — different agents.** Researcher, architect, decomposer,
   executor, review-comment fixer — separate fresh-context agents, connected
   only by artifacts.
4. **A single source of truth for dependencies.** Dependencies live in the ticket
   frontmatter. `graph/tickets.yaml` is a **generated view**, not a hand-written
   master file (otherwise they will inevitably diverge).

---

## 3. `.planning/` structure

Does not conflict with the native GSD layout (`STATE.md`, `ROADMAP.md`,
`phases/XX-name/XX-YY-PLAN.md`, `spikes/`), but adds to it:

```text
.planning/
  STATE.md                      # GSD
  ROADMAP.md                    # GSD
  REQUIREMENTS.md               # GSD

  investigations/               # overlay: loop 1
    INV-001-topic/
      PROBLEM.md
      RESEARCH.md
      OPTIONS.md
      RISKS.md
      OPEN-QUESTIONS.md
      DECISIONS.md              # accepted positions → raw material for the ADR

  architecture/                 # overlay: investigation output
    ADR-001-selected-approach.md
    INTERFACES.md
    DATA-MODEL.md
    ROLLOUT.md

  phases/                       # GSD: tickets = GSD plans with a delivery extension
    01-foundation/
      01-01-PLAN.md             # = ticket T-01-01
      01-02-PLAN.md
    02-behavior/
      02-01-PLAN.md

  graph/                        # overlay: generated views + delivery state
    tickets.json                # generated from plan frontmatter — the MACHINE view
    tickets.yaml                #   the same data, rendered for humans
    delivery-state.json         # state of each ticket in the delivery loop (machine)
    delivery-state.yaml         #   the same, rendered for humans
    delivery-log.jsonl          # append-only telemetry (pipeline-stats input)
```

Every script reads the `.json` files; the `.yaml` mirrors exist for reading and are
regenerated on each run. All four are generated — never hand-edited.

---

## 4. Loop 1 — Deep Investigation

### 4.0. Initiation

Investigation is a standalone entry point. The interface is a **skill, not a CLI with
flags**: there are no parameters to remember.

```text
/investigate                      # no arguments — the skill figures it out itself
/investigate <any text>           # raw problem statement as an argument
```

On start the skill reads `.planning/investigations/` and **figures out the context itself**:

```text
- are there open INVs?  → asks: continue INV-001 (shows its status and open
                     questions) or start a new one?
- new without text → asks for a problem statement
- INV matured      → proposes on its own: "all questions closed — shall I close Gate 1
                     and generate the ADR?"
```

**Input can be of any maturity**: a raw idea, a bug/incident, a Jira epic,
a PRD. For a completely raw idea, the skill will first propose `/gsd-explore` (Socratic
ideation) — its output becomes the problem statement.

**What starting a new INV does:**

```text
1. Preconditions: .planning/ is initialized (/gsd-new-project),
   the codebase map exists and is fresh (/gsd-map-codebase) — otherwise it runs them
2. Creates .planning/investigations/INV-NNN-slug/ with a skeleton of all artifacts
3. Intake interview: the agent asks the questions missing for PROBLEM.md
   (for whom, current pain, success criteria, what is out of scope) —
   a raw statement is not accepted silently
4. Research fan-out: parallel agents along the lines
   (system state / alternatives+prior art / constraints / risks)
   → drafts of RESEARCH.md, OPTIONS.md, RISKS.md + OPEN-QUESTIONS.md
5. Next — an iterative dialogue (4.1): you close questions and accept
   positions; the next session — again just /investigate, and the skill
   picks up the open INV from the state of the artifacts itself
```

**Closure** (the skill proposes it on its own when the questions are exhausted): the structural
Gate 1 validator (all OPEN-QUESTIONS closed or converted into risks,
DECISIONS complete) → generation of the ADR package in `architecture/` in a format
that `plan-phase --ingest` parses → the INV is marked closed and becomes a
read-only reference.

Several investigations can live in parallel (INV-001, INV-002) — they are
independent until the moment their ADRs meet in a single decomposition.

### 4.1. Process

```text
Problem statement
  → codebase research            (/gsd-map-codebase, if not present yet)
  → topic research               (research agents, /gsd-spike as needed for
                                  experiential verification of hypotheses with draft code)
  → OPTIONS.md with trade-offs
  → DECISIONS.md                 (accepted positions: what was chosen, what was rejected, why)
  → ADR package in architecture/ (a format that plan-phase --ingest parses)
```

Investigation is an iterative dialogue with a human: the agents bring in findings and
options, the human accepts positions. Each accepted position is recorded in
`DECISIONS.md` immediately, not at the end.

### 4.2. Artifacts

```text
PROBLEM.md        — what problem we are solving, for whom, success criteria, what is out of scope
RESEARCH.md       — current system state, alternatives, constraints, unknowns
OPTIONS.md        — Option A/B/C + trade-offs (a comparison table is mandatory)
RISKS.md          — risks with severity and mitigation
OPEN-QUESTIONS.md — questions that block the decision; each has an owner
DECISIONS.md      — locked decisions; each: decision / why / what was rejected / scope fence
```

### 4.3. Gate 1 — Investigation complete

- all OPEN-QUESTIONS are either closed or explicitly moved into risks with mitigation;
- every option in OPTIONS.md has trade-offs;
- DECISIONS.md covers all the decisions needed for decomposition;
- the ADR files are created in `architecture/` (this is the input format for loop 2).

**The check is automated**: a validator script verifies the presence and
non-emptiness of the sections. The substantive quality is checked by a human — this is a human gate.

---

## 5. Loop 2 — Decomposition into tickets

### 5.1. Ticket = GSD plan + delivery extension

The interface is the `/decompose` skill (no parameters). It itself:

```text
1. finds closed INVs with ADRs that are not yet decomposed → asks which one to take
   (or several ADRs into one phase)
2. clarifies the mode: --tdd? --mvp? (with a recommendation based on the type of work)
3. runs a chain of GSD commands under the hood:
   /gsd-plan-phase N --ingest <adr> [--tdd|--mvp]
   /gsd-plan-review-convergence N --all --max-cycles 3
   scripts/validate-graph          # Gate 2 + generation of tickets.yaml
4. shows a summary: tickets, DAG, waves, high-risk → you approve
   or say "break down T-03" — and the chain repeats pointwise
```

Decomposition is done by GSD — this is its strong suit; the skill only relieves you of
the need to remember commands and flags.

The GSD plan already has the needed frontmatter (`phase`, `plan`, `type`, `wave`,
`depends_on`, `files_modified`). The delivery loop adds its own fields:

```yaml
# frontmatter 01-02-PLAN.md (addition)
delivery:
  ticket: T-01-02
  branch: ticket/T-01-02-repository-layer
  pr: null            # filled in by the orchestrator
  risk: medium
  human_checkpoint: false
```

### 5.2. Requirements for the ticket body (execution contract)

Each ticket must contain: **Goal, Context (list of files to read),
Scope, Out of scope, Acceptance criteria, Test strategy, Verification commands.**
This already almost matches the GSD plan format; we use `plan-review-convergence`
as the mechanism to bring tickets up to this standard.

### 5.3. Graph generation and validation

`graph/tickets.yaml` is generated by a script from the frontmatter of all plans:

```yaml
# generated — do not edit by hand
milestone: M-001
tickets:
  T-01-01: { title: "Add data model",       depends_on: [],                 files: [src/models/**],  risk: medium }
  T-01-02: { title: "Add repository layer", depends_on: [T-01-01],          files: [src/repo/**],    risk: medium }
  T-02-01: { title: "Add API endpoint",     depends_on: [T-01-01, T-01-02], files: [src/api/**],     risk: high }
```

### 5.35. Source of truth and external trackers

A pipeline ticket exists only as the file `.planning/phases/<N>-*/<N>-<M>-PLAN.md`.
Jira/GitHub issues are an optional **export projection** (item 7 in the
implementation list), not a replacement: deliver reads only PLAN files, and Gate 2 is
solely exit 0 from validate-graph, not the presence of tickets in a tracker.
If decomposition finished without materialized PLAN files — this is an
improperly closed Gate 2; the deliver cold start detects this case and
proposes importing external tickets into PLAN files with a repeated Gate 2.

**Jira export (decompose Step 5).** By default — no hand-written config needed —
decomposition projects the validated graph into Jira *after* Gate 2 and approval:
one Epic per phase, one issue per ticket (summary `<ticket-id>: <title>`),
`depends_on` mapped to "is blocked by" links, all content in **English**
regardless of conversation language. The project is auto-resolved (existing
tracker keys in the repo → `getVisibleJiraProjects` → ask once) and cached into
`.planning/config.json` → `pipeline.jira`, so later runs are non-interactive.
Export is skipped only when `pipeline.jira.enabled` is explicitly `false` or no
Jira MCP is connected. Idempotency is by a stable marker label
`shipyard-<ticket-id>` (search-first, never duplicate); the resulting key is
mirrored into the plan frontmatter `delivery.jira` and surfaced in `tickets.json`.
This is strictly a projection — a Jira failure never blocks decomposition, and
deliver still reads only PLAN files.

### 5.4. Gate 2 — Ticket graph valid (fully automatic)

The validator (`scripts/validate-graph`) checks:

- there are no cycles (topological sort succeeds);
- every `depends_on` references an existing ticket;
- tickets without common ancestors do not overlap in `files_modified`
  (otherwise they cannot go in the same wave — the validator either raises a conflict
  or adds an artificial dependency);
- every `risk: high` ticket has `human_checkpoint: true`.

---

## 6. Loop 3 — Delivery: worktree → PR → green state

This is a separate mechanism (orchestrator) that replaces `/gsd-execute-phase` +
`/gsd-ship` for the "PR per ticket" mode. The native execute-phase remains
available for internal/low-risk phases where a single PR per phase is enough.

**Delivery is a standalone entry point.** Loops 1–3 are not one continuous
process: a day or a month may pass between investigation, decomposition, and delivery.
That is why delivery starts with a separate command, takes an **explicit selection
of tickets**, and holds no state in session memory — only artifacts + GitHub.

### 6.0. Ticket selection and cold start

The interface is the `/deliver` skill (no parameters). Instead of flags — a board and
a selection:

```text
1. cold start (below) → the skill shows a BOARD built from the actual state:
     ready:    T-01-01, T-01-04          (dependencies merged, can be taken)
     blocked:  T-02-01 ← waiting for T-01-02
     pr-open:  T-01-02 (PR #142, fixing, attempt 2)
     merged:   T-01-03
     drifted:  T-01-05 → needs-replan
2. asks what to take into work: multiselect from ready (+ option "the whole phase" /
   "everything ready")
3. if you chose a blocked ticket — it clarifies right then, not with a flag in advance:
     "T-02-01 depends on T-01-02 (PR open). Add T-01-02 to the scope?
      Stack onto its branch? Or defer T-02-01?"
4. confirmed scope → orchestrator launch; from there everything runs without you until the
   human gates
```

Merged dependencies are always considered satisfied — selecting from the middle of the graph
is legal. Calling `/deliver` again at any moment shows the same
board (progress, blockers) and lets you add the next batch.

**Cold start (a mandatory prologue to every run).** Since there was a gap between
runs:

```text
1. State resync: gh pr list/checks/reviews → rebuild delivery-state.yaml
   from the actual GitHub state (the local file is a cache, GitHub is the truth)
2. Graph revalidation: scripts/validate-graph against the current main
   (something might have merged past the pipeline)
3. Drift gate for each selected ticket: a fast agent verifies that the
   contract still matches the codebase (files from Context exist, interfaces
   have not changed, scope is not overlapped by others' changes). Drift → the ticket
   is marked needs-replan and is NOT executed blindly; it returns to
   loop 2 (/gsd-plan-phase pointwise)
```

### 6.05. Integration model — epic-stacked (default)

A phase is integrated through ONE epic branch, not through dozens of PRs directly into the default
branch. `.planning/config.json` → `pipeline.integration_mode`:
`epic-stacked` (default) | `direct-to-main` (legacy; dependents wait for merge).

- per phase — an epic branch `epic/<phase-dir>` off the default branch (main|master),
  generated in `tickets.json.epics` together with per-ticket `epic`/`pr_base`;
- the root ticket (empty `depends_on`) → PR into the epic branch;
- a dependent ticket → a **cascading** PR into the primary parent's branch (the deepest
  dependency of the same phase), WITHOUT waiting for its merge — the flow does not stop;
- `state-sync` computes the `base` of each ticket (root → epic; dependent → the parent's
  branch; merged parent → epic — GitHub retargets the children of a merged parent);
- the phase enters the default branch as ONE epic → default PR; it, like the ticket PRs,
  is merged by a human after the integrator is `passed`;
- readiness is cascading: a ticket is ready as soon as its parents are ≥ `branched` (not merged) —
  a child can be worked in parallel with its parent.

Deterministic layer: `epic-branch.sh ensure|pr|retarget|status`.

### 6.1. Execution model

```text
for each ticket T from the selected scope in topological order:
  ready(T) = epic-stacked: all depends_on(T) ≥ branched (have a branch to cascade onto)
             direct-to-main: all depends_on(T) in the merged state

  1. base   = state[T].base (epic-stacked: epic for the root / the primary
              parent's branch for a dependent / epic when the parent is merged;
              direct-to-main: main or the branch of the deepest unmerged dependency)
  2. git worktree add ../wt/T-XX <branch> <base>
  3. executor: headless agent in the worktree with the ticket contract
     (claude -p with the ticket body + Context reads; TDD per the contract)
  4. local check: verification commands from the ticket
  5. commit → push → gh pr create --base <base> --draft (first line of the body:
     machine-readable "Ticket: <T>")
  6. babysit loop (6.2) until green
  7. green → merge into ITS OWN base (epic/the parent's branch) → child PRs are retargeted onto
     the epic (epic-branch.sh retarget; GitHub often does this itself)
```

Parallelism is free: all tickets for which `ready(T)` holds are launched
simultaneously — each in its own worktree, file conflicts ruled out by Gate 2.
The cascade also makes the chain independent: a child starts as soon as the parent has a branch.

**Branch naming.** A ticket's branch is `ticket/<ID>-<slug>`, where the slug is the
**ticket title after sanitization**: lowercase, Cyrillic is
transliterated, any character other than letters and digits (spaces, `: , ( ) / ' "`
etc.) is replaced with a single hyphen, edge hyphens are trimmed, slug length
≤ 40 characters. Example: `Add API endpoint (v2): auth` →
`ticket/T-02-01-add-api-endpoint-v2-auth`. The name is generated deterministically
by `validate-graph` from the title and ends up in `tickets.yaml`; an explicitly specified
`delivery.branch` is validated against this same rule (forbidden characters →
a Gate 2 error). Executors take the name only from `tickets.json`.

### 6.2. Babysit loop — driving the PR to green

**Movement toward a fixpoint.** The orchestrator drives the entire reachable scope to completion in one
run, rather than stopping at the first blocker. After each `state-sync` it
computes the actionable front = {ready tickets not yet started} ∪ {open non-green
PRs}; while the front is not empty it continues (executing the ready ones, babysitting PRs,
picking up cascading children as soon as the parent is `branched`). A blocker (escalate,
attempts>MAX, adr-outdated, drift, human-gate) **parks** the ticket and does not stop the
run — progress continues with the rest of the front. Stopping is legal only at a fixpoint: everything
delivered or only blockers/waiting-for-human remain.

The state of each ticket is tracked in `graph/delivery-state.yaml`:

```yaml
T-01-02:
  status: fixing        # pending|in-progress|pr-open|fixing|green|merged|blocked
  branch: ticket/T-01-02-repository-layer
  pr: 142
  attempts: 2           # cycle limit, after which — escalation to a human
  last_push: <sha>
```

The cycle (run by the orchestrator for each open PR):

```text
loop:
  1. CI:      gh pr checks <pr> --json name,state
              has failing → fix agent in the ticket's worktree:
                reads the failure log (gh run view --log-failed),
                fixes it, runs the verification commands locally,
                commit + push
              → step 4

  2. Reviews: collect actionable comments
                gh api repos/{o}/{r}/pulls/<pr>/comments   (inline)
                gh api repos/{o}/{r}/pulls/<pr>/reviews    (verdicts)
              has unresolved → fix agent:
                ! receiving-code-review discipline: a comment is first
                  verified against the code; an unfounded one gets a
                  reasoned reply, not a blind edit
                edits → commit + push
              → step 4

  2b. Arch-review (CodeRabbit/Copilot do NOT know our ADRs — this is a separate agent):
              reads the PR diff + architecture/ (ADR, INTERFACES, DATA-MODEL)
              + the ticket contract; verdict:
                conform     → proceed
                violation   → fix agent brings it in line with the ADR → step 4
                adr-outdated→ escalation to a human: either the decision changes
                              (update DECISIONS/ADR and revalidate the graph),
                              or the code is brought in line with the ADR
              runs when the PR is opened and after each push that changes code

  3. The green state is reached if:
              - all checks passed
              - no unresolved actionable comments
              - CodeRabbit: last review without blocking issues
              - Copilot: review comments addressed
              - arch-review: verdict conform
              - approvals per branch protection (a human — for human_checkpoint)
              → status: green, exit the loop

  4. Reviewer re-initialization after EACH push:
              # CodeRabbit — full re-review
              gh pr comment <pr> --body "@coderabbitai full review"
              # Copilot — re-request review (does not re-review a push automatically)
              gh api -X POST repos/{o}/{r}/pulls/<pr>/requested_reviewers \
                 -f 'reviewers[]=copilot-pull-request-reviewer[bot]'
              attempts += 1
              attempts > MAX (default 5) → status: blocked, escalation to a human
              → step 1
```

Notes on the reviewers' mechanics:

- **CodeRabbit**: `@coderabbitai review` — incremental review of the new commits,
  `@coderabbitai full review` — a full one from scratch (this is the "re-initialization");
  `@coderabbitai resolve` — close the addressed threads after a push with fixes.
- **Copilot code review**: after a push you must explicitly re-request via the
  `requested_reviewers` API (or `gh pr edit --add-reviewer` where supported);
  on its own it does not re-review.
- Both bots can be wrong: the fix agent is obliged to **verify every
  comment against the code** and has the right to respond with a reasoned disagreement. The goal
  of the cycle is "no unresolved threads", not "all the bots' whims fulfilled".

### 6.3. Gate 3 — Ticket delivered (automatic, per ticket)

- the PR is in the green state (criteria from step 3, including arch-review conform);
- all changes in the PR belong to the ticket's scope (diff check against `files_modified`);
- the ticket's verification commands are green locally and in CI;
- for `human_checkpoint: true` — explicit human approval.

### 6.4. Gate 4 — Integration (per milestone/phase)

After all the phase's tickets are merged — a separate integrator agent reads all the PRs,
the diff of the milestone branch/main, the ADRs, and checks: coherence, the absence
of duplication between tickets, conformance to the ADRs, actual coverage of the acceptance
criteria. The verdict `passed | needs-fix | human-review-required` goes into
`INTEGRATION.md`; `needs-fix` spawns fix tickets that go through the same
delivery loop (section 6.1) — this is the feedback cycle.

### 6.5. Pipeline telemetry (input for improvement)

The pipeline accumulates an append-only log `.planning/graph/delivery-log.jsonl`:

- `status_change` is written by **`state-sync.cjs` itself** on each cold start
  (the transition pending→branched→pr-open→merged, with a timestamp);
- session-only facts (`attempt` with role/model/outcome, `fix_round`
  fixed|no-op|escalate, `escalation`) are logged by the orchestrator via
  `log-event.cjs` — GitHub cannot recover them later.

`pipeline-stats.cjs` aggregates the log + `gh pr list` into metrics: median
time to merge, babysit attempts, the share of no-op fix rounds, and escalations broken down
by risk. This is the input for tuning the model ladder (§7.5) and the fix-role prompts.

The ticket state in `delivery-state.json` additionally carries `since` (since when the ticket has been in
the current status); the cold-start board highlights the "tails" —
approved+green PRs without merge and stale drafts. Ticket↔PR matching is
branch-first with a fallback on the `<T>:` marker in the PR title (a safeguard in case
the canonical branch is renamed by re-decomposition; `Ticket: <T>` is the first
line of the PR body).

### 6.6. Off-conveyor direct mode (`/shipyard:bench`)

Not every session fits the conveyor. When you are working hands-on inside a
checkout someone already set up — a shared/integration worktree, a teammate's
branch, an experiment — with no ticket graph and often an explicit "don't
commit", the delivery loop (loop 3) is the wrong tool: it assumes ticket
preparation, isolated branches, cascading PRs, review, and merge/ship. For that
case there is `/shipyard:bench`: a direct implementation mode that writes code
and tests and runs verification locally, but **never** creates branches or
worktrees, opens PRs, re-inits reviewers, merges, ships, or touches
`.planning/graph/` state — and does **not commit unless explicitly asked**. It is
strictly off-conveyor: it produces no tickets, no delivery state, and reads none.
When the work genuinely needs to ship, bench stops and routes to
`/shipyard:decompose` / `/shipyard:deliver`. Artifacts are English; conversation
follows the user's language, like every other loop.

---

## 7. Orchestrator

Launched by the `/deliver` skill on the scope you confirmed, and lives until the
scope is driven to green or blocked:

```text
0. cold start (6.0): resync from GitHub → graph revalidation → drift gate
1. reads graph/tickets.yaml + graph/delivery-state.yaml (just resynced)
2. advances states within the scope: launches ready tickets, runs the babysit loop
   for open PRs
3. after each state change — commits delivery-state.yaml (audit trail in git)
4. blocks only on human gates (human_checkpoint, attempts escalations,
   needs-replan after the drift gate)
5. when the entire scope is green/merged — if this was the last batch of the phase,
   proposes an integrator run (Gate 4)
```

The orchestrator is idempotent: all state is in `delivery-state.yaml` + GitHub,
so it can be killed and restarted at any moment — it will reconstruct the
picture from the PR state (`gh pr list --json`), not from session memory.
In this repository, the natural place to run it is the claude-shipyard container
(gh auth is already mounted, the claude CLI is baked in).

---

## 7.5. Model policy

Two tiers: **heavy judgment + heavy work → the Opus tier, light mechanics →
Sonnet.** The pipeline agent layout:

```text
opus      integrator, arch-review,        — judgment with the most expensive mistakes,
          executor, review-fix, ci-fix,     code work, diagnostics,
          research:alternatives             option design
sonnet    drift-check, research:system-    — mechanical cross-checking and fact gathering
          state/constraints/risks
```

**The policy is code, not prose.** `scripts/pipeline-config.cjs model <role>
[--risk|--type|--files|--attempt|…]` returns the tier for a spawn, applying the
role × risk × attempt matrix, the `model_policy` profile, and any
`pipeline.models` override. The skills call it instead of reasoning a value out —
which is also what keeps the emitted values valid.

**Only tier aliases are valid `model` values on a spawn**: `opus`, `sonnet`,
`haiku`. The Agent tool validates `model` against exactly that set, so a full
model ID (`claude-opus-…`) or a context-suffixed alias (`opus[1m]`) is rejected on
input — an earlier revision of this document specified suffixed aliases, and every
spawn following it would have failed validation. Deliberately no generation is
pinned here: model ids move, and a document that names one goes stale silently.
Context-window selection is a session/runtime concern and cannot be expressed in a
spawn's `model` at all.

The GSD decomposition agents are governed by GSD's own mechanism
(`model_profile` / `models` / `model_overrides` in the same config.json) —
a separate namespace from `pipeline.*`. Recommendation: `models.planning: opus`;
if you additionally pin a full id in `model_overrides.gsd-planner`, look it up in
the current model catalog rather than copying it from here.

## 8. Gates (summary table)

```text
Gate 1: Investigation complete      — human + structural validator
Gate 2: Ticket graph valid          — fully automatic (validate-graph)
Gate 3: Ticket delivered (× ticket)  — automatic; human only for high-risk
Gate 4: Integration accepted        — integrator agent + human on needs-fix
Gate 5: Release ready               — rollout/rollback described, evidence in PR body
```

Compared to v1, gates 4–8 are collapsed: plan quality is ensured by
`plan-review-convergence`, mechanical verification lives in the CI babysit cycle,
and "a quality PR body" is a Gate 3 requirement (PR body template: Problem, Scope, Ticket,
Dependency slice, Test evidence, Rollout/Rollback).

---

## 9. Full operational flow

```bash
# 0. Init (one-time)
/gsd-new-project
/gsd-map-codebase

# 1. Deep investigation (loop 1) — a separate entry point
/investigate "topic/problem"
#    intake interview → research fan-out → iterative dialogue
#    hypotheses that need to be verified with code: /gsd-spike "<idea>"
/investigate            # next session: the skill picks up the open INV itself
#    when the questions are exhausted, the skill proposes closure:
#    result: DECISIONS.md + architecture/ADR-001.md          [Gate 1: human]

# --- a gap is possible here ---

# 2. Decomposition (loop 2)
/decompose
#    finds undecomposed ADRs itself, clarifies the mode, under the hood:
#    plan-phase --ingest + plan-review-convergence + validate-graph
#    → graph/tickets.yaml, you approve the set of tickets              [Gate 2: auto]

# --- a gap is possible here ---

# 3. Delivery (loop 3) — a separate entry point, you choose the scope on the board
/deliver
#    cold start: resync from GitHub + drift gate → ticket board
#    → you choose what to take into work (multiselect)
#    worktree per ticket → PR per ticket → babysit to green
#    with CodeRabbit/Copilot re-initialization after each push [Gate 3: auto]
/deliver                 # the next batch, whenever convenient

# 4. Integration — /deliver proposes it itself when the phase is closed
#    integrator → INTEGRATION.md                                 [Gate 4]
#    needs-fix → fix tickets → /deliver again

# 5. Next phase → step 2
```

---

## 10. What needs to be implemented (delta, in priority order)

**Interface layer — three skills** (Claude Code plugin, the same mechanism
as GSD commands). The skills take no mandatory parameters: they read state
from the artifacts, show it, and **interrogate only what they cannot infer**:

```text
1. /investigate   — loop 1: pick up an open INV or create a new one,
                    intake interview, research fan-out, Gate 1 → ADR
2. /decompose     — loop 2: find undecomposed ADRs, clarify the mode,
                    GSD chain under the hood, Gate 2 → tickets for approval
3. /deliver       — loop 3: cold start → board → scope selection →
                    orchestrator; at the end of the phase proposes the integrator
```

**Deterministic layer — scripts that the skills call** (the agent does not improvise
git operations, validation, and GitHub state):

```text
4. delivery orchestrator    — sections 6–7; worktree/branch/PR lifecycle + babysit loop
5. scripts/validate-graph   — Gate 2: cycles, references, file conflicts,
                              generation of graph/tickets.yaml from frontmatter
6. scripts/reviewers        — re-init: coderabbit comment + copilot re-request;
                              collecting unresolved threads
7. scripts/state            — resync delivery-state.yaml from the actual GitHub state
```

**Agent prompts** (used by the orchestrator):

```text
8. ci-fix, review-fix, arch-review, drift-check, integrator, intake/research (INV)
```

The minimal working cycle "tickets → green PRs": `/deliver` + items 4–7 +
ci-fix/review-fix. `(optional)` Jira/GitHub exporter: tickets.yaml → issues.

---

## 10.5. Reorientation to GSD 1.7 (pin: 1.7.0)

The pipeline has been reoriented from 1.6.x to 1.7. The key fact from the review of the
next documentation: GSD deliberately stops at PR creation (non-goals: no tracker
integration, no auto-PR-loop, no auto-merge) — the babysit cycle, state resync from
GitHub, ADR conformance, and the integrator remain the unique value of the overlay.

**Already accounted for in the pipeline:**

- `requirements[]` — a mandatory frontmatter field (empty = a plan-checker
  BLOCKER): the template in /shipyard:decompose has been extended, and
  validate-graph rejects it as a hard Gate 2 error;
- `wave` in the template for self-authored plans — documentation only: the
  validator computes the real dependency depth and warns on a mismatch;
- preflight `gsd-tools worktree base-check` before creating a ticket worktree;
- `context_window: 1000000` in the recommended config (GSD adaptive-context for
  1M models; a per-spawn `model` cannot express a context window);
- config booleans like `workflow.code_review` have become capability-owned — the skills
  do not read them directly.

- **capability `delivery-pipeline`** (`capabilities/delivery-pipeline/`,
  installed into the image at global scope): a fail-closed gate `command-exit-zero` →
  `validate-graph.cjs` on `plan:post`, blocking. Gate 2 is now a mechanical
  part of the GSD cycle: planning physically will not finish without materialized
  valid PLAN files (verified: without plans the gate returns block:true,
  with valid ones — block:false). The switch is the federated config key
  `delivery_pipeline.graph_gate`. An rc.4 nuance: `runtimeCompat.supported`
  accepts only `["*"]` (the concrete id `claude` does not pass cross-validation).

- **ship:pre gate** (capability v0.3.0): a blocking `command-exit-zero` →
  `uat-gate.cjs ${PHASE_NUMBER}` wraps the fail-closed predicate
  `phase uat-passed` — /gsd-ship will not pass without verification evidence
  (switch: `delivery_pipeline.uat_gate`). Without a phase in context — skip.
- **`ship.pr_body_sections`** seeded into the recommended decompose config
  (Acceptance Criteria + Risks & Dependencies from PLAN.md).
- **Pre-push review** — an optional step 4b in deliver
  (`/gsd-code-review --fix` / `/gsd-review --coderabbit --opencode`).
- validate-graph is deliberately NOT slimmed down to a delta over plan-checker:
  the import flow (Jira → PLAN.md in deliver) does not go through plan-checker,
  so a standalone full DAG check remains necessary.

- **arch-conform agentVerdict** (capability v0.4.0): an advisory gate on
  ship:pre — an LLM assessment of the phase changes' conformance to the locked ADR decisions
  (blocking is forbidden by the contract for non-deterministic checks; switch
  `delivery_pipeline.arch_verdict`).
- **`agent_skills` injection**: the `pipeline:delivery-rules` skill
  (rules for frontmatter/the delivery block/branch naming/scope discipline)
  is injected into gsd-planner and gsd-executor via
  `agent_skills: {"gsd-planner": ["global:shipyard:delivery-rules"], ...}`
  in the recommended config.
- **The `gate_status:` trailer** — deliver records the verdicts in the PR body as the last
  line (`gate_status: arch-review=…, drift-check=…, checks=green`);
  it survives a squash-merge and is read after the fact.

The 1.7 roadmap is fully closed.

## 10.6. Codex runtime (the same pipeline on the OpenAI Codex CLI)

The pipeline works on Codex too — installed on the host, separately from the Docker image.
The source of truth remains the Claude plugin (`plugins/delivery-pipeline/commands/*.md`);
the generator `scripts/gen-codex-shipyard.cjs` emits Codex-native artifacts,
so the two runtimes do not diverge (zero drift).

- **Conversion without replication.** The generator `require()`s gsd-core's own converter
  (`runtime-artifact-conversion.cjs`) — commands become Codex skills
  `~/.agents/skills/shipyard-<cmd>/SKILL.md` with a `<codex_skill_adapter>` header
  (mapping `AskUserQuestion → request_user_input`, `Agent/Task → spawn_agent`).
  The plugin-specific rewrites (`${CLAUDE_PLUGIN_ROOT}`, `/shipyard:<cmd>` →
  `$shipyard-<cmd>`) are done by the generator itself.
- **Subagents.** Roles from `references/*.md` (arch-review, ci-fix, drift-check,
  review-fix, integrator, inv-research) → `$CODEX_HOME/agents/shipyard-<role>.toml`,
  registered in `config.toml [agents.*]` **non-destructively** (the gsd agents
  are not touched; the merge is idempotent).
- **Gates.** The capability is already runtime-agnostic (`runtimeCompat: ["*"]`,
  `command-exit-zero` + `agentVerdict`) — the same Gate 2 and UAT gate
  are installed via `gsd-tools capability install`.
- **`deliver` — a hybrid.** Codex has no Workflow tool, so `deliver` goes its own
  built-in Agent path: determinism — Node scripts under
  `$CODEX_HOME/shipyard/scripts/`, agentic work — via `spawn_agent`.

Installation: `make install-shipyard-codex` (requires gsd-core for Codex:
`npx --yes @opengsd/gsd-core@1.7.0 --codex --global`). `SHIPYARD_CODEX_PHASE=1` —
investigate+decompose only. Smoke: `make test-codex-shipyard`.

## 11. Brief conclusion

```text
GSD        = investigation support + decomposition + plan quality convergence
Overlay    = deep-investigation discipline + ticket graph +
             PR-per-ticket delivery in worktrees + review babysitting
```

The greatest value comes from: locked decisions as the investigation contract;
ticket = a GSD plan with delivery frontmatter (a single source of truth for dependencies);
the worktree + stacked-PR model that gives true parallelism without file conflicts;
the babysit loop that automatically drives each PR to green and keeps
CodeRabbit/Copilot in the loop after each push.
