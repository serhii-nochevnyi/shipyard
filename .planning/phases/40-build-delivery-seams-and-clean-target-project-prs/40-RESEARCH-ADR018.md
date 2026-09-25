# Phase 40 (addition): ADR-018 worktree conditions and residual seams - Research

**Researched:** 2026-09-25
**Domain:** Shipyard host-side delivery conveyor: role, delivery and decompose hosts; worktree lifecycle; gate carry; artifact validation; planning projection
**Mode:** `--tdd`, granularity standard
**Confidence:** HIGH for code locations and file overlap. MEDIUM for proof and ordering design. LOW only where marked `[ASSUMED]`.
**Source revision:** `e6e6151b` ("plan(40): register ADR-018 requirements for phase 40"), checked with `git log --oneline -1`. The line numbers below are from this tree, which is the epic 39 line. The 27 phase 40 tickets are planned but not implemented, so every line they touch will move.

## Summary

ADR-018 adds nine requirements (REQ-151..REQ-159) to phase 40. They fix seven defects found in phase 39 delivery, and they add one executable **worktree-conditions** module that every host checks before launch. None of this code exists yet. Every file the new work touches is either new or is also modified by a planned phase 40 ticket. ADR-018 fixes the direction: the new tickets **depend on** the phase 40 tickets that modify the same files.

Most of the work sits in five places:

1. `claude-role-host.cjs`. REQ-152 (role part), REQ-154, REQ-156, REQ-157 and REQ-158 all land here, after T-40-16 and T-40-22. These tickets must form one chain, because Gate 2 rejects dependency-unordered overlaps.
2. A new `worktree-conditions.cjs` registry and predicate module, consumed by eight hosts and scripts.
3. `gate-trailer.cjs` carry (REQ-151), after T-40-19.
4. `role-artifact.cjs` executor validation (REQ-155), after T-40-18.
5. The planning flow (REQ-159): a new offline seeder plus `decompose.md`, after T-40-25.

Research found four design traps the planner must encode as acceptance criteria:

- **T-40-19 abbreviates the tree.** Its planned status description carries `tree=<short sha>` (D-32). But carry requires a full 40-hex `base_tree`. Any REQ-151 carry built on T-40-19 must restore a full base tree in the status description, within 140 characters.
- **Excludes are repo-global and hide files from the post-run check.** `.git/info/exclude` lives in the common git dir, so an exclude entry affects every worktree and the main checkout. It also hides the excluded files from the role host's post-run check (`ls-files --others --exclude-standard`). The post-run mutation check must therefore snapshot registry paths with `lstat` and digest them. It must not rely on `git status`.
- **T-40-22 writes into the worktree.** Its sidecar `<graphDir>/provenance/<dispatch_id>.json`, plus `recordInflight` writing `dispatches.json`, land inside the ticket worktree whenever the role host uses its default graph (`<worktree>/.planning/graph`). Without the host-owned set, every arch-review after T-40-22 fails with `WORKTREE_MUTATED`, and the next launch refuses. This is RISKS R4.
- **Seeding breaks the published binding until the next sync.** Writing `delivery-state.json` outside `state-sync.cjs` changes the file's digest, so `wait-events.cjs` returns `RESYNC_REQUIRED` until the next state-sync. That is fail-closed and acceptable, but it has to be tested and documented.

**Primary recommendation:** slice ADR-018 into 10 tickets (plus one optional). The role-host chain is T-40-22 → draft/sentinel → integrator diff → conditions/restore. `worktree-conditions.cjs` is a new root after T-40-01. Carry, historical validation, ticket-worktree and the seeder each hang off their single phase 40 file owner. `deliver.md` prose comes last, after T-40-24.

## User Constraints (from ADR-018, DECISIONS.md and ADR-017; locked)

No `/gsd-discuss-phase` CONTEXT exists for this addition. The locked decisions are the accepted ADR-018 Decision section and the INV-005 scope fences. They are quoted verbatim below.

DATA_r8Kq2vXe_START
### Locked Decisions (ADR-018 "Decision", `.planning/architecture/ADR-018-worktree-conditions-and-residual-seams.md:36-45`)
- All residual fixes and the worktree-conditions work land as new phase 40 tickets that depend on the phase 40 tickets modifying the same files.
- A conform verdict carries across a sibling merge only when git tree objects prove the ticket's own change is identical and the base move touched no path the ticket declares or changes; otherwise arch-review is re-owed, and the carry is built on T-40-19's commit-status carrier.
- One worktree-conditions module defines scratch and host-owned files and the launch preconditions (clean tracked tree, role evidence path absent, plan and graph inside the worktree, fresh base ref, usable signing where a host commits), and every role, delivery and decompose host checks it before launch with a copyable remedy.
- `ticket-worktree.sh` prepares worktrees by construction: it writes `.git/info/exclude` entries for the registry's scratch files and offers a `verify` subcommand backed by the same module.
- A role's out-of-scope worktree mutation is restored by the host and reported, never left for the next launch.
- Executor artifacts are validated in a historical mode against their recorded base commit and tree at publication, and the PR opens against the live base for the normal base-merge.
- The integrator judges the full code diff excluding `.planning/` and `.shipyard-role-artifacts/` plus a name-status and blob-digest summary of `.planning`, and refuses with a named remedy when a bound is still exceeded.
- Arch-review accepts a draft PR, while the sentinel and the merge gate keep refusing drafts.
- A sentinel round excludes PRs opened after its snapshot and never acts on or reports them; changed members still expire.
- The planning flow writes a deterministic pending delivery observation for new tickets so `gsd-sync --check` stays offline and fail-closed.

### Scope fences (INV-005 `DECISIONS.md:14,19,24,29,34,39,44,49`)
- New tickets carry `depends_on` on the phase 40 tickets that modify the same files (T-40-16, T-40-18, T-40-19, T-40-22, T-40-24; state-sync owners); ADR-017 decisions are extended, not re-decided.
- Carry: built on T-40-19's commit-status carrier; compares git tree objects for the ticket's declared and changed paths, not diff text; any overlap between base-move paths and ticket paths re-owes arch-review; cross-ticket semantics stay with the integrator.
- Conditions: a shared registry defines scratch and host-owned files; every host (role, delivery Claude/Codex, finalizer, base-merge, ticket-worktree.sh) consumes it; `ticket-worktree.sh` writes `.git/info/exclude` entries and gains `verify`; the role's own evidence path must be absent (or moved aside with a digest) before launch; a role's out-of-scope mutation is restored by the host and reported; every refusal names a copyable remedy.
- Executor: a historical executor mode re-verifies the recorded base commit and tree objects; the PR opens against the live base and the normal base-merge brings it current; freshness against the live epic is still enforced by the merge gates.
- Integrator: full `--unified=50` diff excluding `.planning/` and `.shipyard-role-artifacts/`; `.planning` changes as name-status with blob digests; still over a bound → refusal with a named remedy; `references/integrator.md` states the scope; works with tracked and untracked `.planning`; ADR-014 window promotion inputs unchanged.
- Draft: accepted only for arch-review; sentinel and merge keep refusing drafts; a test pins both.
- Sentinel: new PRs are never acted on or reported by the round; they belong to the next round; changed members still expire; a test covers the non-member case.
- gsd-sync: stays offline and fail-closed; the planning flow writes a deterministic `pending` observation for new tickets.
DATA_r8Kq2vXe_END

### Claude's Discretion (derived; no CONTEXT exists)
- Module names, CLI shapes, refusal codes and remedy wording.
- Exact ticket slicing, and whether small requirements share a ticket.
- Whether the dispatch entry point (T-40-15 `deliver-dispatch.cjs`) also runs the conditions check as an early refusal. The hosts are the mandatory check sites.

### Deferred Ideas (OUT OF SCOPE; ADR-018 "Out of scope", `:57-62`)
- Decisions already taken in ADR-017: dispatch entry point, sentinel preflight, pre-push gate, header-free YAML, PR hygiene, dogfood install root, sealer.
- The ADR-014 model/effort grid and the fail-closed receipt contract.
- Carrying verdicts on diff-text or patch-id comparison.
- Jira export of this work.

<phase_requirements>
## Phase Requirements

| ID | Description (REQUIREMENTS.md:160-168) | Research support |
|----|----------------------------------------|------------------|
| REQ-151 | Conform carries across a sibling merge only on a tree-object proof of identical ticket change and disjoint base move; built on the commit-status carrier | §Pattern 4 (delta-identity proof on `git diff-tree --no-renames`), ticket A7 |
| REQ-152 | One worktree-conditions module: scratch and host-owned registry plus launch preconditions, checked by every role, delivery and decompose host, with a copyable remedy | §Pattern 1 and §Precondition matrix, tickets A1, A4, A5, A6 |
| REQ-153 | `ticket-worktree.sh` writes `.git/info/exclude` entries for registry scratch files and offers `verify` | §Pattern 2 (verified: exclude lives in the common dir), ticket A6 |
| REQ-154 | Out-of-scope role mutation restored by the host and reported | §Pattern 3 (snapshot → restore → refuse), tickets A4 and A5 (Codex parity) |
| REQ-155 | Executor artifacts validated in historical mode against the recorded base; PR opens against the live base | §Pattern 5, tickets A8 and A9 |
| REQ-156 | Integrator: code diff without `.planning/` and `.shipyard-role-artifacts/`, plus a `.planning` name-status and blob-digest summary; named-remedy refusal | §Pattern 6, ticket A3 |
| REQ-157 | Arch-review accepts drafts; sentinel and merge gate keep refusing | §Pattern 7, ticket A2 |
| REQ-158 | Sentinel round excludes PRs opened after its snapshot; changed members still expire | §Pattern 7, ticket A2 |
| REQ-159 | Planning flow writes a deterministic pending observation so `gsd-sync --check` stays offline and fail-closed | §Pattern 8, ticket A10 |
</phase_requirements>

## Project Constraints (from CLAUDE.md and the gsd-delivery-rules skill)

