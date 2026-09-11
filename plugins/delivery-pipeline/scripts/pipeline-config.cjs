#!/usr/bin/env node
'use strict';

// Single deterministic reader for the conveyor's configuration, plus the model
// policy — a floor, a role-keyed effort table and an earned ceiling — and the
// repair STRATEGY a failure signature's history implies.
//
// Before this module the policy lived only as prose inside the skills, so it was
// unenforceable and drifted (it named model IDs the Agent tool does not accept).
// Now the skills ASK for a model instead of reasoning one out:
//
//   node pipeline-config.cjs resolve                      # effective config, JSON
//   node pipeline-config.cjs model <role> [flags]         # one tier alias
//   node pipeline-config.cjs model <role> --json [flags]  # {model, effort, route}
//                                                        # + strategy, with --signature-state
//
//   flags: --risk low|medium|high  --type <plan type>  --checkpoint
//          --input-tokens <n>   the caller's own measurement of this dispatch's
//                               input; the ceiling's window route reads it
//          --contested          this judgement has already been contested once
//          --signature-state first|progress|repeat|repeat_exhausted|
//                            flake_candidate|flake|plan_defect
//          --files <n>  --code-change|--no-code-change
//          --attempt <n>  --previous-failed   ← all accepted, but INERT (see below)
//
// THE FLOOR IS `opus`, THE DEPTH IS EFFORT, AND `fable` IS EARNED (ADR-005 D1/D2
// as amended 2026-09-08, D4/D5). Three layers, in this order:
//
//   1. the FLOOR — every role that writes code or renders a judgement resolves to
//      `opus`. Two roles are exempt and stay on `sonnet`, each for a measured
//      reason recorded beside it (see SONNET_ROLES): `pr-sentinel`, whose merge
//      decision sentinel.cjs enforces mechanically, and `drift-check`, which
//      returns a file list. No built-in path returns `haiku` any more.
//   2. the DEPTH — a role-keyed EFFORT table (EFFORT_ROWS), because with the tier
//      constant the old "effort follows the model" derivation collapsed to one
//      value and `--signature-state repeat` stopped deepening anything. Measured
//      2026-09-07 with the floor set through configuration: every role except
//      drift-check came out `opus`/`xhigh`, so the repair ladder's depth rung had
//      quietly gone.
//   3. the CEILING — `fable` is reached by three mechanical routes and never by
//      default (fableRoute): a measured input over `fable_window_tokens`, a
//      repair whose signature came back a third time, or a contested judgement.
//      `pipeline.fable` must be `auto` for any of them to be honoured; `off` (the
//      default) degrades the route to `opus` at `max` effort and says why.
//
// EFFORT IS A QUALITY KNOB, NOT A PRICE ONE, and no row here may be justified as
// a saving. Reconstructed from this project's usage ledger: output is 12–19% of a
// model line and cache read+write are 82–87%, so `xhigh` → `high` moves about
// 3.4% of a run against ≈2.5× for a tier step. An effort row buys or gives up
// QUALITY at approximately constant price.
//
// AND EFFORT IS ONLY ENFORCED ON THE WORKFLOW PATH. The Agent tool takes no
// `effort` parameter at all (verified against the live schema, CLI 2.1.263): only
// Workflow's `agent()` carries it. So the table governs executors, drift judges
// and fix rounds, and is a sentence in the prompt for an Agent-spawned background
// guard.
//
// REPAIRS ESCALATE BY STRATEGY AND DEPTH, NOT BY TIER (ADR-001 D1). The repair
// roles (ci-fix, review-fix, pr-sentinel) used to read `attempt >= 2 → opus`,
// which is "try harder": the observed loss is one wrong hypothesis re-tried by
// three models in sequence. Their tier is now the floor alone, and the failure
// SIGNATURE's history — computed by failure-signature.cjs, passed in as
// `--signature-state` — decides what to do differently, plus how deep to think at
// that tier. Only its last rung moves the model, and it moves it to the CEILING
// rather than up a tier: `repeat_exhausted` means the depth has already been
// spent. `--attempt` and `--previous-failed` remain accepted for the callers and
// docs that still pass them (and the attempt counter remains as telemetry), but
// they no longer route anything.
//
// TWO CONFIG NAMESPACES, both in .planning/config.json:
//
//   delivery_pipeline.*  the capability's own declared config (GSD-native: it is
//                        what the capability's gate `when:` clauses read, and it
//                        is settable/validated through GSD's config tooling).
//                        PREFERRED — it wins over pipeline.* below.
//   pipeline.*           shipyard's runtime knobs. `pipeline` is NOT a valid GSD
//                        config key, so `/gsd-config --set pipeline.x` is
//                        rejected; edit config.json directly, or use the
//                        delivery_pipeline.* form for the keys that have one.
//
// GSD's own top-level keys are READ (never written) where the conveyor has to
// agree with GSD: `runtime`, `git.base_branch`, `git.branching_strategy`,
// `response_language`. Disagreeing with them silently is how an epic branch ends
// up cut from main in a repo that integrates into develop.

const fs = require('fs');
const path = require('path');

// The Agent tool validates `model` against exactly these aliases: a full model id
// (`claude-opus-…`) or a suffixed alias (`opus[1m]`) is rejected on input. Full ids
// and `inherit` do exist, but on a DIFFERENT surface — a subagent's own `model:`
// frontmatter in `.claude/agents/*.md` — which is not the parameter a dispatch goes
// through, so a docs page listing them is not permission to emit one here.
// `opus` is Opus 5 from Claude Code 2.1.219 on. `fable` is Claude Fable 5.1 from
// 2.1.255 on: Opus-tier, 1M-token context, adaptive thinking at xhigh effort, and
// the only alias that expresses "top tier WITH a 1M window" — which is what this
// repo's long-broken `opus[1m]` was reaching for. It is a CEILING the conveyor
// reaches by itself through the three routes in `fableRoute`, and no role's
// default: measured on this repository, the largest input in the whole system is
// the phase epic diff at ~52k tokens, which Opus 5's ordinary window swallows.
// Below CLI 2.1.255 the alias resolves to Fable 5 instead — ruled out — so
// `pipeline.fable: auto` is a person's consent AND `gsd-tune.cjs` reports the
// version floor at Step 0 of every delivery.
const TIERS = ['opus', 'sonnet', 'haiku', 'fable'];
const TOP_TIERS = new Set(['opus', 'fable']);

// Workflow's agent() accepts these; GSD's ladder also has `minimal`, which is
// Codex-only and clamps to `low`. `ultra` is deliberately NOT here: it is
// advertised by one Codex model that no built-in path selects (ADR-005 D6/D7).
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
// GSD's light/standard/heavy tier defaults used to be mirrored here and mapped
// from the resolved model. That derivation is gone (see resolveEffort): with the
// floor at `opus` it collapsed to one value. The names survive only in GSD's own
// `effort.routing_tier_defaults`, which `gsd-tune` mirrors for GSD's agents.

// Roles whose work is mechanical reconciliation. On the runtime whose effort axis
// is flat (Codex) this is still the one distinction the axis makes; on Claude the
// role's own row in EFFORT_ROWS decides, and drift-check's row is no longer the
// cheapest one — it now carries the plan-defect burden the executor stopped
// carrying (ADR-005 D2 as amended).
const MECHANICAL_ROLES = new Set(['drift-check']);

// ── the Codex model palette (ADR-005 D6/D7) ──────────────────────────────────
//
// An ORDERED list of the models a Codex agent may be written with, each with the
// effort to USE — not the deepest the model accepts. That distinction is the
// whole reason the field is shaped this way: ranking the models by which effort
// levels they SUPPORT is what produced three wrong ladders in a row (GSD's
// `codexModelEffort` is a support matrix, and nothing in it claims to be a
// quality ranking).
//
// FIRST entry is the workhorse floor every role gets; LAST is the ceiling, which
// only the integrator takes statically and the `-deep` agents make reachable
// (ADR-005 D8 — on that runtime an agent is a FILE, so an escalation needs its
// own file). `min_cli` is the Codex CLI version that can first CONFIGURE the
// model; the generator refuses an entry above the host's version rather than
// writing an agent the runtime may ignore. There is no id registry to validate a
// model against — GSD's catalog does not carry every model an operator may have
// — so an unknown id cannot be distinguished from a new one, and a hardcoded
// allowlist here would go stale faster than the models do.
//
// `gpt-5.6-sol` is deliberately absent: with `xhigh`/`max` retired on that
// runtime its only distinguishing property (advertising `ultra`) buys nothing, so
// no built-in path selects it. It stays a value a person may configure — see the
// capability's declared default, which mirrors this list.
const DEFAULT_CODEX_MODELS = [
  { model: 'gpt-5.6-terra', effort: 'high' },
  { model: 'gpt-6-astra', effort: 'high', min_cli: '0.153.1' },
];
const CODEX_MODEL_KEYS = new Set(['model', 'effort', 'min_cli']);

