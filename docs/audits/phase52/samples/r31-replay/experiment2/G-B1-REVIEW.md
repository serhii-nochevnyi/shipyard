---
phase: B1
reviewed: 2026-10-19T12:06:16Z
depth: deep
files_reviewed: 3
files_reviewed_list:
  - plugins/delivery-pipeline/scripts/jira-project.cjs
  - tests/unit/jira-project.test.cjs
  - plugins/delivery-pipeline/scripts/ci-wait.cjs
findings:
  critical: 1
  warning: 6
  info: 5
  total: 12
status: issues_found
---

# Phase B1: Code Review Report

**Reviewed:** 2026-10-19T12:06:16Z
**Depth:** deep
**Files Reviewed:** 3
**Status:** issues_found

## Summary

Scope was the diff `009dee0143..HEAD` for three files:

- `jira-project.cjs` grows from the T-29-03 watermark store to include the T-29-04 planner (+315 lines).
- `jira-project.test.cjs` is new (638 lines).
- `ci-wait.cjs` gains a single trailing comment and no behaviour change.

I read all three files in full. I also read the callees the planner depends on: `lock.cjs`, `pipeline-config.cjs` (`loadConfig`, `normalizeJiraTransitions`, `TICKET_STATUSES`), the `status_change` writer in `state-sync.cjs:787`, the `jira` field written by `validate-graph.cjs:177`, and the sibling stores `drift-record.cjs` / `escalation-record.cjs`.

I ran `jira-project.test.cjs` (34/34), `record-stores`, `ci-wait`, `source-contract` and `files-contract`; all are green. Green is not evidence of correctness here. I wrote throwaway repros under `/tmp/p52-review-scratch` and ran mutation probes against a copy of the module. Both found real gaps, each reproduced below. No source file was modified.

The planner's windowing logic holds up under inspection. The backward scan terminates, the first-line drop is guarded by `seeked`, and the "latest event wins" collapse is correct because the window always extends to EOF. Network isolation holds. The defects are at the store boundary (what happens when the watermark file is not a clean, expected shape), in one exported comparator, in one product-behaviour gap, and in tests that do not discriminate.

`ci-wait.cjs` has only the comment-line change (IN-01). I did not re-audit its pre-existing logic beyond a read-through; nothing in the changed lines can affect behaviour.

## Critical Issues

### CR-01: A corrupt or mis-shaped `jira-projection.json` is silently read as "empty", and the next write destroys every other watermark

**File:** `plugins/delivery-pipeline/scripts/jira-project.cjs:139-146` (`load`), `182-206` (`mutate`), `441-534` (`planItems`)

**Issue:** `load()` wraps `readFileSync` + `JSON.parse` in a bare `catch { return { tickets: {} } }`, so every failure collapses into "nothing has been projected yet". That includes a JSON syntax error, `EISDIR`, `EACCES`, and `tickets` of the wrong type. It is only safe for a missing file (`ENOENT`). `mutate()` then runs `fn(store)` on that empty store and `writeAtomic`s the result over the original file.

This is realistic. The file's own comments say `.planning/graph/` is tracked in git (see `lock.cjs`), so a merge conflict leaves `<<<<<<<` markers in `jira-projection.json`. The `mutate` doc comment even names the consequence ("a torn read parses as an empty store … re-projects everything") but only guards against torn writes, not against any other unparseable content.

Reproduced against the shipped module:

```
1a store before corruption: [ 'T-1', 'T-2' ]
1b write over conflict-marked store -> true keys now: [ 'T-1' ]          # T-2's watermark is gone
1c plan over unparseable store emits: [ 'T-1', 'T-2' ] warnings: []       # whole board re-projected, no warning
5a markProjected over {"tickets":"oops"} THROWS: TypeError Cannot create property 'T-1' on string 'oops'
5b tickets=[] -> written: true  on disk: {"tickets":[]}                  # reported written, NOT persisted
```

Consequences:

- **1b:** permanent loss of all other watermarks, plus any `unreachable` records T-29-05 will write. Every lost ticket is transitioned again on somebody's board, the exact failure the store exists to prevent.
- **1c:** the planner treats a broken store as a clean first run and emits every mapped ticket with no warning. The sibling `invalid config` path is deliberately loud and refuses (ADR-004 D2). A corrupt watermark file deserves the same treatment, because transitioning a board is a mutation.
- **5b:** `load()` accepts any truthy `raw.tickets`, including an array. `store.tickets[ticket] = rec` on an array sets a non-index property, which `JSON.stringify` drops. The call returns `written: true` while nothing was persisted, so the ticket is re-projected every round.
- **5a:** a string `tickets` makes `markProjected` throw an unhandled `TypeError` stack trace instead of a refusal.

