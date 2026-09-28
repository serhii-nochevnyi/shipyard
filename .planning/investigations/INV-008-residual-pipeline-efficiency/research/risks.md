# INV-008 research line 4 — risks and unknowns

- **Line:** risks (→ RISKS.md and OPEN-QUESTIONS.md drafts)
- **Subject:** `INV-008-residual-pipeline-efficiency:risks`
- **Source revision:** `705eb23328e166bf373701790f1768c90446f503` (`git rev-parse HEAD`; `git describe --tags` → `v0.68.0-16-g705eb233`)
- **Policy hash (DATA):** `30e71fb4066fee5b67df14120532c0b4f8aedde169907bc16f70dd2569744968`, ADR-014 `adr-014.v6`; policy signals for this dispatch: `{}`
- **Selection:** Claude `claude-opus-5-5` / medium (research base rung)
- **Scope:** read-only. This file is the only thing written. No product code, graph, or planning scaffold was changed.

## 0. Evidence method and gaps in this line

Every codebase claim below names the command that checked it. Some checks could not run, and they are listed here so that they are not mistaken for verified facts:

| Intended check | Result | Consequence |
|---|---|---|
| SHA-256 and line count of the **installed** `~/.claude/hooks/shipyard-stop-gate/stop-gate.cjs` and the installed plugin cache | Not run. The sandbox refuses reads outside the worktree (Glob on `~/.claude/plugins`: "outside … --restricted confines the file tools to the working directory"; a compound `cd … && grep` Bash call was auto-denied because it needed approval) | Whether the installed hook is 0.68.0 is **unknown** at this revision. The backlog's 0.66.0 hash match (`a41aea77…`) is a 2026-09-26 observation, not a current one. See OQ-S1-6. |
| Installed Codex host (`codex-delivery-host.cjs`) artifact-contract fields | Not run (outside the worktree) | PREFLIGHT's host blocker is assumed resolved by 0.67.0/0.68.0, not verified here. |
| `origin/main` freshness | `git log --oneline main -1` → `22ef429b` (a phase-40 planning merge), so the **local `main` ref is stale**. `origin/main` was not fetched (no network call made) | Any "is it on main" claim must use `origin/main` after a fetch, never the local `main`. |

`.planning/codebase/` is absent (`ls .planning/codebase` → "No such file or directory"), as PREFLIGHT already recorded.

## 1. Command-backed facts that the risks depend on

### 1.1 Phase-43 state: "merged" means merged into the epic, not into main

- `node -e` over `.planning/graph/delivery-state.json` gives T-43-01, -02, -03, -05 and -09 `merged`; T-43-04, -07, -10 and -11 `pr-open`; T-43-06, -08 and -12…-19 `pending`.
- `delivery-state.json["T-43-03"]` → `"merged_into":"epic/43-target-project-delivery-at-scale"`.
- `git merge-base --is-ancestor origin/epic/43-target-project-delivery-at-scale HEAD` → exit 1. The epic is **not** in this revision. `git log -1 origin/epic/43-…` → `7552b655`.

**Implication (R-X1, below).** The independence rule in RESEARCH-CONTRACT Q2 ("a phase-43 ticket that is not yet merged") is ambiguous. A ticket "merged" into the epic is still absent from `main` and from 0.68.0. A phase-45 ticket cut from `main` that edits the same file will still conflict with the epic → main merge. Blocking should be measured against **the epic reaching main**, not the ticket's epic merge.

### 1.2 Phase-43 `files_modified` (from the PLAN front matter)

Command: an `awk` extraction over `.planning/phases/43-*/43-*-PLAN.md`. Hyphens were stripped in the output and are restored below.

| Hot file | Phase-43 tickets that declare it (status) |
|---|---|
| `sentinel.cjs` + `tests/unit/sentinel.test.cjs` | T-43-04 (pr-open), T-43-07 (test only, pr-open), T-43-08 (pending), T-43-12 (pending), T-43-19 (pending) |
| `claude-role-host.cjs` | T-43-06 (pending) |
| `codex-delivery-host.cjs` | T-43-06, T-43-16, T-43-17 (all pending) |
| `claude-delivery-host.cjs` | T-43-16, T-43-17 (pending) |
| `delivery-commit-finalizer.cjs` | T-43-06, T-43-17 (pending) |
| `base-merge.cjs` | T-43-06, T-43-13, T-43-17 (pending) |
| `ticket-worktree.sh` | T-43-06 (pending) |
| `role-artifact.cjs` | T-43-05 (merged into epic), T-43-06 (pending) |
| `deliver-dispatch.cjs` | T-43-14, T-43-15 (pending) |
| `commands/deliver.md` | T-43-14 (pending) |
| `commands/decompose.md` | T-43-11 (pr-open), T-43-12, T-43-15 (pending) |
| `validate-graph.cjs`, `front.cjs`, `pipeline-stats.cjs`, `skills/delivery-rules/SKILL.md` | T-43-12 (pending) |
| `gate-trailer.cjs` | T-43-13 (pending) |
| `log-event.cjs` | T-43-07 (pr-open), T-43-08, T-43-18, T-43-19 (pending) |
| `state-sync.cjs` | T-43-09 (merged into epic), T-43-10 (pr-open) |
| `pipeline-config.cjs` | T-43-01 (merged into epic), T-43-10 (pr-open) |
| `comment-policy.cjs`, `publish-gate.cjs`, `scripts/shipyard-pre-push-gate.sh` | T-43-02, T-43-03 (merged into epic) |
| `references/pr-sentinel.md`, `references/ci-fix.md` | T-43-18, T-43-19 (pending) |

