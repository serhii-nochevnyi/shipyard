# INV-005 — research line: alternatives (→ OPTIONS.md draft)

- **Line:** alternatives
- **Policy signals (DATA, preserved verbatim):** `{"type":"alternatives"}`
- **Model selection resolved by caller:** claude-opus-5-5/medium
- **Source revision:** `133447a7358d49ee5920b3a9c17051394a1e17b2` (branch `inv/005-worktree-and-residual-seams`)
  — `git -C <wt> rev-parse HEAD` → `133447a7358d49ee5920b3a9c17051394a1e17b2`
- **Worktree:** `/Volumes/KINGSTON/.wt-claude-shipyard/inv-005`
- **Rule:** no recommendation. The options belong to the human (DECISIONS.md).

## 0. Inputs and one input anomaly

- `.planning/backlog/phase-39-delivery-findings.md` is **absent from this worktree**
  (Read → "File does not exist"). It exists only on branch
  `inv/003-conveyor-session-friction`:
  `git log --all --oneline -- .planning/backlog/phase-39-delivery-findings.md` → `17a25673 backlog: phase 39 delivery findings`;
  `git branch -a --contains 17a25673` → `+ inv/003-conveyor-session-friction`.
  Read with `git show 17a25673:.planning/backlog/phase-39-delivery-findings.md`.
  PROBLEM.md cites it as if present. Next check: the orchestrator should decide
  whether to bring it into this INV branch (it is the evidence base for defects 4–12).
- ADR-017 read at `.planning/architecture/ADR-017-delivery-seams-and-pr-hygiene.md`.
- Phase 40 plan titles, `depends_on` and shared files were extracted with an awk
  loop over `40-*-PLAN.md` frontmatter (command in §5). Only overlap-relevant rows are cited.
- The phase 39 directory was not re-read line by line; the findings file plus
  ADR-017's context section is the phase 39 evidence used here (assumption:
  sufficient for alternatives; the system-state line owns the full map).

## 1. Command-backed facts the options rest on

| # | Fact | Command / evidence |
|---|---|---|
| F1 | The role host refuses any worktree with **any** porcelain output, untracked files included. | `Grep` on `claude-role-host.cjs`: `:123` `status --porcelain=v1 --untracked-files=all`, `:124` `reject('worktree has local changes before role dispatch')` |
| F2 | Prior art for (5): `base-merge.cjs` already ignores untracked files for its dirty check, citing the same scratch files. | `Grep` on `base-merge.cjs`: `:142-143` comment names `.shipyard-pr-body.md`/`.shipyard-evidence.md`; `:167` `status --porcelain --untracked-files=no` |
| F3 | The repo `.gitignore` has no `shipyard` entry, and three `.shipyard-role-artifacts/` files are tracked. | `grep -n shipyard .gitignore` → no output; `git ls-files .shipyard-role-artifacts \| wc -l` → `3` (`…/1138a7f8…/.shipyard-role-artifact.json`, `INTEGRATION.md`, `findings.json`) |
| F4 | Arch-review refuses a draft PR at prepare time and again at revalidation. The sentinel treats a draft as "changed". | `claude-role-host.cjs:363` `live.isDraft === true` → reject; `:826` same in `revalidateLiveInputs`; `:871` `live.isDraft !== true` part of `unchanged` |
| F5 | `deliver.md` undrafts only after conform. | `deliver.md:2309-2335` (`conform → … → gh pr ready <pr> (remove draft)`) |
| F6 | The sentinel round is refused if any phase ticket reaches `pr-open` or opens a PR outside the snapshot during the round. | `claude-role-host.cjs:845-847` (`new PRs opened outside the authenticated sentinel round`, `STALE_CONTEXT`), `:865-866`, `:885-890` |
| F7 | A carry already exists, but only when head trees are equal **and** the recorded `base_tree` equals the new merge-base tree. A sibling squash into the epic always changes the base tree. | `gate-trailer.cjs:49,64-67,382-390,492-523`; backlog `a-conform-verdict-does-not-survive-a-base-merge-that-changes-nothing.md:60-87`; `the-carry-window-closes-on-exactly-the-merge-that-needs-it.md:8-11` |
| F8 | `STALE_ARTIFACT` on a base move comes from the non-historical branch of manifest validation. A `historical` mode exists that checks only the recorded objects. | `role-artifact.cjs:2241` `historical = input.historical === true \|\| input.allowHistorical === true`; `:2303-2312` non-historical compares recorded vs live base commit/tree → `STALE_ARTIFACT 'artifact integration-base identity is stale'` |
| F9 | `gsd-sync --check` blocks on any PLAN ticket that has no delivery-state observation. The file header says a missing observation is never treated as green. | `gsd-sync.cjs:608` `delivery-state.json has no observation`, `:612`; `:6-8` header comment; `:1215-1217` check exit code |
| F10 | The integrator diff is a single `git diff --unified=50 <merge-base>...<head>` capped at `DIFF_MAX_BYTES = 1 MiB`. Plans reach the integrator separately through `sources.plans` / `phase_contracts`. | `claude-role-host.cjs:21`, `:341-344`, `:451-457` (`combinedDiff`, `phaseContracts` from `sources.plans`) |
| F11 | Epic 39 diff size: total 1,935,272 B. `.planning` accounts for 1,465,974 B. Everything outside `.planning` and `.shipyard-role-artifacts` is 469,298 B. | `git diff --no-ext-diff --unified=50 $(git merge-base origin/main origin/epic/39-…)...origin/epic/39-…` piped to `wc -c`, then the same diff limited to `-- .planning`, then the same diff with `':(exclude).planning' ':(exclude).shipyard-role-artifacts'`. Merge base `befc970c4b9c`. `.planning`: 309 files, +14420/−420 |
| F12 | Only one role host exists (Claude). No Codex role host exists. | `ls scripts \| grep role-host` → `claude-role-host.cjs` only |
| F13 | The delivery host forces `commit.gpgsign=true` through env config. | `claude-delivery-host.cjs:316` `GIT_CONFIG_KEY_0: 'commit.gpgsign', GIT_CONFIG_VALUE_0: 'true'` |
| F14 | The graph dir can be overridden through `SHIPYARD_GRAPH_DIR` in the delivery host and through `options.graphDir` in the role host. | `claude-delivery-host.cjs:152`; `claude-role-host.cjs:135` |
| F15 | `ticket-worktree.sh` has `remove`, `list` and `gc` subcommands. It does not write `info/exclude` and does not handle signing. | `grep -n -E '^\s*(add\|remove\|prune\|gc\|reap\|list\|verify)\)'` → `:284 remove)`, `:303 list)`, `:312 gc)`; `grep info/exclude\|gpgsign` → no output |

