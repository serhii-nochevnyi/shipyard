# Review-round spikes S1 and S4 (ADR-035 R-10, REQ-207)

Baseline commit: `e36c0d8633c67959fdbb02558a7f805f9d6d4e59` (release 1.0.0-rc.3, `epic/harness-simplification`, plus the phase 54 planning files; `git diff 9ba94e7c e36c0d86 -- plugins capabilities` is empty, so the code under test is that of `9ba94e7c`). "Current release" below means 1.0.0-rc.3; the plan's must-have text says 1.0.0-rc.2, while CONTEXT.md gives the base as 1.0.0-rc.3 and the version target as 1.0.0-rc.4. Node `v24.21.0`, darwin. Reproduce with `node --test tests/unit/code-review-round-spikes.test.cjs` in the clean environment (about 125 s; it prints every table below as `# ...` diagnostics).

Nothing under `plugins/`, `capabilities/` or `tests/fixtures/` is changed. The test copies `plugins/delivery-pipeline` and `tests/fixtures/code-review` into its own temporary directory, patches the copies by exact-text replacement (each replacement asserts exactly one occurrence), and drives real sealing through the fixture in child `node` processes. Every child gets a temporary `HOME`, `CODEX_HOME`, `TMPDIR`, `XDG_*` and `GIT_CONFIG_GLOBAL` as in `tests/unit/run.sh`. The protection is that environment: a single spawn helper asserts, before every child starts (probes and the status CLI), that `HOME`, `TMPDIR` and `GIT_CONFIG_GLOBAL` resolve inside the test's own temporary directory. The test never reads the real state directory.

## Patches

Three target texts, each currently reading the per-PR cap constant `ROUND_CAP` (3):

| Site | File and current line | Target text | Replacement |
|---|---|---|---|
| normalize | `code-review-core.cjs:196` (`normalizeResult`) | `round > ROUND_CAP \|\|` | `round > 5 \|\|` |
| seal | `role-artifact.cjs:3099` (`codeReviewResultData`) | `result.review_round > core.ROUND_CAP` | `result.review_round > 5` |
| replay | `role-artifact.cjs:3143` (`authenticatedCodeReviewRecord`) | `lineage.active.size >= require('./code-review-core.cjs').ROUND_CAP` | `lineage.active.size >= 5` |

Variants: A is the unpatched copy; B patches normalize and seal; C patches all three. Variant T is C with the replay guard replaced by `((globalThis.guardSizes ??= []).push(lineage.active.size), lineage.active.size >= 5)`, which records the `active.size` seen at every guard evaluation; it changes no outcome and exists only to measure the lineage arithmetic.

Lineage built by every probe: round 1 is a full review with one blocking finding (`CR-01` of `review.json`); round n > 1 is a delta whose only content is the carried BLOCKER with disposition `unresolved`, re-sealed after `retainPlanningInput` (Claude: session transcript; Codex: `retainPlanningInput(..., { runtime: 'codex' })`, a native Codex session). Each round is a new commit and adds one merged fix ticket to the graph. After each attempt the probe reads `priorCodeReviewVerdicts` and `currentCodeReviewVerdict`.

## S1 result (both runtimes give identical rows)

Per round: the sealing outcome (`stage` is where it stopped), the `answer_authenticated` flag of every verdict in the history, and the current verdict at the new head.

| Round | A: unpatched | B: normalize + seal | C: normalize + seal + replay |
|---|---|---|---|
| 1-3 | sealed, history all `auth=true`, current `needs-fix` | same | same |
| 4 | refused at `normalize`: `INVALID_RESULT invalid review round or scope`; history stays 1-3; current `null` | sealed, history 1-4 all `auth=true`, current round 4 `needs-fix` | same as B |
| 5 | not reached | refused at `seal`: `REVIEW_NATIVE_INVALID original carried findings lack authenticated sealed source lineage`; history stays 1-4 `auth=true`; current `null` | sealed, history 1-5 all `auth=true`, current round 5 `needs-fix` |
| 6 | not reached | not reached | refused at `normalize`: `INVALID_RESULT invalid review round or scope`; history stays 1-5; current `null` |

Raw rows (Claude runtime; the Codex runtime printed the same rows; `...` marks the earlier rounds, which sealed and are omitted):

