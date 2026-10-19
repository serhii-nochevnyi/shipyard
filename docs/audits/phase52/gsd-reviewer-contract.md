# R-31: GSD reviewer finding identity

status: not-verified
date: 2026-10-19
host: executor sandbox, macOS Darwin 27.0.0, node v24.21.0, git 2.54.0 (Apple Git-157), worktree T-52-02 at HEAD e8299ce01e729f5e0c19e99477a33bb066ef4806 (main 1c34583b, Shipyard 0.73.0)

Gate: the fallback code review role does not ship without a `verified` finding identity (planning gate adopted from INV-018 `RISKS.md` R-31; plans 52-03, 52-06 and 52-12 assert it as a precondition). `not-verified` stops the phase. The verdict at the bottom of this file is `not-verified`, now on a measured replay: the reviewer agent was read, three real reports of one phase were compared, and on 2026-10-19 the operator authorised the planned same-head replay, which ran four reviewer launches (section 6). Only 3 defects were found in all four runs against the required 5, and none of them kept its identity.

Section status:

| Section | Status | Why |
|---|---|---|
| 1. Observed report schema and id grammar | verified from one real report | a tracked GSD review report exists in the tree and was read |
| 2. Where `rule`, `path` and `line` come from | verified from the same report | counted over its 14 findings |
| 3. Mapping onto `findingIdentity` | not-verified | the observed report has no rule field; the mapping and its stability need the replay |
| 4. Reviewer agent file, GSD version, prompt | verified | read from the operator's installed GSD 1.17.0 |
| 5. Prior dispositions as input | verified (no) | the agent's `<config>` block has no input for them |
| 6. Replayed fix round | measured (4 live runs, A1, A2, B1, B2) | run on 2026-10-19 with the operator's authorisation; the comparison of three older reports is kept as supporting data |
| 7. Disposition sources | recorded | quoted from the plan; ADR-032 itself was not readable here |

## Inputs

Digests were taken with `shasum -a 256 <path>` in the worktree.

| Input | sha256 |
|---|---|
| `.planning/phases/50-make-launch-and-upgrade-reliable/50-REVIEW.md` (tracked since commit 92453193; the real reviewer output) | `21c91b48e7faedba4ddee8549f5cac40043000d3b6528831b6f0b30eff5eec0e` |
| `.planning/phases/50-make-launch-and-upgrade-reliable/50-REVIEWS.md` (a plan-check report, not a code review; not used for the schema) | `eb8f64084cb508642daa28fa7a16e5a6e4cb2bc606509480ff0852a32ef688ab` |
| `plugins/delivery-pipeline/scripts/review-signature.cjs` | `bc6647f2bb3fb8f4751d0836dd7eecdbf1aba7772864791041184dd6b3638dc4` |
| `docs/audits/phase52/samples/gsd-code-review-phase50-iteration4-excerpt.md` (verbatim excerpt of the first row) | `84b0667f4f5bf82e3b2b84c6f450e9c8645f4f79b6a3ff7d6a5a55b6a078d62c` |

Searches that bound what exists in this tree: the Glob `.planning/phases/**/*REVIEW*.md` returned only `50-REVIEW.md` and `50-REVIEWS.md`; the Grep for `gsd-code-reviewer|gsd-code-review|REVIEW\.md|CR-\d\d|WR-\d\d|IN-\d\d` over the repository (excluding `.git`) found no other review report and no `CR-NN` id in any file.

## 1. Observed report schema and id grammar

Source: `50-REVIEW.md`, signed `_Reviewer: Claude (gsd-code-reviewer)_`, `depth: deep`, `iteration: 4`, `status: issues_found`, 14 findings. This is one report; claims below are limited to it.

Frontmatter keys, in order: `phase`, `reviewed` (ISO timestamp), `depth`, `iteration`, `scope` (a quoted string naming the diff range, `git diff 3d5c385c...b8b20168 (44 fix commits of review rounds 1-3), excluding plugins/shipyard and .planning`), `files_reviewed` (count), `files_reviewed_list` (paths), `findings` (`critical`, `warning`, `info`, `total`), `status`.

Body, in order: `# Phase N: Code Review Report (iteration N)`; bold metadata lines `Reviewed`, `Depth`, `Files Reviewed`, `Status`; `## Summary`; `## Warnings`; `## Info`; a footer with `Reviewed`, `Reviewer` and `Depth`. A `## Critical` section is not present because the report has `critical: 0`; its heading and the `CR` block shape are **not observed**.

