# Options

Per scope item, from `research/alternatives.md` §1–§8, with the system-state correction on P44-A
(Option A4). The choice belongs to the human and is recorded in DECISIONS.md.

## P44-A — collector shape

- **A1 in-process tap in existing hosts.** Claude statusline wrapper through the installer; the
  Codex host asks for a snapshot around each launch. Couples observation to launches.
- **A2 separate read-only observers.** Claude statusline wrapper; a short-lived Codex app-server
  client at lifecycle boundaries (`account/rateLimits/read` plus sparse `updated`). A second
  authenticated process, and its retrieval is unproven.
- **A3 Claude-first.** Claude wrapper plus the shared envelope; Codex rows stay
  `unsupported|unverified` until a read-only check passes.
- **A4 stream-derived, reader side, both runtimes (new).** Parse records the hosts already save:
  Claude `rate_limit_event` (fraction 0–1) in the host transcripts under
  `~/.local/state/shipyard/claude/*/transcripts/` (host check: the INV-009 research transcripts
  hold 6–16 such records each), and Codex `token_count.rate_limits` in the native transcript that
  `usage-report.cjs:479` already reads. Only the reader changes (`usage-report.cjs` plus the
  envelope module); no runtime host, installer or phase-43 file is touched, and no new process or
  call is made. Limits: samples exist only while a worker runs, so there is no idle baseline and
  no coverage of the interactive parent session, which the audit says dominates consumption.
  Bracketing a whole run needs parent-side samples, which only the statusline wrapper (A1/A2/A3)
  provides; A4 can be combined with that wrapper later.

## P44-B — reuse key and single-flight

- **B1 full input manifest + fenced reservation record** (`inflight|completed|failed|unknown`,
  owner lease through `lock.cjs`; lookup before `prepareRoleArtifact`; hit returns `reused` with
  the original receipt).
- **B2 sealed-receipt index only**, with no single-flight: concurrent identical requests both
  launch.
- **B3 B1 as a role-agnostic primitive** for phase-45 D4/P5; crosses into phase-45 ownership.
- For all three: Codex has no arch-review host, so Codex reuse is a named gap until T-43-14
  lands.

## P44-C — coverage manifest and delivery

- **C1 central rule-id manifest generated into native forms** (Claude references + Codex
  startup/role references through `gen-codex-shipyard.cjs`), with a coverage verifier.
- **C2 verification-only manifest**: native delivery unchanged; installed-host check of the
  loaded paths/digests fails on a missing mandatory rule.
- **C3 per-runtime manifests** sharing only a rule-id namespace.

## P44-D — rotation shadow observations

- **D1 extend `recommendRotation`**: model, effort, policy hash and instruction digest in
  `comparableKey`, and one shadow decision per (advice, state fingerprint).
- **D2 separate shadow-log adapter**; the recommender is untouched.
- **D3 defer** until P44-A data exists.

## P44-E — index granularity

- **E1 file-level source index** (repository, revision, path, sha256, provenance).
- **E2 range-level source index + claim/finding index**, with selective synthesis.
- **E3 synthesis-side finding index only.**
- For any option: a packet refusal when a contract-mandated source is missing
  (risks R-E3) is small and independent.

## P44-F — checkpoint reason

- **F1 separate `checkpoint_reason`** (`administrative|technical|mixed|unknown`, default
  `unknown`): `signals.checkpoint = human_checkpoint && reason !== 'administrative'` after the
  amendment. Additive; it lands after T-43-12.
- **F2 new `technical_risk` signal**, replacing `checkpoint` in every rung table on both grids.
- **F3 derive from T-43-12's `review|merge`**: conflates who acts with why and redefines T-43-12.
- Delivery variant for F1/F2: ship record-only (schema + migration, resolver unchanged, policy
  hash unchanged) in phase 44, with activation behind a later ADR-014 amendment.

## P44-G — experiment infrastructure

- **G1 policy-pinned experiment arm in the resolver, disabled by default**, with deterministic
  assignment, a distinct policy hash per arm and a recorded human promotion gate.
- **G2 offline paired trials** in disposable worktrees; the resolver is untouched; the trials
  spend quota.
- **G3 protocol + versioned schema only**; the assignment mechanism waits for a later ADR.

## Sequencing against phase 43

Gate 2 rejects any unmerged, dependency-unordered pair of tickets that touch the same path
(`validate-graph.cjs:470-512`), whatever the delivery date. B, C, E and F therefore need real
cross-phase `depends_on` edges onto the pending T-43 tickets they share files with, and those
edges keep them blocked until epic 43 reaches main (`:628`). The choice is what to decompose now:

- **Seq-1 decompose all of P44 now**: A, D and G (as scoped) start at once; B, C, E and F carry
  cross-phase edges and sit blocked behind phase 43. Line references in their plans are re-read
  when they unblock.
- **Seq-2 decompose only the independent items now** (A, D, G protocol) and decompose B, C, E and
  F in a second planning pass after epic 43 merges, against the landed code.

## Comparison

| Item | Option | Complexity | Main risk | Forecloses | Needs installed host / account |
|---|---|---|---|---|---|
| P44-A | A1 | S-M | launch coupling; Codex half may be empty | off-launch sampling | both |
| P44-A | A2 | M | second auth process; daemon creep | — | both |
| P44-A | A3 | S | asymmetric data | — | Claude |
| P44-A | A4 | S | worker-only samples, no parent or idle coverage; units differ per runtime | — | none for fixtures; transcripts already hold samples |
| P44-B | B1 | M-L | incomplete key; liveness | — | no |
| P44-B | B2 | M | concurrent duplicates remain | single-flight | no |
| P44-B | B3 | L | crosses phase 45 | phase-45 choice | no |
| P44-C | C1 | M-L | generator drops a rule | hand divergence | yes |
| P44-C | C2 | S-M | detects only, no saving | — | yes |
| P44-C | C3 | M | parity drift | easy parity | yes |
| P44-D | D1 | S-M | more `unknown`; test compatibility | — | no |
| P44-D | D2 | M | duplicated comparability rules | — | no |
| P44-D | D3 | — | finding unaddressed | — | — |
| P44-E | E1 | S | small gain | — | no |
| P44-E | E2 | M-L | lost counterevidence | — | no |
| P44-E | E3 | S-M | reads still duplicated | — | no |
| P44-F | F1 | M-L | mislabel lowers the rung | — | receipts per grid at activation |
| P44-F | F2 | L | whole-grid amendment | old signal meaning | receipts per grid |
| P44-F | F3 | S | alters T-43-12 | independent taxonomy | — |
| P44-G | G1 | L | silent activation | — | both |
| P44-G | G2 | M | quota spend; weak evidence | — | both |
| P44-G | G3 | S | partial acceptance | — | no |
