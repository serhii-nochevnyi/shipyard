# Risks

Sources: `research/risks.md` (24 risks, full register there), `research/alternatives.md` §3. Likelihood is stated only where observed; otherwise unknown.

## Coverage integrity (the guarantee that must not weaken)
- **Changing the delivery channel does not remove the window bound.** Moving the diff from the prompt to files or tool reads moves where `prompt_too_long` or a compaction rejection happens; Codex discards a compacted session after the cost is paid. Mitigation: keep the unit that one session must cover below a measured budget (spike S1/SP-3).
- **A reviewer silently skips part of a very large diff and still returns `complete`/`passed`.** Today a declared `complete` is accepted for architecture review. Mitigation: prove coverage host-side from artifacts the model cannot author (coverage by construction, or a read ledger parsed from the transcript); never rely on model-declared coverage as proof.
- **Reading tools truncate silently**, so "I read the whole file" can be false; a verdict can claim coverage it did not have (echo-only coverage objects).
- **An epic larger than any aggregation step can hold**, and chunked review loses the cross-chunk judgement the integrator exists for (needs a seam inventory and tree reduction).

## Reviewer mechanics
- The Claude child may be unable to read host-prepared inputs or run `git` against a linked worktree under its sandbox settings (never exercised against a real child).
- Tool-driven reviewers can trip the worktree-mutation guard after paying; a reviewer-run `git diff` is not the host-built diff.
- Tool-reading cost and latency are unmeasured and unbounded (no `--max-turns`); evidence ceilings (10,000 stream records, 50 MiB transcript) fail the run after spend.
- A tools-enabled reviewer reads untrusted diff content with `Bash`, `Write` and `Edit` available.

## Contracts and rollout
- Contract-version drift and verifier skew between hosts and installs (unknown versions are a hard refusal).
- A new packet or ledger collides with the authority-key scan; one launch/one receipt conflicts with per-chunk launches.
- Stale or tampered per-chunk evidence; editing the 11 pinned producer files invalidates retained focused verdicts for in-flight PRs.
- The routing signal (`inputTokens > 250000`) selects the model rung; a smaller launch prompt would run the review on a cheaper rung while the real workload is unchanged.

## Mirror exclusion
- Implemented in the shared classifier (`development-artifacts.cjs`) it opens a CI gate hole: a mirror-only PR would look development-only and skip product jobs.
- A partial or inconsistent exclusion (four paths use different pathspecs; arch-review uses none) or one that hides what is not a copy; mirror parity is proven by CI only for PRs not based on `epic/*` or `ticket/*`.

## Operations
- The stop-gap may not be enough and its margin is unknown (292–485k estimated tokens against an unmeasured window).
- Operators and reviewers have been relying on a refusal and a bypass (phase 50 merged without both reviews).
- Ownership and board collisions (phases 51 and 52 overlap these files) are not knowable from this checkout.
- Intake figures partly irreproducible (the 25.7 MB figure).
