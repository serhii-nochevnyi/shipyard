'use strict';

// A JUDGMENT PROCEDURE THAT ONLY ONE ENTRY POINT STATES IS NOT A PROCEDURE.
//
// The background path (the PR sentinel) is told to run the architecture judge
// and it is told to escalate a RE-judgement whenever the journal already holds
// an `arch_review … verdict=violation` for the ticket. It was never told to
// resolve the judge from the ladder, and it was never told to WRITE that event —
// so the guard read a fact nothing on its own path produced. Measured on this
// ticket's base: `references/pr-sentinel.md` contained ZERO occurrences of
// `log-event.cjs arch_review` and ZERO of `model arch-review`, while
// `deliver.md`'s inline path had two of each. Phase 27 shipped anyway, because
// the orchestrator patched the resolve step and the record step into every
// guard brief BY HAND — which is the definition of a protocol that does not
// hold. Prose rules get skipped; mechanical gates hold.
//
// So the procedure is measure → resolve → dispatch → record, it is stated in
// ONE document, and the other REFERENCES it. Both halves are pinned here,
// because either half alone re-creates the defect: four steps in one place with
// nothing pointing at them is a document nobody on the other path reads, and
// four steps in both places is the duplication the two paths diverged through.
//
// HOW THIS TEST ERRS. A doc-contract test that passes wrongly is worse than no
// test at all — it certifies the exact silence it exists to break. Three
// choices push every uncertainty toward a FALSE RED instead:
//
//   1. Both section anchors must be FOUND. A slice that runs to end-of-file
//      would match markers belonging to other duties (both documents name the
//      resolver elsewhere, for other roles), and a whole-file grep would have
//      passed on base while the arch-review entry said nothing at all.
//   2. Steps are asserted by INVOCATION strings — the script name and the flags
//      an agent actually types — not by the English words, which occur all over
//      both files.
//   3. The referencing side is asserted in a WINDOW around its pointer, not
//      file-wide, and its pointer is required separately.
//
// The residual weakness is deliberate and named: the referencing side is
// satisfied by the four step NAMES near the pointer, which is a weaker claim
// than an invocation. It cannot be stronger without re-introducing the
// duplication — so it is bounded by the pointer requirement and by the
// stated-once assertion below, which fails if the invocations ever come back.
//
// SEAM. `SUBJECTS` is a table, and `arch-review` is one row. A second row —
// another mechanism whose two entry points must agree — needs no new machinery
// here: declare its two documents, their section anchors and its steps.
//
// ── AND THE SECOND TABLE: EVERY READER HAS A WRITER, OR A RECORDED DECISION ──
//
// `SUBJECTS` above asks whether TWO entry points agree about one procedure.
// `WIRED` below asks a smaller question about many more mechanisms: does the one
// document or script that is supposed to REACH this mechanism actually name it?
// Both are the same claim — a document must name its caller — so they share one
// home rather than starting a third doc-contract file.
//
// ADR-007 Family B is the measurement: `needsBaseMerge` occurred ZERO times in
// `deliver.md` while `fix-round.mjs` documented it in its own args contract;
// `behind_by` was read by `front.cjs` and written by nobody; `drift-needed.cjs`
// was implemented and tested and called from no production command; the
// `base_merge` journal event had a writer contract, a docs-smoke exemption
// claiming the script "journals itself", and no caller. Each was correct code
// that nothing reached — and every one of them passed every test in the suite,
// because a mechanism nobody connected still compiles. This is the guard
// `trailer.test.cjs` WAS, one row short, when phase 27's D2 shipped inert.
//
// TWO KINDS OF ROW, and the second one is the point. `kind: 'wired'` says the
// caller must be there. `kind: 'decided'` says the opposite — this reader has no
// writer ON PURPOSE, the reason is written where a reader of the code looks, and
// a writer appearing later is itself the finding. `unresolved_count` is that
// row: a per-PR GraphQL query is the class of field that made a monorepo sync
// cost 41s instead of 7s, so on a board rebuilt from GitHub the predicate is
// unreachable BY DESIGN. A reader with no writer that SAYS SO is a decision, not
// drift, and the difference between the two is exactly what this table records.
//
// HOW THESE ROWS ERR — AND THE ONE WAY THEY COULD NOT ERR AT ALL. These rows
// matched their home FILE at first, on the argument that the caller of a
// mechanism is not always inside one bounded section. Measured, that made four
// of the six unfailable: the integrator extracted the epic tip, deleted each
// caller and nothing else, and only `behind_by` and `drift-needed.cjs` went red.
// The cause is one sentence — the same document that CALLS an event also
// documents its SCHEMA, so `log-event.cjs base_merge` and `effort_applied=` were
// still there after step d's lines were gone; `needsBaseMerge` survived in the
// prose explaining it, and `PARKED_RENDER_ONLY` in its own `const`. A guard that
// certifies whatever it is pointed at is worse than no guard: `WIRED` was green
// on a tree where four mechanisms had no caller left.
//
// So a home now declares WHERE the caller lives. `slice` bounds the match to the
// paragraph or code block that calls (both anchors must be FOUND — a slice to
// end-of-file is the false-green shape again), and a home without one uses a
// pattern that only an invocation or an assignment can produce
// (`entry\.behind_by\s*=`, `front\.parked_render_only\s*=`, `effort_applied=<`
// with the template bracket the prose never writes).
//
// The BOUNDARY this must not cross, and it is why the slices are narrow rather
// than the patterns broad: deleting only an event's schema documentation, with
// its caller still in place, must NOT fail. A pin that fires on documentation
// edits gets loosened by the next reader, and then four rows are unfailable
// again. `judgment-contract` asserts that direction explicitly below.
//
// A row may declare SEVERAL homes — one per entry point that must reach the
// mechanism. `effort_applied` and the `base_merge` event have two each (the main
// loop's step d and the guard's own duties), and each home is its own test, so a
// failure names which path lost its caller rather than which mechanism is
// unreachable from somewhere.
//
// These rows stay weaker than `SUBJECTS`: they prove a document names its caller
// in the right region, never that the surrounding instruction is correct. The
// mutation check in the ticket's acceptance criteria is what keeps them honest —
// remove the caller, watch the named row fail, per row and not per table.

