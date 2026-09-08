# The epic-key NUL separator makes `state-sync.cjs` binary to every grep

**Found:** 2026-09-08, while reading the `reapable` rule.
**Introduced:** `35de683` (T-24-11), deliberately — this is not corruption.
**Scope:** none of the current tickets. T-26-03 and T-26-15 both touch this
file; do not smuggle it into either.

## What it is

`plugins/delivery-pipeline/scripts/state-sync.cjs:331`:

    const epicKey = (phase, repo) => `${phase}\0${repo || ''}`;

A NUL as a composite-key separator is a sound idiom — neither a phase name nor
an `owner/name` can contain one, so the key cannot collide. Nothing about the
runtime behaviour is wrong, and the file round-trips as valid UTF-8.

## Why it still costs something

One NUL byte at offset 17260 is enough for the whole file to be classified as
binary:

    file -I …/state-sync.cjs   → application/octet-stream; charset=binary
    grep -n "reapable" …       → "Binary file … matches"     (no line output)

So every grep over this file **silently degrades**: `grep -n` prints no lines,
and `grep -q` still succeeds — which means a contract assertion written as
`grep -q <phrase> state-sync.cjs` passes for the wrong reason, and one written
as `grep -c` or `grep -o` returns nothing at all. This repository asserts
exactly that way (`tests/smoke/docs-smoke.sh` is a grep contract, and
`sentinel-smoke.sh` greps script output), and this file is the busiest one in
the conveyor. It also breaks a human's own `grep` mid-investigation, which is
how it was found — the analysis it interrupted read `0 occurrences` for a
pattern the file plainly contains.

`grep -a` fixes any single call site and is the wrong fix: it has to be
remembered at every future call site, by everyone.

## Fix (unowned)

Make the separator printable while keeping the collision guarantee. A different
control byte does NOT help — `U+001F` (unit separator) and every other control
character trigger the same classification. Two that do:

- `JSON.stringify([phase, repo || ''])` as the key — unambiguous, printable,
  and self-documenting;
- or a two-character sequence illegal in both operands, e.g. `${phase}::${repo}`
  (a phase name is `NN-slug` and an `owner/name` contains no `::`).

Whichever is chosen, add the reason as a comment — the NUL was chosen for a
real property, and the replacement must be shown to keep it. A unit assertion
that no script contains byte 0x00 is the cheap regression guard, and it belongs
with the other file-level contracts in `tests/unit/files-contract.test.cjs`.

## Found in the same read, unrelated and equally small

The editor's own diagnostics report `state-sync.cjs:143` — `'ghTry' is declared
but its value is never read`. Dead binding on `main`, no behavioural effect,
and nothing in `make test-fast` lints for it. Worth removing by whoever next
opens the file for a declared reason.