- The Claude plugin under `plugins/delivery-pipeline/` is canonical. Codex outputs are generated by `scripts/gen-codex-shipyard.cjs` and must be regenerated after shared changes (`make install-shipyard-codex`) [VERIFIED: CLAUDE.md:5-7,69-70,112-113].
- Deterministic scripts own computable decisions. **Every new rule gets a focused unit or fixture test** [VERIFIED: CLAUDE.md:72-75].
- Shell scripts keep `set -euo pipefail` and validate preconditions early [VERIFIED: CLAUDE.md:114].
- Preserve unrelated worktree changes, because the repository is often edited during an active session [VERIFIED: CLAUDE.md:116-117].
- Update `README.md` only when a supported command or installation flow changes [VERIFIED: CLAUDE.md:118]. `ticket-worktree.sh verify` is internal and adds no make target, so no README change is expected.
- **Comment policy** (pre-push gate `plugins/delivery-pipeline/scripts/comment-policy.cjs`): added comments may only be directives, licence or generated markers, or one-line `@invariant:`/`@security:`/`@contract:` markers of at most 120 characters. The policy covers `.cjs`, `.sh`, `.yml`, `.gitignore` and more [VERIFIED: comment-policy.cjs:8-9 `const MAX_MARKER_LENGTH = 120;` `const MARKER_PATTERN = /^@(invariant|security|contract)\s*:/i;`, :23 `['.sh', 'hash']`]. **Consequence:** a new usage line in the `ticket-worktree.sh` header comment block is a blocked comment. `HISTORY_PATTERN` even matches the word `ticket` (:10-11). Put usage in the script's `echo "usage: …"` output instead.
- **Rule zero:** every verification claim names its command [VERIFIED: .shipyard/generated/gsd-delivery-rules/SKILL.md:16-22].
- Planner rules: full frontmatter, non-empty `requirements` and `files_modified`, `depends_on` inside phase 40, and verification commands scoped to the ticket [VERIFIED: SKILL.md:40-118].
- Executors stop at the commit and stay inside `files_modified` [VERIFIED: SKILL.md:138-165].
- **Digest-pinned files:** only `plugins/delivery-pipeline/scripts/runtime-adapters.cjs` and `plugins/delivery-pipeline/scripts/claude-dispatch-adapter.cjs` [VERIFIED: tests/unit/source-contract.test.cjs:1986-1989]. None of the ADR-018 tickets needs to touch them. If one does, the pin can only change through T-40-06's `scripts/refresh-runtime-digests.cjs` and a `Runtime-Digest-Refresh:` trailer [CITED: 40-06-PLAN.md:24,37-38].

## Architectural Responsibility Map

| Capability | Primary tier | Secondary tier | Rationale |
|------------|--------------|----------------|-----------|
| Scratch and host-owned registry, launch preconditions | Deterministic script layer (`worktree-conditions.cjs`) | Every host (callers) | One predicate and one remedy vocabulary. Hosts only call it (DECISIONS scope fence). |
| Worktree preparation (`info/exclude`, `verify`) | Worktree lifecycle script (`ticket-worktree.sh`) | Conditions module (lines and verdict) | The shell owns creation. The node module owns the rules. |
| Out-of-scope mutation restore | Host process (role host, Codex delivery host) | Conditions module (snapshot/restore helpers) | Only the trusted host knows the pre-launch snapshot. |
| Verdict carry proof | `gate-trailer.cjs carry` plus a new pure proof module | `base-merge.cjs` (caller, unchanged CLI) | The script computes the proof; the caller never supplies it (gate-trailer.cjs:392-397). |
| Executor artifact validation | `role-artifact.cjs` (trusted consumer) | `deliver.md` publication step (passes `--historical`) | The mode lives in the validator. The prose chooses it at publication. |
| Integrator input scope | New shared script `integrator-diff.cjs` | `claude-role-host.cjs` (Claude); `references/integrator.md` plus prose (Codex) | Parity on Codex requires a shared deterministic producer, because the Codex host has no packet bounds. |
| Draft and round rules | `claude-role-host.cjs` | `sentinel.cjs merge` (unchanged, pinned by a test) | Identity rules live in the host that authenticates the snapshot. |
| Pending observations | New offline seeder script | `decompose.md` Gate 2 step; `gsd-sync.cjs` remedy text | The planning flow writes; `gsd-sync` only checks, offline. |

## Standard Stack

There are no external packages. Every capability uses Node built-ins and git, which the repository already uses.

| Component | Version | Purpose | Evidence |
|-----------|---------|---------|----------|
| Node.js | CI pins `24.15.0`; local `v24.10.0` | All scripts and tests (`node:test`, `node:assert`, `node:child_process` `execFileSync` argument arrays) | [VERIFIED: .github/workflows/test.yml:46 `node-version: '24.15.0'`; `node --version` → `v24.10.0`] |
| git | local `2.54.0` | `diff-tree --no-renames`, `rev-parse --git-path`, `ls-files`, `restore` | [VERIFIED: `git --version` → `git version 2.54.0 (Apple Git-157)`] |
| `path-owner.cjs` (in-repo) | — | Glob-aware "does declaration own path" (`parse`, `owns`) for declared-path overlap in carry and scope | [VERIFIED: delivery-commit-finalizer.cjs:7 `const { parse, owns } = require('./path-owner.cjs');`] |
| `graph-dir.cjs` (in-repo) | — | `resolveGraphDir`, `repoRootOf`, `resolveBaseRef`. Reuse; do not add a second locator | [VERIFIED: graph-dir.cjs:33-61,184] |
| `role-artifact.cjs` exports (in-repo) | — | Scratch names; import them, never re-type them | [VERIFIED: role-artifact.cjs:29-34,41-45, exports :2689-2699] |

**Installation:** none.

## Package Legitimacy Audit

No external packages are installed by this addition. **Packages removed:** none. **Packages flagged:** none.

## Verified in-repo values (verbatim quotes)

Scratch names [VERIFIED: role-artifact.cjs:29-34, 41-45]:
DATA_m3Tz9QwL_START
```
const MANIFEST_NAME = '.shipyard-role-artifact.json';
const PR_BODY_NAME = '.shipyard-pr-body.md';
const EVIDENCE_NAME = '.shipyard-evidence.md';
const REPAIR_EVIDENCE_NAME = '.shipyard-repair-evidence.md';
const DRIFT_EVIDENCE_NAME = '.shipyard-drift-evidence.md';
const ARTIFACT_ARCHIVE_DIR = '.shipyard-role-artifacts';
const JUDGMENT_EVIDENCE_NAMES = Object.freeze({
  'arch-review': '.shipyard-arch-review-evidence.md',
  'pr-sentinel': '.shipyard-sentinel-evidence.md',
  integrator: 'INTEGRATION.md',
});
```
DATA_m3Tz9QwL_END

Role host bounds and evidence names [VERIFIED: claude-role-host.cjs:19-27]:
DATA_c5Hn1RyV_START
```
const REQUEST_MAX_BYTES = 32768;
const SOURCE_MAX_BYTES = 768 * 1024;
const DIFF_MAX_BYTES = 1024 * 1024;
const PROMPT_MAX_BYTES = 1500000;
const RESULT_MAX_BYTES = 128 * 1024;
const PACKET_MAX_TOKENS = 360000;
const ROLES = Object.freeze(['arch-review', 'integrator', 'pr-sentinel']);
const ARCH_EVIDENCE = '.shipyard-arch-review-evidence.md';
const SENTINEL_EVIDENCE = '.shipyard-sentinel-evidence.md';
```
DATA_c5Hn1RyV_END

The three other scratch policies [VERIFIED: codex-delivery-host.cjs:20; delivery-commit-finalizer.cjs:8; claude-delivery-host.cjs:606-611; base-merge.cjs:167]:
DATA_p2Wd7GsN_START
```
const SCRATCH_STATUS = new Set(['?? .shipyard-pr-body.md', '?? .shipyard-evidence.md']);
const SCRATCH = new Set(['.shipyard-pr-body.md', '.shipyard-evidence.md']);
  return status.split('\0').some((entry) => entry.length >= 4
    && entry.slice(3) !== roleArtifact.REPAIR_EVIDENCE_NAME
    && !entry.slice(3).startsWith(`${roleArtifact.ARTIFACT_ARCHIVE_DIR}/`));
const dirtyCheck = git(['status', '--porcelain', '--untracked-files=no'], { tolerate: true });
```
DATA_p2Wd7GsN_END

Host-owned graph files today [VERIFIED: claude-role-host.cjs:786; dispatch-record.cjs:1150]: `for (const relative of ['dispatches.json', 'delivery-front.json']) {` and `const STORE_NAME = 'dispatches.json';`. T-40-22 adds `<graphDir>/provenance/<dispatch_id>.json` [CITED: 40-22-PLAN.md:27,45; 40-CONTEXT.md:51 D-33].

Gate grammar [VERIFIED: gate-trailer.cjs:88,97-107,138-150]: `const TREE_SHA = /^[0-9a-f]{40}$/i;`. `gateKind` uses exact head comparison, with no prefix tolerance.

Merge draft refusal [VERIFIED: sentinel.cjs:922]: `if (pr.isDraft) return block('PR is still a draft — the conform gate has not been passed');`

gsd-sync blockers [VERIFIED: gsd-sync.cjs:607-613]: `` blockers.push(`${plan.ticket}: delivery-state.json has no observation`); `` and `` `${plan.ticket}: delivery-state.json has no valid status observation` ``, checked with `typeof observation.status !== 'string'`.

state-sync pending shape [VERIFIED: state-sync.cjs:556]: `const entry = { branch: t.branch, pr: pr ? pr.number : null, status: 'pending' };`

## Architecture Patterns

### System architecture (data flow)

```
                    ┌─────────────── planning (decompose Gate 2) ───────────────┐
 PLAN.md ──validate-graph.cjs──▶ tickets.json ──seed-delivery-state (A10)──▶ delivery-state.json (pending rows)
                                                                   └──▶ gsd-sync --check (offline, fail-closed)
                    └──────────────────────────────────────────────────────────┘

 ticket-worktree.sh create ──▶ worktree ──▶ writes <common-dir>/info/exclude (registry scratch lines)  [A6]
                                   │
 deliver-dispatch launch (T-40-15) ─┤ (optional early check, A11)
                                   ▼
            ┌──── host launch (role / delivery Claude / delivery Codex / decompose) ────┐
            │ 1. conditions.check(profile, worktree, graphDir, base)  → refuse + remedy  │
            │ 2. move-aside stale own evidence (digest) ; rotate (prepareRoleArtifact)   │
            │ 3. recordInflight (T-40-14/22 → dispatches.json, provenance/<id>.json)     │
            │ 4. snapshot: tracked HEAD, untracked set, registry scratch + host-owned    │
            │    bytes/digests (lstat-based, independent of info/exclude)                │
            │ 5. agent launch (ADR-014 boundary, unchanged)                              │
            │ 6. post-run: diff vs snapshot → unexpected? restore + report + refuse      │
            │ 7. revalidate live inputs (draft OK for arch-review; round excludes new)   │
            │ 8. seal artifact / verdict                                                 │
            └────────────────────────────────────────────────────────────────────────────┘
                                   │
 arch-review conform ─▶ gate-trailer write (T-40-19: merge-gate status on head, full base_tree)
                                   │
 sibling squash into epic ─▶ base-merge.cjs ─▶ gate-trailer carry ─▶ carry-proof (A7):
        Δ(J→F) ≡ Δ(N→T) on tree entries (--no-renames) AND paths(J→N) ∩ (Δ ∪ declared) = ∅
        ├─ holds  → post status on new head (base_tree = N, carried_from = F)
        └─ fails  → refusal; arch-review re-owed
                                   │
 publication ─▶ role-artifact validate/read --historical (A8/A9) ─▶ gh pr create --base <live base>
                                   │
 integrator ─▶ integrator-diff.cjs (A3): code diff -- . ':(exclude).planning' ':(exclude).shipyard-role-artifacts'
                                        + .planning raw name-status with full blob ids ─▶ bounds ─▶ refuse w/ remedy
```

