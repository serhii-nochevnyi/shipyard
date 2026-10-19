---
phase: 29-the-tracker-is-a-projection-and-a-projection-is-driven (T-29-03 watermark store, T-29-04 planner)
reviewed: 2026-10-19T12:10:00Z
depth: deep
files_reviewed: 2
files_reviewed_list:
  - plugins/delivery-pipeline/scripts/jira-project.cjs
  - tests/unit/jira-project.test.cjs
findings:
  critical: 1
  warning: 7
  info: 5
  total: 13
status: issues_found
---

# Phase 29: Code Review Report

**Reviewed:** 2026-10-19T12:10:00Z
**Depth:** deep
**Files Reviewed:** 2
**Status:** issues_found

## Summary

Reviewed `jira-project.cjs` (the watermark store plus the planner) and its unit test, and traced their imports and data sources. The cross-file checks covered:

- `pipeline-config.cjs`: `loadConfig`, `normalizeJiraTransitions` and `TICKET_STATUSES`.
- `lock.cjs`: the `withLock` and `writeAtomic` signatures.
- `state-sync.cjs`: the only writer of `status_change`.
- `validate-graph.cjs`: confirmed that `tickets.json` carries `jira` at the top level of each ticket.
- The sibling stores `drift-record`, `escalation-record` and `record-stores.test.cjs`, which holds the T-29-03 store tests.

I did not take the green test run (34/34) as evidence of correctness. I reproduced each finding below with a scratch script outside the repo, and quote the observed output in the finding.

The data contract is sound. `jira` is at the top level of `tickets.json`, `state-sync` writes only the four statuses in `TICKET_STATUSES`, and the `withLock`/`writeAtomic` calls match `lock.cjs`. No network, credential or injection surface exists in these two files.

The defects are about trust in durable input and honesty of output:

- The write path destroys the watermark store whenever it fails to parse.
- The planner throws away the config warnings that explain why it is idle, and then reports "the default".
- `plan` run from the wrong cwd silently reports "off".
- The `--graph` parser still has two spellings that skip the refusal the file says it enforces.
- The collapse rule discards a status the operator explicitly mapped.

No `<structural_findings>` block was supplied, so there is no fallow section.

## Critical Issues

### CR-01: An unparseable `jira-projection.json` is silently replaced on the next write, destroying every watermark

**File:** `plugins/delivery-pipeline/scripts/jira-project.cjs:139-146` (cause), `:182-206` (write path); the read side repeats it at `:486`
**Issue:** `load()` wraps `readFileSync` and `JSON.parse` in one `catch {}` and returns `{ tickets: {} }` for ENOENT, EACCES, EISDIR and a corrupt file alike. The docstring says "a missing or unreadable file is an EMPTY store, not an error". That is true for ENOENT only.

`mutate()` calls the same `load(dir)` inside the lock, applies `fn`, and `writeAtomic`s the result. A store that exists but does not parse is therefore overwritten with a store holding only the one ticket being marked.

The unparseable store is not exotic. This file lives in `.planning/graph/`, which some projects track in git, so merge-conflict markers produce it. A hand edit or a restore from a partial backup produces it too. `writeAtomic` rules out only self-inflicted tearing.

Reproduced:
```
store on disk (broken JSON): {"tickets":{"T-1":{projected_to:"merged"},"T-2":{projected_to:"merged"} ...
markProjected('T-3','pr-open',…) -> written:true
store now: {"T-3":{…}}        <- T-1 and T-2 watermarks are gone
```
On the next `plan`, T-1 and T-2 (already `Done` on the tracker) are emitted again. That is the "transitioned twice on somebody's board" outcome this module's header says it exists to prevent.

The planner has the same blind spot (`:486`). It treats a corrupt store as "nothing projected yet", re-emits every keyed ticket, and says nothing. It applies the opposite rule to a corrupt *config* (ADR-004 D2: "a corrupt configuration permits no mutation") — and the watermark is no less a precondition for mutating the tracker.

