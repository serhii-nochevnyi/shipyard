---
phase: 29-jira-projection-planner
reviewed: 2026-10-19T00:00:00Z
depth: deep
files_reviewed: 2
files_reviewed_list:
  - plugins/delivery-pipeline/scripts/jira-project.cjs
  - tests/unit/jira-project.test.cjs
findings:
  critical: 1
  warning: 6
  info: 3
  total: 10
status: issues_found
---

# Phase 29: Code Review Report

**Reviewed:** 2026-10-19T00:00:00Z
**Depth:** deep
**Files Reviewed:** 2
**Status:** issues_found

## Summary

I reviewed the planner added to `jira-project.cjs` (`readTransitions`, `statusChangesIn`, the unreachable-suppression helpers, `planItems`, the `plan` verb) and its test file. I also read the code it calls: `lock.cjs`, `loadConfig` and `normalizeJiraTransitions` in `pipeline-config.cjs`, the `status_change` writer in `state-sync.cjs`, and the `tickets.json` writer in `validate-graph.cjs`.

I reproduced each finding below in scratch directories under `/tmp`. Nothing in the checkout was modified.

The main weakness is that the planner's safety story ("exactly-once", "loses nothing silently") holds for well-formed inputs and fails open on malformed ones. The worst case is a corrupt watermark store, which is read as "nothing has been projected yet". Several smaller fail-open paths and misleading diagnostics sit around it. The tests are thorough on the happy path and on the documented mutations, but they always pass `--graph` and never feed a malformed store or journal.

## Critical Issues

### CR-01: A corrupt watermark store is read as empty, so `plan` re-emits every ticket

**Rule:** fail-open-on-corrupt-store
**File:** `plugins/delivery-pipeline/scripts/jira-project.cjs:498`
**Anchor:** `const store = load(dir);`
**Issue:** `load()` turns any parse failure into `{ tickets: {} }`. The planner then sees every subject as unwatermarked, reads the whole journal and re-emits the latest mapped status of every keyed ticket, including ones already on the tracker.

I reproduced it. With `projected_to: merged` in the store and a `merged` event in the journal, `planItems` returns `[]`. After overwriting the store with `{ corrupt`, the same call returns the `merged` item and no warning.

The diff treats an unparseable config as "no mutation permitted" (ADR-004 D2, lines 458-466), but gives the store, which is the exactly-once guarantee, the opposite treatment. This is realistic, not hypothetical. `.planning/graph/` is tracked in this repo and branches are merged into each other constantly, so a merge conflict in `jira-projection.json` leaves conflict markers and unparseable JSON. The file's own comments (lines 190-193) name this exact outcome ("re-projects everything") as the defect to avoid.

`mutate` has the same weakness, because `load` is shared. A writer would replace the conflicted file with a fresh store.

**Fix:** Distinguish "absent" (ENOENT, which is a normal empty store) from "present but unparseable or the wrong shape". Have the planner refuse in the second case, the way it does for config:
```js
function loadStrict(dir) {
  let text;
  try { text = fs.readFileSync(storeFile(dir), 'utf8'); }
  catch (e) { if (e.code === 'ENOENT') return { store: { tickets: {} }, error: null }; return { store: null, error: e }; }
  try {
    const raw = JSON.parse(text);
    if (raw && typeof raw === 'object' && raw.tickets && typeof raw.tickets === 'object') return { store: raw, error: null };
    return { store: null, error: new Error('not a watermark store') };
  } catch (e) { return { store: null, error: e }; }
}
// in planItems:
const { store, error: storeError } = loadStrict(dir);
if (!store) {
  out.enabled = false;
  out.reason = `${STORE_NAME} is unreadable (${storeError.message}) — a corrupt watermark permits no projection`;
  out.warnings.push(out.reason);
  return out;
}
```
Make `mutate` refuse in the same way. Add a test that overwrites the store with `{ corrupt` and asserts that `items` is empty and a warning is present.

## Warnings

### WR-01: Coverage check counts an event with no `to` for a non-subject ticket, ending the backward scan early

**Rule:** missing-membership-guard
**File:** `plugins/delivery-pipeline/scripts/jira-project.cjs:386`
**Anchor:** `if (need.get(e.ticket) === e.to) { seen.add(e.ticket); covered++; }`
**Issue:** For a non-subject ticket, `need.get(e.ticket)` is `undefined`. If the event has no `to` field, `undefined === undefined` is true, so the event counts toward `covered`. `statusChangesIn` (line 322) admits it because it checks `e.event` and `e.ticket` but never `e.to`.

I reproduced it with a journal over 64 KB, one watermarked subject whose projected event is old, and a single `status_change` line with no `to` for another ticket near the end of the file. The scan stops after the first 64 KB window and `plan` returns `[]`. The same journal without the malformed line returns the pending `merged` item after reading the whole file. The transition is dropped silently on every round for as long as the line stays in the journal.