Finding block, identical for all 14: a heading `### <ID>: <title>`, then `**File:** <locations>`, `**Issue:** <prose>` and `**Fix:** <prose>`. A finding may embed fenced reproduction output inside the Issue.

Id grammar observed: `WR-01` to `WR-08` (8) and `IN-01` to `IN-06` (6): a two-letter severity prefix, a hyphen and a two-digit number counted separately inside each severity. `CR-NN` was not observed; its grammar is assumed to match and is **unknown** until the agent file is read (section 4).

Numbering and rounds: the report is iteration 4 and its ids start again at `WR-01` and `IN-01`; no earlier iteration's report is in the tree. The ids are therefore positional inside one report and cannot serve as an identity across rounds. The only trace of earlier rounds in the report is the `iteration` number and a `scope` that spans the fix commits of rounds 1 to 3; the body contains no prior-finding or disposition section.

## 2. Where `rule`, `path` and `line` come from

Counted by reading the `**File:**` line of each of the 14 findings in `50-REVIEW.md`:

| Shape of the first location | Findings | Count |
|---|---|---|
| `path:line` (one integer) | WR-01, WR-02, WR-05, WR-06, IN-03 | 5 |
| `path:start-end` (a range) | WR-03, WR-04, WR-07, IN-01, IN-06 | 5 |
| `path:line,line,...` (a comma list) | IN-02, IN-04 | 2 |
| `path (symbol)` with no line | WR-08, IN-05 | 2 |

Further shapes: eleven of the 14 findings name more than one path in the same field (only WR-06, IN-02 and IN-06 name one path); for example WR-01 lists `refusal-hints.cjs:187 (fallback), callers gsd-tune.cjs:804 and session-observer.cjs:302-303`, and WR-02 also names a test by its title and assertion with no line.

| Identity field | Source in the GSD finding | Observed |
|---|---|---|
| `path` | the path of the first location in `**File:**` | present in 14 of 14 |
| `line` | the first integer after the first path's colon; for a range, its start | present in 12 of 14 (WR-08 and IN-05 have none) |
| `rule` | **none.** No `rule`, `rule_id`, `category`, `class`, `check` or `code` field exists. The nearest values are the severity prefix of the id and the free-text title after it | absent in 14 of 14 |

Reading `review-signature.cjs`: `ruleClass` accepts the keys `rule`, `rule_id`, `category`, `class`, `check`, `code`, `kind`, `name`, or a body marker `rule: x` or a leading `[x]`; `locationOf` needs `path`/`file`/`filename` plus an integer `line`, `original_line`, `originalLine`, `start_line`, `startLine` or `position`; `findingIdentity` returns `known: false` with reason `missing-rule-or-class` or `missing-path-or-location` otherwise, and hashes `rule_class`, `path` and `line` into the signature. Given a finding parsed into `path` and `line` from its `**File:**` line, `findingIdentity` returns `known: false` with `missing-rule-or-class` for the 12 that have a line, because `title` is not among the accepted keys, and `missing-path-or-location` for WR-08 and IN-05. One further hazard: if the Issue prose were passed as `body`, the comment-marker pattern in `ruleClass` (`rule`, `check`, `category`, `class` or `code` followed by `:` or `=`) could match incidental wording and produce an accidental, unstable `rule_class`; this was not tested.

## 3. Mapping onto `findingIdentity` (`rule_class`, `path`, `line`)

Status: not-verified. This table records what the mapping would have to be and why each row is not yet safe.

| Identity field | Candidate mapping | Verified? | Risk |
|---|---|---|---|
| `path` | first path of `**File:**` | mechanical, 14 of 14 | the first location is not always the defect's own location (WR-01 puts the fallback first and the callers after); a location order change would change the identity |
| `line` | first integer of the first location; start of a range | 12 of 14 | **prediction, not measured:** the line is the line at the reviewed head, so an unrelated fix that inserts lines above an unchanged defect moves it and changes the signature, which hashes the line. `findingIdentity` is safe for bot threads only because it falls back to `original_line`, which a fresh reviewer output does not carry. This is the property the replay in section 6 must test |
| `rule_class` | there is no GSD field. Options: (a) the shipped reviewer reference requires a rule slug line, for example `**Rule:** <slug>`, which the GSD agent does not produce today; (b) map the title to `name` | (a) not built; (b) not safe | (b) makes the identity depend on the exact title wording, which the reviewer rewrites each round; not verified, and likely unstable |

