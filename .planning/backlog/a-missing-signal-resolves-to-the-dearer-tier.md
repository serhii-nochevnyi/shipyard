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
