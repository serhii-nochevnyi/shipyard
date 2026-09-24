# INV-004 — research line: alternatives & prior art (OPTIONS.md draft)

- Line id: `alternatives`; policy signals (preserved as DATA): `{"type":"alternatives"}`
- Model selection resolved by caller: `claude-opus-5-5/medium`
- Source revision: `8c264020707b67933cf109f0578c652fc8a1cb41` (`git rev-parse HEAD`, branch `inv/004-phase39-delivery-retro`)
- Inputs read in full: `research/session-evidence.md` (101 lines), `research/codex-flowpdf-evidence.md` (50 lines), `OPTIONS.md` template (`cat`, see E0).
- No recommendation is made. Options belong to the human (DECISIONS.md).

## Evidence log (commands run for this line)

All commands run from `/Volumes/KINGSTON/.wt-claude-shipyard/inv-004`.

| # | Command | Relevant output |
|---|---|---|
| E0 | `wc -l $D/research/*.md $D/*.md` and `cat` of both evidence files and `OPTIONS.md` | The evidence files exist; `OPTIONS.md` is an empty A/B template with a mandatory comparison table |
| E1 | `ls plugins/delivery-pipeline/scripts` | `ci-wait.cjs`, `run-controller.cjs`, `run-waker.cjs`, `wait-events.cjs`, `front.cjs`, `dispatch-record.cjs`, `stop-gate.cjs`, `sentinel.cjs`, `state-sync.cjs`, `run-scope.cjs`, `publish-gate.cjs`, `claude-*-host.cjs`, `codex-*-host.cjs` all exist |
| E2 | `sed -n 1,12p` on those scripts | `ci-wait.cjs:1` "the one legitimate way for the conveyor to wait"; `dispatch-record.cjs:1` "the durable home for 'this ticket is with an agent right now'" with a `mark` subcommand; `stop-gate.cjs:1` Stop hook; `sentinel.cjs:1` PR sentinel core; `state-sync.cjs:1` rebuilds delivery-state from GitHub |
| E3 | `sed -n 1,30p run-controller.cjs; sed -n 1,25p run-waker.cjs` | `shipyard.run-controller.v1` with leases and states `waiting/runtime_unavailable/retryable`; `shipyard.run-waker.v1` with wait kinds `ci, review, quota, lease, host` |
| E4 | `sed -n 14,22p codex-decompose-host.cjs` | line 18: `'gsd-phase-researcher': { role: 'research', sandbox: 'read-only' }` (confirms C4) |
| E5 | `sed -n 1980,2000p tests/unit/source-contract.test.cjs` | `RUNTIME_OWNED_FILE_DIGESTS` at `:1986` pins sha256 of `runtime-adapters.cjs` and `claude-dispatch-adapter.cjs`; there is no regenerate step, only `assert.equal` (item 5) |
| E6 | `grep -rn slugify ...; sed -n 72,86p validate-graph.cjs; sed -n 60,70p gsd-sync.cjs` | two independent slug functions: `validate-graph.cjs:74 slugify(title, max = 40)` builds `ticket/${id}-${slug}` (`:85`); `gsd-sync.cjs:62 slugify(value, max = 64)`. `ticket-worktree.sh create <ticket-id> <branch> <base-ref>` takes the branch as an argument (`:6`), so the mismatch in item 6 comes from whichever caller computes the branch — not proven which (see U3) |
| E7 | `grep -n manifest.json scripts/shipyard-doctor.cjs` | `:193` `path.join(codexBundle, 'manifest.json')` (confirms C8 location) |
| E8 | `grep -nE '^[a-z-]+:' Makefile` | `test-fast` (`:47`) = unit, graph, worktree, gates, gsd-sync, sentinel, docs, hooks, comment-policy, model-ladder-runtime; `test` (`:51`) = test-fast + test-codex-shipyard + test-releases. There is no live-launch or captured-fixture target |
| E9 | `ls tests/fixtures; grep -rln <fixture names> tests` | Captured-style fixtures already exist: `claude-assistant-session.jsonl`, `codex-agent-child-0.155.1.jsonl`, `codex-agent-parent-0.155.1.jsonl`, used by `tests/unit/claude-runtime-host.test.cjs:20`, `codex-runtime-host.test.cjs`, `codex-decompose-host.test.cjs`. `head -c 600` of the Claude fixture shows synthetic session ids (`1111…`, `2222…`): it is hand-authored, not captured. The Codex ones carry a CLI version in the name, which suggests a capture (unverified, U1) |
| E10 | `grep -n 'dispatch-record\|mark' stop-gate.cjs`; `sed -n 1,20p .planning/backlog/front-has-no-in-flight-state.md` | `stop-gate.cjs:167-170,629-630`: "a mark can be written before the launch". The backlog entry is CLOSED 2026-09-09 as "the dispatch overlay" (`dispatch-record.cjs mark/clear`, `waiting.dispatched`). The pre-launch mark mechanism exists, but the Claude host path does not use it before launch (item 1) |
| E11 | `grep -n 'dispatch-record\|mark' claude-delivery-host.cjs claude-workflow-host.cjs claude-runtime-host.cjs dispatch-boundary.cjs` | None of the Claude hosts call `dispatch-record` directly. `dispatch-boundary.cjs:811` projects into dispatch-record's graph under a receipt claim lock (`withClaim`), which fits "mark lands only after the receipt" |
| E12 | `grep -n sealPlanningResearch *.cjs; grep -n research codex-delivery-host.cjs` | `sealPlanningResearch` exists only at `claude-delivery-host.cjs:506`, dispatched at `:752`; no `research` match in `codex-delivery-host.cjs` (confirms C3) |
| E13 | `ls plugins/delivery-pipeline/workflows` | `drift-gate.mjs`, `executors.mjs`, `fix-round.mjs`, `investigation-research.mjs` |
| E14 | `grep -n 'ci-wait' commands/deliver.md` | `:251`, `:2189`, `:2517`: "the one legitimate wait is `ci-wait.cjs`". It is documented, but the session still polled with `sleep` loops (item 8) |
| E15 | `grep` of Goal sections in `39-01/03/12-PLAN.md` | T-39-03 scopes the stop gate to a session armed by `/shipyard:deliver`. It does not address in-flight dispatches inside the armed session, so item 1 stays open. T-39-12 covers schema and output unwrap. T-39-01 covers the refusal hint map |
| E16 | `ls .planning/backlog` | Related prior notes: `generated-state-yaml-header-blocks-push-from-the-project.md`, `decompose-host-returns-no-artifact-index.md`, `codex-plan-checker-lease-test-flakes-on-ci.md`, `nothing-wakes-a-run-that-is-only-waiting.md`, `the-stop-gate-enforcing-this-session-predates-the-fix-for-this-exact-case.md`, `no-ci-in-the-conveyors-own-repo.md`, `two-claims-in-our-own-tree-that-source-checking-disproved.md` |

