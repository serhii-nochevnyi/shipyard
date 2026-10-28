# R-30: arch-review launch-cost baseline and the effect of a raised packet limit

status: measured
date: 2026-10-19
host: executor sandbox, macOS Darwin 27.0.0, node v24.21.0, git 2.54.0 (Apple Git-157), worktree T-52-02 at HEAD e8299ce01e729f5e0c19e99477a33bb066ef4806 (main 1c34583b, Shipyard 0.73.0)

Section status:

| Section | Status | Why |
|---|---|---|
| 1. Baseline figures (tokens per phase review and per launch) | measured, with the caveats listed in the results | the attribution ledger is absent from the tree (evidence below), so a ledger was built on 2026-10-19 from the host launch receipts and the runtime transcripts they point to, and `usage-report.cjs` was run over it; the report was comparable with 0 warnings |
| 2. ADR-022 launch-cost assumptions | verified | quoted from the file at the digest below |
| 3. Structural bound | verified | read from `model-policy-internal.cjs` and `claude-role-host.cjs` at the digests below |

Plan 52-05 points at this file and does not edit ADR-022.

## Inputs

Digests were taken with `shasum -a 256 <path>` in the worktree.

| Input | sha256 |
|---|---|
| `.planning/architecture/ADR-022-review-stage-efficiency.md` | `30e3b3f28a6082e78da9c1765c4248df18fee662bffc8db16075963572b922f6` |
| `.planning/architecture/ADR-021-subscription-efficiency-per-runtime.md` | `fc64afb80278a3c9c16b3b7ceea456527c60baa5e8c6a7ea4e7bd86fc948f220` |
| `plugins/delivery-pipeline/scripts/usage-report.cjs` | `751a4fa13e8a762bd5547502eea2bc8ee8fd0f1b326615e3e0198f2b53f232ea` |
| `plugins/delivery-pipeline/scripts/claude-role-host.cjs` | `6a7c5283d6f85a4f01389567620ef4700c2639efd3af6382027b3cea4f366744` |

## 1. Baseline figures

### Why the executor could not produce them

- `ls -la .planning/graph/usage-attribution.jsonl` exits 1 with `No such file or directory`. The directory listing (`ls .planning/graph`) shows `ci-waits.json delivery-front.json delivery-log.jsonl delivery-state-meta.json delivery-state.json delivery-state.yaml dispatches.json drift.json escalations.json pr-ledger.json tickets.json tickets.yaml`.
- The tracked journal `.planning/graph/delivery-log.jsonl` has 1,783 lines. The Grep tool counted 127 lines that mention `arch-review` (any spelling matching `arch.review`), and 2 lines that mention both `arch-review` and a ticket of phases 43 to 49 (pattern `arch.review.*T-(4[3-9])-|T-(4[3-9])-\d\d.*arch.review`). Two rows cannot establish a cohort of phases 43 to 49, and the journal has no token fields. ADR-022 says the same: "The tracked journal holds no review rows for phases 40-44." The journal therefore cannot replace the ledger.
- The Claude and Codex session transcripts the report needs live in the operator's home directory, outside the executor sandbox.

### Cohort definition

Per-phase `arch-review` launches of phases 43 to 49, on each runtime separately (Claude and Codex), counting every launch including re-owed reviews (a review repeated because the head moved, the base moved, an input changed or a violation was repaired). A launch is one `dispatch_id` whose attribution row has `role: arch-review`. A phase review is the sum of all its launches. A phase is attributed from the ticket id (`T-<phase>-<nn>`) or from a `phase=<directory>` subject. Phase 48 has no identified landing (see `packet-limits.md`); record it as a row with zero launches if the ledger has none, never omit it.

### Command (operator, read-only)

`usage-report.cjs` takes explicit transcript files and an explicit ledger and prints JSON; it never writes. Run it from the worktree on this branch, passing every Claude and Codex transcript for phases 43 to 49 (the operator lists them; the directory layout is an assumption to confirm with `ls`):

```
node plugins/delivery-pipeline/scripts/usage-report.cjs \
  <claude-transcript.jsonl> [more.jsonl ...] <codex-transcript.jsonl> [more.jsonl ...] \
  --attribution .planning/graph/usage-attribution.jsonl > "$TMPDIR/usage-report.json"
```

It exits 1 when `comparable` is false (a path warning or a malformed row); record the warnings with the result and treat the figures as `inconclusive` until they are explained.

