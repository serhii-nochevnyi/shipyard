# R-31: GSD reviewer finding identity

status: pending-operator
date: 2026-10-19
host: executor sandbox, macOS Darwin 27.0.0, node v24.21.0, git 2.54.0 (Apple Git-157), worktree T-52-02 at HEAD e8299ce01e729f5e0c19e99477a33bb066ef4806 (main 1c34583b, Shipyard 0.73.0)

Gate: the fallback code review role does not ship without a `verified` finding identity (planning gate adopted from INV-018 `RISKS.md` R-31; plans 52-03, 52-06 and 52-12 assert it as a precondition). `not-verified` stops the phase. The verdict at the bottom of this file is `pending-operator` until the operator has read the reviewer agent and replayed a fix round.

Section status:

| Section | Status | Why |
|---|---|---|
| 1. Observed report schema and id grammar | verified from one real report | a tracked GSD review report exists in the tree and was read |
| 2. Where `rule`, `path` and `line` come from | verified from the same report | counted over its 14 findings |
| 3. Mapping onto `findingIdentity` | not-verified | the observed report has no rule field; the mapping and its stability need the replay |
| 4. Reviewer agent file, GSD version, prompt | pending-operator | outside the executor sandbox |
| 5. Prior dispositions as input | pending-operator | depends on the agent prompt |
| 6. Replayed fix round | pending-operator | needs live model runs |
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

Status: pending-operator. The executor cannot read the operator's home directory (the sandbox refuses reads outside the worktree), and the repository carries no copy of the agent. `Makefile` sets `GSD_CORE_VERSION ?= latest` (a deliberate no-pin, so the version cannot be read from the repository). Record, with the command that produced each value:

| Item | Command | Result |
|---|---|---|
| GSD version | for example `node <gsd-core>/bin/gsd-tools.cjs --version`, or the `version` field of the installed `package.json`; name the command used | PENDING-OPERATOR |
| Reviewer agent path | `find ~/.claude ~/.codex -name 'gsd-code-reviewer*' -not -path '*/projects/*' -not -path '*/sessions/*' 2>/dev/null` (the location is an assumption to confirm) | PENDING-OPERATOR |
| Reviewer agent sha256 | `shasum -a 256 <path from the row above>` | PENDING-OPERATOR |
| Reviewer prompt excerpt (at most 60 lines: the output-format and finding-id instructions, with the line range) | `sed -n '<a>,<b>p' <path>` | PENDING-OPERATOR |
| `CR-NN` grammar and whether `CR`, `WR` and `IN` numbering restarts per review | read from the prompt, and confirmed on one report that has a critical finding | PENDING-OPERATOR |
| Reviewer model and effort used for the replay | the dispatch record of the replay | PENDING-OPERATOR |

## 5. Does the reviewer accept prior dispositions as input?

Status: pending-operator. Observed: the iteration-4 report carries no prior-finding or disposition section, and its `scope` names a fix-commit range, so earlier rounds reach the reviewer, if at all, as a diff range. Whether the agent accepts a list of prior findings, their dispositions or a recorded disagreement as a prompt input is unknown until section 4 is filled. Answer: PENDING-OPERATOR (yes or no, with the prompt lines that show it).

## 6. Replayed fix round (operator)

Status: pending-operator. Procedure:

1. Choose a real head `H` and its base (a past phase or ticket diff the operator can reproduce). Run the reviewer on `H` twice with the same prompt, model and effort: runs `A1` and `A2`.
2. Make one unrelated fix commit `F` on top of `H`: a change in a different file, and a second variant that inserts at least 10 lines above a known defect in the same file. Run the reviewer on `H+F`: runs `B1` (different file) and `B2` (lines shifted).
3. A human matches findings across runs as the same defect or not. For each matched defect, compute the identity (`findingIdentity` over the mapping chosen in section 3) in each run.
4. Record the table below, and commit scrubbed outputs under `docs/audits/phase52/samples/` (public repository content or synthetic diffs only; no tokens, account ids or private transcripts).

| Defect (id in A1) | In A2 | Identity A1 = A2 | In B1 | Identity A1 = B1 | In B2 | Identity A1 = B2 |
|---|---|---|---|---|---|---|
| PENDING-OPERATOR | PENDING-OPERATOR | PENDING-OPERATOR | PENDING-OPERATOR | PENDING-OPERATOR | PENDING-OPERATOR | PENDING-OPERATOR |

Proposed criterion (the operator may tighten it, not loosen it): `verified` only if at least 5 defects are matched across all four runs and every matched defect keeps the same identity in all four. Anything less is `not-verified`, with the unstable field named (`rule_class`, `path` or `line`).

## 7. Disposition sources

The plan for this ticket names two sources the core may implement, both within ADR-032 decision 6; any further source needs an ADR amendment. ADR-032 was not readable from this worktree, so this list repeats the plan's statement and is an assumption until compared with the ADR.

```
disposition_sources:
  - prior_sealed_findings    # the findings and the reviewer's own dispositions sealed in earlier rounds
  - recorded_disagreements   # a justified disagreement recorded by a human in the project's phase directory and carried as input
```

## Verdict

verdict: pending-operator

The executor's reading is that the verdict will be `not-verified` unless the mapping gains a stable rule slug and a line anchor, because the real report has no rule field and its lines are positional at one head (sections 2 and 3). That is a prediction, not a result; the operator replaces this line with `verified` or `not-verified` after section 6.

## Commands run by the executor

- `shasum -a 256 <each path in the Inputs table>`
- `git ls-files .planning/phases/50-make-launch-and-upgrade-reliable/50-REVIEW.md` (tracked) and `git log --oneline --follow -- <same path>` (one commit, 92453193)
- the Glob and Grep searches quoted under Inputs
- reading `50-REVIEW.md` and `review-signature.cjs` with the Read tool
- `sed -n '<range>p' 50-REVIEW.md` for the line ranges 1-7, 60-76, 83-87, 111-115, 117-119, 144-148, 170-182 and 208-212, concatenated into the sample file with a source and digest header
- the Grep tool over `docs/audits/phase52/samples` for `/Users/|/home/|@<domain>|token|secret|password` (no match)