// `model[:effort][@min_cli]` — the GSD-settable spelling of one palette entry.
// The capability declares `codex_models` as a STRING because GSD's capability
// config vocabulary is boolean|string|number|enum (its own
// `validateConfigSliceEntry`), so an array-typed slice would not be a declared,
// settable knob at all. A hand-edited config may still use the object form.
function parseCodexModelEntry(text) {
  const raw = String(text).trim();
  if (!raw) return null;
  const at = raw.indexOf('@');
  const head = at === -1 ? raw : raw.slice(0, at);
  const minCli = at === -1 ? undefined : raw.slice(at + 1).trim();
  const colon = head.indexOf(':');
  const model = (colon === -1 ? head : head.slice(0, colon)).trim();
  const effort = colon === -1 ? undefined : head.slice(colon + 1).trim();
  const entry = { model };
  if (effort) entry.effort = effort;
  if (minCli) entry.min_cli = minCli;
  return entry;
}

// One list out of any of the three accepted spellings: an array of objects, an
// array of `model:effort@min_cli` strings, or one comma-separated string.
// Malformed entries are SKIPPED with a warning — never half-honoured — and an
// empty palette means "write no model", which is the previous behaviour and a
// safe floor.
function normalizeCodexModels(value, warnings) {
  const items = typeof value === 'string'
    ? value.split(',')
    : Array.isArray(value) ? value : null;
  if (items === null) {
    warnings.push(
      'pipeline.codex_models must be a list of {model, effort} entries (or a "model:effort@min_cli, …" string) — ignored'
    );
    return null;
  }
  const out = [];
  for (const item of items) {
    const entry = typeof item === 'string' || typeof item === 'number'
      ? parseCodexModelEntry(item)
      : (item && typeof item === 'object' && !Array.isArray(item)) ? { ...item } : null;
    if (!entry) {
      warnings.push(`pipeline.codex_models entry ${JSON.stringify(item)} is not a model — skipped`);
      continue;
    }
    for (const key of Object.keys(entry)) {
      if (!CODEX_MODEL_KEYS.has(key)) {
        warnings.push(`pipeline.codex_models."${key}" is not an entry field — ignored (fields: ${[...CODEX_MODEL_KEYS].join(', ')})`);
        delete entry[key];
      }
    }
    if (typeof entry.model !== 'string' || !entry.model.trim()) {
      warnings.push(`pipeline.codex_models entry ${JSON.stringify(item)} has no model id — skipped`);
      continue;
    }
    entry.model = entry.model.trim();
    if (entry.effort !== undefined && !EFFORTS.includes(entry.effort)) {
      warnings.push(
        `pipeline.codex_models."${entry.model}" effort "${entry.effort}" is not an effort level — ignored (${EFFORTS.join('|')}); the role's own effort applies`
      );
      delete entry.effort;
    }
    if (entry.min_cli !== undefined && !/^\d+(\.\d+)*$/.test(String(entry.min_cli))) {
      warnings.push(`pipeline.codex_models."${entry.model}" min_cli "${entry.min_cli}" is not a version — ignored`);
      delete entry.min_cli;
    }
    out.push(entry);
  }
  return out;
}

// The roles that repair an existing PR rather than build a ticket. They are the
// ones ADR-001 D1 took the attempt counter away from, and the only ones a
// signature state applies to — an executor has no failure history to read.
const REPAIR_ROLES = new Set(['ci-fix', 'review-fix', 'pr-sentinel']);

// What a signature's history means for the NEXT move. The keys are
// failure-signature.cjs's verdict enum verbatim — it is the contract between the
// two files, so a synonym or a seventh word here is a silent no-op there (the
// unit test asserts the two lists are identical). Not imported: this reader must
// stay free of the journal/lock chain, since every skill loads it.
//
// The values are pinned strings the babysit loop switches on. The last three
// mean "do not dispatch a fixer at all".
const STRATEGIES = {
  first: 'fix',
  progress: 'continue',
  // Hold the tier, change the approach: re-read the plan, widen the context,
  // raise the hypothesis above the symptom.
  repeat: 'rethink',
  // The same instruction, one rung up: the deeper effort has already been spent
  // on this signature, so what changes is the MODEL (the ceiling's second route
  // — see fableRoute), not the advice to the fixer. Deliberately NOT a new
  // strategy word: `references/pr-sentinel.md` and `references/ci-fix.md` are
  // what a fixer actually reads, and a seventh verb would be a contract only the
  // resolver knew about.
  repeat_exhausted: 'rethink',
  flake_candidate: 'rerun',
  flake: 'quarantine',
  plan_defect: 'park',
};
const SIGNATURE_STATES = Object.keys(STRATEGIES);

// Own-property only: `strategyFor('toString')` must be unknown, not a function.
function strategyFor(state) {
  return Object.prototype.hasOwnProperty.call(STRATEGIES, state) ? STRATEGIES[state] : undefined;
}

// Every `pipeline.*` knob that goes through the shared positive-number rule
// below (loadConfig). Exported and read back by both the rule's own loop and
// its test, so a knob added here needs no second, hand-mirrored copy to drift
// out of sync with the rule that actually enforces it.
const NUMERIC_KNOBS = ['max_attempts', 'pr_fetch_limit', 'stale_merge_hours', 'stale_draft_hours',
  'plan_defect_signatures', 'fable_window_tokens', 'max_concurrent_agents'];

// ── the four statuses a ticket actually moves through ───────────────────────
//
// In OUR order (`pending` < `branched` < `pr-open` < `merged`), which is the
// order the projection's forward-only rule is measured in. These are the only
// values `state-sync.cjs` ever writes into a ticket's `status`, and therefore
// the only left-hand sides `jira_transitions` can be keyed by. The tempting
// wrong values are the FRONT's bucket names (`fix`, `finalize`, `merge`, `ci`):
// those are computed by `front.cjs` per round and never appear in the
// `status_change` stream this map is consumed against.
const TICKET_STATUSES = ['pending', 'branched', 'pr-open', 'merged'];

// One map out of either accepted spelling: an object, or one comma-separated
// `our-status:Their Target Status` string — the same two shapes `codex_models`
// takes, and for the same reason (GSD's capability config vocabulary is
// boolean|string|number|enum, so an object-typed knob would not be settable at
// all). The right-hand side is the tracker's TARGET STATUS NAME, never the name
// of a transition: the performing half looks up the offered transition whose
// target status matches, because a workflow's transition names are not a stable
// schema and its status names are.
//
// Malformed entries are SKIPPED with a warning, never half-honoured; a wholly
// unusable value keeps the empty map, which means the projection is off.
function normalizeJiraTransitions(value, warnings) {
  const items = typeof value === 'string'
    ? value.split(',')
    : (value && typeof value === 'object' && !Array.isArray(value))
      ? Object.entries(value).map(([k, v]) => `${k}:${v}`)
      : null;
  if (items === null) {
    warnings.push(
      'pipeline.jira_transitions must be a map of our status to the tracker\'s target status name '
      + '(or a "pr-open:In Progress, merged:Done" string) — ignored'
    );
    return null;
  }
  const out = {};
  for (const item of items) {
    const raw = String(item).trim();
    // A blank segment is SILENT: the capability's declared default is the empty
    // string, and `''.split(',')` is `['']`, so warning here would put a warning
    // on every load of an unconfigured project — which is how a reader learns to
    // ignore warnings. A trailing comma is the same case.
    if (!raw) continue;
    // The first colon only: a Jira status name may contain anything but is
    // conventionally spaced words, and splitting on every colon would silently
    // truncate one that carries a colon of its own.
    const colon = raw.indexOf(':');
    if (colon === -1) {
      warnings.push(
        `pipeline.jira_transitions entry "${raw}" is not "<our status>:<their target status>" — skipped`
      );
      continue;
    }
    const from = raw.slice(0, colon).trim();
    const target = raw.slice(colon + 1).trim();
    if (!TICKET_STATUSES.includes(from)) {
      warnings.push(
        `pipeline.jira_transitions."${from}" is not a ticket status — skipped `
        + `(statuses: ${TICKET_STATUSES.join(', ')}; the front's bucket names are not statuses)`
      );
      continue;
    }
    if (!target) {
      warnings.push(`pipeline.jira_transitions."${from}" has no target status name — skipped`);
      continue;
    }
    out[from] = target;
  }
  return out;
}

