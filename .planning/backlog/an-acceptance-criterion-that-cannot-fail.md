# An acceptance criterion that cannot fail

Found 2026-09-09 by T-28-06's executor, in a criterion this orchestrator wrote.
ADR-006 made a witnessed mutation required because "an assertion nobody has seen
fail is not a guard". This is the sharper case: an assertion that *cannot* fail,
shipped as the proof that a mechanism was wired.

## The criterion, and why it was unfalsifiable

T-28-06's plan said:

> A PR that GitHub reports as `CLEAN` while `behindBy()` says 3: the board files
> it under `fix` with a base-moved reason. **On base the board files it under
> `merge`**, which is the board offering what the guard refuses.

The second sentence is false, and the executor measured it:
`tests/unit/front.test.cjs:1871` ALREADY asserted `CLEAN` + `behind_by: 3` →
`fix`, and already passed on base — because `computeFront` is a pure function
and that test hands it a fixture with the field already set. Whether anything
WRITES the field is invisible to a pure-function test over a hand-built input.

So the mutation check the plan prescribed — delete the writer, watch this test
fail — could not fail. The plan asked for evidence that the shape of the test
made impossible to produce.

## How the executor closed it, which is the reusable part

Two ways, because neither alone is enough:

1. **A source-level pin owns the writer's existence** (the WIRED pin in
   `judgment-contract.test.cjs`), mutation-verified: delete the write and the pin
   fails naming it.
2. **The behavioural criterion is reproduced through a REAL `state-sync`**
   against a stubbed `gh`, quoted in the PR body in BOTH directions — with the
   write, and with the write deleted.

And the pre-existing pure-function test was extended with the pair it was
missing: `actionable.merge` empty WITH the count present, and `['T']` with the
field ABSENT. That second case is the one that makes the fixture say something
about a missing writer.

## The lesson, stated so it can be applied

**A pure-function test cannot witness a writer.** When a ticket's subject is that
something is now WRITTEN, the mutation check has to run the writer — a fixture
that hands the value in has already assumed the thing under test. Ask of every
RED-on-base claim: what exactly turns red, and could it turn red for the reason
I am claiming?

Two related instances from the same phase, both in criteria this orchestrator
wrote: T-28-03's "two of eight assertions red" measured 8-of-11 (the plan
counted the greps it had run rather than the steps that were missing), and
T-28-01 omitted the test file its own rule would break. Three plans, three
criteria wrong about their own evidence — the executors measured each and said
so with numbers rather than working around them, which is the only reason any of
it is on record.
