```json
[
  {
    "path": "plugins/delivery-pipeline/scripts/jira-project.cjs",
    "line_start": 444,
    "line_end": 465,
    "anchor": "const { config, valid, error } = loadConfig(root);",
    "category": "history",
    "confidence": 50,
    "severity": "WARNING",
    "kept": false,
    "summary": "planItems discards the warnings loadConfig returns, so a jira_transitions map emptied by a skipped bad entry is reported as the projection being off by default.",
    "failure_scenario": "delivery_pipeline.jira_transitions is set to \"fix:In Progress\" (not an allowed bucket). The entry is skipped with a warning and the map becomes empty, so plan returns items [] and warnings [], with the reason \"pipeline.jira_transitions is empty, which is the projection switched off (the default)\". The operator never sees why nothing projects, unless they read state-sync's board warnings."
  },
  {
    "path": "plugins/delivery-pipeline/scripts/jira-project.cjs",
    "line_start": 451,
    "line_end": 452,
    "anchor": "out.reason = `config is invalid (${error && error.message}) — no policy is in effect, so nothing is projected`;",
    "category": "history",
    "confidence": 50,
    "severity": "WARNING",
    "kept": false,
    "summary": "The invalid-config reason and warning name no file, although loadConfig supplies error.relative, and the test labelled 'naming the file' only checks the count and /invalid/.",
    "failure_scenario": ".planning/config.json is unparseable, so the output reads \"config is invalid (is not valid JSON (...)) — ...\" with no path. With a cross-repo graph or a worktree the operator cannot tell which project's file is broken."
  },
  {
    "path": "tests/unit/jira-project.test.cjs",
    "line_start": 30,
    "line_end": 32,
    "anchor": "// Every fixture line is a REAL record copied out of `.planning/graph/delivery-log.jsonl`",
    "category": "comment",
    "confidence": 40,
    "severity": "WARNING",
    "kept": false,
    "summary": "The header claims every fixture is a verbatim journal record, but most are synthesised: the journal has no merged to pr-open or to \"branched\" event, and the T-99-NN tickets exist only in pad().",
    "failure_scenario": "A maintainer trusts the comment, assumes the reopen and branched shapes occur in the real journal, and writes behaviour against them. Which fixture lines are verbatim cannot be told."
  },
  {
    "path": "plugins/delivery-pipeline/scripts/jira-project.cjs",
    "line_start": 565,
    "line_end": 565,
    "anchor": "const out = planItems();",
    "category": "history",
    "confidence": 35,
    "severity": "WARNING",
    "kept": false,
    "summary": "The plan CLI resolves the graph and config from cwd with no refusal, so a run from a directory without .planning reports the projection as off by default instead of naming the wrong directory.",
    "failure_scenario": "plan is run without --graph from a ticket worktree that has no .planning/. loadConfig returns defaults with an empty jira_transitions, and plan exits 0 saying \"nothing to project — pipeline.jira_transitions is empty ... (the default)\". Nothing is projected and the cause is misattributed to config. No caller of plan exists yet at HEAD, and read verbs are deliberately permissive."
  },
  {
    "path": "plugins/delivery-pipeline/scripts/jira-project.cjs",
    "line_start": 270,
    "line_end": 271,
    "anchor": "// here besides the journal lives at the PROJECT root, never at cwd, and the",
    "category": "comment",
    "confidence": 35,
    "severity": "WARNING",
    "kept": false,
    "summary": "The comment says everything read besides the journal lives at the project root, but only config.json does; tickets.json and the projection store come from the graph dir.",
    "failure_scenario": "A maintainer follows the comment and resolves tickets.json or the store from projectRootFor(dir), which looks in the wrong directory. The code itself is correct today."
  },
  {
    "path": "plugins/delivery-pipeline/scripts/jira-project.cjs",
    "line_start": 507,
    "line_end": 514,
    "anchor": "latest.set(e.ticket, e);",
    "category": "bug",
    "confidence": 25,
    "severity": "WARNING",
    "kept": false,
    "summary": "Events are collapsed to the latest per ticket before the status map is consulted, so a mapped intermediate status is lost when the latest status is unmapped.",
    "failure_scenario": "With jira_transitions {branched: 'In Progress', merged: 'Done'}, a ticket goes pending to pr-open within one sync round. The latest event, pr-open, is unmapped, so the item is skipped and the tracker later jumps straight to Done. Plan 29-04 specifies collapse at the latest status and silent skip of unmapped statuses as separate rules, so this appears intentional."
  },
  {
    "path": "plugins/delivery-pipeline/scripts/jira-project.cjs",
    "line_start": 272,
    "line_end": 272,
    "anchor": "const projectRootFor = (dir) => path.resolve(dir, '..', '..');",
    "category": "history",
    "confidence": 25,
    "severity": "WARNING",
    "kept": false,
    "summary": "projectRootFor duplicates the body of the existing lockRootFor instead of aliasing it.",
    "failure_scenario": "A later change to lockRootFor's graph-dir to project-root mapping misses projectRootFor, so config is read from one root while the lock sits under another. Both are fixed to <project>/.planning/graph today."
  },
  {
    "path": "plugins/delivery-pipeline/scripts/jira-project.cjs",
    "line_start": 436,
    "line_end": 439,
    "anchor": "* Every off-switch answers with an EMPTY LIST and exit 0, never a warning: this",
    "category": "comment",
    "confidence": 25,
    "severity": "WARNING",
    "kept": false,
    "summary": "The docstring says every off-switch is silent, but the invalid-config branch disables the projection and pushes a warning.",
    "failure_scenario": "Someone relies on the docstring, treats the invalid-config warning as a bug and silences it, against the test that pins it. The inline comment a few lines below already acknowledges the exception."
  },
  {
    "path": "plugins/delivery-pipeline/scripts/jira-project.cjs",
    "line_start": 432,
    "line_end": 432,
    "anchor": "* Returns `{graph, enabled, reason, items, warnings}`. `items` carry",
    "category": "comment",
    "confidence": 25,
    "severity": "WARNING",
    "kept": false,
    "summary": "The documented return shape omits the journal field that planItems sets and that plan --json emits.",
    "failure_scenario": "A consumer written from the docstring does not know about out.journal. The field is additive, so nothing breaks."
  },
  {
    "path": "plugins/delivery-pipeline/scripts/jira-project.cjs",
    "line_start": 356,
    "line_end": 377,
    "anchor": "need.set(ticket, projectedTo);",
    "category": "history",
    "confidence": 20,
    "severity": "WARNING",
    "kept": false,
    "summary": "Subjects whose watermark is merged can never yield an item yet still pin the backward window, and each step re-parses the whole cumulative slab.",
    "failure_scenario": "On a multi-megabyte journal, every long-merged subject drags the window back to its merge event each round, and the quadratic re-parse costs seconds per plan. At the current 142 KB the walk is about three steps."
  },
  {
    "path": "plugins/delivery-pipeline/scripts/jira-project.cjs",
    "line_start": 426,
    "line_end": 426,
    "anchor": "return !(now > at);",
    "category": "history",
    "confidence": 15,
    "severity": "WARNING",
    "kept": false,
    "summary": "A duplicate same-to status_change with a newer ts lifts an unreachable suppression, although the board did not move.",
    "failure_scenario": "plan emits an item at ts t1 and a duplicate pr-open event lands at t2 > t1. The next round re-emits the item, costing one extra tracker call. The real journal has such doubled records for 4 tickets, but no record writer exists at HEAD and the lift on a newer event is the documented design."
  },
  {
    "path": "plugins/delivery-pipeline/scripts/jira-project.cjs",
    "line_start": 374,
    "line_end": 374,
    "anchor": "if (need.get(e.ticket) === e.to) { seen.add(e.ticket); covered++; }",
    "category": "bug",
    "confidence": 10,
    "severity": "WARNING",
    "kept": false,
    "summary": "A status_change with no to field matches need.get() of undefined for a non-subject ticket, inflating covered and ending the backward scan early.",
    "failure_scenario": "A hand-edited journal line {\"event\":\"status_change\",\"ticket\":\"T-99-01\"} near the tail stops the scan before an older subject's anchor event is read, so that subject's item is dropped. No writer emits a status_change without to, and log-event.cjs refuses hand-written ones."
  }
]
```

### Code review

No issues found. Checked for bugs and CLAUDE.md compliance.