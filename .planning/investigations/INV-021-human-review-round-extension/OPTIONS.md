# Options

Four candidates from the `alternatives` line, grounded by `system-state`, `constraints` and `risks`. The agent does not recommend; the choice is recorded in DECISIONS.md by the operator.

## Option A — keep the single `report` exit; fix text and visibility only (minimal change)
`ROUND_CAP` stays 3. Correct the wording ("for this PR" is false: the key is project-wide), make the refusal, status and comment say what `report` costs, and optionally show on the PR that the hold was lifted by configuration. Touches `phase-code-review.cjs:87-90,181,215,275`, `deliver-dispatch.cjs:1209`, `deliver.md` and the generated mirror; tens of lines, can delete the three duplicate copies of the refusal sentence. No change to core, seal or replay. Human-only: no claim made. Does not give a fourth review.

## Option B — the proposal as written (signed extension record + `extend` command)
Effective limit `ROUND_CAP` + records, ceiling, head/base binding, delta-only, visibility. About nine production files: core limit, seal bound, replay bound, a signed store with a registered key prefix, three call sites, a new verb with argument parsing, comment/status/trailer text. Likely several hundred lines and a new `shipyard.*` schema id. Human-only: against a role-hosted model yes (already sandboxed); against the orchestrating model no, because the `--confirm` token is a public constant and the key is same-user readable unless the operator's own settings deny it. Reverses ADR-032 "no waiver store". Needs consumption recorded to avoid the consumed-versus-voided hole. Deletes nothing.

## Option C — a human GitHub review on the exact head replaces the round at `limit`
Keep the cap at 3. At `limit`, `evaluateGate` accepts a fresh, head-bound APPROVED review from a non-bot user who is not the PR author, reusing `isHumanHeadApproval` (`reviewers.cjs:138-144`). Tens of lines in `evaluateGate`/`verifyCodeReview` plus one `gh` read; no new state, command, schema, or key; core, seal and replay untouched. Human-only through GitHub identity, which holds only if the model lacks credentials of the approving account. Does not re-run the review (the human attests). Fails for single-account operators. Re-opens ADR-032's withdrawn "human APPROVED fallback".

## Option D — head-bound extra round expressed in `.planning/config.json`
The extra round, ceiling, binding and visibility of B, with the permission as a validated config entry instead of a signed store; no new verb or key. Same cap sites as B plus a config key. Human-only: no stronger than today's `report` exit, but narrower (one PR, one head, one round). A signed store could replace the config entry later without changing the mechanism. Same replay-depth and rollback hazards as B; still a per-PR waiver record, so ADR-032 is amended; adds a contract key and deletes nothing.

## Second axis (applies to B and D): who may grant
L0 constant token; L1 key signature (only if the orchestrator cannot read the key); L2 `/dev/tty` nonce (a pty answers it); L3 sandboxed orchestrator (not shippable by the plugin; depends on the operator's settings); L4 out-of-band factor (OS prompt, hardware key); L5 GitHub identity of another human (Option C). Any layer above L0 is a new security promise, not a restatement of one.

## Comparison

| | A | B | C | D |
|---|---|---|---|---|
| Grants a fourth conveyor review | no | yes (to ceiling) | no (human attests) | yes (to ceiling) |
| Production touch points | ~5 files, strings | ~9 files, store, verb, 3 call sites | `evaluateGate` + one `gh` read | cap sites of B + config key |
| Rough size | tens of lines, net ≤ 0 | several hundred + tests (estimate) | tens of lines + ~5 tests | between C and B |
| Cap-pinning tests change | message pins only | yes (nine files) | no | yes |
| New state / contract id | none | signed record, likely new schema id | none | config key |
| Human-only vs role-hosted model | n/a (already sandboxed) | yes (sandbox) | yes (GitHub identity) | yes (sandbox) |
| Human-only vs orchestrating model | no | not as written | yes if approver account is not the model's | no (as `report`) |
| ADR-032 | none | amend (waiver store) | amend (APPROVED fallback) | amend (waiver store) |
| Simplification direction | satisfied | no deletion identified | adds one branch | adds a key and a parameter |
| Rollback | revert | remove verb; sealed round-4 hazard | remove branch | remove key; same hazard |
| Largest unknown | is lifting the project-wide hold acceptable | key access, replay depth, rollback | PR author vs approver accounts | as B |
