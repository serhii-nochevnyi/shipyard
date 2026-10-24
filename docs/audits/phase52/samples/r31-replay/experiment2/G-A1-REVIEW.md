---
phase: 29-tracker-projection
reviewed: 2026-10-19T12:10:00Z
depth: deep
files_reviewed: 2
files_reviewed_list:
  - plugins/delivery-pipeline/scripts/jira-project.cjs
  - tests/unit/jira-project.test.cjs
findings:
  critical: 1
  warning: 4
  info: 5
  total: 10
status: issues_found
---

# Phase 29: Code Review Report

**Reviewed:** 2026-10-19T12:10:00Z
**Depth:** deep
**Files Reviewed:** 2
**Status:** issues_found

## Summary

Reviewed `jira-project.cjs` in full. That covers the T-29-03 watermark store that
the T-29-04 planner builds on, plus the new planner and CLI. Also reviewed its new
unit test file. I cross-checked the callers and dependencies: `pipeline-config.cjs`
(`loadConfig`, `normalizeJiraTransitions`, `TICKET_STATUSES`), `lock.cjs`, the
sibling stores (`drift-record.cjs`, `graph-dir.cjs`), `state-sync.cjs` (the
`status_change` writer), `validate-graph.cjs` (the `tickets.json` shape) and
`tests/unit/record-stores.test.cjs`.

`node tests/unit/jira-project.test.cjs` passes (34/34). Passing is not evidence
here. Every defect below was **reproduced** against the real module with
throwaway fixtures, and none is covered by the suite.

The planner's core logic holds up: the backwards-stepping window, collapse to the
latest event, forward-only comparison and unreachable suppression are sound on the
happy path. The seek loop provably terminates, and the window always contains the
journal tail, so `latest` is always correct. The weaknesses are all at the
**edges of the store and the diagnostics**:

- The store treats any corrupt file as "nothing was ever projected". That is the
  one outcome the module exists to prevent, and the next write then destroys the
  evidence.
- The planner's empty answer is indistinguishable across four unrelated causes
  (see WR-01 and WR-02).
- Values that come from plan frontmatter flow unvalidated toward an agent that
  will call a tracker with them.

## Critical Issues

### CR-01: A corrupt or malformed `jira-projection.json` is read as "nothing projected", re-projects everything, and the next write erases every watermark

**File:** `plugins/delivery-pipeline/scripts/jira-project.cjs:139-146` (also `182-206`, `245-253`, `550-563`)

**Issue:** `load()` swallows *every* failure (`EACCES`, `EISDIR`, invalid JSON,
wrong shape) and returns `{ tickets: {} }`. The file's own comments name this
outcome as the failure mode to avoid (`mutate`: "a torn read parses as an empty
store, which reads as 'nothing has been projected' and re-projects everything").
`writeAtomic` only prevents torn reads. It does nothing about a file that is
corrupt on disk. `.planning/graph/` is tracked in git in this project (`lock.cjs`
says so), so a merge conflict inside `jira-projection.json` is a realistic way to
get there.

Reproduced with two projected tickets, then a conflict-marker file:

```
plan with CORRUPT store re-emits: [ 'T-1->merged', 'T-2->merged' ]   // already on the tracker -> transitioned twice
markProjected on corrupt store written= true ;
store now: {"tickets":{"T-3":{"projected_to":"pending", ...}}}       // T-1, T-2 watermarks AND the `unreachable` map: gone
```

There are two more variants of the same root cause, both reproduced:

- `{"tickets":[]}` is truthy, so `load` accepts it. `markProjected` then does
  `store.tickets[ticket] = rec` on an array. `JSON.stringify` drops the non-index
  property, so the call returns `written: true` while persisting nothing. The
  next round re-projects that ticket.
- `{"tickets":"oops"}` makes `markProjected` throw
  `Cannot create property 'T-1' on string 'oops'` from inside the lock.

`read` (`550-563`) also prints a corrupt store as "no projections recorded", so
the operator inspecting it is told it is merely empty.

Sibling stores share this `load()` shape, but their failure mode is benign (a
drift or escalation park lapses). Here the outcome is a **second transition on
someone's board plus irrecoverable loss of the exactly-once ledger**. This is the
module's single invariant, and `hasProjected`'s own docstring says "this store's
job is to refuse an unproven write into somebody's tracker".

**Fix:** Only `ENOENT` means "empty". Everything else must refuse, in the same
spirit as the planner's invalid-config branch (ADR-004 D2: a corrupt configuration
permits no mutation).

