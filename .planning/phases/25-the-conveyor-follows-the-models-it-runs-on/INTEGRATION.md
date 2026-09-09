# INTEGRATION — phase 25, `the conveyor follows the models it runs on`

## Round 2 — head `d6890dba32f41c1ff7f91ca9509200b8e4f1c918`

- **Epic**: `epic/25-the-conveyor-follows-the-models-it-runs-on` → `main`, PR #40, repo `serhii-nochevnyi/shipyard`
- **Head verified myself**: `d6890db` (`gh pr view 40 --json headRefOid` agrees), 7 ahead of `origin/main`
- **New since round 1**: `d6890db fix(T-25-06): every home of a pinned fact agrees with the others (#59)` — 5 files, +148/−23
- **Round 1** was `needs-fix` on `e8dc9da` (F1 §7.5's retired ladder, F2 investigate.md's `sonnet`, F3 the split `GSD_CORE_VERSION` pin)

## Verdict — `passed`

All three round-1 findings are fixed, and fixed better than I asked: T-25-06 did
not patch the three lines, it removed the CLASS both times. The doc's §7.5 table is
now compared against `pipeline-config.cjs model <role> --json` for every role in
the module's own `ROLES` export, and the five build homes of the pin are compared
against **each other** rather than against a literal — so neither has a value that
needs bumping and neither can go stale silently again. I mutated both guards
myself: **twelve of thirteen honest mutants bite**, including a ninth role added to
`ROLES` with the doc untouched, which closes the rule-owner/file-owner seam from
the code side exactly as claimed.

Nothing I found in round 1 or round 2 blocks the release except **D**, which is a
release *step* rather than a defect. A–C and E are follow-ups; my reasoning for
each, including where I changed my own emphasis, is below.

---

## What I re-verified on the new head

### The base had moved 20 commits, so I measured the MERGED tree, not just the epic

`origin/main` is now `88c8411` and the epic's merge base is `295b5c1` — so at the
moment you asked, the epic was **20 behind**, and `gh` reported
`mergeStateStatus: UNKNOWN`. This repo's own rule is that a green measured against
a base that has since moved is not a green, so I did not measure only the epic head:

- **No conflict.** `git merge --no-commit --no-ff` of the epic into `origin/main`:
  *"Automatic merge went well"*, zero conflicted paths.
- **No overlap to reason about.** All 20 of main's commits touch `.planning/` only
  — records, backlog, `config.json`, `tickets.json`, plans, ROADMAP. Not one of the
  epic's 25 shipped files is among them, so there is no merged combination that
  neither side reviewed. This is the cheap case, and I checked it rather than
  assuming it.
- **`make test-fast` on the merged tree → exit 0**, and on the epic head alone →
  exit 0. The green describes the tree that will actually land.
- **The merged `.planning/config.json` is consistent**: `pipeline` holds only
  `jira.enabled`, both `model_overrides.gsd-*` are `opus`. So my round-1 follow-up
  **F is genuinely closed** — origin no longer shadows R1/R3, and the epic does not
  reintroduce the shadow keys (it never touched the file, so the three-way merge
  keeps main's version — I verified that in the merged tree rather than reasoning
  about it).

### F1 — §7.5 is now the ladder the code resolves

The table is one row per role with tier, effort and the reason, both floor
exemptions carrying theirs, and the per-dispatch escalations moved to prose beneath
it because they are not per-role. Correct on both counts: `executor` at `--risk
high`, `research --type alternatives` and a repeated repair signature are all
*signals*, not rows, and putting them in the table is what made the old grid unable
to describe itself.

It also fixed a fourth stale grant I had **not** enumerated — line 694's
"`fable`, the judgment tier" → "`fable`, the earned ceiling of §7.5". That one was
in my blind spot: my round-1 grep paired a ROLE with a TIER, and this sentence names
the tier with no role beside it, so no pattern of mine could have caught it. Worth
recording, because it means my F1 was a lower bound rather than the count.

### F2 — `investigate.md` reads `opus`, and the converted Codex form is verbatim