### Phase 40 overlap (same files, so a `depends_on` is needed)

From the frontmatter extraction (§5 command):

- `claude-role-host.cjs` is touched by **T-40-16** (sentinel preflight, deps T-40-01, T-39-12) and **T-40-22** (provenance sidecar, deps T-40-21/16/14/19, T-39-03/12). Any fix for 4, 5, 6 or the integrator diff touches the same file.
- `role-artifact.cjs` is touched by **T-40-18** (clean PR bodies; dep T-40-17). Fix 8 touches the same file.
- `gate-trailer.cjs` and `sentinel.cjs` are touched by **T-40-19** (verdict as a commit status instead of a PR-body trailer; `carry` posts status on the new head). Fix 7 touches the same file and must build on its carrier.
- `deliver.md` is touched by **T-40-24** (rewrite around the dispatch entry point). Fixes 4, 5 and 8 may touch its prose.
- `state-sync.cjs` is touched by T-40-02, T-40-03, T-40-19 and T-40-27. The seeding variant of fix 12 may touch it.
- **T-40-15** `deliver-dispatch.cjs` is the ADR-017 single dispatch entry point. It is the natural home of a pre-launch worktree check. ADR-017 fixes the entry point, not its preconditions, so extending it is in scope and redesigning it is out of scope.
- **T-40-17** untracks `.planning/` in target projects only and exempts the Shipyard repository (`40-17-PLAN.md:25,74`). It therefore **does not** shrink the Shipyard epic diff (F11).

## 2. Whole-investigation approaches (OPTIONS.md candidates)

These are genuinely different shapes for the whole INV. §3 gives per-defect
sub-alternatives that any of A–C can use.

### Option A — Seven point fixes plus a written conditions reference

**Sketch.** One ticket per residual defect (4, 5, 6, 7, 8, 12, integrator diff),
each fixed where it lives, plus a `references/worktree-conditions.md` that
lists every condition and its remedy. Each host adds its own inline check next
to the one it already has (for example `claude-role-host.cjs:123`).
**Cost.** Low to medium. About seven small tickets plus one prose ticket, most chained on T-40-16, T-40-18, T-40-19 and T-40-22.
**Risks.** The conditions stay duplicated across `claude-role-host.cjs`, `base-merge.cjs:167`, `claude-delivery-host.cjs` and Codex hosts. F1 vs F2 already shows this drift, and the reference doc drifts from code. It does not satisfy "checked by the hosts before launch, refusing with a named remedy" uniformly, because every host words its own refusal.
**Forecloses.** Little. It can later be refactored into B.