Files that **no** phase-43 PLAN declares include `stop-gate.cjs`, `stop-gate-arm.cjs`, `claude-runtime-host.cjs`, `codex-runtime-host.cjs`, `usage-report.cjs`, `dispatch-boundary.cjs`, `run-controller.cjs`, `codex-decompose-host.cjs`, `review-signature.cjs`, the `drift-*` scripts and `lock.cjs`. The command was the same extraction, and none of these names appears in its output.

### 1.3 S1 code facts

- `stop-gate-arm.cjs:23-30` stores one marker per session at `<git-common-dir>/shipyard/stop-gate-armed/<session_id>.json`. `:34` writes `{session_id, armed_at, cwd}`. `:39-46` `isArmed` compares only `session_id`, and `cwd` is never read back. `:54-57` accepts only the `arm` verb, so **no `disarm` exists** (N55 is still present). Checked with Read on `plugins/delivery-pipeline/scripts/stop-gate-arm.cjs`.
- `stop-gate.cjs:491-514`: scoped mode (`run_id`, `SHIPYARD_RUN_CONTROL=scoped` or `SHIPYARD_RUN_STORE_DIR`) reads exactly one run-owned front. `:515-524`: in unscoped armed mode the candidates are `cwd` plus every `git worktree list` entry. `:530-531` sorts by `generated_at` and takes the newest. **The foreign-board defect is still present at this revision.** Checked with Read on `stop-gate.cjs` at offset 480.
- `stop-gate.cjs:533-546` itself documents a second trap: running `state-sync` in the wrong cwd produces a newer `fixpoint:true` front, which "WINS the selection … and silences the gate". Newest-timestamp selection therefore fails in **both** directions, with a false block (the backlog case) and a false allow (this comment).
- The generated copies `plugins/shipyard/host/plugins/delivery-pipeline/scripts/stop-gate.cjs`, `…/stop-gate-arm.cjs` and `…/commands/deliver.md` also exist (Grep `stop-gate-arm` over the worktree, excluding `.planning`). An S1 change has at least four surfaces: source, generated bundle, installer copy and the live hook.
- `scripts/install-shipyard-claude-hook.sh:34-35` installs to `$CLAUDE_HOME/hooks/shipyard-stop-gate/stop-gate.cjs` **by copy**. `:325` says it applies to "new sessions; open /hooks or restart to load in a running session". The backlog note `the-stop-gate-enforcing-this-session-predates-the-fix-for-this-exact-case.md` records a stale installed copy (379 vs 672 lines) that enforced outdated rules.
- The tests that reference the arm helper are `tests/unit/stop-gate.test.cjs`, `stop-gate-arm.test.cjs`, `phase41-stop-wake.test.cjs` and `dispatch-record.test.cjs` (same Grep).

### 1.4 Other package-state facts used below