**Fix:** Separate "absent" from "unreadable", and validate shape.

```js
function load(dir = GRAPH_DIR) {
  let text;
  try { text = fs.readFileSync(storeFile(dir), 'utf8'); }
  catch (e) {
    if (e.code === 'ENOENT') return { tickets: {} };            // genuinely nothing yet
    throw new Error(`cannot read ${storeFile(dir)} (${e.code || e.message}) — refusing to treat it as empty`);
  }
  let raw;
  try { raw = JSON.parse(text); }
  catch (e) { throw new Error(`${storeFile(dir)} does not parse (${e.message}) — refusing to treat it as empty; fix or delete it`); }
  const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
  if (!isObj(raw) || (raw.tickets !== undefined && !isObj(raw.tickets))) {
    throw new Error(`${storeFile(dir)} has an unexpected shape — refusing to overwrite it`);
  }
  raw.tickets = raw.tickets || {};
  return raw;
}
```

- `mutate` then fails loudly before touching the file, because the throw happens inside the lock and the `finally` releases it.
- `planItems` should catch that error and answer `enabled:false` plus one warning, the same way it handles an invalid config.
- Also skip `writeAtomic` when `fn` reports `written:false`. A skipped `markProjected` currently rewrites an identical file under the lock, which is pointless churn in a tracked directory and is what turned a read error into a write.

## Warnings

### WR-01: The exported `compareStatus` answers "earlier" for an unknown status, contradicting the file's own stated rule

**File:** `plugins/delivery-pipeline/scripts/jira-project.cjs:108-129`

**Issue:** The comment above `statusRank` says `-1` is "unknown, never 'before everything': every caller checks for it before comparing, because arithmetic on an unknown would quietly answer a question nobody can actually answer." `compareStatus` then does exactly that arithmetic: `statusRank(a) - statusRank(b)`.

Measured:

```
compareStatus('bogus', 'pr-open') = -3    // "bogus is earlier than pr-open"
compareStatus('merged', 'bogus')  =  4    // "merged is later than bogus"
```

The docblock says the function is exported so that "the planner (T-29-04) and every later reader take that comparator rather than spelling the order again". Only `hasProjected` pre-screens through `statusRank`, so any later consumer that uses the exported comparator directly gets "unknown sorts before everything". That is the unsafe direction, since "earlier" reads as "forward progress" and permits a write. The guard lives in one caller instead of in the single definition of the order.

**Fix:** Make the single comparator refuse the case it cannot answer.

```js
function compareStatus(a, b) {
  const ra = statusRank(a), rb = statusRank(b);
  if (ra === -1 || rb === -1) {
    throw new RangeError(`compareStatus: "${ra === -1 ? a : b}" is not one of ${TICKET_STATUSES.join(', ')}`);
  }
  return ra - rb;
}
```

`hasProjected` already screens first, so its behaviour is unchanged. Add a test that pins the throw.

### WR-02: A mapped lower status is never projected when the board skips past it, and the planner gives no reason

**File:** `plugins/delivery-pipeline/scripts/jira-project.cjs:496-531`

**Issue:** The collapse keeps only the latest event per ticket. The planner then drops the ticket if the latest `to` is unmapped. With `jira_transitions = {branched: 'In Progress', merged: 'Done'}` and a journal `null→pending`, `pending→pr-open`, the output is `items: [], reason: null`. The ticket passed *through* a mapped status in OUR order, but nothing is ever emitted for it.

The test file's own fixture shows that skipping is the common shape: `REAL.branched` is literally `"from":"pending","to":"pr-open"`. state-sync only journals what it observes, and a PR opened in one round never shows `branched`. An operator who maps `branched` but not `pr-open` therefore gets silence for exactly the tickets that matter, and `plan` says only "nothing to project". The existing test ("an unmapped `to` is skipped silently") only pins the case where *nothing at or below* the latest status is mapped.

This is a design-level consequence. Please confirm it against ADR-008 D3 rather than assume either direction.

**Fix:** If the intent is "the tracker reflects the furthest mapped status at or below the board", select the highest mapped status `s` with `compareStatus(s, e.to) <= 0` that is not already `hasProjected`, and emit that. If the current behaviour is intended, say so in the `plan` output (e.g. a `skipped_unmapped: [{ticket, to}]` list under `--json`) so a silent no-op is distinguishable from "nothing happened".

### WR-03: The "no ticket graph" refusal is bypassed for any explicit directory, so a typo'd `--graph` writes into the void and litters a stray `.planning/graph/.locks`

