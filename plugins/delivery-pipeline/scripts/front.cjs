#!/usr/bin/env node
'use strict';

// The ACTIONABLE FRONT — the conveyor's stop condition, as code.
//
// /shipyard:deliver's first principle is "never end the run while there is
// somewhere to go", and until now that was prose the orchestrating model had to
// re-derive from a board printout every round. It got it wrong in exactly the
// two ways prose fails: it serialized on `gh pr checks --watch` (calling a
// waiting PR "the run") and it read a human_checkpoint as "do nothing at all".
// Both times the run reported a fixpoint while a dozen tickets were executable.
//
// So the verdict is computed here instead, from delivery-state, and printed as
// `fixpoint: YES|NO`. Stopping is legal on YES only.
//
//   actionable now (work the run can start this second, no waiting involved):
//     execute   — undelivered, ready, no branch yet
//     publish   — branch pushed, PR missing (an executor died between the two)
//     fix       — open PR with failing checks, or one whose BASE HAS MOVED (the
//                 remedy is base-merge, and the guard's duty says so by name:
//                 every other answer about such a PR measures a merge base that
//                 no longer exists)
//     finalize  — open PR, checks green: threads/arch-review/conform gate/undraft
//     merge     — open PR green + conform, targeting the STACK (epic/parent):
//                 the sentinel squashes it in (auto-merge only, see below)
//   waiting (NOT actionable, and NOT a fixpoint either — motion resumes by itself):
//     ci        — checks still running, or a check state that could not be READ
//                 this round (check-state.cjs's `unavailable`): both resolve by
//                 looking again, and neither owes anyone work
//     dispatched— an agent already holds this ticket (dispatch-record.cjs): not
//                 actionable, because taking it again is duplicate work; not
//                 parked, because nobody has given up; and never a fixpoint,
//                 because the round has to come back for the result
//     parent    — stacked on a parent whose PR is still open (parent-moving.cjs).
//                 The guard has answered `wait-parent` here since it was written;
//                 the board had no such bucket, so the same ticket read as
//                 fix/finalize/merge — work the loop would not take (the bucket is
//                 the guard's) and the guard would not do either
//   parked (compatible with a fixpoint — only a human or a replan moves these):
//     merge_human — green, out of draft, but the merge is a human action
//                   (auto-merge off, direct-to-main, the PR targets the
//                   integration branch, or NO checks were reported at all — see
//                   noCiHold: "nothing ran" is not a green the run may land on)
//     human     — a human_checkpoint ticket that has cleared its gate and whose
//                 judgement nobody has supplied yet (a person holds the key), a
//                 child held behind an OPEN checkpoint parent until it lands, or
//                 a PR whose CHANGES_REQUESTED verdict stands with NO unresolved
//                 thread left — a fixer has nothing to service there, only a
//                 reviewer can re-review or dismiss it
//     blocked   — dependencies unsatisfied, or parked by the run (--parked)
//     done      — merged
//
// fixpoint = no actionable work, nothing waiting on CI, nothing held behind a
// moving parent, and nothing out with an agent. A PR whose checks are still
// running is NOT a fixpoint: the round has to come back to it. But it is also not
// a reason to block — the run serves the rest of the front meanwhile, and when a
// wait IS all that is left the sanctioned move is `ci-wait.cjs`, a foreground wait
// with a budget that returns on the first PR to settle. A dispatched ticket and a
// child held behind a moving parent read the same way for the same reason.
//
// OWNERSHIP. fix/finalize/merge are the PR SENTINEL's duty (sentinel.cjs), which
// runs alongside the main loop; execute/publish belong to the main loop. The
// split matters because it is what lets the run cascade onward while the tail of
// open PRs is still being driven to green — before it, an unmerged green PR was
// simply "waiting on a human" and the run declared a fixpoint on top of it.

const path = require('path');
// Read at module level for the journal-tail reader below. (The CLI block at the
// bottom re-requires it in its own scope; harmless, and left alone.)
const fs = require('fs');
// The lifting rule for a park comes from the store that OWNS the park, never
// from here. Composing it at this render site is what let the board tell a
// human that moving the PR lifts a plan defect, while escalation-record.cjs —
// the file that decides when it actually lifts — says a PR move does not touch
// it. This module's job for a park is placement; the wording is not its call.
const { escalationWhy } = require(path.join(__dirname, 'escalation-record.cjs'));
// Same rule, second store: a dispatch's lifting sentence is written by the file
// that decides when it lifts. (dispatch-record.cjs requires front.cjs back, but
// only lazily and only from its CLI, so there is no half-built module here.)
const { dispatchWhy, activeDispatches } = require(path.join(__dirname, 'dispatch-record.cjs'));
// The OTHER predicate the guard and the board must not spell twice — "is this
// ticket's parent still being driven?". It lived in sentinel.cjs alone, which is
// why the board offered tickets the guard was refusing. One home, one direction:
// this module imports nothing back.
// `limbBaseOf`/`limbRemedy` come from the same home for the same reason, and
// they are the reason stated in the past tense: the merge gate learned to
// refuse a limb base and this file did not, so the board answered
// `actionable.merge` for exactly the PR `sentinel.cjs merge` declined, every
// round, on a real phase.
const {
  movingParentOf, movingParentWhy, limbBaseOf, limbRemedy,
} = require(path.join(__dirname, 'parent-moving.cjs'));
// The trailer's classification comes from its own module — the board and the
// guard (sentinel.cjs) must never disagree about whether a verdict counts.
const { gateConform: trailerConform, gateWhy } = require(path.join(__dirname, 'gate-trailer.cjs'));
// The check vocabulary, from the file that owns it. `isGreen` rather than the
// inline `failing === 0 && pending === 0` this file used to spell out: an
// UNAVAILABLE reading (a 503, a rate limit, an old `gh` rejecting `bucket`)
// carries all-zero tallies, so the arithmetic alone calls a PR nobody read green.
const { isGreen } = require(path.join(__dirname, 'check-state.cjs'));

// ── the identity of one phase's epic, in ONE home ───────────────────────────
//
// The key `state-sync.cjs`'s `epicInfo` is keyed by, and it lives here for the
// same reason the predicates below do: two files have to agree about it, so only
// one of them may own it. `state-sync` imports it (this module is pure and
// importable; that one parses argv and can exit at load time, so it cannot be
// imported back). One epic NAME per phase, but a separate branch — and a
// separate integration PR — in every repository the phase touches, so the repo
// is part of the identity and not a detail of it.
//
// The separator is written as the ESCAPE `\0` and never as the byte itself. It
// is the one character neither a phase number nor an `owner/name` slug can
// contain, so no two pairs collide on a key; a literal NUL in the source, on the
// other hand, makes the whole file binary to `grep`, which is how state-sync.cjs
// came to answer nothing at all to `grep -n require`.
const epicKey = (phase, repo) => `${String(phase ?? '')}\0${repo || ''}`;

// ── the checkpoint predicates, in ONE home ──────────────────────────────────
//
// `sentinel.cjs` imports both of these rather than keeping its own copies. Until
// ADR-001 D6 it kept a `checkpointParentOf` of its own beside an identical
// closure in computeFront, and the standing rule — the board must never offer
// what the guard refuses — was held by nothing but the two texts happening to
// match. Adding a second condition to two copies is how a rule comes to
// contradict itself; reducing them to one is the point.
//
// They live HERE because this module is pure and importable: it reads no file
// and its CLI is behind `require.main`, while sentinel.cjs parses argv and can
// exit at load time, so it cannot be required back.

// "Does this ticket still need a person?" — the one question both files ask.
//
// `human_checkpoint` says a human must act on this ticket; `preauthorized`
// (ADR-001 D6, written by validate-graph.cjs) says the human already did, while
// approving the ticket set. The two are not synonyms and must not collapse:
// what pre-authorization lifts is the WAIT, never the checkpoint itself.
//
// The polarity is deliberately asymmetric. The checkpoint is recognised on a
// TRUTHY value, so anything that reached the graph looking like a stop still
// stops the run; only a real unquoted `true` lifts it. Gate 2 refuses every
// other spelling at plan time — but a field whose whole purpose is to authorize
// an unattended merge must fail towards the human, not away from them.
function needsHuman(ticket) {
  const t = ticket || {};
  if (!t.human_checkpoint) return false;
  return t.preauthorized !== true;
}

// The parent ticket's id when this ticket's base is a checkpoint parent whose PR
// is still OPEN, else null. Deliberately indifferent to pre-authorization: a
// child never lands into an open checkpoint parent either way. Un-authorized,
// the squash would rewrite the diff a person is reading. Pre-authorized, nobody
// is reading it — but it is still the ticket the checkpoint names, and landing a
// child into it first changes what lands under that authorization. Callers ask
// `needsHuman(parent)` to say WHICH of the two they are looking at.
function checkpointParentOf(id, tickets, state) {
  const parent = ((tickets && tickets[id]) || {}).primary_parent;
  if (!parent) return null;
  if (!((tickets && tickets[parent]) || {}).human_checkpoint) return null;
  return ((state && state[parent]) || {}).status === 'pr-open' ? parent : null;
}

// ── the NO-CI hold, in the same ONE home, for the same reason ───────────────
//
// `none_reported` means nothing ran, not that everything passed. It used to
// count as green all the way into `actionable.merge`, so a PR in a repo whose
// pipeline never registered was squashed into the epic with no test having run;
// state-sync warns about it in a line nobody reads at 3am.
//
// So both readers withhold the two actions that walk such a PR towards landing —
// the squash itself, and the mechanical `undraft` that readies it for one — and
// report the merge as a human's. Only those two: the architecture verdict and
// the review threads are real work whatever CI did, and a `finalize` withheld
// there would strand a PR nobody is servicing.
//
// Gated on `autoMerge` deliberately. With auto-merge off the human merges it in
// either case, and readying the PR is a courtesy to them (the duty's
// `checks_note` already says what "green" meant) — holding the draft there
// would leave a PR nobody can land at all.
// The three facts are ANDed, so their ORDER cannot change the answer — but it
// decides whether the front's config read happens at all, which is why the cheap
// ones are settled first. `merge_without_ci` is the only expensive input (on the
// board it comes from the project's config file), so it is consulted LAST and may
// arrive as a THUNK: a caller that already holds the value passes the value, and
// one that would have to go and find it passes a function that is never called
// unless a PR with no reported checks is actually in hand. Reviewer-found on
// PR #44: front.cjs resolved it eagerly to build this options object, so every
// `computeFront` opened the file — including the overwhelming majority of boards
// where no PR has `none_reported` and the answer is `false` either way. The
// short-circuit lives HERE rather than at the call site on purpose: the rule has
// two readers (this board and sentinel.cjs's guard) and duplicating any conjunct
// into one of them is how the two come to disagree.
function noCiHold(checks, opts = {}) {
  if (opts.autoMerge !== true) return false;
  if ((checks || {}).none_reported !== true) return false;
  const mergeWithoutCi = typeof opts.mergeWithoutCi === 'function'
    ? opts.mergeWithoutCi()
    : opts.mergeWithoutCi;
  return mergeWithoutCi !== true;
}

