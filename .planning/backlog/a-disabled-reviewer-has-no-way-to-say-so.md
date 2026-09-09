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