### Option B — One executable worktree-conditions module, checked at the dispatch entry point

**Sketch.** A new `worktree-conditions.cjs` holds a declarative table
`{id, applies_to_roles, check(worktree), remedy_command}` for: scratch files
(exact allowlist), tracked `.shipyard-role-artifacts/`, reviewer leftovers
(tracked modifications), local-vs-origin base ref (reusing T-40-16's
fetch/fast-forward), plan and graph readable under `--restricted` (worktree-local
plan plus `SHIPYARD_GRAPH_DIR`, F14), signing (F13), and the worktree being
registered and not reaped by `gc` (F15). T-40-15 `deliver-dispatch.cjs` and each
host call `check(role, worktree)` before launch. A failure is a refusal that
names the exact remedy command. Defects 4, 6, 7, 8, 12 and the integrator diff
still get point fixes (§3), and this module covers 5, 9, 10 and the audit.
**Cost.** Medium. One new module plus unit tests, and wiring into about four hosts plus `base-merge.cjs`. It must depend on T-40-15, T-40-16 and T-40-22.
**Risks.** It serializes behind T-40-15, which is the longest phase 40 chain (T-40-15 ← T-40-14 ← T-40-12 ← T-40-13 ← T-40-10). An allowlist that is too permissive hides real uncommitted agent output. The module shares a file boundary with ADR-017's entry point, so it must extend that entry point without redesigning it.
**Forecloses.** Ad hoc per-host conditions. New hosts must register their conditions.

### Option C — Rebind review, round and artifact identity from commits to the ticket's own patch

**Sketch.** Treat 6, 7 and 8 as one root cause: identity is bound to base
commits that move for reasons unrelated to the ticket. Bind to the ticket's
own change instead: `git patch-id --stable` of `merge-base...head`, plus its
changed-path set. A conform verdict, a sealed executor artifact and a sentinel
per-ticket snapshot stay valid across a base move when the patch-id is equal
and the paths the base move brought in are disjoint from the ticket's paths.
Otherwise they expire exactly as today. Sentinel rounds judge a closed snapshot
and ignore PRs opened later. This is combined with B or A for the remaining
defects.
**Cost.** High. It changes `gate-trailer.cjs` (on top of T-40-19), `role-artifact.cjs` (on top of T-40-18), `sentinel.cjs` and `claude-role-host.cjs`, plus an ADR amendment or a new ADR, because it weakens a measured design decision (backlog F7 file `:51-58`: "tree-equality alone would have carried a verdict onto a diff nobody had judged").
**Risks.** Semantic interaction between siblings with disjoint paths, such as a changed function signature called from an untouched file, is no longer judged per ticket. It is judged only by the integrator, which is exactly the role that cannot run today (F10, F11). It may be read as touching the ADR-014 fail-closed boundary contract, which is out of scope. That boundary is unverified (§6 U3). `git patch-id` is rendering-sensitive: the same backlog file `:73-76` warns that diff-output comparison depends on flags.
**Forecloses.** Strict commit-bound verdicts. It makes the integrator load-bearing for cross-ticket semantics.

### Option D — Do nothing structural: a runbook plus two knob changes

**Sketch.** Document the ~10 manual interventions as an operator runbook and change only two knobs: exclude `.planning` from the integrator diff (or raise `DIFF_MAX_BYTES`) and ignore untracked files (`--untracked-files=no`, as `base-merge.cjs:167` already does). Keep serial review and merge.
**Cost.** Very low: two small tickets plus prose.
**Risks.** It fails the stated success criteria ("reach a fixpoint without manual repairs", "conditions … checked by the hosts before launch"). Phase 40 delivery repeats the ~10 manual interventions and the 12 serial cycles (PROBLEM.md "Current pain").
**Forecloses.** Nothing, but it defers every cost to each future phase.

### Comparison

| | A — point fixes plus doc | B — conditions module at entry point | C — patch-bound identity | D — runbook plus two knobs |
|---|---|---|---|---|
| Complexity | Low–medium, about 8 tickets | Medium, 1 module plus about 7 point tickets | High, cross-cutting plus an ADR | Very low |
| Meets "checked before launch, named remedy" | Partly (per host, uneven) | Yes, one place | Only combined with A or B | No |
| Removes serial review (7) | Only if the §3/7 carry variant is chosen | Same as A | Yes, by design | No |
| Integrator runs on epic | Yes (§3/new) | Yes | Yes | Yes |
| Phase 40 dependency depth | Shallow (T-40-16/18/19/22) | Deep (T-40-15 chain) | Deep (T-40-18/19 plus ADR) | Minimal |
| Main risk | Condition drift across hosts (F1 vs F2) | Allowlist hides real leftovers, schedule behind T-40-15 | Cross-ticket semantics unjudged, possible ADR-014 conflict | Manual repairs persist |
| Forecloses | Nothing | Ad hoc per-host checks | Strict commit-bound verdicts | Nothing (defers cost) |
| Touches ADR-017-decided items | No | Extends T-40-15 entry point, does not redesign it | No, but amends the ADR-006 D2 carry rule | No |

