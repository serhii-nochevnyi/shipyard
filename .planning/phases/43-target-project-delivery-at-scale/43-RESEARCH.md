# Phase 43: Target-project delivery at scale — Research

**Researched:** 2026-09-26
**Domain:** Shipyard deterministic conveyor scripts (Node CJS), merge gate, trusted delivery hosts, project configuration
**Confidence:** HIGH for seams and ownership (read from source and graph this session); MEDIUM for designs that depend on phase-40/42 code not yet on `main`

## Summary

ADR-020 has 17 decisions (REQ-159..REQ-175). The code seams behind each one exist on this revision. Nearly half of them sit in files still owned by pending phase-40 tickets and by T-42-01. Phase 41 is fully `merged` in `delivery-state.json`, so its files (`gsd-sync.cjs`, `shipyard-pre-push-gate.sh`, `pre-push-gate.test.cjs`) no longer force any ordering. Every phase-40 ticket and T-42-01 is still `pending`. For each phase-43 file I checked the owners in `.planning/graph/tickets.json`, which is the post-amendment graph. The orchestrator's hot-file list is correct, with these corrections:
- **T-40-28, not T-40-15,** owns `workflows/executors.mjs`, both delivery hosts and their tests. T-40-15 owns only `deliver-dispatch.cjs`, its test, `run-waker.cjs` and its test.
- **T-42-01 (not T-41-04)** owns `codex-delivery-host.cjs`, `delivery-commit-finalizer.cjs` and `command-runner.cjs`.

Five findings change how the plan should be shaped:
1. **T-42-01 already specifies a host-side verification producer for Codex.** That is `collectVerificationEvidence` plus an OS-sandboxed `createVerificationRunner`, which "never fall[s] back to bare `runBounded`" and denies network access. REQ-159 therefore means reusing and sharing that producer, not inventing a new one. The pdffiller verification path needs docker and php, and so it collides with the "no network, no sockets" runner profile. That is the main decision the planner has to put in front of the human.
2. **Nothing records which commits the conveyor made.** The finalizer returns `{commit, …}` (`delivery-commit-finalizer.cjs:224`) but writes nothing a merge gate could look up later. The `base_merge` journal line is written by the model through `log-event.cjs`, and the live journal shows one that covers a hand-resolved conflict. REQ-160 therefore needs a sealed coverage record written at finalization. It cannot rely on a receipt lookup alone.
3. **`validate-graph.cjs:164` reads `human_checkpoint: delivery.human_checkpoint === true`.** Written today, a plan value of `review` silently becomes `false`, which fails open. REQ-162 must change validation before any plan uses the new values.
4. **Aliasing `pipeline.gsd_sync` in `loadConfig` is not enough.** GSD's lifecycle gates are keyed on `"when": "delivery_pipeline.gsd_sync"` (`capability.json:134,147,160,173`), and `gsd-sync-gate.cjs:38` reads only `delivery_pipeline.gsd_sync`.
5. **`sentinel.mergeOne` tests `checks.failing > 0` and `checks.pending > 0` directly (`sentinel.cjs:1026-1027`), not `isGreen`.** Moving `cancel` out of `failing` without adding it elsewhere would let the guard merge a PR whose latest run was cancelled.

**Primary recommendation:** 19 tickets (one PR each). Register the new config keys once, first. Serialize the four hot-file chains (`sentinel.cjs`: 04→08→12→19; hosts/finalizer: 06→16→17; `base-merge.cjs`: 06→13→17; `log-event.cjs`: 07→08→18→19). The coverage **recorder** (T-43-17) lands before the merge-gate **enforcer** (T-43-19). Every ticket carries REQ-175 with RED-first tests.

<user_constraints>
## User Constraints (from ADR-020 and INV-007 DECISIONS.md — no phase CONTEXT.md exists)

`.planning/phases/43-target-project-delivery-at-scale/` was empty when research started. The locked decisions below are copied verbatim from `.planning/architecture/ADR-020-target-project-delivery-at-scale.md:28-44`. The scope fences in `INV-007/DECISIONS.md` are binding.

### Locked Decisions
DATA_q7Lm2xZr_START
- Executor work is verified host-side: the trusted host, outside the agent sandbox, runs only the verification commands declared in the approved plan that match a project allow-list, as argument arrays with timeouts and bounded output, records the result as finalization evidence (or a sealed artifact referenced by digest), finalizes only on pass, and returns failures to a bounded executor or fixer round; the agent sandbox is not widened and the receipt shape does not change; Codex reuses the same host path.
- The merge gate refuses a head that the conveyor does not cover, for PRs opened after this phase is released: every commit since the ticket's base must be a verified executor or fixer receipt with trusted finalization, a journalled base-merge, or a declared remedy-workflow commit; any other commit refuses with the command that brings it under the conveyor; PRs opened earlier keep today's rule and are marked legacy in the journal; both runtimes' merge paths.
- A conform verdict carries across a base-merge when the ticket's own patch is identical (`git patch-id --stable`, or identical blobs for every `files_modified` path) and every other path equals the new base; any other difference re-owes arch-review; the carry posts the `merge-gate` commit status introduced by T-40-19.
- `human_checkpoint` takes `review` (a human approves the PR, then the guard merges into the epic) or `merge` (the human merges, also used for external-dependency holds); `true` keeps meaning `merge`, `preauthorized: true` keeps working, Gate 2 states the consequence of each value, and `pipeline-stats` keeps attributing guard merges separately.
- Target repositories may declare extra allowed comment markers as exact tokens in the project's `.planning/config.json`, keyed by `owner/repo` and read through `loadConfig`; a changed line whose pre-image was already a comment is not an addition; net-new free comments still block; the built-in markers and Shipyard defaults are unchanged.
- Pre-existing Jira issues are bound by key: decompose proposes the ticket-to-issue mapping, the human approves it with the ticket set at Gate 2, a recorded key is authoritative (lookup by key, never create, refuse an unknown key), and issues without the shipyard label are only transitioned and commented.
- Only operator-declared repository remedy workflows (per repository: failure signature, workflow, inputs) run before a human escalation, bounded by the attempt budget and journalled; a commit such a workflow pushes is a declared link of the merge gate's chain and still goes through arch-review and CI; nothing undeclared is discovered or run.
- One exported definition of the conveyor's scratch files is used by the role host, the finalizer, the Codex delivery host, base-merge and gc; any other untracked file still blocks the role host, whose status read no longer fails on large output; no `.gitignore` or `info/exclude` writes.
- A stale approval from a declared bot does not block a merge when the target branch requires no review or a human approval exists on the current head; a stale human approval still blocks; otherwise the guard re-requests the review once and escalates with the command; bot identities become configurable.
- A CANCELLED check superseded by a newer run is ignored and a lone cancelled latest run gets one journalled `gh run rerun` that is never green and does not count against `max_attempts`; on Claude one `ci-wait.cjs` call returns within 540 s unless `--timeout` is explicit, with the window budget accumulated across calls.
- `pipeline.gsd_sync` is honoured as a deprecated alias with the warning on the state-sync summary line, decompose writes its phase into ROADMAP in the shape gsd-sync reads, and plans of a phase absent from ROADMAP produce one summarised warning instead of a per-plan block.
- `publish-gate.cjs` resolves the base from the ticket's recorded base and then the repository's `origin/HEAD` before the `origin/main`/`main` fallback, the pre-push hook passes the ticket for ticket branches, and an unresolved base still refuses.
- Reachability checks ask bounded questions: `run-reachability.cjs` uses O(1)-output git forms with a large `maxBuffer`, and `sentinel.cjs` compares only declared paths through local git when the repository is checked out, with a path-scoped API fallback that still refuses a truncated listing.
- `deliver-dispatch.cjs` builds research, decomposition, arch-review, ci-fix and review-fix requests from the graph and the investigation directory, each round-tripping through the host's exported validator, with Codex parity or a named reason.
- `state-sync.cjs` lists PRs by ticket head and open state instead of `--state all --limit <pr_fetch_limit>`, and does not re-derive tickets whose merge into a landed epic is recorded immutably; `--full` re-derives everything.
- An arch-review finding of unknown type is kept as an informational note with its original type and never changes the verdict; a violation or an incomplete blocking finding still fails the artifact.
- Phase 43 is delivered as one wave after phases 40, 41 and 42 are released; every fix carries unit or fixture tests that fail on base, and the before/after measurements come from a later proving-ground rerun by the operator, outside the phase.
DATA_q7Lm2xZr_END

Binding scope fences from `INV-007/DECISIONS.md` (summarised; see the file):
- Host verification: commands are never taken from agent output. The receipt shape does not change. There is no sandbox widening. Codex reuses T-42-01's candidate seam.
- Merge gate: it reads existing receipts and adds no new receipt fields. Legacy PRs are journalled.
- Carry: it is built after T-40-19. The duplicated-block merge re-owes review. CI and the epic PR remain the interaction checks.
- Comment markers: they are anchored and length-bounded, read from trusted configuration and never from the ticket worktree.
- Jira: status transitions stay the phase-29 projection.
- Remedies: when nothing is declared, escalation names the candidate remedy.
- Stale bot approval: GitHub's own `BLOCKED` still refuses.
- ci-wait: the stop gate keeps the turn alive between calls.
- gsd_sync: `delivery_pipeline.*` precedence is unchanged. It is built after T-41-05 (merged) and T-40-17.

### Claude's Discretion (implementation details the ADR leaves to plans)
- Where the new configuration keys live, their names, and their shapes. They must stay within D-45: registered in `pipeline-config.cjs`, keyed by `owner/repo`, `delivery_pipeline.*` wins, and a bad shape warns and falls back.
- The storage format for coverage records, the rule for "opened after release", and the representation of `review`/`merge` in the graph.
- The ticket slicing and granularity. The orchestrator rule is standard granularity, one ticket per PR.

### Deferred / Out of Scope (from ADR-020 "Out of scope")
- Everything in phase 40 (including D-43..D-45) and in phase 41.
- The ADR-014 model/effort grid, the resolver input schema and the receipt shape.
- Widening any agent sandbox (network, docker, reads outside the worktree).
- Target-project code changes and the proving-ground rerun itself. No live or proving-ground ticket may be created.