// ONE sentence for the fact, quoted by the board and the guard rather than
// written twice: the remedy is a decision with two branches, and a reader who is
// told only one of them ("wait") never reaches for the setting.
const NO_CI_WHY = 'no CI checks were reported — nothing ran, so "green" here is the absence of evidence '
  + 'rather than evidence. Either confirm this repo has no CI '
  + '(`delivery_pipeline.merge_without_ci: true`) or wait for the checks to register; until then the merge '
  + 'is a human\'s.';

// ── the verdict a fixer cannot service, in the same ONE home ────────────────
//
// A review DECISION outlives the threads it was filed with: a reviewer who
// requested changes in a summary comment, or a bot whose threads were all
// resolved while its verdict stood, leaves CHANGES_REQUESTED with ZERO
// unresolved threads. Both readers used to send a fixer at that state — the
// guard as `review-fix`, the board as `finalize` ("review not settled") — and
// the fixer returned having done nothing, because there was nothing to service:
// the threads are closed and the verdict is not lifted by resolving them or by
// pushing. The signature then repeated until the attempt budget escalated a
// ticket nobody owed work on.
//
// The owner is a PERSON, so this is `waiting.human` and not `parked`: nobody
// owes work, a reviewer holds the key.
//
// UNKNOWN is not zero. The count comes from a GraphQL call that can fail, and
// "we could not read the threads" must fail towards the work — parking a PR on a
// human over an API hiccup is the more expensive mistake. Only a real 0 routes.
function reviewStandsAlone(reviewDecision, unresolvedCount) {
  if (reviewDecision !== 'CHANGES_REQUESTED') return false;
  return unresolvedCount === 0;
}

// ONE sentence, quoted by both readers. It has to name the ACT that lifts the
// state, or the reader is told to wait with no idea for what.
const REVIEW_STANDS_WHY = 'CHANGES_REQUESTED stands with no unresolved thread — a reviewer must re-review '
  + 'or dismiss the verdict. A fixer has nothing to service: every thread is closed, and the verdict is '
  + 'lifted neither by resolving them nor by pushing.';

// ── the base moved under the branch, in the same ONE home again ─────────────
//
// A green measured against a base that has since MOVED is not a green:
// retargeting a cascade child updates where it points and re-runs nothing, so
// its check result still describes a merge base that no longer exists.
// `sentinel.cjs merge` has refused on this since T-24-05 — with a message and no
// action, while the board went on offering the merge that refusal was waiting
// for. One predicate, two readers, and the remedy is named rather than described.
//
// TWO signals, because neither alone suffices (the merge gate's own reasoning):
// `merge_state` is GitHub's `mergeStateStatus`, authoritative but reported as
// BEHIND only where branch protection requires up-to-date branches; `behind_by`
// is our own `gh api compare` count, which works everywhere but is a second
// opinion rather than a verdict. DIRTY is the third state and a different fact —
// conflicts, not staleness — with the same remedy and a different sentence.
function baseMoved(facts) {
  const f = facts || {};
  const st = String(f.merge_state || '').toUpperCase();
  const n = Number(f.behind_by);
  const behind = Number.isFinite(n) && n > 0 ? n : null;
  if (st === 'DIRTY') return { kind: 'dirty', behind };
  if (st === 'BEHIND') return { kind: 'behind', behind };
  if (behind !== null) return { kind: 'behind', behind };
  return null;
}

// The remedy, as a command and not as a description. `base-merge.cjs` takes the
// base's edition for conflicts in files the ticket does not declare and leaves
// the real ones for judgement; the anti-rebase rule travels with it, because a
// pushed branch rebased is a force-push that dismisses approvals and re-anchors
// every thread the round just resolved.
function baseMergeWhy(moved, base) {
  const where = base ? `\`${base}\`` : 'its base';
  const how = 'In the ticket worktree: `base-merge.cjs <ticket> --worktree <path> --base <base ref>` '
    + '(or `git fetch origin && git merge origin/<base>`) — NEVER rebase: the PR is pushed, so a rebase is a '
    + 'force-push that dismisses approvals and re-anchors resolved threads.';
  if (moved.kind === 'dirty') {
    return `merge conflicts with ${where} — the base moved and the two editions disagree. ${how}`;
  }
  const far = moved.behind !== null ? `${moved.behind} commit(s)` : 'some commits';
  return `the base moved: ${where} is ${far} ahead of this branch, so any green here was measured against a `
    + `merge base that no longer exists. ${how}`;
}

const ORDER = ['execute', 'publish', 'fix', 'finalize', 'merge'];
const SENTINEL_BUCKETS = ['fix', 'finalize', 'merge'];

