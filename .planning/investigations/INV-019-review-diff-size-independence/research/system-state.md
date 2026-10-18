# INV-019 — Line 1: system state

How the `integrator` and `arch-review` roles receive the diff and its surrounding material TODAY, on the Claude and Codex hosts, and what the host verifies afterwards.

## 0. Identity, method and limits of this artifact

| Item | Value |
|---|---|
| Investigation | `INV-019-review-diff-size-independence`, line `system-state` |
| Source revision | `1c34583b1aedbffe75d9deeff49de9069237e5aa` (`git rev-parse HEAD`, branch `inv/019-review-without-diff-embedding`) |
| Policy hash | `3978b08721ef8f2381aa1f31355c9fef1dafd4058a2093b4a5f06ee90cd44570` (ADR-014 `adr-014.v7`) |
| Policy signals (preserved as given) | `{}` |
| Research model | `claude-sonnet-5-5`, effort `xhigh` (selection resolved by the caller) |
| Read-only | Product code was not modified. The only file written is this artifact. `git status --short` at the end showed the same three entries as at the start: ` M .planning/graph/delivery-front.json`, ` M .planning/graph/dispatches.json`, `?? .planning/investigations/INV-019-review-diff-size-independence/` (the first two were already modified when this worker started; they are not mine). |
| `.planning/codebase/` map | Absent (`ls .planning/codebase` → `No such file or directory`), so all tracing is from source. |

Conventions: `path:line` refers to the tree at `1c34583b`. "Verified" means a command or a source read named in §13 supports it. Claims I derived by arithmetic from code, or inferred, are labelled **derived** or **inference**. Things I could not check are listed in §12 as unknowns with the next check.

What I deliberately did **not** do:
- No live model launch, no live `gh` call, no write to `~/.local/state/shipyard/` (evidence/authority stores untouched). Tests were run with `HOME` pointed at a scratch directory under `$TMPDIR`.
- I did not inspect the operator's installed Codex agents (`~/.codex/agents`) or installed Claude plugin: one `ls ~/.codex/agents` was refused by the session's permission layer ("requires approval, no approval surface"). I did not retry or work around it; the installed-agent facts below come from the repository generator (`gsd-tune.cjs`), not from an installed copy.
- I did not re-measure the 2.65 MB prompt (EVIDENCE.md says that need not be repeated). I did reproduce the diff composition from git (§8.2) because it was cheap and it corroborates the evidence.

## 1. Summary (twelve facts)

1. **The code under investigation is deployed code, not an absence.** The v2 integration contract, the focused architecture contract and the `DIFF_MAX_BYTES` embedding all landed in `c7633d9e` ("feat: streamline architecture review and phase delivery (#456)"), which is contained in tags `v0.72.0`…`v0.73.0`; `HEAD` is the tip of `origin/main`; the generated mirror copies of the review scripts are byte-identical to the canonical ones. The phase-50 failures are real limits/defects. (§2)
2. **Four review paths, three different "how the model gets the diff" mechanisms.** Claude integrator = whole combined diff inline in the stdin prompt. Claude arch-review = diff inline, switching to a host-owned file relay when the prompt exceeds 1 MiB. Codex integrator and Codex arch-review = prompt for ≤1 MiB, otherwise host-owned files read by the model through `exec_command`. (§4–§5)
3. **The host-side limits are fixed constants that carry no knowledge of the model window.** The window itself is not recorded anywhere in the repo: the only "window" quantity is `WINDOW_THRESHOLD_TOKENS = 250000`, a routing signal that promotes the model rung (`model-policy-internal.cjs:40`). The only observed enforcement of the real window is the child's own refusal (`prompt_too_long`). (§3, §12)
4. **The Claude host admits prompts the model refuses.** `INTEGRATOR_MAX_PACKET_TOKENS = 750000` (`claude-role-host.cjs:40`) and `PROMPT_MAX_BYTES = 3000000` (`:35`) are fixed numbers; the host has no knowledge of the model's real window and does not surface the child's stderr (`claude-runtime-host.cjs:842` keeps stderr in `details`, `claude-role-host.cjs:1659-1662` prints only `error.message`). (§5.A)
5. **Claude judgement roles are not tool-restricted to read-only.** They launch with `Bash,Read,Edit,Write,Glob,Grep` inside a sandbox that allows writes to the whole worktree; "read-only" is enforced after the fact by `assertEvidenceOnlyChanges`. `READ_ONLY_TOOLS` is used only for the read-only smoke. The `deliver.md` sentence about a "read-only profile" does not match the code. (§5.A, §11)
6. **Only one of the four paths has host-verified proof that the reviewer read the material:** the Codex full-reader transport (v3 batch reader), through the native session transcript and `shipyard.native-file-consumption.v3`. The focused architecture contract (both runtimes) and the Claude inline path have **no** read proof; completeness there is the reviewer's own declaration (`review_completeness`), refused as authority only when it says `incomplete`. (§7)
7. **v2 "inherited trust" works only for Codex.** `prepareIntegrationLineage` forces `mode: 'full'` for any non-Codex original runtime (`codex-delivery-host.cjs:807-809`). On both runtimes the v2 builder first runs the v1 preparation, so the 2 MiB `DIFF_MAX_BYTES` still gates v2 (`claude-role-host.cjs:625`, called from `prepareIntegratorContext`, which `codex-delivery-host.cjs:1002` also uses). (§6)
8. **The v2 impact builder's material is repository-sized, not diff-sized.** `buildReviewImpactPacket` reads every `.cjs/.mjs/.js/.ts/.tsx/.jsx` blob of both endpoint trees (`codex-arch-review-context.cjs:2006-2027`); at HEAD that is 449 files / 14,823,120 B (325 files / 10,550,222 B without the mirror), against `FILE_LIMITS.material` = 16 MiB. The exact 25.7 MB figure from EVIDENCE.md is not reproduced by my accounting (§6.3). (§6)
9. **The generated mirror enters every review diff.** `productPathspec()` excludes only `.planning/`, `.shipyard/`, `.shipyard-*`, `docs/audits/`, `AGENTS.md`, `CLAUDE.md` (`development-artifacts.cjs:5-19`). Claude arch-review and Codex focused arch-review use **no** pathspec at all, so they also carry `.planning/**`. Reproduced on the epic-50 squash commit: 643 KB of 2.04 MB is `plugins/shipyard`. (§8)
10. **The mirror cannot be excluded by adding it to `PREFIXES`.** `isDevelopmentArtifact()`/`productPathspec()` also drive CI "product change scope" (`.github/actions/scope/action.yml` → `development-artifacts.cjs`), `scope-gate`, `pr-hygiene`, `reviewers`, `comment-policy`; marking `plugins/shipyard/**` as a development artifact would make a mirror-only PR look "development only" and skip the CI product jobs. A separate review-diff pathspec is needed. (§8.3)
11. **Phase arch-review on the Claude host fails before launch for a reproducible reason:** `registerPhaseArchiveRoster` stores `receipt` in each roster record (`role-artifact.cjs:2451`), `selectPhaseArchives` returns those records as `selection` (`:2628-2629`), the Claude host copies it into `role_context.phase_archive_selection` (`claude-role-host.cjs:549`), and `rejectAuthorityKeys` forbids the key `receipt` anywhere in a packet (`context-packet.cjs:34-39, 196-205, 455, 523`). I reproduced the refusal with a direct `buildContextPacket` call (§9.1). The Codex path puts the same selection into its own packet but never runs `rejectAuthorityKeys` (by reading).
12. **Existing tests pin the current inline behaviour** (2 MiB diff bound, 3,000,000-byte prompt bound, token-bound refusal, focused file relay) — any redesign must change or replace them (§10).

## 2. Deployment-state check (contract hypothesis #1: is the code actually there?)

The problem is "review cannot run on a large diff", not "X does not happen in env", but the contract's rule applies in spirit: prove the code exists, is on the integration branch and in the shipped package before analysing it.