| Package | Fact | Command / location |
|---|---|---|
| R12/N43 | `deliver-dispatch.cjs:74-89` `resolveLaunchGraphDir`: an explicit `--graph-dir` now wins (`:75-80`, #316, commit `0f7d9ba9`). Without the flag, a tracked `.planning/graph/tickets.json` in the worktree still wins (`:81-83`). `delivery-commit-finalizer.cjs:212,312` still refuse `out-of-scope paths`, and it has no board-file exemption: a Grep for `.planning/graph\|delivery-front\|dispatches.json\|provenance/\|runs/` in that file finds nothing. | Read + Grep; `git log --grep='#316'` |
| N47 | Fixed by `b5c7239d` "fix(release): check the Codex home the live round was pointed at", in release merge `d1c647d6` (#347) | `git log --oneline -i -E --grep='#316\|#347\|CODEX_HOME\|graph-dir'` |
| R11/N29/N30 | `claude-role-host.cjs:23` `DIFF_MAX_BYTES = 1024 * 1024`; `:26` `ARCH_REVIEW_PACKET_TOKENS = 60000` (unchanged) | Grep |
| R13/N46 | `claude-role-host.cjs:442,1054,1100` refuse or require `isDraft !== true`; `sentinel.cjs:922` blocks a draft merge | Grep `isDraft` |
| R17/N58 | `codex-delivery-host.cjs:848` `NO_PUBLISHABLE_DELTA` when no worktree delta | Grep |
| R5/N6 | `deliver-dispatch.cjs:238-243` spawns the **host** `detached: true`; `claude-runtime-host.cjs:713` and `codex-runtime-host.cjs:1064` call `child.kill()` only on local error paths; no Grep hit for `SIGTERM`, `process.on('exit'` or `process.kill(-` in `*-host.cjs` | Grep |
| D5 | `dispatch-boundary.cjs:2080-2087` has a per-dispatch "capacity admission" lease; no run/phase aggregate ledger was found (Grep `aggregate\|admission` hits only those lines in that file, plus reporting files) | Grep |
| D2 | `commands/deliver.md` is 3,017 lines (SCOPING-NOTES recorded 2,913 earlier); `decompose.md` is 681 | `wc -l` |
| R12/N42 | Context (Reads) parsing appears only in `deliver-dispatch.cjs` and `codex-delivery-host.cjs`; `validate-graph.cjs` has no match | Grep `Context \(Reads\)\|contextRead` (files_with_matches) |

## 2. Risk register (RISKS.md draft)

Each risk uses the RISKS.md record format. Severity is this line's judgment. "Lose" means a gate, ownership or a required instruction lost if the package is built naively (RESEARCH-CONTRACT Q5).

### Cross-cutting

#### R-X1 — the phase-43 independence test counts epic-merged tickets as landed
severity: high
The graph says `merged` for tickets that are only in `epic/43-…` (§1.1). A phase-45 ticket cut from `main` that touches `role-artifact.cjs`, `state-sync.cjs`, `pipeline-config.cjs`, `comment-policy.cjs`, `publish-gate.cjs` or `shipyard-pre-push-gate.sh` will conflict with the epic's landing. It may also build on pre-phase-43 behaviour that the epic has already replaced, which is the stacked-delivery failure (N19/N22) reproduced across phases.
mitigation: define "blocking" as "declared by any phase-43 PLAN until `origin/epic/43` is an ancestor of `origin/main`". Check with `git merge-base --is-ancestor origin/epic/43-… origin/main` after a fetch, never the local `main` (stale, §0). Otherwise cut the phase-45 ticket from the epic and declare an explicit cross-phase dependency, as ADR-020's parallel-delivery amendment does.

#### R-X2 — hot shared files need one serialized owner
severity: high
Several phase-45 packages edit the same files that phase-43 tickets are still rewriting. If each is planned independently, Gate 2 fails on unordered shared paths (ADR-021 context) or, worse, passes with a declared order that recreates N22 conflict churn.

| File | Phase-45 packages that would touch it | Phase-43 owners (§1.2) |
|---|---|---|
| `sentinel.cjs` | R2 (`wait-parent` for inherited red CI), R3/ADR-022 candidate gating, D1 duty scheduling, R18 merge-result gate, ADR-022 drift timing | T-43-04, -08, -12, -19 |
| `claude-role-host.cjs` | R8 packet summary, R10 environment classification, R11 integrator subsets, R12 scratch cleanup, R13 integrator `base` and draft review, C1 reuse, ADR-022 draft input | T-43-06 |
| `claude-delivery-host.cjs` / `codex-delivery-host.cjs` | R1 live base, R4 pre-commit gates, R5 process group, R12 scratch, R13 state base, R14 preconditions, R17 payload persistence | T-43-06, -16, -17 |
| `delivery-commit-finalizer.cjs` | R4, R12 (board files), R17 | T-43-06, -17 |
| `base-merge.cjs` | R2 (mechanical add/add, push), R18 fallback | T-43-06, -13, -17 |
| `deliver-dispatch.cjs` | R1, R13, R14, R15, D6 | T-43-14, -15 |
| `commands/deliver.md` | D2 split, R10 shell-difference rules, S1 caller instructions, every package that changes caller prose | T-43-14 |
| `validate-graph.cjs` | R12 Gate 2 Context (Reads), N37/N40 checks, C4 `checkpoint_reason` | T-43-12 |
| `commands/decompose.md` | P3 checker count amendment, R12/N37/N40 plan-shape rules | T-43-11, -12, -15 |
| `role-artifact.cjs` | R12 reseal (N51), R17 | T-43-05 (epic), T-43-06 |
| `usage-report.cjs` | R13 (N48 stream usage), P4, D6 measurement | — (not phase-43; still shared inside phase 45) |
| `log-event.cjs` | ADR-022 review journalling, D5 reconciliation, R6 repair journal | T-43-07, -08, -18, -19 |

mitigation: the decomposition must assign one owner per hot file per wave. Two concrete proposals: (a) `sentinel.cjs` changes for R2, R3/ADR-022 and D1 go into one ticket chain, ordered R3 → R2 → D1, all after T-43-19; (b) the delivery-host changes (R1, R4, R5, R13-base, R17) go into one chain after T-43-17. `deliver.md` is edited by nearly everything, so D2 (the split) must either come last or come first with a frozen section map. Doing D2 in the middle rebases every other prose edit.

#### R-X3 — the generated bundle and installed copies drift from source
severity: medium
`plugins/shipyard/host/…` holds generated copies of `stop-gate*.cjs` and `deliver.md` (§1.3), and N30 notes 323 KB of generated tree in the epic diff. The Claude hook is installed by copy and is loaded only by new sessions (§1.3). A fix verified on source can be absent where the conveyor runs, which is the "fourth instance" in the stale-hook backlog note and the three phase-27 instances it cites.
mitigation: every S1/D1/R16 acceptance names the installed-path check (hash of the installed file vs the source) as a separate command, and names "restart or `/hooks`" as a rollout step. Consider the backlog's option 1 (a provenance stamp that `state-sync` or the doctor compares) as a cheap S1 companion. Note that this is a scope question, see OQ-S1-7.

#### R-X4 — efficiency treatments reported as savings without a matched cohort
severity: medium
Evidence so far is token counters and dispatch counts: 84.6% of measured Codex **input** was outer coordination, not 84.6% of the quota (MODEL-ROUTING-RESEARCH); Sonnet executors had 56% of child consumption (N49); 9 reviews for 8 PRs (N54). N48 means `usage-report` shows **zero** for a Codex stream transcript, so a Codex-side baseline can under-count silently. A treatment could be promoted on a measurement that cannot see its effect, or one that fails to count what it moved (for example, D1 moves turns from the sentinel into the orchestrator).
mitigation: fix R13/N48 before any Codex baseline. Every P/D treatment reports `inconclusive` without same-account, same-window matched cohorts (ADR-021). Count parent, child, failed and abandoned work together. Correctness packages (S1, R12, R13, R17 and the other R items) are not gated on measurement.

#### R-X5 — concurrent sessions share runtime homes, hooks and the stash stack
severity: medium
N56 (a foreign dogfood `~/.codex` breaks another session's doctor and release, and pre-push checks the cwd worktree) and S1 are the same class of defect: session-global state chosen by location or recency, not by owner. P1 (planning lease) and D5 (aggregate ledger) add new shared stores. Built with the same pattern, they reproduce it.
mitigation: every new shared store (the S1 binding, the P1 lease, the D5 ledger, the C1 reservation) keys on an explicit owner identity (session id plus run id or worktree realpath) and a fencing epoch. It never selects by timestamp or by "the only one present". Reuse `lock.cjs`/`writeAtomic` (used by `stop-gate-arm.cjs:7,35`) and the `run-controller.cjs` fencing rather than a new lock primitive.

### Workstream S

#### R-S1 — binding only the arming cwd breaks the stale-main case
severity: high
The marker already has `cwd` (`stop-gate-arm.cjs:34`). Filtering candidates to `cwd` is the tempting fix, but the backlog's acceptance case 2 (a session parked in a stale main checkout that owns a linked phase worktree) and the comment at `stop-gate.cjs:533-546` show that the arming cwd is often **not** the board's worktree. A naive filter would let a live owner stop early, a false allow. That loses the gate rather than over-enforcing it.
mitigation: the binding names the board explicitly (worktree realpath plus graph dir, or `run_id`) and is written by the command that selects the board (`deliver` Step 0 or the run controller), not inferred from cwd. It needs tests for both A/B opposite-state directions and for the stale-main case.

#### R-S2 — a strict binding traps an abandoned or forked session
severity: high
A binding that fails closed on missing or stale scope can block every Stop turn indefinitely. `pendingScope` in scoped mode (`stop-gate.cjs:497-512`) already shows the refusal shape. `--fork-session` copies the session context but gets a new `session_id`, so either the fork is unarmed (a silent allow) or it inherits a binding it does not own. With no `disarm` (N55), the only escape today is moving the marker by hand or `SHIPYARD_STOP_GATE=off`, which the backlog calls a gate "that enforces nothing".
mitigation: add `disarm` with a reason, a bounded expiry tied to the run's lease or completion (`fixpoint`), and a refusal message that names the exact disarm command. Fork semantics must be decided explicitly (OQ-S1-3).

#### R-S3 — S1 is folded into D1 or measured as efficiency
severity: medium
WORK-PACKAGES, CONTEXT and the backlog all forbid this. D1 depends on S1 installed, and both touch Stop and wake behaviour. `phase41-stop-wake.test.cjs` exercises the arm helper (§1.3).
mitigation: a separate ticket with a human checkpoint, and an acceptance gate on the installed hook. D1's plan declares S1 as a prerequisite, not a co-owned file.

#### R-S4 — scoped-mode regression
severity: medium
Scoped mode already binds to a run (`:496-514`). An S1 change that unifies the two paths could weaken the T-41-03 scoped behaviour.
mitigation: keep the T-41-03 scoped tests unchanged as regression controls, and make any S1 change to the scoped branch a separate diff hunk.

### Workstream P

#### R-P1 — the planning lease duplicates or conflicts with run ownership
severity: medium
`run-controller.cjs` leases and `session-handoff.cjs` locks already exist (SCOPING-NOTES). A third lease can deadlock with them or make them inconsistent: a stale planning lease holder with a live run lease, or the reverse. A global lease over unrelated worktrees is explicitly refused by P1.
mitigation: specify P1 as a fenced lease **per planning worktree realpath**, with a documented precedence against the run lease and a test for two sessions racing.

#### R-P2 — judgment-role timeout recovery double-counts or fabricates a receipt
severity: high
Recovering a researcher, planner or checker after a native wait timeout from the transcript risks: (a) sealing a result from a still-running child, which loses ownership; (b) counting model use twice; (c) accepting a partial transcript. Phase-42 recovery covers executors only.
mitigation: refuse on unknown child liveness (N6 shows orphans exist, R-R5), reuse the original `dispatch-boundary` reservation id, and never issue a second receipt.

#### R-P3 — the bounded checker revision violates the one-checker contract
severity: high
`decompose.md` requires exactly one typed checker receipt (SCOPING-NOTES). A revision loop activated before that contract is amended either fails Gate 2 or quietly weakens it. `decompose.md` is also owned by T-43-11, -12 and -15 (§1.2).
mitigation: a policy amendment (ADR) before code, a count gate that rejects surplus checks, and a plan ordered after the phase-43 `decompose.md` edits.

#### R-P4 — Codex parent/wait reduction removes host-owned launch or cancel semantics
severity: high
Removing the model parent from the dispatch path can lose cancellation, containment or sealing that the parent now provides implicitly (P4 acceptance). Observation is also weak: N48 zeros the Codex stream counts.
mitigation: build the wait-only improvement first. Parent removal requires the native host to prove equivalent launch, containment, cancellation and sealing, with a test per property.

#### R-P5 — INV reuse skips a line or reuses stale evidence
severity: high
Out of scope: "reducing the four independent investigation perspectives". Reuse keyed on less than the full source identity (revision, ADR set, scope, research contract digest) would present old findings as current. A "second fact index" that competes with C3 splits identity.
mitigation: P5 consumes the C3 index (so it waits for the phase-43 epic, like C3) and preserves the original receipts. A changed input triggers gap research, never silent reuse, and all four lines stay mandatory.

### Workstream D

#### R-D1 — host-owned duty scheduling suppresses a needed wake
severity: high
"Unchanged duty causes no new model turn" is correct only if the change detector covers every input: head, CI, review threads, approvals, live merge conditions, and base moves (N59). A missed input is a stalled run that looks like a fixpoint, and a stalled run combined with the Stop gate is the S1 false-allow direction.
mitigation: a declared input manifest for the duty fingerprint with a mutation test per field (the C1 pattern), and shadow mode that compares host decisions with the current model-driven sentinel before enforcement.

#### R-D2 — the instruction split drops a mandatory rule on one runtime
severity: high
`deliver.md` has 3,017 lines (§1.4) and is copied into the generated bundle. Splitting before C2's manifest and verifier exist cannot prove coverage. Codex and Claude load differently (ADR-021). T-43-14 also edits `deliver.md`.
mitigation: D2 strictly after C2's verifier (which waits for the phase-43 epic). Acceptance means the verifier passes on both installed runtimes for every stage, not that the line count went down.

#### R-D3 — repair grouping hides a finding or coarsens tickets globally
severity: medium
Batching comments across heads, or deduplicating by a too-coarse signature (`review-signature.cjs`), can drop a distinct finding. "Cohesive ticket granularity" risks becoming a global default.
mitigation: a batch bound to one head, a changed head invalidates it, rejected hypotheses stay visible, and there is no global granularity change (acceptance already says so).

#### R-D4 — drift reuse and C1 reuse diverge in identity
severity: medium
ADR-021 (amendment) and the problem statement ask INV-008 to settle **one** input-identity primitive for C1, D4 and P5. If D4 ships first with its own identity, C1 and P5 either duplicate it or inherit a weaker one.
mitigation: define the primitive in the ADR and have D4 ship behind or with C1. A missing provenance field refuses, and each ticket keeps its own drift decision.

#### R-D5 — the aggregate ledger blocks verification, or fabricates quota
severity: high
A ledger that reserves capacity by launch count can starve the checkpoint, verification or review launches that must run for a gate to pass, which is loss of a quality gate by exhaustion. Mapping missing quota data to a percentage violates ADR-021's rules.
mitigation: reserved classes (verification, review, checkpoint) that the cap cannot consume, conservative count bounds when quota is unknown, exhaustion as a resumable `resource` state, and shadow mode first. It lives in `dispatch-boundary.cjs`, which is not phase-43-owned (§1.2), so it could start early. Its measurement still depends on R13/N48.

#### R-D6 — the short-context outer handoff loses instructions or ownership, or becomes a downgrade
severity: high
MODEL-ROUTING-RESEARCH: the evidence is counters, not quota, and the T-43-14 Luna/max coordinator switch is "not evidence of quality equivalence". Risks: a handoff that omits a mandatory rule, creation of duplicate native dispatches, and a global model downgrade by implication (out of scope).
mitigation: needs C2 identity, a recorded human experiment decision (ADR-021 effort-experiment protocol), shadow mode, and a separate outer usage identity. Native ADR-014 grids stay untouched.

### Workstream R

#### R-R1 — base following makes any base acceptable
severity: high
The fix for N1/N45 (take the base from the board after the parent merges) must still refuse a base that is neither the recorded parent nor the board's live base. Loosening `executorCommitInput`'s `prBase === row.pr_base` check to "any ancestor" would let a mis-cut worktree finalize. The executor artifact's `base_commit` (N20) must record the cut point, not the live ref.
mitigation: an explicit two-value allow set (parent while open, epic after the recorded merge), and tests for a deleted parent branch.

#### R-R2 — mechanical conflict resolution resolves a real conflict
severity: high
"Blob equals the child's base" is safe only when compared per path with the exact merge-base objects. A content comparison after normalization, or `--ours` by default, silently drops the parent's rework (N22: T-40-27 kept T-40-18's superseded design).
mitigation: identity by object id only. Anything else goes to one receipted integrator launch, and there is never a hand commit. `base-merge.cjs` is owned by T-43-06, -13 and -17, so R2 waits for the epic.

#### R-R3 — candidate gating starves or serializes everything
severity: medium
ADR-022 decided this, but naive ranking can starve a sibling behind a candidate that waits on a person. ADR-022's person-wait exception must be implemented with the `wait-parent` semantics.
mitigation: implement exactly the ADR-022 rules, and measure wall time and sentinel rounds (ADR-022 consequence).

#### R-R4 — pre-commit gates run with the wrong base or config
severity: medium
Running `comment-policy` and `publish-gate` inside the hosts before commit duplicates T-43-02/03 base resolution and configured markers. If the host passes no ticket base, `publish-gate` falls back differently from CI (ADR-020 base-resolution decision).
mitigation: call the phase-43 entry points with the ticket's recorded base. Wait for T-43-02/03 to reach main (they are only in the epic, R-X1).

#### R-R5 — process-group kill takes out unrelated work, or kill-on-exit races sealing
severity: medium
`deliver-dispatch.cjs:240` already detaches the host. Adding a group kill in the host must not kill the dispatcher's group or the host's own sealing step. A stale-writer check based on a pid alone is subject to pid reuse.
mitigation: record pid plus start time (or a process-group id) in the in-flight record. Order seal before kill in normal exit, and test the SIGTERM path.

#### R-R6 — a verdict repair turn becomes a model retry loop
severity: low
One re-ask with the validation error is bounded. A contradictory verdict could still be "repaired" into the answer the host wants, which weakens independent judgment.
mitigation: journal both results, refuse on the second, and never tell the model which verdict value to pick.

#### R-R7 — the "real boundary" verification commands need network, CLIs or secrets
severity: medium
Live capture or CLI round trips (N11/N18/N25/N32) cannot run in the executor sandbox (N21, N38) or in Linux CI without credentials. Required verification that cannot run becomes a permanently red gate or a "not run" note (N32: "Live round not run: needs CLIs").
mitigation: split verification into the host-runnable part (ADR-020 host verification allow-list, `node`/`bash`/`make` only, N40) and an operator live-round step with a named receipt.

#### R-R8 — elided captures remove evidence a reviewer needs
severity: medium
Replacing capture bodies by digest (N29) keeps the packet bound, but a reviewer can no longer see a scrubbing leak (N28) in the capture.
mitigation: a deterministic scrubber check over the full capture runs in CI, so the reviewer sees the digest plus the checker result.

#### R-R9 — making the flaky tests deterministic removes the concurrency they test
severity: medium
Injected clocks can turn a real cross-process atomicity test (`dispatch-boundary` file reservation) into a single-process test that no longer detects the race.
mitigation: the acceptance already requires the guard-removed variant to fail. Keep one real multi-process case per suite with explicit barriers.

#### R-R10 — environment-only adjudication becomes a waiver path
severity: high
This is the riskiest gate change in phase 45. A misclassified assertion failure (an `EPERM` that is actually the code under test writing to a forbidden path) would be adjudicated away. An adjudication issued without an audited authority is a forged `conform`. ENVIRONMENT-RECOVERY-RESEARCH states that the T-43-03 violation "remains a real gate refusal" until a contract is accepted.
mitigation: classification by a failure phase (setup before any assertion), proven from the command runner's output. Trusted same-command CI evidence on the exact head, base and instruction set. The original violation is preserved. Human authority or an accepted deterministic policy is required. Any source or architecture finding stays blocking. R10 and C1 stay separate (ADR-022 out of scope keeps R10's contract with its owner).

#### R-R11 — per-subset integration misses cross-subset interactions
severity: high
ADR-022 keeps the integrator on "the full combined phase diff as the architectural interaction check". R11's per-subset verdicts combined into one would weaken exactly that check. ADR-022 also says to fix the N44 `base` defect "before any reduction of its scope is considered".
mitigation: first exclude generated trees and name the bound (both safe). Per-subset integration requires an ADR decision on how cross-subset interactions are judged. It is not the default.

#### R-R12 — the board-file exemption hides a real out-of-scope write
severity: high
Making the finalizer "ignore generated board files" (N43) is a blanket exemption. An executor that edits `tickets.json` or other planning files through a bug would be committed silently or dropped silently. #316 fixed only the explicit-flag path (`deliver-dispatch.cjs:75-83`, §1.4). The no-flag branch still writes into a tracked worktree graph.
mitigation: fix the source (every board write goes to the canonical graph dir). The finalizer exempts only the exact generated file set, defined once (the ADR-020 scratch-definition pattern), and refuses anything else. Scratch cleanup (N50) uses T-43-06's `conveyor-scratch.cjs` (pending) rather than a second list.

#### R-R13 — the arch-review host reviews drafts and loses the undraft gate
severity: medium
ADR-022 requires `isDraft` to become a reuse-manifest input and undraft to remain unreachable without conform. The hosts' `isDraft === true` refusals are spread over several checks (`claude-role-host.cjs:442,1054,1100`), and removing all of them could also remove the post-review "unchanged" identity check at `:1100`.
mitigation: change only the pre-review identity check, keep `:1100` and `sentinel.cjs:922`, and test that a draft cannot be merged.

#### R-R14 — preconditions checked at the wrong path or `TMPDIR`
severity: low
N53: the capture landed in the parent's `TMPDIR`, not the sandbox's `/tmp/claude-502`. A precondition check that resolves `TMPDIR` in the dispatcher gives a false pass.
mitigation: preconditions name worktree-relative paths, or a host-resolved sandbox path that is recorded in the refusal.

#### R-R15 — the executor context budget drops mandatory sources
severity: high
N49's 640 KB packet is the largest single lever (56% child share), so pressure to cut it is strongest. C3's "packet builder refuses when a mandatory source is not embedded" is the guard, and it waits for the phase-43 epic.
mitigation: R15 builds on C3. Measure first, and cut only optional references.

#### R-R16 — dedicated dogfood homes break existing operator setups
severity: medium
Changing the default dogfood `CODEX_HOME` moves installs away from where the operator's running sessions look.
mitigation: an explicit migration message from the doctor, no automatic deletion, and pre-push checks the pushed worktree (`scripts/shipyard-pre-push-gate.sh`, also T-43-02's file, R-X1).

#### R-R17 — payload recovery synthesizes or cross-binds bytes
severity: high
The recovery must restore **the same** bytes bound to the original dispatch. A convenient implementation that accepts a later turn's files (the T-43-14 case) is exactly what ENVIRONMENT-RECOVERY-RESEARCH forbids. Persisting before the signed commit adds a new private store with retention and permission requirements.
mitigation: persist digests and bytes atomically with the finalization candidate. Refuse when absent. Test crash points before and after persistence and finalization. The unmerged-branch re-cut (OQ-R17-2) stays a refusal until designed.

#### R-R18 — merge-result attestation accepts a stale proof
severity: high
The risk is that `CLEAN`, an old check, or a rerun (same `GITHUB_SHA`) is accepted, or that the attested tree differs from the actual squash result. A merge queue needs `merge_group` triggers and branch rules that ephemeral epics do not have (MERGE-BASE-RESEARCH). The T-43-07 counterexample shows attestation must never stand in for architecture review.
mitigation: bind the attestation to repository, PR, head, base, merge tree, workflow digest and run id. Re-read live identities at merge. Base-merge stays the fallback. It is a design spike before any ticket.

### Workstream C (contracts accepted; delivery risks only)

#### R-C1 — carried items land before the phase-43 epic
severity: high
ADR-021 (and its 2026-09-28 amendment) requires C1–C4 to wait for the epic. C1 touches `claude-role-host.cjs` (T-43-06) and must coordinate with T-43-13's carry. C4 touches `validate-graph.cjs` (T-43-12).
mitigation: planning of workstream C starts only after `origin/epic/43` is an ancestor of `origin/main` (R-X1), with line references re-read.

## 3. Packages that could lose a gate, ownership or a required instruction (summary for Q5)

| Loses a quality gate if naive | Loses ownership if naive | Loses a required instruction if naive |
|---|---|---|
| R10 (waiver), R11 (cross-subset check), R12 (blanket finalizer exemption), R18 (stale proof), D5 (starved verification), R2 (silent conflict resolution), R13 (draft merge), P3 (checker count) | S1 (both directions), P1 (lease precedence), P2 (live child), P4 (cancellation), R5 (orphan writer), R1 (any base), R17 (cross-bound payload), D1 (missed wake) | D2 (split), D6 (short handoff), R15 (context budget), P5 (reused research) |

**Shared files that need one serialized owner:** see the R-X2 table. The critical chains are `sentinel.cjs` (R2/R3/D1/R18 plus four phase-43 tickets), the delivery hosts plus finalizer plus `base-merge.cjs` (R1/R2/R4/R5/R12/R13/R17 plus T-43-06/13/16/17), `claude-role-host.cjs` (R8/R10/R11/R12/R13/C1 plus T-43-06), and `deliver.md` (D2 plus everyone plus T-43-14).

**Apparently free of phase-43 file ownership (subject to R-X1, §1.2):** S1 (`stop-gate*.cjs` and the installer; but `deliver.md` caller prose is T-43-14's), R5 (the runtime hosts; the delivery hosts are not), R9 (test files only, except `sentinel`-adjacent ones), D5 (`dispatch-boundary.cjs`), the R13 `usage-report` part, P1/P2/P4 (`run-controller.cjs`, `codex-decompose-host.cjs`). Each still needs the system-state line to confirm its full file list.

## 4. Proposed spikes (not run; `/gsd-spike` candidates)

- `/gsd-spike "S1: two armed Claude sessions in sibling worktrees plus a stale-main owner, against the installed copied hook, with fork-session and re-arm"`: proves the binding and the installed-copy path. It must run outside this sandbox, because it needs `~/.claude/hooks`.
- `/gsd-spike "Does --fork-session keep CLAUDE_CODE_SESSION_ID or mint a new one, and which session_id reaches the Stop hook payload?"`
- `/gsd-spike "R18: detached merge-result CI on an ephemeral epic, compared with the GitHub merge queue (merge_group trigger), including a mid-test base move"`
- `/gsd-spike "R10: classify EPERM-before-assertion from command-runner output for the T-43-03 commands"`
- `/gsd-spike "N48: usage-report on a Codex host-stream transcript with turn.completed.usage, deduplicated against native session counters"`

## 5. Open questions (OPEN-QUESTIONS.md draft)

### Cross-cutting
- [ ] Is "independent of phase 43" measured against a ticket's epic merge or against `origin/epic/43` reaching `origin/main`? (§1.1, R-X1) — owner: maintainer
- [ ] When is the phase-43 epic expected to reach main, and will phase-45 tickets be cut from `main` or from the epic with cross-phase dependencies? — owner: maintainer / phase-43 delivery session
- [ ] Is the installed Claude hook and plugin cache at 0.68.0 on the operator machine, and does its `stop-gate.cjs` hash equal the source? Not checkable from this sandbox (§0). — owner: operator (`shasum -a 256 ~/.claude/hooks/shipyard-stop-gate/stop-gate.cjs plugins/delivery-pipeline/scripts/stop-gate.cjs`)
- [ ] Are the installed Codex research and decompose hosts carrying `artifactContract`/`planning.v1` (the PREFLIGHT blocker)? — owner: installed-host preflight
- [ ] Which single identity primitive do C1, D4 and P5 share, and which fields are common versus per-consumer? — owner: ADR author (INV-008 alternatives line plus maintainer)
- [ ] Who owns `deliver.md` edits during phase 45: does D2 go first (frozen section map) or last? — owner: maintainer / decomposition planner

### S1
- [ ] Which command writes the session → board binding (deliver Step 0, run controller, or `stop-gate-arm arm --board`), and which identity does it store (worktree realpath, graph dir, `run_id`)? — owner: maintainer decision after alternatives line
- [ ] What happens on missing, altered or ambiguous binding: allow with a warning, or block with a named remedy, and with what expiry? — owner: maintainer
- [ ] Does `--fork-session` produce a new `session_id` at the Stop hook, and should a fork inherit, re-bind or start unarmed? — owner: spike (§4)
- [ ] Does `disarm` require the owning session id only, or also a fixpoint or a reason, and is it journalled? — owner: maintainer
- [ ] Should markers of other sessions be garbage-collected, and by whom? — owner: maintainer
- [ ] How is the fix verified in the installed copy and in already-running sessions (restart or `/hooks` is needed, installer line 325)? — owner: S1 plan author / operator
- [ ] Is the installed-hook provenance stamp (backlog option 1) in S1's scope or a separate ticket? — owner: maintainer

### P
- [ ] What is the precedence between the P1 planning lease, `run-controller` leases and `session-handoff` locks? — owner: system-state line plus maintainer
- [ ] How does P2 prove a judgment child has ended (no live writer) before sealing from its transcript? — owner: alternatives line
- [ ] What checker revision count does the maintainer approve, and in which ADR does the `decompose.md` one-checker rule change? — owner: maintainer
- [ ] Which Codex native host features prove equivalent cancellation and containment if the P4 parent is removed? — owner: spike on the installed Codex host

### D
- [ ] What is the complete input manifest of a sentinel duty fingerprint for D1? — owner: system-state line
- [ ] Which launch classes does D5 reserve outside the cap, and what are the conservative count bounds when quota is unknown? — owner: maintainer
- [ ] Which outer Codex coordination stages are eligible for D6 Luna/max, and when must they promote to Sol? (already in OPEN-QUESTIONS) — owner: maintainer model-policy decision

### R
- [ ] Is R11 per-subset integration compatible with ADR-022's "full combined phase diff" decision, or does it need an ADR-022 amendment? — owner: maintainer
- [ ] Who may authorize an R10 environment-only adjudication, and where is it audited? (already in OPEN-QUESTIONS) — owner: maintainer ADR
- [ ] For R12, is the fix "board writes never reach the worktree" (source), "the finalizer exempts an exact generated set" (sink), or both? — owner: alternatives line plus maintainer
- [ ] How does the ticket-worktree lifecycle recover a signed, unpublished, unmerged branch when the R17 payload is absent? (already in OPEN-QUESTIONS) — owner: maintainer ADR
- [ ] Is a GitHub merge queue acceptable for ephemeral epics, given the setup cost and `merge_group` workflow changes? (R18) — owner: maintainer, after spike
- [ ] Which live-boundary R7 verification commands can run in CI, and which need an operator live-round receipt? — owner: constraints line
- [ ] Does R16's default dogfood home change need migration for existing operator installs? — owner: maintainer

## 6. Sources

- Packet-authenticated: PROBLEM.md, RESEARCH-CONTRACT.md, PREFLIGHT.md, SCOPING-NOTES.md, `intake/phase40-delivery-findings.md` (N1–N59), ADR-014/020/021/022, phase-45 WORK-PACKAGES.md, CONTEXT.md, MODEL-ROUTING-RESEARCH.md, ENVIRONMENT-RECOVERY-RESEARCH.md, MERGE-BASE-RESEARCH.md, the two backlog notes (digests in the context packet).
- Read at this revision: `plugins/delivery-pipeline/scripts/stop-gate-arm.cjs` (full), `stop-gate.cjs:480-549`, `deliver-dispatch.cjs:70-99,230-249`, `claude-runtime-host.cjs:700-719`, `.planning/backlog/the-stop-gate-enforcing-this-session-predates-the-fix-for-this-exact-case.md`, the existing `RISKS.md` and `OPEN-QUESTIONS.md`.
- Commands: `git rev-parse HEAD`; `git describe --tags`; `git log --oneline main -1`; `git merge-base --is-ancestor origin/epic/43-… HEAD` (exit 1); `git log -1 origin/epic/43-…`; `git log --grep` (#316/#347); `node -e` over `tickets.json`/`delivery-state.json`; `awk` over the `43-*-PLAN.md` front matter; `wc -l deliver.md decompose.md`; Grep for `DIFF_MAX_BYTES`, `isDraft`, `NO_PUBLISHABLE_DELTA`, `out-of-scope paths`, `detached: true`, `SIGTERM|child.kill`, `aggregate|admission`, `Context (Reads)`, `stop-gate-arm` and `stop-gate` in `scripts/`.
- External claims (GitHub `pull_request` merge-ref semantics, rerun SHA semantics, merge queue `merge_group`) are taken from MERGE-BASE-RESEARCH's cited GitHub docs. They were not re-fetched in this line.
