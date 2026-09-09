# The stop gate enforcing this session predates the fix for this exact case

Measured 2026-09-09, minutes after phase 27's epic landed on `main`, while
dispatching phase 28's first wave.

## What happened

Wave 1 of phase 28 has five roots and the cap is four. The front said so, in the
line T-26-12 and T-27-01 shipped for exactly this:

```
capacity: 4 agents, 4 in flight — 1 actionable item(s) wait for the next round
fixpoint: NO — 1 item(s) are actionable but capacity is full … this run is
waiting on CAPACITY, not on work. Do NOT dispatch past the cap …
```

The stop gate then blocked the turn with:

```
shipyard: the delivery front is not empty — 1 item(s) are actionable RIGHT NOW
(execute: T-28-08). Ending the run here is a defect, not a choice.
```

Two mechanisms reading one board, ordering opposite things — the precise
pathology ADR-006 D1 was written about and T-27-01 fixed.

## Why the fix could not help

`stop-gate.cjs` is installed by COPY, not by reference: the installer writes it
to `~/.claude/hooks/shipyard-stop-gate.cjs` because it must run with no plugin
resolution. CLAUDE.md says so and tells the operator to "re-run `make
install-shipyard-claude-hook` after an upgrade".

Measured:

```
installed: 379 lines    repo: 672 lines    (18342 byte diffs)
installed: capacityFull=0   capMax===0=0
repo:      capacityFull=4   capMax===0=1
```

The hook governing this session's every stop has NONE of the capacity logic. It
predates phase 27 entirely — arguably several phases.

## Why this is the sharpest instance of ADR-007's Family C

Family C was written about the installed Codex bundle: four scripts behind
`main`, `AGENT_CARDINALITY` absent, judgment agents on Terra, zero `-deep`
files. That is a runtime the operator invokes deliberately.

This is worse in one specific way: **the stale copy is the thing that enforces
the rule.** A stale conveyor script produces a worse decision; a stale stop gate
produces a wrong verdict about whether a decision may be made at all — and it
does so on every turn, invisibly, in the session that is delivering the fix.

It also completes a set. "A change is in force where the conveyor RUNS from, not
where its ticket merged" was measured three times in phase 27 (a worktree cut
from a stale local epic ref; a guard unable to run a `--base-tree` call the docs
had just prescribed; the installed Codex bundle). This is the fourth, and the
first where the stale copy sits in the enforcement path.

## What was done, and what was not

The gate was NOT switched off. `SHIPYARD_STOP_GATE=off` exists and using it to
get past a gate is what this repository's own notes warn produces an uninstalled
gate that enforces nothing. Instead T-28-08 was parked through
`state-sync --parked` — the honest channel, because the reason is real (the cap
is full) and genuinely session-scoped (it lifts the moment an agent returns and
the board is re-derived). The durable board then read `actionable=0`,
`capacity={"max":4,"in_flight":4,"free":0}`.

The hook was NOT reinstalled: `make install-shipyard-claude-hook` writes into
the operator's `~/.claude`, and that is theirs to run.

## The durable fix, which is not "remember to reinstall"

An installed copy with no version identity cannot be told it is stale. Options,
cheapest first:

1. **The hook reports its own provenance.** Stamp the installed copy with the
   version and commit it was generated from, and have `state-sync` (which
   already reads the plugin's own version) print a `⚠` line when the installed
   hook's stamp is behind. That turns a silent wrong verdict into a named
   warning, which is the same move as every other finding in this family.
2. **The hook becomes a thin shim.** A three-line file that locates the plugin's
   `stop-gate.cjs` and delegates. It cannot go stale, but it re-introduces the
   plugin-path resolution the copy exists to avoid, and CLAUDE.md records that
   the copy was deliberate — so this needs the original reason re-examined, not
   overruled.
3. **`make install-shipyard-claude-hook` runs from Step 0 of deliver** when the
   stamp is behind. Convenient and the most invasive: a delivery run writing to
   the operator's home directory is a new behaviour nobody asked for.

Option 1 is the one that matches this repository's habits: it does not decide
for the operator, and it makes the invisible case say its own name.