**Noted tension:** DECISIONS.md says phase-43 tickets "depend only on each other" because phases 40, 41 and 42 will already be released. The orchestrator's hard rule requires a cross-phase `depends_on` edge for every pending ticket that shares a file. Both rules can be met: the edges are satisfied the moment those tickets are on `main`, and they stop Gate 2 from accepting an unordered overlap if phase-40 slips. The slicing below includes them.
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description (ROADMAP) | Research support → ticket |
|----|----|----|
| REQ-159 | Host-side verification of plan-declared, allow-listed commands; finalization evidence; both runtimes | T-42-01's producer and runner (42-01-PLAN.md:52-53); the Claude path through `claude-delivery-host.cjs:11,645-648` → **T-43-16** (plus the allow-list key in T-43-01 and the evidence digest in T-43-17) |
| REQ-160 | The merge gate refuses heads the conveyor does not cover; legacy PRs are journalled | `sentinel.cjs:891-1134` has no coverage check; the finalizer records nothing → **T-43-17** (recorder) and **T-43-19** (enforcer) |
| REQ-161 | Conform carry on an identical own patch | `gate-trailer.cjs:382-538` carry, called from `base-merge.cjs:205-226` → **T-43-13** |
| REQ-162 | `human_checkpoint` review/merge | `validate-graph.cjs:164`, `front.cjs:146-147`, `sentinel.cjs:905,911`, `pipeline-stats.cjs:171-232` → **T-43-12** |
| REQ-163 | Per-repo comment markers; comment edits are not additions | `comment-policy.cjs:9,240,382` → **T-43-03** (key in T-43-01) |
| REQ-164 | Jira bound by key | `jira-export.cjs:138-162,223,252` → **T-43-11** |
| REQ-165 | Declared remedy workflows | `escalation-record.cjs mark`, `log-event.cjs:293` → **T-43-18** (key in T-43-01) |
| REQ-166 | One exported scratch definition | `claude-role-host.cjs:144-145`, `delivery-commit-finalizer.cjs:8`, `codex-delivery-host.cjs:20`, `role-artifact.cjs:29-45` → **T-43-06** |
| REQ-167 | Stale bot approvals | `reviewers.cjs:105-110,142,154-178`, `sentinel.cjs:1052-1053` → **T-43-08** (key in T-43-01) |
| REQ-168 | CANCELLED rerun; 540 s ci-wait | `check-state.cjs:95-104`, `ci-wait.cjs:122-125,542-573` → **T-43-07** |
| REQ-169 | gsd_sync alias; ROADMAP shape; one summarised warning | `pipeline-config.cjs:927-933`, `gsd-sync-gate.cjs:38-39`, `gsd-sync.cjs:606-608`, `adr-bootstrap.cjs:82-116`, `state-sync.cjs:385-402,1192` → **T-43-10** |
| REQ-170 | publish-gate base resolution; hook passes the ticket | `publish-gate.cjs:24-40`, `shipyard-pre-push-gate.sh:62` → **T-43-02** |
| REQ-171 | Bounded reachability | `run-reachability.cjs:58-59,150`, `sentinel.cjs:202-229` → **T-43-04** |
| REQ-172 | deliver-dispatch builders for five roles | host validators listed in §Seams → **T-43-14** (arch-review, ci-fix, review-fix) and **T-43-15** (research, decomposition) |
| REQ-173 | Targeted state-sync listing and immutable-merge skip | `state-sync.cjs:459-490,537` → **T-43-09** |
| REQ-174 | Unknown arch-review finding type becomes an informational note | `role-artifact.cjs:1257-1276` → **T-43-05** |
| REQ-175 | Ships after phases 40, 41 and 42; RED-first tests; measurements come from the operator's rerun | Cross-cutting: list REQ-175 on **every** ticket. Each plan's RED step must fail on base. No live ticket (see §Live-only) |
</phase_requirements>

## Project Constraints (from CLAUDE.md and the orchestrator's hard rules)

- The Claude plugin under `plugins/delivery-pipeline/` is canonical. Codex skills are generated at install time by `scripts/gen-codex-shipyard.cjs`, and no generated Codex output is committed (only `.shipyard/generated/gsd-delivery-rules/` exists) [VERIFIED: `ls .shipyard/generated/`]. Prose changes therefore reach Codex automatically. Host changes need explicit parity.
- Deterministic scripts own decisions that can be computed. Every new rule gets a focused unit or fixture test.
- Shell scripts stay on `set -euo pipefail`.
- Preserve unrelated worktree changes.
- The ADR-014 boundary is resolve → validate → launch → receipt. No new launch authority, and no model or effort selection in builders.
- Tests are hermetic: `os.tmpdir()`, their own `GIT_CONFIG_GLOBAL`, `commit.gpgsign=false`. Each must be shown to fail on base.
- Verification commands are scoped to `files_modified`: `node --check`, single test files, single smokes, and `publish-gate.cjs`. Never `make test` or `make test-fast` inside a ticket.
- Comment policy on added lines. `comment-policy.cjs:9` allows only `@invariant:`, `@security:` and `@contract:` markers, 120 characters at most.
- `risk: high` ⇒ `human_checkpoint: true` (also enforced by `validate-graph.cjs:462-463`).
- Shipyard's own behaviour is unchanged under its defaults:
  - `prHygiene.applies` is false;
  - `.planning/` is tracked;
  - the base branch is `main`;
  - no new config keys are set.

## Architectural Responsibility Map

| Capability | Primary tier | Secondary | Rationale |
|---|---|---|---|
| Host-side verification (REQ-159) | Trusted host process (`claude-/codex-delivery-host`, `command-runner`) | Project config (allow-list) | Runs outside the agent sandbox; the evidence is host-produced |
| Commit coverage record (REQ-160 part 1) | Trusted finalizer (`delivery-commit-finalizer.cjs`), `base-merge.cjs`, remedy dispatcher | Host state directory (sealed files) | The finalizer is the single choke point where every executor and fixer commit is created on both runtimes |
| Merge refusal (REQ-160 part 2, 162, 167) | `sentinel.cjs mergeOne` (the one `gh pr merge`) | `reviewers.cjs`, `front.cjs` read models | The only merge call in the plugin is `sentinel.cjs:1125` |
| Verdict carry (REQ-161) | `gate-trailer.cjs carry`, invoked by `base-merge.cjs` | GitHub `merge-gate` status (T-40-19) | The carry is a deterministic writer and already exists |
| Config keys (163, 165, 167, 159) | `pipeline-config.cjs loadConfig` | `.planning/config.json` of the project root | D-45; the single policy reader |
| CI state vocabulary (168) | `check-state.cjs` | `ci-wait.cjs` (one deterministic rerun) | Shared by state-sync, sentinel and ci-wait through `CHECK_FIELDS` |
| Board and projection (169, 173) | `state-sync.cjs`, `gsd-sync.cjs`, `gsd-sync-gate.cjs` | GSD capability gates | State-sync is the delivery writer |
| Request building (172) | `deliver-dispatch.cjs` | Host validators (exported) | Builders only build and validate; hosts launch |
| Publish gate (163, 170) | `publish-gate.cjs` + `comment-policy.cjs` inside the pre-push hook bundle | Project config | Runs in a Claude hook, copied by the installer |
| Jira binding (164) | `jira-export.cjs plan` (pure data) | Decompose prose (Gate 2) and the model executing the steps | The export plan is data; the model performs the steps |

## Standard Stack

No new external packages. Everything is in-repo Node CommonJS on Node's standard library [VERIFIED: codebase — every script listed below requires only `node:*` and relative modules].

| Component (existing) | Purpose in phase 43 |
|---|---|
| `tests/unit/assert-harness.cjs` + `tests/unit/run.sh` | Test framework. `run.sh` auto-discovers `tests/unit/*.test.cjs` (lines 23-26), so new test files need no registration [VERIFIED: tests/unit/run.sh:23-26] |
| `run-bounded` (`runBounded`, used by `sentinel.cjs:142`) | Bounded child processes with timeout |
| `dispatch-boundary.cjs` durable envelope (HMAC-SHA256, `:208-252`) | The pattern for sealed host records. Reuse it rather than writing new crypto |
| T-42-01 `command-runner.cjs createVerificationRunner` (pending) | The host verification runner that T-43-16 builds on |
| `failure-signature.cjs` | Normalized failure signatures for remedy matching (REQ-165) |
| `path-owner.cjs owns/parse` | Ownership matching of `files_modified` against paths (carry, coverage, reachability) |

## Package Legitimacy Audit

Not applicable: phase 43 installs no external packages. **Packages removed:** none. **Packages flagged:** none.

## Current-Source Seams per Decision (read this session)

Line numbers are for revision `22ef429b`. **Phase 40 rewrites several of these files before phase 43 starts, so plans must anchor on function names and cite lines only as "at 22ef429b".**

### REQ-170 publish-gate base
- `publish-gate.cjs:24-32` [VERIFIED]. The candidate list is verbatim: `requested, process.env.COMMENT_POLICY_BASE, process.env.SHIPYARD_COMMENT_BASE, process.env.GITHUB_BASE_REF ? \`origin/${process.env.GITHUB_BASE_REF}\` : null, 'origin/main', 'main'`. `:39` throws `cannot resolve a base ref in ${worktree}`, and `:70` exits 2.
- `scripts/shipyard-pre-push-gate.sh:62` passes a literal: `[PUBLISH_GATE, "--worktree", toplevel, "--working-tree", "--ticket", "publish"]` [VERIFIED]. The hook never passes a real ticket id or a base.
- A recorded base exists: `state-sync.cjs:843-892` assigns `s.base` (the epic or the parent branch) [VERIFIED: grep + read].
- The hook bundle follows only literal relative requires: `install-shipyard-claude-hook.sh:143` `const localRequire = /require\(\s*['"](\.\.?\/[^'"]+)['"]\s*\)/g;` [VERIFIED]. Any new dependency of `publish-gate.cjs` must be `require('./x.cjs')`, never `require(path.join(__dirname, …))`, or the installed hook crashes.
- Tests: `tests/unit/pre-push-gate.test.cjs` (owner T-41-08, merged, so free) and a new `tests/unit/publish-gate.test.cjs`. Do **not** touch `tests/smoke/claude-hook-smoke.sh`, which T-40-05 and T-40-21 own.

