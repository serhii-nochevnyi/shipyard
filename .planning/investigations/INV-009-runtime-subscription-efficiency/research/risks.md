# INV-009 research line 4 — risks and unknowns

- Investigation: INV-009-runtime-subscription-efficiency (phase 44, P44-A..G)
- Line: `risks` → drafts for `RISKS.md` and `OPEN-QUESTIONS.md`
- Source revision: `bc127635242959a3d6ff76c7d76e8ce456df512d` (`git rev-parse HEAD`, exit 0)
- Policy hash: `30e71fb4066fee5b67df14120532c0b4f8aedde169907bc16f70dd2569744968` (ADR-014 `adr-014.v6`, from the context packet)
- Runtime of this worker: Claude, `claude-opus-5-5` / `medium` (research base rung, resolved by caller)
- Policy signals preserved as given: `{"type":"facts"}`
- Mode: read-only. Only this file was written. No product code, planning state, provider account API, or path outside the worktree was touched.

## 1. Sources read

| Source | How read |
|---|---|
| `.planning/investigations/INV-009-runtime-subscription-efficiency/PROBLEM.md`, `RESEARCH-CONTRACT.md` | embedded in the authenticated context packet (digests `982e83ae…`, `b573cc3b…`) |
| `.planning/phases/44-*/CONTEXT.md`, `RESEARCH.md`, `WORK-PACKAGES.md` | embedded in the packet (digests `4e168000…`, `d42d9811…`, `57c5650c…`) |
| `.planning/phases/44-*/PLANNING-STATUS.md`, `evidence/IMPLEMENTATION-RESEARCH.md`, `evidence/RUNTIME-SPECIFIC-ADDENDUM.md` | `cat` (these are listed in `role_context.source_refs` but were **not** embedded in `required_refs`; see R-E3) |
| `.planning/phases/43-*/43-12-PLAN.md`, `43-13-PLAN.md`, `files_modified` of all 19 phase-43 plans | `grep` |
| `.planning/phases/45-*/WORK-PACKAGES.md` | `grep` (boundary only) |
| `plugins/delivery-pipeline/scripts/*.cjs` (listed per finding), `scripts/gen-codex-shipyard.cjs` | `grep -n`, Grep tool |
| `.planning/graph/delivery-state.json` | `node -e` status summary |
| INV-009 `RISKS.md`, `OPEN-QUESTIONS.md` (templates, empty) | `cat` |

Not read (blocked or out of contract): `~/.claude/statusline.sh`, `~/.claude/settings.json`, `~/.codex/shipyard/**`, `codex`/`claude` binaries. A Bash probe (`ls ~/.claude/statusline.sh; ls ~/.codex/shipyard; command -v codex claude`) was **denied by the session permission layer** and, independently, the research contract forbids reading outside the worktree. Every installed-host claim below is therefore an assumption or an open question.

## 2. Command-backed findings (evidence log)

