# Open questions

## Closed by research and host checks

- [x] Does the installed Codex decompose host match the source (is the PLANNING-STATUS blocker closed)? → Yes. The digests of `codex-decompose-host.cjs`, `planning-result-sealer.cjs`, `codex-delivery-host.cjs` and `claude-role-host.cjs` are identical in source, `~/.codex/shipyard` and the Claude 0.67.0 cache (RESEARCH.md "Deployment").
- [x] Does the maintainer's statusline receive `rate_limits`? → Yes: `~/.claude/statusline.sh:31-41` reads `five_hour`/`seven_day.used_percentage`.
- [x] Do headless workers expose quota without the statusline? → Yes, Claude streams carry `rate_limit_event` (fraction) and Codex transcripts carry `token_count.rate_limits` (RESEARCH.md P44-A).
- [x] Which Codex effort pairs does the installed host support? → `gpt-6-luna` low, medium, high, xhigh and max; `gpt-6-sol` low, medium, high, xhigh, max and ultra (`~/.codex/shipyard/codex-capabilities.json`). Eligibility for an arm is a decision (see below).
- [x] Does `validate-graph` support cross-phase dependencies onto phase-43 tickets? → Yes (`validate-graph.cjs:628`; used by `40-01-PLAN.md:7`). Unordered shared paths are a Gate 2 error (`:470-512`).
- [x] Who owns F17 and what shape does it take? → Pending T-43-12: boolean-compatible `human_checkpoint` plus a projected field named `checkpoint` (`merge|review|null`); model signals untouched (RESEARCH.md P44-F).
- [x] What produces the `plugins/shipyard/host` mirror? → `scripts/package-shipyard-codex.cjs` (`make package-shipyard-codex`), regenerated on the epic.
- [x] Does `lock.cjs` provide fencing for a long single-flight reservation? → No. It has token-owned short locks (`:26-37,151`); a reservation needs its own state record written under the lock. This is a planning detail inside whichever P44-B option is chosen.
- [x] Is the committed delivery state authoritative for readiness? → No: it is stale for phase 40. Moved to RISKS.md (R-X3) with a mitigation.

## Decisions for the user

- [ ] P44-A collector shape (A1–A4) — owner: user
- [ ] P44-B reuse key and single-flight (B1–B3) — owner: user
- [ ] P44-C coverage manifest (C1–C3) — owner: user
- [ ] P44-D rotation shadow observations (D1–D3) — owner: user
- [ ] P44-E index granularity (E1–E3) — owner: user
- [ ] P44-F reason model and whether phase 44 ships it record-only (F1–F3) — owner: user
- [ ] P44-G experiment infrastructure (G1–G3) and eligible arms — owner: user
- [ ] Sequencing against pending phase 43 (S1/S2) — owner: user
- [ ] Where per-account quota samples live, and the account-scope identifier (opaque label vs salted hash) — owner: user

## Facts that need an installed host or a live account

- [ ] Idle-time Codex `account/rateLimits/read` under the ChatGPT login — owner: maintainer (read-only probe)
- [ ] Effective Codex AGENTS.md budget and nested loading under `--ignore-user-config` — owner: maintainer / spike
- [ ] Whether Claude session transcripts record the loaded CLAUDE.md/memory files — owner: maintainer / spike
- [ ] Complete list of arch-review prompt inputs for the reuse key — owner: P44-B planner / spike
- [ ] Whether the T-02-12 duplicate reviews were concurrent — owner: maintainer (not recorded in the audit)
