#!/usr/bin/env node
'use strict';

// dispatch-record.cjs — the durable home for "this ticket is with an agent right
// now".
//
//   dispatch-record.cjs mark  <ticket> <role> [--model <alias>] [--effort <level>]
//                             [--effort-applied <level|unsupported|unknown>]
//                             [--route <resolver route>]
//                             [--task-level <level>] [--runtime <runtime>]
//                             [--backend <backend>] [--observed-model <id>]
//                             [--observed-effort <level>] [--agent-file <name>]
//                             [--agent-id <launch id>] [--dispatch-id <id>]
//                             [--graph <dir>]
//   dispatch-record.cjs mark-many --stdin [--graph <dir>]
//                             # JSON array of {ticket, role, ...mark fields}
//   dispatch-record.cjs clear <ticket>        [--graph <dir>]
//   dispatch-record.cjs clear-many --stdin [--graph <dir>]
//                             # JSON array of {ticket, dispatch_id}
//   dispatch-record.cjs list  [--json]        [--graph <dir>]
//
// Why this exists. The front's vocabulary had no state for DISPATCHED AND
// RUNNING, so a ticket handed to an agent was indistinguishable from one nobody
// had touched: nothing is pushed yet, so state-sync — which reads GitHub — still
// classifies it `execute`, and the stop gate then refuses a turn over work that
// is already in flight. Measured five times in one session (3, 5, 6, 4 and 5
// items), across BOTH owners, every one verified in flight before it was
// reported.
//
// It is wrong by construction rather than by accident: deliver.md tells the run
// to post the guard and NOT wait for it, so `fix`/`finalize`/`merge` are
// dispatched BY DESIGN. A run that follows the documented protocol therefore
// mis-reports the guard's buckets on every healthy round. The evidence of a
// dispatch lived only in the orchestrator's session, which is exactly the kind of
// fact this conveyor has repeatedly learned not to keep there (`--parked` →
// escalation-record, the drift verdict → drift.json).
//
// EXPIRY IS THE WHOLE DESIGN, and it has TWO independent triggers because either
// alone leaves a hole. A record that never lifted would hide a ticket the next
// run must pick up — trading a spurious block for a SILENT STALL, which is the
// worse of the two outcomes and the one this store must never produce:
//
//   1. THE OWNER'S OUTPUT EXISTS. The dispatch is a claim that an agent is
//      PRODUCING something; the moment that output appears in delivery state — a
//      branch or a PR for an executor, a new head for a fixer, a gate trailer for
//      arch-review, a merge or a retarget for the guard — the dispatch has done
//      its job and the board owns the ticket again.
//
//      It used to be bound to escalation-record's shared `fingerprint`, which
//      hashes the CHECK TALLIES: a guard's dispatch therefore expired the moment
//      ANY check finished, which is minutes after the fixer was handed the work
//      and long before it has pushed. The front re-offered the PR, the stop gate
//      blocked over it, and a second fixer could be dispatched at the same PR
//      (ADR-002 A1/D1). "The PR moved" is not one fact: three stores needed three
//      meanings of it, so each owns its own — `dispatchFingerprint` below, keyed
//      by ROLE, and no role's fields include a tally. The shared hash is still
//      imported, for records written before the split.
//   2. A TTL, so a killed session cannot park a ticket forever. See below.
//
// Neither needs a second command to remember, which is the property that makes
// this safe to write from a loop that may not survive to clean up after itself.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { withLock, lockDirFor, writeAtomic } = require(path.join(__dirname, 'lock.cjs'));
// Only for records written before this store had its own per-role rule; see
// `activeDispatches`. Never reimplemented, so a legacy record is read with exactly
// the hash it was written with.
const { fingerprint } = require(path.join(__dirname, 'escalation-record.cjs'));
// One role vocabulary for the whole conveyor: the same names `pipeline-config.cjs
// model <role>` resolves a model for. A dispatch filed under a name the ladder
// does not know is a record whose owner nobody can identify.
//
// TIERS and EFFORTS come from the SAME module for the same reason: the recorder
// validates against the ladder's own vocabulary, never a copy of it, or a tier
// added there would be refused here by a list nobody remembered to update.
// `parseRoute` for the same reason again: the route the journal records is the
// RESOLVER's, so it is validated against the resolver's own grammar rather than a
// regex copied over here — the drift `CODEX_DEEP_ROLES` already paid for.
const {
  ROLES, TIERS, EFFORTS, TASK_LEVELS, parseRoute,
} = require(path.join(__dirname, 'pipeline-config.cjs'));

// HOW LONG A DISPATCH MAY STAY SILENT — the backstop, not the main rule. It only
// has to cover the longest stretch of REAL work that legitimately moves no
// delivery state at all, because anything that moves state expires by trigger 1
// long before this.
//
// Measured from this repo's own delivery journal rather than rounded to a
// comfortable number. The longest observed dispatch→publish stretch is one
// executor wave: phase 21 wave 1 opened its PRs at 13:52 and wave 2 (dispatched
// off that board) opened at 14:29 — 37 minutes with nothing pushed in between.
// Phase 20 gives 29 minutes for the same span, phase 22 gives 14. The longest
// PR LIFETIME in the same journal is 135 minutes (T-21-02), but every minute of
// that moves checks, drafts or review decisions, so trigger 1 has already fired.
// 90 minutes is ~2.4x the worst silent stretch on record — enough that a slow
// wave is never dropped mid-flight, short enough that a session killed at
// midnight is not still hiding its tickets at 02:00.
const TTL_RAW = Number(process.env.SHIPYARD_DISPATCH_TTL_MS || 90 * 60 * 1000);
// Garbage in the env var must not disable the backstop: NaN poisons every
// comparison into "never expired", which is precisely the silent stall.
const DISPATCH_TTL_MS = Number.isFinite(TTL_RAW) && TTL_RAW > 0 ? TTL_RAW : 90 * 60 * 1000;

// WHAT EACH ROLE'S OUTPUT LOOKS LIKE IN DELIVERY STATE — one table, because the
// per-role rule and the per-role sentence on the board must not be able to
// disagree, and because everything the skills are told to "decide" that can be
// computed belongs in a script.
//
// Keyed by the ladder's own role names (`ROLES`, the vocabulary `mark` already
// validates against), so a role added there cannot silently inherit a list that
// describes somebody else's output; tests/unit/dispatch-record.test.cjs iterates
// ROLES and fails if one has no entry. `checks.*` appears in NO entry, by design
// and by test — a tally is the pipeline moving, never an agent's output.
//
// `head_sha` is recorded by state-sync from T-24-04 on. Absent, it hashes as null
// on both sides, so a fixer dispatched before it exists expires on status/pr and
// on the TTL exactly as it did — graceful by construction, no special case.
const DISPATCH_SUBJECT = {
  // The main loop's own: nothing is pushed when the work is handed over, so the
  // first branch or PR to appear IS the output.
  executor: { fields: ['status', 'pr', 'branch'], lifts: 'a branch or a PR appears' },
  // A fixer's whole product is a new commit on the PR. Before head_sha existed
  // its push was visible only as status/pr, which is why both are still here.
  'ci-fix': { fields: ['head_sha', 'status', 'pr'], lifts: "the PR's head moves (a push)" },
  'review-fix': { fields: ['head_sha', 'status', 'pr'], lifts: "the PR's head moves (a push)" },
  // A judge writes a verdict into the PR body (`gate_status:`) and may undraft.
  'arch-review': { fields: ['gate', 'draft', 'status'], lifts: 'the gate trailer or the draft state changes' },
  // The guard's output is a merge, or the retarget that follows one.
  'pr-sentinel': { fields: ['status', 'pr_base', 'pr'], lifts: 'the PR merges, or its base moves' },
  integrator: {
    fields: ['status', 'pr', 'pr_base', 'gate', 'draft'],
    lifts: 'the integration PR appears, its gate changes, or it lands',
  },
  // Neither leaves a mark in delivery state at all — a drift verdict goes to
  // drift.json, research to a document — so in practice the TTL is what returns
  // these. Any motion of the ticket still counts, and no tally does.
  'drift-check': { fields: ['status', 'pr', 'branch'], lifts: "the ticket's status, PR or branch changes" },
  research: { fields: ['status', 'pr', 'branch'], lifts: "the ticket's status, PR or branch changes" },
};

