---
phase: 29-tracker-projection
reviewed: 2026-10-19T00:00:00Z
depth: deep
files_reviewed: 2
files_reviewed_list:
  - plugins/delivery-pipeline/scripts/jira-project.cjs
  - tests/unit/jira-project.test.cjs
findings:
  critical: 1
  warning: 5
  info: 5
  total: 11
status: issues_found
---

# Phase 29: Code Review Report

**Reviewed:** 2026-10-19T00:00:00Z
**Depth:** deep
**Files Reviewed:** 2
**Status:** issues_found

## Summary

I reviewed the new `plan` verb in `jira-project.cjs` and its unit tests. I traced it through `pipeline-config.cjs` (`loadConfig`, `normalizeJiraTransitions`), `lock.cjs`, `state-sync.cjs` (the `status_change` writer), `validate-graph.cjs` (the `tickets.json` shape and the `jira` field) and `front.cjs` (the other journal reader).

The core algorithm holds up. Collapsing to the latest event is correct. The suffix-window argument is sound: any suffix window that contains at least one event of a ticket also contains that ticket's latest event. The forward-only and exactly-once logic is also sound.

The defects are in what surrounds that core. They are the inputs the planner trusts, the places it fails open, and a suppression record that cannot lift when the operator fixes the cause.

I confirmed the first five findings by running the module against throwaway fixtures in `/tmp`. Nothing in the checkout was modified.

## Critical Issues

### CR-01: A corrupt or unreadable watermark store is read as "nothing projected yet", so `plan` re-emits every transition

**Rule:** fail-open-on-error
**File:** `plugins/delivery-pipeline/scripts/jira-project.cjs:144`
**Anchor:** `return { tickets: {} };`
**Issue:** `load()` collapses every failure into an empty store. That covers ENOENT, EACCES, truncated JSON and git conflict markers. The same fallback applies when the JSON parses but `raw.tickets` is falsy, a string or an array.

An empty store is exactly the first-run state, so `planItems` sees no watermarks. It reads the whole journal and emits a pending projection for every keyed ticket's latest mapped status. The acting agent then re-transitions tickets that were already projected, or that a person has since moved on the board.

I reproduced this. A store whose JSON was cut off mid-record, for a ticket already at `merged`, produced `items: 1` with `warnings: 0`.

This is realistic and not just theoretical. CLAUDE.md records that `.planning/graph/` is tracked on some branches, so a merge conflict inside `jira-projection.json` yields invalid JSON. The comment at line 181 even states the consequence ("re-projects everything") and treats it as acceptable.

The file applies ADR-004 D2 ("a corrupt configuration permits no mutation") to the config, but not to its own exactly-once guarantee. `mutate()` goes through the same `load()`, so the next `markProjected` also overwrites the corrupt file with a one-record store. That destroys every other watermark.

`load()` also returns `raw` untouched when `tickets` is truthy but sibling keys exist, and drops `raw` entirely (including `unreachable`) when `tickets` is missing. Both are shape accidents of the same one-line normalisation.

**Fix:**
```js
function load(dir = GRAPH_DIR) {
  let text;
  try { text = fs.readFileSync(storeFile(dir), 'utf8'); }
  catch (e) { if (e.code === 'ENOENT') return { tickets: {} }; throw e; }
  let raw;
  try { raw = JSON.parse(text); }
  catch (e) {
    throw new Error(`${storeFile(dir)} is not valid JSON (${e.message}) — refusing to read it as "nothing projected"`);
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`${storeFile(dir)} is not a JSON object`);
  }
  const t = raw.tickets;
  raw.tickets = t && typeof t === 'object' && !Array.isArray(t) ? t : {};  // keep sibling keys such as `unreachable`
  return raw;
}
```
In `planItems`, catch the throw and answer `enabled: false` with the message in `warnings`, which is the same loud-but-exit-0 shape the invalid-config branch already uses. `mutate()` then refuses to overwrite a store it cannot read.

## Warnings

### WR-01: `pipeline.jira.enabled` only switches off for a literal boolean `false`

**Rule:** unnormalized-config-flag
**File:** `plugins/delivery-pipeline/scripts/jira-project.cjs:455`
**Anchor:** `if (config.jira.enabled === false) {`
**Issue:** `loadConfig` copies `jira.*` values verbatim (`cfg.jira[jk] = jv`) and never normalises `enabled`. In the same function, `merge_without_ci`, `use_workflow`, `sentinel`, `auto_merge` and `fable` all accept the string spellings a hand-edited `config.json` acquires.

I reproduced this with `{"jira":{"enabled":"false"},"jira_transitions":{"merged":"Done"}}`. `planItems` returned `enabled: true` with one pending item.

The file's own posture is "silence is not consent to write into someone's tracker". Here an operator who wrote `"false"`, `"off"`, `0` or `null` has the projection stay on.

This is the only code reader of `jira.enabled`, so the strictness decision belongs here or in `loadConfig`. It should not be left to an incidental `===`.

**Fix:** Normalise once in `loadConfig`, for example `true|'true'` → true and `false|'false'` → false. Anything else should produce a warning and fall back to the safe value, which is off for a tracker write. In `planItems`, use a positive check such as `if (config.jira.enabled !== true)`.