// Facts GitHub cannot know. `parked` is the session-scoped channel — a judgement
// made mid-run that has no home on disk yet; a front that keeps re-offering an
// escalated PR is an infinite babysit loop, so the caller passes those ids in.
function computeFront(tickets, state, opts = {}) {
  const parkedIds = new Set(opts.parked || []);
  // A drift verdict is a fact about the PLAN, not about a session, so unlike
  // `parked` it has to outlive the run that discovered it. Without that the front
  // re-offers the ticket as executable on every single run: two tickets confirmed
  // stale on 2026-08-06 were still being listed under `execute` days later, and
  // deliver.md's promise that a drifted ticket is "marked needs-replan" pointed
  // at a mark nothing wrote and nothing read. The caller supplies
  // {ticket: reason}; it is expected to drop entries whose plan has since been
  // re-planned, so the park lifts by itself rather than becoming permanent.
  const drifted = opts.drifted || {};
  // An escalation is the same shape of fact one level down: not about the plan,
  // but about the PR as it stood when the run gave up. It used to travel ONLY as
  // `--parked`, so it died with the session and the next run re-dispatched
  // review-fix and arch-review against a PR a human had already been asked to
  // handle — with the reason, the only part worth inheriting, gone. The caller
  // supplies the park RECORDS `activeParks` returns — {ticket: {kind, reason}} —
  // and is expected to drop entries whose PR has since moved, so a human
  // answering the review lifts the park by itself. The record travels whole
  // rather than flattened to its reason because the KIND decides which lifting
  // rule the human is told about, and a kind recovered from the reason TEXT is a
  // kind that free text can forge. A bare string is still accepted: that is the
  // flat `activeEscalations` view, which has already discarded the kind, so it
  // renders as an ordinary escalation.
  const escalated = opts.escalated || {};
  // "An agent is already holding this one." The third durable fact GitHub cannot
  // know, and the only one that is not a park: a dispatch is motion, not a
  // verdict. Without it a ticket handed to an agent is indistinguishable from one
  // nobody has touched — nothing is pushed yet, so state-sync still classifies it
  // `execute` — and the stop gate refuses turns over work already in flight (five
  // times in one session, on both owners' buckets). The caller supplies the
  // records `activeDispatches` returns — {ticket: {role, at}} — and that reader
  // has already dropped everything expired, so nothing here decides how long a
  // dispatch lives. A bare role string is accepted as the flattened shape.
  const dispatched = opts.dispatched || {};
  // Auto-merge is a config decision (pipeline.auto_merge) that state-sync passes
  // in; the front never guesses it, because the difference is whether an unmerged
  // green PR is the run's work or a human's.
  const autoMerge = opts.autoMerge === true;
  // ── the project's own config, read AT MOST ONCE per call ───────────────────
  //
  // Two knobs are resolved from it (`merge_without_ci` below and
  // `max_concurrent_agents` further down) and they share this one memo, so no
  // board ever opens the file twice. It stays a function rather than a value
  // because a caller who pins BOTH knobs must still read nothing at all: the
  // passed option always wins, and there is then nothing to look up.
  //
  // WHICH project: `graph-dir.cjs`, never `process.cwd()`. That is this repo's
  // one answer to "which project does this invocation belong to" —
  // `--graph`/`SHIPYARD_GRAPH_DIR` → cwd → the worktree's OWN repository, with
  // the project root the graph's grandparent. computeFront has three callers
  // (state-sync.cjs, dispatch-record.cjs and the CLI below); the first and last
  // stand at the project root and a cwd read would serve them, but
  // `dispatch-record.cjs refreshFront` is DOCUMENTED to run from a ticket
  // worktree — which has no `.planning/` of its own when the project keeps it
  // untracked — and it REWRITES `delivery-front.json` from what it computes. A
  // cwd read there answers with a project that is not this one. Reviewer-found
  // on PR #44, and calling it "conservative" was the excuse: two different
  // answers are not more and less cautious, they are inconsistent.
  //
  // `valid` rides along because the two knobs need it: an unparseable config
  // means no policy is in effect, and each knob says below what it does then.
  let projectConfigCache;
  const projectConfig = () => {
    if (projectConfigCache === undefined) {
      try {
        const { resolveGraphDir } = require(path.join(__dirname, 'graph-dir.cjs'));
        const { loadConfig } = require(path.join(__dirname, 'pipeline-config.cjs'));
        const { dir, how } = resolveGraphDir(process.argv.slice(2), process.cwd());
        const root = how === 'none' ? process.cwd() : path.resolve(dir, '..', '..');
        const { config, valid } = loadConfig(root);
        projectConfigCache = { config, valid };
      } catch (e) {
        // Unreadable is treated exactly as unparseable: no policy is in effect.
        projectConfigCache = { config: null, valid: false };
      }
    }
    return projectConfigCache;
  };
  // "This repo has no CI" is a claim only the PROJECT can make, so it is a
  // config knob (`delivery_pipeline.merge_without_ci`) and never an inference.
  // The caller may pass it and that always wins; otherwise it comes from the
  // shared read above, and only the first time a PR with no checks is actually
  // seen — so a caller that pins this knob and the cap reads no file at all.
  //
  // The fallback exists because a board that answered `merge_human` while
  // sentinel.cjs — which reads the config directly — landed the same PR is
  // exactly the board/guard disagreement the shared predicates above exist to
  // prevent. An unreadable or unparseable config is still `false`, because
  // absence is not consent.
  const mergeWithoutCi = () => {
    if (opts.mergeWithoutCi !== undefined) return opts.mergeWithoutCi === true;
    const { config, valid } = projectConfig();
    return valid && !!config && config.merge_without_ci === true;
  };
  // ── the concurrency cap (ADR-005 D11) ──────────────────────────────────────
  //
  // How many agents this run may hold at once. It belongs on the board because
  // the board is what the wave is BUILT from: deliver.md Step 3 fans out over
  // every ready ticket in one call and Step 4 posts a guard beside it, and
  // nothing counted. A rule in prose is the class of rule this repo has already
  // watched get skipped, so the number lives here.
  //
  // Resolution has the same two steps as `merge_without_ci` above, and for the
  // same reasons: a caller that has already paid for the config passes it in,
  // and everyone else is served lazily through `graph-dir.cjs` — which answers
  // "which PROJECT does this invocation belong to" even from a ticket worktree,
  // where `dispatch-record.cjs refreshFront` is documented to run.
  //
  // The two failure directions are deliberately DIFFERENT, because a capacity
  // cap is a gate on DISPATCH and a gate's failure must always be to dispatch
  // LESS, never more:
  //
  //   the VALUE is malformed (0, negative, not a number) in a config that
  //   parses → pipeline-config.cjs warns and uses the measured default. A typo
  //   in a number is not a decision to stop working, and a run that stalls on a
  //   typo is a run whose operator switches the cap off.
  //
  //   the FILE does not parse, or cannot be read at all → `max: 0`, so nothing
  //   may be dispatched. T-26-02's rule applied to capacity: an invalid config
  //   permits no mutation, and handing work to an agent is a mutation. The
  //   permissive reading — "fall back to the default so the run keeps moving" —
  //   would let a wave out under a policy nobody can read, which is precisely
  //   the direction this gate must never fail in.
  //
  // So `max === 0` means exactly one thing — no policy could be read — and
  // formatFront relies on that to word the line. A CALLER cannot express 0: a
  // non-positive or non-numeric `opts.maxConcurrentAgents` is treated as absent
  // and the project's own policy answers, so a caller's arithmetic slip can
  // never freeze a run.
  const capMax = () => {
    const passed = Number(opts.maxConcurrentAgents);
    if (Number.isFinite(passed) && passed > 0) return passed;
    const { config, valid } = projectConfig();
    // `|| 0` covers the impossible-but-cheap case of a config object without
    // the key; pipeline-config.cjs has already coerced a malformed value to the
    // measured default, so a positive number is what a VALID config yields.
    return valid && config ? Number(config.max_concurrent_agents) || 0 : 0;
  };
  // The resolver is handed over UNCALLED. `noCiHold` settles `autoMerge` and
  // `none_reported` first and only then asks for it, so the promise the comment
  // above makes — "an ordinary board still reads no file here" — is kept by the
  // predicate's own structure rather than by this line remembering to.
  const heldForNoCi = (s) => noCiHold(s.checks, { autoMerge, mergeWithoutCi });
  // Expected CI length per ticket, in seconds, supplied by the caller —
  // `ciEstimates` below derives it and BOTH entry points pass it in. It is data,
  // not a lookup: computeFront is a pure function over its inputs and reads no
  // file, so the journal is opened by the caller or not at all.
  const ciEst = opts.ci_estimates || {};
  // The parent rules, bound to this call's graph. `sentinel.cjs` binds the SAME
  // functions over its own — the two cannot disagree because there is only one of
  // each.
  const checkpointParent = (id) => checkpointParentOf(id, tickets, state);
  // The guard's parked set is `--parked` ∪ escalations ∪ drift verdicts (see
  // sentinel.cjs's PARKED). The board holds the same three facts under three
  // names, so the union is built here rather than passed: a narrower set on
  // either side means the two disagree the moment a human parks a parent.
  const parkedForParent = new Set([...parkedIds, ...Object.keys(drifted), ...Object.keys(escalated)]);
  const movingParent = (id) => movingParentOf(id, { tickets, state, parked: parkedForParent });
  // The board's base is the one it holds; `sentinel.cjs mergeOne` asks the same
  // predicate about `pr.baseRefName` from the live view. Same rule, two bases,
  // deliberately — `dutyItems` resolves it exactly this way.
  const limbBase = (id) => limbBaseOf(
    id, ((state[id] || {}).pr_base || (state[id] || {}).base || null), { tickets, state }
  );

  const actionable = { execute: [], publish: [], fix: [], finalize: [], merge: [] };
  const waiting = { ci: [], dispatched: [], parent: [], merge_human: [], human: [] };
  const parked = { blocked: [], done: [] };
  const why = {};
  // Which parent each `waiting.parent` child is held behind. The FRONT decides
  // who that is, so `ci-wait.cjs` can watch the parent's pipeline without
  // re-deriving graph semantics from tickets.json — the board is the one place
  // that answers "what is this run waiting for".
  const parentOf = {};

  for (const id of Object.keys(state)) {
    const s = state[id] || {};
    const t = (tickets && tickets[id]) || {};

    if (parkedIds.has(id)) {
      parked.blocked.push(id);
      why[id] = 'parked by this run (escalation or attempts exhausted)';
      continue;
    }

    // Checked BEFORE `merged`: a ticket can be both drifted and already landed
    // under other names, and calling that "done" would hide the stale plan.
    if (drifted[id] && s.status !== 'merged') {
      parked.blocked.push(id);
      why[id] = `drifted — ${drifted[id]}. Re-plan it (/shipyard:decompose); executing this plan builds against a codebase that moved.`;
      continue;
    }

    if (s.status === 'merged') {
      parked.done.push(id);
      continue;
    }

    // After `merged` — unlike drift. A drifted plan stays worth flagging even
    // when the work landed under other names, but an escalation is a verdict on
    // getting this PR in: if it is in, there is nothing left to escalate.
    if (escalated[id]) {
      parked.blocked.push(id);
      why[id] = escalationWhy(id, escalated[id]);
      continue;
    }

    // After every park and after `merged`, and both placements are deliberate. A
    // park is a DECISION and outranks a dispatch, which is only a transient; and
    // a dispatch for a ticket that has already landed must suppress nothing at
    // all — whoever was working on it, it is in.
    //
    // Placed BEFORE the status branches rather than inside them, so it covers
    // both owners: the main loop's execute/publish and the guard's
    // fix/finalize/merge. The first sighting of this defect was an executor wave,
    // but the guard's contract is "post it and do NOT wait", so the front
    // mis-reported the sentinel's buckets on every healthy run that followed the
    // documented protocol.
    if (dispatched[id]) {
      waiting.dispatched.push(id);
      why[id] = dispatchWhy(id, dispatched[id]);
      continue;
    }

    if (s.status === 'pr-open') {
      // FIRST inside the branch, and the position is the whole point: `dutyItems`
      // tests `parentIsMoving` BEFORE the failing-checks branch, so a red child of
      // an open parent is `wait-parent` and not `ci-fix`. Placed after the checks
      // chain instead, the board would still offer `fix`/`finalize`/`merge` on
      // exactly the tickets that cost a second CI round — which is the
      // disagreement this bucket exists to end. Do not reorder.
      //
      // NOTE for T-24-09: the stop gate's CI-only branch reads `waiting.ci`
      // alone, so a board holding nothing but `waiting.parent` still permits a
      // stop today. That ticket extends the gate; this one gives it the bucket to
      // read.
      const movingBase = movingParent(id);
      if (movingBase) {
        waiting.parent.push(id);
        parentOf[id] = movingBase;
        why[id] = `PR #${s.pr}: stacked on ${movingParentWhy(movingBase, state)} — driving this one to green now `
          + 'buys a green the base move will undo. Drive the parent; this follows when it lands.';
        continue;
      }
      const c = s.checks || {};
      // `none_reported` means nothing ran, not that everything passed —
      // state-sync warns about it separately; for the front it counts as green
      // so the gate can still be driven (the human is told what "green" meant).
      // `unavailable` does NOT: check-state.cjs's `isGreen` asks that flag first,
      // because a reading that never happened has all-zero tallies and the
      // arithmetic this line used to spell out therefore said green about it.
      const green = isGreen(c);
      if ((c.failing || 0) > 0) {
        actionable.fix.push(id);
        why[id] = `PR #${s.pr}: ${c.failing} failing check(s)`;
      } else if (baseMoved(s)) {
        // Same bucket as a failing check and the same owner (the guard), because
        // it is the same shape of work: something has to change on the branch
        // before anything else about it means anything. Placed AFTER the failing
        // branch on purpose — a red check is the louder fact and the fixer sees
        // the stale base in its own dispatch either way — and BEFORE `waiting.ci`,
        // because a run measuring a moved base is a run to restart, not to wait
        // for. `dutyItems` orders the same two facts the same way.
        actionable.fix.push(id);
        why[id] = `PR #${s.pr}: ${baseMergeWhy(baseMoved(s), s.pr_base || s.base)}`;
      } else if (c.unavailable) {
        // THE READING THAT DID NOT HAPPEN. `gh pr checks` errored or answered
        // something that is not a JSON array, so this PR's CI state is unknown —
        // which is not "no checks" (`none_reported`, a decision a person makes
        // once per repository) and not "one check pending" either, which is what
        // the synthetic unreadable row used to say about a check nobody ever saw.
        // Nobody owes work and nobody is asked to confirm anything: the next sync
        // simply looks again, so the honest bucket is the one that means exactly
        // that. `waiting.ci` is deliberately not a fixpoint — the stop gate's
        // CI-only branch keeps the run alive and `ci-wait.cjs` terminates it
        // (T-24-10 counts unreadable rounds as empty windows and escalates).
        //
        // PLACED LATE, after the failing and moved-base branches, and the
        // position is load-bearing: the permanent case is an old `gh` that
        // rejects `--json bucket`, where checks stay unreadable for every round
        // of the run. Routing here first would freeze base-merge — real work,
        // read from `merge_state`, which no `pr checks` failure says anything
        // about — behind a reading that is never coming. Only the two actions
        // that walk a PR towards LANDING are withheld, exactly as the no-CI hold
        // withholds them; `sentinel.cjs`'s duty holds the same position.
        waiting.ci.push(id);
        why[id] = `PR #${s.pr}: checks unreadable: ${c.note || 'gh pr checks did not answer'} — retried next sync`;
      } else if ((c.pending || 0) > 0) {
        waiting.ci.push(id);
        why[id] = `PR #${s.pr}: ${c.pending} check(s) still running`;
      } else if (s.draft && gateConform(s) && heldForNoCi(s)) {
        // A certified draft with nothing left but the readying, in a repo where
        // nothing ran. `finalize` here would be dispatched every round to do that
        // one mechanical step the guard now withholds — "every round re-proposes
        // the same impossible action", which is the loop this bucket exists to
        // end. An UNCERTIFIED draft falls through: arch-review is still owed.
        waiting.merge_human.push(id);
        why[id] = `PR #${s.pr}: ${NO_CI_WHY} It is left as a draft, which is what a draft says.`;
      } else if (s.draft) {
        // Draft is the pre-gate state: threads, arch-review and the conform gate
        // are all still ahead, and every one of them is work the run can do now.
        actionable.finalize.push(id);
        why[id] = `PR #${s.pr}: green and still a draft — threads, arch-review, conform gate`;
      } else if (needsHuman(t) && green) {
        // Out of draft on a checkpoint ticket whose judgement nobody has supplied
        // = the gate was cleared and the approval/merge is the human's. A
        // checkpoint parks the PUBLISH step only; it never justifies leaving the
        // code unwritten (see deliver.md). A PRE-AUTHORIZED one falls through to
        // the merge branch below: the person answered at plan time, so the wait
        // has already been served — the gate itself (conform trailer, threads,
        // stacked base) is still enforced there, exactly as for any other ticket.
        waiting.human.push(id);
        why[id] = `PR #${s.pr}: human_checkpoint — awaiting approval/merge`;
      } else if (reviewStandsAlone(s.review_decision, s.unresolved_count)) {
        // A verdict with nothing behind it to service. `waiting.human`, NOT
        // parked: nobody owes work, a reviewer holds the key — the same class as
        // a child held behind an open checkpoint parent. Placed after the
        // checkpoint branch because that person is already being waited for, and
        // after the draft branches because a draft still owes arch-review and the
        // conform gate, which are real work whatever the reviewer said.
        //
        // WHERE THE COUNT COMES FROM — and it is not the sync. An unresolved
        // thread count is a per-PR GraphQL query, the class of field that made a
        // monorepo sync cost 41s instead of 7s, so it never enters the sync
        // window: `unresolved_count` is NOT a field state-sync writes, and this
        // comment used to say it was. (`merge_state`, the other half of the pair
        // this branch was shipped with, DOES ride the open-only pass — one scalar
        // on a call already being made — which is why that predicate is fed and
        // this one is not.) So the branch fires for a caller that already HOLDS
        // the count, and for nobody else: on a board rebuilt from GitHub it is
        // unreachable BY DESIGN, and the integrator reading it as dead was right.
        //
        // A synced board learns a real zero the way it learns every other fact a
        // live query owns — as a PARK. The guard reads the count off the
        // `reviewers.cjs unresolved` call it already makes, answers `wait-human`
        // for this exact state, and the durable form of that answer is
        // `escalation-record.cjs mark <T> <reason>`; `activeParks` then routes the
        // ticket above this whole chain, and the park lifts by itself when the
        // review verdict moves (`parkFingerprint` hashes `review_decision`), so
        // nothing has to remember to unpark it.
        //
        // An UNKNOWN count is not a disagreement either, which is why no fallback
        // is owed here: the guard's own answer for it is `review-fix`, whose
        // bucket on this board is `finalize` — where the final branch below
        // already puts exactly that PR.
        waiting.human.push(id);
        why[id] = `PR #${s.pr}: ${REVIEW_STANDS_WHY}`;
      } else if (autoMerge && gateConform(s) && s.merge_scope === 'stacked' && checkpointParent(id)) {
        // Ready in every respect, and still not the run's to land: the base is a
        // parent whose ticket is a human_checkpoint with an OPEN PR. Squashing
        // there rewrites the diff that person is reading, and the post-merge
        // retarget would send this child's own children to the epic — content
        // that is actually sitting in a checkpoint branch. `sentinel.cjs merge`
        // refuses it; the front must not offer what the guard will refuse, or
        // every round re-proposes the same impossible action.
        //
        // The hold stands whether or not the parent is PRE-AUTHORIZED, and the
        // choice is deliberate: pre-authorization is a person approving THAT
        // ticket's diff at plan time, so it covers the parent's own merge and not
        // merges INTO it — a child squashed in first changes what lands under
        // that approval, and the retarget incoherence is unchanged. What differs
        // is only who is being waited for: a person, or the guard's own next
        // merge. The reason says which, because the remedy is not the same.
        //
        // waiting.human, NOT parked: nobody owes work here — the same class the
        // front already models. Three of five escalations in one phase existed
        // only to hold this by hand.
        const parent = checkpointParent(id);
        waiting.human.push(id);
        why[id] = needsHuman(tickets && tickets[parent])
          ? `PR #${s.pr}: green + conform, but its base is ${parent} — a human_checkpoint PR still open. It merges once that one lands.`
          : `PR #${s.pr}: green + conform, but its base is ${parent} — a pre-authorized human_checkpoint PR still open. Nobody is reading it, but it lands first; this one follows.`;
      } else if (autoMerge && gateConform(s) && s.merge_scope === 'stacked' && heldForNoCi(s)) {
        // Ready in every other respect, and nothing verified it. `sentinel.cjs
        // merge` refuses this against LIVE GitHub, so the board must not offer
        // it — the front must never offer what the guard declines.
        waiting.merge_human.push(id);
        why[id] = `PR #${s.pr}: ${NO_CI_WHY}`;
      } else if (autoMerge && s.review_decision !== 'CHANGES_REQUESTED'
                 && gateConform(s) && s.merge_scope === 'stacked' && limbBase(id)) {
        // Ready in every other respect, and the base is a LIMB: a ticket branch
        // whose own ticket has already merged, so its content is in the epic and
        // the branch is only still there because nothing deleted it. A squash
        // landing here strands the work — PR #52, measured, with the epic missing
        // the very files the board reported merged.
        //
        // `sentinel.cjs merge` refuses this against LIVE GitHub and `dutyItems`
        // answers `human-merge` for it; the board must not offer what the guard
        // declines, or every round re-proposes the same impossible action. That
        // is not a hypothetical here: this branch is the second half of a fix
        // whose first half taught the gate a refusal the board never learned.
        //
        // `waiting.merge_human`, matching the NO-CI hold above and duty's own
        // `human-merge` — the remedy is a retarget plus a base-merge, and until
        // someone does it this run has no move. The remedy text is the guard's,
        // character for character, because two paraphrases of one remedy make an
        // operator guess which is current.
        //
        // CHANGES_REQUESTED is excluded, and that guard is not decoration: duty
        // reaches `review-fix` BEFORE its own limb branch, so a limb PR carrying
        // a verdict is still work — servicing the threads. Without this clause
        // the board would answer `waiting.merge_human` where the guard answers
        // `review-fix`, which is the disagreement this branch exists to remove,
        // merely relocated.
        waiting.merge_human.push(id);
        why[id] = `PR #${s.pr}: green + conform, but its ${limbRemedy(id, s.pr_base || s.base || null, limbBase(id), { tickets, state })}`;
      } else if (autoMerge && s.review_decision !== 'CHANGES_REQUESTED' && gateConform(s) && s.merge_scope === 'stacked') {
        // The sentinel's merge: into the epic or a parent ticket branch only.
        // `merge_scope` is set by state-sync; an integration-branch target never
        // gets it, so a phase can never land on the default branch without a
        // human. sentinel.cjs re-verifies all of this against live GitHub.
        actionable.merge.push(id);
        why[id] = `PR #${s.pr}: green + conform — squash into ${s.pr_base || s.base} (sentinel)`;
      } else if (autoMerge && gateConform(s) && s.merge_scope !== 'stacked') {
        waiting.merge_human.push(id);
        why[id] = `PR #${s.pr}: green + conform, but it targets ${s.pr_base || s.base} — that merge is a human's`;
      } else if (s.review_decision === 'APPROVED' && !autoMerge) {
        waiting.merge_human.push(id);
        why[id] = `PR #${s.pr}: approved + green — awaiting merge (human)`;
      } else if (autoMerge && !gateConform(s)) {
        // Green and out of draft, but the architecture verdict was never
        // recorded on the PR. With auto-merge on that trailer IS the gate, so
        // the run owes the work rather than parking on a human.
        actionable.finalize.push(id);
        // The words follow the STATE, not just its absence: "no trailer" about a
        // body that visibly carries one sends the run looking for the wrong
        // thing, and the stale case has to name both SHAs or the remedy
        // ("re-judge THIS head") is a guess.
        why[id] = `PR #${s.pr}: green, ${gateWhy(s.gate, s.head_sha)} — threads + arch-review still owed`;
      } else {
        // Green, out of draft, not approved: bot/human review is still open, so
        // there are threads to service and an arch-review verdict to record.
        actionable.finalize.push(id);
        why[id] = `PR #${s.pr}: green, review not settled (${s.review_decision || 'no decision'})`;
      }
      continue;
    }

    if (s.status === 'branched') {
      if (s.ready) {
        actionable.publish.push(id);
        why[id] = 'branch exists, PR missing — run the did-work gate and publish';
      } else {
        parked.blocked.push(id);
        why[id] = blockedWhy(s);
      }
      continue;
    }

    // pending
    if (s.ready) {
      actionable.execute.push(id);
      why[id] = 'ready — worktree + executor';
    } else {
      parked.blocked.push(id);
      why[id] = blockedWhy(s);
    }
  }

  const counts = {
    execute: actionable.execute.length,
    publish: actionable.publish.length,
    fix: actionable.fix.length,
    finalize: actionable.finalize.length,
    merge: actionable.merge.length,
    ci: waiting.ci.length,
    dispatched: waiting.dispatched.length,
    parent: waiting.parent.length,
    merge_human: waiting.merge_human.length,
    human: waiting.human.length,
    blocked: parked.blocked.length,
    done: parked.done.length,
  };
  const actionableCount = ORDER.reduce((n, k) => n + actionable[k].length, 0);
  // A dispatch counts against the fixpoint exactly as a running CI queue does:
  // the work is moving and its result has to be collected. Saying YES here would
  // hand the human a summary written before the answers came back. A child held
  // behind a moving parent is the same class of fact: the parent is being driven,
  // and when it lands this ticket becomes work again — so the round has to come
  // back for it.
  const fixpoint = actionableCount === 0 && waiting.ci.length === 0
    && waiting.dispatched.length === 0 && waiting.parent.length === 0;
  // What a wave may take NOW. The cap is a TRUNCATION of the order below, never
  // a filter: nothing is moved out of `actionable`, and that is what keeps the
  // fixpoint honest without touching its formula — `actionable_count` is
  // unchanged, so a board with work and no free capacity still reports
  // `fixpoint: NO`. Implemented as a filter it would have flipped exactly the
  // way phase 24 exists to prevent: a capped front reporting YES ends a run
  // mid-phase.
  //
  // `in_flight` counts AGENTS, not the actionable buckets and not the records:
  // the cost is the agent, whatever bucket its ticket landed in, so a
  // pr-sentinel and a ci-fix count exactly as an executor does — but ONE guard
  // holding four PRs is one agent, and the collapse that says so is
  // `AGENT_CARDINALITY` beside `agentsInFlight` below (ADR-006 D1).
  // `activeDispatches` has already dropped everything expired or landed, so
  // nothing here decides how long a dispatch lives.
  const inFlight = agentsInFlight(dispatched);
  const capacity = { max: capMax(), in_flight: inFlight, free: Math.max(0, capMax() - inFlight) };
  // SHALLOWEST FIRST within a stack — the THIRD sort key now; the full order is
  // stated at the comparator below. A ticket stacked on an open parent is
  // work that will have to be redone: when the parent lands, this branch's base
  // moves, CI re-runs against different code and reviewers re-read a changed
  // diff. Ordering by stack depth is what makes "drive the parents first" the
  // default rather than a thing to remember, and it costs one comparison.
  const depth = (id, seen = new Set()) => {
    const parent = ((tickets && tickets[id]) || {}).primary_parent;
    if (!parent || seen.has(id)) return 0;
    seen.add(id);
    return ((state[parent] || {}).status === 'merged' ? 0 : 1) + depth(parent, seen);
  };
  // …but depth only orders work WITHIN a stack. Across phases it says nothing,
  // and sorting by it alone promotes the oldest left-behind tickets to the head
  // of the list: a phase-2 root has depth 0, so it outranks every live child of
  // the phase being worked. Observed immediately after shipping the sort — two
  // tickets judged stale six days earlier sat first under `execute`, and a run
  // that takes the head of the list would have taken one.
  //
  // "Left behind" is a ticket its OWN phase shipped WITHOUT: the phase's epic has
  // landed on the integration branch and this ticket is not in it. Those go LAST
  // — still listed, because the fixpoint must not lie about them, but never ahead
  // of work that is actually in flight.
  //
  // It used to be ARITHMETIC over phase numbers — `phase(id) < max(phase of any
  // merged ticket)` — which is a different claim entirely: it says a HIGHER
  // NUMBER landed, not that THIS phase did. This repository delivered phase 22
  // before 21 on purpose (ROADMAP §22), so every phase-21 ticket read as left
  // behind while it was the live work. Measured on 2026-09-07: three phase-26
  // tickets merged into their epic, `max` became 26, and the board reported
  // phase 24's T-24-05 — high risk, pre-authorized, the live head of that
  // phase's chain — as `ALL 1 actionable item(s) are in phases already moved
  // past`; the stop gate's all-left-behind hatch then exited 0 over it. Nothing
  // about phase 24 had been abandoned. The only fact behind the verdict was that
  // 26 is greater than 24.
  //
  // So the flag needs POSITIVE EVIDENCE of an integration event, and the caller
  // supplies it rather than this file inferring it: `opts.epics` is
  // state-sync.cjs's own `epicInfo` — `landed | not-landed | unknown` per phase
  // per repo, keyed by `epicKey`, and the only place in the conveyor that has
  // actually asked GitHub. A caller that cannot supply the observation
  // (front.cjs's own CLI, `dispatch-record.cjs refreshFront`) gets NO left-behind
  // at all, deliberately: the hatch this feeds must never fire on a fact nobody
  // measured, and "no evidence" has to mean "keep driving".
  const epics = opts.epics || {};
  const keyOf = (id) => {
    const t = (tickets && tickets[id]) || {};
    return epicKey(t.phase, t.repo);
  };
  // `landed === true` ALONE is not that evidence, and reading it as such would be
  // a worse defect than the arithmetic it replaces. It means "nothing from this
  // phase is outside the base" — a READINESS fact (state-sync blocks cross-phase
  // dependents on it) — and it is deliberately true in two states where nothing
  // has landed: a phase whose epic BRANCH does not exist yet (every decomposed
  // phase has an `epics` entry from the moment it is planned, long before its
  // branch is cut), and an epic freshly cut from the base with nothing merged
  // into it yet. Either would flag a whole phase at the instant its delivery
  // began.
  //
  // The integration event is therefore ONE observable thing: the epic's own
  // integration PR is MERGED. That is the act — a person performs it, the
  // conveyor never auto-merges an epic — and the record already carries it.
  //
  // A MERGED TICKET of the phase is deliberately NOT accepted as the same fact,
  // and the reason is a fact about `delivery-state` rather than a preference.
  // `status: 'merged'` says a ticket's PR was merged into ITS OWN BASE, and in a
  // stack that base is legitimately a parent TICKET branch — `pr_base` (the only
  // field that would tell the two apart) is recorded for OPEN PRs alone, so a
  // merged entry cannot answer "into the epic, or into a parent?". Accepting it
  // would re-create this ticket's own defect on any freshly cut epic: epic level
  // with its base, one child squash-merged into an open parent by hand, and the
  // green ready parent reads as left behind while the hatch exits 0 over it. So
  // an epic PR outside the bulk window — or one a human merged and reaped
  // without a PR at all — is given up in the conservative direction: no
  // evidence, no hatch, the run keeps driving.
  const leftBehind = (id) => {
    // A merged ticket is IN the phase that landed; it is not a casualty of it.
    // (It is never actionable either, so this is the definition holding rather
    // than a bucket being filtered.)
    if ((state[id] || {}).status === 'merged') return 0;
    const info = epics[keyOf(id)];
    // No record (direct-to-main, or a phase this graph knows no epic for) and
    // `landed: null` (the compare did not answer) are both 0 — one has no epic
    // that could land, the other has an answer nobody received.
    if (!info || info.landed !== true) return 0;
    return info.pr && String(info.pr.state || '').toUpperCase() === 'MERGED' ? 1 : 0;
  };

  // UNBLOCKING POWER — how much other work this ticket is holding up. Depth
  // orders a stack and left-behind demotes a phase that shipped without it, but
  // neither says which of two live roots to take, and unattended that is the
  // decision that matters: the head of the list is what the 04:00 round picks up,
  // so it should be the ticket that leaves the most work available behind it.
  //
  // Counted over `depends_on` (the whole DAG) rather than `primary_parent` (the
  // branch stack): a ticket can gate work it was never going to be the base of.
  const dependents = new Map();
  for (const [cid, t] of Object.entries(tickets || {})) {
    for (const dep of (t && t.depends_on) || []) {
      if (!dependents.has(dep)) dependents.set(dep, []);
      dependents.get(dep).push(cid);
    }
  }
  // A FRESH visited set per root, memoised by root. validate-graph.cjs already
  // paid for the other half of this: ancestor closures computed with a set
  // SHARED across recursions cached truncated closures and rejected valid
  // diamond graphs. The mirror-image defect here is inflation — in A←B, A←C,
  // B←D, C←D, D is reachable by two paths and must still count ONCE for A. The
  // same set makes the walk cycle-tolerant: Gate 2 proves the graph acyclic, but
  // the front must not hang on a corrupt file.
  const descCache = new Map();
  const descendants = (id) => {
    if (descCache.has(id)) return descCache.get(id);
    const seen = new Set([id]);
    const stack = (dependents.get(id) || []).slice();
    let n = 0;
    while (stack.length) {
      const cur = stack.pop();
      if (seen.has(cur)) continue;
      seen.add(cur);
      // Merged dependents are walked THROUGH — their own children are still held
      // up — but never counted: a merged ticket needs no unblocking.
      if ((state[cur] || {}).status !== 'merged') n++;
      for (const next of dependents.get(cur) || []) stack.push(next);
    }
    descCache.set(id, n);
    return n;
  };
  // Longest pipeline first: starting the slowest one earliest is what overlaps
  // its wait with the rest of the front. A missing or malformed entry ties at 0
  // rather than poisoning the comparator.
  const ciLen = (id) => Number(ciEst[id]) || 0;

  // The order inside every actionable bucket:
  //   leftBehind  ASC   a phase that shipped without it never leads (still first)
  //   descendants DESC  the widest unblocker first
  //   depth       ASC   then top-down within a stack
  //   ciLen       DESC  then the longest pipeline, started earliest
  //   id          ASC   a stable tiebreak, so the board does not shuffle
  //
  // Descendants-before-depth keeps "drive the parents first" by construction
  // rather than by luck: a parent's descendant set strictly contains its
  // unmerged child's, so the parent always wins that key outright.
  const byUnblocking = (a, b) =>
    leftBehind(a) - leftBehind(b) ||
    descendants(b) - descendants(a) ||
    depth(a) - depth(b) ||
    ciLen(b) - ciLen(a) ||
    String(a).localeCompare(String(b));
  for (const k of Object.keys(actionable)) actionable[k].sort(byUnblocking);

  // What the sentinel owns (open PRs) vs what the main loop owns (new tickets).
  // deliver.md splits the run on exactly this line. Built AFTER the sort so the
  // duty line and the buckets it is drawn from cannot print two different orders
  // of the same work. (The guard's own serving order is sentinel.cjs's — this is
  // the board's view of its share.)
  const sentinel = {
    duty: SENTINEL_BUCKETS.flatMap((k) => actionable[k]),
    waiting_ci: waiting.ci.slice(),
    // Held children are the guard's too (deliver.md's bucket table marks
    // `parent` [SENTINEL]) and count exactly as `waiting_ci` does: the guard has
    // to come back when the parent lands. Without this the board would print
    // `sentinel: clear` over a guard that still owes a whole subtree, and
    // deliver.md reads that line as one of the two conditions for completion.
    waiting_parent: waiting.parent.slice(),
    // The guard's share of the dispatched list — the tickets that left `duty`
    // BECAUSE they were handed to the guard or to one of its fixers. Without
    // this the board would print `sentinel: clear — no open PR needs guarding`
    // over a guard that is mid-round, and deliver.md reads that line as one of
    // the two conditions for entering completion.
    dispatched: waiting.dispatched.filter((id) => SENTINEL_ROLES.has(roleOfDispatch(dispatched[id]))),
  };
  sentinel.clear = sentinel.duty.length === 0 && sentinel.waiting_ci.length === 0
    && sentinel.dispatched.length === 0 && sentinel.waiting_parent.length === 0;

  // How much of the actionable list is work its own phase already shipped
  // without. The stop condition has to distinguish "there is live work" from
  // "there is only work left behind": on a real board `fixpoint: NO — 4
  // actionable` was held ENTIRELY by two tickets judged stale six days earlier,
  // so the run was being told that stopping is a defect on account of work it
  // would never take. Both readers of the count (`stop-gate.cjs`'s
  // all-left-behind hatch, `ci-wait.cjs`'s refusal) act on it unchanged — what
  // changed underneath them is that it is now evidence rather than arithmetic.
  const actionableIds = ORDER.flatMap((k) => actionable[k]);
  const leftBehindCount = actionableIds.filter((id) => leftBehind(id)).length;

  return { actionable, waiting, parked, why, counts, parent_of: parentOf, actionable_count: actionableCount, left_behind_count: leftBehindCount, fixpoint, capacity, sentinel, roles: BUCKET_ROLES };
}

