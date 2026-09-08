# The gsd-core pin has eleven sites; the new guard knows five — and two of them should not exist

**Found:** 2026-09-08 by `arch-review` on PR #59 (T-25-06), which inventoried the
literal rather than accepting the ticket's own count.
**Scope:** none of the current tickets. T-25-06 is `conform` and merged; this is
the follow-up it names, corrected.

## What T-25-06 shipped, and what it left

T-25-06 added a `docs-smoke.sh` assertion that the **build** pin agrees across
five homes (`Dockerfile`, `Makefile`, `docker-compose.yml`, `.env.example`,
`tests/smoke/codex-shipyard-smoke.sh`), comparing them against EACH OTHER so
there is no literal to bump. Its executor found a sixth home —
`scripts/install-shipyard-capability.sh:28-29`, HINT strings naming
`@opengsd/gsd-core@1.7.0` — and deliberately left it out, on the grounds that
the guard would then go red on a file the ticket may not touch.

**That judgement was right** (a defect in an undeclared file is a follow-up, and
a guard blocking the epic's own release blocker on unrelated work would be
worse), **and the follow-up it named was wrong.** The reviewer's inventory:

> **eleven sites across eight files** — the five build homes, plus six spelled
> `gsd-core@<semver>`: `README.md:312`, `README.md:487`, the spec doc `:3` and
> `:894` (all four at 1.13.0, moved by hand this phase), and the two installer
> HINTs at 1.7.0.

So the guard's own comment — "the pin lives in five files" — is true of the
build pin and false as an inventory.

## The fix, in two steps and in this order

1. **Remove the home rather than add it to the list.**
   `install-shipyard-capability.sh` should hold NO version literal at all:
   `ensure-gsd-core.sh:127`, `install-shipyard-codex.sh:59` and
   `gen-codex-shipyard.cjs:64` all print `@latest` by deliberate design, and
   `CLAUDE.md` states the reason — a superstructure that pins its base rots
   against it. Change both HINTs to `latest`.
2. **Then a SWEEP, not a longer list.** Extract the pin from `Dockerfile` and
   assert that every tracked `gsd-core@<semver>` equals it, excluding
   `.planning/` (planning records quote historical values on purpose) and the
   spec document's historical §10.5 heading. A list of homes has to be edited
   whenever a home is added, which is the same failure the pin itself had.

## Four blind classes in the guard as shipped

The reviewer ran twelve mutants, nine of them ones the executor had not tried;
seven bite. Notably **a ninth role added to `ROLES` with the doc untouched
FAILS** — the rule-owner/file-owner seam that caused this whole ticket, now
closed from the code side. What still passes:

1. **`head -1` versus last-wins — the most real of the four.** A duplicate
   `ARG GSD_CORE_VERSION=1.7.0` in `Dockerfile`, or a trailing duplicate in
   `.env.example`, leaves the guard green while the EFFECTIVE value is the later
   one. Fix: fail when a file yields more than one match, rather than taking the
   first.
2. **The `EXEMPT:` reasons are unguarded** — replacing `drift-check`'s reason
   with `(no reason given)` passes. The reason is the half that stops the next
   reader deleting the row, so it is worth asserting non-empty.
3. **A contradictory duplicate row passes**: `find` takes the first match and
   the reverse check only tests membership.
4. **The escalation prose is unchecked** — moving `xhigh` from
   `--type alternatives` to `--type facts` passes, because only the table rows
   are compared against the resolver.

Each was verified by `git diff` to have actually landed before the run, so none
is a mutant that silently failed to apply.

## One thing worth keeping from the same review

The `config-free temp cwd` in the table assertion is **load-bearing, not
defensive**, and the reviewer nearly called it stale by measuring `main` (where
`782647a` had dropped the keys) instead of the epic head — which still carries
`pipeline.models.arch-review/.integrator: "opus"` and where those keys still
shadow D4's ceiling. It reproduced the PR #57 warning verbatim to confirm.
`pipeline-config.cjs` reads `<cwd>/.planning/config.json` and nothing else — no
`homedir`, no `~/.gsd/defaults.json`, no env, no walk-up — so a check run in the
project would document this checkout's tuning rather than the shipped policy.
