# Decisions

## Launch and upgrade reliability is a separate investigation from UI lifecycle integration
**Why:** The user asked on 2026-10-15 to keep this work apart from INV-015 so the two tasks are not mixed.
**What was rejected:** Folding launch/upgrade reliability into INV-015, or treating the ADR-digest incident as part of the UI investigation.
**Scope fence:** This authorizes investigation only, not implementation, ticket creation or shipping. The five required changes in PROBLEM.md are stated requirements; the architecture and design remain undecided.

## Design baseline is Shipyard v0.72.2 (`origin/main`)
**Why:** The research packet was bound to `d8a70dec`, 9 commits behind; the installed bundle and the observed failures are v0.72.2 (`research/system-state.md` F0). The user asked on 2026-10-15 to update local `main`; it was fast-forwarded to `be7ab4f3`.
**What was rejected:** Designing against `d8a70dec`.
**Scope fence:** Behaviour at v0.72.2 on the Claude hosts is still unreproduced (spike S-1); it must be confirmed before decomposition.

## Take Option B-lite with MS1; do not build a launcher CLI
**Why:** The user accepted the recommendation on 2026-10-15. One shared environment resolver in an existing module plus a preflight inside every host, before `recordInflight`, removes the divergence (20+ resolution sites, 8+ rules) without a new entry point. MS1 (adopt pre-existing sidecars as historical/unverified in the protected authority state) is needed by every option and satisfies "history deletion is not a required procedure". A launcher (Option C) conflicts with the shape ADR-025 rejected for phase 47, adds a process hop and a publication-pin file, and buys little for Claude, which probes the runtime live.
**What was rejected:** Option A alone (leaves divergent resolution and only partial preflight/e2e); Option C (launcher); Option D (no Claude hook, unverified `SessionStart` semantics).
**Scope fence:** In scope: MS1 legacy adoption; one resolver in an existing module (no new script file); host-side preflight with accurate, installed-bundle-runnable remedies and hints from every entry point; a contract test plus one shared `repositoryIdentity()` for the digest subjects (not a rewrite of all subject grammars); an installed-package end-to-end harness in an isolated HOME (no-env launch, upgrade with old history). Out of scope: a launcher, persisted launch context, ADR-014 changes, any trust shortcut. Still open and not decided here: whether MS1 runs automatically or on consent, what counts as explicit capability evidence, env-versus-manifest conflict behaviour, the supported UI path for the e2e (see OPEN-QUESTIONS.md).

## MS1 legacy adoption runs automatically, once per worktree, inside the host
**Why:** The success criterion is that the ordinary command works after an upgrade with no manual step and no history cleanup; an operator-consent command would be exactly the "internal host command" knowledge PROBLEM.md rules out. Adoption stays host-side (the Claude launch sandbox denies the model access to the authority directory) and serialised by the existing catalogue lock.
**What was rejected:** Explicit operator-run migration (MS2); namespace split (MS3, wider blast radius); deleting or archiving history.
**Scope fence:** Adoption records the inventory in the protected authority state under a separate versioned legacy field with status `historical-unverified`; legacy members never become pins, never satisfy the `writeProvenanceOnce` existence check for a new dispatch id, and never count as verified evidence. New or altered members still refuse. A legacy member that changes after adoption is reported by preflight (block-versus-warn detail is for decomposition to settle with the spike). Re-adoption after a partial-history case is decided from spike S-1 results, not now.

## Explicit capability evidence is the installer-written bundle copy, verified by digest at every launch
**Why:** The installer already writes a measured, byte-identical `codex-capabilities.json` bound by `capabilities_digest` in the manifest; today runtime readers check only its shape. Locating it from the executing script's bundle and verifying digest and the ADR-014 grid at launch strengthens the contract without synthesizing evidence. The existing runtime probe (`codex --version`, `exec --help` markers) stays.
**What was rejected:** A live `codex debug models` probe on every launch (slow, runtime-dependent, duplicates bootstrap); trusting shape only; synthesizing evidence from policy.
**Scope fence:** Discovery locates and validates, never fabricates; a missing or digest-mismatched file is a named preflight refusal with a remedy that works from the installed bundle. The pinned installer refusal without explicit evidence (`tests/smoke/codex-shipyard-smoke.sh:145-155`) is unchanged. Staleness of the snapshot against the installed Codex CLI is reported by preflight; making it a hard refusal needs a measured rule and is a follow-up. README's two accounts (`README.md:105-109` vs `:163`) are reconciled in the same change.

## Environment that disagrees with the bundle is a named conflict and refuses
**Why:** A silent pick of either value is the failure class being removed. A self-located bundle resolves its own home, so global, dogfood and custom installs need no variable.
**What was rejected:** Env wins with a warning; bundle wins silently.
**Scope fence:** An explicit flag or env value that agrees with the bundle is accepted; one that differs refuses, naming both values and the remedy (unset it or reinstall). With no bundle (source checkout), the explicit value is required and is validated as today. The resolver passes the validated Codex home, capabilities path and runtime to child processes; other variables (`SHIPYARD_GRAPH_DIR`, `SHIPYARD_CODEX_AGENT_DIR`, `SHIPYARD_CODEX_LOG_DB`, `GSD_*`) keep their current owners.