// The arch-review verdict is recorded as a `gate_status:` trailer in the PR body
// (it survives a squash merge) and parsed by state-sync into state[id].gate,
// beside the head it was rendered against (state[id].head_sha).
//
// A verdict for ANOTHER head does not count: the observed sequence is verdict →
// undraft → a bot review lands on the undrafted PR → review-fix pushes → CI goes
// green again, and the untouched trailer would otherwise offer a merge of a diff
// arch-review never saw. `sentinel.cjs merge` refuses that against the LIVE head,
// so the board has to refuse it too — the front must never offer what the guard
// declines, or every round re-proposes the same impossible action.
function gateConform(s) {
  return trailerConform((s || {}).gate, (s || {}).head_sha);
}

// EXPECTED CI LENGTH, as a per-repo median over the delivery journal.
//
// A PROXY, and named as one: what is journalled is the PR's LIFETIME (first
// `pr-open` → first `merged`), not CI wall time — nothing records the latter, so
// this number carries review latency and merge-queue waiting with it. That is
// exactly why it is the front's LAST key before the id: it breaks ties between
// otherwise indistinguishable tickets and never outranks unblocking power or
// stack depth.
//
// Grouped by repo because a phase spanning a backend and a frontend repo has two
// unrelated pipelines, and a median from one says nothing about the other.
// MEDIAN, not mean: one PR that sat over a weekend must not redefine its repo.
//
// It reads the LOCAL journal only. Nothing here may grow into a per-PR `gh`
// field — that is the 41s-vs-7s lesson state-sync's bulk window records.
function ciEstimates(graphDir, tickets = {}) {
  const fs = require('fs');
  const path = require('path');
  const repoKey = (id) => String(((tickets && tickets[id]) || {}).repo || '');
  const out = {};
  for (const id of Object.keys(tickets || {})) out[id] = 0;

  let raw;
  try {
    raw = fs.readFileSync(path.join(graphDir, 'delivery-log.jsonl'), 'utf8');
  } catch (e) {
    // No journal yet (a first run, or a fresh graph): everyone estimates 0 and
    // the term falls through to the id, which is the pre-existing order.
    return out;
  }

  // FIRST occurrence wins. The journal is append-only, so the earliest entry for
  // a (ticket, status) pair is when the ticket actually reached that status; a
  // later duplicate is a resync re-observing it.
  const firstAt = new Map();
  for (const line of raw.split('\n')) {
    const s = line.trim();
    if (!s) continue;
    let e;
    // state-sync appends under a lock this read does not take, so a torn tail is
    // reachable. It must cost one sample, never the whole front.
    try { e = JSON.parse(s); } catch (_) { continue; }
    if (!e || e.event !== 'status_change' || !e.ticket || !e.to) continue;
    const ms = Date.parse(e.ts);
    if (!Number.isFinite(ms)) continue;
    const key = `${e.ticket}\u0000${e.to}`;
    if (!firstAt.has(key)) firstAt.set(key, ms);
  }

  const samples = new Map();
  for (const key of firstAt.keys()) {
    const sep = key.indexOf('\u0000');
    if (key.slice(sep + 1) !== 'merged') continue;
    const id = key.slice(0, sep);
    // A ticket the journal remembers but the current graph does not (pruned,
    // archived, or read from the wrong graph) has no KNOWN repo — `repoKey`
    // would default it to '', the same bucket a real local ticket with no
    // `repo` field uses, misattributing a foreign PR's lifetime into the
    // local median.
    if (!(tickets && Object.prototype.hasOwnProperty.call(tickets, id))) continue;
    const opened = firstAt.get(`${id}\u0000pr-open`);
    // Merged with no journalled `pr-open` (imported history, a PR opened before
    // the conveyor watched it): there is no lifetime to measure, so no sample.
    if (!Number.isFinite(opened)) continue;
    const secs = (firstAt.get(key) - opened) / 1000;
    if (!(secs > 0)) continue;
    const r = repoKey(id);
    if (!samples.has(r)) samples.set(r, []);
    samples.get(r).push(secs);
  }

  const medians = new Map();
  for (const [r, xs] of samples) {
    const sorted = xs.slice().sort((a, b) => a - b);
    const mid = sorted.length >> 1;
    medians.set(r, sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2);
  }
  // Every ticket gets its OWN repo's median; a repo with no merged sample yet
  // estimates nothing, which ties it at 0.
  for (const id of Object.keys(out)) out[id] = medians.get(repoKey(id)) || 0;
  return out;
}