```text
variant A claude
... (rounds 1-3 sealed)
4 | normalize INVALID_RESULT invalid review round or scope | history=[{"round":1,"auth":true},{"round":2,"auth":true},{"round":3,"auth":true}] | current=null | guard_seal=[] | guard_history=[]
variant B claude
... (rounds 1-3 sealed)
4 | sealed | history=[{"round":1,"auth":true},{"round":2,"auth":true},{"round":3,"auth":true},{"round":4,"auth":true}] | current={"round":4,"verdict":"needs-fix"} | guard_seal=[] | guard_history=[]
5 | seal REVIEW_NATIVE_INVALID original carried findings lack authenticated sealed source lineage | history=[{"round":1,"auth":true},{"round":2,"auth":true},{"round":3,"auth":true},{"round":4,"auth":true}] | current=null | guard_seal=[] | guard_history=[]
variant C claude
... (rounds 1-4 sealed)
5 | sealed | history=[{"round":1,"auth":true},{"round":2,"auth":true},{"round":3,"auth":true},{"round":4,"auth":true},{"round":5,"auth":true}] | current={"round":5,"verdict":"needs-fix"} | guard_seal=[] | guard_history=[]
6 | normalize INVALID_RESULT invalid review round or scope | history=[{"round":1,"auth":true},{"round":2,"auth":true},{"round":3,"auth":true},{"round":4,"auth":true},{"round":5,"auth":true}] | current=null | guard_seal=[] | guard_history=[]
```

Findings of the S1 run:

- The refusal of round 4 in A and of round 6 in C comes from `normalizeResult` in the probe's own carry step, before any seal is attempted. In B and C rounds 4 and 5 do pass through the patched seal check (`:3099`); no S1 refusal originates there. The unpatched `:3099` check is observed refusing a sealed round-4 verdict in S4.
- In B round 5 is normalized and reaches `sealJudgment`, which refuses through the lineage guard; the message does not name the guard, only the missing lineage (see the arithmetic below).
- A, B and C behave identically on the Claude and the Codex path.

## Seal-time lineage arithmetic

Variant T, rounds 1-5, Claude (the Codex rows are the same). The test asserts exactly this: at round N the seal-time guard sizes are `0..N-2` twice, and every history-read size is 0 or 1. In the refused rows of A, B and C the carried history is asserted to be the N-1 sealed rounds, all `auth=true`.

```text
1 | sealed | ... | guard_seal=[] | guard_history=[0]
2 | sealed | ... | guard_seal=[0,0] | guard_history=[0,0,1]
3 | sealed | ... | guard_seal=[0,1,0,1] | guard_history=[0,0,1,0,1]
4 | sealed | ... | guard_seal=[0,1,2,0,1,2] | guard_history=[0,0,1,0,1,0,1]
5 | sealed | ... | guard_seal=[0,1,2,3,0,1,2,3] | guard_history=[0,0,1,0,1,0,1,0,1]
```

Reading the code against these numbers:

- Seal path. `sealJudgment` (`role-artifact.cjs:4033`) calls `authenticateCodeReviewAnswer({ trusted, result, evidence, identity })` with no `lineage` (`:4064-4065`), so the default `codeReviewReplayState()` (`:2834`, `:2901`) is a fresh `{ active: new Set(), ... }`. The record being sealed is not in `active`. `authenticateCarriedCodeReviewFindings` (`:2862`; it returns at once when nothing is carried, `:2863`) enters the predecessor through `authenticatedCodeReviewRecord` (`:2892`, guard at `:3143`) with `active.size = 0`; that record's replay calls `authenticateCodeReviewAnswer` again with the same `lineage` (`:3198`), entering its own predecessor with `active.size = 1`, and so on. Sealing round N therefore evaluates the guard at sizes 0 .. N-2, and the largest size is N-2: 0, 1, 2, 3 for rounds 2, 3, 4, 5.
- With the guard at `>= 3` the walk for round 5 reaches size 3 and is refused; round 4 reaches 2 and passes. This is the observed B result, and it is the only reason B refuses round 5.
- The walk is evaluated twice per seal (the sequences above repeat): once in `sealJudgment` (`:4065`) and once in `validateJudgmentManifest` (`:4102`, `:4246`), each with its own fresh lineage.
- History read. `priorCodeReviewVerdicts` (`:3208`) shares one `lineage` across all records of the call (`:3213`, passed at `:3220`); the memo (`:3145`) answers each predecessor after the guard. In these probes the records of one worktree are replayed oldest first (warm memo) and the sizes seen are 0 and 1 for every N. The cold case is measured in the next section.
- A failure inside a nested replay is swallowed into `answer_authenticated: false` (`:3196-3201`); the seal path surfaces it as the lineage message at `:2896-2898`.