const fs = require('fs');
const path = require('path');
const { suite, test, done, assert } = require(path.join(__dirname, 'assert-harness.cjs'));

const ROOT = path.join(__dirname, '..', '..');
const PLUGIN = path.join(ROOT, 'plugins', 'delivery-pipeline');

const PR_SENTINEL = path.join(PLUGIN, 'references', 'pr-sentinel.md');
const DELIVER = path.join(PLUGIN, 'commands', 'deliver.md');
const STATE_SYNC = path.join(PLUGIN, 'scripts', 'state-sync.cjs');
const FRONT = path.join(PLUGIN, 'scripts', 'front.cjs');

// One subject = one mechanism with two entry points. `canonical` is the
// document that STATES the procedure; `referencing` is the one that must point
// at it and name the same steps without restating them.
const SUBJECTS = [
  {
    mechanism: 'arch-review',
    canonical: {
      doc: PR_SENTINEL,
      // The guard's duty entries are `**`<duty>`**` paragraphs. arch-review's
      // ends where undraft's begins.
      start: /^\*\*`arch-review`\*\*/m,
      end: /^\*\*`undraft`\*\*/m,
    },
    referencing: {
      doc: DELIVER,
      // The inline babysit cycle's step c, ending at step d.
      start: /^ {2}c\. arch-review agent/m,
      end: /^ {2}d\. /m,
    },
    // What the referencing document must point AT.
    pointer: /references\/pr-sentinel\.md/,
    steps: [
      {
        step: 'measure',
        name: /measure/i,
        // The two signals the measurement produces. A resolver called without
        // them cannot fire the window route at all — "an absent measurement
        // cannot fire that route, by design" — and the contested signal is read
        // out of the journal, so the probe has to be named too.
        markers: [/--input-tokens/, /--contested/, /delivery-log\.jsonl/],
        why: 'the judged input is measured: the diff size the window route needs, and whether this is a contested re-judgement',
      },
      {
        step: 'resolve',
        name: /resolve/i,
        markers: [/pipeline-config\.cjs model arch-review/],
        why: 'model and effort come from the ladder, never from an assumption',
      },
      {
        step: 'dispatch',
        name: /dispatch/i,
        markers: [/references\/arch-review\.md/],
        why: 'the judge is dispatched with its own reference as the prompt',
      },
      {
        step: 'record',
        name: /record/i,
        markers: [/log-event\.cjs arch_review/],
        why: 'the verdict reaches the journal — the guard\'s own contested rule is the reader, and this step is its only writer',
      },
    ],
    // The invocations that must live in exactly ONE of the two sections.
    // Deliberately NOT `gate-trailer.cjs write`, which both documents show on
    // purpose and `trailer.test.cjs` requires in both.
    statedOnce: [/pipeline-config\.cjs model arch-review/, /log-event\.cjs arch_review/],
  },
];