function blockedWhy(s) {
  if (s.blocked_by && s.blocked_by.length) {
    return s.blocked_by
      .map((d) => `${d} (${(s.blocked_reasons || {})[d] || 'blocked'})`)
      .join('; ');
  }
  return 'not ready';
}

// The board lines. Deliberately blunt: the last line is the stop verdict, and it
// names the rule so a run cannot quietly reinterpret it.
// Which ladder ROLE each actionable bucket dispatches. The front's buckets and
// the model ladder's roles are two different vocabularies for the same work
// (`execute` vs `executor`, `merge` vs `pr-sentinel`), and nothing used to map
// between them — so a run reading the board naturally logged `role=finalize` or
// `role=merge`, names `pipeline-config.cjs model <role>` rejects. The dispatch
// then resolved no model from role × risk × attempt and someone picked one by
// hand. Publishing has no agent at all: the main loop pushes and opens the PR
// itself, deliberately, so that the "did work" gate is not run by the thing it
// checks. Stating the mapping here is what makes the invented names unnecessary.
const BUCKET_ROLES = {
  execute: ['executor'],
  publish: [],
  fix: ['ci-fix', 'review-fix'],
  finalize: ['review-fix', 'arch-review'],
  merge: ['pr-sentinel'],
};

// Which dispatch roles belong to the guard — DERIVED from the table above rather
// than listed again, so a bucket that changes hands changes both answers at once.
const SENTINEL_ROLES = new Set(SENTINEL_BUCKETS.flatMap((k) => BUCKET_ROLES[k] || []));
const roleOfDispatch = (rec) => (typeof rec === 'string' ? rec : ((rec && rec.role) || ''));