What this means for plan 52-03 (the reference) and plan 52-06 (the core): the identity cannot be built from GSD fields alone. Either the reviewer is required to emit a stable rule slug and a line anchor that survives unrelated edits, or the core derives them and the derivation is measured in section 6. Until one of those is shown stable, the verdict stays `not-verified`.

## 4. Reviewer agent file, GSD version and prompt (operator)

Status: verified. Read on 2026-10-19 from the operator's installed GSD.

| Item | Command | Result |
|---|---|---|
| GSD version | `cat ~/.claude/gsd-core/VERSION` | `1.17.0` (the Codex cache `~/.codex/plugins/cache/gsd-core/gsd-core/1.17.0` carries the same version) |
| Reviewer agent path | `find ~/.claude ~/.codex -name 'gsd-code-reviewer*' -not -path '*/projects/*' -not -path '*/sessions/*'` | `~/.claude/gsd-core/agents/gsd-code-reviewer.md` (403 lines; the same bytes are in the marketplace and plugin cache copies); `~/.claude/agents/gsd-code-reviewer.md` (404 lines; a per-runtime copy that differs only by `effort: high` and `/gsd-code-review` against `/gsd:code-review` in two lines); `~/.codex/agents/gsd-code-reviewer.{md,toml,compact.md}` for Codex |
| Reviewer agent sha256 | `shasum -a 256 <path>` | `7cb900ef23bf373d46499baef051822a057354b2ed72aec228b91b33902cc963` for `~/.claude/gsd-core/agents/gsd-code-reviewer.md` and for the plugin-cache copy; `353743f58b268d2f838b0eca222b63c64943906b4bff3de49afb8f7c65d5449d` for `~/.claude/agents/gsd-code-reviewer.md` |
| Reviewer prompt excerpt | `sed -n '255,360p' ~/.claude/gsd-core/agents/gsd-code-reviewer.md` | summarised below, not copied |
| `CR-NN` grammar and numbering | read from the prompt, lines 296-352 | ids are `CR-01`, `WR-01`, `IN-01` in the template: a severity prefix and a two-digit number; the template restarts at `01` in every report and nothing in the prompt carries numbering over from an earlier report. `BL-` is accepted as a Critical-tier equivalent of `CR-`, and the frontmatter key `critical:` is canonical with `blocker:` accepted (line 300). A report that contains a `CR` finding was not in the tree, so the `CR` shape rests on the template alone |
| Reviewer model and effort | no replay was run | not applicable; the three compared reports are signed `Claude (gsd-code-reviewer)` and record no model or effort |

What the prompt says about findings (lines 255-352, paraphrased): every finding carries `file`, `line` (a number or a range such as `42-45`), `issue` and `fix`; the report has a frontmatter with `critical`, `warning` and `info` counts and a `files_reviewed_list`, a `## Summary`, and `## Critical Issues`, `## Warnings` and `## Info` sections whose headings are `### <ID>: <title>` followed by `**File:**`, `**Issue:**` and `**Fix:**`. There is no `rule`, `category` or stable-slug field anywhere in the template.

## 5. Does the reviewer accept prior dispositions as input?

Status: verified, no. The agent reads a `<config>` block (prompt lines 106-111) whose keys are `depth`, `phase_dir`, `review_path`, `files` and `diff_base`, plus a `<required_reading>` block. Nothing in the prompt reads a list of earlier findings, a disposition or a recorded disagreement, and it does not read an earlier `REVIEW.md`. Earlier rounds reach it only through the `diff_base` range or the file list. A pipeline role that must not re-raise a dispositioned finding therefore has to add that input to its own prompt; GSD's agent does not provide it.

## 6. Replayed fix round (operator)

Status: measured. The operator authorised the replay on 2026-10-19 (the option "Replay with an own prompt").

**Set-up.** Head `H` is the pre-fix head `9b4e167188` of a real ticket PR (the Jira planner, two files, 946 insertions against its base `009dee0143`, a 47,536-byte diff); the head the PR's Copilot review read. Three known defects of that review are in the diff (corpus rows D-03 to D-05 of `catch-rate.md`). Runs, all with the same prompt:

