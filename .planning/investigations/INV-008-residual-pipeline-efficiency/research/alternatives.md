# INV-008 research line — alternatives & prior art (OPTIONS.md draft)

- **Line:** alternatives. **Policy signals (verbatim DATA):** `{"type":"alternatives"}`.
- **Selection:** Claude `claude-opus-5-5`/medium, resolved by the caller. This is the ADR-014 Claude `research` base rung; `alternatives` does not promote it (ADR-014 §3).
- **Source revision:** `705eb23328e166bf373701790f1768c90446f503`. Checked with `git rev-parse HEAD` in `/Volumes/KINGSTON/.wt-claude-shipyard/inv008`.
- **Policy hash:** `30e71fb4066fee5b67df14120532c0b4f8aedde169907bc16f70dd2569744968` (context packet).
- **Scope:** read-only. This line writes only this file. It makes no recommendation, because the choice belongs to the human (research contract, Line 2). It does not reopen ADR-021 (C1–C4) or ADR-022.
- **Context note:** the context packet reported `overflow: true` (40,806 estimated tokens against a 12,000 soft ceiling). It also reported `required_preserved: true`, so no required reference was dropped.

## 0. Command-backed evidence used by this line

| # | Command (run from the worktree root) | Relevant output |
|---|---|---|
| E1 | `git rev-parse HEAD` | `705eb233…0446f503` |
| E2 | `cat -n plugins/delivery-pipeline/scripts/stop-gate-arm.cjs` | 69 lines. `arm()` writes `{session_id, armed_at, cwd}` (`:32-37`). `isArmed()` compares only `session_id` (`:39-46`). The CLI accepts only `arm`, and anything else prints usage and exits 1 (`:54-57`). There is **no `disarm`** (N55 confirmed at this revision). |
| E3 | `sed -n 470,560p plugins/delivery-pipeline/scripts/stop-gate.cjs` | Scoped mode (`run_id`, `SHIPYARD_RUN_CONTROL=scoped` or `SHIPYARD_RUN_STORE_DIR`) reads exactly one run-owned front. It refuses on a `run_id` mismatch through `pendingScope`. The unscoped armed path scans `[cwd, ...worktreesOf(cwd)]` and sorts by `generated_at`, and the newest front wins. The S1 defect is still present in source at this revision. |
| E4 | `grep -n "session_id\|disarm" plugins/delivery-pipeline/scripts/stop-gate.cjs` | A per-session ledger `stop-gate-ledger.json {session_id, blocks, …}` exists (`:45`, `:377`, `:418`). No `disarm` match. |
| E5 | `grep -rln "stop-gate-arm" plugins/delivery-pipeline/commands plugins/delivery-pipeline/workflows scripts` | Only `plugins/delivery-pipeline/commands/deliver.md` calls arming. |
| E6 | `awk` over `files_modified` in `.planning/phases/43-*/43-*-PLAN.md` | Phase-43 file owners (see §9). No phase-43 plan names `stop-gate*.cjs`, `dispatch-boundary.cjs`, `run-controller.cjs`, `claude-role-host.cjs` (except T-43-06), `orchestration-overhead.cjs` or `context-packet.cjs`. |
| E7 | `node -e` reading `.planning/graph/delivery-state.json` for `T-43*` | Committed projection: merged 01, 02, 03, 05, 09. PR open: 04, 07, 10, 11. Pending: 06, 08, 12–19. **This is a projection and may be stale.** The committed state was stale before (ADR-021 last bullet), and the system-state line must recheck it. |
| E8 | `grep -n "exactly one\|one typed checker\|gsd-plan-checker" plugins/delivery-pipeline/commands/decompose.md` | The checker is a typed `gsd-plan-checker` role on the `decomposition` grid (`:174`, `:194`, `:202`), sealed as `shipyard.decomposition-result.v1` (`:284-287`). The literal "exactly one" wording was not matched by this grep, so the one-checker rule is taken from `SCOPING-NOTES.md` (P3 row) and is **unverified here**. |
| E9 | `grep -n "lease\|fenc\|epoch" plugins/delivery-pipeline/scripts/run-controller.cjs` | Run leases with `lease_id`/`epoch` (`:115-116`, `:156-157`, `:192-194`) and a TTL (`:263`). |
| E10 | `ls plugins/delivery-pipeline/scripts \| grep -iE "disarm\|payload\|admission\|budget\|lease\|merge-queue\|attest"` | Only `capacity-lease.cjs` matched. It uses schema `shipyard.capacity-leases.v1`, a 30-minute TTL and a 10-minute heartbeat, and runs under `withLock` (`:6-10`). There is no admission, payload or attestation module. |
| E11 | `grep -n "function reserve\|reservation" plugins/delivery-pipeline/scripts/dispatch-boundary.cjs` | Per-dispatch atomic reservation file (`:290`, `:595-602`) and `recorderReserve` (`:1533-1551`). These reservations are per dispatch, not aggregate. |
| E12 | `grep -n "wait_poll\|model_turn" plugins/delivery-pipeline/scripts/orchestration-overhead.cjs` | Separate `wait_poll`/`model_turn`/`tool_call` stages and `polls`/`model_turns` counters (`:25`, `:31`, `:157`, `:178`). |
| E13 | `grep -n "source_revision" plugins/delivery-pipeline/scripts/context-packet.cjs` | The packet binds `source_revision` and `policy_hash` and refuses a mismatch with `CONTEXT_PACKET_IDENTITY` (`:436`, `:537-539`). |
| E14 | `grep -n "arch-review" plugins/delivery-pipeline/scripts/sentinel.cjs` | `arch-review` is offered for green drafts (`:677-682`) and for green non-drafts (`:719-721`) with no candidate ranking. `ACTIONABLE` includes `arch-review` and `base-merge` (`:812`). |
| E15 | `grep -n "\['push'\|\"push\"\|push'," plugins/delivery-pipeline/scripts/base-merge.cjs` | No match. The only `push` hit in an earlier broad grep was the array `taken.push(p)` (`:268`), so `base-merge.cjs` has no `git push` (N3). |
| E16 | `grep -n "pr_base" claude-delivery-host.cjs deliver-dispatch.cjs` | The Claude host binds `row.pr_base` (`:213`, `:346`, `:515-518`). `deliver-dispatch.cjs:127` prefers `s.pr_base \|\| s.base \|\| row.pr_base`, and `:172` sends `prBase: row.pr_base` (N1/N45 still present at `:172`). |
| E17 | `grep -n "DIFF_MAX_BYTES\|ARCH_REVIEW_PACKET_TOKENS" claude-role-host.cjs` | `DIFF_MAX_BYTES = 1 MiB` (`:23`). `ARCH_REVIEW_PACKET_TOKENS = 60000` (`:26`). The diff uses `--unified=50` (`:421`) and the refusal text is `role diff exceeds the bounded context packet` (`:422`). |
| E18 | `grep -rn "merge_group" .github/workflows/` and `grep -n "^on:" -A5 .github/workflows/test.yml` | No `merge_group` trigger. `test.yml` runs on `pull_request` and on `push` to `main` only. |
| E19 | `wc -l plugins/delivery-pipeline/commands/deliver.md` | 3,017 lines. `SCOPING-NOTES.md` says 2,913, so the file has grown. |

