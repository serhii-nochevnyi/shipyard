---
phase: 29-tracker-projection
reviewed: 2026-10-19T12:00:00Z
depth: deep
files_reviewed: 2
files_reviewed_list:
  - plugins/delivery-pipeline/scripts/jira-project.cjs
  - tests/unit/jira-project.test.cjs
findings:
  critical: 0
  warning: 6
  info: 3
  total: 9
status: issues_found
---

# Phase 29: Code Review Report

**Reviewed:** 2026-10-19T12:00:00Z
**Depth:** deep
**Files Reviewed:** 2
**Status:** issues_found

## Summary

I reviewed `git diff 009dee0143 HEAD`. It adds the `plan` verb (`planItems`, `readTransitions`, `statusChangesIn`, and the unreachable-suppression helpers) to `jira-project.cjs`, plus its unit suite. I traced each piece against its callers and callees: `pipeline-config.cjs` (`loadConfig`, `normalizeJiraTransitions`, `TICKET_STATUSES`), `state-sync.cjs` (the `status_change` writer), `validate-graph.cjs` (the `tickets.json` shape), `lock.cjs`, `front.cjs` (the sibling journal reader), and `graph-dir.cjs`.

The core algorithm holds up. The suffix window always contains each watermarked ticket's true latest event. The collapse, forward-only comparison, and conditional first-line drop are correct. The weaknesses are all on the boundary between "quiet common case" and "something is broken", in a script whose output an agent turns into tracker writes:

- A corrupt watermark store reads as empty.
- An unreachable report does not lift when the operator fixes its cause.
- The key and the off-switch are trusted without validation.
- Config warnings are discarded.
- A mis-resolved graph is indistinguishable from "nothing to do".

No blocker was found.

## Warnings

### WR-01: A corrupt or conflicted watermark store is read as "nothing projected yet", so the planner re-offers every ticket

