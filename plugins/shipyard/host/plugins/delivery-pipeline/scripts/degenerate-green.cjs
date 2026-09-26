#!/usr/bin/env node
'use strict';

// degenerate-green.cjs — diff in, findings out.
//
//   degenerate-green.cjs <ticket> --diff <file>            [--json] [--graph <dir>]
//   degenerate-green.cjs <ticket> --base <ref> --worktree <path>
//                                                          [--json] [--graph <dir>]
//
// Drive-to-green optimizes the signal it is measured by. Left alone overnight, a
// repair loop can reach green by weakening the MEASUREMENT instead of fixing the
// code, and the seven ways it does that are enumerable (ADR-001, D7): a weakened
// assertion, a skip, a rewritten snapshot, a raised timeout, `any`/`@ts-ignore`,
// a swallowed catch, a narrowed matcher. Every one of them is visible in the hunk
// text, which is why this is pattern level and not AST level: the proving ground
// is TypeScript, this repository is CJS and bash, and a parser for one would be
// blind on the other.
//
// IT REPORTS. IT DECIDES NOTHING.
//
// This is the only check in the programme that can be WRONG about legitimate
// work — a relaxed assertion is sometimes the right change, and a `catch` that
// swallows is sometimes the point. In this repository a blocking gate with false
// positives has a documented fate: it gets switched off. Two were removed in this
// same programme (`workflow.use_worktrees`, warned at a value that was the
// planner's own default and so fired for most projects; and the unguarded-merge
// warning). So the exit code carries NO verdict:
//
//   exit 0  — the run succeeded. Findings or not. Always.
//   exit 2  — the run could not happen: bad usage, no such diff, not a unified
//             diff, git refused. "Could not run" is the only non-zero.
//
// DO NOT ADD `--strict` OR `--fail-on`. A flag that turns this report into a gate
// is exactly the decision ADR-001 D7 defers until the false-positive rate has
// been measured in the field. Adding one "for later" quietly re-opens it.
//
// False-positive discipline is therefore the whole design, and it shows up as
// three rules that are worth stating because each one costs a detection:
//
//  1. A mode fires on a CHANGE, not on a presence. A raised timeout needs a lower
//     one removed in the same hunk; a narrowed matcher needs a strict one removed.
//     A brand-new test that uses `objectContaining` is not degenerate.
//  2. Context excludes. A timeout in a config file is configuration, an `any` in
//     a `.d.ts` is a declaration, a NEW snapshot file is a new expectation.
//  3. What cannot be seen is not asserted. A `catch` whose closing brace falls
//     outside the hunk is silent, because the rethrow may be on the next line.
//
// The graph is resolved the way graph-dir.cjs resolves it (flag/env → cwd → the
// worktree's own repository), because the documented caller stands in a ticket
// worktree. But it is resolved SOFTLY: a missing graph is a missing label, not a
// failed run, exactly as `failure-signature.cjs compute` treats it — the agent
// that runs this has a diff in hand and is owed its findings. The base, by
// contrast, is resolved the way both worktree gates resolve it: `origin/<base>`
// when it exists, because a stale local branch of the same name measures a merge
// base that no longer exists. Both output modes print the ref that was measured;
// a silently substituted base would be a new invisible behaviour.
//
// `--json` shape (stable — every mode key is always present in `counts`):
//
//   {
//     "ticket": "T-21-04",
//     "source": {"kind": "diff"|"git", "diff": …, "worktree": …,
//                "base": …, "requested_base": …, "graph": …},
//     "findings": [{"mode": …, "file": …, "line": <int>, "text": …, "reason": …}],
//     "counts": {"total": <int>, "weakened_assertion": <int>, …}
//   }

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { resolveGraphDir, resolveBaseRef } = require(path.join(__dirname, 'graph-dir.cjs'));

// The enumerated modes, in ADR-001 D7's order. `counts` always carries all seven,
// so a consumer can read `counts.skip` without checking whether it exists.
const MODES = [
  'weakened_assertion',
  'skip',
  'rewritten_snapshot',
  'raised_timeout',
  'any_or_ts_ignore',
  'swallowed_catch',
  'narrowed_matcher',
];

// ─────────────────────────────────────────────────────────────────────────────
// The diff parser
//
// Unified diff only, and deliberately tolerant of the two shapes `git` and
// `gh pr diff` actually emit: `@@ -a,b +c,d @@` and the count-less `@@ -a +c @@`.
// Removed lines carry BOTH numbers — their own old line, and the new-file cursor
// where they were taken out, which is the only sane place to report a deletion.
// ─────────────────────────────────────────────────────────────────────────────

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