External prior-art claims are sourced from the GitHub documentation already cited in `MERGE-BASE-RESEARCH.md` (`pull_request` merge-ref semantics, rerun SHA semantics, `merge_group` requirement). This line made no network call.

## 1. Framing: four genuinely different whole-phase strategies

These differ in **how much of phase 45 is built, and when**. Per-package options follow in §2–§8.

- **Option A — Do nothing beyond S1 (correctness-only).** Ship S1 as its own high-risk ticket. Record all P/D/R packages as backlog and wait for phase-43 landing and the ADR-021 C1–C4 observations.
- **Option B — Correctness-first, then measured treatments.** First deliver the correctness/reliability fixes that are independent of phase 43: S1, R5, R9, R12 and R17 where their files are free (§9). Then add the R/D items that sit on phase-43 files once the epic merges. Treat P1–P5 and D1–D6 as one-at-a-time experiments behind the phase-44 observation data.
- **Option C — Host-owned conveyor ("move routine judgment out of model turns").** Put D1 (host-side sentinel scheduling), D5 (admission ledger), P4 (parent/wait) and R14 (pre-launch human preconditions) together behind one controller extension to `run-controller.cjs` and `capacity-lease.cjs`. This is a larger shared owner file set, and every treatment then shares one rollout.
- **Option D — Buy, don't build, where a hosted primitive exists.** Use a GitHub merge queue (`merge_group`) for R18, protected-branch rules for epic branches, and GitHub's native concurrency groups for CI churn. Build only what GitHub cannot express, such as S1, R17 and P1.