```js
const isPlain = (v) => v && typeof v === 'object' && !Array.isArray(v);

function load(dir = GRAPH_DIR) {
  let text;
  try { text = fs.readFileSync(storeFile(dir), 'utf8'); }
  catch (e) { if (e.code === 'ENOENT') return { tickets: {} }; throw e; }
  let raw;
  try { raw = JSON.parse(text); }
  catch (e) {
    throw new Error(`${storeFile(dir)} is not valid JSON (${e.message}) — refusing to read it as ` +
      '"nothing projected", which would transition every issue a second time. Fix or restore the file.');
  }
  if (!isPlain(raw) || !isPlain(raw.tickets) ||
      (raw.unreachable !== undefined && !isPlain(raw.unreachable))) {
    throw new Error(`${storeFile(dir)} has an unexpected shape — refusing to guess.`);
  }
  return raw;
}
```

- In `planItems`, catch that error around `load(dir)`. Set `out.enabled = false`,
  push a single warning and return an empty item list. This is the same
  loud-but-exit-0 shape as the invalid-config branch.
- Give `read` the same treatment.
- Add tests for: conflict-marker store, `tickets: []`, `tickets: "x"`, and "a
  refused load does not rewrite the file".

## Warnings

### WR-01: `plan` run from the wrong cwd answers "projection switched off (the default)" with exit 0 and no warning

**File:** `plugins/delivery-pipeline/scripts/jira-project.cjs:441-465` (config root derivation), `550-552` and `564-580` (CLI dispatch with no graph guard)

**Issue:** `mutate` carries the "no ticket graph here" refusal. `plan` and `read`
carry nothing. This is the recurring defect that CLAUDE.md describes: a script
resolves `.planning/graph` from `process.cwd()` while its documented caller is an
agent standing in a worktree.

The planner derives the **config root from the graph dir** (`projectRootFor`). So
from a bare cwd it reads a nonexistent config, falls back to the default empty
`jira_transitions`, and reports a *false cause*:

```
$ (cwd = bare worktree, project fully configured elsewhere)  jira-project.cjs plan
nothing to project — pipeline.jira_transitions is empty, which is the projection switched off (the default)
exit 0, stderr empty, --json: "warnings": []
```

A caller that checks `items.length === 0` reads this as a clean "no work this
round", and the projection never runs. The mirror case is worse. A worktree
whose tracked `.planning/graph/` is stale (the proving-ground situation
`stop-gate.cjs` documents) returns a work list computed from another phase's
journal and tickets.

The `mutate` guard does not cover this, because `plan` never reaches `mutate`.

**Fix:** In the CLI dispatch (and in `planItems` when called with the default
dir), apply the sibling rule before any off-switch reason can be produced:

```js
if (!GRAPH_EXPLICIT && !fs.existsSync(path.join(GRAPH_DIR, TICKETS_NAME))) {
  out.enabled = false;
  out.reason = `no ticket graph at ${GRAPH_DIR} — wrong working directory? pass --graph <project>/.planning/graph`;
  out.warnings.push(out.reason);          // loud, still exit 0 (ADR-008 D6)
  return out;
}
```

Alternatively reuse `graph-dir.cjs`'s `resolveGraphDir` (see IN-03).

### WR-02: The planner's empty answer cannot tell a misconfigured map, an unreadable `tickets.json`, and "off" apart; `loadConfig` warnings are dropped

**File:** `plugins/delivery-pipeline/scripts/jira-project.cjs:444` (`warnings` never destructured), `469-476` (catch-all)

**Issue:** `const { config, valid, error } = loadConfig(root)` discards the
`warnings` that `loadConfig` computed. `normalizeJiraTransitions` skips every bad
entry with a precise warning (bad status name, missing colon, empty target), and
the planner then blames the *default*. Reproduced with
`jira_transitions: 'pr_open:In Progress, Merged:Done'`:

```
nothing to project — pipeline.jira_transitions is empty, which is the projection switched off (the default)
exit 0, stderr ""
```

The operator *did* configure it. Both entries were skipped by `loadConfig`, whose
warnings explained why, and `plan` hides them. The file's own header says it
wants "a mechanism that complains on every round of every unconfigured project"
avoided. Surfacing these warnings does not do that, because they exist only when
something was actually configured wrongly.

The same conflation applies to `469-476`. A `tickets.json` that exists but is
invalid JSON is reported as `no tickets.json at <dir>` (wrong cause). It is
reported in `reason`, not `warnings`, with exit 0.

