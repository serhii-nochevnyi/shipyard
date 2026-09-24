# INV-005 — research line 4: risks and unknowns

- Line: `risks` (→ RISKS.md + OPEN-QUESTIONS.md drafts)
- Source revision: `133447a7358d49ee5920b3a9c17051394a1e17b2` (`git rev-parse HEAD`)
- Repository: `git@github.com:serhii-nochevnyi/shipyard.git` (`git remote get-url origin`)
- Branch: `inv/005-worktree-and-residual-seams`
- Model selection (resolved by caller): `claude-opus-5-5/medium`
- Policy signals (DATA, preserved verbatim): `{"type":"facts"}`
- Date: 2026-09-24
- Read-only: no product code was changed. This file is the only file written.

## 0. Access limits hit during this research (they affect confidence)

- `gh pr view 207 …` / `gh pr list --state open …` was **denied by the session
  permission layer** (no approval surface). Every claim below about GitHub state is
  therefore derived from local git refs and `.planning/graph/delivery-state.json`,
  not from live GitHub. Labelled where it matters.
- One `ls` over computed paths and one `node -e` over the delivery state were
  also denied. The same facts were re-established with the Grep/Glob tools, as
  cited.

## 1. Command-backed facts this risk analysis rests on

| # | Fact | Command | Output / evidence |
|---|---|---|---|
| F1 | The findings file named in the problem statement **is not on this branch**. It exists only in commit `17a25673`, which is reachable only from `inv/003-conveyor-session-friction` and not from `main` or `origin/main`. | `Glob .planning/backlog/*` (no `phase-39-delivery-findings.md`); `git log --all --oneline -- .planning/backlog/phase-39-delivery-findings.md` → `17a25673`; `git branch -a --contains 17a25673` → `inv/003-conveyor-session-friction`; `git merge-base --is-ancestor 17a25673 main` → exit 1; same for `origin/main` → exit 1 | Content read with `git show 17a25673:.planning/backlog/phase-39-delivery-findings.md` (items 1–12, same as the problem statement except the problem statement adds `.shipyard-arch-review-evidence.md` to item 5 and the new integrator item). |
| F2 | Epic 39 is **not on `main`**. Local `epic/39-…` = `origin/epic/39-…` = `be16f9b6`. `be16f9b6` is contained only by `epic/39`, `origin/epic/39` and this inv branch. `main` = `origin/main` = `4830411b`. There are 43 commits in `main..HEAD`. | `git rev-parse epic/39-remove-conveyor-session-friction origin/epic/39-remove-conveyor-session-friction`; `git branch -a --contains be16f9b6`; `git log --oneline -1 origin/main`; `git log --oneline main..HEAD \| wc -l` → 43 | — |
| F3 | Epic diff size, measured with the role host's exact diff shape (`--no-ext-diff --unified=50 base...head`): **1,935,272 bytes total** and **469,298 bytes outside `.planning`**. `.planning` is therefore ~1,465,974 bytes (~76%). 364 files changed, +17,304/−591. | `git diff --no-ext-diff --unified=50 origin/main...origin/epic/39-remove-conveyor-session-friction \| wc -c`; the same with `-- . ':!.planning'`; `git diff --stat … \| tail -1` | Cap: `DIFF_MAX_BYTES = 1024 * 1024` at `plugins/delivery-pipeline/scripts/claude-role-host.cjs:21`, enforced at `:341-345` (`reject('role diff exceeds the bounded context packet')`). The integrator calls it at `:453`. |
| F4 | The pre-dispatch worktree check refuses **any** untracked file: `git status --porcelain=v1 --untracked-files=all` → `reject('worktree has local changes before role dispatch')`. | `Read claude-role-host.cjs:117-132` | Defect (5) lives here. There is no allowlist at this point. |
| F5 | The post-dispatch mutation check allows only `prepared.evidencePath` plus, **for pr-sentinel only**, `.planning/graph/dispatches.json` and `.planning/graph/delivery-front.json` (`roundOwnedFileDigests`). arch-review and integrator have an empty host-owned map. | `Read claude-role-host.cjs:740-813` (`hostOwnedFiles`, `roundOwnedFileDigests`, `assertEvidenceOnlyChanges`) | Refusal code `WORKTREE_MUTATED`. |
| F6 | arch-review refuses a draft PR twice: at prepare (`live.isDraft === true` → `'live PR identity differs from the ticket worktree'`) and at revalidate (`'live PR changed while architecture review was running'`, `STALE_CONTEXT`). | `Read claude-role-host.cjs:358-366` and `:822-832` | `deliver.md:56-58` says the `finalize` step is "arch-review verdict, conform trailer, undraft" (the guard splits it into `arch-review` + `undraft`), so undraft comes **after** the verdict. Defect (4) is confirmed in source. |
| F7 | Sentinel revalidation discards the round (`STALE_CONTEXT`) on each of these: phase membership changed; **any phase ticket newly `pr-open` in delivery state**; any new open PR on a round ticket's branch; any open PR on a non-round ticket; **the base OID moved**. Per-ticket head/base drift only *expires* that ticket and does not discard the round. | `Read claude-role-host.cjs:834-893` | Defect (6) covers the "new PR" triggers. **The base-moved trigger (`:849-852`) is a second discard cause that the findings file does not name.** Every epic merge during a round also discards it. |
| F8 | `branchOid` already fetches `origin/<base>` and tries `origin/<name>` before the bare local name. A fetch failure is swallowed when `expectedOid` is given. | `Read claude-role-host.cjs:169-188` | T-40-16 fixes the swallow (see 40-16-PLAN.md Scope). The integrator's inclusion check `git merge-base --is-ancestor <mergeCommit> canonical.head` (`:441-442`) runs against the **local worktree HEAD** (the local epic branch), and nothing fetches or fast-forwards that. This is the local-vs-origin seam for the integrator, and T-40-16 does not cover it (T-40-16 is sentinel-only). |
| F9 | Every scratch filename is **untracked and not ignored**: `.shipyard-pr-body.md`, `.shipyard-evidence.md`, `.shipyard-role-artifact.json`, `.shipyard-arch-review-evidence.md`, `.planning/graph/provenance/x.json`, `.shipyard-role-artifacts/x`. | `git check-ignore -v <each>` → no output, exit 1 | — |
| F10 | Scratch handling is already duplicated in four places, each with its own list or rule, and **none lists `.shipyard-role-artifact.json` or `.shipyard-arch-review-evidence.md`**: `delivery-commit-finalizer.cjs:8` (`SCRATCH` set of 2 names), `codex-delivery-host.cjs:20` (`SCRATCH_STATUS` of 2 names), `ticket-worktree.sh:397` (comment on the same 2), `base-merge.cjs:141-161` (deliberately "tracked content only" and **explicitly rejects a filename list**, citing T-27-07). | `Grep '\.shipyard-(pr-body\|evidence\|role-artifact)' plugins/delivery-pipeline`; `Read base-merge.cjs:140-161` | Prior art for defect (5). A fix in one of these files will leave the others drifting. |
| F11 | `.shipyard-role-artifacts/` **is tracked** in this repository: 3 files under `1138a7f8…/` (`.shipyard-role-artifact.json`, `INTEGRATION.md`, `findings.json`), last touched by `22397b76 docs: finalize phase 38 integration evidence`. | `git ls-files .shipyard-role-artifacts \| wc -l` → 3; `git log --oneline -2 -- .shipyard-role-artifacts` | These tracked integrator artifacts **add to the epic diff** and are one of the worktree conditions the audit must specify. |
| F12 | `.planning/graph/*` is tracked in this repository (ci-waits, delivery-front, delivery-log.jsonl, delivery-state{,-meta}.json, delivery-state.yaml, dispatches, drift, escalations, tickets …). | `git ls-files .planning/graph` | ADR-017 line 49 makes `.planning/` **untracked in target projects**. The Shipyard repo and target projects therefore have opposite worktree conditions. |
| F13 | Global signing is on: `commit.gpgsign=true`; `gpg.format` is unset (defaults to openpgp). | `git config --get commit.gpgsign` → `true`; `git config --get gpg.format` → empty | Any host-side commit (T-40-16 preflight graph commit, seal/re-seal, finalizer) depends on a working gpg agent in the launched process. T-40-01 makes only *unit fixtures* hermetic. |
| F14 | `git worktree list` reports 122 worktrees, and `--porcelain` flags 112 of them as `prunable`. | `git worktree list \| wc -l` → 122; `git worktree list --porcelain \| grep -c prunable` → 112 | **Uncertain.** The sandbox denies reads under `/Volumes` outside this worktree, so "prunable" may be a sandbox artefact rather than truly missing gitdirs. Next check: run the same command outside the sandbox. The reaper/gc condition cannot be judged from here. |
| F15 | `gsd-sync --check` makes every PLAN without a `delivery-state.json` entry a blocker (`"<T>: delivery-state.json has no observation"`). | `Read plugins/delivery-pipeline/scripts/gsd-sync.cjs:600-614` | Defect (12) is confirmed in source. |
| F16 | Delivery state on this branch: T-39-01..12 all `merged` **except T-39-03 = `pr-open` (pr 207)**, even though the epic tip `be16f9b6` *is* the T-39-03 merge commit "(#207)". All T-40-* read `pending`. The `40-*-SUMMARY.md` files are gsd-sync projections (`actuals: tokens: 0 … commits: 0`), not delivery evidence. | `Grep '"T-39-\d+": \{' -A3 .planning/graph/delivery-state.json`; `Grep T-40- -A2 …`; `Read 40-16-SUMMARY.md:1-15`; `git log --oneline -1` shows `be16f9b6 T-39-03 … (#207)` on the epic | The observation for T-39-03 is stale on this branch. **GitHub was not checked** (gh denied). |
| F17 | Context-packet soft ceiling: `DEFAULT_TOKEN_CEILING = 12000` tokens, with an overflow record that must preserve required content. | `Grep DEFAULT_TOKEN_CEILING plugins/delivery-pipeline/scripts/context-packet.cjs` → `:19` | A 1 MB diff is roughly 250k+ tokens (assumption: ~4 bytes/token). Raising or scoping `DIFF_MAX_BYTES` leaves the **model context window** as the real limit, and the packet ceiling is already far below it. |
| F18 | No Codex role host exists. The Codex host scripts are `codex-decompose-host.cjs`, `codex-delivery-host.cjs` and `codex-runtime-host.cjs`. | `Glob plugins/delivery-pipeline/scripts/codex-*host*.cjs` | The "checked by the hosts before launch" criterion has no single Codex counterpart to `claude-role-host.cjs`. |