## 3. Per-defect sub-alternatives (menu, no recommendation)

**(4) Draft PR versus arch-review order** (F4, F5)
- 4a. The host accepts a draft for arch-review: drop `isDraft` at `:363` and `:826`. `deliver.md` is unchanged. Risk: `:871` in the sentinel must keep its own rule.
- 4b. `deliver.md` undrafts before arch-review. Risk: a draft signals "not reviewable" to humans and CI, and T-40-24 rewrites the same prose.
- 4c. The host undrafts as part of the arch-review launch. Risk: an outward-facing mutation from a review host.

**(5) Scratch files block dispatch** (F1, F2, F3)
- 5a. `--untracked-files=no` (prior art F2). Risk: an untracked product file that an agent forgot to add passes silently.
- 5b. Exact allowlist of the four scratch names (`.shipyard-pr-body.md`, `.shipyard-evidence.md`, `.shipyard-role-artifact.json`, `.shipyard-arch-review-evidence.md` from `deliver.md:2284`). Anything else still refuses.
- 5c. Move the scratch files out of the worktree into the host-owned state dir. Risk: every producer and consumer path changes, including `role-artifact.cjs seal --evidence-path` at `deliver.md:2284`.
- 5d. `ticket-worktree.sh` writes `.git/info/exclude` entries at creation (F15: none today). `status` then hides them for every tool.
- Related: the tracked `.shipyard-role-artifacts/` (F3) must be decided with this item: allowed tracked output, or moved out.

