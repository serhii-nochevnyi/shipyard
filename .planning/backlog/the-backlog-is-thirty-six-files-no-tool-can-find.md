# The backlog is thirty-six files no tool can find

Found 2026-09-10, by the operator asking a one-sentence question: *how would
another tool find these tasks?* The answer, measured, is that it would not.

## The measurement

```
.planning/backlog/                     36 files
index / README / _ prefixed file       none
mentions in plugins/*/commands/*.md    0
mentions in plugins/*/references/*.md  0
mentions in skills/delivery-rules      0
mentions in CLAUDE.md                  0
mentions anywhere in scripts/          1   (a code comment in sentinel.cjs:721)
```

The single occurrence is prose inside a comment explaining a different defect.
Nothing reads the directory, nothing lists it, nothing knows it exists.

**And GSD's backlog is a DIFFERENT MECHANISM, which is what makes this worse
than a missing index.** `/gsd-capture --backlog` writes into **ROADMAP.md**
under 999.x numbering, and `/gsd-review-backlog` promotes items from there.
Measured on this project: ROADMAP.md has no 999.x section at all. So the one
tool a person would reach for to review a backlog looks in a place this
repository has never written to, finds nothing, and reports an empty backlog
while thirty-six notes sit two directories away.

That is not a gap in discoverability. It is two mechanisms with the same name
and no relationship, where the one that is used is the one nothing reads.

## Why the notes are good and still lost

The corpus is not junk — it is the conveyor's memory, and three whole phases
were decomposed out of it. ADR-006 opens by saying so: *"Delivering them
produced 23 backlog notes, and re-reading them together shows the sentence has
a second half nobody wrote down."* ADR-007 and ADR-008 were sourced the same
way.

But every one of those readings happened because a session was ALREADY holding
the directory in context and chose to re-read it. A fresh session, the Codex
runtime, a teammate, or `/gsd-review-backlog` gets nothing. The corpus is
readable exactly by whoever already knows it is there — which is the definition
of a record that does not survive the person who wrote it, and the reason
`escalation-record.cjs` exists in the first place.

**This note is itself the evidence.** Four findings from phase 29 were about to
die in a chat log; the operator asked for them to be written down, and the act
of writing them surfaced that writing them down is not enough.

## The shapes a fix could take, cheapest first

- **An index the writer maintains** — `.planning/backlog/README.md`, one line
  per note. Cheapest, and it rots the way every hand-maintained list in this
  repository has rotted; ADR-006 D7 is a whole decision about preferring a
  sweep to a list.
- **A generated index** — a script that walks the directory and regenerates the
  list, plus a `source-contract` case asserting the index names every file.
  That is the sweep shape, and it makes "a note nobody linked" a red test.
- **Bridge to GSD's own backlog** so `/gsd-review-backlog` finds them — either
  by writing a 999.x ROADMAP stub per note, or by teaching capture to write
  both. This is the only option that answers the operator's actual question,
  because it is the only one another TOOL consumes rather than another reader.
- **Name it in the command docs** — `investigate.md` Step 0 already looks for
  undecomposed ADRs; it could look for unclosed backlog notes the same way, and
  `route.md` could name the directory as an input. This is what would have let
  a fresh session find the corpus without being told.

None adopted here. The choice between them is a real decision — the third one
in particular changes which tool owns the list — and it belongs in an
investigation rather than in a note about its own invisibility.

## Two smaller facts worth keeping

- **Nothing marks a note CLOSED.** Phase 27 closed three notes by writing
  evidence into them; nothing distinguishes those from live ones except reading
  the prose. A generated index would have to carry state, or it will re-offer
  settled work.
- **`phase-20-followups`, `phase-22-followups`, `phase-24-followups` are
  collections, not notes** — ADR-006 parked them pending a triage pass of their
  own. Any index has to handle a file that holds N items rather than one.

Related: [[a-disabled-reviewer-has-no-way-to-say-so]], whose 2026-09-10 section
records the orchestrator asserting the opposite of what that very note already
said — the same corpus being unread, from the other direction.