### Phase 40 plans that touch the same files (from `files_modified`/`depends_on`)

Command: a shell loop over `40-*-PLAN.md` printing `depends_on:` and the
`files_modified:` list (run in the phase 40 directory).

| File a residual fix will touch | Phase 40 tickets already modifying it |
|---|---|
| `scripts/claude-role-host.cjs` + `tests/unit/claude-role-host.test.cjs` | **T-40-16** (sentinel preflight, `branchOid`), **T-40-22** (in-flight record + provenance sidecar at role launch) |
| `scripts/sentinel.cjs` | T-40-19, T-40-22 |
| `scripts/role-artifact.cjs` (the `STALE_ARTIFACT` sites at `:594`, `:602`, `:1013`, `:2218-2317`) | T-40-18 |
| `scripts/delivery-commit-finalizer.cjs` (the `SCRATCH` set) | T-40-18, T-40-27 |
| `scripts/state-sync.cjs` | T-40-02, T-40-03, T-40-19, T-40-27 |
| `commands/deliver.md` (the undraft order) | T-40-24 |
| `scripts/dispatch-record.cjs` | T-40-14, T-40-22 |
| `scripts/ticket-worktree.sh`, `scope-gate.cjs` | T-40-27 |
| `scripts/codex-delivery-host.cjs` (`SCRATCH_STATUS`) | T-40-09 (tests), T-40-12, T-40-14 |
| `scripts/gsd-sync.cjs` | **none** (defect 12 has no phase 40 overlap) |
| `scripts/gate-trailer.cjs` (carry, defect 7) | T-40-19 |
| `scripts/base-merge.cjs` | none |