### WR-02: An unreachable report is never lifted by the fixes it asks for (the mapping or the issue key)

**Rule:** stale-suppression-never-lifts
**File:** `plugins/delivery-pipeline/scripts/jira-project.cjs:422`
**Anchor:** `if (rec.to !== item.to) return false;`
**Issue:** `unreachableSuppressed` lifts only on a different `to` or a strictly newer event `ts`. The report exists so an operator can fix why the transition was unreachable. The two fixes are changing `pipeline.jira_transitions` to a status the workflow actually offers (`offered` is recorded for exactly that purpose) and correcting a mistyped `delivery.jira` key. Neither fix changes `to` or produces a new `status_change`.

I reproduced this. A record with `to: merged` and the event's `ts` stayed suppressed (`items: 0`) after the mapping changed from `Done` to `Closed`. The ticket stays suppressed until the board happens to move, which may be never.

The comment at 414-417 says "a suppression that never lifts is worse than one round of noise". `unreachableRecord` stores `key` but not `target_status`, and neither value is compared.

**Fix:** Add `target_status` to `unreachableRecord`. In `unreachableSuppressed`, return false when `rec.target_status !== item.target_status` or `rec.key !== item.key`, in addition to the existing `to` and `ts` tests. Pin both cases in the unit tests. Adding the field now costs one line. Adding it after `record --unreachable` ships needs a migration of stored records.

### WR-03: A `status_change` with no `to` miscounts coverage in the seek loop and silently ends the backward walk early

**Rule:** undefined-equals-undefined
**File:** `plugins/delivery-pipeline/scripts/jira-project.cjs:374`
**Anchor:** `if (need.get(e.ticket) === e.to) { seen.add(e.ticket); covered++; }`
**Issue:** For a ticket that is not a subject, `need.get(e.ticket)` is `undefined`. If the record has no `to` (a hand-appended, torn or foreign record), `undefined === undefined` is true. That counts a non-subject towards `covered`, so `covered === need.size` can hold while a real subject's events are still outside the window.

`statusChangesIn` (line 310) admits such records because it checks only `event`, `ticket` and not `to`. `front.cjs:1056` guards `!e.to` for exactly this reason.

I reproduced the silent loss. The fixture was a 168 KB journal. T-2 has a watermark of `pending` and a pending `pr-open` event far from the end. T-1 has an anchor event in the last 64 KB. One line `{"event":"status_change","ticket":"T-X"}` was appended. `planItems` returned no items, with `seeked: true` and `bytes_read: 65536`. Without that line it returned `T-2:pr-open`. This is the "loses transitions without saying so" outcome the file's header exists to prevent.

The same missing guard has a second effect. A trailing `to`-less event for a subject becomes `latest` (lines 504-508). `map[undefined]` is then unmapped and silently skipped, which masks the valid earlier transition. I reproduced this too (`items: 0`).

**Fix:**
```js
if (!e || e.event !== 'status_change' || !e.ticket || !e.to) continue;   // statusChangesIn
...
for (const e of events) {
  if (!need.has(e.ticket) || seen.has(e.ticket)) continue;               // readTransitions
  if (need.get(e.ticket) === e.to) { seen.add(e.ticket); covered++; }
}
```

### WR-04: A missing or corrupt ticket graph is a quiet exit-0 no-op, and a config reason can hide the real cause

**Rule:** silent-failure-on-missing-input
**File:** `plugins/delivery-pipeline/scripts/jira-project.cjs:474`
**Anchor:** `out.reason = \`no ${TICKETS_NAME} at ${dir} — nothing is a subject\`;`
**Issue:** This has three parts:

1. The `catch` treats an unparseable `tickets.json` the same as an absent one. `state-sync.cjs:256-261` distinguishes the two and fails loudly. I reproduced it: a `{bad` file reports "no tickets.json at … — nothing is a subject", which is a false statement about the file.
2. Neither case becomes a warning. CLAUDE.md describes the recurring defect as a script resolving `.planning/graph` from `process.cwd()` for a caller that stands in a worktree or the wrong checkout. The sibling stores refuse loudly for that reason. `plan` is read-only, but the cost here is that a projection which never runs says nothing.
3. The config is read from `projectRootFor(dir)` before the graph is checked. Run without `--graph` from a directory that has no `.planning/config.json`, and the config answers first with "jira_transitions is empty, which is the projection switched off (the default)". The reader is told the wrong cause. This also fires on the very next missing-config condition, so the true cause (wrong directory) is never reported.

**Fix:** When `!GRAPH_EXPLICIT && dir === GRAPH_DIR` and `tickets.json` is missing, push a one-line entry into `out.warnings` naming the directory and the `--graph` / `SHIPYARD_GRAPH_DIR` remedy, and do this before the config check. Split ENOENT from a parse failure. A parse failure should be a warning with the parser message, as in the invalid-config branch.

### WR-05: Jira keys go from `tickets.json` to the acting agent with no shape check