**File:** `plugins/delivery-pipeline/scripts/jira-project.cjs:190-198`

**Issue:** The guard only fires when `!GRAPH_EXPLICIT && dir === GRAPH_DIR`. Both an explicit flag/env and a library caller passing its own `dir` skip it entirely, and `mkdirSync(dir, {recursive:true})` then creates whatever was named. Reproduced with a typo'd `--graph …/.planning/grap`:

```
A written: true
typo/.planning/grap/jira-projection.json     # store nobody reads
typo/.planning/graph/.locks                  # stray lock tree under the derived root
```

The next round reads the real `.planning/graph`, finds no watermark, and re-projects. That is the "written into the void" failure the file's header and CLAUDE.md describe: "the refusal fixes the class, because the next prompt that forgets it must fail loudly". CLAUDE.md states the rule as "refuse when the resolved graph dir has no `tickets.json`", with no explicit-flag exemption. The stated rationale for the exemption is that a cross-repo caller "names a graph dir this process cannot otherwise reach". But a valid project graph named explicitly still contains `tickets.json`, so the exemption protects nothing legitimate. `drift-record.cjs:158` carries the same exemption, so the siblings should be fixed together.

**Fix:** Check the directory that will actually be written, regardless of how it was named:

```js
if (!fs.existsSync(path.join(dir, 'tickets.json'))) {
  throw new Error(`no ticket graph at ${dir} — refusing to record a projection nothing will read. …`);
}
```

Keep the message that names `--graph`. Do the check before the `mkdirSync`. Consider the same fix in `drift-record.cjs`, `escalation-record.cjs` and `dispatch-record.cjs`.

### WR-04: The project root is assumed to be `<graph>/../..`, so a non-standard graph dir silently disables the planner under a false reason

**File:** `plugins/delivery-pipeline/scripts/jira-project.cjs:104`, `272`, `443-444`

**Issue:** `planItems` loads the config from `projectRootFor(dir) = dir/../..`, and `mutate` places its lock under the same derived root. `--graph` and `SHIPYARD_GRAPH_DIR` are advertised as accepting any directory. For a graph at `<proj>/my-graph`, the config is read from the grandparent. Reproduced:

```
B items: 0 reason: pipeline.jira_transitions is empty, which is the projection switched off (the default)
```

The config actually did contain `jira_transitions: {merged: 'Done'}`; it was read from the wrong place. The reported reason is false, and `plan` exits 0 with no warning. Since "off" is the quiet common case, the operator has no signal that a configured feature is never firing. `mutate` has the matching hazard: its lock lands in `<grandparent>/.planning/graph/.locks`, possibly outside the project, or at `/` for a shallow path.

**Fix:** Either require the `…/.planning/graph` shape (fail with a clear message otherwise), or include the path actually searched in the "off" reason (`config read from ${root}/.planning/config.json`). Prefer the former, since lock placement also depends on it.

### WR-05: The "reports what the tracker was last TOLD" test cannot fail: the fixture makes the watermark equal the earliest event's `from`

**File:** `tests/unit/jira-project.test.cjs:249-259`

**Issue:** The fixture has events `pending→branched`, `branched→pr-open` and a watermark `projected_to: 'pending'`. The earliest event's `from` is also `'pending'`, so the assertion `from === 'pending'` passes whether the code uses the watermark or the earliest event. I removed the watermark branch (`(wm && wm.projected_to) ||`) from a copy of the module and the whole file stayed green (34 passed, 0 failed). The behaviour the test is named for, "what the tracker was last TOLD", is therefore unguarded.

**Fix:** Make the two sources disagree:

```js
journal: [
  sc('T-21-02', 'pending', 'branched', '2026-08-26T09:00:00.000Z'),
  sc('T-21-02', 'branched', 'pr-open', '2026-08-26T14:29:20.564Z', 17),
],
store: { tickets: { 'T-21-02': { projected_to: 'branched', ts: '2026-08-26T09:00:05.000Z' } } },
// expect from === 'branched'   (earliest event's `from` would be 'pending')
```

### WR-06: Deterministic item ordering is unasserted, and the tests sort on their own side, which masks it

**File:** `tests/unit/jira-project.test.cjs:422`, `578`; code under test at `plugins/delivery-pipeline/scripts/jira-project.cjs:532`

**Issue:** The planner sorts `out.items` by ticket id. Both multi-item assertions call `.sort()` themselves (`ids(out).sort()` at line 422, `j.json.items.map(...).sort()` at line 578), so the planner's own ordering is never observed. Deleting the `out.items.sort(...)` line from a copy leaves 34/34 green. The agent that consumes this list in T-29-05 walks it in order, and a stable order is what makes rounds reproducible.