## 2. Risks (draft for RISKS.md)

### R1 — The phase 39 → phase 40 ordering deadlocks (release circularity)
severity: high
evidence: F2, F3. ADR-017 "Consequences" (`ADR-017-delivery-seams-and-pr-hygiene.md:65`): "Most tickets overlap phase 39 files and wait for the phase 39 epic on `main`; the live acceptance happens after phase 39 is released." Epic 39 is not on `main` (F2). Epic 39's integrator refuses at `claude-role-host.cjs:343` (F3). The problem statement puts the integrator fix into phase 40.
risk: the phase 40 tickets wait on epic 39 reaching `main`, and epic 39 reaches `main` only after an integrator fix that is itself a phase 40 ticket. The new tickets also have to cut from somewhere: `main` is missing epic 39, and epic 39 is missing phase 40.
mitigation: decide explicitly (OQ-1) whether the integrator-diff fix ships as a phase 39 tail ticket or hotfix on epic 39, whether the integrator is run once by a manual or out-of-band procedure for epic 39, or whether epic 39 merges to `main` under a recorded waiver. Record the choice in DECISIONS.md before decomposition.

### R2 — Excluding `.planning` from the integrator diff can hide reviewable changes and still not scale
severity: high
evidence: F3 (469 KB of code diff for 12 tickets), F11, F12, F17.
risk:
(a) Phase 40 has 27 planned tickets plus the new ones. Naive scaling from phase 39 (≈39 KB/ticket at `--unified=50`, an assumption) puts the phase 40 code-only diff near or above 1 MB. A pathspec exclusion may be a one-phase fix.
(b) `.planning/graph/tickets.json`, the plans and the ADRs are contract inputs. Dropping them from the diff removes review coverage of graph edits, and those edits drive delivery.
(c) Tracked `.shipyard-role-artifacts/` (F11) can also grow the diff.
(d) Even under 1 MB, the diff far exceeds the 12k-token packet ceiling (F17) and possibly the model context window. The real failure may move from the host refusal to a truncated or degraded judgement.
mitigation: prefer a bounded design (a per-ticket diff digest-referenced by the already-reviewed PR heads, plus a small cross-ticket seam diff) over only raising or scoping the cap. Keep `.planning` visible as a name-status or stat summary with digests. A focused test must show the host refusing, with a named remedy, when the scoped diff still exceeds the cap. Measure the phase 40 epic diff before choosing (OQ-2). A `/gsd-spike "integrator diff budget: per-ticket digests + seam diff vs pathspec exclusion, measured on epic 39"` is recommended.