**Rule:** fail-open-on-error
**File:** `plugins/delivery-pipeline/scripts/jira-project.cjs:486`
**Anchor:** `const store = load(dir);`
**Issue:** `load()` (line 139) catches every error, including a JSON parse failure, and returns `{ tickets: {} }`. That was tolerable while the store had no consumer. `planItems` now makes the store the sole driver of writes to someone's tracker. `.planning/graph/` is git-tracked in this repo (`git ls-files .planning/graph` lists its siblings), and epic refreshes merge `origin/<base>` into ticket branches constantly. So a merge-conflicted or hand-damaged `jira-projection.json` is a realistic input. A file with conflict markers parses to an empty store. `hasProjected` then answers false for every subject, and `plan` offers every keyed ticket's latest `to` again. The agent re-transitions the whole board, possibly dragging issues someone has since moved. The next `mutate` call also loads the empty store and overwrites the damaged file, destroying the other watermarks. The same function already refuses on a corrupt config ("ADR-004 D2: a corrupt configuration permits no mutation"). It does not apply the same rule to the store, whose only job is to prevent double projection.
**Fix:** Distinguish "absent" (ENOENT, which is an empty store) from "present but unreadable or wrong shape" (a corrupt store). In `planItems`, treat the corrupt case like the invalid-config branch:
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
// planItems: if (error) { out.enabled = false; out.reason = `${STORE_NAME} is unreadable (${error.message}) — refusing to project against an unknown watermark`; out.warnings.push(out.reason); return out; }
```
Give `mutate` the same refusal, so a damaged store is never silently replaced.

### WR-02: An unreachable report is lifted only by a newer event, so fixing its cause (key or target status) does not lift it, and for the terminal `merged` status it may never lift

**Rule:** suppression-never-lifts
**File:** `plugins/delivery-pipeline/scripts/jira-project.cjs:422`
**Anchor:** `if (rec.to !== item.to) return false;`
**Issue:** The docblock promises "the block lifts by itself, and nobody has to remember to clear it", and says a suppression that never lifts is "worse than one round of noise". `unreachableSuppressed` compares only `to` and `ts`. An "unreachable" report means the tracker offered no transition to the mapped target status. That is fixed by correcting the ticket's `delivery.jira` key, or by renaming the target in `pipeline.jira_transitions`, or by fixing the Jira workflow. None of these touches the journal. The item stays withheld until the ticket produces a newer `status_change`. For `to: merged`, the terminal status, that may never happen. The record already stores `key` but the check ignores it, and it does not store the target status at all. The planner has no clear verb, so a ticket stuck at `merged` stays unprojected indefinitely, silently.
**Fix:** Record `target_status` in `unreachableRecord`, and lift when either the key or the target differs from what was reported:
```js
function unreachableRecord({ to, ts, key = null, target_status = null, offered = null }) {
  return { to, ts: ts || null, key, target_status, offered };
}
// unreachableSuppressed:
if (rec.key && rec.key !== item.key) return false;
if (rec.target_status && rec.target_status !== item.target_status) return false;
```

### WR-03: The Jira key and its project are not validated before they become an instruction for a tracker write

**Rule:** unvalidated-external-identifier
**File:** `plugins/delivery-pipeline/scripts/jira-project.cjs:479`
**Anchor:** `if (t && t.jira) keyOf.set(id, String(t.jira));`
**Issue:** `delivery.jira` comes from plan frontmatter. `validate-graph.cjs:177` only does `String(delivery.jira)`, and `planItems` copies it verbatim into `item.key`. That item is the work list an agent with write access to the tracker acts on. Any string flows through unchanged, whether it is free text, an instruction-shaped string, or a key from a different Jira project. `config.jira.project` exists in the config but the planner ignores it. Anyone who can land a plan file can therefore aim a status transition at an arbitrary issue in the tenant, or put text in front of the acting agent. Skipping such a ticket is cheap and fits the file's own posture ("refuse an unproven write into somebody's tracker").
**Fix:** Accept only issue-key-shaped values, and require the configured project prefix when one is set. Skip the rest with a warning, because a malformed subject is a defect, not the quiet common case:
```js
const KEY_RE = /^[A-Z][A-Z0-9_]*-\d+$/;
const proj = config.jira.project;
const key = String(t.jira).trim();
if (!KEY_RE.test(key) || (proj && !key.startsWith(`${proj}-`))) {
  out.warnings.push(`${id}: delivery.jira "${key}" is not a ${proj ? `${proj}-` : ''}issue key — not projected`);
  continue;
}
keyOf.set(id, key);
```

### WR-04: `pipeline.jira.enabled` is honoured only as a literal boolean `false`, so `"false"`, `0` or `null` leave the projection on

**Rule:** off-switch-fails-open
**File:** `plugins/delivery-pipeline/scripts/jira-project.cjs:455`
**Anchor:** `if (config.jira.enabled === false) {`
**Issue:** `loadConfig` copies `jira.*` values without coercion (`cfg.jira[jk] = jv`, `pipeline-config.cjs:615`). A hand-edited `config.json` with `"enabled": "false"`, `0`, or `null` is not `=== false`. The planner treats it as enabled whenever `jira_transitions` is non-empty, which defeats an operator's attempt to turn the feature off. The rest of the config reader treats this situation explicitly. `use_workflow` accepts `false` and `'false'`. `merge_without_ci` coerces the string and warns on any other non-boolean ("the string a hand-edited JSON file acquires"). This knob, which guards writes to an external system, gets neither the coercion nor the warning.
**Fix:** Normalise `jira.enabled` in `loadConfig` the way `merge_without_ci` is normalised, or accept the string and zero forms here:
```js
const en = config.jira.enabled;
if (en === false || en === 'false' || en === 0 || en === null) { ... off ... }
```
Prefer a coercion that also warns on any value that is not a boolean.

### WR-05: `planItems` discards `loadConfig`'s warnings, so a malformed `jira_transitions` is reported as "the default"

**Rule:** diagnostic-discarded
**File:** `plugins/delivery-pipeline/scripts/jira-project.cjs:444`
**Anchor:** `const { config, valid, error } = loadConfig(root);`
**Issue:** `normalizeJiraTransitions` skips malformed entries with specific warnings, such as a bucket name used as a status (`"merge:Done"`), a missing colon (`"merged Done"`), or an empty target. `planItems` reads only `config`, `valid` and `error`, so those warnings are dropped. When every entry is skipped, the map is empty, and the planner answers `pipeline.jira_transitions is empty, which is the projection switched off (the default)`. That statement is false for an operator who did configure it, and it is the quiet message the file elsewhere says must not stand in for a misconfiguration. Printed through `plan`, the typo and the unconfigured project look identical.
**Fix:** Destructure `warnings`, forward those about the projection keys, and do not call the empty map "the default" when one was present:
```js
const { config, valid, error, warnings } = loadConfig(root);
const mine = (warnings || []).filter((w) => /jira/.test(w));
out.warnings.push(...mine);
// empty-map branch: out.reason = mine.length ? 'pipeline.jira_transitions has no usable entry (see warnings)' : '… (the default)';
```

### WR-06: The `plan` verb resolves its graph from `cwd` and, unlike the write path, never refuses when none is found

**Rule:** cwd-resolved-graph-silent
**File:** `plugins/delivery-pipeline/scripts/jira-project.cjs:565`
**Anchor:** `const out = planItems();`
**Issue:** The planner comment (line 267) says the verb's caller "stands wherever the main loop left it". The default `GRAPH_DIR` is still `process.cwd()/.planning/graph`. The no-ticket-graph refusal is applied only inside `mutate`. `CLAUDE.md` records that the main loop's session stays parked in whatever checkout it was opened in, and that this checkout carries its own tracked, possibly stale `.planning/graph/`. Run there without `--graph`, `plan` reads that checkout's journal and watermark store. If the directory has no `tickets.json`, it prints `nothing to project — no tickets.json at …` and exits 0 with `enabled: true`. The projection never runs, and the exit code and structured fields look the same as the normal quiet case. The convention for the cwd-resolving scripts (`state-sync`, `sentinel`) is to fail loudly on a missing graph. This verb is cwd-rule without the loudness.
**Fix:** When the graph is not explicit and `tickets.json` is absent at the resolved dir, report it as a warning (`out.warnings`, and set `enabled: false`) rather than as a reason, or apply the same refusal text as `mutate`. If a non-zero exit would block the round, a stderr warning is the minimum.

## Info

### IN-01: `statusChangesIn` accepts events with no `to`, and `undefined === undefined` then counts as a covered anchor

**Rule:** missing-field-guard
**File:** `plugins/delivery-pipeline/scripts/jira-project.cjs:310`
**Anchor:** `if (!e || e.event !== 'status_change' || !e.ticket) continue;`
**Issue:** `front.cjs:1056` filters `!e.to` for the same stream. Here a `status_change` with no `to` for a non-subject ticket makes `need.get(e.ticket) === e.to` evaluate `undefined === undefined` in the coverage loop (line 374). `covered` is incremented for a ticket that is not in `need`. That can reach `need.size` early and end the backward walk before a real anchor is in the window, silently dropping later transitions. That is the defect the function exists to prevent. State-sync always writes `to`, so this needs a malformed or foreign journal line.
**Fix:** Require `to` where events are parsed, as `front.cjs` does: `|| !e.ticket || !e.to`. Alternatively guard the coverage test with `need.has(e.ticket) &&`.

### IN-02: Two tickets sharing one Jira key get independent, possibly conflicting items

**Rule:** unchecked-uniqueness
**File:** `plugins/delivery-pipeline/scripts/jira-project.cjs:478`
**Anchor:** `for (const [id, t] of Object.entries(tickets)) {`
**Issue:** Watermarks are per ticket and `keyOf` is ticket → key. Nothing (neither `validate-graph` nor the planner) prevents two tickets from carrying the same `delivery.jira`. Both then produce items for one issue in the same round. For example, T-1 `merged` and T-2 `pr-open` yield `Done` and `In Progress` for the same key. Sorted by ticket id and performed in order, the second leaves the issue behind the first, which is the backwards move the forward-only rule is meant to prevent. The planner could detect this cheaply.
**Fix:** After building `keyOf`, group by key. Where a key has more than one subject, emit a warning and either skip all of them or keep only the highest-ranked `to` per key.

### IN-03: The seek tests cannot tell "every watermark covered" from "any watermark covered", though the header claims each rule is pinned

**Rule:** mutation-survives-test-gap
**File:** `tests/unit/jira-project.test.cjs:351`
**Anchor:** `test('with every subject watermarked the read SEEKS, and still reaches the watermarked event', () => {`
**Issue:** Despite the title, this fixture and the "anchor is the projected EVENT" fixture each have exactly one subject. With one subject, the stop condition `covered === need.size` is indistinguishable from `covered >= 1`. A window that stops at the nearest of several anchors rather than the oldest also passes every test. The docblock says the scan reads "from the OLDEST watermark forward". A regression to "any" or "nearest" would silently drop transitions for the farther-anchored subject, and the suite would stay green.
**Fix:** Add a case with two watermarked subjects whose anchors sit at different depths. Put one anchor inside the first 64 KB window and the other beyond it, and give each a newer event. Assert that both items are emitted.

---

_Reviewed: 2026-10-19T12:00:00Z_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: deep_