Claims about behaviour inside the session transcripts (for example "the orchestrator wrote `mkexec.cjs`") come from the evidence files. This line did not re-verify them against the jsonl transcripts, which are outside the sandbox read allowlist.

## Framing

The 13 findings (0–12, with C1–C8 under 12) fall into three kinds:

- **Point defects** with a local fix: 3 (`resolveDispatch` signal), 6 (branch slug), 7 (research refusal remedy and per-line discard), 11 (pre-push worktree detection), C1, C2, C4, C8.
- **Missing seams**: 1 (in-flight mark), 2 (front → dispatch entry), 4 (sentinel preconditions), 5 (digest repair path), 8 (waiting), 9 (dogfood), C3/C6 (Codex research and decomposition consumers), C5 (task digest), C7 (explaining the host state dir).
- **The systemic cause** (0): fixtures are authored to the consumer's expectation, so the other kinds reach release undetected.

The options below differ in how they treat item 0 and the seams. Per-item fixes are needed under every option except D. Section "Sub-decisions" lists the real forks inside individual items.

## Option A — Point fixes, one ticket per finding

**Sketch.** About 16–20 tickets, each a focused fix plus a unit test for the defect as seen. Examples: allow `implementation` in `resolveDispatch` or map it; share one slug function; flip `codex-decompose-host.cjs:18` to `workspace-write` and fix the test at `codex-decompose-host.test.cjs:35,103`; point doctor at `~/.codex/agents/.shipyard-manifest.json`; a `sentinel` precondition check that refuses with a remedy; a `make` target that rewrites `RUNTIME_OWNED_FILE_DIGESTS`. Boundary fixtures for 0/4 get captured by hand once and checked in.