// A role the table does not know keeps the executor's list: motion of the ticket
// itself, no tallies. It must never be the shared hash again.
const DEFAULT_SUBJECT = DISPATCH_SUBJECT.executor;

const subjectOf = (role) => DISPATCH_SUBJECT[role] || DEFAULT_SUBJECT;

// ── WHAT THE DISPATCH DECIDED, recorded beside WHO holds the ticket ──────────
//
// The record used to carry `role` and nothing about the model, so the journal
// could say a judge was dispatched 196 times and not once what it ran at. Every
// row of the ladder was therefore adopted on reasoning, and no revision of it
// could be better than the reasoning until these fields existed.
//
// Every one is OPTIONAL and every one is written ONLY when the caller passes it.
// There is no default, no inference and no fallback to a session setting: an
// omitted flag writes NO KEY AT ALL, because absence here means UNMEASURED and a
// `null` would read as a measured unknown. The same discipline the conveyor
// applies to `landed`, `checks` and `unresolved` — positive evidence before a
// mutation, and writing a fact IS the mutation.
//
// `effort` and `effort_applied` are TWO CLAIMS and must never be collapsed into
// one:
//   * `--effort` is what the RESOLVER decided (`pipeline-config.cjs model … --json`);
//   * `--effort-applied` is what the SPAWN could actually carry, and only the
//     Workflow path can: `agent()` takes an effort, the Agent tool has no such
//     parameter, so an Agent-dispatched judge runs at the SESSION's own effort
//     whatever the ladder chose. Recording the resolved value as applied would
//     poison the very evidence these fields exist to collect — a later review
//     would compare rows that were never in force against rows that were.
// So the Agent path omits `--effort-applied`, its absence means "nobody measured
// this", and the recorder must not helpfully fill it in from the other flag.
const MARK_FLAGS = [
  'model', 'effort', 'effort-applied', 'route', 'task-level', 'runtime', 'backend',
  'observed-model', 'observed-effort', 'agent-file', 'agent-id', 'dispatch-id',
];

// ── `reason` is the RESOLVER's route, never the caller's sentence ────────────
//
// The field shipped as `--reason <text>` and deliver.md claimed the text was
// "the branch the resolver already returned". It was not: the resolver returned
// `{model, effort}` and named the route only on stderr, as prose — so what landed
// in the journal was the caller's READING of the ladder, in whatever words that
// caller chose. One field then held two provenances, and the field exists for
// exactly one purpose: to make a later review of the ladder cheap by counting
// rows. Two vocabularies cannot be counted (ADR-006 D5).
//
// So the flag is refused rather than merged, with its own branch and its own
// message — dropping it from MARK_FLAGS alone would report it as an "unexpected
// argument", which names neither the replacement nor where the value comes from.
const REFUSED_FLAGS = {
  reason: 'a hand-composed reason is not the ladder\'s answer, it is the caller\'s reading of it, and one\n' +
    '  field cannot hold both provenances and still be countable.\n' +
    '  The route comes from the resolver: `pipeline-config.cjs model <role> --json [flags]` now returns\n' +
    '  a `route` field beside the pair — pass THAT, verbatim, as `--route "<route>"`.',
};
// Flag name → the key written into the record and the journal line. The query in
// deliver.md reads these names, so they are the field vocabulary, not an
// implementation detail.
const MARK_FIELD = {
  model: 'model',
  effort: 'effort',
  'effort-applied': 'effort_applied',
  // The KEY stays `reason`: two journal rows already carry it and deliver.md's
  // ladder query reads it by that name. What changed is where the value comes
  // from, not what a reader greps for.
  route: 'reason',
  'task-level': 'task_level',
  runtime: 'runtime',
  backend: 'backend',
  'observed-model': 'observed_model',
  'observed-effort': 'observed_effort',
  'agent-file': 'agent_file',
  'agent-id': 'agent_id',
  'dispatch-id': 'dispatch_id',
};

// ── WHO holds it, not just WHAT it is (ADR-007 D1) ───────────────────────────
//
// The record named the ROLE and nothing about the agent, and `front.cjs` then
// collapsed a guard's N records to one agent by adding that role string to a Set.
// Two guards are legitimate — `deliver.md` tells the run to re-post one for PRs
// opened after the first started — so two of them counted as one, and the
// reported board was `max=4, in_flight=3, free=1` with four agents genuinely
// out: an authorisation to spend past the cap, which is not a cap.
//
// So the dispatch carries the identity of the agent holding it: the id the LAUNCH
// returned (the Workflow tool a task id, the Agent tool an agent id), passed
// verbatim. That provenance rule is `--route`'s, for the same reason — a value
// the caller composes and a value the mechanism returned cannot share one field
// and stay countable. A hand-typed label is the ONE way this field can make the
// count wrong (two guards under one name read as one agent), and no validation
// can catch it, so the refusal below says so and deliver.md says so too.
//
// It is OPTIONAL like every other decided field, and its absence is not an error:
// an older store must still read, and `agentsInFlight` counts a record with no
// identity as its own agent — unknown resolves UPWARD wherever the answer is a
// budget to spend. That is why the refusal tells a caller with no id to OMIT the
// flag rather than invent one: an anonymous record over-counts (a stall), an
// invented one under-counts (a spend), and only the second is unsafe.
const AGENT_ID_MAX = 200;

// ONE rule for "is this string safe to hold as an agent identity", read by both
// the write path (mark, below) and the read path (`agentIdOf`, near the bottom).
// Two copies of this check would be free to disagree about a hand-edited or
// pre-validation record, and `front.cjs`'s Set key relies on the invariant this
// enforces — no whitespace or control character in either half of the joined
// `role\u0000identity` key — holding for every record it ever reads, not only
// ones this script itself wrote.
function agentIdSafetyIssue(id) {
  if (typeof id !== 'string') return 'it is not a string';
  if (id.trim() === '') return 'it is blank';
  if (/[\s\u0000-\u001f\u007f]/.test(id)) {
    return 'it contains whitespace or a control character, so two spellings of one id would count as two agents';
  }
  if (id.length > AGENT_ID_MAX) return `it is longer than ${AGENT_ID_MAX} characters, which no launch id is`;
  return null;
}

// Requested/applied/observed reconciliation is useful only when the extra
// fields have stable vocabularies. Model ids are intentionally opaque because
// Codex can expose a new concrete id before GSD's catalog knows it; the safety
// check only protects the JSONL line and keeps whitespace from creating two
// spellings of one value.
const DISPATCH_RUNTIMES = new Set(['claude', 'codex']);
const DISPATCH_BACKENDS = new Set(['agent', 'workflow', 'inline', 'codex-agent']);
function opaqueDispatchValueIssue(value) {
  if (typeof value !== 'string') return 'it is not a string';
  if (value.trim() === '') return 'it is blank';
  if (/[\s\u0000-\u001f\u007f]/.test(value)) return 'it contains whitespace or a control character';
  if (value.length > AGENT_ID_MAX) return `it is longer than ${AGENT_ID_MAX} characters`;
  return null;
}