// ── the wired-mechanism table (ADR-007 D6) ──────────────────────────────────
//
// One row = one mechanism, its READER (who acts on it, quoted so a failure says
// what breaks) and every home that must reach it. `caller` is the invocation or
// assignment an agent or a script actually types — never the English words,
// which occur all over both documents, and never a shape the event's own schema
// documentation also has.

// A SLICE is the region of a home where the CALLER lives, in the shape
// `section()` below already reads. It is what makes a caller-deletion fail: the
// document that calls an event also documents it, so the whole file matches
// either way.
const STEP_D = {
  name: "deliver.md § step d — the main loop's post-push journal duty",
  start: /^ {2}d\. after EACH push:/m,
  // The babysit cycle is one fenced block and step d is its last item, so the
  // closing fence is the section end. Anything past it is the prose ABOUT the
  // cycle, which is exactly what must not satisfy a caller.
  end: /^```$/m,
};
const FIX_ROUND_ARGS = {
  name: 'deliver.md § the fix-round Workflow args literal',
  // The args object, and nothing of the paragraph that explains it: that
  // paragraph names `needsBaseMerge` twice and survived the deletion.
  start: /^ {3}args: \{prs: \[\{id, pr, branch/m,
  end: /^ {3}ciFixRefPath/m,
};
const SENTINEL_AFTER_PUSH = {
  name: "pr-sentinel.md § After EVERY push — the guard's own attempt row",
  start: /^## After EVERY push/m,
  end: /^## Hard rules/m,
};
const SENTINEL_BASE_MERGE = {
  name: "pr-sentinel.md § the `base-merge` duty",
  start: /^\*\*`base-merge`\*\*/m,
  end: /^\*\*`review-fix`\*\*/m,
};

// The tracker projection is ONE call, and the section around it names the
// script in prose three times over (the planner, the `plan` verb, the recorder
// the acting half invokes per item). So the slice is the paragraph that says
// WHERE the projection runs plus the fenced block under it — ending at the
// asymmetry paragraph, which is the next `**bold**` lead — and the pattern is
// the `scripts/<name>.cjs <verb>` path form that only an invocation writes.
const TRACKER_PROJECTION_CALL = {
  name: 'deliver.md § tracker projection — where it runs',
  start: /^\*\*Where it runs, and why nothing waits on it\.\*\*/m,
  end: /^\*\*A pending projection is not actionable/m,
};

// The invocation template a log line writes and a sentence about the field does
// not: `effort_applied=<level|unknown>` in the command, versus "the honest
// record is `effort_applied=unknown`" in the paragraph beside it — which is
// INSIDE step d, so the bare key passes with the log line deleted.
const EFFORT_APPLIED_KEY = /effort_applied=</;

const WIRED = [
  {
    kind: 'wired',
    mechanism: 'behind_by',
    reader: '`front.cjs baseMoved` — a green measured against a base that has MOVED is not a green',
    homes: [{ doc: STATE_SYNC, caller: [/entry\.behind_by\s*=/] }],
    why: 'GitHub reports `mergeStateStatus: BEHIND` only where branch protection requires up-to-date '
      + 'branches, so on an ordinary repo the compare count is the ONLY witness. With nothing writing it, '
      + 'the board offered exactly the merges `sentinel.cjs merge` refuses',
  },
  {
    kind: 'wired',
    mechanism: 'needsBaseMerge',
    reader: '`workflows/fix-round.mjs` — it makes the base merge step 0 of the fixer prompt',
    homes: [{ doc: DELIVER, slice: FIX_ROUND_ARGS, caller: [/needsBaseMerge/] }],
    why: 'until the fix round passes it, every fixer on the Workflow path measures the branch against a '
      + 'merge base that no longer exists: the test reproduces against the wrong code and the push may '
      + 'not even fast-forward',
  },
  {
    kind: 'wired',
    mechanism: 'the `base_merge` journal event',
    reader: '`pipeline-stats.cjs` and any reader of the journal asking which base moved in, and when',
    // TWO entry points perform this merge — the main loop in step d and the
    // guard in its own duty — and neither writes the event for the other.
    homes: [
      { doc: DELIVER, slice: STEP_D, caller: [/log-event\.cjs base_merge/] },
      { doc: PR_SENTINEL, slice: SENTINEL_BASE_MERGE, caller: [/log-event\.cjs base_merge/] },
    ],
    why: '`log-event.cjs` declares the event with four required fields and `sentinel.cjs` says the duty '
      + '"journals itself" — the script does no such thing, so the caller has to be named where each path '
      + 'reads, or the event is a contract with no writer',
  },
  {
    kind: 'wired',
    mechanism: 'drift-needed.cjs',
    reader: 'Step 2 — which tickets get a drift judge at all',
    homes: [{ doc: DELIVER, caller: [/drift-needed\.cjs/] }],
    why: 'the script SUPERSEDES Step 2\'s prose condition and its own header says so; measured over one '
      + 'session it would have cut 17 scans (1.24M subagent tokens, 21% of the session\'s agent spend) to '
      + 'the four that produced every reuse candidate',
  },
  {
    kind: 'wired',
    mechanism: '`effort_applied` on the attempt event',
    reader: '`failure-signature.cjs` — `repeat_exhausted` may only be claimed off a prior round that '
      + 'RECORDS the depth it spent',
    // The guard is the second writer of attempt rows, and the one whose repair
    // path can measure its own depth. Its line carried no `effort_applied` at
    // all while the same file told it to record the depth with
    // `dispatch-record.cjs --effort-applied`, which lands on a `dispatch` event
    // the escalation rule never reads.
    homes: [
      { doc: DELIVER, slice: STEP_D, caller: [/log-event\.cjs attempt/, EFFORT_APPLIED_KEY] },
      { doc: PR_SENTINEL, slice: SENTINEL_AFTER_PUSH, caller: [/log-event\.cjs attempt/, EFFORT_APPLIED_KEY] },
    ],
    why: 'T-28-02 made the ceiling rung depend on this field and nothing on the attempt path wrote it, so '
      + '`repeat_exhausted` was unreachable — the safe direction (absent proof reads as not-yet-spent) '
      + 'and still the exact defect this phase exists to remove',
  },
  {
    kind: 'wired',
    mechanism: '`front.cjs --parked` says what it did',
    reader: 'the operator who passed the flag and believes the park is now durable',
    // The ASSIGNMENT, in the shape `entry.behind_by =` already uses. The
    // constant's own `const` line and its export both name `PARKED_RENDER_ONLY`
    // and neither puts the notice on a board.
    homes: [{ doc: FRONT, caller: [/front\.parked_render_only\s*=/] }],
    why: 'the same flag on `state-sync.cjs` writes the board the stop gate enforces on, while here it '
      + 'renders and persists nothing — measured when the gate correctly refused a stop whose board still '
      + 'listed an item the orchestrator believed it had parked (the behaviour is pinned in front.test.cjs)',
  },
  {
    kind: 'wired',
    mechanism: '`jira-project.cjs plan` — the tracker projection\'s work list',
    reader: 'the acting half in deliver.md — the agent that asks the connected tracker for an issue\'s '
      + 'transitions and performs each emitted item',
    // ADR-008 D6 puts the call in the main loop AFTER a state-sync and
    // deliberately NOT inside it: state-sync's wall time is the tick rate. So
    // the one home is the paragraph in deliver.md that says where it runs.
    homes: [{ doc: DELIVER, slice: TRACKER_PROJECTION_CALL, caller: [/scripts\/jira-project\.cjs plan/] }],
    why: 'the planner is a read-only function of three LOCAL files and opens no socket — with no caller '
      + 'it computes nothing, the watermark never moves, and the whole acting half under it is a '
      + 'procedure nobody is ever told to begin. A tested, complete, inert mechanism is ADR-007\'s '
      + 'entire subject and the exact defect phase 28 shipped a fix for',
  },
  {
    kind: 'decided',
    mechanism: 'unresolved_count',
    reader: '`front.cjs reviewStandsAlone` — a review verdict with no thread behind it to service',
    home: FRONT,
    // Matched by CONTENT and not by line number: this phase moved the code around
    // it, and a citation that drifts is a citation that stops asserting.
    decision: [/`unresolved_count` is NOT a field state-sync writes/],
    // The other half, and the half that makes this a guard: a writer appearing
    // later is the finding, not a fix.
    absent: { home: STATE_SYNC, writer: /entry\.unresolved_count\s*=/ },
    why: 'an unresolved-thread count is a per-PR GraphQL query — the class of field that made a monorepo '
      + 'sync cost 41s instead of 7s — so the predicate fires for a caller that already HOLDS the count '
      + '(the guard, off the `reviewers.cjs unresolved` call it already makes) and for nobody else',
  },
];

// Every home a row declares, whatever key it used: the `decided` row names one
// document and no caller.
const homesOf = (row) => row.homes || [{ doc: row.home }];

// Extract a section by its two anchors, and REFUSE when either is missing: a
// slice to end-of-file matches markers from every later duty, which is the
// false-green shape this file exists to avoid.
function section(spec, text = fs.readFileSync(spec.doc, 'utf8')) {
  const label = path.basename(spec.doc);
  const startMatch = text.match(spec.start);
  assert.ok(startMatch, `${label}: section anchor ${spec.start} not found — the document was restructured, so this contract is asserting nothing`);
  // Skip past the FULL matched anchor, not one character of it — a slice of
  // `from + 1` drops the first character of the section (the heading's own
  // leading `*`, `#`, or whatever the anchor pattern matched), which is fine
  // for a marker deep in the section and wrong the moment one is required at
  // the very start of it.
  const rest = text.slice(startMatch.index + startMatch[0].length);
  const to = rest.search(spec.end);
  assert.ok(to >= 0, `${label}: closing anchor ${spec.end} not found after ${spec.start} — the slice would run to end-of-file and match other duties`);
  return { label, text: rest.slice(0, to) };
}