// ── HOW MANY AGENTS A SET OF DISPATCH RECORDS *IS* (ADR-006 D1) ──────────────
//
// The capacity cap is a limit on AGENTS, and records are not agents. The one
// place the two diverge is the guard: `deliver.md` marks a `pr-sentinel` record
// for EVERY guarded ticket, while Step 4 spawns exactly ONE guard for the whole
// round. Counting records therefore reported `in_flight: 4` for a single agent
// holding four open PRs, which under the measured default of 4 left `free: 0`
// and launched no executor until a PR merged — the ordinary mid-phase board, and
// the number the default was measured on is an EXECUTOR wave.
//
// So each role declares its cardinality:
//
//   'round'   one agent for the whole round, however many tickets it holds
//   'ticket'  one agent per record — the per-ticket roles, and the default
//
// The role vocabulary is `pipeline-config.cjs`'s `ROLES`, the same list
// `dispatch-record.cjs mark` validates against and files its records under;
// tests/unit/front.test.cjs iterates ROLES and fails if one has no entry here,
// because a role that silently inherited the wrong cardinality would misreport
// the budget rather than fail. `drift-check` is deliberately 'ticket':
// `workflows/drift-gate.mjs` really does dispatch one judge per ticket, in
// parallel.
//
// This is a COUNTING rule, not the per-role weighting T-26-12 put out of scope
// (that needs a cost model the conveyor does not have): every agent still costs
// exactly 1.
const AGENT_CARDINALITY = {
  executor: 'ticket',
  'ci-fix': 'ticket',
  'review-fix': 'ticket',
  'arch-review': 'ticket',
  'drift-check': 'ticket',
  research: 'ticket',
  integrator: 'ticket',
  // The guard: one agent per round, posted beside the wave and holding every
  // open PR on its duty list.
  'pr-sentinel': 'round',
};
// A role the table does not know spends a WHOLE agent. Unknown must resolve
// UPWARD here — the cap is a gate on dispatch, so its failure direction is to
// dispatch less — and it is the opposite of the rule for a missing SIGNAL in the
// model ladder, where every row is an upgrade and silence must resolve down.
const DEFAULT_CARDINALITY = 'ticket';