| Check | Command | Result |
|---|---|---|
| HEAD identity | `git rev-parse HEAD` | `1c34583b1aedbffe75d9deeff49de9069237e5aa` |
| HEAD is on the integration branch | `git branch -a --contains HEAD`; `git merge-base --is-ancestor HEAD origin/main` | lists `inv/019-…`, `remotes/origin/main`; exit 0. `git rev-parse origin/main` = `1c34583b…` (HEAD **is** the tip of `origin/main`). |
| Caveat: local `main` ref is stale | `git rev-parse main`; `git merge-base --is-ancestor main origin/main` | local `main` = `fb1480ca` ("chore: sync delivery state"), **not** an ancestor of `origin/main`. Use `origin/main`, not `main`, for comparisons. |
| Commit that implements v2 lineage | `git log --oneline -S'prepareIntegrationLineage' -- plugins/delivery-pipeline/scripts/codex-delivery-host.cjs` | `c7633d9e feat: streamline architecture review and phase delivery (#456)` |
| Commit that implements the focused contract | `git log --oneline -S'FOCUSED_CONTRACT' -- …/codex-arch-review-context.cjs` | `c7633d9e` (#456) |
| Commit that introduced `DIFF_MAX_BYTES` | `git log --oneline -S'DIFF_MAX_BYTES' -- …/claude-role-host.cjs` | introduced by `57b97a79 feat: connect Claude judgement roles through trusted host` (oldest hit); the occurrence count changed again in `c7633d9e` |
| Commit that introduced the `receipt` authority key | `git log --oneline -S"'receipt', 'applicationEvidence'" -- …/context-packet.cjs` | `d0f6cf34 epic: 33-reduce-orchestration-context-… (#163)` |
| Released in | `git tag --contains c7633d9e` | `v0.72.0 v0.72.1 v0.72.2 v0.73.0` |
| Package version in the mirror | `plugins/shipyard/package-build.json` | `0.73.0+codex.1632d8e19debc9b0`; `git log -1 --format='%H %cI' -- plugins/shipyard` → `1c34583b… 2026-10-18T15:56:43+03:00` |
| Mirror equals canonical (7 review-path files) | `cmp -s plugins/delivery-pipeline/scripts/$f plugins/shipyard/host/plugins/delivery-pipeline/scripts/$f` for `claude-role-host, context-packet, codex-arch-review-context, codex-delivery-host, development-artifacts, role-artifact, claude-runtime-host` | `IDENTICAL` for all seven |
| Phase-50 epic head exists locally | `git cat-file -t f80dfea7` | `commit` |

Not reachable from here (unknown, §12): a deploy timestamp for the operator's *installed* Claude/Codex bundle (`make doctor` compares the checkout with `~/.claude` / `~/.codex`; it reads the operator's home and I did not run it), and which model/effort the failed phase-50 dispatch used (the evidence store is off limits).

Conclusion: absence is excluded. The behaviour in the problem statement follows from the present code.

## 3. Constants and limits that bound the review paths

Source of truth for each number is cited; "applies to" says which path hits it.