This is the "loses transitions without saying so" failure the planner is built to prevent. A malformed line is also the latest event for its own ticket. For a subject it would shadow that ticket's last valid event in `latest` (line 519).

**Fix:** Guard membership at the comparison, and require `to` at parse time as a second line of defence:
```js
if (need.has(e.ticket) && need.get(e.ticket) === e.to) { seen.add(e.ticket); covered++; }
```
In `statusChangesIn`, use `if (!e || e.event !== 'status_change' || !e.ticket || !e.to) continue;`, which is what `front.cjs:1056` already does.

### WR-02: Run without `--graph` from a directory that is not the project, `plan` says the projection is "switched off (the default)" and exits 0

**Rule:** wrong-graph-silent-noop
**File:** `plugins/delivery-pipeline/scripts/jira-project.cjs:456`
**Anchor:** `const { config, valid, error } = loadConfig(root);`
**Issue:** `planItems` derives the project root from whichever graph dir it was handed and consults the config and the off-switches (lines 456-477) before it checks that the dir is a ticket graph (line 483).

When `plan` is run from a ticket worktree that has no `.planning/` and no `--graph`, the CLI call `planItems()` (line 577) resolves `<cwd>/.planning/graph`. There is no config there, so the defaults apply and the output is:
```
nothing to project — pipeline.jira_transitions is empty, which is the projection switched off (the default)
```
and exit 0. I reproduced this from a bare directory.

That blames the operator's configuration for what is actually a wrong working directory, and the feature goes quiet for a project that did configure it. This is the recurring defect class that `graph-dir.cjs` and the sibling stores' "no ticket graph at …" refusal exist for. The header (lines 47-53) promises that discipline, but `mutate` is the only place it is enforced. `plan` is a reader with no explicit-graph check.

The tests cannot see this, because `run()` (test line 99) always appends `--graph`.

**Fix:** In the CLI `plan` branch, or at the top of `planItems` when `!GRAPH_EXPLICIT && dir === GRAPH_DIR`, check for `tickets.json` first. Report a "no ticket graph at <dir> — pass --graph <project>/.planning/graph" reason, before any config-derived reason can answer. Add a CLI test that runs `plan` with no `--graph` and a bare cwd, and asserts the reason names the missing graph rather than `jira_transitions`.

### WR-03: `jira.enabled` is compared with `=== false`, so `"false"` or `0` leaves the projection ON

**Rule:** loose-boolean-switch
**File:** `plugins/delivery-pipeline/scripts/jira-project.cjs:467`
**Anchor:** `if (config.jira.enabled === false) {`
**Issue:** `pipeline-config.cjs:615` stores `jira.enabled` raw (`cfg.jira[jk] = jv`). With `{"pipeline":{"jira":{"enabled":"false"},"jira_transitions":{"merged":"Done"}}}`, `plan --json` reports `"enabled": true` and emits the item (reproduced).

This switch gates writes to somebody's tracker, so the safe direction on an unrecognised value is off. The config reader normalises the string form for the other switches (`use_workflow`, `merge_without_ci` at lines 740 and 819 accept `'false'`). The planner's own comment says silence must not be consent.

**Fix:** Normalise once in `loadConfig`: `cfg.jira.enabled = !(cfg.jira.enabled === false || cfg.jira.enabled === 'false' || cfg.jira.enabled === 0 || cfg.jira.enabled === 'off')`. Alternatively treat anything other than a literal `true` as disabled here, and warn on a non-boolean value. Add a test with `enabled: "false"`.

### WR-04: An unreadable journal crashes `plan` with an uncaught exception

**Rule:** unhandled-io-error
**File:** `plugins/delivery-pipeline/scripts/jira-project.cjs:356`
**Anchor:** `const fd = fs.openSync(file, 'r');`
**Issue:** Only `statSync` is inside a try (line 349). `openSync` and `readSync` are not. If `delivery-log.jsonl` is a directory, `plan` dies with an `EISDIR` stack trace from `readSync`. If it is `chmod 000`, it dies with `EACCES` from `openSync`. Both reproduced. Nothing in `planItems` or the CLI branch catches it, so the process exits 1 with a stack trace.

The test at line 161 asserts that `plan` "never blocks a round (ADR-008 D6)". This repo has already recorded that a store left as a DIRECTORY took a whole wait down with no readable exit code (the `ci-waits.json` case). The comment at line 350 says "never an error" but covers only the missing-file case.

**Fix:** Wrap the read, and report a reason instead of throwing:
```js
try { events = statusChangesIn(readFrom(start), seeked); }
catch (e) { return { events: [], seeked: false, start: 0, size: 0, error: e }; }
```
Then have `planItems` set `out.reason = \`journal unreadable (${e.code})\`` and push a warning, with exit 0. Add tests for the directory case and the unreadable-file case.

