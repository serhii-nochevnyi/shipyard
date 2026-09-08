# A missing routing signal silently resolves to the more expensive tier

**Found:** 2026-09-07, dispatching T-26-14 during the phase 24/25/26 run.
**Scope:** none of the current tickets — `pipeline-config.cjs` is declared by
T-25-02, T-25-03, T-25-04 and T-26-02, all of them blocked behind epics, so
this has no owner today.

## What happened

The executor ladder's light path is `risk === 'low' && (type === 'research' ||
Number(signals.files) <= 2)`. `Number(undefined)` is `NaN`, and `NaN <= 2` is
false, so a caller that omits `--files` never takes the light path and always
gets `opus`.

Measured on the ticket that exposed it — T-26-14, risk `low`, two files:

    model executor --risk low --type implementation            → opus / xhigh
    model executor --risk low --type implementation --files 2  → sonnet / high

The orchestrator's own dispatch command lost the argument to a shell-quoting
slip and would have run the ticket two tiers up. Nothing reported anything: the
resolver answered confidently, the answer was valid, and only a hand comparison
against the ladder caught it.

## Why it is the expensive class

It is the same shape as every finding in ADR-004: a decision taken from the
ABSENCE of a value rather than from the value. Here the absence resolves in the
costly direction and stays silent, which is the worst of the two, because
nothing about the run looks wrong. A wrong-cheap answer surfaces as a bad diff
that arch-review catches; a wrong-expensive one surfaces only on the bill.

`--risk` has the same shape (`signals.risk || 'medium'`), but its default is the
middle of the range rather than the top, so it fails less badly.

## Shape of the fix (unowned)

The resolver should distinguish "not supplied" from "supplied and large".
Either warn on a routing call that omits a signal the chosen role reads — the
same `⚠ config:` channel the config reader already uses, so it reaches the
board — or make `--files` required for `executor` and fail loudly without it.
Prefer the warning: a hard failure would break older callers, and the whole
point is that a silent wrong answer is worse than a noisy one.

Whoever picks it up should also check the CALLERS: `deliver.md` Step 3 tells the
loop to pass `--files <n>`, and nothing verifies it did. A contract that only
the caller can honour, with no check, is the class of rule this repository keeps
measuring itself skipping.

## The second instance, measured 2026-09-08 — `review-fix` and `--no-code-change`

The same shape, one role over: `ladderTier`'s `review-fix` branch reads
`signals.codeChange === false ? 'sonnet' : 'opus'`, and the CLI derives that
signal from `rest.includes('--no-code-change')` — so the flag's ABSENCE and an
explicit "yes, code changed" are the same value, and both buy the dearer tier.
The documented dispatch makes it optional in both places that name it
(`deliver.md:1085`, `references/pr-sentinel.md:133`, each written as
`[--no-code-change]`), so the cheap branch fires only when an operator
remembers a flag. Over 14 days of journal: 16 `review-fix` dispatches, and the
role has no other way down.

`executor`'s `--files` is the first instance and is worse, because there the
dispatch does not name the flag at all — `deliver.md:864` passes `--risk` and
`--type` only, so `Number(undefined) <= 2` is false on every ticket and the
`sonnet` path is unreachable by construction, not by forgetfulness.

**The rule this asks for, and it is ADR-004's own principle turned on the
ladder: a signal that is ABSENT must never resolve upward.** Three concrete
requirements for whoever takes it:

- every branch that reads a signal must distinguish absent from present-and-false
  (`codeChange: undefined` is not `codeChange: true`);
- the resolver warns on stderr when a role's cheap branch depended on a signal
  the caller did not pass — the same way unknown config keys warn today, so the
  gap is visible in a dispatch line rather than only in a bill;
- and the documented dispatch supplies every signal the ladder can read, since
  the ticket record already holds all of them (`files.length`, `risk`, `type`).

Measured consequence at the time of writing: of 173 role dispatches in the
journal, 69 resolve to the single dearest cell (`opus` + heavy effort), and two
of the three branches that exist to prevent exactly that are gated on signals
the documented dispatch never passes.
