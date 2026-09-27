# INV-009 research line: alternatives (OPTIONS.md draft)

- Line: `alternatives`; policy signals preserved as given: `{"type":"alternatives"}`
- Runtime/model: Claude, `claude-opus-5-5` / `medium` (research base rung, ADR-014 policy `adr-014.v6`)
- Source revision: `bc127635242959a3d6ff76c7d76e8ce456df512d`
  (checked: `git rev-parse HEAD`, exit 0, output matches)
- Policy hash: `30e71fb4066fee5b67df14120532c0b4f8aedde169907bc16f70dd2569744968`
- Scope: read-only. The only file written is this one. No provider account API was called, no
  model workload was launched, no test was run.
- Status of content: options with trade-offs for the human. **No recommendation is made.** Where a
  sentence says an option "depends on" or "forecloses" something, that is analysis, not a decision.

## 0. Command-backed facts this line relies on

Each fact below was checked on this revision. Line numbers moved since the 2026-09-26 evidence
copies were written; the evidence claims are marked "still holds" or "moved" accordingly.

| # | Fact | Command | Result |
|---|---|---|---|
| F1 | No source reads provider rate limits today. The only "subscription" mention is a null placeholder in the usage report. | `grep -rln "subscription\|rate_limits\|rateLimits" plugins/delivery-pipeline/scripts scripts` then `grep -n "subscription\|rate_limit" plugins/delivery-pipeline/scripts/usage-report.cjs` | One file: `usage-report.cjs:836` `units: 'tokens processed; not subscription quota'`, `:837` `subscription_usage: null`, `:839` "not subscription billing". |
| F2 | The review-host seam is `createClaudeRoleHost().run()` at `claude-role-host.cjs:1223`. It mints a new run/dispatch id at `:1228-1229`, records in-flight at `:1245`, and calls `roleArtifact.prepareRoleArtifact()` at `:1250` before `boundary.dispatch` at `:1254`. | `grep -n "prepareRoleArtifact\|run(\|checkpoint" .../claude-role-host.cjs`; `sed -n 1223,1262p .../claude-role-host.cjs` | Confirmed. IMPLEMENTATION-RESEARCH §2 cites `:1090`; **moved** to `:1223`, but the ordering claim (reuse lookup must go before `prepareRoleArtifact`) **still holds**. |
| F3 | The `checkpoint` model signal comes from graph rows: `claude-role-host.cjs:377` `checkpoint: rows.some(({ row }) => row.human_checkpoint === true)`; allowed signals at `:98` are `risk, critical, checkpoint, contested`. | same grep as F2 | Confirmed. IMPLEMENTATION-RESEARCH §6 cites `:359`; **moved** to `:377`, and the claim **still holds**. |
| F4 | The policy promotes on `checkpoint: true` for decomposition, arch-review, integrator, executor and research-like roles (`model-policy-internal.cjs:160,163,166,178,193`); the resolver applies it at `:635-643`. | `grep -n "checkpoint" plugins/delivery-pipeline/scripts/model-policy-internal.cjs` | Confirmed; this matches the `runtime_signal_rules` in the packet policy. |
| F5 | `validate-graph.cjs` parses `human_checkpoint` as a strict boolean (`:211`) and `preauthorized` (`:218`). It requires a checkpoint for high risk (`:520-521`) and requires a checkpoint for `preauthorized` (`:527-531`). | `grep -n "human_checkpoint\|preauthorized" plugins/delivery-pipeline/scripts/validate-graph.cjs` | Confirmed. |
| F6 | **The phase-43 owner of approval semantics is T-43-12** (REQ-162, REQ-175). It adds `human_checkpoint: true\|false\|review\|merge` plus a **new projected field named `checkpoint`** (`'merge'\|'review'\|null`) in `tickets.json`/`tickets.yaml`. It edits `validate-graph.cjs`. Its summary status is `halted`. | `grep -ln "review\` or \`merge" .planning/phases/43-*/43-*-PLAN.md`; `sed -n 1,30p` and `grep -n human_checkpoint` on `43-12-PLAN.md`; `grep -m1 -io 'status: *[a-z-]*' 43-12-SUMMARY.md` | `43-12-PLAN.md:4,29,45`; summary `status: halted`. ADR-020 records the same decision at `ADR-020-target-project-delivery-at-scale.md:31`. |
| F7 | Phase-43 plans that touch P44 seam files, with summary status: 43-06 (T-43-05: `claude-role-host.cjs`, `role-artifact.cjs`, `codex-delivery-host.cjs`), halted. 43-14 (T-43-14: `claude-role-host.cjs`, `claude-delivery-host.cjs`, `codex-delivery-host.cjs`, `deliver-dispatch.cjs`), halted. 43-11 (T-43-11: `validate-graph.cjs`), halted. 43-12 (T-43-12: `validate-graph.cjs`, `sentinel.cjs`, `pipeline-stats.cjs`), halted. 43-02 (`install-shipyard-claude-hook.sh`), complete. 43-03 (`install-shipyard-claude-hook.sh`, `pipeline-config.cjs`), halted. | loop over `43-{02,03,06,11,12,14}-PLAN.md` with `grep -o "plugins/delivery-pipeline/scripts/[a-z-]*\.cjs\|scripts/install..."` and the summary status grep | Of 19 summaries, 1 is `complete` (43-02) and 18 are `halted`. "Halted" is the summary's own word; whether each ticket is pending in the graph was **not** checked here (see U1). |
| F8 | Rotation advice exists at `session-handoff.cjs:148` (`recommendRotation`) and is called for status at `:473`. It groups by role/runtime/backend only (`comparableKey`, `:170-172`), needs 5 ordinary passes (`:177-178`) plus startup evidence (`:185-187`), and measures `estimated_tokens` or `bytes` (`:189-192`). | `grep -n "recommendRotation" ...`; `sed -n 148,200p .../session-handoff.cjs` | Confirmed. IMPLEMENTATION-RESEARCH §3 **still holds**: model, effort, policy and instruction identity are not in the cohort key. |
| F9 | `orchestration-overhead.cjs:18` sets `TREATMENT_KEYS = ['wait_events','bounded_context']` (values at `:20-21`); `normalizeTreatment` is at `:98`. | `grep -n "wait_events\|bounded_context\|function normalizeTreatment" .../orchestration-overhead.cjs` | Confirmed. IMPLEMENTATION-RESEARCH §7 cites `:17`; **moved** by one line, and the claim **still holds**. |
| F10 | The research handback cap is 500 characters: `workflows/investigation-research.mjs:46,215-216`. Required refs are assembled in `context-packet.cjs:397-400`. | `grep -n "500" .../investigation-research.mjs`; `grep -n "required_refs\|requiredRefs" .../context-packet.cjs` | Confirmed. IMPLEMENTATION-RESEARCH §4 cites `investigation-research.mjs:222` and `context-packet.cjs:385`; **moved**, and the claims **still hold**. |
| F11 | The Codex host launches with `--ignore-user-config` and `forced_login_method="chatgpt"` (`codex-runtime-host.cjs:1006-1007`) and requires `fork_turns none` (`:581,790`). | `grep -n "fork_turns\|ignore-user-config\|forced_login" .../codex-runtime-host.cjs` | Confirmed. RUNTIME-SPECIFIC-ADDENDUM §"Current evidence" cites `:841`; **moved**, and the claim **still holds**. |
| F12 | `lock.cjs:376` exports `withLock, acquire, writeAtomic, lockDirFor, sleepSync, DEFAULT_TTL_MS, OWNERLESS_GRACE_MS`. | `grep -n "module.exports" -A4 .../lock.cjs` | Confirmed. The primitives exist; no fencing-token export was seen (see U4). |
| F13 | A review-signature module exists: `review-signature.cjs`, schema `shipyard.review-signature.v1`. It normalizes finding rule classes, not governing inputs. | `head -40 plugins/delivery-pipeline/scripts/review-signature.cjs` | Confirmed. It is a repeat-signature helper for repair rungs, not a review input manifest. |
| F14 | No model-policy source mentions "experiment". | `grep -n "experiment" .../model-policy-internal.cjs .../model-policy.cjs` | No output. |
| F15 | Relevant unit tests exist: `claude-role-host`, `context-packet`, `model-policy`, `orchestration-overhead`, `review-signature`, `rotation-recommendation` (all `.test.cjs`). | `ls tests/unit \| grep -E "rotation\|overhead\|review-sig\|context-packet\|claude-role-host\|model-policy"` | Six files listed. They were not run in this line. |
| F16 | Phase 45 (another session) owns P5 "exact-revision INV reuse and stable research reporting", D2 "stage/runtime delivery instruction loading" and D4 "exact-input drift-scan reuse". It states that phase 44 owns subscription collection, exact arch-review reuse, mandatory instruction coverage, rotation advice, fact indexing, checkpoint reasons and effort experiments. | `sed -n 15,32p .planning/phases/45-*/CONTEXT.md` | Confirmed. These overlap P44-B, P44-C and P44-E at the boundary, and the options below must respect that split. |