| | A — S1 only | B — correctness-first, measured treatments | C — host-owned conveyor bundle | D — buy hosted primitives |
|---|---|---|---|---|
| Complexity | Lowest: one ticket, 2 scripts plus tests (E2, E3) | Medium: many small tickets, serialized per shared file | High: one large controller change touching the run-lease, reservation and duty paths | Medium: config and workflow setup plus a new `merge_group` trigger (E18); build elsewhere |
| Measured waste addressed | None of the quota waste (84.6% outer Codex coordination; 56% Sonnet executors) | Replays N42–N58 first, then treatments against cohorts | Parent/wait and sentinel turns in one step | Only CI/branch-update churn (N59) |
| Main risks | Waste persists. N43/N50/N51/N58 keep costing executor replays. | Many owners on hot files (`sentinel.cjs`, delivery hosts) → serialization delays | One regression can disable several gates. Treatments cannot be measured separately (conflicts with CONTEXT "keep each treatment independent"). | Ephemeral `epic/*` branches need protection rules. Merge queue on personal repos is an unknown plan capability. Cross-ties to GitHub. |
| Forecloses | Nothing | Bundled treatment rollout | Independent per-treatment rollback and measurement | Host-owned attestation design for R18. Target projects without merge-queue support. |
| Compatible with out-of-scope list | Yes | Yes | Borderline: must not become an always-on daemon | Yes, if the base-merge fallback is retained |

## 2. S1 — armed Stop-gate session-to-board binding (correctness)

Present gap (E2–E5): the marker lacks board/run identity, the unscoped path picks the newest front across worktrees, and there is no `disarm`.

- **S1-a — Bind the marker to an explicit board path.** `arm --board <graph dir>` records the realpath of `.planning/graph` plus the board's `run_id`/epic if present. The Stop hook reads **only** that board, and a missing or unreadable bound board produces an explicit allow-with-warning or bounded block. `disarm` deletes the session's own marker. Cost: small, confined to `stop-gate-arm.cjs`, `stop-gate.cjs`, `deliver.md` and tests. Risk: a path identity alone cannot distinguish two runs on one board. A stale-main `cwd` works because the path is explicit.
- **S1-b — Bind to a run-controller run.** `arm` requires a `run_id` from `run-controller.cjs` (E9). The hook then always uses the existing scoped path (E3), so the unscoped path disappears for armed sessions. Cost: medium, because every `/shipyard:deliver` must create or resume a run before arming. Risk: couples S1 to phase-41 run control. Board-only (unscoped) deliveries lose the gate unless they create a run. Fork and scope switch inherit run-lease semantics (owner epoch).
- **S1-c — Keep discovery but filter by owner.** `front.cjs`/`state-sync` stamps `owner_session_id` into `delivery-front.json`, and the hook ignores fronts not owned by this session. Cost: medium, touching `front.cjs`, which T-43-12 owns (E6), so it waits. Risk: a session-id stamp in a tracked file; a fork (new session id) loses the board until re-sync.
- **S1-d — Do nothing, or document only.** Operators move the marker by hand (the N55 workaround). This retains a reproduced false block, which contradicts the S1 acceptance.