const DEFAULTS = {
  integration_mode: 'epic-stacked',   // | direct-to-main
  model_policy: 'balanced',           // economy | balanced | premium
  use_workflow: 'auto',               // auto | false
  // The PR sentinel: who drives open PRs to green and lands them in the stack
  // while the main loop cascades onward.
  //   sentinel:   auto (background guard when the runtime has one, otherwise a
  //               mandatory duty pass every round) | off (main loop only)
  //   auto_merge: epic — the sentinel squashes a green+conform ticket PR into
  //               its base (phase epic or parent ticket branch). The epic →
  //               integration-branch PR is NEVER auto-merged; that stays human.
  //               off — every merge is a human's, the pre-sentinel behaviour.
  sentinel: 'auto',                   // auto | off
  auto_merge: 'epic',                 // epic | off
  // A PR with NO reported checks is not a green PR — nothing ran. Both the board
  // (front.cjs) and the guard (sentinel.cjs) therefore withhold the two actions
  // that walk such a PR towards landing, and this is the project's way to say
  // "there is no CI here, that absence is expected". Opt-in only, and it fails
  // towards the human: see the coercion below.
  merge_without_ci: false,
  max_attempts: 5,                    // babysit rounds per PR (the backstop, not the ladder's input)
  // How many agents a wave may hold at once (ADR-005 D11). The one axis no
  // choice of TIER can address: the model policy is per dispatch and a spend
  // limit is per SESSION, so what decides whether a run survives is how many
  // dispatches are open together. On 2026-09-07 a run held nine opus/xhigh
  // executors and a fable guard in flight, hit a per-session limit, and six
  // agents died mid-ticket — five tickets lost their commits and the recovery
  // cost a whole re-dispatch round. Priced on that session's volumes the entire
  // ladder question is worth ~$26; this one is worth the run.
  //
  // 4 is a MEASUREMENT, not a round number: the largest wave this repository has
  // completed without an interruption. Every role counts against it, the PR
  // sentinel included — it is an agent, it holds tickets, and that session's
  // failure included one.
  //
  // `front.cjs` reports it as `capacity: {max, in_flight, free}` and deliver.md
  // builds the wave from `capacity.free`; the remainder is taken next round. A
  // wave wider than the cap is CUT, never refused. Note the two failure
  // directions are different on purpose: a malformed value here falls back to
  // this default (below, with every other positive-number knob), because a typo
  // in a number is not a decision to stop working — while a config file that
  // does not PARSE resolves to a cap of 0 in front.cjs, because then no policy
  // is in effect at all and a dispatch is a mutation.
  max_concurrent_agents: 4,
  // K of the k-distinct rule: this many DIFFERENT failure signatures with no
  // green means the ticket is wrong, not the fix (ADR-001 D2). Same default as
  // `failure-signature.cjs verdict --k`, and the two must agree.
  plan_defect_signatures: 3,
  pr_fetch_limit: 1000,               // `gh pr list --limit`
  stale_merge_hours: 4,
  stale_draft_hours: 24,
  worktree_root: null,                // null → <repo>/../.wt-<repo-name>
  graph_gate: true,                   // mirrors the capability's declared key
  gsd_sync: true,                     // mirrors the capability's declared key
  models: {},                         // per-role override → tier alias
  effort: {},                         // per-role override → effort level
  // The CEILING, and the consent that unlocks it (ADR-005 D5). `off` is the
  // default because an unconsented Fable request in a background session waits
  // out `dialogExpiry` and then ends the turn WITHOUT SENDING: silence is not
  // consent, exactly as decomposition treats pre-authorization. Under `off`
  // every ceiling route degrades to `opus` at `max` and prints the reason, so
  // the escalation still happens — one rung lower and visibly.
  fable: 'off',                       // off | auto
  // The window route's threshold: five times the largest input measured on this
  // repository (the phase-24 epic diff, the integrator's own input, at 210 KB
  // ≈ 52k tokens). The caller MEASURES and passes `--input-tokens`; the resolver
  // only decides. Absent, the route cannot fire — an absent signal must never
  // resolve upward.
  fable_window_tokens: 250000,
  // The Codex model palette, in preference order (see DEFAULT_CODEX_MODELS).
  // Mirrors the capability's declared `delivery_pipeline.codex_models`.
  codex_models: DEFAULT_CODEX_MODELS,
  // Sibling repositories the graph delivers into ("owner/name" → absolute local
  // checkout path). Tracking a foreign repo needs nothing but `delivery.repo` on
  // the ticket; EXECUTING there needs a local checkout, because worktrees,
  // commits and pushes are local git operations.
  repos: {},
  jira: { enabled: true, project: null, issue_type: 'Task', epic_issue_type: 'Epic' },
  // Our ticket status → the tracker's TARGET STATUS NAME, for the projection
  // (ADR-008 D2). TOP-LEVEL and flat, deliberately NOT a member of `jira`:
  // `delivery_pipeline` is merged over `pipeline` SHALLOWLY, so an object-valued
  // `jira` in one namespace replaces the other's wholesale and a nested knob
  // would vanish the moment a user set one key in the other place.
  // EMPTY IS OFF, and empty is the default — the same posture as `fable: off`:
  // silence is not consent to write into someone's tracker.
  jira_transitions: {},
};

const KNOWN_KEYS = new Set(Object.keys(DEFAULTS));
const KNOWN_JIRA_KEYS = new Set(['enabled', 'project', 'issue_type', 'epic_issue_type']);
const ROLES = ['integrator', 'arch-review', 'executor', 'ci-fix', 'review-fix', 'drift-check', 'research', 'pr-sentinel'];

// Judgment roles are never cheapened: there is no mechanical safety net above
// them, so a false verdict is the most expensive kind of error in the pipeline.
// The floor covers every role now, so this set no longer decides a TIER — it has
// exactly one reader, `fableRoute`'s contested route, because a re-judgement is
// the only thing `--contested` can mean. The other half of the invariant (neither
// of these may ever join SONNET_ROLES) is asserted in the unit test.
const JUDGMENT_ROLES = new Set(['integrator', 'arch-review']);
// ── the floor, and its two named exemptions (ADR-005 D1, amended D2) ─────────
//
// The floor is `opus`: the conveyor's failure mode is a wrong green reaching an
// epic, and every mechanical gate above the executor costs more to run than the
// difference between tiers. `haiku` is therefore returned by NO built-in path —
// it stays in TIERS because a user override may still name it.
//
// Two roles stay below it, and the reason travels WITH the exemption: a bare one
// is the thing a later reader deletes, and these two are 57% of all dispatches in
// the journal, so nobody should have to re-derive them from a bill.
const SONNET_ROLES = new Map([
  // The guard's merge decision is MECHANICAL. `sentinel.cjs mergeOne` re-verifies
  // every condition against live GitHub — open, undrafted, checks green, zero
  // unresolved threads, a conform trailer bound to this head, not
  // CHANGES_REQUESTED, not a checkpoint, base inside the stack — and refuses on
  // anything unproven, so the MODEL is not the gate. 44% of all dispatches.
  ['pr-sentinel', 'the merge decision is enforced by sentinel.cjs against live GitHub, not by the model'],
  // It returns a file list and a set of reuse pointers. The plan-defect burden it
  // inherited from the executor is bought with EFFORT instead (its row below is
  // `high`, up from `low`) — effort is ~12% of a line, which makes this the
  // cheapest possible home for that work rather than a saving on the work itself.
  ['drift-check', 'it returns a file list and reuse pointers; its new plan-defect burden is bought with effort, not with a tier'],
]);

// ── the depth: one EFFORT row per role (ADR-005 D2 as amended 2026-09-08) ────
//
// Read this table beside `tests/unit/pipeline-config.test.cjs`'s EFFORT_MATRIX,
// which asserts it row for row so no later edit can move one quietly.
//
//   drift-check                  high    (was `low`; it is now the role expected
//                                        to notice a plan that no longer matches
//                                        the codebase, and it runs BEFORE an
//                                        executor is paid)
//   research                     high    xhigh with --type alternatives
//   executor                     high    xhigh at risk: high or a checkpoint
//   ci-fix, review-fix,
//     pr-sentinel                high
//   arch-review, integrator      xhigh
//   any repair role on a
//     repeated signature         max     (see resolveEffort — it outranks this
//                                        table, and it is the ONLY built-in path
//                                        to `max`)
//
// `xhigh` and not `max` for the judges, DELIBERATELY: Anthropic's effort guidance
// names `xhigh` the best setting for most coding and agentic work (it is Claude
// Code's own default) and says to reach `max` only when measurement shows headroom
// at the level below. Nothing has measured that here, so `max` is reserved for the
// one case that IS a measurement — a signature that has repeated on one ticket.
// Raising the judges by argument instead is what this sentence exists to prevent.
//
// The three rows that changed on 2026-09-08, each of which LOOKS like a saving
// and is not (effort is 12–19% of a line):
//
//   * executor → high. Its job is to implement a contract; catching a defect in
//     that contract is not its job. `xhigh` is kept where a defect is EXPENSIVE
//     rather than merely possible — risk: high or a checkpoint, 6 of this
//     project's 49 tickets. What this gives up, stated so nobody is surprised:
//     on 2026-09-08 four of five executors corrected their own plan, and one of
//     those four could only have been found by BUILDING AN EXPERIMENT against the
//     code (a forty-round race probe that disproved the plan's prescribed atomic
//     step). No upstream role does that, and this row accepts it.
//   * drift-check → high, from low. It inherits the burden above, at the cheapest
//     place in the system to put it.
//   * pr-sentinel → high rather than xhigh, on the same reading as its tier: the
//     merge decision is enforced by sentinel.cjs, not by the model.
//
// Codex is NOT this table: there the axis is two values wide by measurement
// (ADR-005 D6) and RUNTIMES_WITH_FLAT_EFFORT answers first, above.
const EFFORT_ROWS = {
  'drift-check': () => 'high',
  research: (s) => (s.type === 'alternatives' ? 'xhigh' : 'high'),
  executor: (s) => (s.risk === 'high' || s.checkpoint === true ? 'xhigh' : 'high'),
  'ci-fix': () => 'high',
  'review-fix': () => 'high',
  'pr-sentinel': () => 'high',
  'arch-review': () => 'xhigh',
  integrator: () => 'xhigh',
};
const DEFAULT_EFFORT_ROW = 'high';