### R3 — Relaxing the pre-dispatch "no local changes" check weakens a security boundary
severity: high
evidence: F4, F5, F9, F10. `base-merge.cjs:154-156` rejects filename allowlists as the shape that silently re-opens when a new scratch file is added.
risk: the role host's untracked-files check stops a pre-seeded or stale `.shipyard-arch-review-evidence.md` / `.shipyard-sentinel-evidence.md` / `.shipyard-role-artifact.json` from being mistaken for fresh role output. Switching to "tracked-only" like base-merge would let a stale evidence file sit at the exact evidence path the role later writes (`prepared.evidencePath`, `:802`), so the post-check would accept it. An allowlist, on the other hand, drifts: four divergent lists already exist (F10), and none has the two newer names.
mitigation: one shared scratch registry module consumed by the finalizer, base-merge, ticket-worktree.sh, codex-delivery-host and claude-role-host. The role host treats *its own* evidence path as "must be absent before launch" (or moves it aside with a digest) and executor scratch as "ignored but never read as evidence". Alternatively, put scratch under a git-ignored per-dispatch directory, which needs a `.gitignore` or `info/exclude` decision in target projects (OQ-4). The tests must include "stale evidence file present before launch is refused".

### R4 — T-40-22's provenance sidecar collides with the role host's own mutation check
severity: high
evidence: F5, F12. `40-22-PLAN.md` Scope: "`recordInflight` also writes `<graphDir>/provenance/<dispatch_id>.json`", and the role host calls `recordInflight` at role launch. `graphDirectory` defaults to `<projectRoot>/.planning/graph` (`claude-role-host.cjs:134-139`), i.e. inside the worktree for tracked-graph repos. `.planning/graph/provenance/x.json` is not ignored (F9).
risk: after T-40-22 lands, every arch-review and integrator launch creates an untracked `.planning/graph/provenance/<id>.json`, which fails the post-check (`WORKTREE_MUTATED`, only sentinel has host-owned files). The **next** dispatch in that worktree then fails the pre-check (F4). This is a new instance of defect (5), introduced by a planned ticket.
mitigation: the new scratch/host-owned-files ticket must `depends_on: T-40-22` (or T-40-22 must be amended) so that the host-owned set covers provenance for all three roles. Add an explicit fixture test: role launch writes a sidecar, and the post-check plus the next pre-check both pass.

