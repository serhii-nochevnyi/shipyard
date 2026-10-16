# Open questions

## Closed by research
- [x] Which components resolve Codex home, the capabilities file and the active runtime today, and where do their rules disagree? — answered: RESEARCH.md "Current system state", `research/system-state.md` §4 (20+ sites, 8+ rules; `codex-runtime-host.cjs:160-171` needs `CODEX_HOME`)
- [x] What does the host do with pre-existing provenance/dispatch/launch records after an upgrade, and which paths can block a new launch? — answered: `research/system-state.md` §6 (`role-artifact.cjs:1826-1827`; no migration; Claude role host also exposed)
- [x] Where do the phase + repository + ADR digest producer and consumer diverge? — answered: `research/system-state.md` §7 (five subject grammars, four repository identities; #486 shares only the decomposition seal)
- [x] Which refusals reach the user without a supported recovery, and what must preflight check? — answered: `research/system-state.md` §8, `research/constraints.md` §2.7
- [x] Which real installed entry points can an e2e check use? — answered: `research/risks.md` §5 (N-1…N-11); no UI entry point exists in the repo (see open question on UI path)

## Needs a spike or measurement (owner: research, not run by the first pass)
- [x] Can legacy records be kept historical/unverified without entering trusted evidence, and which migration marker/schema version is needed? (design obligations known; behaviour unverified) — carried into delivery as a verification obligation: ADR-030 L-11 (decided 2026-10-15)
- [x] Does the legacy-sidecar refusal reproduce at `v0.72.2` on the Codex delivery host, the Claude role host and the Claude delivery CLI, with a disposable HOME? — answered 2026-10-15: yes for the call shape all three hosts pass; see spikes/SPIKES.md (shared `recordInflight` exercised, Claude host CLIs not run end to end)
- [x] Which readers treat catalogue membership as proof of authenticity, so a migration can be shown not to promote legacy files? — carried into delivery as a verification obligation: ADR-030 L-11 (decided 2026-10-15)
- [x] Is `catalogue.lock` safe under pid reuse? — carried into delivery as a verification obligation: ADR-030 L-11 (decided 2026-10-15)
- [x] Is upgrade → downgrade → upgrade safe once the catalogue carries a migration marker? — carried into delivery as a verification obligation: ADR-030 L-11 (decided 2026-10-15)
- [x] Round-trip of the decomposition subject through build, host, sealer and verifier on both runtimes; repository paths with whitespace across the three regexes — answered 2026-10-15: whitespace part answered: grammars disagree (spikes/SPIKES.md S2); full cross-runtime round-trip stays an acceptance test
- [x] Codex `SessionStart` hook semantics — not needed: Option D was rejected (DECISIONS.md)
- [x] What does the Claude side do with no `CLAUDE_*`/`SHIPYARD_*` variables, and does `CLAUDE_HOME` have a reader in the runtime host? — carried into delivery as a verification obligation: ADR-030 L-11 (decided 2026-10-15)
- [x] Does GSD core expose a preflight/doctor worth reusing? — carried into delivery as a verification obligation: ADR-030 L-11 (decided 2026-10-15)
- [x] Do `run-store.cjs` and `planning-writer-lease.cjs` order or fence a catalogue write during adoption? — carried into delivery as a verification obligation: ADR-030 L-11 (decided 2026-10-15)
- [x] Which component writes the `.git/info/exclude` entries for `.planning/graph/provenance/` and `runs/`, and what happens in a fresh clone? — carried into delivery as a verification obligation: ADR-030 L-11 (decided 2026-10-15)

## Decisions for the user
- [x] Baseline: re-bind the design to `v0.72.2` / `origin/main` — decided 2026-10-15: local `main` fast-forwarded to `be7ab4f3` (v0.72.2); design is bound to it (DECISIONS.md)
- [x] Which option, or composition, to take — decided 2026-10-15: B-lite with MS1, no launcher (DECISIONS.md). The ADR-025 launcher conflict no longer applies; whether ADR-025 (untracked) is durable enough to cite for other constraints stays open — owner: user
- [x] Must legacy adoption (MS1) run automatically at first launch, or only on explicit consent? (PROBLEM item 2 implies automatic) — decided 2026-10-15: automatic, once per worktree, host-side (DECISIONS.md)
- [x] Legacy catalogue shape and handling of later changes — decided 2026-10-15: changed legacy member blocks the launch; one adoption only, any later unknown file blocks with a named remedy; the separate versioned `legacy_bookkeeping` field in the protected authority state is the shape (DECISIONS.md)
- [x] What counts as "explicit capability evidence" for discovery: the installer-written bundle copy, a live `codex debug models` probe, or both? Must launch verify it against the manifest digest and the ADR-014 grid? Which README account (`README.md:105-109` vs `:163`) is authoritative? — decided 2026-10-15: installer-written bundle copy verified by digest at every launch; no per-launch live `codex debug models` (DECISIONS.md)
- [x] When an env override disagrees with the bundle manifest: refuse, or env wins with a visible warning? — decided 2026-10-15: named conflict, refuse (DECISIONS.md)
- [x] Preflight-only command — decided 2026-10-15: a `--preflight` flag in every host, both runtimes, no new entry point and no Claude hook (DECISIONS.md)
- [x] Which env inputs does "validated environment for every child" own — decided 2026-10-15: only Codex home, capabilities path and runtime; the other variables keep their current owners (DECISIONS.md, env-conflict decision)
- [x] Canonical repository identity for subjects: remote `owner/name`, git-common realpath, `git-common:<sha256>` or worktree path? May the shared module be a new file given the publication-pin cost? — decided 2026-10-15: realpath of git-common-dir, one `repositoryIdentity()` in an existing module (DECISIONS.md)
- [x] What is "the existing supported UI path" for the installed-package full UI cycle? The repo has no UI entry point; GSD owns it. — decided 2026-10-15: GSD `gsd-ui-phase` → `gsd-ui-review` as a smoke scenario (DECISIONS.md)
- [x] Which incident produced the original ADR-digest mismatch — answered 2026-10-15: the FlowPDF Phase 9 planning session found the `adr=` binding missing from `codex-decompose-host.cjs:140` (EVIDENCE.md)
- [x] `--capability-only` exit-code contract — decided 2026-10-15: unchanged (exit 0); the new `--preflight` returns non-zero on any incompatibility (DECISIONS.md)
- [x] Acceptance evidence — decided 2026-10-15: hermetic core in CI (no-env launch on both runtimes; upgrade with every legacy-history variant; concurrent Codex+Claude; real state unchanged; UI smoke or declared gap) plus live receipts at release (DECISIONS.md)
- [x] Empty harness `.claude/.cc-writes/` directories — removed 2026-10-15 at the user's request
- [x] Behaviour on a project with an active peer session — decided 2026-10-15: existing catalogue lock only; the second session waits a bounded time or gets a named refusal with a remedy (DECISIONS.md)