| # | Claim | Command | Result |
|---|---|---|---|
| F1 | Rotation advice exists and hard-forbids automatic transfer | `grep -n "function recommendRotation\|automatic" plugins/delivery-pipeline/scripts/session-handoff.cjs` | `:148 function recommendRotation`; `:126`, `:241`, `:821` `automatic_transfer … allowed: false`; `:823` "automatic transfer has no proven runtime-specific host path" |
| F2 | Overhead treatments are a closed set of two | `grep -n "wait_events\|bounded_context\|function normalizeTreatment" …/orchestration-overhead.cjs` | `:18 TREATMENT_KEYS = ['wait_events','bounded_context']`; `:98 normalizeTreatment` |
| F3 | Existing primitive tests pass on this revision | `node tests/unit/rotation-recommendation.test.cjs; echo $?` / same for `orchestration-overhead.test.cjs` | rotation: `7 passed, 0 failed`, exit 0; overhead: `16 passed, 0 failed`, exit 0 (the preparation recorded 8 → the overhead suite has grown since 2026-09-26; the prep's count is stale) |
| F4 | `checkpoint` promotes the critical rung for executor, decomposition, integrator, arch-review | `grep -n checkpoint …/model-policy-internal.cjs` | `:160,163,166,178,193` rules `{ checkpoint: true }`; `:635-643` applies it |
| F5 | The checkpoint signal is derived from a boolean `human_checkpoint` at **two** launch seams | `grep -n checkpoint …/claude-role-host.cjs`; Grep `human_checkpoint` in `deliver-dispatch.cjs` | `claude-role-host.cjs:377 checkpoint: rows.some(({ row }) => row.human_checkpoint === true)`; `deliver-dispatch.cjs:90 if (row.human_checkpoint === true) signals.checkpoint = true;` |
| F6 | Graph parser collapses `human_checkpoint` to boolean and keeps `preauthorized` separate | `grep -n "preauthorized\|human_checkpoint" …/validate-graph.cjs` | `:211 human_checkpoint: delivery.human_checkpoint === true`; `:218 preauthorized`; `:520` high risk requires checkpoint; `:527` preauthorized requires checkpoint. No `'review'` literal (`grep -n "'review'"` empty) |
| F7 | Pending T-43-12 changes `human_checkpoint` to `review`/`merge` and itself calls the current boolean parse "fail open" | `grep -n "F17\|approval\|checkpoint" .planning/phases/43-*/43-12-PLAN.md` | `:29` "`human_checkpoint` takes `review` … or `merge` … `true` keeps meaning `merge`"; `:35` "a `review` value would silently become false: fail open" |
| F8 | Pending T-43-13 owns changed-base verdict carry | `grep -n "verdict\|carry" .planning/phases/43-*/43-13-PLAN.md` | `:4` "Carry a conform verdict across a base-merge…"; `:25` risk high because it reuses a verdict |
| F9 | Arch-review host run order: new dispatch id, then evidence preparation | `grep -n "prepareRoleArtifact\|async run\|dispatchId =" …/claude-role-host.cjs` | `:1223 async run`, `:1229 const dispatchId = newDispatchId()`, `:1250 roleArtifact.prepareRoleArtifact(…)`. The prep cited `:1090`; the seam moved |
| F10 | Codex host ignores user config and strips API keys | `grep -n "ignore-user-config\|forced_login_method\|OPENAI_API_KEY\|fork_turns" …/codex-runtime-host.cjs` | `:993 'OPENAI_API_KEY','CODEX_API_KEY'`; `:1006 forced_login_method="chatgpt"`; `:1007 --ignore-user-config`; `:790 fork_turns !== 'none'` refusal |
| F11 | Phase-40 planning sealer now exists; PLANNING-STATUS blocker is stale | `ls plugins/delivery-pipeline/scripts`; `grep -n "artifact\|planning" …/codex-decompose-host.cjs` | `planning-result-sealer.cjs` present; `codex-decompose-host.cjs:16 require('./planning-result-sealer.cjs')`, `:138-153` research artifact containment + `artifact_index`. PLANNING-STATUS.md ("accepts only gsd_role/prompt/signals/dispatch_id") no longer holds for the **source** (installed copy unverified) |
| F12 | No subscription/rate-limit code exists anywhere in source or tests | Grep `rate_limits\|five_hour\|statusLine\|rateLimits` over `{plugins,scripts,tests}/**/*.{cjs,mjs,js,json}` | no matches |
| F13 | Context packet fails closed on omitted content | Grep `truncat\|overflow\|required_refs` in `context-packet.cjs` | `:400` required refs loop, `:483` overflow flag, `:520 fail('INVALID_CONTEXT_PACKET', … omits content without an explicit overflow reference)` |
| F14 | Codex generator emits role instructions as `developer_instructions` | Grep `AGENTS\|project_doc\|developer_instructions` in `scripts/gen-codex-shipyard.cjs` | `:312 'developer_instructions = ' + tomlMultiline(body)`; `:320` fenced AGENTS.md block. No project-doc budget handling found |
| F15 | Shared-file owners among phases 40–43 | `for f in …; grep -l "$f" .planning/phases/4[0-3]-*/4*-PLAN.md` | `claude-role-host.cjs`: 40-16, 40-22, 41-01, 41-07, 41-09, **43-06, 43-14**; `validate-graph.cjs`: 40-15/17/20/27, **43-11, 43-12**; `role-artifact.cjs`: 40-*, 41-07, 42-01, **43-05, 43-06**; `codex-runtime-host.cjs`: 40-07/09/23, 41-04, 42-02; `session-handoff.cjs`: 41-02; `usage-attribution.cjs`: 41-06; `orchestration-overhead.cjs`: 41-02, 41-06; `context-packet.cjs`: 40-15, 41-01; `model-policy-internal.cjs`: 40-15; `gen-codex-shipyard.cjs`: none |
| F16 | Delivery state file contradicts git history for phase 40 | `node -e` over `.planning/graph/delivery-state.json`; `git log --oneline HEAD \| grep -oE 'T-40-[0-9]+' \| sort -u` | state: 27 `T-40-*` **pending**, `T-41-01..09` and `T-42-01..03` merged, `T-43-02` merged, `T-43-07` pr-open, other 17 `T-43-*` pending. Git history: all `T-40-01..28` present. `delivery-state.json` last committed `0872b22d 2026-09-26`. Working tree also has uncommitted edits to `delivery-front.json`/`dispatches.json` (gitStatus) |
| F17 | Phase-45 claims adjacent items that consume P44 outputs | `grep -n … .planning/phases/45-*/WORK-PACKAGES.md` | `:11` keeps P44 items with phase 44; `:29` P5 "Align … with phase-44 WP-G rather than building a second fact index"; `:36` D2 consumes WP-D rule IDs; `:37` D3 depends on P44 attribution; `:38` D4 drift-scan reuse "sharing only a proven identity primitive"; `:39` D5 admission ledger after provider-specific observation; `:52` R3 reviews only next merge candidate |
| F18 | This line's own packet illustrates selection loss | inspection of the context packet | `required_refs` embeds 5 files; `PLANNING-STATUS.md` and all three `evidence/*.md` are in `source_refs` only. `accounting.estimated_tokens 10374 / soft_ceiling 12000, overflow:false` |

## 3. Corrections the preparation needs on this revision

1. PLANNING-STATUS.md's blocker (Codex decompose host has no planning artifact contract) is stale for source (F11). Whether the **installed** Codex copy matches is unverified (Q-X2).
2. `claude-role-host.cjs:1090` → the reuse seam is now between `:1229` and `:1250` (F9).
3. Overhead tests are 16, not 8 (F3).
4. "F17 owner" is no longer a hypothetical former phase-42 item: it is pending **T-43-12** (F7), and changed-base carry is pending **T-43-13** (F8). Both are in phase 43, which is being delivered now.
5. The phase-44 CONTEXT dependency "phase 40 installed and verified" cannot be read from `delivery-state.json`, which still lists every T-40 ticket pending although all 28 are in history (F16).

## 4. Risks (RISKS.md draft)

Severity reflects impact if the item is built wrong, not likelihood.

### Cross-cutting

#### R-X1 — Checkpoint signal silently dropped when T-43-12 lands (fail-open model demotion)
severity: high
evidence: F5, F6, F7. Both launch seams test `human_checkpoint === true`. T-43-12 introduces `review`/`merge` values. If the parser at `validate-graph.cjs:211` or either derivation site is updated inconsistently, a `review` checkpoint yields `checkpoint=false` and the executor/arch-review/integrator stays at base rung — which *looks like* the P44-F saving without any reason model, policy amendment, or observed-selection evidence.
mitigation: P44-F must be planned strictly after T-43-12 merges and must add a regression fixture that `review`, `merge` and `true` all still produce `signals.checkpoint=true` at `claude-role-host.cjs` and `deliver-dispatch.cjs` until the ADR-014 amendment is accepted. Ask T-43-12's owner to include that assertion (Q-F1).

#### R-X2 — Shared-file collisions with pending phase-43 tickets
severity: high
evidence: F15. P44-B touches `claude-role-host.cjs` and `role-artifact.cjs` (pending 43-05, 43-06, 43-14); P44-F touches `validate-graph.cjs` (pending 43-11, 43-12) and `model-policy-internal.cjs`; P44-C likely touches `gen-codex-shipyard.cjs` and the delivery-rules skill (43-12 edits `skills/delivery-rules/SKILL.md` and `.shipyard/generated/gsd-delivery-rules/SKILL.md`).
mitigation: every P44 PLAN names the phase-43 ticket it follows on each shared file and re-reads line refs after that ticket merges; the graph gate must see a real `depends_on` only where data depends, otherwise serialization at dispatch.

#### R-X3 — Dependency readiness read from a stale state projection
severity: medium
evidence: F16. A planner or dispatcher trusting `delivery-state.json` would believe phase 40 is not started (blocking P44 forever) or, conversely, could trust an uncommitted working-tree projection from another session.
mitigation: define readiness by merged commits on `main` plus installed-host verification, not by the state file; resolve the discrepancy with the owner before Gate 2 (Q-X1).

#### R-X4 — Source present ≠ installed ≠ behaviourally verified
severity: high
evidence: F11 vs PLANNING-STATUS.md; the research line could not read `~/.codex/shipyard` or `~/.claude` (permission denied).
mitigation: each P44 item records three separate states (installed / behaviourally verified / efficiency-measured), per CONTEXT.md; installed-host proofs are explicit human-run steps listed in §5.

#### R-X5 — Phase-45 boundary erosion
severity: medium
evidence: F17. Phase-45 P5, D2, D3, D4, D5 consume or neighbour P44-E, P44-C, P44-A/D, P44-B identity primitive. If P44 generalizes reuse beyond arch-review, or builds an admission ledger, it takes phase-45 scope; if P44 ships an unstable identity primitive, D4 inherits it.
mitigation: P44-B keeps reuse to arch-review only; export the identity primitive with a versioned schema and document it as the only shared surface; no ledger/scheduler in P44.

#### R-X6 — Efficiency claimed from inference
severity: high
evidence: CONTEXT.md "no API-price or raw-token-to-quota conversion"; F12 (no quota data exists today).
mitigation: every report says `inconclusive` until matched cohorts exist; acceptance never contains a savings percentage; the phase integrator rejects PLANs whose must_haves assert savings.

### P44-A — passive subscription observation

#### R-A1 — Collector breaks or alters the user's statusline
severity: high
evidence: IMPLEMENTATION-RESEARCH §1 (renderer consumes stdin once; install must restore previous command). Cannot be verified here (no read of `~/.claude/statusline.sh`).
mitigation: wrapper buffers stdin once, forwards identical bytes; collector failure never changes renderer stdout/exit; install/uninstall only touch owned keys; tests with isolated `HOME`.

#### R-A2 — Credentials or account identifiers persisted
severity: high
evidence: phase-45 R8 (`WORK-PACKAGES.md:57`) already found Codex 0.157 captures leak `session_meta.creator_user_id`; Codex host strips API keys (F10) but an app-server session is authenticated.
mitigation: strict field whitelist (no raw stdin, no tokens, no email/user id — `account_scope` is a local label or salted hash); private file mode; bounded retention; negative fixture asserting no auth material in any stored record.

#### R-A3 — Non-additive percentages summed or mis-windowed
severity: medium
evidence: CONTEXT.md locked requirement; ADDENDUM §1 (`primary`/`secondary` not safely 5h/7d; legacy single-bucket alias).
mitigation: bucket identity = provider+account_scope+bucket_id+resets_at; reset/decrease/account change → discontinuity; alias dedup fixture.

#### R-A4 — Codex collector becomes a model launch or a second execution backend
severity: high
evidence: F10 (execution path is `codex exec --json`, not app-server); ADDENDUM §2.
mitigation: collector is read-only, never sends a turn; test asserts zero `turn/start`-class calls; no change to `codex-runtime-host.cjs` launch path.

#### R-A5 — Headless workers never render a statusline
severity: medium
evidence: IMPLEMENTATION-RESEARCH §1 ("Headless worker statusline coverage must be tested"). Unverified.
mitigation: account-level samples only bracket a controlled window; per-worker attribution stays with receipts/usage records; explicit "coverage: interactive only" flag when true.

#### R-A6 — Uncontrolled concurrent usage (web/mobile, other repos) attributed to Shipyard
severity: medium
mitigation: `concurrent_usage=unknown` default → `inconclusive`.

### P44-B — exact-input architecture-review reuse and single-flight

#### R-B1 — Reused verdict hides a violation or misses a changed input
severity: high
evidence: IMPLEMENTATION-RESEARCH §2 key list; F9 (evidence file is replaced at `:1250`); ADDENDUM §6 runtime-scoped identity.
mitigation: inventory every input the host actually reads before fixing the key (Q-B1); mutation test per key field (head, base, merge-base tree, plan, ADR, instructions, policy hash, runtime/model/effort, validator version, contested/critical signals) must miss; reused `violation` stays blocking; unknown input field → no reuse.

#### R-B2 — Reuse overlaps T-43-13 carry and double-grants a verdict
severity: high
evidence: F8. Two mechanisms that both "reuse a verdict" can compose: a P44 exact hit on a carried verdict, or a carry of a reused one.
mitigation: P44-B reuses only on identical base; never consumes a carried verdict as a reuse source; ADR states precedence (carry decision is T-43-13's; P44 hit requires exact identity). Plan P44-B after T-43-13 merges.

#### R-B3 — Single-flight deadlock or duplicate launch after crash
severity: high
evidence: IMPLEMENTATION-RESEARCH §2 ("lease expiry alone is not proof that its model child stopped"); `lock.cjs` exists for short critical sections only.
mitigation: reservation states `inflight|completed|failed|unknown`; `unknown` blocks automatic redispatch and surfaces a recovery action; never hold a file lock across the model run; crash-boundary fixtures.

#### R-B4 — Usage double-counted or original receipt replaced
severity: medium
mitigation: host returns `outcome: reused` with the original `dispatch_id`/receipt; usage attribution dedups by original dispatch; no new launch receipt.

#### R-B5 — Claude verdict satisfies a separately required Codex review (or vice versa)
severity: high
mitigation: runtime/provider is a key field; cross-provider requirement evaluated independently of cache.

### P44-C — mandatory instruction coverage

#### R-C1 — Required instruction lost on one runtime
severity: high
evidence: F14 (Codex roles get `developer_instructions`; no project-doc budget handling in generator); ADDENDUM §3 (default 32 KiB Codex project-doc budget; pdffiller AGENTS.md 31,738 bytes — from the audit, not re-measured here; the doc phrases the limit differently in two places).
mitigation: coverage manifest per rule ID × role × runtime; installed-host loaded-source digests as acceptance; refuse launch when a mandatory rule is unaccounted.

#### R-C2 — Relying on Claude path rules for mandatory pre-read / new-file checks
severity: medium
mitigation: explicit role-level loading for mandatory rules; path rules only for scoped reference material.

#### R-C3 — Destructive edits to target repositories
severity: medium
evidence: CONTEXT.md (pdffiller is a fixture, not authorization).
mitigation: fixtures copy the layout; any target-repo migration is a separate human-authorized change.

#### R-C4 — Generated Codex artifacts drift from the Claude source
severity: medium
mitigation: changes go through `scripts/gen-codex-shipyard.cjs` and its drift check; parity test through both adapters.

### P44-D — rotation advice and shadow observations

#### R-D1 — Advisory silently becomes automatic transfer
severity: high
evidence: F1 (`automatic_transfer.allowed:false` in three places).
mitigation: keep those literals; test that no P44-D path mutates ownership; automatic mode is out of scope.

#### R-D2 — Mixed cohorts produce misleading advice
severity: medium
mitigation: cohort key includes model, effort, policy hash, instruction digest; mismatch → `unknown`.

#### R-D3 — Fork counted as small fresh context; warmup costs omitted
severity: medium
evidence: ADDENDUM §2; F10 (`fork_turns none` invariant).
mitigation: separate classes resume/fork/compact/fresh-start; totals include checkpoint, successor startup, rereads, cache warmup.

#### R-D4 — Extra model wake just to re-deliver unchanged advice
severity: low
mitigation: one decision per (recommendation, source-state fingerprint).

### P44-E — research fact/source index

#### R-E1 — Shared false claim propagates to all four lines
severity: high
evidence: IMPLEMENTATION-RESEARCH §4; phase-45 P5 aligns with this index (F17).
mitigation: critical risk/constraint claims recheck primary sources per line; index entries are claims until checked; contradictions force expansion.

#### R-E2 — Stale facts after source change
severity: medium
mitigation: range content digest + file digest + revision; any change invalidates.

#### R-E3 — Selection omits material evidence without an overflow signal
severity: high
evidence: F18 — this very dispatch received PLANNING-STATUS.md and all evidence files only as `source_refs`, not `required_refs`, while `overflow:false`. `context-packet.cjs:520` fails closed only for *embedded* refs that omit content (F13); it cannot detect a material file never classified as required. This worker read them from disk; a stricter worker might not.
mitigation: the index must classify "mandatory transitive refs" explicitly and the packet builder must refuse when a mandatory class is absent; add a fixture where an evidence file is required by the contract.

### P44-F — typed checkpoint reasons

#### R-F1 — Policy change activated silently
severity: high
evidence: F4/F5; ADR-014 is `adr-014.v6` with checkpoint promotion in the policy content (packet).
mitigation: the reason field ships parsed-and-recorded only; resolver behaviour unchanged until an accepted ADR-014 amendment changes the policy hash; test that the policy hash in receipts is unchanged by the migration ticket.

#### R-F2 — Legacy/unknown reason de-escalated
severity: high
mitigation: absent/unknown/legacy → current conservative promotion; no bulk reclassification of existing checkpoints.

#### R-F3 — Approval semantics altered (duplicating F17)
severity: high
evidence: F7 — T-43-12 owns `review`/`merge` meaning; `preauthorized` separate (F6).
mitigation: reason is orthogonal to `human_checkpoint` value; merge-permission fixtures identical before/after.

#### R-F4 — Codex/Claude grids diverge
severity: medium
evidence: packet policy — Claude executor critical is `opus/low`, Codex `sol/high`; Claude arch-review has an extra `ceiling` rung (`fable/medium`, `inputTokens > 250000`), Codex does not.
mitigation: observed-selection receipts for both grids per reason value.

### P44-G — effort experiment harness

#### R-G1 — Experiment arm treated as the baseline / activated by default
severity: high
evidence: packet policy — Claude executor base `sonnet/max`; F2 (closed treatment set).
mitigation: separate versioned experiment schema, not a third `TREATMENT_KEYS` entry; default disabled; activation only through recorded approval; policy hashes for arms distinct.

#### R-G2 — Experiment counted as a saving
severity: high
mitigation: failed/repair/escalation/abandoned costs included; insufficient evidence → inconclusive; 20/95%/7-day thresholds are a floor, not proof.

#### R-G3 — Offline paired trials consume the subscription they measure
severity: medium
mitigation: budget trials explicitly; pilot requires approval with a cap.

#### R-G4 — Arbitrary model override path introduced
severity: high
mitigation: arms resolve through the trusted host only; no request-time override; alias pinning to observed model id.

## 5. What cannot be verified without an installed host or a real account

| Item | Needs | Why here it is unknown |
|---|---|---|
| Claude statusline carries `rate_limits.five_hour/seven_day` on this install | interactive Claude session on the maintainer's machine | read of `~/.claude` denied; contract forbids |
| Headless Claude workers emit statusline input | installed Claude run of a worker | no host access |
| Codex `account/rateLimits/read` returns data under ChatGPT subscription auth | read-only authenticated app-server call | contract forbids account API calls; prep only generated schema |
| Sparse `account/rateLimits/updated` frequency/shape | live app-server session | same |
| Effective Codex instruction chain/budget for launched roles | installed Codex run with loaded-source evidence | `--ignore-user-config` (F10) changes what loads; not observable from source |
| Installed Codex decompose host matches source sealer (F11) | `~/.codex/shipyard/scripts/codex-decompose-host.cjs` digest vs source | denied |
| Observed model/effort per reason value on both grids | real launches | no model launches in research |
| Any quota-per-completion delta | matched cohorts over days | no data (F12) |

## 6. Recommended spikes (not executed)

- `/gsd-spike "statusline tee wrapper: buffer stdin once, forward identical bytes, collector failure invisible to renderer, in an isolated HOME"`
- `/gsd-spike "read-only Codex app-server rateLimits read + updated merge under ChatGPT auth without a model turn"`
- `/gsd-spike "inventory every input claude-role-host arch-review reads between :1223 and seal, to derive the reuse key"`
- `/gsd-spike "measure the effective Codex developer_instructions + AGENTS chain for a generated role under --ignore-user-config"`

## 7. OPEN-QUESTIONS.md draft

- [ ] Is `.planning/graph/delivery-state.json` (all T-40 pending, last commit 0872b22d) authoritative, or is readiness defined by merged commits on main? Which does Gate 2 use for the "phase 40 installed and verified" prerequisite? — owner: repository maintainer / phase-40 delivery session
- [ ] Does the installed Codex `codex-decompose-host.cjs` / planning sealer match source revision bc127635 (i.e. is the PLANNING-STATUS blocker closed on the installed host)? — owner: maintainer (installed-host check)
- [ ] Will T-43-12 keep `signals.checkpoint=true` for `review` and `merge` at `claude-role-host.cjs:377` and `deliver-dispatch.cjs:90`, and does P44-F plan after T-43-12 merges? — owner: phase-43 session (T-43-12 owner)
- [ ] What is the precedence between T-43-13 changed-base carry and P44-B exact reuse; may a carried verdict ever be a reuse source? — owner: ADR author for INV-009 with the phase-43 session
- [ ] Which exact inputs does the arch-review host read (full list for the reuse key), including reviewer prompt/validator versions? — owner: system-state research line, then P44-B planner
- [ ] Does the maintainer's installed Claude statusline receive `rate_limits` fields, and do headless workers invoke it at all? — owner: maintainer (interactive check)
- [ ] Does Codex `account/rateLimits/read` succeed read-only under the ChatGPT subscription login used by `codex-runtime-host.cjs`, and what bucket ids does it return? — owner: maintainer (authenticated read-only check)
- [ ] What is the effective Codex instruction budget and loaded chain for generated roles launched with `--ignore-user-config`? — owner: maintainer / Codex installed-host check
- [ ] Which fields may the observation store keep for account scope (local label vs hash), and what retention period is acceptable? — owner: maintainer (privacy decision)
- [ ] Which phase-45 items may import the P44-B identity primitive, and is its schema versioned as a public contract? — owner: phase-45 session (INV-008) with INV-009 ADR author
- [ ] Which experimental effort pairs are eligible (Claude sonnet/high vs max only? any Codex pair after Luna/max baseline?) and who approves a pilot's activation and budget? — owner: maintainer
- [ ] Is an ADR-014 amendment for typed checkpoint reasons in scope for this phase's ADR, or a separate later ADR with P44-F shipping record-only? — owner: maintainer / ADR reviewer
- [ ] Which ticket owns `gen-codex-shipyard.cjs` and the generated delivery-rules skill for P44-C, given T-43-12 edits `.shipyard/generated/gsd-delivery-rules/SKILL.md`? — owner: phase-43 session and P44 planner
- [ ] Should packet builders refuse when a contract-mandated source is classified only as `source_refs` (F18), and is that P44-E or phase-45 P5 scope? — owner: INV-009 ADR author with phase-45 session

## 8. Assumptions (unverified)

- A1: ADR-017 and ADR-020 content was not re-read by this line; phase-43 plan text (F7, F8) is taken as the F17/F6 owner statement. Constraints line should confirm against ADR-020.
- A2: The phase-43 SUMMARY files present for all 19 plans are planning summaries, not delivery completions; delivery state (F16) shows 17 pending.
- A3: Evidence-file statements about the user's statusline (`statusline.sh:31-33`) and pdffiller sizes are historical (2026-09-26) and not rechecked.
- A4: Official doc claims (Claude statusline/memory/sub-agents, Codex app-server/AGENTS.md) are taken from the evidence copies; not re-fetched (no network in contract).