**Cost.** Lowest per ticket. Tickets are highly parallel and mostly start from `main`. Fits the capacity-4 waves.

**Risks.** Item 0 recurs: new fixtures are still written by the person who writes the consumer, and no gate forces a re-capture when the CLI or host changes. There is no deterministic dispatch entry, so the next wave may again hand-build requests (the item 2 bugs, `signals` and `planPath`, recur in a new form). The success criterion "phase 40 wave dispatched through the new entry point" needs at least the item 2 seam, so pure A does not meet it.

**Forecloses.** Nothing structurally. It leaves the release process unchanged, so 0.62 could ship with no live round again.

## Option B — Seam-first: a deterministic dispatch entry plus a captured-boundary harness, then point fixes on top

**Sketch.**
1. **Captured-boundary harness.** A `scripts/capture-boundary.*` recorder (or a `make capture-fixtures` target) runs the real producers: `claude --print --output-format stream-json --json-schema …` with `--model haiku` (cheap, shown working in session-evidence [886]–[891]), `run-scope.cjs createRunScope`, `claude-dispatch-adapter` capture, `codex exec` / `spawn_agent` child. It writes versioned fixtures under `tests/fixtures/captured/<producer>@<version>.jsonl` with a provenance header (CLI version, date, command). Unit tests for consumers must load captured fixtures for any boundary listed in a registry. A source-contract check fails when a boundary consumer's test uses an inline object instead of a captured fixture. Prior art: E9 already has version-named Codex fixtures. The Claude fixture is synthetic.
2. **One front → dispatch entry point.** For example `deliver-dispatch.cjs --front --wave`: it reads `front.cjs` actionable tickets and builds `shipyard.claude-delivery-request.v1` / the Codex equivalent from the graph, taking `planPath` from the ticket worktree and `branch` from the single slug function. It resolves policy via `resolveDispatch`, writes the `dispatch-record mark` **before** launch (fixes 1, using the pre-launch mark `stop-gate.cjs:167` already allows), launches detached, and returns an ID that `ci-wait.cjs` / `run-waker.cjs` can wait on (fixes 8). Items 2, 3, 6 and most of 1 and 8 fold into one ticket cluster.
3. **Sentinel preflight** (`sentinel.cjs duty --preflight` or folded into the entry point): fetches and fast-forwards the local base ref, runs `state-sync`, and commits the state before a round (item 4).
4. Remaining point fixes as in A.

**Cost.** Medium to high. The entry point touches files phase 39 changed (`claude-runtime-host.cjs`, `claude-dispatch-adapter.cjs`, `executors.mjs`), so under the user's phase-ordering decision it takes cross-phase dependencies on T-39-12 and T-39-03. The harness needs network and a CLI login to recapture, so capture is a manual or periodic step, not part of `make test-fast`.

**Risks.** A new entry point is one more host-adjacent surface: it must not become a second dispatch boundary (the ADR-014 boundary contract is out of scope to change). It must call the existing boundary, not re-implement it. Captured fixtures can go stale silently unless something checks their age or version. A registry of boundaries that must be captured needs upkeep.

**Forecloses.** The orchestrator hand-building requests: the entry point becomes the only documented path, and `deliver.md` prose is rewritten around it. It makes a later move to an out-of-process daemon less needed.

## Option C — Release gate: require a live smoke round before any version bump (plus Codex fixture project)

**Sketch.** Leave the unit fixtures mostly as they are. Add `make test-live`, or a `test-releases` extension (E8 shows `test-releases` already exists in `make test`). It launches one real executor round per runtime through the installed-layout hosts: Claude with haiku/low, Codex with the cheapest allowed model. The round runs on a throwaway fixture repository (a mini "FlowPDF-equivalent" project with a two-ticket graph) through research → decompose → one executor → sentinel. The version bump or release script refuses without a fresh passing live receipt. Point fixes as in A.