// The collapse. Every 'round' role contributes at most one agent no matter how
// many tickets carry its record; everything else contributes one per record.
function agentsInFlight(dispatched) {
  const perRound = new Set();
  let n = 0;
  for (const id of Object.keys(dispatched || {})) {
    const role = roleOfDispatch(dispatched[id]);
    const how = Object.prototype.hasOwnProperty.call(AGENT_CARDINALITY, role)
      ? AGENT_CARDINALITY[role]
      : DEFAULT_CARDINALITY;
    if (how === 'round') perRound.add(role);
    else n += 1;
  }
  return n + perRound.size;
}

// ── IS THE BOARD ABOUT TO BE PRINTED BEHIND REALITY? (ADR-006 D6) ────────────
//
// This module recomputes the buckets from the CACHED `delivery-state.json`.
// Only `state-sync.cjs` re-derives that state from GitHub — so any writer that
// moved GitHub (a push, a merge, a thread resolve) obliges a resync before the
// board is read again, and nothing said so. Found 2026-09-08: the push was
// journalled with `log-event.cjs`, the front was read, "0 actionable" was
// concluded — a verdict computed before the write, right only by accident.
// `dispatch-record.cjs` is the exception, because it refreshes the overlay
// itself; the journal writers are not.
//
// So the board says it on its own face. One line, and it never repeats the
// stale board's contents as fact — those contents are precisely what is wrong.
//
// THE TAIL READER IS A TWIN OF `stop-gate.cjs`'s, DUPLICATED ON PURPOSE.
// `install-shipyard-claude-hook.sh` installs that hook by COPYING the single
// file into `~/.claude/hooks/`, where it has no siblings: a `require` of a
// shared module would break the installed hook while every in-repo test stayed
// green. So each file carries its own copy of ONE rule:
//
//   * read the TAIL only (64KB) — the newest events are at the end, which is
//     the only end either caller needs, and a hook has a ~75ms budget;
//   * COUNT what a resync would teach the board: `merge` (a PR is gone and its
//     children were retargeted) and a pushed `attempt`/`fix_round` (a branch
//     moved, so checks re-ran);
//   * EXCLUDE `status_change` — `state-sync.cjs` writes it, so it is
//     contemporaneous with the state by construction — and `dispatch`, which
//     `dispatch-record.cjs` has already overlaid onto the board. Counting
//     either re-creates the false block that fired five times across phases 20
//     and 22, and a warning that fires on a contemporaneous event teaches its
//     reader to skip it;
//   * shift the first line ONLY when the read actually SEEKED. A seek lands
//     mid-line, so line one is a fragment; dropping it unconditionally ate the
//     only event in a short journal, which is every project that has not been
//     running for weeks.
//
// TWO DELIBERATE DIVERGENCES from the twin, both because the callers differ:
//   * `escalation` is NOT counted here. The hook cannot see a park; this
//     module's CLI reads the escalation store LIVE on every run
//     (`activeParks`), so an escalation is already in the board it is about to
//     print. Pinned by a test, so the two are not "fixed" into agreement.
//   * NO age bound. The hook bounds candidates by `RESYNC_MS` because it
//     BLOCKS the end of a turn globally, and a merge stays in the journal
//     forever. Here nothing is blocked — one line is printed on demand — and a
//     state derived before a journalled merge is behind whatever its age.
const JOURNAL_TAIL_BYTES = 64 * 1024;

// The newest event proving the world moved after `generatedAt`, or null.
function movedSince(graphDir, generatedAt) {
  if (!Number.isFinite(generatedAt)) return null;
  const file = path.join(graphDir, 'delivery-log.jsonl');
  let text;
  let seeked = false;
  try {
    const { size } = fs.statSync(file);
    const start = Math.max(0, size - JOURNAL_TAIL_BYTES);
    seeked = start > 0;
    const fd = fs.openSync(file, 'r');
    try {
      const buf = Buffer.alloc(size - start);
      fs.readSync(fd, buf, 0, buf.length, start);
      text = buf.toString('utf8');
    } finally { fs.closeSync(fd); }
  } catch {
    return null; // no journal is no evidence, and never a warning
  }
  const lines = text.split('\n');
  if (seeked) lines.shift();

  let newest = null;
  for (const line of lines) {
    const t = line.trim();
    if (!t) continue;
    let e;
    try { e = JSON.parse(t); } catch { continue; }
    if (!e || typeof e !== 'object') continue;
    const at = Date.parse(e.ts || '');
    if (Number.isNaN(at) || at <= generatedAt) continue;
    const moved =
      e.event === 'merge' ||
      (e.event === 'attempt' && e.outcome === 'pushed') ||
      (e.event === 'fix_round' && (e.pushed === true || e.pushed === 'true'));
    if (!moved) continue;
    if (!newest || at > newest.at) newest = { at, event: e };
  }
  return newest;
}

// WHEN the state this module is about to render was derived. Read from the stamp
// `state-sync.cjs` wrote and from nothing else: `.planning/` is TRACKED in this
// project, so a checkout rewrites every mtime — an mtime-based answer would
// silently disarm the guard on one repo and invent a derivation time on another,
// and a line printed off a guessed timestamp is a guess. No stamp, no warning.
// `delivery-front.json` first because it is the field the twin reads and
// `refreshFront` preserves it verbatim; `delivery-state-meta.json` is the same
// moment, written last by the sync that published the trio.
function stateDerivedAt(graphDir) {
  for (const name of ['delivery-front.json', 'delivery-state-meta.json']) {
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(graphDir, name), 'utf8'));
      const at = Date.parse((raw && raw.generated_at) || '');
      if (Number.isFinite(at)) return at;
    } catch { /* absent, corrupt, or a directory some accident left behind */ }
  }
  return null;
}

const MOVED_WHAT = {
  merge: 'a merge',
  attempt: 'a push (fix attempt)',
  fix_round: 'a push (fix round)',
};

// The board's own warning about itself: what moved, when, and the ONE remedy.
// It names no bucket and no count — repeating the stale board would be asserting
// exactly what this line exists to deny.
function behindWarning(graphDir, generatedAt = stateDerivedAt(graphDir)) {
  const moved = movedSince(graphDir, generatedAt);
  if (!moved) return null;
  const e = moved.event;
  const what = MOVED_WHAT[e.event] || e.event;
  const who = e.ticket ? ` of ${e.ticket}` : '';
  return {
    event: e.event,
    ticket: e.ticket || null,
    ts: e.ts,
    why:
      `⚠ this board is BEHIND reality: ${what}${who} is journalled at ${e.ts}, after the state it renders ` +
      `was derived (${new Date(generatedAt).toISOString()}). A merge retargets children and a push re-runs ` +
      'checks, and this state knows neither — every line below was computed before that write. ' +
      'Run `state-sync.cjs` and read the board IT prints, not this one.',
  };
}

