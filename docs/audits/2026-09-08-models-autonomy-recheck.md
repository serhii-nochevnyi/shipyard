# Model routing and autonomy — recheck, 2026-09-08

## Scope and immutable subjects

This review supersedes the previous conversation's model-routing conclusions. It does not re-propose Sonnet as the executor or orchestrator, Luna/Sol for the built-in Codex palette, or a configuration table that overrides signature escalation. The accepted amended ADR-005 is the policy being checked.

`git fetch origin` succeeded. Local `main` already matched `origin/main`; there was nothing to pull. The implementation is not all on main:

| Subject | Reviewed revision | What it contains |
|---|---|---|
| main | `8fa1df6b2f653674a7581ab45abb95f002c1c55c` | Updated ADRs, project config and plans; phase 24 implementation |
| epic/25 | `e8dc9da89e477d00b5f579d1e0bf1f18b65704ed` | T-25-01 through T-25-05, including the new ladder and telemetry |
| epic/26 | `9df771d82a4379ad88aaa56086a366aa676e46be` | Landed safety/state fixes; T-26-02 and T-26-12 remain pending |
| temporary combination | tree `dca91901082a0dc61409c16879e12447714ee4e3` | Automatic merge of the two epic heads, without committing or changing either branch |

T-25-06 was being edited in its own worktree during this review. Its five dirty files were observed and left untouched. Its unfinished contents are not treated as a released fix or re-reported as a new discovery.

The review covers role resolution, model/effort delivery, generated Codex agents, installation and preflight, failure history, background versus inline sentinel paths, telemetry, and the integration of phase 26's state/lock/check changes. It combines source inspection, local suites, and adversarial fixtures. It is not a live paid-model evaluation or a Docker deployment certification.

## Result

The ordinary routing and installation paths work, and substantial previous audit findings have been addressed. Six additional findings remain: one P1 and five P2. Five have executable fixture evidence; the sixth is a missing edge in the shipped background-agent contract. These findings also survive the temporary combination of phases 25 and 26.

The accepted model choices need not change to fix them. The remaining faults concern enforcement and propagation of those choices.

## Verification performed

| Check | Result |
|---|---|
| epic 25: `make test-fast` | PASS, exit 0 |
| epic 25: `make test-codex-shipyard` | PASS, exit 0; actual gsd-core 1.13.0 converter/installer in the smoke's isolated environment |
| epic 26: `make test-fast` | PASS, exit 0 |
| temporary combined 25+26: `make test-fast` | PASS, exit 0 |
| merge of the two epic heads | No text conflicts; no commit or merge to a user branch |
| eight-role baseline matrix, both runtime branches | Matches current policy |
| adversarial probes on epic 25 and combined source | Same defective outcomes reproduced |

The CLI versions in compatibility probes are controlled local stubs. No paid agent was launched and no real PR was merged or modified. The upgrade probe runs the real generator twice, then reproduces the installer's exact copy-over operation; it does not claim a live Codex session selected the stale file.

Confirmed Claude baseline:

| Role | Model | Effort requested |
|---|---|---|
| executor | opus | high |
| ci-fix / review-fix | opus | high |
| research | opus | high |
| arch-review / integrator | opus | xhigh |
| drift-check / pr-sentinel | sonnet | high |

High-risk/checkpoint executor and alternatives research deepen as specified. Haiku is not selected by a built-in route. Codex generation uses Terra/high, Terra/low for drift-check, Astra/high for integrator, and four Astra/high `-deep` variants when permitted by the palette and CLI version. The resolver's `sonnet` alias is not mistaken for the final Codex model.

## New findings

### R01 — P1: nonconsecutive failures skip the rethink rung