**Fix:** Write the journal in reverse id order and assert the raw order, with no test-side sort:

```js
journal: [ sc('T-24-05', …), sc('T-21-02', …) ]
assert.deepEqual(ids(plan(p)), ['T-21-02', 'T-24-05']);
```

## Info

### IN-01: `ci-wait.cjs` gains an unrelated, meaningless trailing comment after the infinite loop

**File:** `plugins/delivery-pipeline/scripts/ci-wait.cjs:609-610`

**Issue:** The only change to this file is `// replay note: unrelated comment line, no behaviour change.`, placed after a `for (;;)` that never falls through. The commit is titled "unrelated: comment in ci-wait". It is out of scope for the T-29-04 ticket, and it touches a script that CLAUDE.md describes as load-bearing for the stop-gate pair. "Replay note" means nothing to a future reader, and it adds nothing to the file's already extensive documentation.

**Fix:** Revert the hunk (`git checkout 009dee0143 -- plugins/delivery-pipeline/scripts/ci-wait.cjs`).

### IN-02: `plan --json` has an unstable shape, and an unorderable watermark is skipped forever with no diagnostic

**File:** `plugins/delivery-pipeline/scripts/jira-project.cjs:441-494`, `168-173`

**Issue:** There are two related quiet-failure points.

- `out.journal` is only set after `readTransitions`, so every early return (disabled, empty map, no `tickets.json`, no keys) omits it. A JSON consumer that reads `out.journal.bytes_read` unconditionally gets a `TypeError`. Initialise it in the `out` literal.
- A hand-edited `projected_to` outside `TICKET_STATUSES` makes `hasProjected` return `true` forever. This is the documented safe direction, but `plan` reports `reason: null` and no warning. The ticket is stuck without a trace, and the `readTransitions` anchor for it never matches, so every round reads the entire journal.

**Fix:** Add `journal: null` to the initial `out`. For the poisoned-record case, push one warning per such ticket (`${ticket}: projected_to "${x}" is not a ticket status — skipped until the record is fixed`).

### IN-03: `statusChangesIn` accepts events with no or unknown `to`, unlike `front.cjs`'s journal reader

**File:** `plugins/delivery-pipeline/scripts/jira-project.cjs:310`

**Issue:** `front.cjs:1056` skips `status_change` records lacking `to`; this reader does not. A parseable but malformed record becomes `latest` and masks an earlier valid one. Reproduced: `pr-open→merged` followed by a `status_change` with no `to` yields `items: []`. State-sync does not write such a record, so this is hand-edit or corruption territory, but the two readers of the same stream should agree.

**Fix:** `if (!e || e.event !== 'status_change' || !e.ticket || statusRank(e.to) === -1) continue;`

### IN-04: Speculative and duplicated code for a ticket that has not landed

**File:** `plugins/delivery-pipeline/scripts/jira-project.cjs:104`, `272`, `289`, `390-427`, `550`

**Issue:**

- `unreachableFor`, `unreachableRecord`, `UNREACHABLE_KEY` and `unreachableSuppressed` read a store field that nothing in this build writes (T-29-05 owns the writer).
- `lockRootFor` and `projectRootFor` are byte-identical (`path.resolve(dir,'..','..')`).
- `read` has an undocumented `list` alias, and the usage line says `read|plan`.
- Unknown flags are silently ignored, so `plan --jsno` prints human text and exits 0; an agent that typos `--json` then fails at `JSON.parse` downstream.

**Fix:** Keep `unreachable*` only if T-29-05 is merged with it, since the suppression path is exercised today only by hand-built stores. Collapse the two root helpers into one. Remove the `list` alias, or document it. Reject unknown `--flags` with exit 1.

### IN-05: Test header overstates provenance, and a hard-coded line reference will rot

**File:** `tests/unit/jira-project.test.cjs:30-33`, `59-60`

**Issue:** The header says every fixture line is a real record copied out of the project's journal. Most are synthesised by `sc()` (for example `pending→branched @ 09:00:00.000Z` and every padding record). `REAL.branched` is actually a `pending→pr-open` record, so its name is wrong. The comment also pins `state-sync.cjs:787`, which will drift on the next edit.

**Fix:** Reword to "shapes taken from real records", rename `REAL.branched` to `REAL.prOpened`, and reference the writer by name (`transitions.push({… event: 'status_change' …})`) instead of a line number.

---

_Reviewed: 2026-10-19T12:06:16Z_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: deep_