### REQ-163 comment markers
- `comment-policy.cjs:8-9`: `const MAX_MARKER_LENGTH = 120;` and `const MARKER_PATTERN = /^@(invariant|security|contract)\s*:/i;`. `:382` has `allowed_markers: ['@invariant:', '@security:', '@contract:'],` [VERIFIED].
- `parseDiff` (`:213-244`) records only `+` lines; `:240` `if (raw[0] === '-') continue;`. `diffFor` (`:285-291`) uses `--unified=0`. The pre-image of a changed line is therefore available only by pairing it with the `-` lines of the same hunk and reading the base blob with `git show <base>:<path>`.
- The pdffiller token `@ai-generated model=<model>` has **no colon**, so a config token cannot be pushed through `MARKER_PATTERN`. It needs its own exact-token match: the token, then whitespace or the end of the line.
- Config access: `loadConfig(root)` (`pipeline-config.cjs:881`) needs the **project root**. The hook knows only the worktree, and for a foreign-repo worktree the project root is a different repository (see Open Questions Q3). With no config found, the built-in markers apply. That is the stricter result, so it fails closed.

### REQ-171 bounded reachability
- `run-reachability.cjs:58-59`: `function git(repo, args, …) { const result = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8' });`. There is no `maxBuffer`, so Node's default of 1 MiB applies [VERIFIED]. `:150` runs `git(repo, ['ls-tree', '-r', '--name-only', baseSha])`, a full recursive listing. `:186` (`rev-list --left-right --count`) and `:194` (`merge-base --is-ancestor`) are already O(1).
- `sentinel.cjs:202-216` `treeBlobs`: `gh api …/git/trees/${ref}?recursive=1`. `:210` refuses a truncated listing, and `epicReceived` (`:221-229`) reads both the head and the epic trees [VERIFIED]. The result is `{ok:null}` on error. It never refuses, because it runs after the squash.
- Tests: `tests/unit/run-reachability.test.cjs` (free) and `tests/unit/sentinel.test.cjs` (T-40-22).

