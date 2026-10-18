# INV-019 research line 4 — risks and unknowns

- **Line:** risks (→ RISKS.md + OPEN-QUESTIONS.md drafts)
- **Subject:** `INV-019-review-diff-size-independence:risks`
- **Source revision:** `1c34583b1aedbffe75d9deeff49de9069237e5aa` (checked: `git rev-parse HEAD`, C1)
- **Policy hash (DATA, preserved):** `3978b08721ef8f2381aa1f31355c9fef1dafd4058a2093b4a5f06ee90cd44570`, policy version `adr-014.v7`
- **Resolved selection (DATA, preserved):** Claude `claude-sonnet-5-5` / `xhigh`; policy signals `{}`
- **Date:** 2026-10-18
- **Scope kept:** read-only line. No product code, graph file, planning scaffolding, other investigation file, or `~/.local/state/shipyard/` path was changed or read. Only this file was written, plus the empty `research/` directory that holds it.
- **Reading conventions:** `[Cn]` is an entry in the verification ledger in section 7 (exact command, path, result). A claim marked **(code reading)** was derived by reading source and was not executed. A claim marked **(arithmetic)** is derived from numbers in this file. A claim marked **(assumption)** has no command behind it and has a next check.

## 0. Environment limits on this line (stated, not absorbed)