Evidence copies used, and what still holds on this revision:
- `evidence/IMPLEMENTATION-RESEARCH.md` §§1-7 and the delivery sequence: design claims **still hold**; line
  numbers moved as noted in F2, F3, F9 and F10. Its scope-fence table names "phase-42 F6/F17/F18". F17 is now
  materialized as **T-43-12** (F6); the target-scale investigation became phase 43 / ADR-020.
- `evidence/RUNTIME-SPECIFIC-ADDENDUM.md` §§1-7: the Codex host claims **still hold** at the moved lines (F11).
  The `app-server` schema claims (Codex 0.157.0) were **not re-checked**: that needs an installed host (U2).
- `evidence/REPORT.md`: not re-read in this line. Its figures (the T-02-12 duplicate reviews, the pdffiller
  31,738-byte AGENTS.md) are used only as they are quoted in the two files above.

## 1. P44-A — collector shape per runtime

**Option A1: in-process tap inside existing hosts.** Claude: the supported installer wraps the statusline once.
It buffers stdin, extracts whitelisted `rate_limits` fields and forwards the identical bytes to the preexisting
renderer (IMPLEMENTATION-RESEARCH §1). Codex: the existing `codex-runtime-host.cjs` asks for a rate-limit snapshot
around each launch. Both append per-session files; the aggregate fills `usage-report.cjs:837`
`subscription_usage`.
- Cost: small to medium. There is one Claude installer change and one Codex host hook.
- Risks: the Codex CLI `exec` path (F11) is not the app-server. Whether `exec` exposes rate limits at all is
  unknown (U2), so the Codex half may collapse to "unavailable". Coupling to the launch host risks adding latency
  or failure modes to launches.
