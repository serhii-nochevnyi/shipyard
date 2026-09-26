# Phase 41 — Integration (round 2, after T-41-09)

Verdict: passed

- Phase: `41-reduce-pipeline-subscription-overhead`
- Combined head: `1e57b5163fbd4c30b60b7f0386aa0a23d69af586`, tree `d070bcad71ff82467968f3929f0028ba04f006d3`
- Base: `origin/main` `8d6c8bc1f5452217f1c2030b0b2a5eab2adf8d5b`, tree `b199f88a4667a43b2691330386bca8eed95c61f3`
- Ticket-set digest: `d0784c5d53104d1312f2d8ab8f531700d0f721f00c0ba679daf8db4b3d3a22eb`
- Blocking findings: 0

## Revision and ticket-set evidence

| Check | Command | Result |
|---|---|---|
| Head, tree, base, base tree | `git rev-parse HEAD HEAD^{tree} origin/main origin/main^{tree}` | the four SHAs above; `git status --short` is clean |
| Ticket-set digest | `node -e '…sha256(JSON.stringify(ticket_set))'` on the host `ticket_set` | `d0784c5d…a22eb`, the same as the authenticated subject |
| Every ticket landed on the epic | `git log --oneline --first-parent origin/main..HEAD` | one squash commit per ticket: T-41-08 `49b47a97` (#236), T-41-03 `5960223e` (#238), T-41-07 `bce16061` (#235), T-41-02 `c9bb06fe` (#237), T-41-04 `79c0aba9` (#246), T-41-05 `1aa77de2` (#240), T-41-06 `b11b0487` (#241), T-41-01 `2046c2cd` (#244), T-41-09 `1e57b516` (#250). There are also two main-sync merges (#247, #249). |
| PR heads exist locally | `git cat-file -e <head>` for all nine ticket-set heads | all present |

Live GitHub PR state was not queried. This role has no network path to `gh`. The T-41-07 preflight (`phase-integrator-preflight.cjs`) is the component that proves live merged state, and it is the orchestrator's prelaunch step. The squash commits above are first-parent ancestors of the head by construction.

## Verification commands (run at the combined head)

| Command | Exit / result |
|---|---|
| `node --check` on claude-role-host, session-handoff, codex-runtime-host, gsd-sync, usage-report, orchestration-overhead, phase-integrator-preflight, state-sync, and tests/unit/phase41-stop-wake.test.cjs | all ok |
| `bash -n scripts/shipyard-pre-push-gate.sh` | ok |
| `node tests/unit/claude-role-host.test.cjs` | 0 — 40 pass, 0 fail |
| `node tests/unit/session-handoff.test.cjs` | 0 — 16 passed |
| `node tests/unit/rotation-recommendation.test.cjs` | 1 in the sandbox: 4 failed with `gpg failed to sign the data`, which is the user gitconfig signing fixture commits. With `GIT_CONFIG_GLOBAL=$TMPDIR/gc` (commit.gpgsign=false) it is 0 — 7 passed. Environmental; not a code defect. |
| `node tests/unit/phase41-stop-wake.test.cjs` | 0 — 8 passed |
| `node tests/unit/codex-runtime-host.test.cjs` | 1 inside this Claude session. `launchAgent sends dynamic selection…` fails with `claude-session-env: runtime claude conflicts with option.runtime (codex)` because the ambient `CLAUDE*` env is set. With the `CLAUDE*` vars unset it is 0 — 13 passed, including `typed launch accepts a completed native child after timeout-only parent waits`. Environmental; that test is not phase-41 code. |
| `node tests/unit/gsd-sync.test.cjs` | 0 — 30 passed |
| `node tests/unit/gsd-sync-gate.test.cjs` | 0 — 10 passed |
| `node tests/unit/usage-report.test.cjs` | 0 |
| `node tests/unit/orchestration-overhead.test.cjs` | 0 — 16 passed |
| `node tests/unit/phase-integrator-preflight.test.cjs` | 0 — 17 passed |
| `node tests/unit/deliver-phase41-preflight-contract.test.cjs` | 0 — 7 passed |
| `node tests/unit/state-sync-yaml.test.cjs` | 0 — 2 passed |
| `node tests/unit/pre-push-gate.test.cjs` | 0 — 8 passed |
| `node plugins/delivery-pipeline/scripts/gsd-sync.cjs --check --json` | 0, `"ok":true` (read-only; the generated projections match the per-output fingerprints at this head) |

Not run: `publish-gate.cjs --base origin/main --working-tree` (T-41-08) and `tests/smoke/sentinel-smoke.sh`. The plan assigns both to CI or the operator.

## Acceptance sweep

### T-41-01 (REQ-151)
- The reference appears once. `reference_digest: referenceDigest(reference)` is at `plugins/delivery-pipeline/scripts/claude-role-host.cjs:456,545,656`, and the reference is passed straight to `makePrompt`. `git grep reference_content -- plugins` returns nothing. The test `the role reference appears once in the prompt…` passes for all three roles.
- Partial supersession: DECISIONS.md refs are collected from every candidate before the superseded exclusion (`claude-role-host.cjs:314`). The partial-supersession fixture passes for arch-review, integrator and pr-sentinel.
- Required-input admission: an over-bound packet is refused with a remedy for all three roles (the test now covers sentinel as well).
- The launch record carries `packet_bytes`, `packet_estimated_tokens`, `prompt_bytes`, `host_identity`, `policy_hash`, `selected_refs`, `selected_backlog_ids`, model, effort and `first_response_usage` (`claude-role-host.cjs:1237-1245`).
- Release-operator installed-host and first-response observations: **not yet satisfied**. This is release evidence; see F1.

### T-41-02 (REQ-152)
- 32 KiB and 64 KiB bounds: `session-handoff.cjs:510` and the size refusals.
- Explicit boundary and child-enumeration refusal (`session-handoff.cjs:556` onward).
- Stale or missing pins carry remedies. Acknowledgement refuses on review, check or gate failure (`session-handoff.cjs:663` onward).
- Duplicate successor gets `HANDOFF_LOST` with a remedy. Continuation fields survive resume and acknowledgement.
- All of the above are covered by passing tests. The rotation fixture was amended as the operator approved.
- Collection, startup and warmup stages are still emitted through `recordLifecycleCost`. The live handoff observation is release evidence.

### T-41-03 (REQ-153)
- The fixture covers six foreign observations → 0 model turns, then one owner transition → 1 turn.
- It also covers: unarmed immunity; an unchanged CI wait → 0 claims; one CI or review change → 1 claim, duplicate refused; installed vs source digest and version separation; per-repo arm scope.
- 8 tests pass. Installed hook and settings observation is release evidence.

### T-41-04 (REQ-154)
- The parent wait check is now structural: every wait output must carry a boolean `timed_out` (`codex-runtime-host.cjs:664`).
- Child verification is unconditional for typed launches (`readNativeCodexChild` at `codex-runtime-host.cjs:918`).
- The launcher-level test covers: timeout-only then completion accepted, missing child refused, duplicate completion refused. Malformed, missing and non-boolean wait outputs are refused in the parser test.

### T-41-05 (REQ-155)
- Per-output fingerprints: `ticketFingerprint`/`phaseFingerprint` at `gsd-sync.cjs:1061,1068`, plus the state, requirements and roadmap fingerprints.
- The fixtures prove:
  - byte identity for unrelated phases;
  - a moved plan invalidates both phases;
  - a status change touches 6 files, none in unrelated phases;
  - read-only `--check` drift detection.
- The repository projections pass `--check` at head.

### T-41-06 (REQ-156)
- The outcome join requires exact or session attribution plus dispatch, ticket and run identity.
- Ambiguous outcomes stay `ambiguous`.
- Failed, parked and unknown rows stay in the cohort, as joined attempts or as unassigned overhead bucketed by reason and runtime.
- Mixed Claude/Codex totals are null.
- Matched cohorts need full runtime/model/effort/role/account identity and a single-treatment difference.
- Reopens and escaped defects force rollback. `status` separates implemented, installed, behaviorally verified and efficiency-measured.
- All of this is fixture-tested. Live cohorts and the 7-day defect window are release evidence.

### T-41-07
- The preflight derives the ticket set from the graph and checks it against the complete plan set.
- It requires exactly one live merged PR targeting the epic.
- It proves `merge-base --is-ancestor` against the pinned epic (`phase-integrator-preflight.cjs:151`) and re-pins the epic after the proof.
- The proof is bounded and never mentions INTEGRATION.md.
- `deliver.md:2741` places the gate before the single `boundary.dispatch`. The contract test passes.
- The blocking human checkpoint (proof schema and live proof) is outside this integrator's authority; see F2.

### T-41-08 (REQ-157)
- The YAML has no `#` line, volatile fields are excluded, and keys are sorted (`state-sync.cjs:962,1123`).
- The stdout generation line and meta JSON are unchanged (test asserts both).
- All 8 hook cases pass. The hook passes `SCRIPT_DIR` as `process.argv[1]`, confirmed with `node -e 'console.log(process.argv.slice(1))' -- /some/dir` → `["/some/dir"]`.
- The installed hook digest is release evidence.

### T-41-09 (REQ-151, fixes the round-1 blocker)
- `firstResponseUsage` (`claude-role-host.cjs:1088`) now:
  - groups by message id, falling back to uuid;
  - skips `<synthetic>` (`:1121`);
  - max-merges `USAGE_FIELDS`;
  - requires `stop_reason`, otherwise returns `unknown`/`incomplete` (`:1150`);
  - reports `synthetic-only`, `no identity` or `conflicting model` as unknown.
- The digest check is unchanged.
- This matches `usage-report.cjs:444-466` (same key, same max-merge, `complete ||= stop_reason`, same synthetic filter). The seven fixtures pass.
- The round-1 blocking seam is closed.

## Findings

- **F1 (informational, T-41-01).** The installed launcher that dispatched this integrator is not the merged host. The authenticated packet it built still carries `role_context.reference_content` alongside the same reference text at the top of the prompt, which is the exact duplication T-41-01 removed. Merged source has no `reference_content` (`git grep -n reference_content -- plugins` → empty; `claude-role-host.cjs:545` emits `reference_digest`). This confirms the plan's split between source integration and installed behavior: T-41-01's release acceptance (installed host, packet-builder and policy hashes, plus an observed first response per role) is still open.
- **F2 (note, T-41-07).** `deliver.md:2741` onward says to attach the bounded proof fields (`proof_digest`, `epic`, `merges`) to the integrator context. The Claude role-host request schema has no field for them (`claude-role-host.cjs:77-84` rejects any extra key), and this packet contains no proof fields. On the Claude path the binding therefore rests on digest equality: the host recomputes the same `{id, pr, head, base, branch}` set with `sha256(JSON.stringify)` (`claude-role-host.cjs:523`, matching `phase-integrator-preflight.cjs:194`), and `--verify --ticket-set-digest` compares them. That digest matches this dispatch's subject. The per-ticket merge SHAs must be recorded beside the receipt by the orchestrator. Whether a live proof was produced for this dispatch is **unknown** to this role. Next check: the operator inspects `<proof.json>` against head `1e57b516…` and digest `d0784c5d…` at T-41-07's blocking human checkpoint.
- **F3 (informational, T-41-07/T-41-01).** Two helpers are duplicated. The merged-PR marker and identity rule appears in `phase-integrator-preflight.cjs:113` and `claude-role-host.cjs:505-516`, and `canonicalJson` appears in `phase-integrator-preflight.cjs:30` and in the role host. The plan asks for the native Claude checks to stay as defense in depth, so this is intentional. Future edits must change both copies together.
- **F4 (informational, T-41-09).** `firstResponseUsage` accepts a strict superset of the record shapes `usage-report.cjs` accepts. It also takes `message.role === 'assistant'` and a top-level `record.usage` (`claude-role-host.cjs:1117-1118`), while usage-report requires `row.type === 'assistant'` and `msg.usage` (`usage-report.cjs:444`). For real Claude transcripts, which carry `type: 'assistant'` and `message.usage`, the results are the same. The two could diverge only on non-standard records.
- **F5 (informational, T-41-06).** The `verified_completions` rows from `usage-report.cjs` (with `dispatch_ids` at `:355`, emitted at `:855`) are shape-compatible with `orchestration-overhead.cjs`'s `completionClaims` (`:456`, consumed at `:540`). However, the overhead CLI `report` command (`:613`) has no flag to pass them in, so per-completion metrics are only reachable through the module API. This does not block the offline acceptance criteria.
- **F6 (informational, T-41-02).** The session-handoff CLI `checkpoint` default payload `{ next_action }` (`session-handoff.cjs:1083`) cannot pass `makeCheckpoint` without `--checkpoint-file`. That was already true before this phase, because `plan_digests` and the other fields were required. It now also requires `boundary`, `children` and `children_unknown`. There is no regression, but the manual CLI path needs a complete checkpoint file.

No duplicated or contradictory solution for the same concern, and no dead seam that blocks acceptance, was found across the nine tickets. ADR-004 (unknown ≠ none) holds in every new join:
- first-response usage (unknown with a reason);
- outcome join (ambiguous or unknown);
- handoff child enumeration (absent → refuse);
- preflight (every gap refuses);
- pre-push (an unresolvable named target refuses and does not fall back).

ADR-019's constraints hold as well: existing mechanisms are extended, no new ledger is added, and every savings verdict stays inconclusive until the readiness gates are met.

## Open release-time evidence (not integration blockers)
- T-41-01: installed host and policy hashes plus an observed first response per role (see F1).
- T-41-02: a live explicit handoff with collection, startup and warmup observations.
- T-41-03: installed stop-gate and arm digests plus the settings hook path, and one controlled owner wake.
- T-41-06: live matched cohorts and the seven-day defect window.
- T-41-07: approval at the blocking human checkpoint of the proof contract and live proof (see F2).
- T-41-08: installed pre-push hook digest and a real `cd <worktree>; git push` reaching publish-gate; `sentinel-smoke.sh` in CI.
