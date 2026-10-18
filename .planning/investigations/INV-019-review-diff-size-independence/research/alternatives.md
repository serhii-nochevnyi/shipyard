# INV-019 — research line `alternatives` (alternatives & prior art → OPTIONS.md draft)

- Investigation: `INV-019-review-diff-size-independence`
- Line: `alternatives` (research worker, `claude-sonnet-5-5` / `xhigh`, policy signals `{}` — preserved verbatim from the dispatch)
- Source revision: `1c34583b1aedbffe75d9deeff49de9069237e5aa` (`git -C <worktree> rev-parse HEAD`, E01)
- Policy hash: `3978b08721ef8f2381aa1f31355c9fef1dafd4058a2093b4a5f06ee90cd44570` (ADR-014 `adr-014.v7`, from the context packet)
- Date: 2026-10-18
- Mode: read-only. No product code, configuration, planning scaffolding, commit or PR was touched. This file is the only thing written. No throwaway code was run; everything that would need one is listed in §8 as a recommended `/gsd-spike`.
- **No recommendation is made.** The choice among options belongs to the user (RESEARCH-CONTRACT.md, "Do not choose for the user").

Evidence IDs (`E01`…) point to the ledger in §9, which names the exact command, tool call or file range behind each claim. Where a claim cannot be checked by a command it is labelled **Assumption** or **Unknown** and gets a next check. Line numbers are those of the source revision above.

---

## 0. Blocked action (disclosed, not worked around)

One compound Bash command (`cd … && wc -l …; ls …`) was denied by the permission layer ("contains multiple operations … no approval surface"). It was not retried; the same facts were collected with single-operation Bash commands and the Read/Grep/Glob tools (E30). No other command was denied. No sandbox network violation occurred.

---

## 1. Findings the options depend on

### 1.1 Where the diff and its surrounding material enter the model today (four paths)

| Path | Diff recipe and bound | Reaches the model as | Claim evidence |
|---|---|---|---|
| **Claude integrator** (v1 and v2) | `git diff --no-ext-diff --unified=50 <merge-base>...<head> -- . :(exclude).planning …` (`productPathspec()`), `maxBuffer = DIFF_MAX_BYTES + 1`, hard refusal above `DIFF_MAX_BYTES = 2 MiB` — `claude-role-host.cjs:34`, `:459-469`, `:625` | Inline: `role_context.combined_diff.content` (`:634-635`) → `buildPacket` (token ceiling `min(750000, 60000 + ceil(diffBytes/3))`, `:824-829`) → `makePrompt` serializes the whole packet as one JSON string between `<AUTHENTICATED_CONTEXT_PACKET>` markers (`:864-906`); non-focused prompts above `PROMPT_MAX_BYTES = 3,000,000` are refused (`:35`, `:897-904`); the prompt is written to the child's stdin (`claude-runtime-host.cjs:822`). v2 additionally runs `prepareIntegrationLineage` (`claude-role-host.cjs:658-667` → `codex-delivery-host.cjs:773-836`) and re-renders the prompt with the lineage packet (`:665`). | E03, E04 |
| **Claude arch-review** (ticket and phase) | `git diff --no-ext-diff --no-textconv --unified=50 <merge-base>...<head>` with **no pathspec**, `maxBuffer = FILE_LIMITS.material` (16 MiB) — `claude-role-host.cjs:509-510`; changed paths, `--name-status`, `--numstat` also unscoped (`:515`, `:538-539`) | Inline in the packet: `role_context.exact_diff.content` (`:542`). `ARCH_REVIEW_PACKET_TOKENS = 60000` (`:37`) is advisory: overflow is rejected only for roles other than `arch-review` (`:856-859`). If the prompt exceeds 1 MiB the host switches to the **focused file relay** (`:1446-1461`): the packet is partitioned into 128 KiB host files (`codex-arch-review-context.cjs:461-485`) and the prompt carries only a manifest pointer; relay + instructions must stay ≤ 1 MiB (`claude-role-host.cjs:1458-1459`). | E03, E06 |
| **Codex arch-review** (ticket and phase) | Same `--unified=50` diff; `productPathspec()` is applied **only** to the legacy (non-focused) contract (`codex-arch-review-context.cjs:1091-1093`); bound `FILE_LIMITS.material` (16 MiB, `:110`) → `CONTEXT_OVER_BOUND` on overflow (`:119-130`) | Inline up to `INPUT_MAX_BYTES = 1 MiB` (`:109`); above that `prepareFileInput` (`:1594-1606`): immutable host-owned files outside the writer tree, read by the model through `exec_command` in a read-only sandbox. | E06 |
| **Codex integrator** | v1: material is the caller prompt; inline ≤ 1 MiB (`codex-delivery-host.cjs:1038`), else `prepareFileInput` with the automatic reader profile (`:1053-1087`, chunk 8192 B, 12 ranges/batch, `:974-980`). v2: `prepareIntegratorContext` (Claude role host) + `prepareIntegrationLineage`, then file input (`:1001-1023`, `:824-835`). | Host files read by the model through `exec_command … --read-batch` frames (base64, `codex-arch-review-context.cjs:293-322`, `:424-436`). | E06, E07 |

Other bounds in play: `INPUT_MAX_BYTES` 1 MiB, `FILE_LIMITS = {material 16 MiB, manifest 512 KiB, relay 64 KiB, chunk 256 KiB, assets 2000, decisions 1000, reads 2064}` (`codex-arch-review-context.cjs:109-112`), `RESULT_MAX_BYTES` 128 KiB (`claude-role-host.cjs:36`), `EVIDENCE_MAX_BYTES` 96 KiB (`codex-arch-review-context.cjs:18`).

### 1.2 What the reviewer can do with tools (sandbox and tools)

- **Claude, integrator and arch-review.** The role host calls `runtime.agent(prompt, {model, effort, schema})` without `readOnly` (`claude-role-host.cjs:1182-1187`; `readOnly` is passed only for the read-only smoke). The launcher therefore uses `ALLOWED_TOOLS = 'Bash,Read,Edit,Write,Glob,Grep'` (`claude-runtime-host.cjs:34`, `:781-782`) with `--restricted`, `--permission-mode dontAsk`, a sandbox that is `enabled`, `failIfUnavailable`, `allowUnsandboxedCommands:false`, `allowWrite:[worktree]` and `permissions.blockReadsOutsideWorkingDirectories:true` (`:750-790`); the unit test pins exactly these (`tests/unit/claude-runtime-host.test.cjs:245-263`). `READ_ONLY_TOOLS = 'Read,Write,Glob,Grep'` (`claude-runtime-host.cjs:35`) is smoke-only and **has no Bash**, so it cannot run `git diff`. There is no `--max-turns` argument (`:783-792`). The child's cwd is the reviewed worktree (`:796`), whose HEAD is the reviewed commit.
- **Codex, integrator and arch-review.** Reviews run under an explicit `read-only` sandbox (`codex-runtime-host.cjs:2660-2664`; `sandbox_mode: 'read-only'` at `:1116`, `:1129`, `:1632`), with the only write grant being the role evidence file for arch-review/drift-check (`:2534-2551`, `:2553-2568`). The model's only tool is `exec_command` through the code-exec wrapper, with `max_output_tokens ≤ 10000` per call and an output envelope ≤ 252 KiB (`:1300-1309`, `:1339`, `:1358`).
- **Window facts.** No numeric context-window value for `claude-sonnet-5-5`, `claude-opus-5-5` or `gpt-6.1-sol` exists in the repository's policy or capability files (E22). What exists: `WINDOW_THRESHOLD_TOKENS = 250000` (`model-policy-internal.cjs:40`), which only *selects a rung* (Claude arch-review → Fable/medium `ceiling`; Claude integrator → Opus/high `critical`; Codex both → Sol/xhigh `critical`; `model-policy-internal.cjs:162-166`, `:192-195`); a comment that `fable` is a 1M-token tier (`pipeline-config.cjs:111-117`, `:2009-2013`); and a stale statement that the largest input in the system is "~52k tokens" (`pipeline-config.cjs:115-117`), contradicted by the phase-50 measurement. The Claude integrator ladder has **no Fable rung** (`role_rungs.claude.integrator` = Sonnet/xhigh → Opus/high in the policy packet), so a larger window is unreachable for that role without an ADR-014 change, which the problem statement puts out of scope. The actual window of each model is **Unknown** (U1).
- **Coupling to model selection.** `inputTokens` is host-observed from the prompt size (`claude-role-host.cjs:410-426`, `:908-911`, `codex-delivery-host.cjs:744`, `:1029`). Any option that shrinks the prompt also changes the routing signal (see §3, risk R4).