### Recommended file layout (new files only)

```
plugins/delivery-pipeline/scripts/
├── worktree-conditions.cjs     # registry + preconditions + snapshot/restore + CLI (verify, exclude-lines)
├── carry-proof.cjs             # pure tree-object delta-identity proof (no gh)
├── integrator-diff.cjs         # scoped combined diff + .planning summary + CLI (Claude import, Codex prose)
└── seed-delivery-state.cjs     # offline pending-row seeder + CLI
tests/unit/
├── worktree-conditions.test.cjs
├── worktree-conditions-hosts.test.cjs     # delivery + decompose host wiring (avoids T-40-09's test files)
├── ticket-worktree-conditions.test.cjs    # avoids tests/smoke/worktree-smoke.sh (T-40-20)
├── carry-proof.test.cjs
├── integrator-diff.test.cjs
├── sentinel-draft-merge.test.cjs          # pins sentinel.cjs merge draft refusal (avoids sentinel.test.cjs, T-40-22)
├── seed-delivery-state.test.cjs
└── deliver-worktree-conditions-contract.test.cjs  # avoids deliver-seams-contract.test.cjs (T-40-24)
```

New test files are discovered automatically: `tests/unit/run.sh` loops over `tests/unit/*.test.cjs` and runs `node --check` on every `plugins/delivery-pipeline/scripts/*.cjs` [VERIFIED: tests/unit/run.sh:15-26]. No Makefile change is needed.

### Pattern 1: one registry plus profile-based preconditions (REQ-152)

**What:** `worktree-conditions.cjs` exports the following.

- `REGISTRY`. Each entry is `{path, kind: 'file'|'dir', class: 'scratch'|'host-owned', base: 'worktree'|'graph'}`. Scratch entries are built **from the `role-artifact.cjs` exports**: `PR_BODY_NAME`, `EVIDENCE_NAME`, `MANIFEST_NAME`, `REPAIR_EVIDENCE_NAME`, `DRIFT_EVIDENCE_NAME`, the `JUDGMENT_EVIDENCE_NAMES` values other than `INTEGRATION.md`, and `ARTIFACT_ARCHIVE_DIR/` as a dir. Host-owned entries are relative to the graph dir: `dispatches.json`, `delivery-front.json`, `provenance/` (T-40-22), and the state-sync outputs `delivery-state.json`, `delivery-state.yaml` and `delivery-state-meta.json`. Add `pr-ledger.json` (T-40-03, D-31) only if the planner confirms that hosts write it inside the worktree `[ASSUMED]`.
- `classify(worktree, graphDir)`. It runs `git status --porcelain=v1 -z --untracked-files=all --ignored` and returns `{trackedDirty[], untrackedUnknown[], scratchPresent[], hostOwnedDirty[]}`. **A path tracked in HEAD is never scratch.** The Shipyard repository tracks three files under `.shipyard-role-artifacts/1138a7f8…/` [VERIFIED: `git ls-files .shipyard-role-artifacts` → 3 paths], so a modification to them is a tracked change.
- `check(profile, {worktree, graphDir, base, evidencePath, planPaths, commits, run})`. It returns `{ok:true}` or throws `{code, message, remedy, details}`. The remedy is a concrete copyable command with absolute paths, following the T-40-16 precedent that "every refusal message contains a command the operator can copy and run" [CITED: 40-16-PLAN.md:70].
- `snapshot(...)` / `diffSnapshot(...)` / `restore(...)`. See Pattern 3.
- CLI: `verify --worktree <wt> --role <role> [--graph <dir>] [--base <b>] [--json]` and `exclude-lines`. All git calls use `execFileSync` argument arrays with an injectable runner for tests. That is the existing `options.execFileSync` seam, `claude-role-host.cjs:95-111`.

**Precondition matrix (profiles):**

| Condition | role: arch-review | role: pr-sentinel | role: integrator | executor (Claude/Codex) | repair (ci-fix/review-fix) | decompose (Claude/Codex) |
|---|---|---|---|---|---|---|
| Worktree is canonical toplevel | yes (exists :120-122) | yes | yes | yes (exists) | yes | yes (exists claude-decompose-host.cjs:106) |
| Clean tracked tree, excluding host-owned graph files | yes | yes | yes | yes | yes | **no**: decompose writes PLANs into a live checkout; CLAUDE.md:116-117 |
| Untracked non-registry files | refuse | refuse | refuse | refuse (today the Codex host refuses non-scratch, :204-206) | refuse | not checked |
| Role's own evidence path absent | yes: move aside if untracked, rotate if tracked | yes | yes (`INTEGRATION.md` may be tracked) | `.shipyard-pr-body.md` and `.shipyard-evidence.md` absent before launch | `.shipyard-repair-evidence.md` | n/a |
| Plan inside worktree (the model reads it under `--restricted`) | host reads it via `fileText` (already contained, :220-237) | yes, plus the graph (sentinel scripts read `graph_path`, :575) | yes | **yes**: `planPath` must be under the worktree | yes | graph and research refs |
| Graph inside worktree | yes (default graph dir) | yes | yes | not required; the host reads the graph host-side via `SHIPYARD_GRAPH_DIR` | not required | n/a |
| Fresh base ref: fetch `+refs/heads/<b>:refs/remotes/origin/<b>`; `origin/<b>` exists; local `<b>` not diverged | yes (reuse `branchOid`) | T-40-16 preflight already owns fetch and fast-forward | yes | yes | yes (the repair path fetches today, :294) | no |
| Usable signing (`user.signingkey` resolves to one secret key and a full fingerprint) | no | **only when** `.planning/graph` is tracked (T-40-16 commits the synced graph) | no | yes (move the existing duplicated checks here) | yes | no |

**Existing implementations to consolidate (plan rule §5):** there are two copies of signer resolution, `claude-delivery-host.cjs:184-202` `signingFingerprint` and `codex-delivery-host.cjs:109-127` `signerFingerprint` [VERIFIED: Read]. Four scratch policies are listed in the verbatim block above. The role host has no policy and refuses everything (:123-124). The conditions module replaces all of them; the hosts delegate. The existing refusal codes should be reused where the meaning matches: `WORKTREE_NOT_READY`, `SIGNER_UNAVAILABLE` (Codex), `WORKTREE_MUTATED` (role host).

**Open design point: plan inside the worktree in target projects.** T-40-17 makes `.planning/` untracked in target projects (D-16). A ticket worktree therefore holds no `.planning/`, and T-40-15 sets `planPath = path.resolve(graphDir,'..','..',row.plan)` with `graphDir` resolved from the ticket worktree. That falls back to the **main checkout's** graph (`resolveGraphDir` step 3, graph-dir.cjs:54-57). The precondition "plan inside the worktree" would then refuse **every** target-project executor. ADR-018 does not say who materializes the plan. See Open Question 1. The recommended default is that `ticket-worktree.sh create` copies the ticket's plan file (only that file) into `<wt>/.planning/phases/<dir>/<plan>`, and the host verifies its sha256 against the main-checkout plan. `.planning/` is gitignored there by `planning-untrack.cjs` (40-17-PLAN.md:55), so the copy is invisible to git. `[ASSUMED]`

### Pattern 2: prepared by construction with repo-global excludes (REQ-153)

**Verified behaviour** (a probe in `$TMPDIR` with a linked worktree, `GIT_CONFIG_GLOBAL=/dev/null`):

```
path: /private/tmp/claude-502/probe-excl-15930/r/.git/info/exclude     # git rev-parse --git-path info/exclude (from the linked worktree)
before: ?? .shipyard-pr-body.md
after: []                                                               # after appending /.shipyard-pr-body.md
ls-files others excl-std: []
ignored: !! .shipyard-pr-body.md
```

Consequences:

1. Resolve the file with `git -C "$wt_dir" rev-parse --git-path info/exclude`, never `$wt_dir/.git/info/exclude`. In a linked worktree `.git` is a file.
2. The write is **repo-global**. It also hides the scratch files in the main checkout. This is desirable, but it means that committing new phase-level evidence under `.shipyard-role-artifacts/` in the Shipyard repository (as commit `22397b76` did) will need `git add -f`. Document this, or exclude the archive dir only from ticket worktrees. That is not possible with `info/exclude`, so it is an Open Question.
3. **Excluded files vanish from `git ls-files --others --exclude-standard`**, which is what the role host's post-run check uses (claude-role-host.cjs:799). After A6 lands, a role that rewrites `.shipyard-pr-body.md` during arch-review is **invisible** to today's check. The snapshot must be `lstat` and digest based over the registry (Pattern 3). This is RISKS R3.

**`ticket-worktree.sh` changes:**

- `create`: after `worktree add`, and also on both reuse paths (they are idempotent), run `node "$conditions_script" exclude-lines`. Append only the missing lines to the exclude file, while holding the existing `acquire_git_lock` (ticket-worktree.sh:206). Print nothing on stdout. Stdout is the API: `echo "$wt_dir"` (:250, :282).
- New `verify` case: `verify <ticket-id> [--role <r>] [--json]` resolves `$wt_base/$ticket`, then runs `node "$conditions_script" verify --worktree … --role … [--json]` and passes the exit code through. Add it to the `usage` echo text. Add no header comment lines (comment policy).
- Keep bash 3.2 compatibility and `set -euo pipefail`.

**Interaction with T-40-27:** T-40-27 rewrites the fresh-branch path of `create` (a merge of the epic for diamond children) [CITED: 40-27-PLAN.md:72-80]. Place the exclude write **after** that merge block, so a failed diamond merge (exit 13, cleanup) never writes excludes for a removed worktree. The exclude file is shared, so leaving the lines would still be harmless.

### Pattern 3: snapshot → restore → refuse (REQ-154)

In the role host (`buildBoundary` launch and `assertEvidenceOnlyChanges`, claude-role-host.cjs:752-820):

1. **Before the agent launch** and **after** `reserveRound` (:760-765) and T-40-22's `recordInflight`, take a snapshot:
   - the HEAD commit and branch;
   - the set of untracked paths (`ls-files --others -z`, **without** `--exclude-standard` for registry paths, or `lstat` per registry entry);
   - the bytes of every registry scratch file and every host-owned file that exists under the worktree. They are small, but bound each file (for example 1 MiB) and refuse `SNAPSHOT_TOO_LARGE` otherwise;
   - a recursive listing plus digests for `.shipyard-role-artifacts/`.

   Today `hostOwnedFiles` is filled **only for pr-sentinel** (:759-766). It must be filled for all three roles, because T-40-22 records in-flight for every role launch (40-22-PLAN.md:46).
