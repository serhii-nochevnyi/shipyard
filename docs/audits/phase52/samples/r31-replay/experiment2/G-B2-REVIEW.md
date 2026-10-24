---
phase: 29-the-tracker-is-a-projection-and-a-projection-is-driven
reviewed: 2026-10-19T12:10:00Z
depth: deep
files_reviewed: 2
files_reviewed_list:
  - plugins/delivery-pipeline/scripts/jira-project.cjs
  - tests/unit/jira-project.test.cjs
findings:
  critical: 1
  warning: 2
  info: 4
  total: 7
status: issues_found
---

# Phase 29: Code Review Report

**Reviewed:** 2026-10-19T12:10:00Z
**Depth:** deep
**Files Reviewed:** 2
**Status:** issues_found

## Summary

Scope: the T-29-04 planner (`planItems`, `readTransitions`, the unreachable suppression, the `plan` CLI verb) added on top of the T-29-03 watermark store, plus its unit test file, plus a trailing "unrelated" commit that inserted twelve comment lines. I read both files in full and cross-checked them against `pipeline-config.cjs` (`loadConfig`, `TICKET_STATUSES`), `lock.cjs`, `escalation-record.cjs` (sibling store conventions), `state-sync.cjs:787` (the writer of the consumed `status_change` records), `validate-graph.cjs` (where `tickets.json`'s `jira` field comes from) and `front.cjs`/`stop-gate.cjs`. The 34 unit tests pass (`node tests/unit/jira-project.test.cjs`).

The planner's core algorithm is sound where it counts. I traced the window logic (step back until every watermarked subject's projected event is in the window, always keep the latest event per ticket) and the collapse logic, and the 64 KB-tail trap is genuinely avoided. The defects are at the edges, and every one of them fails **silently with exit 0**. That is the failure mode the file's own header calls "worse than one that never ran". I reproduced each of the three substantive findings below in a scratch project outside the repo.

- **CR-01**: an unparseable watermark store is read as "nothing has ever been projected". `plan` then re-emits every already-projected ticket, and the next `markProjected` overwrites the corrupt file and destroys every other record.
- **WR-01**: a `status_change` record with no `to` makes the journal scan stop early and silently drops a pending transition.
- **WR-02**: `plan` run from a cwd that is not the conveyor project answers "the projection is switched off (the default)", which misdiagnoses the cause, and exits 0.

## Critical Issues

### CR-01: A corrupt or conflicted `jira-projection.json` is treated as "nothing projected", so the planner re-emits everything and the next write destroys the store

**File:** `plugins/delivery-pipeline/scripts/jira-project.cjs:151-158` (`load`), consumed at `:498` (`planItems`) and `:213-215` (`mutate`)

**Issue:** `load()` has one `catch` that maps every failure to `{ tickets: {} }`: ENOENT, EACCES, truncated JSON, git conflict markers and a non-object body all read the same. ENOENT is the legitimately normal first state. The others are not, and they are indistinguishable from it. The docblock says "a torn read cannot happen", but it only covers a torn *write*. It says nothing about a store that arrives corrupt. That is plausible here: the file lives in `.planning/graph/`, which this repo tracks in git (`.planning/graph/tickets.json` is in the tree), so a merge-conflicted `jira-projection.json` is a realistic input.

The header (lines 187-193) states the consequence of an empty read itself: "reads as 'nothing has been projected' and re-projects everything". The new planner at `:498` is the code that turns that into action. I reproduced both halves:

```
# healthy store (T-24-05 projected_to: merged)
$ jira-project.cjs plan --graph …      → "nothing to project"            exit 0
# same store with <<<<<<< / ======= / >>>>>>> markers around it
$ jira-project.cjs plan --graph …      → "1 pending projection:
                                           T-24-05 SHIP-5: pr-open -> merged => "Done""   exit 0, no warning
```

Then `markProjected("T-30-01", "pr-open", …)` against a conflict-marked store that also held an `unreachable` section returned `written: true` and rewrote the file as `{ tickets: { "T-30-01": … } }`. Every prior watermark and every `unreachable` report was gone, with no error. Result: the exactly-once and forward-only guarantees, which are the whole point of this store, are void after any parse failure. Tickets are transitioned a second time on somebody's board, and a person who has since moved an issue by hand has it moved again. The unreachable suppression also lifts, so the retry loop ADR-008 D4 forbids restarts.

The sibling stores (`escalation-record.cjs:207-214`) share the swallow-everything `load`. Their blast radius is a verdict that un-parks for a round. Here the radius is writes to an external system, so copying the pattern verbatim is not equivalent.

**Fix:** distinguish "absent" from "unreadable". Absent stays empty. Unreadable makes `plan` refuse and makes `mutate` refuse to overwrite. For example:

```js
function load(dir = GRAPH_DIR) {
  let text;
  try { text = fs.readFileSync(storeFile(dir), 'utf8'); }
  catch (e) {
    if (e.code === 'ENOENT') return { tickets: {} };
    throw new Error(`cannot read ${storeFile(dir)}: ${e.message}`);
  }
  let raw;
  try { raw = JSON.parse(text); }
  catch (e) {
    throw new Error(`${storeFile(dir)} is not valid JSON (${e.message}) — refusing to treat it as "nothing projected". Fix or remove the file.`);
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`${storeFile(dir)} is not a JSON object`);
  if (!raw.tickets || typeof raw.tickets !== 'object' || Array.isArray(raw.tickets)) raw.tickets = {};
  return raw;   // preserves `unreachable`
}
```

In `planItems`, catch that error around `load(dir)`, set `out.enabled = false`, put the message in `out.reason` and `out.warnings` (this is the same "broken file, worth saying" case as the invalid-config branch at `:461-466`), and return an empty list. Add a regression test with a conflict-marker store that asserts `plan` projects nothing and warns, and a `markProjected` test that asserts the corrupt file is left byte-identical.

## Warnings

### WR-01: A `status_change` with no `to` makes the journal scan stop early and silently drops a pending transition

**File:** `plugins/delivery-pipeline/scripts/jira-project.cjs:384-388` (`readTransitions`), with the filter at `:322`

**Issue:** The stop test is `need.get(e.ticket) === e.to`. For a ticket that is **not** a subject, `need.get()` returns `undefined`, so a `status_change` event whose `to` is absent (`undefined === undefined`) counts as "covered". `statusChangesIn` (`:322`) only checks `e.event` and `e.ticket`. It does not require `to`, and `front.cjs:1056` does guard `!e.to`, so the codebase already expects such records. With a single watermarked subject, one such record anywhere in the current window makes `covered === need.size`, and the scan returns before it has reached the subject's real projected event.

I reproduced it. The subject has watermark `pr-open` and a `merged` event ~200 KB back. A 207 KB journal has one `to`-less `status_change` for another ticket at its tail:

```
with the to-less record:   {"items": [], "journal": {"bytes_read": 65536, "size": 207334, "seeked": true}}   exit 0
same journal without it:   1 pending projection: T-24-05 SHIP-5: pr-open -> merged => "Done"
```

The merge is never projected, silently, and stays unprojected until that ticket generates another event. `state-sync.cjs:787` always writes `to`, so this needs a hand-edited, merged or foreign-written record. That is why it is a Warning rather than a Critical. The consequence is exactly the "loses transitions without saying so" defect this scan was built to avoid, and the existing tests only exercise well-formed events.

**Fix:** only count tickets that are in `need`, and make `statusChangesIn` reject records without a usable `to`:

```js
for (const e of events) {
  if (!need.has(e.ticket) || seen.has(e.ticket)) continue;
  if (need.get(e.ticket) === e.to) { seen.add(e.ticket); covered++; }
}
```
```js
if (!e || e.event !== 'status_change' || !e.ticket || !e.to) continue;   // match front.cjs:1056
```

Add a test: a big journal with a `to`-less `status_change` for a non-subject near the tail must still emit the old pending item.

### WR-02: `plan` from the wrong cwd answers "switched off (the default)", misdiagnoses the cause, and exits 0

**File:** `plugins/delivery-pipeline/scripts/jira-project.cjs:453-477` and `:576-577`

**Issue:** `plan` has no equivalent of the refusal `mutate` has at `:202-210`. Without `--graph`, `GRAPH_DIR` is `<cwd>/.planning/graph`. `planItems` reads the config from `<cwd>` first, and the off-switches run **before** `tickets.json` is looked at. From a directory with no `.planning/`, the config is the default, `jira_transitions` is empty, and the planner reports a deliberate configuration:

```
$ cd <dir with no .planning> && jira-project.cjs plan
nothing to project — pipeline.jira_transitions is empty, which is the projection switched off (the default)      exit 0
```

That is the recurring defect CLAUDE.md describes for `graph-dir.cjs`: a script resolving `.planning/graph` from `process.cwd()` while its documented caller stands in a worktree. The main loop `cd`s into a phase worktree inside every Bash call, and that worktree has no `.planning/` when the project keeps it untracked. The result is a projection that never runs, for a reason the output names incorrectly, so nobody looks. The wrong-cwd case is not covered by any test (the "no tickets.json" test passes an explicit graph, and `run()` always appends `--graph`).

The same blind spot applies to `projectRootFor` (`:284`). It assumes `--graph` points at a `<project>/.planning/graph`-shaped directory. Any other shape silently reads the config from a different directory and produces the same misleading message.

**Fix:** check the graph before the off-switches, and say so when the graph was not named explicitly:

```js
function planItems(dir = GRAPH_DIR) {
  const out = { … };
  if (!fs.existsSync(path.join(dir, TICKETS_NAME))) {
    out.enabled = false;
    out.reason = `no ${TICKETS_NAME} at ${dir} — nothing is a subject`;
    if (!GRAPH_EXPLICIT && dir === GRAPH_DIR) {
      out.warnings.push(`${out.reason}. Run from the conveyor project or pass --graph <project>/.planning/graph (or set SHIPYARD_GRAPH_DIR).`);
    }
    return out;
  }
  …
```

The warning-versus-quiet rule still holds: a non-explicit cwd with no graph is a mistake, not the quiet common case. Add a test that runs `plan` from a bare temp dir with no flag and asserts a stderr line naming the directory.

## Info

### IN-01: Twelve placeholder comment lines wedged into the file's explanatory header

**File:** `plugins/delivery-pipeline/scripts/jira-project.cjs:21-32`

**Issue:** The "unrelated" commit (`382bd0c2`) inserted a line reading `replay shim: twelve explanatory comment lines inserted above every known defect.` and eleven lines `// (comment line N of the shim)`. These carry no information, and the first line's claim is false: the lines sit in the header, not above any defect. They also split the paragraph that explains the store from its continuation. Line 33, "FORWARD-ONLY IS THE OTHER HALF", now follows the shim instead of the "WHY A WATERMARK" paragraph it completes. They are commented-out filler in a file whose comments are otherwise load-bearing, and they make line numbers in later review notes and blame unreliable.

**Fix:** delete lines 21-32 (a pure comment deletion, with no code change).

### IN-02: Comments that have gone stale now that the planner lives in this file

**File:** `plugins/delivery-pipeline/scripts/jira-project.cjs:79-81`, `:198-201`

**Issue:**
- `:79-81` says "T-29-04's planner `require`s this file for the comparator and the watermark, and an exit at require time would kill THAT script under this one's name". The planner is now `planItems` in this same file. The `require.main === module` guard is still right (T-29-05's `record` and the tests do `require` it), but the stated reason is no longer true.
- `:198-201` says "the verbs that write (T-29-04/05) are not in this ticket". T-29-04 is the read-only planner and writes nothing. Only T-29-05 writes.

**Fix:** reword to name T-29-05 / the tests as the `require`rs and drop T-29-04 from the "writers" list.

### IN-03: `readSync`'s byte count is ignored, and `size` can go stale between `stat` and read

**File:** `plugins/delivery-pipeline/scripts/jira-project.cjs:355-362`

**Issue:** `readFrom` allocates `size - start` bytes and ignores what `fs.readSync` returned. If the journal is rotated or truncated between `statSync` and the read, or the read is short, the unread tail of the buffer is zero-filled. `toString('utf8')` then yields NUL bytes in the last "line". It fails `JSON.parse` and is skipped, so a real final event can be dropped without a trace. The window is narrow, but the file otherwise takes care that a loss is never silent.

**Fix:** `const n = fs.readSync(fd, buf, 0, buf.length, start); return buf.toString('utf8', 0, n);`

### IN-04: Suppression lifts on a wall-clock comparison, while collapse explicitly refuses wall-clock order

**File:** `plugins/delivery-pipeline/scripts/jira-project.cjs:431-439` versus `:508-513`

**Issue:** The collapse comment (`:508-513`) says append order is the truth "rather than the timestamp". `unreachableSuppressed` then lifts only when `Date.parse(item.ts) > Date.parse(rec.ts)`. A genuinely newer event whose `ts` is equal or earlier (a writer with a skewed clock) never lifts the block while the `to` stays the same. An item with an undatable `ts` is suppressed forever (`return true` at `:437`). This is low probability because the sole writer is one script and one clock, but the two rules disagree about what "newer" means. The test suite only covers well-formed, monotonic timestamps.

**Fix:** either record the journal position (byte offset or line number) of the driving event alongside `ts` and compare that, or document that wall-clock monotonicity is assumed and add a test for the equal-timestamp case so the choice is deliberate.

### Test-file notes (no separate finding)

- The tests never clean up their `mkdtempSync` directories (`tests/unit/jira-project.test.cjs:73`, `:551`). Each run leaves ~30 temp dirs, several of them ~250 KB journals.
- The header says every fixture line is "a REAL record copied out of the journal", but `sc()` (`:61-62`) synthesises most records. The claim overstates the provenance.
- There is no case for the three inputs behind CR-01, WR-01 and WR-02 (a corrupt store, a `to`-less record, a `plan` run with no `--graph` from a bare cwd). They are the three gaps in an otherwise thorough suite.

---

_Reviewed: 2026-10-19T12:10:00Z_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: deep_