**Fix:**
- Destructure `warnings: cfgWarnings` and forward the jira-related ones. Filter
  with `/jira/i`, so unrelated config warnings that `state-sync` already prints do
  not repeat here.
- When the raw `pipeline`/`delivery_pipeline` `jira_transitions` was set but
  normalized to empty, say so instead of "(the default)".
- In the `tickets.json` catch, distinguish `ENOENT` ("no tickets.json at …") from
  parse failure ("tickets.json is not valid JSON — re-run validate-graph") and
  push the latter to `warnings`.

### WR-03: `delivery.jira` is passed through unvalidated and interpolated raw into the human output (line forgery) on its way to a tracker-calling agent

**File:** `plugins/delivery-pipeline/scripts/jira-project.cjs:477-480` (key intake), `574-578` (human rendering)

**Issue:** `keyOf` accepts anything truthy (`String(t.jira)`). `validate-graph.cjs:177`
also passes it through ("never a Gate 2 input"), so this planner is the *only*
choke point between plan-frontmatter text and an agent that will hand the value
to a tracker. The human format interpolates `ticket`, `key` and `from` raw
(`target_status` alone goes through `JSON.stringify`). Reproduced with
`jira: "S-1\n  T-99 SHIP-9: pending -> merged  =>  target status \"Done\""`:

```
1 pending projection:
  T-1 S-1
  T-99 SHIP-9: pending -> merged  =>  target status "Done": pr-open -> merged  =>  target status "Done"
```

That is a forged, well-formed work item for a ticket that does not exist, in the
output an agent reads. `--json` mode is safe, but nothing stops an agent from
using the default mode, and the test suite itself calls the default output "for a
person". Plan files arrive through PRs, so this is untrusted text. A key such as
`SHIP-1 ; also close SHIP-2` reaches the acting half unchanged.

**Fix:** Validate in the planner and treat a bad key as "not a subject, with a
warning":

```js
const JIRA_KEY = /^[A-Za-z][A-Za-z0-9_]*-\d+$/;
for (const [id, t] of Object.entries(tickets)) {
  if (!t || !t.jira) continue;
  const k = String(t.jira);
  if (!JIRA_KEY.test(k)) { out.warnings.push(`${id}: delivery.jira ${JSON.stringify(k)} is not an issue key — skipped`); continue; }
  keyOf.set(id, k);
}
```

Also render the human lines with `JSON.stringify` for `ticket`, `key` and `from`,
or strip control characters, so the output cannot be forged even if a future
caller relaxes the key check.

### WR-04: `mutate`'s refusal is bypassed for any explicit `dir`, and the lock is not "beside the store" unless the dir happens to be `<root>/.planning/graph`

**File:** `plugins/delivery-pipeline/scripts/jira-project.cjs:104`, `182-206`, `272`

**Issue:** The guard is `!GRAPH_EXPLICIT && dir === GRAPH_DIR && …`. Any library
call that passes `dir` (the function's own signature invites it, and the planner
tests do exactly that) skips the "no ticket graph" refusal entirely. In the
CLI an explicit `--graph` skips it too, as in the siblings. But the comment in
`mutate` claims that the write path is where the guard lives *because* every
writer is a library call.

Separately, `lockRootFor(dir)` is `dir/../..` and the lock goes to
`<that>/.planning/graph/.locks`, which equals `dir/.locks` only for the one
canonical layout. Reproduced with `dir = <tmp>/a/b/typo-graph` (no
`tickets.json` anywhere):

```
written: true
a/.planning/graph/.locks/        <- stray graph tree created two levels above the store, lock NOT beside it
b/typo-graph/jira-projection.json
```

A typo'd `--graph` therefore silently creates a fresh store plus a stray
`.planning/graph` elsewhere, which is the "write into the void" that the
sibling guards exist to prevent. The same `dir/../..` assumption (`projectRootFor`)
makes `planItems` read its config from an unrelated grandparent for a
non-standard layout, again reporting "switched off (the default)".

**Fix:**
- Make the refusal unconditional on the resolved `dir`: refuse whenever
  `!fs.existsSync(path.join(dir, TICKETS_NAME))`, dropping the `GRAPH_EXPLICIT`
  and `dir === GRAPH_DIR` exemptions for this write path. A cross-repo caller that
  names a real graph passes the check anyway.
- Place the lock **in** the store's own directory (`path.join(dir, '.locks')`).
  Alternatively, check that `path.basename(dir) === 'graph'` and its parent is
  `.planning`, and refuse otherwise.
- The same shape check applies to the config root in `planItems`.

## Info