// ── the Codex half: which FILE was invoked ───────────────────────────────────
//
// An agent on Codex is a static `.toml`, so the dispatch's real decision is the
// file: `shipyard-<reference>` at the palette's floor, or its `-deep` twin at the
// ceiling. Recording the role alone loses exactly the distinction the palette
// exists to express.
//
// The accepted names are derived from the plugin's OWN `references/` directory,
// which is the generator's source of truth for "which agents exist" and which
// ships inside the bundle — `scripts/gen-codex-shipyard.cjs` does not, so it
// cannot be required here.
//
// `-deep` is written for four roles only; the set is a local copy of that
// generator's `DEEP_ROLES` (there is nothing exported inside the plugin to read
// it from), and tests/unit/dispatch-record.test.cjs asserts the two are equal so
// the copy cannot drift.
const CODEX_DEEP_ROLES = new Set(['ci-fix', 'review-fix', 'pr-sentinel', 'arch-review']);
const CODEX_DEEP_SUFFIX = '-deep';
// Critical variants are first-attempt premium files. They are also a local copy
// of the generator's set; the unit test keeps both surfaces in lockstep.
const CODEX_CRITICAL_ROLES = new Set(['inv-research', 'arch-review', 'ci-fix', 'review-fix']);
const CODEX_CRITICAL_SUFFIX = '-critical';
const CODEX_AGENT_PREFIX = 'shipyard-';

// The ladder's roles and the generator's agent files are NOT one-to-one, and the
// cross-check below is wrong in both directions if it assumes they are:
//
//   * `research`'s reference ships as `inv-research.md` — the investigation loop's
//     own name — so the file a research dispatch runs is `shipyard-inv-research`;
//   * `executor` has NO agent file at all. There is no `executor.md` for the
//     generator to emit one from, because an executor is dispatched by the main
//     loop rather than by a `.toml`. So `--agent-file` on an executor mark cannot
//     name a file anybody can look at, whatever the value.
//
// Both facts are derived from `references/` rather than declared twice:
// `agentFilesFor` intersects the role's candidate names with the files that
// actually ship, so a reference added or renamed changes this with no edit here,
// and tests/unit/dispatch-record.test.cjs pins that every shipped file is claimed
// by exactly one role.
const CODEX_AGENT_ROLE_NAME = { research: 'inv-research' };
const agentRoleName = (role) => CODEX_AGENT_ROLE_NAME[role] || role;

function agentFilesFor(role, known) {
  const name = agentRoleName(role);
  const candidates = [`${CODEX_AGENT_PREFIX}${name}`];
  if (CODEX_DEEP_ROLES.has(name)) candidates.push(`${CODEX_AGENT_PREFIX}${name}${CODEX_DEEP_SUFFIX}`);
  if (CODEX_CRITICAL_ROLES.has(name)) candidates.push(`${CODEX_AGENT_PREFIX}${name}${CODEX_CRITICAL_SUFFIX}`);
  return new Set(candidates.filter((f) => known.has(f)));
}

function codexAgentFiles(dir = path.join(__dirname, '..', 'references')) {
  let refs;
  try { refs = fs.readdirSync(dir); } catch { return null; }
  const out = new Set();
  for (const f of refs) {
    if (!f.endsWith('.md')) continue;
    const role = f.slice(0, -3);
    out.add(`${CODEX_AGENT_PREFIX}${role}`);
    if (CODEX_DEEP_ROLES.has(role)) out.add(`${CODEX_AGENT_PREFIX}${role}${CODEX_DEEP_SUFFIX}`);
    if (CODEX_CRITICAL_ROLES.has(role)) out.add(`${CODEX_AGENT_PREFIX}${role}${CODEX_CRITICAL_SUFFIX}`);
  }
  return out;
}

/**
 * The `mark` flags, in ONE left-to-right pass — gate-trailer.cjs's shape, for the
 * holes it already paid for:
 *
 *   * an argument outside the list is REFUSED rather than ignored, because a
 *     mis-typed `--modle opus` does not fail, it records a dispatch with no model
 *     at all — the silent omission this whole ticket exists to end;
 *   * a DUPLICATE is refused: `indexOf` takes the first, so the later value would
 *     be dropped in silence and the record would name a model the spawn did not
 *     get;
 *   * the arity lives in the loop that consumes it, so a flag with no value is
 *     reported against THAT flag instead of mis-blaming its neighbour's value.
 *
 * Values are validated here, before anything is written: a mis-spelled alias
 * recorded silently is worse than no field, because it would be counted later as
 * fact.
 */
