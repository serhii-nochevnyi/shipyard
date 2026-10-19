# Phase 52 audit evidence: the ADR-032 first-ticket spikes (T-52-02)

date: 2026-10-19
host: executor sandbox, macOS Darwin 27.0.0, node v24.21.0, git 2.54.0 (Apple Git-157), worktree T-52-02 at HEAD e8299ce01e729f5e0c19e99477a33bb066ef4806 (main 1c34583b, Shipyard 0.73.0)

ADR-032 closes four open items as first-ticket spikes. This directory holds the evidence for each. No production source, limit or default changes in this ticket; later tickets copy the accepted values into product constants whose own tests pin them, and the hold is enabled only after this evidence is merged.

## Index

Status values: `measured`, `inconclusive`, `verified`, `not-verified`, and `pending-operator` (a figure the executor could not produce). The statuses below are the state at executor handoff. The operator updates each one on this branch before the merge checkpoint, and no `pending-operator` may remain at merge.

| Spike | Subject | File | Status at handoff | What is already in the file | What the operator must add | Inputs (sha256 of what was read) |
|---|---|---|---|---|---|---|
| R-27 | raised packet limits | [packet-limits.md](packet-limits.md) | pending-operator | the 30-landing diff-size table (measured), the bound that refuses a large review on each runtime (verified from the symbols), proposed values for six limits with their derivation | the model context windows (operator-supplied), confirmation of the hand-computed statistics, the final value of `ARCH_REVIEW_PACKET_TOKENS` and the per-launch cost ceilings | listed in the file's Inputs table; tool output `diff-sizes.json` `5dcd42d7f12854ce4101c3ca1906c2170260ee39980040dbd8da067d679dd55b` |
| R-30 | `arch-review` cost baseline | [arch-review-cost.md](arch-review-cost.md) | pending-operator | the exact command, the cohort definition, a ready script, the ADR-022 launch-cost assumptions (verified) with its SHA-256, and the structural bound per launch and per round | the figures, from the attribution ledger `.planning/graph/usage-attribution.jsonl` (absent from this tree) and the Claude and Codex transcripts; or `inconclusive` with the reason | ADR-022 `30e3b3f28a6082e78da9c1765c4248df18fee662bffc8db16075963572b922f6` |
| R-31 | GSD finding identity | [gsd-reviewer-contract.md](gsd-reviewer-contract.md) | pending-operator (provisional reading: not-verified) | the id grammar, schema and the source of `path` and `line`, counted over a real tracked GSD review report; the finding that the report carries no rule field; the two disposition sources | the reviewer agent path, SHA-256, prompt excerpt and GSD version; whether prior dispositions are accepted; the replayed fix round; the verdict | `50-REVIEW.md` `21c91b48e7faedba4ddee8549f5cac40043000d3b6528831b6f0b30eff5eec0e`; sample `84b0667f4f5bf82e3b2b84c6f450e9c8645f4f79b6a3ff7d6a5a55b6a078d62c` |
| R-32 | same-family catch rate | [catch-rate.md](catch-rate.md) | pending-operator | 6 of the 13 defects identified from the backlog notes with their sources, one false-positive control, the replay protocol, the cascade definition | the 7 remaining defects from the GitHub threads, the replay results per runtime, the catch rates and the cascaded fraction | the four backlog notes listed in the file's Inputs table |

Other files: [diff-sizes.json](diff-sizes.json) (the tool's JSON output behind the R-27 table) and [samples/](samples/) (a verbatim excerpt of a real GSD review report).

## What each status means downstream

| Spike | Status | Effect |
|---|---|---|
| R-27 | `measured` | plan 52-05 may copy the chosen values into constants |
| R-27 | `inconclusive` | **plan 52-05 and every ticket after it stay blocked** until the measurement is repeated. The operator holds this ticket's merge until R-27 reads `measured`, or merges it only to record the gap and re-opens this ticket's evidence |
| R-30 | `measured` or `inconclusive` | later tickets proceed; an `inconclusive` baseline leaves the per-launch cost ceilings to be set by the rule in `packet-limits.md` once a baseline exists, and `arch-review-cost.md` must state the reason and the next check |
| R-31 | `verified` | plans 52-03, 52-06 and 52-12 may proceed |
| R-31 | `not-verified` | **the phase stops**: the role does not ship without a verified finding identity |
| R-32 | `measured` or `inconclusive` | later tickets proceed; the figure informs how the role is described, not whether it ships |
| any | `pending-operator` | not allowed at merge; it means a figure the executor could not produce is still missing |

## The tool

`tests/smoke/phase52-diff-sizes.cjs` measures the first-parent product diff of landing commits: `node tests/smoke/phase52-diff-sizes.cjs --repo <dir> --commit <sha> [--commit <sha> ...] [--json]`. A sha must be 40 lowercase hex characters; a root commit or an unknown sha exits 1 and names it; a usage error exits 2. Its test is `node --test tests/unit/phase52-diff-sizes.test.cjs`. It reports `over_diff_max_bytes` (more than 2,097,152 bytes, the `DIFF_MAX_BYTES` of main), `over_legacy_diff_max_bytes` (more than 1,048,576 bytes, the bound before phase 50) and `over_arch_review_tokens` (more than 60,000 estimated tokens).

## Operator checklist at the merge checkpoint

1. Confirm the executor's hand-computed statistics in `packet-limits.md` with the `node -e` command in that file (expected output is printed beside it).
2. Fill the model windows, with sources and dates, in `packet-limits.md` section 3; accept or change the proposed values in section 4; set the final `ARCH_REVIEW_PACKET_TOKENS` and the cost ceilings.
3. Run the R-30 command and fill `arch-review-cost.md`, or set it to `inconclusive` with the reason and next check.
4. Read the reviewer agent, fill `gsd-reviewer-contract.md` sections 4 to 6, and set the verdict.
5. Fetch the remaining defects, run the replay and fill `catch-rate.md`.
6. Review every committed sample for tokens, account ids and private transcript content.
7. Set each file's `status:` line, update the Index above, and confirm no file still contains `PENDING-OPERATOR` or `status: pending-operator`.
8. Check that `git diff --name-only` for the ticket lists only paths inside `docs/audits/phase52/**`, `tests/smoke/phase52-diff-sizes.cjs` and `tests/unit/phase52-diff-sizes.test.cjs`.