**Fix:** Distinguish "absent" from "unreadable". Refuse on the write path and fail closed in the planner:
```js
function load(dir = GRAPH_DIR, { strict = false } = {}) {
  let text;
  try { text = fs.readFileSync(storeFile(dir), 'utf8'); }
  catch (e) {
    if (e.code === 'ENOENT') return { tickets: {} };
    if (strict) throw e;
    return { tickets: {}, unreadable: e.message };
  }
  let raw;
  try { raw = JSON.parse(text); }
  catch (e) {
    if (strict) throw new Error(
      `${storeFile(dir)} is not valid JSON (${e.message}) — refusing to overwrite the only record of what was projected. ` +
      'Repair it or move it aside deliberately.');
    return { tickets: {}, unreadable: e.message };
  }
  return raw && typeof raw === 'object' && !Array.isArray(raw) && raw.tickets && typeof raw.tickets === 'object'
    ? raw : { tickets: {}, ...(raw && typeof raw === 'object' ? { ...raw, tickets: {} } : {}) };
}
// mutate(): const store = load(dir, { strict: true });
// planItems(): if (store.unreadable) { out.enabled = false; out.reason = `watermark store unreadable (${store.unreadable}) — nothing is projected`; out.warnings.push(out.reason); return out; }
```
Add a test with a torn, a conflict-marker and an EISDIR store.

## Warnings

### WR-01: `planItems` discards every warning `loadConfig` produced, then reports a mistyped mapping as "the default"

**File:** `plugins/delivery-pipeline/scripts/jira-project.cjs:444` (destructure), `:460-465` (reason)
**Issue:** `loadConfig` returns `{config, warnings, valid, error}`, and `normalizeJiraTransitions` goes to the trouble of warning on each skipped entry. `planItems` destructures only `{config, valid, error}`. A typo in the mapping leaves the map empty, so the planner answers with the quiet off-switch text.

Reproduced:
```
jira_transitions: { merge: 'Done' }     -> reason: "pipeline.jira_transitions is empty, which is the projection switched off (the default)"  warnings: []
jira_transitions: 'merged Done'          -> same reason, warnings: []
```
The message says "(the default)" about a config the operator explicitly wrote. The one sentence that would name the typo ("`merge` is not a ticket status — skipped") never reaches the operator. The header's "never warn on an off switch" rule covers the empty default, not a rejected entry.

**Fix:** Keep the config's warnings and surface them. They concern the input being malformed, not the quiet common case, and the empty default produces none.
```js
const { config, valid, error, warnings: cfgWarnings } = loadConfig(root);
out.warnings.push(...cfgWarnings.filter((w) => /jira/.test(w)));
```
Alternatively, when the map is empty AND a `jira_transitions` key is present in the raw config, drop the "(the default)" wording. Add a test with a mistyped key and assert the warning is non-empty.

### WR-02: Collapse runs before the mapping filter, so a status the operator mapped is never projected if the ticket moved past it between rounds

**File:** `plugins/delivery-pipeline/scripts/jira-project.cjs:502-531` (and the comment at `:511-512`)
**Issue:** `latest` is the last `status_change` of the ticket, whatever it is. The map is consulted only afterwards, and an unmapped latest `to` is dropped. The comment promises "an operator who mapped only `merged` asked for only `merged`", and the mirror case breaks that promise.