| Limit | What happened | Consequence |
|---|---|---|
| Compound shell command denied | `cd <worktree> && wc -l <9 files>; ls <dir>` was denied (multiple operations need approval; no approval surface). | Re-run as single commands (C4) and with the Read/Grep/Glob tools. Nothing was lost. |
| Run-time-computed path denied | A `node -e` script that measured the JavaScript/TypeScript corpus at the phase-50 epic base `be7ab4f3` and head `f80dfea7` (to reproduce EVIDENCE.md's "25.7 MB / 1,523 files") was denied: "node names a path that is computed at run time, which cannot be checked against the read block (`permissions.blockReadsOutsideWorkingDirectories`)". Not retried. | That EVIDENCE figure is **not reproduced** here (U-14). A narrower measurement at `HEAD` ran earlier (C27). The refusal is also first-hand evidence that this permission feature blocks Bash commands whose path it cannot resolve — relevant to R-7. |
| No network, no GitHub, no model call | No `gh`, vendor-doc fetch, Claude or Codex launch was attempted. | Branch protection, live window limits and live tool behaviour are **unknown** and are listed as questions and spikes, not absorbed. |
| Private state fenced | `~/.local/state/shipyard/**` and the user's other worktrees were not read (research contract). | The failed phase-50 transcript (`terminal_reason: prompt_too_long`) was not inspected; the effective window is unknown (U-1). |
| No spike run | Contract forbids throwaway validation code. | Section 4 lists `/gsd-spike` candidates. |

## 1. Command-backed facts this register rests on

Each fact is the minimum the risks need. System-state, alternatives and constraints lines own the full maps.

### Delivery state first (hypothesis #1 does not apply, but the contract asks the check)

**F1.** The problem is "a review cannot run for large epics", not "a feature is absent", but the code under investigation is present on the integration branch: `git branch --contains 92453193 --all` lists `origin/main` (C2); commit `92453193` is the phase-50 epic squash and its message states the integrator and arch-review "were not run for this epic" and the epic was "merged on the human's explicit decision" (C3). The local ticket board is a **stale snapshot**: delivery state counts phase-50 tickets as `{"pending":25,"pr-open":4}` (C4) although the epic is on `origin/main`; for example `T-50-17` is `pending` yet the code it names (`launchPreflight` in `claude-role-host.cjs:1589`) is present. Ticket-ownership claims taken from this board are unreliable (R-21, U-11).

### How the diff reaches the model today (only what the risks need)

**F2. Claude integrator.** `diffText` runs `git diff --no-ext-diff --unified=50 <base>...<head> <productPathspec()>` capped at `DIFF_MAX_BYTES = 2 MiB` (`claude-role-host.cjs:34,459-469,625`); the content is embedded as `role_context.combined_diff.content` (`:634-635`) and the whole packet is serialised into the prompt (`:864-896`). Bounds: `PROMPT_MAX_BYTES = 3,000,000` (`:35,897`), token ceiling `min(750000, 60000 + ceil(diffBytes/3))` (`:40,824-829`), and every estimate is `bytes/4` (`:910`) (C5, C6).

**F3. Claude arch-review.** The diff is `git diff --no-ext-diff --no-textconv --unified=50 <merge-base>...<head>` with **no pathspec at all**, capped by `FILE_LIMITS.material = 16 MiB` (`claude-role-host.cjs:509-510`; `codex-arch-review-context.cjs:110`); embedded as `role_context.exact_diff.content` (`:542`). Packet overflow is tolerated for arch-review (`:856,860-861`). A prompt over 1 MiB is switched to a host-file relay (`:1446-1461`) and refused if prompt plus instructions still exceed 1 MiB (`:1458-1459`) (C6).

**F4. Codex arch-review.** `collect()` applies `productPathspec()` only in "legacy" mode (`legacy = legacyArchitecture || readerProfile !== undefined || readerCapacity !== undefined`, `codex-arch-review-context.cjs:1091-1093`); the focused mode has no pathspec. Neither mode excludes `plugins/shipyard/` (C7, C8).

**F5. Codex integrator v2 and Claude integrator v2.** `prepareIntegrationLineage` (`codex-delivery-host.cjs:773-836`) builds a full copy of the original packet as a private host file (`:802-803`), then `buildReviewImpactPacket` (`codex-arch-review-context.cjs:1959-2131`), then a second host file with the lineage packet (`:824-830`). The Claude host calls the same function but forces `mode: 'full'` (`:807-809`) and sends the result **inline** (`claude-role-host.cjs:658-667`). On Codex the reader pre-measures capacity with one launch and then launches the real review (`codex-delivery-host.cjs:2997`); batches are 8192-byte chunks, 12 ranges per batch (`:974-980`); limits `material 16 MiB`, `reads 2064` (`codex-arch-review-context.cjs:110-111`) (C9, C10).

**F6. Why v2 reaches 25.7 MB.** The impact builder reads **every** JS/TS blob in both the baseline and the head inventories to build an import graph, counting each against one `total` bound of `FILE_LIMITS.material` (`codex-arch-review-context.cjs:1977-1999,2006-2027`), then appends the **full content** of every affected endpoint source (changed files plus their importers) to the packet (`:2076-2087`). So graph construction, not only included content, consumes the bound, and changed mirror files would be included as whole files even if the diff excluded them. At `HEAD` of this checkout there are 449 JS/TS files, 14,823,120 bytes (10,550,222 bytes as unique blobs, 4,272,898 bytes under `plugins/shipyard/`) (C27). EVIDENCE.md's 25.7 MB / 1,523 files at the epic head could not be reproduced (section 0, U-14).

### What the host verifies afterward

**F7. Self-declared completeness is what is "enforced" for architecture review.** `references/arch-review.md:84-88,124` says partition hashes "authenticate availability; they do not prove reading", no `input_consumption` or range echoes are required, and "neither the declarations nor an empty finding list prove source consumption". Code: `validateFocusedResult` checks only that `complete` has empty `limitations`/`unresolved_sources` and that identity fields match (`codex-arch-review-context.cjs:1389-1405`); the prompt text says "No consumption or range echoes are required" (`:1571`; `claude-role-host.cjs:885`); the current-verdict selector only skips a verdict whose own `review_completeness !== 'complete'` (`role-artifact.cjs:3878-3879`) (C11, C12).

**F8. The integrator has no completeness field.** `roleOutputSchema('integrator')` has `outcome`, identity fields, `findings`, `reviewed_identity`, `coverage` and no `review_completeness` (`claude-role-host.cjs:1005-1024`). For v2, `validateIntegrationCoverage` compares model-echoed lists with host-computed lists (`codex-delivery-host.cjs:852-873`); the role instructions tell the model to copy them (`references/integrator.md:113-122`). The Claude inline prompt says "Trusted mechanical integrity supplies no semantic reading credit" (`claude-role-host.cjs:890`); `semantic_credit: false` is hard-coded in the integrity record (`codex-arch-review-context.cjs:762-765`). The only host-verified consumption in the repository is the Codex integrator v2 read count: `evidence.input_consumption.chunk_reads === result.input_chunk_reads === verifyFileInput(...).chunk_reads` (`codex-delivery-host.cjs:917-926`) — a count of reads, not proof of comprehension (C12, C13).

**F9. The downstream verifier reconstructs what the reviewer saw from the stored session transcript.** `originalInlinePacket` re-extracts `<AUTHENTICATED_CONTEXT_PACKET>` / `<AUTHENTICATED_FOCUSED_INPUT>` from the user messages of the saved transcript (`role-artifact.cjs:3425-3454`); `authenticateInlineCoverage` requires `coverage.mode === 'full'`, no baseline, and every required ref's full content present in `newly_reviewed` (`:3456-3488`); `authenticateCurrentCoverage` re-hashes the **11 focused producer files** against the pins stored in the original packet and compares them with the files currently installed next to the verifier (`:3268-3276`; list at `codex-arch-review-context.cjs:1382-1387`) and re-hashes the role instructions (`:3265-3267`). Caps on the Claude semantic transcript: 20,000 records (`:3214`), 128 MiB (`:3208`); runtime evidence caps the Claude session transcript at 50 MiB (`claude-runtime-host.cjs:33,508,641`) (C14, C15).

**F10. One launch, one receipt.** The role host accepts one request per instance (`claude-role-host.cjs:1437`), requires `launchCount === 1` at launch and after (`:1147,1494`), seals one judgment for one `dispatchId` (`:1418-1430`). CLAUDE.md:97 makes `resolve → validate → launch → receipt` mandatory for every routed launch (C6, C16).

### Tools, sandbox and limits of the reviewer child

**F11. Claude child.** Tools are `ALLOWED_TOOLS = Bash,Read,Edit,Write,Glob,Grep` for every role launch except the read-only smoke, which uses `READ_ONLY_TOOLS = Read,Write,Glob,Grep` (`claude-runtime-host.cjs:34-35,781-782`; `claude-role-host.cjs:1186`). Settings: sandbox enabled, `allowWrite` only the worktree, `permissions.blockReadsOutsideWorkingDirectories: true`, reads of the evidence and archive-authority globs denied, `cwd` = the worktree (`claude-runtime-host.cjs:750-763,795-798`); a unit test pins both the tool string and the read block (`tests/unit/claude-runtime-host.test.cjs:251-262`). Host input files must live **outside** the child's writable tree (`outsideWriter`, `codex-arch-review-context.cjs:205-209`) and are placed under `~/.local/state/shipyard/claude/<key>/` (`claude-role-host.cjs:1116-1122`). Tests of the Claude file relay stub the runtime (`tests/unit/claude-role-host.test.cjs:1406-1432` uses `onLaunch`); the only live Claude role smoke accepts a ticket-level `arch-review` and `pr-sentinel`, not an integrator or a phase review (`tests/smoke/claude-delivery-roles-smoke.sh:50-58`). After the run, any changed or untracked path other than the evidence file, a fixed scratch list and pinned bookkeeping aborts with `WORKTREE_MUTATED` (`claude-role-host.cjs:1211-1249`; scratch list `conveyor-scratch.cjs:6-20`). I found no wall-clock deadline for the child: `grep timeout` in `claude-runtime-host.cjs` matches only the version/auth probes, the transcript poll and the start hook (C17, C18).

**F12. Codex child.** Integrator and arch-review run `sandbox_mode: 'read-only'` (`codex-delivery-host.cjs:3120`; `codex-runtime-host.cjs:1116,1129,1632`). A native transcript containing any compaction record is rejected: `REVIEW_RESTART_REQUIRED` "native semantic context requires an authenticated handoff or full review" (`codex-runtime-host.cjs:1529-1531`) (C19).

**F13. Window facts the repository records.** `window_threshold_tokens = 250000` is a policy rung-promotion threshold, not a model window (`model-policy-internal.cjs:40,306`). `docs/audits/2026-09-30-model-ladder-refresh.md:41` states both Claude 5.5 models "have native 1M context on the direct Anthropic API" with the caveat "pins, gateways and restrictions can change the actual selection"; `:63` records Sol 6.1 at 1,050,000 context on the API and says "Do not apply that API pricing rule to ChatGPT-authenticated Codex without a matching product contract". `capabilities/delivery-pipeline/capability.json:94` still justifies the 250,000 window route as "five times the largest input measured … about 52k tokens". The integrator is not given Fable by default (`capability.json:89`; CLAUDE.md:95 gives it no ceiling rung) (C20, C21).

**F14. The host admits a prompt the model refused.** Observed (EVIDENCE.md, not re-measured): 2,647,625-byte prompt, `terminal_reason: prompt_too_long`; the host bound was 750,000 estimated tokens and `PROMPT_MAX_BYTES` 3,000,000 (F2). **(arithmetic)** If the child really had a 1M-token window, a refusal at 2,647,625 bytes means the packet cost more than 1M tokens, i.e. at most 2.65 bytes per token, against the host's assumed 4 (`:910`). If the window was smaller than 1M, the density could be anything. Either way `bytes/4` and `PROMPT_MAX_BYTES = 3 MB` are not safe admission rules.

### Mirror and pathspec facts

**F15. Mirror composition (measured).** `plugins/shipyard/` has 161 tracked files; 152 are byte-identical to their source (4,799,701 bytes), 0 differ, 9 have no source counterpart (9,245 bytes): `.codex-plugin/plugin.json`, `hooks/hooks.json`, `package-build.json` (carries the package digest) and six `skills/shipyard-*/SKILL.md` stubs (C22). EVIDENCE.md's "role-artifact.cjs 99,159 vs 99,247 B" is not a file-size comparison: both files are 380,159 bytes (C23) and `cmp` on `claude-role-host.cjs` is silent (C23). Likely diff-hunk sizes; do not reuse.

**F16. Epic/50 diff arithmetic (measured at `be7ab4f3...f80dfea7`).** Product diff (development artifacts excluded) at `--unified=50` is 2,043,597 bytes (EVIDENCE.md: 2,043,596); without `plugins/shipyard/` 1,400,771 bytes (−642,826, −31.5%). At `--unified=10`: 1,089,711 → 815,389; `--unified=3`: 870,339 → 679,800; `--unified=0`: 743,885 → 604,258. 236 changed files, 27 in the mirror (C24). Phase 50 sat at 97.4% of `DIFF_MAX_BYTES` (2,097,152). **(arithmetic)** With the mirror removed the failed prompt would have been about 2,647,625 − 642,826 = 2,004,799 bytes. Largest earlier no-mirror product diff in EVIDENCE.md is 1.79 MB (phase 36).

**F17. The shared classifier has many consumers.** `isDevelopmentArtifact` / `productPathspec` / `changedProductPaths` are used by CI scoping (`.github/actions/scope/action.yml:20`), `scope-gate.cjs:118`, `pr-hygiene.cjs:265,292,354` (exempt reason `development-artifacts-only`), `reviewers.cjs:200,205,323,442` (review freshness; `fresh: true, reason: 'development-artifacts-only'`), `comment-policy.cjs:402`, `role-artifact.cjs:2851,2946,2949,2965,2991`, and `codex-arch-review-context.cjs:1095,1451,1920,1954,2041,2044,2060,2086` (C25). `product_changes` gates the CI unit shards, `publish-gate`, the digest-trailer check and `make test-fast-rest` (`.github/workflows/test.yml:55-125`) (C26).

**F18. Where mirror freshness is enforced.** The only freshness check is a unit test: `assertPackageForBase(path.join(root,'plugins/shipyard'), baseRef)` regenerates the package with `build()` and compares file hashes (`tests/unit/marketplace-install.test.cjs:60,76-97`); it is skipped when the base ref starts with `epic/` or `ticket/` (`scripts/package-shipyard-codex.cjs:71-74`; CLAUDE.md:81-84: ticket PRs do not regenerate the mirror). So the mirror enters review diffs only at epic → `main`, and its parity is checked only there, by a unit test that runs only when `product_changes == 'true'` (C26, C28).

### Unrelated defects found at intake — confirmed

**F19. `receipt` key.** `registerPhaseArchiveRoster` stores `receipt` in every record (`role-artifact.cjs:2450-2452`); `selectPhaseArchives` returns it in `selection.records` (`:2628-2629`); the Claude packet embeds `phase_archive_selection: selectedArchives.selection` (`claude-role-host.cjs:549`); `AUTHORITY_KEYS` contains `receipt` (`context-packet.cjs:34-39`) and `rejectAuthorityKeys` scans every key at every depth at build and validate time (`:196-205,455,523`). The only host test that builds a phase roster registers an **empty** one, `JSON.stringify({ rows: [] })` (`tests/unit/claude-role-host.test.cjs:619`), so the collision never ran. The Codex path builds its own packet without `buildContextPacket` (`codex-arch-review-context.cjs:1168-1178`) and does not collide (C29).

**F20. Child stderr.** A non-zero child exit becomes `Claude process exited N` with stderr only in `details` (`claude-runtime-host.cjs:842`), and the stream parser runs only after that check (`:844`), so nothing the child printed is parsed or surfaced when the exit code is non-zero (C17). EVIDENCE.md records `terminal_reason: prompt_too_long` and "printed only `Claude process exited 1`"; which stream carried the reason is an assumption (next check: the captured child output).

**F21. Graph directory.** `graphData` honours `options.graphDir` (`claude-role-host.cjs:194-209`) but the CLI entry builds the host with `{}` or the smoke flag only (`:1654-1657`) and `parseRequest` has no graph-dir field (`:88-126`), so the CLI always uses `<worktree>/.planning/graph`. `recordInflight`/`clearInflight` bookkeeping and the host-owned file allow-list name `dispatches.json` and `delivery-front.json` there (`:1201,1474,1558`; that the host rewrites the tracked `delivery-front.json` is from EVIDENCE.md, not re-derived). This very worktree shows both tracked files modified (C2).

## 2. Risk register (draft for RISKS.md)

Severity is this line's judgement. Likelihood is stated only where a basis exists; otherwise it is `unknown`. "Spike" names a measurement the contract forbids running here.

### Group A — coverage integrity (the thing the problem statement says must not weaken)

## R-1 — Changing the delivery channel does not remove the window bound
severity: high
mitigation: Treat "one session must consume everything" as window-bound by construction; size any per-session budget from a measured tokens-per-byte and a measured effective window (SP-3), with explicit headroom, and keep the unit of work that one session must cover below that budget.
likelihood: observed in part. Codex v2 already reads through host files and its packet was 5,211,605 tokens at a 64 MiB bound (EVIDENCE.md); the Claude child reading the same bytes with tools accumulates the same tokens in one context.
evidence: F5, F6, F12, F14.
what bites: moving the diff from the prompt into files or tool reads only changes *where* `prompt_too_long` or a compaction rejection happens. Codex additionally rejects any session that compacts (F12), so a reviewer that approaches its window is discarded after paying.

## R-2 — A reviewer silently skips part of a very large diff and still returns `complete` / `passed`
severity: high
mitigation: Do not accept model-declared coverage as proof. Prove coverage on the host side from artifacts the model cannot author: either coverage by construction (every unit the host hands a session is inside that session's inline prompt, so "received" is host-known) or a host-computed read ledger parsed from the session transcript and compared with a host-built chunk manifest. Keep the existing `complete ⇒ empty limitations` rule as a necessary, not sufficient, condition.
likelihood: unknown. Today a partial reading that declares `complete` is accepted for architecture review (F7), so this risk exists independent of the redesign; a tools-driven reviewer raises the incentive and the chance (cost of reading everything is visible to the model).
evidence: F7, F8.
what bites: PROBLEM.md says "review-completeness stays enforced by the host" and "a review that did not cover all of it cannot return a passing verdict". What the host enforces today for architecture review is a label; for the integrator there is no label (F8). A design that assumes an existing host proof will inherit none. Spike SP-2.

## R-3 — The reading tools truncate silently, so "I read the whole file" is false
severity: high
mitigation: Verify tool-result fidelity before choosing a tool-reading option (SP-2); prefer host-built chunks small enough to fit one tool result; record chunk digests in the manifest and have the host confirm from the transcript that each chunk's content (not just its path) came back whole.
likelihood: unknown (assumption). The Read tool definition available in this research session states "Reads up to 2000 lines by default" and gates large files behind a flag; Bash output caps and long-line truncation in the Claude Code build used by the role child are **not** verified by any repository file. Next check: SP-2.
evidence: none in the repository; labelled assumption.
what bites: diff files contain very long lines (minified, generated, JSON); a truncated tool result looks like a complete read to the model and, today, to the host.

## R-4 — A verdict claims coverage it did not have (echo-only coverage objects)
severity: high
mitigation: Any coverage object returned by the model must be recomputed or cross-checked by the host from independent evidence (chunk receipts, transcript ranges). Copying `role_context.review_coverage` verbatim must not be sufficient.
likelihood: unknown; mechanism confirmed by code reading.
evidence: F8. `validateIntegrationCoverage` equality-checks fields the instructions tell the model to copy; Claude's inline v2 path has no read verification at all.
what bites: a chunked or manifest-driven design that returns `coverage.newly_reviewed_obligations` for chunks never opened passes `validateIntegrationCoverage`.

## R-5 — An epic larger than any aggregation step can hold
severity: medium
mitigation: Hierarchical or host-side deterministic aggregation; never ask a model to enumerate all unreviewed partitions; raise caps only together with a design that stays below the window.
likelihood: unknown; epics are 0.3–1.8 MB product diff today (EVIDENCE.md), so the cap is not hit yet, but the trend is upward.
evidence: result bound 128 KiB (`claude-role-host.cjs:36`; `codex-arch-review-context.cjs:17`); evidence ≤ 96 KiB (`:18,1241`); `limitations` and `unresolved_sources` ≤ 128 items × 1,024 bytes (`claude-role-host.cjs:994-995`; `codex-arch-review-context.cjs:1394-1397`); focused partitions are 128 KiB (`:470`), so 128 partitions = 16 MiB; roster ≤ 1,000 rows and ≤ 4 MiB (`role-artifact.cjs:2446,963`); `FILE_LIMITS.assets` 2,000 and `reads` 2,064.
what bites: an incomplete review over more than 128 unresolved partitions cannot be expressed in the schema; per-chunk findings merged into one 128 KiB result overflow at a few hundred chunks.

## R-6 — Chunked review loses the cross-chunk judgement the integrator exists for
severity: high
mitigation: Decide explicitly (user decision) whether the integrator's "what only the sum reveals" judgement survives; if chunks are reviewed in isolation add a host-built cross-chunk interface/impact pass and treat its absence as `incomplete`. Do not describe a per-chunk map-reduce as the same judgement.
likelihood: unknown.
evidence: `references/integrator.md:3-4,45-50` (cross-ticket coherence and emergent violations); ADR-022 `:33` "The integrator keeps judging the full combined phase diff as the architectural interaction check" and `:48` (accepted); PROBLEM.md scope fence "Changing what integrator/arch-review judge … beyond how the evidence reaches them".
what bites: chunk boundaries cut across tickets; a defect that needs two chunks is judged by nobody, and the change may exceed the scope fence.

### Group B — reviewer tools, sandbox and host mechanics

## R-7 — The Claude child cannot read host-prepared inputs (or run git against the linked worktree) under its current settings
severity: high
mitigation: Run SP-1 before any option that depends on tool reading on Claude. If blocked, the choices are inline chunks (no tool read), host inputs placed inside the worktree on a new allow-listed, host-hashed read-only scratch path (touches `conveyor-scratch.cjs`, `assertEvidenceOnlyChanges`, the immutability model), or a changed permission profile (a producer-file change, R-13).
likelihood: unknown. The settings block reads outside the working directory (F11) and the immutability design requires inputs outside the writable tree (`outsideWriter`), which are in direct tension; no live test covers it, and this session's own run-time-path denial shows the block applies to Bash too (section 0).
evidence: F11.
what bites: the focused file relay that Claude arch-review already uses above 1 MiB may not work for a real child; any new option that points the child at host files inherits the unknown. READ_ONLY_TOOLS contains Write but no Bash, so a "read-only" profile cannot run `git diff` and must read host-built files.

## R-8 — Tool-driven reviewers trip the worktree-mutation guard after paying
severity: medium
mitigation: Give the reviewer a host-owned scratch location (not model-chosen paths) or a tool profile without Write/Edit where possible; test that `git diff` or `git show` inside the child sandbox leaves `git status` clean for a linked worktree (SP-1).
likelihood: unknown. Both Bash and Write/Edit are allowed to the child (F11); any scratch file, patch or notes file it creates under the worktree aborts the run with `WORKTREE_MUTATED` after the model work is spent.
evidence: F11 (`assertEvidenceOnlyChanges`, fixed scratch list).

## R-9 — A reviewer-run `git diff` is not the host-built diff
severity: medium
mitigation: The host builds the exact bytes (it already uses `--no-ext-diff --no-textconv`), digests them and gives the reviewer those bytes; the reviewer does not generate the diff.
likelihood: unknown. A model-run command is subject to repository attributes and git configuration that the host's fixed flags avoid; coverage proof by digest is lost when the reviewer generates its own bytes.
evidence: F2, F3 (host flags); reviewer tools F11.

## R-10 — Tool-reading cost and latency are unmeasured and unbounded
severity: medium
mitigation: Add a host-enforced step budget and deadline for review launches; measure spend and wall time on a real large epic before adopting any option.
likelihood: unknown. Known amplifiers: Codex pays twice (capacity-measurement launch, then the review, F5); no child deadline found (F11); there is no tracked baseline — the journal holds only three `integrator` rows, all from September 8 for epics 25–26, and none for epics 36–50 (C30; same gap INV-010 recorded as its F8).
evidence: F5, F11, C30. API list prices in the repository audit (`docs/audits/2026-09-30-model-ladder-refresh.md:45-59`) are rates, not task costs; no number is derived here.
what bites: a slow or stuck reviewer blocks `/shipyard:deliver` indefinitely; a "free" per-chunk design multiplies launches.

## R-11 — Evidence-size ceilings fail the run after spend
severity: medium
mitigation: Budget records and bytes per MB read (SP-4) and design chunk size so the transcript stays far below the caps; fail early on a projected overrun, not after the model finished.
likelihood: unknown.
evidence: Claude: session transcript ≤ 50 MiB (`claude-runtime-host.cjs:508,641`), ≤ 20,000 records at verification (`role-artifact.cjs:3214`), 128 MiB read cap (`:3208`), telemetry reader 4 MiB (`claude-role-host.cjs:48,1361`, non-fatal). Codex: 128 MiB transcript (`codex-arch-review-context.cjs:19`), 200,000 records (`codex-runtime-host.cjs:299`).
what bites: every tool result is a transcript record; a reviewer that reads in many small ranges or explores with `Grep` can exceed 20,000 records without exceeding the model window.

## R-12 — Codex compaction rejection
severity: high
mitigation: Keep each Codex session's input below its measured compaction trigger (SP-4); never design for "read until the window is nearly full".
likelihood: unknown.
evidence: F12 (`codex-runtime-host.cjs:1529-1531`).
what bites: a reviewer that triggers auto-compaction produces a transcript the host rejects, and the only recovery path is an authenticated handoff or a full restart.

### Group C — contracts, receipts, rollout

## R-13 — Contract-version drift and verifier skew between hosts and installs
severity: high
mitigation: Introduce a new contract identifier rather than redefining v1/v2/focused.v1; ship a verifier that reads both generations before any producer emits the new one; announce that open PRs re-owe review; keep one authority per contract in `role-artifact.cjs`.
likelihood: observed mechanism (code reading). Producer and verifier compare file digests: the verifier re-hashes the 11 producer files and the role instructions against the pins inside the original packet (F9), so **any** edit to `claude-role-host.cjs`, `claude-runtime-host.cjs`, `claude-dispatch-adapter.cjs`, `claude-reference-content.cjs`, `context-packet.cjs`, `codex-arch-review-context.cjs`, `role-artifact.cjs`, `model-policy*.cjs`, `architecture-target.cjs`, `dispatch-boundary.cjs`, or to `references/arch-review.md` / `integrator.md`, invalidates every previously sealed Claude focused verdict at verification time (`focused producer source changed` / `focused role instructions changed`). A verifier from one install (source, installed bundle, mirror) verifying a verdict made by another fails the same way.
evidence: F3, F4, F5 (five distinct paths for two roles: Claude inline integrator, Codex file integrator, Claude focused arch-review inline or relay, Codex focused arch-review, Codex legacy arch-review), F9; unknown versions refuse before launch (`claude-role-host.cjs:96`; `codex-delivery-host.cjs:120,984`; `commands/deliver.md:2934`). Not executed.
what bites: fixing one path leaves the other four on the old behaviour; upgrading the host re-owes every in-flight review; hosts disagree about which contract a sealed verdict used.

## R-14 — A new packet or ledger collides with the authority-key scan
severity: medium
mitigation: Fix or relocate the roster `receipt` record (F19) and choose ledger field names that avoid `AUTHORITY_KEYS` (`model`, `effort`, `reasoning_effort`, `model_reasoning_effort`, `capabilities`, `supportedModels`, `supportedEfforts`, `supportedSelections`, `agent`, `agents`, `callback`, `callbacks`, `launch`, `launchOptions`, `selection`, `resolution`, `receipt`, `applicationEvidence`) at any depth, or carry such data outside `buildContextPacket`.
likelihood: observed. The scan already blocks every phase arch-review on Claude with a non-empty roster (F19), and per-chunk ledgers naturally want `receipt`, `selection` or `launch` keys.
evidence: F19. The scan reads key names only, on the raw packet before semantic encoding (`context-packet.cjs:455,523`; encoding is applied later at `:659-706`), so it also sees keys nested under `role_context`. The Codex path does not collide only because it never calls `buildContextPacket` (`codex-arch-review-context.cjs:1168-1178`), not because the key is allowed there.

## R-15 — One launch, one receipt versus per-chunk launches
severity: high
mitigation: If any option uses more than one launch per role, define the receipt chain first: a receipt per chunk session (resolve → validate → launch → receipt each), an aggregator receipt that binds the chunk receipts by digest, and a verifier that checks the chain; do not weaken the single-launch invariant by accident.
likelihood: unknown; applies only to map-reduce and per-unit options.
evidence: F10; ADR-014 grids and receipts are out of scope to change (PROBLEM.md). Touching `claude-dispatch-adapter.cjs` or `runtime-adapters.cjs` requires `make refresh-runtime-digests` and the `Runtime-Digest-Refresh:` trailer (CLAUDE.md:136; `.github/workflows/test.yml:106-108`; the pin lists exactly those two files, C31).
what bites: N+1 dispatches, N+1 inflight records and N+1 tracked-graph rewrites (`dispatches.json`, `delivery-front.json`, F21), each followed by the dirty-tree check `review worktree has local changes`; a live PR or base move during a long multi-launch run turns earlier chunk results stale (`revalidateLiveInputs` runs once before and once after a single launch, `claude-role-host.cjs:1157,1497`).

## R-16 — Stale or tampered per-chunk evidence
severity: medium
mitigation: Bind every chunk record to the exact head, base, merge-base, chunk digest and dispatch id; keep chunk inputs host-written, private (0700/0400), outside the child's writable tree and re-verified by identity (device, inode, size, mtime, ctime, uid, mode) before and after use, as the existing relay does; define resumption (reuse of a finished chunk across a restart) as an explicit authenticated operation or forbid it.
likelihood: unknown. The existing machinery (private 0400 files, identity re-check, HMAC-keyed authority state with the child denied read, `role-artifact.cjs:2456-2460,2482-2484`; `claude-runtime-host.cjs:756`) covers one input set; N chunk sets multiply the time-of-check/time-of-use windows and the replay surface.
evidence: `codex-arch-review-context.cjs:189-209,519-526,586-587`.

## R-17 — Mirror exclusion implemented in the shared classifier opens a gate hole
severity: high
mitigation: Add a **review-only** pathspec helper next to `productPathspec` and leave `isDevelopmentArtifact` and its consumers unchanged; pin both with tests (the existing `tests/unit/development-artifacts.test.cjs` pins process metadata only).
likelihood: plausible if the one-line change `PREFIXES += 'plugins/shipyard/'` is chosen because it is the obvious edit.
evidence: F17, F18. If `plugins/shipyard/` joined `PREFIXES`, a PR touching only the shipped package would become "development artifacts only": CI would skip unit shards, `publish-gate`, the digest-trailer check and `test-fast-rest` (`test.yml:60,70,96-111,121`), including the unit test that is the only freshness check (F18); `pr-hygiene` would exempt it; `reviewFreshness` would call an earlier approval fresh; the arch-review and integrator prompts would label it "context only" (`claude-role-host.cjs:888`). The mirror is what users install.

## R-18 — Mirror exclusion is partial, inconsistent, or hides what is not a copy
severity: medium
mitigation: Apply the exclusion in every place that builds the diff or its inventory (see list below), say so in the role instructions, and decide (user) whether the 9 non-copy files are reviewed or covered by a host-recorded parity proof (digest of `build()` output equals the tracked mirror) that enters the packet as evidence.
likelihood: observed mechanism. Sites that must change together: `claude-role-host.cjs:462/625` (via `productPathspec`), `:509` (arch-review diff, which has no pathspec), `:515`, `:538-539` (changed paths, name-status, numstat); `codex-arch-review-context.cjs:1093` (legacy mode only), `:1095`, `:1110`, `:1170-1171`, `:1185`; `focusedChangeInventory` classification (`:1451`); the v2 impact builder (`:2076-2087`, whole changed mirror files, F6); role instructions (`references/integrator.md:21` "The diff excludes `.planning/`"; `references/arch-review.md:73-74` "Judge the full current merge-base-to-head PR diff").
evidence: F3, F4, F6, F15.
what bites: if the diff drops the mirror but the change inventory still lists 27 mirror paths, an honest reviewer must declare them `unresolved_sources` and cannot return `complete` (arch-review) — the exclusion would produce non-passing verdicts. If the exclusion covers all 161 files, `hooks/hooks.json`, `.codex-plugin/plugin.json`, `package-build.json` and six skill stubs — behaviour-bearing files with no source file to review — are reviewed nowhere. Parity is checked only for non-epic/ticket bases (F18).

## R-19 — The stop-gap (exclude the mirror, shrink context) may not be enough, and its margin is unknown
severity: medium
mitigation: Treat the stop-gap as independent of the window question: do not ship it as the fix without SP-3 and a successful end-to-end run on an epic at least as large as phase 50 with a margin.
likelihood: unknown. **(arithmetic)** After removing the mirror the failed prompt would be about 2.0 MB (F16). Under the hypothesis of a 1M window and the upper-bound density of 2.65 bytes/token that is about 0.76M tokens (24% headroom, less at lower densities); under any smaller window it still does not fit. The largest earlier product diff, 1.79 MB, would be about 1.8 MB before plans and ADRs are added; `DIFF_MAX_BYTES` 2 MiB still refuses a 1.5× larger epic.
evidence: F14, F16. Tests pin the old shape: `--unified=50` (`tests/unit/phase49-review-continuation.test.cjs:1656`) and admission of a 1.9–2 MiB diff with an estimated-token overflow of `false` (`tests/unit/claude-role-host.test.cjs:1040-1052`). Shrinking context (`--unified=10` → 815,389 bytes without the mirror) cuts reviewer context and the role text assumes `--unified=50`.

## R-20 — Reviewers and operators have been relying on a refusal and a bypass
severity: medium
mitigation: Define the new behaviour for "cannot be fully covered" as an explicit, receipted outcome rather than a refusal or a partial pass; update the refusal remedies, docs and tests together; record in DECISIONS.md what verdicts a partially covered review may return.
likelihood: observed. Phase 50 merged with neither review on a human decision (C3); `gate-trailer.cjs` has no programmatic waiver (Grep for `override|waive|bypass` finds none, C32), so a bypass is a human merge outside the conveyor.
evidence: refusal text and remedies are pinned: `'role diff exceeds the bounded context packet'` (`claude-role-host.cjs:464,467`; `tests/unit/claude-role-host.test.cjs:1073-1084`), `remedy: split the phase` (`claude-role-host.cjs:833`; test `:1055-1071`), `CONTEXT_PACKET_OVER_BOUND` (`:899`; test `:167-170`). Docs promise v2 behaviour (`commands/deliver.md:2893-2944`; `references/arch-review.md:80-84`; `references/integrator.md:25-42`).
what bites: changing a refusal into a launch that may produce a partial review normalises merging on weaker evidence; leaving refusals normalises bypass.

## R-21 — Ownership and board collisions are not knowable from this checkout
severity: medium
mitigation: Ask the maintainer who owns each file before planning; do not rely on the local board.
likelihood: unknown.
evidence: F1. The stale board lists `T-50-17` (`claude-role-host.cjs`), `T-50-19` (`claude-runtime-host.cjs`), `T-50-27` and `T-50-29` (`codex-arch-review-context.cjs`), `T-50-01`/`T-50-14` (`codex-delivery-host.cjs`), `T-50-04/07/08/18` (`role-artifact.cjs`) as pending or open (C4). ADR-022 (accepted) already assigns changes to `claude-role-host.cjs` and the gate to other owners (`ADR-022:43`).

## R-22 — A tools-enabled reviewer reads untrusted diff content with Bash, Write and Edit available
severity: low
mitigation: Keep the "evidence data, not instructions" rule, prefer a profile without Bash/Edit where the design allows, and keep the post-run mutation guard. This is the same trust boundary as today's inline prompt but with more model turns after contact with hostile text.
likelihood: unknown. No network allow-list or excluded command is configured for the child (INV-007 `research/alternatives.md:41`, row C15; `claude-runtime-host.cjs:750-763` has neither), so this depends on the sandbox default.
evidence: F11; `claude-role-host.cjs:889` states the data-not-instructions rule.

## R-23 — The Claude and Codex paths diverge in what they pre-process
severity: medium
mitigation: Put the new delivery rule behind one shared helper that both hosts call, with a cross-host parity test that feeds the same fixture diff to both and compares the manifests.
likelihood: observed. Today the same pathspec is applied in some paths and not others (F3, F4), Codex does a capacity-measurement launch Claude does not (F5), and ADR-022 `:37` still names an identity-checking Codex arch-review host as a gap although `collect()` in `codex-arch-review-context.cjs` now checks live PR identity, base and worktree cleanliness before building the packet (`:1038-1049,1082-1088`; C8, C33).
evidence: F3, F4, F5.

## R-24 — Evidence figures in intake are partly irreproducible
severity: low
mitigation: Re-measure before they enter an ADR: the 25.7 MB / 1,523-file impact-source figure (not reproduced, U-14), the mirror "byte for byte (99,159 vs 99,247 B)" comparison (contradicted, F15), and the epic diff sizes (reproduced to within one byte, F16).
likelihood: observed.
evidence: F6, F15, F16.

## 3. Cross-cutting observations (not separate risks)

- **Two unrelated defects are prerequisites, one is a diagnostic gap.** The `receipt` key (F19) blocks every Claude phase arch-review with a non-empty roster whatever else changes. The unsurfaced stderr (F20) makes any new failure (per chunk, per tool) opaque. The fixed graph directory with tracked bookkeeping files (F21) multiplies per launch (R-15). Whether to fix them inside this work is OQ-9.
- **Which defects each option needs is not settled here.** That is for the alternatives line; this line only records that R-7 (child reads), R-14 (`receipt` key), R-15 (receipt chain) and R-13 (verifier branches) are the four mechanisms that would force them.
- **No code-level reason to keep v2 was found.** v2's graph build reads the whole repository (F6) and is the source of `CONTEXT_OVER_BOUND`; whether it is kept, replaced or retired is a user decision (OQ-3).

## 4. Measurements and spikes needed (recommendations only; none executed)

- **SP-1 (R-7, R-8, U-4).** `/gsd-spike "launch a real Claude role child with the exact claude-runtime-host settings in a linked worktree; confirm it can Read a host-written 0400 file outside the worktree, run git diff/show against the linked worktree, and leaves git status clean"`.
- **SP-2 (R-2, R-3, R-4).** `/gsd-spike "have a Claude child read a 2 MB host-built diff via Read, Bash and Grep; reconstruct the covered byte ranges from the stream-json tool_use/tool_result records; compare with ground truth, including long lines and the tool's truncation markers"`.
- **SP-3 (R-1, R-14, R-19, U-1, U-2, U-3).** `/gsd-spike "bisect the largest admissible packet for claude-sonnet-5-5, claude-opus-5-5 and gpt-6.1-sol with the real product authentication, on a prefix of the phase-50 integrator packet; record tokens per byte and the failure mode"`.
- **SP-4 (R-11, R-12, U-8, U-9).** `/gsd-spike "run a tool-reading Claude session and a Codex read-only session over a 1, 2 and 4 MB input; count transcript records and bytes per MB read and find where Codex auto-compaction first appears"`.
- **SP-5 (R-6).** `/gsd-spike "review phase 36, 45 and 50 diffs whole versus in host-built chunks with seeded cross-file defects; compare defect detection and verdict agreement"`.
- **SP-6 (R-13).** `/gsd-spike "change one byte in a focused producer file in a scratch copy and run currentArchitectureVerdict and gate-trailer verify on a previously sealed focused verdict to confirm the re-owe behaviour read in role-artifact.cjs:3268-3276"`.
- **Cheap checks (not spikes).** Reproduce the 25.7 MB figure at `f80dfea7` outside this sandbox (U-14); read branch protection for `main` (OQ-10).

## 5. Unknowns (draft for OPEN-QUESTIONS.md)

Each item has a checkbox and an owner. Items already in OPEN-QUESTIONS.md are cross-referenced, not duplicated.

- [ ] OQ-1 — What window did the failed phase-50 Claude integrator child actually have (model id and effort, rung, Claude Code version, any `[1m]` alias, gateway or pin), and what was its measured input token count at `prompt_too_long`? The audit says both Claude 5.5 models have native 1M on the direct API with caveats (F13), yet a 2,647,625-byte prompt was refused (F14). — owner: operator who captured the transcript (private state is outside this line's read scope); next check: the child transcript and `first_response_usage` for that dispatch.
- [ ] OQ-2 — What is the real tokens-per-byte of the combined-diff packet (code plus JSON-escaped diff) on Claude and on Codex? The host assumes 4 bytes/token (`claude-role-host.cjs:910`); the refusal bounds it at 2.65 or lower only under a 1M-window hypothesis. — owner: research; next check: SP-3.
- [ ] OQ-3 — What is the Codex context window for `gpt-6.1-sol` under ChatGPT-authenticated Codex? The API lists 1,050,000; the audit says not to apply API terms without a matching product contract (F13). — owner: repository operator; next check: product contract or a measured bisect (SP-3).
- [ ] OQ-4 — Can a real Claude role child read a host-prepared file outside its worktree and run `git diff` / `git show` against a linked worktree under the current sandbox and permission settings? No live test exists (F11). — owner: delivery-pipeline maintainer; next check: SP-1.
- [ ] OQ-5 — What does the host accept as proof of coverage when the reviewer reads with tools (transcript-derived ranges, per-chunk receipts, deterministic checksums), and is a model-declared `complete` ever sufficient? Today it is sufficient for architecture review (F7). — owner: user, after SP-2.
- [ ] OQ-6 — What verdict may an incompletely covered review return? Architecture review has `incomplete` (cannot grant `conform`); the integrator has no completeness field, so "incomplete" does not exist for it (F8). Which of `passed`, `needs-fix`, `human-review-required` is allowed, and who is told? — owner: user.
- [ ] OQ-7 — Is excluding the mirror required for all 161 tracked files or only the 152 byte-identical copies, and who reviews the 9 non-copy files (`hooks/hooks.json`, `.codex-plugin/plugin.json`, `package-build.json`, six skill stubs) or accepts a host-recorded parity proof instead (R-18)? — owner: user.
- [ ] OQ-8 — Should the exclusion be a new review-only pathspec or an edit of the shared `PREFIXES` classifier, given its CI, hygiene, freshness and comment-policy consumers (F17, R-17)? — owner: user with the delivery-pipeline maintainer.
- [ ] OQ-9 — Fix the three intake defects (roster `receipt`, unsurfaced stderr, fixed graph directory) inside this work or separately? (Duplicates OPEN-QUESTIONS.md item 5; evidence is in F19–F21.) — owner: user.
- [ ] OQ-10 — Is the unit job (which holds the only mirror-parity check) a required check on `main`, and what let PR #521 merge without integrator or arch-review? Branch protection was not queried (no GitHub access from this line). — owner: repository operator.
- [ ] OQ-11 — Who owns edits to `claude-role-host.cjs`, `claude-runtime-host.cjs`, `codex-arch-review-context.cjs`, `codex-delivery-host.cjs` and `role-artifact.cjs` now? The local board lists phase-50 tickets pending although the epic is on `origin/main` (F1, R-21). — owner: delivery-pipeline maintainer.
- [ ] OQ-12 — Does the change need a new contract identifier (integration-review v3, architecture-review v3 or focused v2), and for how long must historical sealed v1/v2/focused.v1 verdicts stay verifiable after the producer files change (R-13)? (Overlaps OPEN-QUESTIONS.md item 3.) — owner: user.
- [ ] OQ-13 — What wall-clock and spend ceiling is acceptable for a large-epic review? No child deadline exists today (F11) and no baseline is tracked (R-10). — owner: repository operator.
- [ ] OQ-14 — How should EVIDENCE.md's "impact sources 25.7 MB / 1,523 files" be reproduced (what is counted: files in the dependency closure, inventory entries, bytes read for graph building)? This line measured 449 JS/TS files and 14.8 MB at `HEAD` (C27), and its re-measurement at the epic head was blocked (section 0). Also correct the mirror comparison in EVIDENCE.md (F15). — owner: system-state research line / operator.
- [ ] OQ-15 — How many transcript records and bytes does a tool-reading Claude or Codex review produce per MB read, relative to the 20,000-record, 50 MiB, 128 MiB and 200,000-record caps (R-11)? — owner: research; next check: SP-4.
- [ ] OQ-16 — At what input size does a Codex read-only reviewer session first compact (R-12)? — owner: research; next check: SP-4.
- [ ] OQ-17 — Which other consumers of the epic diff have size limits that this line did not enumerate (for example the `gate-trailer` patch-id path at `gate-trailer.cjs:647-653`, `comment-policy.cjs:367`, `pr-hygiene`)? Only reviewers were traced. — owner: system-state research line.
- [ ] OQ-18 — Is the 250,000-token window threshold and its stated premise ("largest input about 52k tokens", `capability.json:94`) still the intended promotion rule, given a 640k-token estimated packet and no Fable rung for the integrator by default? — owner: user (ADR-014 amendment is out of scope for this INV; recorded only because it changes which model reviews a large epic).

## 6. Sources

**Read in this checkout (all at `1c34583b`):** `PROBLEM.md`, `EVIDENCE.md`, `OPEN-QUESTIONS.md`, `OPTIONS.md`, `RESEARCH.md`, `RISKS.md`, `RESEARCH-CONTRACT.md`, `DECISIONS.md` of this investigation; `plugins/delivery-pipeline/scripts/claude-role-host.cjs` (1–1664), `claude-runtime-host.cjs` (20–60, 740–890, greps), `codex-arch-review-context.cjs` (100–130, 186–231, 256–600, 740–830, 986–1230, 1380–1545, 1925–2135), `codex-delivery-host.cjs` (740–1030, 2975–3035, greps), `codex-runtime-host.cjs` (1500–1560, greps), `context-packet.cjs` (19–60, 190–210, 655–764, greps), `role-artifact.cjs` (2436–2510, 2620–2650, 3150–3340, 3405–3610, 3860–3890, greps), `development-artifacts.cjs`, `conveyor-scratch.cjs`, `gate-trailer.cjs` (625–665, greps), `model-policy-internal.cjs` and `pipeline-config.cjs` (greps); `references/integrator.md` (1–140), `references/arch-review.md` (1–130); `commands/deliver.md` (2870–2959); `CLAUDE.md`; `.github/workflows/test.yml` (40–140); `.github/actions/scope/action.yml` (grep); `scripts/package-shipyard-codex.cjs` (55–78), `scripts/refresh-runtime-digests.cjs`, `scripts/check-runtime-digest-trailer.cjs`; `tests/unit/claude-role-host.test.cjs` (120–190, 600–650, 1040–1090, 1385–1500), `tests/unit/claude-runtime-host.test.cjs` (245–265), `tests/unit/development-artifacts.test.cjs`, `tests/unit/marketplace-install.test.cjs` (14–105), `tests/unit/runtime-file-digests.json`, `tests/smoke/claude-delivery-roles-smoke.sh` (grep); `docs/audits/2026-09-30-model-ladder-refresh.md` (30–75); `capabilities/delivery-pipeline/capability.json` (84–98); `.planning/architecture/ADR-022-review-stage-efficiency.md`; prior `INV-010-review-stage-efficiency/{research/risks.md, DECISIONS.md}`, `INV-017-.../research/risks.md` (25–50) and `INV-007-.../research/system-state.md` (155–180) and `INV-007-.../research/alternatives.md` (grep hit at line 41) for format and prior findings; `.planning/graph/delivery-log.jsonl` (greps), `tickets.json` and `delivery-state.json` (node summaries).

**External claims and where they come from:** the 1M window, Sol 6.1 1,050,000 context and price rates are quoted from `docs/audits/2026-09-30-model-ladder-refresh.md` (which cites vendor pages); this line did not re-fetch them. The Read tool "2000 lines by default" statement comes from the tool definition shown in this research session, not from a repository file, and is an assumption for the role child's Claude Code build (R-3).

**Not read:** GitHub (no access), `~/.local/state/shipyard/**`, the installed bundles, the failed phase-50 transcript and prompt capture, the other worktrees, `plugins/delivery-pipeline/scripts/phase-integrator-preflight.cjs`, `sentinel.cjs`, `dispatch-record.cjs` internals, `codex-agent.cjs`, Codex runtime-host reader internals beyond the cited lines (those belong to the system-state line).

## 7. Verification ledger (exact commands)

Tool calls are written as `Tool(args)`. Paths are under `/Volumes/KINGSTON/.wt-claude-shipyard/inv-019` unless absolute.

| ID | Command | Result |
|---|---|---|
| C1 | `git rev-parse HEAD` (run in the worktree) | `1c34583b1aedbffe75d9deeff49de9069237e5aa` |
| C2 | `git -C … branch --contains 92453193 --all`; `git status --short` | branch list: `* inv/019-review-without-diff-embedding`, `remotes/origin/HEAD -> origin/main`, `remotes/origin/main`, `remotes/origin/release/0.73.0`; status: ` M .planning/graph/delivery-front.json`, ` M .planning/graph/dispatches.json`, `?? .planning/investigations/INV-019-review-diff-size-independence/` |
| C3 | `git -C … log -1 --format=%B 92453193` | message: "Integrator and arch-review were not run for this epic: the Claude integrator packet exceeds the model context window and the phase arch-review packet is refused by the context-packet authority check. Merged on the human's explicit decision." |
| C4 | `node -e` over `.planning/graph/tickets.json` and `delivery-state.json` (phase 50 status counts; open tickets touching the review files); `wc -l` of seven source files | `{"pending":25,"pr-open":4}`; ten non-merged tickets touch the review files (T-50-01/04/07/08/14/17/18/19/27/29); lines: claude-role-host 1664, codex-arch-review-context 2251, codex-delivery-host 3734, context-packet 764, role-artifact 6465, development-artifacts 34, phase-integrator-preflight 289 |
| C5 | `Grep "DIFF_MAX_BYTES\|INTEGRATOR_MAX_PACKET_TOKENS\|PROMPT_MAX_BYTES\|READ_ONLY_TOOLS\|ALLOWED_TOOLS\|--unified" plugins/delivery-pipeline/scripts` | `claude-role-host.cjs:34,35,40,462,467,509,515,538,539,828,897,901`; `claude-runtime-host.cjs:34,35,402,781,782`; `codex-arch-review-context.cjs:1093,1185`; `comment-policy.cjs:367` |
| C6 | `Read claude-role-host.cjs` ranges 1–140, 440–770, 770–1190, 1189–1664; `Read tests/unit/claude-role-host.test.cjs` 120–190, 600–650, 1040–1090, 1385–1500 | constants, `diffText`, `prepareArch`, `prepareIntegrator`, `makePrompt`, `buildBoundary`, `assertEvidenceOnlyChanges`, `run` as cited |
| C7 | `Read plugins/delivery-pipeline/scripts/development-artifacts.cjs` | `PREFIXES = ['.planning/','.shipyard/','.shipyard-','docs/audits/']`, `FILES = ['AGENTS.md','CLAUDE.md']`; `productPathspec()` excludes those only |
| C8 | `Read codex-arch-review-context.cjs` 986–1230 | `legacy` flag and pathspec use at 1091–1093; no mirror exclusion |
| C9 | `Read codex-delivery-host.cjs` 740–1030, 2975–3035; `Grep "integration-review\|prepareIntegrationLineage\|…" codex-delivery-host.cjs` | v2 lineage preparation, coverage validation, consumption checks, capacity measurement at 2997 |
| C10 | `Read codex-arch-review-context.cjs` 100–130, 256–600, 740–830 | `FILE_LIMITS`, reader batches, `prepareFileInput`, `preflightReviewMaterial` |
| C11 | `Read codex-arch-review-context.cjs` 1380–1545; `Read references/arch-review.md` 1–130 | `validateFocusedResult` 1389–1405; reference text 70–124 |
| C12 | `Grep "review_completeness\|focused-architecture\|FOCUSED_CONTRACT\|limitations" plugins/delivery-pipeline/scripts` (gate-trailer, role-artifact, host files) and `…/references` | `role-artifact.cjs:3278,3314,3878-3879`; no `review_completeness` in `gate-trailer.cjs` or the integrator schema |
| C13 | `Read references/integrator.md` 1–140 | v2 coverage echo text 113–122 |
| C14 | `Read role-artifact.cjs` 3150–3340, 3405–3610 | `authenticateCurrentCoverage`, `originalInlinePacket`, `authenticateInlineCoverage` |
| C15 | `Read role-artifact.cjs` 3860–3890; `Grep "TRANSCRIPT_MAX_BYTES\|…" claude-runtime-host.cjs` | verdict filter 3878–3879; 50 MiB at `claude-runtime-host.cjs:33,508,641` |
| C16 | `Read CLAUDE.md` | boundary rule at line 97; digest-pin rule at 136; mirror rule at 81–84 |
| C17 | `Read claude-runtime-host.cjs` 20–60, 740–890; `Grep "TRANSCRIPT_MAX_BYTES\|blockReadsOutsideWorkingDirectories\|additionalDirectories\|add-dir\|timeout\|TIMEOUT" claude-runtime-host.cjs` | tools and sandbox settings 750–792; exit handling 841–842; `timeout` matches at 31, 190, 199, 213, 494, 776 only |
| C18 | `Read tests/unit/claude-runtime-host.test.cjs` 245–265; `Read conveyor-scratch.cjs` 1–80; `Grep "timeout\|stale_after\|heartbeat" run-controller.cjs` | pinned tool string and read block; scratch list of seven files and one directory; lease TTL fields exist (semantics not read) |
| C19 | `Read codex-runtime-host.cjs` 1500–1560; `Grep "--sandbox\|sandbox_mode\|read-only\|…" codex-runtime-host.cjs codex-delivery-host.cjs` | compaction rejection 1529–1531; sandbox `read-only` sites |
| C20 | `Grep "context[_-]?window\|window_threshold\|…" plugins/delivery-pipeline`; `Read model-policy-internal.cjs` via `Grep WINDOW_THRESHOLD_TOKENS` | `WINDOW_THRESHOLD_TOKENS = 250000` at line 40 |
| C21 | `Read docs/audits/2026-09-30-model-ladder-refresh.md` 30–75; `Read capabilities/delivery-pipeline/capability.json` 84–98 | lines 41 and 63; capability description line 94 |
| C22 | `node -e` (script A below): measure mirror vs source | `{"total":161,"byte_identical":152,"differs":0,"no_source_file":9,"bytes":{"same":4799701,"other":9245}}`; the 9 are `.codex-plugin/plugin.json 924`, `hooks/hooks.json 336`, `package-build.json 300`, six `skills/shipyard-*/SKILL.md` 1150–1618 |
| C23 | `wc -c plugins/delivery-pipeline/scripts/role-artifact.cjs plugins/shipyard/host/plugins/delivery-pipeline/scripts/role-artifact.cjs`; `cmp …/claude-role-host.cjs plugins/shipyard/host/plugins/delivery-pipeline/scripts/claude-role-host.cjs` | `380159` and `380159`; `cmp` exit 0, no output |
| C24 | `node -e` (script B below): epic diff sizes at `be7ab4f3...f80dfea7` | `{"merge_base":"be7ab4f3407b017a50e9fe2a49bf54e22e7d3202","product_u50":2043597,"product_nomirror_u50":1400771,"product_u10":1089711,"product_nomirror_u10":815389,"product_u3":870339,"product_nomirror_u3":679800,"product_u0":743885,"product_nomirror_u0":604258,"files_total":236,"files_mirror":27}` |
| C25 | `Grep "isDevelopmentArtifact\|productPathspec\|changedProductPaths\|development-artifacts" plugins/delivery-pipeline scripts capabilities .github Makefile` | consumers as listed in F17 |
| C26 | `Read .github/workflows/test.yml` 40–140; `Read .github/actions/scope/action.yml` (via C25 grep, line 20) | `product_changes` gates unit shards, publish gate, digest trailer, `make test-fast-rest` |
| C27 | `node -e` (script C below): JS/TS blobs at `HEAD` | `{"js_ts_files_at_HEAD":449,"bytes":14823120,"in_mirror":{"files":124,"bytes":4272898},"unique_blobs":325,"unique_bytes":10550222}` |
| C28 | `Read tests/unit/marketplace-install.test.cjs` 14–105; `Read scripts/package-shipyard-codex.cjs` 55–78; `Grep packageFreshnessRequired` over `scripts tests plugins/delivery-pipeline Makefile .github` | `assertPackageForBase` at line 97; `packageFreshnessRequired` at 71–74; consumers in two unit tests |
| C29 | `Read context-packet.cjs` 28–60, 190–210; `Read role-artifact.cjs` 2436–2510, 2620–2650; `Grep "registerPhaseArchiveRoster\|phase_archive_selection" tests` and `…/claude-role-host.test.cjs` with context | `AUTHORITY_KEYS` 34–39; roster record carries `receipt` 2450–2452; test at `claude-role-host.test.cjs:619` registers `{ rows: [] }` |
| C30 | `Grep '"event":"(arch_review\|dispatch\|integrator)"' .planning/graph/delivery-log.jsonl` (count); `Grep '"event":"integrator"' …` | 474 matches overall, 46 `arch_review`; the `integrator` rows are lines 542, 552, 574 (epics 25, 26, 2026-09-08) |
| C31 | `node -e` printing `Object.keys(require('tests/unit/runtime-file-digests.json').files)` | `["plugins/delivery-pipeline/scripts/claude-dispatch-adapter.cjs","plugins/delivery-pipeline/scripts/runtime-adapters.cjs"]` |
| C32 | `Grep "function verifyArchitectureTarget\|override\|waive\|bypass\|human" plugins/delivery-pipeline/scripts/gate-trailer.cjs` | only `verifyArchitectureTarget` at 242 and a comment at 690 |
| C33 | `Read .planning/architecture/ADR-022-review-stage-efficiency.md` 1–60; `Read codex-arch-review-context.cjs` 986–1230 (C8) | ADR lines 33, 37, 48; `collect()` checks live PR identity, base freshness and a clean worktree at `:1038-1049,1082-1088` |
| C34 | blocked: `node -e` measuring JS/TS corpus at `be7ab4f3` and `f80dfea7` | denied (run-time-computed path); not retried |

**Script A (C22)** — `node -e` run in the worktree:
```
const fs=require('fs'),path=require('path'),cp=require('child_process');
const root='/Volumes/KINGSTON/.wt-claude-shipyard/inv-019';
const files=cp.execFileSync('git',['-C',root,'ls-files','plugins/shipyard'],{encoding:'utf8'}).split('\n').filter(Boolean);
let same=0,diff=[],nosrc=[],bytes={same:0,other:0};
for(const f of files){
  const rel=f.slice('plugins/shipyard/'.length);
  let src=null;
  if(rel.startsWith('host/plugins/delivery-pipeline/'))src='plugins/delivery-pipeline/'+rel.slice('host/plugins/delivery-pipeline/'.length);
  else if(rel.startsWith('host/capabilities/'))src=rel.slice('host/'.length);
  else if(rel.startsWith('host/scripts/'))src='scripts/'+rel.slice('host/scripts/'.length);
  const size=fs.statSync(path.join(root,f)).size;
  if(!src||!fs.existsSync(path.join(root,src))){nosrc.push(rel+' '+size);bytes.other+=size;continue;}
  if(fs.readFileSync(path.join(root,f)).equals(fs.readFileSync(path.join(root,src)))){same++;bytes.same+=size;}else{diff.push(rel+' '+size);bytes.other+=size;}
}
console.log(JSON.stringify({total:files.length,byte_identical:same,differs:diff.length,no_source_file:nosrc.length,bytes}));
```

**Script B (C24)**:
```
const cp=require('child_process');const R='/Volumes/KINGSTON/.wt-claude-shipyard/inv-019';
const g=a=>cp.execFileSync('git',['-C',R,...a],{encoding:'utf8',maxBuffer:1<<29});
const mb=g(['merge-base','be7ab4f3','f80dfea7']).trim();
const ex=[':(exclude).planning',':(exclude).shipyard',':(exclude).shipyard-*',':(exclude)docs/audits',':(exclude)AGENTS.md',':(exclude)CLAUDE.md'];
const mirror=':(exclude)plugins/shipyard';
const size=(u,extra)=>Buffer.byteLength(g(['diff','--no-ext-diff','--unified='+u,mb+'...f80dfea7','--','.',...ex,...extra]));
// for u in 50,10,3,0: product_u<u> = size(u,[]); product_nomirror_u<u> = size(u,[mirror]);
// files_total / files_mirror from `git diff --name-only --no-renames -z mb...f80dfea7`
```
The exclusion list reproduces `productPathspec()` (`development-artifacts.cjs:16-19`) so the first number matches EVIDENCE.md within one byte.

**Script C (C27)**: `git -C <worktree> ls-tree -r -l HEAD`, keep entries ending `.cjs|.mjs|.js|.ts|.tsx|.jsx`, sum sizes, count those under `plugins/shipyard/`, and count unique blob ids and their bytes.

## 8. Drafts handed to the command

- **RISKS.md draft:** section 2, in the template's `## <risk> / severity / mitigation` form (extra `likelihood` / `evidence` / `what bites` lines follow the three required ones).
- **OPEN-QUESTIONS.md draft:** section 5 (OQ-1 … OQ-18); OQ-9 and OQ-12 overlap existing items 5 and 3 and should be merged, not duplicated.
- **Spike list:** section 4 (SP-1 … SP-6); none executed.