- Forecloses: sampling at times other than launches. It ties observation cadence to dispatch.

**Option A2: separate read-only observer per provider, host untouched.** Claude: the same statusline wrapper as
A1. Codex: a separate short-lived `app-server` client, invoked at lifecycle boundaries only. It calls
`account/rateLimits/read` and merges sparse `account/rateLimits/updated`. Both emit one shared normalized envelope
(ADDENDUM §1 field list).
- Cost: medium. It needs a new Codex protocol adapter with version and auth refusal.
- Risks: a second authenticated process against the subscription. It must not launch a model turn and must not
  become a daemon (PROBLEM.md out of scope). Schema support is not proof that retrieval works (ADDENDUM §1).
- Forecloses: nothing structural. It keeps launch authority out of observation (ADR-014 boundary).

**Option A3: Claude-only first; Codex marked `unavailable` until capability is proven.** Ship A1/A2's Claude
wrapper and the shared envelope and report. Codex rows carry `availability: unsupported|unverified` until a
read-only installed check passes.
- Cost: small.
- Risks: asymmetric data. Any cross-runtime claim stays inconclusive longer, and P44-G's Codex arm cannot be
  evaluated on quota.
- Forecloses: nothing; Codex can be added later under A1 or A2.

Common to all three: exact decimals kept, never summed across provider/bucket/window, reset or account change
gives a discontinuity, and no prompts or credentials persisted (CONTEXT.md locked requirements).

## 2. P44-B — reuse key and single-flight mechanism