2. **After the run:** compute the unexpected set. It holds tracked changes other than the evidence path, new untracked paths not in the snapshot, scratch or host-owned bytes that differ from the snapshot, and new archive entries.
3. **Restore**, in this order:
   - tracked changes: `git -C wt restore --source=HEAD --staged --worktree -- <paths>`, using NUL-safe argument arrays. The pre-launch clean check guarantees nothing unrelated is lost;
   - new untracked files: `unlink`, only after `lstat` proves they are regular files or symlinks **inside** the worktree and not in the snapshot. Then remove the now-empty directories bottom-up;
   - scratch and host-owned files: rewrite the snapshotted bytes atomically;
   - a HEAD or branch move: compare-and-swap with `git update-ref refs/heads/<branch> <prepared.head> <current>` followed by `git reset --keep <prepared.head>`, only when the branch name is unchanged. Otherwise refuse `STALE_CONTEXT` with the remedy `git -C <wt> switch <branch>`. `[ASSUMED]`: the planner decides whether HEAD restore is in scope. ADR-018 says "worktree mutation".
4. **Report and refuse:** `reject(\`role changed paths outside its evidence file (restored: …)\`, 'WORKTREE_MUTATED')`, with `error.details = {restored, removed, rewritten}`. The verdict is still discarded, and the next launch sees a clean tree.
5. **The failure path:** in the `catch` at :998-1006, when `getLaunchCount() === 1`, run the same restore before rethrowing. A heartbeat error or `MISSING_RECEIPT` after launch otherwise leaves the mutations in place.

**Codex parity:** `codex-delivery-host.cjs` launches every role through `launchAgent` (:314-329) and runs no post-run check except for executors (:309-331) [VERIFIED: Read]. For the judgment roles on Codex (arch-review, integrator, drift-check), apply the same snapshot and restore, allowing the role's evidence path from `JUDGMENT_EVIDENCE_NAMES` or `DRIFT_EVIDENCE_NAME`. pr-sentinel on Codex performs PR duties and may run state-sync, so its allowed set is evidence plus host-owned graph files `[ASSUMED]`. Executors and repairs keep the finalizer-based scope check.

### Pattern 4: carry across a sibling merge by delta identity (REQ-151)

**Today:** `runCarry` requires `fromTree === toTree` (gate-trailer.cjs:450-454) **and** merge-base tree `=== judgedBaseTree` (:519-524). A sibling squash changes both, so a verdict never carries [VERIFIED: Read gate-trailer.cjs:403-577].

**Proof (all tree objects, rename detection off):** let

- `F = from^{tree}`, the judged head;
- `T = to^{tree}`, the new head;
- `J` = the full `base_tree` recorded with the verdict;
- `N = tree(merge-base(resolveBaseRef(base), to))`.

1. `from` is an ancestor of `to` (existing check, :455-459).
2. `ΔJF = git diff-tree -r --no-renames --raw -z --full-index J F` and `ΔNT = git diff-tree -r --no-renames --raw -z --full-index N T`. Require **identical entries**: same path set, and for each path the same old mode/oid and new mode/oid. This proves the ticket's own change is identical on both sides of every changed path. Because it compares tree entries, not rendered text, it does not depend on `diff.algorithm` or context size. `--no-renames` removes the INV-005 "rename detection" unknown: a rename becomes delete plus add, compared exactly.
3. `B = paths(git diff-tree -r --no-renames --name-only -z J N)`. Require that no `p ∈ B` is in `paths(ΔJF)`, and that no declared file owns `p`. Ownership uses `path-owner.cjs owns(parse(decl), p)` over `tickets.json` `row.files`. Step 2 already refuses a base move on a changed path, because the old oids would differ. Step 3 adds the **declared-but-unchanged** paths.
4. The existing no-content carry (`F==T && J==N`) is the special case where both deltas are equal and `B` is empty. Keep it first for its existing messages.
5. Conflict resolutions change `ΔNT`'s new oid on a ticket path, so the proof fails and arch-review is re-owed. This matches the backlog rule that "a conflict resolution is authored content".
6. On success, post the carried status on `to` with `base_tree = N` (so that a later carry chains soundly), `carried_from = <first judged head>`, and no `checks=` (existing rule, :546-549).

**Declared paths:** gate-trailer reads the row through `graph-dir.cjs resolveGraphDir(['--graph', …] or argv, worktree)` plus `loadTickets`. A missing row refuses (absent proof is not proof, :64-69). Base-merge's call (base-merge.cjs:212-216) passes no `--graph`. The `worktree-repo` fallback resolves the graph for same-repo tickets. Cross-repo tickets then refuse the sibling carry, which is fail-closed. Do **not** add `--graph` to base-merge in the same ticket unless `gate-trailer.cjs` accepts it first. Its `parseFlags` refuses unknown flags (:408).

**T-40-19 contract risk (must be an acceptance criterion):** D-32 says the status description carries "the existing trailer grammar (`arch-review=…, drift-check=…, tree=<short sha>`), at most 140 characters" [CITED: 40-CONTEXT.md:50]. `TREE_SHA` refuses abbreviations (gate-trailer.cjs:85-88, :498-500). The carry ticket must make the `merge-gate` description carry a **full 40-hex `base_tree`**. `head` is implicit, because the status is attached to that sha. The ticket must drop `checks=`, abbreviate `carried_from` (audit only, never used in the proof), and assert a worst-case length of ≤ 140 in a test. A back-of-envelope count: `arch-review=conform, drift-check=fresh, degenerate-green=clean, base_tree=<40>, carried_from=<7>` is about 136 characters `[ASSUMED]`. It is tight, so the test must use the longest vocabulary values.

**Where it lives:** a new `carry-proof.cjs` exports `proveCarry({git, from, to, judgedBaseTree, baseRef, declared})` and returns `{carried, reason, newBaseTree}`. It is a pure function over an injected git runner, and it contains no `gh` calls. `gate-trailer.cjs runCarry` calls it after reading the gate through T-40-19's `readGate({repo, sha: from, body})`. The pure module keeps the textual conflict with T-40-19's edits of `gate-trailer.cjs` small, and gives a gh-free test surface.

### Pattern 5: historical executor validation (REQ-155)

**Today:** `validateExecutor` → `expectedManifest` compares `base`, `base_commit` and `base_tree` with the **live** identity from `gitIdentity` → `liveBaseRef`, which prefers `origin/<base>` (role-artifact.cjs:191-236, :568-598), and fails `STALE_ARTIFACT` otherwise. The CLI already parses `--historical` and forwards `historical: true` (:2548-2551, :2613). But `validateExecutor` and `readExecutor` ignore it (:657-722). Only repair and drift artifacts honour it (:2241, :2289-2313) [VERIFIED: Read].

**Change:** in `expectedManifest`, when `input.historical === true || input.allowHistorical === true`, remove `base_commit`/`base_tree` from the live-equality list and instead:

- (a) `gitObjectIdentity(input, worktree, manifest.base_commit)` (:2174-2178) must resolve, and its tree must equal `manifest.base_tree`;
- (b) `git merge-base --is-ancestor <manifest.base_commit> HEAD` must succeed, which proves the committed ticket was built on the recorded base. This is the extra binding that R7 requires;
- (c) `head`, `head_tree`, `base` (the name), repository, worktree, dispatch and policy stay live-equal.

Return `historical: true` in the validated object, like `validateRoleManifest` (:2445). **Do not** make historical mode automatic: the caller asks for it, as ADR-018 specifies ("at publication"). Merge freshness remains with base-merge and the sentinel merge gate.

**Prose:** `deliver.md` steps 5d/6 (:1956-1980 today; T-40-24 rewrites the publication section) add `--historical` to executor `validate` and `read`, keep `gh pr create --base <state[T].base>` (the live base), and name `base-merge.cjs` as the follow-up. On Codex, the executor artifact is sealed and validated through the same `deliver.md` path, so parity comes from the regenerated prose.

**T-40-18 interaction:** T-40-18 edits `assertTicketMarker` call sites at `:545` and `:693` for PR hygiene [CITED: 40-18-PLAN.md:28-40]. REQ-155 edits `expectedManifest` (:568-598) and `validateExecutor` (:657-722). They are adjacent hunks in the same functions, so depend on T-40-18.

### Pattern 6: scoped integrator input (REQ-156)

**Today:** `diffText` runs `git diff --no-ext-diff --unified=50 base...head` with no pathspec and refuses above `DIFF_MAX_BYTES` with no remedy (claude-role-host.cjs:341-345). `prepareIntegrator` feeds it the whole epic (:451-453) [VERIFIED: Read]. Measured epic 39 (INV-005): total 1,935,272 B; `.planning` 1,465,974 B; everything else 469,298 B (≈117k tokens by the host estimator) [CITED: INV-005 research/constraints.md B4, C-T1].

**New `integrator-diff.cjs`:**

- `codeDiff`: `git diff --no-ext-diff --unified=50 <mergeBase>...<head> -- . ':(exclude).planning' ':(exclude).shipyard-role-artifacts'`, bounded by `DIFF_MAX_BYTES + 1` in `maxBuffer` as today.
- `planningSummary`: `git diff --no-ext-diff --no-renames --raw -z --full-index <mergeBase> <head> -- .planning`. Parse it into sorted `{status, path, old_mode, new_mode, old_blob, new_blob}`. The git blob ids are the "blob digests"; they are content-addressed.
- Untracked `.planning` in target projects: `.planning` is not in either tree, so the summary is empty. That is correct: "works with tracked and untracked". Plans still arrive as `phase_contracts` (:456-457), and those need the plans to be readable in the worktree (Open Question 1).
- A CLI (`--worktree --merge-base --head [--json]`) so the Codex orchestrator can build the same input from `references/integrator.md`.

**Role host:**

- `combined_diff.content = codeDiff`;
- add `combined_diff.pathspec_excludes: ['.planning', '.shipyard-role-artifacts']` and `planning_changes: summary` to `roleContext`. Extra keys are allowed: `context-packet.cjs` only checks that the required keys (`phase_contracts`, `combined_diff`) are present (context-packet.cjs:28, :417-418);
- the refusal becomes `role diff exceeds the bounded context packet: <bytes> B > 1048576 B after excluding .planning and .shipyard-role-artifacts — measure: git -C <wt> diff --no-ext-diff --unified=50 <mb>...<head> -- . ':(exclude).planning' ':(exclude).shipyard-role-artifacts' | wc -c; remedy: …`. The remedy wording is `[ASSUMED]` for the planner and user; for example "split the phase or integrate the epic in two steps".

Apply the same remedy to the prompt bound at :637. `estimatePromptTokens` (:641-644) is unchanged, so ADR-014 window promotion keeps its input definition.

**`references/integrator.md`** "Input" (:14-22) must say that the diff excludes `.planning/` and `.shipyard-role-artifacts/`, name the summary and the CLI, and keep the `## Verification contract` section. `source-contract.test.cjs:441-469` asserts that section in every role reference.

**Phase 40 sizing check (R2):** phase 40 plans are 178,675 B and `.planning/architecture/*.md` is 237,948 B (27 files) [VERIFIED: `cat … | wc -c`]. Both are inlined as required refs. Add JSON escaping and the code diff, and the phase 40 integrator prompt approaches the 250k-token window threshold. Measure it on the epic before running. This is a note for the live round, not a blocker.

### Pattern 7: draft accepted for arch-review; round excludes late PRs (REQ-157, REQ-158)

**REQ-157:**