// GSD's own model_profile vocabulary, accepted as an alias for ours so a user who
// knows GSD does not get a "not one of economy|balanced|premium" warning.
const PROFILE_ALIASES = { budget: 'economy', quality: 'premium', adaptive: 'balanced', inherit: 'balanced' };

function configPath(root) {
  return path.join(root || process.cwd(), '.planning', 'config.json');
}

// A config file that EXISTS but cannot be read is not the same fact as one that
// is ABSENT, and every mutating caller has to be able to tell them apart (ADR-004
// D2, audit F03). Absent means "nobody has configured this yet", and the defaults
// are exactly the right answer. Unparseable means "what this project decided is
// UNKNOWN" — and a truncated file that said `auto_merge: off` used to resolve to
// the DEFAULT `epic` with nothing but a warning, so the guard merged under a
// policy the file forbade.
//
// So `valid` is the field a WRITER checks and `config` stays populated for
// readers: a board still has to render, a `resolve` still has to print. The
// absent/unparseable split is the same distinction `drift-needed.cjs`'s
// `readJsonDistinct` draws over delivery-state.json, drawn here over the config;
// `exists` was already half of it.
//
//   { valid: true,  error: null }                  absent, or parsed to an object
//   { valid: false, error: {file, relative, message} }  exists and does not parse
//
// `error.file` is ABSOLUTE (ci-wait.cjs runs from a worktree, where a relative
// path names nothing a person can open) and `error.relative` is the project-root
// spelling the human-facing sentences use.
function loadConfig(root) {
  const base = root || process.cwd();
  const file = configPath(base);
  const warnings = [];
  let raw = {};
  let error = null;
  const exists = fs.existsSync(file);
  const invalid = (message) => {
    error = { file, relative: path.relative(base, file), message };
    raw = {};
    // The warning says INVALID rather than "using defaults", because the
    // defaults are precisely what must NOT apply: state-sync prints every
    // warning on the board, and "using defaults" beside "no policy in effect"
    // is the board contradicting itself in two consecutive lines.
    warnings.push(
      `${error.relative} ${message} — INVALID: no policy is in effect. Every mutation refuses `
      + '(no merge, no escalation) until the file parses; the fix is the file, not a flag.'
    );
  };
  if (exists) {
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (e) {
      invalid(`is not valid JSON (${e.message})`);
    }
    // Checked BEFORE anything reads `raw.pipeline`: `JSON.parse('null')` returns
    // null and the very next line used to throw a TypeError on it, so a config
    // containing `null` took state-sync and the sentinel down with a stack trace
    // instead of a refusal. An array or a scalar is the same absence of a
    // configuration, reported the same way.
    if (!error) {
      const shape = parsed === null ? 'null' : Array.isArray(parsed) ? 'an array' : typeof parsed;
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        invalid(`is not a JSON object (got ${shape})`);
      } else {
        raw = parsed;
      }
    }
  }
  const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
  // delivery_pipeline.* (the capability's declared, GSD-native namespace) wins
  // over pipeline.* for any key present in both.
  const legacyPipeline = obj(raw.pipeline);
  const declaredPipeline = obj(raw.delivery_pipeline);
  const merged = { ...legacyPipeline, ...declaredPipeline };
  // gsd_sync is a capability-declared switch. Do not let the legacy pipeline
  // namespace appear to configure a key that the lifecycle gate never reads.
  if (Object.prototype.hasOwnProperty.call(legacyPipeline, 'gsd_sync')
      && !Object.prototype.hasOwnProperty.call(declaredPipeline, 'gsd_sync')) {
    delete merged.gsd_sync;
    warnings.push('pipeline.gsd_sync is not supported — use delivery_pipeline.gsd_sync');
  }

  // GSD's own `sub_repos` (both the flat and the nested shape it accepts). It is
  // the declared way to say "this nested checkout belongs to my project", and
  // findProjectRoot honours it BEFORE its git-boundary guard — so it is the fix
  // we point at when a `pipeline.repos` path turns out to be nested.
  const subReposRaw = raw.sub_repos ?? obj(raw.planning).sub_repos;
  const subRepos = Array.isArray(subReposRaw) ? subReposRaw : [];

  // Every container value is copied, never shared with DEFAULTS: a caller that
  // sorts or filters the palette in place would otherwise change what the next
  // loadConfig() in the same process returns.
  const cfg = {
    ...DEFAULTS,
    jira: { ...DEFAULTS.jira },
    models: {},
    effort: {},
    repos: {},
    codex_models: DEFAULT_CODEX_MODELS.map((e) => ({ ...e })),
    jira_transitions: {},
  };
  for (const [key, value] of Object.entries(merged)) {
    if (!KNOWN_KEYS.has(key)) {
      warnings.push(`unknown pipeline config key "${key}" — ignored (known: ${[...KNOWN_KEYS].sort().join(', ')})`);
      continue;
    }
    if (key === 'jira') {
      for (const [jk, jv] of Object.entries(obj(value))) {
        if (!KNOWN_JIRA_KEYS.has(jk)) { warnings.push(`unknown pipeline.jira key "${jk}" — ignored`); continue; }
        cfg.jira[jk] = jv;
      }
      continue;
    }
    if (key === 'models') {
      for (const [role, tier] of Object.entries(obj(value))) {
        if (!ROLES.includes(role)) {
          warnings.push(`pipeline.models."${role}" is not a pipeline role — ignored (roles: ${ROLES.join(', ')})`);
          continue;
        }
        if (!TIERS.includes(tier)) {
          warnings.push(
            `pipeline.models."${role}" = "${tier}" is not a tier alias — ignored. Use one of ${TIERS.join('|')}; ` +
            'full model IDs are not accepted by the Agent tool (set them in GSD model_overrides instead).'
          );
          continue;
        }
        cfg.models[role] = tier;
      }
      continue;
    }
    if (key === 'repos') {
      for (const [slug, local] of Object.entries(obj(value))) {
        if (!/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(slug)) {
          warnings.push(`pipeline.repos."${slug}" is not an owner/name slug — ignored (it must match delivery.repo in the plans)`);
          continue;
        }
        if (typeof local !== 'string' || !local) {
          warnings.push(`pipeline.repos."${slug}" must be a path to the local checkout — ignored`);
          continue;
        }
        if (!path.isAbsolute(local)) {
          warnings.push(`pipeline.repos."${slug}" = "${local}" is relative — the conveyor runs from several worktrees, so it must be an ABSOLUTE path`);
          continue;
        }
        // A sibling checkout NESTED inside this project is the one layout where
        // GSD's project-root resolution changed under us: since gsd-core 1.9.1
        // (#2843) findProjectRoot refuses to cross a git-repo boundary, so any
        // GSD tooling run inside that nested repo no longer sees THIS project's
        // .planning/ — it resolves to the child repo, silently. GSD's own escape
        // hatch is `sub_repos`, which is checked before the boundary guard, so
        // declaring it there restores the crossing deliberately.
        const rel = path.relative(base, local);
        const nested = rel && !rel.startsWith('..') && !path.isAbsolute(rel);
        if (nested && !subRepos.includes(rel.split(path.sep)[0])) {
          warnings.push(
            `pipeline.repos."${slug}" = "${local}" is nested inside this project. Since gsd-core 1.9.1, ` +
            'GSD tooling run there resolves to that repo instead of this project (findProjectRoot no longer ' +
            `crosses a git-repo boundary). Either check it out outside the project, or add "${rel.split(path.sep)[0]}" ` +
            'to sub_repos in .planning/config.json so GSD keeps resolving here.'
          );
        }
        cfg.repos[slug] = local;
      }
      continue;
    }
    if (key === 'codex_models') {
      const palette = normalizeCodexModels(value, warnings);
      // A wholly unusable value keeps the shipped palette; an explicitly EMPTY
      // one is honoured, because "write no model" is a legitimate choice.
      if (palette !== null) cfg.codex_models = palette;
      continue;
    }
    if (key === 'jira_transitions') {
      const map = normalizeJiraTransitions(value, warnings);
      // A wholly unusable value keeps the empty map, which is the projection
      // switched off — the safe direction for anything that writes to a tracker.
      if (map !== null) cfg.jira_transitions = map;
      continue;
    }
    if (key === 'effort') {
      for (const [role, level] of Object.entries(obj(value))) {
        if (!ROLES.includes(role)) {
          warnings.push(`pipeline.effort."${role}" is not a pipeline role — ignored`);
          continue;
        }
        if (level !== 'minimal' && !EFFORTS.includes(level)) {
          warnings.push(`pipeline.effort."${role}" = "${level}" is not an effort level — ignored (${EFFORTS.join('|')})`);
          continue;
        }
        // ADR-005 D3: the override is read BEFORE the signature rule, so on a
        // repair role it also switches off the depth rung a repeated failure
        // earns. It keeps its precedence — a person who measured something wins —
        // but it no longer does that silently, because shipping the effort table
        // as configuration is exactly how the repair ladder was disabled once.
        if (REPAIR_ROLES.has(role)) {
          warnings.push(
            `pipeline.effort."${role}" = "${level}" outranks the repair ladder's depth rung: a repeated ` +
            'failure signature would otherwise raise this role to "max". It is honoured, but the escalation ' +
            'is now off for this role — remove the key to get it back.'
          );
        }
        cfg.effort[role] = level;
      }
      continue;
    }
    cfg[key] = value;
  }

  // Enum-ish knobs: a misspelling here decides whether PRs get merged at all, so
  // it is reported rather than silently coerced to the safe value.
  if (cfg.auto_merge === true) cfg.auto_merge = 'epic';
  if (cfg.auto_merge === false) cfg.auto_merge = 'off';
  if (!['epic', 'off'].includes(cfg.auto_merge)) {
    warnings.push(`pipeline.auto_merge "${cfg.auto_merge}" is unknown — falling back to off (values: epic | off)`);
    cfg.auto_merge = 'off';
  }
  if (cfg.sentinel === true) cfg.sentinel = 'auto';
  if (cfg.sentinel === false) cfg.sentinel = 'off';
  if (!['auto', 'off'].includes(cfg.sentinel)) {
    warnings.push(`pipeline.sentinel "${cfg.sentinel}" is unknown — falling back to auto (values: auto | off)`);
    cfg.sentinel = 'auto';
  }
  // The sentinel is what performs an auto-merge; without a guard there is nobody
  // to re-verify the gate against live GitHub, so the pair must stay consistent.
  if (cfg.sentinel === 'off' && cfg.auto_merge === 'epic') {
    warnings.push('pipeline.sentinel is off, so nothing can auto-merge — treating pipeline.auto_merge as off (turn the sentinel back on to land ticket PRs automatically)');
    cfg.auto_merge = 'off';
  }
  // The polarity is deliberately asymmetric, the same way `preauthorized` is in
  // front.cjs: this knob authorizes landing a PR that nothing verified, so only
  // a real `true` (or the string a hand-edited JSON file acquires) opts in, and
  // anything else is reported rather than silently honoured. A misspelling here
  // must not read as consent.
  if (cfg.merge_without_ci === 'true') cfg.merge_without_ci = true;
  if (cfg.merge_without_ci === 'false') cfg.merge_without_ci = false;
  if (typeof cfg.merge_without_ci !== 'boolean') {
    warnings.push(
      `pipeline.merge_without_ci "${cfg.merge_without_ci}" is not a boolean — using false, ` +
      'so a PR with no reported checks stays a human\'s merge (values: true | false)'
    );
    cfg.merge_without_ci = false;
  }
  // The consent knob for the paid ceiling, with `sentinel`'s polarity and for a
  // sharper reason: this one authorizes a model that may bill usage credits and
  // whose consent prompt an unattended session cannot answer. So only a real
  // `auto` opts in, and anything else is reported rather than honoured — a
  // misspelling must never read as consent.
  if (cfg.fable === true) cfg.fable = 'auto';
  if (cfg.fable === false) cfg.fable = 'off';
  if (!['auto', 'off'].includes(cfg.fable)) {
    warnings.push(
      `pipeline.fable "${cfg.fable}" is unknown — falling back to off (values: auto | off), ` +
      'so the ceiling routes degrade to opus at max effort'
    );
    cfg.fable = 'off';
  }
  if (!['epic-stacked', 'direct-to-main'].includes(cfg.integration_mode)) {
    warnings.push(`pipeline.integration_mode "${cfg.integration_mode}" is unknown — falling back to epic-stacked`);
    cfg.integration_mode = 'epic-stacked';
  }
  if (PROFILE_ALIASES[cfg.model_policy]) {
    cfg.model_policy = PROFILE_ALIASES[cfg.model_policy];
  } else if (!['economy', 'balanced', 'premium'].includes(cfg.model_policy)) {
    warnings.push(`pipeline.model_policy "${cfg.model_policy}" is unknown — falling back to balanced`);
    cfg.model_policy = 'balanced';
  }
  // ONE numeric rule for every positive-number knob, and it is shared on purpose:
  // a bespoke coercion per knob is one more place to get the fallback direction
  // wrong. Two values used to pass it silently, and BOTH were properties of the
  // rule rather than of any knob — so they were shipped accepted for every one of
  // these seven at once, and probing only the endpoints is exactly how:
  //
  //   `true`  — `Number(true) === 1`, a positive finite number, so
  //             `max_concurrent_agents: true` capped a whole session at ONE agent
  //             with no warning. `false` (→ 0 → the default) is the mirror, which
  //             is why checking `false` proved nothing. A boolean is not a number:
  //             it is refused BEFORE Number(), and a numeric STRING still works,
  //             because a hand-edited config.json legitimately acquires those.
  //   `4.5`   — survived intact and produced a FRACTIONAL board (`free: 0.5` is
  //             truthy, so front.cjs's `free === 0` fixpoint branch never fired
  //             while nothing could actually be dispatched). Floored, and the
  //             floor is reported: a silently rounded knob is a value the operator
  //             did not set.
  //
  // The floor runs BEFORE the positivity check, so `0.5` floors to 0 and then
  // falls back to the default like any other non-positive value. That is
  // deliberate rather than incidental: `front.cjs`'s `capMax` reserves `max === 0`
  // for exactly one fact — no policy could be READ — and `formatFront` words its
  // line off it, so letting a parsing file resolve 0 would make the board report
  // it as unparseable. A malformed number in a readable file falls back; only an
  // unreadable file dispatches nothing.
  for (const numeric of NUMERIC_KNOBS) {
    const given = cfg[numeric];
    if (typeof given === 'boolean') {
      warnings.push(
        `pipeline.${numeric} is ${given}, which is not a number — using ${DEFAULTS[numeric]} `
        + '(a boolean coerces to 1 or 0, so it would silently read as a value nobody set)'
      );
      cfg[numeric] = DEFAULTS[numeric];
      continue;
    }
    const asNumber = Number(given);
    const n = Number.isFinite(asNumber) ? Math.floor(asNumber) : asNumber;
    if (!Number.isFinite(n) || n <= 0) {
      warnings.push(`pipeline.${numeric} must be a positive number — using ${DEFAULTS[numeric]}`);
      cfg[numeric] = DEFAULTS[numeric];
    } else {
      if (n !== asNumber) {
        warnings.push(`pipeline.${numeric} is ${asNumber}, which is not a whole number — using ${n}`);
      }
      cfg[numeric] = n;
    }
  }
  cfg.use_workflow = cfg.use_workflow === false || cfg.use_workflow === 'false' ? false : 'auto';
  cfg.graph_gate = cfg.graph_gate !== false;

  // ── GSD's own settings the conveyor must agree with ───────────────────────
  const git = obj(raw.git);
  const workflow = obj(raw.workflow);
  cfg.gsd = {
    runtime: typeof raw.runtime === 'string' ? raw.runtime : null,
    base_branch: typeof git.base_branch === 'string' && git.base_branch ? git.base_branch : null,
    branching_strategy: typeof git.branching_strategy === 'string' ? git.branching_strategy : null,
    response_language: typeof raw.response_language === 'string' ? raw.response_language : null,
    use_worktrees: typeof workflow.use_worktrees === 'boolean' ? workflow.use_worktrees : null,
  };
  // Same collision as branching_strategy, one level down. GSD's writer workflows
  // fork their own git worktree when this is true — and the conveyor calls
  // `/gsd-code-review --fix` from INSIDE a ticket worktree, so the fixer would
  // nest a worktree within ours and commit the fix where no PR is watching.
  // GSD 1.9.1 made `--fix` honor this setting, which is what makes `false` the
  // correct value rather than a preference.
  // No warning: `true` is GSD's own default and is fine here. This used to warn,
  // on the belief that `/gsd-code-review --fix` — which the conveyor DOES call
  // from inside a ticket worktree — would fork a nested one. Checked against the
  // source (1.9.1): code-review never mentions worktrees, and `git worktree add`
  // lives only in execute-phase, new-workspace and worktree-safety.cjs, none of
  // which the conveyor invokes. The boundary that DOES matter is stated
  // elsewhere and is about wave parallelism, not this flag: no shipyard path may
  // call `execute-phase`, because two orchestrators creating worktrees for the
  // same plans would collide. Keep the check keyed to that, not to a setting.
  // GSD's phase/milestone strategies create their own branches; the conveyor owns
  // branching (epic/<phase> + ticket/<id>) and the two would fight over it.
  if (cfg.gsd.branching_strategy && cfg.gsd.branching_strategy !== 'none') {
    warnings.push(
      `git.branching_strategy is "${cfg.gsd.branching_strategy}", but the delivery conveyor owns branching ` +
      '(epic/<phase> + ticket/<id> + PR per ticket). Set it to "none" so GSD does not also create phase/milestone branches.'
    );
  }
  // The plugin-namespaced agent_skills form only resolves on the claude runtime.
  const agentSkills = obj(raw.agent_skills);
  for (const [agent, entries] of Object.entries(agentSkills)) {
    const list = Array.isArray(entries) ? entries : [entries];
    for (const entry of list) {
      if (typeof entry !== 'string') continue;
      const namespaced = entry.startsWith('global:') && entry.slice(7).includes(':');
      if (namespaced && cfg.gsd.runtime && cfg.gsd.runtime !== 'claude') {
        warnings.push(
          `agent_skills."${agent}" uses "${entry}", a plugin-namespaced skill that GSD resolves ONLY on the claude ` +
          `runtime — it is silently skipped on runtime "${cfg.gsd.runtime}". Use the bare global form instead ` +
          '(e.g. "global:shipyard-delivery-rules", installed under the runtime\'s global skills dir).'
        );
      }
    }
  }

  return { config: cfg, warnings, file, exists, valid: error === null, error };
}