| | S1-a board path | S1-b run binding | S1-c owner stamp | S1-d none |
|---|---|---|---|---|
| Files | `stop-gate-arm.cjs`, `stop-gate.cjs`, `deliver.md` (E5) | + run-controller callers | + `front.cjs` (T-43-12 pending, E6/E7) | — |
| Phase-43 independent | Yes, except `deliver.md`, which T-43-14 lists (E6) | Yes, except `deliver.md` | **No** | n/a |
| Stale-main `cwd` case | Handled (explicit path) | Handled (run worktree) | Handled if stamp readable | Broken |
| Two runs, one board | Not distinguished | Distinguished | Not distinguished | Broken |
| Fork / re-arm | Re-arm overwrites the path; fork needs a new marker | Epoch/lease semantics | New session id loses its stamp | — |
| Forecloses | Nothing: can be upgraded to S1-b | Unscoped armed delivery | Clean tracked board files | Correctness |

The `deliver.md` overlap with T-43-14 affects only the caller instruction text. Whether one instruction line can be delivered in a separate ticket without a Gate-2 shared-path conflict is an open question for the constraints line.

## 3. R10 — environment-only adjudication; R14 — pre-launch human preconditions

**R10** (N21, N52, N57):
- **R10-a — Classification only.** The reviewer and executor results carry a typed `environment_failure` record (command, phase `setup|assertion`, errno). Nothing changes the verdict, and a fresh review is still needed. This is cheap and safe but saves no review turn.
- **R10-b — Deterministic policy adjudication.** The host issues a separate `environment-adjudication` gate record when every blocking finding is `setup`-phase `EPERM`/`EACCES` on an unchanged head, base and instruction digest, *and* trusted same-command CI or host evidence (ADR-020 host verification) passed. The original violation stays immutable. This needs an accepted deterministic policy (ENVIRONMENT-RECOVERY-RESEARCH treatment 1) and changes merge-gate semantics.
- **R10-c — Human-signed adjudication.** Same evidence as R10-b, but the gate record requires an explicit human command with an audit entry. This is slower, but the authority is unambiguous.
- **R10-d — Fix the reviewer sandbox instead.** Give the reviewer a writable scratch `TMPDIR`, so that the EPERM class disappears. ADR-020 forbids widening sandboxes to network or outside-worktree reads. A worktree-local tmp may be admissible, but this is **unknown**; see the constraints line.

**R14** (N53):
- **R14-a — Plan-declared preconditions.** Planners declare a `preconditions:` list with artifact paths. Gate 2 (`validate-graph.cjs`, which T-43-12 owns) validates it and dispatch refuses before launch. This waits for T-43-12.
- **R14-b — Dispatch-time check only.** `deliver-dispatch.cjs` parses a marked plan section. The file is owned by T-43-14/15 (E6), so this also waits.
- **R14-c — Do nothing.** The operator reads plans. N53 cost three extra Opus launches.

| | R10-a | R10-b | R10-c | R10-d | R14-a | R14-b | R14-c |
|---|---|---|---|---|---|---|---|
| Saves model turns | No | Yes | Yes | Yes | Yes | Yes | No |
| Gate-semantics change | None | New gate record type | New gate record + human | Sandbox policy | Gate 2 schema | Dispatch only | None |
| Main risk | None | False green if classification is wrong | Human bottleneck | Violates ADR-020 sandbox fence | Plan-format churn | Invisible at Gate 2 | Repeats N53 |
| Waits for phase 43 | No, if in the role host only (`claude-role-host.cjs` is T-43-06, E6) | Yes, needs ADR-020 host verification (T-43-16) | Yes (T-43-16) | Unknown | Yes (T-43-12) | Yes (T-43-14/15) | — |

## 4. R16 — concurrent-session host isolation; R17 — executor publication payload

