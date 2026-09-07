'use strict';

// "IS THIS TICKET'S PARENT STILL MOVING?" — in ONE home, for both readers.
//
// The board must never offer what the guard refuses. `checkpointParentOf` (in
// front.cjs) already holds one half of that rule from a single definition; this
// is the OTHER shared test, and until now it existed only inside sentinel.cjs.
// The guard has answered `wait-parent` for a child stacked on an open parent
// since it was written, while `computeFront` had no such bucket — so the same
// ticket read as `fix`/`finalize`/`merge` on the board. The main loop dispatched
// nothing (those buckets are the guard's), the guard declined the work the board
// offered, `ci-wait.cjs` refused because something was "actionable", and the stop
// gate blocked over it. Round after round, on a real phase.
//
// WHY A MODULE OF ITS OWN rather than a second export from front.cjs: sentinel.cjs
// already imports front.cjs, and front.cjs must import this. Putting the predicate
// in front.cjs would work today and invert the moment anything here needs a fact
// front.cjs derives. One direction, no cycle: front → parent-moving,
// sentinel → { front, parent-moving }.
//
// WHY ANYTHING IS "MOVING" AT ALL. Work done on a child whose parent is still
// open is provisional: when the parent lands, this branch's base moves, CI re-runs
// against different code and reviewers re-read a changed diff. So a green reached
// now is a green that has to be reached again. Ordering the stack is not tidiness,
// it is the difference between paying for CI once and paying twice.

// Accepts a Set, an array, or nothing. The guard's parked set is
// `--parked` ∪ escalations ∪ drift verdicts; `computeFront` builds the same union
// from its own opts. A caller that passes NOTHING gets the un-parked answer,
// which is the honest default for a caller that tracks no parks.
function isParked(parked, id) {
  if (!parked) return false;
  if (typeof parked.has === 'function') return parked.has(id);
  if (Array.isArray(parked)) return parked.includes(id);
  return false;
}

// The parent ticket's id when this ticket is stacked on a parent that is still
// being driven, else null. The four ways a parent is NOT moving:
//
//   * there is no parent — the ticket is a root, its base is the epic;
//   * the parent's PR is not open — merged (the base already moved) or not yet
//     published (nothing to wait for);
//   * the parent is PARKED — nobody is driving it, so waiting behind it would
//     freeze this subtree for as long as the park lasts;
//   * the parent is a `human_checkpoint`. Deliberately `human_checkpoint` and
//     NOT `needsHuman`: this exception is about driving a child to GREEN, and
//     narrowing it to un-authorized parents would make the guard answer
//     `wait-parent` for a red child of a pre-authorized parent while the board
//     answers `fix` — inventing the very disagreement one shared predicate
//     exists to remove. The MERGE-side hold on a checkpoint parent is a separate
//     rule, enforced by `checkpointParentOf` in front.cjs and by
//     `sentinel.cjs merge`, and it is not relaxed by anything here.
function movingParentOf(id, ctx = {}) {
  const { tickets, state, parked } = ctx;
  const parent = ((tickets && tickets[id]) || {}).primary_parent;
  if (!parent) return null;
  const ps = (state || {})[parent];
  if (!ps || ps.status !== 'pr-open') return null;
  if (isParked(parked, parent)) return null;
  if (((tickets && tickets[parent]) || {}).human_checkpoint) return null;
  return parent;
}

// The predicate the guard asks. Same answer, no id — kept as its own export so
// neither caller has to spell the `!== null` and risk spelling it differently.
function parentIsMoving(id, ctx = {}) {
  return movingParentOf(id, ctx) !== null;
}

// What that parent is DOING, for the board's reason line. Placement is a
// predicate's job; the sentence is not — but "stacked on P" with no verb makes a
// reader open GitHub to find out whether anyone is driving it.
function movingParentWhy(parent, state) {
  const ps = (state || {})[parent] || {};
  const c = ps.checks || {};
  const pr = ps.pr ? `PR #${ps.pr}` : 'its PR';
  if ((c.failing || 0) > 0) return `${parent} (${pr}: ${c.failing} failing check(s))`;
  if ((c.pending || 0) > 0) return `${parent} (${pr}: ${c.pending} check(s) still running)`;
  if (ps.draft) return `${parent} (${pr}: still a draft)`;
  return `${parent} (${pr}: open, checks reported green)`;
}

module.exports = { movingParentOf, parentIsMoving, movingParentWhy };
