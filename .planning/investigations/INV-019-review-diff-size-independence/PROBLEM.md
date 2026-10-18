---
status: open          # open | closed — Gate 1 sets `closed`
closed:               # YYYY-MM-DD, filled in at Gate 1
adr:                  # path to .planning/architecture/ADR-NNN-*.md, filled in at Gate 1
---

# Problem

## What we are solving

The `integrator` and `arch-review` roles receive the entire combined diff of the unit under review inline in their launch prompt, so whether a review can run at all depends on the diff size. The review fails (or must be skipped) when the diff, or the material built around it, exceeds a fixed byte/token bound or the model's context window. Find a way to deliver all the information both roles need without that dependency, on both the Claude and the Codex hosts, while keeping the host-owned guarantees. Separately and certainly: the generated mirror `plugins/shipyard/` must be excluded from the review diff.

## For whom

The operator running `/shipyard:deliver` on a large epic or phase, who today gets either a refused integrator/arch-review or has to merge without them; and every future phase of the conveyor, because epics routinely carry 1–2 MB of product diff.

## Current pain

Measured on phase 50 (epic into main, 2026-10-18): the integrator v1 prompt was 2.65 MB (about 640k tokens) and the Claude child exited with `terminal_reason: prompt_too_long`; the combined diff was 2.04 MB (77% of the prompt), of which only 33% were changed lines (the rest `--unified=50` context) and 31% was the generated mirror. The v2 contract refuses with `CONTEXT_OVER_BOUND` (impact sources 25.7 MB over a 16 MiB bound), and the phase arch-review on the Claude host is refused by `context-packet.cjs` because the retained roster records carry a `receipt` key. Phase 50 was merged without either review. Raising byte/token constants does not help: the model window is the real bound.

## What success will be

- Integrator and arch-review can complete on an epic whose diff is far larger than any single model context window, on Claude and on Codex.
- The reviewer still sees, or can verifiably obtain, every changed line it is accountable for; a review that did not cover all of it cannot return a passing verdict (review-completeness stays enforced by the host).
- Host-owned launch authority, ADR-014 application receipts, digest-bound/immutable inputs and bounded evidence are unchanged in strength.
- The generated mirror is not part of any review diff, and a test pins that.

## What is definitely out of scope

- Weakening or removing any review verdict, receipt, or host-owned authority rule.
- Changing model/effort selection (ADR-014 grid) or adding a provider fallback.
- Changing what integrator/arch-review judge (their rubrics) beyond how the evidence reaches them.
- Fixing the unrelated defects found while measuring (listed in EVIDENCE.md) unless research shows they block the chosen approach.