### 1.3 What the host verifies after the reviewer returns (today)

| Check | Where | Strength |
|---|---|---|
| Result identity: head, head tree, base, base tree, ticket set and digest, PR number, focused echoes (`context_digest`, `launch_digest`) | `claude-role-host.cjs:1058-1100`; `codex-arch-review-context.cjs:1389-1405` | Strong, mechanical |
| `review_completeness ∈ {complete, incomplete}`; `complete` requires empty `limitations` and `unresolved_sources` | `validateFocusedResult` `codex-arch-review-context.cjs:1389-1405`; a non-`complete` focused verdict is skipped by the current-verdict lookup, `role-artifact.cjs:3878-3879` | **Self-declared.** `arch-review.md:80-89` and `:116-124` say partition hashes "authenticate availability; they do not prove reading" and "neither the declarations nor an empty finding list prove source consumption". |
| Codex native consumption of host files (exact command schedule, order, one wrapper per batch, untruncated output, no compaction) | `codex-runtime-host.cjs:1296-1452`, `:1522-1539` (compaction ⇒ `REVIEW_RESTART_REQUIRED`), `:1808-1830` | Strong *exposure* proof for non-focused contracts; not required for the focused arch-review contract (`arch-review.md:86-88`) |
| Claude consumption of the diff | none — no component parses tool calls from a Claude transcript (E23); the transcript is pinned (path, bytes, sha256) and used for model/effort evidence and first-response usage only (`claude-runtime-host.cjs:477-640`, `claude-role-host.cjs:1352-1416`) | Absent |
| Worktree untouched except the evidence file; HEAD/branch unchanged; packet revalidated | `assertEvidenceOnlyChanges` `claude-role-host.cjs:1211-1249`; `revalidateLiveInputs` `:1251-1350` | Strong |
| Seal and validate the artifact (`sealJudgment`/`validateJudgmentManifest`), receipt `compliance:'verified'`, then `gate-trailer` current-verdict lookup | `claude-role-host.cjs:1418-1430`; `gate-trailer.cjs:203-240`; `role-artifact.cjs:3826-3900` | Strong, mechanical |
| ADR-014 application receipt | `dispatch-boundary.cjs`, `claude-dispatch-adapter.cjs:437-452` | Binds model, effort, session transcript pin. The adapter validates the context packet's identity at launch (`validateLaunchPacket` → `validateContextPacket`, `claude-dispatch-adapter.cjs:437-452`, called at `:639` and `:936`); no packet, prompt or input digest field appears in `dispatch-boundary.cjs` (0 matches) or in the adapter's receipt code (E31). Input binding is therefore the host's echo check (`context_digest`, `launch_digest`), not the receipt. |

"Trusted mechanical integrity supplies no semantic reading credit" is the repository's standing position (`claude-role-host.cjs:890`, `integrator.md:36-37`). Every option below therefore proves **exposure** (the reviewer was given every changed line), never comprehension.

### 1.4 Existing building blocks and prior art in the repository

1. **Host-file transport + reader batches (Codex).** `prepareFileInput`, manifest `shipyard.host-file-input.v1/v2/v3`, per-asset sha256 and identity, batch CLI `--read-batch` (`codex-arch-review-context.cjs:293-368`, `:457-597`, `:829-960`), and the native-session consumption verifier. This moves the diff **out of the launch prompt** but not out of the model's context: every byte still returns through tool output, and the Codex host refuses a session that was compacted (`codex-runtime-host.cjs:1529-1531`). The batch profile is OpenAI-only (`codex-arch-review-context.cjs:272`).
2. **Focused architecture contract `shipyard.focused-architecture-review.v1`** (partitions of 128 KiB, self-declared completeness). Already used by the Claude arch-review above 1 MiB (`claude-role-host.cjs:1446-1461`), proven only with a mocked runtime (`tests/unit/claude-role-host.test.cjs:1406-1432`).
3. **Integration review v2** (inherited trust + impact sources): `selectReviewBaseline`, `buildReviewImpactPacket` (`codex-arch-review-context.cjs:1959-2126`, duplicated in `role-artifact.cjs:2849-2995`). On any non-Codex host the selection is forced to `mode:'full'` with reason `unsupported-original-runtime-authority` (`codex-delivery-host.cjs:806-809`), and `deliver.md:2931-2933` says the second runtime "currently selects full review" — so on Claude v2 pays the impact builder's cost without ever inheriting.
4. **Retained authority outside the worktree with an HMAC** — the phase archive roster (`role-artifact.cjs:2438-2474`, `:2476-2495`). A precedent for a "sealed ledger" that the model cannot forge.
5. **Maintainers' own earlier proposal for exactly this problem.** `WORK-PACKAGES.md` row **R11** (phase 45, from INV-008 finding N30): "Exclude generated trees (`plugins/shipyard/`, registered capture fixtures) from the combined diff. Name the `DIFF_MAX_BYTES` bound in the refusal… When a phase exceeds one packet, integrate per authenticated ticket subset (wave or workstream) and combine the subset verdicts into one phase verdict with receipts." (`.planning/phases/45-close-residual-pipeline-efficiency-gaps/WORK-PACKAGES.md:61`). `PLANNING-STATUS.md:14` records that no tickets, PLAN files or PRs were created for phase 45. `productPathspec()` still has no `plugins/shipyard` entry (`development-artifacts.cjs:5-19`), so R11 part 1 is not implemented. INV-010 left R11 with its owner (`INV-010 DECISIONS.md:29`).
6. **Rejected before:** "batched per-ticket verdicts" for the *ticket* arch-review was rejected in INV-010 "because of the new schema and receipt shape and the 60k-token packet bound" (`INV-010 DECISIONS.md:16`); "reducing the integrator to cross-ticket interfaces only" was rejected (`:28`); risks R-1 and R-15 warn that a looser carry certifies an interaction nobody judged (`INV-010 RISKS.md:5`, `:19`).

### 1.5 Measurements on the phase-50 epic (reproducible, this checkout)

The epic is available locally: `f80dfea7` is the PR #521 head per EVIDENCE.md:5, and the commit exists here (E18); the squash merge `92453193` has one parent `be7ab4f3`, and `git merge-base be7ab4f3 f80dfea7` = `be7ab4f3`. All sizes below are `git diff --no-ext-diff … be7ab4f3...f80dfea7 | wc -c` (E16). The first row reproduces the EVIDENCE.md figure (2,043,596 B; `wc -c` adds the trailing newline that the host trims).

| Diff variant (integrator pathspec = `.planning`, `.shipyard*`, `docs/audits`, `AGENTS.md`, `CLAUDE.md` excluded) | Bytes | vs today |
|---|---|---|
| Today: product pathspec, `--unified=50` | 2,043,597 | — |
| + `plugins/shipyard` excluded, `--unified=50` | 1,400,771 | −31.5 % |
| + `plugins/shipyard` excluded, `--unified=10` | 815,389 | −60.1 % |
| + `plugins/shipyard` excluded, `--unified=3` | 679,800 | −66.7 % |
| + `plugins/shipyard` excluded, `--unified=0` | 604,258 | −70.4 % |
| Claude/Codex **arch-review** diff today (no pathspec: includes `.planning/` and the mirror), `--unified=50` | 3,352,354 | +64 % |

File and line counts (E17, `git diff --numstat`): product without the mirror **80 files, +9,859 / −268**; mirror `plugins/shipyard` **27 files, +1,702 / −214**; `.planning/` **126 files, +11,880 / −196**. 80 + 27 = 107 files, matching EVIDENCE.md. The largest single product file diff is 564 added lines (`tests/unit/legacy-bookkeeping-adoption.test.cjs`); no single file approaches any bound — the problem is the sum, not an item. Phase 50 has 29 tickets (`Grep '^    "T-50-…": \{' tickets.json` → 29; 29 `50-NN-PLAN.md` files, E27).

Derived packet estimates (**arithmetic, not a measured prompt**): the non-diff material in the phase-50 integrator packet is 2,647,625 − 2,043,596 = 604,029 B (EVIDENCE.md:7-8), and the packet ratio is 2,647,625 B / 640,131 est. tokens = 4.136 B/token.

| Variant | Packet bytes | ≈ tokens |
|---|---|---|
| Today | 2,647,625 | 640k (EVIDENCE.md:10) |
| mirror excluded, U50 | 2,004,800 | 485k |
| mirror excluded, U10 | 1,419,418 | 343k |
| mirror excluded, U3 | 1,283,829 | 310k |
| mirror excluded, U0 | 1,208,287 | 292k |

