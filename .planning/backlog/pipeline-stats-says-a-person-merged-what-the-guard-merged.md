# pipeline-stats says a person merged what the guard merged

Found 2026-09-09 while assembling phase 27's completion summary — in the tool
built to measure the conveyor, which makes it ADR-006's subject rather than a
reporting nit.

## What it printed, and what the journal says

```
[since 2d] 8 human_checkpoint ticket PR(s) were merged by a person, as the
contract requires (the guard refuses them): … T-27-02#64, T-27-03#66, T-27-04#68
```

```
{"event":"merge","ticket":"T-27-02","pr":64,"by":"sentinel","preauthorized":true}
{"event":"merge","ticket":"T-27-03","pr":66,"by":"sentinel","preauthorized":true}
{"event":"merge","ticket":"T-27-04","pr":68,"by":"sentinel","preauthorized":true}
```

Three of the eight were merged by the GUARD, each with `preauthorized: true`
recorded in the same event. The line says a person did it.

## Why, and the comment is the evidence

`pipeline-stats.cjs:175`:

```js
checkpoint_merge: !!(pr && pr.state === 'MERGED' && t.human_checkpoint
  && withinWindow(pr.mergedAt)),
```

It never asks WHO merged. The comment eight lines above says why it does not
need to:

> EXCEPT on a `human_checkpoint` ticket, where an unguarded merge is the
> contract, not an anomaly: `sentinel.cjs merge` refuses those outright ("the
> merge is the human's by contract"), so a guarded one is impossible by
> construction.

That was true when it was written. `delivery.preauthorized` then shipped — a
person signs off on a specific ticket's risk at decomposition time, and
`needsHuman()` returns false for it, so the guard merges it after re-verifying
every other gate. The user exercised exactly that on 2026-09-08 for all three
tickets above. So "impossible by construction" became "the normal case", and the
predicate that rested on it kept counting.

Note the shape: the reasoning was sound, the code implementing it was correct,
and neither was wrong at the time. What changed was a mechanism three files
away. This is the repository's own named recurring defect — prose asserting a
behaviour the code does not have — arriving through the one door that cannot be
closed by re-reading the file it lives in.

## The fix is cheap, because the journal already knows

The `merge` event carries both `by` and `preauthorized`, and
`pipeline-stats.cjs` already reads that event for the `unguarded_merge`
predicate on the very next line. So split the count in two and let the line say
which happened:

- **merged by a person** — a `human_checkpoint` ticket with NO `merge` event of
  the guard's. Still the contract, still a neutral fact.
- **merged by the guard under pre-authorization** — a `merge` event with
  `by: "sentinel"` and `preauthorized: true`. Also correct, also worth counting,
  and worth counting SEPARATELY: it is the measurement of how much waiting the
  pre-authorization question actually saved, which is the only evidence that
  asking it was worth the operator's attention.

A third bucket is worth a moment's thought rather than an assumption: a
`human_checkpoint` ticket with a `merge` event that is NOT pre-authorized would
mean the guard merged a checkpoint nobody authorized. That should be a WARNING,
not a neutral count — and today it is invisible, folded into the same line as
the two legitimate cases.