**Source:** [failure-signature.cjs:375–397](https://github.com/serhii-nochevnyi/shipyard/blob/e8dc9da89e477d00b5f579d1e0bf1f18b65704ed/plugins/delivery-pipeline/scripts/failure-signature.cjs#L375).

`seen` counts every occurrence of the current signature since the last green. Only the last prior signature must match. Consequently, the sequence below skips `repeat` entirely:

```text
failure signatures, each at a new head: A → B → A → A
actual verdicts: first → progress → progress → repeat_exhausted
```

There are only two distinct signatures, so the K=3 plan-defect rule does not intervene. No earlier verdict instructed a `rethink`, and no maximum-depth attempt is proven. Nevertheless, R2 now says that deeper effort was spent and permits the ceiling; the delivery instructions allow one such round before handing the ticket to a person.

This can spend the premium-model round and end autonomous repair before the intended intermediate diagnostic attempt happened. It is a stronger counterexample than missing effort telemetry: the resolver's own verdict sequence contains no `repeat` at all.

**Correction:** require evidence of a prior rethink for this signature before declaring that rung exhausted. A consecutive-repeat check fixes this interleaving; persisted attempt/dispatch strategy and applied-depth evidence are needed to support the stronger claim that the deeper attempt actually ran. Unknown applied effort must not be treated as proof of exhaustion. Add `A,B,A,A`, override, and Agent-with-unknown-effort cases alongside the existing `A,A,A` test.

### R02 — P2: a GSD remap bypasses the Codex model-version filter

**Source:** [gen-codex-shipyard.cjs:219–260](https://github.com/serhii-nochevnyi/shipyard/blob/e8dc9da89e477d00b5f579d1e0bf1f18b65704ed/scripts/gen-codex-shipyard.cjs#L219).

The generator filters the palette by `min_cli`, but later returns a GSD-remapped model directly. The final selected model is never checked against the same constraint.

**Executed reproduction:** CLI `0.147.0`, default palette, and project `model_profile_overrides.codex.sonnet.model = "gpt-6-astra"` using the installed real GSD resolver:

```text
warning: not writing "gpt-6-astra"; requires 0.153.1
filtered palette: [gpt-5.6-terra/high]
actual ci-fix result: gpt-6-astra/high
```

The warning and generated choice contradict one another. Remap priority is legitimate; bypassing a declared compatibility requirement is not. This reintroduces the unsupported-model startup/fallback problem the floor is intended to prevent.

**Correction:** validate the final selected model after remapping, consulting the original palette's known compatibility metadata. Do not introduce a global hardcoded registry or reject all unknown new models. Test a remap to a known, version-gated palette model on both sides of its floor.

### R03 — P2: startup preflight checks the registration file instead of the agent's model

**Source:** [gsd-tune.cjs:361–375](https://github.com/serhii-nochevnyi/shipyard/blob/e8dc9da89e477d00b5f579d1e0bf1f18b65704ed/plugins/delivery-pipeline/scripts/gsd-tune.cjs#L361).

The comment says installed agent files are checked, but the implementation only searches `config.toml` for the model ID. A normal generated registration holds a `config_file` path; the actual `model` is in that referenced file.

**Executed reproduction:**

```toml
# config.toml
[agents.shipyard-integrator]
config_file = "agents/shipyard-integrator.toml"

# agents/shipyard-integrator.toml
model = "gpt-6-astra"
model_reasoning_effort = "high"
```

With CLI `0.147.0`, after applying ordinary tuning in the fixture, the next preflight returns `exit=0, drift=[], blockers=[]`. Putting a model literal directly into the top-level config, as the existing fixture does, does not test the installed layout.

**Correction:** inspect the actual registered/discovered Shipyard agent files, or a shipped manifest that records their resolved models, and test the installer's real file layout. Keep this distinct from R02: R02 is generation, R03 is detection of an existing incompatible install.

### R04 — P2: reinstall leaves ceiling agents that the new generation excluded

**Source:** [install-shipyard-codex.sh:96–103](https://github.com/serhii-nochevnyi/shipyard/blob/e8dc9da89e477d00b5f579d1e0bf1f18b65704ed/scripts/install-shipyard-codex.sh#L96).

The payload is replaced, but agent files are only copied over existing files. Agents no longer emitted are not removed.

**Executed reproduction:** generate/install the agent-file set at `0.153.4`, then generate at `0.147.0` and perform the same copy-over operation. The new output correctly contains no `-deep` agents, but the installed directory still contains all four old Astra variants:

```text
shipyard-arch-review-deep.toml
shipyard-ci-fix-deep.toml
shipyard-pr-sentinel-deep.toml
shipyard-review-fix-deep.toml
```

The same problem occurs when the operator reduces the palette to one model. Registration replacement is insufficient to make the existing "check the file exists before naming it" fallback reliable. A later dispatch can attempt an agent deliberately removed from the current generation; whether the particular host discovers it or rejects its name, the old file no longer represents the current policy.

**Correction:** reconcile the previous generated-agent manifest with the new manifest, removing only files owned by that generation. Preserve user-authored agents. Add a two-install smoke that removes the ceiling and verifies both files and registrations disappear.

### R05 — P2: Fable preflight accepts an explicitly prohibited model pin

**Source:** [gsd-tune.cjs:338–352](https://github.com/serhii-nochevnyi/shipyard/blob/e8dc9da89e477d00b5f579d1e0bf1f18b65704ed/plugins/delivery-pipeline/scripts/gsd-tune.cjs#L338).

The check validates the CLI version only. It explains that the alias can also be pinned incorrectly but never inspects that pin.

**Executed reproduction:** `pipeline.fable: auto`, CLI `2.1.263`, and `ANTHROPIC_DEFAULT_FABLE_MODEL=claude-fable-5`. After ordinary fixture tuning, preflight returns `exit=0, drift=[], blockers=[]`.

A current binary therefore passes while the known environment override points at the Fable version ADR-005 D5 explicitly excludes. Updating the binary does not repair that override.

**Correction:** when automatic Fable routing is enabled, validate an explicit effective pin as well as the binary version. Add the current-CLI/wrong-pin case. Do not silently overwrite the operator's environment.

### R06 — P2: the background sentinel does not produce the evidence its judgment escalation reads

**Sources:** [pr-sentinel.md:149–172](https://github.com/serhii-nochevnyi/shipyard/blob/e8dc9da89e477d00b5f579d1e0bf1f18b65704ed/plugins/delivery-pipeline/references/pr-sentinel.md#L149), contrasted with [deliver.md:1249–1274](https://github.com/serhii-nochevnyi/shipyard/blob/e8dc9da89e477d00b5f579d1e0bf1f18b65704ed/plugins/delivery-pipeline/commands/deliver.md#L1249).

The inline loop resolves arch-review with measured input and `--contested`, then explicitly journals `arch_review` for every verdict. The background sentinel receives its own reference file as its contract. That reference reads a prior `arch_review ... verdict=violation` for deep selection but contains no instruction to write that event. The arch-review reference itself only returns the verdict. The sentinel instead explicitly logs `degenerate_green`, which cannot satisfy the escalation predicate.

The background contract also omits the arch-review resolver call with `--input-tokens` and `--contested`; only its Codex-specific paragraph describes the deep alternative. A run whose architecture verdicts are all handled by the background guard has no contractual producer for the journal fact R3 depends on, and Claude's R1/R3 propagation is left implicit.

**Evidence level:** source/call-contract inspection, not a live LLM run. An agent might improvise the missing steps; the autonomous protocol does not require them.

**Correction:** share the complete judgment-dispatch procedure between inline and background paths: measure input, read the relevant prior verdict, resolve, dispatch, and record every outcome with a full head SHA. Add a contract test covering both paths. This is separate from the already known missing dispatch telemetry: an `arch_review` event drives behavior, not merely accounting.

## Known unfinished work — not new findings

| Item | Updated assessment |
|---|---|
| T-26-02: corrupt config permits defaults | Still pending. Reproduced on combined source: truncated config intended to contain `auto_merge: off` resolves to `auto_merge: epic` with a warning. This existing P1 remains important before declaring unattended mutation safe. |
| T-26-12: concurrency capacity | Still pending; no `max_concurrent_agents`/capacity enforcement in the reviewed heads. The model ladder alone does not prevent another excessive fan-out. A concurrency cap controls outstanding work; it is not itself a hard guarantee of total subscription budget. |
| T-26-13: drift-needed helper | Implemented and tested, but deliberately not wired into `deliver.md`. Step 2 still contains the previous prose condition. This is an explicit deferral in the plan, not an unannounced defect in that ticket. Autonomous cold starts cannot rely on a previous session remembering a manual helper call. |
| T-25-05 caller coverage | The new recorder supports requested effort, applied effort, reason and agent file. The existing integration review already records missing drift/architecture dispatch sites and an epic-scoped integrator limitation. Do not declare complete cost attribution from the recorder's unit tests alone. |
| Reason and agent provenance | Existing backlog covers caller-authored reason, role/file mismatch, alternate `log-event dispatch` writer and mixed SHA formats. Not re-counted here. |
| Workflow drift effort fallback | Existing integration follow-up: omitted effort still defaults to low despite the new Claude high row. Correct normal callers pass the resolved value. |
| T-25-06: stale policy prose / GSD pin homes | Known and under active modification. The audited epic snapshot still contains the old facts; the worktree edits were not disturbed. |

The old audit's path-ownership, CI unknown-state, worktree-GC, lock ownership, snapshot ordering and TOML findings are not re-presented as new defects of phase 25. Phase 26 contains their changes and its corresponding local tests pass, including in combination with phase 25. Head-bound architecture approval and stale-base duty work from phase 24 are likewise retained.

## Claims deliberately not made

- No new estimate of subscription savings: this review did not measure account-limit consumption or model quality on representative tasks.
- No claim that reducing effort is comparable in financial impact to switching model families.
- No request to change the accepted executor or orchestrator model.
- No claim that requested effort equals applied effort on the Agent path.
- The Workflow prompt ignores an extra `strategy` field, but the documented caller passes attempt history and the builder already instructs a different hypothesis when history exists. A probe of the unsupported field alone is insufficient to count that as a new live-path defect; it is not included in R01–R06.
- No claim that green local suites prove the real provider honors every requested model. Docker base/overlay/runtime tests and live paid-model dispatch were not run.

## Recommended order

1. Finish the already scoped corrupt-config and concurrency work, T-26-02/T-26-12, without changing the agreed model floor.
2. Correct the exhaustion transition and the background judgment evidence path, R01/R06.
3. Close generation → installation → preflight compatibility as one acceptance scenario, R02–R05, including upgrade/downgrade and remap paths.
4. Finish caller telemetry and wire the deterministic drift-needed helper, so the next optimization is measured on actual calls.

The architectural improvement since the first audit is real. The remaining central issue is that a function being correct does not prove its inputs reach it or its output reaches the running agent.

## Reproduction artifact

`2026-09-08-models-autonomy-probes.cjs` beside this report accepts a source checkout path and an optional installed Codex GSD root. It creates isolated fixtures under the system temporary directory, stubs CLI version output, uses the actual generator/GSD resolver, and prints observed outcomes. It changes no project configuration or installed agents. It is a diagnostic script: exit 0 means the observations completed, not that the defects are fixed. Read the JSON values against each finding above.

Example:

```sh
node docs/audits/2026-09-08-models-autonomy-probes.cjs /path/to/epic-checkout /path/to/.codex
```

Runtime code was not edited. The report and reproduction artifact are left uncommitted for review; existing working-state files and active ticket worktrees were not changed.