Even at zero context lines the packet stays above the 250k-token routing threshold because 0.60 MB of plans, ADRs and obligations is untouched by diff levers. Whether 290–485k tokens fits the Claude window is **Unknown** (U1): the child refused 640k with `prompt_too_long`, so the window is below that, but no value exists in the repository.

At this checkout's HEAD the mirror is 161 files / 4,808,946 B, of which 124 JS-like files / 4,272,898 B; all JS-like tracked blobs are 449 files / 14,823,120 B (E15). The v2 impact builder reads every JS/TS blob at both endpoints against `FILE_LIMITS.material` (`codex-arch-review-context.cjs:1983-1999`); the repository has 1,523 tracked files (E14), exactly the "1523 files" of EVIDENCE.md:23. So v2's `CONTEXT_OVER_BOUND` scales with **repository size**, not with the epic's diff; a single endpoint is already 88 % of the 16 MiB bound (14,823,120 / 16,777,216). (The 25.7 MB figure is the user's measurement at the phase-50 head; it is not reproduced here.)

### 1.6 The mirror (`plugins/shipyard/`)

- Generated: `CLAUDE.md:79-84`; the builder is `scripts/package-shipyard-codex.cjs` (`make package-shipyard-codex`, `Makefile:5-7`). Ticket PRs into `epic/*` or `ticket/*` skip regeneration and the staleness check; it is enforced for the epic → `main` PR, the one the integrator and phase arch-review judge (`scripts/package-shipyard-codex.cjs:71-74`, `tests/unit/phase49-package-publication.test.cjs:38-49`, test `ordinary-complete-candidate-package-parity`).
- `plugins/shipyard/package-build.json` carries a `version` and a `digest` of the build.
- The runtime-file digest pin (`tests/unit/runtime-file-digests.json`) covers only `claude-dispatch-adapter.cjs` and `runtime-adapters.cjs`; refreshing it needs `make refresh-runtime-digests` and its trailer (`CLAUDE.md:53`, `:136-137`; `scripts/refresh-runtime-digests.cjs`). The review hosts (`claude-role-host.cjs`, `codex-arch-review-context.cjs`, `context-packet.cjs`, `development-artifacts.cjs`) are **not** pinned there (E20).
- **Trap.** `isDevelopmentArtifact` is shared by `scope-gate.cjs:118`, `pr-hygiene.cjs:265,292,354`, `comment-policy.cjs:402`, `reviewers.cjs:200,323,442`, `codex-arch-review-context.cjs:1451,1920,1954,2041-2044,2060,2086` and `role-artifact.cjs:2851,2946-2991` (E11). Adding `plugins/shipyard/` to `PREFIXES` would silently turn mirror changes into "development artifacts" for the ticket scope gate (mirror edits stop counting against `files_modified`), PR hygiene (a mirror-only PR becomes `development-artifacts-only` exempt), the comment policy and bot-thread filtering, and would invert the unit test at `tests/unit/development-artifacts.test.cjs:11-12`. The exclusion must be a separate pathspec/classification, not a `PREFIXES` entry.
- Where the mirror enters a review (every site a "mirror excluded" change must touch): `productPathspec()` (`development-artifacts.cjs:16-19`; used by `claude-role-host.cjs:459,625` and the legacy Codex arch-review `:1093`); the **unscoped** Claude arch-review diff, changed-path list and change metadata (`claude-role-host.cjs:509,515,538-539`); the unscoped focused Codex arch-review diff, changed paths and metadata (`codex-arch-review-context.cjs:1092-1095,1109-1110,1170-1171`) and its `post_change_inventory` (legacy, `:1180`); the v2 endpoint inventory/delta/impact reads (`:1933-1957`, `:1983-1999`, and the duplicate in `role-artifact.cjs`); `focusedChangeInventory` classification (`:1430-1455`). `.planning/` is also part of the arch-review diff by design ("included in the complete PR diff", `:1186`) because changed ADRs under `.planning/architecture/` are governing input (`selectFocusedArchitecture`, `:1457-1539`); excluding all of `.planning/` from arch-review would drop that (decision for the user, U6).

### 1.7 Unrelated defects found at intake — verified by reading

| Defect | What the code does | Evidence |
|---|---|---|
| `receipt` authority key (Claude phase arch-review) | The phase roster records contain the original `receipt` (`role-artifact.cjs:2448-2453`); `selectPhaseArchives` returns them as `selection.records` (`:2628-2629`); the Claude host copies `selectedArchives.selection` into `role_context.phase_archive_selection` (`claude-role-host.cjs:548-549`); `buildContextPacket` and `validateContextPacket` run `rejectAuthorityKeys` over the whole packet, and `AUTHORITY_KEYS` contains `receipt` (`context-packet.cjs:34-39,196-205,455,523`) ⇒ `CONTEXT_PACKET_AUTHORITY … records.0.receipt is host-owned launch authority`. The Codex packet carries the same selection at the top level (`codex-arch-review-context.cjs:1176`); the refusal is reported only for the Claude host (EVIDENCE.md:24), and the Codex path checks its own `SCHEMA` packet in `preflightReviewMaterial` (`:750-761`) rather than through `validateContextPacket`. | E13 |
| Child stderr not surfaced | A non-zero child exit raises `RUNTIME_UNAVAILABLE "Claude process exited N"` with `details.stderr` (`claude-runtime-host.cjs:842`); the CLI prints only `error.message` plus a hint (`claude-role-host.cjs:1659-1661`); `hintForError` reads only `pid, path, key, explicit, bundle_value` from `details` (`refusal-hints.cjs:266,274-291`). | E04, E28 |
| Fixed graph directory | The library honours `options.graphDir` (`claude-role-host.cjs:194-200`) but the CLI has no flag (`parseCli` accepts only `--preflight`, `--capability-only`, `--args-file`, `:1565-1587`) and the entry point builds `hostOptions` without it (`:1654-1657`); the request schema allows no graph field (`:92-95`). Each run records an in-flight entry and bookkeeping in `<worktree>/.planning/graph` (`:1474`, `:1198-1209`), and those files are **tracked** (`git ls-files .planning/graph` lists `dispatches.json`, `delivery-front.json`; `git status --short` in this worktree shows both modified, E19), while `canonicalWorktree` refuses a dirty tree for non-aggregate roles (`:167-174`). | E03, E19 |

---

## 2. The options

Four complete approaches. Each is described the same way. "Hosts" means the five production files that carry the review path: `claude-role-host.cjs` (1,664 lines), `codex-arch-review-context.cjs` (2,251), `codex-delivery-host.cjs` (3,734), `role-artifact.cjs` (6,465), `context-packet.cjs` (764) (E02). Cost labels (S/M/L/XL) are **estimates from the touched surface, not measurements** (Assumption A1).

### Option A — Stop-gap: shrink the inline packet (no change of mechanism)

**Sketch.** Keep both roles inline. Exclude the generated mirror from every review diff; reduce `--unified=50`; optionally trim whole plan files to their acceptance header (as `arch-review.md:29-30` already does for plans); name the bound and the measured size in refusals; fix the three unrelated defects that block phase-level runs. This is R11 part 1 plus operability fixes.

**What changes.** A mirror-aware pathspec used at every site in §1.6 (not via `PREFIXES`); the `--unified` value at `claude-role-host.cjs:462,509`, `codex-arch-review-context.cjs:1093,1185`; a test that pins "no `plugins/shipyard/` path in any review diff" for all four paths; v2 impact builder skips (or lazily reads) mirror and, for `mode:'full'`, need not read all repository source (§1.4 item 3).

**Cost.** S–M. Touches `development-artifacts.cjs` and the diff sites above (≈ 4 host files) plus tests (`tests/unit/development-artifacts.test.cjs`, `claude-role-host.test.cjs:1004-1100`, `codex-arch-review-context.test.cjs`). Mirror regeneration for the epic (`make package-shipyard-codex`); no digest-pin refresh unless `claude-dispatch-adapter.cjs` or `runtime-adapters.cjs` change.

**How the host proves every changed line was covered.** By construction: everything is embedded. The host can add a cheap mechanical check that the embedded diff's file list equals `git diff --name-only <merge-base>...<head> -- <pathspec>` (today only the packet digest is echoed). It proves *delivery*, not *reading* — identical to today (`§1.3`). Dropping context lines (U3) removes surrounding code from the embedded text, but the Claude reviewer can still `Read` files at HEAD and the Codex reviewer can still `cat` them; coverage of **changed** lines is unaffected.

