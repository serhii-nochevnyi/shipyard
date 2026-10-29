# R-27: packet limits for the fallback code review and the raised arch-review packet

status: measured
date: 2026-10-19
host: executor sandbox, macOS Darwin 27.0.0, node v24.21.0, git 2.54.0 (Apple Git-157), worktree T-52-02 at HEAD e8299ce01e729f5e0c19e99477a33bb066ef4806 (main 1c34583b, Shipyard 0.73.0)

Section status:

| Section | Status | Why |
|---|---|---|
| 1. Landing diff sizes | measured | produced by a throwaway measuring tool (removed in HS-12; the table below is the retained record), 30 landing commits |
| 2. Which bound refuses a large review | verified | read from the symbols named below at the input digests below; no model run was needed |
| 3. Model context windows | measured (runtime-reported) | read from the model-usage and token-count records of existing Claude Code and Codex sessions on this host; not from vendor documentation |
| 4. Chosen values | proposals, for the operator to accept | rows 1 to 6 and C1 to C3 are derived from sections 1 to 3 and the R-30 figures in `arch-review-cost.md`; they are decisions, not measurements |

Downstream rule (from the plan): if this file is `inconclusive` at merge, plan 52-05 and every ticket after it stay blocked until the measurement is repeated. Section 3 is `measured`, so the file is not `inconclusive`, but the Codex maximum output is not exposed by the runtime and is recorded as unknown.

## Inputs

Digests were taken with `shasum -a 256 <path>` in the worktree.

| Input | sha256 |
|---|---|
| `plugins/delivery-pipeline/scripts/claude-role-host.cjs` | `6a7c5283d6f85a4f01389567620ef4700c2639efd3af6382027b3cea4f366744` |
| `plugins/delivery-pipeline/scripts/codex-arch-review-context.cjs` | `43063b60822acfa43449279ce21e13f30b3ead17bd504cf9be3a317a117d9f50` |
| `plugins/delivery-pipeline/scripts/context-packet.cjs` | `e2969388009c91796a3e8db3ee3de34ab67558e3b4fd0f89665158c7b43e520a` |
| `plugins/delivery-pipeline/scripts/development-artifacts.cjs` | `36b097bbb3cd95e6ee1b8941e2326e015c5c66f22a561083d6c81b8880521530` |
| `docs/audits/phase49-final-review-acceptance.json` | `248be462e93724d150d513726628243307251262b31e867026d8e8880424c699` |

## 1. Landing diff sizes (measured)

The measuring tool (`tests/smoke/phase52-diff-sizes.cjs`, with its unit test and the raw `diff-sizes.json` output) was removed in HS-12 because nothing in the product or CI used it; it remains in git history before that change. It was run from the worktree over the 30 landing commits listed in the table below.

The tool measured `git diff --no-ext-diff --no-textconv --unified=50 <sha>^ <sha>` limited to `productPathspec()` (everything except `.planning/`, `.shipyard/`, `.shipyard-*`, `docs/audits/`, `AGENTS.md` and `CLAUDE.md`), and reports estimated tokens as `ceil(bytes / 4)`, the same estimate `context-packet.cjs` `estimateTokens` uses.

How the commits were identified: `git log --first-parent -i -E --grep=<patterns>` over subjects, because `.planning/graph/delivery-state.json` has no epic records (its top-level keys are ticket ids; reading `.epics` and `.epic` gave `{}`). Identification is by subject and can be wrong for any single row; the table lists the subject kind so a reader can check it with `git show -s --format=%s <sha>`.