**Option B1: full semantic input manifest plus a fenced reservation record.** The key is a versioned digest over
every governing input (the IMPLEMENTATION-RESEARCH §2 list plus runtime/provider/observed model/effort and host or
validator version, ADDENDUM §6). A state record `inflight|completed|failed|unknown` is written through `lock.cjs`
`withLock`/`writeAtomic` (F12) with an owner lease. Lookup runs after `prepareInvocation` and before
`prepareRoleArtifact` (F2). A hit returns `reused` with the original receipt reference.
- Cost: medium to large. The inventory of host inputs is the hard part.
- Risks: an incomplete key reuses a stale verdict, and that verdict can hide a violation. Lease expiry does not
  prove the child stopped, so unknown liveness must block (U4).
- Forecloses: nothing; a narrower cache can be derived later.

**Option B2: receipt-index lookup only, no reservation.** Reuse only a sealed, completed verdict whose recorded
input manifest equals the current one. Concurrent identical requests both launch (no single-flight).
- Cost: medium. There is no concurrency protocol.
- Risks: it does not fix the simultaneous-duplicate case the audit reported (T-02-12, two identical-input
  violation reviews), if those were concurrent. Whether they were concurrent is unknown (U5).
- Forecloses: it defers single-flight, which is a scope item of P44-B.

**Option B3: shared reuse primitive for arch-review now, generalized key API.** Build B1, but expose the
manifest and reservation as a role-agnostic module that phase 45 D4 (drift-scan reuse) and P5 (INV reuse) could
consume later.
- Cost: large. It requires API design for consumers that do not exist yet.
- Risks: it crosses into phase-45 ownership (F16) and widens the blast radius of a key bug.
- Forecloses: phase 45 choosing a different reuse design.

Invariants for any option: a reused violation stays blocking; no carry across a changed base (T-43/F6 owner); a
verdict never satisfies a separately required other-provider review; current CI and approval gates are
re-evaluated live. File conflict: `claude-role-host.cjs` is also edited by halted T-43-05 (43-06) and T-43-14
(43-14), so P44-B must be serialized after them (F7).

## 3. P44-C — coverage manifest and delivery

**Option C1: central shared rule-ID manifest, generated into native forms.** One manifest (rule ID, source digest,
scope, mandatory roles, loading mechanism). The Claude plugin and `scripts/gen-codex-shipyard.cjs` generate Claude
role/rule references and Codex startup/role references from it. A verifier asserts coverage per role before the
first relevant action.
- Cost: medium to large (a semantic migration).
- Risks: a generator bug drops a rule in one runtime; a manifest drifts from the actual instruction text.
- Forecloses: hand-maintained per-runtime instruction divergence.

**Option C2: verification-only manifest, native delivery unchanged.** Keep existing delivery. Add a manifest plus
an installed-host check that records the effectively loaded paths and digests per runtime and fails when a
mandatory rule is missing.
- Cost: small to medium.
- Risks: it detects gaps but does not repair them, and it saves no quota by itself. It needs installed-host
  evidence to be meaningful (U3).
- Forecloses: nothing; C1 can follow.

**Option C3: per-runtime manifests with a shared rule-ID namespace only.** Each runtime owns its own manifest;
cross-checks happen only on rule IDs.
- Cost: medium.
- Risks: parity drift, and two sources of truth for "mandatory".
- Forecloses: easy parity proofs.

Boundary: phase 45 D2 "stage/runtime delivery instruction loading" (F16) is adjacent. P44-C owns *coverage*
(which rules must be present); D2 owns *stage loading*. Target-repo instruction rewrites (pdffiller) are out of
scope; they are used as fixtures only.

## 4. P44-D — shadow-observation shape

**Option D1: extend the `recommendRotation` input rows.** Add model, effort, policy hash and instruction digest to
`comparableKey` (F8) and feed rows from phase-41 measurements. Record one shadow decision per
(advice, source-state fingerprint), and later record what actually happened.
- Cost: small to medium.
- Risks: a stricter key means more `unknown` results. Changing the key can alter the existing 7-test behaviour
  (compatibility).
- Forecloses: nothing.

**Option D2: separate shadow-log adapter; the recommender stays untouched.** A new adapter wraps
`recommendRotation` and writes decision records classed by resume, history-copying fork, compaction or fresh
start, including checkpoint/startup/warmup costs.
- Cost: medium.
- Risks: the comparability rules are duplicated outside the recommender.
- Forecloses: nothing; it is reversible.

