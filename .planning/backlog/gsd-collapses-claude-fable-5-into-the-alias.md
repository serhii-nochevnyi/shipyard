# GSD normalises `claude-fable-5` into the `fable` alias, which now means 5.1

**Found:** 2026-09-07, reviewing why Fable was 53% of this project's model bill.
**Scope:** upstream — the code is gsd-core's, not this repository's. Recorded
here because the conveyor's own policy reaches GSD through exactly this path.

## What it is

`~/.claude/gsd-core/bin/lib/model-resolver.cjs` line ~137 builds
`CLAUDE_POLICY_ID_TO_ALIAS` by reversing `MODEL_ALIAS_MAP` (the catalog's Claude
tier defaults), and then adds one entry by hand:

    'claude-fable-5': 'fable',

The comment above it says why the hand-written entry exists: `fable` is accepted
by Claude Code's Agent tool but is not a GSD model-profile tier, so it cannot
come from the catalog.

The consequence is that an explicit full id is collapsed into an alias, and the
alias no longer means what the id said. On Claude Code ≥ 2.1.255 `fable`
resolves to **Fable 5.1**; below it, to Fable 5. So a policy that names
`claude-fable-5` — the id, chosen precisely because it pins a version — gets
5.1 on any current CLI, silently.

`claude-fable-5-1` is not in the map at all, so it is not normalised and would
reach the Agent tool as a full id, which that tool's enum rejects
(`opus|sonnet|haiku|fable`). The two Fable versions are therefore handled by
two different code paths, neither of which preserves the version the caller
asked for.

## Why it matters here

It is the same shape as the conveyor's own findings: a decision taken from a
NORMALISED value rather than from what was written. And the direction is
expensive — Fable is $10/$50 per MTok against Opus 5's $5/$25, and this
project's cumulative accounting puts `claude-fable-5-1` at $125 of $237.

## Shape of the fix (upstream)

Either keep the id when one is given (do not reverse-map an id the Agent tool
would have to receive as an alias — resolve the version at the boundary that
knows the CLI version), or refuse a version-pinning id with a message naming
`ANTHROPIC_DEFAULT_FABLE_MODEL` as the mechanism that actually pins it. A silent
version substitution is the one outcome that should not survive.

Worth reporting to gsd-core rather than working around: nothing in this
repository can make the map honest, and a local shim would be a second place
where the version is decided.