## Canonical repository identity is the realpath of `git --git-common-dir`
**Why:** It is already used by the Claude hosts, `role-artifact.cjs` and `codex-planning-context-host.cjs`; it is identical across linked worktrees, needs no remote and survives remote renames. The remote-derived `owner/repo` form exists only in the Codex planning builder and is missing without a remote.
**What was rejected:** Remote `owner/name` (absent or renamable); `realpath(worktree)` (differs per linked worktree).
**Scope fence:** One `repositoryIdentity()` replaces the four constructions; the contract test round-trips every subject family on both runtimes. Sealed artifacts produced with the old Codex form must still verify (decomposition checks this first). Paths containing whitespace are covered by spike S2 before the change. The shared function lives in an existing module (no new script file). Moving a checkout changes the realpath and so the identity, as it already does for the authority key.

## The installed-package e2e covers a UI scenario only as a smoke of the existing GSD path
**Why:** The repository has no UI entry point; "the existing supported UI path" is GSD's `gsd-ui-phase` → `gsd-ui-review`. This INV owns whether launch and upgrade work, not UI design correctness, and has no dependency on INV-015.
**What was rejected:** Defining a Shipyard UI entry point here; blocking Gate 1 on INV-015.
**Scope fence:** The harness runs a fixture UI phase through the GSD commands in the installed package with the prepared environment and asserts it starts and completes without environment or history refusals. UI-quality findings go to INV-015. If the GSD path cannot be driven non-interactively in the harness, that scenario is recorded as a documented gap, not silently dropped.

## Claude hosts use the same bookkeeping route as Codex
**Why:** The user asked on 2026-10-15 for the same route for Claude if nothing contradicts it. At v0.72.2 the Claude delivery CLI already passes `worktree` and `claude-role-host` already does, so nothing contradicts it; the same MS1 admission and preflight apply to every host entry.
**What was rejected:** A Claude-specific bookkeeping path.
**Scope fence:** Confirmed against v0.72.2 by spike S-1 before decomposition.

## Mixed-runtime concurrency is in scope for design and acceptance
**Why:** The user stated on 2026-10-15 that the investigation was triggered by a parallel Codex session in the same repository; a Codex and a Claude launch were both observed writing into one project's provenance directory within ten minutes.
**What was rejected:** Treating concurrency as an out-of-scope edge case (risks R-10 and the pid-reuse spike S-3 are promoted to acceptance requirements).
**Scope fence:** Scope extends to the second session's outcome (named refusal or wait) and to adoption under concurrent writers; it does not add cross-runtime coordination beyond the existing catalogue lock without a separate decision.

## Handling of legacy members after adoption: block on change, one adoption only
**Why:** The user chose on 2026-10-15 to block a launch when an adopted legacy sidecar's bytes change, and to allow only one adoption per worktree; any later unknown file (for example from an older host still running in parallel) refuses with a named remedy to update that host. This keeps "new or altered records are never trusted" simple and unambiguous.
**What was rejected:** Warn-and-continue and ignore for a changed legacy member; repeatable adoption by stamp or by operator confirmation.
**Scope fence:** A parallel older session that writes after adoption blocks the new session until the older host is updated; the refusal must say so. The unauthenticated linked-worktree write path found in S-1 must be covered by adoption or pin its sidecar.

## Preflight is a `--preflight` flag on every host entry; `--capability-only` keeps exit 0
**Why:** Every host already runs preflight automatically; the flag shows its result without launching, which gives post-install diagnostics with no new file or entry point. `--capability-only` has a smoke caller (`tests/smoke/codex-runtime-smoke.sh:104`) and unknown external callers, so its always-exit-0 contract is not changed.
**What was rejected:** A standalone preflight command; extending `make doctor` (checkout-only); changing `--capability-only` to non-zero; removing it.
**Scope fence:** `--preflight` exits non-zero on any incompatibility, prints every finding in one pass with a remedy that runs from the installed bundle, and does not mint trust. Claude gets no preparation hook.

## Concurrency uses only the existing catalogue lock
**Why:** The user chose on 2026-10-15 not to add cross-runtime coordination: adoption and migration run under the catalogue lock; the second session waits a bounded time or gets a named refusal with a remedy.
**What was rejected:** Refusing adoption while a peer runtime has a live in-flight dispatch; documentation only.
**Scope fence:** Safety under simultaneous Codex and Claude writes is proven by acceptance (concurrent launch, including during adoption), not by new coordination. Spike S-3 (pid reuse on `catalogue.lock`) stays a design input.

## Acceptance is a hermetic CI core plus live receipts at release
**Why:** The user chose on 2026-10-15 the core set over the full N-1…N-11 matrix.
**What was rejected:** Full matrix including rollback in CI; minimum of two scenarios.
**Scope fence:** CI (Linux, Node 24) with an isolated HOME, state roots and graph dir: launch with no env on both runtimes; upgrade with each legacy-history variant (partial history, linked worktree, changed legacy member, new unknown member, symlinked member); concurrent Codex and Claude launches; real user state unchanged afterwards; the UI smoke scenario or its declared gap. Live receipts on both runtimes at release as already required. Upgrade → downgrade → upgrade (S-2) is not an acceptance gate; its result is recorded as a known limitation unless the spike shows a hazard.