- Drop `live.isDraft === true` from the arch-review identity checks at `:363` and `:826`.
- Split the combined messages. Today, draft, head and base all say "live PR identity differs from the ticket worktree". The new messages name the cause and a remedy, for example `gh pr view <n> --json headRefOid` or `git -C <wt> pull --ff-only`.
- Leave `prepareSentinel`/`pr_state.draft` as it is (:552).
- **Pin both refusals:** `sentinel.cjs mergeOne` already blocks drafts (sentinel.cjs:922). No test asserts that today (`grep 'still a draft' tests` finds only a comment in escalation-record.test.cjs:25). Add a new test file that drives `sentinel.cjs merge` against a stubbed `gh` returning `isDraft: true`, modelled on `tests/unit/sentinel.test.cjs`, and asserts the block. The draft-until-conform order in `deliver.md:56-58` and `sentinel.cjs:672-693` stays unchanged, and "draft means not certified" is preserved (C-P2).

**REQ-158:** in `revalidateLiveInputs` (pr-sentinel branch, :834-893):

| Site | Today | New |
|---|---|---|
| :838-840 membership change | reject | keep (a graph membership change is not "a PR opened"; out of scope) |
| :841-848 non-member now `pr-open` in graph | reject `STALE_CONTEXT` | exclude silently from this round |
| :862-867 member has an **additional** open PR | reject | expire the member (a changed member), `expiredTickets.push(id)` |
| :885-891 non-member has an open PR on GitHub | reject | exclude silently; **but** a non-array `open` (a gh failure) still rejects, fail-closed |

"Never acts on or reports them" is already enforced for results. `dutyEntries` rejects any `performed`/`refused` entry whose ticket is outside the guarded set (role-artifact.cjs:1505-1507), and the round record keeps only snapshot members plus `expired_tickets` (dispatch-record.cjs:1524, :1594). Do not add excluded tickets to the result, the round record or the artifact.

**Tests** (`tests/unit/claude-role-host.test.cjs`, which uses `node:test` fixtures, `setupSentinelRepository` at :216-254 and the `sentinelPrs` stubs):

- a non-member opens a PR mid-round; the round seals, and `result.round.tickets` equals the snapshot;
- the graph marks a non-member `pr-open` mid-round; same outcome;
- a member gains a second open PR; the member expires;
- `listPullRequests` returns a non-array for a non-member; `STALE_CONTEXT`.

The fixture mutation happens inside the fake runtime `agent()` (the `onLaunch` hook, :146).

### Pattern 8: offline pending observations (REQ-159)

**Today:** `checkSource` blocks every PLAN without a `delivery-state.json` key (gsd-sync.cjs:607-613), and only state-sync writes that file, from GitHub [VERIFIED: Read; state-sync.cjs:459 `gh pr list`].

**New `seed-delivery-state.cjs`:**

- `seed({graphDir})` reads `tickets.json` and `delivery-state.json`.
- For each ticket id **absent** from state, it adds `{branch: row.branch, pr: null, status: 'pending'}`, the same shape as state-sync.cjs:556.
- It never modifies an existing row, and it writes atomically with the existing formatting (`JSON.stringify(state, null, 2) + '\n'`, state-sync.cjs:1113).
- It is idempotent: a second run gives byte-identical output.
- It makes no network calls.
- It exits non-zero when `tickets.json` is missing or invalid.
- CLI: `--graph <dir> [--json]`, using `graph-dir.cjs` resolution.

**Callers and effects:**

- `decompose.md` Step 4, Gate 2 (:465-471): run the seeder right after `validate-graph.cjs` exits 0, then the existing `gsd-sync.cjs` projection write. Codex gets this through the generated skill.
- `gsd-sync.cjs:608`: append a remedy to the blocker, for example `— run node <plugin>/scripts/seed-delivery-state.cjs --graph .planning/graph`. The existing test only matches `/T-01-01: delivery-state\.json has no observation/` (tests/unit/gsd-sync.test.cjs:136), so a suffix keeps it green.
- **The published binding breaks (expected):** `wait-events.cjs:812-814` refuses `RESYNC_REQUIRED` when `delivery-state.json` no longer matches `delivery-state-meta.json.binding.state_digest`. After seeding, the board refuses to wake work until the next state-sync. That is fail-closed and self-healing, because deliver starts with state-sync. Assert it in the seeder test, and state it in `decompose.md`.
- The next state-sync rebuilds every row from GitHub (state-sync.cjs:556), so seeded rows are replaced. **No change to `state-sync.cjs` is needed**, so REQ-159 does not depend on T-40-02/03/19/27.
- `gsd-sync`'s source fingerprint includes `deliveryStateProjection(state, planRecords)` (gsd-sync.cjs:1096-1099). Run the projection write (`gsd-sync.cjs` without `--check`) **after** seeding in the same planning commit.

**Immediate operational note:** the planning PR that adds the ADR-018 tickets needs the same rows before the seeder exists (constraints C-D4). The planner must add `pending` rows for the new ticket ids to `.planning/graph/delivery-state.json`, either by running `state-sync.cjs` (network) or by hand, and then regenerate the gsd-sync projections. Otherwise `make test-gsd-sync` fails CI.

### Anti-patterns to avoid

- **Name allowlists re-typed per host.** Two repo decisions forbid a second copy (base-merge.cjs:154-156). Import the registry, which is built from the `role-artifact.cjs` exports.
- **Using `git status` or `ls-files --exclude-standard` as the only mutation detector** once excludes exist (Pattern 2, consequence 3).
- **Relaxing `--untracked-files` in the role host** instead of snapshotting. That reintroduces RISKS R3.
- **Carry on diff text or patch-id** (ADR-018 out of scope), or with rename detection on.
- **Automatic historical mode** or a silent fallback to it on `STALE_ARTIFACT`. That weakens fail-closed (R7).
- **Seeding by making `gsd-sync` accept missing observations** (rejected in DECISIONS.md:48).
- **Editing test files owned by later phase 40 tickets** (`codex-delivery-host.test.cjs`/`codex-decompose-host.test.cjs` are T-40-09's; `worktree-smoke.sh` is T-40-20's; `sentinel.test.cjs` is T-40-22's; `deliver-seams-contract.test.cjs` is T-40-24's). Add new test files instead, so no extra `depends_on` edge is needed.

## Don't Hand-Roll

| Problem | Don't build | Use instead | Why |
|---------|-------------|-------------|-----|
| Glob ownership of declared files | regex matching | `path-owner.cjs` `parse`/`owns` | The finalizer and scope gate already agree on its semantics |
| Graph location | a new resolver | `graph-dir.cjs resolveGraphDir`/`repoRootOf`/`resolveBaseRef` | T-40-27 already mandates "do not add a second graph locator" (40-27-PLAN.md:43) |
| Scratch names | string literals | `role-artifact.cjs` exports | They are the source of truth for producers |
| Exclude-file location | `$wt/.git/info/exclude` | `git rev-parse --git-path info/exclude` | Verified above; `.git` is a file in linked worktrees |
| Tree comparison | parsing `git diff` text | `git diff-tree -r --no-renames --raw -z --full-index` | Object identity, no rendering surface (gate-trailer.cjs:55-62) |
| Signer resolution | a third copy | move the existing gpg listing (claude-delivery-host.cjs:184-202) into the conditions module | Two copies exist |
| Base fetch refspec | new fetch forms | `+refs/heads/<b>:refs/remotes/origin/<b>` as in `branchOid` (:174-175) and T-40-16 | One grammar |
| Atomic writes | `fs.writeFileSync` on live state | the existing `writeAtomic` pattern (state-sync, dispatch-record) | Interrupted writes must not corrupt state |

## Runtime State Inventory

(This addition consolidates the scratch policy and changes on-disk conventions.)

| Category | Items found | Action required |
|----------|-------------|-----------------|
| Stored data | `delivery-state.json` has no rows for the new ADR-018 ticket ids until state-sync or the seeder runs. Provenance sidecars (after T-40-22) accumulate under `<graphDir>/provenance/`. `.shipyard-role-artifacts/<digest>/` archives accumulate in worktrees. | Hand-seed the rows in the planning PR (code edit plus data). Treat sidecars and archives as host-owned and scratch (registry). There is no migration of existing archives. |
| Live service config | GitHub `merge-gate` statuses after T-40-19. Carried statuses record `base_tree = N`. Existing trailers and statuses keep their meaning. | None. The legacy trailer fallback is T-40-19's. |
| OS-registered state | `.git/info/exclude` in the **common** git dir (repo-global). Existing worktrees created before A6 have no entries. | `create` writes the entries on reuse paths too. `verify` reports missing entries with the remedy `ticket-worktree.sh create …` or the `exclude-lines` append command. |
| Secrets and env vars | `SHIPYARD_GRAPH_DIR` (T-40-15 passes it to hosts; the role host ignores it and uses `options.graphDir` or the worktree graph, claude-role-host.cjs:134-140). `user.signingkey` / `GNUPGHOME`. | No rename. The signing precondition reads the existing keys only. |
| Build artifacts / installed packages | The Claude plugin cache and the Codex bundle (`$CODEX_HOME/shipyard/`, the scripts dir copied wholesale, gen-codex-shipyard.cjs:332-336) with recorded bundle digests. | Reinstall after merge (`make install-shipyard-claude-hook`, `make install-shipyard-codex`; `make doctor` shows drift until then) [CITED: ADR-018:55; constraints C-D7]. |

## Common Pitfalls

### Pitfall 1: T-40-22 makes every arch-review fail (R4)
**What goes wrong:** `recordInflight` writes `dispatches.json` and `provenance/<id>.json` into `<worktree>/.planning/graph`. The post-run check (:796-813) flags them, and the next launch's clean check refuses. **Avoid:** the host-owned set includes `provenance/`; snapshot after `recordInflight`; all roles fill `hostOwnedFiles`; a test runs **two** arch-reviews in one worktree with the real `dispatch-record.cjs` from T-40-22. **Warning sign:** `WORKTREE_MUTATED … .planning/graph/provenance/…`.

### Pitfall 2: excludes blind the post-run check (R3)
See Pattern 2. **Test:** with an exclude entry for `.shipyard-pr-body.md`, a fake arch-review agent that rewrites it must be detected and restored.

### Pitfall 3: stale own evidence sealed as new evidence
`prepareRoleArtifact` unlinks the evidence file before dispatch (role-artifact.cjs:872-915). After the conditions module tolerates scratch, a crashed previous run's evidence would otherwise be rotated silently. **Avoid:** move the untracked file aside into host state (`~/.local/state/shipyard/claude/<key>/moved-aside/<sha256>`) and report `{path, sha256}`. Keep today's rotation for tracked `INTEGRATION.md`. Refuse symlinks and non-regular files with a remedy. **Note:** `validateJudgmentManifest` later re-reads the source evidence and requires it to equal the archive (role-artifact.cjs:1905-1918). The **current** run's evidence must therefore stay in the worktree after seal. Never clean it up post-seal.

### Pitfall 4: short-sha tree in T-40-19's status breaks carry
See Pattern 4. **Warning sign:** carry always refuses with "not the full forty characters".