**(6) Sentinel round discarded when a PR opens** (F6)
- 6a. Closed-snapshot semantics: new PRs belong to the next round, so `:845-847`, `:865-866` and `:885-890` are removed. The digest of the ticket set stays.
- 6b. A publication lease: the main loop does not publish PRs while a round is in flight (it could reuse T-40-14's in-flight record). Cost: throughput.
- 6c. Seal a partial round for the unchanged tickets and expire only the new ones, extending the `expiredTickets` mechanism at `:853-892`.

**(7) Conform never carries across a sibling merge** (F7; must build on T-40-19)
- 7a. Patch-id plus disjoint-paths carry (the core of Option C, scoped to arch-review only).
- 7b. Keep the strict binding and make arch-review cheaper on re-judgement: pass the previous verdict and the base-move delta so the reviewer judges only the delta. Cost: a model run per move, but smaller.
- 7c. Order review after the siblings land: review and merge in dependency order and batch-review siblings once the epic stabilizes. Throughput stays serial but review runs once.
- 7d. Accept serial (status quo).

**(8) `STALE_ARTIFACT` between seal and publication** (F8; must build on T-40-18)
- 8a. Publish in `historical` mode (`role-artifact.cjs:2241`). The artifact proves what was built on the recorded base, and GitHub computes the PR diff anyway. Risk: validation stops proving freshness against the live epic.
- 8b. The host reseals mechanically without re-dispatch when the executor's patch-id is unchanged after an automatic rebase or base-merge.
- 8c. Pin publication to the recorded base: open the PR, then let the cascade `base-merge` bring it current. The artifact is never re-validated against a moved base.

**(12) `gsd-sync --check` on planning PRs** (F9)
- 12a. A planning-mode check that validates projections but not observations for tickets with no delivery record. Risk: it conflicts with the design stated at `gsd-sync.cjs:6-8`.
- 12b. The planning PR flow runs state-sync to seed a `planned` observation for new tickets and commits it (it touches `state-sync.cjs`, shared with T-40-02/03/19/27).
- 12c. Recognize "absent from delivery state and present in a PLAN on the PR head" as the explicit status `unobserved-new`, distinct from green.

**(new) Integrator diff exceeds `DIFF_MAX_BYTES`** (F10, F11)
- Na. Exclude `.planning/` and `.shipyard-role-artifacts/` from the integrator diff pathspec. The measurement gives 469,298 B (under 1 MiB), and plans still arrive through `phase_contracts` (F10).
- Nb. A per-role budget: raise the integrator cap. Risk: the token budget (`estimatePromptTokens`, `:477`) may bind next (§6 U1).
- Nc. Per-ticket diffs plus a combined `--stat`, with the integrator reading files on demand. It is the largest change and keeps the full coverage.
- Nd. Lower `--unified=50` for the integrator. Its effect was not measured (§6 U2).

**Worktree conditions audit** (the Option B table is the "one place". A and D keep it as prose.)
- Wa. Prose reference only.
- Wb. Executable module at the entry point (Option B).
- Wc. Correct by construction: `ticket-worktree.sh add` writes excludes, a local plan copy, `SHIPYARD_GRAPH_DIR` and signing config, plus a `verify` subcommand that hosts call.
- Wd. A standalone `worktree-doctor` that the operator runs. It is not enforced before launch, so it fails the success criterion.

## 4. Constraints respected by all options

- Out of scope per PROBLEM.md and ADR-017 `:43-57, :68-74`: dispatch entry point design, sentinel preflight, pre-push gate, header-free YAML, PR hygiene, dogfood root, sealer, the ADR-014 grid, fail-closed receipts and Jira export. Option B **extends** T-40-15/T-40-16 and does not redesign them. Option C must be checked against ADR-014 (U3).
- Every new ticket that shares a file with a phase 40 ticket needs `depends_on` on that ticket (the §1 overlap list).

## 5. Commands run (all exit 0 unless noted)

- `git -C /Volumes/KINGSTON/.wt-claude-shipyard/inv-005 rev-parse HEAD`
- `git -C … log --all --oneline -- .planning/backlog/phase-39-delivery-findings.md`, `git -C … branch -a --contains 17a25673`, `git -C … show 17a25673:.planning/backlog/phase-39-delivery-findings.md`
- `Grep` over `claude-role-host.cjs` (`DIFF_MAX_BYTES|isDraft|…`), `Read` of `claude-role-host.cjs:110-199, 325-374, 815-894`
- `Grep` of `STALE_ARTIFACT` under `plugins/`, `Read` of `role-artifact.cjs:2280-2324`, `grep -n historical role-artifact.cjs`
- `Grep` of `conform` in `deliver.md`, `Read` of `deliver.md:2270-2339`
- `Grep` of `carry|base_tree` in `gate-trailer.cjs`
- Frontmatter awk loop over `.planning/phases/40-…/40-*-PLAN.md` (titles, `depends_on`, shared files), plus greps in `40-16/17/18/19-PLAN.md`
- `grep -n shipyard .gitignore` (no output, exit 1 inside the pipeline), `git ls-files .shipyard-role-artifacts | wc -l` → 3
- `grep` of `blockers.push` / `--check` in `gsd-sync.cjs`
- `git diff … | wc -c` measurements (F11)
- `ls scripts | grep role-host…`, `grep` of `SHIPYARD_GRAPH_DIR|gpgsign` in the delivery host, `grep` of subcommands in `ticket-worktree.sh`
- `Read` of the backlog notes `a-conform-verdict-…md`, `the-carry-window-…md:1-40` and `base-merge-refuses-on-the-scratch-files-…md` (head)
- One first attempt was denied by the permission layer (a `cd` plus `ls` with a runtime-computed path). It was re-run with absolute paths. A second attempt failed with exit 127 (shell-variable command expansion) and was re-run.

## 6. Uncertainties and recommended spikes

- **U1 (unknown):** whether the integrator packet at about 469 KB diff (Na) fits the prompt-token estimate at `claude-role-host.cjs:477`. Next check: `/gsd-spike "run claude-role-host prepare for integrator on epic/39 with .planning excluded and print estimatePromptTokens"`.
- **U2 (unknown):** the effect of lowering `--unified` (Nd) on size. It was not measured. Next check: the same `wc -c` with `--unified=3`.
- **U3 (unknown):** whether Option C or sub-option 7a/8a counts as changing the ADR-014 fail-closed boundary contract (out of scope). Owner: repository operator (ADR decision owner).
- **U4 (assumption):** that the three tracked `.shipyard-role-artifacts/` files are intentional history rather than a leftover. Next check: `git log --format='%h %s' -- .shipyard-role-artifacts`.
- **U5 (unknown):** how often semantic sibling interactions occur with disjoint paths. This decides Option C's real risk. Suggested spike: `/gsd-spike "replay phase 39 sibling merges: count tickets whose patch-id survived each epic merge and whose paths were disjoint"`.
- **U6 (input gap):** the findings file is absent from this branch (§0). Owner: orchestrator.
- **U7 (assumption):** a Codex role host does not exist (F12), so "which host checks each condition" on Codex currently resolves to the Codex runtime and decompose hosts only. The system-state line should confirm this.