Then derive the cohort from the report's `observations` (fields used: `role`, `dispatch_id`, `ticket`, `runtime`, `input_tokens`, `output_tokens`; the report states `units: tokens processed; not subscription quota`). Keep the raw report out of the repository (it carries session and dispatch ids); commit only the derived tables below.

```
node -e '
const rows = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).observations
  .filter(o => o.role === "arch-review" && o.dispatch_id && o.input_tokens !== null);
const phaseOf = t => { const m = /^T-(\d+)-\d+$/.exec(t || "") || /^phase=0*(\d+)/.exec(t || ""); return m ? Number(m[1]) : null; };
const launches = new Map();
for (const o of rows) {
  const k = o.runtime + "|" + o.dispatch_id;
  const l = launches.get(k) || { runtime: o.runtime, phase: phaseOf(o.ticket), tokens: 0 };
  l.tokens += o.input_tokens + (o.output_tokens || 0); launches.set(k, l);
}
const rank = (a, p) => [...a].sort((x, y) => x - y)[Math.ceil(p * a.length) - 1];
const median = a => { const s = [...a].sort((x, y) => x - y), n = s.length; return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2; };
for (const runtime of ["claude", "codex"]) {
  const mine = [...launches.values()].filter(l => l.runtime === runtime && l.phase >= 43 && l.phase <= 49);
  const perPhase = new Map();
  for (const l of mine) perPhase.set(l.phase, (perPhase.get(l.phase) || 0) + l.tokens);
  const lt = mine.map(l => l.tokens), pt = [...perPhase.values()];
  console.log(runtime, "launches", lt.length, "per-launch median", median(lt), "p90", rank(lt, 0.9), "| phases", pt.length, "per-phase median", median(pt), "p90", rank(pt, 0.9));
}' "$TMPDIR/usage-report.json"
```

(The statistic definitions match `packet-limits.md`: median is the mean of the two middle values; 90th percentile is the nearest rank. If a runtime has no launches the line prints `NaN`; record `0 launches`, not a figure.)

### How the figures were produced (2026-10-19)

No attribution ledger exists anywhere on the host (a search found only unit-test fixtures), so the command above was run over a ledger built for this purpose, not an existing one:

1. The host launch receipts (`~/.local/state/shipyard/{claude,codex}/*/receipts/record-*.json`) of role `arch-review` for phases 43 to 49 gave 85 launches, each with a `dispatch_id`, the runtime, the ticket or phase subject, the resolved model and effort and the path of the runtime transcript it produced (Codex transcripts are zstd-compressed rollouts under `~/.codex/sessions`; they were decompressed into a scratch directory).
2. One attribution row per launch was written through `usage-attribution.cjs record` into a scratch graph directory outside the repository (85 rows recorded, none refused).
3. `usage-report.cjs` ran over the 85 transcripts with that ledger: `comparable: true`, 0 warnings, 2,418 observations; units are tokens processed, including cache reads, not subscription quota.
4. The per-launch and per-phase figures below are the plan's script applied to the report, plus a second pass that keeps launches whose subject is an epic or a phase instead of a ticket (the plan's script drops them because it parses the phase from a `T-NN-NN` ticket id).

The scratch ledger and the raw report carry session and dispatch ids and stay out of the repository; only the derived tables are committed. A reader can rebuild the ledger from the receipts with the same four steps; the figures depend on the receipts present on the operator's host.

### Results

| Runtime | Phases with launches | Launches | Per-launch median tokens | Per-launch 90th percentile | Per-phase median tokens | Per-phase 90th percentile | Warnings from the report |
|---|---|---|---|---|---|---|---|
| Claude | 43, 44, 45 | 22 | 303,730.5 | 524,773 | 2,969,713 | 3,504,828 | 0 |
| Codex (ticket launches) | 43, 45, 46, 47 | 59 | 2,580,329 | 4,248,540 | 40,968,751 | 70,030,785 | 0 |

Ranges: Claude per launch 121,018 to 961,675; Codex per launch 638,139 to 6,960,073. Of the tokens processed, almost all are cache reads: the uncached input plus output per launch has a median of 122.5 tokens on Claude (90th percentile 155) and 183,132 on Codex (90th percentile 363,647). The input that the arch-review judged, where the transcript records it, has a median of 17,699 tokens and a maximum of 34,656 on Claude, and a median of 86,942 and a maximum of 239,194 on Codex.

