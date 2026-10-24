---
phase: 29-tracker-projection
reviewed: 2026-10-19T00:00:00Z
depth: deep
files_reviewed: 3
files_reviewed_list:
  - plugins/delivery-pipeline/scripts/jira-project.cjs
  - tests/unit/jira-project.test.cjs
  - plugins/delivery-pipeline/scripts/ci-wait.cjs
findings:
  critical: 0
  warning: 5
  info: 4
  total: 9
status: issues_found
---

# Phase 29: Code Review Report

**Reviewed:** 2026-10-19T00:00:00Z
**Depth:** deep
**Files Reviewed:** 3
**Status:** issues_found

## Summary

The diff adds the `plan` verb to `jira-project.cjs`. It is a read-only planner over three local files: the journal, `tickets.json` and the config. The diff also adds a 638-line unit test file and one stray comment line in `ci-wait.cjs`.

I traced the journal scan in `readTransitions`, the collapse and forward-only logic in `planItems`, and the unreachable suppression against `pipeline-config.cjs` (`loadConfig`, `TICKET_STATUSES`, `normalizeJiraTransitions`), `lock.cjs`, `graph-dir.cjs`, `state-sync.cjs:787` (the `status_change` writer), `front.cjs:1056` (a sibling journal reader) and `validate-graph.cjs` (the `tickets.json` shape).

The core algorithm holds up: a suffix window that steps back until every watermarked subject is covered, latest-in-append-order collapse, and the byte-0 fallback. I found no defect in the step, seek or termination logic. The defects are at the edges, and all five warnings are cases where the planner fails quietly or fails open:

- It reports "off" for a wrong working directory.
- It treats a corrupt watermark store as empty and re-projects everything.
- It accepts `to`-less journal records.
- It lets I/O errors crash a verb whose contract is "never blocks a round".
- Its "no network" test pin has gaps.

## Warnings

### WR-01: `plan` run from a worktree reports "projection switched off (the default)" instead of naming the missing graph
**Rule:** silent-noop-on-wrong-cwd
**File:** `plugins/delivery-pipeline/scripts/jira-project.cjs:444`
**Anchor:** `const { config, valid, error } = loadConfig(root);`
**Issue:** The default graph dir is `<cwd>/.planning/graph`, and `root` is derived from it by walking up two levels.

When the main loop runs `plan` from a ticket or phase worktree, that worktree has no `.planning/` if the project keeps it untracked. CLAUDE.md names this exact calling context as "the recurring defect in this repo".

In that case `loadConfig(root)` finds no config file and returns defaults. The planner then reaches the empty-map branch at line 461 and answers "pipeline.jira_transitions is empty, which is the projection switched off (the default)" with exit 0. The missing-graph check at lines 469-476 is never reached.

An operator who configured `jira_transitions` correctly is pointed at the wrong cause. The projection silently never fires, and no `record` step ever runs to trip the `mutate()` refusal. The sibling stores fail loudly here; `state-sync` and `sentinel` do too.

The existing test "a graph with no tickets.json…" only passes because it creates a config at the project root and passes the dir explicitly. It never exercises the default-cwd path.

**Fix:** Check the graph before the config, mirroring the guard in `mutate`. Make it a loud warning on stderr and in `warnings`, still exit 0:
```js
if (!GRAPH_EXPLICIT && dir === GRAPH_DIR && !fs.existsSync(path.join(dir, TICKETS_NAME))) {
  out.enabled = false;
  out.reason = `no ticket graph at ${dir} — run from the conveyor project or pass --graph <project>/.planning/graph (or set SHIPYARD_GRAPH_DIR)`;
  out.warnings.push(out.reason);
  return out;
}
```
Add a test that runs `plan` from a directory with no `.planning/`, with no `--graph`, and asserts the message names `--graph`.

### WR-02: A corrupt or conflict-marked `jira-projection.json` is read as an empty store, so the planner re-projects every ticket
**Rule:** fail-open-on-corrupt-store
**File:** `plugins/delivery-pipeline/scripts/jira-project.cjs:486`
**Anchor:** `const store = load(dir);`
**Issue:** `load()` returns `{ tickets: {} }` for any read or parse failure, not only for ENOENT. This is the first place a corrupt store turns into tracker mutations.

With an empty store:

- Every subject has `projected_to = null`.
- `readTransitions` takes the unanchored branch and reads the whole journal.
- `hasProjected` answers false for everything.
- `plan` emits every mapped latest transition again, so the acting agent re-transitions issues that were already moved.

`.planning/graph/` is tracked in this project, and ticket branches routinely merge `origin/epic/…`. A merge conflict in `jira-projection.json` leaves `<<<<<<<` markers. After that:

- `plan` silently re-projects the whole board.
- The next `mutate()` overwrites the conflicted file with a fresh store and loses every watermark, and also any `unreachable` reports.

The file's own principle is the opposite: an unknown or unproven state must skip, "refuse an unproven write into somebody's tracker". `hasProjected` follows it for unknown statuses, and an invalid config refuses. An unreadable store does not.

**Fix:** Make `load` distinguish "absent" from "present but unreadable".
```js
function load(dir = GRAPH_DIR) {
  let text;
  try { text = fs.readFileSync(storeFile(dir), 'utf8'); }
  catch (e) { if (e.code === 'ENOENT') return { tickets: {} }; throw e; }
  const raw = JSON.parse(text);   // throws on corruption
  ...
}
```
`planItems` should catch the error and return `enabled: false` with a one-line warning naming the file, as it does for an invalid config. `mutate` should refuse to overwrite an unparseable store.

### WR-03: `statusChangesIn` accepts `status_change` records with no `to`, which can end the backward scan early and mask a real transition
**Rule:** missing-field-validation
**File:** `plugins/delivery-pipeline/scripts/jira-project.cjs:310`
**Anchor:** `if (!e || e.event !== 'status_change' || !e.ticket) continue;`
**Issue:** The sibling reader `front.cjs:1056` also requires `!e.to`. This one does not, and two things follow.

1. **Premature coverage.** In `readTransitions` the coverage test is `need.get(e.ticket) === e.to`. For a non-subject ticket `need.get` returns `undefined`, and a `to`-less record has `e.to === undefined`, so the test is true. Such a record adds a bogus ticket to `seen` and increments `covered`. With `need.size === 1` one malformed record in the first 64 KB window ends the scan. The subject's real events (older than the window) are never read, and its transition is silently dropped on every round. That is the "loses transitions without saying so" defect the scan exists to prevent.
2. **Masking in the collapse.** If a subject's last `status_change` lacks `to`, `latest` holds that record. `map[undefined]` misses, so the ticket's real latest transition is skipped silently.

State-sync always writes `to`, so this needs a malformed or hand-edited journal line. It is the failure mode the planner is built to survive, and the guard is one token.

**Fix:**
```js
if (!e || e.event !== 'status_change' || !e.ticket || !e.to) continue;
```
Also tighten the coverage test to `need.has(e.ticket) && need.get(e.ticket) === e.to`.

### WR-04: I/O errors in the journal read crash `plan` with a stack trace and exit 1, against its "never blocks a round" contract
**Rule:** unhandled-io-error
**File:** `plugins/delivery-pipeline/scripts/jira-project.cjs:344`
**Anchor:** `const fd = fs.openSync(file, 'r');`
**Issue:** Only `fs.statSync` is guarded. `openSync` and `readSync` are not, and neither is the CLI's `planItems()` call. The file's own tests state the contract: "still exit 0 — this never blocks a round (ADR-008 D6)".

These cases throw an uncaught exception with exit 1:

- The journal is rotated or removed between the `statSync` and the `openSync` (ENOENT). `state-sync` appends concurrently, so the window is real.
- The journal path is a directory. This is the accident `ci-wait.cjs` measured for its own store. `statSync().size` is non-zero, and `readSync` throws EISDIR.
- The journal is unreadable (EACCES).

The return value of `readSync` is also ignored, so a short read leaves zero-filled bytes in `buf`.

**Fix:** Catch around the read inside `readTransitions` and degrade to `{events: [], …}`, or wrap the CLI's `planItems()` call. Either way, report one line (an `out.warnings` entry) and exit 0. Truncate the buffer to the number of bytes actually read: `buf.toString('utf8', 0, n)`.

### WR-05: The "no network" source-token pin has gaps, so it gives more assurance than it provides
**Rule:** weak-negative-test-pin
**File:** `tests/unit/jira-project.test.cjs:626`
**Anchor:** `/require\(['"](https?|net|tls|dgram)['"]\)/]) {`
**Issue:** The test claims the sweep "covers every path" and is "the stronger" assertion. It does not.