function parseMarkFlags(argv, role) {
  const given = new Map();
  for (let i = 0; i < argv.length;) {
    const arg = String(argv[i]);
    const name = arg.startsWith('--') ? arg.slice(2) : null;
    if (name !== null && Object.prototype.hasOwnProperty.call(REFUSED_FLAGS, name)) {
      fail(`--${name} is no longer accepted — ${REFUSED_FLAGS[name]}`);
    }
    if (name === null || !MARK_FLAGS.includes(name)) {
      fail(
        `unexpected argument "${arg}" — the recorder would drop it in silence, and a dispatch ` +
        'recorded without its model is the gap this store exists to close.\n' +
        `  flags: ${MARK_FLAGS.map((f) => `--${f}`).join(', ')}`
      );
    }
    if (given.has(name)) {
      fail(`--${name} given more than once — the later value would be silently dropped; pass it once`);
    }
    const v = argv[i + 1];
    if (v === undefined || String(v).startsWith('--')) fail(`--${name} needs a value`);
    given.set(name, String(v));
    i += 2;
  }

  const decided = {};
  const model = given.get('model');
  if (model !== undefined) {
    if (!TIERS.includes(model)) {
      fail(
        `"${model}" is not a tier alias — a model recorded by a name nothing resolves would be read ` +
        'later as fact.\n' +
        `  tiers: ${TIERS.join(', ')}`
      );
    }
    decided.model = model;
  }
  for (const flag of ['effort', 'effort-applied']) {
    const level = given.get(flag);
    if (level === undefined) continue; // absent stays absent — never filled in from its twin
    const evidenceState = flag === 'effort-applied' && ['unknown', 'unsupported'].includes(level);
    if (!EFFORTS.includes(level) && !evidenceState) {
      fail(
        `"${level}" is not an effort level or applied-effort state — --${flag} would record a depth ` +
        'nothing ran at.\n' +
        `  efforts: ${EFFORTS.join(', ')}; applied states: unsupported, unknown`
      );
    }
    decided[MARK_FIELD[flag]] = level;
  }
  const taskLevel = given.get('task-level');
  if (taskLevel !== undefined) {
    if (!TASK_LEVELS.includes(taskLevel)) {
      fail(
        `"${taskLevel}" is not a task level — --task-level would make the dispatch impossible to compare.\n` +
        `  task levels: ${TASK_LEVELS.join(', ')}`
      );
    }
    decided.task_level = taskLevel;
  }
  const runtime = given.get('runtime');
  if (runtime !== undefined) {
    if (!DISPATCH_RUNTIMES.has(runtime)) {
      fail(`"${runtime}" is not a supported dispatch runtime — runtimes: ${[...DISPATCH_RUNTIMES].join(', ')}`);
    }
    decided.runtime = runtime;
  }
  const backend = given.get('backend');
  if (backend !== undefined) {
    if (!DISPATCH_BACKENDS.has(backend)) {
      fail(`"${backend}" is not a dispatch backend — backends: ${[...DISPATCH_BACKENDS].join(', ')}`);
    }
    decided.backend = backend;
  }
  for (const flag of ['observed-model']) {
    const observed = given.get(flag);
    if (observed === undefined) continue;
    const why = opaqueDispatchValueIssue(observed);
    if (why !== null) fail(`--${flag} ${JSON.stringify(observed)} cannot be recorded: ${why}`);
    decided[MARK_FIELD[flag]] = observed;
  }
  const observedEffort = given.get('observed-effort');
  if (observedEffort !== undefined) {
    if (!['unknown', 'unsupported'].includes(observedEffort) && !EFFORTS.includes(observedEffort)) {
      fail(
        `"${observedEffort}" is not an observed effort level — observed values: unknown, unsupported, ${EFFORTS.join(', ')}`
      );
    }
    decided.observed_effort = observedEffort;
  }
  // The agent's identity. Opaque by nature — a launch id has no vocabulary to
  // check against, and inventing an allowlist for one is the mistake this repo
  // refused for Codex model ids (an unknown id cannot be told from a new one).
  // So only what cannot be COMPARED or JOURNALLED is refused: nothing, blank,
  // whitespace or a control character inside (two spellings of one id would count
  // as two agents, and a newline would break the journal into two lines), and an
  // absurd length. Everything else is stored exactly as passed.
  const agentId = given.get('agent-id');
  if (agentId !== undefined) {
    // The SAME predicate `agentIdOf` reads back with, so a value accepted here
    // can never later fail that check -- and a hand-edited or pre-validation
    // record that would NOT pass this check is exactly the one `agentIdOf`
    // must refuse to trust when reading it back.
    const why = agentIdSafetyIssue(agentId);
    if (why !== null) {
      // Echoed via JSON.stringify, never raw interpolation: an id refused
      // BECAUSE it holds a newline or control character must not then inject
      // that same newline or control character into this stderr message.
      fail(
        `--agent-id ${JSON.stringify(agentId)} cannot identify an agent: ${why}.\n` +
        '  Pass the id the LAUNCH returned, verbatim — the Workflow tool returns a task id, the Agent tool an\n' +
        '  agent id — and never a label you compose: two guards recorded under one hand-typed name count as\n' +
        '  ONE agent, and the cap then authorises a spend past itself.\n' +
        '  Holding no id at all, OMIT the flag: an unidentified record counts as its own agent, which is the\n' +
        '  safe direction.'
      );
    }
    decided.agent_id = agentId;
  }
  // This id is generated when the record is written, so callers do not have to
  // invent a correlation key before a launch exists. Accept an explicit value
  // for orchestrators that already have one, but keep it opaque and safe for the
  // JSONL journal. The id is separate from agent_id: one agent can own several
  // ticket dispatches in a wave, while every dispatch needs its own usage join.
  const dispatchId = given.get('dispatch-id');
  if (dispatchId !== undefined) {
    const why = opaqueDispatchValueIssue(dispatchId);
    if (why !== null) fail(`--dispatch-id ${JSON.stringify(dispatchId)} cannot be recorded: ${why}`);
    decided.dispatch_id = dispatchId;
  }
  // The RESOLVER's route, checked against the resolver's own grammar and then
  // against the pair recorded beside it. The grammar check is what stops a
  // sentence being posted through the new flag; the pair check is what stops a
  // route from a DIFFERENT dispatch — a copy-paste from the round before, or from
  // another role's resolve — describing this one. Both are cheap, and a journal
  // whose provenance field describes the wrong decision is worse than one with no
  // provenance field at all.
  const route = given.get('route');
  if (route !== undefined) {
    const parsed = parseRoute(route);
    if (!parsed) {
      fail(
        `--route "${route}" is not a resolver route — it is the \`route\` field of\n` +
        '  `pipeline-config.cjs model <role> --json [flags]`, passed verbatim, e.g.\n' +
        '  --route "tier=floor(opus) effort=row(high)". A sentence about the ladder is what this\n' +
        '  field used to hold, and what it can no longer be counted with.'
      );
    }
    // `--effort-applied` is deliberately NOT cross-checked: it is what the SPAWN
    // could carry, and on the Agent path that is legitimately a different number
    // from what the resolver decided. Checking it would refuse exactly the honest
    // dispatches T-25-05 built the two fields to tell apart.
    if (decided.model !== undefined && parsed.tier.model !== decided.model) {
      fail(
        `--route names tier "${parsed.tier.model}" and --model says "${decided.model}" — one of them is from\n` +
        '  another dispatch. Re-run the resolver for THIS role and its signals, and pass the model and\n' +
        '  the route it returned together.'
      );
    }
    if (decided.effort !== undefined && parsed.effort.effort !== decided.effort) {
      fail(
        `--route names effort "${parsed.effort.effort}" and --effort says "${decided.effort}" — one of them is\n` +
        '  from another dispatch. Re-run the resolver for THIS role and its signals, and pass the effort\n' +
        '  and the route it returned together (--effort-applied is the other claim, and is not checked).'
      );
    }
    // `route` and `{model, effort}` are the SAME claim in two encodings — not
    // two claims the way `effort`/`effort_applied` are (that pair is left alone
    // above on purpose: they measure different things). So a caller who passes
    // `--route` alone is not under-specifying; the pair is read out of the
    // route's own parse rather than left absent, which is what closes the gap
    // Copilot found: a `--route`-only mark used to store a `reason` naming a
    // model and effort while leaving the structured `model`/`effort` fields
    // empty, and a reader of `model_overrides` or the ladder query would see a
    // route text and no pair to cross-check it against. Disagreement is still
    // refused above, before this ever runs.
    if (decided.model === undefined) decided.model = parsed.tier.model;
    if (decided.effort === undefined) decided.effort = parsed.effort.effort;
    decided.reason = route;
  }
  if (runtime !== undefined && decided.model === undefined) {
    fail(
      `a ${runtime} dispatch must carry the resolver's --model or --route — otherwise its model lane is unknown.\n` +
      '  Resolve with `pipeline-config.cjs model <role> --json [signals]` and pass the returned pair and route.'
    );
  }
  const agentFile = given.get('agent-file');
  if (agentFile !== undefined) {
    if (runtime !== undefined && runtime !== 'codex') {
      fail('--agent-file is a Codex-only field — omit it for a Claude dispatch');
    }
    const known = codexAgentFiles();
    if (!known) {
      fail(
        `--agent-file cannot be verified: no references/ directory beside ${__dirname}.\n` +
        '  The point of the field is to record which agent file RAN, so an unverifiable name is worse than none.'
      );
    }
    if (!known.has(agentFile)) {
      fail(
        `"${agentFile}" is not an agent file the Codex generator produces — recording it would name a ` +
        'file nobody can look at.\n' +
        `  agent files: ${[...known].sort().join(', ')}`
      );
    }
    // A KNOWN file belonging to a DIFFERENT role is the case the flag was blind
    // to, and it was found by reproduction: `mark T-01-01 executor --agent-file
    // shipyard-arch-review-deep` was accepted. Either the dispatch went to the
    // wrong agent or the record names the wrong file, and the journal must not
    // quietly hold it under either reading — the whole point of the field is that
    // the ordinary/`-deep` choice IS the dispatch's decision on Codex, so a file
    // from another role makes the model recorded beside it fiction.
    //
    // Built from the ROLE rather than parsed out of the file name: five role names
    // contain a hyphen, and `-deep` is a suffix, so splitting the name is where an
    // off-by-one lives. Never compared against itself — the mutation test asserts
    // that a known file for another role still refuses.
    const mine = agentFilesFor(role, known);
    if (!mine.size) {
      fail(
        `${role} has no agent file the Codex generator produces, so "${agentFile}" cannot be the file this\n` +
        '  dispatch ran: the generator emits one agent per shipped `references/*.md`, and this role has\n' +
        '  none — it is dispatched by the main loop rather than by a `.toml`. Omit --agent-file.'
      );
    }
    if (!mine.has(agentFile)) {
      fail(
        `"${agentFile}" is not ${role}'s agent file — a dispatch recorded as ${role} ran either the wrong\n` +
        '  agent or is recording the wrong file, and on Codex the FILE is what carries the model.\n' +
        `  ${role} runs: ${[...mine].sort().join(' or ')}`
      );
    }
    decided.agent_file = agentFile;
  }
  return decided;
}