### REQ-166 scratch set
Three different definitions exist today [VERIFIED]:
- `delivery-commit-finalizer.cjs:8`: `const SCRATCH = new Set(['.shipyard-pr-body.md', '.shipyard-evidence.md']);`
- `codex-delivery-host.cjs:20`: `const SCRATCH_STATUS = new Set(['?? .shipyard-pr-body.md', '?? .shipyard-evidence.md']);`
- `role-artifact.cjs:29-45` (the writer's names):
  - `MANIFEST_NAME = '.shipyard-role-artifact.json'`
  - `PR_BODY_NAME = '.shipyard-pr-body.md'`
  - `EVIDENCE_NAME = '.shipyard-evidence.md'`
  - `REPAIR_EVIDENCE_NAME = '.shipyard-repair-evidence.md'`
  - `DRIFT_EVIDENCE_NAME = '.shipyard-drift-evidence.md'`
  - `ARTIFACT_ARCHIVE_DIR = '.shipyard-role-artifacts'`
  - `'arch-review': '.shipyard-arch-review-evidence.md'`
  - `'pr-sentinel': '.shipyard-sentinel-evidence.md'`

Where each site checks the worktree:
- `claude-role-host.cjs:144-145`: `git(options, worktree, ['status', '--porcelain=v1', '--untracked-files=all'], 256 * 1024); if (status) reject('worktree has local changes before role dispatch');`. There is no scratch exemption, and `command()` (`:116-131`) turns a buffer overflow into `PREFLIGHT_FAILED`.
- `base-merge.cjs:141-167` and `ticket-worktree.sh:393-397` use `--untracked-files=no`. Their comments explicitly reject "exempting the two known filenames" as a list of names.

The ADR overrides that stance for the role host only. base-merge and gc should keep asking the tracked-only question but import the shared module, so there is exactly one definition. That module should export both the set and the helpers.

### REQ-174 unknown finding type
- `role-artifact.cjs:1257-1276`. Arch-review types handled: `violation` and `adr-outdated` (each with required fields), and `note`/`informational` (summary only). Anything else hits `fail('INCOMPLETE_FINDING', \`${role} finding ${index} has unsupported type ${JSON.stringify(rawType)}\`)` [VERIFIED]. The integrator branch starts at `:1277`. Change the arch-review branch only.

### REQ-167 stale bot approval
- `reviewers.cjs:105-110`: `const CODERABBIT = 'coderabbitai'; const COPILOT_BOT = 'copilot-pull-request-reviewer[bot]';`, with `isCodeRabbit` and `isCopilot` matched by login prefix. `:142` sets `bot: isCodeRabbit(...) || isCopilot(...)` [VERIFIED].
- `reviewFreshness` (`:154-178`) is fresh only if some current APPROVED row has `commit_id === headSha`. It ignores who the author is. It is not exported. The script is CLI-only, and `tests/unit/reviewers.test.cjs` drives it through a stub `gh` (`:147-164`).
- Re-request support exists: `reinit` posts to `…/requested_reviewers` (`:264`).
- `sentinel.cjs:1052-1053` blocks on `review_fresh === false`. `:1072` still blocks on `BLOCKED`.

### REQ-168 CANCELLED and ci-wait
- `check-state.cjs:48`: `const BUCKETS = new Set(['pass', 'fail', 'pending', 'skipping', 'cancel']);`. `:53` has `const CHECK_FIELDS = 'name,state,bucket';`. In `:100`, `case 'fail': case 'cancel': out.failing += 1; break;` [VERIFIED].
- `CHECK_FIELDS` has no run or time field, so "superseded by a newer run" cannot be decided with today's fields. The additional `gh pr checks --json` fields (for example `link`, `startedAt`, `workflow`) are [ASSUMED].
- `sentinel.cjs:1026-1027` tests `checks.failing` and `checks.pending` directly. If a lone cancel moves out of `failing`, it **must** count as `pending` (or the gate must add an explicit block), or the guard merges it.
- `ci-wait.cjs:122-125`: `TIMEOUT_S_EXPLICIT = argv.includes('--timeout'); let TIMEOUT_S = flag('--timeout', 15 * 60); … WINDOW_CEIL_S = 60 * 60`. Window sizing is at `:542-573`. The empty-window counter at `:502` counts **windows**, not seconds (`prev.empty_windows + 1`), so a 540 s window reaches the three-window park in a third of the time. The count must become elapsed-time based.
- Runtime detection exists in `runtime-context.cjs:94,213-214` (`CLAUDE_PLUGIN_ROOT` or `CLAUDE_CODE_ENTRYPOINT` means claude) [VERIFIED].

### REQ-169 gsd_sync, ROADMAP
- `pipeline-config.cjs:927-933`: when only `pipeline.gsd_sync` is set, `delete merged.gsd_sync; warnings.push('pipeline.gsd_sync is not supported — use delivery_pipeline.gsd_sync');` [VERIFIED].
- `capability.json:41-45` declares `delivery_pipeline.gsd_sync`. The gates at `:134,147,160,173` carry `"when": "delivery_pipeline.gsd_sync"`.
- `capabilities/delivery-pipeline/checks/gsd-sync-gate.cjs:38-39` passes only on `config.delivery_pipeline.gsd_sync === false`. An alias honoured only in `loadConfig` would leave GSD's gates running.
- `state-sync.cjs:385` skips the projection only on `cfg.gsd_sync === false`. At `:402`, `fail(\`gsd-sync finalization blocked: ${blockers}\`)` runs from `publishGsdProjection()`, which is called **before** the config warnings are printed at `:1192`. So the warning never reaches the operator when gsd-sync blocks.
- `gsd-sync.cjs:606-608` pushes one blocker **per plan**: `${plan.file}: phase ${plan.phase} is not declared in ROADMAP.md`. It parses headings with `:367` `/^###\s+Phase\s+(\d+)\s*:\s*(.+)$/gm`.
- `adr-bootstrap.cjs:37-50` writes `### Phase ${phase}: ${heading.title}`, which is the shape gsd-sync reads. But `:82-90 writeIfMissing` skips an existing ROADMAP (`:113-116`), so an existing ROADMAP never gains the new phase.

### REQ-173 state-sync listing
- `state-sync.cjs:459`: `gh(['pr', 'list', …, '--state', 'all', '--limit', String(cfg.pr_fetch_limit), '--json', PR_FIELDS])`. `:466-469` detect truncation and fall back to per-branch `prsForBranch` (`:537`, `--state all --head <branch> --limit 50`). `:473` runs an extra open-only review listing. `pipeline-config.cjs:537` has `pr_fetch_limit: 1000` [VERIFIED].
- T-40-03 adds `pr-ledger.cjs` (the PR number recorded at creation). T-43-09 must build on it.
- The file contains a NUL byte, so grep it with `grep -a` or read it with node (per INV-007).

### REQ-162 checkpoint semantics
- `validate-graph.cjs:164`: `human_checkpoint: delivery.human_checkpoint === true,`. `:171` has `preauthorized: delivery.preauthorized === true,`. `:462-463` require the checkpoint when risk is high, and `:469-473` allow preauthorized only together with a checkpoint [VERIFIED].
- `front.cjs:146-147`: `if (!t.human_checkpoint) return false; return t.preauthorized !== true;`.
- `sentinel.cjs:905` refuses `human_checkpoint ticket — the merge is the human's by contract`. `:911` records `preauthorized`. `:966-983` hold merges **into** an open checkpoint parent.
- `pipeline-stats.cjs:171,207,231-232` attribute checkpoint merges (`checkpoint_preauthorized_merge` and `checkpoint_unauthorized_merge`).
- Other boolean readers of `human_checkpoint`: `run-contract.cjs`, `run-controller.cjs`, `run-waker.cjs`, `claude-role-host.cjs` and `parent-moving.cjs` [VERIFIED: grep counts]. **Recommendation:** keep the graph field boolean (true for both review and merge) and add a separate `checkpoint` field (`'review'|'merge'|null`), so none of those readers changes meaning.
- Gate 2 prose is in `decompose.md:405-414,488-501` (T-40-25). The rules skill is `skills/delivery-rules/SKILL.md` plus the generated copy (T-40-20), at lines 53-54.

### REQ-164 Jira
- `jira-export.cjs:102-124` builds label JQL lookups. `:138-162 resolveLookup` returns `{ action: 'create' }` when nothing matches. `:223` and `:252` set `on_no_match: 'create'`, and `:244` sets `summary: \`${id}: ${t.title}\`` [VERIFIED].
- The recorded key is already in the graph: `upsertJiraKey` writes `delivery.jira` (`:285-326`), and `validate-graph.cjs:177` has `jira: delivery.jira != null ? String(delivery.jira) : null`. `planExport` never reads `t.jira`.
- The plan is data. The model executes it by following `decompose.md:585-606` (T-40-25). Refusal and transition-only behaviour must therefore be encoded in the step data (for example a key lookup with `on_no_match: 'refuse'` and a flag for unlabelled issues) **and** stated in that prose.

### REQ-161 carry
- `gate-trailer.cjs:10` `carry <ticket> --pr <n>`, with the implementation at `:382-538`. It refuses when the live head is not the judged head (`:473-538`). `base-merge.cjs:205-226 carryVerdict` calls it with `--from/--to` [VERIFIED].
- T-40-19 moves the verdict to a `merge-gate` commit status and keeps `carry` posting on the new head (`40-19-PLAN.md:49-52`) [VERIFIED].
- `git diff`/`git patch-id` accept tree-ish arguments, so the recorded base **tree** plus the judged head tree is enough to compute the old patch-id [ASSUMED from git semantics; confirm in RED].

### REQ-160 coverage
- There is no coverage check in `sentinel.mergeOne` (`:891-1108`). The merge is `gh pr merge --squash --match-head-commit` (`:1125-1126`), and the journal line is `{event:'merge', …, by:'sentinel'}` (`:1133-1134`) [VERIFIED].
- `delivery-commit-finalizer.cjs:108-228` signs with `commit-tree -S` and a subject of `(${ticket}): finalize scoped changes` (`:185`). It returns `{ticket, worktree, base, previousHead, commit, signer, changed}` (`:224`) and persists nothing. Both hosts call it: `claude-delivery-host.cjs:11,645-648,767` and `codex-delivery-host.cjs:129-135,231`.
- The pdffiller hand commits were also signed (`git commit -q -S`, per INV-007 risks.md), so **a signature is not proof of coverage**.
- `base_merge` is journalled by the model: `log-event.cjs:293` `base_merge: ['ticket', 'pr', 'base', 'head']`, and the prose is at `deliver.md:717-718`. A live journal entry shows `"note":"… 2 real conflicts … resolved by taking epic's newer …"` [VERIFIED: `.planning/graph/delivery-log.jsonl`]. A journalled base-merge can therefore contain hand-resolved content.
- There is only one merge path. `gh pr merge` appears in the plugin only at `sentinel.cjs:1125` [VERIFIED: grep], and Codex runs the same script through generated skills. "Both runtimes' merge paths" is satisfied by that one script. The recorder side, however, needs both hosts.

### REQ-159 host verification
- T-42-01 (pending) specifies `collectVerificationEvidence(prepared, verificationSpec)` in `codex-delivery-host.cjs` and `command-runner.cjs:createVerificationRunner`, "select[ing] a host-approved OS sandbox backend (macOS `sandbox-exec`, Linux `bwrap`) and refus[ing] when no supported backend … never fall back to bare `runBounded`", with network denied and HMAC-authenticated records [VERIFIED: 42-01-PLAN.md:52-53].
- The Claude delivery host has no verification step today. It finalizes through `finalizeDeliveryCommit` (`claude-delivery-host.cjs:11,767`).
- The plan's verification commands live in each PLAN's `## Verification commands` bullet list (for example `40-17-PLAN.md:95-102`).

### REQ-172 builders
Exported validators [VERIFIED: grep of `module.exports`]:
- `claude-role-host.cjs:1296-1303` exports `parseRequest` (arch-review). `ROLES = ['arch-review', 'integrator', 'pr-sentinel']` (`:29`).
- `codex-decompose-host.cjs:317-326` exports `requestValue`. Its `ROLES` maps `'gsd-phase-researcher'` → `{ role: 'research', sandbox: 'read-only' }` (`:18-19`).
- `codex-delivery-host.cjs:460-468` exports `requestValue`.
- `claude-delivery-host.cjs:18-19`: `WORKFLOWS = ['executors', 'fix-round', 'drift-gate', 'investigation-research']` and `REQUEST_SCHEMA = 'shipyard.claude-delivery-request.v1'`. `validateRequest` arrives with T-40-14.
- `claude-decompose-host.cjs:258` exports `canonicalRequest`.
- `deliver-dispatch.cjs` does not exist yet. T-40-15 creates it.

## Cross-Phase File Ownership (from `.planning/graph/tickets.json` and `delivery-state.json`, read this session)

Status: every T-40-xx and T-42-01 is `pending`; T-41-01..09 are `merged`. Only pending owners create `depends_on` edges.

| File | Pending owners (graph order) | Phase-43 tickets (in order) |
|---|---|---|
| `scripts/sentinel.cjs` | T-40-19 → T-40-22 | 04 → 08 → 12 → 19 |
| `tests/unit/sentinel.test.cjs` | T-40-22 | 04 → 08 → 12 → 19 |
| `tests/smoke/sentinel-smoke.sh` | T-40-19 | avoid (use sentinel.test.cjs) |
| `scripts/claude-role-host.cjs` + test | T-40-16 → T-40-22 | 06 |
| `scripts/state-sync.cjs` | T-40-03 → T-40-19 → T-40-27 | 09 → 10 |
| `scripts/gate-trailer.cjs`, `tests/unit/trailer.test.cjs` | T-40-19 | 13 |
| `scripts/role-artifact.cjs` + test | T-40-18 | 05 → 06 |
| `scripts/pipeline-config.cjs` + test | T-40-17 | 01 → 10 |
| `scripts/deliver-dispatch.cjs` + test | T-40-15 | 14 → 15 |
| `scripts/claude-delivery-host.cjs` | T-40-10, T-40-13, T-40-14, T-40-28 | 16 → 17 |
| `tests/unit/claude-delivery-host.test.cjs` | T-40-01, T-40-13, T-40-14, T-40-28 | 16 → 17 |
| `scripts/codex-delivery-host.cjs` | T-42-01, T-40-12, T-40-14, T-40-28 | 06 → 16 → 17 |
| `tests/unit/codex-delivery-host.test.cjs` | T-42-01, T-40-01, T-40-12, T-40-14, T-40-28, **T-40-09 (last)** | 06 → 16 → 17 |
| `scripts/delivery-commit-finalizer.cjs` | T-42-01 → T-40-18 → T-40-27 | 06 → 17 |
| `tests/unit/delivery-commit-finalizer.test.cjs` | T-42-01, T-40-18 | 06 → 17 |
| `scripts/command-runner.cjs` + test | T-42-01 | 16 |
| `scripts/ticket-worktree.sh` | T-40-27 | 06 |
| `scripts/validate-graph.cjs`, `tests/smoke/graph-validator-smoke.sh`, `skills/delivery-rules/SKILL.md`, `.shipyard/generated/gsd-delivery-rules/SKILL.md` | T-40-20 | 12 |
| `scripts/pipeline-stats.cjs` | T-40-03 | 12 |
| `commands/deliver.md` | T-40-24 | 14 (only; 16 and 19 avoid it) |
| `commands/decompose.md` | T-40-25 | 11 → 12 → 15 |
| `commands/investigate.md` | T-40-25 | 15 |
| `workflows/executors.mjs`, `fix-round.mjs` | T-40-28 | avoid unless 16 needs them (then add T-40-28, already a dependency) |
| Free (no pending owner) | — | `publish-gate.cjs`, `shipyard-pre-push-gate.sh`, `pre-push-gate.test.cjs`, `comment-policy.cjs` + test, `run-reachability.cjs` + test, `reviewers.cjs` + test, `check-state.cjs` + test, `ci-wait.cjs` + test, `front.cjs` + test, `jira-export.cjs` + test, `gsd-sync.cjs` + tests, `capabilities/…/gsd-sync-gate.cjs`, `adr-bootstrap.cjs` + test, `base-merge.cjs`, `escalation-record.cjs` + test, `log-event.cjs`, `references/*.md`, new modules |

Phase-43 internal chains on free files: `publish-gate.cjs` 02 → 03; `base-merge.cjs` 06 → 13 → 17; `log-event.cjs` 07 → 08 → 18 → 19; `conveyor-coverage.cjs` (new) 17 → 18 → 19; `references/pr-sentinel.md` 18 → 19.

## Proposed Ticket Slicing (one PR each)

Every ticket lists REQ-175 in addition to the requirements shown. "Verify" commands are scoped. Every ticket also runs `node plugins/delivery-pipeline/scripts/publish-gate.cjs --base origin/main --working-tree --json` (the comment-policy gate) and `node --check` on each modified `.cjs`, or `bash -n` on each `.sh`.

| ID | Title | REQ | files_modified | depends_on | risk / HC | Verify (besides node --check and publish-gate) |
|---|---|---|---|---|---|---|
| T-43-01 | Register per-repository config keys for comment markers, reviewer bots, remedy workflows and verification allow-list | 163, 165, 167, 159 | `pipeline-config.cjs`, `tests/unit/pipeline-config.test.cjs` | T-40-17 | medium | `node tests/unit/pipeline-config.test.cjs` |
| T-43-02 | Resolve the publish-gate base from the recorded base and origin/HEAD; hook passes the ticket | 170 | `publish-gate.cjs`, `scripts/shipyard-pre-push-gate.sh`, `tests/unit/publish-gate.test.cjs` (new), `tests/unit/pre-push-gate.test.cjs` | — | medium | `node tests/unit/publish-gate.test.cjs`; `node tests/unit/pre-push-gate.test.cjs`; `bash -n scripts/shipyard-pre-push-gate.sh` |
| T-43-03 | Allow configured per-repository comment markers; edits of existing comments are not additions | 163 | `comment-policy.cjs`, `publish-gate.cjs`, `tests/unit/comment-policy.test.cjs`, `tests/unit/publish-gate.test.cjs` | T-43-01, T-43-02 | medium | `node tests/unit/comment-policy.test.cjs`; `node tests/unit/publish-gate.test.cjs` |
| T-43-04 | Bounded reachability: O(1) git forms, large buffer, declared-path epic check with a path-scoped fallback | 171 | `run-reachability.cjs`, `tests/unit/run-reachability.test.cjs`, `sentinel.cjs`, `tests/unit/sentinel.test.cjs` | T-40-19, T-40-22 | medium | `node tests/unit/run-reachability.test.cjs`; `node tests/unit/sentinel.test.cjs` |
| T-43-05 | Keep an unknown arch-review finding type as an informational note | 174 | `role-artifact.cjs`, `tests/unit/role-artifact.test.cjs` | T-40-18 | medium | `node tests/unit/role-artifact.test.cjs` |
| T-43-06 | One exported conveyor scratch set for role host, finalizer, Codex host, base-merge and gc | 166 | `conveyor-scratch.cjs` (new), `tests/unit/conveyor-scratch.test.cjs` (new), `claude-role-host.cjs`, `tests/unit/claude-role-host.test.cjs`, `delivery-commit-finalizer.cjs`, `tests/unit/delivery-commit-finalizer.test.cjs`, `codex-delivery-host.cjs`, `tests/unit/codex-delivery-host.test.cjs`, `base-merge.cjs`, `ticket-worktree.sh`, `role-artifact.cjs` | T-43-05, T-40-16, T-40-22, T-42-01, T-40-18, T-40-27, T-40-12, T-40-14, T-40-28, T-40-01, T-40-09 | **high / true** (role host is the judge's input boundary) | `node tests/unit/conveyor-scratch.test.cjs`; `node tests/unit/claude-role-host.test.cjs`; `node tests/unit/delivery-commit-finalizer.test.cjs`; `node tests/unit/codex-delivery-host.test.cjs`; `bash tests/smoke/worktree-gates-smoke.sh` (base-merge regression, read-only) |
| T-43-07 | Cancelled checks: ignore superseded, one journalled rerun, never green; ci-wait ≤540 s on Claude with a time budget | 168 | `check-state.cjs`, `tests/unit/check-state.test.cjs`, `ci-wait.cjs`, `tests/unit/ci-wait.test.cjs`, `log-event.cjs` | — | **high / true** (green semantics feed the merge gate) | `node tests/unit/check-state.test.cjs`; `node tests/unit/ci-wait.test.cjs`; `node tests/unit/stop-gate.test.cjs` (read-only guard) |
| T-43-08 | A stale approval from a declared bot does not block; re-request once, then escalate with the command | 167 | `reviewers.cjs`, `tests/unit/reviewers.test.cjs`, `sentinel.cjs`, `tests/unit/sentinel.test.cjs`, `log-event.cjs` | T-43-01, T-43-04, T-43-07, T-40-19, T-40-22 | **high / true** (relaxes the merge gate) | `node tests/unit/reviewers.test.cjs`; `node tests/unit/sentinel.test.cjs` |
| T-43-09 | state-sync lists PRs by ticket head and open state; skip immutably landed tickets; `--full` | 173 | `state-sync.cjs`, `tests/unit/state-sync-listing.test.cjs` (new) | T-40-03, T-40-19, T-40-27 | medium | `node tests/unit/state-sync-listing.test.cjs`; `node tests/unit/state-sync-yaml.test.cjs` (read-only guard) |
| T-43-10 | Honour `pipeline.gsd_sync` as a deprecated alias on the summary line; decompose phase in ROADMAP; one summarised warning | 169 | `pipeline-config.cjs`, `tests/unit/pipeline-config.test.cjs`, `capabilities/delivery-pipeline/checks/gsd-sync-gate.cjs`, `tests/unit/gsd-sync-gate.test.cjs`, `gsd-sync.cjs`, `tests/unit/gsd-sync.test.cjs`, `state-sync.cjs`, `adr-bootstrap.cjs`, `tests/unit/adr-bootstrap.test.cjs` | T-43-01, T-43-09, T-40-17, T-40-03, T-40-19, T-40-27 | medium | the four named test files; `node plugins/delivery-pipeline/scripts/gsd-sync.cjs --check --json` |
| T-43-11 | Bind pre-existing Jira issues by recorded key; refuse unknown; unlabelled issues are transition- and comment-only | 164 | `jira-export.cjs`, `tests/unit/jira-export.test.cjs`, `commands/decompose.md`, `tests/unit/jira-binding-contract.test.cjs` (new) | T-40-25 | medium | `node tests/unit/jira-export.test.cjs`; `node tests/unit/jira-binding-contract.test.cjs`; `bash tests/smoke/docs-smoke.sh` |
| T-43-12 | `human_checkpoint: review\|merge`; `true` = merge; Gate 2 states the consequence; stats keep attribution | 162 | `validate-graph.cjs`, `tests/smoke/graph-validator-smoke.sh`, `front.cjs`, `tests/unit/front.test.cjs`, `sentinel.cjs`, `tests/unit/sentinel.test.cjs`, `pipeline-stats.cjs`, `tests/unit/pipeline-stats.test.cjs`, `commands/decompose.md`, `skills/delivery-rules/SKILL.md`, `.shipyard/generated/gsd-delivery-rules/SKILL.md` | T-43-08, T-43-11, T-40-19, T-40-22, T-40-20, T-40-03, T-40-25 | **high / true** | `bash tests/smoke/graph-validator-smoke.sh`; `node tests/unit/front.test.cjs`; `node tests/unit/sentinel.test.cjs`; `node tests/unit/pipeline-stats.test.cjs`; `node tests/unit/stop-gate.test.cjs` (read-only) |
| T-43-13 | Carry a conform verdict across a base-merge when the own patch is identical and everything else equals the new base | 161 | `gate-trailer.cjs`, `tests/unit/trailer.test.cjs`, `base-merge.cjs`, `tests/unit/verdict-carry.test.cjs` (new) | T-43-06, T-40-19 | **high / true** (verdict reuse) | `node tests/unit/trailer.test.cjs`; `node tests/unit/verdict-carry.test.cjs`; `bash tests/smoke/worktree-gates-smoke.sh` |
| T-43-14 | deliver-dispatch builds arch-review, ci-fix and review-fix requests through the host validators | 172 | `deliver-dispatch.cjs`, `tests/unit/deliver-dispatch.test.cjs`, `commands/deliver.md`, `tests/unit/deliver-builders-contract.test.cjs` (new) | T-40-15, T-40-24 | medium | `node tests/unit/deliver-dispatch.test.cjs`; `node tests/unit/deliver-builders-contract.test.cjs`; `bash tests/smoke/docs-smoke.sh` |
| T-43-15 | deliver-dispatch builds research and decomposition requests from the investigation directory | 172 | `deliver-dispatch.cjs`, `tests/unit/deliver-dispatch.test.cjs`, `commands/investigate.md`, `commands/decompose.md`, `tests/unit/planning-builders-contract.test.cjs` (new) | T-43-14, T-43-12, T-40-15, T-40-25 | medium | same pattern as T-43-14 |
| T-43-16 | Host-side verification of plan-declared, allow-listed commands on both runtimes | 159 | `host-verification.cjs` (new, extracted from T-42-01's producer), `tests/unit/host-verification.test.cjs` (new), `claude-delivery-host.cjs`, `tests/unit/claude-delivery-host.test.cjs`, `codex-delivery-host.cjs`, `tests/unit/codex-delivery-host.test.cjs`, `command-runner.cjs`, `tests/unit/command-runner.test.cjs` | T-43-01, T-43-06, T-42-01, T-40-10, T-40-13, T-40-14, T-40-28, T-40-12, T-40-01, T-40-09 | **high / true** | the four test files |
| T-43-17 | Record a sealed coverage entry for every trusted finalization and mechanical base-merge | 160, 159 | `conveyor-coverage.cjs` (new), `tests/unit/conveyor-coverage.test.cjs` (new), `delivery-commit-finalizer.cjs`, `tests/unit/delivery-commit-finalizer.test.cjs`, `base-merge.cjs`, `claude-delivery-host.cjs`, `tests/unit/claude-delivery-host.test.cjs`, `codex-delivery-host.cjs`, `tests/unit/codex-delivery-host.test.cjs` | T-43-06, T-43-13, T-43-16, T-42-01, T-40-18, T-40-27, T-40-28, T-40-09 (and the host owners already listed on T-43-16) | **high / true** | the four test files; `bash tests/smoke/worktree-gates-smoke.sh` |
| T-43-18 | Run only declared repository remedy workflows before escalation; record their commits as chain links | 165 | `repo-remedy.cjs` (new), `tests/unit/repo-remedy.test.cjs` (new), `escalation-record.cjs`, `tests/unit/escalation-record.test.cjs`, `log-event.cjs`, `conveyor-coverage.cjs`, `tests/unit/conveyor-coverage.test.cjs`, `references/ci-fix.md`, `references/pr-sentinel.md` | T-43-01, T-43-08, T-43-17 | **high / true** (outward mutation) | `node tests/unit/repo-remedy.test.cjs`; `node tests/unit/escalation-record.test.cjs`; `node tests/unit/conveyor-coverage.test.cjs`; `bash tests/smoke/docs-smoke.sh` |
| T-43-19 | Merge gate refuses heads not covered by the conveyor; pre-release PRs are journalled as legacy | 160 | `sentinel.cjs`, `tests/unit/sentinel.test.cjs`, `conveyor-coverage.cjs`, `tests/unit/conveyor-coverage.test.cjs`, `log-event.cjs`, `references/pr-sentinel.md` | T-43-12, T-43-17, T-43-18, T-40-19, T-40-22 | **high / true** | `node tests/unit/sentinel.test.cjs`; `node tests/unit/conveyor-coverage.test.cjs`; `bash tests/smoke/docs-smoke.sh` |

Dependency sanity (every overlapping pair ordered):
- `sentinel.cjs`: 04 → 08 → 12 → 19.
- `pipeline-config.cjs`: 01 → 10.
- `state-sync.cjs`: 09 → 10.
- `publish-gate.cjs`: 02 → 03.
- `role-artifact.cjs`: 05 → 06.
- `codex-delivery-host.cjs` and its test: 06 → 16 → 17.
- `claude-delivery-host.cjs` and its test: 16 → 17.
- `delivery-commit-finalizer.cjs` and its test: 06 → 17.
- `base-merge.cjs`: 06 → 13 → 17.
- `log-event.cjs`: 07 → 08 → 18 → 19.
- `conveyor-coverage.cjs` and its test: 17 → 18 → 19.
- `deliver-dispatch.cjs` and its test: 14 → 15.
- `decompose.md`: 11 → 12 → 15.
- `references/pr-sentinel.md`: 18 → 19.

Critical paths are 06 → 13 → 17 → 18 → 19 and 04 → 08 → 12 → 19. Tickets 01, 02, 05, 07, 09 and 11 can start as soon as their phase-40 owners are on `main`.

### Per-ticket design notes the planner needs

- **T-43-01 (config).** Register four keys, each as a string/array or an object keyed by `owner/repo` (with `default`), shape-validated with warn-and-fallback. The names below are [ASSUMED] and are the planner's choice:
  - `comment_markers`
  - `reviewer_bots`
  - `repo_remedies`: `{owner/repo: [{signature, workflow, inputs, ref?}]}`
  - `verification_commands`: an allow-list of argv prefixes per repository

  Export one helper that resolves a per-repository value, so consumers do not each re-parse the map. GSD's capability vocabulary is `boolean|string|number|enum` (`capability.json:74`, jira_transitions description) [VERIFIED]. Object keys therefore stay out of `capability.json`, exactly as T-40-17 does for `pr_title_format`. Shipyard proof: no keys set means the defaults, and there are no unknown-key warnings.
- **T-43-02.** Order: `--base`, then the env vars, then `delivery-state[ticket].base`, then `refs/remotes/origin/HEAD`, then `origin/main`, then `main`. When nothing resolves, keep exiting 2. Print the chosen source in `--json`. The ticket id comes from `ticket/T-NN-NN-…` branches. For hygiene-named branches (`feat/…`, T-40-20), look up the branch in delivery-state when the project graph can be found; otherwise fall back to `origin/HEAD` (Q3). Fixtures: a bare origin whose default is `master`, one whose default is `develop`, and a Shipyard-shaped fixture that still resolves `origin/main`. Never add literal `master` or `develop` candidates.
- **T-43-03.** Exact-token match: the configured token, followed by whitespace or the end of the comment body, within `MAX_MARKER_LENGTH`. Reject config tokens that contain regex metacharacters or whitespace (warn and ignore). Pre-image rule: pair the removed and added lines positionally inside each `--unified=0` hunk, and exempt an added line only when its paired pre-image line scans as a comment in the base blob. Scan the whole base file so block-comment state is right. Print the effective markers in `policy.allowed_markers`.
- **T-43-04.**
  - `run-reachability`: replace `declaredFiles`' full `ls-tree -r` with `ls-tree -r <base> -- <declared literal paths and glob prefixes>`, and set `maxBuffer` to 64 MiB or more on `git()`.
  - `sentinel`: compute the blobs of declared paths with local `git ls-tree` on the checked-out repository, via ROOT or the `repo-resolve` checkout, after a fetch. Glob declarations list their static prefix directory.
  - Fallback: path-scoped `gh api …/contents/<path>?ref=` or a non-recursive tree per directory. Any `truncated` result stays `{ok:null}` with a reason. An absent path must read as absent, never as "not asserted".
  - Add an agreement test between the scoped answer and the full listing, including a glob declaration.
- **T-43-05.** For an unknown type, keep `{type:'informational', original_type:<raw>, summary}` only when the finding has summary text; otherwise fail as today. The verdict field is validated separately and is never changed. Tests:
  - `violation` verdict plus an unknown finding: the artifact is accepted and the verdict stays `violation`;
  - a `violation` finding missing `file`: still `INCOMPLETE_FINDING`;
  - integrator findings: unchanged;
  - the sealed envelope schema `shipyard.role-artifact.v1`: unchanged.
- **T-43-06.** `conveyor-scratch.cjs` exports:
  - `SCRATCH_FILES`: the exact names from `role-artifact.cjs:29-45`;
  - `SCRATCH_DIRS`: `.shipyard-role-artifacts`;
  - `isScratch(path)`;
  - `statusIgnoringScratch(worktree)`: runs `git status --porcelain=v1 -z --untracked-files=all` with a bounded but large buffer, and returns a named refusal on overflow.

  `role-artifact.cjs` imports the names instead of defining them. Recommend an **exact set, not a `.shipyard-` prefix**. INV-007 risks.md R-F5-1 suggested a prefix, but a prefix lets an agent-written `.shipyard-x.js` reach the judge, while the ADR says "any other untracked file still blocks". base-merge and gc keep `-uno` (the tracked-work question) and import the helper, which makes the shared module their single definition. There are no `.gitignore` or `info/exclude` writes. Codex parity: `codex-delivery-host.cjs:205,227` filter through the shared set.
- **T-43-07.** `check-state.classify`:
  - a cancel that has a newer run of the same check name on the same head: ignored (the check is decided by the newer run);
  - a lone latest cancel: counted in **`pending`** plus a new `cancelled` tally, so `sentinel.cjs:1026-1027` still refuses and `isGreen` stays false.

  `ci-wait` performs the single `gh run rerun <run-id>` for a lone cancel. The run id comes from the check's link, which is [ASSUMED]. It journals a new `ci_rerun` event (`log-event.cjs` required-fields map, `:293` pattern). That event kind is not in the repair events of `attempt-history.cjs` (`:137` `REPAIR_EVENTS`), so it does not charge `max_attempts`. A second lone cancel after the rerun falls back to today's failing path.

  Window: on Claude, `min(window, 540)` unless `--timeout` is explicit. Store accumulated seconds in the existing wait record, and park on accumulated time, not on window count.
- **T-43-08.** `reviewFreshness` gains author awareness: a declared bot comes from `reviewer_bots`, defaulting to today's CodeRabbit and Copilot login rules. A stale approval whose author is a declared bot is ignored when either a human APPROVED review has `commit_id === head`, or the target branch provably requires no review. "Provably" means the branch-rules query (`repos/{o}/{r}/rules/branches/<b>`) answers `[]` **and** classic protection answers 404. Any error or 403 counts as "may require", which fails closed [ASSUMED endpoint semantics]. Otherwise the result names `reviewers.cjs reinit <pr> --force` as the remedy. The guard re-requests once (journalled `review_rerequest`) and escalates on the next refusal.
- **T-43-09.** Per repository: one `gh pr list --state open` pass, plus per-ticket lookups by the PR number from T-40-03's ledger (or `--head <branch>`) for tickets that are neither open nor immutably landed. "Immutably landed" means a ledger entry, a merge SHA, **and** an epic whose PR has merged into the integration branch. `--full` restores the full re-derivation. The test uses a stub `gh` that counts calls.
- **T-43-10.**
  - `loadConfig`: honour `pipeline.gsd_sync` when `delivery_pipeline.gsd_sync` is absent, and warn `pipeline.gsd_sync is deprecated — …`.
  - `gsd-sync-gate.cjs:38`: apply the same alias rule.
  - `state-sync`: print config warnings on the summary line, and before `publishGsdProjection()` can `fail`.
  - `gsd-sync.checkSource`: collapse "phase N is not declared" into one warning per phase (a warning, not a blocker).
  - `adr-bootstrap`: append the phase block to an existing ROADMAP when that phase heading is absent, in the `### Phase N: title` shape.
  - Keep `decompose.md` out of this ticket; the adr-bootstrap call at `decompose.md:70` already exists.
- **T-43-11.** `planExport`: when `t.jira` is set, emit `lookup: [{kind:'key', key, on_match:'update-if-labelled'}]` and `on_no_match: 'refuse'`, and never create. The step carries an explicit rule for unlabelled issues: transition and comment only, never rewrite the summary or description. Decompose prose: propose the mapping from the investigation's Jira input, write `delivery.jira` via `jira-export.cjs record`, and have Gate 2 show the mapping for approval.
- **T-43-12.** In `validate-graph`, accept `true|false|'review'|'merge'`, normalize `true` to `merge`, keep the boolean `human_checkpoint`, and add `checkpoint: 'review'|'merge'|null`. For `risk: high`, either value is allowed.
  - `front.needsHuman`: `merge` → true unless preauthorized; `review` → true until the board shows APPROVED. The sentinel re-verifies live.
  - `sentinel.mergeOne`: `review` requires a human (non-bot) approval on the exact head, using the reviewers output from T-43-08, and then merges with a journal line `{checkpoint:'review'}`.
  - `pipeline-stats`: attributes `review` guard merges separately.
  - The merge-into-open-checkpoint-parent hold (`:966-983`): unchanged for `merge`. For `review` it is the planner's call, flagged in Q6.
- **T-43-13.** New proof in `carry`, used when head trees differ:
  - `patch-id --stable` of `diff <judgedBaseTree> <judgedHeadTree>` equals that of `diff <newBase> <newHead>`, **and**
  - `diff --name-only <newBase> <newHead>` touches only paths owned by `files_modified`, **and**
  - for every owned path, the blob in `newHead` equals the judged blob.

  Post the carried `merge-gate` status (T-40-19). Mandatory negative fixture: a merge that duplicates a block, or a sibling that deletes a function the ticket calls, must re-owe the review when its own patch changes.
- **T-43-14 and T-43-15.** Builders read the graph row and the investigation directory, set only allow-listed signals, and never copy `type` (T-40-15 Pitfall 1). Each builder is tested by round-tripping through the **real** exported validator, never a hand-written shape.
  - Claude: arch-review → `claude-role-host.parseRequest`; ci-fix and review-fix → `claude-delivery-host` `validateRequest` (fix-round); research → the `investigation-research` workflow request; decomposition → `claude-decompose-host.canonicalRequest`.
  - Codex: `codex-delivery-host.requestValue` (arch-review, ci-fix, review-fix) and `codex-decompose-host.requestValue` (research, decomposition).
  - Name a reason for any role without a Codex host path. Codex has no role host for pr-sentinel or integrator, per INV-007 constraints K2.
- **T-43-16.** Move T-42-01's `collectVerificationEvidence` into `host-verification.cjs`. Both hosts call it after a verified executor completion and before finalization. The command set is the intersection of the pinned plan `## Verification commands` and the `verification_commands` allow-list for the repository, matched as argv arrays (no shell). On failure, the host returns a structured result that routes to the existing bounded fixer round; it never finalizes. The evidence digest travels as finalization evidence or a sealed artifact; the receipt stays untouched. **Blocking decision:** the sandbox profile for allow-listed commands (Q1).
- **T-43-17.** `conveyor-coverage.cjs` writes a sealed record for each conveyor commit. Record contents:
  - `{schema, commit, parents, tree, ticket, repo, kind: 'executor'|'fixer'|'base-merge'|'remedy'}`;
  - `{dispatch_id, receipt_digest, verification_digest}` for executor and fixer commits;
  - `recorded_at`.

  Sealing reuses the durable-envelope/HMAC pattern (`dispatch-boundary.cjs:208-252`) with a host-owned key outside the worktree.
  - The finalizer writes a record only after `update-ref` succeeds.
  - `base-merge.cjs` writes one only for a merge it committed mechanically (`result: 'resolved mechanically'`, `base-merge.cjs:298-299`, or already clean). A merge with conflicts that were resolved by hand is **not** recorded, so it must go back through the conveyor.
  - The recorder also writes a one-time rollout marker, which T-43-19 uses to decide "opened after release" (Q4).
- **T-43-18.** `repo-remedy.cjs match|run`:
  - matching uses the normalized failure signature (`failure-signature.cjs`) against the declared entries;
  - `run` executes `gh workflow run <workflow> --ref <branch> -f k=v…` as an argv array, bounded by the attempt budget, and journals `remedy_dispatch`;
  - `escalation-record.cjs mark` refuses while a matching declared remedy has budget left, and prints the `repo-remedy.cjs run …` command;
  - a commit the workflow pushes is recorded as `kind: 'remedy'` only when its parent was the head at dispatch, its author is the declared workflow bot, and the run id matches [ASSUMED attribution rule; Q5].
- **T-43-19.** In `mergeOne`, after the gate verdict and before the checks, walk `git rev-list <ticket base>..<head>` (local, bounded). Every commit needs a verified coverage record. The first uncovered commit refuses with the remedy: re-run the executor or fixer through `deliver-dispatch`, or back out the hand commit, then re-verify. A PR created before the rollout marker is merged under today's rule and journalled `merge_gate_legacy` once. Codex parity is automatic: this is the single merge path (`sentinel.cjs:1125`).

## Architecture Patterns

```
 plan (Gate 2, human) ──► deliver-dispatch (T-43-14/15) ──validate──► host (Claude | Codex)
                                                                        │ launch agent (sandbox unchanged)
                                                                        ▼
                                          host-verification (T-43-16): plan cmds ∩ allow-list → runner
                                                   │ fail → bounded fixer round      │ pass
                                                   ▼                                  ▼
                                   delivery-commit-finalizer ──► conveyor-coverage record (T-43-17)
                                                                        ▲            ▲
                          base-merge.cjs (mechanical only) ─────────────┘            │
                          repo-remedy.cjs (declared workflows, T-43-18) ─────────────┘
 GitHub PR ─► state-sync (T-43-09/10) ─► front ─► sentinel duty ─► mergeOne:
      gate status (T-40-19, carry T-43-13) → coverage chain (T-43-19) → checks (T-43-07)
      → reviewers freshness (T-43-08) → checkpoint mode (T-43-12) → BLOCKED/BEHIND → gh pr merge --squash
```

- **Pattern: one definition, many readers.** The scratch set (T-43-06), per-repository config resolution (T-43-01) and the CI vocabulary (`check-state.cjs`) each live in one module.
- **Pattern: relax only on positive evidence** (K4). Every relaxation is decided by a recorded fact:
  - carry: object identities;
  - stale bot: a human approval on the head, or a provable absence of rules;
  - cancel: a newer run exists;
  - unknown finding: the verdict is unchanged.
- **Pattern: recorder before enforcer.** T-43-17 records for a release before T-43-19 enforces, so enforcement never meets a PR with no records unless that PR is legacy.
- **Anti-pattern:** reading `.planning/config.json` or the graph from the ticket worktree (D-43, K5). Always use the project root.
- **Anti-pattern:** `require(path.join(__dirname, …))` in anything the pre-push hook bundles (`install-shipyard-claude-hook.sh:143`).

## Don't Hand-Roll

| Problem | Don't build | Use instead | Why |
|---|---|---|---|
| Sealed host records | New HMAC or file format | `dispatch-boundary.cjs` durable envelope pattern; T-42-01's host key store | Atomic create, `timingSafeEqual`, and key-mode checks already exist |
| Verification runner | A second process runner | T-42-01 `createVerificationRunner` / `runBounded` | Timeouts, bounded output, OS sandbox backend |
| Path ownership | Glob matching | `path-owner.cjs owns/parse` | Gate 2, the scope gate and the finalizer share it |
| Failure signature | Regex on logs | `failure-signature.cjs` | Normalization shared with ci-fix history |
| Title/format templates | — | not needed | — |
| Config shape validation | Per-consumer parsing | One `pipeline-config.cjs` helper (T-43-01) | D-45 warn-and-fallback in one place |
| Patch identity | Diff text comparison | `git patch-id --stable` | Stable against line offsets; ADR-named |

## Runtime State Inventory (partial: the phase changes stored-state semantics)

| Category | Items found | Action |
|---|---|---|
| Stored data | Existing plan frontmatter with `human_checkpoint: true` and `preauthorized: true`; delivery-log `base_merge` lines with hand resolutions; open PRs whose commits have no coverage records | `true` keeps meaning `merge` (code only). Existing PRs are handled by the legacy rule (T-43-19). No data migration |
| Live service config | GitHub `merge-gate` statuses (T-40-19); target-repo branch rules (read only) | None written by phase 43 except carried statuses |
| OS-registered state | The installed pre-push hook bundle is copied into `~/.claude/hooks/shipyard-stop-gate/` | The operator must reinstall (`make install-shipyard-claude-hook`) for T-43-02/03 to take effect. Note it in the release, not in a ticket |
| Secrets/env vars | A host HMAC key for coverage records (new file under host state) | Created on first use with mode 0600, as `dispatch-boundary.cjs:212-227` does |
| Build artifacts | Generated Codex bundle (installed, not committed) | `make install-shipyard-codex` after release; nothing to commit |

## Common Pitfalls

1. **`review` silently becomes `false`.** `validate-graph.cjs:164` uses `=== true`. Change validation in T-43-12 before any plan or prose tells authors to write `review`.
2. **A cancel that is neither failing nor pending gets merged.** `sentinel.cjs:1026-1027`. Keep a lone cancel inside `pending`.
3. **A shorter ci-wait window escalates slow CI early.** The empty-window count at `ci-wait.cjs:502` must become an accumulated-seconds budget.
4. **The gsd_sync alias is only half applied.** Change `gsd-sync-gate.cjs:38` too. Otherwise GSD lifecycle gates still block while state-sync skips.
5. **The warning never prints.** `state-sync` `fail`s inside `publishGsdProjection()` (`:402`) before `:1192`.
6. **Hook bundle misses a new dependency.** Only literal `require('./x')` is copied (`install-shipyard-claude-hook.sh:143`).
7. **A journalled base-merge that carries hand content.** Record coverage only for mechanical merges (T-43-17).
8. **A signed commit read as proof.** Hand commits were signed with the same key. Only sealed coverage records count.
9. **Scoped reachability fails open.** An absent path must read as absent. Add an agreement test against the full listing.
10. **Line numbers drift.** Phase 40 rewrites `sentinel.cjs`, `state-sync.cjs`, both hosts and the finalizer first. Anchor plans on functions.
11. **The comment policy flags phase 43's own diff.** `sentinel.cjs` and others contain long explanatory comments. Editing next to them is fine, but added lines must carry no new narrative comments.
12. **Config read from the worktree.** An agent could widen its own marker or allow-list. Only `loadConfig(projectRoot)` may be used.
13. **The verification allow-list becomes a shell.** Match argv arrays, never strings. Commands come from the pinned plan (T-42-01 pins the plan digest before launch), never from agent output.
14. **Two carry proofs disagree.** Keep the old tree-equal path and add the new one. Refuse when either identity is unreadable.

## Code Examples (shape only; from current source)

```js
// Source: plugins/delivery-pipeline/scripts/check-state.cjs:95-104 (current) — the line T-43-07 changes
for (const row of list) {
  switch (stateBucket(row)) {
    case 'pass': out.passing += 1; break;
    case 'fail': case 'cancel': out.failing += 1; break;
    case 'skipping': out.skipped += 1; break;
    default: out.pending += 1; break;
  }
}
```

```js
// Source: plugins/delivery-pipeline/scripts/publish-gate.cjs:24-32 (current) — T-43-02 inserts candidates before 'origin/main'
const candidates = [requested, process.env.COMMENT_POLICY_BASE, process.env.SHIPYARD_COMMENT_BASE,
  process.env.GITHUB_BASE_REF ? `origin/${process.env.GITHUB_BASE_REF}` : null, 'origin/main', 'main'].filter(Boolean);
```

## What cannot be tested without a live target project

This belongs to the operator's proving-ground rerun, outside the phase (REQ-175). Planners must not write acceptance criteria that need it.
1. The docker, php and FE verification actually running under the chosen runner profile, and its wall time on a 27k-file repository (REQ-159).
2. The end-to-end "no orchestrator-authored commits" outcome and the refusal remedy UX on real PRs (REQ-160).
3. Arch-review launches per ticket before and after (REQ-161). The source-reported baseline is about 23 for 13 tickets.
4. State-sync wall time before and after (REQ-173). The baseline is a 128 s median over 25 syncs.
5. CodeRabbit's real re-review behaviour and pdffiller branch rules and protection (REQ-167).
6. Real Jira MYD transitions, binding and permissions (REQ-164).
7. Whether `pw-debug-tests.yml` pushes a commit, and with which author (REQ-165 attribution).
8. The real Claude Bash 600 s cap and the Codex tool timeout (REQ-168).
9. The copy-installed pre-push hook on a `master`/`develop` default-branch repository (REQ-170, 163).

Everything else is fixture-reproducible with a stub `gh` on `PATH`, hermetic git repositories and synthetic large stdout. The human checkpoints on high-risk tickets should use an operator-owned scratch GitHub repository, as T-40-19 and T-40-22 do. They must not use a target project.

## Assumptions Log

| # | Claim | Section | Risk if wrong |
|---|---|---|---|
| A1 | `gh pr checks --json` offers `link`, `startedAt` and `workflow`, and the run id can be parsed from `link` | T-43-07 | The superseded check cannot be decided; a different lookup is needed (`gh run list --commit`) |
| A2 | The rules endpoint `repos/{o}/{r}/rules/branches/<b>` answers `[]` with read access, and classic protection answers 404 when there is none and 403 without admin | T-43-08 | If wrong, a stale bot approval keeps blocking (fail closed); no fail-open |
| A3 | `git diff`/`patch-id` over the recorded base **tree** reproduce the judged patch | T-43-13 | The carry would need the judged base commit, which means extending the status grammar |
| A4 | Remedy commit attribution by parent, author and run id is reliable | T-43-18 | Remedy commits are refused by T-43-19 (fail closed) |
| A5 | Config key names (`comment_markers`, `reviewer_bots`, `repo_remedies`, `verification_commands`) | T-43-01 | Naming only |
| A6 | The coverage record lives in host state with a host HMAC key, reusable by sentinel running as the same user | T-43-17/19 | Location and key sharing may need a different root per runtime |

## Open Questions (RESOLVED)

Resolved by the user on 2026-09-26; the answers are locked in `43-CONTEXT.md` as P-01..P-05.

1. **Q1 [NEEDS DECISION]: runner profile for allow-listed verification commands (T-43-16).** T-42-01's runner denies network and sockets and never runs unsandboxed. pdffiller's verification is docker plus php, which needs the docker socket. The ADR calls allow-listed commands "an operator-authority path, bounded by the allow-list".
   - Options: (a) keep T-42-01's sandbox for everything, which leaves docker-bound verification unsolved; (b) allow-list entries may declare a host profile, run unsandboxed via `runBounded` with argv, a timeout and bounded output.
   - Recommendation: (b), opt-in per allow-list entry, never the default, with the profile recorded in the evidence. Confirm at T-43-16's checkpoint, because it relaxes T-42-01's stated invariant.
   - RESOLVED (P-01): option (b), opt-in per entry, never the default, profile recorded in the evidence.
2. **Q2: base-merges with hand-resolved conflicts.** Recommendation: not covered, so the conflict resolution goes back through a fixer round. This is stricter than "a journalled base-merge" read literally. Confirm with the ADR owner. RESOLVED (P-02): not covered; the resolution goes through a fixer round.
3. **Q3: project-root discovery from a foreign-repo worktree in the pre-push hook** (config and delivery-state for T-43-02/03). Recommendation:
   - honour `SHIPYARD_PROJECT_ROOT` or `--project-root` when given;
   - otherwise use the main worktree of the pushing repository;
   - when neither yields config, use the built-in markers and the `origin/HEAD` base (both fail safe).
   - RESOLVED (P-05): as recommended.
4. **Q4: "opened after release"** (T-43-19). Recommendation: compare the PR's `createdAt` with a sealed rollout marker that T-43-17 writes on the first recorded finalization in the project. A config flag would be easy to forget. RESOLVED (P-03): sealed rollout marker, no config flag.
5. **Q5: remedy commit attribution** (see A4). Confirm on the proving ground. RESOLVED: kept as [ASSUMED] with fail-closed attribution (43-CONTEXT, after P-05); an unattributed commit stays uncovered.
6. **Q6: `review` checkpoint as a base for children** (`sentinel.cjs:966-983`). Should children wait until the review-mode parent merges into the epic (today's rule), or proceed once it is approved? Recommendation: today's rule, unchanged. RESOLVED (P-04): today's rule, unchanged.
7. **Q7: phase-40 landing may rename exports** (for example T-40-14's `validateRequest`). Planners must re-read the files after release. Every seam above is cited "at 22ef429b". RESOLVED: every plan re-reads its seams after release (43-CONTEXT).

## Environment Availability

| Dependency | Required by | Available | Version | Fallback |
|---|---|---|---|---|
| Node | all | ✓ | v24.10.0 (CI pins 24.15.0) | — |
| git | tests, patch-id | ✓ | 2.54.0 | — |
| gh | runtime only | ✗ in this sandbox (config read denied) | — | Tests stub `gh` on `PATH`; no ticket needs real `gh` |
| `sandbox-exec`/`bwrap` | T-42-01 runner tests reused by T-43-16 | macOS host, not probed | — | CI or an operator host (42-01-PLAN.md:40) |
| External packages | — | none needed | — | — |

## Validation Architecture

| Property | Value |
|---|---|
| Framework | Plain Node with `tests/unit/assert-harness.cjs`; bash smokes in `tests/smoke/` |
| Config file | none. `tests/unit/run.sh` auto-discovers `*.test.cjs` |
| Quick run | `node tests/unit/<file>.test.cjs` (per ticket, scoped) |
| Full suite | `make test-fast` (phase gate and CI only; never inside a ticket) |

| Req | Behavior | Type | Command | Exists? |
|---|---|---|---|---|
| 159 | allow-listed plan cmds run host-side, fail blocks finalize, both hosts | unit/fixture | `node tests/unit/host-verification.test.cjs` | ❌ new (T-43-16) |
| 160 | coverage records written; uncovered commit refuses; legacy journalled | unit | `node tests/unit/conveyor-coverage.test.cjs`, `node tests/unit/sentinel.test.cjs` | ❌ new / ✅ extend |
| 161 | identical own patch carries; duplicated block re-owes | fixture | `node tests/unit/verdict-carry.test.cjs` | ❌ new |
| 162 | review/merge/true semantics, stats attribution | unit/smoke | `bash tests/smoke/graph-validator-smoke.sh`, `node tests/unit/front.test.cjs` | ✅ extend |
| 163 | configured token allowed, edited comment passes, new comment blocks, Shipyard unchanged | unit | `node tests/unit/comment-policy.test.cjs` | ✅ extend |
| 164 | recorded key → key lookup, refuse unknown, no create | unit | `node tests/unit/jira-export.test.cjs` | ✅ extend |
| 165 | declared remedy runs first, bounded, journalled; undeclared never runs | unit | `node tests/unit/repo-remedy.test.cjs` | ❌ new |
| 166 | scratch present → proceeds; other untracked → refuses; >buffer → named refusal | unit | `node tests/unit/conveyor-scratch.test.cjs`, `node tests/unit/claude-role-host.test.cjs` | ❌ new / ✅ extend |
| 167 | bot stale + human fresh → fresh; human stale → stale; unknown rules → stale | unit | `node tests/unit/reviewers.test.cjs` | ✅ extend |
| 168 | superseded cancel ignored; lone cancel pending+rerun; 540 s cap; time budget | unit | `node tests/unit/check-state.test.cjs`, `node tests/unit/ci-wait.test.cjs` | ✅ extend |
| 169 | alias honoured in loadConfig and gate; warning on summary; one warning per absent phase; bootstrap appends | unit | `node tests/unit/pipeline-config.test.cjs`, `node tests/unit/gsd-sync.test.cjs`, `node tests/unit/gsd-sync-gate.test.cjs`, `node tests/unit/adr-bootstrap.test.cjs` | ✅ extend |
| 170 | master/develop origin resolves; Shipyard → origin/main; unresolved → exit 2 | unit | `node tests/unit/publish-gate.test.cjs` | ❌ new |
| 171 | >1 MiB output no ENOBUFS; scoped = full listing; truncation → unknown | unit | `node tests/unit/run-reachability.test.cjs`, `node tests/unit/sentinel.test.cjs` | ✅ extend |
| 172 | each builder output accepted by the real validator; no `type` in signals | unit | `node tests/unit/deliver-dispatch.test.cjs` | ✅ extend (after T-40-15) |
| 173 | merged-landed tickets cause 0 gh calls; `--full` restores | unit | `node tests/unit/state-sync-listing.test.cjs` | ❌ new |
| 174 | unknown type → informational with original_type; verdict unchanged | unit | `node tests/unit/role-artifact.test.cjs` | ✅ extend |
| 175 | every test above fails on base (RED commit) | process | per-plan RED step | — |

Sampling: per task commit, run the ticket's scoped commands. Per wave merge, CI runs `make test-fast` (`.github/workflows/test.yml`). The phase gate is `make test-fast` green before `/gsd-verify-work`.

**Wave 0 gaps:** none at the framework level. The new test files are listed per ticket and created in each ticket's RED step.

## Security Domain (security_enforcement: true, ASVS L1)

| ASVS | Applies | Control |
|---|---|---|
| V4 Access control | yes | The merge gate (coverage chain, checkpoint mode, bot freshness) refuses by default; relax only on positive evidence |
| V5 Input validation | yes | D-45 shape validation with warn-and-fallback; exact marker tokens; argv-array allow-list; Jira key regex (`JIRA_KEY_RE`, existing) |
| V6 Cryptography | yes | HMAC-SHA256 via `node:crypto` with `timingSafeEqual`, reusing the `dispatch-boundary.cjs` pattern; no hand-rolled schemes |
| V12/V14 command execution | yes | `execFileSync`/`spawnSync` argument arrays, no shell, timeouts, bounded output |
| V2/V3 | no | — |

| Threat | STRIDE | Mitigation |
|---|---|---|
| Agent widens its own marker list or verification allow-list via worktree files | Elevation | Read config only through `loadConfig(projectRoot)` (K5) |
| Plan-declared command becomes an arbitrary host command | Elevation | Intersect with the operator allow-list; argv match; the plan digest is pinned before launch (T-42-01) |
| Forged coverage record or journal line | Spoofing/Tampering | Sealed records with a host key; journal lines alone never cover a commit |
| Hand-resolved base-merge rides as mechanical | Tampering | Record coverage only for merges `base-merge.cjs` committed without manual resolution |
| Bot login spoofing or a renamed bot | Spoofing | Configured identities; unknown authors count as human (the stricter case) |
| Remedy workflow abuse | Elevation | Only declared `{repo, signature, workflow, inputs}`; bounded; journalled |
| Unknown finding hides a violation | Repudiation | The verdict field is never changed by finding normalization |

## Sources

### Primary (HIGH — read this session)
- ADR-020 (`.planning/architecture/…:1-60`), the ingest, and INV-007 `DECISIONS.md`, `research/constraints.md`, `research/alternatives.md` and `research/risks.md`.
- `.planning/graph/tickets.json` and `delivery-state.json`: ownership and status for T-40/41/42.
- Plans: `40-15`, `40-17`, `40-19`, `40-22`, `40-28` (scope), `42-01`, `40-06` (goal).
- Source files and lines as cited in §Seams: `publish-gate.cjs`, `shipyard-pre-push-gate.sh`, `install-shipyard-claude-hook.sh`, `run-reachability.cjs`, `sentinel.cjs`, `reviewers.cjs`, `check-state.cjs`, `ci-wait.cjs`, `comment-policy.cjs`, `role-artifact.cjs`, `jira-export.cjs`, `validate-graph.cjs`, `pipeline-config.cjs`, `capability.json`, `gsd-sync-gate.cjs`, `gsd-sync.cjs`, `adr-bootstrap.cjs`, `state-sync.cjs`, `claude-role-host.cjs`, `base-merge.cjs`, `ticket-worktree.sh`, `delivery-commit-finalizer.cjs`, `codex-delivery-host.cjs`, `claude-delivery-host.cjs`, `codex-decompose-host.cjs`, `dispatch-boundary.cjs`, `front.cjs`, `pipeline-stats.cjs`, `log-event.cjs`, `tests/unit/run.sh`, `.planning/graph/delivery-log.jsonl`.

### Secondary / Tertiary
- None fetched. No web or Context7 lookups were needed: the phase is internal code with no new libraries. The GitHub API and `gh` field details are [ASSUMED] (A1, A2).

## Metadata

- Standard stack: HIGH (no new dependencies).
- Seams and ownership: HIGH at `22ef429b`. MEDIUM after phase 40 lands, because line numbers and exports will move.
- Designs for T-43-16, 17 and 19: MEDIUM. They depend on T-42-01's runner and Q1, Q2 and Q4.
- Pitfalls: HIGH (each verified in source).
- **Valid until:** the release of phases 40 and 42. Re-verify the §Seams anchors then.