**Receipts, authority, digest binding.** Unchanged. Same packet, same `context_digest`/`launch_digest` echoes, same ADR-014 receipt, same `gate-trailer` path. No new contract version if the reviewer's input remains "the complete authenticated diff". Changing `--unified` or the pathspec changes the packet digest, but digests are computed per launch, so no stored artifact is invalidated.

**Runtimes.** Identical code path on both; Codex keeps its >1 MiB host-file transport.

**Phase-50 effect (derived, §1.5).** Integrator packet ≈ 485k tokens (mirror only) → ≈ 310k (mirror + U3) → ≈ 292k (U0). Arch-review diff 3,352,354 B → ≈ 2.71 MB with only the mirror excluded (3,352,354 − 642,826, where 642,826 = 2,043,597 − 1,400,771 is the mirror's measured U50 share, derived); 1.40 MB at U50 and 0.68 MB at U3 only if all of `.planning/` were excluded as well, which must not be done wholesale (§1.6).

**Failure modes.**
- It moves the cliff; it does not remove it. An epic with ≥ 2× phase 50's product diff exceeds the same window again (EVIDENCE.md:11 lists 1.57–1.79 MB product diffs at U50 without the mirror for phases 36/43/46).
- Fit is unproven: 292–485k tokens vs an unknown window (U1).
- Mirror divergence is hidden from the reviewer. Mitigation exists mechanically: the parity test fails the epic → main PR when the mirror differs from builder output (`phase49-package-publication.test.cjs:46-49`); the host could also include the mirror's path/status/blob-id list (metadata, a few KB) without content.
- Lower context may reduce judgment quality (Unknown, U5).
- The v2 impact builder still fails on repository size unless changed (§1.5).

**Rollback.** Revert the pathspec/constant changes; regenerate the mirror. No stored data depends on them.

**Forecloses.** Nothing structurally; it defers the real fix and leaves the integrator inside the `inputTokens > 250000` routing regime (`critical` rung) on large epics.

**Unrelated defects it needs.** `receipt` key: yes, if phase arch-review on Claude must run at all (independent of size, so every option needs it). stderr: not required (diagnostic only). Graph directory: operability only (repeat runs refuse a dirty tree).

---

### Option B — Pull model: the reviewer reads git objects itself, driven by a host-sealed manifest

**Sketch.** The packet no longer carries the diff text. It carries a **host-built diff manifest**: for every changed path (after the mirror pathspec) the status, old/new blob ids, numstat, byte size, per-file diff sha256 and hunk count, plus the exact recipe (`git diff --unified=N <merge-base>...<head> -- <path>`). The manifest is bound into `context_digest`. Plans/ADRs stay inline (or as today's focused partitions). The reviewer pulls each file's diff, can widen context on demand, and must report coverage; the host verifies it from the **runtime transcript** and caps the verdict at `incomplete` when the ledger has a gap.

**What changes.**
- Claude: a new transcript verifier (no equivalent exists, E23) that pairs `tool_use` and `tool_result` records for the reviewer's `Bash git diff …`/`Read` calls, recomputes the expected output of each recipe from git (deterministic for fixed object ids) and requires every manifest entry to have been returned complete and untruncated. Prompt text in `makePrompt` (`:890`) and the role references change from "read the complete inline dictionary" to "pull every manifest entry".
- Codex: the existing host-file transport already delivers the diff outside the launch prompt, so B on Codex means (a) making it the only diff transport, (b) adding a **completeness proof to the focused arch-review contract**, which today has none (`arch-review.md:86-88`), and (c) a diff-manifest-aware partition schedule so the existing native-consumption observer (`codex-runtime-host.cjs:1296-1452`) can credit per-file reads. The batch profile's `provider === 'openai'` check (`codex-arch-review-context.cjs:272`) stays Codex-only.
- A new contract label for the review (e.g. a v3 / "manifest" contract) so artifacts record which input model applied; all consumers that decode `packet.role_context.exact_diff.content` or `packet.diff.content` must learn the new shape (`codex-arch-review-context.cjs:463,909`, `role-artifact.cjs` current-review readers).

**Cost.** L. A Claude transcript verifier is new code of the order of the Codex consumption verifier (`codex-runtime-host.cjs:1296-1452`, ≈ 160 lines for the Codex ordering logic alone, plus its truncation handling `:1364-1427`) (A1), plus manifest builder, contract plumbing, prompts, tests for both runtimes, and a live spike before any claim of coverage.

**How the host proves every changed line was covered.** Three strengths, in increasing order of cost (they can be combined):
1. *Self-declaration* (today's focused contract): `review_completeness` + `unresolved_sources`. No host check. Weakest; this is the status quo for the focused arch-review.
2. *Transcript exposure ledger* (the strong form): host parses the pinned, host-copied session transcript (Claude: `claude-runtime-host.cjs:601-640` saves it outside the worktree; Codex: native session under `~/.codex/sessions`) and requires, for each manifest entry, a tool call whose recomputed expected output equals the returned output. The transcript is written by the CLI outside the worktree, so the reviewer cannot edit it — the same property the Codex verifier relies on. **Unknown (U3):** whether Claude `--output-format stream-json --verbose` / the session JSONL contains complete `tool_result` bodies and how the Read/Bash tools truncate long outputs in the installed CLI version.
3. *Host-mediated reader* (a host CLI the reviewer must call, as `--read-batch` does for Codex): its served-range ledger would have to live outside the worktree; inside the Claude sandbox only the worktree is writable (`claude-runtime-host.cjs:756`), so a ledger written there is reviewer-writable. It therefore only helps if the host derives the ledger from the transcript anyway.

A verdict claiming `complete` without a closed ledger is rejected as `INVALID_RESULT`; the host may downgrade to `incomplete`, never upgrade.

**Receipts, authority, digest binding.** ADR-014 receipt and sealing unchanged. Input identity is bound by git object ids (immutable) rather than embedded bytes: head/tree/merge-base/base-tree are already in the packet, and the manifest digest joins `context_digest`. Reading from git objects, not working-tree files, avoids a reviewer mutating what it later reads; the post-run `assertEvidenceOnlyChanges` and `revalidateLiveInputs` stay (`claude-role-host.cjs:1211-1350`). Claude's sandbox allows writes inside the worktree, so a reviewer *could* create files; the post-check catches it (`WORKTREE_MUTATED`) but cannot undo what the reviewer saw (Assumption A2: reading only through `git` object commands makes this moot).

**Runtimes.**
- Claude: native (Bash + Read inside the worktree; `git` is expected to work in the sandbox because the reference tells the reviewer to run `git rev-parse` — `arch-review.md:156` — but reading the common git directory of a linked worktree under `blockReadsOutsideWorkingDirectories` is **Unknown**, U4). `READ_ONLY_TOOLS` (no Bash) cannot be used.
- Codex: partly existing (host files). A free-form `git diff` through `exec_command` would not match the observer's exact-command schedule, so the manifest/partition route is the one that keeps host-verified coverage.

**Failure modes.**
- **The window moves, it does not disappear.** Every byte pulled stays in the session's context. Codex refuses a compacted native session (`codex-runtime-host.cjs:1529-1531`), so a Codex reviewer whose reads exceed its window fails with `REVIEW_RESTART_REQUIRED`; for Claude, whether `--print` auto-compacts (silently dropping early reads) is **Unknown** (U2) — if it does, the ledger would still show "returned" for content the model no longer holds. Reading 2 MB of diff as tool output costs about the same tokens as embedding it; the only guaranteed savings are the launch-bound cliff and the ability to read selectively.
- Codex's existing reader encodes ranges as base64 (`codex-arch-review-context.cjs:307-309`), inflating bytes by 4/3 and tokens by more (tokenizer penalty on base64 — Assumption A3); a 2.6 MB packet through it may exceed any window (Unknown, U7).
- Silent skipping: mitigated only by the ledger; without strength 2 the skip is invisible.
- Turn/transcript limits: stream record cap 10,000 (`claude-runtime-host.cjs:276`), transcript cap 50 MiB (`:33`, `:508`), role result cap 128 KiB (`claude-role-host.cjs:36`).
- Runtime-format drift: the verifier depends on the Claude CLI's transcript format; the host already pins `runtime_version` and required help markers (`claude-runtime-host.cjs:19-24`).
- Latency: many sequential tool turns; no `--max-turns` is set today (`:783-792`), so there is also no turn cap to protect against a runaway reader.
- Manifest size: `FILE_LIMITS.manifest` is 512 KiB and `assets` 2000 (`codex-arch-review-context.cjs:110`); an epic with several thousand changed files needs a paged or two-level manifest.

**Rollback.** The request already carries a `review_contract` selector (`claude-role-host.cjs:96-97`, `:120-121`) and "unknown contract versions are refused" (`integrator.md:41`); adding a value is additive and falling back means selecting v1. Artifacts sealed under the new label stay valid history. Skew risk: installed bundles that predate the new label refuse it (consumers must ship together).

**Forecloses.** The simple invariant "the reviewer judged exactly the bytes the host embedded and hashed". The artifact is bound to commit/tree ids and a manifest instead. Also couples the verdict's trust to a transcript parser for Claude.

**Unrelated defects it needs.** `receipt` key: yes (phase arch-review). stderr: strongly advisable — turn exhaustion, permission denials and window errors are new failure modes and today they all surface as "Claude process exited 1". Graph directory: operability, as in A.

---

### Option C — Partitioned (map-reduce) review with a sealed ledger

**Sketch.** The host partitions the changed-path set into **review units**, each small enough to fit a normal inline packet with margin. Each unit is reviewed by an ordinary routed dispatch (resolve → validate → launch → receipt) using today's inline path. A final **aggregator** launch judges the phase: it receives the phase contracts, ADRs, the complete change inventory, a bounded verdict summary per unit and a **seam inventory** (changed files that import or are imported across unit boundaries), plus the ledger digest. The host proves coverage as a set-cover over git data; a phase verdict cannot be `passed` unless the ledger is complete and every unit is complete and passing. This is R11's per-subset integration (`WORK-PACKAGES.md:61`) generalised to arch-review.

**Unit definition (sub-choice for the user, U8).**
- C1 *ownership units*: one unit per ticket (or wave/workstream) from the graph's `files` and `path-owner.cjs`. Phase 50 would give 29 units averaging ≈ 23 KB of diff each (679,800 B / 29; derived) — mostly overhead.
- C2 *byte-budget units*: directory-cohesive groups of changed files up to a token budget. Phase 50's diff at U3 is ≈ 164k tokens (679,800 B / 4.136); with a ~150k-token unit budget and roughly 40–50k tokens of instructions, ADRs and relevant plans per unit, each unit carries ≈ 100k tokens of diff, i.e. ≈ 2–4 units (derived, A1).
- C3 *wave/workstream subsets* as written in R11.
For C1/C2 each unit also needs the plans and ADRs relevant to its files, not the whole phase set (the 29 plan files are 0.38 MB ≈ 92k tokens, EVIDENCE.md:8).

**What changes.** A partitioner in the host; a new subject kind and role-artifact schema for unit results that **cannot satisfy** the PR-level gate (today any sealed `arch-review` record with a matching PR/head/base and `verdict:'conform'` can, `role-artifact.cjs:3844-3849`, `:3868-3879`); a ledger authority modelled on the roster (HMAC, outside the worktree, `role-artifact.cjs:2438-2474`); per-unit evidence paths and sequential or isolated worktrees (today there is one fixed evidence file per role, `.shipyard-arch-review-evidence.md`, `conveyor-scratch.cjs:11`, and `assertEvidenceOnlyChanges` allows only that path, `claude-role-host.cjs:1216-1217`); an aggregator packet and prompt; changes in `front.cjs`/`sentinel.cjs` duties that assume one arch-review per PR; hierarchical reduction when the unit count exceeds the aggregator's capacity.

**Cost.** XL (A1). New artifact kind, new authority record, N+1 launches per review, conveyor-duty changes, and a seam analysis. The static import graph in `buildReviewImpactPacket` (`codex-arch-review-context.cjs:2006-2049`) could seed the seam inventory but is bounded by the 16 MiB repository read (§1.5).

**How the host proves every changed line was covered.** Mechanically and independently of any transcript format: the host derives the full changed set from `git diff --name-status -z --find-renames <merge-base>...<head>` (the same inventory `focusedChangeInventory` already builds, `:1430-1455`), assigns each row to exactly one unit (disjoint and exhaustive), embeds exactly that unit's diff in that unit's packet, and records `{unit_id, paths, old/new blob ids, diff_sha256, artifact_ref, artifact_digest, receipt_digest, outcome, review_completeness}` in the ledger. `ledger_digest` joins the aggregator's `context_digest`. The host re-validates every unit artifact at aggregation and again at finish (as it does for archives, `revalidateLiveInputs`). A unit that returns `incomplete`, fails, or is stale forces `incomplete` at the aggregate. Coverage is therefore "each line was *embedded* in a bounded session that was itself receipt-verified", the same exposure standard as today, with no single session needing the whole diff.

**Receipts, authority, digest binding.** One ADR-014 receipt per unit launch plus one for the aggregator; each unit crosses `boundary.dispatch`. The aggregator cannot forge a unit result because unit artifacts live in host-owned storage and are re-read by the host. Model selection happens per launch from that launch's signals. The final artifact binds `ledger_digest` in addition to head, tree, base, ticket-set digest.

**Runtimes.** Both. The unit path reuses each host's existing inline/file path unchanged; only the partitioner, ledger and aggregator are new and can live in shared code (`codex-delivery-host.cjs` already hosts the shared v2 lineage that Claude calls, `claude-role-host.cjs:660-664`).

**Failure modes.**
- Cross-unit blindness: the integrator exists to see "what only the sum reveals" (`integrator.md:3-4`); per-unit judgment can miss emergent issues unless the seam inventory is complete (INV-010 R-15, `INV-010 RISKS.md:19`).
- Aggregator overflow for very large N (hence a tree reduction); per-unit overhead dominates for C1 (each unit repeats instructions and ADRs).
- Partial failure and retry: unit 7 fails after 6 succeed — resume semantics, idempotence, and cost accounting. All units must pin the same head/tree; any head or base move re-owes every unit.
- Evidence and gate collisions: single evidence path, single `gate-trailer` current-verdict lookup (`gate-trailer.cjs:203-240`) and sentinel duties assume one verdict per PR.
- N× launches multiply the graph-directory bookkeeping that already dirties the tree (§1.7) and the receipt/transcript storage.
- Cost/latency is unbounded in N; phase 50 per-ticket units ≈ 29 launches plus an aggregator (derived).

**Rollback.** Additive subject kind: stop selecting it. In-flight phases that already adopted new conveyor states need a migration. Previously sealed single-verdict artifacts remain valid.

**Forecloses.** The single-session whole-picture review as the default; reuse of the existing single `phase=…;tickets=…` artifact shape; simple operator mental model ("one review, one receipt").

**Unrelated defects it needs.** All three. `receipt` key (the aggregator/phase packet carries the roster). stderr (diagnosing which of N+1 launches failed). **Graph directory is a hard dependency**: N launches each write bookkeeping into tracked graph files and the next run refuses the dirty tree (§1.7).

---

### Option D — Hybrid: size-routed (inline → pull → partitioned)

**Sketch.** Route by the *measured* estimated input against a calibrated window `W`:
1. `est ≤ T1`: today's inline path with Option A's shrinkage (small epics unchanged and fully compatible — "Existing v1 full-input reviews remain complete and compatible", `integrator.md:41-42`).
2. `T1 < est ≤ T2`: Option B (pull) for one-session reviews.
3. `est > T2` (cannot fit one session): Option C (partitioned).
The chosen route is recorded in the sealed artifact and evidence; a route-2 failure (compaction, truncation, open ledger) escalates to route 3 rather than accepting a partial review (the existing code already uses `REVIEW_RESTART_REQUIRED` for "full review required", `codex-runtime-host.cjs:1531`).

**What changes.** Everything A, B and C change, plus the router, the thresholds, a contract label that includes `route`, and a change to what `inputTokens` means for model selection (§3 R4) because the routing signal must be computed from the *work*, not from the shrunken prompt.

**Cost.** XL+ (A1): three code paths to build, test on two runtimes, and keep consistent; thresholds need measurement (S1, S2, S4) before they can be set.

**How the host proves coverage.** Whichever route applied (A: delivery; B: exposure ledger; C: set-cover ledger). The route is part of the contract so a verifier knows which proof to demand. Routing down never silently weakens: a route that cannot close its proof is not accepted.

**Receipts, authority, digest binding.** As in the chosen route; the dispatch context records `route` and thresholds so a later audit can reproduce the decision.

**Runtimes.** Both, but thresholds are per runtime and per role (the windows differ and are unknown, U1); a Claude-only or Codex-only route table is likely (Assumption A4).

**Failure modes.** Highest complexity; threshold mis-calibration (a route that is too optimistic fails late and expensively); host/runtime skew if Claude and Codex route the same epic differently (contract-version drift between hosts); every bug class of A, B and C is reachable.

**Rollback.** One knob: set `T1 = ∞` to restore the (A-shrunk) inline path, or `T2 = ∞` to disable partitioning. Because each route is additive, rollback does not invalidate sealed artifacts.

**Forecloses.** Nothing technically, but it commits the project to maintaining three mechanisms and to measuring windows per model.

**Unrelated defects it needs.** All three (same reasoning as C for the partitioned route).

---

## 3. Comparison (mandatory)

Reference column "Status quo" is not an option (it fails on realistic epics — EVIDENCE.md:10-11, 22-25); it is shown for orientation.

| | Status quo | **A** Stop-gap shrink | **B** Pull model | **C** Partitioned ledger | **D** Hybrid routed |
|---|---|---|---|---|---|
| Removes dependence on diff size? | No | **No** — moves the cliff | **Partly** — removes the launch cliff only; session window still bounds total reads | **Yes** — no session holds the whole diff; aggregator bounded by ledger (needs tree reduction for very large N) | **Yes** (via route 3) |
| Phase-50 integrator (derived) | refused: 640k tok | 292–485k tok; fit **Unknown** | one session reads ≈ 0.6–1.4 MB of diff + 0.6 MB inline; fit **Unknown** | ≈ 2–4 units (C2) or 29 (C1) + aggregator | route by measured size |
| Cost / complexity (A1 estimates) | — | S–M | L | XL | XL+ |
| Host proof of "every changed line covered" | none (refused) | delivery by construction; add name-list equality | exposure ledger from transcript (strong form needs U3 resolved); self-declaration is the weak form | set-cover ledger over git data, transcript-independent | per route |
| New contract label / artifact shape | no | no | yes (manifest contract) | yes (unit kind, ledger, aggregator) | yes (adds `route`) |
| ADR-014 receipts / host authority | unchanged | unchanged | unchanged; adds transcript-derived proof | one receipt per launch; ledger authority (HMAC, outside worktree) | per route |
| Claude | inline; fails > window | same path | **new** verifier (no precedent, E23) | reuse unit path + shared partitioner | all of the above |
| Codex | host files; v2 fails on repo size | same path; v2 fix needed | extend existing consumption verifier + manifest | reuse unit path | all of the above |
| Main failure modes | `prompt_too_long`, `CONTEXT_OVER_BOUND` | still fails on bigger epics; hides mirror divergence (CI parity test covers it); judgment quality at low context (U5) | window still binds (Codex refuses compaction; Claude **Unknown**); silent skip without strong ledger; base64 token inflation (Codex); transcript-format dependence | cross-unit blindness; N× cost/latency; partial failure/retry; gate/evidence collisions | threshold calibration; three paths; host skew |
| Rollback | — | trivial (revert pathspec/constants) | selector value; additive | stop selecting; migrate in-flight phases | one knob per route |
| What it forecloses | — | nothing structural | "judged exactly the embedded bytes" invariant | single-session whole-picture default; single-verdict artifact shape | nothing, but triples maintenance |
| Needs `receipt` fix | yes (phase arch-review) | yes | yes | yes | yes |
| Needs stderr surfaced | — | no (advisable) | strongly advisable | strongly advisable | strongly advisable |
| Needs graph-dir isolation | — | operability | operability | **hard dependency** | hard for route 3 |
| Prior art in repo | — | WORK-PACKAGES R11 part 1 (unbuilt) | Codex host files + focused partitions + native consumption verifier | WORK-PACKAGES R11 part 2 (unbuilt); roster HMAC authority; INV-010 rejected the *ticket-review* variant | composition |
| Tests that pin today's behaviour and would change | `development-artifacts.test.cjs:11-30`; `claude-role-host.test.cjs:1004-1100` (2 MiB admission/refusal), `:1406-1470` (focused overflow, big-ADR bounds) | these, minimally | these + 12 test files that reference the review contracts (53 hits, E26) | same set + new fixtures | all |

Risks that cut across every option (not option-specific):

- **R1 Silent partial review.** A reviewer or host that reports `complete` without having been exposed to every changed line. Mitigation differs per option (table above); the weak form (self-declaration) is today's focused-arch-review standard (`arch-review.md:124`).
- **R2 Mirror divergence hidden by exclusion.** Mitigated mechanically only on epic → `main` PRs (`packageFreshnessRequired`, `scripts/package-shipyard-codex.cjs:71-74`); tickets into `epic/*` never run it. A reviewer that never sees the mirror cannot notice a mirror edit that the parity test would also catch; a metadata inventory of mirror paths keeps the *fact of change* visible.
- **R3 Contract/version drift between hosts.** Any new contract label must be understood by every consumer (`role-artifact.cjs`, `gate-trailer.cjs`, both hosts, installed bundles). "Unknown contract versions are refused" (`integrator.md:41`) makes skew a hard refusal, not silent.
- **R4 Routing-signal drift.** `inputTokens > 250000` selects Opus/high (Claude integrator), Fable/medium (Claude arch-review) or Sol/xhigh (Codex both) (`model-policy-internal.cjs:162-166,192-195`). Options B–D shrink the launch prompt below that threshold while increasing the real workload, so the reviewer would run on a cheaper rung than today. Changing the signal's definition is a host change outside the ADR-014 grid but affects what the grid's "measured window" means; owner: ADR-014 owner (U9).
- **R5 Stale or tampered evidence.** Per-chunk/unit evidence pinned to a head that later moves must be re-owed; the existing `STALE_CONTEXT` checks (`claude-role-host.cjs:1251-1350`) apply, but C multiplies the artifacts to re-validate.
- **R6 Operators relying on old behaviour.** Phase 50 was merged without either review; the conveyor currently allows "merge without" as the failure outcome. Any option that makes review runnable changes expectations; "human-review-required never authorizes a merge by itself" stays (`integrator.md:208-210`).

---

## 4. Considered and set aside (with the reason)

| Idea | Why it is not one of the options |
|---|---|
| Raise `DIFF_MAX_BYTES` / `PROMPT_MAX_BYTES` / `INTEGRATOR_MAX_PACKET_TOKENS` again | The host already admits 750k tokens while the child refuses 640k (EVIDENCE.md:10); the model window is the bound. Already rejected in PROBLEM.md. |
| Use a larger-window model | Claude integrator has no Fable rung in the policy; adding one or changing the grid is an ADR-014 change the problem statement excludes. Codex has only Sol/Luna. |
| Buy: rely on CodeRabbit/Copilot | They "do not know this project's ADRs" (`arch-review.md:51-53`) and produce no ADR-014 receipt or host-owned verdict; they cannot replace either role. |
| LLM pre-pass that summarises the diff before review | Lossy and unreceipted as evidence of coverage; a pre-pass that reviews a chunk *is* Option C. |
| Carry per-ticket architecture verdicts into the integrator | Rejected by INV-010 (`DECISIONS.md:26-29`, risks R-1/R-15); v2 inherited trust is already Codex-only and forced `full` on Claude (§1.4 item 3). |
| Make the Claude child read the existing host-file relay as the whole solution | The relay lives outside the worktree while the child runs with `blockReadsOutsideWorkingDirectories:true`; the existing test uses a mocked runtime (`claude-role-host.test.cjs:1406-1432`), so reachability is unproven (U4). |
| Do nothing | Fails on every epic in the 1–2 MB product-diff class (EVIDENCE.md:11); shown only as a reference column. |

---

## 5. What each option would touch (implementer's anchor list)

- **Common to all (mirror):** `development-artifacts.cjs:16-19`; `claude-role-host.cjs:462,509,515,538-539`; `codex-arch-review-context.cjs:1092-1095,1109-1110,1170-1171,1186,1430-1455,1933-1957,1983-1999`; `role-artifact.cjs:2849-2995` (duplicate impact builder); new test beside `tests/unit/development-artifacts.test.cjs:26-30` and `claude-role-host.test.cjs:1004-1017`.
- **Common to all (defects):** `context-packet.cjs:34-39,196-205,455,523` and `claude-role-host.cjs:548-549` (or `role-artifact.cjs:2628-2629`) for `receipt`; `claude-runtime-host.cjs:842` and `claude-role-host.cjs:1659-1661` for stderr; `claude-role-host.cjs:92-95,1565-1587,1654-1657` for the graph directory.
- **B:** `makePrompt` `claude-role-host.cjs:864-906`; `prepareArch`/`prepareIntegrator` packet shape `:542,634-635`; a Claude transcript verifier beside `claude-runtime-host.cjs:477-640`; `validateFocusedResult` `codex-arch-review-context.cjs:1389-1405`; `verifyFileInput` focused branch `:905-931`; `codex-runtime-host.cjs:1296-1452`.
- **C:** a partitioner and ledger (new), `role-artifact.cjs` (unit kind; roster-style authority `:2438-2495`), `gate-trailer.cjs:203-240`, `front.cjs`/`sentinel.cjs` duties, `dispatch-record.cjs` in-flight bookkeeping.
- **D:** all of the above plus a router and the `inputTokens` semantics (`claude-role-host.cjs:410-426`, `codex-delivery-host.cjs:744,1029`).
- Generated package: any change under `plugins/delivery-pipeline/` requires `make package-shipyard-codex` before the epic → `main` PR; `make refresh-runtime-digests` only if `claude-dispatch-adapter.cjs` or `runtime-adapters.cjs` change (E20).

---

## 6. Sources

Repository (all read at `1c34583b`): `plugins/delivery-pipeline/scripts/{claude-role-host,claude-runtime-host,claude-dispatch-adapter,codex-arch-review-context,codex-delivery-host,codex-runtime-host,context-packet,role-artifact,development-artifacts,model-policy-internal,pipeline-config,refusal-hints,gate-trailer,pr-hygiene,scope-gate,graph-dir,conveyor-scratch}.cjs`; `plugins/delivery-pipeline/references/{integrator,arch-review}.md`; `plugins/delivery-pipeline/commands/deliver.md:2880-3049`; `CLAUDE.md:30-141`; `Makefile`; `scripts/{package-shipyard-codex,refresh-runtime-digests}.cjs`; `tests/unit/{claude-role-host,claude-runtime-host,development-artifacts,phase49-package-publication,runtime-file-digests}`; `plugins/shipyard/package-build.json`; `.planning/phases/45-close-residual-pipeline-efficiency-gaps/{WORK-PACKAGES,PLANNING-STATUS}.md`; `.planning/investigations/INV-008-residual-pipeline-efficiency/research/constraints.md` (HC-19), `INV-010-review-stage-efficiency/{DECISIONS,RISKS}.md`, `INV-017-launch-and-upgrade-reliability/research/risks.md:36-38`; INV-019 `PROBLEM.md`, `EVIDENCE.md`, `RESEARCH-CONTRACT.md`, `OPEN-QUESTIONS.md`. No external source was consulted. No file under `~/.local/state/shipyard/` was read.

---

## 7. Unknowns → OPEN-QUESTIONS.md draft lines

Each is a checkbox for the user's OPEN-QUESTIONS.md; none is silently absorbed above.

- [ ] U1 — What is the real input window of `claude-sonnet-5-5`, `claude-opus-5-5` (both reachable by the integrator) and `gpt-6.1-sol` at the host's launch flags, and what share is usable after instructions and output headroom? No numeric value exists in the repository (E22). Next check: spike S1. — owner: research / runtime owner
- [ ] U2 — Does `claude --print` (the host's launch mode) auto-compact a long session, and is that visible in the stream or transcript? If it compacts silently, an exposure ledger can show "read" for content the model no longer holds. Next check: spike S2. — owner: research
- [ ] U3 — Does the Claude stream-json output / session JSONL contain complete, untruncated `tool_result` bodies for `Bash` and `Read`, and what are the per-call truncation limits of the installed CLI? This decides whether Option B's strong coverage proof is possible on Claude. Next check: spike S2. — owner: research
- [ ] U4 — Can the restricted Claude child (`blockReadsOutsideWorkingDirectories:true`, write-allow = worktree only) read (a) host input files under `~/.local/state/shipyard/claude/…` (the existing >1 MiB arch-review relay) and (b) the common git directory of a linked worktree through sandboxed `git diff`? The existing relay test is mocked. Next check: spike S3. — owner: research
- [ ] U5 — Does a smaller `--unified` value (3/10) degrade arch-review/integrator judgment, given the reviewer can read surrounding code with tools? `--unified=50` is mentioned in 9 `.planning` files (all INV-008/INV-010 research or intake) that describe the value; in the lines inspected none gives a rationale, but those files were not read in full (E24b). — owner: user
- [ ] U6 — May the arch-review diff exclude `.planning/` outside `.planning/architecture/**` and `…/DECISIONS.md`, or must "the complete PR diff" stay complete (`codex-arch-review-context.cjs:1186`)? Excluding only `plugins/shipyard/` is certain per PROBLEM.md. — owner: user
- [ ] U7 — Does a Codex review of the 2.6 MB phase-50 packet through the existing batch reader complete at all (base64 inflation, no compaction allowed, `codex-runtime-host.cjs:1529-1531`)? EVIDENCE.md has no Codex v1 run. Next check: spike S4. — owner: research
- [ ] U8 — If Option C or D is chosen, which unit definition (ownership per ticket, byte-budget chunks, wave/workstream subsets) and which seam rule apply, and who owns the R11 work package that already specifies the per-subset idea? — owner: user
- [ ] U9 — If review prompts shrink, what does the `inputTokens > 250000` routing signal mean for Options B–D (prompt size vs work size), and does that need an ADR-014 note? — owner: ADR-014 owner
- [ ] U10 — Should the three unrelated defects (`receipt` key, child stderr, graph directory) be fixed inside this work or separately? The comparison shows `receipt` is needed by every option, the graph directory is a hard dependency only for C/D, stderr is advisable for B–D. — owner: user (already OPEN-QUESTIONS.md item 5)
- [ ] U11 — Is the v2 impact builder (reads all repository source at both endpoints; no inheritance on Claude) kept, made lazy for `mode:'full'`, replaced or retired, and does any option need contract v3? — owner: user (already OPEN-QUESTIONS.md item 3)
- [ ] U12 — Would a metadata-only mirror inventory (changed `plugins/shipyard/` paths with blob ids, no content) in the review packet be acceptable instead of silence? — owner: user

---

## 8. Recommended spikes (not run; the contract forbids throwaway code here)

- **S1** `/gsd-spike "bisect the real prompt window of claude-opus-5-5, claude-sonnet-5-5 and gpt-6.1-sol at the host's launch flags with synthetic prompts of 150k/250k/400k/550k tokens"` — resolves U1 and sets T1/T2 for Option D.
- **S2** `/gsd-spike "Claude --print reviewer pulls a 700 KB epic diff with Bash git diff per file under the host sandbox settings: turns, tokens, compaction, tool_result presence and truncation in stream-json and session JSONL, transcript size"` — resolves U2, U3 and the feasibility of Option B's strong proof on Claude.
- **S3** `/gsd-spike "restricted Claude child reads the host focused-relay manifest and runs git diff in a linked worktree under blockReadsOutsideWorkingDirectories"` — resolves U4.
- **S4** `/gsd-spike "Codex v1 integrator and focused arch-review on the 2.6 MB phase-50 packet through the batch reader: completes, compacts, or refuses?"` — resolves U7.
- **S5** `/gsd-spike "seam-aware partition of the phase-50 diff by ticket ownership and by byte budget: unit sizes, seam counts, aggregator input"` — sizes Option C (pure computation over git and `tickets.json`, no model).

---

## 9. Evidence ledger (exact commands and files)

All paths are relative to `/Volumes/KINGSTON/.wt-claude-shipyard/inv-019`. "Read" and "Grep" are the harness tools; each entry names the pattern/range and the observed result.

- **E01** `git -C <wt> rev-parse HEAD` → `1c34583b1aedbffe75d9deeff49de9069237e5aa`.
- **E02** `wc -l` over `claude-role-host.cjs codex-arch-review-context.cjs codex-delivery-host.cjs context-packet.cjs role-artifact.cjs development-artifacts.cjs phase-integrator-preflight.cjs` → 1664, 2251, 3734, 764, 6465, 34, 289.
- **E03** Read `plugins/delivery-pipeline/scripts/claude-role-host.cjs` 1-260, 440-1664; Grep `READ_ONLY_TOOLS|ALLOWED_TOOLS|DIFF_MAX_BYTES|INTEGRATOR_MAX_PACKET_TOKENS|PROMPT_MAX_BYTES|FILE_LIMITS|unified=|combinedDiff|diffText|FOCUSED_CONTRACT` → constants at `:34-40`, diff sites at `:459-469,509-510,625`, focused relay `:1446-1461`.
- **E04** Grep `READ_ONLY_TOOLS|ALLOWED_TOOLS|--allowedTools|--tools|sandbox|stdin|stderr` and Read `claude-runtime-host.cjs` 1-60, 215-290, 385-425, 690-910 → tools `:34-35`, launch args `:783-792`, settings `:750-780`, stdin `:822`, exit handling `:840-842`, record cap `:276`, transcript cap `:33,:508`.
- **E05** Read `tests/unit/claude-runtime-host.test.cjs` 225-284 → pins tools, sandbox, `blockReadsOutsideWorkingDirectories`, write-allow.
- **E06** Read `codex-arch-review-context.cjs` 100-760, 740-1245, 1382-1800, 1927-2126 → limits `:109-112`, partitions `:461-485`, batch `:293-368`, `prepare` `:1545-1642`, impact builder `:1959-2126`, focused result `:1389-1405`.
- **E07** Read `codex-delivery-host.cjs` 740-1100 → v2 lineage `:773-836`, Codex integrator `:974-1089`.
- **E08** Grep `sandbox|exec_command|compact|truncat|input_consumption|createReviewObserver|validateReviewNative` and Read `codex-runtime-host.cjs` 1296-1370, 1520-1540, 1808-1830, 2530-2570 → compaction refusal `:1529-1531`; `exec_command` and 10,000-token cap `:1300-1309`; read-only profile `:2553-2568`.
- **E09** Read `plugins/delivery-pipeline/references/integrator.md` (1-210) and `arch-review.md` (1-244).
- **E10** Read `development-artifacts.cjs` (1-34) → `PREFIXES`, `productPathspec()`; no `plugins/shipyard` entry.
- **E11** Grep `productPathspec|changedProductPaths|isDevelopmentArtifact` over `plugins/delivery-pipeline/scripts`, `scripts`, `tests`, `.github` → consumer list in §1.6.
- **E12** Read `pr-hygiene.cjs` 258-300, `scope-gate.cjs` 105-135.
- **E13** Grep `AUTHORITY_KEYS|rejectAuthorityKeys|'receipt'` in `context-packet.cjs`; Read `role-artifact.cjs` 2438-2495, 2624-2637 → roster records carry `receipt` (`:2450-2451`).
- **E14** `git -C <wt> ls-files plugins/shipyard | wc -l` → 161; `git -C <wt> ls-files | wc -l` → 1523.
- **E15** `git ls-tree -r -l HEAD plugins/shipyard | awk '{s+=$4;n++} END{print n,s}'` → `161 4808946`; same filtered to `.(cjs|mjs|js|ts|tsx|jsx)` → `124 4272898`; `git ls-tree -r -l HEAD | awk` (JS-like, whole tree) → `449 14823120`.
- **E16** `git -C <wt> diff --no-ext-diff --unified=N be7ab4f3...f80dfea7 -- . ':(exclude).planning' ':(exclude).shipyard' ':(exclude).shipyard-*' ':(exclude)docs/audits' ':(exclude)AGENTS.md' ':(exclude)CLAUDE.md' [':(exclude)plugins/shipyard'] | wc -c` → U50: 2043597; U50 + mirror excluded: 1400771; U3: 679800; U10: 815389; U0: 604258. Unscoped `git diff --no-ext-diff --unified=50 be7ab4f3...f80dfea7 | wc -c` → 3352354.
- **E17** `git diff --no-ext-diff --numstat be7ab4f3...f80dfea7 -- <product pathspec + mirror excluded> | awk` → `80 files, +9859 -268`; `-- plugins/shipyard` → `27 files, +1702 -214`; `-- .planning` → `126 files, +11880 -196`. Per-file listing read for the 564-line maximum.
- **E18** `git log -4 --format='%H %P %s'` (squash merge `92453193` with parent `be7ab4f3`); `git cat-file -t f80dfea7` → `commit`; `git merge-base be7ab4f3 f80dfea7` → `be7ab4f3407b017a50e9fe2a49bf54e22e7d3202`.
- **E19** `git status --short` → ` M .planning/graph/delivery-front.json`, ` M .planning/graph/dispatches.json`, `?? .planning/investigations/INV-019-…/`; `git ls-files .planning/graph` → 12 tracked files including both.
- **E20** Read `CLAUDE.md` 30-141; `scripts/refresh-runtime-digests.cjs`; `tests/unit/runtime-file-digests.json` (2 files pinned); Grep `packageFreshnessRequired` (`scripts/package-shipyard-codex.cjs:71-74`); Read `tests/unit/phase49-package-publication.test.cjs` 36-60; Read `plugins/shipyard/package-build.json`; Grep `.github/workflows` → only `check-runtime-digest-trailer.cjs` at `test.yml:106-108`.
- **E21** Read `model-policy-internal.cjs` 150-210, 515-575; Grep `WINDOW_THRESHOLD_TOKENS` → `:40,:306,:553`.
- **E22** Grep (case-insensitive) `context[ _-]?window|model_context_window|prompt_too_long|window size` over `plugins/delivery-pipeline/**`, `docs/**`, `CLAUDE.md`, `AGENTS.md`, `.planning/architecture/**` → only `docs/gsd_multilevel_delivery_pipeline.md:1076-1077`, ADR-014 `:70,:112`, `deliver.md:1607`, `pipeline-config.cjs:2010`; Grep `context|window|token` in `model-capability.cjs` → no window field; Read `pipeline-config.cjs` 100-130, 2000-2030.
- **E23** Grep `tool_use|tool_result|"Read"|'Read'` over `plugins/delivery-pipeline/scripts` → no transcript tool-call parsing (only tool allow-lists at `claude-runtime-host.cjs:403,761`).
- **E24** Read `INV-010 DECISIONS.md`; Grep `R11|per-subset` in INV-010; Read `WORK-PACKAGES.md:61`; Grep `R11` in `PLANNING-STATUS.md`; Grep `HC-19` area in `INV-008 …/constraints.md:85`; Grep `unified=50|unified 50` over `.planning` (`files_with_matches`, excluding INV-019) → 9 files, all INV-008/INV-010 research or intake describing the value (**E24b**; not read in full); Grep `unified=50` over `tests` → 3 hits pin the value (`phase49-review-continuation.test.cjs:1656`, `architecture-target.test.cjs:156,228`).
- **E31** Grep `packet|context_digest|input_digest|prompt_digest|prompt_sha` (case-insensitive) in `claude-dispatch-adapter.cjs` → only `validateLaunchPacket` and its two call sites (`:16,437-452,639,936`); Grep `prompt_sha|input_digest|context_digest|packet_digest|prompt_digest|context_packet` count in `dispatch-boundary.cjs` → 0 matches.
- **E25** Read `deliver.md` 2880-3049 (v2 contract, legacy v1, runtime split).
- **E26** Read `tests/unit/claude-role-host.test.cjs` 1000-1080, 1400-1470; Grep `shipyard.integration-review|FOCUSED_CONTRACT|focused-architecture-review|host-file-input|native-reader-transport|review-coverage-lineage` over `tests` → 53 occurrences in 12 files.
- **E27** Grep `^    "T-50-[0-9]+[^"]*": \{` count in `.planning/graph/tickets.json` → 29; Glob `.planning/phases/50-*/*-PLAN.md` → 29 files.
- **E28** Read `refusal-hints.cjs` 266-324 → `DETAIL_TOKENS = ['pid','path','key','explicit','bundle_value']`.
- **E29** Read `gate-trailer.cjs` 196-245; `role-artifact.cjs` 3262-3330, 3826-3900.
- **E30** Blocked: one compound Bash command denied (`cd … && wc -l …; ls …`); re-run as single commands (E02).

---

## 10. Assumptions (labelled, with next check)

- **A1** Cost labels S/M/L/XL and the "≈ 160 lines" analogy are estimates from the touched surface; next check: implementation planning after the user picks an option.
- **A2** For Option B on Claude, reading only through `git` object commands (not working-tree files) removes the reviewer-mutation hazard; next check: S2/S3 and a review of the sandbox's treatment of `git`.
- **A3** Base64 text tokenizes less efficiently than plain text, so the Codex batch reader costs more than 4/3 of the byte count in tokens; next check: S4 (measure tokens consumed).
- **A4** Thresholds and routes would differ per runtime and role because windows differ; next check: S1.
