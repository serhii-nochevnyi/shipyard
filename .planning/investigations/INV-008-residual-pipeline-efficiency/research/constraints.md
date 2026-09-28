# INV-008 research line 3 — constraints

- **Line:** constraints (→ RESEARCH.md "Constraints" and seeds for CONSTRAINTS)
- **Subject:** `INV-008-residual-pipeline-efficiency:constraints`
- **Source revision:** `705eb23328e166bf373701790f1768c90446f503` (checked: `git rev-parse HEAD`)
- **Policy hash (packet):** `30e71fb4066fee5b67df14120532c0b4f8aedde169907bc16f70dd2569744968`, policy `adr-014.v6`
- **Policy signals (preserved as data):** `{}`
- **Runtime selection used for this line:** Claude `claude-opus-5-5` / medium (research base rung, ADR-014 §3)
- **Mode:** read-only. No product file was changed and no model, provider account API or `gh` call was made. The only write is this file.

Confidence scale: **high** = read directly from an accepted ADR or source line checked by a command at this revision; **medium** = derived from source plus a planning document, or from a committed projection that may be stale; **low** = inference or an unverified assumption.

---

## 0. Commands run and what they showed

| # | Command (from the worktree root) | Relevant output |
|---|---|---|
| E1 | `git rev-parse HEAD` | `705eb23328e166bf373701790f1768c90446f503` |
| E2 | `grep version plugins/delivery-pipeline/.claude-plugin/plugin.json` | `"version": "0.68.0"` |
| E3 | awk extraction of `files_modified` from every `.planning/phases/43-*/43-*-PLAN.md` frontmatter | The per-ticket lists reproduced in §4.1 |
| E4 | `node -e` over `.planning/graph/delivery-state.json` for `T-43-*` | merged: 01, 02, 03, 05, 09. pr-open: 04 (#319), 07 (#266), 10 (#346), 11 (#334). pending: 06, 08, 12–19 |
| E5 | `node -e` over `.planning/graph/delivery-state-meta.json` | `generation: 392`, `observed_at: 2026-09-28T14:42:03.372Z` |
| E6 | `git log --oneline origin/epic/43-target-project-delivery-at-scale -25` | Epic head `7552b655`; it contains T-43-05 (#328), T-43-03 (#338), T-43-09 (#326), T-43-01 (#323). There is no merge of the epic into `main` in `git log origin/main -1` (`8f1b6418`, #353). |
| E7 | `sed -n 25,48p plugins/delivery-pipeline/scripts/stop-gate-arm.cjs` | `arm()` writes `{session_id, armed_at, cwd}` (`:32-37`). `isArmed()` compares only `session_id` (`:39-46`). Exports are `markerPath, arm, isArmed, validSessionId` (`:48`), so there is **no `disarm`**. |
| E8 | `grep -n … plugins/delivery-pipeline/scripts/stop-gate.cjs` and `sed -n 520,560p` | The scoped path runs only with `run_id`/`SHIPYARD_RUN_ID`/`SHIPYARD_RUN_CONTROL=scoped`/`SHIPYARD_RUN_STORE_DIR` (`:491-494`), and a foreign `run_id` refuses (`:511-512`). The unscoped path sorts candidates by `generated_at` and takes the newest (`:528-531`). |
| E9 | `grep -n "stop-gate-arm" plugins/delivery-pipeline/commands/deliver.md` | `:1233` is the only caller instruction for arming |
| E10 | `grep -n "stop-gate" scripts/install-shipyard-claude-hook.sh` | The installer copies a dependency bundle to `$CLAUDE_HOME/hooks/shipyard-stop-gate/stop-gate.cjs` (`:34-35`, `:232`) and registers `Stop → node "$STOP_DIR/stop-gate.cjs"` (`:139`) |
| E11 | `ls tests/unit \| grep -i stop` | `stop-gate.test.cjs`, `stop-gate-arm.test.cjs`, `phase41-stop-wake.test.cjs` |
| E12 | `grep -rn "ARCH_REVIEW_PACKET_TOKENS\s*=\|DIFF_MAX_BYTES\s*="` | `claude-role-host.cjs:23` `DIFF_MAX_BYTES = 1024 * 1024`; `:26` `ARCH_REVIEW_PACKET_TOKENS = 60000` |
| E13 | `grep -n "POLICY_HASH\s*=\|adr-014.v"` | `model-policy-internal.cjs:26` `POLICY_VERSION = 'adr-014.v6'`; `:322` `POLICY_HASH = fingerprintPolicy(POLICY)`; `usage-attribution.cjs:57` and `effort-experiment.cjs:52` derive from it |
| E14 | `sed -n 10,20p plugins/delivery-pipeline/scripts/validate-graph.cjs` and a grep for overlap | Gate 2 checks: `files_modified` overlap between dependency-unordered tickets, high risk ⇒ `human_checkpoint`, a well-formed `preauthorized` (`:12-17`). An empty `files_modified` is a hard error (`:256-261`). |
| E15 | `grep -rn automatic_transfer plugins/delivery-pipeline/scripts` | `session-handoff.cjs:138`, `:340`, `:951` hard-code `allowed: false` |
| E16 | `sed -n 40,70p .github/workflows/test.yml`; `grep -n "on:\|pull_request\|push:"` | Triggers are `pull_request` and `push` (`:20-22`). Steps: publish gate (`:48-52`), runtime digest trailer on PRs (`:54-56`), bubblewrap OS sandbox (`:58-65`), then `make test-fast` with `SHIPYARD_REQUIRE_OS_SANDBOX=1` (`:67-70`) on Node `24.15.0` (`:46`) |
| E17 | `sed -n 56,82p CLAUDE.md`; `sed -n 120,140p CLAUDE.md` | Delivery and editing rules (see §3) |
| E18 | `grep -n … plugins/delivery-pipeline/commands/decompose.md` | Typed roles `gsd-phase-researcher`/`gsd-planner`/`gsd-plan-checker` (`:46`, `:239-242`). Sealed `shipyard.decomposition-result.v1` identity `phase=…;repository=…;adr=…` (`:284`). Receipt verification before acceptance (`:271`, `:294`). The checker runs on the `decomposition` grid (`:194`, `:202`). |
| E19 | `wc -l plugins/delivery-pipeline/commands/deliver.md` | 3017 lines (SCOPING-NOTES recorded 2,913 earlier, so the file is growing) |
| E20 | `git log --oneline -1 --grep='#316'` / `--grep='#347'` | `0f7d9ba9 fix(delivery): honor explicit canonical graph for stale ticket worktrees (#316)`; `d1c647d6 … release/version-0.68.0 (#347)` |
| E21 | `grep -rn "worktree has local changes before role dispatch"` | `claude-role-host.cjs:146` (the N50 refusal is present) |
| E22 | `grep -rn "turn.completed" plugins/delivery-pipeline/scripts/usage-report.cjs` | no match (consistent with the N48 gap; the system-state line should confirm this behaviourally) |
| E23 | `grep -l "scripts/<file>" .planning/phases/43-*/43-*-PLAN.md` for each seam file | Mentions only; **not** used for blocking, because the contract uses `files_modified` (see §4) |
| E24 | `ls tests/unit \| grep -E "^(codex-decompose-host\|session-handoff\|dispatch-boundary)\.test"` | All three R9 suites exist |

---

## 1. Hard technical constraints

### 1.1 Policy and model routing (ADR-014)

| ID | Constraint | Source | Confidence |
|---|---|---|---|
| HC-1 | The ADR-014 grids, promotion rules, `POLICY_HASH`, resolver input schema and receipt shape are not changed by phase 45. P3, P4, D6 and R15 must not require a new rung or a new signal, and the receipt policy hash stays `30e71fb4…`. Anything that does needs an ADR-014 amendment first. | ADR-014 §5 and scope fences; ADR-021 "Out of scope"; ADR-020 "Out of scope"; `model-policy-internal.cjs:26`, `:322` (E13) | high |
| HC-2 | Every routed launch passes resolve → validate → explicit launch → application receipt → record. A missing receipt, an inherited parent model or a silent fallback fails closed. For **D6**, an outer coordination session that inherits a model is not an ADR-014 launch and must be recorded as `inherited`, never as a native selection. | ADR-014 §4; MODEL-ROUTING-RESEARCH "Proposed D6" step 2 | high |
| HC-3 | Fixed mechanical roles (`pr-sentinel`, `drift-check`) never promote from window or complexity signals. D1 cannot reach the host by "promoting" the sentinel, and D4 cannot change the drift-check rung. | ADR-014 §3 (signals are role-scoped); packet policy `runtime_signal_rules.*.pr-sentinel: {}`, `drift-check: {}` | high |
| HC-4 | Repair rungs `repeat` / `repeat_exhausted` require a boundary-verified receipt from the preceding rung. If D3 groups several review comments into one repair input, a group still counts as one attempt in the signature chain. It must not reset or skip a rung. | ADR-014 §2–3; packet `repair_prerequisites` | high |
| HC-5 | A global model downgrade is out of scope. D6 is limited to *outer* Codex coordination, and the native executor/review/checkpoint grids stay unchanged. | PROBLEM.md "out of scope"; WORK-PACKAGES D6; MODEL-ROUTING-RESEARCH disposition table | high |

### 1.2 Receipt, artifact and planning-gate integrity

| ID | Constraint | Source | Confidence |
|---|---|---|---|
| HC-6 | Decomposition needs one verified researcher, planner and checker receipt with sealed `shipyard.decomposition-result.v1` artifacts, followed by real PLAN files and `validate-graph.cjs` Gate 2. **P3** (bounded checker revision) cannot add checker launches until `decompose.md`'s receipt contract is amended. Surplus or fabricated checks must fail a count/receipt gate. | `decompose.md:271`, `:284`, `:294` (E18); WORK-PACKAGES P3; PREFLIGHT "Decomposition host blocker" | high |
| HC-7 | Research keeps four independent lines, the 500-character handback, `planning.v1`, `shipyard.research-result.v1` and durable full artifacts. **P5** reuse must keep the *original* INV receipts, create no synthetic researcher receipt and never reduce the lines. | ADR-021 (research index bullet); PROBLEM.md out of scope; WORK-PACKAGES P5 | high |
| HC-8 | An immutable `violation` artifact cannot be edited or carried into `conform`, and green CI alone cannot change it. **R10** adjudication must preserve the original violation. It may only issue a separate, auditable gate record, for environment-only findings, on an unchanged head/base/instruction set, with explicit human authority or an accepted deterministic policy. | ENVIRONMENT-RECOVERY-RESEARCH §T-43-03; WORK-PACKAGES R10 | high |
| HC-9 | **R17** can recover only bytes that were persisted and bound to the original dispatch. It must not synthesize a payload or rebind one from another dispatch, and it extends phase-42 commit-only recovery rather than duplicating it. | ENVIRONMENT-RECOVERY-RESEARCH treatment 2; WORK-PACKAGES R17 | high |
| HC-10 | A carried verdict is never a reuse source. The precedence is exact-input reuse (C1), then identity carry (T-43-13), then a fresh launch. **D4** and **P5** may share only the input-identity primitive with C1. No second fact index. | ADR-022 bullet 1; ADR-021 amendment 2026-09-28; WORK-PACKAGES D4, P5 | high |
| HC-11 | **R18** cannot declare a changed-base review `conform`. GitHub `CLEAN`, an old check or a rerun of the old event is never proof, because a rerun keeps the original `GITHUB_SHA`/`GITHUB_REF`. CI runs on `pull_request` (merge commit) and `push` (E16), so an attestation must bind the merge commit/tree and both parent SHAs. A merge queue would need a `merge_group` trigger that does not exist today. | MERGE-BASE-RESEARCH (GitHub docs cited there); `.github/workflows/test.yml:20-22` (E16) | high (repo), medium (GitHub semantics, external source) |
| HC-12 | Gate 2 refuses `files_modified` overlap between dependency-unordered tickets and requires `human_checkpoint` for high risk. Phase-45 tickets that share a file with each other or with a pending phase-43 ticket must be dependency-ordered. S1 is high risk, so it carries `human_checkpoint`. | `validate-graph.cjs:12-17`, `:256-261` (E14); ADR-020 last bullet; ADR-021 first bullet | high |
| HC-13 | Planning runs `state-sync` in the planning worktree before Gate 2, because the committed projection can list merged tickets as pending. The phase-43 statuses in §4 come from a projection observed at `2026-09-28T14:42:03Z` (E5). | ADR-021 last decision bullet; E4/E5 | high (rule), medium (statuses) |

### 1.3 Security and sandbox boundaries

| ID | Constraint | Source | Confidence |
|---|---|---|---|
| HC-14 | No agent sandbox is widened (network, docker, reads outside the worktree). **R10** (sandbox `gh`/log access), **N38**/**D1** (sentinel scripts and `gh` blocked) and **R14** (a capture in the sandbox `TMPDIR`) must move work to the trusted host or pass data in as fenced input. They must not open the sandbox. | ADR-020 "Out of scope"; WORK-PACKAGES R10; intake N38, N52, N53 | high |
| HC-15 | Codex host verification accepts only `node`, `bash`, `make` or an absolute executable as a PLAN verification command (N40). Every phase-45 PLAN's verification commands must obey this, and R12's Gate-2 checks should enforce it. | intake N40 (0.67.0 live round) | medium (not re-checked in source on this line) |
| HC-16 | Private per-account subscription samples live in `~/.local/state/shipyard/<runtime>/subscription/` (file mode 0600, directory 0700). Tracked reports carry only derived values, with no e-mail, user id, `credits` or `plan_type`. **D5**/**D6**/**P4** measurements and **R8** captures must not commit account identifiers. | ADR-021 (storage and account bullets); intake N28 | high |
| HC-17 | `automatic_transfer.allowed: false` is hard-coded. S1's "fork / scope switch updates ownership" must not become an automatic session transfer. | `session-handoff.cjs:138`, `:340`, `:951` (E15); ADR-021 rotation bullet; PROBLEM.md out of scope | high |
| HC-18 | Codex runs launched from inside a Claude session refuse `AMBIGUOUS_RUNTIME` unless `CLAUDECODE`/`CLAUDE_CODE_*` are cleared. Tests that leak these variables misreport (N21, N39). R9/R10 fixtures must clear them explicitly, and no config may pick a runtime implicitly. | ADR-014 §5; intake N21, N39 | medium |

### 1.4 Performance and size budgets

| ID | Constraint | Source | Confidence |
|---|---|---|---|
| HC-19 | The arch-review packet is bounded at 60 000 tokens, and the integrator diff at 1 MiB with `--unified=50`. **R8** (summarise captures by digest) and **R11** (exclude generated trees, per-subset verdicts) must name the bound in refusals and never raise it silently. | `claude-role-host.cjs:23`, `:26` (E12); intake N29, N30 | high |
| HC-20 | Claude `ci-wait.cjs` returns within 540 s per call unless `--timeout` is explicit, with the window budget accumulated. **D1** scheduling must not re-introduce model-held waits beyond this. | ADR-020 cancelled-check bullet | high |
| HC-21 | The window threshold is 250 000 tokens (`window_threshold_tokens`) and drives integrator/arch-review promotion. **R15** (executor context budget) cannot use it to promote the executor. | packet policy; ADR-014 §3 | high |

---

## 2. Product constraints (flows that must not change, flag policy)

| ID | Constraint | Source | Confidence |
|---|---|---|---|
| PC-1 | **S1 must keep the stale-main-cwd case working.** A session whose process `cwd` is a stale main checkout but which owns a live linked phase worktree must still be enforced on that board. The arming `cwd` alone cannot identify the board, and a foreign front must never win by timestamp. Scoped (`run_id`) behaviour stays run-owned, as today (`stop-gate.cjs:491-512`). | backlog defect "Required correction" and acceptance 1–5; E7, E8 | high |
| PC-2 | **S1 needs a new `disarm`.** It must not release another session's marker. Missing, stale, altered or ambiguous binding must refuse *boundedly* and never trap an abandoned session permanently. | intake N55; E7 (`stop-gate-arm.cjs:48` has no `disarm`); backlog acceptance 3–4 | high |
| PC-3 | **S1's acceptance is the installed copied hook** (`$CLAUDE_HOME/hooks/shipyard-stop-gate/stop-gate.cjs`, E10), with a two-armed-session fixture and a human checkpoint. It is judged by correctness, not by quota savings, and must not be folded into D1. | CONTEXT.md completion criteria; WORK-PACKAGES S1; backlog | high |
| PC-4 | Review stays independent. Neither D3 grouping nor R18 attestation replaces arch-review. T-43-07 is the recorded counterexample: exact-head CI was green, yet arch-review found two source blockers. | MERGE-BASE-RESEARCH ¶3; WORK-PACKAGES D3 | high |
| PC-5 | Undraft stays unreachable without a `conform` verdict. The Claude arch-review host may review drafts, with `isDraft` recorded as a C1 manifest input (R13 part / N46). | ADR-022 draft bullet | high |
| PC-6 | Candidate gating (R3) is the permanent rule: disjoint-aware, with the person-wait exception. `wait-turn` is non-actionable, and drift-check follows the same timing. R3 is partly **superseded** by ADR-022, so its contract is not re-decided here. | ADR-022; WORK-PACKAGES R3 note | high |
| PC-7 | `human_checkpoint` has three values: `review`, `merge`, and `true` (meaning `merge`). `preauthorized` keeps working. `checkpoint_reason` (C4) is orthogonal and records only. `signals.checkpoint` must keep promoting exactly as today. | ADR-020; ADR-021 checkpoint bullet | high |
| PC-8 | D5 exhaustion creates a resumable resource state and never skips a quality gate. Missing quota data yields conservative launch bounds, never a fabricated percentage. D5 starts in advisory/shadow mode. | WORK-PACKAGES D5; rollout step 4 | high |
| PC-9 | Every efficiency treatment (P3, P4, P5, D1–D6, R15, R18) is measured one at a time. It stays `inconclusive` without matched provider-specific cohorts, and no acceptance criterion contains a savings percentage. Token totals are not quota units, and Claude and Codex are never combined. | ADR-021 (states and inconclusive bullets); CONTEXT.md; WORK-PACKAGES rollout 5 | high |
| PC-10 | Excluded: an always-on sentinel daemon (limits D1 to host-controller scheduling within existing processes), adaptive 1/2/4 fan-out, cross-provider scheduling or fallback, and API-price conversion. | PROBLEM.md; CONTEXT.md "Existing owners and exclusions" | high |
| PC-11 | Existing configuration keys follow D-45: registered in `pipeline-config.cjs`, keyed by `owner/repo`, `delivery_pipeline.*` wins, bad shapes warn and fall back. Any new phase-45 key (D5 caps, R16 dogfood home, R14 preconditions) follows the same rule, and `pipeline-config.cjs` is owned by pending T-43-10. | ADR-020 consequences; §4.1 | high |

---

## 3. Delivery constraints (conventions, CI gates)

| ID | Constraint | Source | Confidence |
|---|---|---|---|
| DC-1 | CI on every PR runs the publish gate (comment policy included) and the runtime-digest trailer, then `make test-fast` under a bubblewrap OS sandbox with `SHIPYARD_REQUIRE_OS_SANDBOX=1` on Node 24.15.0. Tests for R5, R9 and R10 must pass inside that sandbox on Linux. The macOS/Linux differences in N31/N52 are real risks. | `.github/workflows/test.yml:46-70` (E16) | high |
| DC-2 | The Claude plugin is canonical. Codex outputs are regenerated with `make package-shipyard-codex`, and `plugins/shipyard/` is never hand-edited. Ticket PRs into `epic/*` or `ticket/*` do not regenerate it; the epic → `main` PR does. | `CLAUDE.md:76-82` (E17) | high |
| DC-3 | The runtime-file digest pin changes only through `make refresh-runtime-digests` and its trailer. S1 changes a copied hook, so it probably touches pinned runtime files: expect a trailer on its PR. | `CLAUDE.md:130`; `test.yml:54-56` | medium (the pin list for `stop-gate.cjs` was not checked) |
| DC-4 | Keep shell on `set -euo pipefail` (for R16 and R4's pre-push hook). Preserve unrelated worktree changes. Update `README.md` when a supported command changes, e.g. a new `stop-gate-arm disarm` or `make` target. `tests/smoke/docs-smoke.sh` enforces this. | `CLAUDE.md:58-62`, `:124-129` | high |
| DC-5 | Every fix carries unit or fixture tests that fail on base. A release gate needs its own live run in the PR that adds it (N32), so R7-class verification must exercise the production path. | ADR-020 last bullet; intake N32 | high |
| DC-6 | Global REQ/ticket IDs are assigned only by the authenticated ADR plus typed researcher/planner/checker chain and Gate 2, never by a hand ticket list. | WORK-PACKAGES formalization checkpoint; PREFLIGHT | high |
| DC-7 | Shared files in phase 45 get **one serialized owner** per delta (ADR-022 names R3, D1, R13, C1 and T-43-13 as sharing the gating/draft/journal files). | ADR-022 consequences; WORK-PACKAGES boundary | high |

---

## 4. Phase-43 independence constraint (RESEARCH-CONTRACT Q2)

Rule (from RESEARCH-CONTRACT Q2): a package **waits** when it touches a path in the `files_modified` of an unmerged phase-43 ticket. Mentions in plan prose (E23) do not count.

### 4.1 Unmerged phase-43 file ownership (E3 × E4)

Unmerged tickets: T-43-04, 06, 07, 08, 10, 11 (pr-open or pending) and 12–19 (pending). Merged, so their files are free: 01, 02, 03, 05, 09.

| Path | Unmerged owners |
|---|---|
| `scripts/sentinel.cjs` | 43-04, 43-08, 43-12, 43-19 (43-07 only its test) |
| `scripts/front.cjs`, `scripts/validate-graph.cjs`, `scripts/pipeline-stats.cjs`, `skills/delivery-rules/SKILL.md`, `.shipyard/generated/gsd-delivery-rules/SKILL.md` | 43-12 |
| `commands/decompose.md` | 43-11, 43-12, 43-15 |
| `commands/deliver.md` | 43-14 |
| `commands/investigate.md` | 43-15 |
| `scripts/deliver-dispatch.cjs` | 43-14, 43-15 |
| `scripts/claude-role-host.cjs`, `scripts/ticket-worktree.sh`, `scripts/role-artifact.cjs`, `scripts/conveyor-scratch.cjs` | 43-06 |
| `scripts/delivery-commit-finalizer.cjs` | 43-06, 43-17 |
| `scripts/codex-delivery-host.cjs` | 43-06, 43-16, 43-17 |
| `scripts/claude-delivery-host.cjs` | 43-16, 43-17 |
| `scripts/base-merge.cjs` | 43-06, 43-13, 43-17 |
| `scripts/gate-trailer.cjs` | 43-13 |
| `scripts/state-sync.cjs`, `scripts/pipeline-config.cjs`, `scripts/gsd-sync.cjs`, `scripts/adr-bootstrap.cjs` | 43-10 |
| `scripts/log-event.cjs` | 43-07, 43-08, 43-18, 43-19 |
| `scripts/ci-wait.cjs`, `scripts/check-state.cjs` | 43-07 |
| `scripts/reviewers.cjs` | 43-08 |
| `scripts/run-reachability.cjs` | 43-04 |
| `scripts/host-verification.cjs`, `scripts/command-runner.cjs` | 43-16 |
| `scripts/conveyor-coverage.cjs` | 43-17, 43-18, 43-19 |
| `references/ci-fix.md` | 43-18 |
| `references/pr-sentinel.md` | 43-18, 43-19 |
| `scripts/jira-export.cjs` | 43-11 |

The following seam files appear in **no** phase-43 `files_modified` (E3; existence checked in E23): `stop-gate.cjs`, `stop-gate-arm.cjs`, `run-controller.cjs`, `dispatch-boundary.cjs`, `drift-needed.cjs`, `drift-record.cjs`, `workflows/drift-gate.mjs`, `review-signature.cjs`, `usage-report.cjs`, `codex-decompose-host.cjs`, `claude-decompose-host.cjs`, `context-packet.cjs`, `orchestration-overhead.cjs`, `wait-events.cjs`, `session-handoff.cjs`, `lock.cjs`, `host-provenance.cjs`, `workflows/investigation-research.mjs`, `scripts/shipyard-doctor.cjs`, and the merged-owner files `publish-gate.cjs`, `comment-policy.cjs` and `scripts/shipyard-pre-push-gate.sh`.

### 4.2 Package → blocking tickets

The likely-touched files come from the WORK-PACKAGES text and SCOPING-NOTES seams. They are a planning constraint, not a ticket graph. Confidence is **medium** throughout, because the exact per-package file sets are fixed only by the typed planner.

| Package | Likely files | Blocked by (unmerged phase-43) | Can start now? |
|---|---|---|---|
| **S1** | `stop-gate.cjs`, `stop-gate-arm.cjs`, their tests, installer bundle; caller instruction `deliver.md:1233` (E9) | **T-43-14**, only through `deliver.md` | **Yes, if** the `deliver.md` edit is dropped, deferred or ordered after T-43-14. The script, test and installer core is independent. |
| P1 | `run-controller.cjs`, `session-handoff.cjs`, `lock.cjs`, planning host | none directly; `decompose.md` wording → 43-11/12/15 | Core yes; instruction text waits |
| P2 | `dispatch-boundary.cjs`, `codex-decompose-host.cjs`, `claude-decompose-host.cjs` | none directly | Yes (after the P1 contract) |
| P3 | `decompose.md` receipt-count contract, decompose hosts | 43-11, 43-12, 43-15 | **Wait** |
| P4 | `orchestration-overhead.cjs`, Codex decompose host `dispatch wait` | none directly | Yes (needs P2) |
| P5 | `context-packet.cjs`, `investigation-research.mjs`, `investigate.md` | 43-15 (through `investigate.md`); C3 must land first | **Wait** (on C3, which waits on the epic) |
| D1 | `sentinel.cjs`, `state-sync.cjs`, `wait-events.cjs`, `references/pr-sentinel.md` | 43-04, 08, 10, 12, 18, 19 | **Wait**; also after S1 installed |
| D2 | `deliver.md` | 43-14; also consumes C2 | **Wait** |
| D3 | `review-signature.cjs`, `deliver.md` repair loops, `fix-round.mjs` | 43-14 | Signature core yes; `deliver.md` waits |
| D4 | `drift-needed.cjs`, `drift-record.cjs`, `drift-gate.mjs` | none directly; the identity primitive is shared with C1 | Contract after C1; code is technically free |
| D5 | `dispatch-boundary.cjs`, `run-controller.cjs`; a new config key → `pipeline-config.cjs` | 43-10 (only for a config key) | Ledger yes; config waits |
| D6 | outer Codex coordination (new surface), usage attribution | none directly; needs C2 and an approved experiment | Policy-gated, not file-gated |
| R1 / R13 base / N45 | delivery hosts, `ticket-worktree.sh`, `deliver-dispatch.cjs` | 43-06, 14, 15, 16, 17 | **Wait** |
| R2 | `base-merge.cjs`, integrator path | 43-06, 13, 17 | **Wait** |
| R3 | `sentinel.cjs`, `front.cjs` (ADR-022) | 43-04, 08, 12, 19 | **Wait** |
| R4 | finalizer, fix-round host, `comment-policy.cjs` (free), `publish-gate.cjs` (free) | 43-06, 17 (finalizer) | Scanner fix (N13) yes; host part waits |
| R5 | delivery/role hosts | 43-06, 16, 17 | **Wait** |
| R6 | `drift-record.cjs` / role validation | none directly | Probably yes |
| R7 | plan/review conventions: `delivery-rules` SKILL, arch-review reference | 43-12 | **Wait** for the SKILL text |
| R8 | capture tool, `claude-role-host.cjs` packet bound | 43-06 | Capture scrubber yes; packet bound waits |
| R9 | the three flaky tests | none (test files not in any `files_modified`; E24) | **Yes** |
| R10 | `host-verification.cjs`, reviewer host, fix-round request | 43-06, 16 | **Wait** |
| R11 | `claude-role-host.cjs` integrator | 43-06 | **Wait** |
| R12 | `validate-graph.cjs`, finalizer, role hosts | 43-06, 12, 17 | **Wait** |
| R13 usage-report part (N48) | `usage-report.cjs` | none | **Yes** |
| R14 | `deliver-dispatch.cjs` pre-launch check | 43-14, 15 | **Wait** |
| R15 | executor packet (`context-packet.cjs`, delivery hosts) | 43-16, 17; needs C3 | **Wait** |
| R16 | `shipyard-doctor.cjs`, `host-provenance.cjs`, dogfood installer, `shipyard-pre-push-gate.sh` (43-02 merged) | none | **Yes** |
| R17 | finalizer, delivery hosts | 43-06, 16, 17 | **Wait** |
| R18 | `sentinel.cjs`, `front.cjs`, `base-merge.cjs`, workflow | 43-04, 06, 08, 12, 13, 17, 19 | **Wait**; also ADR-level merge-authority design |
| C1–C4 | per ADR-021 | wait by ADR-021 (amendment 2026-09-28) | **Wait** (decided, not reopened) |

The shared-file hot spots inside phase 45 need one serialized owner (DC-7):
- `sentinel.cjs`/`front.cjs`: R3, R18, D1, ADR-022 gating;
- `claude-role-host.cjs`: R8, R10, R11, R12, R13, C1;
- the finalizer and delivery hosts: R1, R4, R5, R12, R17;
- `deliver.md`: S1, D2, D3;
- `decompose.md`: P1, P3;
- `dispatch-boundary.cjs`: P2, D5.

---

## 5. Constraints per open design package (seeds for CONTRACT refusal cases)

- **S1.**
  - Binding key: at least session id + board/graph path (realpath) or run id, recorded at arm time.
  - The foreign-timestamp rule (PC-1) forbids a newest-wins fallback when a binding exists.
  - An unbound legacy marker needs a defined bounded behaviour. The gate cannot trap forever (PC-2).
  - The `/var` → `/private/var` realpath issue (N11, N31) means paths must be compared after `realpath`.
  - Arming currently writes to `<git-common-dir>/shipyard/stop-gate-armed/<session>.json` (`stop-gate-arm.cjs:25-29`). That store is shared by all worktrees of the repository, so writes must be atomic, which they already are (`writeAtomic`, `:35`).
- **R10:** see HC-8 and HC-14. The CI provenance must be exact-head, same command. N57 is the fixture.
- **R14:** refusal happens before any model turn. The artifact path is under the sandbox `TMPDIR` or the worktree (N53 lost three launches to a parent `TMPDIR`). No sandbox widening.
- **R16:** dogfood installs default to a dedicated runtime home. The doctor classifies a foreign cache as foreign and never silently accepts it. The pre-push hook checks the pushed worktree. N41 (release versus dogfood provenance) shares `host-provenance.cjs`.
- **R17:** HC-9. Store in private bounded host state keyed by dispatch id and finalization candidate. The storage location is an open question.
- **R18:** HC-11 and PC-4. The epic branch currently has no protection rule (MERGE-BASE-RESEARCH), so a merge queue needs a new branch rule and a `merge_group` trigger (DC-1 workflow change).
- **D1:** HC-3, HC-20, PC-10. It must follow S1 installation (WORK-PACKAGES rollout 4), and a foreign-board wake is an S1 defect.
- **D5:** PC-8; reservations must be atomic across processes (the `dispatch-boundary` cross-process test is itself a flaky R9 suite, so D5 depends on R9 for trustworthy CI).
- **D6:** HC-2, HC-5, PC-9; requires the phase-44 effort-experiment protocol and a recorded human decision.
- **P1–P5:** HC-6 and HC-7. P1's lease must be distinct from run leases (`run-controller.cjs`) and must not lock unrelated worktrees. P2 counts model use once. P3 is blocked until `decompose.md` is amended.

---

## 6. Correctness versus efficiency classification (a constraint on how each package is judged)

- **Correctness fixes**, judged by refusal and fixture tests, with no cohort needed: S1, R12, R13, R17, and also R1, R2, R4, R5, R9, R16.
- **Efficiency treatments** that need matched-cohort, one-at-a-time measurement (PC-9): P3, P4, P5, D1, D2, D3, D4, D5 (advisory first), D6, R15, R18.
- **Hybrids:** R10 (a gate-correctness contract whose benefit is avoided replays), R3 (ADR-022 metric), R6 and R14 (avoid lost launches).

---

## 7. Assumptions, unknowns and next checks

- **A1 (medium).** Phase-43 statuses come from the committed projection (E5, observed `2026-09-28T14:42Z`). They were not re-checked live, because no `gh` call is allowed on this line. *Next check:* run `state-sync` in the planning worktree before Gate 2 (HC-13), or `gh pr view 319 266 346 334 --json state`.
- **A2 (medium).** Package → file mapping is inferred from WORK-PACKAGES and SCOPING-NOTES. *Next check:* the typed planner's `files_modified` and Gate 2.
- **A3 (medium).** Whether `stop-gate.cjs` is in the runtime-digest pin was not checked. *Next check:* `grep -rn "stop-gate" scripts/check-runtime-digest-trailer.cjs` and the pin file.
- **A4 (medium).** The Codex verification allowlist (HC-15) was taken from intake N40 and not re-read in source. *Next check:* grep `VERIFICATION_SPEC_UNSUPPORTED` in `plugins/delivery-pipeline/scripts/`.
- **A5 (low).** Whether an installed Codex host has a Stop-gate equivalent was not checked (`grep -n Codex stop-gate.cjs` returned nothing). S1 is therefore treated as Claude-only.
- **U1.** The durable, authenticated source for S1's board binding (a run id from `run-controller`, or the realpath of the graph dir) is unresolved. This belongs to the risks/alternatives lines and the ADR.
- **U2.** Where R17's payload store lives, and whether it is atomic with finalization, is unresolved (ENVIRONMENT-RECOVERY-RESEARCH questions).
- **U3.** Who has authority to issue an R10 replacement gate record (human versus deterministic policy) is unresolved, and it needs a maintainer decision.
- **Spike candidates** (not run): `/gsd-spike "two armed Claude sessions in sibling worktrees against the installed stop-gate bundle with a session-bound board"` for S1 acceptance 1–2; `/gsd-spike "GitHub merge_group on an ephemeral epic branch"` for R18.