// `fable` exists on the Claude runtime only. GSD's tier vocabulary is
// opus|sonnet|haiku, and the Codex agent files are rendered through that map, so
// asking for `fable` there produces a model nobody can resolve. Runtime-aware
// here rather than at every call site: the ladder is the one place that decides
// what "top tier" means.
//
// UNSET means opus, not fable — the asymmetry is deliberate. The two failures are
// not equal: on Claude, `opus` instead of `fable` costs a smaller context window
// on a job that usually fits anyway; on Codex, `fable` is a model id nothing can
// resolve. So the default is the one that degrades rather than the one that
// breaks, and the 1M tier is taken only where the runtime SAYS it is available.
// `gsd-tune.cjs` writes that declaration — it is in the REQUIRED group precisely
// because several behaviours, this one included, hang off it.
const RUNTIMES_WITH_1M_TIER = new Set(['claude']);
function topTier(cfg) {
  const runtime = (cfg.gsd && cfg.gsd.runtime) || null;
  return RUNTIMES_WITH_1M_TIER.has(runtime) ? 'fable' : 'opus';
}

// A tier alias means the same STRENGTH everywhere but not the same ECONOMICS.
// On Claude, `opus` is the ordinary choice for writing code. On Codex the top
// tier is a premium reasoning model, and GSD's own catalog shows what that is
// worth: of its 34 Codex agents, exactly TWO take the top model — `gsd-planner`
// and `gsd-eval-planner`. Its executor, code-fixer, code-reviewer, debugger and
// security-auditor are all on the workhorse tier. A straight tier-for-tier
// mapping put four of our seven roles on the premium model, which is not the same
// policy expressed on a different runtime — it is a more expensive one.
//
// So outside Claude the top model goes to NOBODY here, exactly as in GSD: the
// only agents it gives `sol` to are `gsd-planner` and `gsd-eval-planner`, and the
// conveyor has no planner among its roles — decomposition is done by the main
// loop, not by a role agent. Its reviewer, executor, fixer and debugger are all
// on the workhorse. GSD expresses depth through EFFORT at the same model —
// `gsd-debugger` and `gsd-security-auditor` are `gsd-executor`'s model at xhigh
// — and that is what this cap used to lean on. It no longer holds THERE:
// ADR-005 D6 measured that the deeper efforts buy nothing on that runtime, so
// the effort axis is two values wide (see RUNTIMES_WITH_FLAT_EFFORT) and depth
// comes back from the model, through a second agent FILE per escalating role
// (D8). The cap still stands, because what it decides is which tier the
// GENERATOR renders a palette entry for, and the palette's own ceiling is what
// the escalation reaches.
const RUNTIMES_WITH_PREMIUM_TOP_TIER = new Set(['codex']);

