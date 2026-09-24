# INV-004 research line 4 — risks and unknowns

Line: `risks` (→ RISKS.md + OPEN-QUESTIONS.md drafts).
Policy signals (DATA, preserved verbatim): `{"type":"facts"}`.
Selection: `claude-opus-5-5/medium` (resolved by the caller).
Source revision: `8c264020707b67933cf109f0578c652fc8a1cb41`
(`git rev-parse HEAD`, worktree `/Volumes/KINGSTON/.wt-claude-shipyard/inv-004`,
branch `inv/004-phase39-delivery-retro`).

Inputs I read in full: `research/session-evidence.md` (101 lines),
`research/codex-flowpdf-evidence.md` (50 lines), and the `RISKS.md`,
`OPEN-QUESTIONS.md` and `DECISIONS.md` templates (`cat`, exit 0).

## 0. Verification limits of this line

- `gh pr list …` failed in the sandbox: `failed to read configuration: open
  /Users/serhii/.config/gh/config.yml: operation not permitted`. **PR states for
  #202–#208 were not checked.** Every statement below about PR state is inferred
  from git refs only.
- A read of the installed plugin cache (`~/.claude/plugins/cache/shipyard/…`)
  was denied: the session has no approval surface. **The patched-cache state
  (N9) and the `*.pre-T-39-12.bak` files were not observed directly.** Those
  claims come only from the session evidence.
- I did not read the transcripts (`~/.claude/projects/…jsonl`,
  `~/.codex/sessions/…`), because they are outside the sandbox read allowlist.
  Transcript line references are taken from the evidence files as given.

## 1. Command-backed findings that create or sharpen risks