Reproduced: map `{ 'pr-open': 'In Review' }`, journal `pending→pr-open`, `pr-open→merged`, no watermark. Result: `items: []`, `reason: null`, with no signal at all. The operator who mapped only `pr-open` (for example because Jira's own GitHub integration closes the issue on merge) never gets the transition for a PR that opened and merged within one round. Any round gap longer than the PR's life, such as an overnight pause, triggers this.

**Fix:** Filter to mapped, forward-of-watermark events before taking the latest:
```js
for (const e of events) {
  if (!keyOf.has(e.ticket)) continue;
  if (!Object.prototype.hasOwnProperty.call(map, e.to) || !map[e.to]) continue;
  if (hasProjected(e.ticket, e.to, store)) continue;
  if (!earliest.has(e.ticket)) earliest.set(e.ticket, e);
  latest.set(e.ticket, e);
}
```
Note that `earliest`/`from` then reflects mapped events only. If collapsing to the strict latest status is the intended design, the comment at `:511` and ADR-008 must say so, and a test should pin it either way.

### WR-03: `plan` run from a cwd with no ticket graph exits 0 and says the feature is "off" — the false report this repo's CLAUDE.md names as its recurring defect

**File:** `plugins/delivery-pipeline/scripts/jira-project.cjs:441-465` (check order), `:564-580` (CLI)
**Issue:** The config check and the empty-map check come before the `tickets.json` check, and the `--graph` refusal exists only on the write path (`mutate`). `plan` is documented as called from wherever the main loop stands, including ticket worktrees that have no `.planning/`.

Reproduced from a bare directory with no flag:
```
$ node jira-project.cjs plan
nothing to project — pipeline.jira_transitions is empty, which is the projection switched off (the default)      exit=0
```
That is an affirmative, wrong statement about the project's configuration, when the truth is "I looked at the wrong directory". Human output also never names the directory looked at (only `--json` carries `graph`). A run that is stranded in the wrong cwd therefore looks like an unconfigured project, forever and quietly.

**Fix:** When `GRAPH_EXPLICIT` is false and `<dir>/tickets.json` is missing, fail loudly in the CLI for `plan` (mirror `mutate`'s message), or at minimum reorder so the missing graph is reported before any off-switch reason and print `graph: <dir>` in the human output.
```js
if (!GRAPH_EXPLICIT && !fs.existsSync(path.join(GRAPH_DIR, TICKETS_NAME))) fail(`no ticket graph at ${GRAPH_DIR} …`);
```

### WR-04: Two `--graph` spellings still resolve to a directory the parser claims to reject, and one of them skips the no-graph refusal on the write path

**File:** `plugins/delivery-pipeline/scripts/jira-project.cjs:59-85`
**Issue:** The block states "one spelling has to mean one PARSER", but it only catches an absent value and a value starting with `--`.

- `--graph ""`, the empty string a shell produces from `--graph "$GRAPH"` with `GRAPH` unset or empty: `val === ''` passes both checks, `GRAPH_EXPLICIT` becomes true, and `path.resolve('')` is the **cwd itself**, not `<cwd>/.planning/graph`. Reproduced: `markProjected('T-1','merged')` run with `--graph ""` wrote `jira-projection.json` straight into the cwd and exited 0, with the refusal exempted by `GRAPH_EXPLICIT`. That is the "written into the void where nothing reads it" outcome the guard exists to stop. `plan --graph ""` looks in the cwd and prints the false "(the default)" line from WR-03.
- `--graph=/path/to/graph`: indexOf does not match, so the flag is ignored and cwd resolution applies silently. No error, no usage text.

**Fix:**
```js
if (val === undefined || val === '' || val.startsWith('-')) fail(…);
// and reject the = spelling explicitly:
const eq = ARGV_ALL.find((a) => a.startsWith('--graph='));
if (require.main === module && eq) fail('use `--graph <dir>`, not `--graph=<dir>`');
```
The siblings (`drift-record.cjs:59`, `escalation-record.cjs`) share the same parser, so fix them in the same change or extract one helper into `graph-dir.cjs`.

### WR-05: The project root and the lock root are derived by a blind `dir/../..`, and the write guard is bypassed for any explicitly passed `dir`

**File:** `plugins/delivery-pipeline/scripts/jira-project.cjs:104`, `:190`, `:200`, `:272`, `:443-444`
**Issue:** `lockRootFor` and `projectRootFor` assume `dir` is `<project>/.planning/graph`. The refusal at `:190` fires only when `dir === GRAPH_DIR && !GRAPH_EXPLICIT`, so a library caller passing any other `dir` (as the tests do) gets no check at all, not even that `tickets.json` exists.

Reproduced with `markProjected(…, '<tmp>/graphdir')`: it created `<tmp>/graphdir/jira-projection.json` and a lock tree at `/tmp/.planning/graph/.locks`, outside the directory the caller named. Two unrelated graphs that share a grandparent then also share a lock. The docs say the lock is "beside the STORE".

For `plan`, a `--graph` outside that shape makes `loadConfig(root)` read the wrong `config.json` (or none, which reads as "feature off", see WR-03).

**Fix:** Validate the shape once, in one helper, and throw when it does not hold.
```js
function projectRoot(dir) {
  const rel = path.relative(path.resolve(dir, '..', '..'), dir).split(path.sep);
  if (rel.join('/') !== '.planning/graph') throw new Error(`--graph must be <project>/.planning/graph (got ${dir})`);
  return path.resolve(dir, '..', '..');
}
```
Use it for both `lockRootFor` and `projectRootFor`. Also see IN-01.

### WR-06: The exported `compareStatus` gives confident answers for unknown statuses, and in the unsafe direction

**File:** `plugins/delivery-pipeline/scripts/jira-project.cjs:112-129`
**Issue:** The header makes this comparator the single shared order that T-29-05 "and every later reader" must take. For an unknown value, though, `statusRank` returns -1 and the subtraction yields a plausible number:

- `compareStatus('merged', 'bogus')` is `4`, which reads as "merged is later, so proceed".
- `compareStatus('bogus', 'pending')` is `-1`, which reads as "earlier than everything".

The doc comment admits "the result is meaningless" and relies on every caller screening through `statusRank` first, as `hasProjected` does. That is a convention, not a guard, and the file's own policy is "refuse an unproven write into somebody's tracker, not guess". A reader that calls the exported comparator directly turns the "unknown" case into a green light.

**Fix:** Make the unknown case unrepresentable:
```js
function compareStatus(a, b) {
  const ra = statusRank(a), rb = statusRank(b);
  if (ra === -1 || rb === -1) throw new Error(`compareStatus: "${ra === -1 ? a : b}" is not one of ${TICKET_STATUSES.join(', ')}`);
  return ra - rb;
}
```
`hasProjected` already screens, so it is unaffected.

### WR-07: The watermark store's shape is checked only for truthiness, so malformed-but-parseable files crash mid-lock, crash `read`, or silently drop a write

**File:** `plugins/delivery-pipeline/scripts/jira-project.cjs:142`, `:149-152`, `:252`, `:558-561`
**Issue:** `load()` accepts anything with a truthy `raw.tickets`. Reproduced:

- `{"tickets":5}`: `markProjected` throws `TypeError: Cannot create property 'T-1' on number '5'` from inside the lock, after the mkdir.
- `{"tickets":{"T-1":null}}`: `jira-project.cjs read` dies with an uncaught TypeError and a stack trace at `:559` (`rec.projected_to` on null).
- `markProjected('__proto__', …)` returns `written: true`, but `store.tickets['__proto__'] = rec` sets a prototype instead of an own key, so `JSON.stringify` drops it. The file on disk is `{"tickets": {}}` and `hasProjected` says false afterwards. `projectionOf` guards against this with `hasOwnProperty`; the write side does not. Ticket ids come from plan frontmatter and nothing validates them against this.

**Fix:** Normalise `tickets` to a null-prototype or own-keyed map on load (`Object.create(null)` or `new Map`), reject non-object values, skip non-object records in `read`, and refuse ticket names `__proto__`/`constructor`/`prototype` in `markProjected`.

## Info

### IN-01: `lockRootFor` and `projectRootFor` are the same function twice

**File:** `plugins/delivery-pipeline/scripts/jira-project.cjs:104` and `:272`
**Issue:** Both are `path.resolve(dir, '..', '..')`, and the second one's own comment says "the same walk `lockRootFor` does". Two names for one rule is the "two copies of an order are free to disagree" risk the file's header warns about.
**Fix:** Keep one (see WR-05) and use it for both.

### IN-02: An unrecognised `projected_to` suppresses a ticket forever with no signal, and also forces a full journal read every round

**File:** `plugins/delivery-pipeline/scripts/jira-project.cjs:168-173`, `:354-357`
**Issue:** The skip-forever on an unknown watermark is documented as deliberate. But `plan` emits neither a warning nor a reason, so a poisoned record (hand edit, a future status vocabulary) makes one ticket's projection vanish silently. The same record's anchor can never be found, so the read degrades to byte 0 on every run.
**Fix:** In `planItems`, push one warning per ticket whose `projected_to` is not in `TICKET_STATUSES` (`T-x: watermark "closed" is not a ticket status — never projected again; remove the record to retry`). Exclude such tickets from `need`.

### IN-03: The seek is defeated in steady state, and each step re-reads and re-parses the whole suffix

**File:** `plugins/delivery-pipeline/scripts/jira-project.cjs:352-379`
**Issue:** `need` holds every watermarked subject, including tickets projected to `merged` long ago. Their anchor events are ancient, so the loop effectively always walks back to byte 0. Reproduced: with one stale watermarked ticket whose event is at the head, `bytes_read == size` (463 KB of 463 KB). Each step also re-reads and re-parses the entire suffix from the new `start`, so the cost is quadratic in journal size. The "a watermarked board seeks" behaviour that the tests pin therefore holds only on a young board. Performance is out of v1 scope, but the optimisation is largely dead code in practice, and it is not what the comments describe.
**Fix:** Exclude subjects whose watermark is the terminal status (`merged`) from `need` (nothing after it can be forward), or accumulate events across steps instead of re-parsing.

### IN-04: A no-op `markProjected` still rewrites the store

**File:** `plugins/delivery-pipeline/scripts/jira-project.cjs:199-205`
**Issue:** `mutate` always calls `writeAtomic` after `fn`, even when `fn` returned `written: false`. Reproduced: a skipped backwards move bumped the file's mtime and re-serialised it. This is harmless, but it also silently "repairs" a corrupt store by rewriting it (see CR-01) and creates the file on a pure refusal.
**Fix:** Let `fn` signal "no change" (for example return `{ …, dirty: false }`) and skip the write.

### IN-05: The test suite leaves the defects above unpinned, and its negative pin is weaker than its comment claims

**File:** `tests/unit/jira-project.test.cjs:133-145`, `:216-236`, `:612-629`
**Issue:**
- The "EMPTY MAP" test asserts `warnings: []`. That would also pass if `planItems` kept dropping `loadConfig`'s warnings (WR-01). No test feeds a mistyped `jira_transitions` entry.
- There is no case where the mapped status is not the latest (WR-02), no wrong-cwd `plan` without `--graph` (WR-03), no `--graph ""` / `--graph=` (WR-04), and no corrupt-store case (CR-01). Those paths are covered by `record-stores.test.cjs` only for well-formed stores.
- The "no network" token sweep says it "covers every path", but it does not catch `require('node:http')`, `node:net`, `http2`, `dns`, or `new WebSocket`. It is also a raw-source regex, so any future comment containing "gh", "mcp" or "https:" fails it for the wrong reason.
**Fix:** Add the cases above. Broaden the sweep to `/(?:node:)?(?:https?|http2|net|tls|dgram|dns)\b/` on stripped code, or strip comments before matching.

---

_Reviewed: 2026-10-19T12:10:00Z_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: deep_