### R5 — Merge conflicts and wrong ordering with phase 40 tickets on `claude-role-host.cjs`
severity: medium
evidence: shared-file table above. T-40-16 and T-40-22 both edit `claude-role-host.cjs` and its test. Defects (4), (5), (6), (8-adjacent), the integrator diff and the worktree-condition checks would all add edits to the same file.
risk: up to ~6 tickets editing one ~1000-line host file serialise. Per defect (7), each merge also re-owes arch-review for every open sibling, so this is the worst case of the pain being fixed. Missing `depends_on` edges produce conflicting parallel branches; T-40-22 is already `risk: high, human_checkpoint: true` (`40-22-PLAN.md:18-19`).
mitigation: chain the new role-host tickets after T-40-16 → T-40-22 with explicit `depends_on`. Consider one "role-host worktree conditions" ticket that owns the pre/post checks, rather than one ticket per defect in that file. Land the (7) carry fix early so the later tickets benefit from it.

### R6 — A semantic carry across sibling merges (defect 7) could approve unreviewed interactions
severity: high
evidence: `.planning/backlog/the-carry-window-closes-on-exactly-the-merge-that-needs-it.md:8-11`: the ADR-006 D2 carry proves "head trees equal and recorded base tree equals new merge-base tree". Defect (7) exists because a sibling base merge always changes the tree.
risk: any carry that survives a content-bringing base merge must replace an object-identity proof with a semantic one (e.g. "the sibling's changed paths are disjoint from this ticket's files and from files this ticket's code imports"). Path-disjointness does not prove absence of behavioural interaction. That is a change to an ADR-006 decision, which ADR-017 does not cover, so it may need a new ADR (a governance cost) and may be refused as out of scope.
mitigation: open a decision (OQ-6). If the carry is accepted, bound it: disjoint declared *and* touched paths, no shared-contract files (graph, schemas, references), and the integrator as the backstop that re-judges cross-ticket seams (this ties to R2). Test: the carry is refused when the sibling touches any file in the ticket's `files` or in the diff.

### R7 — Fixing the sentinel discard (defect 6) could let a round mutate PRs it never judged
severity: medium
evidence: F7. The discard is deliberate fail-closed behaviour on round identity (`subject = round:<ticketSetDigest>`, `:532`).
risk: tolerating newly opened PRs is safe only if the round's actions stay strictly limited to its authenticated ticket set. Tolerating a **moved base** (the second trigger in F7, not named in the findings) is riskier, because merge decisions made against the old base could be applied after the base moved. Fixing only the "new PR" trigger leaves the round still discarded on every epic merge, which the main loop also does continuously.
mitigation: split the triggers. New PRs outside the set become ignored-and-reported. A base move expires the affected tickets (as head drift already does, `:876-881`) instead of rejecting the whole round. Test each trigger separately.