// A wave is launched as one action, but the old CLI needed one process, lock and
// front refresh per ticket. `mark-many` accepts the same facts as `mark` in a
// JSON array and turns the whole batch into one validated mutation. The payload
// uses JSON field names rather than shell flags so a route containing spaces is
// not re-quoted by every caller. It deliberately does not accept `reason` or
// `pr`: the former is the refused hand-composed route spelling, and the latter
// is read from the state the record is bound to.
const BATCH_FIELDS = new Map([
  ['model', 'model'],
  ['effort', 'effort'],
  ['effort_applied', 'effort-applied'],
  ['route', 'route'],
  ['task_level', 'task-level'],
  ['runtime', 'runtime'],
  ['backend', 'backend'],
  ['observed_model', 'observed-model'],
  ['observed_effort', 'observed-effort'],
  ['agent_file', 'agent-file'],
  ['agent_id', 'agent-id'],
  ['dispatch_id', 'dispatch-id'],
]);

function parseBatchEntries(raw) {
  if (!Array.isArray(raw)) {
    throw new Error('mark-many input must be a JSON array of dispatch objects');
  }
  const seen = new Set();
  return raw.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error(`mark-many item ${index + 1} must be an object`);
    }
    if (typeof item.ticket !== 'string' || !item.ticket) {
      throw new Error(`mark-many item ${index + 1} needs a non-empty ticket`);
    }
    if (typeof item.role !== 'string' || !item.role) {
      throw new Error(`mark-many item ${index + 1} needs a non-empty role`);
    }
    if (!ROLES.includes(item.role)) {
      throw new Error(`"${item.role}" is not a pipeline role — the board would name a holder nothing can identify.\n  roles: ${ROLES.join(', ')}`);
    }
    if (seen.has(item.ticket)) {
      throw new Error(`mark-many contains duplicate ticket ${item.ticket} — one ticket can have only one active dispatch`);
    }
    seen.add(item.ticket);

    const flags = [];
    for (const [key, value] of Object.entries(item)) {
      if (key === 'ticket' || key === 'role') continue;
      const flag = BATCH_FIELDS.get(key);
      if (!flag) {
        throw new Error(`mark-many item ${index + 1} has unsupported field "${key}" — use ticket, role and the mark fields`);
      }
      if (typeof value !== 'string') {
        throw new Error(`mark-many item ${index + 1} field "${key}" must be a string; omit it when it is unmeasured`);
      }
      flags.push(`--${flag}`, value);
    }
    return {
      ticket: item.ticket,
      role: item.role,
      decided: parseMarkFlags(flags, item.role),
    };
  });
}

// A completed fan-out has the same opposite shape as a launch wave: one
// operation owns several ticket records. Clearing them one process at a time
// re-takes the lock and refreshes the derived front for every ticket, so a
// short Workflow round can cost more orchestration turns than the work itself.
// A completion must carry the dispatch id it is completing. Ticket ids are
// reusable, so deleting by ticket alone lets a delayed result erase a newer
// dispatch and its capacity/stop-gate protection. Missing or already-lifted
// records remain idempotent, but a mismatched id is deliberately left alone.
function parseClearBatch(raw) {
  if (!Array.isArray(raw)) {
    throw new Error('clear-many input must be a JSON array of {ticket, dispatch_id} objects');
  }
  const seen = new Set();
  return raw.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error(`clear-many item ${index + 1} must be an object with ticket and dispatch_id`);
    }
    const { ticket, dispatch_id: dispatchId } = item;
    if (typeof ticket !== 'string' || ticket.trim() === '') {
      throw new Error(`clear-many item ${index + 1} must carry a non-empty ticket id`);
    }
    const why = opaqueDispatchValueIssue(dispatchId);
    if (why !== null) throw new Error(`clear-many item ${index + 1} dispatch_id cannot be recorded: ${why}`);
    if (seen.has(ticket)) {
      throw new Error(`clear-many contains duplicate ticket ${ticket} — pass each id once`);
    }
    seen.add(ticket);
    return { ticket, dispatch_id: dispatchId };
  });
}

// `draft` is normalized so `undefined` and `false` are one state; everything else
// is compared as it stands, with an absent field as null.
function fieldValue(s, field) {
  if (field === 'draft') return s[field] === true;
  return s[field] === undefined ? null : s[field];
}

// The role is part of the payload on purpose: a record whose `role` was edited by
// hand then matches nothing and reads as expired, and every branch in this store
// fails TOWARDS offering the work.
function dispatchFingerprint(role, s = {}) {
  const fields = subjectOf(role).fields;
  return crypto.createHash('sha256')
    .update(JSON.stringify([role, ...fields.map((f) => fieldValue(s, f))]))
    .digest('hex').slice(0, 16);
}

// Same resolution and the same flag spelling as drift-record.cjs/log-event.cjs —
// one convention for "which graph does this belong to", stripped from ANY
// position, because a flag only tolerated at the end is a trap for the caller who
// puts it first.
const ARGV_ALL = process.argv.slice(2);
const GRAPH_FLAG_AT = ARGV_ALL.indexOf('--graph');
// A flag-shaped token is not a directory. Guarded for the CLI only: front.cjs
// `require`s this file for activeDispatches/dispatchWhy, and an exit at require
// time would kill THAT script under this one's name.
if (require.main === module && GRAPH_FLAG_AT !== -1) {
  const val = ARGV_ALL[GRAPH_FLAG_AT + 1];
  if (val === undefined || val.startsWith('--')) {
    fail(`--graph needs a directory value (got ${val === undefined ? 'nothing' : `the flag "${val}"`})`);
  }
}
const GRAPH_EXPLICIT = GRAPH_FLAG_AT !== -1 || !!process.env.SHIPYARD_GRAPH_DIR;
const GRAPH_DIR = GRAPH_FLAG_AT !== -1
  ? path.resolve(ARGV_ALL[GRAPH_FLAG_AT + 1] || '')
  : (process.env.SHIPYARD_GRAPH_DIR
    ? path.resolve(process.env.SHIPYARD_GRAPH_DIR)
    : path.join(process.cwd(), '.planning', 'graph'));
