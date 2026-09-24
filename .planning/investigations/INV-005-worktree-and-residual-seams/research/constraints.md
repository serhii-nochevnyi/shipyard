# INV-005 research — line 3: constraints

- **Investigation:** INV-005-worktree-and-residual-seams
- **Line:** constraints (→ RESEARCH.md "Constraints" + seeds for CONSTRAINTS)
- **Source revision:** `133447a7358d49ee5920b3a9c17051394a1e17b2` (`git rev-parse HEAD`)
- **Repository:** `git@github.com:serhii-nochevnyi/shipyard.git` (`git remote get-url origin`)
- **Policy signals (DATA, preserved verbatim):** `{"type":"facts"}`
- **Model selection resolved by caller:** claude-opus-5-5/medium
- **Date:** 2026-09-24

Rule zero applies: every codebase claim below names the command or tool call that
checked it. Claims without that are labelled **ASSUMPTION** or **UNKNOWN**, with a
next check.

---

## 0. Baseline facts this line depends on

| # | Fact | Evidence (command → result) |
|---|------|-----------------------------|
| B1 | The findings file `.planning/backlog/phase-39-delivery-findings.md` is **not in this worktree**. It exists only in commit `17a25673`, which only branch `inv/003-conveyor-session-friction` contains. | Read tool on the path → "File does not exist"; `git log --all --oneline -- .planning/backlog/phase-39-delivery-findings.md` → `17a25673 backlog: phase 39 delivery findings`; `git branch -a --contains 17a25673` → `inv/003-conveyor-session-friction` only. Content read via `git show 17a25673:.planning/backlog/phase-39-delivery-findings.md`. |
| B2 | HEAD contains epic 39. Epic 39 is **not** on `origin/main`. | `git merge-base --is-ancestor origin/epic/39-remove-conveyor-session-friction HEAD` → true; the same against `origin/main` → false. `origin/main` = `main` = `4830411b…` (`git rev-parse origin/main main`). |
| B3 | Every phase 40 ticket (T-40-01..27) is `pending`. No `epic/40` branch exists. The `40-*-SUMMARY.md` files are gsd-sync projections, not execution summaries. | `node -e` over `.planning/graph/delivery-state.json` → all 27 `"pending"`; `git branch -a --list '*40*'` → empty; `head -20 40-16-SUMMARY.md` → `# shipyard:gsd-sync generated`, `commits: 0`. |
| B4 | Epic 39 diff at integrator settings (`--unified=50`, three-dot against `origin/main`): **1,935,272 B** total. `.planning` is **1,465,974 B**. Everything else is **469,298 B**. `.shipyard-role-artifacts` adds 0 on top of the non-`.planning` share. | `git diff --no-ext-diff --unified=50 origin/main...origin/epic/39-… \| wc -c` (and with `-- .planning`, `-- . ':(exclude).planning'`, plus `':(exclude).shipyard-role-artifacts'`). |
| B5 | Added lines in the `.planning` share by directory: `phases` 7,690; `investigations` 3,294; `graph` 3,119; `architecture` 147. The top files are `graph/tickets.json` (+1,238), `40-RESEARCH.md` (+1,027) and `graph/delivery-state.json` (+664). So phase 40 planning, merged into epic 39 via inv/004, is part of the phase 39 epic diff. | `git diff --numstat origin/main...origin/epic/39-… -- .planning \| awk …`; `git diff --stat … -- .planning`. |
| B6 | `.planning/` is tracked in the Shipyard repository (573 files). | `git ls-files .planning \| wc -l` → 573. |

---

## 1. Hard technical constraints

### C-T1 — Role-host packet bounds are layered; relaxing only `DIFF_MAX_BYTES` is not enough
- `claude-role-host.cjs:19-24`:
  - `REQUEST_MAX_BYTES=32768`
  - `SOURCE_MAX_BYTES=768 KiB`
  - `DIFF_MAX_BYTES=1 MiB`
  - `PROMPT_MAX_BYTES=1,500,000`
  - `RESULT_MAX_BYTES=128 KiB`
  - `PACKET_MAX_TOKENS=360000`