| Phase | Commit | Subject kind | Product files | Product diff bytes | Est. tokens | > 2 MiB | > 1 MiB | > 60,000 tok |
|---|---|---|---|---|---|---|---|---|
| 20 | 21f94c5d | `Merge phase 20 (#7)` | 20 | 335,904 | 83,976 | no | no | yes |
| 21 | df42e660 | `Merge phase 21 (#16)` | 14 | 246,738 | 61,685 | no | no | yes |
| 22 | eb9476c6 | `Merge phase 22 (#13)` | 12 | 131,029 | 32,758 | no | no | no |
| 23 | 61835242 | `Merge phase 23 (#23)` | 10 | 138,188 | 34,547 | no | no | no |
| 24 | 295b5c1a | `Merge phase 24 (#30)` | 41 | 861,935 | 215,484 | no | no | yes |
| 25 | 9614c09c | merge of `epic/25` (#40) | 26 | 550,001 | 137,501 | no | no | yes |
| 26 | 339b2ebf | merge of `epic/26` (#41) | 37 | 832,715 | 208,179 | no | no | yes |
| 27 | 191137ae | `epic: 27-... integration` | 39 | 913,244 | 228,311 | no | no | yes |
| 28 | c68562f1 | `epic: 28-... integration` | 30 | 612,052 | 153,013 | no | no | yes |
| 29 | 9b01aa4c | merge of `epic/29` (#85) | 12 | 226,932 | 56,733 | no | no | no |
| 30 | ba2a0674 | merge of `epic/30` (#123) | 24 | 368,336 | 92,084 | no | no | yes |
| 31 | 931f87fe | single commit `feat(phase31)`, not an epic merge | 21 | 434,020 | 108,505 | no | no | yes |
| 32 | 843f6ec8 | `epic phase 32 (#104)` | 34 | 810,440 | 202,610 | no | no | yes |
| 33 | d0f6cf34 | `epic: 33-... integration (#163)` | 46 | 1,065,592 | 266,398 | no | yes | yes |
| 34 | 0b211b1a | squash PR `Phase 34 (#172)`, not an epic merge | 30 | 336,724 | 84,181 | no | no | yes |
| 35 | c527efea | `epic phase 35` | 23 | 353,565 | 88,392 | no | no | yes |
| 36 | f4ff8cb9 | `epic: 36-... integration (#126)` | 7 | 238,022 | 59,506 | no | no | no |
| 36 | 54b87dd3 | `epic: 36-... integration (#152)` | 53 | 1,717,644 | 429,411 | no | yes | yes |
| 39 | 76d0a33e | merge of `epic/39` (#215) | 60 | 596,452 | 149,113 | no | no | yes |
| 40 | 20228321 | merge of `epic/40` (#313) | 166 | 2,442,219 | 610,555 | yes | yes | yes |
| 41 | d60b742e | merge of `epic/41` (#239) | 23 | 411,848 | 102,962 | no | no | yes |
| 42 | 5d3b7328 | merge of `epic/42` (#263) | 15 | 240,953 | 60,239 | no | no | yes |
| 42 | 9021fb6e | merge of `epic/42` (#275) | 5 | 32,117 | 8,030 | no | no | no |
| 43 | a4e22676 | `epic: 43-... integration (#320)` | 136 | 2,656,479 | 664,120 | yes | yes | yes |
| 44 | a18293a8 | merge of `epic/44` (#342) | 34 | 429,756 | 107,439 | no | no | yes |
| 45 | 845fd6d7 | merge of `epic/45` (#381) | 73 | 1,614,765 | 403,692 | no | yes | yes |
| 46 | 7eebae48 | merge of `epic/46` (#403) | 129 | 1,932,900 | 483,225 | no | yes | yes |
| 47 | d8a70dec | squash `phase47 native handoff safeguards (#421)` | 109 | 3,438,635 | 859,659 | yes | yes | yes |
| 49 | c7633d9e | squash `streamline architecture review and phase delivery (#456)`, body lists T-49-01 onward | 64 | 3,598,345 | 899,587 | yes | yes | yes |
| 50 | 92453193 | `epic: 50-... integration (#521)` | 107 | 2,043,597 | 510,900 | no | yes | yes |

Phases with no landing commit identified: 37, 38 and 48. Search: `git log --first-parent --format='%H %ad %s' --date=short -i -E --grep='epic/(2[0-6]|3[78]|48)|epic: (2[0-6]|3[78]|48)-|phase ?(2[0-6]|37|38|48)([^0-9]|$)'` returned no commit for them (and the earlier search for 29, 31, 34, 37, 38, 47, 48 and 49 found none for 37, 38 and 48). Their work may have landed inside another phase's merge or under a subject these patterns miss; that is unknown, and the next check is `git log --first-parent --format='%h %s' --since=<phase date>` read by a person.

Summary statistics (30 rows). A `node -e` one-liner to compute them was refused by the executor's permission layer, so these figures were computed by hand from the 30 rows above and **must be confirmed** with the operator check below. Median is the mean of the 15th and 16th ordered values; 90th percentile is the nearest rank, the 27th ordered value.

| Quantity | Count | Min | Median | 90th percentile | Max |
|---|---|---|---|---|---|
| Product files | 30 | 5 | 32 | 109 | 166 |
| Product diff bytes | 30 | 32,117 | 573,226.5 | 2,442,219 | 3,598,345 |
| Estimated tokens | 30 | 8,030 | 143,307 | 610,555 | 899,587 |

Threshold counts: 4 of 30 landings exceed 2 MiB (phases 40, 43, 47, 49); 9 of 30 exceed 1 MiB (those four plus 33, 36 `54b87dd3`, 45, 46, 50); 25 of 30 exceed 60,000 estimated tokens (all except 22, 23, 29, 36 `f4ff8cb9` and 42 `9021fb6e`); 2 of 30 exceed 750,000 estimated tokens (47 and 49). Landings at or under 1 MiB: 21 of 30.

Statistics of the table (as recorded by the original ticket): product_files `min 5 median 32 p90 109 max 166`; product_diff_bytes `min 32117 median 573226.5 p90 2442219 max 3598345`; estimated_tokens `min 8030 median 143307 p90 610555 max 899587`; `over 2 MiB 4 over 1 MiB 9 over 60k tokens 25`.

### The phase-49 row does not reproduce 6,530,992, and the method differs

The phase-49 landing `c7633d9e` measures 3,598,345 product diff bytes. With no pathspec (`git diff --no-ext-diff --no-textconv --unified=50 c7633d9e^ c7633d9e | wc -c`) it measures 3,604,512 bytes; the artifact share (`-- .planning docs/audits CLAUDE.md AGENTS.md`) is 6,167 bytes. So neither number is 6,530,992.

The figure 6,530,992 is not a diff size. It is `material_bytes` in `tests/smoke/phase49-final-review-acceptance.cjs` (the assertions `value.benchmark.material_bytes, 6530992` and `runtime.input_accounting.material_bytes, 6530992`) with `successful_reads: 830`: the byte total of the review input material that `prepareFileInput` in `codex-arch-review-context.cjs` hands the reader. For the focused contract that material is `[packet JSON, ...128 KiB partitions of current-pr.diff and every required reference]`, so the diff and references are counted twice (once inside the packet JSON, once as partitions) plus packet metadata. Two consequences, both read from `prepareFileInput` and not measured:

- material bytes are about `2 x (diff + references) + metadata`, so the largest landing here (3,598,345 B) needs about 7.2 MB of material plus references; and
- 6,530,992 B of material corresponds to a diff-plus-references of about 3.27 MB, which is less than the final landing's 3.60 MB. This is consistent with the benchmark having been taken at an earlier epic head than the squash. The benchmark head is recorded only in a private ledger (`~/.local/state/shipyard/phase49-focused-review-T49-11-original-pre-focused-ledger/phase49-final-review-acceptance.json`, sha256 `f461880d2719d951df4e7381f450fa3fa24770a0494cadae0b055fdbd3640ef8`, per the `historical_ledger` field of `docs/audits/phase49-final-review-acceptance.json`), which the executor cannot read.

Assumption, with the next check: the earlier-head explanation is an inference. The operator can confirm it by measuring the product diff at the epic head named in the private ledger.

### Limits of this measurement

- The tool counts product paths only, as the plan specifies. Both current arch-review paths read the complete PR diff with no pathspec (`prepareArch` in `claude-role-host.cjs`; the focused path of `codex-arch-review-context.cjs`, where `development` reports "included in the complete PR diff"). Only the Claude integrator (`diffText` with `productPathspec()`) and the Codex `legacy` path exclude artifacts. For the one landing measured both ways (phase 49) the difference is 6,167 bytes (0.17 percent); it is not measured for the other 29.
- A merge or squash commit measures the net result against its first parent, not the diff a reviewer saw while the epic head moved. The two can differ when the base moved after the review.
- Phases 31 and 34 are single commits, not epic merges, and phases 36 and 42 have two landings each. All 30 rows are counted as separate landings.

## 2. Which bound actually refuses a large review (verified by reading the symbols)

Status: verified. Every row names the symbol; no line numbers are cited because they go stale (phase-50 review finding IN-02).

### Claude (`plugins/delivery-pipeline/scripts/claude-role-host.cjs`)

| Bound | Value | Applies to | Effect when exceeded |
|---|---|---|---|
| `DIFF_MAX_BYTES` in `diffText` | 2 MiB (2,097,152) | integrator only (`prepareIntegrator` calls `diffText` with `productPathspec()`) | refuses with "role diff exceeds the bounded context packet"; a git output over the buffer is mapped from `INPUT_TOO_LARGE` to the same refusal |
| `DIFF_MAX_BYTES` as `maxBuffer` of the name-only, name-status and numstat inventories in `prepareArch` | 2 MiB each | arch-review | `command` raises `INPUT_TOO_LARGE`; these outputs are about one line per changed file, so they are far below the bound (phase 43 changed 136 product files) |
| `FILE_LIMITS.material` as `maxBuffer` of the diff read in `prepareArch` | 16 MiB (16,777,216) | arch-review | `INPUT_TOO_LARGE` from `command` |
| `ARCH_REVIEW_PACKET_TOKENS` through `packetBound` and `buildPacket` | 60,000 estimated tokens | arch-review | **does not refuse.** `buildPacket` rejects overflow only for roles other than `arch-review`; for `arch-review` the packet records `accounting.overflow = true`. In `buildContextPacket` an estimate over the ceiling only strips the content of optional references (it keeps their digest references) and adds the `overflow` record. The packet `prepareArch` builds passes no optional references (assumption read from `buildPacket`: `selectedBacklogIds` is `[]` for `arch-review` and only `requiredRefs` are given), so today the ceiling is a marker and changes no content |
| `PROMPT_MAX_BYTES` in `makePrompt` | 3,000,000 | arch-review (non-focused) and integrator | refuses `CONTEXT_PACKET_OVER_BOUND` with `limiting_field: complete_inline_prompt_bytes`; **skipped when `packet.role_context.focused` is set**, which `prepareArch` always sets |
| `INTEGRATOR_MAX_PACKET_TOKENS` through `packetBound` | 750,000 estimated tokens (`min(750000, 60000 + ceil(diffBytes / 3))`) | integrator | `buildPacket` rejects with `CONTEXT_PACKET_OVER_BOUND` |
| literal `1024 * 1024` in `createClaudeRoleHost` `run` | 1,048,576 | arch-review | not a refusal: a prompt over it is relayed through `prepareFileInput`; the relay is refused only if prompt plus `generated_instruction_bytes` still exceed 1,048,576 ("focused file relay and instructions exceed ordinary launch capacity") |
| `prepareFileInput` material and reads (`codex-arch-review-context.cjs`, called by `run`) | `FILE_LIMITS.material` 16 MiB total; `FILE_LIMITS.reads` 2,064 reads at `INPUT_CHUNK_BYTES` 8 KiB (about 16.1 MiB) | arch-review above 1 MiB | `CONTEXT_OVER_BOUND` "complete material exceeds its bound" |

Which bound refuses a large review on Claude:

- **Integrator:** `DIFF_MAX_BYTES` (2 MiB) refuses first. Four of 30 landings exceed it (phases 40, 43, 47, 49: 2,442,219; 2,656,479; 3,438,635; 3,598,345 bytes). Phase 50's landing (2,043,597 B) is 53,555 bytes under it, which is consistent with 2 MiB having been chosen to fit that phase. `INTEGRATOR_MAX_PACKET_TOKENS` would refuse the two landings over 750,000 estimated tokens next.
- **Arch-review:** no constant refuses a 3.6 MB diff. The first refusing bound is the relay material ceiling, `FILE_LIMITS.material` (about 16 MiB of material, which is about 8 MiB of diff less references, because the diff is carried twice). `ARCH_REVIEW_PACKET_TOKENS` and `PROMPT_MAX_BYTES` do not refuse it.
- **Not expressed by any host constant:** the model's own context window. The diff alone of the four largest landings is 610,555 to 899,587 estimated tokens. Whether a reviewer can read that is the question section 3 exists to answer, and the host would admit the input either way.

### Codex (`plugins/delivery-pipeline/scripts/codex-arch-review-context.cjs`)

| Bound | Value | Effect when exceeded |
|---|---|---|
| `INPUT_MAX_BYTES` | 1 MiB (1,048,576) | a complete prompt over it is not refused: it moves to file input (`prepareFileInput`). It also bounds the launch itself: `preflightReaderSchedule` refuses `complete_launch_input_bytes` when relay bytes plus generated instruction bytes exceed it, and a non-file launch refuses with "generated instructions plus complete review prompt exceed the launch bound" |
| `FILE_LIMITS.material` as `maxBuffer` of the diff, name-only, name-status and numstat reads | 16 MiB | `run` fails with `CONTEXT_OVER_BOUND` "complete input exceeds its bound" |
| serialized review input | `FILE_LIMITS.material` | `fail('complete review input exceeds its bound')` |
| `prepareFileInput` total material and reads | 16 MiB material; 2,064 reads at 8 KiB chunks (`INPUT_CHUNK_BYTES`, about 16.1 MiB) or 128 KiB chunks with measured reader capacity (about 258 MiB, so material binds first) | `CONTEXT_OVER_BOUND` "complete material exceeds its bound" |
| `FILE_LIMITS.relay` | 64 KiB | refuses a relay prefix over it |
| batch transport (`preflightReaderSchedule`) | 252 KiB per batch envelope (`output_budget_bytes`), 128 MiB total encoded schedule | `capacityRefusal('finite_batch_envelope_bound' ...)` and `complete_encoded_schedule_bytes` |

Which bound refuses a large review on Codex: the 16 MiB material bound of `prepareFileInput` (or the 2,064-read bound just before it at the default 8 KiB chunk). `INPUT_MAX_BYTES` does not refuse a large review; it decides that the review goes through file input and caps the launch prompt itself. The recorded phase-49 Codex benchmark (6,530,992 B of material, 830 successful reads; the acceptance record requires `runtime: codex`) was inside both bounds. The Codex integrator host was not read for this table, so no integrator bound is claimed for Codex.

## 3. Model context windows (runtime-reported)

Status: measured. The figures are the runtime's own reports, read from existing session records on 2026-10-19; none comes from vendor documentation. Label: `runtime-reported`. The model identifiers are the ones in the dispatch policy.

| Model | Context window (tokens) | Maximum output (tokens) | Source | Date read | Label |
|---|---|---|---|---|---|
| Claude Sonnet (`claude-sonnet-5-5`) | 1,000,000 | 128,000 | the `modelUsage` object (`contextWindow`, `maxOutputTokens`) in a Claude Code session transcript and in the transcript of the decomposition host launch of 2026-10-16 | 2026-10-19 | runtime-reported |
| Claude Opus (`claude-opus-5-5`) | 1,000,000 | 128,000 | the same `modelUsage` fields in 4 Claude Code session transcripts, among them the arch-review role launch of the phase-45 ticket T-45-03 | 2026-10-19 | runtime-reported |
| Codex Sol (`gpt-6.1-sol`) | 258,400 in 10 launches and 475,000 in 3 launches | not exposed (the rollout events carry no output limit) | `model_context_window` in the `task_started` and `token_count` events of the Codex rollouts (`~/.codex/sessions/**/rollout-*.jsonl.zst`) of the arch-review launches counted in `arch-review-cost.md`; the previous Sol id `gpt-6-sol` reported 258,400 in 50 launches | 2026-10-19 | runtime-reported |

An older Claude alias `claude-sonnet-5` (not used by the current grid) reported a maximum output of 64,000 in the same records; it is listed only so the 128,000 above is not read as universal.

The spread between 258,400 and 475,000 for the same Codex model id is unexplained by the records (it may follow the launch configuration); the smaller value is the safe bound until a launch is shown to carry the larger.

Comparison (diff sizes from section 1, estimated tokens). A review needs the diff plus the instructions and references and room for the verdict. The instruction overhead is taken as about 60,000 tokens (the current `ARCH_REVIEW_PACKET_TOKENS` soft ceiling is the nearest recorded figure; it is an assumption, not a measurement), and the output reserve is the model's maximum output.

| Landing | Diff tokens | Claude (1,000,000 window, 128,000 output reserved; room for the diff about 812,000) | Codex Sol (258,400 window; output unknown) |
|---|---|---|---|
| Median | 143,307 | fits in one context | fits only if instructions and output stay under about 115,000 tokens; no reference budget is left |
| 90th percentile | 610,555 | fits in one context, with about 200,000 left for references | does not fit; needs partitioned complete-input reading |
| Largest (phase 49) | 899,587 | does not fit (diff plus overhead is about 1,087,587 including the output reserve); needs partitioned complete-input reading | does not fit, even at 475,000 |

Which of the three models can hold the largest, the 90th percentile and the median landing in one context: Claude Sonnet and Claude Opus hold the median and the 90th percentile, not the largest; Codex Sol holds at most the median. Consequence for the design: phases like 47 (859,000) and 49 (899,587) exceed what a Claude single packet can carry, and every phase above the median needs partitioning on Codex, so the complete-input partitioned approach is required on both runtimes, as ADR-032 already assumes.

## 4. Chosen values

Rows 1, 2, 3, 5 and 6 are **proposals derived from sections 1 and 2** for the operator to accept or change; they are decisions, not measurements, and the derivation is shown so each can be re-derived. Rows 4 and C use the section 3 windows and the R-30 figures. No product constant changes in this ticket; plan 52-05 copies the accepted values into constants whose own tests pin them.

| # | Limit | Current on main 1c34583b | Proposed value | Derivation (measurement behind it) |
|---|---|---|---|---|
| 1 | Claude inline packet bound for the code review (complete prompt bytes above which the host relays through files) | no code-review constant exists; arch-review relays above the literal 1,048,576 in `run` | 1,048,576 bytes, unchanged | 21 of 30 landings have a product diff at or under 1 MiB before prompt overhead (median 573,226.5 B). The other 9 are carried by the relay path, whose bound is row 2, so the inline bound need not rise to admit the largest phase |
| 2 | Claude complete-input ceiling for the code review (material carried through the relay) | `FILE_LIMITS.material` = 16,777,216 for arch-review | 16,777,216 bytes, unchanged | by `prepareFileInput`, material is about `2 x (diff + references) + metadata`; the largest landing (3,598,345 B) needs about 7.2 MB plus references, about 43 percent of the ceiling. The same `prepareFileInput` admitted the recorded phase-49 benchmark on Codex (6,530,992 B, 830 reads); no Claude run of a large review was observed by this ticket. Assumption: the factor 2 is read from code, not measured; the operator can measure it by building the focused packet for the phase-49 landing and reading `manifest.accounting.material_bytes` |
| 3 | `DIFF_MAX_BYTES` | 2,097,152 | 6,291,456 bytes (6 MiB) | 4 of 30 landings exceed 2 MiB today, so the integrator refuses them. 6 MiB is 1.75 x the largest landing (3,598,345 B) and `2 x 6 MiB = 12 MiB` leaves 4 MiB of the 16 MiB material ceiling for references and packet metadata, so an admitted diff always fits row 2 |
| 4 | `ARCH_REVIEW_PACKET_TOKENS` | 60,000 | 550,000 estimated tokens (the Claude value of C2 below; the interim 1,632,864 is rejected because it exceeds the 1,000,000 window of section 3, and no packet may exceed about 800,000 = 1,000,000 window - 128,000 output - about 60,000 instructions, rounded down) | 25 of 30 landings exceed 60,000 tokens on the diff alone, so the soft ceiling flags nearly every review as overflow while changing no content (section 2). Above 550,000 the host partitions the complete input instead of carrying it in one packet. The value is the Claude C2 of this table; the unit caveat of C1 and C2 applies (a packet size and a processed-token cost are different quantities) |
| 5 | Codex `INPUT_MAX_BYTES` | 1,048,576 | 1,048,576 bytes, unchanged | it does not refuse a large review (section 2); it routes it to file input and caps the launch prompt (relay plus generated instructions). Raising it would enlarge the launch prompt, not the material a review can read. Same 21 of 30 split as row 1 |
| 6 | Codex `FILE_LIMITS.material` (the Codex-side bound that refuses a large review) | 16,777,216 | 16,777,216 bytes, unchanged | same derivation as row 2: the largest landing needs about 7.2 MB plus references, and the phase-49 benchmark was admitted at 6,530,992 B with 830 of 2,064 reads |
| C1 | Per-launch cost ceiling, code review (estimated tokens per launch) | none | Claude 550,000; Codex 4,250,000 (processed tokens per launch; see the caveat below) | rule: the smallest multiple of 50,000 above the 90th percentile tokens per launch measured for `arch-review` in `arch-review-cost.md` (Claude p90 524,773, Codex p90 4,248,540), and never above the section 3 window of the model the launch runs on. The per-round ceiling equals the per-launch ceiling. Caveat: the measured unit counts every token a multi-turn launch processed, cache reads included, and a window bounds one context; the rule's cap by the window can therefore only be applied to the Claude value (550,000 is under the 1,000,000 window), and applying it to the Codex value would set a ceiling of 258,400 under the Codex median of 2,580,329 processed tokens, which no launch could meet. The Codex ceiling is therefore stated in the measured unit and the operator must accept that reading |
| C2 | Per-launch cost ceiling, `arch-review` (estimated tokens per launch) | none | Claude 550,000; Codex 4,250,000 | same rule and caveat; the Claude value is the final value for row 4. The code-review role has no measured launches yet, so its ceiling starts equal to this one, which is the structural bound of ADR-032 (no more than one `arch-review` per phase) |
| C3 | Per-phase worst case | none | `3 x` the per-launch ceiling | the plan allows at most three code-review rounds per phase, so a phase can run three launches; the ceiling is per launch and per round, never a per-phase figure |

If the operator rejects row 3 or row 4's interim value, the constraint to keep is: `DIFF_MAX_BYTES` times 2 plus the references budget must stay at or under row 2's ceiling, or an admitted diff can still be refused by the relay.

### Operator choices (2026-10-19)

Revision 12 of the delivered T-52-05 PLAN authorizes these operator choices derived from the existing measured evidence. This subsection supersedes Section 4's proposals for implementation. The proposal rows above, measurement history, derivations, assumptions and unknowns remain historical evidence; these choices do not assert a new source measurement. The file's measurement status remains `measured`.

| Quantity | Value and unit | Meaning |
|---|---|---|
| Claude `CODE_REVIEW_PACKET_TOKENS` | 262144 estimated packet tokens | Inline packet estimate, derived as 1048576 bytes / 4. The Claude code-review packet carries no diff: the reviewer reads it with git, split into path-group parts by one changed-line budget per runtime. |
| Codex `INPUT_MAX_BYTES` | 1048576 bytes, unchanged | Launch-prompt byte bound; a code-review prompt above it refuses before any part runs. |
| Codex code-review `PART_BUDGET` | 10000 changed lines per part | One part per path group within the Sol window; Claude uses 40000. |
| Codex `FILE_LIMITS.material` | 16777216 material bytes, unchanged | Complete-input material capacity. |
| Claude `DIFF_MAX_BYTES` | 6291456 diff bytes | The supported 6 MiB choice from Section 4 row 3. |
| Claude `ARCH_REVIEW_PACKET_TOKENS` | 550000 estimated packet tokens | The supported packet-size choice from Section 4 row 4. |
| Processed-token cost observations | Claude 550000; Codex 4250000 processed tokens per launch | Retained cost evidence with the C1/C2 cache-read and context-window caveats; neither figure defines input capacity or an implemented token-spending meter. |

The equal numeric Claude packet and cost figures, 550000, have different units: estimated packet tokens versus processed tokens per launch. Material capacity, inline packet estimates, prompt-byte routing and processed-token cost are separate quantities. Material bytes do not equal cost tokens. Up to three rounds may run three launches; the material ceiling applies independently to each launch and asserts neither a token cost nor a phase-wide capacity.

A diff under 6291456 bytes can still exceed the complete-material ceiling after references and packet metadata are included. This supersedes row 3's historical inference that an admitted diff always fits row 2. The full material bound is enforced independently, with no admission inferred from the diff bound and no partial review of input above the ceiling. Source partitions preserve all admitted material above inline size. Product tests pin constants with their units and the separate byte-routing boundary; this audit subsection records execution evidence and is not a product-test target (DS-11).

## Commands run by the executor

All from the worktree; each result is quoted above.

- `shasum -a 256 <each path in the Inputs table>`
- the measuring tool over the 30 commits of section 1 (exit 0; the tool was removed in HS-12)
- `git log --first-parent --format='%H %ad %s' --date=short -i -E --grep=<pattern>` (three patterns, quoted in section 1)
- `git rev-parse <short sha> ...` to expand the 30 commit ids
- `git diff --no-ext-diff --no-textconv --unified=50 c7633d9e^ c7633d9e | wc -c` (3,604,512) and the same with `-- .planning docs/audits CLAUDE.md AGENTS.md` (6,167)
- `node -e` over `docs/audits/phase49-final-review-acceptance.json` to list its keys and print `historical_ledger`
- `grep` (the Grep tool) for `6,?530,?992` across the repository (matches only the two phase-49 test and smoke files)
- reading the symbols named in section 2 with the Read tool at the input digests above