**Option D3: defer P44-D until P44-A data exists.** Rotation advice keeps its token heuristic. P44-D is re-scoped
after subscription observations can support comparisons.
- Cost: none now.
- Risks: the audit's rotation findings remain unaddressed.
- Forecloses: nothing.

In all options automatic transfer stays disabled; T-41-02 owns checkpoint and successor safety.

## 5. P44-E — index granularity

**Option E1: file-level source index.** Each entry holds (repository, revision, path, file sha256, provenance).
Lines receive the selected files; synthesis reads full artifacts.
- Cost: small.
- Risks: a coarse index gives a small saving, and moved ranges invalidate whole files.
- Forecloses: nothing.

**Option E2: range-level source index plus a claim/finding index.** Each range carries a content digest, and the
finding index has `claim_id`, result, source refs, severity and contradiction links (IMPLEMENTATION-RESEARCH §4).
Synthesis expands only material claims.
- Cost: medium to large.
- Risks: selective synthesis can drop counterevidence. A false shared claim can spread across the four lines
  unless critical checks go back to primary sources independently.
- Forecloses: nothing, if the full artifacts remain durable.

**Option E3: finding index only (on the synthesis side), no source-selection change.** Keep the complete packets
per line and add only a per-line claim index to make synthesis cheaper.
- Cost: small to medium.
- Risks: research reads stay duplicated.
- Forecloses: nothing.

Boundary: phase 45 P5 owns exact-revision INV reuse (F16). P44-E must not reuse whole INV results; it indexes
facts inside a run. The 500-character handback (F10) and the four canonical lines are preserved.

## 6. P44-F — reason model and its interaction with `human_checkpoint`/`preauthorized` and T-43-12

Key fact: T-43-12 (F6) will introduce a projected field **named `checkpoint`** with values `merge|review|null`. The
model-policy signal is also named `checkpoint` (F3, F4). Any P44-F reason field must not collide with either name.

**Option F1: a separate `checkpoint_reason` field in the delivery block.** Values
`administrative|technical|mixed|unknown`, defaulting to `unknown` (conservative, current promotion). The role hosts
derive `signals.checkpoint = human_checkpoint && reason !== 'administrative'`. `human_checkpoint`, `preauthorized`
and T-43-12's `review|merge` are unchanged.
- Cost: medium to large. It needs the ADR-014 amendment, a validate-graph migration, derivation at both host seams
  and native resolver fixtures.
- Risks: mislabelling a technical checkpoint as administrative silently lowers the rung. `validate-graph.cjs`
  conflicts with halted T-43-11 and T-43-12 (F7).
- Forecloses: nothing; it is additive.

**Option F2: a new signal (`technical_risk`) instead of reinterpreting `checkpoint`.** Keep `checkpoint` as the
input only for approval. Add a separate signal derived from `risk`/`critical` and a reason. Resolver rules would
change from `{checkpoint:true}` to `{technical_risk:true}`.
- Cost: large. Every rung table in both native grids changes (F4 lists 5 roles × 2 runtimes).
- Risks: a larger ADR-014 amendment and a changed policy hash for every role. Legacy rows must map to
  `technical_risk:true` to stay conservative.
- Forecloses: the current meaning of the `checkpoint` signal.

**Option F3: derive the reason from T-43-12's `review|merge` value.** Treat `review` as administrative.
- Cost: small.
- Risks: it conflates *who acts* (review/merge) with *why* (technical/administrative). A high-risk ticket requires a
  checkpoint (F5), so it would lose promotion when marked `review`. It also redefines T-43-12's semantics, which is
  out of scope (PROBLEM.md).
- Forecloses: an independent reason taxonomy.

In all options, activating a resolver change requires the canonical ADR-014 amendment and observed-selection
receipts for each native grid (CONTEXT.md P44-F). F1 and F2 can ship "schema + migration, resolver inactive" first.

## 7. P44-G — experiment assignment and promotion rule

**Option G1: policy-hash-pinned experiment arm in the resolver, disabled by default.** A versioned experiment
record (eligibility, arms, assignment by deterministic hash of ticket id, stop rules) resolves through the trusted
host. Receipts carry the experiment id and the distinct policy hash. Promotion requires a recorded human gate over
matched cohorts, including repairs and escalations.
- Cost: large.
- Risks: a silent activation or an arm leaking into production; an experiment counted as a saving.
- Forecloses: nothing, if the gate is off by default.