**R16** (N56):
- **R16-a — Dedicated dogfood runtime home by default.** Installers write to `$XDG_STATE_HOME/shipyard/dogfood/<runtime>`, and doctor classifies a foreign cache as `foreign`. Low cost, in the installer scripts only.
- **R16-b — Per-session provenance stamp.** `host-provenance.cjs` records the installing session/worktree, and the doctor ignores foreign stamps. This keeps the shared home but adds identity.
- **R16-c — Do nothing, and document `CODEX_HOME` isolation.** The N47 fix (0.68.0 #347) already handles the live-round precondition.

The pre-push hook's "wrong worktree" part is separate. `scripts/shipyard-pre-push-gate.sh` is owned by T-43-02, which the projection shows as merged (E6, E7), so this part is independent once T-43-02 is confirmed on the epic or `main`.

**R17** (N58):
- **R17-a — Persist the payload before finalization.** The executor host writes result, PR body and evidence into private host state keyed by `dispatch_id` and bound by digests to the finalization candidate, before the signed commit becomes publishable. Recovery replays those bytes through `seal → validate → read`. It touches both delivery hosts and `delivery-commit-finalizer.cjs`, which T-43-06/16/17 own (E6), so it **waits**.
- **R17-b — Refuse finalization without payload.** The finalizer refuses to sign until the payload files exist in the worktree. This is simpler but moves the loss earlier rather than removing it, and it gives no crash recovery.
- **R17-c — Supported lifecycle re-cut.** Add a `ticket-worktree.sh recut` for an unmerged, unpublished branch. The result is honest (the work is replayed) but costs a full executor turn each time.

| | R16-a | R16-b | R16-c | R17-a | R17-b | R17-c |
|---|---|---|---|---|---|---|
| Complexity | Low | Medium | None | Medium–high | Low | Low–medium |
| Saves model turns | Indirect | Indirect | No | Yes (N58: second turn 464,776 input tokens avoided) | Partly (loss is detected before signing) | No |
| Risk | Breaks existing dogfood muscle memory | Stamp spoofing within one user | Recurs | Payload store becomes a new trust boundary | Executor stalls if files are late | History rewrite if misused |
| Phase-43 independent | Yes (installers under `scripts/`: recheck ownership) | `host-provenance.cjs` not in phase 43 (E6) | — | **No** (T-43-06/16/17) | **No** (finalizer) | **No** (`ticket-worktree.sh`, T-43-06) |

## 5. R18 — clean base move without branch-update churn (N59)

Current: `pull_request` CI tests the merge ref at trigger time. There is no `merge_group` trigger (E18), and `sentinel merge` refuses when the ticket is `behind_by` (MERGE-BASE-RESEARCH).

- **R18-a — Status quo: `base-merge.cjs` plus push plus fresh CI.** Safe, and N59 churn remains. `base-merge.cjs` still does not push (E15, N3).
- **R18-b — Host merge-result attestation.** A trusted host computes `merge(base_live, head)` on a detached candidate, runs the required CI through `workflow_dispatch` or host verification on that exact tree, and binds `{repo, PR, head, base, merge tree, workflow digest, run id}`. The merge gate rechecks the live base, head and landing tree. Cost: high, and it touches `sentinel.cjs`/`front.cjs`, which T-43-04/07/08/12/19 own (E6).
- **R18-c — GitHub merge queue (buy).** Add a `merge_group` trigger and a queue rule on `epic/*`. GitHub builds and tests the exact merge. Cost: repository settings plus workflow. Risks: queue rules require branch protection on ephemeral epics; queue availability for the owner's plan is **unknown**; target projects may lack it.
- **R18-d — Reduce pushes only.** Batch base-merges per epic move (one push per sibling after R3/ADR-022 gating). This saves CI churn only for the next candidate, and the others wait.

| | R18-a | R18-b | R18-c | R18-d |
|---|---|---|---|---|
| Complexity | None | High | Medium (config) | Low |
| CI runs saved | 0 | Most clean moves | Most clean moves | Some |
| Head changes | Every move | None | None | Only for the next candidate |
| Gate risk | None | Attestation bug → false green | Queue semantics differ from `sentinel merge` | Low |
| Phase-43 independent | — | **No** | Workflow only: yes; gate integration: no | **No** (`sentinel.cjs`) |
| Forecloses | — | Nothing (fallback kept) | Target projects without queue unless fallback kept | Nothing |

R18 never declares an arch-review conform (WORK-PACKAGES R18). Any option must keep the ADR-022 precedence: exact reuse, then carry, then fresh launch.

## 6. D1 — sentinel duty scheduling; D5 — aggregate admission; D6 — outer Codex coordination

**D1** (N38; the sentinel offers `arch-review` and `base-merge` without ranking, E14):
- **D1-a — Host-side duty diff.** A trusted script runs `state-sync` and `sentinel.cjs duty`, hashes the actionable set, and wakes a model only when the hash changes. This reuses `wait-events.cjs`. Low–medium cost, and it depends on S1 installed (WORK-PACKAGES D1).
- **D1-b — Move mechanical duties to the host.** `undraft`, `merge` and `base-merge` execute host-side, and only `ci-fix`, `review-fix` and `arch-review` launch roles (ADR-020 host-side execution direction, N38). Higher cost, and it touches `sentinel.cjs` (T-43-04/08/12/19).
- **D1-c — Keep the model sentinel but give it a smaller packet.** This saves tokens per turn but does not reduce turns.
- **D1-d — Do nothing.**

**D5**:
- **D5-a — Advisory ledger.** Record the reservations per run/phase and warn over the cap. This is shadow mode.
- **D5-b — Enforcing ledger on `capacity-lease.cjs`.** Extend the existing locked lease store (E10) with an aggregate count/attempt cap and reconciliation, and put the run into a resumable `resource-wait` state on exhaustion. Medium cost. It must reserve verification and checkpoint capacity.
- **D5-c — Aggregate inside `dispatch-boundary.cjs`.** Add an aggregate counter next to the per-dispatch reservation (E11). This is atomic with launch but makes the hot boundary file larger.
- **D5-d — Do nothing, and rely on `run-controller` retry budgets.**

**D6**:
- **D6-a — Bounded digest handoff with the model unchanged (Sol/high).** Reduces the inherited context only.
- **D6-b — Bounded handoff plus a Luna/max candidate for routine stages.** This needs an approved phase-44 effort/model experiment and a human decision. It is not a global downgrade.
- **D6-c — Replace outer collaboration agents with native host dispatch** (`dispatch wait`), so that no outer model agent exists for routine stages. This overlaps with P4.
- **D6-d — Measure only.** Record outer-session identity and the inherited model, and change nothing.

| | D1-a | D1-b | D1-c | D5-a | D5-b | D5-c | D6-a | D6-b | D6-c | D6-d |
|---|---|---|---|---|---|---|---|---|---|---|
| Targets | sentinel turns | sentinel turns + hand duties | tokens/turn | runaway launches | runaway launches | same | 84.6% outer input (MODEL-ROUTING) | same | same | none |
| Complexity | Low–med | High | Low | Low | Med | Med | Med | Med + experiment | High | Low |
| Gate risk | Missed wake on an unhashed input | Host-merge bug | Omitted instruction | None | Skipped gate if capacity is not reserved | Boundary regression | Omitted instruction/evidence | Quality regression | Loss of cancellation/ownership | None |
| Phase-43 independent | Mostly (new script; S1 first) | **No** | **No** (`sentinel.cjs`/refs) | Yes | Yes (`capacity-lease.cjs` not in phase 43, E6) | Yes (E6) | Unknown (`deliver.md` T-43-14) | Unknown | Unknown | Yes |
| Forecloses | — | Model sentinel for mechanical duties | — | — | Unbounded fan-out | — | — | — | Outer collaboration pattern | — |

## 7. P1–P5 — planning reliability

- **P1:**
  - **P1-a** — a planning-tree writer lease in `capacity-lease.cjs`, keyed by worktree realpath, with a fencing token that receipts carry;
  - **P1-b** — reuse the run-controller lease (E9) by making planning a run;
  - **P1-c** — detect only: a foreign edit makes receipts stale, compared through a digest of touched paths, and nothing is locked.

  Trade-off: P1-b gives strong fencing but couples planning to delivery runs. P1-c cannot prevent the loss, only detect it.
- **P2:**
  - **P2-a** — recover from the durable dispatch reservation (E11) plus the authenticated child transcript and artifact digest, with no relaunch;
  - **P2-b** — raise the native wait timeout only;
  - **P2-c** — relaunch (status quo).

  P2-a needs child-liveness proof. A wrong "completed" classification creates a synthetic receipt, which is forbidden.
- **P3:**
  - **P3-a** — amend the one-checker contract (E8; wording unverified) to allow N bounded revisions, each a typed receipt;
  - **P3-b** — same-receipt internal convergence: one checker launch revises internally;
  - **P3-c** — deterministic pre-validation (Gate-2 checks such as N37/N40/N42) before the checker, so that fewer semantic failures reach it, with no contract change.

  P3-c is independent of the contract but touches `validate-graph.cjs`, which T-43-12 owns.
- **P4:**
  - **P4-a** — extend blocking `dispatch wait` to decomposition, so the parent sleeps without model turns (`orchestration-overhead.cjs` already separates `wait_poll` from `model_turn`, E12);
  - **P4-b** — remove the model parent entirely. This is allowed only with proven equivalent launch, containment, cancellation and sealing (WORK-PACKAGES P4);
  - **P4-c** — measure only.
- **P5:**
  - **P5-a** — exact-revision INV reuse keyed on `source_revision` plus `policy_hash` (E13) plus the C3 index;
  - **P5-b** — a byte/section budget and write-once artifact only;
  - **P5-c** — status quo.

  P5-a depends on C3, which waits for phase 43 (ADR-021).

| | P1-a | P1-b | P1-c | P2-a | P2-b | P3-a | P3-b | P3-c | P4-a | P4-b | P5-a | P5-b |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Complexity | Med | Med–high | Low | Med | Low | Med + policy | Med | Low–med | Med | High | Med | Low |
| Receipt/contract change | New lease field | None | None | None (original receipt) | None | **Yes** (checker count) | Receipt shape unchanged, semantics change | None | None | Possibly | Optional fields | None |
| Main risk | Stale lease blocks a live owner | Coupling | Lost work only detected | Synthetic-receipt risk | Longer hang | Surplus checks | Checker self-approval | T-43-12 file | Lost wake | Loses containment | Stale reuse | Report truncation |
| Phase-43 independent | Yes (E6) | Yes | Yes | Yes (E6) | Yes | `decompose.md` T-43-11/12/15 → **No** | Same → **No** | **No** | Codex host not in phase 43 except `codex-delivery-host.cjs` → Unknown | Unknown | **No** (C3) | Yes |

## 8. Cross-cutting reuse identity (C1 / D4 / P5)

ADR-021's amendment asks INV-008 to settle one input-identity primitive.
- **I-a** — one shared, versioned manifest hasher (field list per consumer, shared canonicalization and digest) used by C1, D4 and P5.
- **I-b** — three independent manifests that share only `sha256` helpers.
- **I-c** — reuse the `context-packet.cjs` identity (`source_revision`, `policy_hash`, packet digest; E13) as the common core, with consumer-specific extensions.

| | I-a shared hasher | I-b independent | I-c packet-core |
|---|---|---|---|
| Complexity | Medium | Low each, higher in total | Low–medium |
| Risk | One bug invalidates three reuse paths | Divergent canonicalization → inconsistent staleness | The packet includes elided/overflow data, and its digest may change for irrelevant reasons |
| Forecloses | Per-consumer canonical forms | Cross-consumer dedup | Identity independent of packet building |

## 9. Phase-43 file ownership relevant to options (from E6/E7)

Phase-43 plans and the files they declare (hyphens restored from the `awk`/`tr` output):
- T-43-01 and T-43-10: `pipeline-config.cjs`.
- T-43-02: `publish-gate.cjs`, `shipyard-pre-push-gate.sh`.
- T-43-03: `comment-policy.cjs`, `publish-gate.cjs`.
- T-43-04: `run-reachability.cjs`, `sentinel.cjs`.
- T-43-05 and T-43-06: `role-artifact.cjs`.
- T-43-06 also: `conveyor-scratch.cjs`, `claude-role-host.cjs`, `delivery-commit-finalizer.cjs`, `codex-delivery-host.cjs`, `base-merge.cjs`, `ticket-worktree.sh`.
- T-43-07: `check-state.cjs`, `ci-wait.cjs`, `log-event.cjs`.
- T-43-08: `reviewers.cjs`, `sentinel.cjs`, `log-event.cjs`.
- T-43-09 and T-43-10: `state-sync.cjs`.
- T-43-11: `jira-export.cjs`, `decompose.md`.
- T-43-12: `validate-graph.cjs`, `front.cjs`, `sentinel.cjs`, `pipeline-stats.cjs`, `decompose.md`, the delivery-rules skill.
- T-43-13: `gate-trailer.cjs`, `base-merge.cjs`.
- T-43-14 and T-43-15: `deliver-dispatch.cjs`. T-43-14 also owns `deliver.md`. T-43-15 also owns `investigate.md` and `decompose.md`.
- T-43-16: `host-verification.cjs`, `claude-delivery-host.cjs`, `codex-delivery-host.cjs`, `command-runner.cjs`.
- T-43-17: `conveyor-coverage.cjs`, `delivery-commit-finalizer.cjs`, `base-merge.cjs`, both delivery hosts.
- T-43-18: `repo-remedy.cjs`, `escalation-record.cjs`, `log-event.cjs`, `conveyor-coverage.cjs`, `ci-fix.md`, `pr-sentinel.md`.
- T-43-19: `sentinel.cjs`, `conveyor-coverage.cjs`, `log-event.cjs`, `pr-sentinel.md`.

Files **not** declared by any phase-43 plan:
- `stop-gate*.cjs`, `run-controller.cjs`, `capacity-lease.cjs`, `dispatch-boundary.cjs`;
- `orchestration-overhead.cjs`, `context-packet.cjs`, `host-provenance.cjs`, `review-signature.cjs`, `drift-needed.cjs`;
- the Codex decompose host.

Options built only on these files are candidates for delivery now: S1-a/b except the `deliver.md` line, D5-a/b/c, P1, P2-a and R16-b. The E7 status list is a committed projection. The system-state line must recheck it with live `state-sync`/`gh` before any ordering decision.

## 10. Prior art (external and internal)

- **GitHub merge queue / `merge_group`.** Tests the exact merge commit before landing and requires checks on `merge_group` (MERGE-BASE-RESEARCH sources). This is prior art for R18-c.
- **GitHub rerun semantics.** A rerun keeps the original `GITHUB_SHA`, so a rerun cannot certify a new base (MERGE-BASE-RESEARCH). This rules out a "rerun old CI" option for R18.
- **Internal leases and fencing.** `run-controller.cjs` lease/epoch (E9) and `capacity-lease.cjs` TTL/heartbeat (E10) are the in-repo prior art for P1, D5 and S1-b.
- **Internal single-flight.** ADR-021's `lock.cjs` reservation states (`inflight`/`completed`/`failed`/`unknown`) are prior art for P2 and D5 reconciliation.
- **Internal scoped Stop gate.** The run-owned scoped path (E3) is prior art for S1-b.

## 11. Uncertainties and spikes (not validated by this line)

- [ ] Does `decompose.md` literally require exactly one checker receipt? E8 did not match "exactly one". Next check: `grep -n -i "one checker\|single checker\|checker receipt" plugins/delivery-pipeline/commands/decompose.md` — owner: system-state line.
- [ ] Is GitHub merge queue available for `serhii-nochevnyi/shipyard` epic branches, and can rules target `epic/*`? Recommend `/gsd-spike "merge_group queue on an ephemeral epic branch"` — owner: repository maintainer.
- [ ] Can a reviewer-local writable `TMPDIR` inside the worktree satisfy ADR-020's no-widening fence (R10-d)? — owner: constraints line / maintainer.
- [ ] Is the E7 projection current (e.g. T-43-02 merged, so R16's pre-push part is free)? Next check: live `state-sync.cjs` plus `gh pr list --base epic/43-…` — owner: system-state line.
- [ ] Can a single `deliver.md` arming-instruction change for S1 be delivered alongside pending T-43-14 without a Gate-2 unordered shared-path refusal? — owner: constraints line.
- [ ] Is the D1-a duty hash complete? Which inputs (head, CI, reviews, live mergeability, wait events) must enter it? Recommend `/gsd-spike "duty-set hash wake suppression against recorded phase-44 sentinel rounds"` — owner: risks line.
- [ ] Is the S1-a vs S1-b binding sufficient for `--fork-session`: does Claude pass a new `session_id` to the Stop hook after a fork? Recommend `/gsd-spike "installed Stop hook payload after --fork-session"` — owner: maintainer.

No recommendation is made. OPTIONS.md should present §1 as the phase-level choice and §2–§8 as per-package choices for DECISIONS.md.