// Guarded on the -1 case: `i !== GRAPH_FLAG_AT + 1` with no flag present reads as
// `i !== 0` and eats the SUBCOMMAND.
const ARGV = GRAPH_FLAG_AT === -1
  ? ARGV_ALL
  : ARGV_ALL.filter((_, i) => i !== GRAPH_FLAG_AT && i !== GRAPH_FLAG_AT + 1);
const STORE_NAME = 'dispatches.json';

function fail(msg) {
  process.stderr.write(`dispatch-record: ${msg}\n`);
  process.exit(1);
}

function graphDir(cwd = process.cwd()) {
  return path.join(cwd, '.planning', 'graph');
}

function readState(cwd) {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(graphDir(cwd), 'delivery-state.json'), 'utf8'));
    return raw && raw.tickets ? raw.tickets : raw || {};
  } catch {
    return {};
  }
}

const hasStateTicket = (state, id) =>
  Object.prototype.hasOwnProperty.call(state || {}, id);

function load(cwd = process.cwd()) {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(graphDir(cwd), STORE_NAME), 'utf8'));
    return raw && typeof raw === 'object' && raw.tickets ? raw : { tickets: {} };
  } catch {
    return { tickets: {} };
  }
}

// A dispatch id is the join key between the delivery journal and a later
// provider transcript. It is generated at write time rather than in the prompt
// builder, because a retry must get a new id and a caller that never reaches the
// recorder must not leave a phantom correlation key behind.
function newDispatchId() {
  const random = typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : crypto.randomBytes(16).toString('hex');
  return `dispatch-${Date.now().toString(36)}-${random}`;
}

function dispatchIdInUse(store, id, ticket) {
  return Object.entries(store.tickets || {}).some(([otherTicket, record]) =>
    otherTicket !== ticket && record && record.dispatch_id === id
  );
}

function withDispatchId(decided, store, ticket) {
  const id = decided.dispatch_id || newDispatchId();
  if (dispatchIdInUse(store, id, ticket)) {
    throw new Error(`dispatch id "${id}" is already active for another ticket`);
  }
  return { ...decided, dispatch_id: id };
}

// Read-modify-write plus the journal line, under ONE lock and written atomically —
// drift-record's rule for the same reason: the main loop dispatches a whole wave
// at once, and an unsynchronized load→save loses records (six concurrent marks
// reliably produced five). The lock sits beside the STORE, never at cwd: a mark
// run from a ticket worktree would otherwise take a lock nobody else contends
// for and serialize nothing.
function mutate(cwd, fn) {
  fs.mkdirSync(graphDir(cwd), { recursive: true });
  return withLock(lockDirFor(cwd), 'dispatch-record', () => {
    const store = load(cwd);
    const extra = fn(store);
    writeAtomic(path.join(graphDir(cwd), STORE_NAME), JSON.stringify(store, null, 2) + '\n');
    if (extra) {
      const events = Array.isArray(extra) ? extra : [extra];
      if (events.length) {
        fs.appendFileSync(
          path.join(graphDir(cwd), 'delivery-log.jsonl'),
          events.map((event) => JSON.stringify(event)).join('\n') + '\n'
        );
      }
    }
  }, { label: 'dispatch-record' });
}

const roleOf = (rec) => (typeof rec === 'string' ? rec : ((rec && rec.role) || 'an agent'));

/**
 * WHICH agent holds this record, or `null` when nothing identifies one.
 *
 * Exported and read by `front.cjs`'s counter rather than re-derived there: "what
 * counts as an identity" is one rule, and two copies of it would be free to
 * disagree about a blank string — with the disagreement showing up as a cap that
 * authorises one more agent than it means to. A bare role string (the flattened
 * shape) and a record from before the field existed both answer `null`, which
 * `agentsInFlight` spends a whole agent on.
 *
 * Runs the SAME `agentIdSafetyIssue` the write path enforces, not only the
 * `trim() !== ''` half of it: `front.cjs` joins `role\u0000agent` into a Set
 * key on the promise that neither half holds whitespace or a control
 * character, but that promise is only as good as what THIS function lets
 * through — a hand-edited store, or a record written before the write-side
 * check existed, is not bound by it. An id this function would refuse to
 * WRITE is exactly the one it must refuse to trust on READ; both answer
 * `null`, which is the same safe direction as no identity at all — an extra
 * agent counted, never one silently discounted through a collision.
 */
const agentIdOf = (rec) => {
  const id = rec && typeof rec === 'object' ? rec.agent_id : undefined;
  return typeof id === 'string' && agentIdSafetyIssue(id) === null ? id : null;
};

function ageMinutes(rec) {
  const at = Date.parse((rec && rec.at) || '');
  return Number.isFinite(at) ? Math.max(0, Math.round((Date.now() - at) / 60000)) : null;
}

/**
 * The board's sentence for a live dispatch, and it lives HERE — beside the branch
 * in `activeDispatches` that decides when the record actually lifts. That is
 * escalation-record's rule applied to a second store: a lifting rule composed at
 * the render site is how a board came to promise one thing while the file that
 * decides promised another.
 *
 * It names both expiry triggers, because a reader who does not know the record
 * lifts by itself will reach for `clear` — and a `clear` that becomes routine is
 * how a store starts being cleared before the work returns.
 */
function dispatchWhy(id, rec) {
  const mins = ageMinutes(rec);
  const age = mins === null ? '' : ` ${mins}m ago`;
  const role = roleOf(rec);
  // The fact is quoted from the same table the expiry rule reads, so the board
  // cannot name one trigger while the code waits for another. The old sentence
  // listed "a check" among them, which was exactly the wrong claim.
  return `dispatched to ${role}${age} — an agent holds it, so it is nobody else's to start. ` +
    `It returns to the board by itself when the delivery state moves in the way this role's own output moves it ` +
    `(${subjectOf(role).lifts}) or after ${Math.round(DISPATCH_TTL_MS / 60000)}m; ` +
    `\`dispatch-record.cjs clear ${id}\` returns it now.`;
}

/**
 * The dispatches still in force: {ticket: {role, at, agent_id?}} — the shape
 * `computeFront` takes as `opts.dispatched`. Callers get both expiry triggers for
 * free.
 *
 * `agent_id` is present only when the record carries one, because the counter
 * that reads it treats a missing identity as an agent of its own and a `null`
 * would have to be special-cased into the same answer twice.
 *
 * `state` may be passed in by a caller that already has it, otherwise it is read
 * from disk.
 *
 * Every branch here fails TOWARDS offering the work. A record that cannot be
 * read, cannot be dated, or was written against a ticket the state no longer
 * describes is treated as spent, because the failure this store must never
 * produce is a ticket hidden from the run that owns it.
 */
function activeDispatches(cwd = process.cwd(), state = null) {
  const live = state || readState(cwd);
  const now = Date.now();
  const out = {};
  for (const [id, rec] of Object.entries(load(cwd).tickets || {})) {
    if (!rec) continue;
    const s = live[id] || {};
    // A merged ticket is never suppressed, whoever was working on it: it landed.
    if (s.status === 'merged') continue;
    const at = Date.parse(rec.at || '');
    // An undateable record has an unknown age, and an unknown age is expired.
    if (!Number.isFinite(at) || now - at >= DISPATCH_TTL_MS) continue;
    // Trigger 1 — the ROLE's own output appeared, so the dispatch did its job.
    // WHICH hash comes from the record: one written before this store had a
    // per-role rule is bound to the shared hash and keeps expiring against that
    // one, so an upgrade mid-flight neither hides a ticket nor re-reads an old
    // record under a rule it was not written under. Both lift inside the TTL
    // either way.
    if (rec.fingerprint) {
      // Named `current`, not `now`: `now` in this scope is the clock the TTL above
      // reads, and shadowing it with a hash is how the two triggers would come to
      // be confused by the next reader.
      const current = rec.fingerprint_kind === 'role'
        ? dispatchFingerprint(roleOf(rec), s)
        : fingerprint(s);
      if (current !== rec.fingerprint) continue;
    }
    const agent = agentIdOf(rec);
    out[id] = agent === null
      ? { role: roleOf(rec), at: rec.at }
      : { role: roleOf(rec), at: rec.at, agent_id: agent };
  }
  return out;
}

