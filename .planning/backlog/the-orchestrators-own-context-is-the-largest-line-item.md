# The orchestrator's own context is the conveyor's largest line item

Measured 2026-09-10 across 865 session transcripts and 108,720 messages
carrying `usage` fields. Not estimated from file sizes, which are a proxy and
disagree with the answer.

## What the spend actually is

The composition is the same every day, to within a few points:

```
              cacheREAD  cacheWRITE  output  input
2026-09-07      66.6%      28.2%      5.2%    0.0%
2026-09-08      74.8%      18.2%      7.0%    0.0%
2026-09-09      73.3%      18.9%      7.9%    0.0%
2026-09-10      66.4%      27.5%      6.1%    0.0%
```

Generation is 5-8%. Two thirds is **re-reading context that is already there**,
once per tool call. Average context per request across those days: 154k-222k
tokens, with peaks near 967k in the orchestrator session.

This repository already knew the smaller version of this: `pipeline-config.cjs`
records that "output is 12-19% of a line, cache read+write 82-87%", which is
why effort is a quality knob and not a price one. The measurement above is that
same fact at session scale, and it says something the per-line version does
not — the price of a run is set by CONTEXT SIZE times REQUEST COUNT, and both
of those are the orchestrator's own behaviour rather than the ladder's.

## The number that matters

Marginal cost of ONE tool call, by who makes it (2026-09-10, this project):

```
level                    requests  context/req  per call   relative
orchestrator (main)           279        419k     209k       x17.5
Workflow executor             612        114k      57k        x4.8
arch-review judge             286         92k      46k        x3.8
sentinel (sonnet)             671        120k      12k        x1.0
```

**One orchestrator tool call costs what seventeen sentinel calls cost.** Not
because it does more — because it drags 419k of context behind it, multiplied
by the `opus` tier.

The inversion is the finding: the sentinels made 671 requests and were 3.4% of
the day; the orchestrator made 279 and was 22.1%.

## Three levers, in order of size

1. **Session length.** This session ran 12 days and 3,350 requests, re-reading
   1.66 BILLION tokens of context in total. A neighbouring project's session
   ran 45 days, 19,133 requests, **10.54 billion**. Context does not reset, so
   every later turn in a long session is dearer than the same turn in a fresh
   one. Restarting per phase would drop the orchestrator's per-call cost from
   ~419k to ~30k of context, which is roughly fifteenfold on the largest line
   item. This is the only lever that compounds.
2. **Delegate rather than do.** Work handed to a sentinel costs ~1/17 of the
   same work done in the orchestrator's own turn. The conveyor is already built
   for this and the orchestrator under-used it on 2026-09-10: 279 own calls
   against 612 executor calls.
3. **Batch the checks.** Three greps in three Bash calls cost three full
   context re-reads; the same three in one call cost one. Observed repeatedly
   in this session's own transcript.

## What this does NOT argue

It does not argue for cheapening the ladder. 96% of the day's weighted spend
was `opus` and 3.9% `sonnet`, but ADR-005's floor is a correctness decision
about where a wrong green costs most, and the measurement above says the
savings are in call COUNT and context SIZE rather than in tier. Reading this
note as an argument to drop the floor would be reading it backwards: the reason
a tier step matters so much per call is exactly why the calls, not the tier,
are the thing to reduce.

It also does not argue for compaction as a strategy. Compaction is what the
harness does when a session outgrows its window; the lever here is not
compacting later, it is starting a new session at a natural boundary — a merged
epic — where the context genuinely has no further use.

## Method, so a later reader can repeat it

Walk `~/.claude/projects/**/*.jsonl`, take `message.usage` from every assistant
message, group by `timestamp[0:10]`, project, agent kind (main / subagent /
workflow-agent) and model. Weight with the published ratios — output 5x input,
cache write 1.25x, cache read 0.1x, and Opus input 5x Sonnet — to compare where
spend went. That weighting is a RELATIVE cost estimate, not a billing
statement, and the note should not be read as one.

Related: [[the-backlog-is-thirty-six-files-no-tool-can-find]] — both are facts
about the conveyor that only exist while somebody is looking at them.