Now `opus` at `high` for the fact lines, `xhigh` for `--type alternatives`, plus a
sentence that did not exist before and is the one that actually prevents the
regression: *"The tier is the same on both lines because the floor is `opus`; what
`--type alternatives` buys is DEPTH, not a tier step, so do not substitute a
cheaper tier for the fact lines."*

I ran the generator into a temp `--out` myself and read the converted skill.
`skills/shipyard-investigate/SKILL.md:145-156` is the new paragraph verbatim,
nothing inverted, `${CLAUDE_PLUGIN_ROOT}` correctly rewritten to the bundle root,
and both mechanism names (`the Agent tool`) intact.

One check the fix passes that I want on the record, because it is the kind of thing
a reviewer waves through: the alias list widened from "for research those are
`opus`/`sonnet`/`haiku`" to "`opus`, `sonnet`, `haiku`, `fable`". That is not a
loosening — `fableRoute`'s R1 window route is **role-agnostic** (only R3 is gated
on `JUDGMENT_ROLES`), so a research dispatch that measures a large enough input
genuinely can resolve `fable`. Measured: `model research --input-tokens 900000`
under `fable: auto` → `{"model":"fable","effort":"high"}`, while
`model ci-fix --contested` correctly refuses the route → `{"model":"opus","effort":"high"}`.
The wider list is more accurate than the narrower one it replaced.

### F3 — five homes, one value

```
Dockerfile                            ARG GSD_CORE_VERSION=1.13.0
Makefile                              GSD_CORE_VERSION ?= 1.13.0
docker-compose.yml                    GSD_CORE_VERSION: ${GSD_CORE_VERSION:-1.13.0}
.env.example                          GSD_CORE_VERSION=1.13.0
tests/smoke/codex-shipyard-smoke.sh   GSD_CORE_VERSION="${GSD_CORE_VERSION:-1.13.0}"
```

### The guard — I mutated it rather than reading it

Thirteen honest mutants against `tests/smoke/docs-smoke.sh`, run one at a time with
a `git checkout` between each (tree verified clean at the end):

| mutant | result |
|---|---|
| M1 doc says `arch-review` is `sonnet` | **BITES** — names both sides and says "the code is the policy" |
| M2 doc says `executor` effort `xhigh` | **BITES** |
| M3 `drift-check` row deleted | **BITES** — "every role the resolver routes must be in the table" |
| M4 a ninth role added to `ROLES`, doc untouched | **BITES** — the seam I identified, closed from the code side |
| M5 a doc row for a name that is not a role | **BITES** |
| M6 `.env.example` back to 1.7.0 | **BITES** |
| M7 compose default back to 1.7.0 | **BITES** |
| M8a §7.5 renumbered to 7.6 | **BITES** |
| M8b whole §7.5 deleted | **BITES** |
| M8c §7.5 heading demoted to `###` | **BITES** |
| M9 the table's fence is no longer ```` ```text ```` | **BITES** — "documented as prose no test can check" |
| M11 `Makefile` pin back to 1.7.0 | **BITES** |
| M12 codex smoke pin back to 1.9.1 | **BITES** |
| M10 a SECOND `GSD_CORE_VERSION=` line appended to `.env.example` | **BLIND** |

Two notes on that, both corrections to things I said or assumed:

- My first attempt at M8 renamed only the heading's *title* and passed — and I
  nearly recorded that as a blind spot. It is not: the check keys on the `## 7.5.`
  prefix, which my mutant left intact, so the section was still found and the table
  was still correct. A pass was the right answer. Renumbering, deleting or demoting
  the section all bite. Recording this because a wrong mutant is how a guard gets
  reported as weaker than it is.