// Where the effort axis is flat: one cheap value for the mechanical role, one
// working value for everything else (ADR-005 D6). Not a limitation of the
// runtime — a measurement of it.
const RUNTIMES_WITH_FLAT_EFFORT = new Set(['codex']);
function capForRuntime(tier, cfg) {
  const runtime = (cfg.gsd && cfg.gsd.runtime) || null;
  if (!RUNTIMES_WITH_PREMIUM_TOP_TIER.has(runtime)) return tier;
  return TOP_TIERS.has(tier) ? 'sonnet' : tier;
}

// A runtime name reaches the route from the CONFIG, so it is slugged before it
// becomes a rule token: an operator's `runtime: "Claude Code"` would otherwise
// risk a route with a space in it, which `parseRoute` — the grammar
// dispatch-record validates against — would reject. Today both call sites below
// gate on an EXACT `=== 'codex'` match against the raw value before either ever
// reaches this function, so `runtimeToken` only ever sees `'codex'` in practice —
// this guards a FUTURE caller (a broadened match, a third call site) rather than
// a live failure, and the function's own contract (never a bare punctuation
// remnant, see below) should hold regardless of who calls it or how.
const runtimeToken = (cfg) => {
  // A whitespace-only (or otherwise all-punctuation) runtime slugs to a bare
  // "-", which is non-empty and so slips past the `|| 'unset'` fallback below —
  // it would leak into a route token as e.g. `cap:-`. Trim the leading/trailing
  // hyphens the replace can produce before testing for emptiness.
  const slug = String((cfg.gsd && cfg.gsd.runtime) || 'unset')
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'unset';
};

// ── the ceiling: three mechanical routes to `fable` (ADR-005 D4) ─────────────
//
// Each route is COMPUTABLE from something the caller measured or the journal
// recorded; none is a prompt rule, and none of them is a role's default. There is
// no standing exception any more — the integrator goes through R1 like everything
// else. (An earlier draft gave it `fable` unconditionally because it "reads the
// largest input in the system, runs once per phase, and is the last mechanical
// judgment before a person merges": all true, and none of it a measurement. Its
// single run on 2026-09-08 consumed 291k tokens end to end, against `fable`
// costing exactly 2× `opus` on every component. Being the last judgement before a
// human merge is why its EFFORT is `xhigh` and never drops — not why it would
// take the bigger model.)
//
// Returns null when no route fires, or {route, why, model, degraded, reason}.
// `degraded` means the route fired and could NOT be honoured: the answer is then
// `opus` at `max` effort, which is the ADR's own escalation ORDER (opus at depth
// first, fable after) with the reason printed rather than silently swallowed.
function fableRoute(role, signals = {}, cfg = DEFAULTS) {
  let route = null;
  let why = '';
  // R1 — window pressure. The CALLER measures its own input and passes the
  // number; the resolver only compares. Absent (`undefined`, or anything
  // non-numeric) cannot fire: an absent signal must never resolve upward.
  const tokens = Number(signals.inputTokens);
  const threshold = Number(cfg.fable_window_tokens) || DEFAULTS.fable_window_tokens;
  if (Number.isFinite(tokens) && tokens > threshold) {
    route = 'window';
    why = `--input-tokens ${tokens} is over pipeline.fable_window_tokens (${threshold})`;
  } else if (REPAIR_ROLES.has(role) && signals.signatureState === 'repeat_exhausted') {
    // R2 — exhausted depth. The same failure a third time, after a `rethink` at
    // `max` (Claude) or at the same effort (Codex) already failed. The verdict is
    // computed once, by `failure-signature.cjs computeVerdict`, so the journal
    // stays the single source and this stays a pure function.
    route = 'exhausted';
    why = 'the same failure signature came back after the deeper effort was already spent on it';
  } else if (signals.contested === true && JUDGMENT_ROLES.has(role)) {
    // R3 — contested JUDGMENT, and the role is part of the condition. Both facts
    // that set this flag are a judge's own prior verdict: the journal already
    // holds an `arch_review … verdict=violation` for this ticket, or the
    // integrator has returned `needs-fix` on this epic before — a second reading
    // at the same depth is what produced the contested verdict in the first
    // place. A fixer carrying the flag is not a re-judgement, and a route that
    // any role could open with one flag is not a ceiling that has to be earned.
    route = 'contested';
    why = 'this judgement has already been contested once (--contested)';
  }
  if (!route) return null;

  const consented = cfg.fable === 'auto';
  const runtimeHasIt = topTier(cfg) === 'fable';
  if (consented && runtimeHasIt) return { route, why, model: 'fable', degraded: false, reason: null };
  return {
    route,
    why,
    model: 'opus',
    degraded: true,
    reason: !consented
      ? `pipeline.fable is "${cfg.fable}", so the ceiling stays closed — opus at max effort instead ` +
        '(set it to "auto" once a person has answered Fable\'s consent prompt interactively)'
      : `the "${(cfg.gsd && cfg.gsd.runtime) || 'unset'}" runtime has no 1M-context tier, so the ` +
        'ceiling is opus at max effort (on Codex the escalation is a `-deep` agent file — ADR-005 D8)',
  };
}

