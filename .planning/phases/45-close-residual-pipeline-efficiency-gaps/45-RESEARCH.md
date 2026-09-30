# Phase 45: Close residual pipeline efficiency gaps — Research (first pass)

**Researched:** 2026-09-28
**Worktree revision:** `c42535f6` (plugin, scripts, tests and capabilities are byte-identical to `705eb233` = the INV-008 research revision: `git diff --stat 705eb233 HEAD -- plugins scripts tests capabilities Makefile` printed nothing)
**Domain:** Node.js (CommonJS) host scripts, git worktrees, file-lock/lease primitives, Claude Stop hook, Codex/Claude transcript parsing
**Confidence:** HIGH for current code, tests and file ownership (every claim was read this session). MEDIUM for recommended designs. LOW for the root causes of two of the three R9 flakes (not reproduced).

## Summary

The first pass is limited to packages whose files lie outside every phase-43 `files_modified`. I checked this against all 19 `.planning/phases/43-*/43-*-PLAN.md` frontmatters (114 path entries, extracted with an awk loop over the `files_modified:` block). Six packages are **fully free**: S1 core, R9, R13/N48, P1, P2 and D5 (advisory). Four are **partly free**: R16 (the pre-push hook is T-43-02), P4 (the only blocking `dispatch wait` is in `deliver-dispatch.cjs`, owned by T-43-14/15), R6 (Claude drift workflow only, since the Codex path is in `codex-delivery-host.cjs`) and R8 (the scrubber only). **R4's N13 scanner fix must move to the second pass**, because `comment-policy.cjs` is T-43-03 and `publish-gate.cjs` is T-43-02/03.

S1 is a small, local change. `stop-gate-arm.cjs` (69 lines) writes `{session_id, armed_at, cwd}` and has no `disarm`. `stop-gate.cjs:515-531` scans `[cwd, ...worktreesOf(cwd)]` and lets the newest `generated_at` win. The binding has to be backward and forward compatible, because the arm writer (the plugin cache copy, called by `deliver.md:1233`) and the hook reader (the copy under `~/.claude/hooks/shipyard-stop-gate/`) can be different versions. `deliver.md` belongs to T-43-14, so the first pass cannot change the caller. `arm` without flags must therefore pick a board by itself, and the real-world benefit only arrives when the second pass adds an explicit `--graph-dir` to the caller line.

R9 was not reproduced here. The code shows two concrete sources of nondeterminism:
- `codex-decompose-host.cjs` `runCli` creates its run controller without a clock (`:330-333`), and the test uses a 2000 ms wall-clock lease (`codex-decompose-host.test.cjs:364-365`).
- The shared `assert-harness.cjs` starts every `async` test body at once and runs later synchronous tests while it is pending (`assert-harness.cjs:76-99`). Both the session-handoff and dispatch-boundary suites use this harness.