### R8 — `STALE_ARTIFACT` recovery (defect 8) touches the ADR-014 fail-closed contract
severity: medium
evidence: `role-artifact.cjs:2306-2313` ("historical artifact integration-base tree no longer matches", "artifact integration-base identity is stale"). The problem statement puts the "ADR-014 grid and the fail-closed boundary contract" out of scope. T-40-18 also edits `role-artifact.cjs`.
risk: the obvious fix (accept an artifact whose integration base has advanced) loosens a fail-closed identity check that is explicitly out of scope. The in-scope fix is to change *when* the seal happens (seal after the base is final, or re-seal deterministically without re-dispatch), not *what* the check accepts. It is unclear which of the `STALE_ARTIFACT` sites is the one hit (see OQ-8).
mitigation: identify the exact site from the phase 39 transcript or log before designing. Keep verification byte-identical and move the seal/publication ordering. Depend on T-40-18.

### R9 — Undraft-before-review (defect 4) removes a safety property
severity: medium
evidence: F6. `deliver.md:56-58`: the guard splits finalize into `arch-review` + `undraft` "so a faulted verdict cannot ready the PR".
risk: undrafting before arch-review makes a PR look ready (notifying reviewers and enabling auto-merge rules on some repos, an assumption for target projects) before the verdict exists. Allowing drafts in the role host is the smaller semantic change, but the post-review `revalidateLiveInputs` check must then pin `isDraft` to the value seen at prepare time, not require `false`. T-40-24 edits `deliver.md`, so the prose change must depend on it.
mitigation: prefer "role host accepts a draft and pins draft state across the run" over reordering deliver.md. Test both draft→draft and draft→undrafted-mid-run (the latter must be `STALE_CONTEXT`).

### R10 — `gsd-sync --check` fix (defect 12) could accept plans that were never observed
severity: medium
evidence: F15, F16 (T-39-03 observed `pr-open` while it is in the epic, which shows observations do go stale).
risk: letting `--check` pass without an observation for new tickets removes a guard against a PLAN absent from delivery tracking. The safer fix is to seed `pending` rows deterministically when tickets are created (decompose/state-sync). That touches `state-sync.cjs`, which four phase 40 tickets already edit (T-40-02/03/19/27).
mitigation: seed at creation with an explicit `observed_by: planning` marker, and keep `--check` strict for existing tickets. Depend on the last phase 40 ticket touching `state-sync.cjs`.

### R11 — Worktree conditions diverge between the Shipyard repo and target projects
severity: medium
evidence: F11, F12 (tracked `.planning/graph` and `.shipyard-role-artifacts/` here), ADR-017:49 (`.planning/` untracked in target projects), T-40-16 plan Context ("target projects leave `.planning/` untracked … the clean-worktree test ignores untracked `.planning/`").
risk: a single "conditions" spec checked by the hosts must branch on the repo kind. A check tuned to one kind fails in the other: an untracked `.planning` trips `--untracked-files=all` in a target project, and a tracked graph mutated by the preflight commit (T-40-16) changes HEAD and so the role's `canonical.head` in the Shipyard repo.
mitigation: specify each condition with both repo kinds, with a fixture for each, and derive the repo kind the same way T-40-18 does (committed `shipyard` manifest).

### R12 — GPG signing inside launched hosts and hermetic runs
severity: medium
evidence: F13. Host-side commits: the T-40-16 preflight commits the graph, the finalizer commits, and re-seal/rebase is the defect (8) recovery. T-40-01 hardens only unit fixtures.
risk: a launched role or preflight commit prompts for or fails on the gpg agent (headless, restricted tools, sandboxed), which surfaces as an opaque git failure rather than a named remedy. The success criterion requires "never a silent failure".
mitigation: a pre-launch condition probes signing when the host will commit (`git commit-tree` with a dry sign, or checks `user.signingkey` and the agent) and refuses with the remedy. Test with `GIT_CONFIG_GLOBAL` set to `commit.gpgsign=true` and no key.

