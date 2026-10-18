# Decisions

<!-- Every accepted position is recorded IMMEDIATELY at the moment of the decision, not at the end. -->
<!-- Record format: -->
<!-- ## <decision, as an affirmative statement> -->
<!-- **Why:** ... -->
<!-- **What was rejected:** ... -->
<!-- **Scope fence:** what this decision explicitly does NOT cover -->
<!-- These sections become the locked decisions in the ADR when Gate 1 is closed. -->

## The generated mirror `plugins/shipyard/` is excluded from every review diff of the integrator and arch-review (accepted 2026-10-18)
**Why:** the mirror is a byte-for-byte generated copy of `plugins/delivery-pipeline` (31% of the phase 50 integrator diff, 643 KB of 2.04 MB), so the reviewer reads the same code twice; its parity with the source is proven by the package freshness check, not by a model review. Stated by the user as certain.
**What was rejected:** adding the mirror to `PREFIXES` in `development-artifacts.cjs`: that classifier also drives CI product-change scope, scope-gate, PR hygiene, comment-policy parity and the unresolved-review-thread gate, so a mirror-only PR would look "development only" and skip product jobs (research: `system-state.md` §8.3, `constraints.md` §4).
**Scope fence:** this fixes only the mirror. It does not decide whether `.planning/**` stays in arch-review diffs, how mirror parity is proven at review time, or how the diff-size dependence is removed (open questions). A review-specific pathspec must be applied at every diff site of all four paths and pinned by a test.

## Review input delivery is the size-routed hybrid (Option D): inline, then pull, then partitioned (accepted 2026-10-18)
**Why:** the user chose the hybrid directly. Inline stays for small epics, a larger one-session path covers the middle, and a partitioned review is the only route whose total input is independent of the diff size (research: `alternatives.md` Option D; a session reading everything is window-bound, `risks.md` R-1).
**What was rejected:** A alone (moves the cliff, an epic twice as large fails again); B alone (removes only the launch cliff, total reads stay window-bound); C alone (needless cost and cross-unit blindness for small epics); raising byte/token bounds; a larger-window model.
**Scope fence:** this fixes the direction only. Route thresholds, the unit definition, the proof of coverage per route, the fate of integration-review v2, the routing-signal meaning and the unrelated defects are decided separately (see OPEN-QUESTIONS.md). Thresholds need a measured window before they are set.

## The middle route (pull) ships with the hybrid and its coverage proof is declarative (accepted 2026-10-18)
**Why:** the user chose to include route B from the start rather than gate it on a spike. Research (`alternatives.md` Option B, `risks.md` R-2, R-3) shows a host-verified read ledger for a Claude reviewer is unproven (tool_result truncation, compaction, reachability of outside-worktree files), so route 2 carries the same strength as today's focused architecture review: the host builds and digest-binds the manifest of changed paths, checks that the reviewer's declared coverage inventory equals the manifest, and keeps `complete` implying empty limitations; it does not prove the reading itself.
**What was rejected:** shipping route B disabled until spike S2 proves transcript-derived coverage; dropping route B (inline then partition only).
**Scope fence:** the guarantee "a review that did not cover all of it cannot return a passing verdict" holds mechanically on the inline route (everything embedded) and the partitioned route (set-cover ledger over git data), and only by the reviewer's declaration on the pull route. An operator can lower the pull route's upper threshold to send more epics to the partitioned route. Making the pull route host-verified is a later change that needs the Claude transcript spike first.

## The partitioned route splits by byte budget (accepted 2026-10-18)
**Why:** units are directory-cohesive groups of changed files sized to a per-session token budget, so each unit is guaranteed to fit; for phase 50 the research estimates about 2–4 units instead of 29, with far less repeated overhead (`alternatives.md` Option C, C2).
**What was rejected:** one unit per ticket (29 launches of about 23 KB each, mostly overhead); wave/workstream subsets (unit size not guaranteed).
**Scope fence:** each unit is an ordinary receipt-verified dispatch; the aggregator receives plans, ADRs, the change inventory, per-unit verdict summaries and a seam inventory; the exact budget, the seam rule and the tree reduction for very large unit counts are design details for decomposition.