// A neighbourhood around the pointer, in the shape `trailer.test.cjs` uses for
// its own doc pin: `span` lines on EACH side of the pointer, not the whole
// file — a step named just above the pointer line must count too.
function pointerWindow(sectionText, pointer, span) {
  const lines = sectionText.split('\n');
  const at = lines.findIndex((l) => pointer.test(l));
  if (at < 0) return null;
  return lines.slice(Math.max(0, at - span), at + span + 1).join('\n');
}

for (const subject of SUBJECTS) {
  suite(`${subject.mechanism} — the sections this contract reads actually exist`);

  test(`both entry points expose a bounded ${subject.mechanism} section`, () => {
    const c = section(subject.canonical);
    const r = section(subject.referencing);
    assert.ok(c.text.trim().length > 0, `${c.label}: the canonical section is empty`);
    assert.ok(r.text.trim().length > 0, `${r.label}: the referencing section is empty`);
  });

  suite(`${subject.mechanism} — the canonical statement names all four steps`);

  const canon = section(subject.canonical);
  for (const s of subject.steps) {
    test(`${canon.label} states the ${s.step.toUpperCase()} step`, () => {
      for (const m of s.markers) {
        assert.ok(
          m.test(canon.text),
          `${canon.label}'s ${subject.mechanism} section does not state the ${s.step.toUpperCase()} step (${s.why}): no match for ${m}`
        );
      }
    });
  }

  suite(`${subject.mechanism} — the other entry point references that statement`);

  const ref = section(subject.referencing);
  const window = pointerWindow(ref.text, subject.pointer, 12);

  for (const s of subject.steps) {
    test(`${ref.label} names the ${s.step.toUpperCase()} step beside its pointer`, () => {
      assert.ok(
        window,
        `${ref.label}'s ${subject.mechanism} section does not point at the canonical statement (${subject.pointer}) — an agent on this path has nothing to read`
      );
      assert.ok(
        s.name.test(window),
        `${ref.label} points at the canonical statement but does not name the ${s.step.toUpperCase()} step beside it (${s.why}) — a step the pointer does not name is a step this path can skip in silence`
      );
    });
  }

  suite(`${subject.mechanism} — stated once, referenced twice`);

  test('the procedure is spelled out in exactly one of the two documents', () => {
    for (const inv of subject.statedOnce) {
      const carriers = [canon, ref].filter((d) => inv.test(d.text)).map((d) => d.label);
      assert.strictEqual(
        carriers.length, 1,
        carriers.length === 0
          ? `neither document's ${subject.mechanism} section invokes ${inv} — the procedure is stated nowhere`
          : `${carriers.join(' and ')} both spell out ${inv} in their ${subject.mechanism} section — duplication is the mechanism the two paths diverged through; state it once and reference it`
      );
    }
  });

  test('the canonical document is the one that spells it out', () => {
    for (const inv of subject.statedOnce) {
      assert.ok(
        inv.test(canon.text),
        `${canon.label} is the canonical statement for ${subject.mechanism} but does not invoke ${inv}`
      );
    }
  });
}