### R13 — Restricted tools cannot read plans or the graph outside the worktree (item 9) — partial ADR-017 coverage
severity: medium
evidence: finding 9 (F1 content). ADR-017:45 ("plan path from the ticket worktree"). `claude-runtime-host.cjs:20,236,684` (`--restricted`, `restrictedTools: true`).
risk: ADR-017's entry point covers the plan path for *executor dispatch* only. arch-review, integrator and sentinel read `graphDirectory(options, projectRoot)` from the worktree. If a caller passes `SHIPYARD_GRAPH_DIR` pointing outside the worktree, the host reads it but a restricted child cannot. Nobody has verified whether each role's child needs the graph or plan files at runtime (packet content versus file reads).
mitigation: OQ-9, and a worktree-conditions check that the plan and graph resolve inside the worktree whenever the child is restricted.

### R14 — Reviewer mutation leftovers and reaper/gc are unverified
severity: low (evidence is thin)
evidence: the problem statement ("reverting a reviewer's leftover mutation"). F14 is uncertain. The post-check `WORKTREE_MUTATED` (F5) refuses a mutation, but the refusal leaves the mutation in place, so the next dispatch then fails the pre-check with a generic message (F4), not a named remedy.
risk: operator repair loops. A reaper that removes a worktree holding unpublished scratch or evidence loses the evidence.
mitigation: on `WORKTREE_MUTATED`, name the exact paths and the `git restore`/`git clean` command. Check reaper behaviour (OQ-11).

### R15 — Investigation inputs live on unmerged branches
severity: low
evidence: F1 (the findings file is only on `inv/003`), F2 (phase 40 plans are only in `main..HEAD`).
risk: decomposition tickets cite a file that is not on the branch they are cut from. A future reader cannot find the evidence (see the backlog note `the-backlog-is-thirty-six-files-no-tool-can-find.md`).
mitigation: carry `phase-39-delivery-findings.md` into this investigation branch (or cite it by commit `17a25673`) before Gate 1.

### R16 — Codex parity is undefined for the role checks
severity: low
evidence: F18. The problem statement ("the operator … on Claude Code (primary) and Codex").
risk: the conditions spec says "checked by the hosts", but Codex has no role host, so the Codex counterpart of arch-review, integrator and sentinel is unknown. A Claude-only fix could leave Codex silently unchecked.
mitigation: OQ-12, and name the Codex host per condition in the spec, or mark it N/A with a reason.

## 3. Open questions (draft for OPEN-QUESTIONS.md)