// Recompute `delivery-front.json` from the stores as they now stand.
//
// This is not decoration: the file the stop gate reads is written by state-sync,
// and the dispatch happens BETWEEN two syncs — deliver.md runs state-sync once,
// after the whole publish phase, so at the moment a wave is handed to agents the
// board on disk still lists every one of them as actionable. A record nothing
// re-derives from would be a fact with no reader at exactly the moment it is
// true.
//
// Deliberately narrow:
//   * it REFRESHES an existing front and never creates one. The stop gate is
//     installed globally, and a front conjured in a directory that has none would
//     arm it where nothing asked for it;
//   * it inherits `parked_by_run`, `auto_merge` and `generated_at` from the file
//     it is updating. Those are the SYNC's facts — session parks and how fresh
//     the GitHub read is — and re-stamping `generated_at` would make a stale
//     board read as current, which is the staleness hatch this whole gate relies
//     on;
//   * it is BEST EFFORT. The record is the durable fact; the front is derived.
//     A concurrent state-sync holding the lock is a reason to say so and move on,
//     never a reason to fail the mark.
// The READ, the COMPUTE and the WRITE all sit inside the `state` lock — the same
// one state-sync writes its trio under. Reading first and locking only the write
// is the lost-update this repo has already paid for twice: the guard runs
// state-sync at the top of every round, and one landing between our read and our
// write would see its newer board replaced by one computed from older inputs.
function refreshFront(cwd) {
  const dir = graphDir(cwd);
  const frontFile = path.join(dir, 'delivery-front.json');
  // Required lazily and ON PURPOSE: front.cjs requires THIS file at load time for
  // `dispatchWhy`, so a top-level require here would hand it a half-built module.
  // By the time this function runs, both are fully loaded.
  const { computeFront, ciEstimates } = require(path.join(__dirname, 'front.cjs'));
  const { activeDrift } = require(path.join(__dirname, 'drift-record.cjs'));
  const { activeParks } = require(path.join(__dirname, 'escalation-record.cjs'));
  try {
    return withLock(lockDirFor(cwd), 'state', () => {
      let previous;
      let tickets;
      let state;
      try {
        previous = JSON.parse(fs.readFileSync(frontFile, 'utf8'));
        tickets = (JSON.parse(fs.readFileSync(path.join(dir, 'tickets.json'), 'utf8')) || {}).tickets || {};
        state = JSON.parse(fs.readFileSync(path.join(dir, 'delivery-state.json'), 'utf8'));
      } catch {
        return null; // no board here yet — state-sync writes the first one
      }
      if (!previous || typeof previous !== 'object' || !state || typeof state !== 'object') return null;
      const front = computeFront(tickets, state, {
        parked: previous.parked_by_run || [],
        autoMerge: previous.auto_merge === 'epic',
        drifted: activeDrift(cwd),
        escalated: activeParks(cwd, state),
        dispatched: activeDispatches(cwd, state),
        ci_estimates: ciEstimates(dir, tickets),
      });
      writeAtomic(frontFile, JSON.stringify({
        generated_at: previous.generated_at,
        parked_by_run: previous.parked_by_run || [],
        auto_merge: previous.auto_merge || 'off',
        dispatches_applied_at: new Date().toISOString(),
        ...front,
      }, null, 2) + '\n');
      return front;
    }, { label: 'dispatch-record', waitMs: 20_000 });
  } catch (e) {
    process.stderr.write(
      `dispatch-record: the record is stored, but delivery-front.json could not be refreshed (${e.message}).\n` +
      '  The next state-sync rewrites it anyway; re-run this command if the board still offers the ticket.\n'
    );
    return null;
  }
}

module.exports = {
  activeDispatches, dispatchWhy, dispatchFingerprint, agentIdOf, DISPATCH_SUBJECT, DISPATCH_TTL_MS,
  MARK_FLAGS, MARK_FIELD, REFUSED_FLAGS, codexAgentFiles, agentFilesFor, agentRoleName,
  CODEX_DEEP_ROLES, CODEX_DEEP_SUFFIX, CODEX_CRITICAL_ROLES, CODEX_CRITICAL_SUFFIX,
  CODEX_AGENT_PREFIX, DISPATCH_RUNTIMES, DISPATCH_BACKENDS, newDispatchId,
};

