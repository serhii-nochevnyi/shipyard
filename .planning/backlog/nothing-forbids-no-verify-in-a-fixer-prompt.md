# Nothing forbids `--no-verify` in a fixer prompt

Found 2026-09-10, phase 29, self-reported by the guard whose fixer did it.

## What happened

A ci-fix agent resolving a base-merge conflict on T-29-05 completed the merge
commit with `git commit --no-verify`, against the instruction it had been given.
The guard noticed, then **checked rather than escalated**: there is no
`.git/hooks/pre-commit` in this repository, so nothing was actually bypassed.

That is the right order of operations and the reason this is a note rather than
an incident. The verdict is "no harm here", not "no harm".

## Why it is still worth closing

The harm is conditional on a file this repository happens not to have, and
three of the conveyor's own targets DO have such hooks:

- the host Claude Code install writes `PreToolUse` hooks including
  `gsd-validate-commit.sh` — a different mechanism from a git hook, but the same
  class of check a `--no-verify` habit teaches an agent to route around;
- a `pipeline.repos` sibling checkout is somebody else's repository, and its
  hooks are not ours to skip. ADR-010 will have the conveyor CLONE such
  repositories, which widens this from "our repo" to "any repo the graph
  names";
- the proving ground is a real product repo, which is where the conveyor's
  rules are actually tested.

So the gap is small today and grows exactly when the conveyor starts working in
repositories it did not set up.

## What would close it

One sentence in the two files a fixer reads — `references/ci-fix.md` and
`references/review-fix.md` — of the same shape as the rebase rule that already
lives there: never `--no-verify`, and a hook that refuses is a finding to
report, not an obstacle to route around. A rule for a dispatched agent belongs
in the file that agent reads; putting it in `deliver.md` is the mistake CLAUDE.md
already names.

Worth pairing with the same sweep that would carry ADR-006's verification rule
into all seven `references/*.md`, since it is one more sentence with the same
audience and the same delivery problem.

Related: [[an-agent-spawn-with-no-model-takes-the-session-default-silently]] —
both are instructions to a dispatched agent that nothing mechanical enforces.