suite('every reader has a writer, or a recorded decision (ADR-007 D6)');

// The table itself must be readable before any row can assert anything — a home
// that moved makes every row below a no-op that passes.
for (const row of WIRED) {
  for (const home of homesOf(row)) {
    test(`the home declared for ${row.mechanism} exists (${path.basename(home.doc)})`, () => {
      assert.ok(fs.existsSync(home.doc), `${home.doc} does not exist — this row is asserting nothing`);
    });
  }
}

for (const row of WIRED.filter((r) => r.kind === 'wired')) {
  const homes = homesOf(row);
  for (const home of homes) {
    const where = home.slice ? home.slice.name : path.basename(home.doc);
    const scope = homes.length > 1
      ? 'one of the entry points that must reach it'
      : 'the one place that must reach it';
    test(`${where} names the caller for ${row.mechanism}`, () => {
      // The slice is read INSIDE the test, so a document restructured out from
      // under this row is a named failure and not a load-time crash.
      const text = home.slice
        ? section({ doc: home.doc, ...home.slice }).text
        : fs.readFileSync(home.doc, 'utf8');
      for (const c of home.caller) {
        assert.ok(
          c.test(text),
          `${row.mechanism} is read by ${row.reader}, and ${where} — ${scope} — `
          + `contains no match for ${c}. WHY IT MATTERS: ${row.why}. A mechanism nobody connected is not a mechanism.`
        );
      }
    });
  }
}