Per-phase table (the plan's script counts only launches whose subject is a ticket; epic launches are shown on their own rows and are not in the medians above):

| Phase | Runtime | Subject | Launches | Re-owed launches | Tokens per phase review |
|---|---|---|---|---|---|
| 43 | Claude | ticket | 2 | 0 | 1,296,005 |
| 44 | Claude | ticket | 9 | 1 | 2,969,713 |
| 45 | Claude | ticket | 11 | 1 | 3,504,828 |
| 43 | Codex | ticket | 30 | 13 | 70,030,785 |
| 45 | Codex | ticket | 20 | 13 | 69,240,093 |
| 46 | Codex | ticket | 7 | 2 | 12,697,409 |
| 47 | Codex | ticket | 2 | 0 | 6,038,592 |
| 47 | Codex | epic | 1 | 0 | 128,112,237 |
| 49 | Codex | epic | 3 | 2 | 23,906,967 (10,544,751, 2,925,450 and 10,436,766 per launch) |

"Re-owed launches" is the number of launches minus the number of distinct subjects in the phase and runtime. The receipts do not say why a launch repeated, so it counts every repeat (a moved head or base, a changed input, a repaired violation) and cannot be split into the cohorts ADR-022 asks for. Phase 48 has no arch-review launches in the receipts.

Caveats the operator must read before accepting the ceilings:

- **The Claude data is the old grid.** The 22 Claude launches ran `claude-opus-5-5` at medium or high effort under the policy of the time (v6), not the current Sonnet at xhigh base rung; a Sonnet launch would not cost the same. Claude has no data for phases 46 to 49: those phases ran on Codex only.
- **Phase 49 has only epic-subject launches**, which is also the only case that resembles the phase-level review this ADR adds. The epic launches (4 in all, from phases 47 and 49) processed 128,112,237, 10,544,751, 2,925,450 and 10,436,766 tokens, with a judged input of 1,699,400 to 2,105,467 tokens, 10 to 60 times the ticket launches' judged input.
- **The unit is processed tokens, not packet tokens.** A multi-turn launch re-reads its context from cache on each turn, so the processed total is many times the packet. The ceilings in `packet-limits.md` are therefore stated in the measured unit and are not packet sizes.
- **No matched cohorts.** ADR-022 requires matched cohorts keyed by runtime, siblings per epic and stack depth; none were built, so a comparison between phases is not claimed.
- **Ledger built from receipts, not an existing ledger**, as described above; a launch missing a receipt is missing here.

Rule-derived ceilings from these figures (`packet-limits.md` rows C1 and C2): the smallest multiple of 50,000 above the per-launch 90th percentile, which is 550,000 for Claude and 4,250,000 for Codex, with the unit caveat above.

## 2. ADR-022 launch-cost assumptions

Source: `.planning/architecture/ADR-022-review-stage-efficiency.md`, sha256 `30e3b3f28a6082e78da9c1765c4248df18fee662bffc8db16075963572b922f6` (status `accepted`, dated 2026-09-28). ADR-022 states its cost assumptions as launch counts, not as tokens per launch. The sentences it rests on, quoted verbatim:

- Context: "**Every sibling is reviewed as soon as it is green.** The guard offers `arch-review` to every green sibling in the same tick, with no merge-candidate ordering (`sentinel.cjs:600-789`)."
- Context: "**The installed carry never fires in a cascade.** It requires the head and base trees to be unchanged (`gate-trailer.cjs:494-498`, `:563-568`), so a sibling squash that moves the epic always forces a fresh review."
- Measurements: "**Phase 44 (Claude):** 9 reviews for 8 merged PRs. The only extra review was a base move that T-43-13 covers. The phase stayed near one per ticket because siblings were finalized one at a time." and "**Phase 43 (Codex):** 11 reviews on 4 tickets. The repeats come from real violations, repairs and a sandbox `EPERM` (N57)."
- Decision: "The metric \"arch-review launches per merged ticket\" counts `first` and `after-base-move` launches; repairs after a real violation and environment adjudications are reported separately, cohorts are keyed by runtime, siblings per epic and stack depth, and results stay `inconclusive` without matched cohorts."
- Consequences: "In an epic-stacked cascade the conveyor now reviews a ticket about once, on the base it will merge into, instead of once per sibling merge."
- Consequences: "Tail siblings with overlapping files wait longer. This is measured as wall time and sentinel rounds per merged ticket, and a treatment that lowers reviews but raises total consumption fails."

So the assumptions are: (a) the cost of review is the number of launches per merged ticket; (b) one launch is one bounded ticket-level review; (c) a treatment is judged by total consumption, not launch count alone. ADR-022 carries no token figure per launch and no packet size.

### How the raised arch-review packet limit changes them

1. **A raised `ARCH_REVIEW_PACKET_TOKENS` does not change the launch count.** Read from `buildPacket` and `buildContextPacket`: for `arch-review` the 60,000-token value is a soft marker (`accounting.overflow`), not a refusal; `buildPacket` rejects overflow only for other roles. Raising it admits no review that is refused today, so assumption (a) is unaffected by the constant alone.
2. **The cost of a launch is already priced by input size through the ladder, independent of the packet limit.** `claude-role-host.cjs` `observedSignals` passes `estimatePromptTokens('arch-review', ...)` as `inputTokens`. In `model-policy-internal.cjs` `WINDOW_THRESHOLD_TOKENS` is 250,000. The Claude `arch-review` ladder (`base` sonnet/xhigh, `critical` opus/high, `ceiling` fable/medium) selects the `ceiling` rung when `inputTokens` exceeds that threshold; the Codex ladder (`base` sol/high, `critical` sol/xhigh) selects `critical` on the same signal. At least 9 of the 30 measured landings (phases 33, 36 `54b87dd3`, 40, 43, 45, 46, 47, 49, 50) exceed 250,000 estimated tokens on the diff alone (`packet-limits.md`, section 1), so a review of a landing that size already runs on the dearer rung; the count is a lower bound because the prompt adds references and instructions. ADR-022 does not account for this, because its subject is per-ticket reviews, whose diffs are much smaller than a landing.
3. **Where the cost does move.** A limit raised so that a whole phase diff (median 573,226.5 B, 90th percentile 2,442,219 B, maximum 3,598,345 B) is reviewed in one launch moves assumption (b): a launch is no longer one bounded ticket-level review, and the material it reads is about `2 x (diff + references)` (`packet-limits.md`, section 1). Per-launch tokens therefore rise with the diff, up to the per-launch ceiling in `packet-limits.md` rows C1 and C2, while the number of launches per merged ticket can fall if a phase review replaces several ticket reviews. Whether total consumption falls is exactly what assumption (c) says must be measured: it cannot be concluded from launch count, and the section 1 baseline is the denominator.
4. **Reuse is unchanged.** ADR-021 (`fc64afb80278a3c9c16b3b7ceea456527c60baa5e8c6a7ea4e7bd86fc948f220`) keeps exact-input reuse and the rule "there is no reuse across a changed base and a carried verdict is never a reuse source". A larger packet makes a manifest miss more expensive, not more likely.

Next check for point 2: `grep -n "WINDOW_THRESHOLD_TOKENS\|inputTokens" plugins/delivery-pipeline/scripts/model-policy-internal.cjs plugins/delivery-pipeline/scripts/claude-role-host.cjs` and read `observedSignals`.

## 3. Structural bound, per launch and per round

Read from `model-policy-internal.cjs` (the ladders) and `claude-role-host.cjs` (the packet bound); the dispatch policy for this ticket is `adr-014.v7`.

- **Base rung.** The fallback code review runs no higher than the base rung of `arch-review` on its runtime: Claude `sonnet` at `xhigh`; Codex `sol` at `high`. An escalation above base follows the same signal rules as `arch-review` (`critical`, `checkpoint`, `contested`, and input tokens over `WINDOW_THRESHOLD_TOKENS`), so the review role cannot become dearer than `arch-review` per launch by choosing a higher base.
- **Material.** The material of one launch is capped by the per-launch ceiling in `packet-limits.md` rows C1 and C2 (Claude 550,000 and Codex 4,250,000 processed tokens, section 1), and never above the model window in `packet-limits.md` section 3.
- **Rounds.** At most three code-review rounds run per phase. The ceiling applies per launch and per round (the same value). The per-phase worst case is `3 x` the per-launch ceiling. It is not a per-phase budget.

## Commands run by the executor

- `shasum -a 256 <each path in the Inputs table>`
- `ls -la .planning/graph/usage-attribution.jsonl` (exit 1) and `ls .planning/graph`
- the Grep tool over `.planning/graph/delivery-log.jsonl` with the patterns quoted in section 1 (counts 127 and 2), and `wc -l .planning/graph/delivery-log.jsonl` (1,783)
- the Grep tool for `window_threshold_tokens|WINDOW_THRESHOLD` and `'arch-review'` in `model-policy-internal.cjs`, and for `inputTokens` in `claude-role-host.cjs`
- reading `usage-report.cjs` (`--help` text, `main`, the `observations` shape) and ADR-022 and ADR-021 with the Read and Grep tools