- **M10 is the real one**, and it is the `head -1` versus last-wins class I flagged:
  `sed -n 's/^GSD_CORE_VERSION=//p' | head -1` takes the FIRST line while
  dotenv/compose take the LAST, so a duplicate — which is exactly how people edit a
  `.env` — reads green while the effective value is the old pin. Measured, not
  surmised. It is already in
  `.planning/backlog/the-pin-has-eleven-sites-and-the-guard-knows-five.md`, and I
  agree with the recorded plan: remove the two installer HINTs so they print
  `latest` like their three siblings, then sweep — lengthening the list is the wrong
  shape of fix. **Not a blocker**: it needs a second line to exist before it lies,
  and the guard is strictly better than the nothing it replaced.

### The ladder is byte-identical to round 1 — T-25-06 changed no behaviour

`runtime: claude` and unset: integrator `opus`/`xhigh`, arch-review `opus`/`xhigh`,
executor/ci-fix/review-fix/research `opus`/`high`, pr-sentinel `sonnet`/`high`,
drift-check `sonnet`/`high`. `runtime: codex`: every role identical to the value I
measured on `e8dc9da`, drift-check alone at `low`. `haiku` swept across 8 roles × 7
signal combinations — returned by nothing. R1/R2/R3 all reach `fable` under
`auto`; with `off` they degrade to `opus`/`max` and print why.

`repeat_exhausted`: still 6 occurrences, still in `VERDICTS` itself
(`failure-signature.cjs:76`). The release condition T-25-02's review made continues
to hold on the new head.

### `make test-codex-shipyard` — I ran it, and it is green

I did not take this one on trust, because it is the gate that had never been run and
the generator moved 233 lines. I checked the isolation **before** running it, for
the same reason you did: `codex-shipyard-smoke.sh:24-27` is `mktemp -d`,
`trap 'rm -rf "$WORK"' EXIT`, `export HOME="$WORK"`, `CODEX_HOME="$WORK/.codex"`.

```
$ make test-codex-shipyard
→ installing gsd-core@1.13.0 --codex (throwaway HOME)…
pipeline-config: warning: arch-review reads --input-tokens <n> and did not get it …
codex-shipyard smoke: OK
exit=0
```

Your trace of the warning is right and I confirmed it independently: it is the
smoke's **own** line 112, `pipeline-config.cjs model arch-review` with no signal, and
the assertion reads stdout while the warning goes to stderr. Noise in a test's
output, not a defect of the diff.

One small thing I noticed while confirming it, offered as a nit and not a finding:
the comment above that line (`:105-111`) explains the `cd "$WORK"` by saying this
project's config *"legitimately resolves the two judgment roles to `fable`"*. That
was true when T-25-02 wrote it; after `782647a` nothing resolves `fable` by default
anywhere. The `cd` is still correct and still necessary — for the general reason
that a shipped assertion must not measure one checkout's tuning — but its stated
reason is a generation old.

### The generator, re-run on the new head

11 agents with the CLI pinned above the ceiling's floor — integrator and the four
`-deep` variants on `gpt-6-astra`, the rest on `gpt-5.6-terra`, drift-check alone at
`low` — and 7 agents with no `-deep` files at the host's real 0.147.0. Unchanged
from round 1, as expected, since T-25-06 touched no generator input.

---

## Ruling on A–E: which block the release

**D blocks. A, B, C and E do not.** In order of how close each came:

### D — the version bump: **BLOCKS the release, and it is a step, not a defect**

`plugin.json` and `capability.json` are both still `0.46.0`, unchanged from `main`,
while `capability.json` grew three declared config keys (`codex_models`, `fable`,
`fable_window_tokens`) and the plugin's commands, references and scripts all moved.

This is the one item where nothing will ever tell you: `make test-overlay`'s drift
check asserts only that the two files are **equal to each other**, and they are, so
it stays green at a stale version forever. A host already carrying 0.46.0 gets no
signal that its capability config vocabulary changed under it.

`CLAUDE.md`'s convention puts the bump at step 1 of five, **before** the merge. Both
placements work mechanically, and they differ in one way worth choosing
deliberately: bumping on the epic means the merge commit itself carries the version
the release notes describe, so `git log <prev-tag>..<tag>` reads coherently.
Bumping on `main` after the merge means the release contains a version bump that
describes commits above it. **I would bump on the epic** — one commit, both files,
no test risk — but if you would rather not reopen a green epic for it, bumping on
`main` immediately after the merge and before the tag is a legitimate second choice.
What is not acceptable is reaching `gh release create` with 0.46.0.