if (require.main === module) {
  const [cmd, ...rest] = ARGV;
  const cwd = path.resolve(GRAPH_DIR, '..', '..');

  // Fail-closed, exactly as drift-record and escalation-record do: this command
  // is documented to run from ticket worktrees, which have no `.planning/` of
  // their own, and a store written beside no ticket graph is unreadable rather
  // than merely misplaced — the front reads the PROJECT's. `list`/`clear` stay
  // permissive: they read or they remove, they never hide a ticket nowhere.
  if (['mark', 'mark-many'].includes(cmd) && !fs.existsSync(path.join(GRAPH_DIR, 'tickets.json'))) {
    fail(
      `no ticket graph at ${GRAPH_DIR} — refusing to record a dispatch nothing will read` +
      (GRAPH_EXPLICIT ? ' (the explicitly selected graph is invalid).' : '.\n') +
      (GRAPH_EXPLICIT ? '\n' : '') +
      '  The front reads the PROJECT\'s graph; one written in a worktree is invisible to it,\n' +
      '  so the ticket keeps being offered as work an agent already holds.\n' +
      '  Run this from the conveyor project, or pass --graph <project>/.planning/graph.'
    );
  }

  if (cmd === 'mark') {
    const [ticket, role] = rest;
    if (!ticket || !role) {
      fail(
        'usage: dispatch-record.cjs mark <ticket> <role> ' +
        `[${MARK_FLAGS.map((f) => `--${f} <v>`).join('] [')}] [--graph <dir>]\n` +
        `  roles: ${ROLES.join(', ')}`
      );
    }
    // The role is what tells the morning reader WHO holds the ticket, and it is
    // the ladder's own vocabulary so that the name on the board is the name the
    // model resolver answers to.
    if (!ROLES.includes(role)) {
      fail(`"${role}" is not a pipeline role — the board would name a holder nothing can identify.\n  roles: ${ROLES.join(', ')}`);
    }
    // Parsed and validated BEFORE the state lookup and before anything is
    // written: a usage error must cost no lock and must never leave half a
    // record behind.
    const decided = parseMarkFlags(rest.slice(2), role);
    const at = new Date().toISOString();
    let dispatchId;
    mutate(cwd, (store) => {
      // Read the ticket state while the dispatch mutation is locked. A
      // concurrent state-sync may move the PR between the preflight read and
      // this callback; using the older fingerprint would make a fresh dispatch
      // look expired on the next front evaluation.
      const state = readState(cwd);
      if (!hasStateTicket(state, ticket)) throw new Error(`no ${ticket} in delivery-state.json — run state-sync.cjs first, or check the id`);
      const s = state[ticket];
      // A re-dispatch restarts the clock: the previous agent is not the one
      // holding it now.
      const recorded = withDispatchId(decided, store, ticket);
      dispatchId = recorded.dispatch_id;
      store.tickets[ticket] = {
        role,
        at,
        // Spread, never enumerated: a flag the caller did not pass contributes no
        // key, so the record distinguishes "ran at high" from "nobody measured".
        ...recorded,
        fingerprint: dispatchFingerprint(role, s),
        // Which hash the line above is, so a reader upgrading over an existing
        // store compares each record with the rule it was written under.
        fingerprint_kind: 'role',
        pr: s.pr || null,
      };
      // Journalled because nothing else records WHEN work was handed over, nor
      // WHAT it was handed to. The TTL above had to be inferred from PR
      // timestamps for want of this line and the ladder from judgement for want
      // of the fields; the next one of each can be measured. The ticket's next
      // `status_change` closes the interval, so a `clear` needs no event of its
      // own.
      return { ts: at, event: 'dispatch', ticket, role, pr: s.pr || null, ...recorded, by: 'dispatch-record' };
    });
    // The record is durable the instant `mutate` above returns — that alone is
    // what `activeDispatches` reads. `refreshFront` only decides whether the
    // ON-DISK board reflects it RIGHT NOW or on the next sync; its return value
    // says which, so the message does not claim a refresh that did not happen
    // (no board yet, or a state-sync held the lock).
    const refreshed = refreshFront(cwd) !== null;
    console.log(
      `dispatch recorded for ${ticket} (${role}), dispatch_id=${dispatchId} — ` +
      (refreshed
        ? 'the front reports it as waiting, not as work to start. '
        : 'no board was refreshed just now (none exists yet, or a sync holds the lock); the record is durable and the next state-sync or refresh will apply it. ') +
      `It lifts when ${subjectOf(role).lifts}, or after ${Math.round(DISPATCH_TTL_MS / 60000)}m.`
    );
  } else if (cmd === 'mark-many') {
    if (rest.length !== 1 || rest[0] !== '--stdin') {
      fail(
        'usage: dispatch-record.cjs mark-many --stdin [--graph <dir>]\n' +
        '  stdin must contain a JSON array of {ticket, role, ...mark fields}; an empty array is a no-op'
      );
    }
    let raw;
    try {
      raw = JSON.parse(fs.readFileSync(0, 'utf8'));
    } catch (e) {
      fail(`mark-many stdin is not valid JSON — ${e && e.message ? e.message : e}`);
    }
    let entries;
    try {
      entries = parseBatchEntries(raw);
    } catch (e) {
      fail(e && e.message ? e.message : e);
    }
    if (!entries.length) {
      console.log('no dispatches recorded — the batch was explicitly empty');
    } else {
      // Check every ticket before taking the lock. The callback repeats this
      // check against the state read while the lock is held, so a concurrent
      // state-sync cannot turn a valid batch into a record with a stale
      // fingerprint or leave only the first item filed.
      const state = readState(cwd);
      const missing = entries.find((entry) => !hasStateTicket(state, entry.ticket));
      if (missing) fail(`no ${missing.ticket} in delivery-state.json — run state-sync.cjs first, or check the id`);
      const at = new Date().toISOString();
      const dispatchIds = new Map();
      try {
        mutate(cwd, (store) => {
          const current = readState(cwd);
          const absent = entries.find((entry) => !hasStateTicket(current, entry.ticket));
          if (absent) throw new Error(`no ${absent.ticket} in delivery-state.json — run state-sync.cjs first, or check the id`);
          const events = [];
          for (const entry of entries) {
            const s = current[entry.ticket];
            const recorded = withDispatchId(entry.decided, store, entry.ticket);
            if ([...dispatchIds.values()].includes(recorded.dispatch_id)) {
              throw new Error(`mark-many contains duplicate dispatch id "${recorded.dispatch_id}"`);
            }
            dispatchIds.set(entry.ticket, recorded.dispatch_id);
            store.tickets[entry.ticket] = {
              role: entry.role,
              at,
              ...recorded,
              fingerprint: dispatchFingerprint(entry.role, s),
              fingerprint_kind: 'role',
              pr: s.pr || null,
            };
            events.push({
              ts: at,
              event: 'dispatch',
              ticket: entry.ticket,
              role: entry.role,
              pr: s.pr || null,
              ...recorded,
              by: 'dispatch-record',
            });
          }
          return events;
        });
      } catch (e) {
        fail(e && e.message ? e.message : e);
      }
      const refreshed = refreshFront(cwd) !== null;
      console.log(
        `dispatch recorded for ${entries.length} ticket(s) ` +
        `(dispatch_ids=${[...dispatchIds.values()].join(',')}) — ` +
        (refreshed
          ? 'the front reports them as waiting, not as work to start. '
          : 'no board was refreshed just now (none exists yet, or a sync holds the lock); the records are durable and the next state-sync or refresh will apply them. ') +
        `They lift by their role output or after ${Math.round(DISPATCH_TTL_MS / 60000)}m.`
      );
    }
  } else if (cmd === 'clear') {
    const [ticket] = rest;
    if (!ticket) fail('usage: dispatch-record.cjs clear <ticket> [--graph <dir>]');
    const had = !!load(cwd).tickets[ticket];
    if (had) {
      mutate(cwd, (store) => { delete store.tickets[ticket]; });
      refreshFront(cwd);
    }
    console.log(had ? `dispatch cleared for ${ticket} — it is the board's again` : `no dispatch recorded for ${ticket}`);
  } else if (cmd === 'clear-many') {
    if (rest.length !== 1 || rest[0] !== '--stdin') {
      fail(
        'usage: dispatch-record.cjs clear-many --stdin [--graph <dir>]\n' +
        '  stdin must contain a JSON array of {ticket, dispatch_id} objects; an empty array is a no-op'
      );
    }
    let raw;
    try {
      raw = JSON.parse(fs.readFileSync(0, 'utf8'));
    } catch (e) {
      fail(`clear-many stdin is not valid JSON — ${e && e.message ? e.message : e}`);
    }
    let ticketsToClear;
    try {
      ticketsToClear = parseClearBatch(raw);
    } catch (e) {
      fail(e && e.message ? e.message : e);
    }
    if (!ticketsToClear.length) {
      console.log('no dispatches cleared — the batch was explicitly empty');
    } else {
      let cleared = 0;
      mutate(cwd, (store) => {
        for (const { ticket, dispatch_id: dispatchId } of ticketsToClear) {
          const current = store.tickets[ticket];
          if (!current || current.dispatch_id !== dispatchId) continue;
          delete store.tickets[ticket];
          cleared++;
        }
      });
      if (cleared) {
        refreshFront(cwd);
      }
      console.log(
        `dispatch cleared for ${cleared} of ${ticketsToClear.length} ticket(s) — ` +
        'the board can offer them again'
      );
    }
  } else if (cmd === 'list') {
    const active = activeDispatches(cwd);
    if (rest.includes('--json')) {
      console.log(JSON.stringify(active, null, 2));
    } else if (!Object.keys(active).length) {
      console.log('no dispatches in force');
    } else {
      for (const [id, rec] of Object.entries(active)) {
        const mins = ageMinutes(rec);
        console.log(`${id}: ${rec.role}${mins === null ? '' : `, ${mins}m ago`}`);
      }
    }
  } else {
    fail('usage: dispatch-record.cjs <mark|mark-many|clear|clear-many|list> …');
  }
}