- `diffText` refuses above `DIFF_MAX_BYTES` (`:341-345`). The complete prompt refuses above `PROMPT_MAX_BYTES` (`:637`). Token estimation is `ceil(prompt_bytes/4)` (`:641-644`).
- The policy grid promotes to the `ceiling`/`critical` rung when `inputTokens > window_threshold_tokens` = **250000** (`model-policy-internal.cjs:40,169,172,200`).
- **Consequence:**
  - The full 1.94 MB diff (B4) would breach the prompt bound (1.5 MB) even with no diff cap.
  - The non-`.planning` share (469 KB ≈ 117k tokens by the host's own estimator) fits every bound and stays below the window threshold.
  - Any fix has to satisfy all three bounds together (diff, prompt, token ceiling), and must not change the ADR-014 promotion inputs by accident.
- **Evidence:** Read `claude-role-host.cjs:14-33`; Grep `PROMPT_MAX_BYTES|PACKET_MAX_TOKENS|SOURCE_MAX_BYTES` → lines 20, 22, 24, 264, 276, 611, 637; Grep `WINDOW_THRESHOLD_TOKENS =` → `model-policy-internal.cjs:40: 250000`.
- **Confidence:** high.

### C-T2 — The integrator's input contract is "epic against default branch", and the packet must carry `combined_diff`
- `references/integrator.md:16-22` defines the input as the combined diff of the epic against the default branch, **plus** `.planning/architecture/` and the ticket plan files as separate inputs.
- `context-packet.cjs:28` requires `phase_contracts` and `combined_diff` for the integrator.
- Plans already arrive as `phase_contracts` (`claude-role-host.cjs:456-457`). ADRs arrive as `adr_refs` (`:467`).
- So excluding `.planning` from `combined_diff` would change the documented contract. `references/integrator.md` would need an update in the same ticket, because it is loaded into the prompt through `loadClaudeReferenceContent('integrator')` (`:455`).
- **Evidence:** Read `references/integrator.md:10-29`; Grep `combined_diff|exact_diff` → `context-packet.cjs:27-28`, `claude-role-host.cjs:378,462`.
- **Confidence:** high for the code; **ASSUMPTION** that the reference text is part of a hashed policy context (next check: read `claude-reference-content.cjs`).

### C-T3 — The role host's pre-dispatch "clean worktree" is the baseline for its post-run mutation check
- Before launch, `canonicalWorktree` refuses on **any** `git status --porcelain=v1 --untracked-files=all` output (`claude-role-host.cjs:123-124`). This is defect 5.
- After the run, `assertEvidenceOnlyChanges` treats every changed or untracked path as `WORKTREE_MUTATED`, except `evidencePath` and host-owned files whose digest matches a pre-run snapshot (`:796-813`). Host-owned files are `dispatches.json` and `delivery-front.json` only (`:783-794`).
- **Constraint:** exempting executor scratch files before launch is unsafe unless the same files are digest-snapshotted before launch and re-verified after. Otherwise a role could alter them undetected. The existing `hostOwnedFiles` map is the in-code precedent for that shape.
- **Evidence:** Read `claude-role-host.cjs:117-132`, `:780-820`.
- **Confidence:** high.

### C-T4 — Three scratch-file policies already exist and disagree; one repo decision forbids name lists
- `base-merge.cjs:141-167` and `ticket-worktree.sh:394-408` use `--untracked-files=no`. Both comments say explicitly that they were "NOT fixed by exempting the two known filenames — the next scratch file added would silently re-open it."
- Other hosts use name allowlists:
  - `delivery-commit-finalizer.cjs:8`: `SCRATCH = {.shipyard-pr-body.md, .shipyard-evidence.md}`
  - `codex-delivery-host.cjs:20`: `SCRATCH_STATUS`, same two names
  - `claude-delivery-host.cjs:606-611`: exempts `REPAIR_EVIDENCE_NAME` and `ARTIFACT_ARCHIVE_DIR/`
- `role-artifact.cjs:29-31` also names `.shipyard-role-artifact.json`.
- The role host has none of these, so it refuses. The problem statement also names `.shipyard-arch-review-evidence.md`, which is the role host's own `ARCH_EVIDENCE` (`claude-role-host.cjs:26`).
- **Constraint:**
  - A fix for (5) and for the worktree-conditions spec must pick one policy and state it once.
  - A new name allowlist contradicts two documented repo decisions.
  - `--untracked-files=no` alone contradicts C-T3, because the role host must see untracked output.
- **Evidence:** Grep `shipyard-pr-body|shipyard-evidence\.md|shipyard-role-artifact\.json|SCRATCH` over `plugins/`; Read `base-merge.cjs:120-169`; `sed -n 390,410p ticket-worktree.sh`.
- **Confidence:** high.

### C-T5 — `.shipyard-role-artifacts/` is tracked at HEAD
- Three files under `.shipyard-role-artifacts/1138a7f8…/` are tracked: `.shipyard-role-artifact.json`, `INTEGRATION.md`, `findings.json`.
- `.gitignore` has no entry for `.shipyard-*` or `.shipyard-role-artifacts/`.
- These paths reach the three-dot diff and the scope gate. A worktree-conditions spec must say whether archives are tracked, ignored or host-state.
- **Evidence:** `git ls-files .shipyard-role-artifacts` → 3 paths; `cat .gitignore`.
- **Confidence:** high.

### C-T6 — Drafts are refused by the role host but are the state the guard routes to arch-review
- `claude-role-host.cjs:363` (prepare) and `:826` (revalidate) refuse `live.isDraft === true` for arch-review.
- `sentinel.cjs:672-683` emits `action = 'arch-review'` **only** for `s.draft && !gateConform(...)`.
- `sentinel.cjs:691-693` then emits `undraft`.
- `deliver.md:56-58` states that the split exists "so a faulted verdict cannot ready the PR". `deliver.md:2335` readies the PR after the conform trailer.
- `sentinel.cjs:922` blocks merge while the PR is a draft.
- **Constraint:** the draft-until-conform order is a deliberate safety property: a draft means "not certified". The fix for (4) should be in the role host (accept a draft for arch-review; keep the refusal for sentinel/merge). It should not move undraft earlier. Pinned by prose and by `sentinel.cjs`.
- **Evidence:** Grep `isDraft|undraft` in `sentinel.cjs` → lines 692, 794, 812, 915, 922; Read `sentinel.cjs:670-699`; Read `deliver.md:50-64`, `:2310-2344`; Read `claude-role-host.cjs:358-389`, `:822-833`.
- **Confidence:** high. **Note:** `tests/unit/claude-role-host.test.cjs` (500 lines) has **no** draft assertion (Grep `isDraft: true|draft` → no matches), so no existing test pins the refusal.

### C-T7 — The sentinel round is authenticated as a snapshot; new PRs are refused
- `revalidateLiveInputs` for pr-sentinel (`claude-role-host.cjs:834-893`) refuses `STALE_CONTEXT` in three cases:
  - any ticket in `pr-open` state that is not in the round's `ticketSet` (`:841-848`)
  - any newly opened PR on a guarded branch (`:862-867`)
  - any open PR on a non-guarded phase ticket (`:885-891`)
- Per-PR drift is already tolerated as `expiredTickets` (`:853-882`).
- The result identity is checked against the authenticated round snapshot (`:700`).
- **Constraint:** the fix for (6) must keep the guarantee that the sentinel never acts on or reports an unauthenticated PR. The existing `expiredTickets` path shows the accepted shape: narrow the round rather than fail it.
- **Evidence:** Read `claude-role-host.cjs:822-900`; Grep `sentinel` → `:695,700,704`.
- **Confidence:** high.

### C-T8 — Conform carry exists and is proof-based; it must not become "a base-merge never invalidates"
- `gate-trailer.cjs` implements `carry` (`:10,49-82,382-530`):
  - It requires a recorded full `base_tree=`.
  - It refuses without that proof (`:492-499`).
  - Its only caller is `base-merge.cjs` (`:79-81`).
- The design record `.planning/backlog/a-conform-verdict-does-not-survive-a-base-merge-that-changes-nothing.md` fixes the rule:
  - equal head trees **and** equal merge-base trees;
  - "Only `arch-review=conform` may carry. `checks=green` must not.";
  - "The script computes the proof; the caller does not supply it.";
  - a conflict resolution is authored content that must be re-judged.
- `deliver.md:2312-2321` requires `--base-tree` from arch-review output.
- Defect 7 says the base merge "always brings content". So the carry precondition (equal head trees) never holds for siblings with real epic content.
- **Constraint:** the fix for (7) must be a new, equally mechanical proof. For example, the sibling's own diff against its new base is identical to the judged diff. It must not weaken the tree-equality proof.
- **Evidence:** Grep `carry|covers|base_tree|…` in `gate-trailer.cjs`; `sed -n 60,140p` of the backlog file; `git log --oneline -3 --` on it (`154995d0`, `7096b488`, `8be41caf`); Read `deliver.md:2310-2335`.
- **Confidence:** high for the code; **UNKNOWN** whether a diff-identity proof is sound in the presence of rename detection. The backlog file itself warns that diff *output* depends on flags. Spike recommended (§7).

### C-T9 — Executor artifacts bind to the live integration base
- `role-artifact.cjs:568-597` (`expectedManifest`, executor path) requires `base_commit` and `base_tree` to equal the live identity, else `STALE_ARTIFACT`. This is defect 8.
- A `historical` mode exists only on the repair/drift path (`:2241,2289-2313`). It verifies the recorded base tree instead of the live base.
- **Constraint:** the ADR-014 fail-closed boundary contract is out of scope (PROBLEM.md). A fix may add a verified path, for example "historical" for executors plus a mechanical rebase proof. It must not drop the base binding.
- **Evidence:** Grep `STALE_ARTIFACT` in `scripts/` → `role-artifact.cjs:594,602,1013,2292,2306,2309,2317`, `claude-dispatch-adapter.cjs:325`; Read `role-artifact.cjs:568-597`, `:2270-2313`; `grep -n historical` → `:2003,2241,2445,2516,2548,2613`.
- **Confidence:** high.

### C-T10 — Digest-pinned runtime files
- `claude-dispatch-adapter.cjs` and `runtime-adapters.cjs` are digest-pinned in `tests/unit/source-contract.test.cjs:1986-1995`.
- Any change to either needs a pin update. After T-40-06 lands, that update also needs a `Runtime-Digest-Refresh:` trailer that CI verifies (`40-06-PLAN.md:24,38`).
- `claude-role-host.cjs` is **not** pinned. It is listed in `run-rollout.cjs:32-41` `RUNTIME_FILES.claude`, which checks existence (`:378`), not a digest.
- **Evidence:** Grep `RUNTIME_OWNED_FILE_DIGESTS` in `source-contract.test.cjs`; Read `run-rollout.cjs:1-80`; Grep `RUNTIME_FILES` → `run-rollout.cjs:32,378,618`, `run-rollout.test.cjs:67,170`.
- **Confidence:** high.

### C-T11 — `gsd-sync --check` is local-only and fails closed on missing observations
- `gsd-sync.cjs:6-8`: "never makes a network request and never treats a missing observation as a green result."
- `:603-614` adds a blocker for every PLAN whose ticket has no `delivery-state.json` entry, or an entry without a string `status`. This is defect 12.
- CI runs this via `make test-fast` → `test-gsd-sync` (`Makefile:47,65-66`; `.github/workflows/test.yml:54-55`).
- **Constraint:** the fix for (12) cannot make a missing observation pass or fetch from GitHub inside `gsd-sync`. It has to make the planning flow write a valid local observation (for example a `pending` row) deterministically.
- **Evidence:** Read `gsd-sync.cjs:1-20`, `:590-623`; Grep `gsd-sync` in Makefile/workflows; Read `test.yml`.
- **Confidence:** high.

### C-T12 — Restricted Claude launches run with `cwd = worktree`
- `claude-runtime-host.cjs:684` passes `--restricted` and `:694` sets `cwd: scope.worktree`.
- Graph resolution is `options.graphDir || SHIPYARD_GRAPH_DIR || <root>/.planning/graph` (`claude-delivery-host.cjs:152`, `codex-delivery-host.cjs:72`, `claude-role-host.cjs:135`).
- Finding 9 (in `17a25673`) states that restricted file tools cannot read a plan outside the worktree.
- **Evidence:** Grep `restricted|SHIPYARD_GRAPH_DIR|…` over the hosts.
- **Confidence:** high for code paths; **ASSUMPTION** on the exact semantics of the Claude CLI `--restricted` flag, which is external and not verified here. Next check: CLI docs or the captured fixture from T-40-07/08.

### C-T13 — Signing is a host precondition, checked only on commit paths
- The Claude and Codex executor/repair paths refuse without a resolvable `user.signingkey` fingerprint:
  - `claude-delivery-host.cjs:184-199,281,299,507,646`
  - `codex-delivery-host.cjs:109-124,214`
  - `delivery-commit-finalizer.cjs:153-154`
- The role host does not check signing. It commits nothing, but the preflight planned in T-40-16 will commit a synced graph.
- T-40-01 makes unit fixtures hermetic against global signing. It does not change hosts.
- **Evidence:** Grep `gpgsign|signerFingerprint|signing` over `scripts/`; Read `40-16-PLAN.md:44-58`; `40-01` frontmatter.
- **Confidence:** high.

### C-T14 — Local vs origin refs
- `branchOid` (`claude-role-host.cjs:169-188`) fetches `origin/<name>` unless `options.execFileSync` is injected (tests). It tries `origin/<b>` before `<b>`.
- The fetch failure is swallowed when `expectedOid` is given (`:176-177`). T-40-16 removes that swallowing and adds the fast-forward.
- Finding 10 (local epic ref drifts after GitHub merges) is therefore owned by T-40-16 / ADR-017 "sentinel preflight" for the sentinel only. **UNKNOWN** whether arch-review/integrator get the same preflight. T-40-16 scope is `prepareSentinel` only (`40-16-PLAN.md:51`).
- **Evidence:** Read `claude-role-host.cjs:169-188`; `git blame -L 169,179` → `57b97a79`; Read `40-16-PLAN.md`.
- **Confidence:** high.

---

## 2. Product constraints

| ID | Constraint | Source | Confidence |
|----|-----------|--------|------------|
| C-P1 | Out of scope, must not be re-decided: ADR-017 decisions (dispatch entry point, sentinel preflight, pre-push gate, header-free YAML, PR hygiene, dogfood install root, sealer); the ADR-014 grid; the fail-closed boundary contract; Jira export. | `PROBLEM.md` "definitely out of scope"; ADR-017 §Decision/§Out of scope (Read `ADR-017-…md:41-75`) | high |
| C-P2 | A draft PR means "not certified". Undraft follows conform, and merge refuses drafts. | `deliver.md:56-58,2335`; `sentinel.cjs:672-693,922` (C-T6) | high |
| C-P3 | Refusals must name a remedy the operator can copy. This is the precedent set for the sentinel preflight ("Every refusal message contains a command the operator can copy and run") and required by PROBLEM.md success criteria. | `40-16-PLAN.md:70`; `PROBLEM.md` | high |
| C-P4 | Target projects keep `.planning/` untracked (ADR-017 D-16 / T-40-17). The Shipyard repo tracks it (B6) and is exempt from PR hygiene. So the integrator-diff overflow (B4) is mainly a **Shipyard-repo** condition. A fix must work for both tracked and untracked `.planning`. | ADR-017 `:49,74`; `40-17-PLAN.md:26,55`; `40-16-PLAN.md:37` | high |
| C-P5 | Claude and Codex stay two native paths. The Claude plugin is canonical; Codex outputs are regenerated after shared changes. Judgement roles run through `claude-role-host.cjs` on Claude and `codex-delivery-host.cjs` on Codex (`source-contract.test.cjs:2064-2065`). The Codex host has **no** packet bounds, draft check or role-specific preparation (Grep `isDraft\|DIFF\|MAX_BYTES\|arch-review\|integrator\|pr-sentinel` in `codex-delivery-host.cjs` → no matches). So parity for (4)/(5)/(new) on Codex is **UNKNOWN**. | `CLAUDE.md:69-70,110-113`; Grep results | medium |
| C-P6 | Deterministic scripts own computable decisions. Every new rule gets a focused unit or fixture test. | `CLAUDE.md:72-75` | high |
| C-P7 | The Shipyard repo is often edited during an active delivery session. Preserve unrelated worktree changes. Reapers use `--untracked-files=no` so that scratch never blocks gc. | `CLAUDE.md:116-117`; `ticket-worktree.sh:394-408` | high |

---

## 3. Delivery constraints

| ID | Constraint | Source | Confidence |
|----|-----------|--------|------------|
| C-D1 | CI on every PR: `publish-gate.cjs --base origin/$GITHUB_BASE_REF --working-tree --json`, then `make test-fast` (includes `test-gsd-sync`, `test-sentinel`, `test-unit`, comment policy). Node `24.15.0`. No network in CI. | `.github/workflows/test.yml:34-55`; `Makefile:47` | high |
| C-D2 | New tickets go into phase 40 with `depends_on` on phase 40 tickets that touch the same files (success criterion). The overlap map is in §4. | `PROBLEM.md`; phase 40 frontmatter (awk over `40-*-PLAN.md`) | high |
| C-D3 | All phase 40 tickets are pending (B3). ADR-017 Consequences: "Most tickets overlap phase 39 files and wait for the phase 39 epic on `main`". Epic 39 is not on `origin/main` (B2), and the integrator cannot run on it (B4). So the phase 39 → main merge gates every phase 40 ticket that touches phase-39 files. The integrator fix is on the critical path of **both** phases. | ADR-017 `:65`; B2, B3, B4 | high |
| C-D4 | A planning PR that adds PLANs fails CI (C-T11) until matching `delivery-state.json` rows exist. This applies to the INV-005 decomposition PR itself. | C-T11 | high |
| C-D5 | Changes to digest-pinned files need a pin refresh plus trailer (C-T10), once T-40-06 lands. | C-T10 | high |
| C-D6 | Commits in this environment carry `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. The Shipyard repo's own PRs are exempt from PR hygiene (ADR-017 `:74`) and keep `T-NN-NN:` titles (recent log: `be16f9b6 T-39-03: …`). | session attribution rule; `git log` in gitStatus | high |
| C-D7 | Changing the role host changes the installed cache only after reinstall. Acceptance starts with `make install-shipyard-claude-hook` / `make doctor`. | ADR-017 `:66` | high |

---

## 4. File overlap with phase 40 (seeds for `depends_on`)

Phase 40 `files_modified` were extracted with `awk` over the frontmatter of
`40-*-PLAN.md` (command in §8).

| Residual item | Likely files touched | Phase 40 tickets touching the same files | Seed |
|---|---|---|---|
| (4) draft for arch-review | `claude-role-host.cjs`, `tests/unit/claude-role-host.test.cjs` | **T-40-16** (w3), **T-40-22** (w7) | depends_on T-40-16, T-40-22 |
| (5) scratch files / worktree conditions | `claude-role-host.cjs`, possibly a new shared module, `delivery-commit-finalizer.cjs`, `codex-delivery-host.cjs`, `role-artifact.cjs` | T-40-16, T-40-22 (role host); **T-40-18**, **T-40-27** (`delivery-commit-finalizer.cjs`); T-40-12, T-40-14 (`codex-delivery-host.cjs`); T-40-18 (`role-artifact.cjs`); T-40-27 (`ticket-worktree.sh`) | depends_on the subset actually touched |
| (6) sentinel round discarded | `claude-role-host.cjs`, maybe `dispatch-record.cjs` | T-40-16, T-40-22; **T-40-14**, T-40-22 (`dispatch-record.cjs`) | depends_on T-40-16, T-40-22 (+T-40-14) |
| (7) conform across sibling merge | `gate-trailer.cjs`, `sentinel.cjs`, `base-merge.cjs`, `tests/unit/trailer.test.cjs`, `tests/smoke/sentinel-smoke.sh` | **T-40-19** (moves the verdict carrier to a commit status; `carry` posts on the new sha, `40-19-PLAN.md:56`); T-40-22 (`sentinel.cjs`) | depends_on T-40-19 (hard: same function) |
| (8) STALE_ARTIFACT on base move | `role-artifact.cjs`, `claude-delivery-host.cjs` | **T-40-18** (`role-artifact.cjs`); T-40-10, T-40-13, T-40-14 (`claude-delivery-host.cjs`) | depends_on T-40-18 (+T-40-14 if the host changes) |
| (12) gsd-sync on planning PRs | `gsd-sync.cjs` and/or `state-sync.cjs`, decompose prose | T-40-02, T-40-03, T-40-19, T-40-27 (`state-sync.cjs`); **T-40-25** (`decompose.md`) | depends_on the touched set |
| (new) integrator diff > 1 MB | `claude-role-host.cjs`, `references/integrator.md` | T-40-16, T-40-22 | depends_on T-40-16, T-40-22, **but see C-D3**: the integrator must run on epic 39 **before** phase 40 lands on main. The seed conflicts with the goal (open question Q1). |
| Worktree-conditions spec + prose | `deliver.md` | **T-40-24** (w8, rewrites deliver.md) | depends_on T-40-24, or amend T-40-24 |

**Observation:** `claude-role-host.cjs` is already a serialisation point in phase 40
(T-40-16 → T-40-22). Adding four residual tickets on it makes a chain of about six
tickets on one file. Given defect (7), that means strictly serial arch-review.
The grouping decision belongs to OPTIONS/decompose; this line records it as a
constraint only.

---

## 5. Worktree conditions: what is checked today, and by whom

| Condition | Claude role host | Claude delivery host (executor/repair) | Codex delivery host | base-merge / worktree gc | Evidence |
|---|---|---|---|---|---|
| Worktree is repo root | refuses (`:120-122`) | refuses (resolved via git) | refuses (`:196-198`) | n/a | Reads above |
| Branch matches graph row | arch `:360`, integrator `:397,403` | yes | `:201-203` | n/a | Read `claude-role-host.cjs:358-405`, `codex-delivery-host.cjs:195-218` |
| No tracked changes | refuses (all status) | repair: exempts evidence + archive (`:606-611`) | exempts 2 scratch names (`:204-206`) | `--untracked-files=no` (`base-merge.cjs:167`, `ticket-worktree.sh:394,519`) | C-T4 |
| Untracked scratch present | **refuses** (defect 5) | exempt (repair names) | exempt (2 names) | ignored | C-T4 |
| Tracked `.shipyard-role-artifacts/` | appears in diff; no rule | archive dir exempt | no rule | no rule | C-T5 |
| Plan/graph readable under `--restricted` | graph via `graphDir` option or `<root>/.planning/graph` (`:134-140`) | `SHIPYARD_GRAPH_DIR` (`:152`) | `SHIPYARD_GRAPH_DIR` (`:72`) | n/a | C-T12; no host checks that the **plan path** lies inside the worktree before launch (**UNKNOWN**: next check is Grep `plan` path containment in `claude-delivery-host.cjs`) |
| Signing key resolvable | not checked | refuses | refuses | n/a | C-T13 |
| Local base == origin base | fetch + compare; fetch failure swallowed when OID known | uses `pr_base` resolution | `resolveBaseRef` (`:207`) | n/a | C-T14 |
| Leftover reviewer mutation after run | `WORKTREE_MUTATED` post-run (`:796-813`) | n/a | n/a | n/a | C-T3. The phase 39 manual revert suggests a leftover survived a run on some path: **UNKNOWN** which. |
| Host state outside worktree | n/a | yes | refuses `INVALID_STATE_DIR` (`:160`) | n/a | Grep result |
| Draft state | arch-review refuses | n/a | not checked | guard routes drafts to arch-review | C-T6 |
| Diff/prompt within bounds | refuses | n/a | not checked | n/a | C-T1 |

**Constraint derived:** no single place defines these conditions. Each host checks a
different subset, with different names and remedies. The spec required by PROBLEM.md
has to be enforced by a shared deterministic predicate. Per C-P6, each condition needs
a named refusal plus a copyable remedy (C-P3) and a unit test.

---

## 6. Seeds for CONSTRAINTS (candidate hard lines for the decision)

1. **No weakening of identity binding.** Fixes for (4), (6), (7) and (8) may add
   mechanically proven carry or narrow paths. They may not drop the head, base or
   round binding (C-T6..C-T9, C-P1).
2. **One scratch policy.** The worktree-conditions spec defines scratch once. Every
   host consumes it. The post-run check snapshots scratch digests (C-T3, C-T4).
3. **Draft stays the "uncertified" signal.** Fix (4) in the role host, not in the
   undraft order (C-T6, C-P2).
4. **Bounds are layered.** An integrator fix must satisfy diff, prompt and token
   ceilings and must not move the ADR-014 window promotion by accident (C-T1). It
   must update `references/integrator.md` if the diff scope changes (C-T2), and it
   must work with `.planning` tracked (Shipyard) and untracked (targets) (C-P4).
5. **`gsd-sync` stays offline and fail-closed.** Fix (12) upstream by writing
   observations (C-T11).
6. **Every refusal names a copyable remedy, with one test per rule** (C-P3, C-P6).
7. **`depends_on` follows the §4 file overlap.** The integrator fix has to be
   deliverable **before** phase 40 lands on main (C-D3): see Q1.

---

## 7. Spikes recommended (not run; read-only line)

- `/gsd-spike "integrator combined_diff excluding .planning (keeping phase_contracts + adr_refs) on epic 39: measure prompt bytes and estimated tokens against PROMPT_MAX_BYTES, PACKET_MAX_TOKENS, window threshold"`
- `/gsd-spike "sibling conform carry: prove merge-base-tree-relative diff identity of a sibling across an epic merge using tree objects, not diff text, on phase 39 siblings"`
- `/gsd-spike "executor artifact re-verification after base move: historical mode + clean rebase proof (head tree of rebased == replay) on T-39 executor artifacts"`

---

## 8. Commands run (verbatim) and blocked actions

Commands run successfully (paths relative to `/Volumes/KINGSTON/.wt-claude-shipyard/inv-005`):

- `git rev-parse HEAD && git remote get-url origin`
- `git log --all --oneline -- .planning/backlog/phase-39-delivery-findings.md`; `git branch -a --list '*39*'`
- `git branch -a --contains 17a25673; git show 17a25673:.planning/backlog/phase-39-delivery-findings.md`
- `grep -n "DIFF_MAX_BYTES\|isDraft\|…" plugins/delivery-pipeline/scripts/claude-role-host.cjs`
- `git blame -L 169,179 …/claude-role-host.cjs`; `git blame -L 21,21 …`
- frontmatter `awk` loop over `.planning/phases/40-…/40-*-PLAN.md`
- `git branch -a --list '*40*'`; `node -e` status dump of `.planning/graph/delivery-state.json`; `head -20 40-16-SUMMARY.md`
- `sed -n` over the backlog files `a-conform-verdict-…`, `base-merge-refuses-on-the-scratch-files-…`
- `grep -n "^function \|historical" …/role-artifact.cjs`
- `ls .github/workflows/`; `sed -n 40,64p Makefile`
- `git merge-base --is-ancestor …` (B2); `git rev-parse origin/main main`
- `git diff --no-ext-diff --unified=50 origin/main...origin/epic/39-remove-conveyor-session-friction [pathspecs] | wc -c` (B4)
- `git diff --numstat … -- .planning | awk …` (B5); `git ls-files .planning | wc -l` (B6)
- `cat .gitignore; git ls-files .shipyard-role-artifacts`
- `grep -n "…" plugins/delivery-pipeline/scripts/ticket-worktree.sh`; `sed -n 390,410p …`
- `grep -n "role" …/codex-delivery-host.cjs`; `wc -l CLAUDE.md …`
- Read/Grep tool calls cited inline per constraint.

Blocked (the session could not approve or the sandbox refused):

- `ls` of the investigation directory with computed paths: denied by the permission
  mode ("blockReadsOutsideWorkingDirectories"). Replaced with the Glob tool.
- A compound `cd …; grep …` over `context-packet.cjs`: denied (needs approval).
  Replaced with the Grep tool.
- `gh pr list --repo serhii-nochevnyi/shipyard …` for PRs #204–#217: failed with
  `open /Users/serhii/.config/gh/config.yml: operation not permitted` (sandbox read
  block). **The live state of PRs #204–#217 is unverified by this line.**

---

## 9. Unknowns (each mirrored as an OPEN-QUESTIONS item)

- [ ] Q1: Should the integrator-diff fix land as a hotfix on epic 39 (so phase 39 can reach main), or as a phase 40 ticket? Phase 40 tickets that touch phase-39 files wait for epic 39 on main (ADR-017 `:65`), so a phase 40 ticket cannot unblock phase 39. — owner: repository operator
- [ ] Q2: What is the state of phase 39 PRs #204–#217 and epic 39's PR on GitHub? `gh` was blocked in this sandbox. — owner: operator (run `gh pr list --state all --limit 30`)
- [ ] Q3: Does the Codex path (`codex-delivery-host.cjs`) need parity fixes for (4), (5) and the diff bound? It has no role-specific preparation or bounds (C-P5). — owner: repository operator / Codex host maintainer
- [ ] Q4: Is the text of `references/integrator.md` part of a hashed policy context, so that a scope change re-keys receipts? — owner: next research check (`claude-reference-content.cjs`)
- [ ] Q5: Which dispatch path left the reviewer mutation uncommitted in phase 39, given that the role host's `WORKTREE_MUTATED` check exists? — owner: operator (session transcript / dispatch records)
- [ ] Q6: Should `.shipyard-role-artifacts/` be tracked in the Shipyard repo (it is tracked at HEAD)? Which host owns its lifecycle? — owner: repository operator
- [ ] Q7: Should the sentinel preflight (T-40-16: fetch + fast-forward) also run before arch-review and integrator launches (finding 10)? — owner: repository operator
- [ ] Q8: Exact semantics of Claude CLI `--restricted` for file-tool reach outside `cwd` (finding 9). — owner: T-40-07/08 captured fixtures or CLI docs
- [ ] Q9: Should the findings file (only on `inv/003-conveyor-session-friction`, commit `17a25673`) be brought onto this branch/main as the canonical evidence source? — owner: repository operator