// The ladder BEFORE the runtime cap — the strength this role deserves.
//
// Order: an explicit override, then the earned CEILING, then the FLOOR. The
// ceiling sits ABOVE the floor deliberately: expressing the floor through
// `pipeline.models.*` instead (which is how it was piloted) short-circuits this
// function at the override and no escalation could ever fire.
// Every step returns the RULE beside the value, and the value the callers below
// take is `.value` — so the route is a BYPRODUCT of the decision rather than a
// second function that describes it. A parallel `explainRoute()` mirroring these
// branches is exactly the shape ADR-006's Consequences name: a claim about a
// mechanism written from its documented intent, which is how three assertions in
// one session came to be disproved by opening the file.
function tierRoute(role, signals = {}, cfg = DEFAULTS) {
  const override = cfg.models && cfg.models[role];
  if (override) return { value: override, rule: 'override' };

  // A fired route overrides the two sonnet exemptions as well: they say "the
  // model is not the gate here", and a route firing is the measured evidence
  // that on THIS dispatch it is.
  const ceiling = fableRoute(role, signals, cfg);
  if (ceiling) {
    return { value: ceiling.model, rule: `ceiling:${ceiling.route}${ceiling.degraded ? ':degraded' : ''}` };
  }

  // The floor. `model_policy` deliberately does not appear: the floor is not a
  // preference (ADR-005 D1), so no profile moves it in either direction. The key
  // survives because `gsd-tune` mirrors it onto GSD's own `model_profile`, which
  // governs GSD's agents rather than the conveyor's roles.
  return SONNET_ROLES.has(role)
    ? { value: 'sonnet', rule: 'floor:exempt' }
    : { value: 'opus', rule: 'floor' };
}

// The tier the Agent tool is handed, and which rule produced it — the cap is
// appended rather than replacing the rule, because "the floor chose opus and the
// runtime capped it" is two facts and a reader of the journal needs both.
function modelRoute(role, signals = {}, cfg = DEFAULTS) {
  const tier = tierRoute(role, signals, cfg);
  const capped = capForRuntime(tier.value, cfg);
  if (capped === tier.value) return tier;
  return { value: capped, rule: `${tier.rule}+cap:${runtimeToken(cfg)}` };
}

// role × signals routing. Returns a tier alias the Agent tool accepts.
function resolveModel(role, signals = {}, cfg = DEFAULTS) {
  return modelRoute(role, signals, cfg).value;
}

// Reasoning effort — the axis the policy now rests on, keyed on the ROLE and its
// signals rather than on the resolved model (ADR-005 D2). The dependency had to
// invert: the old rule derived the effort tier FROM the model, so the moment the
// floor made the model constant everything collapsed to `xhigh` and
// `--signature-state repeat` stopped deepening anything. `model` stays in the
// signature for the callers that pass it, and drives nothing.
//
// Order, and every step of it is load-bearing:
//   1. an explicit `pipeline.effort.<role>` override (warned about at load time
//      when it shadows a repair role — ADR-005 D3);
//   2. the flat-effort runtime (Codex), where the axis is two values wide by
//      measurement and there is no deeper rung to escalate INTO;
//   3. a repair role whose signature came back — `max`, the only built-in path to
//      it, and earned by a repeated failure rather than chosen;
//   4. a ceiling route that fired but could not be honoured — `max` at the floor
//      model, which is the escalation the closed ceiling still owes;
//   5. the role's own row in EFFORT_ROWS.
function effortRoute(role, model, cfg = DEFAULTS, signals = null) {
  const runtime = (cfg.gsd && cfg.gsd.runtime) || null;
  const clamp = (level) => {
    // `minimal` is Codex-only in GSD and is not in Workflow's enum at all.
    // There is deliberately no `max` → `xhigh` clamp for Codex any more: both
    // halves of its justification were false (ADR-005 D7). GSD's
    // `codexModelEffort._baseline` advertises `max` for every model, and
    // `advertisedCodexEffort` returns that baseline for any model it does not
    // name — which the palette's ceiling is. No built-in path asks for `max`
    // there, so the clamp only ever rewrote an operator's explicit choice.
    if (level === 'minimal') return 'low';
    return EFFORTS.includes(level) ? level : 'high';
  };
  // `+clamp` is appended wherever the clamp actually MOVED the value, so a route
  // never reports a depth the resolver declined to return.
  const routed = (level, rule) => {
    const value = clamp(level);
    return { value, rule: value === level ? rule : `${rule}+clamp` };
  };
  const override = cfg.effort && cfg.effort[role];
  if (override) return routed(override, 'override');
  // ADR-005 D6 — on THIS runtime the effort axis has two values, by measurement
  // rather than by limitation: `xhigh` and `max` cost more there without a
  // better result, and the ceiling model's best results are at `high`. So the
  // ladder below does not apply; depth comes from the MODEL instead, which is
  // what the `-deep` agents make reachable (D8). Placed after the override so an
  // explicit configuration still wins, and before the repeat rule because there
  // is no deeper rung here to escalate INTO — a repeat still changes strategy
  // (`rethink`), which is the half that survives.
  if (RUNTIMES_WITH_FLAT_EFFORT.has(runtime)) {
    return routed(MECHANICAL_ROLES.has(role) ? 'low' : 'high', `flat:${runtimeToken(cfg)}`);
  }
  // The same failure came back: hold the tier, deepen the thinking (ADR-001 D1).
  // `max` and not `xhigh` — under the opus floor `xhigh` is where the judges
  // already sit, so it stopped being a raise at all, which is the regression this
  // rung is being restored from. Both repeat states qualify: on `repeat_exhausted`
  // the MODEL moves (fableRoute's R2) and the depth stays at the deepest rung,
  // because backing the thinking off while raising the model is neither ladder.
  // No mechanical-role guard is needed — no repair role is mechanical, and
  // drift-check is not a repair.
  if (signals && REPAIR_ROLES.has(role)
      && (signals.signatureState === 'repeat' || signals.signatureState === 'repeat_exhausted')) {
    // `repeat` and `repeat:exhausted` rather than the state's own spelling: the
    // grammar below has no underscore in it, and the rule token is the one thing
    // in a route that a later reader groups by.
    return routed('max', signals.signatureState === 'repeat' ? 'repeat' : 'repeat:exhausted');
  }
  // A ceiling route fired and the ceiling is shut (no consent, or a runtime with
  // no 1M tier). The escalation does not simply vanish: it lands on the axis that
  // IS available, which is depth at the floor model — ADR-005's own reading of
  // Fable's positioning ("opus at higher effort first, fable after"), applied in
  // the direction the config allows.
  if (signals) {
    const ceiling = fableRoute(role, signals, cfg);
    if (ceiling && ceiling.degraded) return routed('max', `degraded:${ceiling.route}`);
  }
  const row = Object.prototype.hasOwnProperty.call(EFFORT_ROWS, role) ? EFFORT_ROWS[role] : null;
  return routed(row ? row(signals || {}) : DEFAULT_EFFORT_ROW, row ? 'row' : 'row:default');
}

function resolveEffort(role, model, cfg = DEFAULTS, signals = null) {
  return effortRoute(role, model, cfg, signals).value;
}

// ── THE ROUTE: which rule chose the tier, and which chose the effort ─────────
//
// The journal used to record a `reason` the CALLER composed — its own reading of
// which branch of the ladder had fired — while the resolver named the route only
// on stderr, as prose. So a field that exists to make a later ladder review cheap
// held the caller's opinion of the mechanism instead of the mechanism's answer,
// and two rows written by two callers were not comparable (ADR-006 D5, and the
// review that found it reproduced the gap rather than reading it).
//
// One line, one grammar, both halves: `tier=<rule>(<alias>) effort=<rule>(<level>)`.
// It is a REGULAR grammar because it is meant to be counted later — `parseRoute`
// is exported so the recorder validates against the resolver's own definition
// rather than a copy of it, the lesson `CODEX_DEEP_ROLES` already paid for.
const ROUTE_RE = /^tier=([a-z][a-z0-9:+-]*)\(([a-z]+)\) effort=([a-z][a-z0-9:+-]*)\(([a-z]+)\)$/;

function routeOf(role, signals = {}, cfg = DEFAULTS) {
  const m = modelRoute(role, signals, cfg);
  const e = effortRoute(role, m.value, cfg, signals);
  return `tier=${m.rule}(${m.value}) effort=${e.rule}(${e.value})`;
}

// Returns {tier: {rule, model}, effort: {rule, effort}} or null. The parenthesised
// values are checked against TIERS/EFFORTS here, so a reader that parses a route
// never has to re-validate them — and a hand-composed sentence cannot pass for
// one, which is the whole point of the field.
function parseRoute(text) {
  const m = ROUTE_RE.exec(String(text == null ? '' : text));
  if (!m) return null;
  if (!TIERS.includes(m[2]) || !EFFORTS.includes(m[4])) return null;
  return { tier: { rule: m[1], model: m[2] }, effort: { rule: m[3], effort: m[4] } };
}

