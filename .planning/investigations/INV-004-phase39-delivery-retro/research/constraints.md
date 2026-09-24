# INV-004 research line 3 — constraints

- **Line:** constraints (→ RESEARCH.md "Constraints" + seeds for CONSTRAINTS)
- **Investigation:** INV-004-phase39-delivery-retro
- **Source revision:** `8c264020707b67933cf109f0578c652fc8a1cb41` (`git rev-parse HEAD`)
- **Branch:** `inv/004-phase39-delivery-retro`
- **Dispatch selection (caller-resolved):** Claude `claude-opus-5-5` / `medium`;
  policy signals preserved verbatim as data: `{"type":"facts"}`
- **Mode:** read-only. The only file this line wrote is this one.

Confidence scale: **high** = read in code/ADR at the cited line with the cited
command; **medium** = consistent with code but the triggering run was not
reproduced; **low / assumption** = inferred, next check named.

---

## 0. Baseline delivery state (checked first, per the line-1 rule)

| Fact | Command | Result |
|---|---|---|
| `main` is the 0.61.0 release, no phase-39 code on it | `git log --oneline -3 main` | `befc970c Merge pull request #201 … release/version-0.61.0` |
| The phase 39 epic is not on `main` | `git merge-base --is-ancestor origin/epic/39-remove-conveyor-session-friction origin/main` | `epic-not-in-main` |
| No T-39 ticket branch is merged into the epic | `for b in $(git branch -r \| grep 'ticket/T-39'); do git merge-base --is-ancestor $b origin/epic/39-…; done` | all 8 remote ticket branches (T-39-01..07, T-39-12) `not-in-epic` |
| Epic head is the #203 planning merge | `git log --oneline -8 origin/epic/39-remove-conveyor-session-friction` | `5b56a747 Merge pull request #203 …` |
| Installed plugin version = source version | `grep -n '"version"' plugins/delivery-pipeline/.claude-plugin/plugin.json` | `"version": "0.61.0"` |
| `make test-fast` on this HEAD | `make test-fast` (see §6) | see §6 |

**Consequence (C-DEL-0, high):** every phase-39 fix (T-39-01 refusal hints,
T-39-03 armed stop gate, T-39-08 summary cap, T-39-12 schema/unwrap/run-scope)
exists only on unmerged ticket branches. A new ticket that "starts from main"
starts from 0.61.0 *without* them; any INV-004 fix that depends on T-39
behaviour must take a cross-phase dependency (user decision 2026-09-24,
PROBLEM.md "out of scope").

---

## 1. Hard technical constraints