// THE BOUNDARY, ASSERTED. Every slice above exists to make a caller-deletion
// fail; this test is the other direction, and it is the one that keeps the pin
// installed. Deleting an event's SCHEMA documentation while its caller stands
// must NOT fail — a pin that goes red on documentation edits gets loosened by
// the next reader, and then the rows are unfailable again. So the assertion is
// the mutation, standing: remove `deliver.md`'s event-schema section from the
// text and require every DELIVER caller to still match. `pr-sentinel.md`
// documents no event contracts — it invokes them — so the boundary is
// `deliver.md`'s alone.
//
// It deliberately does NOT require the stripped section to still DECLARE those
// events, because that requirement is the very failure it guards against: a
// pin that reds when documentation is deleted is a pin that fires on
// documentation edits. The residual weakness, named: if the schema
// documentation ever moves OUT of the Telemetry section AND a caller slice
// grows to include it, this test would strip the wrong block and prove nothing.
// What it still catches — the case that was actually live — is a slice or a
// pattern that matches the documentation instead of the call.
test('deleting an event\'s schema documentation, caller in place, does not fire any row', () => {
  const TELEMETRY = {
    doc: DELIVER,
    start: /^## Telemetry \(pipeline log\)/m,
    end: /^## /m,
  };
  const full = fs.readFileSync(DELIVER, 'utf8');
  const schema = section(TELEMETRY, full).text;
  assert.ok(
    schema.trim().length > 0,
    'deliver.md\'s Telemetry section is empty, so this test strips nothing and asserts nothing'
  );
  const stripped = full.replace(schema, '\n');

  for (const row of WIRED.filter((r) => r.kind === 'wired')) {
    for (const home of homesOf(row).filter((h) => h.doc === DELIVER && h.slice)) {
      const text = section({ doc: home.doc, ...home.slice }, stripped).text;
      for (const c of home.caller) {
        assert.ok(
          c.test(text),
          'with deliver.md\'s event-schema documentation removed and every caller left in place, '
          + `${home.slice.name} no longer matches ${c} for ${row.mechanism} — this row is matching the `
          + 'DOCUMENTATION and not the caller, which is how four of these six rows became unfailable'
        );
      }
    }
  }
});

for (const row of WIRED.filter((r) => r.kind === 'decided')) {
  const label = path.basename(row.home);
  test(`${label} carries the recorded decision for ${row.mechanism}`, () => {
    const text = fs.readFileSync(row.home, 'utf8');
    for (const d of row.decision) {
      assert.ok(
        d.test(text),
        `${row.mechanism} is read by ${row.reader} and written by nobody. That is allowed ONLY while the `
        + `reason is written where a reader of the code looks, and ${label} no longer matches ${d} — `
        + `so what was a decision has become drift. WHY: ${row.why}`
      );
    }
  });

  test(`and nothing has quietly started writing ${row.mechanism}`, () => {
    const wLabel = path.basename(row.absent.home);
    const text = fs.readFileSync(row.absent.home, 'utf8');
    assert.ok(
      !row.absent.writer.test(text),
      `${wLabel} now matches ${row.absent.writer}, so ${row.mechanism} HAS a writer — and the decision `
      + `recorded in ${label} says why it must not. Either the cost measurement changed (then move this `
      + `row to \`kind: 'wired'\` and rewrite that comment) or the write is the defect. WHY: ${row.why}`
    );
  });
}

done();
