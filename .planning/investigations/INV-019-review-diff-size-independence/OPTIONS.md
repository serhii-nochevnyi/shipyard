# Options

Sources: `research/alternatives.md` §2–§3. Cost labels are estimates from the touched surface (not measured). No option is chosen by the research.

An invariant behind all four: whatever a single session reads must fit in its window. A mechanism that keeps one session can therefore make the launch independent of the diff size only if the reviewer reads selectively; a mechanism that removes the dependence outright must split the review across sessions.

## A — Stop-gap: shrink the inline packet (S–M)
Exclude the generated mirror with a review-specific pathspec at every diff site (never via `PREFIXES`), reduce `--unified`, optionally trim plans to their acceptance header, name the bound and measured size in refusals, fix the `receipt` key, pin "no `plugins/shipyard/` path in any review diff" for all four paths with a test.
- Phase 50 effect (derived): integrator packet ~485k tokens (mirror only), ~310k (mirror + U3), ~292k (U0). Fit against the unknown window is unproven.
- Removes the dependence on diff size: **No** (moves the cliff; an epic twice as large fails again).
- Host proof of coverage: delivery by construction (plus a cheap file-list equality check); no read proof, same as today.
- No new contract label, receipts unchanged, trivial rollback.
- Hides mirror divergence from the reviewer; the CI parity test covers epic → main PRs, and a metadata-only mirror inventory (paths and blob ids) can keep the fact of change visible.

## B — Pull model: the reviewer reads git objects driven by a host-sealed manifest (L)
The packet carries a manifest (per changed path: status, blob ids, size, per-file diff hash, recipe) bound into `context_digest`; the reviewer pulls each file's diff and the host derives a read ledger from the runtime transcript, capping the verdict at `incomplete` on a gap.
- Removes the dependence: **partly** (the launch cliff only; every byte pulled stays in the session context, so total reads are still window-bound).
- Claude needs a new transcript verifier (no precedent); Codex extends its consumption verifier and adds a proof to the focused arch-review.
- Open feasibility: tool_result truncation and compaction on Claude, reachability of outside-worktree files, git in a linked worktree under the sandbox.
- New contract label; additive, rollback by selecting v1.
- Forecloses the invariant "the reviewer judged exactly the bytes the host embedded and hashed".

## C — Partitioned (map-reduce) review with a sealed ledger (XL)
The host splits the changed paths into disjoint review units (per ticket, by byte budget, or by wave); each unit is an ordinary receipt-verified dispatch on today's inline path; an aggregator judges the phase from the plans, ADRs, change inventory, per-unit verdict summaries and a seam inventory. The host proves coverage as a set-cover over git data.
- Removes the dependence: **yes** (no session holds the whole diff; the aggregator needs tree reduction for very large N).
- Coverage proof is transcript-independent: every changed row belongs to exactly one unit whose packet embeds it and whose result is receipt-verified.
- Needs a new unit/ledger artifact kind that cannot satisfy the PR-level gate, per-unit evidence paths, conveyor-duty changes (one arch-review per PR is assumed), and a ledger authority outside the worktree.
- Main risk: cross-unit blindness (the integrator exists to see what only the sum reveals); N× cost and latency; partial failure and retry; the fixed graph directory becomes a hard dependency.
- Prior art: R11 per-subset integration in `WORK-PACKAGES.md`; roster HMAC authority; INV-010 rejected the ticket-review variant.

## D — Hybrid, size-routed: inline → pull → partitioned (XL+)
Route by measured estimated input against a calibrated window: small epics keep the (shrunk) inline path, mid-size use B, over-size use C; the route is recorded in the contract; a route that cannot close its proof escalates, never accepts a partial review.
- Removes the dependence: yes, via route 3. Highest complexity: three paths on two runtimes, thresholds per runtime and role that need measurement first, and a changed meaning of `inputTokens` for model selection.

## Comparison (short)

| | A | B | C | D |
|---|---|---|---|---|
| Independent of diff size | no | partly | yes | yes |
| Proof of coverage | delivery | transcript ledger (feasibility unknown) | set-cover over git, transcript-independent | per route |
| Cost | S–M | L | XL | XL+ |
| New contract/artifact | no | yes | yes | yes |
| Needs graph-dir isolation | operability | operability | hard | hard (route 3) |
| Rollback | trivial | selector value | stop selecting | one knob per route |
| Every option needs | the `receipt` key fix for phase arch-review (and a mirror-aware review pathspec) | | | |

## Set aside
Raising the byte/token bounds again (the model window is the bound); a larger-window model (no Fable rung for the Claude integrator; changing the grid is an ADR-014 change and out of scope); an external review service (no ADR knowledge, no receipt); an LLM pre-pass that summarises the diff (lossy and unreceipted; a pre-pass that reviews a chunk is C); carrying per-ticket arch-review verdicts into the integrator (rejected by INV-010); making the Claude child read the existing relay as the whole solution (unproven reachability).
