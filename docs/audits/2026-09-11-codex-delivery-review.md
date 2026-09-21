# Review of Codex's additional delivery (phases 32 and 35, ADR-011/012/013)

Date: 2026-09-11. Reviewer: Claude Fable 5.1 (this session). Everything below
was measured against live GitHub, the local checkout on `prep/gsd-workflow-sync`
and the files named; a claim marked *hypothesis* could not be measured.

## Two questions only the operator can answer

1. **Did the operator accept ADR-012's `routine → sonnet` lane?** ADR-012 says
   "Decision owner: repository operator". The standing instruction in this
   session was the opposite: never below `opus` for any role except
   `pr-sentinel` and `drift-check`. Nothing in the files proves either way.
2. **Did the operator pre-authorize T-32-06?** `32-06-PLAN.md` carries
   `preauthorized: true` with the comment "Pre-authorized by the operator on
   2026-09-11". The decompose contract says only Step 4.3 writes that flag,
   after a person reads the table. The commit was authored by Codex.

If either answer is "no", #95 was merged on a false authorization and #104
carries it toward `main`.

## The blocker: `runtime: "codex"` is heading for `main`

- `origin/main` `.planning/config.json`: `runtime: "claude"`, no `model_ladder`.
- `#104` (epic/32 → main, opened 07:08 today) flips it: `runtime: "codex"`,
  `model_ladder: "adaptive"`, `agent_skills` to the flat Codex form.
- `runtime` is ONE field shared by both runtimes. `capForRuntime` caps every
  Claude role to the workhorse tier when it reads `codex`. Measured on the
  branch with `pipeline-config.cjs model <role> --json`:

  | role / flags | model | route |
  |---|---|---|
  | executor, risk low | sonnet | `tier=level:routine(sonnet)` |
  | executor, risk medium | sonnet | `tier=floor+cap:codex(sonnet)` |
  | executor, risk high, checkpoint | sonnet | `tier=level:critical+cap:codex(sonnet)` |
  | arch-review | sonnet | `floor+cap:codex` |
  | integrator | sonnet | `floor+cap:codex` |
  | ci-fix, signature repeat | sonnet | `floor+cap:codex` |

  That is not ADR-012's narrow routine lane. It is every judgement role on
  `sonnet` for every Claude session in this project, which ADR-005 D1 and
  ADR-011 D8 both forbid. Merging #104 as-is puts `main` there.
- Design gap none of the three ADRs addresses: a project both runtimes work on
  has no mechanism. `gsd-tune` reads the config and agrees with it; nothing
  sniffs the live CLI. CLAUDE.md documents the hazard at the GLOBAL level
  (installer handover); at project level there is nothing.
- `agent_skills` flipped to `global:shipyard-delivery-rules` resolves nowhere on
  Claude (silently skipped), so the GSD planner loses the delivery-rules
  contract on the canonical runtime.

## Per-ADR verdicts

### ADR-011 — measure the work before optimizing the model: sound

Disciplined. D8 keeps the ADR-005 floors; Alternatives rejects "make Sonnet the
executor default"; ROLLOUT orders waves and forbids routing changes in wave 0.
It fairly corrects this reviewer: the 15× restart and 17× delegation figures in
the session-cost backlog note are hypotheses, not validated quota savings. That
is the rule written into ADR-006 today and it applies to me.

### ADR-012 — task-level model ladder: contradicts what it claims to respect

- Says "this experiment does not … lower the stated minimum for any automatic
  lane" and, in the same page, routes `routine` executor/research to `sonnet`.
  The stated minimum (ADR-005 D1) is `opus` for every code-writing role. Both
  sentences cannot be true.
- No `Amends`/`Supersedes` field. ADR-005 D1 and ADR-011 D8 are silently
  overridden. Third instance of the ADR-006 D8 bookkeeping defect.
- The commit adopting it (`adf66e6`) existed on no remote when first checked;
  now it reaches GitHub only through #95/#104.
- Mechanically the resolver work is competent: missing signals fall to
  `complex`, mechanical roles cannot be raised, Codex selector reports fallback.
  The DECISION is what is unproven, not the code.

### ADR-013 — GSD workflow synchronization: design sound, footprint large

- `gsd-sync.cjs` is a projection, never an authority; `--check`, lock, atomic
  writes; never calls GitHub/Jira. Verified.
- Gates at `plan:post`/`execute:post`/`verify:post`/`ship:pre` are
  applicability-scoped: `gsd-sync-gate.cjs` reads `delivery:` first, `when:
  delivery_pipeline.gsd_sync`. Verified. The script is in the Codex smoke.
- Cost, stated in its own Consequences: #101 commits 121 generated files, 94
  under `.planning/phases/`. A generated read-model checked into git will drift
  on every plan edit; the gates make that visible, they do not make it cheap.

## Process findings

- **Rollout order violated.** ADR-011 ROLLOUT says phases 32–34 follow 29–31
  and only T-32-01/02 may advance early. Phases 30 and 31 were never
  decomposed; 33 and 34 were skipped; phase 35 was built.
- **Phase 32 integration verdict covers wave 0 only.** `WAVE-0-PROGRESS.md`
  says so explicitly ("These contracts do not complete all of phase 32"), so the
  "passed at 2/7" is by design, not a defect. What is a defect: epic/32 was
  merged to `main` (#94) while five tickets still targeted it, and now #104
  re-opens the same epic branch against `main` carrying #95.
- **#95 merged into an already-integrated epic** (07:07 today), with the
  `runtime` flip and the T-32-06 pre-auth inside it.
- **Local branch `prep/gsd-workflow-sync`**: 9 commits ahead of `main`, on no
  remote, no trailers, content duplicating #96–#102; 851 uncommitted lines
  across 18 files; untracked `usage-attribution.cjs` (314 lines) plus its test
  are in no PR. Tree vs #102 differs by 43 files (+2485/−1001).
- **Each open PR carries its own `tickets.json`**, so Gate 2 was never run over
  the set as one graph.
- `make test-fast` on the uncommitted tree: 160 passed, 0 failed, docs and
  ssh-sync smokes passed.

## Recommended order

1. Answer the two questions above.
2. Before anything else lands: strip `runtime: codex`, `model_ladder`, and the
   `agent_skills` flip from #104, or gate them behind a per-runtime mechanism
   that does not yet exist.
3. Decompose phases 30 and 31 (ADR-010, ADR-009) as queued; ADR-011 ROLLOUT
   requires them before 32-03+.
4. Push or discard `prep/gsd-workflow-sync`; decide the home of
   `usage-attribution.cjs`.
5. Re-run Gate 2 over one `tickets.json` for the open set.

## Observed while closing this review (2026-09-11)

The stop gate in this reviewing session read the phase-35 board in the
`T-35-03` worktree (Codex's run, not this session's). After
`escalation-record.cjs mark` on T-35-01/02/03 and a `state-sync`, T-35-03 went
to `parked.blocked` but T-35-01 and T-35-02 stayed in `waiting.ci`: the CI
bucket outranks an escalation park in `front.cjs`, so an operator-held PR that
is still running checks keeps the CI-only refusal alive. deliver.md says an
escalation park "drops the ticket from the front", and that holds for every
bucket except this one. Candidate backlog item; not fixed here.