## The three unrelated defects are fixed inside this phase (accepted 2026-10-18)
**Why:** the `receipt` authority-key refusal blocks phase arch-review on the Claude host under every option; the fixed graph directory is a hard dependency of the partitioned route (N launches each dirty the tracked graph and the next run refuses the tree); the unsurfaced child stderr hides which of N+1 launches failed and why.
**What was rejected:** fixing only `receipt`; deferring all three.
**Scope fence:** the `receipt` fix must keep the host-owned authority-key scan intact (no key renaming to slip past it); the graph directory becomes selectable without weakening the clean-tree guard; stderr is surfaced bounded and sanitized.

## Integration-review v2 stays, its impact reading becomes lazy, and the hybrid is a new contract version v3 (accepted 2026-10-18)
**Why:** v2 inherited trust still works for a Codex original; its impact builder reads every JS/TS blob of both endpoint trees (repository-sized) and must not gate a full-mode review; the routes and the ledger need a contract label so consumers know which proof applies, and v1/v2 keep working (unknown versions are a hard refusal).
**What was rejected:** retiring v2; leaving v2 untouched with the hybrid limited to v1.
**Scope fence:** v3 content (route recorded in the artifact, ledger digest, per-route proof) and the migration of retained verdicts bound to old producer digests are design work for decomposition.

## Arch-review diffs exclude `.planning/` except `.planning/architecture/**` and DECISIONS files (accepted 2026-10-18)
**Why:** planning artifacts are about 1.3 MB of the phase 50 epic diff and are not product code; the integrator already excludes them and receives plans as ticket contracts, and the ADRs the work is judged against arrive as required references.
**What was rejected:** keeping the complete PR diff for arch-review.
**Scope fence:** applies only to the review diff of the four paths; the architecture review still receives the relevant ADRs and their companion files, and the PR itself is unchanged.

## Mirror parity is shown by mirror metadata in the packet plus the CI parity check (accepted 2026-10-18)
**Why:** the reviewer should see the fact that the mirror changed without paying for its bytes; the packet carries the changed `plugins/shipyard/` paths with blob ids (a few KB, no content) while CI keeps proving the mirror equals the builder output on epic to main pull requests.
**What was rejected:** silence about the mirror (the reviewer cannot notice a change); a host rebuild-and-compare at review time (more code and time for a check CI already performs).
**Scope fence:** CI skips the freshness check for `epic/*` and `ticket/*` bases; that gap is unchanged by this decision.

## The routing signal counts the work, not the prompt (accepted 2026-10-18)
**Why:** `inputTokens > 250000` selects the model rung; with routes that keep the prompt small the rung must not drop merely because the diff left the prompt. The signal is computed from the size of the work (diff plus required material), and the rule is recorded as an ADR-014 note.
**What was rejected:** counting the launch prompt as today (a large epic on the pull or partitioned route would run on a cheaper rung than the same epic inline).
**Scope fence:** the ADR-014 grid and rung table are unchanged; only the definition of the measured input for these two roles changes.

## Measurements are delivery obligations, and the thresholds are configurable and conservative until measured (accepted 2026-10-18)
**Why:** the real model windows, Claude compaction behaviour, reachability of host files from the restricted Claude child, Codex behaviour on a 2.6 MB packet through the batch reader and the partition sizes do not decide the direction; they calibrate thresholds. The first delivery ticket measures them (spikes S1–S5, the live model/effort of the failed phase 50 integrator child, the Codex integrator sandbox, and the effect of editing a pinned producer file on a sealed focused verdict) before the route code ships.
**What was rejected:** running the spikes before closing Gate 1.
**Scope fence:** until measured, the route thresholds default to the conservative values that keep every review on the safest route (partitioned above the inline bound); the delivery ADR carries these as verification obligations.