## Cold history read (replay bound)

Variants R5, R4 and R3 are C with the replay bound set to 5, 4 and 3 and with `Object.values(authorityState(worktree).payload.records)` in `priorCodeReviewVerdicts` (`:3216`) reversed (`.reverse()`, exactly-one-occurrence replacement), so the newest record is replayed first and the memo is cold. Five rounds are sealed with C, then each variant reads the same worktree. Both runtimes give the same result and no read throws (`error=null`):

```text
cold read R5 claude: [{"round":1,"auth":true},{"round":2,"auth":true},{"round":3,"auth":true},{"round":4,"auth":true},{"round":5,"auth":true}] error=null
cold read R4 claude: [{"round":1,"auth":true},{"round":2,"auth":false},{"round":3,"auth":false},{"round":4,"auth":false},{"round":5,"auth":false}] error=null
cold read R3 claude: [{"round":1,"auth":true},{"round":2,"auth":true},{"round":3,"auth":false},{"round":4,"auth":false},{"round":5,"auth":false}] error=null
```

A guard refusal inside a nested replay is swallowed at `:3196-3201`, so a bound below 5 silently downgrades rounds 2-5 (bound 4) or 3-5 (bound 3) to `answer_authenticated: false` when the history is read in reverse order. The bound is therefore the ceiling 5, not the seal-time minimum (largest seal-time size N-2 = 3 at round 5). Reverse order is a probe device; no real catalogue order that produces it was identified (verdicts spread over several registered phase worktrees is the plausible source, not driven).

## S4: code of the current release reads a sealed round-4 verdict

Four rounds sealed with variant C, then read from the same worktree and the same state home. Both runtimes, same result.

```text
patched reader claude: {"history":[{"round":1,"auth":true},{"round":2,"auth":true},{"round":3,"auth":true},{"round":4,"auth":true}],"error":null,"next":{"round":null,"state":"limit","rounds_used":4},"current":{"round":4,"verdict":"needs-fix"}}
unpatched reader claude: {"history":null,"error":{"stage":"history","code":"INVALID_RESULT","message":"invalid code-review round, scope or prior_head"},"next":null,"current":null}
unpatched status CLI claude: exit=1 stdout="" stderr="INVALID_RESULT: invalid code-review round, scope or prior_head\nhint[INVALID_RESULT]: The dispatch result does not match the shape the boundary requires. — remedy: Fix the result fields to match the documented schema and re-run.\n"
```

- The throw leaves `priorCodeReviewVerdicts` from the replay of the round-4 record: `replayCodeReviewRecord` calls `judgmentResultData` (`:3186`), outside the `try` at `:3196-3201`, and `codeReviewResultData` refuses `review_round > ROUND_CAP` (`:3099-3102`). Round-4 sealing is the cause, not the replay depth.
- The patched reader (C) authenticates all four; `nextRound` returns `limit` with `rounds_used: 4` because `ROUND_CAP` is still 3 in the copy.
- `phase-code-review.cjs status` (unpatched): exit status 1, empty stdout, the error line above, then the `INVALID_RESULT` hint. The hint is the generic `INVALID_RESULT` one and tells the operator to fix result fields against a schema, which is not the cause here.

Callers of `priorCodeReviewVerdicts` in the current tree:

| Caller | Line | Guard | Observed |
|---|---|---|---|
| `status` in `phase-code-review.cjs` | `:145` | none | exit 1 as above |
| `prepareCodeReview` in `claude-role-host.cjs` | `:596` | none | read from source; the call is before `nextRound` and in no `try`; not driven |
| `collect` in `codex-code-review-context.cjs` | `:141` | none | read from source; same; not driven |
| `assertCodeReviewLineage` in `role-artifact.cjs` | `:3069` | none; runs only for a `pass` seal and for `validateJudgmentManifest` | not driven |
| `currentCodeReviewVerdict` in `role-artifact.cjs` | `:3310-3311` | `try ... catch { return null; }` | driven on the unpatched copy against the sealed round-4 state: returns `null` (`"current":null` above), where the patched copy returns the round-4 verdict |

The three callers the plan names (rows 1-3) have no guard. The two internal callers are an addition to the research picture.