### A — `drift-gate.mjs`'s `low` default: does NOT block, and is phase 27's FIRST ticket

I want to be explicit that I moved on this one, and why in both directions.

Toward blocking: this phase **created** the divergence rather than inheriting it.
Before T-25-04 the resolver returned `drift-check → low` and
`effort: t.effort || 'low'` agreed with it; after T-25-04 the resolver returns
`high` and the workflow's fallback contradicts it, with a comment ("cheap effort on
purpose") asserting the argument D2's amendment retired. And the divergence is not
incidental: drift-check at `high` **is** the stated compensation for dropping the
executor from `xhigh` to `high` — D2's amendment says in as many words that it
"cannot carry this at `low`". So a silent fallback to `low` voids the phase's own
compensating control. This repo also has a measured base rate for exactly this class
of omission: the `--files` signal that "never fired once in 173 dispatches" because
the documented dispatch omitted it. Once measured, that was 173 out of 173.

Against blocking, and this is what decided it: the epic contains no path that
*reaches* `low`. The resolver returns `high`, `deliver.md:901-905` tells the loop to
take the pair from the resolver and says why ("or this ladder drifts here first"),
and the fallback only applies to a caller that omits a field it is told to pass. The
consequence if it ever does is a **quality** regression — weaker plan-defect
detection, whose cost D2's amendment explicitly accepts and describes — with no
state corruption, no gate misled, no wrong green reaching an epic. Weighed against
that: fixing it means reopening a green epic to change two lines in a file no phase-25
ticket owns, which is the cascade cost the conveyor's stacking rules exist to avoid.

So: **not a blocker, and not a backlog item either.** It is the first ticket of
phase 27, and it should carry the assertion rather than just the fix — a test that
each `workflows/*.mjs` default equals what the resolver returns for that role, so
the next ladder change cannot re-open the same gap. `executors.mjs` (`opus`) and
`fix-round.mjs` (`opus`) happen to agree today; only `drift-gate.mjs` does not, and
nothing is holding any of the three.

### B — the unrecorded mark sites: does NOT block, same ticket as A

The drift judges (`deliver.md:896`) and arch-review (`:1249`) still have no
`dispatch-record.cjs mark`, so they record nothing. It records no **wrong** fact,
which is the distinction that keeps it off the blocking list: D2's precondition is
about what the NEXT ladder revision can be argued from, not about whether this one
is correct. The two roles are the ones the cost argument rests on
(drift-check ≈30% of subagent tokens, judges ≈22%), and drift-check is the role
whose effort just moved — so the change most in need of evidence is the one with
none. Pair it with A: same two roles, same shape of fix, and the acceptance
criterion should assert the **set** of mark sites against the set of documented
dispatches rather than a count over the lines that exist, which is how the shortfall
passed review the first time.

### C — the two false sentences: does NOT block

`pipeline-config.cjs`'s degraded-ceiling message tells a Codex operator "the ceiling
is opus at max effort" while the resolver returns `sonnet`/`high` there. Both halves
false on that runtime — but the actionable half of the same message (the `-deep`
agent file) is correct, so the worst outcome is a reader looking for a dispatch that
is not there. Follow-up. The `fable_window_tokens` "five times" arithmetic (250k
against ~52k is 4.8×) goes with it.

### E — ADR-003 D3: does NOT block the merge, and should go WITH the release step

Architecture records are outside this diff and I do not judge them. But since you
asked me to rule: `ADR-003:68` still reads *"`fable` stays the default for judgment
on Claude"*, with no amendment note, and your new "D1's verification, settled
2026-09-08" section (`b85d510`, which I confirmed is on `origin/main`) did not close
it. ADR-005 declares itself as refining D3, so a reader who follows the chain
arrives right and a reader who opens ADR-003 alone does not — which is the position
D4's own amendment paragraph names as how the old behaviour comes back. It is one
line. **Do it with D**, since you will be in the release step anyway and the same
step already owes the notes ADR-003 now requires.