**Option G2: offline paired trials in disposable worktrees; the resolver is untouched.** Run both arms outside the
delivery conveyor on selected small tasks with randomized order, and report on a separate experiment schema (not as
`orchestration-overhead` treatments, F9).
- Cost: medium, but the trials themselves consume quota.
- Risks: no production-cohort quota evidence, and small samples prove nothing about non-inferiority.
- Forecloses: nothing.

**Option G3: evaluation protocol plus schema only; no assignment mechanism in phase 44.** Define the schema,
eligibility, metrics and promotion rule. Assignment infrastructure moves to a later phase with its own ADR.
- Cost: small.
- Risks: P44-G acceptance ("infrastructure") is only partially met.
- Forecloses: nothing.

Promotion-rule variants for the human to choose: (i) the existing 20 completions / 95% attribution / 7-day defect
window as a minimum, plus a predefined non-inferiority margin; (ii) sequential stopping on the first false-green or
lost constraint; (iii) never automatic, always a recorded human decision. CONTEXT.md already requires (iii) for any
promotion, and (i) and (ii) are additive.

## 8. Comparative table (mandatory)

| Item | Option | Complexity | Main risk | Forecloses | Needs installed host / real account |
|---|---|---|---|---|---|
| P44-A | A1 in-host tap | S-M | Codex `exec` may expose nothing; launch coupling | off-launch sampling | yes (both) |
| P44-A | A2 separate observers | M | 2nd auth process; daemon creep | — | yes (both) |
| P44-A | A3 Claude-first | S | asymmetric data | — | yes (Claude) |
| P44-B | B1 manifest + fenced reservation | M-L | incomplete key; liveness | — | no (unit/fixture) |
| P44-B | B2 receipt index only | M | concurrent duplicates remain | single-flight (deferred) | no |
| P44-B | B3 generalized primitive | L | crosses phase-45 D4/P5 | phase-45 choice | no |
| P44-C | C1 generated from manifest | M-L | generator drops rule | hand-divergence | yes (loaded-source proof) |
| P44-C | C2 verify only | S-M | detects, no saving | — | yes |
| P44-C | C3 per-runtime manifests | M | parity drift | easy parity | yes |
| P44-D | D1 extend key | S-M | more `unknown`; test compatibility | — | no |
| P44-D | D2 shadow adapter | M | duplicated comparability | — | no |
| P44-D | D3 defer | — | finding unaddressed | — | — |
| P44-E | E1 file-level | S | small gain | — | no |
| P44-E | E2 range + claim index | M-L | lost counterevidence | — | no |
| P44-E | E3 finding index only | S-M | reads still duplicated | — | no |
| P44-F | F1 `checkpoint_reason` | M-L | mislabel lowers rung; validate-graph conflicts | — | receipts per grid |
| P44-F | F2 new `technical_risk` signal | L | whole-grid amendment | old signal meaning | receipts per grid |
| P44-F | F3 derive from review/merge | S | conflates who/why; alters T-43-12 | independent taxonomy | — |
| P44-G | G1 resolver arm, off | L | silent activation | — | yes (both) |
| P44-G | G2 offline paired | M | quota spend; weak evidence | — | yes |
| P44-G | G3 protocol only | S | partial acceptance | — | no |

## 9. Proposed ticket slicing with real data dependencies

These are proposals for the planner; they are not ticket IDs. The arrows are data or interface dependencies only.
Where a shared file is the only link, the entry says "serialize" instead.

1. **S-A0 Observation envelope + report slot**: fills `usage-report.cjs:837` (P44-A contract). No upstream data
   dependency.
2. **S-A1 Claude statusline collector + reversible installer** → depends on S-A0 (envelope). Installer file:
   serialize with T-43-03 (`install-shipyard-claude-hook.sh`, halted, F7).
3. **S-A2 Codex rate-limit observer** → depends on S-A0 and on the result of the U2 capability check. If U2 fails,
   the slice ships only the `unavailable` path.
