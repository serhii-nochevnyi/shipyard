# INV-004 — Research line: system state

- Line: `system-state` (→ RESEARCH.md "Current system state")
- Selection: claude-opus-5-5 / medium. Policy signals (DATA, preserved verbatim): `{"type":"facts"}`
- Source revision: `8c264020707b67933cf109f0578c652fc8a1cb41` (branch `inv/004-phase39-delivery-retro`)
- Worktree: `/Volumes/KINGSTON/.wt-claude-shipyard/inv-004`. All commands below ran from there.
- `.planning/codebase/` maps: **none** (`ls .planning/codebase` → "No such file or directory"), so everything was checked directly in source.

## 0. Deployment and branch state (hypothesis #1)

| Claim | Command | Result |
|---|---|---|
| Product code at HEAD matches the 0.61.0 release | `git diff --stat befc970c HEAD -- plugins scripts tests Makefile` | empty output. HEAD only adds planning files on top of 0.61.0 (`befc970c`, PR #201). |
| `origin/main` is the 0.61.0 release | `git log --oneline -6 origin/main` | tip `befc970c Merge pull request #201 … release/version-0.61.0` |
| epic/39 holds planning only | `git log --oneline -12 origin/epic/39-remove-conveyor-session-friction` | tip `5b56a747` (#203 planning). 15 commits ahead of main (`git rev-list --count origin/main..<epic>` = 15). No ticket merge. |
| **No T-39 ticket is merged into epic/39 or main** | loop `git merge-base --is-ancestor <ticket> <epic>` over `git branch -r \| grep T-39` | `merged=n` for T-39-01..07 and T-39-12. The ticket branches are 1–5 commits ahead. T-39-12 tip `08e0927b` (2026-09-24 18:40 +03:00). Branches for T-39-08..11 do not exist on the remote. |
| Remote refs may be stale | `git fetch --dry-run` | failed: `ssh_dispatch_run_fatal … Broken pipe`. Refs are as last fetched. |
| PR states | `gh pr list …` | **blocked**: sandbox denies `~/.config/gh/config.yml`. PR #205–#208 states are **unknown**. Next check: `gh pr view 205..208 --json state,mergedAt` outside the sandbox. |
| The installed Claude plugin is 0.61.0 at `befc970c` | `grep -A8 '"shipyard@' ~/.claude/plugins/installed_plugins.json` | `version 0.61.0`, `gitCommitSha befc970c…`, installedAt 2026-09-24T10:43:56Z |
| **The installed cache is patched with unmerged T-39-12 code** (N9) | `cmp` of cache files against `git show befc970c:…` and `git show origin/ticket/T-39-12…:…` | `claude-runtime-host.cjs`, `claude-dispatch-adapter.cjs`, `claude-role-host.cjs`: **differ from release, identical to T-39-12 tip**. Each `*.pre-T-39-12.bak` is identical to the release (`ls -la …/0.61.0/scripts`: bak files 13:43; patched files 17:55 and 18:22 local time). |

**Consequences:**

- Every phase 39 fix (T-39-01..12) is **absent** from main, the epic, and any release.
- The only place the T-39-12 code runs is the hand-patched cache, which matches no release.
- The evidence understated N9: `claude-role-host.cjs` is patched too (`.bak` exists), not just the two files listed.

## 1. Architecture of the affected part (today, 0.61.0)

**Claude delivery path:**

1. `commands/deliver.md` Step 3 orchestrator prose
2. The model hand-assembles a JSON request `shipyard.claude-delivery-request.v1` `{schema, scope, args}` (`claude-delivery-host.cjs:19`, `readRequest` `:874-886`)
3. `claude-delivery-host.cjs --workflow <executors|fix-round|drift-gate|investigation-research> --request-file` (`parseCli` `:865-872`)
4. `createRunScope` + `createRunController` (`:924-938`)
5. `createClaudeDeliveryHost` (`:716-863`) → `registerClaudeWorkflowHost` → workflow `.mjs` (`workflows/executors.mjs`, `investigation-research.mjs`, …)
6. `claude-dispatch-adapter.cjs` → `claude-runtime-host.cjs` spawns `claude --print …`
7. `dispatch-boundary.cjs` verifies the receipt (`finalizeApplicationReceipt` `:1480-1493`)
8. The artifact consumer seals it (`role-artifact.cjs`, `sealPlanningResearch` `:506-572`)

Other Claude entry points:

- PR sentinel: `claude-role-host.cjs --args-file`, request `shipyard.claude-role-request.v1` (`deliver.md:2033-2041`).
- Board: `front.cjs computeFront` (`:351`).
- Dispatch ownership: `dispatch-record.cjs mark|clear|reserveRound`.
- Stop hook: `stop-gate.cjs`.
- Pre-push hook: `scripts/shipyard-pre-push-gate.sh` → `publish-gate.cjs`.

**Codex path:**

- `codex-delivery-host.cjs --args-file`, `codex-decompose-host.cjs --args-file`, `codex-runtime-host.cjs` (parent `codex exec` → `spawn_agent` child), `codex-agent.cjs`, `gsd-tune.cjs`.
- Install: `scripts/install-shipyard-codex.sh` + `scripts/gen-codex-shipyard.cjs`.
- Doctor: `scripts/shipyard-doctor.cjs`.

## 2. Per-item findings

### Item 0 — boundary fixtures are invented (systemic)

- At HEAD, the Claude runtime host does not forward `--json-schema`. `grep -c -- '--json-schema' plugins/delivery-pipeline/scripts/claude-runtime-host.cjs` → `0`.
- `normalizeScope` is at `claude-runtime-host.cjs:120`. The text check `must be non-empty text` is at `:67`.
- Unit tests stub the CLI with hand-written `spawn:` closures (`grep -n "spawn" tests/unit/claude-runtime-host.test.cjs` → `:194, :268, :298, :323, :348, :377, :422`).
- The only Claude fixture, `tests/fixtures/claude-assistant-session.jsonl`, is 6 lines with a synthetic `session_id` `11111111-…` (`head -c 300`). `grep -c '"structured_output"\|"type":"result"'` → `0`. It came from `98556be3` (#191, 2026-09-23).
- **The T-39-12 fixes keep the same pattern.**
  - `git show "origin/ticket/T-39-12…:tests/unit/claude-runtime-host.test.cjs" | grep -c structured_output` → `0`. Its new tests assert argv shape (`:316-330`, `args.includes('--json-schema')`).
  - The workflow-host test feeds a synthetic `{status, summary, output}` (`claude-workflow-host.test.cjs:138-145`).
  - `git diff befc970c <T-39-12> --stat -- tests/fixtures` → empty: no captured producer output was added.
- So item 0 is still unaddressed after T-39-12. Assumption, not checked: no test anywhere spawns a real `claude` binary. Next check: `grep -rn "spawn('claude'\|execFileSync('claude'" tests`.

### Item 1 — stop gate fires while dispatches are in flight

- `deliver.md:1826`: "**Record the dispatch — AFTER the boundary returned a verified receipt, never before.**"
- `dispatch-record.cjs mark` with `--boundary-store` requires `--dispatch-id` naming "the receipt the boundary recorded after launch" (`:508-516`). A routed mark without a receipt is refused (`:850-857`).
- `runClaudeDeliveryCli` awaits the whole workflow before returning (`claude-delivery-host.cjs:903-945`, `await createClaudeDeliveryHost(...)`). So the CLI caller gets the dispatch id and receipt only when the executor finishes.
- `stop-gate.cjs` only treats a dispatch as live through `front.waiting.dispatched` (`:552`, `:582`). Its comments admit the mark may lag or lead the launch (`:167-170`, `:443-445`).
- **Exception:** the sentinel path reserves before launch (`claude-role-host.cjs:748` `reserveRound`, `:959` `recordRound`, `:987` `clearRound`). That pre-launch reservation pattern already exists and could be reused for executors.
- Overlap: T-39-03 (session-scoped stop gate, branch `…T-39-03…`, unmerged) changes *when* the gate enforces, not the mark timing. Assumption; next check: `git diff origin/epic/39… origin/ticket/T-39-03… -- plugins/delivery-pipeline/scripts/stop-gate.cjs`.

### Item 2 — no deterministic front → dispatch entry point

- `grep -rln "claude-delivery-request.v1" plugins scripts tests` → only `claude-delivery-host.cjs`. **No script produces the request.** `front.cjs` exports board computation only (`grep -n "^function \|module.exports" front.cjs`: `computeFront`, `formatFront`, …, no request builder).
- `deliver.md:1710-1741` asks the model to assemble `executors.mjs args` and call `buildContextPacket` itself.
- The host validates rather than derives:
  - `graphTicket` checks the branch against the graph (`:198-212`).
  - `canonicalPlan` requires `realpath(planPath) === <graph dir>/../../<row.plan>` (`:214-221`). That explains the `planPath` failure [1011]: the path must resolve relative to the ticket worktree's graph.
  - `assertScopedWork` checks worktree equality (`:80-100`).
- The CLI accepts exactly one ticket (`cliDispatch` `:888-900`). A 4-ticket wave therefore needs four processes, and the doc has no launch/monitor helper. `grep -n -i "nohup\|background" deliver.md` finds only sentinel background prose (`:291-326`).

### Item 3 — `resolveDispatch` rejects `signals.type: "implementation"`

- The refusal is at `model-policy-internal.cjs:422-424` (`normalizeSignals`): only `facts|alternatives` are allowed. (The evidence cites `:355`; the line is `:423` in 0.61.0 source.) `pipeline-config.cjs:1664` wraps it.
- **Correction to the problem statement:** the graph carries no `signals` object.
  - `.planning/graph/tickets.json` has a ticket-level `"type"`. `grep -o '"type": *"[a-z]*"' … | sort | uniq -c` → 144 `implementation`, 14 `execute`. Example: T-39-12 `"type": "implementation"` at `tickets.json:5464`.
- **The root cause is doc ↔ resolver contradiction.** `deliver.md:1711-1713` tells the orchestrator to "Pass the complete ticket evidence — `risk`, `type`, … — as `signals`". `deliver.md:2152`, `:2208`, `:2251` also list `type` inside `signals`. The resolver refuses any ticket type.
- The tests pin both sides. `grep -c '"type": "implementation"'`: `tests/unit/pipeline-config.test.cjs` 2, `tests/unit/claude-role-host.test.cjs` 2, `tests/unit/model-policy.test.cjs` 1. Next check: read those assertions to see whether they expect refusal.

### Item 4 — sentinel has undocumented preconditions

- Base check: `branchOid` in `claude-role-host.cjs:168-188`.
  - It fetches `origin/<name>`. When an expected oid is given, a fetch failure is **swallowed** (`:176`).
  - It then accepts `origin/X` or local `X` only at the exact live `baseRefOid`. Otherwise it refuses with `base branch … is missing or differs from its live GitHub revision` (`:187`).
  - Hypothesis, unverified: in session 7bcbbf57 the fetch failed silently, so the stale local/remote-tracking ref was compared. Next check: the transcript around [1323] for fetch stderr.
- PR identity: `prepareSentinel` (`:485-520`) requires `delivery-state.json` `head_sha`/`pr_base` to equal the live PR (`:510-514`). Only `state-sync.cjs` updates `head_sha` (`state-sync.cjs:587`). So every push or base merge needs a state-sync first.
- `deliver.md:2033` requires "a clean phase worktree", so the synced state must also be committed.
- The Step 4 sentinel section (`deliver.md:2020-2060`) names neither precondition. `awk 'NR>=1980&&NR<=2070&&/state-sync|fetch|base ref|branch -f/'` hits only `:1990`, `:2008`, `:2015` (Step 3, "Update delivery-state — once, AFTER all of Phase C").

### Item 5 — source-contract digest pin has no repair path

- `tests/unit/source-contract.test.cjs:1986-1989` `RUNTIME_OWNED_FILE_DIGESTS` pins sha256 of `runtime-adapters.cjs` and `claude-dispatch-adapter.cjs` (assertion `:1991-1995`).
- `grep -rn "RUNTIME_OWNED_FILE_DIGESTS\|source-contract" Makefile scripts docs CLAUDE.md plugins/delivery-pipeline/references` → nothing. There is no update script, no doc, and no make target.
- On T-39-12 the digest was hand-edited (`git diff befc970c <T-39-12> -- tests/unit/source-contract.test.cjs`: `95dde3dd…` → `9d0682e3…`, commit `81f3e66c`).

### Item 6 — branch-name truncation mismatch

- **The code does not reproduce the stated mechanism.**
  - `ticket-worktree.sh create <ticket-id> <branch> <base-ref>` uses the branch **verbatim** (`:201-204`, `:271-280`). It has no truncation.
  - The only ticket-branch slug implementation is `validate-graph.cjs:74-86` (`slugify`, max 40, trailing `-` trimmed). The other truncations (`grep` for `slice(0, 4x)`) are unrelated (`gsd-sync.cjs:62` max 64 is phase dirs; `wait-events.cjs:404` is an id).
- Replaying slugify on the T-39-12 title gives `forward-the-declared-output-schema-to-ev`, 40 chars (`node -e …` → `… 40 | …-to-eve`). That matches `tickets.json:5467`.
- So `…-to-eve` (41 chars) was produced by the caller, not by `ticket-worktree.sh`. Most likely the orchestrator or `mkexec.cjs` typed it for `gh pr create --head`.
- Unknown: who typed it. The transcript is outside the sandbox. Next check: `grep -n 'to-eve' <transcript>` around [991].
- Real gap: nothing derives `--head` for PR creation from `tickets.json` `branch` (see item 2).

### Item 7 — research refusal names the wrong remedy and discards the whole fan-out

- `sealPlanningResearch` puts eleven conditions in one boolean, including `summary > 500` chars. It emits the single message `planning research has invalid scope or result` (`claude-delivery-host.cjs:506-516`).
- `claude-dispatch-adapter.cjs:19` `REPAIR = 'Install an ADR-014-capable Claude host…'` is appended to every boundary failure (`:28-40`).
- `workflows/investigation-research.mjs:285-290` rethrows any per-line error by design. The comment reads: "A host/bridge failure or malformed agent result is a failed workflow". The whole `parallel` then rejects, so the three good lines lose their sealed index.
- The workflow's own validator already names the precise cause (`:174` `summary must be a string of at most 500 characters`). The host check is coarser.
- Overlap: T-39-08 (summary cap) and T-39-01 (refusal hints) are unmerged. Per-line isolation is not in their titles; assumption, next check: `39-08-PLAN.md`, `39-01-PLAN.md`.

### Item 8 — foreground polling

- `ci-wait.cjs` is the only sanctioned wait (`deliver.md:251`, `:2557-2578`). It refuses when the board has actionable work (`deliver.md:2630`).
- `wait-events.cjs` defaults: 30 s interval, 15 min deadline (`:18-20`).
- No primitive waits on in-flight host CLI processes (see item 2). Whether the Claude harness `run_in_background` / Monitor is referenced: `grep -n "run_in_background\|ScheduleWakeup" deliver.md` → no hits.

### Item 9 — patched installed plugin, no dogfood mode

- The cache state is proven in §0.
- `grep -rn -i dogfood plugins scripts Makefile CLAUDE.md docs` → no hits.
- Receipts carry no host-source identity. `grep -n "host_version\|plugin_version\|host_source\|source_digest\|shipyard_version\|CLAUDE_PLUGIN_ROOT"` over `dispatch-boundary.cjs`, `claude-runtime-host.cjs`, `codex-runtime-host.cjs` → no hits. `finalizeApplicationReceipt` (`dispatch-boundary.cjs:1480-1493`) records policy_hash / dispatch_id / launch_id only.

### Item 10 — generated state YAML header and stale projections

- `.planning/graph/delivery-state.yaml:1` currently reads `# generated by state-sync.cjs from live GitHub state — do not edit`.
- The backlog entry (`.planning/backlog/generated-state-yaml-header-blocks-push-from-the-project.md`) describes a `# snapshot generation N` header that the comment policy blocks. Severity there: "Scope: none of the phase 39 tickets".
- `Makefile:47` puts `test-gsd-sync` (`gsd-sync.cjs --check`, `:65-66`) into `test-fast`.
- The epic planning commits alone rewrote 198 projection files (`git diff befc970c <epic> --name-only | grep -c -E 'SUMMARY|UAT|VERIFICATION'` → 198; e.g. `20-01-SUMMARY.md` changes only `shipyard_source_fingerprint`). Any graph change fans out to every phase projection, which is what made #203's CI stale.

### Item 11 — pre-push hook derives the worktree from command text

- `scripts/shipyard-pre-push-gate.sh:13-17` extracts the worktree by regex from `git -C <x>` or `cd <x>` in the command text, otherwise from `cwd`. It passes the result to `publish-gate.cjs --worktree` (`:34`). `publish-gate.cjs:43-44` refuses when `<worktree>/.git` is missing.
- Replay (`node -e` with the hook's exact regex):
  - `cd /…/inv-003; git push` → `"/…/inv-003;"` (trailing `;` captured by `\S+`)
  - `git -C "$W" push` → `"$W"`
  - `cd $W && git push` → `"$W"`
- Both reproduce [677] and [1374]. The hook is installed as a copy by `scripts/install-shipyard-claude-hook.sh:236-240`, so a fix needs a hook reinstall.

### Items C1–C8 — Codex (source lines verified against 0.61.0 == HEAD)

| Item | Verified at | Command / observation |
|---|---|---|
| C1 | `pipeline-config.cjs:1650-1655` `CONFLICTING_OVERRIDE`; `codex-agent.cjs:21`, `:187`; `codex-model-remap.cjs:12` | `sed -n`. The Codex REPAIR text says "Install an ADR-014-capable Codex host and regenerate agents with install-shipyard-codex.sh --phase 2" and `:187` appends it to every error. |
| C2 | `gsd-tune.cjs:592` (only `model_overrides` gated on `runtime === 'claude'`), `:606-609` `models.*` ungated, `:589` `workflow.use_worktrees` | `sed -n 588,612p` |
| C3 | Research sealer only in Claude | `grep -ln role-artifact scripts/*.cjs` → only `claude-*`, `attempt-history`, `role-artifact`. `grep -n research codex-delivery-host.cjs` → no hits. `sealPlanningResearch` only at `claude-delivery-host.cjs:506,752`. Research sandbox `read-only` at `gsd-tune.cjs:117`. `investigate.md` still routes Codex to `codex-delivery-host.cjs` (`investigate.md` ≈ `:124`). |
| C4 | `codex-decompose-host.cjs:18`; `codex-dispatch-adapter.cjs:98-99`; `tests/unit/codex-decompose-host.test.cjs:35`, `:103` | `sed -n`. The test pins researcher `read-only`. |
| C5 | `codex-runtime-host.cjs:638-643` (checks agent_type/model/effort/fork_turns/task_name only); `:876-880` ("Give that child this exact task") | `sed -n`. No message digest is compared. |
| C6 | Neither decompose host seals | `grep -n "decomposition-result\|artifact_index\|roleArtifact" codex-decompose-host.cjs claude-decompose-host.cjs` → no hits |
| C7 | `codex-decompose-host.cjs:72` default `~/.local/state/shipyard/codex-decompose`, `INVALID_STATE_DIR` in the worktree | `grep -rln "local/state/shipyard" skills commands` → no hits (undocumented to the agent) |
| C8 | `shipyard-doctor.cjs:192-195` expects `<codex home>/shipyard/manifest.json` | `gen-codex-shipyard.cjs:384` writes `manifest.json` at `$OUT/`. `install-shipyard-codex.sh:727` copies only `$OUT/bundle` → `$BUNDLE_ROOT`. The agent manifest is `.shipyard-manifest.json` in `agents/` (`:280`). The smoke runs doctor against an empty Codex home (`tests/smoke/claude-hook-smoke.sh:61-62`). |

## 3. Known warts (cross-cutting)

1. **The docs are the dispatch API.** `deliver.md` (>2800 lines) describes request shapes that no script builds (items 2, 3, 4). Validation happens only at the host, after hand assembly.
2. **Coarse refusals plus a generic appended REPAIR string** in both runtimes (`claude-dispatch-adapter.cjs:19`, `codex-agent.cjs:21/187`, `codex-model-remap.cjs:12`). The remedy text is unrelated to the failing predicate (items 7, C1).
3. **Test fixtures are consumer-authored**, both before and after T-39-12 (item 0, C4).
4. **Hook scripts are copies** installed into `~/.claude/hooks`, and fixes need a reinstall (item 11).

## 4. Uncertainties and next checks

- [ ] PR #205–#208 and #203 states and CI results: `gh pr view <n> --json state,mergedAt,statusCheckRollup`. Blocked by the sandbox (`gh` config unreadable).
- [ ] Remote refs may be stale (`git fetch` failed over ssh). Re-run `git fetch origin` and repeat the §0 merge checks.
- [ ] Who produced `…-to-eve` (item 6). Needs the transcript `~/.claude/projects/-Volumes-KINGSTON-claude-shipyard/7bcbbf57-….jsonl` [985–995], which is not readable in this sandbox.
- [ ] Whether the sentinel base failure was a swallowed fetch error (item 4): transcript [1320–1330].
- [ ] T-39-03 / T-39-08 / T-39-01 diffs vs items 1 and 7, to confirm non-overlap: `git diff <epic> <ticket> -- <file>`.
- [ ] Installed Codex bundle state (`~/.codex/shipyard`, `~/.codex/agents`) was not inspected; outside the sandbox read allowlist.
- [ ] No spike run. Suggested: `/gsd-spike "capture a real claude --json-schema stream-json launch as a committed fixture and replay it through claude-runtime-host"` (item 0).

## 5. Sources

- Evidence inputs: `research/session-evidence.md`, `research/codex-flowpdf-evidence.md` (this investigation).
- Code: paths under `plugins/delivery-pipeline/{scripts,workflows,commands}`, `scripts/`, `tests/`, and `Makefile`, as cited above, at `8c264020` (code == `befc970c`).
- Installed state: `~/.claude/plugins/installed_plugins.json`, `~/.claude/plugins/cache/shipyard/shipyard/0.61.0/scripts/`.