### C-T1 — ADR-014 dispatch boundary and grid are frozen for this work
- **Source:** `CLAUDE.md` ("Mandatory boundary: every routed launch must
  resolve → validate → launch → receipt … missing receipts hard-refuse");
  `.planning/architecture/ADR-014-INTERFACES.md:6-22`; PROBLEM.md out-of-scope;
  ADR-016 "Out of scope" (`ADR-016-conveyor-session-friction.md:69`).
- **Checked by:** `Read ADR-014-INTERFACES.md` lines 1-60; `Read ADR-016…md`.
- **Implication:** fixes may change callers, mapping, messages and hosts, not
  the resolver input schema, grid, receipt shape or fail-closed verification.
- **Confidence:** high.

### C-T2 — `signals.type` enum is part of the frozen contract (item 3)
- **Source:** `ADR-014-INTERFACES.md:12` declares `type?: 'facts' | 'alternatives'`;
  `plugins/delivery-pipeline/scripts/model-policy-internal.cjs:422-423` refuses
  anything else with `UNSUPPORTED_SIGNAL`.
- **Graph side:** `validate-graph.cjs:160` defaults the *ticket* field
  `type: fm.type ?? 'implementation'`; `.planning/graph/tickets.json:162`
  carries `"type": "implementation"`.
- **Checked by:** `grep -n "implementation\|'facts'\|alternatives" …/validate-graph.cjs`;
  `grep -n 'signals.type\|facts\|alternatives' …/model-policy-internal.cjs`;
  `sed -n 150,170p .planning/graph/tickets.json`.
- **Implication:** the ticket `type` (GSD plan kind) and the ADR-014
  `signals.type` (research evidence kind) are two different vocabularies that
  share a name. Widening the enum would change the boundary contract (C-T1,
  out of scope). The compliant fix is in the front→dispatch mapping: do not
  forward ticket `type` as `signals.type` (or map it explicitly), with a test.
- **Confidence:** high.

### C-T3 — Dispatch mark must follow a verified receipt (item 1)
- **Source:** `plugins/delivery-pipeline/commands/deliver.md:1826-1830`
  ("Record the dispatch — AFTER the boundary returned a verified receipt, never
  before"), `deliver.md:104-110` (`mark` requires `--boundary-store` and
  `--dispatch-id`); `stop-gate.cjs:167-189` (a mark "is a weaker claim … must not
  buy silence" without an agent behind it); `dispatch-record.cjs:107-110`
  (TTL default 90 min, env `SHIPYARD_DISPATCH_TTL_MS`).
- **Checked by:** `grep -n 'dispatch' …/stop-gate.cjs`; `grep -n 'TTL\|ttl' …/dispatch-record.cjs`;
  `Read deliver.md` 98-122 and 1820-1839.
- **Implication:** on Claude the workflow receipt arrives at the end of the
  work, so "mark after receipt" = "mark after the work". A fix cannot simply
  mark before the launch (that is the phantom-silence case the stop gate was
  hardened against) and cannot drop receipt verification (out of scope). It
  needs a launch-time, host-issued proof (e.g. a launch/start receipt or a
  host-owned in-flight record with TTL) that the stop gate accepts. Whether
  the Claude workflow runtime exposes a launch id before completion is
  **unknown** → OPEN QUESTION; candidate `/gsd-spike "Claude workflow emits a
  launch id before completion"`.
- **Interaction:** T-39-03 (armed-session stop gate, `stop-gate.cjs`,
  `stop-gate-arm.cjs`, `dispatch-record.test.cjs`) touches the same files →
  cross-phase dependency on T-39-03 (see C-D5).
- **Confidence:** high for the rule; unknown for the runtime capability.

### C-T4 — Runtime-owned file digest pin (item 5)
- **Source:** `tests/unit/source-contract.test.cjs:1986-1995`
  `RUNTIME_OWNED_FILE_DIGESTS` pins SHA-256 of
  `scripts/runtime-adapters.cjs` and `scripts/claude-dispatch-adapter.cjs`;
  the message is "must match its checked-in baseline". Present identically on
  `main`, the epic and the T-39-12 branch.
- **Checked by:** `git grep -n 'RUNTIME_OWNED_FILE_DIGESTS' <ref> -- tests/unit/source-contract.test.cjs`
  for `main`, `origin/epic/39-…`, `origin/ticket/T-39-12-…`; `Read` lines 1986-2000.
- **Implication:** the pin is a deliberate change detector for palette/provider
  code (ADR-014 native-grid guarantee: lines 1996-1999 also assert aliases and
  forbid foreign model ids). A repair path must keep a deliberate, reviewable
  step (e.g. a script that recomputes the digest and requires the same PR to
  touch the adapter's contract tests) rather than removing the pin. T-39-12
  already lists `source-contract.test.cjs` in `files_modified`
  (`39-12-PLAN.md:13`) → cross-phase dependency.
- **Confidence:** high.

### C-T5 — Sentinel preconditions are fail-closed by design (item 4)
- **Source:** `plugins/delivery-pipeline/scripts/claude-role-host.cjs:187`
  (`BASE_REVISION_UNAVAILABLE`: base "missing or differs from its live GitHub
  revision"), `:365`, `:513` (`STALE_CONTEXT`: "live PR identity differs from
  delivery state"); ADR-004 "positive evidence before a mutation"
  (`.planning/architecture/ADR-004-positive-evidence-before-a-mutation.md`).
- **Checked by:** `grep -n 'differs from its live GitHub revision\|live PR identity differs' …/*.cjs`;
  `sed -n 1,25p ADR-004…md`.
- **Implication:** the fix must establish the preconditions (fetch/advance the
  base ref, run and commit state-sync) deterministically *before* the sentinel,
  or refuse with the remedy — not relax the identity checks.
- **Confidence:** high.

### C-T6 — Pre-push hook is a static text parse, fail-closed (item 11)
- **Source:** `scripts/shipyard-pre-push-gate.sh:13-18` derives the worktree
  from the first `git -C <p>` or `cd <p>` token in the command text, else the
  hook payload `cwd`; `:35-37` exit 2 blocks the push.
  `publish-gate.cjs:43-44` throws `not a git worktree` when `<worktree>/.git`
  is absent (relative/unexpanded paths such as `$W` resolve against the hook's
  cwd).
- **Checked by:** `Read scripts/shipyard-pre-push-gate.sh`;
  `grep -n 'not a git worktree\|cwd\|command' …/publish-gate.cjs`.
- **Implication:** a hook cannot expand shell variables it never sees; the fix
  must degrade to a verifiable source (payload `cwd`, `git rev-parse` on
  candidates) while staying fail-closed for a real push. Installed copy lives
  in `$CLAUDE_HOME/hooks/shipyard-pre-push-gate.sh`
  (`install-shipyard-claude-hook.sh:32,238`) → reaches users only after
  `make install-shipyard-claude-hook` (ADR-016 consequence, line 63-64).
  T-39-04 edits `install-shipyard-claude-hook.sh` (`39-04-PLAN.md:10`) →
  cross-phase dependency if the installer changes.
- **Confidence:** high.

### C-T7 — Comment policy blocks added comments (items 10, all code items)
- **Source:** `plugins/delivery-pipeline/scripts/comment-policy.cjs:6-9`
  (only `@invariant|@security|@contract:` markers ≤120 chars; history words
  such as `ticket`, `because`, `legacy`, `#123`, `ADR-nn` are rejected);
  enforced by CI `publish gate` step (`.github/workflows/test.yml:48-52`), by
  `make test-comment-policy` (`Makefile:80-81`, part of `test-fast`), and by the
  pre-push hook.
- **Backlog:** `.planning/backlog/generated-state-yaml-header-blocks-push-from-the-project.md`
  — `delivery-state.yaml` line 1 `# generated by state-sync.cjs …` (checked:
  `head -5 .planning/graph/delivery-state.yaml`) trips the same policy.
- **Implication:** every new script/test must be written without explanatory
  added comments; the item-10 fix is either a non-comment header or a
  generated-file exemption inside `comment-policy.cjs`, with a test.
- **Confidence:** high.

### C-T8 — Branch names come from `validate-graph.cjs slugify` (item 6)
- **Source:** `validate-graph.cjs:74-86` (`slugify(title, max = 40)`,
  `branchFor`). `ticket-worktree.sh create <ticket> <branch> <base>`
  (`ticket-worktree.sh:6,201-204`) takes the branch as an argument and does
  **not** truncate. `gsd-sync.cjs:62` has a second `slugify(max = 64)` used for
  phase dirs, not branches.
- **Checked by:** `Grep 'function slug|slugify|ticket/\$\{' scripts/`;
  `sed -n 70,90p validate-graph.cjs`; `grep -n branch ticket-worktree.sh`.
- **Contradicting evidence:** `git log --all --oneline -S 'output-schema-to-eve'`
  → no output: no commit ever contained the `…-to-eve` name; the epic's
  `tickets.json:5467` and the remote branch both say `…-to-ev`.
- **Implication:** the mismatch did not come from `tickets.json` vs
  `ticket-worktree.sh` as the problem statement says; the likely source is the
  hand-written request (`mkexec.cjs`, item 2) or a hand-typed `gh pr create`.
  The constraint for a fix: one branch-name producer (`branchFor`) and every
  consumer reads it from the graph, never recomputes. **Confidence:** medium
  (transcript [991] not re-read by this line) → OPEN QUESTION.

### C-T9 — Codex artifacts are generated, not hand-edited (item 12)
- **Source:** `CLAUDE.md` ("Codex artifacts are generated. Edit the Claude
  command or shared script first, then run `make install-shipyard-codex`");
  the only committed generated output is `.shipyard/generated/gsd-delivery-rules/`
  (`ls .shipyard/generated`), checked by `tests/unit/gsd-tune.test.cjs:23,140`.
  Generated TOML (e.g. `shipyard-inv-research.toml`, `sandbox_mode` from
  `gsd-tune.cjs:117` per evidence) is produced at install time.
- **Checked by:** `grep -rln '\.shipyard/generated' tests scripts Makefile`;
  `grep -n 'gen-codex\|--check\|diff' tests/smoke/codex-shipyard-smoke.sh`.
- **Implication:** C2/C3/C4 fixes land in canonical sources
  (`gsd-tune.cjs`, `codex-*-host.cjs`, `commands/*.md`) plus
  `scripts/gen-codex-shipyard.cjs`; verification is `make test-codex-shipyard`,
  which needs the network (C-D2).
- **Confidence:** high.

### C-T10 — Codex decompose researcher sandbox is pinned by a test (C4)
- **Source:** `codex-decompose-host.cjs:17-20` (`'gsd-phase-researcher':
  { role: 'research', sandbox: 'read-only' }`); `tests/unit/codex-decompose-host.test.cjs:35,53,103`
  assert `read-only` for the researcher.
- **Checked by:** `sed -n 16,20p …/codex-decompose-host.cjs`;
  `grep -n 'read-only' tests/unit/codex-decompose-host.test.cjs`.
- **Implication:** the fix changes a pinned expectation; the test must be
  rewritten from a real generated agent file (systemic item 0), not flipped by
  hand. T-39-01 edits both files (`39-01-PLAN.md:12,17`) → cross-phase
  dependency on T-39-01.
- **Confidence:** high.

### C-T11 — Research sealer exists only on the Claude host (C3, item 7)
- **Source:** `claude-delivery-host.cjs:506` `sealPlanningResearch`, dispatched at
  `:752`; `grep -n research codex-delivery-host.cjs` → no match.
- **Checked by:** `grep -n 'sealPlanningResearch' …/*.cjs`;
  `grep -n "research" …/codex-delivery-host.cjs`.
- **Implication:** a Codex research consumer must seal the same
  `shipyard.research-result.v1` envelope (this contract's §"Bounded handback")
  — shared code, not a Codex fork. `claude-delivery-host.cjs` is in T-39-08
  (`39-08-PLAN.md:10`) and `codex-delivery-host.cjs` in T-39-01
  (`39-01-PLAN.md:13`) → both cross-phase dependencies. Per-line discard
  (item 7) must keep fail-closed per line (a rejected line is a `blocked`
  line, never synthesized).
- **Confidence:** high.

### C-T12 — Out-of-repo host state directory is by design (C7)
- **Source:** evidence cites `codex-decompose-host.cjs:72-86`
  (`INVALID_STATE_DIR`, default `~/.local/state/shipyard/codex-decompose/`).
  Not re-read by this line → confidence medium.
- **Implication:** the fix is documentation/hint text, not moving the store
  into the worktree (receipts must be outside the model-writable tree).

### C-T13 — Doctor manifest path (C8)
- **Source:** `scripts/shipyard-doctor.cjs:192-195` checks
  `<codexHome>/shipyard/manifest.json`; installer writes
  `AGENT_MANIFEST_NAME=".shipyard-manifest.json"` into `$CODEX_HOME/agents`
  (`install-shipyard-codex.sh:280,430-432`) from a staging `OUT="$STAGE/bundle-out"`
  (`:235`).
- **Checked by:** `sed -n 190,196p scripts/shipyard-doctor.cjs`;
  `grep -n 'shipyard-manifest\|manifest.json' scripts/install-shipyard-codex.sh`.
- **Implication:** doctor is read-only (`CLAUDE.md`) and must stay so.
  Whether `$CODEX_HOME/shipyard/manifest.json` is ever written was not proven
  by this line → medium. T-39-04 edits `shipyard-doctor.cjs` and
  `install-shipyard-codex.sh` (`39-04-PLAN.md:11-12`) → cross-phase dependency.

### C-T14 — Host shell and tools (items 2, 8)
- **Checked by:** `/bin/bash --version` → `GNU bash, version 3.2.57(1)-release`;
  `command -v timeout gtimeout` → none; `node --version` → `v24.10.0` (CI pins
  `24.15.0`, `.github/workflows/test.yml:46`); `Makefile:1` `SHELL := /bin/bash`;
  `grep -rln 'mapfile\|declare -A\|readarray' scripts plugins/delivery-pipeline/scripts tests/smoke` → none.
- **Implication:** any entry point / waiter must run on bash 3.2 + Node with no
  npm install (`test.yml:3-4`: no package.json) and no coreutils `timeout`;
  timeouts belong in Node. Shell scripts keep `set -euo pipefail`
  (`CLAUDE.md` editing rules). The harness blocks long foreground `sleep`
  (evidence [745]) → waiting must be a background process or a notification,
  not a foreground loop.
- **Confidence:** high (host), medium (harness limit, from transcript only).

---

## 2. Product constraints

| ID | Constraint | Source | Confidence |
|---|---|---|---|
| C-P1 | Claude plugin is canonical; Codex is regenerated after every shared change | `CLAUDE.md` "Editing rules" | high |
| C-P2 | Host refusals keep codes, exit status, fail-closed behaviour; hints come from one shared code→hint map (T-39-01); never suggest bypassing a host | `ADR-016…md:40` | high |
| C-P3 | Stop gate enforces a front only in a deliver-armed session (T-39-03); item 1 must build on that marker, not add a second gating model | `ADR-016…md:42`, `39-03-PLAN.md:46-48` | high |
| C-P4 | Research handback bound is 500 chars, bounded or refused deterministically naming the line (T-39-08); item 7 per-line discard must reuse it | `ADR-016…md:50` | high |
| C-P5 | Installers write only to the selected runtime homes (`CLAUDE_HOME`, `CODEX_HOME`, `AGENTS_SKILLS_DIR`) | `CLAUDE.md` "Host setup" | high |
| C-P6 | A dogfood mode (item 9) must keep receipts honest: ADR-014 hard-refuses stale/missing generated variants; today receipts do not record host source (evidence N9). Any dogfood mode needs recorded host provenance, not silent cache overwrite | `CLAUDE.md` mandatory boundary; session-evidence N9 | medium |
| C-P7 | `make doctor` is read-only | `CLAUDE.md` | high |
| C-P8 | Keep generated state and measurements in existing `.planning` locations | `CLAUDE.md` editing rules | high |
| C-P9 | Supported command surface and README make targets are pinned by `tests/smoke/docs-smoke.sh`; a new entry point (item 2) or dogfood mode (item 9) must update README and `plugin.json` together; retired words (e.g. bare `compose`) fail docs-smoke | `CLAUDE.md` "Tests"; `39-04-PLAN.md:58` | high |
| C-P10 | Every deterministic rule ships with a focused unit or fixture test | `CLAUDE.md` Architecture | high |
| C-P11 | Boundary fixtures for items 0/4 must be captured from a real producer (success criterion) | PROBLEM.md "What success will be" | high |

---

## 3. Delivery constraints

### C-D1 — CI runs only the publish gate + `make test-fast`
- **Source:** `.github/workflows/test.yml:48-55`; `concurrency` cancels older
  runs on the same ref (`:28-32`); 10-minute job timeout (`:37`).
- **Implication:** captured live fixtures must be committed files replayed
  offline; no CI step may call `claude`/`codex`/network.
- **Confidence:** high.

### C-D2 — `make test` = `test-fast` + `test-codex-shipyard` + `test-releases`, both network-bound
- **Source:** `Makefile:47-51,83-87`; `tests/smoke/release-notes-smoke.sh`
  header ("Needs the network and an authenticated `gh`").
- **Implication:** the success criterion "`make test` stays green" is a local
  gate, needs npm registry + `gh`; the Codex parity items (C1-C8) can only be
  proven there.
- **Confidence:** high.

### C-D3 — GSD projections must be in sync (`test-gsd-sync`)
- **Source:** `Makefile:65-66` (`gsd-sync.cjs --check --json`), part of
  `test-fast`; failure on #203 (`Makefile:66: test-gsd-sync`, evidence N10).
- **Implication:** every planning change commits refreshed projections in the
  same PR; the item-10 fix must not break this check.
- **Confidence:** high.

### C-D4 — Commit / PR conventions observed
- **Checked by:** `git log --format='%s' -40 origin/epic/39-… origin/main | sort -u`.
- **Observed:** ticket branches `ticket/T-<phase>-<nn>-<slug≤40>`; planning
  `plan/<phase>-…`, investigation `inv/<nnn>-…`, release `release/…`; subjects
  `feat(T-NN-MM): …`, `fix(T-NN-MM): …`, `plan(NN): …`, `chore(NN): …`,
  `inv(NNN): …`; PRs merged by merge commit into `epic/<phase>-…`, epics into
  `main` via `release/…`.
- **Confidence:** high for observed pattern; the rule is convention, not a
  checked gate: `grep -rln 'commit-msg\|conventional commit' scripts tests plugins/delivery-pipeline/scripts`
  → no files.

### C-D5 — Phase ordering and cross-phase dependencies
- **Source:** user decision 2026-09-24 (PROBLEM.md); `state-sync.cjs:811`
  blocks a child: `cross-phase parent must land on <integ> first (phase N epic
  still ahead)`; `epic-branch.sh` has `ensure|refresh|pr|status|retarget`
  (`:202,243,338,352,367`); backlog
  `a-cross-phase-dependency-never-reaches-the-childs-tree.md`.
- **Checked by:** `grep -n 'cross-phase parent must land' …/state-sync.cjs`;
  `grep -n '^  [a-z-]*)' …/epic-branch.sh`.
- **Implication:** with §0 (nothing of phase 39 merged), every cross-phase
  child is blocked until the phase 39 epic lands on `main`; then the phase 40
  epic needs `epic-branch.sh refresh`. That pushes the "live phase 40 wave"
  success criterion behind phase 39 delivery.
- **Overlap map** (from `Grep '^files_modified|^  - ' 39-*-PLAN.md`):

  | INV-004 item | Files likely touched | Phase-39 ticket touching same file |
  |---|---|---|
  | 0 systemic fixtures | `claude-runtime-host.cjs`, `claude-dispatch-adapter.cjs`, `source-contract.test.cjs`, `claude-workflow-host.test.cjs` | T-39-12 |
  | 1 in-flight stop gate | `stop-gate.cjs`, `dispatch-record.cjs`/test, `deliver.md` | T-39-03 |
  | 2 front→dispatch entry | new script; `deliver.md` | T-39-03 (`deliver.md`) |
  | 3 signals.type | `model-policy-internal.cjs` or dispatch mapping | none |
  | 4 sentinel preconditions | `claude-role-host.cjs`, `deliver.md` | T-39-03 (`deliver.md`) |
  | 5 digest repair | `source-contract.test.cjs` | T-39-12 |
  | 6 branch name | `validate-graph.cjs` | T-39-06 |
  | 7 research refusal | `claude-delivery-host.cjs`, `investigation-research.mjs`, `claude-investigation-host.cjs` | T-39-08, T-39-01 |
  | 8 polling | new waiter; `deliver.md` | T-39-03 (`deliver.md`) |
  | 9 dogfood mode | installers, doctor, README | T-39-04 |
  | 10 state YAML header | `state-sync.cjs` or `comment-policy.cjs` | none |
  | 11 pre-push hook | `scripts/shipyard-pre-push-gate.sh`, maybe installer | T-39-04 (installer only) |
  | 12 C1 | `pipeline-config.cjs`, `codex-agent.cjs`, `codex-model-remap.cjs` | T-39-01 (hint map, `refusal-hints.cjs`) |
  | 12 C2 | `gsd-tune.cjs` | T-39-07 |
  | 12 C3 | `codex-delivery-host.cjs`, `investigate.md` | T-39-01, T-39-11 |
  | 12 C4/C6/C7 | `codex-decompose-host.cjs` + test, `claude-decompose-host.cjs` | T-39-01 |
  | 12 C5 | `codex-runtime-host.cjs`, `context-packet.cjs` | none |
  | 12 C8 | `shipyard-doctor.cjs`, `claude-hook-smoke.sh` | T-39-04 |

  "Likely touched" is this line's inference from the evidence file paths,
  not a plan → confidence medium.

### C-D6 — Out-of-scope boundaries (restated as constraints)
From PROBLEM.md: no change to the ADR-014 grid or dispatch boundary; no
removal of fail-closed receipt verification; no re-planning of T-39-01..12 or
of backlog entries `decompose-host-returns-no-artifact-index.md` and
`codex-plan-checker-lease-test-flakes-on-ci.md`; no Jira export. Item 12-C6
overlaps the decompose artifact-index backlog entry (its wording is
Claude-only, `.planning/backlog/decompose-host-returns-no-artifact-index.md:1-8`)
→ scoping must say whether C6 *is* that entry widened to Codex or a new ticket.
Item 10 overlaps `generated-state-yaml-header-blocks-push-from-the-project.md`
(PROBLEM.md explicitly re-raises severity).

### C-D7 — Worktree / session hygiene
- Preserve unrelated worktree changes; repo often edited during an active
  delivery session (`CLAUDE.md` editing rules).
- Shared git stash across worktrees (environment note) → fixes/scripts must
  not use bare `git stash`.
- Confidence: high.

---

## 4. Constraint seeds for CONSTRAINTS.md

1. The ADR-014 resolver input, grid, receipt shape and fail-closed receipt
   verification do not change; fixes live in callers, mappings, hosts and
   messages (C-T1, C-T2, C-D6).
2. `signals.type` stays `facts | alternatives`; ticket `type` never flows into
   it unmapped (C-T2).
3. No dispatch mark without host-issued launch evidence; in-flight silence
   must still expire by TTL (C-T3).
4. Digest pins stay; a repair path is a deliberate, tested command, never a
   free-form rewrite (C-T4).
5. Sentinel identity/base checks stay fail-closed; the conveyor establishes
   their preconditions itself (C-T5).
6. The pre-push gate stays fail-closed for real pushes (C-T6).
7. New code passes the comment policy; generated files get a sanctioned
   header or exemption, with a test (C-T7).
8. One branch-name producer (`validate-graph.cjs branchFor`); consumers read
   the graph (C-T8).
9. Codex changes are made in canonical sources and regenerated; parity proven
   by `make test-codex-shipyard` (C-T9, C-D2).
10. Pinned-defect tests are replaced by fixtures captured from a real
    producer (C-T10, C-P11).
11. Scripts run on macOS bash 3.2 + Node 24, no npm deps, no `timeout`
    (C-T14).
12. CI stays offline and deterministic; live captures are committed fixtures
    (C-D1).
13. Tickets overlapping phase-39 files take a cross-phase dependency; others
    start from main (C-D5).
14. Installer/hook changes reach users only after reinstall; the repeat run
    begins with `make install-shipyard-claude-hook` and `make doctor`
    (ADR-016:63-64).

---

## 5. Uncertainties and open questions (for RISKS / OPEN-QUESTIONS)

- [ ] Does the Claude workflow runtime expose a launch/task id before the
  workflow completes, so a mark can precede the receipt without weakening
  C-T3? — owner: repository operator / `/gsd-spike "Claude workflow launch id before completion"`
- [ ] Where did `…-to-eve` come from (transcript [991]); `git log --all -S`
  finds it in no commit? — owner: investigation orchestrator (re-read transcript)
- [ ] Is 12-C6 the existing decompose artifact-index backlog entry widened to
  Codex (excluded) or a new Codex ticket (in scope)? — owner: repository operator
- [ ] Is a dogfood mode (item 9) allowed to write to the Claude plugin cache,
  or must it be a separate install root recorded in receipts? — owner:
  repository operator
- [ ] Does `$CODEX_HOME/shipyard/manifest.json` exist after a real
  `make install-shipyard-codex` (C8)? — owner: next check `ls "$CODEX_HOME/shipyard"` after install
- [ ] Should the phase 40 live-wave success criterion wait for the phase 39
  epic to land on `main` (C-D5)? — owner: repository operator

---

## 6. `make test-fast` baseline on `8c264020`

**Not verified green in this sandbox.**

- `make test-fast > "$TMPDIR/inv004-testfast.log" 2>&1; echo "exit=$?"` →
  `exit=2`, tail: `unit tests FAILED` / `make: *** [test-unit] Error 1`. Later
  targets (graph, worktree, gsd-sync, sentinel, docs, hooks, comment-policy,
  model-ladder) did not run because make stopped at `test-unit`.
- `./tests/unit/run.sh 2>&1 | grep -n -E 'FAIL|✗|not ok|[1-9][0-9]* failed|^== |Error:' | grep -v ' 0 failed'`
  → failures are all environment-caused:
  - `git … commit -m chore: seed test repository` / `seed sentinel host repository`
    → `gpg failed to sign the data: keyblock resource '~/.gnupg/pubring.kbx':
    Permission denied` (the user's global git config signs commits; the
    sandbox denies `~/.gnupg`). Named failures: `✗ default base reconciliation
    creates a verified signed merge before repair dispatch`, `✗ blocks a file
    whose added comments exceed its added code`, `✗ blocks one added
    explanatory comment even when code outnumbers it`, `✗ publish gate includes
    uncommitted worktree additions`, plus claude-role / claude-sentinel host
    fixtures.
  - `Error: EPERM: operation not permitted, mkdtemp '/tmp/scds-XXXXXX'`
    (a test hard-codes `/tmp` instead of `os.tmpdir()`; the sandbox only allows
    `$TMPDIR=/tmp/claude-502`).
- **Interpretation:** no evidence of a code regression at `8c264020`, and no
  evidence of green either. CI (ubuntu, no signing config) is the
  authoritative signal; the next check is `gh pr checks` on the INV-004 PR,
  or `make test-fast` outside this sandbox.

### C-T15 — Test hermeticity constraint surfaced by the baseline (new)
- **Source:** the failures above. Unit fixtures that `git commit` inherit the
  developer's global `commit.gpgsign`, and at least one test writes to a fixed
  `/tmp` path.
- **Implication for INV-004:** new fixture tests (items 0, 4, 6, 11 all create
  git repos) must set `commit.gpgsign=false` / an isolated
  `GIT_CONFIG_GLOBAL`, and use `os.tmpdir()`/`$TMPDIR`; otherwise "`make
  test-fast` stays green" holds only on CI and on unsigned hosts. Same class as
  commit `df3f7f46 fix: isolate runtime session env in unit tests`.
- **Confidence:** high for the observed failures; medium that it reproduces on
  the operator's unsandboxed host (there `~/.gnupg` is readable, so signing
  likely succeeds) → OPEN QUESTION.
- [ ] Should unit fixtures be hermetic against global git signing config and
  fixed `/tmp` paths (C-T15)? — owner: repository operator
