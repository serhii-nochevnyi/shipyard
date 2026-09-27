# Decisions

## D-01 — Phase 44 is decomposed in two passes: A, D and G now; B, C, E and F after epic 43 merges
**Why:** Gate 2 rejects unordered shared paths (`validate-graph.cjs:470-512`). B, C, E and F share
files with pending T-43-05/06/11/12/13/14/15/16/17/18/19, so planning them now would pin them
behind cross-phase edges with line references that phase 43 will move. A, D and G (as scoped by
D-03) touch no pending phase-43 file. The user chose Seq-2 on 2026-09-27.
**What was rejected:** Seq-1, decomposing all seven items now behind cross-phase `depends_on`.
**Scope fence:** This ADR still decides the contracts of all seven items; the second pass only
materializes B, C, E and F plans against the landed phase-43 code. It is not a new investigation
unless phase 43 changes a decided contract.

## D-02 — P44-F ships record-only: a `checkpoint_reason` field with no resolver change
**Why:** Any change to the promotion rules changes `POLICY_HASH` (`model-policy-internal.cjs:300`)
and needs an ADR-014 amendment, a version bump, regenerated Codex agents and observed receipts on
both grids (constraints C-04, C-28). Recording the reason first lets phase 44 collect it without
risking a silent demotion (risks R-X1, R-F1). The user chose record-only on 2026-09-27.
**What was rejected:** F1 with activation in this phase; dropping P44-F; F2 (a new
`technical_risk` signal) and F3 (deriving the reason from T-43-12's `review|merge`).
**Scope fence:** The field is `delivery.checkpoint_reason` with values
`administrative|technical|mixed|unknown`, default `unknown`. It is orthogonal to
`human_checkpoint`, `preauthorized` and T-43-12's `checkpoint` field and does not reuse the name
`checkpoint`. `signals.checkpoint` stays `human_checkpoint`-derived and promotes exactly as today,
including for `review` and `merge`. The receipt policy hash is unchanged by the P44-F tickets.
Activation needs a later ADR-014 amendment. P44-F is in the second pass (D-01) because it edits
`validate-graph.cjs` after T-43-12.

## D-03 — P44-G ships the experiment protocol and schema only
**Why:** Effort cannot be a treatment today, because `effort` is a cohort key
(`orchestration-overhead.cjs:410,421-443`). An assignment mechanism in the resolver would be
launch authority and needs its own design (constraints C-03, risks R-G1, R-G4). The user chose G3
on 2026-09-27.
**What was rejected:** G1 (a policy-pinned arm in the resolver, disabled) and G2 (offline paired
trials that spend quota).
**Scope fence:** Phase 44 delivers a versioned effort-experiment schema and report, eligibility
rules, metrics that count failed, repair, escalation and abandoned work, and a promotion rule that
is always a recorded human decision above the 20 / 95 % / seven-day floor. It changes no resolver,
policy object, config key or dispatch, and nothing is active. The existing `TREATMENT_KEYS` set and
report schema are extended only by a new versioned schema, not mutated. Assignment infrastructure
needs a later ADR.

## D-04 — Installed-host unknowns are carried as risks, each resolved by a spike at the start of its ticket
**Why:** The research lines could not reach installed homes or a live account. The facts affect
implementation detail, not the contracts decided here. The user agreed on 2026-09-27.
**What was rejected:** Blocking Gate 1 on read-only probes.
**Scope fence:** RISKS R-A5 (idle Codex rate-limit read), R-C5 (effective Codex AGENTS.md budget),
R-C6 (Claude loaded-instruction evidence), R-B7 (complete arch-review input inventory) and R-B6
(T-02-12 concurrency). An unknown value never becomes launch authority or a passing gate.

## D-05 — P44-A reads quota from the transcripts the hosts already save, plus a reversible Claude statusline wrapper for the parent session
**Why:** Host transcripts already hold Claude `rate_limit_event` records (6–16 per INV-009 research
transcript under `~/.local/state/shipyard/claude/*/transcripts/`) and Codex
`token_count.rate_limits` (`codex-agent-stream-parent.jsonl:16,23,29`). Reading them changes no
runtime host and no pending phase-43 file. Worker samples alone miss the interactive parent
session, which the audit says dominates, so the Claude parent is covered by a statusline wrapper
(`~/.claude/statusline.sh:31-41` already receives `rate_limits`). The user chose this on
2026-09-27.
**What was rejected:** A1 (a snapshot call inside each launch); A2 (a separate Codex app-server
observer); reader-only A4 without the parent wrapper; A3 (Claude-first with Codex unavailable).
**Scope fence:** One whitelisted envelope for both runtimes. Units are normalized per source: the
Claude stream reports a fraction, while the statusline and Codex report percent. Bucket identity
is provider, account label, bucket id, window and reset. `primary`/`secondary` are never mapped to
5 h / 7 d by position. The whitelist excludes Codex `credits` and `plan_type`. The reader lives in
`usage-report.cjs` and a new envelope module; `claude-runtime-host.cjs` and `codex-runtime-host.cjs`
are not changed. The wrapper has its own supported, reversible installer entry point (a new script with a `make`
target), not `scripts/install-shipyard-claude-hook.sh`, which pending T-43-03 edits; nor does it
edit `tests/smoke/docs-smoke.sh`, which T-43-11/14/15/18/19 edit. It buffers stdin once, forwards identical bytes to the preexisting renderer, never changes
the renderer's output or exit, and restores only owned settings on uninstall. Development uses
isolated homes and never edits the user's active statusline. Idle Codex baselines and the Codex
parent session are recorded as `unverified` (R-A5). There is no app-server client, daemon, model
turn or account mutation.

## D-06 — P44-D extends `recommendRotation` with a stricter comparable key and deduplicated shadow decisions
**Why:** `comparableKey` compares only role, backend and runtime (`session-handoff.cjs:78-80`), and
advice is neither persisted nor deduplicated (`:112-130`). Extending the existing advisory
recommender follows ADR-019 and constraint C-17, which rule out a second recommender. The user
chose D1 on 2026-09-27.
**What was rejected:** D2 (a separate shadow adapter that duplicates the comparability rules) and
D3 (deferral).
**Scope fence:** The key adds model, effort, policy hash and instruction digest. A mismatch gives
`unknown`. There is one shadow decision per (recommendation id, source-state fingerprint), and
lifecycle classes resume, history-copying fork, compaction and fresh start are kept separate.
Costs include checkpoint collection, successor startup, rereads and cache warmup. The
`automatic_transfer.allowed: false` literals and T-41-02's ownership invariants stay, and no model
wake is added for unchanged advice. Quota columns come from D-05 when present. The change stays in
`session-handoff.cjs` and `orchestration-overhead.cjs` and their tests; `runtime-context.cjs` is not
edited, because pending T-43-03 and T-43-07 edit it.

## D-07 — Per-account quota samples live in private host state; only de-identified per-outcome joins are tracked
**Why:** `.planning/` is tracked in this repository (ADR-017 exemption), so account samples written
there would be pushed (constraint V-03). The user chose this on 2026-09-27.
**What was rejected:** A gitignored path inside the project tree.
**Scope fence:** Samples live under `~/.local/state/shipyard/<runtime>/subscription/` with mode
0600 (directory 0700) and bounded retention. Tracked reports carry only derived per-outcome and
per-cohort values with the account label. No prompt, transcript excerpt or credential is stored
anywhere.

## D-08 — Accounts are identified by an operator-declared local label
**Why:** The label needs no read of an account identifier, and `creator_user_id` has already leaked
into captures once (phase-45 R8, constraint V-02). The user chose this on 2026-09-27.
**What was rejected:** A salted hash of the provider account id.
**Scope fence:** The label (for example `claude-max-1`, `codex-prolite`) is declared per runtime
home. A missing label makes the observation `unattributed`, never a guessed account. A label change
is a series discontinuity. E-mail, user id, `credits` and `plan_type` are never stored.

## D-09 — P44-B reuses an arch-review verdict only on an exact versioned input manifest, with a single-flight reservation
**Why:** The audit proves a duplicate: T-02-12 was reviewed twice on the same head `b3ae2079…` and
base tree `2cfb6a0b…` with the same violation (`evidence/REPORT.md:53`). Sealed judgments are
indexed by dispatch id only (`role-artifact.cjs:35,947`). The host refuses anything but one launch
(`claude-role-host.cjs:1265`). The user chose B1 on 2026-09-27.
**What was rejected:** B2 (a receipt index without single-flight) and B3 (a role-agnostic primitive
that would take phase-45 D4/P5 scope).
**Scope fence:** Architecture review only. The key is a versioned digest of every governing
input: PR number, head and head tree, base and merge-base and their trees, integration-base tree,
exact diff, plan content and acceptance, ADR refs (including excluded and unresolved),
`reference_digest`, packet digest and selected backlog ids, signals including live `contested`
and `inputTokens`, policy hash, applied model and effort, host identity, and instruction digest.
The plan begins with an exhaustive input inventory (R-B7); an input outside the key disables
reuse. Lookup runs after authenticated preparation and before `prepareRoleArtifact`
(`claude-role-host.cjs:1250`). A hit returns a distinct `reused` outcome with the original
dispatch id and receipt; there is no new launch receipt and no change to `ApplicationReceipt`. A
reused violation still blocks. Live CI, approval and merge gates are re-evaluated on every hit.
There is no reuse across a changed base (T-43-13 owns carry) and a carried verdict is never a
reuse source. A verdict never satisfies a separately required other-provider review. The
reservation record has states `inflight|completed|failed|unknown`, is written under `lock.cjs`
without holding a lock across a model run, and `unknown` blocks automatic redispatch with a named
recovery action. Codex parity is a named gap until a Codex arch-review host exists (T-43-14). The
identity schema is versioned; phase 45 may consume it, but phase 44 builds no general reuse API.
Second pass (D-01): after T-43-05, T-43-06, T-43-13 and T-43-14.

## D-10 — P44-C ships a rule-id coverage manifest with an installed-host verifier first; generating native forms from it is a later decision
**Why:** No rule-id or coverage manifest exists, and neither runtime proves which project
instructions it loaded (`codex-runtime-host.cjs:876-891` covers role instructions only; the Claude
stream lists no memory files). Detection first gives a safety net without a semantic migration of
the instruction files. The user chose C2 first on 2026-09-27.
**What was rejected:** C1 now (a central manifest that generates both native forms) and C3
(per-runtime manifests).
**Scope fence:** A shared manifest of mandatory rule ids with source digest, scope, mandatory roles
and loading mechanism per runtime. The verifier records the paths and digests each runtime
actually loaded and fails when a mandatory rule is missing, with no silent truncation or omission.
Native delivery (`gen-codex-shipyard.cjs`, the delivery-rules skill, references) is unchanged in
phase 44, apart from what the verifier needs to read. The plan begins with the installed-host
spikes R-C5 and R-C6. Target repositories such as pdffiller are fixtures only. Phase-45 D2
consumes the rule ids and owns stage loading. Second pass (D-01): after T-43-12, T-43-14, T-43-18
and T-43-19. Generation from the manifest (C1) needs its own later decision based on the
verifier's findings.

## D-11 — P44-E adds a file-level source index and a packet refusal for missing contract-mandated sources
**Why:** Packet selection is file-level already (`context-packet.cjs:398-414`). In INV-009 the
contract-named evidence files sat only in `source_refs`, neither embedded nor flagged (risks
R-E3). A file-level index plus that refusal is cheap and cannot lose counterevidence. The user
chose E1 plus the refusal on 2026-09-27.
**What was rejected:** E2 (a range and claim index with selective synthesis) and E3 (a
synthesis-side finding index only).
**Scope fence:** Index entries hold repository, revision, path, sha256 and provenance; a changed
source invalidates its entry. The packet builder refuses when a source the research contract
marks mandatory is not embedded. The four lines, the 500-character handback, the `planning.v1`
contract, `shipyard.research-result.v1` and durable full artifacts are unchanged, and new fields
are optional and versioned. There is no whole-INV reuse, which is phase-45 P5, and P5 aligns with
these identities. Range or claim granularity (E2) needs a later decision based on measured data.
Second pass (D-01): after T-43-11, T-43-12, T-43-15, T-43-16 and T-43-17.