F1. **None of the phase 39 ticket branches is merged into the epic.**
Command: for each `origin/ticket/T-39-*`, `git merge-base --is-ancestor $b
origin/epic/39-remove-conveyor-session-friction`. Output: `merged-in-epic: no`
for T-39-01..07 and T-39-12. T-39-12 is 5 commits ahead of the epic. No remote
branches exist for T-39-08..11 (`git branch -a --list '*39*'`).
The epic tip is `5b56a747` (Merge #203), and that tip is an ancestor of HEAD.

F2. **The main line does not have the T-39-12 schema fix. The unmerged branch
does.** Commands:
- `git grep -c "json-schema" HEAD -- plugins/delivery-pipeline/scripts/claude-runtime-host.cjs`: no match, exit 1.
- The same command against `origin/ticket/T-39-12-forward-the-declared-output-schema-to-ev`: 1 match.

As a result, any live Claude executor round started from main or the epic today
reproduces systemic item 0 / defect 1.

F3. **Files that phase 39 plans touch overlap with files that INV-004 items must
touch.** I read the `files_modified` lists from `.planning/phases/39-remove-conveyor-session-friction/39-*-PLAN.md`
(awk extraction). The overlaps:

| INV-004 item | File | Phase 39 ticket(s) touching it |
|---|---|---|
| 0, 5, 9 | `scripts/claude-runtime-host.cjs`, `scripts/claude-dispatch-adapter.cjs`, `tests/unit/source-contract.test.cjs` | T-39-12 |
| 1 | `scripts/stop-gate.cjs`, `stop-gate-arm.cjs`, `commands/deliver.md`, `tests/unit/dispatch-record.test.cjs` | T-39-03 |
| 2, 8 | `commands/deliver.md` | T-39-03 |
| 7 | `scripts/claude-delivery-host.cjs`, `workflows/investigation-research.mjs` | T-39-08 |
| 7, C1 | `scripts/refusal-hints.cjs` plus all four hosts | T-39-01 |
| C2 | `scripts/gsd-tune.cjs`, `tests/unit/gsd-tune.test.cjs` | T-39-07 |
| C3 | `commands/investigate.md` | T-39-11 |
| C4, C6 | `scripts/codex-decompose-host.cjs`, `tests/unit/codex-decompose-host.test.cjs` | T-39-01 |
| C6 | `commands/decompose.md` | T-39-10 |
| C8 | `scripts/shipyard-doctor.cjs`, `tests/smoke/claude-hook-smoke.sh`, `scripts/install-shipyard-codex.sh` | T-39-04 |
| 6 | `scripts/validate-graph.cjs` | T-39-06 |

Almost every item takes a cross-phase dependency under the 2026-09-24 ordering
decision (PROBLEM.md, out of scope).

F4. **Line references in the evidence have drifted from HEAD.**
`grep -n "is not facts" plugins/delivery-pipeline/scripts/model-policy-internal.cjs`
returns line **423**. The evidence cites `:355`. The Codex evidence line numbers
are stated to hold for `befc970c` (0.61.0, `git log --oneline main -1`), not for
HEAD. `git diff --stat main...origin/epic/39-…` shows 237 files changed, +5463/−416.
Planners must re-resolve every `file:line` cited in the evidence.

F5. **The N6 root cause is not where the problem statement places it.** On HEAD,
`.planning/graph/tickets.json` has `"branch": "ticket/T-39-12-forward-the-declared-output-schema-to-ev"`,
and the pushed ref is the same (`grep -o` + `git branch -r --list`).
`validate-graph.cjs:74-86` `slugify(title, max = 40)` gives exactly
`…-to-ev` (40 characters). `git log --all -S'schema-to-eve' -- .planning/graph/tickets.json`
returned nothing. So `…-to-eve` never existed in the committed `tickets.json`.
The wrong value came from somewhere else: model-computed text, a PLAN.md or
other prose, or `gsd-sync.cjs:62` `slugify(value, max = 64)`, which uses a
different cap. `ticket-worktree.sh` has no slug computation (`Grep slugify`
matched only `validate-graph.cjs` and `gsd-sync.cjs`). The two different caps
(40 vs 64) are a confirmed divergence. I have not confirmed that they caused N6.

F6. **Several code claims were confirmed at HEAD:**
- C4: `codex-decompose-host.cjs:18` has `'gsd-phase-researcher': { role: 'research', sandbox: 'read-only' }`. `tests/unit/codex-decompose-host.test.cjs:103` pins `['gsd-phase-researcher', 'research', 'read-only']`.
- C8: `scripts/shipyard-doctor.cjs:193` looks for `path.join(codexBundle, 'manifest.json')`. `install-shipyard-codex.sh:280` sets `AGENT_MANIFEST_NAME=".shipyard-manifest.json"`, and `:431`/`:664` also write `$OUT/manifest.json`. **Whether `$OUT` equals the `codexBundle` that doctor reads is unverified.** The C8 claim needs a real install trace before a fix goes in (see the open questions).
- C3: `sealPlanningResearch` exists only in `claude-delivery-host.cjs:506`, dispatched at `:752` (`Grep`).
- N5: `tests/unit/source-contract.test.cjs:1986-1989` pins the sha256 of `runtime-adapters.cjs` and `claude-dispatch-adapter.cjs`.
- N7: the wrong remedy text is the constant `REPAIR` at `claude-dispatch-adapter.cjs:19`. It is shared by every refusal path in that adapter.
- N11: `publish-gate.cjs:44` throws `not a git worktree` when `<worktree>/.git` is absent.
- C2: `gsd-tune.cjs:593` gates only the `model_overrides` rows on `runtime === 'claude'`. The `models.*` rows at `:606-609` are unconditional.

## 2. Risks (draft for RISKS.md)

### R1 — The phase 39 fixes are unmerged, so INV-004 builds on sand
severity: high
Evidence: F1, F2, F3.
What can bite: INV-004 tickets that depend on T-39-* branches rebase repeatedly.
T-39-12 is still changing (three fixes in one session). If a T-39 PR is
reworked or rejected, the dependent INV-004 tickets are invalidated. The
success criterion "live wave of phase 40 … sentinel passes on the first round"
is unreachable until T-39-12 is merged and released.
mitigation: Treat "phase 39 merged into the epic, epic merged to main, and a
release cut" as an explicit precondition ticket or gate for the live-wave
success criterion. Order INV-004 tickets so that the non-overlapping items
(3, 4-docs, 11, C7) start from main first.

### R2 — Captured fixtures go stale or leak data
severity: high
Item 0 requires fixtures captured from real `claude --print … --json-schema`
and `codex exec` launches. Risks:
(a) captured stream-json can contain session ids, absolute user paths
(`/Users/serhii/…`) and possibly prompt content, which ends up committed;
(b) a Claude/Codex CLI upgrade changes the wire shape (Codex went 0.154→0.156.1
inside one session per the Codex evidence), so fixtures pass while production
breaks, which is the same failure class again;
(c) capturing needs network and credentials, so it cannot run in CI.
mitigation: A scrub step with a test that rejects home paths and tokens in
fixtures. Record the CLI version in each fixture and have a check that flags a
mismatch with the installed CLI. Keep capture as an explicit `make` target that
is run by hand, not by CI. Propose `/gsd-spike "capture and scrub one real
claude structured_output launch as a fixture"` before planning.

### R3 — Relaxing the source-contract digest pin weakens a security boundary
severity: high
Item 5 needs a repair path for `RUNTIME_OWNED_FILE_DIGESTS`
(`source-contract.test.cjs:1986`). The pin exists so that an agent cannot
silently rewrite the runtime adapter. A "repair" command that an agent can run
reproduces the `sed` bypass seen at [1183] with extra steps. Out of scope:
"Removing fail-closed receipt verification". A digest repair that is too easy
is adjacent to that.
mitigation: The repair must need a human-visible signal, for example a
CODEOWNERS path or a PR label checked in CI, or a digest-change note in the
commit that the publish gate verifies. The test must still fail when the file
changes without the pinned update.

### R4 — A dogfood mode (item 9) becomes a second, unreceipted supply path
severity: high
Running unmerged host code for delivery is by definition running code that no
release covers. If dogfood mode is too convenient, it becomes the default, and
receipts attest to a host that is not reproducible. N9 says receipts do not
record the host source. That was not verified here, because the cache read was
denied.
mitigation: Dogfood mode must stamp receipts with the host source (a git sha
plus a dirty flag, or a file digest set). It must be refused on protected base
branches, or require an explicit env var and an audit record. Add a doctor
check that detects a cache that matches no release (hash mismatch with the
release manifest).

### R5 — Moving the stop-gate dispatch mark earlier (item 1) opens a false-satisfied gate
severity: medium
If the mark is recorded at launch instead of at the receipt, a crashed or
killed dispatch (exit 130 as in the Codex run, `kill -0` checks in N2)
satisfies the gate with no work done. This conflicts with the fail-closed
intent. The fix also overlaps T-39-03 (`stop-gate.cjs`, `dispatch-record.test.cjs`, F3).
mitigation: Use two states, `in-flight` (with a lease or TTL plus pid/heartbeat)
and `received`. The gate is quiet only while a lease is live and fails closed
after it expires. Reuse `run-controller.cjs` `DEFAULT_LEASE_TTL_MS`
(imported at `codex-decompose-host.cjs:13`) instead of inventing a new lease.
Note the known lease flake in the backlog (`codex-plan-checker-lease-test-flakes-on-ci.md`).

### R6 — A deterministic front → dispatch entry (item 2) duplicates schema knowledge
severity: medium
The request shape (`shipyard.claude-delivery-request.v1`,
`args.tickets[{…signals,planPath…}]`) is currently implicit in host source.
A new entry point that builds it is a third producer next to the host and
the workflow. If it is not generated from, or validated against, the same
schema, the class of defect in item 0 comes back.
mitigation: The entry point must call the host's own request validator, and
its tests must round-trip through the real host parse path, not a fixture.
Derive `planPath` from `ticket-worktree.sh` output (see [1011]), not from cwd.

### R7 — Widening `resolveDispatch` signals (item 3) touches the model-policy grid
severity: medium
The fix for `signals.type "implementation"` (`model-policy-internal.cjs:423`)
could be read as adding a new signal class to the ADR-014 grid, which is
explicitly out of scope ("Changes to the ADR-014 model/effort grid").
mitigation: Fix it as a normalization at the graph → dispatch boundary: map or
drop non-policy signal values before `resolveDispatch`, and leave the grid
unchanged. Record a decision on which side owns the mapping (open question Q4).

### R8 — The live success criteria depend on external state the project does not control
severity: medium
"Codex run on FlowPDF completes" and "phase 40 live wave, sentinel first round"
depend on CLI versions, GitHub CI availability (the CI flake at #202), model
behaviour, and the FlowPDF repo state. FlowPDF has untracked
`.planning/graph/receipts/codex/` and `transcripts/codex/` left over, and a
config changed from `inherit` to `balanced` with no `pipeline:` block (Codex
evidence, "FlowPDF state"). That was not verified here: FlowPDF is outside the
sandbox. The next run can pick up that leftover state.
mitigation: Define a fixture project alternative in-repo as the primary
acceptance, with FlowPDF as secondary. Clean or archive the FlowPDF leftovers
before the acceptance run. Allow one CI-flake rerun explicitly in "first round".

### R9 — Codex parity regeneration fans out every change
severity: medium
Success requires "Codex outputs are regenerated". Every prose or command
change (items 2, 4, 7, C3, C7) changes generated `.shipyard/generated/**` and
GSD projections. N10 shows that stale projections already failed CI
(`Makefile:66: test-gsd-sync`, #203). With about 20 items across overlapping
files, regeneration conflicts between parallel tickets are likely.
mitigation: Put the N10 fix (generated-header or merge strategy) early in the
wave order. Keep the generated outputs off the tickets and regenerate them in
one integration step, or mark them as regenerate-on-merge.

### R10 — Fixing C4 changes the sandbox on a research role
severity: medium
Making `gsd-phase-researcher` `workspace-write` (`codex-decompose-host.cjs:18`)
broadens write access for a role whose policy signal is `facts`. A too-broad
write scope lets the researcher modify product code.
mitigation: Limit writes to the contained artifact path (investigation or
phase dir). Test that a write outside it is refused or detected. Replace the
forged read-only fixture (`codex-decompose-host.test.cjs:103`) with a captured
one.

### R11 — Per-line research acceptance (item 7) must not hide failed lines
severity: medium
Item 7 wants to discard one line instead of the whole fan-out. The contract
says: "Missing or duplicated canonical lines … are hard errors". Partial
acceptance risks a Gate 1 that passes with a line silently missing.
mitigation: Keep the fan-out result failed, but keep the valid line
artifacts and name the failed line with a line-specific remedy. Re-dispatch
only the failed line. Never mark the fan-out complete with a line missing.

### R12 — C5 message digest checking is limited by Codex `spawn_agent`
severity: medium
The host cannot see the message that the parent actually passed unless Codex
records it (for example in the child session file). If Codex does not expose
it, a digest check cannot be built host-side, and the fix degrades to a warning.
mitigation: Spike first: `/gsd-spike "read the child codex session rollout and
compare the spawn_agent message digest to the host-issued task"`. If the
message is not observable, pass the task by file reference (path plus digest)
instead of inline text.

### R13 — The N6 root cause is misattributed
severity: low
F5 shows that `tickets.json` and the pushed ref agree (`…-to-ev`). A fix that
only changes `ticket-worktree.sh` addresses nothing, because that script has no
slug logic.
mitigation: Trace the origin of `…-to-eve` before planning (open question Q6).
Unify on one `branchFor` exported from `validate-graph.cjs`, and make
`gh pr create --head` read the branch from `tickets.json` or git, never from
text the model composed.

### R14 — Evidence line numbers drift
severity: low
F4: the cited lines are from 0.61.0 (`befc970c`) or from mid-session trees.
Planners who cite them produce wrong PLAN.md anchors.
mitigation: The researcher and planner re-resolve anchors by symbol at the
ticket base revision.

### R15 — The org and time risk is a single maintainer
severity: low (assumption)
Every PR, dogfood decision and digest repair routes through one person. Git
user `Nochevnyi Serhii` is the only author visible in the recent log. This is
an assumption and was not counted. R3 and R4 mitigations that rely on "human
review" reduce to self-review.
mitigation: Make the gates mechanical (CI-checked) rather than relying on review.

## 3. Unknowns (draft for OPEN-QUESTIONS.md)

- [ ] Q1: What are the current states of PRs #202–#208 (open, merged, closed), and when will T-39-12 merge and a release be cut? `gh` was blocked in this sandbox. Next check: `gh pr list --state all --limit 12`. — owner: Serhii (maintainer)
- [ ] Q2: Does INV-004 wait for phase 39 to merge and release, or does it stack on the unmerged T-39-* branches? — owner: Serhii
- [ ] Q3: Is the installed 0.61.0 Claude cache still patched with the T-39-12 worktree files, and do the `*.pre-T-39-12.bak` files exist? This was not readable here. Next check: `shasum -a 256 ~/.claude/plugins/cache/shipyard/shipyard/0.61.0/scripts/claude-{runtime-host,dispatch-adapter}.cjs` compared against `git show befc970c:…`. — owner: Serhii
- [ ] Q4: Who owns the `signals.type: implementation` mapping: the graph producer (stop emitting it) or dispatch (normalize it)? Can it be done without touching the ADR-014 grid? — owner: Serhii / ADR-014 owner
- [ ] Q5: What human-visible signal should authorize a change to the source-contract digest pin (CODEOWNERS, PR label, commit trailer)? — owner: Serhii
- [ ] Q6: Where did `ticket/T-39-12-…-to-eve` come from, given that `tickets.json` and `validate-graph.cjs slugify(max=40)` both give `…-to-ev`? Next check: grep the 7bcbbf57 transcript around [991] for the source of the string, and grep `39-12-PLAN.md` and `gsd-sync.cjs` (max 64) output. — owner: research line system-state / Serhii
- [ ] Q7: Does `install-shipyard-codex.sh` write `$OUT/manifest.json` to the directory that `shipyard-doctor.cjs:193` reads (`codexBundle`)? In other words, is C8 a path mismatch or a naming mismatch? Next check: a trace of a real install into a temp `CODEX_HOME`. — owner: research line system-state
- [ ] Q8: Does Codex record the actual `spawn_agent` message in a way a host can read after the run (for the C5 digest check)? Needs a spike. — owner: spike / Codex CLI docs
- [ ] Q9: Can captured CLI fixtures be committed after scrubbing (privacy of paths, prompts, and session ids)? What scrub policy applies? — owner: Serhii
- [ ] Q10: What CLI versions are the fixtures pinned to (Claude Code, codex-cli 0.156.1+)? What happens on drift: a warning or a failure? — owner: Serhii
- [ ] Q11: Is FlowPDF an acceptable acceptance target, or should an in-repo fixture project be the primary one? Who cleans up the leftover untracked receipts and transcripts there? — owner: Serhii (FlowPDF owner)
- [ ] Q12: Does "PR sentinel passes on the first round" allow a CI infrastructure flake rerun (such as the #202 flake)? — owner: Serhii
- [ ] Q13: Should dogfood mode be allowed at all on the shipyard repo itself, and must receipts from a dogfood host be rejected by the publish gate on `main`? — owner: Serhii
- [ ] Q14: For item 1, is a lease-based in-flight state acceptable given the known lease flake (`codex-plan-checker-lease-test-flakes-on-ci.md`)? — owner: Serhii
- [ ] Q15: For C4 and R10, what exact write scope should the Codex researcher get (only the artifact file, or the phase dir)? Does the Codex sandbox support path-scoped writes? — owner: Codex CLI docs / spike
- [ ] Q16: Is the N11 pre-push hook fix limited to parsing `git -C` and `cd X;` forms, or should the hook resolve the worktree from git itself (for example the `GIT_DIR` env of the hook)? Which harness gives the hook its input? — owner: Serhii

## 4. Spikes recommended (not executed; throwaway validation)

- `/gsd-spike "capture and scrub one real claude --json-schema structured_output launch as a committed fixture"` (R2, item 0)
- `/gsd-spike "read the child codex rollout and compare the spawn_agent message digest to the host-issued task"` (R12, C5)
- `/gsd-spike "path-scoped workspace-write for a codex researcher child"` (R10, C4)

## 5. Sources

- `research/session-evidence.md`, `research/codex-flowpdf-evidence.md` (evidence; transcript refs unverified here)
- `PROBLEM.md` scope and out-of-scope lists (via the problem statement)
- Code at HEAD `8c264020`: `plugins/delivery-pipeline/scripts/{model-policy-internal.cjs:423, codex-decompose-host.cjs:13-20, claude-delivery-host.cjs:506,752, claude-dispatch-adapter.cjs:19, publish-gate.cjs:44, gsd-tune.cjs:593,606-609, validate-graph.cjs:74-86, gsd-sync.cjs:62, ticket-worktree.sh}`, `scripts/shipyard-doctor.cjs:193-195`, `scripts/install-shipyard-codex.sh:280,431,664`, `tests/unit/source-contract.test.cjs:1986-1989`, `tests/unit/codex-decompose-host.test.cjs:103`
- `.planning/phases/39-remove-conveyor-session-friction/39-{01..12}-PLAN.md` `files_modified`
- Git refs: `origin/epic/39-remove-conveyor-session-friction` (`5b56a747`), `origin/ticket/T-39-*`, `main` (`befc970c`)
