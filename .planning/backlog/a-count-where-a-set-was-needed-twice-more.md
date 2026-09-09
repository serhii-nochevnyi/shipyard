# A count where a set was needed, twice more — verified in-repo

An external revision dated 2026-09-09 reported seven findings against `main` at
`31ed896` (its own artifacts are in `docs/audits/2026-09-09-*`, uncommitted).
Two of them are the same defect shape as each other and as ADR-006's own closing
sentence, and both are reproduced here from the repository's own scripts rather
than taken on the report's word.

## R01 (P1) — the `repeat` verdict is unreachable when signatures alternate

`failure-signature.cjs` — `seen` counts every occurrence of a signature after
the last green, while the adjacency test looks only at the LAST pair. So a PR
with two independent problems skips the one verdict that means "try a different
hypothesis at the same tier".

Reproduced against a scratch graph, four real 40-character heads, `--k 3`:

```
A(1) → verdict=first             distinct=1 seen=0
B(2) → verdict=progress          distinct=2 seen=0
A(3) → verdict=progress          distinct=2 seen=1
A(4) → verdict=repeat_exhausted  distinct=2 seen=2
```

`repeat` never appears. That is the verdict whose `strategy` is `rethink` —
same tier, deeper effort, a DIFFERENT hypothesis — so the ladder's one
"think again before escalating" step is bypassed, and the run arrives directly
at `repeat_exhausted`: the state that opens the `fable` ceiling route and then
hands the ticket to a person. Two distinct signatures also keep `K=3` from ever
firing, so `plan_defect` cannot intervene either.

Cost: the most expensive attempt is spent on a hypothesis nobody was asked to
reconsider, and autonomous repair terminates one round early. The report's
framing is right — `effort_applied: unknown` is not evidence that the depth was
already spent, so a fix needs the attempt record to carry what was actually
applied, not only what was decided.

## R07 (P2, new) — two live guards count as one agent

`front.cjs`'s `agentsInFlight` collapses by `perRound.add(role)` — a Set keyed
on the ROLE STRING. `activeDispatches` returns `{ticket: {role, at}}` and
nothing more; `front.cjs:321`'s own comment says so. So two guards posted in
different waves are one member of that Set.

`deliver.md` sanctions exactly that state: "Re-post a guard for PRs opened after
it started … do not leave a PR unguarded." Reported reproduction — four agents
genuinely out, `max=4, in_flight=3, free=1`.

**The half the report does not stress, and it decides the priority: the failure
direction is now the UNSAFE one.** `phase-26-followups.md` justified the
record-counting error by its direction — over-count → under-dispatch → a stall,
annoying and harmless. Under-count → OVER-dispatch past the cap, which is not a
cap. T-27-01 fixed the safe error and introduced an unsafe one in the same
mechanism. That argues for taking it EARLY rather than third, whatever else is
queued.

Time-of-dispatch is not a substitute for an identity: new PRs are legitimately
handed to an already-running guard, so `at` moves without a second agent
existing. Acceptance has to distinguish one guard over many PRs from two guards.

## Why these two belong together

ADR-006's Context ends: "A branch name instead of a ticket status. A sha instead
of a tree. An intent instead of an application. **A count instead of a set.** A
list of homes instead of a sweep." R01 is a count where adjacency-against-a-set
was needed. R07 is a set keyed on a role where agent identity was needed. The
ADR named the shape, phase 27 fixed eight instances of it by hand, and these two
are the ninth and tenth — one pre-existing and unnoticed, one introduced BY the
fix. Case-by-case remediation is what leaves a tenth.
