# Phase 26 follow-ups

Surfaced while delivering phase 26, each out of the scope of the ticket that
found it. **Scope: none of phase 26's tickets** — do not smuggle any of these
into one; all three D2 gaps live in files absent from the finder's
`files_modified`, so the remedy would itself breach Gate 2.

## Three real ADR-004 D2 gaps, found by arch-review on PR #60 (T-26-02)

T-26-02 made an unparseable config permit no mutation across `sentinel.cjs`,
`ci-wait.cjs` and `state-sync.cjs`. Three other readers still take defaults
from a file that does not parse.

1. **`front.cjs`'s standalone CLI (line 1124) reads `auto_merge` off the
   defaults and discards `warnings`.** Demonstrated by the reviewer: a corrupt
   config gives `1 actionable — finalize: T-01-01, fixpoint: NO`, a valid `off`
   gives `0 actionable, waiting: merge (human), fixpoint: YES`, and a valid
   `epic` is **byte-identical to the corrupt answer**. So it offers a paid
   `finalize` dispatch — a fixer that pushes — with no warning at all.
   Severity is bounded and worth stating precisely: the DURABLE board and the
   stop gate are safe, because `delivery-front.json` is written by the gated
   `state-sync`. But `deliver.md:43` advertises `front.cjs` as "re-runnable on
   its own", so the ungated answer is reachable from documented usage — and this
   repo's own standing rule is that **the front must never offer what the guard
   refuses**.
2. **`gsd-tune --global`** reports `model_profile → "balanced" … mirrors
   pipeline.model_policy = "balanced"` off a corrupt file, and would `--apply`
   it. The values it picks are conservative; the **misattribution** is the
   defect — it tells the operator the file said something the file does not say.
   Project mode is already immune via its own hard-fail on the same file
   (reproduced), so this is the `--global` path only.
3. **`gen-codex-shipyard.cjs` (line 206)** bakes default tiers the same way.
   Install-time rather than a delivery mutation, so lowest of the three.

## Five constraints T-26-12's author needed and could not be told

Recorded because they arrived from PR #60's review while T-26-12's executor was
already running, and **a workflow's internal agent cannot be messaged** — I told
that reviewer I could reach the executor, which was wrong. Whoever reviews
T-26-12 should check all five; the third is load-bearing.

1. **Do not call `loadConfig` again.** `sentinel.cjs` already exposes
   module-level `CFG_VALID`, `CFG_ERROR` and a ready-made `CONFIG_REFUSAL`
   sentence. A second read can disagree with the first.
2. **`config` is ALWAYS populated with defaults, valid or not**, so reading
   `cfg.<knob>` without checking `valid` IS audit finding F03. And the other
   half: an ABSENT file is `valid: true, error: null, warnings: []`, so a cap
   must not refuse there. `error` is `{file (absolute), relative, message}`,
   and `null` exactly when valid.
3. **`dutySummary()` now returns EARLY on `!CFG_VALID` from a hand-written
   literal, and that literal is currently a strict superset of the normal
   return — it must stay one.** Any field the concurrency cap adds to the
   normal return (`cap`, `in_flight`, `capped`, …) must also be added to the
   early-return literal, or it is `undefined` on a corrupt config and the first
   consumer doing `d.cap.limit` throws a TypeError — exactly the
   crash-instead-of-refusal T-26-02 removed. Same for `formatDuty`, which now
   returns `[d.config_invalid]`, a single line, so any new text the cap prints
   is suppressed on an invalid config. That may be correct; it must be
   deliberate.
4. **`merge --all` selects via `ids = CFG_VALID ? dutyItems().filter(…) : []`.**
   Layer the cap filter AFTER that ternary, and never let a capped or refused
   selection collapse into a bare `results: []` — the top-level `refusal` field
   exists precisely because an empty array reads as "nothing is mergeable right
   now". A cap that suppresses a merge needs its own named field for the same
   reason.
5. **`ci-wait.cjs` is the template** for the fact/mutation split: count the
   fact, withhold the mutation, mark it `refused: true` and never as a failed
   write, and carry the reason on EVERY result rather than only the one where it
   came due.