---

## Where I would put `test-codex-shipyard` and the Docker targets

**`test-codex-shipyard` is out of the ordering question — it is done and green**, on
`d6890db`, run by both of us independently. Your reasoning for running it on the
epic rather than `main` is right and is the general rule: a smoke run against a tree
that lacks the changed lines proves nothing about them.

**The Docker targets: I accept the deferral, and `passed` does not require the
build.** Four reasons, and I would answer differently if any one of them failed:

1. **The container is not on the delivery path.** `CLAUDE.md` separates the two
   deliverables deliberately: the conveyor reaches both runtimes host-side, and the
   image is a remote dev environment. A wrong image pin cannot produce a wrong green
   on a PR, cannot corrupt delivery state, cannot mis-merge anything.
2. **The failure mode is loud and immediate, not silent.** Both pins are consumed by
   `npm install -g @anthropic-ai/claude-code@<v>` and
   `npx @opengsd/gsd-core@<v>` — an unresolvable version fails the build on the line
   that uses it. This is a build-time risk with a build-time signal, which is a
   different category from the silent-wrong-answer risks this phase's reviews have
   been finding.
3. **The reading is not bare.** `Dockerfile.base:33` is `2.1.263`, above both the
   2.1.219 Opus 5 floor and the 2.1.255 Fable 5.1 floor; `base-image-smoke.sh:25`
   now asserts that floor as `>=` rather than `==`, so it needs no edit on the next
   bump; and the five-home pin agreement is mechanically held by a check I mutated
   four of the five homes against.
4. **Your reason for declining is the correct one, not a convenience.**
   `base-image-smoke.sh:12` runs `make build-base` itself, so there is no read-only
   assertion path — and the host's four-week-old images predate the pins entirely, so
   a green against them would have described the PREVIOUS pin. That is precisely the
   false assurance this phase has spent its reviews removing, and running the smoke
   without rebuilding would have manufactured one.

**Position in the order: after the tag, which is where your record already puts it.**
I would add nothing to ADR-003's placement — the release-notes obligation ("the
container's toolchain pins are updated and unbuilt") is the right instrument,
because it moves the gap from *unknown* to *disclosed*, and the deferred-checkpoint
clause gives the first `make build-base` an owner and an attribution. My only ask is
that the notes say it in the plain words the record demands rather than as a
footnote, since the person who next runs `make build-base` is the one paying for it.

---

## Round-1 findings — final state

| # | finding | state |
|---|---|---|
| F1 | §7.5's retired ladder (`fable` for the judges, `sonnet` for research) | **fixed**, plus a fourth grant at `:694` I had not enumerated, plus a mechanical guard I mutated |
| F2 | `investigate.md` documenting `research --type facts` → `sonnet` | **fixed**, converted Codex form verified verbatim |
| F3 | `GSD_CORE_VERSION` split across five homes | **fixed**, all five at 1.13.0, held by a self-comparing check |
| A | `drift-gate.mjs`'s `low` default and its retired comment | follow-up — **phase 27's first ticket**, with the assertion |
| B | mark sites for the drift judges and arch-review | follow-up — same ticket as A |
| C | two sentences asserting behaviour their code lacks | follow-up |
| D | `plugin.json` / `capability.json` at 0.46.0 | **BLOCKS the release** — a step, before the tag |
| E | ADR-003 D3's stale `fable` sentence | follow-up — do it with D |
| F | the unpushed config commit | **closed**, verified in the merged tree |

## Housekeeping

`#40` not merged, not undrafted. The three throwaway worktrees (`epic25b`,
`mergetest`, and round 1's) have been removed and the epic worktree was verified
clean after the mutation run. This file is written and deliberately left
uncommitted — committing the integrator's artifact is not mine to do.