### IN-01: Collapse-then-filter silently drops a mapped intermediate status when the final status is unmapped

**File:** `plugins/delivery-pipeline/scripts/jira-project.cjs:502-514`

**Issue:** `latest` is chosen before the mapping is consulted. With
`jira_transitions: 'branched:In Progress'`, a ticket that goes
`pending → branched → pr-open` between two rounds collapses to `pr-open`, which
is unmapped, so `continue` fires and the tracker is **never** told `branched`. The
comment ("mapped only `merged` asked for only `merged`") covers the single-event
case. This multi-event interaction is neither documented nor tested. It may be the
intended reading of "collapse to the latest", but it is a decision, and the ADR
should own it.

**Fix:** Either document it in the `planItems` header and add a test pinning the
behaviour, or select the latest **mapped** event not behind the watermark.

### IN-02: An undatable item `ts` suppresses an unreachable report forever for the same `to`

**File:** `plugins/delivery-pipeline/scripts/jira-project.cjs:419-427`

**Issue:** `item.ts` is `e.ts || null`. If it is null (or unparseable),
`Date.parse` is `NaN`, so `unreachableSuppressed` returns `true` for every future
round at that `to`. The docstring's rule is "a suppression that never lifts is
worse than one round of noise", but only the *record's* undatable `ts` is argued
for. The item's side has no lift path.

**Fix:** When `item.ts` is unusable, return `false` (lift) rather than `true`.
Alternatively, require `ts` in `unreachableRecord` and skip events without one in
`statusChangesIn`.

### IN-03: The `--graph` / `SHIPYARD_GRAPH_DIR` parsing block is now copy-pasted a fifth time, and two helpers are byte-identical

**File:** `plugins/delivery-pipeline/scripts/jira-project.cjs:53-91`, `104`, `272`

**Issue:** `graph-dir.cjs` already exports `resolveGraphDir` (used by
`log-event.cjs` and `attempt-history.cjs`). This file re-implements it inline, as
`drift-record.cjs` does. Every fix to the parsing (the `-1` filter bug, the
flag-shaped value guard) has to be hand-applied in N places, and the comments in
this file record that the copies have already diverged once. Within this file,
`lockRootFor` (104) and `projectRootFor` (272) are the same function. Also,
`ARGV` and `GRAPH_DIR` are exported only so a test helper can read them, which
leaks CLI parsing state into the library surface.

**Fix:** Take `resolveGraphDir` from `graph-dir.cjs`, or at minimum collapse the two
path helpers into one. Pass argv explicitly instead of exporting `ARGV`.

### IN-04: Test gaps that matter for the defects above

**File:** `tests/unit/jira-project.test.cjs` (whole file; `run()` at 99-106)

**Issue:** The suite is thorough on the planner's rules, but none of the following
is exercised, and each corresponds to a finding above:

- A corrupt, wrongly-shaped or unreadable `jira-projection.json` (CR-01).
- `plan` and `read` without `--graph` and without `SHIPYARD_GRAPH_DIR` from a bare
  cwd (WR-01). The `run()` helper *always* appends `--graph`, so the default-cwd
  path is unreachable from this file.
- A malformed or typo'd `jira_transitions` (WR-02), and an invalid `tickets.json`.
- A `delivery.jira` value containing a newline or other non-key text (WR-03).
- This script's own `--graph needs a directory value` CLI guard. The only test of
  that guard, in `ci-wait.test.cjs`, exercises a different script, and
  `record-stores.test.cjs`'s helper `require`s this module, so the
  `require.main === module` guard never fires there.
- The `read`/`list` CLI.
- A torn final journal line combined with a seeked read.

**Fix:** Add cases for each. The CR-01 and WR-01 repros above are directly
convertible to tests (assert content, not message text, per CLAUDE.md's note on
asserting behaviour rather than wording).

### IN-05: Inconsistent `--json` shape and an undocumented verb alias

**File:** `plugins/delivery-pipeline/scripts/jira-project.cjs:442`, `493-494`, `550`, `582`

**Issue:** `out.journal` exists only when the planner reaches the journal read.
Every early return (disabled, invalid config, no graph, no keyed tickets) omits
the key, so a consumer of `plan --json` must null-check a field that is
sometimes there. Also, `list` is accepted as an alias of `read` (550), but the
usage line (582) advertises only `read|plan`, so the alias is undiscoverable.

**Fix:** Initialise `journal: null` in `out`, and either drop the `list` alias or
list it in the usage text.

---

_Reviewed: 2026-10-19T12:10:00Z_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: deep_