## Baselines (unmodified tree, run one at a time in the per-file isolated environment of `run.sh`)

| Command | Result | Wall time |
|---|---|---|
| `node tests/unit/role-artifact.test.cjs --code-review-d37-only` | 6 passed, 0 failed | 30 s |
| `node --test tests/unit/deliver-dispatch.test.cjs` | 41 passed, 0 failed | 16 s |
| `node --test tests/unit/claude-role-host.test.cjs` | 244 passed, 0 failed (TAP `ℹ pass 244`, `ℹ fail 0`; the research recorded 235 at `749604b9`) | 421 s |

## Differences from the research and the plan

Line numbers in `54-RESEARCH.md` and `54-01-PLAN.md` are against `749604b9`; HS-45, HS-46 and HS-47 moved code. Current lines (`e36c0d86`):

| Subject | Research | Current |
|---|---|---|
| round check in `normalizeResult` | `code-review-core.cjs:196` | unchanged, `:196` |
| seal round check | `role-artifact.cjs:3146` | `:3099` (`codeReviewResultData`) |
| replay guard | `:3188-3199`, `:3190` | `:3141-3152`, `:3143` |
| `priorCodeReviewVerdicts` | `:3255-3278` | `:3208-3231` |
| nested-replay `try` | `:3243-3248` | `:3196-3201` |
| `judgmentResultData` in the replay | `:3233` | `:3186` |
| seal call to `authenticateCodeReviewAnswer` | `:4097-4098` | `:4064-4065` |
| default `lineage` and `codeReviewReplayState` | `:2947`, `:2880-2882` | `:2901`, `:2834` |

HS-46 moved the ticket-set handling: the host now re-attaches `ticket_set` at seal (`withHostTicketSet`, `:4026`, used at `:4044`) and strips it when replaying the model answer (`withoutHostTicketSet`, `:4019`, used at `:3002`). Every round of the probe passes through both, and none of the research's S1/S4 outcomes changed.

Divergences from the plan and the research:

1. The refusal of round 4 (A) and round 6 (C) occurs in `normalizeResult`, not at seal validation; the plan's wording "variant A refuses round 4 with `INVALID_RESULT`" holds, the site is `code-review-core.cjs:196`.
2. Five callers of `priorCodeReviewVerdicts` exist, not three; one of the two extra (`:3310`) is guarded.
3. The history-read replay depth observed is at most 1 (warm memo). The research's `N-1` figure is the cold-memo case, measured by variants R3-R5 (sizes not traced there; the downgrade outcome is asserted). The seal-time walk needs size N-2, and the bound is still the ceiling 5 because of the cold read.
4. The plan's must-have says a four-deep lineage seals "only when normalization, seal validation and the replay-depth bound all use the ceiling". Variant B contradicts that for round 4: normalize plus seal alone seal and authenticate rounds 1-4; the replay bound first matters at round 5.
5. The status CLI hint for the downgrade case is the generic `INVALID_RESULT` one (see S4).

## Findings carried forward

1. The ceiling must land at all three sites in one ticket (T-54-05): normalize `code-review-core.cjs:196`, seal `role-artifact.cjs:3099` and replay `role-artifact.cjs:3143`. With only the first two, round 4 seals and round 5 is refused as a missing lineage. The replay bound stays 5 and not the smaller seal-time minimum, because a cold history read (variants R3-R5) silently downgrades verdicts to `answer_authenticated: false` under a lower bound.
2. No guard can help the older reader: its `priorCodeReviewVerdicts` throws `INVALID_RESULT` on a sealed round-4 verdict, observed at `status`; the Claude host and the Codex context call it the same way, unguarded (read from source, not driven). The release notes must say that a project holding a sealed round-4 or round-5 verdict cannot be downgraded (drafted in T-54-13's PR body). The rollback behaviour is recorded here, not fixed.
3. The verdict-sealing fixture needs an extension input (T-54-08). The probe needed none: it drives the existing `artifact-fixture.cjs` and the carried-findings loop unchanged.
4. The permanent TDD tests in T-54-05 (five-deep lineage on both runtimes, ceiling at 4 and 5, sixth refused) replace this probe, which T-54-05 deletes.
5. The status hint for the downgrade failure is the generic `INVALID_RESULT` one (see S4); the T-54-13 notes should state the downgrade limit explicitly because the CLI does not.
