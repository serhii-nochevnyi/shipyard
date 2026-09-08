# Four things around the dispatch record, one of them a claim I wrote and got wrong

**Found:** 2026-09-08 by `arch-review` on PR #58 (T-25-05), all four verified by
reproduction rather than reading.
**Scope:** none of the current tickets. T-25-05 itself is `conform` and none of
these blocks it.

## 1. `log-event.cjs` does NOT refuse `dispatch` — my plan said it does

T-25-05's Context states: *"`log-event.cjs` must not grow this. It is a dumb
append-only writer that several roles call from ticket worktrees, and `dispatch`
is not in its vocabulary by design (it refuses the events other scripts own)."*

The first two sentences are true. **The parenthesis is false.**
`OWNED_BY_SCRIPTS` holds exactly `merge`, `status_change`, `escalation` and
`plan_defect`. `dispatch` is not among them, so a hand-written
`log-event.cjs dispatch …` lands in the journal with no `by`, no durable
dispatch record, and none of the validation T-25-05 just built — reproduced by
the reviewer, then reverted.

So `dispatch` has a second, non-validating writer, and the audit trail T-25-05
exists to make trustworthy can be written around. **The fix is one line:** add
`dispatch` to `OWNED_BY_SCRIPTS` with the `halfAct` message the other four use
("parking and journalling are ONE act" is the same argument).

This is the third claim about this codebase that I wrote confidently today and a
reviewer disproved by running it — after "the `arch_review` event is added by
T-24-06" (it is not; nothing wrote that event until today) and ADR-005's D1/D6
still asserting the behaviour D2/D4 had retired. The pattern is worth naming
because it is not carelessness about facts I checked: **it is asserting a
mechanism's behaviour from its documented intent.** `OWNED_BY_SCRIPTS` reads
like a guard list, so I described it as one without opening it.

## 2. `--agent-file` is not cross-checked against the role

Reproduced: `mark T-01-01 executor --agent-file shipyard-arch-review-deep` is
accepted. The flag exists to record which Codex `.toml` actually ran, so a file
belonging to a different role is exactly the value it must reject. One line.

## 3. `--reason`'s provenance is overstated

`deliver.md:1022-3` says the branch is one "the resolver already returned". It
is not: the resolver returns `{model, effort}` (plus `strategy`) and names the
route only on **stderr**, as prose. So `--reason` is the caller's opinion of the
ladder rather than the ladder's own answer. It is optional and unvalidated, so
it cannot corrupt the model/effort evidence — but the sentence should either be
reworded or, better, the resolver should emit a `reason` field so the journal
records the route the ladder actually took. The second is the version worth
having, since the whole point of the field is to make a later review cheap.

## 4. The two `arch_review` events already disagree about their SHA format

The journal's first two `arch_review` events carry `head` in different shapes —
#57's full 40 characters, #58's abbreviated seven (which is what my own dispatch
brief asked for, so this one is mine too). Nothing reads `arch_review.head`
today: R3 greps for `verdict=violation`. But ADR-002 D5 binds a verdict to the
head it judged, and the first reader that compares this field against a
`headRefOid` or against the `gate_status` trailer's full SHA gets a false
mismatch — a verdict that looks stale when it is not, which is the failure mode
that gate exists to prevent.

Pick one format before a third event lands, and the answer is the full SHA:
`gate_status` already records it that way, and an abbreviation cannot be
lengthened by a reader that only has the journal.

## And one packaging note, from the same review

`--agent-file`'s accepted list is a LOCAL copy of the generator's deep-role set,
because `install-shipyard-codex.sh:93` copies only `"$OUT"/bundle/.` and the
generator never reaches `$CODEX_HOME/shipyard/` — a `require` would crash on the
one runtime where the flag is used. The reviewer ruled that correct, and named
the clean fix: the generator already builds a `manifest.json` that the installer
never copies into `bundle/`. Copying it would remove the duplicate list
entirely. Also worth knowing: the pin test's name overclaims — the ordinary set
comes from `references/*.md` while the generator's comes from a hardcoded
`ROLES` map, so only half the vocabulary is actually pinned.