| Run | Input | Purpose |
|---|---|---|
| A1, A2 | `H` | same input twice |
| B1 | `H` plus one unrelated commit (a comment line appended to `ci-wait.cjs`, a different file) | an unrelated fix in another file |
| B2 | `H` plus one unrelated commit that inserts 12 comment lines near the top of the defective file, so every known defect moves down 12 lines | an unrelated fix that shifts lines |

**Prompt.** The GSD reviewer agent instructions of section 4 (`~/.claude/gsd-core/agents/gsd-code-reviewer.md`, sha256 `7cb900ef...`), plus a wrapper (committed as `samples/r31-replay/prompt-wrapper.md`) that sets `depth: deep`, the diff base and the changed files, forbids writing files and reading `.planning/` or notes, asks for the report text as the answer, and adds to the GSD finding block three lines: `**Rule:**` (a kebab-case slug of the defect class), `**File:**` (one path and one integer line) and `**Anchor:**` (the verbatim defective source line). Nothing from the earlier reviews of this PR was given.

**Launch.** `claude -p --model claude-sonnet-5-5 --effort xhigh` with read-only tools (`Read`, `Grep`, `Glob`, and `git diff`, `git show`, `git log`, `wc`), one launch per run, in scratch clones outside the repository. Requested: Sonnet 5.5 at xhigh. Observed model (the `modelUsage` of each result): `claude-sonnet-5-5` in all four, and in B2 also `claude-opus-5-5` for 149,540 input and 11,559 output tokens that the run did not request (cause not established). Applied effort is not evidenced: the result JSON does not report it and the launches ran with `--no-session-persistence`, so there is no transcript. These are measurement runs, not routed conveyor launches, so the ADR-014 receipt boundary did not apply. A first run (A0) answered in Ukrainian because of a user-level language setting, was discarded for that reason and is not counted; A1, A2, B1 and B2 were run with "write in English" added. Cost as reported by the CLI (list prices): A1 $1.14, A2 $1.22, B1 $1.15, B2 $2.08.

**Reports.** Committed under `samples/r31-replay/` as `A1-report.md`, `A2-report.md`, `B1-report.md`, `B2-report.md`; the match table is `matched-defects.json`. Findings per run: A1 9 (0 CR, 6 WR, 3 IN), A2 11 (1 CR, 5 WR, 5 IN), B1 9 (0, 5, 4), B2 10 (1, 6, 3). All 39 findings carried a rule slug, a path and an integer line, so `findingIdentity` returned `known: true` for all 39 (with the pipeline-format lines; the plain GSD format gives `known: false`, section 2).

**Matching.** I matched findings across runs as the same defect by what they describe and by their anchor line, reading each finding; this is a judgement, and the matches are in `matched-defects.json`. Two identities were computed with `review-signature.cjs`: `id-1` is `findingIdentity` as it is (slug, path, line number), and `id-2` replaces the line number by a 28-bit integer hash of the normalised anchor text (slug, path, anchor), which is a mapping that survives line shifts.

| Defect | Found in | Slugs given | Lines | Same identity A1 = A2 | A1 = B1 | A1 = B2 |
|---|---|---|---|---|---|---|
| D1 a corrupt watermark store is read as empty | A1 A2 B1 B2 | 2 (`fail-open-on-error`, `fail-open-on-corrupt-store`) | 486, 144, 486, 498 | no | no | no |
| D2 `loadConfig` warnings discarded, reason says "(the default)" | A1 A2 B1 B2 | 4 | 444, 444, 463, 475 | no | no | no |
| D3 the off switch honours only the literal `false` | A1 A2 B2 | 3 | 455, 455, 467 | no | not found in B1 | no |
| D4 `plan` from a non-project directory reads an empty config | A1 B1 B2 | 3 | 565, 444, 456 | not found in A2 | no | no |
| D5 a `status_change` event without `to` | A1 A2 B1 B2 | 4 | 310, 374, 310, 386 | no | no | no |
| D6 `projectRootFor` duplicates `lockRootFor` | A2 B1 B2 | 1 | 272, 272, 284 | not found in A1 | not found in A1 | not found in A1 |
| D7 the no-network sweep misses `node:` prefixes | A2 B1 | 2 | 626, 626 | n/a | n/a | n/a |
| D8 an unvalidated Jira key from the ticket file | A1 A2 | 1 | 479, 479 | **yes** | n/a | n/a |
| D9 an unreachable report is never lifted | A1 A2 | 2 | 422, 422 | no | n/a | n/a |
| D10 the seek test does not pin the every-subject branch | A1 A2 | 2 | 351, 351 | no | n/a | n/a |
| D11 a journal I/O error crashes `plan` | B1 B2 | 1 | 344, 356 | n/a | n/a | n/a |