// ── the signals a role's rows actually read, and what silence costs ──────────
//
// ADR-004's principle, turned on the ladder: A SIGNAL THAT IS ABSENT MUST NEVER
// RESOLVE UPWARD. Under this table every signal-keyed row is an UPGRADE, so
// silence resolves to the cheaper row by construction — which is the opposite of
// the defect that produced this rule (`Number(undefined) <= 2` is false, so the
// executor's light path never fired once in 173 dispatches and every one of them
// silently bought the dearer answer).
//
// The direction inverts with it: a missing signal is no longer a cost surprise,
// it is a DEPTH the dispatch quietly declined. So the resolver still says so on
// stderr — the same channel the config warnings use, so the gap shows up in a
// dispatch line rather than only in a bill or in a shallow verdict.
//
// Only signals that a row READS are listed. `--files`, `--code-change` /
// `--no-code-change`, `--attempt` and `--previous-failed` are accepted and inert
// (the floor removed the rows they used to gate), and warning about those would
// fire on every dispatch — which is how a warning teaches its reader to ignore
// warnings.
const SIGNAL_GAPS = {
  executor: [{
    flag: '--risk <low|medium|high>',
    absent: (s) => s.risk === undefined,
    cost: 'assuming medium → effort high; the xhigh row needs --risk high or --checkpoint',
  }],
  research: [{
    flag: '--type <plan type>',
    absent: (s) => s.type === undefined,
    cost: 'assuming facts → effort high; --type alternatives is the xhigh row',
  }],
  'arch-review': [{
    flag: '--input-tokens <n>',
    absent: (s) => !Number.isFinite(Number(s.inputTokens)),
    cost: 'the ceiling\'s window route cannot fire without a measured input',
  }],
  integrator: [{
    flag: '--input-tokens <n>',
    absent: (s) => !Number.isFinite(Number(s.inputTokens)),
    cost: 'the ceiling\'s window route cannot fire without a measured input',
  }],
};

// The rows this dispatch could not reach for want of a signal, as sentences.
function signalGaps(role, signals = {}) {
  const rows = Object.prototype.hasOwnProperty.call(SIGNAL_GAPS, role) ? SIGNAL_GAPS[role] : [];
  return rows.filter((r) => r.absent(signals)).map((r) => `${role} reads ${r.flag} and did not get it — ${r.cost}`);
}

module.exports = {
  loadConfig, resolveModel, resolveEffort, strategyFor, fableRoute, signalGaps,
  routeOf, parseRoute, ROUTE_RE, runtimeToken,
  parseCodexModelEntry, normalizeCodexModels,
  normalizeJiraTransitions, TICKET_STATUSES,
  DEFAULTS, TIERS, EFFORTS, ROLES, REPAIR_ROLES, STRATEGIES, SIGNATURE_STATES,
  DEFAULT_CODEX_MODELS, SONNET_ROLES, EFFORT_ROWS, NUMERIC_KNOBS,
};

// ── CLI ─────────────────────────────────────────────────────────────────────
if (require.main === module) {
  const [, , cmd, ...rest] = process.argv;
  const { config, warnings, file, exists, valid, error } = loadConfig(process.cwd());

  if (cmd === 'resolve' || cmd === undefined) {
    // `valid` rides the CLI answer too, for the same reason it rides the module's
    // (ADR-004 D2): this is loadConfig's shell face, and a reader taking
    // `.config.auto_merge` off a corrupt file would get the DEFAULT `epic` with
    // no way to see that the file said otherwise — F03 again, one surface over.
    process.stdout.write(JSON.stringify({
      config,
      warnings,
      valid,
      error,
      config_file: exists ? path.relative(process.cwd(), file) : null,
    }, null, 2) + '\n');
    process.exit(0);
  }

  if (cmd === 'model') {
    const role = rest[0];
    if (!ROLES.includes(role)) {
      process.stderr.write(`pipeline-config: unknown role "${role}" (roles: ${ROLES.join(', ')})\n`);
      process.exit(2);
    }
    const flag = (name) => {
      const i = rest.indexOf(`--${name}`);
      return i === -1 ? undefined : rest[i + 1];
    };
    // An unknown value is ignored with a warning — the same posture as every
    // invalid config value in this file, and for a sharper reason here: a
    // resolver that exits non-zero at 3am stops the round it exists to keep
    // running.
    let signatureState;
    let signatureStateWarning = null;
    if (rest.includes('--signature-state')) {
      const value = flag('signature-state');
      if (SIGNATURE_STATES.includes(value)) {
        signatureState = value;
      } else {
        signatureStateWarning =
          `--signature-state "${value === undefined ? '' : value}" is not a signature state — ignored ` +
          `(${SIGNATURE_STATES.join('|')}; compute it with \`failure-signature.cjs verdict\`)`;
      }
    }
    const signals = {
      risk: flag('risk'),
      type: flag('type'),
      // The caller's own measurement of this dispatch's input. Read by the
      // ceiling's window route; anything non-numeric is the same as absent, and
      // absent cannot fire it.
      inputTokens: flag('input-tokens'),
      contested: rest.includes('--contested'),
      // Accepted, recorded, and INERT (ADR-001 D1 for the attempt pair; the opus
      // floor for the other two — it removed the cheaper rows `files` and
      // `codeChange` used to gate, so neither routes anything now). They stay
      // because deliver.md and references/ still spell them and telemetry still
      // passes them; passing one is not an error, so it does not warn. Both
      // spellings of the code-change signal are parsed so that "no flag" and
      // "yes, code changed" stop being the same value on the record.
      files: flag('files'),
      codeChange: rest.includes('--code-change') ? true : rest.includes('--no-code-change') ? false : undefined,
      attempt: flag('attempt'),
      previousFailed: rest.includes('--previous-failed'),
      signatureState,
      checkpoint: rest.includes('--checkpoint'),
    };
    for (const w of warnings) process.stderr.write(`pipeline-config: warning: ${w}\n`);
    if (signatureStateWarning) process.stderr.write(`pipeline-config: warning: ${signatureStateWarning}\n`);
    // A row this dispatch could not reach for want of a signal (see SIGNAL_GAPS):
    // it resolves DOWNWARD, which is correct, and it says so rather than leaving
    // the gap visible only in a shallow verdict.
    for (const gap of signalGaps(role, signals)) {
      process.stderr.write(`pipeline-config: warning: ${gap}\n`);
    }
    // The ceiling, and the two ways it can be missed: a shut gate, or an override
    // that outranks it. Both are legitimate; both are silent by default, and this
    // is the one moment a reader can act on them.
    const ceiling = fableRoute(role, signals, config);
    if (ceiling) {
      const override = config.models && config.models[role];
      if (override) {
        process.stderr.write(
          `pipeline-config: warning: the ${ceiling.route} ceiling route fired for ${role} ` +
          `(${ceiling.why}) but pipeline.models."${role}" = "${override}" outranks it — remove the ` +
          'override to let the escalation through\n'
        );
      } else if (ceiling.degraded) {
        process.stderr.write(
          `pipeline-config: warning: the ${ceiling.route} ceiling route fired for ${role} ` +
          `(${ceiling.why}) — ${ceiling.reason}\n`
        );
      }
    }
    const model = resolveModel(role, signals, config);
    if (rest.includes('--json')) {
      // `route` is the resolver's own answer to "which rule chose this", and it is
      // what `dispatch-record.cjs mark --route` records: the journal's `reason`
      // field holds the ladder's route rather than the caller's sentence about it
      // (ADR-006 D5). Emitted on every `--json` call, because a field the caller
      // has to ask for is one the caller composes when it forgets to.
      const out = { model, effort: resolveEffort(role, model, config, signals), route: routeOf(role, signals, config) };
      // `strategy` appears ONLY when a valid state was passed, so a consumer
      // reading `{model, effort, route}` sees a stable shape either way.
      if (signatureState) out.strategy = strategyFor(signatureState);
      process.stdout.write(JSON.stringify(out) + '\n');
    } else {
      process.stdout.write(model + '\n');
    }
    process.exit(0);
  }

  process.stderr.write(
    'usage: pipeline-config.cjs <resolve | model <role> [--json] [flags]>\n' +
    '  flags: --risk low|medium|high  --type <plan type>  --checkpoint\n' +
    '         --input-tokens <n>   the caller\'s measurement of this dispatch\'s input;\n' +
    '                              over pipeline.fable_window_tokens it earns the ceiling\n' +
    '         --contested          this judgement was already contested once\n' +
    '         --signature-state ' + SIGNATURE_STATES.join('|') + '\n' +
    '         --files <n>  --code-change|--no-code-change  --attempt <n>  --previous-failed\n' +
    '           (all accepted, telemetry only: the attempt pair never routed a repair\n' +
    '            tier since ADR-001 D1, and the opus floor removed the cheaper rows the\n' +
    '            other two used to gate)\n'
  );
  process.exit(2);
}
