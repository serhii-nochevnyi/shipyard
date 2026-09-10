# A disabled reviewer has no way to say so

Settled 2026-09-09 by the operator: CodeRabbit is DISABLED on this repository,
deliberately. That closes an eight-phase-old question and leaves one narrow gap.

## What the conveyor can and cannot be told

`reviewers.cjs` hardcodes the reviewer:

```js
const CODERABBIT = 'coderabbitai';
const REVIEW_MARKER = '@coderabbitai full review';
```

and there is no knob anywhere to say it is off — zero matches for a
reviewer-enabled/disabled setting across `reviewers.cjs`,
`pipeline-config.cjs` and `capability.json`.

**Credit where it is due, because the obvious complaint is wrong.** The script
already handles a reviewer that never answers, and says why in its own header:

> CodeRabbit re-review is requested by posting a comment, and the babysit loop
> calls reinit after EVERY push — which turned into an unbounded comment stream
> on repos where CodeRabbit is not installed at all. So reinit only asks again
> once the bot has actually responded to the previous ask (`--force` overrides).

So it asks ONCE per PR and then backs off. This is not a comment stream and the
note must not claim it is.

## What it costs, measured rather than assumed

1. **One unanswerable comment per PR**, on a reviewer that will never answer.
   Small, but it is noise on every PR the conveyor opens.
2. **A diagnostic that reads as a defect.** Every `reinit` prints "the previous
   one is still unanswered (CodeRabbit has never responded on this PR — is it
   installed?)". That question mark did its job too well: it was read as a
   possible defect by two phases of guards, by an external revision on
   2026-09-09 which listed it as an anomaly, and by this orchestrator, who put
   "say whether CodeRabbit engaged" into roughly a dozen guard briefs and
   reported the non-engagement to the operator twice as an open anomaly.
3. **Nothing tells a reader what the review leg actually IS.** With one reviewer
   deliberately off, "bot review" means Copilot alone — and that is worth
   knowing, because the evidence base a green rests on is one leg shorter than
   the prose implies. Copilot found four real defects in phase 27 and five in
   phase 28's first wave, so the leg that remains is load-bearing.

## The shape of a fix

A declared list of the reviewers this project expects, in `capability.json` so
it is GSD-settable like every other knob — `delivery_pipeline.reviewers`,
defaulting to the current pair so nothing changes for anyone who does not set
it. Then `reinit` does not ask a reviewer that is not listed, `feedback` does
not report an engagement field for one, and `state-sync` can say in one line
which reviewers this repo actually has, which turns an invisible fact into a
stated one.

Deliberately NOT adopted into phase 28. ADR-007 does not carry this decision,
and adding it would be the quiet widening that ADR's own Consequences warns
about — the same rule that kept the stranded-child retarget out of phase 27.

Related: [[phase-20-followups]] §6, where the question lived for eight phases.

## 2026-09-10 — the gap cost real reviews, and this note already held the answer

Phase 29 is the first measurement of what the missing knob costs, and it is not
theoretical.

The orchestrator was told once, by the operator, that **CodeRabbit** is
disabled. It generalised that to "CodeRabbit and Copilot are DELIBERATELY
DISABLED here" and wrote that sentence into **five consecutive sentinel briefs**,
each one instructing the guard NOT to run `reviewers.cjs reinit`. Measured
across all seven PRs of the phase once the error surfaced:

```
#83  CodeRabbit NEVER, Copilot NEVER
#84  CodeRabbit NEVER, Copilot NEVER
#86  CodeRabbit NEVER, Copilot NEVER
#87  CodeRabbit NEVER, Copilot ENGAGED   → 3 findings, all real, all fixed
#88  CodeRabbit NEVER, Copilot NEVER
#89  CodeRabbit NEVER, Copilot ENGAGED   → 1 finding, real, fixed
#90  CodeRabbit NEVER, Copilot NEVER
```

Copilot's three findings on #87 were dropped `loadConfig()` warnings, a
duplicated `projectRootFor`/`lockRootFor` helper, and a missing `error.relative`
in an error string. On #89 it caught a `deliver.md` line describing the
planner's emitted item without its `ts` field — the field that anchors
`record --unreachable`'s suppression. Six of seven PRs went without a reinit
because of the briefs; both engagements happened on PRs where a guard ran it
anyway or was corrected mid-watch.

**The sharpest part is that this file already knew.** The paragraph above says
Copilot found four real defects in phase 27 and five in phase 28's first wave.
The fact was written down, in the note about exactly this gap, and the
orchestrator asserted its opposite anyway — which is ADR-006's amended rule
(*where a claim can be checked, check it*) violated against this repository's
own record rather than against a file it had never read. One
`reviewers.cjs status <pr>` would have answered it in a second.

That raises the priority of the `delivery_pipeline.reviewers` knob from
ergonomics to correctness: while "which reviewers does this repo have" lives
only in conversation, it is re-derived — wrongly — by every session that
inherits the question.