Under `id-2` (anchor identity) every comparison with A1 in the table gives the same "yes" or "no". Across all the runs that found a defect, `id-2` has fewer distinct values than `id-1` only for D1 (3 against 4) and for D6 and D11 (1 against 2); for D6 and D11 the slug and anchor were the same in every run and only the line moved by the 12 inserted lines, which `id-1` cannot survive.

Reading the table:

- **Defects matched across all four runs: 3** (D1, D2, D5) against the required 5. Findings that appear in only some runs are not the identity problem; they are the reviewer's own variance, and they alone keep the count below 5.
- **Of those 3, 0 keep the same identity in all four runs**, under either identity.
- **Between the two identical-input runs A1 and A2, 1 of the 8 defects present in both (D8) kept its identity.** So the instability exists with no edit at all.
- **The unstable field is `rule_class`, the free-form slug**: the same defect got up to 4 different slugs (D2, D5). `path` was stable (one path per defect in every case). `line` was stable across A1, A2 and B1 when the reviewer picked the same statement (444, 455, 479, 422, 351 repeat), unstable when it picked a different statement of the same defect (D1: 486 against 144; D5: 310 against 374), and moved by +12 in B2 exactly as the inserted lines predict, which no line-number identity survives and an anchor-text identity does when the anchor is chosen the same.
- **Severity is unstable too, and the gate depends on it.** D1 was a Warning in A1 and B1 and a Critical in A2 and B2; D5 was Info in A1 and Warning in the other three; D2 was Warning in A1 and Info in the others. A BLOCKER-only hold would have blocked on D1 in two of four runs and not in the other two.
- **Run-to-run coverage is also uneven**: the known `projectRootFor` duplicate (a Copilot-found defect) was missed in A1, and the off-switch defect in B1.

Untested: whether a closed list of rule classes (instead of a free slug), a required anchor chosen from the diff and a severity rubric would bring the matched count to 5 and the identities together. That would be a new prompt and a new replay.

### 6b. Supporting data: three older reports of one phase (taken before the replay)

These came first, from existing sessions. They are a comparison of three real reports taken at three different heads, not a same-input replay.

The three reports of `.planning/phases/50-make-launch-and-upgrade-reliable/50-REVIEW.md` (the same path at three points in time; the first two are untracked copies in review worktrees, the third is the tracked file):

| Report | sha256 (first 16 hex) | iteration | reviewed | files | findings |
|---|---|---|---|---|---|
| R1 | `556e7ed4ca628` | none stated (a deep review of the original diff) | 2026-10-17 | 29 | 6 WR, 8 IN |
| R2 | `f930cbba6ab6a` | 3 | 2026-10-17 | 37 | 6 WR, 4 IN |
| R3 | `21c91b48e7fae` | 4 | 2026-10-18 | 51 | 8 WR, 6 IN |

Between the reports the code changed: each report reviews the fixes of the previous one. The id numbers restart at `WR-01` and `IN-01` in every report and name different defects each time (R1 `WR-01` is a malformed catalogue passing preflight, R2 `WR-01` is `formatHint` called without variables, R3 `WR-01` is a hint printed with the literal text `the host script`). The id is therefore not an identity across reports, which section 1 predicted from one report and this comparison confirms on three.

The same defect family recurs across reports with a different id and a different location, which is the instability the replay was meant to measure:

| Defect family | R1 (id, first location) | R2 | R3 (id, first location) | path unchanged | line unchanged |
|---|---|---|---|---|---|
| a remedy hint renders a non-runnable command (unfilled `{host}`, then missing variables, then the literal `the host script`) | `WR-03` `claude-role-host.cjs:1618, 1648` | `WR-01` `refusal-hints.cjs:186-195,210-221` | `WR-01` `refusal-hints.cjs:187` | R1 differs from R2 and R3; R2 = R3 | no (R2 range starts at 186, R3 cites 187) |
| the `RUNTIME_CAPABILITY_MISSING` remedy is wrong | `WR-06` `refusal-hints.cjs:91-94` | not reported | `WR-08` `refusal-hints.cjs` with the code name and no line | yes | R3 has no line |
| the `AMBIGUOUS_RUNTIME` remedy is wrong | `IN-04` `refusal-hints.cjs:103-106` | not reported | `IN-05` `refusal-hints.cjs` with the code name and no line | yes | R3 has no line |
| preflight reports ok while the launch refuses (catalogue or key state) | `WR-01` `role-artifact.cjs:1091-1093` | `WR-06` `role-artifact.cjs:3972-3998` and `WR-02` `runtime-context.cjs:509-514` | `WR-03` `codex-decompose-host.cjs:911-921` | no | no |

The `rule_class` field does not exist in any of the three reports (0 of 38 findings), so `findingIdentity` returns `known: false` for every finding that has a line, and `missing-path-or-location` for those that cite only a symbol. The comparison is confounded by the code changes between reports (a line can move because the code was edited, not because the reviewer drifted), so it does not measure the reviewer's run-to-run variance. It does show that the identity fields the review would need are absent or move between successive reviews of the same area.

## 7. Disposition sources

The plan for this ticket names two sources the core may implement, both within ADR-032 decision 6; any further source needs an ADR amendment. ADR-032 was not readable from this worktree, so this list repeats the plan's statement and is an assumption until compared with the ADR.

```
disposition_sources:
  - prior_sealed_findings    # the findings and the reviewer's own dispositions sealed in earlier rounds
  - recorded_disagreements   # a justified disagreement recorded by a human in the project's phase directory and carried as input
```

## Verdict

verdict: not-verified

Measured on the replay of section 6: 3 defects matched across all four runs (the criterion is 5) and none of them kept its identity; one of eight defects kept it between two runs on the identical input. Unstable fields: `rule_class` (a free-form slug, up to 4 different slugs for one defect), `line` where the reviewer picks a different statement of the same defect, and the severity class that the BLOCKER-only hold reads. The gate in plans 52-03, 52-06 and 52-12 treats `not-verified` as a stop. A different design (a closed rule-class list, an anchor chosen from the diff, a severity rubric) is untested; trying it is a new prompt and a new replay, and the operator decides whether to do that or to accept the stop.

## Commands run to fill sections 4 to 6 (2026-10-19)

- the replay: `claude -p --model claude-sonnet-5-5 --effort xhigh --allowedTools Read Grep Glob "Bash(git diff:*)" "Bash(git show:*)" "Bash(git log:*)" "Bash(wc:*)" --disallowedTools Write Edit --output-format json --no-session-persistence < <prompt>` four times in scratch clones of the repository (`git clone --shared`, detached at `9b4e167188`, with the two unrelated commits on separate branches); a script parsed the four reports and called `findingIdentity` from `review-signature.cjs`

- `cat ~/.claude/gsd-core/VERSION`; `find ~/.claude ~/.codex -name 'gsd-code-reviewer*' ...`; `shasum -a 256` of the agent copies; `wc -l`; `diff` of the two Claude copies
- `sed -n` and `grep -n` over the agent for the config block, the finding template and the label-equivalence note
- `shasum -a 256` of every `50-REVIEW.md` in the review worktrees (R1 appears byte-identical in three worktrees and R2 in two, so those are copies, not independent runs) and an `awk` extraction of each report's finding ids and `**File:**` lines

## Commands run by the executor

- `shasum -a 256 <each path in the Inputs table>`
- `git ls-files .planning/phases/50-make-launch-and-upgrade-reliable/50-REVIEW.md` (tracked) and `git log --oneline --follow -- <same path>` (one commit, 92453193)
- the Glob and Grep searches quoted under Inputs
- reading `50-REVIEW.md` and `review-signature.cjs` with the Read tool
- `sed -n '<range>p' 50-REVIEW.md` for the line ranges 1-7, 60-76, 83-87, 111-115, 117-119, 144-148, 170-182 and 208-212, concatenated into the sample file with a source and digest header
- the Grep tool over `docs/audits/phase52/samples` for `/Users/|/home/|@<domain>|token|secret|password` (no match)
