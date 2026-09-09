# ADR-008 — The tracker is a projection, and a projection is DRIVEN

- **Status**: accepted
- **Date**: 2026-09-09
- **Extends**: `delivery-rules` §11 ("Jira is a projection, not the source of
  truth") from a rule about DIRECTION to a rule about MAINTENANCE. §11 settled
  who wins in a disagreement. It never said whether the projection is kept
  current, and the answer today is that it is not.

## Context

The operator asked a one-sentence question — *do the pipelines move the Jira
ticket through statuses when Jira is enabled?* — and the answer, measured
rather than recalled, is **no, and there is no place where they could.**

The evidence, each item read out of the code rather than out of a doc:

- **No script or workflow touches a tracker at all.** `createJiraIssue`,
  `editJiraIssue`, `transitionJiraIssue`, `searchJiraIssuesUsingJql`, `mcp__` —
  zero occurrences across `plugins/delivery-pipeline/scripts/` and
  `workflows/`. The deterministic layer does not know Jira exists.
- **Jira is touched at exactly one moment: decompose, Step 5.** Four acts, all
  of them creating or updating a body — find-or-create the phase Epic,
  find-or-create one issue per ticket, `createIssueLink` for each `depends_on`,
  write `delivery.jira` back into the plan. Then the conveyor never speaks to
  the tracker again. `decompose.md` says so in as many words: *"deliver never
  reads Jira, and Gate 2 never depends on it."*
- **The omission is deliberate, and it is written down twice.** The tool list in
  `decompose.md:339-342` names seven MCP calls and excludes `transitionJiraIssue`
  and `addCommentToJiraIssue`, which the connected MCP has. `bench.md:119` states
  the same boundary as a rule: *"stay read-only on the tracker by default — no
  status transitions, comments, or worklogs unless the user explicitly asks."*
  So this ADR is not fixing an oversight. It is REVERSING a default, and the
  reason the default was right is the reason the reversal has to be careful:
  a tracker write that fails must never be able to stop a merge.
- **The conveyor already keeps the exact record a projector needs, and has
  since long before anyone wanted one.** `state-sync.cjs:787` appends
  `{ts, event: 'status_change', ticket, from, to, pr}` on every REAL status
  change, and `log-event.cjs:144` lists `status_change` in `OWNED_BY_SCRIPTS`
  with state-sync as its sole writer. This project's journal holds 205 of them.
  A projection driven off that stream is driven off an owned, append-only,
  timestamped log — not off a re-read of live state.
- **The status vocabulary is four values, not a spectrum.** `state-sync` writes
  exactly `pending`, `branched`, `pr-open`, `merged`. Everything else the
  operator sees — `fix`, `finalize`, `merge`, `waiting.ci` — is a BUCKET that
  `front.cjs` computes, not a status that is stored or journalled. A map keyed
  on bucket names would be a map onto a vocabulary that never appears in the
  stream it reads.
- **And the trap that would have shipped.** The obvious config is
  `merged: Done`, and the obvious call is `transitionJiraIssue({transitionName:
  'Done'})`. The MCP's own schema refuses it in a sentence: *"Name of the
  transition itself, not the target status — the two often differ, so 'Done'
  does not match a transition named 'Review->Done'."* A projector that maps to
  transition NAMES works on whatever workflow it was written against and
  silently does nothing on the next one.
- **Two connected MCP variants, two incompatible shapes.** One requires
  `transition: {id}` and accepts no name at all; the other accepts
  `transitionId` OR `transitionName`. The id is the only argument both take, so
  resolving through `getTransitionsForJiraIssue` is not an optimisation — it is
  the only portable call.
- **A third silent failure, also from the schema:** a comment passed through
  `update` *"may be dropped without error — the transition reports success and
  no comment is created."*
- **This repository cannot exercise what it is about to build.**
  `.planning/config.json` says `pipeline.jira.enabled: false`, and all 69
  tickets in `tickets.json` carry a null `jira`. That is exactly ADR-007's
  subject — a mechanism nobody connected — arriving before the mechanism does,
  so the acceptance has to be designed around it rather than discovered by it.

The pattern under all of it is one sentence: **the conveyor's own history is
already a complete, owned, replayable transition stream, and nothing consumes
it.** Every hard part of this feature — knowing what changed, when, in what
order, exactly once — is solved. What is missing is a consumer, a map, and one
honest account of who is allowed to fail.

## Decision

Seven decisions, each sized as one ticket, ordered so the deterministic half
exists before anything reaches the network.

- **D1 — The projection reads the JOURNAL, and a watermark makes it exactly
  once.** Not live state: state is a snapshot and says nothing about what has
  already been projected. A fifth durable store, `jira-projection.json`, follows
  the four that exist (`withLock` + `writeAtomic`, the lock beside the store,
  `--graph <dir>` accepted in ANY position, a refusal when the resolved graph
  has no `tickets.json`) and records the last projected `status_change` per
  ticket. Movement is forward-only **in OUR order** (`pending` < `branched` <
  `pr-open` < `merged`): a `to` no later than what was projected is skipped, so
  a re-sync, a reopened PR or a replayed journal can never walk someone's board
  backwards. A ticket with no `delivery.jira` key is not an error — it is not a
  subject.
- **D2 — The map is our status → THEIR TARGET STATUS NAME, and it is a declared
  knob.** Never a transition name; the schema sentence above is the whole
  argument. `delivery_pipeline.jira_transitions` is declared in
  `capability.json` as a comma-separated string (`pr-open:In Progress,
  merged:Done`) for the same reason `codex_models` is: GSD's capability config
  vocabulary is `boolean|string|number|enum`, so an object-typed knob would not
  be settable at all. It is a TOP-LEVEL key, not a member of `cfg.jira` —
  `loadConfig` merges `delivery_pipeline` over `pipeline` shallowly, so an
  object-valued `jira` from one namespace replaces the other's wholesale, and a
  nested knob would be lost the moment a user set one key in the other place.
  An unknown left-hand status warns and is ignored, like every other unknown
  key. **An empty map means the feature is off** — that is the default, and it
  is the same posture as `pipeline.fable: off`: silence is not consent to write
  into someone's tracker.
- **D3 — A script computes the work, and it touches no network.**
  `jira-project.cjs plan [--json]` intersects the journal tail since the
  watermark with the tickets that carry a `jira` key and the configured map, and
  emits `{ticket, key, from, to, target_status}` per pending item. It is a pure
  function of three files, so it is unit-testable over a fixture journal with no
  tracker, no credential and no stub — which is what makes the half that CAN be
  proved mechanically as large as possible.
- **D4 — The agent performs, by ID, and an unreachable target is a report.**
  The acting half is `getTransitionsForJiraIssue` → find the offered transition
  whose TARGET status name matches → transition by that id. Jira workflows
  forbid arbitrary jumps, so the target being unreachable from the current
  status is an ordinary outcome, not a failure: record it, name the transitions
  that WERE offered, move on. Nothing here may block, retry hard, or fail a
  round — the existing rule that *"a Jira error never blocks decomposition"*
  extends unchanged to delivery. No comment is ever passed through `update`.
- **D5 — The recorder refuses a bare "done".** `jira-project.cjs record
  <ticket> <key> --transition-id <id> --status <name>` is the only thing that
  advances the watermark, and it journals a `jira_transition` event that
  `log-event.cjs` adds to `OWNED_BY_SCRIPTS` with the `halfAct` message the
  other three carry — it is that kind exactly, since a hand-written line would
  leave the watermark unmoved and the next round would re-project the same
  ticket. An agent that says it transitioned and cannot name the id it
  used has not produced evidence, and ADR-004's rule — positive evidence before
  a mutation — is about the conveyor's records exactly as much as about code.
  This is the precedent from ADR-006 D5's `--agent-file` cross-check, applied to
  the one act in this ADR that a script cannot witness for itself.
- **D6 — It is bookkeeping: outside the tick rate, invisible to the stop gate.**
  Not inside `state-sync` — that runs on every babysit round and its wall time
  IS the conveyor's tick rate, and it must not grow a dependency on a tracker's
  availability. A separate act in the main loop after a sync. A pending
  projection is **not actionable and not a reason to block**, which is a
  deliberate asymmetry with every other unwired mechanism this repo has fixed,
  and the justification is specific rather than general: the watermark makes
  catch-up free, so the honest worst case of a skipped round is that Jira lags
  by one round and the next one closes the gap. There is no equivalent of the
  5h46m silence here, because nothing waits on it.
- **D7 — Acceptance is designed around the fact that this repo cannot run it.**
  `pipeline.jira.enabled: false` here, so the witnessed mutation — ADR-006's
  standing requirement — lands in the proving ground, and the ADR says so
  instead of letting a green CI imply a live run. What CI proves on its own:
  the planner over a fixture journal, the recorder's refusal of an unevidenced
  record, a wiring assertion that `deliver.md` actually calls the planner (the
  WIRED-pin pattern, already used seven times), and a NEGATIVE pin that
  `transitionName` appears in no script and no prompt — the shape of the
  model-id sweep, aimed at the one mistake this ADR exists to prevent.

## Considered and NOT chosen

**A script calling Jira's REST API directly, with a token.** It is the more
honest engineering answer to ADR-007's objection: the acting half would become
deterministic, stub-testable exactly like `sentinel-smoke.sh` stubs `gh`, and no
part of the mechanism would live in prose. It is rejected on three counts, and
the first is the decisive one. It puts a **tracker credential inside the
conveyor**, which today holds none — `gh` auth is the host's and the MCP's is
the runtime's. It produces **two Jira clients for one tracker**, because
decompose stays on MCP, and two clients drift. And it reverses `decompose.md`'s
explicit *"do not hand-roll REST calls"* for a benefit that D3 and D5 mostly
recover anyway. If the projection later needs to run with no agent in the loop —
a cron, a CI job — this is the upgrade path, and D1/D2/D3 are unchanged by it.
Only D4 is replaced.

**Prose in `deliver.md` and nothing else.** That is ADR-007's failure mode
verbatim, and it is what D5's refusing recorder and D7's wiring pin exist to
prevent. Named here because it is what this feature turns into if either is
dropped for scope.

## What this ADR does NOT cover, and why

- **The phase Epic issue.** The epic → integration-branch merge is a human's
  act by design (it is what makes the epic a quarantine), and the journal
  carries no epic-level status event to drive a projection off. Both halves
  would have to be invented; neither is this subject.
- **Comments and worklogs.** A PR link posted as a comment is genuinely useful
  and is a different subject with a different failure mode — and the MCP drops
  a comment passed through a transition silently, which is a trap worth its own
  investigation rather than a footnote in this one.
- **`escalation` → a "Blocked" status.** Decided OUT, explicitly rather than by
  omission. The journal has the event and the map could take the key, but an
  escalation lifts by itself when the PR moves (fingerprint expiry), so
  projecting it would need an UN-blocking rule that the four forward-only
  statuses do not, and a half-implemented one would leave someone's board stuck
  on Blocked after the conveyor had moved on. It is a clean follow-up once the
  forward path has run live.
- **GitHub Issues, Linear, or any second tracker.** D2's map and D3's planner
  are tracker-agnostic by construction, but nothing here is generalised on
  speculation; the second tracker is what would prove the shape, and there is
  no second tracker.
- **The three prose homes of the config key list.** `README.md:288`,
  `deliver.md:467` and `capability.json` all enumerate the knobs and NOTHING
  asserts they agree — adding `jira_transitions` will have to touch all three by
  hand. That is a real instance of ADR-006 D7's family ("a guard asserts a
  sweep, not a list") and it deserves the sweep rather than a fourth manual
  edit, but it is a general assertion about config documentation, not about this
  feature.

## Consequences

Seven tickets, one phase. The order is load-bearing in one place only: **D1, D2
and D3 are the whole deterministic half and must exist before D4 has anything to
perform**, and D5 must land with D4 rather than after it, because a performing
half with no recorder is precisely the un-evidenced write this ADR refuses. D6
and D7 are the wiring and the guards; D7 is last because it asserts what the
others built.

Two consequences worth stating as such, because both are reversals.

**A default is being reversed, and reversals in this repo have to name what
protected the old one.** `bench.md`'s read-only posture stays for bench — a
human working by hand in someone else's checkout should not silently move a
board. What changes is only the CONVEYOR's own path, where every write is
derived from an owned journal entry the conveyor itself produced. The
protection that made read-only right is preserved by a different mechanism:
an empty `jira_transitions` map, which is the default, and which means a
project that says nothing gets exactly today's behaviour.

**And this phase ships a mechanism its own repository cannot run.** Phase 28
existed because the installed conveyor had drifted from the repository
conveyor; this is the same gap seen from the other side — the repository will
carry a correct, tested, wired mechanism whose first contact with a real
workflow happens somewhere else. D7 is what keeps that honest, and the thing to
watch for is the shape ADR-006 named: an assertion nobody has seen fail is not
a guard, and a fixture journal is not a Jira workflow.