**Cost.** Medium. One fixture project, a driver script, and release-script wiring. Every release costs a few minutes of runtime and tokens. It needs real CLI credentials, so it cannot run in public CI (see backlog `no-ci-in-the-conveyors-own-repo.md`, E16).

**Risks.** It catches integration defects late (at release, not at PR), and a live failure needs diagnosis from scratch. It gives no protection to development between releases, including the dogfood case (item 9). Live runs can flake (quota, network) and tempt a bypass. It does not by itself give phase 40 a deterministic dispatch entry (item 2), so it has to be combined with at least B.2 to meet the phase 40 success criterion.

**Forecloses.** Releasing without an end-to-end round. It pushes the project toward keeping a maintained fixture project.

## Option D — Do nothing beyond phase 39 and the existing backlog

**Sketch.** Ship T-39-01..T-39-12, raise the severity of the existing backlog entry for the generated state YAML (item 10), and document the rest as known workarounds in `deliver.md` (`git branch -f` the base, run `state-sync` before the sentinel, `git -C` for push).

**Cost.** Near zero.

**Risks.** The measured cost repeats: about 1 h × 4 executors per blocked round, three sentinel failures, patched caches (session-evidence). Codex delivery stays unusable (C1–C8: Phase 9 of FlowPDF never got plans). This fails every success criterion in PROBLEM.md.

**Forecloses.** Nothing. It is listed as the baseline.

## Comparison

| | A — point fixes | B — seams + captured harness | C — live release gate | D — do nothing |
|---|---|---|---|---|
| Addresses item 0 (invented fixtures) | Once, by hand; no guard | Structurally (captured registry + source-contract check) | Detects at release, not at PR | No |
| Items 1/2/3/6/8 | Five separate fixes | One cluster (entry point) | Separate fixes (as A) | No |
| Item 4 sentinel | Refuse with remedy | Preflight auto-repair | Caught by live round | Documented workaround |
| Codex C1–C8 | Point fixes | Point fixes + captured Codex fixtures | Proven by the fixture project round | No |
| Meets "phase 40 via new entry point" | No | Yes | Only with B.2 | No |
| Meets "Codex run completes research + decompose" | Only if the fixes are right (no proof) | Proven against captured fixtures only | Yes, proven live | No |
| Complexity / ticket count (estimate, assumption) | ~16–20 small | ~12–16, 3 medium-large | ~A + 3 | 0–1 |
| Cross-phase dependencies on phase 39 | Some (tickets touching `claude-*-host`) | More (entry point sits on T-39-03/T-39-12 files) | Some | None |
| Main risks | Recurrence of item 0 and item 2 | Scope creep into a second boundary; fixture staleness | Late detection; needs credentials; flaky | Measured losses repeat |
| What it forecloses | Nothing | Hand-built dispatch requests | Releasing without an end-to-end round | Nothing |

A and C are not exclusive, and neither are B and C. The realistic choices are A, B, B+C and A+C.

## Sub-decisions inside items (forks the human may want to settle regardless of A–D)