**Rule:** unvalidated-external-identifier
**File:** `plugins/delivery-pipeline/scripts/jira-project.cjs:479`
**Anchor:** `if (t && t.jira) keyOf.set(id, String(t.jira));`
**Issue:** `validate-graph.cjs:177` stringifies whatever `delivery.jira` holds (`String(delivery.jira)`) and never checks its shape. `String` of a YAML object gives `"[object Object]"`, a bare number gives `"1234"`, and a value may contain newlines. The planner passes it on unchanged as `item.key` in the JSON output and in the human-readable line `"  ${it.ticket} ${it.key}: …"`.

The next consumer is an LLM agent that performs a write on an external tracker using that string. The file argues deterministic gates must not be replaced by a model response (ADR-008 D4). A malformed or crafted value can inject text into the agent's context, or target the wrong issue.

**Fix:** Validate against the tracker's key grammar before accepting a subject. For example, `/^[A-Z][A-Z0-9_]+-\d+$/` should match `delivery.jira`, and optionally the prefix should match `config.jira.project`. Skip a non-matching key and add a warning naming the ticket. Never print an unvalidated value.

## Info

### IN-01: `projectRootFor` is a second copy of `lockRootFor`

**Rule:** duplicated-helper
**File:** `plugins/delivery-pipeline/scripts/jira-project.cjs:272`
**Anchor:** `const projectRootFor = (dir) => path.resolve(dir, '..', '..');`
**Issue:** `lockRootFor` (line 104) has an identical body, and the comment above this line admits it is "the same walk". Both mean "the project root of this graph dir". If one is ever corrected, for example for a non-standard graph layout, the lock and the config will point at different projects.
**Fix:** Keep one definition (`projectRootFor`) and use it for the lock as well.

### IN-02: `loadConfig` warnings are discarded, so a fully mis-typed map reads as "the default"

**Rule:** swallowed-warnings
**File:** `plugins/delivery-pipeline/scripts/jira-project.cjs:444`
**Anchor:** `const { config, valid, error } = loadConfig(root);`
**Issue:** `loadConfig` returns `warnings`, for example `jira_transitions."mergd" is not a ticket status — skipped`. `planItems` ignores them. If every entry of a configured map is skipped, `plan` says "pipeline.jira_transitions is empty, which is the projection switched off (the default)". That is false: the operator configured something and every entry was dropped.
**Fix:** When the resulting map is empty but the raw config had `jira_transitions`, append the relevant `jira_transitions` warnings to `out.warnings`. Keep the quiet path for the genuinely unconfigured case.

### IN-03: Any `statSync` failure is reported as "no journal"

**Rule:** swallowed-error-class
**File:** `plugins/delivery-pipeline/scripts/jira-project.cjs:337`
**Anchor:** `try { size = fs.statSync(file).size; } catch {`
**Issue:** The comment justifies the catch for a project that has not synced yet, which is ENOENT. EACCES, EIO and ENOTDIR on the graph path also return `{ events: [] }`, so a broken journal reads as "nothing to project".
**Fix:** Return empty only for `e.code === 'ENOENT'`. For other errors, surface a warning and still exit 0, which matches the "never blocks a round" contract.

### IN-04: No test pins the "every watermarked subject" half of the seek's stop condition

**Rule:** untested-branch
**File:** `tests/unit/jira-project.test.cjs:351`
**Anchor:** `test('with every subject watermarked the read SEEKS, and still reaches the watermarked event', () => {`
**Issue:** Every seek test uses one watermarked subject. The only multi-subject case (line 411) has an unwatermarked subject, so it takes the whole-file path and never reaches the `covered === need.size` aggregate. A mutation to `covered > 0`, or to any "first subject covered" shortcut, passes the whole file. That rule is load-bearing, because a window that covers subject A but not subject B drops B's latest transition. It is also the arithmetic WR-03 shows going wrong.
**Fix:** Add a fixture with two watermarked subjects. One has its anchor in the last 64 KB. The other has its anchor and its pending transition far earlier. Assert both are emitted and that `seeked` is true or false as expected. Add a second case with a `to`-less `status_change` for a non-subject ticket (the WR-03 reproduction).

### IN-05: The "no network" token sweep misses `node:`-prefixed and other network builtins

**Rule:** weak-guard-pattern
**File:** `tests/unit/jira-project.test.cjs:626`
**Anchor:** `/require\(['"](https?|net|tls|dgram)['"]\)/]) {`
**Issue:** The test is documented as stronger than a sandboxed run because it "covers every path". The `require` pattern only matches the bare module names `http`, `https`, `net`, `tls` and `dgram`. `require('node:https')`, `require('node:net')`, `dns`, `http2`, `worker_threads` and a dynamic `import('node:http')` all pass. A future "small helper" that adds a client would go unnoticed, which is the regression the sweep exists to catch.
**Fix:** Broaden to `/(?:require|import)\(\s*['"](?:node:)?(?:https?|http2|net|tls|dgram|dns|worker_threads)['"]/`, and add `\bimport\s*\(` and `\bglobalThis\b`.

---

_Reviewed: 2026-10-19T00:00:00Z_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: deep_