- [ ] OQ-1: How does epic 39 reach `main` when its integrator is blocked by a defect planned for phase 40 (ship the fix on epic 39, run the integrator once manually, or waive)? — owner: repository operator (ADR-017 decision owner)
- [ ] OQ-2: What is the measured `--unified=50` diff size of the phase 40 epic (code-only and `.planning`) at a realistic midpoint, and does a pathspec exclusion keep it under 1 MB? — owner: research/system-state line, or a `/gsd-spike`
- [ ] OQ-3: Should the integrator review `.planning` changes (graph, plans, ADRs) at all, and if so in what bounded form? — owner: repository operator
- [ ] OQ-4: Should conveyor scratch move to a git-ignored per-dispatch directory (which needs `.gitignore`/`info/exclude` in target projects), or stay at the root with one shared registry? — owner: repository operator
- [ ] OQ-5: Will T-40-22's provenance sidecar be written inside the worktree's graph directory for role launches, and will T-40-22 be amended or the new ticket depend on it? — owner: T-40-22 plan author / repository operator
- [ ] OQ-6: Is a carry of `conform` across a content-bringing sibling merge acceptable under ADR-006 D2, and does it need a new ADR (since ADR-017 does not decide it)? — owner: repository operator
- [ ] OQ-7: Should a base move during a sentinel round expire tickets instead of discarding the round, and is any sentinel action unsafe after a base move? — owner: repository operator / sentinel maintainer
- [ ] OQ-8: Which `STALE_ARTIFACT` site (`role-artifact.cjs:594/602/1013/2292/2306/2309/2317` or `claude-dispatch-adapter.cjs:325`) fired in phase 39, and with which field? — owner: operator with the phase 39 session logs
- [ ] OQ-9: Does each role's restricted child read plan or graph files at runtime, or only the host-built packet? — owner: claude-runtime-host / role-host maintainer (check with a fixture)
- [ ] OQ-10: Is `.shipyard-role-artifacts/` meant to be tracked in the Shipyard repo (it is, from phase 38), and should it count toward the integrator diff? — owner: repository operator
- [ ] OQ-11: Which reaper/gc (`ticket-worktree.sh` or other) removes ticket worktrees, when, and does it check for unpublished evidence? Are the 112 "prunable" worktrees real or a sandbox artefact? — owner: operator (run `git worktree list --porcelain` outside the sandbox)
- [ ] OQ-12: Which Codex component is the counterpart of `claude-role-host.cjs` for arch-review, integrator and sentinel, and must it enforce the same conditions? — owner: Codex host maintainer
- [ ] OQ-13: Is T-39-03 / PR #207 merged on GitHub (the local epic tip says yes; delivery-state says `pr-open`)? — owner: operator (`gh pr view 207 --json state,mergedAt`, denied in this session)
- [ ] OQ-14: How can host-side commits (preflight, finalizer, re-seal) sign in headless and restricted launches, or should they be exempt from signing? — owner: repository operator
- [ ] OQ-15: Which host checks each worktree condition (restricted tools vs plan/graph location, untracked scratch, tracked role artifacts, signing, local vs origin refs, reviewer leftovers, reaper) today? This line did not verify the full matrix, only the role host pre/post checks (F4, F5, F8). — owner: system-state research line

## 4. Recommended spikes (not executed; throwaway code is out of this line's mandate)

- `/gsd-spike "integrator diff budget on epic 39: pathspec-excluded diff vs per-ticket digest + seam diff; measure bytes and tokens"` (R2, OQ-2)
- `/gsd-spike "role launch with T-40-22 provenance sidecar in a tracked-graph worktree: does WORKTREE_MUTATED fire?"` (R4, OQ-5)
- `/gsd-spike "restricted Claude child for arch-review: which file reads does it attempt?"` (R13, OQ-9)

## 5. Sources

- `plugins/delivery-pipeline/scripts/claude-role-host.cjs:21,26-27,113-196,330-460,740-900`
- `plugins/delivery-pipeline/scripts/base-merge.cjs:140-161`
- `plugins/delivery-pipeline/scripts/delivery-commit-finalizer.cjs:8`
- `plugins/delivery-pipeline/scripts/codex-delivery-host.cjs:20`
- `plugins/delivery-pipeline/scripts/ticket-worktree.sh:397`
- `plugins/delivery-pipeline/scripts/role-artifact.cjs:594,602,1013,2218-2317`
- `plugins/delivery-pipeline/scripts/claude-dispatch-adapter.cjs:325`
- `plugins/delivery-pipeline/scripts/gsd-sync.cjs:600-614`
- `plugins/delivery-pipeline/scripts/context-packet.cjs:19,442-490`
- `plugins/delivery-pipeline/scripts/claude-runtime-host.cjs:20,236,684`
- `plugins/delivery-pipeline/commands/deliver.md:56-58`
- `.planning/architecture/ADR-017-delivery-seams-and-pr-hygiene.md:41-75`
- `.planning/phases/40-build-delivery-seams-and-clean-target-project-prs/40-{01..27}-PLAN.md` (front matter), `40-16-PLAN.md`, `40-22-PLAN.md`, `40-16-SUMMARY.md`
- `.planning/backlog/the-carry-window-closes-on-exactly-the-merge-that-needs-it.md`
- `git show 17a25673:.planning/backlog/phase-39-delivery-findings.md`
- `.planning/graph/delivery-state.json` (T-39-*, T-40-* rows)