### Pitfall 5: dirty tracked host-owned graph files block launch
In the Shipyard repository `.planning/graph/*.json` is tracked (the `.gitignore` only excludes the stop-gate ledger, stop-gate-armed and session-observations, `.gitignore:10-15`). `reserveRound` and `recordInflight` modify tracked `dispatches.json` and `delivery-front.json` in the worktree. **Avoid:** the "clean tracked tree" check excludes registry host-owned paths. That is consistent with T-40-16's `WORKTREE_DIRTY` excluding `.planning/graph/` (40-16-PLAN.md:49). base-merge's tracked-only check (base-merge.cjs:167-173) needs the same exclusion.

### Pitfall 6: seeding breaks the published binding
See Pattern 8. It is expected, but it must be visible as `RESYNC_REQUIRED`, not as a silent stale board.

### Pitfall 7: comment policy on shell and JS additions
There are many existing explanatory comments (ticket-worktree.sh:4-34, base-merge.cjs:141-166). Added lines must not follow that style. Run `node plugins/delivery-pipeline/scripts/publish-gate.cjs --base origin/main --working-tree --json` in every ticket.

### Pitfall 8: restore deletes something it should not
**Avoid:** delete only paths that (a) are not in the pre-launch snapshot, (b) resolve inside the worktree realpath after `lstat` of every segment (the `fileText` pattern, :220-237), and (c) are not tracked. Never follow symlinks. Never run `git clean`. The pre-launch check refuses unknown untracked files, so the snapshot set is exactly "registry plus host-owned".

### Pitfall 9: the non-hermetic signing host
The role host tests fail 13/13 under global GPG signing (INV-005 system-state §3). New test files must use T-40-01's hermetic harness (`require('./assert-harness.cjs')`, 40-01-PLAN.md:39) or set their own `GIT_CONFIG_GLOBAL` with `commit.gpgsign=false`. Signing tests inject the gpg runner and never call the real `gpg`.

## Code Examples

### Exclude write inside `ticket-worktree.sh create` (sketch; no comments added)
```bash
exclude_file="$(git -C "$wt_dir" rev-parse --git-path info/exclude)"
case "$exclude_file" in /*) ;; *) exclude_file="$wt_dir/$exclude_file" ;; esac
mkdir -p "$(dirname "$exclude_file")"
touch "$exclude_file"
while IFS= read -r line; do
  [[ -n "$line" ]] || continue
  grep -qxF -- "$line" "$exclude_file" || printf '%s\n' "$line" >> "$exclude_file"
done < <(node "$conditions_script" exclude-lines)
```
Source: the verified probes. In a main (non-linked) checkout, `git rev-parse --git-path info/exclude` prints a path **relative to the cwd** (`.git/info/exclude` at the root, `../.git/info/exclude` from a subdirectory). In a linked worktree it printed an absolute common-dir path. With `git -C "$wt_dir"`, a relative result is relative to `$wt_dir`, hence the `case` guard [VERIFIED: `$TMPDIR` probe output `.git/info/exclude` / `../.git/info/exclude`].

### Delta-identity proof core (sketch)
```js
function rawEntries(git, a, b, paths) {
  const out = git(['diff-tree', '-r', '--no-renames', '--raw', '-z', '--full-index', a, b, ...(paths ? ['--', ...paths] : [])]);
  const fields = out.split('\0'); const entries = new Map();
  for (let i = 0; i + 1 < fields.length; i += 2) {
    const [, oldMode, newMode, oldOid, newOid, status] = /^:(\d+) (\d+) ([0-9a-f]+) ([0-9a-f]+) (\w)/.exec(fields[i]) || [];
    if (!status) throw new Error('unparseable diff-tree record');
    entries.set(fields[i + 1], `${oldMode} ${newMode} ${oldOid} ${newOid} ${status}`);
  }
  return entries;
}
```
Source: a git probe in `$TMPDIR` (a rename of `a`→`c` plus a modification of `b`). With `--no-renames` it printed `:100644 000000 7898…4e85 0000…0000 D|a|:100644 100644 6178…2472 587b…26cb M|b|:000000 100644 0000…0000 7898…4e85 A|c|` (NUL shown as `|`). That confirms the `:<old mode> <new mode> <old oid> <new oid> <status>\0<path>\0` layout, and that a rename becomes D plus A [VERIFIED: probe output]. Compare `rawEntries(J,F)` and `rawEntries(N,T)` as maps. Collect `B` with `--name-only`.