| Constant | Value | Where | Applies to |
|---|---|---|---|
| `DIFF_MAX_BYTES` | 2 MiB (2,097,152) | `claude-role-host.cjs:34` | Integrator combined diff (`diffText` :459-469; `maxBuffer = DIFF_MAX_BYTES + 1`, refuse text `role diff exceeds the bounded context packet`); also `git diff --name-only` (:515) and the `--name-status`/`--numstat` listings (:538-539) of Claude arch-review. Applies to Codex v2 integrator too (shared preparation). |
| `PROMPT_MAX_BYTES` | 3,000,000 | `claude-role-host.cjs:35`, check :897-904 | Whole Claude prompt, **except** packets that carry `role_context.focused` (arch-review). Refusal code `CONTEXT_PACKET_OVER_BOUND`. |
| `ARCH_REVIEW_PACKET_TOKENS` | 60,000 (soft) | `claude-role-host.cjs:37`, `packetBound` :825 | Claude arch-review packet soft ceiling; overflow is **allowed** for arch-review (`:856`), pinned by test `claude-role-host.test.cjs:1434-1456`. |
| `INTEGRATOR_CONTEXT_TOKENS` / `INTEGRATOR_MAX_PACKET_TOKENS` | 60,000 / 750,000 | `claude-role-host.cjs:39-40`; `packetBound` :828 | Integrator packet ceiling = `min(750000, 60000 + ceil(diffBytes/3))`; over → `CONTEXT_PACKET_OVER_BOUND` with "split the phase" remedy (:856-859). |
| `SOURCE_MAX_BYTES` | 768 KiB | `claude-role-host.cjs:33`, used :369-375 | ADR corpus + linked decisions for integrator and pr-sentinel packets (not for focused arch-review). |
| Claude relay trigger | prompt > 1 MiB | `claude-role-host.cjs:1446` | Claude arch-review only. After relay, relay prompt + generated instruction bytes must be ≤ 1 MiB (:1458-1459). |
| `FILE_LIMITS` | `material` 16 MiB, `manifest` 512 KiB, `relay` 64 KiB, `chunk` 256 KiB, `assets` 2000, `decisions` 1000, `reads` 2064 | `codex-arch-review-context.cjs:110-111` | Every host-file input (Codex both roles; Claude arch-review relay; v2 lineage inputs). Refusals with code `CONTEXT_OVER_BOUND` at :127, :503, :510, :543, :579, :1990, :2120; the corpus bound at :1130 and the whole-packet bound at :1189 refuse with the default code `INVALID_ARCH_REVIEW_CONTEXT`. |
| `INPUT_MAX_BYTES` / `INPUT_CHUNK_BYTES` | 1 MiB / 8 KiB | `codex-arch-review-context.cjs:109, 112` | Inline-vs-file threshold for Codex review prompts incl. generated instructions; legacy chunk size. |
| Focused partition size | 128 KiB | `codex-arch-review-context.cjs:470` | Focused file input partitions. |
| `encodeUniqueContent` / `decodeUniqueContent` | 16 MiB / 32 MiB | `context-packet.cjs:660, 711` | Semantic dictionary packet. |
| `RESULT_MAX_BYTES` | 128 KiB | `claude-role-host.cjs:36`, `codex-arch-review-context.cjs:17` | Reviewer's returned JSON (includes `evidence_markdown` for focused arch-review). |
| `EVIDENCE_MAX_BYTES` | 96 KiB | `codex-arch-review-context.cjs:18` | Codex arch-review evidence file. |
| Git helper timeouts | 15 s per git call (30 s for `gh`) Claude host; 30 s Codex collector | `claude-role-host.cjs:142`; `codex-arch-review-context.cjs:123` | Diff generation must finish inside these. |
| Claude stream record cap | 10,000 records | `claude-runtime-host.cjs:276` | Hard `RUNTIME_EVIDENCE_INVALID` if a reviewer's tool loop produces more stream records. |
| Claude session transcript cap | 50 MiB | `claude-runtime-host.cjs:33, 508` | `RUNTIME_EVIDENCE_INVALID` above. (The role host's own usage reader uses 4 MiB, `claude-role-host.cjs:48`, and degrades to `unknown`.) |
| Codex native transcript cap | 128 MiB | `codex-arch-review-context.cjs:19` | Codex arch-review evidence read. |
| `WINDOW_THRESHOLD_TOKENS` | 250,000 | `model-policy-internal.cjs:40`, `:306` | Routing signal only: `inputTokens > 250000` promotes integrator/arch-review one rung (Claude: Sonnet/xhigh→Opus/high; arch-review→Fable/medium; Codex: Sol/high→Sol/xhigh). It is not a model window. Fixed per policy fingerprint (`:553`). |
| Claude child wall clock | none | `grep -n timeout plugins/delivery-pipeline/scripts/claude-runtime-host.cjs` → only probe timeouts (:190, :199, :213) and a 10 s hook timeout (:776) | The Claude child is awaited without a timeout. |

The only in-repo statements about real windows: `docs/gsd_multilevel_delivery_pipeline.md:1076` (`context_window: 1000000` "in the recommended config (GSD adaptive-context for 1M models)") and the comment at `pipeline-config.cjs:2010-2016` ("on Claude, `opus` instead of `fable` costs a smaller context window … the 1M tier is taken only where the runtime SAYS it is available"). Neither names a window for `claude-sonnet-5-5`, `claude-opus-5-5`, `claude-fable-5-1`, `gpt-6.1-sol`. (`grep -rniE 'context window|context_window|model window|prompt_too_long'` outside the mirror/phases/fixtures found nothing else.) → unknown, §12.

## 4. Shared machinery

### 4.1 Packet and prompt construction (both Claude roles; Codex v2 integrator reuses it)

1. `parseRequest` (`claude-role-host.cjs:88-126`) accepts only host-owned selectors; the integrator may carry `review_contract` ∈ {`shipyard.integration-review.v1`, `…v2`} (:94-97); `graph_dir` is **not** an accepted request field and `parseCli` (:1565-1587) has no graph-dir flag.
2. `canonicalWorktree` (:161-192) requires the canonical repo root and a clean tree: tracked modifications refuse with `worktree has local changes before role dispatch` (:174); only untracked scratch files are ignored (`conveyor-scratch.cjs:21-48`, `isScratch` applies to `??` entries only).
3. `buildPacket` → `buildContextPacket` (`context-packet.cjs:385-499`): required refs are full file contents (plan files; ADRs), `role_context` is deep-cloned, `rejectAuthorityKeys` runs at :455, token estimate = `ceil(JSON bytes / 4)` (:315-320), ceiling from `packetBound`. Role requirements: arch-review `['adr_refs','exact_diff','integration_base']`, integrator `['phase_contracts','combined_diff']` (:22-32).
4. `makePrompt` (`claude-role-host.cjs:864-906`) assembles `reference` + role instruction + `JSON.stringify(encodeUniqueContent(packet))` between `<AUTHENTICATED_CONTEXT_PACKET>` tags. `encodeUniqueContent` (`context-packet.cjs:659-706`) replaces every string `content` (and `retained_evidence` JSON) with `{ $semantic_content: <sha256> }` and puts each distinct string once in `dictionary`; `obligations` records every logical use. This dedupes identical content only; it does not shrink distinct content. The prompt tells the model: "Read the complete inline dictionary and every logical obligation … Trusted mechanical integrity supplies no semantic reading credit." (:890)
5. Signals: `observedSignals` (:410-426) sets `inputTokens = ceil(prompt bytes / 4)` (`estimatePromptTokens` :908-911) → the ADR-014 resolver; > 250,000 tokens selects the promoted rung. (**Inference:** the phase-50 integrator at ~640k estimated tokens was therefore routed to the promoted rung, Opus/high on Claude; I could not confirm from the receipt.)

### 4.2 Claude child launch (both Claude roles)

`buildBoundary.launch` (`claude-role-host.cjs:1145-1190`) calls `runtime.agent(prepared.prompt, { model, effort, schema, ...(readOnlySmoke ? { readOnly: true } : {}) })` (:1182-1187). `createClaudeCliLauncher` (`claude-runtime-host.cjs:705-917`) spawns:

```
claude --print --input-format stream-json --output-format stream-json --verbose
  --model <alias> --effort <e> --session-id <uuid> --restricted
  --strict-mcp-config --tools <T> --allowedTools <T> --permission-mode dontAsk
  --permission-prompts none --setting-sources '' --settings <json> --json-schema <schema>
```
(:783-792) with `cwd = worktree`, the prompt as a single stream-json user message on stdin (:822) and `T = ALLOWED_TOOLS = 'Bash,Read,Edit,Write,Glob,Grep'` (:34) unless `launchOptions.readOnly === true` (`READ_ONLY_TOOLS = 'Read,Write,Glob,Grep'`, :35, chosen at :781). The role host only sets `readOnly` for `options.readOnlySmoke` (`claude-role-host.cjs:1186`; `SHIPYARD_CLAUDE_ROLE_SMOKE=read-only`, :1655-1656). Settings JSON (:750-763): sandbox `enabled`, `failIfUnavailable`, `allowUnsandboxedCommands:false`, `autoAllowBashIfSandboxed`, `filesystem.allowWrite = [worktree]`, `denyRead/denyWrite = [archive authority namespace]`, credential env scrub; permissions `blockReadsOutsideWorkingDirectories: true` and `deny` of Read/Edit/Write/Glob/Grep on the evidence directory and archive glob; a `SessionStart` hook writes start evidence.

Consequences (verified by reading):
- A real Claude integrator/arch-review run **can** run `git`, `grep`, `Read` etc. in the worktree today; nothing prevents it from re-deriving the diff itself.
- It can also edit files in the worktree; that is detected afterwards (§7.1), not prevented.
- No timeout; non-zero exit → `fail('RUNTIME_UNAVAILABLE', 'Claude process exited N', { stderr: bounded(rawStderr) })` (:842) — stderr is carried only in `error.details`.

### 4.3 Host-file input (`prepareFileInput`, `codex-arch-review-context.cjs:457-597`)

Writes immutable assets under a 0700 `input-*` directory **outside** the writer tree (`outsideWriter` :205-209; Claude default root `~/.local/state/shipyard/claude/<sha(runId\0worktree)>`, `claude-role-host.cjs:1116-1122`; Codex `~/.local/state/shipyard/codex/…`, `codex-delivery-host.cjs:1091-1098`), files 0400, a manifest with per-asset SHA-256, byte length, file identity, and an exact relay prompt (`fileRelay` :418-455). Three transport flavours exist:

| Flavour | Trigger | What the model is told | Host proof of reading |
|---|---|---|---|
| **Focused** (`review_contract = shipyard.focused-architecture-review.v1`) | arch-review prompt > 1 MiB (both runtimes) | "read the manifest and the source partitions needed … bounded targeted reads; report unresolved paths or partitions and incomplete when necessary … no read counts or consumption echoes are required" (:419-423) | **None** by design. |
| **Legacy v1/v2 reader** (8 KiB chunks via `dd` piped to `base64`, `fileRelay` :445) | integrator/arch-review with `readerCapacity` | read every chunk in order, echo counts | native-session verification (§7.3) |
| **Batch reader v3** (`shipyard.native-reader-transport.v3`) | Codex automatic reader (`automaticReaderProfile`: 8,192 B chunks, 12 ranges per batch, `codex-delivery-host.cjs:974-980`; installed arch-review profile uses 3 ranges per batch, `codex-arch-review-context.cjs:1653`) | read every batch with `node codex-arch-review-context.cjs --read-batch <manifest> <index> <profile>` (`batchCommand` :293-300; `readBatchCli` :324-368) | native-session verification (§7.3) |

Focused partitioning (`prepareFileInput` :461-485) builds `material = [<whole semantic packet JSON>, ...128 KiB partitions of current-pr.diff, ...partitions of every required ref]`. **Derived:** the diff and ADR text are therefore stored twice (inside asset 0's dictionary and again as partitions), so under the 16 MiB `FILE_LIMITS.material` check (:503) a focused review can carry roughly ≤ 8 MiB of diff + ADR content. I did not execute this.

## 5. The four paths

Legend: "embedded" = bytes inside the model's launch prompt; "read" = obtained by the model with tools.

### 5.A Claude integrator

**Entry.** `node claude-role-host.cjs --args-file <json>` (`parseCli` :1565; `runClaudeRoleCli` :1609-1638) or `createClaudeRoleHost(options).run(request)` (:1432). `deliver.md` Step 5.2 (`commands/deliver.md:2889-2975`) uses `review_contract: 'shipyard.integration-review.v2'`; "legacy full-input callers" use v1 (`:2990-3020`).

**Subject.** `prepareIntegrator` (:564-668): phase rows from the canonical graph (`phaseSelection` :447-457); epic branch check; for each ticket exactly one authenticated merged PR via `gh pr list/view`, merge commit must be an ancestor of HEAD (:614-615); `ticketSet`/`ticketSetDigest`; `subject = buildSubject('integrator', …)`.

**v1 (no `review_contract`).**
- Embedded in the prompt: the whole combined diff `combined_diff.content` from `diffText(…, productPathspec())` = `git diff --no-ext-diff --unified=50 <merge-base>...<head> -- . :(exclude).planning :(exclude).shipyard :(exclude).shipyard-* :(exclude)docs/audits :(exclude)AGENTS.md :(exclude)CLAUDE.md` (:459-469, :625; pathspec `development-artifacts.cjs:16-19`); full text of every ticket plan (`required_refs`, content), the selected ADRs and decision files (`architectureRefs` :317-381, ≤ 768 KiB), selected backlog items, the ADR-014 policy JSON (in `packet.policy.content`), phase contracts (acceptance/verification lists), ticket set, base/merge-base/tree identities, and the role reference text once. Phase 50: dictionary 2,525,390 B = diff 2,043,596 B + 29 plans (~0.38 MB) + ADR-014 (10 KB + 9 KB ladder) + ADR-020 + ADR-030 (EVIDENCE.md).
- Read by tools: nothing is required of the model; the instruction is "Judge the complete authenticated phase ticket set and combined diff" (:873-874).
- Tools/sandbox: §4.2 (`Bash,Read,Edit,Write,Glob,Grep`; sandbox write grant = the worktree; settings carry `blockReadsOutsideWorkingDirectories: true` — what the Claude CLI does with that setting for `Bash`/`Read` outside the worktree was not tested here).
- Bounds that apply: `DIFF_MAX_BYTES` 2 MiB on the diff, packet ceiling `min(750k, 60k + diff/3)` tokens, `PROMPT_MAX_BYTES` 3,000,000, `SOURCE_MAX_BYTES` 768 KiB for ADRs. Phase 50: diff 2,043,596 B ≤ 2,097,152; packet 640,131 est. tokens ≤ 741,199 (= 60,000 + ceil(2,043,596/3)); prompt 2,647,625 B ≤ 3,000,000 → host admitted the launch; the child answered `terminal_reason: prompt_too_long`, exit 1 (EVIDENCE.md), surfaced only as `Claude process exited 1`.
- Verified afterwards: see §7.1.

**v2 (`shipyard.integration-review.v2`).**
- `prepareIntegrator` first builds the full v1 `prepared` (so :625's 2 MiB bound and :856's token bound are checked first), then, if v2, calls `prepareIntegrationLineage(scope, prepared, { nativeRuntime: 'claude', … })` (`claude-role-host.cjs:658-667`; `codex-delivery-host.cjs:773-836`).
- That function: (a) re-proves live membership and ancestry with `phase-integrator-preflight.cjs` (`completeIntegrationPreflight` :759-771); (b) writes the **current input** as host files (`prepareFileInput` for the v1 packet, :802-803); (c) selects a baseline (`selectReviewBaseline`, forced `mode: 'full'` for non-Codex, :806-809); (d) calls `buildReviewImpactPacket` (§6); (e) builds `integrationPacketWithCoverage` (`claude-role-host.cjs:680-683`) and a second file input for the Codex relay (:823-830).
- For **Claude** the model still receives `makePrompt('integrator', subject, review.packet, reference)` inline (:665-667) — the lineage's file bundles are prepared and rechecked (`recheckIntegrationReview`, :838-850) but the prompt carries the whole coverage packet. `signals.inputTokens` is recomputed from the new prompt (:667).
- Result must echo `reviewed_identity` and `coverage` (lists of inherited / newly reviewed obligations, `impact_paths`, `limitations`) which `validateIntegrationCoverage` (`codex-delivery-host.cjs:852-873`) compares with the host's own lists (called from `claude-role-host.cjs:1081-1082`).
- Phase 50 outcome (EVIDENCE.md): `CONTEXT_OVER_BOUND` from `codex-arch-review-context.cjs` (impact sources vs 16 MiB); with the bound at 64 MiB the packet was 5,211,605 tokens (~20.8 MB at 4 B/token).

### 5.B Claude arch-review (ticket and phase)

**Entry.** Same host, `role: 'arch-review'`, request keys `{schema, role, worktree, ticket|phase, pr, signals, repo}` (:92-93). Ticket form: `requestRows` finds the single ticket whose `branch` equals the worktree branch (:474-478), `selectPullRequest(…'open')`. Phase form: explicit `phase` + `pr` and no ticket (:98-99), `phaseRows`, `phaseBinding` (:500-504). Review is only required when the live PR base is the integration branch (`architectureTarget`, :498-499 → `ARCH_REVIEW_SKIPPED_BY_TARGET`), so ticket PRs into `epic/*` are skipped by policy and the phase review is the epic → `main` PR.

**Embedded (prepareArch :483-562).**
- `exact_diff.content` = `git diff --no-ext-diff --no-textconv --unified=50 <mergeBase>...<head>` **with no pathspec** (:509-510), `maxBuffer = FILE_LIMITS.material` (16 MiB). `.planning/**` and the mirror are in it.
- `change_metadata`: `name_status`, `numstat` (2 MiB bound each, :538-539) and the derived `changes` inventory (`focusedChangeInventory`, :553-554; `codex-arch-review-context.cjs:1430-1455`: per path status, old/new path, additions, deletions, binary flag, `development|product` classification).
- Focused ADR selection (`selectFocusedArchitecture`, :516; `codex-arch-review-context.cjs:1457-1539`): every ADR file inventoried with headings and selection reasons; selected ADRs and linked `DECISIONS.md` are the required refs (full content); the plan files are *not* required refs for arch-review (`buildPacket` :848) — only the first plan's parsed acceptance/verification lists enter the packet (:525, :846-847). For the phase form `.planning/graph/delivery-state.json` is an additional required ref with full content (:519). `adr_selection` lists all candidates.
- `installed_files` (sha256 of 11 producer scripts, `focusedProducerFiles`, `codex-arch-review-context.cjs:1382-1387`), `reference_digest`, PR identity, base/merge-base trees, ticket-set digest.
- Phase form adds `ticket_set`, `phase_archive_selection`, `retained_history_digest`, `retained_evidence` (the retained roster must exist: `selectPhaseArchives` → `ARCHIVE_AUTHORITY_REQUIRED` if missing, `role-artifact.cjs:2476-2480`).

**Relay.** `makePrompt` for arch-review does not enforce `PROMPT_MAX_BYTES` (focused packets are exempt, :897). In `run` (:1446-1461), if the prompt exceeds 1 MiB the host calls `prepareFileInput` with the **focused** binding (:1449-1455); the model prompt becomes relay text + `<AUTHENTICATED_FOCUSED_INPUT>{descriptor}</…>`. The phase-50 phase review never reached this point (§9.1).

**Tools/sandbox.** Same as §4.2.

**Bounds.** Diff ≤ 16 MiB (git `maxBuffer`) and ≤ 15 s wall; packet token ceiling soft (60,000, overflow allowed); relay path adds §4.3 limits.

**Open question specific to this path.** The relay files live outside the worktree while the Claude child is launched with `blockReadsOutsideWorkingDirectories: true`; no test shows a real Claude child reading them (tests use a fake launcher — `claude-role-host.test.cjs:1406-1432`, `phase49-current-review-admission.test.cjs:178, 856`). → unknown U1.

### 5.C Codex integrator

**Entry.** `createCodexDeliveryHost(...).run({ role: 'integrator', … })` (`codex-delivery-host.cjs`, `requestValue` :95-129; `prepareIntegratorInput` :982-1089; run path :2955-3020, :3540). Static generated agent `shipyard-integrator.toml` / `shipyard-integrator-critical.toml`, `gpt-6.1-sol` high/xhigh, **`sandbox_mode = "workspace-write"`** (printed from `codexStaticVariants(2)` in `gsd-tune.cjs:109-120`, written at `gen-codex-shipyard.cjs:326`). The child is `codex exec --json --model … --config model_reasoning_effort=… --ignore-user-config --cd <worktree>` plus a `shipyard-runtime` permission profile extending `:workspace` (or `:read-only`) with protected paths denied (`codex-runtime-host.cjs:2553-2568, 2685-2692`).

**v1.** The diff is **caller-supplied**: the host takes `request.context.prompt|task_prompt|input` (:1024). It does not derive or bound the combined diff, and `preflightReviewMaterial` (`codex-arch-review-context.cjs:740-766`) returns `null` (no validation) unless the material is a semantic-content/context-packet JSON. If `bytes(material) + generated instruction bytes ≤ 1 MiB` → inline (`inlineIntegratorInputs`, :1038-1052; `recheckInlineIntegrator` :961-972). Otherwise `prepareFileInput` with the automatic v3 reader profile when a graph file exists (`automatic`, :1053-1077): 8,192-B chunks, 12 ranges per physical `exec_command`, max 2,064 logical ranges and 16 MiB (§4.3). Before launch a **capacity probe** (a separate native launch, `measureBatchReaderCapacity`, `codex-delivery-host.cjs:2962-3019`, `codex-runtime-host.cjs:3520-…`; selection forced `sandbox_mode: 'read-only'` at :2997) measures the exact candidate.

**v2.** `prepareIntegratorInput` v2 branch (:1001-1023): calls the **Claude-host** `prepareIntegratorContext` (`claude-role-host.cjs:670-676`) — so the 2 MiB diff bound, plan/ADR bounds and productPathspec apply — then `prepareIntegrationLineage` with `nativeRuntime: 'codex'` and the automatic profile. Here `selectReviewBaseline` may return **incremental** mode (§6.2); `buildReviewImpactPacket` output goes into a second file input whose relay prefix is the role reference plus the v2 instructions (:824-830).

**Verified afterwards.** `finishIntegrationReview` (:876-959): original verified durable record; transcript identity; exactly one terminal contract; `validateIntegrationCoverage`; the result must echo `input_manifest_sha256`, `input_material_bytes`, `input_asset_count`, `input_chunk_reads`, `context_digest` and match `evidence.input_consumption` and native-session sha (:917-928); original native transcript candidates; `sealJudgment`. See §7.3.

### 5.D Codex arch-review (ticket and phase)

**Entry.** `deliver-dispatch.cjs build arch-review … --runtime codex` (`:1202-1207`) → `codex-delivery-host.cjs` `run`, where `archReviewContext.prepare(scope, launch, {graphDir, storageRoot, …})` is called with **no** `readerProfile`/`readerCapacity` (`:3528-3543`), i.e. the **focused** contract (`isFocusedContext`, `codex-arch-review-context.cjs:1644-1647`). Static agent `shipyard-arch-review(.|-critical).toml`, **`sandbox_mode = "read-only"`** with exactly one write grant, `.shipyard-arch-review-evidence.md` (`codex-runtime-host.cjs:2534-2551`; variants printed from `codexStaticVariants`).

**Embedded.** `collect` (:986-1230): `git diff --no-ext-diff --no-textconv --unified=50 <mergeBase>...<head>` with **no pathspec** (the `productPathspec()` is only added when `legacy`, i.e. reader profile/capacity, :1091-1093), `maxBuffer` 16 MiB; `change_metadata`; `selectFocusedArchitecture`; plans reduced to acceptance excerpts; `development: { paths, classification: 'included in the complete PR diff' }` (:1184-1186). `prepare` (:1545-1642) builds the prompt around the semantic packet; if the prompt exceeds `INPUT_MAX_BYTES` (1 MiB) it is replaced by the focused file relay (:1594-1606). Phase form binds the roster, retained evidence and `phase_archive_selection` (:1059-1069, :1175-1178).

**Read.** From host files with `exec_command` under a read-only profile; reads are targeted, unobserved: the review observer is created only when `!focused` (`codex-runtime-host.cjs:2727-2732`).

**Legacy Codex arch-review** (only when a caller supplies `readerCapacity`): `collect(legacy=true)` uses `productPathspec()`, the **complete** architecture corpus, `post_change_inventory`, and the development-artifact diff (`:1091-1186`); consumption observed as in §7.3. Not reachable from the default entry (§5.D Entry).

**Verified afterwards.** `finish` (:1263+) and `validateFocusedResult` (:1389-1405), `validateSealedContext` re-collects the packet and requires the same digest (:2133-2242).

### 5.E Matrix

| | Claude integrator | Claude arch-review | Codex integrator | Codex arch-review |
|---|---|---|---|---|
| Who builds the diff | host (`diffText`, product pathspec) | host (`:509`, no pathspec) | v1: **caller**; v2: host via Claude-host preparation (product pathspec) | host (`collect` :1092, no pathspec when focused) |
| Diff bound | 2 MiB | 16 MiB git buffer; relay 16 MiB total (≈ 8 MiB content, **derived**) | v1 none besides 16 MiB material; v2 2 MiB | 16 MiB buffer; relay 16 MiB total (≈ 8 MiB, **derived**) |
| Inline vs files | always inline (≤ 3,000,000 B) | inline ≤ 1 MiB, else focused files | ≤ 1 MiB inline, else v3 batch files | ≤ 1 MiB inline, else focused files |
| Context lines | `--unified=50` | `--unified=50` | v1: caller; v2: `--unified=50` | `--unified=50` |
| Mirror in diff | yes | yes | v1 caller-dependent; v2 yes | yes |
| `.planning/**` in diff | no | **yes** | v1 caller-dependent; v2 no | **yes** (focused) |
| Tools | Bash, Read, Edit, Write, Glob, Grep; write grant = worktree; reads configured `blockReadsOutsideWorkingDirectories` (untested) | same | `exec_command`; workspace-write profile (generated variant) | `exec_command`; read-only profile + evidence file |
| Model window enforcement | none (child refuses → `prompt_too_long`) | none | none | none |
| Read proof | none | none | native-session consumption (v3) | none (focused) |
| Self-declared completeness | no field | `review_completeness` | `coverage` echo | `review_completeness` |
| Contract versions | v1 / v2 (v2 → `full` only) | `focused.v1` | v1 / v2 (incremental possible) | `focused.v1` (+ legacy) |

## 6. Integration-review v2: inherited trust and impact sources

### 6.1 What the contract is

`shipyard.integration-review.v2` (`codex-delivery-host.cjs:793, 818`, accepted by `claude-role-host.cjs:96`, `codex-delivery-host.cjs:120`, `deliver.md:2894`, `references/integrator.md:25-40`) promises: complete current dictionary **plus** `role_context.review_coverage` = {baseline selection, complete endpoint delta, inherited conclusions/assumptions, newly required obligations, affected dependencies/boundaries, limitations, complete live membership/ancestry proof}; "mechanical hashes, preflight and consumption checks provide no semantic credit"; the reviewer must return a fresh `reviewed_identity` and a `shipyard.integration-coverage-result.v1`.

### 6.2 Inherited trust (baseline selection) — `selectReviewBaseline`, `role-artifact.cjs:2671-2818`

A prior original **Codex** integrator success can be inherited only if all of the following hold (each is a code path I read; none was executed): the current input pins instructions (`binding.agent_sha256`, :2679); the complete phase graph pin is current (:2680-2696); a protected original retention exists (`review_baseline` with `shipyard.review-baseline-authority.v1`, written by `originalReviewRetention` :2649-2667 only for `runtime === 'codex'` + host-files transport); the original receipt and archive re-authenticate (`trustedRecord`, `selectedArchiveRecord`); same repository/phase/ticket-set digest, base, merge-base, policy, contract and installed producer sources (:2762-2780); outcome `passed`/`conform` with zero findings and no recorded limitations/assumptions (:2752-2761); prior head is an ancestor of the current head (:2781-2782); no later unresolved review. Output: `conclusion` + `assumptions` (`confirmation: 'fresh-native-review-required'`).

`buildReviewImpactPacket` (`codex-arch-review-context.cjs:1959-2131`) then computes the delta from the baseline head (or the merge-base), the import-closure of changed files over both endpoint trees, and forces **full** mode when: governing/contract/config files changed (:2033-2040), unsupported or cross-language files changed (:2041-2047), dependency closure is uncertain — dynamic `require`/`import`, `readFile*`, `spawn*`, unresolved specifiers, external packages touched (:2011-2015, :2048-2050) — or a current required ref differs from `HEAD` content (:2060-2065). In full mode every current required ref and every affected endpoint source is placed in `newly_reviewed` with its full `content` (:2066-2092), and `lineage.original_packet` embeds the entire original encoded packet (:2118).

For Claude (`nativeRuntime !== 'codex'`) the selection is overwritten to `full` with reason `unsupported-original-runtime-authority` (`codex-delivery-host.cjs:807-809`). Inherited trust is therefore Codex-only and never reduces what a Claude reviewer is handed.

### 6.3 Why the material reaches ~25.7 MB

Verified mechanism (reading `buildReviewImpactPacket`):
- `endpointInventory(root, rev)` is `git ls-tree -r -z <rev>` for **both** the baseline/merge-base and the current head (:1933-1941, :1977-1978).
- `for (const sources of [previous, now]) for (const entry of sources.values())` reads **every** `.cjs|.mjs|.js|.ts|.tsx|.jsx` blob to build the import graph (:2006-2027), irrespective of whether the file changed. Bodies are cached by git object id (:1984), and `total` accumulates distinct blobs against `FILE_LIMITS.material` (:1989-1992 → `complete impact sources exceed their bound`).
- Everything in the closure of changed files is then embedded with full content (:2076-2087), plus all refs, plus the whole original packet (:2118); final bound `Buffer.byteLength(raw) > FILE_LIMITS.material` (:2120).

Measured with git (commands in §13):

| Measure | Value |
|---|---|
| Tree entries at epic-50 head `f80dfea7` (`git ls-tree -r f80dfea7 \| wc -l`) | **1523** — equals the "1523 files" in EVIDENCE.md |
| Tree entries at merge-base `be7ab4f3` | 1417 |
| JS/TS blobs at `f80dfea7` (non-dedup) | 449 files, 14,821,697 B |
| JS/TS blobs at merge-base | 425 files, 14,240,149 B |
| Both endpoints, non-dedup sum | 29,061,846 B |
| Both endpoints, distinct blobs only (what `bodies` caches) | 377 blobs, 14,324,302 B (13.66 MiB) |
| JS/TS at HEAD, excluding `plugins/shipyard/` | 325 files, 10,550,222 B |
| `tests/` JS | 191 files, 6,200,364 B |
| `FILE_LIMITS.material` | 16,777,216 B |

So the read volume is a property of repository size (this repository's JS/TS alone is within ~1.1× of the bound), not of the phase diff. **The 25.7 MB figure is not reproduced:** neither 29.06 MB (non-dedup) nor 14.32 MB (distinct) equals it, and at the point of refusal `total` cannot exceed 16 MiB because the check precedes the add. The number most likely came from an instrumented run with a raised bound (EVIDENCE.md says the 64 MiB run produced a 5,211,605-token packet ≈ 20.8 MB). → unknown U3 with a spike.

## 7. What the host verifies after launch

### 7.1 Claude (both roles)

| Check | Where | Notes |
|---|---|---|
| Launch happened once through the ADR-014 boundary with an application receipt | `createDispatchBoundary`/`createClaudeDispatchAdapter`, `getLaunchCount() === 1` (`claude-role-host.cjs:1193, 1494`) | receipt + `runtime.applicationEvidence` |
| Packet/HEAD/instructions/producer pins unchanged before launch | :1153-1170 (`preflightPins`, `revalidateLiveInputs`, `preflightReviewMaterial`, reference digest) | |
| Worktree mutation | `assertEvidenceOnlyChanges` :1211-1249 → `WORKTREE_MUTATED` unless the only changes are the evidence file, retained archives, digest-pinned scratch/graph files | This is how "read-only" is enforced for Claude roles. |
| Live PR/base/merge state unchanged | `revalidateLiveInputs` :1251-1350 | integrator: default branch oid + each merged PR; arch: PR head/base/draft + phase binding + roster |
| Result identity | `validateResult` :1058-1100 | integrator: phase, head, head_tree, base, base_tree, `ticket_set`, digest (+ v2 coverage). arch: id, pr, head, base_tree, ticket set |
| Focused arch result | `validateFocusedResult` (`codex-arch-review-context.cjs:1389-1405`) + launch digest echo (:1063-1065) | requires `review_completeness ∈ {complete, incomplete}`; `complete` ⇒ `limitations` and `unresolved_sources` empty; identity fields equal host's |
| Evidence file equals returned `evidence_markdown` | :1504-1506 | |
| Seal + validate | `sealResult` :1418-1430 → `roleArtifact.sealJudgment`, `validateJudgmentManifest` | |
| Transcript digest/usage | `firstResponseUsage` :1352-1416 | only usage; returns `unknown` if the transcript is > 4 MiB or unmatched |

No Claude-side code inspects tool calls: `grep -n 'tool_use\|tool_result\|toolUse' claude-runtime-host.cjs claude-role-host.cjs claude-dispatch-adapter.cjs` → no matches. The stream and the native session transcript are retained with digests (`writeTranscript` :579, `saveSessionTranscript` :601) so a tool-call audit would be technically possible, but nothing reads them for coverage.

### 7.2 Downstream authority

`gate-trailer.cjs` (`verifyCurrentReviews` :203-242) calls `role-artifact.currentArchitectureVerdict` (`role-artifact.cjs:3805`), which refuses a candidate when the manifest is on the focused contract and `findings.review_completeness !== 'complete'` (:3878-3879). That single comparison is the only place `incomplete` is turned into "not authority"; there is no corresponding integrator field. The arch-review reference states the limit plainly: "Partition hashes and access logs authenticate availability; they do not prove reading … Neither the declarations nor an empty finding list prove source consumption" (`references/arch-review.md`, *Focused original judgment*).

### 7.3 Codex full-reader consumption proof

For file inputs with a reader transport the host observes the native Codex session (`createReviewObserver`, `codex-runtime-host.cjs:2435`, created at :2727-2732 for non-focused file transports with a ticket-set binding) and, at completion, requires `input_consumption.schema === 'shipyard.native-file-consumption.v3'`, `physical_calls === manifest.batches.length`, `logical_ranges === checked.chunk_reads`, matching `profile_sha256`, strictly increasing unique `range_ordinals`, unique `call_ids` (`:2161-2186`). `finishIntegrationReview` additionally requires the model to echo the manifest hash, byte count, asset count and range count (`codex-delivery-host.cjs:917-928`). This is the existing mechanism that comes closest to "the host proves the reviewer covered every byte"; it covers byte ranges of the packet, not semantic review, and is not used for the focused architecture contract. The Codex integrator's *inline* path (material ≤ 1 MiB, `inlineIntegratorInputs`, `codex-delivery-host.cjs:1038-1052`) has no consumption proof either, only `recheckInlineIntegrator` (HEAD, instructions, graph pins).

## 8. The generated mirror and every pathspec/limit that touches it

### 8.1 What the mirror is

`plugins/shipyard/` is generated by `scripts/package-shipyard-codex.cjs` (`make package-shipyard-codex`); `host/plugins/delivery-pipeline/…` is a byte copy of the canonical plugin (161 tracked files, `git ls-files plugins/shipyard | wc -l`); CLAUDE.md: "never edit its `host/` copy directly".

### 8.2 How much of a review diff it is (reproduced)

Command family: `git diff --no-ext-diff --unified=<N> 92453193^ 92453193 -- <pathspec>` on the squashed epic-50 commit (`92453193`, PR #521), with the equivalent of `productPathspec()`:

| Pathspec / context | Bytes |
|---|---|
| product pathspec, `--unified=50` (what the Claude integrator embeds) | **2,043,597** (EVIDENCE.md: 2,043,596) |
| of which `plugins/shipyard` only | **642,826** (31.5%; EVIDENCE.md: 643 KB) |
| product pathspec **and** `:(exclude)plugins/shipyard`, `--unified=50` | 1,400,771 |
| same, `--unified=3` | 679,800 |
| no pathspec at all, `--unified=50` (what both arch-review paths build) | **3,352,354** |
| of which `.planning` | 1,277,831 |
| `--name-status -z` / `--numstat -z` | 16,095 / 16,853 |

Files in that commit by top directory (`git diff --name-only … | awk -F/ '{print $1"/"$2}' | sort | uniq -c`): 96 `.planning/phases`, 43 `tests/unit`, 27 `plugins/shipyard`, 24 `plugins/delivery-pipeline`, 15 `.planning/investigations`, 9 `tests/smoke`, 9 `.planning/graph`, 2 `.planning/architecture`, 1 `scripts/gen-codex-shipyard.cjs`, 1 `docs/audits`.

### 8.3 Every place the diff or its path list is built (must be considered for a mirror exclusion)

| # | Location | Today | Note |
|---|---|---|---|
| 1 | `development-artifacts.cjs:5-19` `PREFIXES`, `FILES`, `productPathspec()` | excludes `.planning/`, `.shipyard/`, `.shipyard-`, `docs/audits/`, `AGENTS.md`, `CLAUDE.md` | Also used by `isDevelopmentArtifact` (:8-14) and `changedProductPaths` (:21-25). |
| 2 | `claude-role-host.cjs:459-469, 625` integrator diff | `productPathspec()` | v1 and v2 (Claude + Codex v2). |
| 3 | `claude-role-host.cjs:509-510` arch-review diff | **no pathspec** | |
| 4 | `claude-role-host.cjs:515` `changedPaths` (`--name-only`) | **no pathspec** | feeds `selectFocusedArchitecture` |
| 5 | `claude-role-host.cjs:538-539` name-status / numstat | **no pathspec** | feeds `change_metadata.changes` |
| 6 | `codex-arch-review-context.cjs:1092-1093` Codex arch diff | `productPathspec()` only when `legacy`; **none** when focused | |
| 7 | `codex-arch-review-context.cjs:1094-1095` `developmentPaths` and :1184-1186 `development.content` | development paths only; content diffed only when `legacy` | |
| 8 | `codex-arch-review-context.cjs:1109-1110` `changedPaths` | **no pathspec** | feeds ADR selection (:1111) |
| 9 | `codex-arch-review-context.cjs:1170-1171, 1187` name-status / numstat / `changes` | **no pathspec** | |
| 10 | `codex-arch-review-context.cjs:1430-1455` `focusedChangeInventory` classification | `isDevelopmentArtifact` ⇒ `development` else `product` | mirror paths are classified `product` |
| 11 | `codex-arch-review-context.cjs:1943-1957` `endpointChanges`, `:1933-1941` `endpointInventory`, and the duplicate in `role-artifact.cjs:2824-2850` | all paths | `development_context` flag via `isDevelopmentArtifact` |
| 12 | `codex-arch-review-context.cjs:2006-2027` impact reads | reads mirror JS blobs too (shared blob ids dedupe identical copies) | |
| 13 | `tests/unit/development-artifacts.test.cjs:30` | asserts `git diff … productPathspec()` content | |
| 14 | `.github/actions/scope/action.yml` → `development-artifacts.cjs <base> HEAD` | decides CI `product_changes` | **Must not** treat the mirror as a development artifact (§1 fact 10). |

Other consumers of `isDevelopmentArtifact` (not review-diff, but coupled to the same list): `scope-gate.cjs:118`, `pr-hygiene.cjs:265,292,354`, `reviewers.cjs:200,323,442`, `comment-policy.cjs:402` (`grep -rn isDevelopmentArtifact`).

Selection side effect to keep in mind: `selectFocusedArchitecture` marks an ADR as "governs changed module" if its text contains the changed path or any ancestor directory prefix (`codex-arch-review-context.cjs:1482-1488`), so dropping mirror paths from `changedPaths` could change which ADRs are selected only if some ADR mentions `plugins/shipyard/…`; `grep -rn plugins/shipyard .planning/architecture` finds one mention, an install-path example in `ADR-024-ROLLOUT.md:151`, so the effect is probably nil (**inference**).

### 8.4 Mirror parity checks that exist

- `tests/unit/marketplace-install.test.cjs:67-107`: `assertCurrentPackage` compares `plugins/shipyard` with a fresh `build()` ("Marketplace package is stale: run make package-shipyard-codex"), enforced when the base is `''` or `main`, skipped for `epic/*` and `ticket/*` bases (`packageFreshnessRequired`, :70-72; CLAUDE.md says the same).
- `tests/unit/phase49-package-publication.test.cjs`, `phase47-package-publication.test.cjs`: inventory and published-digest pins over specific mirror outputs (e.g. `phase49-package-publication.test.cjs:47, 423, 872`; `phase47-package-publication.test.cjs:50, 579`).
- `tests/unit/runtime-file-digests.json` pins only two files, `plugins/delivery-pipeline/scripts/claude-dispatch-adapter.cjs` and `…/runtime-adapters.cjs` (python read of the JSON); editing them requires `make refresh-runtime-digests` + trailer (`CLAUDE.md`, `scripts/check-runtime-digest-trailer.cjs`, CI step `runtime digest trailer`, `.github/workflows/test.yml:106-108`). The review-path files named in §3 are **not** in that pin.

Hiding the mirror from the reviewer removes the reviewer's ability to see divergence between canonical source and mirror in the diff; the only automatic divergence detector left is the staleness test above, which is skipped for epic/ticket bases. (See risks line.)

## 9. Unrelated defects found at intake — status after reading and reproducing

### 9.1 `receipt` authority key (confirmed, reproduced)

Chain: `registerPhaseArchiveRoster` stores `receipt: row.receipt` per record (`role-artifact.cjs:2451`) → `selectPhaseArchives` returns `selection = { identity, roster_digest, inventory_digest, records: roster.records }` (:2628-2629) → `claude-role-host.cjs:549` puts `selectedArchives.selection` in `role_context.phase_archive_selection` → `buildContextPacket` calls `rejectAuthorityKeys(packet)` (`context-packet.cjs:455`), which recursively rejects any key in `AUTHORITY_KEYS` (:34-39, includes `receipt`) → `CONTEXT_PACKET_AUTHORITY: packet.role_context.phase_archive_selection.records.0.receipt is host-owned launch authority`.

Reproduction (read-only `node -e`, no files written): calling `buildContextPacket` with a `roleContext.phase_archive_selection.records[0]` that has `{dispatch_id, receipt}` → `CONTEXT_PACKET_AUTHORITY : packet.role_context.phase_archive_selection.records.0.receipt is host-owned launch authority`; the same call with a record without `receipt` → built OK, `overflow=false`. `validateContextPacket` repeats the check at :523. The Codex collector puts the same selection in `packet.phase_archive_selection` (`codex-arch-review-context.cjs:1176`) but does not pass it through `buildContextPacket`; its `preflightReviewMaterial` branch for `schema === SCHEMA` does not call `rejectAuthorityKeys` (:750-760) (by reading, not executed).

Observation: the host later stores the selection in the result's `host_context` (:1510), where the check does not run, so the key is legitimate host data that only the packet rule objects to. The packet needs only the roster identity/digest, which the same `selection` also carries.

### 9.2 Child stderr not surfaced (confirmed by reading)

`claude-runtime-host.cjs:842`: `fail('RUNTIME_UNAVAILABLE', 'Claude process exited <code>', { stderr: bounded(rawStderr) })` stores stderr in `error.details`; `hostError` sets `error.details` (:55-61). The CLI prints `error.message` and a hint only (`claude-role-host.cjs:1659-1662`). `rawStdout` (which contains the stream-json `terminal_reason`) is not included in the failure either.

### 9.3 Fixed graph directory (confirmed by reading)

`graphDirectory` honours `options.graphDir` (`claude-role-host.cjs:195`) and the programmatic API accepts it, but the CLI cannot set it: `parseCli` (:1565-1587) has no graph flag; `parseRequest` rejects unknown fields (:92-95); `main` builds `hostOptions` only from `SHIPYARD_CLAUDE_ROLE_SMOKE` (:1655-1656). A tracked, modified `.planning/graph/delivery-front.json`/`dispatches.json` makes `canonicalWorktree` refuse (:167-174). At the start of this worker, `git status --short` showed exactly those two files modified in this worktree; whether a role launch from here would refuse was not executed.

### 9.4 Documentation vs code (found while tracing)

- `commands/deliver.md` (arch-review step, ~:2420): "The Claude role host's read-only profile grants write access only to `.shipyard-arch-review-evidence.md`". Code: real launches use `ALLOWED_TOOLS` with worktree write access (§4.2); the property is checked after the fact (§7.1).
- `commands/deliver.md` (~:2415): "Codex … the builder exits 2 with the named missing host contract" vs `deliver-dispatch.cjs:1202-1207` which builds a Codex arch-review request, and `deliver-dispatch.cjs:1123-1124` which still contains the "missing host contract" text for another branch. Not investigated further.

## 10. Existing tests and checks that pin current behaviour

Run in this worker (isolated `HOME`):

| Command | Result |
|---|---|
| `node --test --test-reporter=spec tests/unit/development-artifacts.test.cjs` | 3 tests, pass 3, fail 0 |
| `node --test --test-reporter=spec --test-name-pattern="integrator admits a role diff\|integrator refuses a role diff above\|an integrator diff of about 2 MB\|integrator judges the code diff\|focused Claude overflow\|an integrator packet above its diff-scaled" tests/unit/claude-role-host.test.cjs` | 6 tests, pass 6, fail 0 |

What they pin (reading `tests/unit/claude-role-host.test.cjs`):
- `:1004-1017` the integrator diff contains no `.planning/` text.
- `:1023-1036` a diff above 1 MiB and ≤ 2 MiB is admitted; `:1038-1053` a ~2 MB diff prepares (> 320,000 estimated tokens, `overflow === false`); `:1073-1084` a diff above 2 MiB refuses with `role diff exceeds the bounded context packet`, not `preflight failed`.
- `:1055-1071`, `:1434-1481` the integrator/sentinel packet ceilings and their remedies; arch-review overflow is admitted (`:1434-1456`); `:1483-1511` ceilings 60,000 (arch), `60,000 + ceil(diff/3)` (integrator), 40,000 (sentinel).
- `:1406-1432` focused Claude overflow uses `<AUTHENTICATED_FOCUSED_INPUT>`, material partitions, `review_completeness: 'complete'`, and passes `currentArchitectureVerdict` and `gate-trailer.verifyArchitectureTarget`.
- `:1086-1103` an `ENOBUFS` on the metadata listings is reported as `INPUT_TOO_LARGE` naming the 2,097,152-byte bound.
- `tests/unit/claude-role-host.test.cjs:152-180` (`prepareInlineReview` with a 3,000,000-byte reference → refusal).

Other relevant suites (not run here): `tests/unit/codex-arch-review-context.test.cjs` (e.g. `:235` "collector bounds the complete input instead of silently truncating it", `:2079` file input bytes/accounting, `:2244` installed v3 admission), `tests/unit/phase49-incremental-integration.test.cjs`, `phase49-current-review-admission.test.cjs`, `phase49-review-continuation.test.cjs`, `subject-contract.test.cjs:286-306`, `tests/unit/model-policy.test.cjs` and `dispatch-boundary.test.cjs` (window-threshold rung promotion), `tests/unit/marketplace-install.test.cjs`, `phase47/49-package-publication.test.cjs`, `tests/smoke/phase49-final-review-acceptance.cjs`, `tests/smoke/claude-delivery-roles-smoke.sh` (live smoke covers `arch-review` and `pr-sentinel`, not `integrator`).

CI (`.github/workflows/test.yml`): `unit (shard n/4)` and `gates and smoke` are conditional on `product_changes` from `development-artifacts.cjs`; `publish gate` (`publish-gate.cjs --base … --working-tree`), `runtime digest trailer` (PRs only), `make test-fast-rest`.

## 11. Known warts relevant to the redesign

1. The same constants live in three places that must agree: Claude host bounds (`claude-role-host.cjs:33-40`), the Codex collector limits (`codex-arch-review-context.cjs:109-112`), the policy threshold (`model-policy-internal.cjs:40`).
2. `claude-role-host.cjs` doubles as the Codex v2 integrator preparation (`prepareIntegratorContext`), so a change to it changes both runtimes' v2 behaviour; it is also in the producer pins list for v2 (`codex-delivery-host.cjs:786` `producerPins`) and in the focused producer list (`focusedProducerFiles`, :1382-1387).
3. `HOST_IDENTITY.role_host_sha256` hashes `claude-role-host.cjs` itself (`:70-73`); any edit changes the recorded host identity.
4. `prepareIntegrator` v2 builds the v1 packet fully (all plans, ADRs, diff) before the lineage; the packet is then rebuilt with `review_coverage`, so v2 on Claude carries v1 + coverage in one prompt.
5. Claude `makePrompt` runs `preflightReviewMaterial` over the encoded packet, which re-validates every required ref against the worktree files (`validateContextPacket`, `context-packet.cjs:557-561`) — large phases pay this cost at prepare and again before launch (:1160-1162) and at completion (:1247).
6. The focused file relay stores diff/ADR text twice (§4.3, derived).
7. Local `main` is not the integration tip in this checkout (§2).

## 12. Unknowns (each is an OPEN-QUESTIONS candidate) and spikes

- [ ] Can a real Claude child (`blockReadsOutsideWorkingDirectories: true`, sandbox `allowWrite: [worktree]`) read the host-file relay under `~/.local/state/shipyard/claude/<key>/input-*`? Only fake launchers exercise it. — owner: spike `/gsd-spike "claude arch-review reads the focused host-file relay from outside the worktree under the role settings"` (live, one tiny fixture).
- [ ] What are the real context windows (input and output) of `claude-sonnet-5-5`, `claude-opus-5-5`, `claude-fable-5-1`, `gpt-6.1-sol` and `gpt-6-luna` as the Claude CLI / Codex CLI actually enforce them? The repo records none (only the 250,000 routing threshold and a "1M tier" remark). — owner: constraints line / operator (capability evidence from the live CLIs).
- [ ] Which model and effort did the failed phase-50 Claude integrator run on (policy predicts the promoted Opus/high rung because the estimated input exceeded 250,000 tokens), and what did the child's `terminal_reason: prompt_too_long` event say about the window? — owner: operator (evidence store; this worker did not touch it).
- [ ] How was the 25.7 MB / 1523-file impact-source figure computed? My accounting gives 14.32 MB (distinct) / 29.06 MB (non-dedup) and the 1523 equals the tree-entry count, not the JS-file count. — owner: spike `/gsd-spike "instrument buildReviewImpactPacket read() at 64 MiB on f80dfea7 and report distinct bytes, file count and packet bytes"`.
- [ ] The generated Codex integrator variant is `workspace-write`, but the review-reader code hard-codes `sandbox_mode: 'read-only'` for probes and recovery (`codex-delivery-host.cjs:2997, 3120`; `codex-runtime-host.cjs:1129, 1632, 3393, 3525`). Which sandbox does an installed Codex integrator actually run under, and is the combination validated? — owner: user / spike reading an installed `shipyard-integrator.toml` and one native session (I could not inspect `~/.codex`).
- [ ] After the `receipt` key stops blocking the Claude phase arch-review, does `prepareArch` for a real phase reach launch (roster registered against the graph dir, evidence archives present, relay > 1 MiB, focused result accepted)? Only the first refusal point is known. — owner: spike with a retained roster fixture or the real phase-50 roster in a scratch graph dir.
- [ ] What does tool-based reading cost on Claude (turns, latency, stream records vs the 10,000-record cap, session transcript vs 50 MiB) for a 2 MB / 6 MB diff? — owner: spike `/gsd-spike "Claude reviewer reads a 2 MB diff via Read/Bash in 64 KB steps: count tool calls, stream records, transcript bytes, wall time"`.
- [ ] Is a Codex **v1** integrator prompt built by the host or by the orchestrating model (`deliver.md` legacy path passes `diff` in the dispatch context)? The host cannot verify that caller material is the combined diff of the authenticated ticket set. — owner: user (intended contract) after reading how the legacy callers assemble `context.prompt`.
- [ ] Which exact pins fail if `claude-role-host.cjs`, `codex-arch-review-context.cjs`, `codex-delivery-host.cjs`, `context-packet.cjs` or `development-artifacts.cjs` change (`phase47/49-package-publication.test.cjs`, `marketplace-install.test.cjs`, hosted-identity checks)? Not run (heavy; may write fixtures). — owner: constraints line; next check: run those suites on a trial edit in a scratch worktree.
- [ ] Is `deliver.md`'s statement about a Claude "read-only profile" and a Codex arch-review "missing host contract" intended behaviour or stale text? — owner: user.
- [ ] Is the installed operator bundle (Claude plugin / Codex `~/.codex`) at the same package build as `plugins/shipyard/package-build.json` (`0.73.0+codex.1632d8e19debc9b0`)? — owner: operator (`make doctor`; read-only but reads their home).

Spike list (none performed): the five `/gsd-spike` lines above (relay readability on Claude, impact-source accounting, tool-reading cost, installed Codex integrator sandbox, phase arch-review reach-launch).

## 13. Command log (every claim above rests on one of these or on the named source read)

Environment: worktree `/Volumes/KINGSTON/.wt-claude-shipyard/inv-019`; commands run from there; Node from PATH; scratch `HOME` for test runs.

1. `ls -la .planning/investigations/INV-019-…/`; `ls …/research` → `research/` did not exist; read PROBLEM.md, EVIDENCE.md, OPEN-QUESTIONS.md, RESEARCH-CONTRACT.md, DECISIONS.md, RESEARCH.md, OPTIONS.md, RISKS.md.
2. `git rev-parse HEAD`; `git status --short`; `ls .planning/codebase` (absent); `wc -l` of the seven scripts (claude-role-host 1664, codex-arch-review-context 2251, codex-delivery-host 3734, context-packet 764, role-artifact 6465, development-artifacts 34, phase-integrator-preflight 289).
3. Source reads (by tool): `claude-role-host.cjs` 1-1664 in full; `claude-runtime-host.cjs` 1-110, 380-440, 700-1053; `context-packet.cjs` 1-764; `codex-arch-review-context.cjs` 1-135, 205-965, 965-1265, 1380-1750, 1925-2251; `codex-delivery-host.cjs` 95-155, 690-1130, 2960-3140, 3515-3560; `codex-runtime-host.cjs` 2120-2190, 2530-2750, 3515-3575; `role-artifact.cjs` 2430-2840, 3255-3330, 3860-3900; `development-artifacts.cjs`; `gsd-tune.cjs` 95-135; `gen-codex-shipyard.cjs` 280-345; `model-capability.cjs` 1-80; `model-policy-internal.cjs` 15-70, 540-570; `phase-integrator-preflight.cjs` 1-80; `conveyor-scratch.cjs` (grep); `commands/deliver.md` 2385-2490, 2840-3110; `references/integrator.md` and `references/arch-review.md` (full); `docs/gsd_multilevel_delivery_pipeline.md` 604-640, 696-712, 806-816; `CLAUDE.md` 40-140; tests listed in §10.
4. `git branch -a --contains HEAD`; `git rev-parse origin/main`; `git merge-base --is-ancestor HEAD origin/main` (exit 0); `git merge-base --is-ancestor HEAD main` (exit 1); `git log --oneline -3 origin/main`; `git log --oneline -2 main`; `git merge-base --is-ancestor main origin/main` (not ancestor).
5. `git log --oneline -S'prepareIntegrationLineage' -- …codex-delivery-host.cjs`; `-S'FOCUSED_CONTRACT'`; `-S"'receipt', 'applicationEvidence'"`; `-S'DIFF_MAX_BYTES'`; `git tag --contains c7633d9e` → `v0.72.0 v0.72.1 v0.72.2 v0.73.0`.
6. `cmp -s` loop over seven files canonical vs mirror → all `IDENTICAL`; `git log -1 --format='%H %cI %s' -- plugins/shipyard`; `cat plugins/shipyard/package-build.json`; `git ls-files plugins/shipyard | wc -l` → 161.
7. `git cat-file -t f80dfea7` → `commit`; `git diff --no-ext-diff --unified=50 92453193^ 92453193 -- . ':(exclude).planning' ':(exclude).shipyard*' ':(exclude)docs/audits' ':(exclude)AGENTS.md' ':(exclude)CLAUDE.md' | wc -c` → 2043597; same with `-- plugins/shipyard` → 642826; with an extra `':(exclude)plugins/shipyard'` → 1400771; with `--unified=3` → 679800; no pathspec `--unified=50` → 3352354; `-- .planning` → 1277831; `--name-status -z --find-renames` → 16095; `--numstat -z --find-renames` → 16853; `git diff --name-only 92453193^ 92453193 | awk -F/ '{print $1"/"$2}' | sort | uniq -c | sort -rn`.
8. `git ls-tree -r -l HEAD | awk …` for JS/TS counts and bytes → all paths 449 / 14,823,120; excluding `plugins/shipyard/` 325 / 10,550,222; `tests/` 191 / 6,200,364; `git ls-tree -r HEAD | wc -l` → 1523. For `f80dfea7` and `be7ab4f3407b017a50e9fe2a49bf54e22e7d3202` (merge-base of `f80dfea7` and `be7ab4f3`): entries 1523 / 1417; JS/TS non-dedup 449 / 14,821,697 and 425 / 14,240,149; unique-blob union 377 / 14,324,302.
9. `node -e` requiring `gsd-tune.cjs` and printing `codexStaticVariants(2)` for integrator/arch-review → `integrator base gpt-6.1-sol high shipyard-integrator.toml workspace-write`, `integrator critical gpt-6.1-sol xhigh … workspace-write`, `arch-review base gpt-6.1-sol high … read-only`, `arch-review critical gpt-6.1-sol xhigh … read-only`.
10. `node -e` calling `context-packet.cjs` `buildContextPacket` twice (with and without a `receipt` key inside `role_context.phase_archive_selection.records[0]`) → refusal / success shown in §9.1.
11. `python3 -I -c "import json; …"` over `tests/unit/runtime-file-digests.json` → files `plugins/delivery-pipeline/scripts/claude-dispatch-adapter.cjs`, `…/runtime-adapters.cjs`.
12. `grep` searches: `AUTHORITY_KEYS|rejectAuthorityKeys`, `productPathspec|isDevelopmentArtifact|changedProductPaths` (all non-mirror), `plugins/shipyard` in scripts/tests/CI, `review_completeness` across `plugins/delivery-pipeline/scripts`, `tool_use|tool_result|toolUse` across the three Claude host files (no matches), `timeout` in `claude-runtime-host.cjs`, window-related terms across the repo (excluding mirror, phases, fixtures, INV-019), `AUTHENTICATED_FOCUSED_INPUT`, `sandbox` in `codex-dispatch-adapter.cjs`/`codex-agent.cjs`.
13. Tests: `node --test --test-reporter=spec tests/unit/development-artifacts.test.cjs` (3/3 pass); `node --test --test-reporter=spec --test-name-pattern=… tests/unit/claude-role-host.test.cjs` (6/6 pass), both with `HOME=$TMPDIR/inv019-home` and the delivery env vars unset. `git status --short` afterwards unchanged from the start.
14. Refused by the permission layer (not performed, not retried): `ls ~/.codex/agents`; and reading back two scratch output files with `tail` (replaced by piping the test output directly).
15. A first attempt to run the tests used `timeout`, which does not exist on this macOS shell (`env: timeout: No such file or directory`); those runs produced no result and were repeated without it.
