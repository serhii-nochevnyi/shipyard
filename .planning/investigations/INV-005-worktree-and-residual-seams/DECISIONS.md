# Decisions

<!-- Every accepted position is recorded IMMEDIATELY at the moment of the decision, not at the end. -->
<!-- Record format: -->
<!-- ## <decision, as an affirmative statement> -->
<!-- **Why:** ... -->
<!-- **What was rejected:** ... -->
<!-- **Scope fence:** what this decision explicitly does NOT cover -->
<!-- These sections become the locked decisions in the ADR when Gate 1 is closed. -->

## All residual fixes and the worktree-conditions work land as new phase 40 tickets
**Why:** Phase 39 is merged to main by a parallel session, so the release circularity (RISKS R1) is resolved outside this INV; phase 40 is the next delivery on the same seams. Decided by the user 2026-09-24.
**What was rejected:** Phase 39 tail tickets; an integrator-only phase 39 tail.
**Scope fence:** New tickets carry `depends_on` on the phase 40 tickets that modify the same files (T-40-16, T-40-18, T-40-19, T-40-22, T-40-24; state-sync owners); ADR-017 decisions are extended, not re-decided.

## A conform verdict carries across a sibling merge only on a mechanical tree-level proof
**Why:** Serial re-review after every epic merge made phase 39 strictly sequential; a proof that the ticket's own change is identical and the base move touched only paths the ticket does not touch keeps the verdict bound to what was judged. Decided by the user 2026-09-24.
**What was rejected:** Cheaper delta re-review (still a model run per merge); accepting serial delivery; patch-id text comparison (rendering-sensitive).
**Scope fence:** Built on T-40-19's commit-status carrier; compares git tree objects for the ticket's declared and changed paths, not diff text; any overlap between base-move paths and ticket paths re-owes arch-review; cross-ticket semantics stay with the integrator.

## One worktree-conditions module checked before every role launch, and worktrees prepared correctly by construction
**Why:** Five places treated the same scratch set four ways and no host checked plan readability, signing, base freshness or leftovers; phase 39 needed ~10 manual repairs. Decided by the user 2026-09-24.
**What was rejected:** Per-host point checks plus a prose reference (drift, uneven remedies); an operator-run doctor that is not enforced.
**Scope fence:** A shared registry defines scratch and host-owned files; every host (role, delivery Claude/Codex, finalizer, base-merge, ticket-worktree.sh) consumes it; `ticket-worktree.sh` writes `.git/info/exclude` entries and gains `verify`; the role's own evidence path must be absent (or moved aside with a digest) before launch; a role's out-of-scope mutation is restored by the host and reported; every refusal names a copyable remedy.

## Executor artifacts are validated against their recorded base at publication
**Why:** An epic move between seal and publication made fresh executor artifacts unreadable (`STALE_ARTIFACT`), forcing rebase, uncommit and re-dispatch. Decided by the user 2026-09-24.
**What was rejected:** Host-side mechanical re-seal after rebase (more moving parts).
**Scope fence:** A historical executor mode re-verifies the recorded base commit and tree objects; the PR opens against the live base and the normal base-merge brings it current; freshness against the live epic is still enforced by the merge gates.

## The integrator judges the code diff plus a digest summary of .planning
**Why:** The epic 39 diff (1.94 MB) exceeds the role host's diff and prompt bounds, 1.47 MB of it `.planning`; plans already reach the integrator as phase contracts. Decided by the user 2026-09-24.
**What was rejected:** Per-ticket digests plus a seam diff (larger change); raising the cap (prompt and token bounds bind next).
**Scope fence:** Full `--unified=50` diff excluding `.planning/` and `.shipyard-role-artifacts/`; `.planning` changes as name-status with blob digests; still over a bound → refusal with a named remedy; `references/integrator.md` states the scope; works with tracked and untracked `.planning`; ADR-014 window promotion inputs unchanged.

## Arch-review accepts a draft PR; draft keeps meaning "not certified"
**Why:** The role host refused the only state in which deliver sends a PR to arch-review. Derived from INV-005 constraint C-T6/C-P2 on the endorsed recommendations 2026-09-24.
**What was rejected:** Undrafting before review; the review host undrafting.
**Scope fence:** Draft accepted only for arch-review; sentinel and merge keep refusing drafts; a test pins both.

## A sentinel round excludes PRs opened after its snapshot instead of failing
**Why:** Three sentinel rounds were discarded in phase 39 because the main loop opened PRs mid-round. Derived from constraint C-T7 on the endorsed recommendations 2026-09-24.
**What was rejected:** A publication lease that pauses the main loop.
**Scope fence:** New PRs are never acted on or reported by the round; they belong to the next round; changed members still expire; a test covers the non-member case.

## Planning changes carry a pending delivery observation
**Why:** `gsd-sync --check` failed every planning PR that added tickets. Derived from constraint C-T11 on the endorsed recommendations 2026-09-24.
**What was rejected:** A planning-mode check that skips observations (weakens fail-closed).
**Scope fence:** `gsd-sync` stays offline and fail-closed; the planning flow writes a deterministic `pending` observation for new tickets.