| Item | Alternative 1 | Alternative 2 | Alternative 3 | Notes / evidence |
|---|---|---|---|---|
| 1 in-flight stop gate | Mark before launch in the host or entry point (the `stop-gate.cjs:167` design already allows it) | Stop gate reads live host state (receipt dir / pid) | Workflow launch writes a lease via `run-controller.cjs` | E10, E11, E3; T-39-03 only scopes to the session (E15) |
| 3 `signals.type` | Extend the allowed set for role executor | Map graph `implementation` to a policy signal at the entry point | Strip unknown signal types before resolving | `model-policy-internal.cjs` refuses; the ADR-014 grid is out of scope, so 1 may count as a grid change (U2) |
| 5 digest pin | `make refresh-runtime-digests` plus a required commit trailer/ADR note | Replace the digest with a structural assertion (exports/strings) | Keep the pin, fail with a message naming the refresh command | E5 |
| 6 branch slug | One shared `ticketBranch()` module used everywhere | The graph stores the branch; everyone reads it, nobody recomputes | — | E6: `validate-graph.cjs:74` max 40 vs `gsd-sync.cjs:62` max 64 |
| 7 research refusal | Per-line refusal: keep valid lines, re-dispatch the failed one | Keep all-or-nothing but name the failed line and the real cause | — | T-39-08 caps summaries; per-line recovery is new |
| 8 waiting | Entry point returns IDs; `ci-wait.cjs` / `run-waker.cjs` extended with a `dispatch` wait kind | Background launcher + completion notifications of the Claude harness | Status quo documented | E3 wait kinds lack `dispatch`; E14 |
| 9 dogfood | Supported `--plugin-dir`/source mode whose receipts record host source revision and dirty flag | Forbid cache patching (doctor detects a digest mismatch against the release manifest) | Both | No dogfood mode found: `grep -rln 'dogfood\|plugin-dir' Makefile scripts commands` returned nothing |
| 10 state YAML | Stop committing the generated YAML (gitignore + regenerate) | Git merge/clean driver or pre-push auto-restore | Header-free deterministic output | Backlog entry exists (E16) |
| 11 pre-push | Derive the worktree from `git rev-parse --show-toplevel` at hook exec (hook cwd) | Parse `-C`/`cd` more robustly | — | Parsing command text is fragile by nature; alternative 1 removes it |
| C3/C6 consumers | Port `sealPlanningResearch` into a shared module used by both hosts | Codex-specific consumer | — | E12; shared C6 overlaps the backlog `decompose-host-returns-no-artifact-index.md` (out of scope as written; U4) |
| C5 task digest | Host computes a sha256 of the exact task and the child echoes it; mismatch refuses | Host writes the task to a file and the child reads the file (no relay) | — | Alternative 2 removes the relay, alternative 1 detects it |

## Spikes suggested (not executed; read-only line)

- `/gsd-spike "capture a real claude --json-schema stream-json launch with haiku and a Codex spawn_agent child as versioned fixtures, then replay them through claude-runtime-host and codex-runtime-host unit tests"`. This validates B.1 cost and staleness handling.
- `/gsd-spike "write the dispatch-record mark before the executors.mjs launch and confirm the stop gate stops firing during an in-flight wave"`. This validates the item 1 alternative 1.
- `/gsd-spike "minimal fixture project with a two-ticket graph driven through Codex investigate research + decompose using the shipped hosts"`. This validates C and the Codex success criterion.

## Constraints honoured / carried from the problem statement

- Out of scope: the ADR-014 grid and the dispatch boundary contract; removing fail-closed receipt verification; T-39-01..T-39-12 work; the backlog decompose artifact index and the Codex lease flake; Jira export.
- Phase ordering: tickets touching phase-39 files take a cross-phase dependency, and the rest start from `main` (user decision 2026-09-24, from PROBLEM.md).
- Every option must keep `make test-fast` and `make test` green and regenerate the Codex outputs (success criterion).

## Unknowns (to OPEN-QUESTIONS.md)

- [ ] U1: Are `tests/fixtures/codex-agent-*-0.155.1.jsonl` real captures or hand-edited? This decides whether B.1 has working prior art for Codex. Owner: the maintainer (check with `git log --follow` on the fixture files).
- [ ] U2: Does accepting or mapping `signals.type: "implementation"` count as an ADR-014 grid change (out of scope)? Owner: the ADR-014 owner.
- [ ] U3: Which caller computes the `…-to-ev` branch passed to `ticket-worktree.sh` versus `…-to-eve` in `tickets.json`? Owner: the system-state line (grep the callers of `ticket-worktree.sh create`).
- [ ] U4: May the shared C6 consumer absorb the backlog item `decompose-host-returns-no-artifact-index.md`, which PROBLEM.md lists as out of scope? Owner: the user.
- [ ] U5: Are live CLI credentials acceptable in a release step (Option C), given there is no CI in the repo? Owner: the user.
- [ ] U6: Should the new entry point (B.2) be Claude-only first, or ship Codex parity in the same phase? Owner: the user.
- [ ] U7: The ticket-count estimates in the comparison table are assumptions, not measured. Owner: decompose (Gate 2).