The module-specifier pattern matches only the bare `http`, `https`, `net`, `tls` and `dgram`. It misses these routes to the network:

- `require('node:https')`, `node:http`, `node:net` and the other `node:`-prefixed forms (the current idiom).
- `http2` and `dns`.
- Dynamic `import()`.
- A concatenated specifier such as `require('child' + '_process')`.

`child_process` itself is caught only by the separate `\bchild_process\b` token. The property the pin protects (the planner grows a credential or a client) can be violated while the test stays green.

**Fix:** Match specifiers with an optional `node:` prefix and a wider module list, and reject dynamic loads:
```js
/require\(\s*['"](?:node:)?(https?|http2|net|tls|dgram|dns)['"]\s*\)/,
/\bimport\s*\(/, /\brequire\s*\(\s*[^'"\s)]/,   // a non-literal require argument
```
Soften the comment from "covers every path" to what the sweep actually does.

## Info

### IN-01: `projectRootFor` duplicates `lockRootFor`, and the new `TICKETS_NAME` constant is not used by `mutate`
**Rule:** duplicated-helper
**File:** `plugins/delivery-pipeline/scripts/jira-project.cjs:272`
**Anchor:** `const projectRootFor = (dir) => path.resolve(dir, '..', '..');`
**Issue:** This is byte-for-byte the same walk as `lockRootFor` at line 104. The comment even says "The same walk `lockRootFor` does". This file's own header argues that one fact should have one definition.

`mutate` (line 190) still spells `'tickets.json'` literally, while the new `TICKETS_NAME` constant is used only by the planner. A change to either place can silently diverge from the other.
**Fix:** Define one `projectRootFor` and have `lockRootFor` use it, or the reverse. Use `TICKETS_NAME` in `mutate`.

### IN-02: The planner discards `loadConfig`'s warnings, so a fully rejected `jira_transitions` map reads as "off (the default)"
**Rule:** discarded-diagnostics
**File:** `plugins/delivery-pipeline/scripts/jira-project.cjs:463`
**Anchor:** `out.reason = 'pipeline.jira_transitions is empty, which is the projection switched off (the default)';`
**Issue:** Line 444 destructures only `{config, valid, error}`. The `warnings` array from `loadConfig` is dropped.

Take `jira_transitions: {pr_open: 'Done'}`, a typo for `pr-open`. `normalizeJiraTransitions` warns and skips the entry, leaving an empty map. `plan` then says the projection is off "by default". `state-sync` prints config warnings on its board, but `plan` is a separate verb.

For an invalid config, the reason is `config is invalid (is not valid JSON …)`. It omits `error.relative`, so it does not name the file. The test's comment ("exactly one line, naming the file") claims more than the code or its assertion (`/invalid/i`) delivers.
**Fix:** Name the file in the invalid-config reason. When the configured map normalizes to empty and the config carried `jira_transitions` entries, add a reason that says the entries were rejected and carries the relevant `loadConfig` warnings.

### IN-03: Comments contradict the code now that `plan` lives in this file
**Rule:** stale-comment
**File:** `plugins/delivery-pipeline/scripts/jira-project.cjs:67`
**Anchor:** ``// CLI only, deliberately: T-29-04's planner `require`s this file for the``
**Issue:** The planner (T-29-04) is now in this file, not a separate script that requires it. The `require.main === module` rationale now applies to T-29-05 and the tests.

The comment at lines 188-189 says "the verbs that write (T-29-04/05) are not in this ticket". T-29-04 is now here, though it does not write.

`tests/unit/record-stores.test.cjs:259-260` (outside this diff) still says the `plan` verb "do[es] not exist yet".
**Fix:** Reword these to name T-29-05 only, and update the record-stores comment.

### IN-04: Stray meta-comment appended to `ci-wait.cjs`, unrelated to this change
**Rule:** unrelated-noise-change
**File:** `plugins/delivery-pipeline/scripts/ci-wait.cjs:610`
**Anchor:** `// replay note: unrelated comment line, no behaviour change.`
**Issue:** The line sits after the unbounded `for (;;)` loop. It documents the commit process, not the code, and it adds an unrelated file to a ticket that is about the Jira planner. It carries no information a reader needs. It makes `git blame` on a hot script point at this ticket.
**Fix:** Drop the line and the `ci-wait.cjs` change from this ticket.

---

_Reviewed: 2026-10-19T00:00:00Z_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: deep_