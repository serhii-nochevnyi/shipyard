# Options

The full analysis is in [research/alternatives.md](research/alternatives.md). The options compose: A is the floor, B and C stack independently, D supersedes B's ordering, and E is separate and gated.

| | A — accepted inputs only | B — merge-candidate gating | C — own-patch review input | D — batched per-ticket verdicts | E — size-routed model (study) |
|---|---|---|---|---|---|
| When a review launches | after green, every sibling | after green, only the next candidate(s) per base; B2 lets disjoint siblings run in parallel | after green, every sibling | per batch or per stack | unchanged |
| What it judges | whole PR vs live merge-base | same | the ticket's own patch plus a marked residue | each ticket's PR, one launch | unchanged |
| Carry / reuse | T-43-13 + C1 | same; fewer carries needed | carry aligned to what was judged | carry per ticket after each merge | unchanged |
| Launches per merged ticket | depends on the owned-path overlap share | ≈1 (B1), ≈1 + overlap (B2) | ≈1 + owned-path conflict rate | below 1 per ticket, but not a comparable unit | count unchanged |
| Latency | today's | B1: serial per epic; B2: serial only for overlapping tickets | today's | D1 worst; D3 ≈ today | unchanged |
| Correctness trade-off | none new | none new | the first review no longer sees base interactions (ADR-020 fence: CI + epic PR) | none if verdicts stay per head; one failure loses N | quality risk on small central diffs |
| Complexity | low (already owned) | medium | medium–high | high (new schema, receipts, packet split) | ADR-014 amendment + experiment |
| Runtime parity | shared carry layer; host reuse is Claude-first | the duty layer is shared → both runtimes | both hosts must build the same packet | both hosts need multi-subject | per grid |
| Owners touched | T-43-13, C1, R10, R13 | `sentinel.cjs`, `front.cjs`, deliver.md (R3, D1) | `claude-role-host.cjs`, `arch-review.md`, `gate-trailer.cjs` | role host, role-artifact, integrator | `model-policy*.cjs` |

Preconditions shared by every option: P-draft (N46, R13), P-env (N57, R10) and P-pre (R14) run before a model turn is spent. Every launch, reuse, carry and re-owe is journalled (R-8).