function stripPrefix(p) {
  if (p === '/dev/null') return null;
  return p.replace(/^[ab]\//, '');
}

function parseDiff(text) {
  const files = [];
  let file = null;
  let hunk = null;
  let oldLine = 0;
  let newLine = 0;
  let sawHeader = false;

  const lines = String(text).split('\n');
  // The artifact of the final newline, not a line of the diff. Interior '' IS
  // kept as context, because a tool that strips trailing whitespace emits a
  // blank context line as an empty string rather than as a single space — but
  // counting the terminator as one shifts every line number after it.
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  for (const raw of lines) {
    if (raw.startsWith('diff --git ')) {
      sawHeader = true;
      const m = raw.match(/^diff --git (\S+) (\S+)$/);
      file = {
        path: m ? stripPrefix(m[2]) : null,
        oldPath: m ? stripPrefix(m[1]) : null,
        isNew: false,
        isDeleted: false,
        hunks: [],
      };
      files.push(file);
      hunk = null;
      continue;
    }
    if (raw.startsWith('--- ')) {
      sawHeader = true;
      if (!file) { file = { path: null, oldPath: null, isNew: false, isDeleted: false, hunks: [] }; files.push(file); }
      const p = stripPrefix(raw.slice(4).split('\t')[0].trim());
      file.oldPath = p;
      if (p === null) file.isNew = true;
      continue;
    }
    if (raw.startsWith('+++ ')) {
      sawHeader = true;
      if (!file) { file = { path: null, oldPath: null, isNew: false, isDeleted: false, hunks: [] }; files.push(file); }
      const p = stripPrefix(raw.slice(4).split('\t')[0].trim());
      if (p === null) { file.isDeleted = true; } else { file.path = p; }
      continue;
    }
    if (raw.startsWith('new file mode')) { if (file) file.isNew = true; continue; }
    if (raw.startsWith('deleted file mode')) { if (file) file.isDeleted = true; continue; }

    const hm = raw.match(HUNK_RE);
    if (hm) {
      sawHeader = true;
      if (!file) { file = { path: null, oldPath: null, isNew: false, isDeleted: false, hunks: [] }; files.push(file); }
      oldLine = Number(hm[1]);
      newLine = Number(hm[3]);
      hunk = { oldStart: oldLine, newStart: newLine, header: raw, lines: [] };
      file.hunks.push(hunk);
      continue;
    }
    if (!hunk) continue;
    if (raw.startsWith('\\')) continue; // "\ No newline at end of file"

    const kind = raw[0];
    const body = raw.slice(1);
    if (kind === '+') {
      hunk.lines.push({ kind: '+', text: body, newLine, oldLine });
      newLine++;
    } else if (kind === '-') {
      // `newLine` here is the cursor: where in the new file this line USED to be.
      hunk.lines.push({ kind: '-', text: body, newLine, oldLine });
      oldLine++;
    } else if (kind === ' ' || raw === '') {
      hunk.lines.push({ kind: ' ', text: body, newLine, oldLine });
      newLine++;
      oldLine++;
    }
    // Anything else (index lines, "similarity index", trailing junk) is ignored.
  }

  // A file with no resolvable path is unusable to a reader, so name it honestly.
  for (const f of files) if (!f.path) f.path = f.oldPath || '(unknown)';
  return { files, wellFormed: sawHeader };
}

// ─────────────────────────────────────────────────────────────────────────────
// Path classification — rule 2 above. Each predicate exists because a control
// depends on it, and the control is what proves the predicate is load-bearing.
// ─────────────────────────────────────────────────────────────────────────────

const isTestPath = (p) =>
  /(?:^|\/)(?:tests?|__tests__|specs?|testdata)\//i.test(p) ||
  /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(p) ||
  /_test\.go$/.test(p) ||
  /(?:^|\/)test_[^/]+\.py$/.test(p) ||
  /_spec\.rb$/.test(p);

const isConfigPath = (p) =>
  /(?:^|\/)[^/]*\.config\.[cm]?[jt]s$/.test(p) ||
  /(?:^|\/)(?:jest|vitest|playwright|karma|cypress|mocha|nyc|wdio)\.[^/]+$/i.test(p) ||
  /(?:^|\/)\.mocharc\.[^/]+$/.test(p) ||
  /(?:^|\/)(?:package\.json|pytest\.ini|setup\.cfg|tox\.ini|pyproject\.toml)$/.test(p) ||
  /(?:^|\/)tsconfig[^/]*\.json$/.test(p);

const isDeclarationPath = (p) => /\.d\.[cm]?ts$/.test(p);
const isTypeScriptPath = (p) => /\.[cm]?tsx?$/.test(p);
const isSnapshotPath = (p) =>
  /(?:^|\/)__snapshots__\//.test(p) || /\.(?:snap|ambr)$/.test(p) || /\.approved\.[^/]+$/.test(p);
const isWorkflowPath = (p) => /(?:^|\/)\.github\/workflows\/[^/]+\.ya?ml$/.test(p);
// Prose. Found in the field on this repository's own history: the ADR and the
// plan for THIS ticket both list the enumerated modes by name, and every mention
// of `@ts-ignore` in them was reported as an occurrence of it. A pragma silences
// a checker only in a file that checker reads; in a document it is the subject
// under discussion.
const isProsePath = (p) => /\.(?:md|mdx|markdown|txt|rst|adoc)$/i.test(p);

// ─────────────────────────────────────────────────────────────────────────────
// Patterns
// ─────────────────────────────────────────────────────────────────────────────

// "Strong" and "weak" are relative to each other, not absolute: the finding is
// the TRANSITION from one to the other inside a single hunk.
const STRONG_ASSERTION = /\b(?:assert\.(?:strictEqual|deepStrictEqual|deepEqual|equal|match|throws|rejects)|assertEqual|assertEquals|toBe|toEqual|toStrictEqual|toMatchObject|toHaveBeenCalledWith|toHaveBeenCalledTimes|toHaveLength|toThrow)\s*\(/;
const WEAK_ASSERTION = /\b(?:assert\.ok|assert\.notStrictEqual|assertTrue|toBeTruthy|toBeFalsy|toBeDefined|toBeUndefined|toBeNull|toHaveBeenCalled|toBeGreaterThan|toBeGreaterThanOrEqual|toBeLessThan|toBeLessThanOrEqual)\s*\(/;

// An assertion over literals only. This is the failure the repo's own harness
// shipped twice: a check that cannot fail reports safety.
const LITERAL = "(true|false|-?\\d+|'[^']*'|\"[^\"]*\")";
const TAUTOLOGIES = [
  {
    re: /\bassert(?:\.ok)?\s*\(\s*(?:true|1)\s*[,)]/,
    reason: 'asserts a literal truth — this line cannot fail, whatever the code does',
  },
  {
    re: new RegExp('\\bassert\\.(?:strictEqual|equal|deepStrictEqual)\\s*\\(\\s*' + LITERAL + '\\s*,\\s*\\1\\s*[,)]'),
    reason: 'compares a literal with itself — this line cannot fail, whatever the code does',
  },
  {
    re: new RegExp('\\bexpect\\s*\\(\\s*' + LITERAL + '\\s*\\)\\s*\\.\\s*(?:toBe|toEqual|toStrictEqual)\\s*\\(\\s*\\1\\s*\\)'),
    reason: 'compares a literal with itself — this line cannot fail, whatever the code does',
  },
];

const SKIP_PATTERNS = [
  {
    re: /\b(?:it|test|describe|context|suite)\s*\.\s*(?:skip|todo|failing|skipIf)\b/,
    reason: 'the test is registered as skipped — a red test becomes an absent one, and the suite is green',
  },
  {
    re: /\b(?:xit|xdescribe|xtest|xcontext)\s*\(/,
    reason: 'the test is registered as skipped — a red test becomes an absent one, and the suite is green',
  },
  {
    re: /\b(?:it|test|describe|context|suite)\s*\.\s*only\s*\(|\b(?:fit|fdescribe)\s*\(/,
    reason: 'focusing one test skips every other test in the file — the green covers a fraction of what it did',
  },
  {
    re: /@pytest\.mark\.(?:skip|skipif|xfail)\b/,
    reason: 'the test is registered as skipped — a red test becomes an absent one, and the suite is green',
  },
  {
    re: /\bt\.Skip(?:Now|f)?\s*\(/,
    reason: 'the test returns early as skipped — a red test becomes an absent one, and the suite is green',
  },
  {
    re: /#\[\s*ignore\s*[\]( ]/,
    reason: 'the test is registered as ignored — a red test becomes an absent one, and the suite is green',
  },
];

// `-u` is jest's spelling and also curl's, so the short form alone is not enough
// evidence — it needs a test runner on the same line. The long forms name
// snapshots outright and stand on their own.
const SNAPSHOT_UPDATE_LONG = /(?:^|\s)(?:--update-snapshots?|--updateSnapshot|--snapshot-update|--force-update-snapshots|SNAPSHOT_UPDATE=1)(?:\s|$|["'])/;
const SNAPSHOT_UPDATE_SHORT = /(?:^|\s)-u(?:\s|$|["'])/;

const TIMEOUT_KEYWORD = /\b(?:timeout|timeoutMs|testTimeout|hookTimeout|teardownTimeout|setTimeout|waitFor|sleep)\b/i;

const IGNORE_PRAGMAS = [
  { re: /@ts-ignore\b/, reason: 'a type error is silenced rather than resolved' },
  { re: /@ts-nocheck\b/, reason: 'type checking is switched off for the whole file' },
  { re: /@ts-expect-error\b/, reason: 'a type error is declared expected rather than resolved' },
  { re: /\beslint-disable(?:-next-line|-line)?\b/, reason: 'a lint rule is switched off rather than satisfied' },
  { re: /#\s*type:\s*ignore\b/, reason: 'a type error is silenced rather than resolved' },
  { re: /#\s*noqa\b/, reason: 'a lint rule is switched off rather than satisfied' },
  { re: /\/\/\s*nolint\b/, reason: 'a lint rule is switched off rather than satisfied' },
  { re: /@SuppressWarnings\b/, reason: 'a compiler warning is suppressed rather than resolved' },
];
const ANY_TYPE = /(?::\s*any\b|\bas\s+any\b|<\s*any\s*>|\bany\[\])/;

const EMPTY_CATCH_INLINE = /\bcatch\s*(?:\([^)]*\))?\s*\{\s*\}/;
const EMPTY_CATCH_HANDLER = /\.catch\s*\(\s*(?:\(\s*[^)]*\)|[A-Za-z_$][\w$]*)\s*=>\s*(?:\{\s*\}|null|undefined|void 0)\s*\)/;
const CATCH_OPENS = /\bcatch\s*(?:\([^)]*\))?\s*\{\s*$/;
const EXCEPT_OPENS = /^\s*except\b[^:]*:\s*$/;
const RETHROW = /\b(?:throw|reject|raise|panic|process\.exit|assert|Fatal|Fatalf|abort)\b/;
const TEST_RUNNER = /\b(?:npm\s+(?:run\s+)?test|yarn\s+test|pnpm\s+test|make\s+test[\w-]*|pytest|go\s+test|jest|vitest|mocha|node\s+--test|cargo\s+test|rspec|phpunit|tox)\b/;
const OR_TRUE = /\|\|\s*(?:true|:)\s*(?:$|#|;|&)/;

const STRICT_MATCHER = /\b(?:toEqual|toStrictEqual|toBe|deepStrictEqual|strictEqual|toHaveBeenCalledWith|toHaveLength)\s*\(/;
const FUZZY_MATCHER = /\b(?:objectContaining|arrayContaining|stringContaining|stringMatching|anything|toMatchObject|toContain|toContainEqual|toBeCloseTo)\s*\(|\bexpect\s*\.\s*any\s*\(/;
const REGEX_LITERAL = /\/(?:[^/\\\n]|\\.)+\/[gimsuy]*/;
// A path with two slashes in it is a regex literal as far as the pattern above is
// concerned, so the loosened-regex rule only reads lines that are matching
// something. Without this, `plugins/delivery-pipeline/` on a removed line arms it.
const REGEX_CONTEXT = /\b(?:toMatch|toThrow|RegExp)\b|\bassert\.match\s*\(|\.(?:match|test|replace|search|split)\s*\(/;
const PERMISSIVE_REGEX = /\/(?:[^/\\\n]|\\.)*(?:\.\*|\[\\s\\S\]\*|\.\+)(?:[^/\\\n]|\\.)*\/[gimsuy]*/;

// ─────────────────────────────────────────────────────────────────────────────
// Detectors. Each pushes {mode, file, line, text, reason}. None of them decides
// anything; `analyze` collects the lot the way validate-graph collects errors.
// ─────────────────────────────────────────────────────────────────────────────

const added = (h) => h.lines.filter((l) => l.kind === '+');
const removed = (h) => h.lines.filter((l) => l.kind === '-');
const newView = (h) => h.lines.filter((l) => l.kind !== '-');

function push(out, mode, file, line, reason) {
  out.push({ mode, file: file.path, line: line.newLine, text: line.text.trim(), reason });
}

function detectWeakenedAssertion(file, hunk, out) {
  const weakened = removed(hunk).some((l) => STRONG_ASSERTION.test(l.text));
  for (const l of added(hunk)) {
    let hit = false;
    for (const t of TAUTOLOGIES) {
      if (t.re.test(l.text)) { push(out, 'weakened_assertion', file, l, t.reason); hit = true; break; }
    }
    if (hit) continue;
    // Rule 1: the transition is the finding. A weak assertion in a brand-new
    // test is a weak test, not a weakened one, and this tool does not review
    // tests — it reviews what a drive-to-green run did to them.
    if (weakened && WEAK_ASSERTION.test(l.text) && !STRONG_ASSERTION.test(l.text)) {
      push(out, 'weakened_assertion', file, l,
        'a strict assertion was removed in this hunk and a truthiness/existence check put in its place');
    }
  }
}

function detectSkip(file, hunk, out) {
  for (const l of added(hunk)) {
    for (const p of SKIP_PATTERNS) {
      if (p.re.test(l.text)) { push(out, 'skip', file, l, p.reason); break; }
    }
  }
}

function detectRewrittenSnapshot(file, hunk, out) {
  if (isSnapshotPath(file.path) && !file.isDeleted) {
    // A rewrite is a REMOVED expectation, and that is the whole test: a new
    // snapshot file has nothing removed (it is a new expectation, not a moved
    // one) and a deleted one went with the test it belonged to.
    const first = removed(hunk)[0];
    if (first) {
      push(out, 'rewritten_snapshot', file, first,
        'a stored snapshot expectation was rewritten — the recorded output moved to meet the code');
    }
    return;
  }
  for (const l of added(hunk)) {
    if (SNAPSHOT_UPDATE_LONG.test(l.text) || (SNAPSHOT_UPDATE_SHORT.test(l.text) && TEST_RUNNER.test(l.text))) {
      push(out, 'rewritten_snapshot', file, l,
        'the test command now updates snapshots instead of comparing against them');
      continue;
    }
    if (/toMatchInlineSnapshot\s*\(/.test(l.text) &&
        removed(hunk).some((r) => /toMatchInlineSnapshot\s*\(/.test(r.text))) {
      push(out, 'rewritten_snapshot', file, l,
        'an inline snapshot was rewritten — the recorded output moved to meet the code');
    }
  }
}

function timeoutValue(text) {
  if (!TIMEOUT_KEYWORD.test(text)) return null;
  const nums = text.match(/\d+(?:\.\d+)?/g);
  if (!nums) return null;
  // The largest number on a timeout line is the timeout in every realistic
  // spelling (`timeout: 5000`, `setTimeout(fn, 5000)`, `--timeout 30`).
  return Math.max(...nums.map(Number));
}

function detectRaisedTimeout(file, hunk, out) {
  // Rule 2: a timeout in configuration is configuration. This exclusion is what
  // keeps `tests/vitest.config.ts` silent even though it sits under `tests/`.
  if (isConfigPath(file.path)) return;
  if (!isTestPath(file.path)) return;
  const before = removed(hunk).map((l) => timeoutValue(l.text)).filter((v) => v !== null);
  if (!before.length) return; // rule 1: no lower value removed, no raise to report
  const was = Math.max(...before);
  for (const l of added(hunk)) {
    const now = timeoutValue(l.text);
    if (now !== null && now > was) {
      push(out, 'raised_timeout', file, l,
        `a test timeout was raised from ${was} to ${now} — slowness was accommodated, not diagnosed`);
    }
  }
}

function detectAnyOrIgnore(file, hunk, out) {
  if (isProsePath(file.path)) return;
  for (const l of added(hunk)) {
    let hit = false;
    for (const p of IGNORE_PRAGMAS) {
      if (p.re.test(l.text)) { push(out, 'any_or_ts_ignore', file, l, p.reason); hit = true; break; }
    }
    if (hit) continue;
    // Rule 2: `any` in a declaration file is how a declaration says "untyped
    // upstream"; it is not a type error being escaped.
    if (isTypeScriptPath(file.path) && !isDeclarationPath(file.path) && ANY_TYPE.test(l.text)) {
      push(out, 'any_or_ts_ignore', file, l,
        '`any` widens the type until the checker stops objecting — the error is escaped, not resolved');
    }
  }
}

function detectSwallowedCatch(file, hunk, out) {
  const view = newView(hunk);
  for (let i = 0; i < view.length; i++) {
    const l = view[i];
    if (l.kind !== '+') continue;

    if (EMPTY_CATCH_INLINE.test(l.text) || EMPTY_CATCH_HANDLER.test(l.text)) {
      push(out, 'swallowed_catch', file, l,
        'the error is caught and discarded — a failure now reads as a success');
      continue;
    }

    if (isWorkflowPath(file.path) && /continue-on-error:\s*true\b/.test(l.text)) {
      push(out, 'swallowed_catch', file, l,
        'the step\'s failure no longer fails the job — a red step reports green');
      continue;
    }
    // Narrow on purpose: `|| true` is ordinary in cleanup lines, so it is only a
    // finding when what it swallows is a TEST RUNNER's exit code.
    if (OR_TRUE.test(l.text) && TEST_RUNNER.test(l.text)) {
      push(out, 'swallowed_catch', file, l,
        'the test runner\'s exit code is discarded — the command reports success whatever the suite did');
      continue;
    }

    if (CATCH_OPENS.test(l.text) || EXCEPT_OPENS.test(l.text)) {
      const verdict = scanHandlerBody(view, i, CATCH_OPENS.test(l.text));
      // Rule 3: an unterminated body is unknown, not empty. The rethrow may be
      // on the first line after the hunk, and a false positive here is the
      // cheapest way to lose the reader's trust in the whole report.
      if (verdict === 'swallowed') {
        push(out, 'swallowed_catch', file, l,
          'the error is caught and nothing is raised, returned or logged onward — a failure now reads as a success');
      }
    }
  }

  // A rethrow DELETED from a handler that is still there. Guarded twice: the
  // handler must survive in the new text, and nothing may re-raise in the hunk —
  // otherwise a `throw` merely moved a few lines and this would fire on a
  // refactor.
  const rethrowGone = removed(hunk).filter((l) => /^\s*(?:throw|raise)\b/.test(l.text));
  if (rethrowGone.length &&
      view.some((l) => /\bcatch\b|^\s*except\b/.test(l.text)) &&
      !added(hunk).some((l) => RETHROW.test(l.text))) {
    push(out, 'swallowed_catch', file, rethrowGone[0],
      'the re-raise was removed from a handler that is still catching — the error stops here now');
  }
}

// Walks forward from an opening handler through the NEW text of the hunk.
// Returns 'swallowed' | 'handled' | 'unknown'.
function scanHandlerBody(view, start, braced) {
  if (!braced) {
    // Python: `except …:` whose whole body is `pass` (or only logs). The block
    // ends at the first line indented no further than the `except` itself.
    const baseIndent = view[start].text.match(/^\s*/)[0].length;
    let sawBody = false;
    for (let i = start + 1; i < view.length; i++) {
      const t = view[i].text;
      if (!t.trim()) continue;
      const indent = t.match(/^\s*/)[0].length;
      if (indent <= baseIndent) return sawBody ? 'swallowed' : 'unknown';
      sawBody = true;
      if (/^\s*(?:pass|\.\.\.)\s*$/.test(t)) continue;
      if (isInertBody(t)) continue;
      return 'handled';  // a real statement: `raise`, a fallback, anything
    }
    return 'unknown'; // the body ran off the end of the hunk — rule 3
  }

  let depth = 0;
  for (let i = start; i < view.length; i++) {
    const full = view[i].text;
    // `} catch (err) {` closes the try and opens the catch on one line, so the
    // whole-line balance is zero. Count from the catch's own brace or the scan
    // reads the next line as the closing one.
    const t = i === start ? full.slice(full.lastIndexOf('{')) : full;
    const opens = (t.match(/\{/g) || []).length;
    const closes = (t.match(/\}/g) || []).length;
    depth += opens - closes;
    if (i > start && depth <= 0) return 'swallowed';   // closing brace is VISIBLE
    if (i > start && /\S/.test(t) && !/^\s*[{}]\s*$/.test(t) && !isInertBody(t)) return 'handled';
  }
  return 'unknown';
}

// A handler body that only logs is still swallowing: nothing downstream learns
// the operation failed. A body that does anything else is a judgement call this
// tool does not make.
function isInertBody(t) {
  return /^\s*(?:\/\/|#)/.test(t) ||
    /^\s*(?:console\.(?:log|error|warn|debug|info)|(?:logger|log)\.\w+|print)\s*\(/.test(t) ||
    /^\s*(?:return\s*(?:null|undefined|false|0|''|""|\[\]|\{\})?\s*;?|pass|continue|break)\s*$/.test(t);
}

function detectNarrowedMatcher(file, hunk, out) {
  const strictGone = removed(hunk).some((l) => STRICT_MATCHER.test(l.text));
  const tightRegexGone = removed(hunk).some(
    (l) => REGEX_CONTEXT.test(l.text) && REGEX_LITERAL.test(l.text) && !PERMISSIVE_REGEX.test(l.text));
  for (const l of added(hunk)) {
    if (strictGone && FUZZY_MATCHER.test(l.text)) {
      push(out, 'narrowed_matcher', file, l,
        'an exact comparison was replaced by a partial one — the assertion still runs, over less');
      continue;
    }
    if (tightRegexGone && REGEX_CONTEXT.test(l.text) && PERMISSIVE_REGEX.test(l.text)) {
      push(out, 'narrowed_matcher', file, l,
        'the pattern was loosened toward `.*` — it now matches text the previous one rejected');
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────

function analyze(parsed) {
  const out = [];
  for (const file of parsed.files) {
    for (const hunk of file.hunks) {
      detectWeakenedAssertion(file, hunk, out);
      detectSkip(file, hunk, out);
      detectRewrittenSnapshot(file, hunk, out);
      detectRaisedTimeout(file, hunk, out);
      detectAnyOrIgnore(file, hunk, out);
      detectSwallowedCatch(file, hunk, out);
      detectNarrowedMatcher(file, hunk, out);
    }
  }

  // A weakened assertion IS a narrowed matcher seen from a different angle;
  // reporting the same line twice makes the count lie about how much happened.
  const weakened = new Set(out.filter((f) => f.mode === 'weakened_assertion').map((f) => `${f.file}|${f.line}`));
  const deduped = [];
  const seen = new Set();
  for (const f of out) {
    if (f.mode === 'narrowed_matcher' && weakened.has(`${f.file}|${f.line}`)) continue;
    const key = `${f.mode}|${f.file}|${f.line}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(f);
  }
  deduped.sort((a, b) =>
    a.file.localeCompare(b.file) || a.line - b.line || MODES.indexOf(a.mode) - MODES.indexOf(b.mode));
  return deduped;
}

function countsOf(findings) {
  const counts = { total: findings.length };
  for (const m of MODES) counts[m] = 0;
  for (const f of findings) counts[f.mode]++;
  return counts;
}

/** The whole tool as one function: diff text in, findings + counts out. */
function scan(text) {
  const parsed = parseDiff(text);
  const findings = analyze(parsed);
  return { parsed, findings, counts: countsOf(findings) };
}

module.exports = { parseDiff, analyze, scan, countsOf, MODES };

// ─────────────────────────────────────────────────────────────────────────────
// CLI
// ─────────────────────────────────────────────────────────────────────────────

const USAGE = [
  'usage:',
  '  degenerate-green.cjs <ticket> --diff <file>                   [--json] [--graph <dir>]',
  '  degenerate-green.cjs <ticket> --base <ref> --worktree <path>  [--json] [--graph <dir>]',
  '',
  'Reports the ways a drive-to-green run can reach green by weakening the',
  'measurement: weakened assertion, skip, rewritten snapshot, raised timeout,',
  '`any`/@ts-ignore, swallowed catch, narrowed matcher.',
  '',
  'Exit 0 ALWAYS when the run succeeded — findings or not. A non-zero exit (2)',
  'is reserved for "could not run": bad usage, an unreadable diff, a diff that is',
  'not a unified diff, a git command that refused.',
  '',
  'This is a REPORT and never a gate. Do NOT add --strict or --fail-on: making',
  'this block is the decision ADR-001 D7 defers until the false-positive rate has',
  'been measured in the field, and a flag added "for later" re-opens it silently.',
  '',
  '--json emits {ticket, source, findings, counts}; counts always carries total',
  'plus one key per mode, so a consumer can read counts.skip without checking.',
].join('\n');

function cannotRun(msg) {
  process.stderr.write(`degenerate-green: ${msg}\n`);
  process.exit(2);
}

function main(argv) {
  const asJson = argv.includes('--json');
  // A value flag with no value of its own must not silently swallow the NEXT
  // flag as its value — `--diff --json` would otherwise try to read a file
  // literally named `--json`, and report a misleading path instead of naming
  // the actual mistake. Bad usage, so it cannot run rather than mis-parse.
  const flag = (name) => {
    const i = argv.indexOf(`--${name}`);
    if (i === -1) return null;
    const v = argv[i + 1];
    if (v === undefined || v.startsWith('--')) {
      cannotRun(`--${name} needs a value, got ${v === undefined ? 'nothing' : JSON.stringify(v)}`);
    }
    return v;
  };
  // Same rule as scope-gate: a flag-first invocation must not make a flag's
  // VALUE the ticket.
  const VALUE_FLAGS = ['--diff', '--base', '--worktree', '--graph'];
  const ticket = argv.find((a, i) => !a.startsWith('--') && !VALUE_FLAGS.includes(argv[i - 1]));

  if (!ticket || argv.includes('--help') || argv.includes('-h')) cannotRun(USAGE);

  const diffFile = flag('diff');
  const baseRef = flag('base');
  const worktreeArg = flag('worktree');

  if (!diffFile && !baseRef) cannotRun(`no diff to read.\n${USAGE}`);
  if (diffFile && baseRef) cannotRun('pass either --diff <file> or --base <ref>, not both — they name two different measurements');
  if (baseRef && !worktreeArg) cannotRun('--base <ref> needs --worktree <path>: the diff is taken in the worktree');

  const worktree = worktreeArg ? path.resolve(worktreeArg) : null;

  // Soft, unlike loadTickets: the graph is a label here, not an input. A caller
  // holding a diff is owed its findings even where no graph resolves.
  const g = resolveGraphDir(argv, worktree);
  const graphDir = g.how === 'none' ? null : g.dir;

  let text;
  let resolvedBase = null;
  if (diffFile) {
    try {
      text = fs.readFileSync(diffFile, 'utf8');
    } catch (e) {
      cannotRun(`cannot read the diff at ${diffFile}: ${e.code === 'ENOENT' ? 'no such file' : e.message}`);
    }
  } else {
    if (!fs.existsSync(worktree)) cannotRun(`no such worktree: ${worktree}`);
    // origin/<base> when it exists — the same rule both worktree gates follow,
    // and for the same reason: a stale local branch of the same name describes a
    // merge base that no longer exists.
    resolvedBase = resolveBaseRef(worktree, baseRef);
    try {
      // Three dots: what this branch did, not what the base did meanwhile.
      text = execFileSync('git', ['-C', worktree, 'diff', `${resolvedBase}...HEAD`], {
        encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (e) {
      cannotRun(`git diff ${resolvedBase}...HEAD failed in ${worktree}: ${e.stderr ? String(e.stderr).trim() : e.message}`);
    }
  }

  const { parsed, findings, counts } = scan(text);
  // An empty diff is a legitimate answer (nothing changed). Text that is not
  // empty and carries no diff header is the caller measuring the wrong thing,
  // and saying "0 findings" to that would be a false all-clear.
  if (!parsed.wellFormed && text.trim() !== '') {
    cannotRun(`not a unified diff: no file headers or @@ hunks found in ${diffFile || `git diff ${resolvedBase}...HEAD`}`);
  }

  const measured = diffFile ? diffFile : `${resolvedBase}...HEAD`;
  const result = {
    ticket,
    source: {
      kind: diffFile ? 'diff' : 'git',
      diff: diffFile || null,
      worktree: worktree || null,
      base: resolvedBase,
      requested_base: baseRef || null,
      graph: graphDir,
    },
    findings,
    counts,
  };

  if (asJson) {
    console.log(JSON.stringify(result, null, 2));
    process.exit(0);
  }

  if (!findings.length) {
    console.log(`degenerate-green: ${ticket} — clean, no degenerate-green patterns in ${measured}`);
    process.exit(0);
  }

  const fileCount = new Set(findings.map((f) => f.file)).size;
  console.log(`degenerate-green: ${ticket} — ${findings.length} finding(s) in ${fileCount} file(s), measured on ${measured}`);
  console.log('');
  for (const m of MODES) {
    const group = findings.filter((f) => f.mode === m);
    if (!group.length) continue;
    console.log(`${m} (${group.length}):`);
    for (const f of group) {
      console.log(`  ${f.file}:${f.line}`);
      console.log(`    ${f.text}`);
      console.log(`    ${f.reason}`);
    }
    console.log('');
  }
  console.log('These are observations, not a verdict, and nothing is blocked by them: each');
  console.log('one is a place to look, and a relaxed assertion is sometimes the right change.');
  console.log('Judge them against the ticket, then say so in the PR body.');
  process.exit(0);
}

if (require.main === module) main(process.argv.slice(2));
