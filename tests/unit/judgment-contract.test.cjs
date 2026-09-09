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

const fs = require('fs');
const path = require('path');
const { suite, test, done, assert } = require(path.join(__dirname, 'assert-harness.cjs'));

const ROOT = path.join(__dirname, '..', '..');
const PLUGIN = path.join(ROOT, 'plugins', 'delivery-pipeline');

const PR_SENTINEL = path.join(PLUGIN, 'references', 'pr-sentinel.md');
const DELIVER = path.join(PLUGIN, 'commands', 'deliver.md');

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

// Extract a section by its two anchors, and REFUSE when either is missing: a
// slice to end-of-file matches markers from every later duty, which is the
// false-green shape this file exists to avoid.
function section(spec) {
  const label = path.basename(spec.doc);
  const text = fs.readFileSync(spec.doc, 'utf8');
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
// its own doc pin: the lines from the pointer forward, not the whole file.
function pointerWindow(sectionText, pointer, span) {
  const lines = sectionText.split('\n');
  const at = lines.findIndex((l) => pointer.test(l));
  if (at < 0) return null;
  return lines.slice(Math.max(0, at - span), at + span + 1).join('\n');
}

for (const subject of SUBJECTS) {
  suite(`${subject.mechanism} — the sections this contract reads actually exist`);

  test('both entry points expose a bounded arch-review section', () => {
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

done();