function formatFront(front) {
  const lines = [];
  // FIRST, before any bucket a reader might believe: this board is behind
  // reality and the remedy is a resync (see behindWarning). Absent on a front
  // computed by a caller that did not look — this file's CLI does.
  if (front.behind && front.behind.why) lines.push(front.behind.why);
  const parts = ORDER.filter((k) => front.actionable[k].length)
    .map((k) => `${k}: ${front.actionable[k].join(', ')}`);
  lines.push(`front: ${front.actionable_count} actionable now${parts.length ? ` — ${parts.join(' | ')}` : ''}`);
  // Name the role each live bucket dispatches, so the run resolves a model with
  // `model <role>` instead of passing the bucket's own name — which the ladder
  // does not know and silently declines to route.
  const live = ORDER.filter((k) => front.actionable[k].length && (BUCKET_ROLES[k] || []).length);
  if (live.length) {
    lines.push(`  dispatch roles (for "model <role>"): ${live.map((k) => `${k} → ${BUCKET_ROLES[k].join(' / ')}`).join(', ')}`);
  }

  const wparts = [];
  if (front.waiting.ci.length) wparts.push(`ci: ${front.waiting.ci.join(', ')}`);
  if ((front.waiting.dispatched || []).length) wparts.push(`dispatched: ${front.waiting.dispatched.join(', ')}`);
  // Rendered with the parent it is held behind: "parent: C" alone sends the
  // reader to the graph to find out WHICH pipeline they are waiting for.
  if ((front.waiting.parent || []).length) {
    const held = front.waiting.parent
      .map((id) => `${id}→${(front.parent_of || {})[id] || '?'}`)
      .join(', ');
    wparts.push(`parent: ${held}`);
  }
  if (front.waiting.merge_human.length) wparts.push(`merge (human): ${front.waiting.merge_human.join(', ')}`);
  if (front.waiting.human.length) wparts.push(`checkpoint (human): ${front.waiting.human.join(', ')}`);
  if (wparts.length) lines.push(`waiting: ${wparts.join(' | ')}`);

  // The sentinel's share of the front, named separately: it is the part that a
  // background guard can take over so the main loop keeps cascading.
  const s = front.sentinel || { duty: [], waiting_ci: [], dispatched: [], waiting_parent: [], clear: true };
  const sDispatched = s.dispatched || [];
  const sHeld = s.waiting_parent || [];
  lines.push(s.clear
    ? 'sentinel: clear — no open PR needs guarding'
    : `sentinel: ${s.duty.length} duty${s.duty.length ? ` (${s.duty.join(', ')})` : ''}` +
      `${sDispatched.length ? ` + ${sDispatched.length} already with an agent (${sDispatched.join(', ')})` : ''}` +
      `${s.waiting_ci.length ? ` + ${s.waiting_ci.length} waiting on CI` : ''}` +
      `${sHeld.length ? ` + ${sHeld.length} held behind a moving parent (${sHeld.join(', ')})` : ''}` +
      ' — post/keep the guard, do NOT wait on it');

  // The cap, printed ONLY when it binds — when the board lists more actionable
  // work than a wave may take now. On a healthy round it is noise; on a capped
  // one it is the difference between a reader trusting the board and a reader
  // wondering why a non-empty front produced no dispatches. An absent field is
  // a front written before this existed (`delivery-front.json` outlives an
  // upgrade), and it must not throw.
  const cap = front.capacity;
  const capBinds = cap && front.actionable_count > cap.free;
  if (capBinds) {
    lines.push(cap.max === 0
      // `max: 0` means exactly one thing (see computeFront): no policy could be
      // read. "0 agents, 0 in flight" would explain nothing, so name the cause
      // and the remedy — which is the file, not a flag.
      ? `capacity: 0 agents — no policy is in effect (the project config does not parse), so nothing may be `
        + `dispatched; ${front.actionable_count} actionable item(s) wait. The fix is the file.`
      : `capacity: ${cap.max} agents, ${cap.in_flight} in flight — `
        + `${front.actionable_count - cap.free} actionable item(s) wait for the next round`);
  }

  if (front.fixpoint) {
    lines.push(
      front.counts.blocked || front.counts.merge_human || front.counts.human
        ? 'fixpoint: YES — nothing actionable and no checks running; only human actions and blockers remain → Step 5'
        : 'fixpoint: YES — everything in scope is delivered → Step 5'
    );
  } else if (front.actionable_count === 0 && front.counts.dispatched) {
    // Nothing to start, and the reason is that it has all been started. This
    // deserves its own sentence: the wording below sends the run to `ci-wait.cjs`,
    // and there is nothing there to wait for — the result arrives with the agents,
    // and that wake-up is free and sooner (ci-wait.cjs refuses for this reason).
    lines.push(
      `fixpoint: NO — ${front.counts.dispatched} ticket(s) are with an agent right now` +
      `${front.counts.ci ? `, and ${front.counts.ci} PR(s) are running CI` : ''}. ` +
      'Do NOT hand them out again and do NOT call this an ending: collect the results, then recompute. ' +
      'Each record also lifts by itself when the ticket\'s state moves or its dispatch times out, ' +
      'so a run that dies here leaves nothing hidden.'
    );
  } else if (front.actionable_count === 0) {
    // Nothing to start, and what is left is a pipeline. Both waits belong here:
    // a ticket's own checks, and a ticket held behind a parent whose checks are
    // the thing it is actually waiting for. Naming `gh pr checks --watch` was the
    // old wording and it sanctioned exactly what this repo removed — a block with
    // no budget, no record and no result the loop can read. `ci-wait.cjs` is the
    // one legitimate wait: it refuses whenever the board has a move, watches the
    // parents of anything held, and returns on the first PR to settle.
    const waits = [];
    if (front.counts.ci) waits.push(`${front.counts.ci} PR(s) still running CI`);
    if (front.counts.parent) waits.push(`${front.counts.parent} PR(s) held behind a parent still being driven`);
    lines.push(
      `fixpoint: NO — ${waits.join(' + ')}. Do NOT end the run: serve them when they report ` +
      '(run ci-wait.cjs — it waits in the foreground and returns on the first PR to settle).'
    );
  } else if (front.left_behind_count && front.left_behind_count === front.actionable_count) {
    // Every actionable item is in a phase that has already landed without it.
    // Saying "ending the run is a defect" here is false: continuing would mean
    // taking work that has been offered and declined every round for days. The
    // honest verdict names the two exits instead of demanding motion — and it
    // names the EVIDENCE, because "moved past" was the old arithmetic's wording
    // and it read as a verdict about phase numbers rather than about an epic.
    lines.push(
      `fixpoint: NO — but ALL ${front.actionable_count} actionable item(s) are in phases whose own epic ` +
      'already landed without them ' +
      `(${front.actionable.execute.concat(front.actionable.fix, front.actionable.finalize).slice(0, 6).join(', ')}). ` +
      'Nothing live remains. These are a decision, not motion: take them, or record why not ' +
      '(`drift-record.cjs mark` when the plan predates what shipped) — after which this reads `fixpoint: YES`.'
    );
  } else if (cap && cap.free === 0) {
    // There IS work and none of it may be handed out yet. The default wording
    // below orders the run to dispatch now, which under a full cap is an order
    // to do the thing that killed the 2026-09-07 wave — so the reason has to
    // name capacity rather than work. Placed after the left-behind branch: if
    // everything remaining is work its own phase shipped without, no wave would
    // be built from it and capacity is not what the run is waiting for.
    //
    // Still `fixpoint: NO`, and that is the point: the round is not over. The
    // stop gate reads the same file, so it keeps blocking — correctly, because
    // the remainder is taken on the next round.
    lines.push(cap.max === 0
      // `max: 0` is the unreadable-policy answer, and it needs its OWN sentence:
      // there are no agents out to collect and recomputing changes nothing, so
      // the wording below would order the loop to spin. This is the one
      // not-a-fixpoint whose remedy is a PERSON's — the same shape as a
      // `human_checkpoint`, and it must read that way or the run retries it
      // every round for as long as the file stays broken.
      ? `fixpoint: NO — ${front.actionable_count} item(s) are actionable but NOTHING may be dispatched: `
        + 'no policy is in effect, because the project\'s `.planning/config.json` does not parse. '
        + 'This is not a round to retry — no agent is out to collect and recomputing changes nothing. '
        + 'A person fixes the file; until then every mutation refuses.'
      : `fixpoint: NO — ${front.actionable_count} item(s) are actionable but capacity is full `
        + `(${cap.max} agent(s) allowed, ${cap.in_flight} in flight): this run is waiting on CAPACITY, not on work. `
        + 'Do NOT dispatch past the cap and do NOT call this an ending — collect the agents that are out, '
        + 'then recompute and take the remainder.');
  } else {
    lines.push(
      `fixpoint: NO — ${front.actionable_count} item(s) are actionable RIGHT NOW` +
      `${capBinds ? `, but only ${cap.free} may be dispatched this round (see the capacity line)` : ''}. ` +
      'Ending the run here is a defect ' +
      '(deliver.md Principle). Do not block on `gh pr checks --watch` while this list is non-empty.'
    );
  }
  return lines;
}

module.exports = {
  computeFront, formatFront, ciEstimates, needsHuman, checkpointParentOf, noCiHold, NO_CI_WHY,
  // Shared with state-sync.cjs, which BUILDS the `epics` records computeFront
  // reads: one key function, so a phase's epic cannot be filed under one name
  // and looked up under another.
  epicKey,
  // Shared with sentinel.cjs for the same reason as everything above it: the
  // board must never offer what the guard refuses, and two texts for one rule is
  // how they came to disagree in the first place.
  reviewStandsAlone, REVIEW_STANDS_WHY, baseMoved, baseMergeWhy,
  // The cap's counting unit, exported so the test can hold it against
  // `pipeline-config.cjs`'s ROLES: a role with no cardinality would be counted
  // by the fallback and nothing would say so.
  AGENT_CARDINALITY, agentsInFlight,
  // The twin of stop-gate.cjs's journal-tail rule (see the section above for why
  // it is a copy and not an import), exported so its exclusions are pinned by a
  // test rather than by prose.
  movedSince, stateDerivedAt, behindWarning, JOURNAL_TAIL_BYTES,
};

// ── CLI: read the state files this project already has and print the verdict ──
if (require.main === module) {
  const fs = require('fs');
  const path = require('path');
  const root = process.cwd();
  const dir = path.join(root, '.planning', 'graph');
  const read = (f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
  let tickets = {};
  let state = {};
  try {
    tickets = (read('tickets.json') || {}).tickets || {};
    state = read('delivery-state.json');
  } catch (e) {
    process.stderr.write(`front: cannot read .planning/graph (${e.message}) — run state-sync.cjs first\n`);
    process.exit(1);
  }
  const argv = process.argv.slice(2);
  const pIdx = argv.indexOf('--parked');
  const parked = pIdx === -1 ? [] : String(argv[pIdx + 1] || '').split(',').map((s) => s.trim()).filter(Boolean);
  // auto_merge decides whether an unmerged green PR is the sentinel's work or a
  // human's, so the standalone CLI has to read it too (state-sync passes it in).
  const { loadConfig } = require(path.join(__dirname, 'pipeline-config.cjs'));
  const { config, valid } = loadConfig(root);
  const autoMerge = config.auto_merge === 'epic' && config.integration_mode === 'epic-stacked';
  // Passed explicitly here because this CLI has already paid for the config —
  // computeFront's own lazy fallback serves the callers that have not.
  const mergeWithoutCi = config.merge_without_ci === true;
  // The concurrency cap, same reasoning — but only when the file PARSES. An
  // invalid config authorizes no dispatch at all, and that answer is
  // computeFront's to give (it resolves the same 0); passing the populated
  // default from here would talk the cap out of it.
  const maxConcurrentAgents = valid ? config.max_concurrent_agents : undefined;
  // The durable parks — drift verdicts and escalations — must be read here too.
  // deliver.md advertises this CLI as "re-runnable on its own", and it silently
  // was not equivalent: state-sync passed both in, so the same graph produced two
  // different verdicts depending on which command you ran. A ticket parked as
  // drifted read back as `execute` — the exact re-offering drift-record exists
  // to stop.
  const { activeDrift } = require(path.join(__dirname, 'drift-record.cjs'));
  // The RECORDS, not the flat view: the board's lifting sentence is chosen by the
  // park's kind, and the flat map keeps the kind only as a text prefix.
  const { activeParks } = require(path.join(__dirname, 'escalation-record.cjs'));
  const front = computeFront(tickets, state, {
    parked, autoMerge, mergeWithoutCi, maxConcurrentAgents,
    drifted: activeDrift(root), escalated: activeParks(root, state),
    // Same reason as the two stores above: this CLI is advertised as re-runnable
    // on its own, and a board that re-offers a ticket an agent is holding is not
    // the same board.
    dispatched: activeDispatches(root, state),
    // …and the ORDER has the same requirement as the verdict: state-sync derives
    // this from the journal, so the CLI must too, or the two commands rank the
    // same graph differently.
    ci_estimates: ciEstimates(dir, tickets),
  });
  // Does the journal prove this cached state is already behind reality? Computed
  // HERE rather than in computeFront, which is a pure function of what it is
  // handed and must stay one. `--json` carries the same finding as a field, so a
  // machine reader cannot miss what a human is shown.
  const behind = behindWarning(dir);
  if (behind) front.behind = behind;
  if (argv.includes('--json')) {
    process.stdout.write(JSON.stringify(front, null, 2) + '\n');
  } else {
    for (const line of formatFront(front)) console.log(line);
  }
  process.exit(0);
}