4. **S-C1 Rule-ID coverage manifest + installed-loading verifier** (C2 core). No data dependency on S-A.
5. **S-C2 Native delivery generation from the manifest** (only under C1) → depends on S-C1. Touches
   `scripts/gen-codex-shipyard.cjs`.
6. **S-B1 Review input manifest + reuse lookup + reservation** → no data dependency on S-A. Serialize after
   T-43-05 and T-43-14 on `claude-role-host.cjs`, and on `codex-delivery-host.cjs` for the Codex parity half.
7. **S-D1 Rotation cohort key + shadow decisions** → depends on phase-41 measurements (T-41-06) and, for quota
   columns, S-A0.
8. **S-E1 Source/claim index + selective synthesis** → depends on the phase-40 planning artifact host. Optionally
   consumes the S-C1 rule IDs.
9. **S-F1 Reason schema + migration, resolver inactive** → depends on T-43-12's final `checkpoint` field
   (name/values), so it waits for T-43-12. Serialize on `validate-graph.cjs` after T-43-11 and T-43-12.
10. **S-F2 Resolver activation** → depends on S-F1, the accepted ADR-014 amendment and observed receipts per grid.
    It is a human checkpoint.
11. **S-G1 Experiment schema + protocol (+ assignment under G1)** → depends on S-A0/S-A1/S-A2 (quota metric), S-C1
    (instruction identity) and a stable baseline. It is a human checkpoint for any activation.

## 10. Deferrable or droppable without losing the phase goal

The phase goal is to reduce avoidable consumption per verified completion *and* to measure it. Measurement (S-A*)
is the one item every other conclusion needs; dropping it makes every saving an inference (PROBLEM.md "Current
pain").
- **Deferrable with low loss:** S-D1 (use D3; rotation already has an advisory mechanism, F8); S-F2 (activation);
  S-G1 assignment (use G3); S-C2 (use C2 first); S-E1 range granularity (start with E1 or E3).
- **Candidate to drop from phase 44:** B3 generalization (phase-45 territory); F3 (it conflicts with T-43-12
  semantics).
- **Not deferrable without changing the goal:** S-A0/S-A1 (measurement), S-B1 (the concrete repeated-review waste
  from the audit), S-C1 (the mandatory-coverage safety net).

## 11. Unknowns (for OPEN-QUESTIONS.md) and spikes

- [ ] U1: Are T-43-05, T-43-11, T-43-12 and T-43-14 pending, active or abandoned in the delivery graph? "Halted" in a
  SUMMARY is not graph state. Next check: `node plugins/delivery-pipeline/scripts/front.cjs` or read
  `.planning/graph/tickets.json` status. — owner: phase-43 delivery session
- [ ] U2: Does the installed Codex host (CLI `exec` or `app-server`) return an authenticated rate-limit snapshot
  without a model turn? — owner: maintainer, installed-host check (spike:
  `/gsd-spike "read-only Codex app-server account/rateLimits/read on installed host"`)
- [ ] U3: What do Claude and Codex actually load per role on the installed hosts (paths and digests)? — owner:
  maintainer, installed-host check
- [ ] U4: Does `lock.cjs` provide fencing semantics sufficient for a single-flight reservation that outlives the lock
  section, or is a new fenced record needed? Next check: read `lock.cjs` `acquire` TTL/owner logic. — owner:
  constraints/system-state line
- [ ] U5: Were the audit's duplicate T-02-12 reviews concurrent or sequential? This decides whether B2 is enough.
  Next check: `evidence/REPORT.md` timestamps. — owner: risks line / maintainer
- [ ] U6: What is the final name and value set of T-43-12's `checkpoint` field once it lands, and does the
  model-policy signal name need to change? — owner: phase-43 owner of T-43-12
- [ ] U7: Which Codex effort pairs are supported for a P44-G arm? — owner: maintainer after the Luna/max baseline
- [ ] U8: Does headless Claude worker execution invoke the statusline at all? This decides whether A1/A2 Claude
  coverage is parent-only. — owner: maintainer, installed-host check

Spikes recommended instead of throwaway code: U2 and U8 above; also
`/gsd-spike "enumerate claude-role-host prepareInvocation inputs for a complete review key"` (P44-B key completeness).