**Primary recommendation:** Plan S1 as a single high-risk ticket with a human checkpoint. Plan R9 first among the rest, because D5 and P1/P2 rely on trustworthy concurrency tests. Give each hot file inside phase 45 one serialized owner: `codex-decompose-host.cjs` (R9, P1, P2, P4), `claude-decompose-host.cjs` (P1, P2, P4) and `dispatch-boundary.cjs` (P2, and R9's test file). Add no cross-phase `depends_on`.

<user_constraints>
## User Constraints (from ADR-023, the phase-45 CONTEXT.md and the orchestrator PHASE-CONTEXT)

The phase `CONTEXT.md` has no `## Decisions` / `## Claude's Discretion` / `## Deferred Ideas` sections. The locked decisions are the accepted ADR-023 bullets and the orchestrator's first-pass rules, quoted verbatim below.

### Locked Decisions (ADR-023 §Decision, verbatim, first-pass-relevant bullets)
DATA_k7Qm2xVb_START
- Phase 45 is delivered correctness-first: correctness fixes whose core files lie outside unmerged phase-43 `files_modified` ship first, packages on phase-43 files take a cross-phase `depends_on` on the owning T-43 ticket or wait for the phase-43 epic, and efficiency treatments are rolled out one at a time and measured on matched cohorts.
- The armed Stop-gate marker binds the realpath of the delivery board chosen at arm time, the hook reads only that board with no newest-wins fallback while a binding exists, an unbound legacy marker has a bounded behaviour, and `stop-gate-arm.cjs disarm` removes the session's own marker.
- Dogfood installs target a dedicated runtime home by default, the doctor and release preconditions classify another session's dogfood cache as foreign instead of a release error, and the pre-push hook checks the worktree that is actually pushed.
- An aggregate admission ledger on `capacity-lease.cjs` runs in advisory mode first and enforces only after measurement, always reserving verification and checkpoint capacity.
- Planning gets a planning-tree writer lease with a fencing token, recovery of a completed judgment role from its durable reservation and authenticated transcript without relaunch, deterministic pre-validation before the checker, a blocking `dispatch wait` for decomposition, and exact-revision INV reuse after C3.
DATA_k7Qm2xVb_END

### Orchestrator first-pass rules (verbatim)
DATA_p3Rw9Lfe_START
HARD RULE — phase-43 file ownership: phase 43 is NOT on main (14 tickets unmerged; T-43-01/02/03/05/09 are merged only into epic/43-target-project-delivery-at-scale). Read every .planning/phases/43-*/43-*-PLAN.md `files_modified`. A first-pass plan MUST NOT list any file that ANY phase-43 plan lists. If a package needs such a file, drop that part from the first pass and note it for the second pass. Do not add cross-phase depends_on in this pass.
DATA_p3Rw9Lfe_END

- S1 excludes `commands/deliver.md` (T-43-14); the caller line is second pass.
- D5 is advisory only, with **no new config key**.
- P1 is a lease in code (`capacity-lease.cjs` or a planning host), not `decompose.md` text.
- P2 never synthesizes a receipt.
- Requirements continue from REQ-184; new ids start at REQ-185 in `.planning/ROADMAP.md` (the requirements list plus the Phase 45 **Requirements** line).

### Claude's Discretion
- The exact design inside each package (module names, marker schema, lease store location) is left to the planner by ADR-023 ("Implementation details belong to the phase-45 plans", ADR-023:9).

### Deferred Ideas (OUT OF SCOPE for the first pass)
P3, P5, D1–D4, D6, R1–R3, R5, R7, R10–R12, R14, R15, R17, R18, C1–C4, ADR-022, R4 (all of it, see below), and the phase-43-owned parts of R16, P4 and R6. ADR-023 also puts these out of scope: a global model downgrade, ADR-014 grid changes, cross-provider fallback, automatic session transfer, and an always-on sentinel daemon.
</user_constraints>

## Project Constraints (from CLAUDE.md)

- Keep the Claude plugin canonical. After a shared change, regenerate the Codex outputs (`make package-shipyard-codex`) once on the epic, not in ticket PRs. Never edit `plugins/shipyard/host/` (CLAUDE.md:76-81).
- Shell scripts use `set -euo pipefail` and validate preconditions early (CLAUDE.md:125).
- Add a focused unit or fixture test with every new rule (CLAUDE.md:83-86).
- Update `README.md` when a supported command or installation flow changes (CLAUDE.md:129). This applies to R16, whose dogfood flow is documented in `README.md:147-160` and CLAUDE.md:51-52.
- ADR-014 routing is unchanged. No inline or session-inherited model selection. A missing receipt hard-refuses (CLAUDE.md:88-94). This applies to P2 and P4.
- Preserve unrelated worktree changes (CLAUDE.md:127).
- Delivery rules (`plugins/delivery-pipeline/skills/delivery-rules/SKILL.md`):
  - full frontmatter with non-empty `requirements` (:40-47);
  - `risk: high` requires `human_checkpoint: true` (:53);
  - `files_modified` is a contract (:77-82);
  - Context reads name the existing implementation as `path:line` (:83-96);
  - verification commands are scoped and start with `node`, `bash` or `make` (:97-113);
  - ids are `T-45-NN` (:134-136);
  - new comments only as one-line `@invariant:`/`@security:`/`@contract:` markers (:26-33).

<phase_requirements>
## Phase Requirements (proposed; the planner assigns final wording in ROADMAP.md)

The format follows `.planning/ROADMAP.md:410-419` (`- **REQ-NNN** — sentence.`) and the Phase line at `:837` (`**Requirements**: REQ-…`). The Phase 45 block (`:845-851`) currently says "global IDs await validated planning". `.planning/REQUIREMENTS.md:188-192` mirrors the same ids as `- [ ] **REQ-NNN**:`. Whether it must be updated as well is an open question (Q1).

| Proposed ID | Package | Behaviour | Research support |
|---|---|---|---|
| REQ-185 | S1 | An armed marker binds the realpath of one delivery board. While bound, the hook reads only that board with no newest-wins fallback. A legacy unbound marker has a bounded behaviour. | §S1 |
| REQ-186 | S1 | `stop-gate-arm.cjs disarm` removes only the caller's own marker. A two-armed-session fixture and an installed-bundle test prove it. Human checkpoint. | §S1 |
| REQ-187 | R16 (part) | Dogfood installs default to a dedicated runtime home. The doctor (and therefore the live-round release precondition) reports another session's dogfood cache as foreign, not as an error. | §R16 |
| REQ-188 | R9 | The three named concurrency tests are deterministic: injected clock or explicit barrier, 50 consecutive runs, and the guard-removed variant still fails. | §R9 |
| REQ-189 | R13 (N48) | `usage-report` counts Codex host-stream `turn.completed.usage`. A zero-observation report on a stream transcript fails a test. | §R13 |
| REQ-190 | P1 | A planning-tree writer lease bound to session/run, base revision and a monotonic fencing token. A stale token cannot overwrite a live owner. | §P1 |
| REQ-191 | P2 | A completed judgment role is recovered from its durable reservation, authenticated transcript and artifact digest without relaunch. Missing or altered evidence refuses, and no receipt is synthesized. | §P2 |
| REQ-192 | P4 (part) | A decomposition host launch can be awaited by the existing blocking `deliver-dispatch.cjs wait`. Parent wait and child model usage are attributed separately. | §P4 |
| REQ-193 | D5 | An advisory, shadow-only aggregate admission ledger on `capacity-lease.cjs` that reserves verification/checkpoint capacity and adds no config key. | §D5 |
| REQ-194 | R6 (part) | An internally contradictory Claude drift-check result gets one bounded repair dispatch. A second invalid result refuses with both errors. | §R6 |
| REQ-195 | R8 (part) | The capture scrubber replaces Codex account identifiers (`creator_user_id` etc.), and the fixture scan rejects any that leak. | §R8 |
</phase_requirements>

## Architectural Responsibility Map

| Capability | Primary tier | Secondary tier | Rationale |
|---|---|---|---|
| S1 board binding | Host hook (`stop-gate.cjs`, Claude Stop hook) | Arm CLI (`stop-gate-arm.cjs`), marker in the git common dir | The hook decides allow/block; the marker is durable per-session state |
| S1 installed verification | Installer (`install-shipyard-claude-hook.sh`) | Doctor | The installed bundle is a copy made by `copy_stop_bundle` |
| R16 dogfood home / foreign classification | Installers (`install-shipyard-marketplace.cjs`, `install-shipyard-codex.sh`) | Doctor (`shipyard-doctor.cjs`), provenance record | The install target is an installer decision; foreign-vs-error is doctor classification |
| R9 determinism | Tests | Host constructors (clock injection) | The flakes come from wall-clock or scheduling in tests plus hosts that ignore an injected clock |
| R13 N48 | Deterministic report (`usage-report.cjs`) | — | Pure transcript parsing |
| P1 writer lease | Planning hosts (decompose hosts) | Lease store in private host state (`lock.cjs` primitives) | The hosts are the only trusted writers that seal plans |
| P2 recovery | Decompose hosts + dispatch boundary (durable recorder) | Runtime hosts (transcript parsers) | Recovery must reuse the same verification path as a live launch |
| P4 wait | Decompose host detached launch + existing `deliver-dispatch.cjs wait` | `orchestration-overhead.cjs` | The waiting is done by a host process, not by model turns |
| D5 ledger | `capacity-lease.cjs` | — | The ADR names this file |
| R6 repair | Claude workflow (`workflows/drift-gate.mjs`) | Role-artifact validator (read only, T-43-05/06) | The re-ask is a workflow decision; the validator is unchanged |
| R8 scrubber | Capture tool (`scripts/capture-boundary-fixtures.cjs`) | Fixture scan test | Scrubbing happens at write time; the scan is the backstop |

## Phase-43 ownership check (the first-pass gate)

Command:
```
for f in .planning/phases/43-*/43-*-PLAN.md; do awk '/^---$/{c++;next} c==1' "$f" | awk '/^files_modified:/{p=1;next} p&&/^[a-z_]+:/{p=0} p'; done
```
The output is 114 entries. The phase-43 files a phase-45 first-pass candidate would need:

| File | Phase-43 owner(s) | Effect on the first pass |
|---|---|---|
| `plugins/delivery-pipeline/commands/deliver.md` | T-43-14 | S1 caller line → second pass |
| `plugins/delivery-pipeline/commands/decompose.md` | T-43-11, T-43-12, T-43-15 | P1/P4 caller text → second pass |
| `plugins/delivery-pipeline/scripts/deliver-dispatch.cjs` (+ test) | T-43-14, T-43-15 | P4 `wait` extension → second pass (read-only reuse allowed) |
| `scripts/shipyard-pre-push-gate.sh`, `tests/unit/pre-push-gate.test.cjs` | T-43-02 | R16 pre-push part → second pass |
| `plugins/delivery-pipeline/scripts/comment-policy.cjs` (+ test) | T-43-03 | R4 N13 → second pass |
| `plugins/delivery-pipeline/scripts/publish-gate.cjs` (+ test) | T-43-02, T-43-03 | R4 → second pass |
| `plugins/delivery-pipeline/scripts/role-artifact.cjs` (+ tests) | T-43-05, T-43-06 | R6 must not edit the validator |
| `plugins/delivery-pipeline/scripts/codex-delivery-host.cjs` | T-43-06, T-43-16, T-43-17 | R6 Codex path → second pass |
| `plugins/delivery-pipeline/scripts/claude-role-host.cjs` | T-43-06 | R8 packet/relay parts → second pass |
| `plugins/delivery-pipeline/scripts/state-sync.cjs` | T-43-09, T-43-10 | D5 must keep the `readCapacitySnapshot` shape (`state-sync.cjs:73` reads it) |
| `plugins/delivery-pipeline/scripts/log-event.cjs` | T-43-07, 08, 18, 19 | R6 "journalled" cannot add an event type |
| `plugins/delivery-pipeline/skills/delivery-rules/SKILL.md`, `.shipyard/generated/gsd-delivery-rules/SKILL.md` | T-43-12 | no first-pass package may edit the planning rules |

**Not in any phase-43 `files_modified`** (checked with `grep -n` against the extracted list): `stop-gate.cjs`, `stop-gate-arm.cjs`, `tests/unit/stop-gate*.test.cjs`, `scripts/install-shipyard-claude-hook.sh`, `tests/smoke/claude-hook-smoke.sh`, `scripts/shipyard-doctor.cjs`, `scripts/install-shipyard-marketplace.cjs`, `scripts/install-shipyard-codex.sh`, `plugins/delivery-pipeline/scripts/host-provenance.cjs`, `tests/live/live-round.sh`, `README.md`, `Makefile`, `capacity-lease.cjs`, `lock.cjs`, `dispatch-boundary.cjs`, `session-handoff.cjs`, `run-controller.cjs`, `claude-decompose-host.cjs`, `codex-decompose-host.cjs`, `planning-result-sealer.cjs`, `claude-runtime-host.cjs`, `codex-runtime-host.cjs`, `orchestration-overhead.cjs`, `usage-report.cjs`, `workflows/drift-gate.mjs`, `claude-workflow-host.cjs`, `scripts/capture-boundary-fixtures.cjs`, and the tests `usage-report`, `capacity-lease`, `dispatch-boundary`, `session-handoff`, `codex-decompose-host`, `claude-decompose-host`, `workflows-args`, `boundary-fixtures`, `host-provenance` and `marketplace-installer`.

**Planner action:** re-run the extraction command immediately before writing PLANs. Phase-43 plan amendments (#322, #339 per INV-008 system-state §1) have already changed `files_modified` once.

---

## S1 — armed Stop-gate binds its board (FULLY FREE except the `deliver.md` caller line)

### Current code
- `stop-gate-arm.cjs:23-30` `markerPath` → `<git-common-dir>/shipyard/stop-gate-armed/<session>.json`, falling back to `<cwd>/.planning/graph/stop-gate-armed` outside git.
- `:32-37` `arm()` writes `{ session_id, armed_at, cwd: path.resolve(cwd) }` via `writeAtomic` (lock.cjs).
- `:39-46` `isArmed()` checks only `marker.session_id === sessionId`.
- `:48` exports `{ markerPath, arm, isArmed, validSessionId }`.
- `:54-57` the CLI accepts only `arm` (`usage: stop-gate-arm.cjs arm [--session-id <id>]`).
- `:10` the session-id regex is `/^[A-Za-z0-9_-]{8,128}$/` (`@security` marker).
- `stop-gate.cjs:490-494` `scopedMode` (run_id / `SHIPYARD_RUN_CONTROL=scoped` / `SHIPYARD_RUN_STORE_DIR`), and `:496-514` the scoped run-owned selection. Keep both unchanged.
- `stop-gate.cjs:515-525`: unarmed → `allow()`. When armed, it collects `frontFileIn(dir)` for `[cwd, ...worktreesOf(cwd)]`.
- `:530-531` `candidates.sort(...)`, and `candidates[0]` wins. This is the defect.
- `:279-281` `frontFileIn(dir)` = `<dir>/.planning/graph/delivery-front.json`.
- `:286-294` `worktreesOf` (`git worktree list --porcelain`).
- `:541-547` the "NOT your cwd" note.
- `:359-440` a ledger beside the chosen front (`stop-gate-ledger.json`, keyed by `session_id`). Once bound, the ledger follows the bound board's `graphDir`.
- `:226` `MAX_BLOCKS`, and `:233` `LEDGER_NAME = 'stop-gate-ledger.json'`.
- `stop-gate.cjs:89-91` (the header) accepts the cross-session risk explicitly: "Two sessions delivering different phases of one repo would let the busier board answer for the quieter one." S1 reverses this, so the header comment has to be rewritten to match. Keep it as a one-line `@invariant`, per the comment policy.
- Callers:
  - `commands/deliver.md:1231-1238` runs `node ${CLAUDE_PLUGIN_ROOT}/scripts/stop-gate-arm.cjs arm` (the plugin cache copy);
  - `tests/unit/stop-gate-arm.test.cjs:154-166` asserts that text. Both stay unchanged in the first pass.
- Installer:
  - `install-shipyard-claude-hook.sh:180-225` `copy_stop_bundle` copies the relative-require closure of `stop-gate.cjs`, so `stop-gate-arm.cjs` and any new relative dependency are bundled automatically;
  - `:269-275` self-check pipes `{}` into the installed hook;
  - `:34-35` `STOP_DIR="$CLAUDE_HOME/hooks/shipyard-stop-gate"`.
- The doctor bundle check is at `scripts/shipyard-doctor.cjs:215-266` (`validateHookBundle`).

### Existing tests and patterns to copy
- `tests/unit/stop-gate.test.cjs` (79 tests, all pass, 9 s; run this session) uses `assert-harness.cjs`.
- Fixtures:
  - `repoWithPhaseWorktree(mainFront, phaseFront)` at `:299-322` builds a real git repo plus a linked worktree;
  - `runIn(cwd, payload, env, doArm)` at `:324-332`;
  - `armedPayload` at `:24-29`;
  - `live()` at `:57-63`;
  - `fresh()` / `agesAgo()` at `:50-51`.
- Regressions to preserve:
  - `:402` "a stale all-clear in the session cwd does not answer for a live sibling worktree";
  - `:426` "the newest board wins even when the nearest one is the live-looking fake";
  - `:436` "selection ignores dispatch marks";
  - `:447` "a cwd outside any git repo still reads its own front";
  - `:729-747` foreign or malformed markers;
  - `:749` "an armed session with a stale main checkout and a live worktree front blocks";
  - `:349-400` the scoped-run controls.
- `:402` and `:426` encode the newest-wins behaviour itself. They must become **legacy-unbound-marker** tests, with bound-marker counterparts added. Deleting them would silently drop the stale-main regression.
- `tests/unit/stop-gate-arm.test.cjs` (12 tests, pass).
- `tests/smoke/claude-hook-smoke.sh:15-24` installs a **fake** `stop-gate.cjs` (`const wake = require('./run-waker.cjs')…`), so no existing test runs the real installed hook. The installed-bundle S1 test is new.

### Files a plan would touch
- `plugins/delivery-pipeline/scripts/stop-gate-arm.cjs`
- `plugins/delivery-pipeline/scripts/stop-gate.cjs`
- `tests/unit/stop-gate.test.cjs`
- `tests/unit/stop-gate-arm.test.cjs`
- a new installed-bundle test (for example `tests/unit/stop-gate-installed.test.cjs`, or an addition to `tests/smoke/claude-hook-smoke.sh`)
- `README.md`, if `disarm` becomes a documented command

`scripts/install-shipyard-claude-hook.sh` changes only if the planner needs a new bundled non-relative file (it should not). None of these is phase-43-owned.

### Recommended design (MEDIUM, planner decides details)
1. **Marker v2 (additive):** `{ session_id, armed_at, cwd, board, board_realpath_digest? }`, where `board = fs.realpathSync(<graph dir>)`.
   - `arm` resolves the board in this order: `--graph-dir <d>` flag, then `SHIPYARD_GRAPH_DIR`, then `<cwd>/.planning/graph` when it holds `delivery-front.json` or `tickets.json`. This mirrors `graph-dir.cjs:46-61` `resolveGraphDir` (flag → env → cwd).
   - When none resolves, write the marker **without** `board` (unbound).
   - `graph-dir.cjs` requires only `fs`, `path` and `child_process` (`:27-29`), so requiring it from `stop-gate-arm.cjs` keeps the bundle closure self-contained. The test at `stop-gate-arm.test.cjs:142-148` requires only built-ins and relative modules.
2. **Hook, bound marker:** read only `<board>/delivery-front.json`.
   - Re-`realpath` the stored path. A missing, unreadable, non-directory, or realpath-changed board → `allow()` with one stderr line naming `arm --graph-dir` / `disarm`. Never select another board, and never trap.
   - Keep `movedSince`, the ledger and every hatch reading `graphDir = board`.
3. **Hook, legacy/unbound marker (the bounded behaviour):** keep today's candidate scan (this preserves the stale-main regression `:749`), bounded by both of:
   - at most one refusal per turn: ignore ledger round-advancement for unbound markers, i.e. the old `stop_hook_active` rule `:415`;
   - expiry after `RESYNC_MS` from `armed_at`.
   Each refusal names the remedy (`arm --graph-dir <board>` or `disarm`). [ASSUMED: these are the specific bounds; ADR-023 requires only "a bounded behaviour".]
4. **`disarm`:** `stop-gate-arm.cjs disarm [--session-id <id>]`.
   - Validate the id with the same regex.
   - Unlink only `markerPath(cwd, id)`, and only if its body's `session_id` equals the id (do not delete a foreign or malformed body).
   - Exit 0 when absent (idempotent); non-zero on an I/O error.
   - Export `disarm`.
5. **Re-arm** overwrites the session's own marker, which is the rebind. `--fork-session` produces a new id and a new marker (`deliver.md:1238` already says re-arm).

### Pitfalls
- **Version skew:** the arm CLI is the plugin cache copy (`deliver.md:1233`) and the reader is the hook bundle copy. The new hook must treat old markers as legacy. The old hook reads new markers through `isArmed`, which checks only `session_id`, so the extra fields are harmless.
- **Board chosen at Step 0:** without the `deliver.md` change, `arm` runs from whatever cwd the Bash call has. If that cwd is a stale main checkout with its own graph, the default resolution binds the wrong board. That session would then be under-enforced (it allows a stop over a live phase board) instead of trapped. This is why S1 needs the human checkpoint and the second-pass `--graph-dir` caller line. The test plan must include a case where the "bound to stale main" behaviour is visible and bounded.
- **Realpath:** macOS tmp dirs are symlinked (`/var` → `/private/var`), so compare only `fs.realpathSync` values. The existing fixture already does `fs.realpathSync(fs.mkdtempSync(...))` in other suites.
- **Hook budget:** the hook has a ~75 ms budget (`stop-gate.cjs:296-298` comment). A bound read skips `git worktree list`, so it is faster.
- **The hook always exits 0** (every test asserts `r.status === 0`, `stop-gate.test.cjs:89`). `disarm` failures belong to the CLI, not the hook.
- `@security`: the `board` value comes from a file an attacker with repository write access could edit. Require realpath plus the `…/.planning/graph` suffix, and never interpolate it unquoted. The refusal text already uses `shellQuote` (`stop-gate.cjs:641`).

### Verification commands
- `node tests/unit/stop-gate.test.cjs`
- `node tests/unit/stop-gate-arm.test.cjs`
- `node tests/unit/stop-gate-installed.test.cjs` (new; installs with `CLAUDE_HOME=$TMPDIR/... SHIPYARD_GSD_AUTO_INSTALL=0 bash scripts/install-shipyard-claude-hook.sh`, then runs the installed `stop-gate.cjs` against the A/B fixture)
- `make test-hooks`
- Human checkpoint (operator, outside the sandbox): `shasum -a 256 ~/.claude/hooks/shipyard-stop-gate/stop-gate.cjs` against the source, then `make doctor`.

---

## R16 — concurrent sessions do not break each other's host (PARTLY FREE)

### Current code
- **Codex installs into the shared home by default.** `install-shipyard-marketplace.cjs:132-145` `setupCodexHost` uses `home = CODEX_HOME || ~/.codex` and passes `installKindEnv(source)`. `:36-40` marks an untagged or dirty local checkout `SHIPYARD_INSTALL_KIND=dogfood`. So `node scripts/install-shipyard-marketplace.cjs codex --source "$PWD"` (the command in CLAUDE.md:23-24) writes a dogfood cache into `~/.codex`.
- **Claude refuses the equivalent.** `:42-50` `refuseUnreleasedClaudeSource`, tested in `tests/unit/marketplace-installer.test.cjs:77-96`.
- Explicit dogfood roots:
  - `install-shipyard-codex.sh:56-87` `--dogfood-root` refuses a root at or inside the active or default Codex home (exit 3);
  - `install-shipyard-claude-hook.sh:59-96` `--dogfood-root` refuses a root inside the Claude plugin cache;
  - `Makefile:128-134` makes both targets error when `DOGFOOD_ROOT` is unset.
- Doctor:
  - `shipyard-doctor.cjs:125-134` `provenanceCheck` → `warn` for dogfood;
  - `:136-162` the Claude cache check → **`error`** "cache matches no release" when a dogfood cache's files differ from its tag;
  - `:164-197` Codex: a dogfood record is `warn`, but the digest mismatch is still **`error`** (`:193-195`);
  - `:396` `process.exitCode = 1` on any error.
- **Release precondition:** `tests/live/live-round.sh:139-141` runs `shipyard-doctor.cjs` and fails the `preconditions` stage on a non-zero exit. `scripts/release.sh` requires a live receipt (`:28-45`) and does not call the doctor itself. So a foreign dogfood cache → doctor `error` → live round fails → no receipt → `release` refused.
- **Provenance:** `host-provenance.cjs:32-35` `freeze()` keeps only `{schema, install_kind, version, source_sha, dirty}`, and `readRecord` (`:47-54`) re-freezes. **A new owner field (for example `source_root` or `session`) is silently dropped unless `freeze` keeps it.**
- **Pre-push part, deferred:** `scripts/shipyard-pre-push-gate.sh` is T-43-02 (merged to the epic only).

### Tests to copy
- `tests/unit/marketplace-installer.test.cjs:115-135` (`codexSetup(localSource(), inspect)` stubs; 9 tests pass).
- `tests/unit/host-provenance.test.cjs:32-70` (5 pass).
- `tests/smoke/claude-hook-smoke.sh:197-218` `cache_doctor` (fixtures that expect `ok`/`error`/`skip`).
- `tests/smoke/claude-hook-smoke.sh:140-178` (dogfood-root refusal cases).

### Files
- `scripts/install-shipyard-marketplace.cjs`
- `scripts/install-shipyard-codex.sh` (default dogfood root)
- `Makefile` (a default `DOGFOOD_ROOT` instead of an error, if chosen)
- `scripts/shipyard-doctor.cjs`
- `plugins/delivery-pipeline/scripts/host-provenance.cjs`
- `tests/unit/marketplace-installer.test.cjs`
- `tests/unit/host-provenance.test.cjs`
- `tests/smoke/claude-hook-smoke.sh`
- `README.md` (`:147-160` documents the dogfood flow)
- `CLAUDE.md` (`:51-52` says "needs DOGFOOD_ROOT=")

### Design notes (MEDIUM)
- "Foreign" needs an owner identity in the record. For example, add `source_root` (the realpath of the checkout toplevel) or reuse `source_sha`. The doctor classifies a dogfood cache whose `source_root` differs from the doctor's own `ROOT` as `foreign` (a warn-level status that does not set the exit code). Its own dogfood is still `warn`. A release cache whose files differ stays `error`.
- A dedicated default home, for example `${XDG_STATE_HOME:-$HOME/.local/state}/shipyard/dogfood/<runtime>/<sha256(realpath worktree)>`. [ASSUMED: path.] For the Codex marketplace flow, either refuse an unreleased local source into a shared home (mirroring Claude) or redirect it to the dedicated home. This changes the install behaviour, so both documentation files are affected.

### Pitfalls
- `docs-smoke.sh` checks documented make targets (CLAUDE.md:59-62). Keep the targets' names.
- `release-gate.test.cjs:150-153` asserts the exact `doctor_args` text in `live-round.sh`, so do not edit that line.

### Verification commands
- `node --test tests/unit/marketplace-installer.test.cjs tests/unit/host-provenance.test.cjs`
- `bash tests/smoke/claude-hook-smoke.sh`
- `node tests/unit/release-gate.test.cjs`

**Deferred to the second pass:** "the pre-push hook checks the worktree that is actually pushed" (`scripts/shipyard-pre-push-gate.sh`, `tests/unit/pre-push-gate.test.cjs`, both T-43-02).

---

## R9 — flaky concurrency tests become deterministic (FULLY FREE)

| Test | Location | Harness | What the code shows |
|---|---|---|---|
| "production gsd-planner/… reaches its native child" (3 roles) | `tests/unit/codex-decompose-host.test.cjs:325-420` | `node:test` (`:10`) | `leaseTtlMs: 2000, heartbeatMs: 20` (`:364-365`), with the fake child closing after `setTimeout(170)` (`:392-395`). `runCli` builds `createRunController({ storeDir, leaseTtlMs })` **without `now`** (`codex-decompose-host.cjs:330-333`), although the controller supports `options.now`/`options.clock` (`run-controller.cjs:260`). The heartbeat is a real `setInterval` (`codex-decompose-host.cjs:356-363`). The lease check is `record.owner.expires_at <= now` → `LEASE_EXPIRED 'the run lease has expired'` (`run-controller.cjs:297-298`), which is the CI error text in intake N5. Synchronous parsing and sealing longer than 2 s blocks the heartbeat. The test also asserts `heartbeat_at > acquired_at` (`:407`), which needs at least one heartbeat. |
| "two successor processes race through acknowledgement…" | `tests/unit/session-handoff.test.cjs:188-293` | `assert-harness.cjs` | Two `ack` child processes run in parallel via `Promise.all` (`:260-264`). The lock is a mkdir lock that refuses immediately, `OWNERSHIP_LOCKED` (`session-handoff.cjs:454-479`), with an mtime-based `LOCK_GRACE_MS = 2000` (`:21`, `:449-452`). The assertion is exactly one winner, and the loser is `HANDOFF_LOST` or `OWNERSHIP_LOCKED` (`:265-271`). |
| "file-backed reservation is atomic across concurrent Node processes" | `tests/unit/dispatch-boundary.test.cjs:1871-1908` | `assert-harness.cjs` | 8 children, IPC ready barrier then `send('reserve')`. `reserve` uses `atomicCreateBuffer` link-publish (`dispatch-boundary.cjs:154-182`, `:593-605`). Each child first runs `loadAuthorityKey` (`:212-228`), a concurrent create of a shared key file in the **parent** of `storeDir` (`:208-210`). |

Harness fact (verified): `assert-harness.cjs:76-99` starts an async body immediately and parks its promise. Later synchronous tests in the same file then run on the same event loop before `done()` (`:112-125`). The two harness-based R9 tests therefore share wall-clock time and CPU with every later synchronous test in their file.

**Root cause status:**
- codex-decompose-host: MEDIUM. The error text matches, and the missing clock injection is visible in the code.
- session-handoff and dispatch-boundary: LOW. Not reproduced, and the failing assertion is not recorded in intake N14/N7.

A 50-run loop was not executed in this session (INV-008 system-state §8 also recommends a spike). **Wave 0 must reproduce each test and capture the failing assertion before choosing a barrier.**

### Files
- `tests/unit/codex-decompose-host.test.cjs`
- `plugins/delivery-pipeline/scripts/codex-decompose-host.cjs` (pass `options.now` into `createRunController`, and allow an injected heartbeat trigger)
- `tests/unit/session-handoff.test.cjs`
- `tests/unit/dispatch-boundary.test.cjs`
- possibly `session-handoff.cjs` / `dispatch-boundary.cjs`, only if the reproduced cause is in production code

### Pitfalls
- The acceptance requires that "the refusal cases they cover still fail when the guard is removed". Keep a mutation check, for example a test variant with the lock or link replaced by a non-atomic write that must fail.
- Do not "fix" a flake by widening TTLs alone. The ADR wants an injected clock or barriers.
- `codex-decompose-host.test.cjs` also pins `CAPTURED_SHA256` (`:316`) to fixture bytes. R8 must not re-capture those fixtures.

### Verification
- `node tests/unit/codex-decompose-host.test.cjs`
- `node tests/unit/session-handoff.test.cjs`
- `node tests/unit/dispatch-boundary.test.cjs` (baseline this session: 18/18, 18 passed, 64 passed)
- The 50-run gate: `bash -c 'for i in $(seq 50); do node tests/unit/session-handoff.test.cjs >/dev/null || exit 1; done'` (one per suite; long-running, use at the phase gate).

---

## R13 (N48 part) — `usage-report` counts `turn.completed.usage` (FULLY FREE)

### Current code
- The Codex branch accepts only `event_msg`/`token_count` or `token_usage_record` (`usage-report.cjs:479-482`).
- It requires `row.timestamp` (`:501-503`) and a session id (`:500`), and treats the value as a **cumulative** thread total (`:486-493`, `:506-538`).
- `CODEX_FIELDS` = `['input_tokens', 'cached_input_tokens', 'cache_write_input_tokens', 'output_tokens', 'reasoning_output_tokens']` (`:14-15`).
- `grep -n "turn\.completed" usage-report.cjs` finds nothing.
- The host-stream shape (verified in `tests/fixtures/captured/codex-agent-stream-exec.jsonl`):
  - `{"type":"thread.started","thread_id":"<SESSION-1>"}`
  - `{"type":"turn.started"}`
  - `{"type":"turn.completed","usage":{"input_tokens":20391,"cached_input_tokens":6912,"cache_write_input_tokens":0,"output_tokens":5,"reasoning_output_tokens":0}}`
  - **No timestamp, no model or effort. The usage is per turn, not cumulative.**
- The session identity is `thread.started.thread_id`. `codex-runtime-host.cjs:247-253` parses the same stream (`thread.started` → session, `turn.completed` + `usage` → count).

### Tests
- `tests/unit/usage-report.test.cjs` uses `node:test` (48 pass). The Codex cases at `:52-226` are the pattern to copy, and the parent native fixture is at `:687`.

### Files
- `plugins/delivery-pipeline/scripts/usage-report.cjs`
- `tests/unit/usage-report.test.cjs`

### Pitfalls
- **Double counting:** the same Codex thread can appear both as a host stream (`exec --json`) and as a native rollout file with `token_count`/`token_usage_record`. Choose one schema per session, as `:386-407` already does for legacy vs current. The stream must not add to a session that current records already own.
- The per-turn values must be **summed** (not max-merged as `mergeUsage` does, `:408-414`), with the source ordering preserved.
- The missing timestamp must not be treated as a valid time. Use an explicit `unit`/`finalized` path, or mark it as untimed, instead of the `:501` refusal.
- Model and effort come only from attribution. `metadataFor` is at `:184`. Never infer them.
- The `subscriptionUsage` pass (`:544-554`) is separate and must stay unchanged.

### Verification
`node --test tests/unit/usage-report.test.cjs`

---

## P1 — planning-tree writer lease with fencing (FULLY FREE; caller text deferred)

### Current code
- No planning writer lease exists. INV-008 grep found only `lock.cjs:69` and `gsd-sync.cjs:1291`.
- Claude: `claude-decompose-host.cjs:180-258` `runDecomposition` creates a **fresh** `runId` and controller per call (`:199-206`) under `privateStore(scope)` (`:174-178`: `~/.local/state/shipyard/claude-decompose/<sha256(repo,worktree,phase)>`). It seals plans after launch (`:243-245` → `decompositionEnvelope` `:155-172` → `sealDecomposition`).
- Codex: `codex-decompose-host.cjs:314-400` `runCli` uses the caller's `scope.run_id` with a store keyed by `sha256(realpath(worktree))` (`:75-92`), and seals in `sealPlans` / `sealResearchArtifact` (`:137-171`).
- Neither host prevents a second session from launching a planner into the same phase directory at the same time.
- Primitives to compose, rather than adding a fifth store (INV-008 system-state §4):
  - `lock.cjs` `withLock`/`acquire`/`writeAtomic` (`:262`, `:342`, `:363`, exports `:376`), with token-proven release and takeover (`:32-42` header);
  - `run-controller.cjs` owner/lease/epoch fencing (`SESSION_FENCED` `:293-296`, `LEASE_EXPIRED` `:297-298`).
- Request validators that T-43-15 will build requests against:
  - `claude-decompose-host.cjs:97-129` `canonicalRequest` **refuses unknown fields** (`:99-100`, keys `role, phase, worktree, prompt, signals`);
  - `codex-decompose-host.cjs:36` `requestValue`.

### Files
- A new `plugins/delivery-pipeline/scripts/planning-writer-lease.cjs` (recommended), or an extension of `capacity-lease.cjs` (this collides with D5; see the serialization notes).
- `claude-decompose-host.cjs`, `codex-decompose-host.cjs`
- `planning-result-sealer.cjs` (optional: record the lease token and epoch in the sealed index)
- New tests, plus `tests/unit/claude-decompose-host.test.cjs` and `tests/unit/codex-decompose-host.test.cjs`

### Design notes (MEDIUM)
- Key the lease by realpath(worktree) plus the phase directory. Store it in private host state outside the worktree, like `defaultRunStoreDir`, which refuses in-worktree state (`codex-decompose-host.cjs:86-89`).
- The record holds `{owner (session/run), base_revision (git HEAD), epoch (monotonic), token, expires_at}`.
- Acquire before launch, and re-assert `{token, epoch}` immediately before sealing. A stale or expired lease alone cannot overwrite a live owner: takeover requires the prior owner's pid to be dead, or a TTL plus an explicit `recover` path, mirroring `lock.cjs` takeover.
- "Foreign edits make affected receipts stale": record the phase-directory file digests at acquire and at seal. A change by a non-owner between them is reported with the changed path and writer evidence.

### Pitfalls
- Adding a **required** request field breaks T-43-15's builders. Any new field must be optional, or the lease must be host-internal (preferred: the host derives everything from scope).
- The lease must not be global. Unrelated worktrees must never contend (acceptance).
- Keep `DEFAULT_LEASE_TTL_MS` semantics, and inject a clock (R9 lesson).

### Verification
`node tests/unit/planning-writer-lease.test.cjs` (new), `node tests/unit/claude-decompose-host.test.cjs`, `node tests/unit/codex-decompose-host.test.cjs`

**Deferred:** the `decompose.md` instructions (T-43-11/12/15).

---

## P2 — recover a completed judgment role without relaunch (FULLY FREE)

### Current code
- Phase-42 `--resume-finalization` exists only for the executor in `codex-delivery-host.cjs:865-1192` (T-43-06/16/17-owned; a pattern to read, not to edit).
- The decompose hosts have no recovery path.
- The Codex native parent must `wait` for its child. Each wait output must carry a boolean `timed_out` (`codex-runtime-host.cjs:807-817`). The child transcript must have exactly one `task_complete` and one `session_meta` bound to the parent and role (`:837-870`). The parent transcript is re-read and digest-checked (`readNativeParentRaw` `:823-835`: `native parent transcript changed after selection verification`).
- The durable recorder (`dispatch-boundary.cjs:276-`) has an HMAC-sealed envelope with a per-store authority key (`:212-252`), `reserve` (`:593-605`), and `record` (which requires an existing reservation, `:612`, and a `compliance === 'verified'` receipt, `:610`). Replay refusals are `DUPLICATE_DISPATCH_ID` (`:1540-1553`, `:1950`).
- Both hosts seal artifacts via `sealDecomposition` (planning-result-sealer.cjs).

### Files
- `claude-decompose-host.cjs`, `codex-decompose-host.cjs` (a `recover --dispatch <id>` entry)
- `dispatch-boundary.cjs` (a read-only "reservation without record" query, if missing)
- possibly `codex-runtime-host.cjs` / `claude-runtime-host.cjs` (export existing parsers only)
- tests for each role (researcher, planner, checker) plus a crash boundary

### Pitfalls
- **Never synthesize a receipt.** Recovery must feed the original transcripts through the same verification functions that a live launch uses, producing one original receipt for the original `dispatch_id`. Count model use once.
- An incomplete, altered, unknown-live (child pid still alive) or missing transcript refuses.
- Codex task text arrives encrypted in `agent_message` (intake N27). Do not base the proof on the child's first user message.
- `dispatch-boundary.cjs` is a hot file inside phase 45 (P2, R9's test). Serialize.

### Verification
`node tests/unit/codex-decompose-host.test.cjs`, `node tests/unit/claude-decompose-host.test.cjs`, `node tests/unit/dispatch-boundary.test.cjs`

---

## P4 — blocking wait for decomposition (PARTLY FREE)

### Current code
- The supported blocking wait is `deliver-dispatch.cjs wait --dispatch <id> [--timeout-ms n]` (`deliver-dispatch.cjs:467-474`; documented at `deliver.md:1740`).
- `waitOnce` (`:404-432`) polls `statusOnce` (`:384-402`) with an injectable `clock`/`sleep` and records a wake event.
- `statusOnce` reads `<stateDir>/<id>/record.json` (`readRecord` `:365-368`) with `{dispatch_id, ticket, role, runtime, graph_dir, pid, result, log, started_at}` (written at `:251-255`), under `dispatchStateDir` = `~/.local/state/shipyard/dispatch` (`:211-213`).
- `deliver-dispatch.cjs` is **T-43-14/15-owned**.
- `orchestration-overhead.cjs` already separates `wait_poll` from `model_turn` (`:25`, `:31`, `:157`, `:371-379`, `:420-441`).

### First-pass-free part
- A decomposition host detached-launch mode (in the decompose hosts, or a new small launcher script) writes a `record.json` / `result.jsonl` in the **same format** under `dispatchStateDir`. The existing `deliver-dispatch.cjs wait` then works unchanged.
- A contract test reads it through the exported `statusOnce`/`waitOnce` (`deliver-dispatch.cjs` exports `:487-488`). Reading and importing do not modify the file.
- Parent/child usage attribution rows go to `orchestration-overhead.cjs`.

### Deferred
Any change to `deliver-dispatch.cjs` (for example a `launch --role decomposition`) and the `decompose.md` caller text (T-43-11/12/14/15).

### Pitfalls
- Coupling to `record.json`, an internal format that T-43-14/15 may change. The contract test must fail loudly if the format moves.
- "No extra model wake on unchanged waits" is an efficiency claim. It reports `inconclusive` until matched cohorts exist (ADR-023 Consequences).

### Verification
`node tests/unit/orchestration-overhead.test.cjs`, `node tests/unit/codex-decompose-host.test.cjs`, plus a new contract test.

---

## D5 — advisory aggregate admission ledger (FULLY FREE)

### Current code
- `capacity-lease.cjs:39-216` `createCapacityCoordinator`:
  - per provider/account-scope slot leases under `withLock(lockDir, 'capacity', …, { waitMs: 5000 })`;
  - default `max = 4` (`:48`), TTL 30 min (`:9`);
  - local fallback marked `degraded` (`:63-70`);
  - `SCHEMA_VERSION = 'shipyard.capacity-leases.v1'` (`:8`);
  - exports `SCHEMA_VERSION, DEFAULT_TTL_MS, createCapacityCoordinator, readCapacitySnapshot` (`:222`).
- It is wired into no launch path. The only consumer is `state-sync.cjs:73` (`readCapacitySnapshot`, owned by T-43-09/10), so **the snapshot's existing fields and the schema string must stay compatible**.

### Tests
`tests/unit/capacity-lease.test.cjs` (`node:test`, 5 pass; `fixture(fn)` pattern `:10-13`).

### Files
`capacity-lease.cjs`, `tests/unit/capacity-lease.test.cjs`

### Design notes
- A run/phase aggregate: `reserve({run_id, phase, kind: 'launch'|'verification'|'checkpoint'})` records a shadow decision `would_admit`/`would_refuse`. It **never** changes an admission result.
- A verification/checkpoint reserve is excluded from the launch cap.
- `reconcile` records observed usage when known. Missing quota data yields conservative counts, never a percentage.
- No new `pipeline.*` key (`pipeline-config.cjs` is T-43-01/10). Parameters come from the constructor only.

### Pitfalls
- Atomic reservations across processes. D5 depends on R9 for trustworthy concurrency tests (INV-008 RESEARCH constraints).
- Advisory means no caller behaviour change. The planner must not wire it into `deliver-dispatch.cjs` (T-43-14/15).

### Verification
`node --test tests/unit/capacity-lease.test.cjs`

---

## R6 — one bounded repair for a contradictory judge (PARTLY FREE: Claude drift workflow)

### Current code
- The validator is `role-artifact.cjs:1103-1125` `driftResultData`, failing with `INVALID_RESULT 'fresh drift verdict cannot contain moved findings'` (`:1117-1118`). It is **T-43-05/06-owned: read only**.
- Claude path: `workflows/drift-gate.mjs:209-258` dispatches through `createClaudeWorkflowDispatch({ role: 'drift-check', requireArtifact: true, artifact: {...}, previousDispatchId, … })`, and its `.catch((e) => { throw e })` (`:252-254`) is the seam.
- The seal happens in the trusted consumer `claude-workflow-host.cjs:285-295` (`roleArtifact.seal`).
- The fan-out accounting requires exactly one result per ticket (`drift-gate.mjs` tail, lines ~265-291: "no single result for …").
- The Codex path is `codex-delivery-host.cjs` (T-43-06/16/17) → second pass.

### Tests
- `tests/unit/workflows-args.test.cjs` (69 pass): suite `:361` "drift-gate.mjs — a dead or throwing judge fails the artifact boundary", and `:873` "drift-gate propagates host receipt failures instead of inventing drift".

### Files
`plugins/delivery-pipeline/workflows/drift-gate.mjs`, `tests/unit/workflows-args.test.cjs`

### Pitfalls
- Match on the error **code and exact message** of this one contradiction. Do not retry every `INVALID_RESULT`.
- The repair is a new dispatch with a new id and `previousDispatchId` = the first. drift-check is a fixed rung (CLAUDE.md:92, "Fixed mechanical roles do not promote"), so the repair must not trigger `repeat` escalation.
- "Journalled" cannot add a `log-event.cjs` type (T-43-07/08/18/19). Carry both errors and both dispatch ids in the result or refusal for the host to journal later. Mark this gap for the second pass.
- `drift-gate.mjs` is also generated to Codex outputs only if the generator includes workflows. Check `make package-shipyard-codex` on the epic.

### Verification
`node tests/unit/workflows-args.test.cjs`

---

## R8 — capture scrubber (PARTLY FREE: scrubber only)

### Current code
- `scripts/capture-boundary-fixtures.cjs:55-65` `scrub` replaces home/tmp paths (`:18-23`), token shapes (`:25-32`) and UUIDs → `<SESSION-n>` (`:34-41`).
- It has **no rule for Codex account fields**. The committed fixtures show hand replacements: `"creator_user_id":"<USER-ID>"` in `codex-agent-stream-{parent,child}.jsonl`, and `"creator_account_id"` mis-placeholdered as `<SESSION-1>` (it is a UUID).
- The scratch dir is a bare `mkdtemp` (`:238`) with no `git init`.
- The fixture scan is `tests/unit/boundary-fixtures.test.cjs:43-65` `checkFixtureScrub` (no account-id check), with scrub tests at `:217-275` (23 pass).

### Files
`scripts/capture-boundary-fixtures.cjs`, `tests/unit/boundary-fixtures.test.cjs`

### Pitfalls
- Do not re-capture or rewrite committed fixtures. `codex-decompose-host.test.cjs:316` pins `CAPTURED_SHA256`, and the tests replace `<SESSION-n>` placeholders by position.
- Placeholder names must stay stable (`<USER-ID>`, plus a new `<ACCOUNT-ID>` for new captures only).

### Verification
`node tests/unit/boundary-fixtures.test.cjs`

**Deferred:** packet elision/summary (`claude-role-host.cjs`, T-43-06), the dogfood `CODEX_HOME` recipe (overlaps R16 docs), and the boundary-contract relay record.

---

## R4 — N13 scanner fix → SECOND PASS

`comment-policy.cjs` + `tests/unit/comment-policy.test.cjs` are T-43-03, and `publish-gate.cjs` + test are T-43-02/03. The hotfix #293 avoided the regex (intake N13). Plan it after T-43-03 lands on `main`.

## Intra-phase-45 serialization (Gate 2 rejects unordered overlaps)

| File | First-pass packages | Recommended order |
|---|---|---|
| `codex-decompose-host.cjs` + test | R9, P1, P2, P4 | R9 → P1 → P2 → P4 |
| `claude-decompose-host.cjs` + test | P1, P2, P4 | P1 → P2 → P4 |
| `dispatch-boundary.cjs` / `tests/unit/dispatch-boundary.test.cjs` | R9 (test), P2 | R9 → P2 |
| `capacity-lease.cjs` | D5 (and P1 only if the lease is placed there) | put P1 in its own module to avoid the edge |
| `tests/smoke/claude-hook-smoke.sh`, `README.md` | S1 (if used), R16 | S1 ‖ R16 need an edge, or keep S1's installed test in its own new file |
| `session-handoff.test.cjs` | R9 | — |

All of these are **same-phase** edges, which cascade. Cross-phase edges are forbidden in this pass.

## Standard Stack

No new dependencies. Node ≥ 24 built-ins only (`node:fs`, `node:path`, `node:crypto`, `node:child_process`, `node:test`), plus the repository primitives `lock.cjs`, `run-controller.cjs`, `dispatch-boundary.cjs` `createDurableRecorder`, `graph-dir.cjs` and `host-provenance.cjs`. The two in-repo test harnesses are `tests/unit/assert-harness.cjs` (stop-gate, session-handoff, dispatch-boundary, workflows-args, boundary-fixtures, orchestration-overhead) and `node:test` (codex-decompose-host, claude-decompose-host, usage-report, capacity-lease, host-provenance, marketplace-installer). New tests should follow the harness of the file they extend.

## Package Legitimacy Audit

Not applicable: the first pass installs no external package. `stop-gate-arm.test.cjs:142-148` enforces built-in/relative requires for the hook bundle.

## Don't Hand-Roll

| Problem | Don't build | Use instead | Why |
|---|---|---|---|
| Cross-process lock / takeover | a new mkdir or TTL lock | `lock.cjs` `withLock`/`acquire` (`:262`, `:342`) | token-proven release and takeover (audit F12, `lock.cjs:32-42`) |
| Lease with epoch/fencing | an ad-hoc counter file | `run-controller.cjs` lease/epoch model (`:260-305`, `:472-481`) or its store | `SESSION_FENCED`/`LEASE_EXPIRED` semantics already tested |
| Exclusive create | `writeFileSync` + `existsSync` | `atomicCreateBuffer` link-publish (`dispatch-boundary.cjs:154-182`) | never replaces an existing destination |
| Graph dir resolution | a new flag parser | `graph-dir.cjs` `resolveGraphDir` (`:46-61`) | same precedence every other gate uses |
| Receipt sealing / MAC | a new signature | `createDurableRecorder` envelope (`dispatch-boundary.cjs:212-252`) | authority key per store, verified reads |
| Atomic JSON replace | a hand-written rename | `lock.cjs` `writeAtomic` (`:363`) | used by the arm helper today (`stop-gate-arm.cjs:7`) |

## Common Pitfalls (cross-package)

1. **Touching a phase-43 file by habit.** The likely slips are `deliver.md` (S1), `decompose.md` (P1/P4), `deliver-dispatch.cjs` (P4), `log-event.cjs` (R6 journalling) and `role-artifact.cjs` (R6). Re-check `files_modified` against the extraction.
2. **Wall-clock tests.** Inject `now`/`clock` everywhere a lease or TTL is compared (R9, P1, D5).
3. **Assert-harness concurrency.** Async tests overlap with later synchronous tests (`assert-harness.cjs:76-99`). Timing-sensitive async tests belong at the end of a file, or in `node:test`.
4. **Schema drops.** `host-provenance.cjs` `freeze()` discards new fields (`:32-35`). The capacity snapshot is read by a phase-43 file.
5. **Version skew between the plugin cache and the hook bundle** (S1).
6. **Efficiency claims.** P4 and D5 report `inconclusive`. No savings percentage is allowed (ADR-023 Consequences).

## Runtime State Inventory (S1 and R16 change persisted state)

| Category | Items found | Action |
|---|---|---|
| Stored data | S1 markers `<git-common-dir>/shipyard/stop-gate-armed/<session>.json` (`stop-gate-arm.cjs:26-27`); ledgers `<graph>/stop-gate-ledger.json` (`stop-gate.cjs:233`) | legacy markers are read as unbound (code); no migration |
| Live service config | None. Verified: there is no service outside git for these packages | — |
| OS-registered state | The Claude `settings.json` Stop/PreToolUse hook registrations (`install-shipyard-claude-hook.sh:294-300`) | unchanged commands; a reinstall refreshes the bundle |
| Secrets/env vars | `CLAUDE_CODE_SESSION_ID` (`stop-gate-arm.cjs:53`), `SHIPYARD_GRAPH_DIR`, `CODEX_HOME`, `SHIPYARD_DOGFOOD_ROOT`, `SHIPYARD_INSTALL_KIND` | names unchanged |
| Build artifacts | the installed hook bundle `~/.claude/hooks/shipyard-stop-gate/`; the Codex cache `~/.codex/plugins/cache/shipyard/shipyard/*`; the generated `plugins/shipyard/` | operator reinstall at the S1 checkpoint; regenerate `plugins/shipyard` once on the epic |

## Environment Availability

| Dependency | Required by | Available | Version | Fallback |
|---|---|---|---|---|
| node | all | ✓ | v24.10.0 | — |
| git | S1 fixtures, P1, R9 | ✓ | 2.54.0 | — |
| bash | smoke tests | ✓ | (macOS system bash) | — |
| `claude` / `codex` CLIs | none of the first-pass unit tests (stubs used) | not probed | — | S1 human checkpoint runs outside the sandbox |
| `~/.claude`, `~/.codex` | S1 installed-hook check, R16 doctor | **not readable in this sandbox** (read deny on `/Users/serhii`) | — | tests use temporary `CLAUDE_HOME`/`CODEX_HOME`; the real-home check is the human checkpoint |

## Validation Architecture

| Property | Value |
|---|---|
| Framework | `tests/unit/assert-harness.cjs` and `node:test` (Node 24) |
| Config | none; `tests/unit/run.sh` runs each `*.test.cjs` with `node` and a scratch `GIT_CONFIG_GLOBAL` (`:23-35`) |
| Quick run | `node tests/unit/<suite>.test.cjs` per touched suite |
| Full suite | `make test-fast` (CLAUDE.md:56) |

| Req | Behaviour | Type | Command | Exists? |
|---|---|---|---|---|
| REQ-185 | bound board only; legacy bounded | unit + git fixture | `node tests/unit/stop-gate.test.cjs` | ✅ (extend) |
| REQ-186 | disarm; two armed sessions; installed bundle | unit + install | `node tests/unit/stop-gate-arm.test.cjs`, `node tests/unit/stop-gate-installed.test.cjs` | ❌ Wave 0 (installed test) |
| REQ-187 | foreign dogfood; dedicated home | unit + smoke | `node --test tests/unit/marketplace-installer.test.cjs tests/unit/host-provenance.test.cjs`, `bash tests/smoke/claude-hook-smoke.sh` | ✅ (extend) |
| REQ-188 | deterministic concurrency | unit, 50× loop | the three suites; loop via `bash -c` | ✅ (rewrite) |
| REQ-189 | `turn.completed.usage` counted | unit | `node --test tests/unit/usage-report.test.cjs` | ✅ (extend) |
| REQ-190 | writer lease + fencing | unit | `node tests/unit/planning-writer-lease.test.cjs` | ❌ Wave 0 |
| REQ-191 | judgment recovery per role + crash | unit | `node tests/unit/codex-decompose-host.test.cjs`, `node tests/unit/claude-decompose-host.test.cjs` | ✅ (extend) |
| REQ-192 | waitable decomposition + attribution | unit + contract | `node tests/unit/orchestration-overhead.test.cjs` + new contract test | ❌ Wave 0 (contract) |
| REQ-193 | advisory ledger | unit | `node --test tests/unit/capacity-lease.test.cjs` | ✅ (extend) |
| REQ-194 | one repair, two refuse | unit | `node tests/unit/workflows-args.test.cjs` | ✅ (extend) |
| REQ-195 | account ids scrubbed and scanned | unit | `node tests/unit/boundary-fixtures.test.cjs` | ✅ (extend) |

- **Sampling:** run the quick per-suite command on every task commit and `make test-fast` per wave. At the phase gate, add the 50-run R9 loops and the S1 human checkpoint.
- **Wave 0 gaps:** R9 reproduction (capture the failing assertion for each test), the installed-stop-gate test file, the planning-writer-lease test file, and the P4 record-format contract test.

## Security Domain (security_enforcement: true, ASVS L1)

| ASVS | Applies | Control |
|---|---|---|
| V4 Access control | yes | S1 binds the session to its own marker and board. `disarm` deletes only the caller's own marker. The P1 lease owner and epoch fence writers. |
| V5 Input validation | yes | the session-id regex (`stop-gate-arm.cjs:10`); marker `board` must realpath to `…/.planning/graph`; bounded request files (`claude-decompose-host.cjs:289-290`) |
| V6 Cryptography | yes (P2) | reuse the recorder HMAC envelope (`dispatch-boundary.cjs:230-252`); never create a receipt without it |
| V8 Data protection | yes (R8, R16) | scrub account identifiers; private state is 0600/0700 (`capacity-lease.cjs:79`, `stop-gate-arm` via `writeAtomic`) |
| V12 Files | yes | path traversal in markers and boards; symlinked tmp dirs; no in-worktree host state (`codex-decompose-host.cjs:86-89`) |

| Threat | STRIDE | Mitigation |
|---|---|---|
| Forged marker steering the hook to a foreign board | Tampering / Elevation | realpath plus suffix check; on doubt allow and stay bounded, never select another board |
| A stale planning writer overwriting a live owner | Tampering | fencing epoch and token checked immediately before sealing |
| A synthesized recovery receipt | Spoofing / Repudiation | recovery only through the original transcript digests and the recorder MAC; missing evidence refuses |
| An account id leaking into committed fixtures | Information disclosure | scrubber rule plus fixture scan |

## Assumptions Log

| # | Claim | Section | Risk if wrong |
|---|---|---|---|
| A1 | The legacy-marker bound is "one refusal per turn and expiry after `RESYNC_MS` from `armed_at`" | S1 | S1 acceptance case 3 may need different bounds; this needs a human decision at the checkpoint |
| A2 | Default arm resolution flag → env → cwd graph, via `graph-dir.cjs` | S1 | a session arming from a stale main checkout binds the wrong board until the second-pass caller line |
| A3 | The dedicated dogfood home path under `~/.local/state/shipyard/dogfood/…` | R16 | a documentation/UX change; the operator may prefer a refusal |
| A4 | The session-handoff and dispatch-boundary flakes stem from scheduling contention, not production races | R9 | if production code is racy, R9 grows into `session-handoff.cjs`/`dispatch-boundary.cjs` changes |
| A5 | P4's host-written `record.json` compatible with `deliver-dispatch` is acceptable reuse of a T-43-owned format without editing it | P4 | T-43-14/15 may change the format; the contract test guards it |
| A6 | The R6 repair as a new dispatch (not an in-session continuation) satisfies "same round" | R6 | the acceptance may require the same dispatch id |

## Open Questions (RESOLVED)

1. **Must `.planning/REQUIREMENTS.md` (`:188-192` style) receive REQ-185+ as well as ROADMAP.md?** RESOLVED: no hand edit. `REQUIREMENTS.md` is generated ("Requirements generated by Shipyard GSD synchronization", `.planning/REQUIREMENTS.md:394`), and ROADMAP.md is the source; REQ-185–REQ-196 are in `.planning/ROADMAP.md:420-431` and on the Phase 45 **Requirements** line (`:861`).
2. **R9 root causes for session-handoff and dispatch-boundary.** RESOLVED: Wave 0 reproduction steps in 45-04 Scope 1 and 45-05 Scope 1; production edits only under their own failing test.
3. **Is P4's first-pass part worth shipping before the caller exists?** RESOLVED: kept small (detached host mode, contract test, `actor` attribution) in 45-11; the `deliver-dispatch`/`decompose.md` caller is second pass.
4. **Should S1's installed test live in a new file** (no overlap with R16's `claude-hook-smoke.sh`)? RESOLVED: a new file, `tests/unit/stop-gate-installed.test.cjs` (45-01).

Note: the REQ ids in "Phase Requirements" and "Validation Architecture" above are the proposed numbering. The final ids are in ROADMAP.md and `45-VALIDATION.md`; for example, the concurrency tests are REQ-189, not REQ-188.

## First-pass disposition (the answer the orchestrator asked for)

| Package | Disposition | Deferred part (second pass, with owner) |
|---|---|---|
| S1 | **Partly free**: core fully free | `deliver.md` caller line / `--graph-dir` / disarm step (T-43-14) |
| R16 | **Partly free** | pre-push hook checks the pushed worktree (`scripts/shipyard-pre-push-gate.sh`, `tests/unit/pre-push-gate.test.cjs`; T-43-02) |
| R9 | **Fully free** | — |
| R13 (N48) | **Fully free** | the rest of R13 (N44–N47) stays second pass (T-43-06/14/16/17) |
| P1 | **Fully free** (code) | `decompose.md` text (T-43-11/12/15) |
| P2 | **Fully free** | — |
| P4 | **Partly free** | `deliver-dispatch.cjs` changes and `decompose.md` caller (T-43-14/15, T-43-11/12) |
| D5 (advisory) | **Fully free** | enforcement and wiring into launches (after measurement; `deliver-dispatch.cjs` is T-43-14/15) |
| R4 (N13) | **Second pass** | all of it (`comment-policy.cjs` T-43-03, `publish-gate.cjs` T-43-02/03) |
| R6 | **Partly free** (Claude `drift-gate.mjs`) | Codex path (`codex-delivery-host.cjs` T-43-06/16/17); journal event (`log-event.cjs` T-43-07/08/18/19) |
| R8 | **Partly free** (scrubber, git-init scratch) | packet elision (`claude-role-host.cjs` T-43-06); relay contract record |

## Sources

### Primary (HIGH, read this session)
- ADR-023 (`.planning/architecture/ADR-023-residual-pipeline-efficiency.md:28-41`); the phase-45 WORK-PACKAGES.md (`:19-68`), CONTEXT.md and PLANNING-STATUS.md.
- INV-008 RESEARCH.md, DECISIONS.md, research/system-state.md, intake/phase40-delivery-findings.md (N5/N7/N13/N14/N23/N27–N29/N48/N55/N56).
- All 19 phase-43 PLAN frontmatters.
- The source and test files cited inline, with file:line.

### Secondary
- None. No web or Context7 lookups were needed; the phase is internal code.

## Metadata

- **Confidence:** code state HIGH; ownership HIGH (re-run before planning); designs MEDIUM; R9 causes LOW/MEDIUM.
- **Research date:** 2026-09-28. **Valid until** the next phase-43 merge or plan amendment (re-extract `files_modified`).

## Release preparation (2026-09-30; terminal T-45-15)

**Scope and confidence.** This addition supports one low-risk, terminal release-preparation ticket for the existing phase 45; it does not change REQ-193, ADR-023, or plans 45-01 through 45-14. The package and release contracts below are HIGH confidence from source plus local commands. The remote release state is UNKNOWN because the GitHub probes failed; recheck it before publication. [VERIFIED: `.planning/phases/45-close-residual-pipeline-efficiency-gaps/CONTEXT.md:28-45`; `.planning/ROADMAP.md:428`; `.planning/architecture/ADR-023-residual-pipeline-efficiency.md:28-41`]

### Current system state and failure

- The canonical manifest declares `"version": "0.68.0"` in `plugins/delivery-pipeline/.claude-plugin/plugin.json:4`. The marketplace catalog points at `"source": "./plugins/delivery-pipeline"` and has no release version field in `.claude-plugin/marketplace.json:11-21`; leave that catalog alone. [VERIFIED: `plugins/delivery-pipeline/.claude-plugin/plugin.json:1-5`; `.claude-plugin/marketplace.json:11-21`]
- `make package-shipyard-codex` invokes `scripts/package-shipyard-codex.cjs`, which copies the canonical plugin and capability trees into `plugins/shipyard/host`, generates six Codex skill wrappers, derives the Codex version from the source manifest plus a content digest, and writes `.codex-plugin/plugin.json` and `package-build.json`. Never edit the generated `host/` tree directly. [VERIFIED: `Makefile:5-7`; `scripts/package-shipyard-codex.cjs:12-69`; `CLAUDE.md:70-81`]
- The marketplace test compares a fresh package snapshot with checked-in `plugins/shipyard` only when `packageFreshnessRequired(GITHUB_BASE_REF)` is true. The function returns false for `epic/` and `ticket/` prefixes; `main` returns true. `GITHUB_BASE_REF=main node tests/unit/marketplace-install.test.cjs` exited 1 with `Marketplace package is stale: run make package-shipyard-codex` at `tests/unit/marketplace-install.test.cjs:75-76`. The test is in the `tests/unit/*.test.cjs` loop used by `make test-fast` in CI. [VERIFIED: `scripts/package-shipyard-codex.cjs:71-76`; `tests/unit/marketplace-install.test.cjs:60-76`; `tests/unit/run.sh:32-36`; `Makefile:64-72`; `.github/workflows/test.yml:67-70`]
- A read-only comparison built into a temporary directory (`node -e '... require("./scripts/package-shipyard-codex.cjs").build(out); spawnSync("diff",["-qr","plugins/shipyard",out]) ...'`) exited with `diff` status 1 and identified **12** changed/generated paths: `.codex-plugin/plugin.json`; `host/plugins/delivery-pipeline/scripts/{capacity-lease,claude-decompose-host,codex-decompose-host,host-provenance,planning-writer-lease,stop-gate-arm,stop-gate,usage-report}.cjs`; `host/plugins/delivery-pipeline/workflows/drift-gate.mjs`; `host/scripts/install-shipyard-codex.sh`; `package-build.json`. This is the current checkout's exact package delta, not a promise about the later final tree. [VERIFIED: command output, 2026-09-30; `scripts/package-shipyard-codex.cjs:12-68`]

### Recommended T-45-15 boundary

1. Execute the ticket in its own `ticket/T-45-15-...` branch through the existing conveyor **after** all fourteen source tickets have reached the phase epic; regenerate once from that integrated source. Do not edit earlier plan identities, frontmatter, dependencies, ownership or risk decisions. The planner must enforce terminal ordering without assuming a single primary-parent branch contains unrelated sibling tickets. [VERIFIED: `CLAUDE.md:76-81`; `plugins/delivery-pipeline/skills/delivery-rules/SKILL.md:108-130`; `.planning/phases/45-close-residual-pipeline-efficiency-gaps/CONTEXT.md:28-45`]
2. Set the canonical manifest's `"version"` from `"0.68.0"` to candidate `"0.69.0"`, then run `make package-shipyard-codex`; inspect the generated diff and include only generated paths that actually change. The exact minimum expected ownership is `plugins/delivery-pipeline/.claude-plugin/plugin.json`, the generated `plugins/shipyard/**` delta above, and one proposed source release-note document `docs/releases/v0.69.0.md` (new path; planner confirms its location). No generator, installer, test, catalog or model-policy edit is needed for the observed failure. [VERIFIED: `plugins/delivery-pipeline/.claude-plugin/plugin.json:4`; `scripts/package-shipyard-codex.cjs:24-68`; `tests/unit/marketplace-install.test.cjs:74-76`; `CLAUDE.md:76-81`] [ASSUMED: proposed notes path]
3. Draft notes from the **merged** v0.68.0-to-final-tree commits and use that document as the later `gh release create ... --notes-file` input. The existing `release.sh` only creates a local annotated tag and prints a push command; `release-notes-smoke.sh` checks remote tags against GitHub Releases and documents `--notes-file`. It does not publish the GitHub Release. `rg -n 'release notes|release-note|notes-file|gh release|CHANGELOG' --glob '*.md' --glob '*.sh' --glob '*.cjs' .` found no existing source release-note document. [VERIFIED: `scripts/release.sh:47-51`; `tests/smoke/release-notes-smoke.sh:22-49`; command output, 2026-09-30]

**Scoped deterministic ticket verification:** run `GITHUB_BASE_REF=main node tests/unit/marketplace-install.test.cjs` to prove source/package byte parity under the integration-to-main condition; run `node tests/unit/release-gate.test.cjs` to cover the unchanged release receipt contract; run `make test-fast` once at the integration gate, rather than on every ticket repair. The marketplace test constructs its own fresh package and compares every file hash, including the derived version and digest. [VERIFIED: `tests/unit/marketplace-install.test.cjs:60-76`; `tests/unit/release-gate.test.cjs:35-96`; `Makefile:64-72`]

Current scoped baseline: `node tests/unit/release-gate.test.cjs` exited 0 (`10 passed, 0 failed`); `GITHUB_BASE_REF=epic/45-close-residual-pipeline-efficiency-gaps node tests/unit/marketplace-install.test.cjs` exited 0 (`marketplace installation tests passed`). Only the integration-to-main freshness branch fails, as reproduced above. [VERIFIED: command outputs, 2026-09-30; `scripts/package-shipyard-codex.cjs:71-74`]

**Publication gate after merge:** `scripts/release.sh` reads the source manifest version, refuses a dirty tree or an existing local `v<version>` tag, obtains `HEAD^{tree}`, and checks fresh passing live receipts for both runtimes before tagging. The live-receipt source quotes the exact required values: `RUNTIMES = Object.freeze(['claude', 'codex'])`, `REQUIRED_STAGES = Object.freeze(['research', 'decompose', 'executor', 'publish', 'sentinel'])`; the default freshness is `7` days. Run real `bash tests/live/live-round.sh --runtime claude` and `bash tests/live/live-round.sh --runtime codex` against the **final merged tree** with the required installed hosts and throwaway repository, then check the exact version/tree with `node plugins/delivery-pipeline/scripts/live-receipt.cjs check --version 0.69.0 --tree-sha "$(git rev-parse 'HEAD^{tree}')"`. Neither a test fixture receipt nor a receipt from the ticket branch substitutes for those final-tree runs. Native dispatches remain Codex under ADR-014. [VERIFIED: `scripts/release.sh:13-49`; `plugins/delivery-pipeline/scripts/live-receipt.cjs:9-10,72-99,121-130`; `tests/live/live-round.sh:22-27,129-141`; `CLAUDE.md:84-94`]

**Collision and unknowns:** `git tag -l 'v0.69.0'` printed nothing locally. `git ls-remote --tags origin 'refs/tags/v0.69.0'` failed DNS resolution and `gh release view v0.69.0 --json tagName` failed to connect to `api.github.com`; neither command established remote availability. Recheck both remote tag and GitHub Release immediately before `make release VERSION=0.69.0` and publication. A remote collision requires a new candidate version and a fresh package, notes and final-tree receipts. [VERIFIED: command outputs, 2026-09-30; `scripts/release.sh:13-27,29-49`]

| Assumption / open question | Confirmation before planning or publication |
|---|---|
| [ASSUMED] `docs/releases/v0.69.0.md` is an acceptable source notes location; this repository currently has no established source notes path. | Planner chooses the one notes path and records it in T-45-15 `files_modified`; publisher passes that exact path to `gh release create --notes-file`. |
| [ASSUMED] `0.69.0` remains the next free minor on origin and GitHub Releases. | Publisher repeats `git ls-remote --tags origin 'refs/tags/v0.69.0'` and `gh release view v0.69.0 --json tagName` with network access; a failed lookup is not absence. |
| [ASSUMED] All fourteen earlier tickets will be integrated before package generation. | Planner/conveyor checks the epic tree and T-45-01…T-45-14 merge status before dispatch; the package test then proves parity on that tree. |

## Integration gap repairs (2026-09-30; T-45-16 and T-45-17)

**Scope and precedence.** This bounded update researches the two repairs to the already integrated Phase 45 tree. It supersedes the stale candidate version and package baseline in the preceding “Release preparation” addition: `nl -ba plugins/delivery-pipeline/.claude-plugin/plugin.json | sed -n '1,8p'` shows the exact source value `DATA_q8Vn2KpR_START` `"version": "0.70.0"` `DATA_q8Vn2KpR_END` at line 4. `git rev-parse HEAD 'HEAD^{tree}' origin/main 'origin/main^{tree}'` returned `e6d1393c173d18d7085a25651e41cd1849d8360b` and tree `f92ca2753f88481ade184660f3ebc551c4c794be` for this worktree, versus `4592df4f0f22cb840f742aed02b54b689521f535` and tree `a0c9f0753af878e2d63eab025cb1a432fee6fe39` for `origin/main`. These are research-time identities, not a release receipt. [VERIFIED: `plugins/delivery-pipeline/.claude-plugin/plugin.json:1-5`; command outputs, 2026-09-30] Preserve plans 45-01 through 45-15 byte-for-byte; the new work is two nonoverlapping repair tickets. [VERIFIED: `.planning/phases/45-close-residual-pipeline-efficiency-gaps/INTEGRATION.md:100-124,146-148`; `.planning/phases/45-close-residual-pipeline-efficiency-gaps/CONTEXT.md:21-45`]

### Current system state and repair boundary

| Capability | Current observation and command-backed evidence | Planning consequence |
|---|---|---|
| Codex completion and recovery | `nl -ba plugins/delivery-pipeline/scripts/codex-decompose-host.cjs | sed -n '645,765p;1060,1142p'` shows `captureNativeCompleted` writes the completion-time artifact digests at lines 729-735, but recovery accepts an absent completion record at 1085-1087 and fills digests from current files at 1112-1141. The exact branch begins `DATA_M4xQ9cT1_START` `if (!completed) {` `DATA_M4xQ9cT1_END`. [VERIFIED: `plugins/delivery-pipeline/scripts/codex-decompose-host.cjs:729-735,1080-1141`] | T-45-16 must require the original durable completion record and its changed-path/digest checkpoint before any receipt path. A pre-checkpoint crash refuses, regardless of current bytes. [CITED: `.planning/phases/45-close-residual-pipeline-efficiency-gaps/45-09-PLAN.md:42-51,59-69`] |
| Native process proof | `nl -ba plugins/delivery-pipeline/scripts/codex-runtime-host.cjs | sed -n '1170,1230p'` shows the session-start callback is triggered by stdout at 1181-1191, after stdin may already be written at 1215-1218. `nl -ba plugins/delivery-pipeline/scripts/codex-decompose-host.cjs | sed -n '660,681p;1079,1095p'` shows nullable PID is accepted and recovery probes only safe integers. Both host `pidAlive` helpers and the writer-lease helper map probe errors other than `EPERM` to stopped. [VERIFIED: `plugins/delivery-pipeline/scripts/codex-runtime-host.cjs:1170-1218`; `plugins/delivery-pipeline/scripts/codex-decompose-host.cjs:662-681,1089-1092,541-545`; `plugins/delivery-pipeline/scripts/claude-decompose-host.cjs:250-254`; `plugins/delivery-pipeline/scripts/planning-writer-lease.cjs:43-48,216-239`] | T-45-16 owns the runtime callback seam and all three liveness helpers. Persist a positive original PID synchronously before native input; refuse missing, invalid, live or unknown liveness. Treat only `ESRCH` as proof of absence, while retaining the lease's explicit expiry behavior. [CITED: `.planning/phases/45-close-residual-pipeline-efficiency-gaps/45-09-PLAN.md:42-45,59-69`; `.planning/phases/45-close-residual-pipeline-efficiency-gaps/45-10-PLAN.md:38-50`] |
| Receipt fence | `nl -ba plugins/delivery-pipeline/scripts/dispatch-boundary.cjs | sed -n '2390,2440p'` puts durable `recorderRecord` and `recorderFinalize` before the host returns. Codex researcher/planner call `assertNoForeignEdit` only inside their seal helpers and checker returns directly; Claude checks the fence only for decomposition, after `createClaudeWorkflowDispatch`. Codex acquisition at 1236 precedes its `try/finally` at 1281. [VERIFIED: `plugins/delivery-pipeline/scripts/dispatch-boundary.cjs:2410-2435`; `plugins/delivery-pipeline/scripts/codex-decompose-host.cjs:145-186,827-836,1236-1319`; `plugins/delivery-pipeline/scripts/claude-decompose-host.cjs:390-435`] | T-45-16 must place fence and foreign-edit validation in a pre-record boundary hook or equivalent authorized seam, for researcher, planner and checker in both live and recovery flows. A post-record seal check cannot satisfy zero durable receipts. Protect every operation after lease acquisition with `finally`. [CITED: `.planning/phases/45-close-residual-pipeline-efficiency-gaps/45-08-PLAN.md:35-55`; `.planning/phases/45-close-residual-pipeline-efficiency-gaps/45-09-PLAN.md:48-51`] |
| Marketplace dogfood isolation | `nl -ba scripts/install-shipyard-marketplace.cjs | sed -n '36,48p;65,92p;140,190p'` shows `main` runs `installCodexMarketplace` before `setupCodexHost`; plugin list/add/remove/upgrade use ambient environment, and the dedicated home or shared-home refusal is selected only in setup. [VERIFIED: `scripts/install-shipyard-marketplace.cjs:36-48,65-92,140-190`] | T-45-17 selects and validates the target before every Codex marketplace read/write, carries that environment through plugin commands and bootstrap, and proves refusal has no side effect. [CITED: `.planning/phases/45-close-residual-pipeline-efficiency-gaps/45-03-PLAN.md:38-53`; `.planning/architecture/ADR-023-residual-pipeline-efficiency.md:28-35`] |

**Additional installer leak in T-45-17.** The direct shell installer snapshots `GSD_DEFAULTS_PATH` at `scripts/install-shipyard-codex.sh:657-659`, then runs `gsd-tune --global` at 667-668. `gsd-tune` chooses `path.join(process.env.HOME || '', '.gsd', 'defaults.json')` at `plugins/delivery-pipeline/scripts/gsd-tune.cjs:316-320`, ignoring that override. The exact throwaway probe below exited 0, printed a write under its temporary `HOME/.gsd/defaults.json`, and reported `isolated_exists False`, `shared_exists True`; it touched no real user home. [VERIFIED: `scripts/install-shipyard-codex.sh:651-669`; `plugins/delivery-pipeline/scripts/gsd-tune.cjs:316-320,1114-1119`; command output, 2026-09-30]

```bash
python3 -c 'import tempfile,pathlib,subprocess,os,json; root=pathlib.Path(tempfile.mkdtemp(prefix="shipyard-gsd-target-")); env=dict(os.environ,HOME=str(root),GSD_DEFAULTS_PATH=str(root/"isolated"/"defaults.json"),GSD_RUNTIME="codex",SHIPYARD_RUNTIME="codex"); p=subprocess.run(["node",str(pathlib.Path("plugins/delivery-pipeline/scripts/gsd-tune.cjs").resolve()),"--global","--runtime","codex","--apply"],cwd=root,env=env,text=True,capture_output=True); print("exit",p.returncode); print("stdout",p.stdout[-500:]); print("stderr",p.stderr[-500:]); print("isolated_exists",(root/"isolated"/"defaults.json").exists()); print("shared_exists",(root/".gsd"/"defaults.json").exists())'
```

A narrow T-45-17 correction should make `gsd-tune --global` honor the installer-selected defaults path, with a test where the override differs from `HOME/.gsd/defaults.json`, and keep ordinary global tuning behavior when the override is absent. The existing installer test uses its fixture's `GSD_DEFAULTS_PATH` at `tests/unit/gen-codex-shipyard.test.cjs:888-893` but does not distinguish these two targets. [VERIFIED: `tests/unit/gsd-tune.test.cjs:317-326,547-563`; `tests/unit/gen-codex-shipyard.test.cjs:888-893`] [ASSUMED: whether every standalone direct-shell dogfood path should set an isolated override automatically; confirm against the installer contract before broadening T-45-17.]

### Prescriptive ticket ownership and order

| Ticket | Sole canonical source and test ownership | Acceptance tests to write first |
|---|---|---|
| T-45-16 — judgment recovery and writer-fence repair | `plugins/delivery-pipeline/scripts/{codex-decompose-host,claude-decompose-host,codex-runtime-host,dispatch-boundary,planning-writer-lease}.cjs`; `tests/unit/{codex-decompose-host,claude-decompose-host,codex-runtime-host,dispatch-boundary,planning-writer-lease}.test.cjs`. The dispatch boundary belongs here because it finalizes the record before the host post-check; the runtime host belongs here because its callback currently arrives after stdin. [VERIFIED: `plugins/delivery-pipeline/scripts/dispatch-boundary.cjs:2410-2435`; `plugins/delivery-pipeline/scripts/codex-runtime-host.cjs:1170-1218`] | Per role and per runtime: pre-record takeover and foreign-edit injections leave no durable `record-*.json` or verified receipt; checker is included. Codex pre-checkpoint crash refuses, post-checkpoint crash recovers original dispatch without spawn; same-path byte tampering refuses. Missing/invalid/live/unknown PID and injected non-`ESRCH` probe errors refuse with zero receipts. A failed PID persistence prevents stdin. Assert lease release after post-acquire throws. Preserve authenticated successful receipts and single-count usage. [CITED: `.planning/phases/45-close-residual-pipeline-efficiency-gaps/45-08-PLAN.md:48-59`; `.planning/phases/45-close-residual-pipeline-efficiency-gaps/45-09-PLAN.md:59-69`; `.planning/phases/45-close-residual-pipeline-efficiency-gaps/45-10-PLAN.md:59-70`] |
| T-45-17 — marketplace home isolation | `scripts/install-shipyard-marketplace.cjs`, `plugins/delivery-pipeline/scripts/gsd-tune.cjs`, `tests/unit/marketplace-installer.test.cjs`, `tests/unit/gsd-tune.test.cjs`, and, if the direct installer assertion needs extending, `tests/unit/gen-codex-shipyard.test.cjs`. Do not alter T-45-16 files. [VERIFIED: `scripts/install-shipyard-marketplace.cjs:65-92,140-190`; `plugins/delivery-pipeline/scripts/gsd-tune.cjs:316-320`; `tests/unit/marketplace-installer.test.cjs:130-220`] | Call `main` through injected command seams with two temporary checkout roots; assert all Codex list/add/remove/upgrade/bootstrap calls see the chosen isolated home, and explicit shared-home refusal makes zero Codex calls and zero writes. Add the off-default `GSD_DEFAULTS_PATH` test and assert the shared default bytes remain unchanged. Retain release and explicit custom-home behavior. [CITED: `.planning/phases/45-close-residual-pipeline-efficiency-gaps/45-03-PLAN.md:38-53`] |

Plan T-45-16 and T-45-17 without overlapping source ownership; the generated `plugins/shipyard/**` is refreshed **once after both canonical source repairs land** with `make package-shipyard-codex`. Run `GITHUB_BASE_REF=main node tests/unit/marketplace-install.test.cjs` on that repaired combined tree: the test rebuilds the package and byte-compares it only when the main-base freshness condition applies. [VERIFIED: `Makefile:5-7`; `tests/unit/marketplace-install.test.cjs:60-76`; `.planning/phases/45-close-residual-pipeline-efficiency-gaps/INTEGRATION.md:146-148`] The two repair tickets add no external packages; retain the existing Node CommonJS stack. [VERIFIED: `scripts/install-shipyard-marketplace.cjs:1-13`; `plugins/delivery-pipeline/scripts/codex-decompose-host.cjs:1-20`]

### Release and evidence gates that stay open

Run the touched unit suites, then `make test-fast` on the final repaired tree. The existing integration's I18 was interrupted, so it is not a full-suite pass. `scripts/release.sh` requires a clean tree and a fresh live receipt for each runtime at the exact `HEAD^{tree}`; the source quotes `DATA_Z6mR3vQ8_START` `RUNTIMES = Object.freeze(['claude', 'codex'])` `DATA_Z6mR3vQ8_END` and `DATA_J2cN7pL4_START` `REQUIRED_STAGES = Object.freeze(['research', 'decompose', 'executor', 'publish', 'sentinel'])` `DATA_J2cN7pL4_END`. [VERIFIED: `Makefile:64-72`; `.planning/phases/45-close-residual-pipeline-efficiency-gaps/INTEGRATION.md:18-28,130-132`; `scripts/release.sh:13-49`; `plugins/delivery-pipeline/scripts/live-receipt.cjs:9-10,72-99`] Run real `bash tests/live/live-round.sh --runtime claude` and `bash tests/live/live-round.sh --runtime codex` only against the final merged version 0.70.0 tree, then check `node plugins/delivery-pipeline/scripts/live-receipt.cjs check --version 0.70.0 --tree-sha "$(git rev-parse 'HEAD^{tree}')"`. The installed Stop hook/operator checkpoint and recovered-vs-live receipt comparison remain open until performed; unit fixtures cannot close them. [VERIFIED: `tests/live/live-round.sh:25-28,129-141`; `.planning/phases/45-close-residual-pipeline-efficiency-gaps/INTEGRATION.md:126-132,142-144`]

Remote publication state is unknown: `git ls-remote --tags origin refs/tags/v0.70.0` exited 128 with DNS failure; `gh release view v0.70.0 --repo serhii-nochevnyi/shipyard --json tagName` exited 1 on API connection, and `gh auth status` exited 1 with an invalid token. Repeat those checks from an authenticated connected host before tag or Release creation. No final-tree live rounds or release command were run during this research. [VERIFIED: command outputs, 2026-09-30; `scripts/release.sh:19-50`]

**Assumptions to confirm:** [ASSUMED] The off-default `GSD_DEFAULTS_PATH` correction belongs in T-45-17 rather than a separate installer ticket; it is the smallest repair that prevents a dogfood-scoped install from tuning the ambient global defaults. [ASSUMED] The final repaired source will be packageable without unrelated generated changes; confirm by inspecting `git diff -- plugins/shipyard` after regeneration. Preserve the Phase 47 REQ-193 production-caller work and the separate Phase 46 model ladder. [VERIFIED: `.planning/ROADMAP.md:911,953-965`; `.planning/architecture/ADR-014-mandatory-runtime-model-ladder.md:119-151`]

### Confirmation

The ownership recommendation remains T-45-16 for the five canonical host/lease sources (`codex-decompose-host`, `claude-decompose-host`, `codex-runtime-host`, `dispatch-boundary`, and `planning-writer-lease`) and their corresponding unit tests, and T-45-17 for marketplace installer and defaults-path isolation with its tests. Rebuild the generated package once after both repairs land. The installed Stop hook/operator checkpoint, final-tree CI and live receipts, and remote release checks remain open. [VERIFIED: `.planning/phases/45-close-residual-pipeline-efficiency-gaps/45-RESEARCH.md:731-747`; `.planning/phases/45-close-residual-pipeline-efficiency-gaps/INTEGRATION.md:126-132,146-150`]