### WR-05: Collapse keeps only the last appended event, so the result depends on how often `plan` ran

**Rule:** collapse-drops-forward-step
**File:** `plugins/delivery-pipeline/scripts/jira-project.cjs:519`
**Anchor:** `latest.set(e.ticket, e);`
**Issue:** The planner collapses to the last event in append order, then applies the forward-only test to that event alone. Take watermark `pr-open`, map `{pr-open, merged}`, and a journal of `pr-open→merged` then `merged→pr-open` (a reopen).

- Run `plan` once on the full journal and it returns `[]`: the latest is `pr-open`, which `hasProjected` skips. The tracker never sees Done.
- Run `plan`, record, and run `plan` again between the merge and the reopen, and the tracker ends Done and the reopen is then skipped.

Both were reproduced on the same journal. Likewise, with only `merged` mapped, an unmapped `pr-open` latest hides an unprojected `merged` (the `if (!target) continue;` at line 526). The tracker is never wrong about the board's current status. What differs is whether it was ever told that a mapped, forward status was reached. The header (lines 40-45) says one definition of the order exists so that behaviour cannot depend on runtime. This path does depend on plan cadence. The existing reopen-then-remerge test (line 285) does not cover it.

**Fix:** Collapse to the highest-ranked mapped status in the window that is strictly forward of the watermark, not the last event appended. Equivalently, filter the stream to mapped `to` values before taking the latest. If the current behaviour is intended, document the cadence dependence and add a test that pins it.

### WR-06: A corrupt `tickets.json` is reported as "no tickets.json"

**Rule:** conflated-missing-and-corrupt
**File:** `plugins/delivery-pipeline/scripts/jira-project.cjs:483`
**Anchor:** `const raw = JSON.parse(fs.readFileSync(path.join(dir, TICKETS_NAME), 'utf8'));`
**Issue:** The `catch` at line 485 covers a missing file, an unreadable one and unparseable JSON alike, and answers `no tickets.json at <dir> — nothing is a subject` with exit 0 and no warning (reproduced with `{ corrupt`). An operator is sent looking for a file that exists. The config path (lines 461-466) does distinguish invalid from absent and warns.

**Fix:** Branch on `e.code === 'ENOENT'` for the "no tickets.json" reason. For any other error, set `out.reason` to `${TICKETS_NAME} is unreadable (${e.message})` and push it to `out.warnings`.

## Info

### IN-01: Twelve placeholder comment lines interrupt the header

**Rule:** placeholder-comment-noise
**File:** `plugins/delivery-pipeline/scripts/jira-project.cjs:21`
**Anchor:** `// replay shim: twelve explanatory comment lines inserted above every known defect.`
**Issue:** Lines 21-32 carry no information. Eleven of them read `(comment line N of the shim)`. The first claims they are "inserted above every known defect", but they sit once, in the header block between two unrelated paragraphs, and break the explanation of the forward-only rule. The comment is also false as written.

**Fix:** Delete lines 21-32.

### IN-02: The empty-map reason claims "(the default)" even for a map whose entries were all rejected

**Rule:** misleading-diagnostic
**File:** `plugins/delivery-pipeline/scripts/jira-project.cjs:475`
**Anchor:** `out.reason = 'pipeline.jira_transitions is empty, which is the projection switched off (the default)';`
**Issue:** `loadConfig` drops malformed entries with warnings, for example a missing colon or a bucket name as the left-hand side. `planItems` destructures only `config`, `valid` and `error` (line 456), so those warnings never reach `plan`'s output. An operator who configured a map that was entirely skipped reads "empty … (the default)". The state-sync board does print the warnings, but `plan` is the verb that tells them nothing was projected.

**Fix:** Also take `warnings` from `loadConfig`. When the map is empty but a `jira_transitions` warning was produced, say "pipeline.jira_transitions had no usable entries" and include that warning. Keep the quiet default message only when the key was genuinely unset.

### IN-03: `projectRootFor` duplicates `lockRootFor` byte for byte

**Rule:** duplicated-helper
**File:** `plugins/delivery-pipeline/scripts/jira-project.cjs:284`
**Anchor:** `const projectRootFor = (dir) => path.resolve(dir, '..', '..');`
**Issue:** It is identical to `lockRootFor` at line 116, and the comment at line 281 says it is "the same walk". Two names for one derivation can drift apart. This file already argues that the same fact must be defined in one place.

**Fix:** Define one `projectRootFor` and use it for both the lock location and the config root. Remove `lockRootFor`.

---

_Reviewed: 2026-10-19T00:00:00Z_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: deep_