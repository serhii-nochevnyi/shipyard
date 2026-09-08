'use strict';

// "WHAT IS THIS TICKET'S PARENT DOING TO ITS BASE?" — in ONE home, for every
// reader. Two questions, one subject: is the parent still MOVING (its PR open,
// so this branch's base is about to change under it), and has it already moved
// so far that the base is a LIMB (the parent merged, its branch left behind).
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

// ── the LIMB base, in the same ONE home, for the same reason ────────────────
//
// A parent that has already MERGED is not moving — but the branch it merged from
// usually still exists (`deleteBranchOnMerge=false`), and a child whose PR still
// literally targets it is stacked on a LIMB rather than on the stack: the
// parent's content is in the epic, so a squash landing on that branch goes
// nowhere and the work is stranded. That is PR #52's shape, and it was measured
// in a real phase — the epic did not contain the work while every board printed
// `merged`.
//
// WHY IT LIVES HERE and not in sentinel.cjs, where it was born: the merge gate
// learned to refuse this and the BOARD never learned it, so `computeFront` kept
// answering `actionable.merge` for the very ticket `mergeOne` declined every
// round — the "front offers what the guard refuses" pathology that this whole
// module exists to make structurally impossible. One predicate, three readers:
// the duty chain, the merge gate, and the board.
//
// WHY `base` IS A PARAMETER rather than read off the state entry: the two
// callers do not measure the same base and must not be made to. `dutyItems` and
// `computeFront` ask about the base the BOARD holds (`pr_base || base`), while
// `mergeOne` asks about `pr.baseRefName` from the live `gh pr view` — the whole
// point of that path being a re-verification.
//
// Read off the BOARD for the parent's status, and that is sound rather than
// convenient: `merged` is TERMINAL, so a cached read can only be stale in the
// direction "it has merged since", never "it has not merged after all" — there
// is no false refusal to pay for.
function limbBaseOf(id, base, ctx = {}) {
  const { tickets, state } = ctx;
  if (!base) return null;
  const s = ((state || {})[id]) || {};
  const repo = s.repo || null;
  const entry = Object.entries(tickets || {}).find(
    ([tid, o]) => tid !== id && (o.repo || null) === repo && o.branch === base
  );
  if (!entry) return null;
  const [baseId] = entry;
  return (((state || {})[baseId] || {}).status === 'merged') ? baseId : null;
}

// The sentence both readers print. Shared for the same reason the predicate is:
// a remedy the guard states and the board paraphrases is two remedies, and the
// operator has to guess which one is current. It names the retarget AND the
// base-merge, because either alone leaves the branch wrong.
function limbRemedy(id, base, limbId, ctx = {}) {
  const { tickets, state } = ctx;
  const s = ((state || {})[id]) || {};
  const t = ((tickets || {})[id]) || {};
  const repo = s.repo || null;
  const epicOf = s.epic || t.epic;
  return `base "${base}" is ${limbId}, whose ticket is already MERGED — the branch survives the squash but ` +
    `its content is in ${epicOf || 'the epic'}, so landing here would strand this work on a limb nothing merges ` +
    `onward (PR #52). Retarget it${epicOf ? ` onto ${epicOf}` : ''} and bring the base in, then it lands: ` +
    `\`gh pr edit ${s.pr}${repo ? ` --repo ${repo}` : ''}${epicOf ? ` --base ${epicOf}` : ' --base <epic>'}\`, ` +
    `then \`base-merge.cjs ${id} --worktree <p> --base ${epicOf || '<epic>'}\`, push.`;
}

module.exports = { movingParentOf, parentIsMoving, movingParentWhy, limbBaseOf, limbRemedy };