## One process note worth keeping

The same review's closing line said the trailer was written before the write
had run. It turned out true, but it is the same shape this repository keeps
finding — **prose asserting a behaviour the code does not yet have.** Phrase it
as intent, or do the thing first and then describe it.

## Three more, from arch-review on PR #61 (T-26-12) — the first one bites next phase

1. **The capacity cap counts dispatch RECORDS, and the guard files one per
   guarded ticket while Step 4 spawns ONE agent.** `deliver.md:1129` marks a
   `pr-sentinel` record for every ticket on the guarded list, and
   `front.cjs:742` counts `Object.keys(dispatched)` over a role-blind
   `activeDispatches`. So a single guard holding four open PRs reports
   `in_flight: 4` → `free: 0` under the default `max_concurrent_agents: 4`, and
   **no executor launches until a PR merges.** That is the ordinary mid-phase
   board.
   It is not a violation and not a stall: the code implements the plan's
   mechanism sentence exactly ("live dispatch records of every role"), a
   `pr-sentinel` record lifts when its PR merges or its base moves, and the
   failure direction is safe. But the plan's INTENT sentence says the 2026-09-07
   incident "included **one**" guard, and the default 4 is a measurement of an
   EXECUTOR wave. **Decide the counting unit — records or agents — before a
   phase runs under this cap, or raise the number in the interim.** Collapsing N
   records to one agent is a counting fix, not the per-role weighting the plan
   put out of scope.
2. **The stop gate has no hatch for `capacity.max === 0`.**
   `state-sync.cjs:717` DEGRADES rather than refusing on an invalid config
   (`CFG_VALID && …`), so a `max: 0` board can reach the durable
   `delivery-front.json` — and `stop-gate.cjs` does not read `capacity`, so it
   would block a session that correctly cannot dispatch anything. Bounded by the
   refusal ledger and strictly better than the pre-T-26-02 behaviour, and the
   plan put the stop gate out of scope, so this is a follow-up rather than a
   defect of that ticket.
3. **Two comments in `tests/unit/front.test.cjs` now name the wrong caller.**
   They claim `state-sync.cjs:769` pins both `mergeWithoutCi` and
   `maxConcurrentAgents`; it passes **neither**. The pre-existing comment was
   accurate ("would be served by it"), so PR #61 introduced the drift.
   Behaviour is unaffected and the PR body itself gets it right — but this is
   the repository's own named recurring defect, prose asserting a behaviour the
   code does not have, and the whole fix is to name only the CLI in both places.

### Two corrections the same review made to what I had passed on

- **RED-on-base for T-26-12 is 17, not the 9 the executor reported.** Measured
  by extracting the epic via `git archive`, dropping the branch's two test files
  onto it and running: 13 failures in `front.test.cjs` (12 genuinely new plus
  the one flipped read-count pin) and 4 in `pipeline-config.test.cjs`. Prose
  arithmetic only — the TDD substance is stronger than was claimed, not weaker.
- **My own base-merge claim held STRONGER than I stated it.**
  `git diff --stat 8995137 bba2c63` is empty **across the whole tree**, not just
  in the one conflicted file, and `merge-base` with the epic IS the epic head.
  `8995137`'s parent is `77c0729` — T-26-02's pre-squash commit — so the branch
  already carried that work and the epic's squash of it is what produced the
  phantom twelve-file diff.

### One shared-rule defect worth its own line

Probing the cap's middle (which I had not done — I checked only the endpoints)
found two values silently accepted, and **both are inherited from the shared
numeric rule in `loadConfig`, not introduced by T-26-12** — `max_attempts`
behaves identically:

- `true` → `Number(true) === 1`, a silent cap of ONE agent with no warning;
- `4.5` / `0.5` → a fractional `free`, and `0.5` reads as "dispatch nothing"
  while `cap.free !== 0`, so the capacity fixpoint branch never fires.

One `Math.floor` plus a type check in the shared rule closes both, for every
numeric knob at once.