### Draft acceptance (arch-review only)
```js
if (!object(live) || live.number !== pr.number || live.state !== 'OPEN') reject(`PR #${pr.number} is not open — remedy: gh pr view ${pr.number} --json state`, 'STALE_CONTEXT');
if (live.headRefName !== row.branch || live.headRefOid !== canonical.head) reject(`PR #${live.number} head ${live.headRefOid} differs from worktree HEAD ${canonical.head} — remedy: git -C ${canonical.worktree} pull --ff-only origin ${row.branch}`, 'STALE_CONTEXT');
```
Source: claude-role-host.cjs:363-366 restructured. The error code is `[ASSUMED]`; today's refusal uses the default `INVALID_HOST`.

## Proposed ticket slicing (for the planner)

The IDs are placeholders (`A1..A11`); the planner assigns T-40-28+. The `wave` values follow the parent depth.

| # | Title (proposed) | Requirements | files_modified | depends_on | Risk / checkpoint | Wave |
|---|---|---|---|---|---|---|
| A1 | Add the worktree-conditions registry and launch preconditions with copyable remedies | REQ-152 | `plugins/delivery-pipeline/scripts/worktree-conditions.cjs`, `tests/unit/worktree-conditions.test.cjs` | T-40-01 | medium / no | 3 |
| A2 | Accept draft PRs for arch-review and exclude late PRs from a sentinel round | REQ-157, REQ-158 | `plugins/delivery-pipeline/scripts/claude-role-host.cjs`, `tests/unit/claude-role-host.test.cjs`, `tests/unit/sentinel-draft-merge.test.cjs` | T-40-22 | medium / no | 8 |
| A3 | Judge the integrator on the code diff plus a .planning digest summary | REQ-156 | `plugins/delivery-pipeline/scripts/integrator-diff.cjs`, `tests/unit/integrator-diff.test.cjs`, `plugins/delivery-pipeline/scripts/claude-role-host.cjs`, `tests/unit/claude-role-host.test.cjs`, `plugins/delivery-pipeline/references/integrator.md` | A2 | medium / no | 9 |
| A4 | Check worktree conditions in the role host and restore out-of-scope role mutations | REQ-152, REQ-154 | `plugins/delivery-pipeline/scripts/claude-role-host.cjs`, `tests/unit/claude-role-host.test.cjs` | A3, A1 | high / yes (a destructive restore) | 10 |
| A5 | Check worktree conditions in the delivery and decompose hosts on Claude and Codex | REQ-152, REQ-154 | `plugins/delivery-pipeline/scripts/claude-delivery-host.cjs`, `plugins/delivery-pipeline/scripts/codex-delivery-host.cjs`, `plugins/delivery-pipeline/scripts/claude-decompose-host.cjs`, `plugins/delivery-pipeline/scripts/codex-decompose-host.cjs`, `tests/unit/worktree-conditions-hosts.test.cjs` | T-40-11, A1 | high / yes | 8 |
| A6 | Prepare ticket worktrees with scratch excludes and a verify subcommand | REQ-153, REQ-152 | `plugins/delivery-pipeline/scripts/ticket-worktree.sh`, `plugins/delivery-pipeline/scripts/delivery-commit-finalizer.cjs`, `plugins/delivery-pipeline/scripts/base-merge.cjs`, `tests/unit/ticket-worktree-conditions.test.cjs` | T-40-27, A1 | medium / no | 7 |
| A7 | Carry a conform verdict across a disjoint sibling merge on a tree-object proof | REQ-151 | `plugins/delivery-pipeline/scripts/carry-proof.cjs`, `tests/unit/carry-proof.test.cjs`, `plugins/delivery-pipeline/scripts/gate-trailer.cjs`, `tests/unit/trailer.test.cjs` | T-40-19 | high / yes (merge gate) | 4 |
| A8 | Validate executor artifacts against their recorded base in historical mode | REQ-155 | `plugins/delivery-pipeline/scripts/role-artifact.cjs`, `tests/unit/role-artifact.test.cjs` | T-40-18 | high / yes (it relaxes a fail-closed check) | 6 |
| A9 | Document worktree conditions, historical publication and sibling carry in deliver | REQ-155, REQ-152, REQ-153, REQ-151 | `plugins/delivery-pipeline/commands/deliver.md`, `tests/unit/deliver-worktree-conditions-contract.test.cjs` | T-40-24, A6, A8 | low / no | 9 |
| A10 | Write pending delivery observations for new tickets during planning | REQ-159 | `plugins/delivery-pipeline/scripts/seed-delivery-state.cjs`, `tests/unit/seed-delivery-state.test.cjs`, `plugins/delivery-pipeline/commands/decompose.md`, `plugins/delivery-pipeline/scripts/gsd-sync.cjs` | T-40-25 | low / no | 7 |
| A11 (optional) | Refuse at the dispatch entry point when worktree conditions fail | REQ-152 | `plugins/delivery-pipeline/scripts/deliver-dispatch.cjs`, `tests/unit/deliver-dispatch-conditions.test.cjs` | T-40-15, A1 | low / no | 8 |

**Why this order:**

- **Role-host chain T-40-22 → A2 → A3 → A4.** All four edit `claude-role-host.cjs` and its test, so they must be totally ordered. A2 comes first because it removes the draft contradiction that blocks **every** arch-review in phase 40's own delivery. Until A2 is merged **and** the conveyor runs a build containing it (a dogfood install, T-40-21), the manual workaround remains. A3 is next because the phase 40 epic itself needs the scoped integrator (R1/R2). A4 is last because it is the largest and has the highest risk. Other orders are valid for Gate 2.
- **A1 is a root after T-40-01** because it only uses T-40-01's hermetic harness. It imports `role-artifact.cjs` constants **read-only**, and T-40-18 does not change them.
- **A5 → T-40-11.** T-40-11 is the last writer of `codex-decompose-host.cjs`, and its ancestry covers T-40-14 (both delivery hosts), T-40-12, T-40-13 and T-40-10 (`claude-decompose-host.cjs`) [VERIFIED: frontmatter; T-40-11 depends `[T-40-04, T-40-14, …]`, T-40-14 → T-40-12 → T-40-13 → T-40-10]. A new test file avoids T-40-09's two test files.
- **A6 → T-40-27.** T-40-27 is the last writer of `ticket-worktree.sh` and `delivery-commit-finalizer.cjs` (its chain includes T-40-18). `base-merge.cjs` has no phase 40 writer (T-40-19 and T-40-27 only read it).
- **A7 → T-40-19.** It is the only writer of `gate-trailer.cjs` and `trailer.test.cjs`. T-40-22 edits `sentinel.cjs`, not these files.
- **A8 → T-40-18.** It is the only writer of `role-artifact.cjs` and `role-artifact.test.cjs`.
- **A9 → T-40-24.** T-40-24 is the only writer of `deliver.md`. A6 and A8 are needed because the contract test checks the `verify` subcommand and the `--historical` wording against real behaviour. A7 is optional there, because base-merge already names the carry.
- **A10 → T-40-25.** T-40-25 is the only writer of `decompose.md`. `gsd-sync.cjs` has no phase 40 writer. **No `state-sync.cjs` edit**, so no edge to T-40-02/03/19/27.
- **Diamond children** (two or more same-phase parents: A4, A5, A6, A9, A11) follow T-40-27's operating precondition: they are dispatched only after T-40-27 is in the epic and in the running build (40-27-PLAN.md:34).
- **Cross-file overlap check among the new tickets:** only A2, A3 and A4 share files (chained). A6 owns `base-merge.cjs` and A7 does not touch it. A1 creates only new files. There are no other overlaps.

**Sharing and splitting guidance:** REQ-157 and REQ-158 share A2, because both are small edits to the live-PR revalidation of one file. REQ-152 must be split across A1, A4, A5 and A6, because it spans files owned by five different phase 40 tickets. REQ-154 rides with each host's wiring (A4 Claude, A5 Codex). REQ-155 splits code (A8) from prose (A9), because their owning tickets are in different waves.

## Tests to write first (RED), per ticket

| Ticket | RED tests (they must fail first) |
|---|---|
| A1 | registry names equal the `role-artifact.cjs` exports; a tracked file under `.shipyard-role-artifacts/` is `trackedDirty`, not scratch; each precondition refuses with a `remedy` containing an absolute-path command; the executor profile refuses a plan outside the worktree; signing is refused with an injected gpg runner returning 0 or 2 secret keys; base freshness refuses when fetch fails (injected runner); `exclude-lines` output is sorted and stable; the `verify` CLI exit codes and `--json` shape |
| A2 | arch-review with `isDraft: true` seals conform; arch-review revalidation passes when the PR becomes a draft or undraft mid-run; **sentinel merge on a draft PR blocks** (new file); a non-member opens a PR mid-round and the round seals with an unchanged ticket set; a member gains a second PR and expires; a gh non-array for a non-member → `STALE_CONTEXT` |
| A3 | the fixture epic with a large `.planning` diff and a small code diff passes; `combined_diff.content` holds no `.planning/` or `.shipyard-role-artifacts/` hunks; `planning_changes` lists name-status plus full blob ids, sorted; a code diff > 1 MiB refuses with the measure command in the message; untracked `.planning` gives an empty summary |
| A4 | **two arch-reviews in one worktree both succeed** (with T-40-22's real sidecar and in-flight rows); a stale untracked own evidence file is moved aside with its digest reported, never sealed; a fake agent editing a tracked file, creating an untracked file and rewriting an excluded scratch file → `WORKTREE_MUTATED`, and after the throw the worktree is clean with `details.restored` listing all three; a mutation on the failure path (`badEvidence`) is also restored; a symlink planted by the agent is removed without following it |
| A5 | the Claude executor refuses a plan outside the worktree with a remedy; the Codex executor tolerates registry scratch and refuses unknown untracked files; the Codex judgment role (arch-review) mutation is restored; both hosts share one signer function (the injected runner is called once per preflight); the decompose hosts check that host state is outside the worktree via the module |
| A6 | `create` writes the exclude lines once (a second `create`/reuse adds nothing), and stdout is only the path; scratch files are invisible to `git status` afterwards; `verify` passes on a clean worktree and refuses a tracked dirty file with the remedy; the finalizer ignores all registry scratch (not only two names); base-merge tolerates dirty host-owned graph files and still refuses a dirty source file |
| A7 | a disjoint sibling merge carries; a sibling touching a ticket-changed path refuses; a sibling touching a declared-only path refuses, including a glob declaration; a conflict resolution on a ticket path refuses; an unrelated rename carries and a rename onto a ticket path refuses; a no-content merge still carries; an abbreviated `base_tree` refuses; the **status description** with worst-case values is ≤ 140 characters and holds a 40-hex `base_tree`; the carried status on `to` records `base_tree = N` |
| A8 | a fresh executor artifact after the epic moves: non-historical → `STALE_ARTIFACT`, historical → valid with `historical: true`; historical with a recorded base not an ancestor of HEAD → `STALE_ARTIFACT`; historical with a tampered `base_tree` → `STALE_ARTIFACT`; a head change still fails in historical mode |
| A9 | `deliver.md` executor `validate` and `read` lines contain `--historical`; names `ticket-worktree.sh verify` and `worktree-conditions.cjs`; states that arch-review runs on drafts and undraft follows conform; every `scripts/<name>` it names exists |
| A10 | seeding adds `{branch, pr:null, status:'pending'}` only for absent ids; existing rows are byte-preserved; a second run is byte-identical; no `gh` on `PATH` is needed (PATH stripped); after seeding, `gsd-sync --check` on the fixture has no "has no observation" blocker; `wait-events` then reports `RESYNC_REQUIRED`; `decompose.md` names the seeder after `validate-graph.cjs` |

## Scoped verification commands (per ticket)

Every ticket also runs `node plugins/delivery-pipeline/scripts/publish-gate.cjs --base origin/main --working-tree --json` (comment policy).

- **A1:** `node --check plugins/delivery-pipeline/scripts/worktree-conditions.cjs`; `node tests/unit/worktree-conditions.test.cjs`
- **A2:** `node --check plugins/delivery-pipeline/scripts/claude-role-host.cjs`; `node tests/unit/claude-role-host.test.cjs`; `node tests/unit/sentinel-draft-merge.test.cjs`
- **A3:** `node --check plugins/delivery-pipeline/scripts/integrator-diff.cjs`; `node tests/unit/integrator-diff.test.cjs`; `node tests/unit/claude-role-host.test.cjs`; `node tests/unit/source-contract.test.cjs` (reference contract)
- **A4:** `node tests/unit/claude-role-host.test.cjs`; `node tests/unit/worktree-conditions.test.cjs`; `node tests/unit/dispatch-record.test.cjs` (read-only guard for the T-40-22 sidecar)
- **A5:** `node --check` on the four hosts; `node tests/unit/worktree-conditions-hosts.test.cjs`; `node tests/unit/claude-delivery-host.test.cjs`; `node tests/unit/codex-delivery-host.test.cjs`; `node tests/unit/codex-decompose-host.test.cjs` (read-only regression)
- **A6:** `bash -n plugins/delivery-pipeline/scripts/ticket-worktree.sh`; `node --check plugins/delivery-pipeline/scripts/delivery-commit-finalizer.cjs plugins/delivery-pipeline/scripts/base-merge.cjs`; `node tests/unit/ticket-worktree-conditions.test.cjs`; `node tests/unit/delivery-commit-finalizer.test.cjs`; `node tests/unit/diamond-worktree.test.cjs` (T-40-27 regression). `bash tests/smoke/worktree-smoke.sh` is CI-only (long).
- **A7:** `node --check plugins/delivery-pipeline/scripts/carry-proof.cjs plugins/delivery-pipeline/scripts/gate-trailer.cjs`; `node tests/unit/carry-proof.test.cjs`; `node tests/unit/trailer.test.cjs`. `bash tests/smoke/sentinel-smoke.sh` is CI-only.
- **A8:** `node --check plugins/delivery-pipeline/scripts/role-artifact.cjs`; `node tests/unit/role-artifact.test.cjs`
- **A9:** `node tests/unit/deliver-worktree-conditions-contract.test.cjs`; `node tests/unit/deliver-seams-contract.test.cjs`; `node tests/unit/orchestration-overhead.test.cjs`
- **A10:** `node --check plugins/delivery-pipeline/scripts/seed-delivery-state.cjs`; `node tests/unit/seed-delivery-state.test.cjs`; `node tests/unit/gsd-sync.test.cjs`; `node tests/unit/gsd-sync-gate.test.cjs`
- **A11:** `node tests/unit/deliver-dispatch-conditions.test.cjs`; `node tests/unit/deliver-dispatch.test.cjs`

**Codex parity check (CI or the operator, not per-attempt):** `make install-shipyard-codex` then `make test-codex-shipyard`. This needs the npm registry (CLAUDE.md:49-50). `make doctor` confirms the installed cache matches the source.

## Codex parity summary

| Req | Claude path | Codex path | Parity mechanism |
|---|---|---|---|
| 151 | `base-merge.cjs` → `gate-trailer.cjs carry` | same scripts | shared script |
| 152 | role host, delivery host, decompose host | `codex-delivery-host.cjs` (**all roles**, not only executor, :309-310), `codex-decompose-host.cjs` | shared module (A5) |
| 153 | `ticket-worktree.sh` | same | shared script |
| 154 | role host restore (A4) | `codex-delivery-host.cjs` snapshot/restore for judgment roles (A5) | shared helpers |
| 155 | `deliver.md` → `role-artifact.cjs --historical` | the generated Codex skill from the same prose | regenerate the bundle |
| 156 | role host imports `integrator-diff.cjs` | `references/integrator.md` names the CLI; Codex has no packet bounds (C-P5) | shared script plus reference |
| 157 | role host | not applicable: Codex arch-review has no draft check; `sentinel.cjs merge` is shared | — |
| 158 | role host round revalidation | not applicable: the Codex host has no round snapshot | — |
| 159 | `decompose.md` plus seeder | the generated Codex decompose skill plus the same seeder | regenerate the bundle |

## State of the Art

| Old approach | Current approach | When changed | Impact |
|---|---|---|---|
| Four scratch policies, and the role host refuses all | one registry plus profiles | ADR-018 | A second role in the same worktree works |
| Carry only on equal head and base trees | delta identity plus disjoint base move | ADR-018 on T-40-19 | Parallel arch-reviews survive disjoint sibling merges |
| Executor artifacts bound to the live base | historical validation at publication | ADR-018 | No re-dispatch after an epic move |
| Integrator on the full epic diff | code diff plus `.planning` digest | ADR-018 | The integrator can run on planning-heavy epics |

## Assumptions Log

| # | Claim | Section | Risk if wrong |
|---|---|---|---|
| A1 | Target-project plan materialization: `ticket-worktree.sh create` copies the ticket plan into the gitignored worktree `.planning/` | Pattern 1 | Every target-project executor refuses "plan outside worktree"; needs a user decision |
| A2 | `pr-ledger.json` belongs in the host-owned set | Pattern 1 | A false `WORKTREE_MUTATED`, or a missed tamper |
| A3 | HEAD or branch restore via compare-and-swap `update-ref` plus `reset --keep` is in REQ-154 scope | Pattern 3 | The scope expands into a destructive git operation; checkpoint |
| A4 | The Codex pr-sentinel's allowed set is evidence plus host-owned graph files | Pattern 3 | Legitimate sentinel writes are refused on Codex |
| A5 | A 140-character status description can hold a full `base_tree` with the key set listed | Pattern 4 | The carry cannot be expressed on the T-40-19 carrier; an alternative store is needed |
| A7 | The integrator bound remedy wording ("split the phase / integrate in two steps") | Pattern 6 | An unhelpful refusal; needs operator wording |
| A8 | Draft/identity refusal code names | Code examples | Cosmetic |
| A10 | Excluding `.shipyard-role-artifacts/` repo-wide is acceptable despite committed phase evidence in Shipyard | Pattern 2 | Committing new evidence needs `git add -f`; operator decision |

## Open Questions

1. **How does the plan reach a target-project ticket worktree?**
   - Known: `.planning/` is untracked in targets (D-16), and restricted children cannot read outside the worktree (OPEN-QUESTIONS.md:14, measured in phase 39).
   - Unclear: who materializes the plan, and whether the graph must be inside the worktree for executors.
   - Recommendation: `ticket-worktree.sh create` copies the plan file; the host verifies its sha256; the graph stays host-side. Confirm with the user before A1 and A6.
2. **Does the T-40-19 description format allow a full `base_tree`?** Resolve when T-40-19 lands. The A7 test enforces it. If it does not fit, store the judged base tree in the status `target_url` or a host-owned ledger. That needs a decision.
3. **Should `.shipyard-role-artifacts/` be excluded repo-wide?** The Shipyard repository deliberately commits phase evidence there (commit `22397b76`). Default: exclude, and document `git add -f` for evidence commits.
4. **REQ-157 operational gap.** Until A2 is in a running build, phase 40's own arch-reviews on draft PRs refuse. ADR-018 locks "depend after" (T-40-22 is wave 7). The operator must use the phase 39 workaround until then.
5. **Is the entry-point early check (A11) wanted?** The hosts already refuse. A11 only improves synchronous feedback for detached launches.

## Environment Availability

| Dependency | Required by | Available | Version | Fallback |
|---|---|---|---|---|
| node | all | ✓ | v24.10.0 (CI 24.15.0) | — |
| git | all; `diff-tree`, `--git-path` | ✓ | 2.54.0 | — |
| gh | runtime only (tests stub it) | ✓ (present; sandbox auth untested) | — | stubs on `PATH` in tests |
| gpg | signing precondition at runtime | ✓ (present) | — | tests inject the runner; no real gpg in tests |
| npm registry | `make test-codex-shipyard` | not probed | — | CI-only |

**Missing dependencies with no fallback:** none for unit verification.

## Validation Architecture

### Test framework
| Property | Value |
|---|---|
| Framework | Node built-in `node:test` plus `node:assert/strict`; `tests/unit/assert-harness.cjs` (hermetic git after T-40-01) |
| Config file | none. `tests/unit/run.sh` discovers `tests/unit/*.test.cjs` |
| Quick run command | `node tests/unit/<file>.test.cjs` |
| Full suite command | `make test-fast` (CI) |

### Phase requirements → test map
| Req ID | Behavior | Test type | Automated command | File exists? |
|---|---|---|---|---|
| REQ-151 | disjoint sibling carry; overlap refuses; full base_tree ≤140 characters | unit (hermetic git plus stub gh) | `node tests/unit/carry-proof.test.cjs && node tests/unit/trailer.test.cjs` | ❌ Wave 0 (carry-proof); trailer ✅ |
| REQ-152 | registry plus preconditions plus remedies; each host calls it | unit | `node tests/unit/worktree-conditions.test.cjs && node tests/unit/worktree-conditions-hosts.test.cjs && node tests/unit/claude-role-host.test.cjs` | ❌ Wave 0 (two new) |
| REQ-153 | excludes written once; verify exit codes | unit (bare origin plus clone) | `node tests/unit/ticket-worktree-conditions.test.cjs` | ❌ Wave 0 |
| REQ-154 | mutation restored, reported, refused (Claude plus Codex) | unit | `node tests/unit/claude-role-host.test.cjs && node tests/unit/worktree-conditions-hosts.test.cjs` | ✅ / ❌ |
| REQ-155 | historical executor validation | unit | `node tests/unit/role-artifact.test.cjs` | ✅ |
| REQ-156 | scoped diff plus summary plus named refusal | unit | `node tests/unit/integrator-diff.test.cjs && node tests/unit/claude-role-host.test.cjs` | ❌ Wave 0 |
| REQ-157 | draft accepted for arch-review; merge refuses drafts | unit | `node tests/unit/claude-role-host.test.cjs && node tests/unit/sentinel-draft-merge.test.cjs` | ❌ Wave 0 (sentinel-draft-merge) |
| REQ-158 | late PRs excluded; members expire | unit | `node tests/unit/claude-role-host.test.cjs` | ✅ |
| REQ-159 | offline deterministic seeding; gsd-sync passes | unit | `node tests/unit/seed-delivery-state.test.cjs && node tests/unit/gsd-sync.test.cjs` | ❌ Wave 0 |

### Sampling rate
- **Per task commit:** the ticket's scoped commands above.
- **Per wave merge:** `make test-fast`.
- **Phase gate:** full suite green, plus human checkpoints for A4, A5, A7 and A8, before `/gsd-verify-work`.

### Wave 0 gaps
- [ ] `tests/unit/worktree-conditions.test.cjs`: REQ-152
- [ ] `tests/unit/worktree-conditions-hosts.test.cjs`: REQ-152, REQ-154
- [ ] `tests/unit/ticket-worktree-conditions.test.cjs`: REQ-153
- [ ] `tests/unit/carry-proof.test.cjs`: REQ-151
- [ ] `tests/unit/integrator-diff.test.cjs`: REQ-156
- [ ] `tests/unit/sentinel-draft-merge.test.cjs`: REQ-157
- [ ] `tests/unit/seed-delivery-state.test.cjs`: REQ-159
- [ ] `tests/unit/deliver-worktree-conditions-contract.test.cjs`: REQ-155 prose, REQ-152/153 prose
- The framework is already present. Hermeticity comes from T-40-01, which is in A1's ancestry and, transitively, in most others.

## Security Domain

`security_enforcement: true`, ASVS level 1 [VERIFIED: `.planning/config.json` workflow].

### Applicable ASVS categories
| ASVS category | Applies | Standard control |
|---|---|---|
| V2 Authentication | no | — |
| V3 Session management | no | — |
| V4 Access control | yes | Worktree containment (realpath plus per-segment `lstat`, the `fileText` pattern). Host state outside the worktree (`stateRootOutsideWorktree`, codex-delivery-host.cjs:147-163). |
| V5 Input validation | yes | Safe branch grammar (`safeBranch`, claude-role-host.cjs:161-167), 40-hex object ids (`TREE_SHA`), bounded JSON reads, NUL-separated git output (`-z`) |
| V6 Cryptography | limited | Content identity via git object ids and sha256 (node `crypto`). Signer fingerprints via gpg. Never hand-roll. |
| V12 Files and resources | yes | Never follow symlinks on restore or delete; bounded snapshot sizes; atomic writes |

### Known threat patterns for this stack
| Pattern | STRIDE | Standard mitigation |
|---|---|---|
| A role forges host-owned files (in-flight rows, sidecars) to silence the stop gate or fake provenance | Spoofing / Tampering | Byte snapshot before launch, exact compare and restore after; only a live pid within TTL counts (T-40-14) |
| A role hides a write inside excluded scratch | Tampering | `lstat`/digest snapshot independent of `info/exclude` (Pitfall 2) |
| Symlink or path-traversal during restore deletes outside the worktree | Elevation / Tampering | Per-segment `lstat`, realpath containment, unlink only non-snapshotted untracked entries, no `git clean` |
| Verdict carried onto unjudged content | Tampering | Delta identity on tree entries plus declared-path disjointness; exact 40-hex; refuse on any doubt |
| A stale executor artifact published after an unsafe rebase | Tampering | Historical mode also requires the recorded base to be an ancestor of HEAD and head equality; merge gates enforce freshness |
| Command injection through branch or path values | Tampering | `execFileSync` argument arrays only; safe-ref grammar; `--` before pathspecs |
| A seeder masking a real missing observation | Repudiation | Only absent ids get `pending`; existing rows untouched; the binding refusal (`RESYNC_REQUIRED`) stays visible |

## Sources

### Primary (HIGH: read this session)
- `.planning/architecture/ADR-018-worktree-conditions-and-residual-seams.md` and its ingest copy; `.planning/investigations/INV-005-worktree-and-residual-seams/{RESEARCH,DECISIONS,RISKS,OPTIONS,OPEN-QUESTIONS}.md`; `research/{system-state,constraints,alternatives}.md` (line evidence)
- `.planning/REQUIREMENTS.md:160-168`
- Phase 40 plans 01, 02, 06, 09, 14, 15, 16, 17, 18, 19, 20, 22, 24, 25, 27 (full or frontmatter); 40-CONTEXT.md D-16, D-30..D-33
- Code: `claude-role-host.cjs` (whole file), `role-artifact.cjs` (:25-49, 186-245, 515-965, 1500-1524, 1767-1920, 2174-2178, 2233-2327, 2530-2710), `gate-trailer.cjs` (:1-180, 380-578), `codex-delivery-host.cjs` (:1-372), `claude-delivery-host.cjs` (:140-330, 595-640), `delivery-commit-finalizer.cjs` (:1-80), `base-merge.cjs` (:120-229), `ticket-worktree.sh` (:1-45, 195-315 plus grep), `gsd-sync.cjs` (:580-630, 1068-1107), `state-sync.cjs` (:120-150, 1100-1170), `wait-events.cjs` (:795-829), `graph-dir.cjs` (:1-66), `refusal-hints.cjs`, `comment-policy.cjs` (:8-39), `sentinel.cjs` (:912-923), `dispatch-record.cjs` (:1148-1152), `context-packet.cjs` (grep), `run-rollout.cjs` (:28-47), `tests/unit/claude-role-host.test.cjs` (:1-310 plus test list), `tests/unit/source-contract.test.cjs` (:430-469, 1986-1998), `tests/unit/run.sh`, `Makefile`, `CLAUDE.md`, `.shipyard/generated/gsd-delivery-rules/SKILL.md`
- The git probe on `info/exclude` in a linked worktree (output pasted in Pattern 2)

### Secondary (MEDIUM)
- INV-005 measurements of the epic 39 diff sizes (not re-run; local refs only, per INV-005 S0.8)

### Tertiary (LOW)
- None. The `diff-tree --raw -z` layout and the `--git-path` behaviour were confirmed by probes this session.

## Metadata

**Confidence breakdown:**
- File overlap and dependency edges: HIGH. Every plan's frontmatter was read with grep, and the key plans were read in full.
- Code locations and current behaviour: HIGH. The relevant functions were read this session.
- Proof design (REQ-151) and restore design (REQ-154): MEDIUM. They are sound on paper, and the RED fixtures listed must confirm them.
- Target-project plan materialization and the T-40-19 description budget: LOW. They are open questions.

**Research date:** 2026-09-25
**Valid until:** until the first of T-40-16, T-40-18, T-40-19 or T-40-22 merges. Line numbers will move then, so re-anchor by function name.
