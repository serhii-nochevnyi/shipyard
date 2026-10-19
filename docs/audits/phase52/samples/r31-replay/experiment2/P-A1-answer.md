```json
[
  {
    "path": "plugins/delivery-pipeline/scripts/jira-project.cjs",
    "line_start": 443,
    "line_end": 464,
    "anchor": "out.reason = 'pipeline.jira_transitions is empty, which is the projection switched off (the default)';",
    "category": "bug",
    "confidence": 50,
    "severity": "BLOCKER",
    "kept": false,
    "summary": "planItems loads config before checking that tickets.json exists, so a wrong cwd (no --graph) is reported as 'projection switched off' with exit 0 instead of a missing graph.",
    "failure_scenario": "An agent runs `jira-project.cjs plan` without --graph from a ticket worktree that has no .planning/: the config resolves to defaults, the empty-map branch fires first, and the tracker is never moved with no hint that the graph was not found. From a parked checkout with a stale tracked graph and no watermark store, it could instead emit catch-up items for tickets already projected."
  },
  {
    "path": "plugins/delivery-pipeline/scripts/jira-project.cjs",
    "line_start": 444,
    "line_end": 444,
    "anchor": "const { config, valid, error } = loadConfig(root);",
    "category": "history",
    "confidence": 50,
    "severity": "WARNING",
    "kept": false,
    "summary": "planItems discards loadConfig's warnings (unknown keys, malformed or non-status jira_transitions entries) on the success path.",
    "failure_scenario": "An operator sets jira_transitions to 'fix:In Progress' (a front bucket name); the entry is skipped, the map is empty, and `plan` reports 'switched off (the default)', indistinguishable from never having configured it."
  },
  {
    "path": "plugins/delivery-pipeline/scripts/jira-project.cjs",
    "line_start": 451,
    "line_end": 451,
    "anchor": "out.reason = `config is invalid (${error && error.message}) — no policy is in effect, so nothing is projected`;",
    "category": "history",
    "confidence": 50,
    "severity": "WARNING",
    "kept": false,
    "summary": "The invalid-config reason uses only error.message and never names the config file (error.relative is available); the test comment claims 'naming the file'.",
    "failure_scenario": "With --graph pointing at another project, `plan` prints 'config is invalid (is not valid JSON (...))' without a path, so the operator cannot tell which config to fix; in text mode the same reason is also printed on stdout beside the stderr warning."
  },
  {
    "path": "plugins/delivery-pipeline/scripts/jira-project.cjs",
    "line_start": 362,
    "line_end": 377,
    "anchor": "const events = statusChangesIn(readFrom(start), seeked);",
    "category": "history",
    "confidence": 50,
    "severity": "WARNING",
    "kept": false,
    "summary": "Each backward step re-reads and re-parses the whole suffix, and tickets already at the terminal 'merged' watermark stay in `need`, so the walk approaches a full journal read with quadratic cost.",
    "failure_scenario": "On a multi-megabyte journal with one old merged ticket, every `plan` round steps back ~64 KB at a time and re-parses the entire window each step; negligible at today's 139 KB, but it grows with journal size."
  },
  {
    "path": "plugins/delivery-pipeline/scripts/jira-project.cjs",
    "line_start": 343,
    "line_end": 350,
    "anchor": "const fd = fs.openSync(file, 'r');",
    "category": "bug",
    "confidence": 50,
    "severity": "BLOCKER",
    "kept": false,
    "summary": "Only statSync is guarded in readTransitions; openSync/readSync errors propagate out of planItems as an uncaught exception, and a corrupt tickets.json is mislabelled 'no tickets.json'.",
    "failure_scenario": "delivery-log.jsonl is a directory or unreadable: statSync succeeds, readSync throws EISDIR/EACCES, and `plan` exits 1 with a stack trace instead of degrading like stop-gate.cjs/front.cjs, which wrap the same read."
  },
  {
    "path": "plugins/delivery-pipeline/scripts/jira-project.cjs",
    "line_start": 262,
    "line_end": 263,
    "anchor": "// credential and no stub. Nothing below opens a socket; the negative pin from",
    "category": "comment",
    "confidence": 50,
    "severity": "WARNING",
    "kept": false,
    "summary": "The comment says the T-29-01 negative pin watches for network use, but that pin is the transitionName identifier sweep; only this script's own test sweep watches for sockets.",
    "failure_scenario": "A maintainer relying on the comment believes a second repo-wide no-network guard exists and removes or weakens the token sweep in jira-project.test.cjs, leaving nothing watching."
  },
  {
    "path": "plugins/delivery-pipeline/scripts/jira-project.cjs",
    "line_start": 455,
    "line_end": 455,
    "anchor": "if (config.jira.enabled === false) {",
    "category": "history",
    "confidence": 40,
    "severity": "BLOCKER",
    "kept": false,
    "summary": "jira.enabled is compared strictly to boolean false, and pipeline-config does not normalise string values the way it does for other booleans.",
    "failure_scenario": "A hand-edited config with \"jira\": {\"enabled\": \"false\"} and a non-empty jira_transitions still produces plan items, so an agent transitions the board of an operator who disabled Jira."
  },
  {
    "path": "plugins/delivery-pipeline/scripts/jira-project.cjs",
    "line_start": 516,
    "line_end": 516,
    "anchor": "if (hasProjected(ticket, e.to, store)) continue;",
    "category": "history",
    "confidence": 30,
    "severity": "BLOCKER",
    "kept": false,
    "summary": "The exactly-once test is per ticket and ignores the recorded Jira key, so re-keying a ticket after it was projected hides it from the planner.",
    "failure_scenario": "delivery.jira changes from MYD-1 to MYD-9 after the ticket was projected to merged; the old watermark makes plan skip it and MYD-9 is never transitioned."
  },
  {
    "path": "plugins/delivery-pipeline/scripts/jira-project.cjs",
    "line_start": 268,
    "line_end": 271,
    "anchor": "// here besides the journal lives at the PROJECT root, never at cwd, and the",
    "category": "comment",
    "confidence": 30,
    "severity": "WARNING",
    "kept": false,
    "summary": "The comment says everything besides the journal is read at the project root, but only the config is; tickets.json and jira-projection.json are read from the graph dir.",
    "failure_scenario": "A maintainer who trusts the comment moves the tickets.json and store reads to the project root and breaks the --graph case."
  },
  {
    "path": "plugins/delivery-pipeline/scripts/jira-project.cjs",
    "line_start": 419,
    "line_end": 427,
    "anchor": "if (rec.to !== item.to) return false;",
    "category": "history",
    "confidence": 20,
    "severity": "BLOCKER",
    "kept": false,
    "summary": "unreachableSuppressed compares only `to` and the timestamp, so a suppression never lifts when the Jira key or the status mapping is corrected, contradicting the 'lifts by itself' promise.",
    "failure_scenario": "A mistyped delivery.jira key causes an unreachable report at to=merged; the operator fixes the key, but merged is terminal so no newer status_change arrives and the item stays withheld forever (no clear verb in this change)."
  },
  {
    "path": "plugins/delivery-pipeline/scripts/jira-project.cjs",
    "line_start": 272,
    "line_end": 272,
    "anchor": "const projectRootFor = (dir) => path.resolve(dir, '..', '..');",
    "category": "history",
    "confidence": 20,
    "severity": "WARNING",
    "kept": false,
    "summary": "projectRootFor duplicates the identical body of the existing lockRootFor instead of aliasing it.",
    "failure_scenario": "If the graph layout changes and only one helper is updated, the planner's config root and the writer's lock root diverge."
  },
  {
    "path": "plugins/delivery-pipeline/scripts/jira-project.cjs",
    "line_start": 502,
    "line_end": 514,
    "anchor": "latest.set(e.ticket, e);",
    "category": "bug",
    "confidence": 25,
    "severity": "BLOCKER",
    "kept": false,
    "summary": "Collapsing to the latest status before the map lookup drops a mapped intermediate status when the latest status is unmapped.",
    "failure_scenario": "With map 'branched:In Progress, merged:Done', a ticket going pending -> branched -> pr-open between runs yields latest pr-open (unmapped), so 'In Progress' is never applied and the later merged -> Done jump may be refused by the Jira workflow."
  },
  {
    "path": "plugins/delivery-pipeline/scripts/jira-project.cjs",
    "line_start": 374,
    "line_end": 374,
    "anchor": "if (need.get(e.ticket) === e.to) { seen.add(e.ticket); covered++; }",
    "category": "bug",
    "confidence": 25,
    "severity": "BLOCKER",
    "kept": false,
    "summary": "A status_change record with no `to` for a non-subject ticket satisfies undefined === undefined and counts as coverage, ending the backward walk early.",
    "failure_scenario": "A malformed journal line {\"event\":\"status_change\",\"ticket\":\"X\"} inside the 64 KB window makes covered equal need.size before the subject's anchor event is reached, so a newer unprojected transition is missed that round (state-sync always writes `to`, so this needs a hand-written line)."
  },
  {
    "path": "plugins/delivery-pipeline/scripts/jira-project.cjs",
    "line_start": 259,
    "line_end": 260,
    "anchor": "// (ADR-008 D3.) `plan` is a pure function of THREE LOCAL FILES — the journal,",
    "category": "comment",
    "confidence": 25,
    "severity": "WARNING",
    "kept": false,
    "summary": "The comment names three local inputs, but planItems also reads jira-projection.json (watermarks and unreachable reports), a fourth input.",
    "failure_scenario": "A reader reasoning about what can change plan's output leaves out the store's watermarks and unreachable reports."
  },
  {
    "path": "tests/unit/jira-project.test.cjs",
    "line_start": 30,
    "line_end": 31,
    "anchor": "// Every fixture line is a REAL record copied out of `.planning/graph/delivery-log.jsonl`",
    "category": "comment",
    "confidence": 25,
    "severity": "WARNING",
    "kept": false,
    "summary": "The header says every fixture line is a real journal record, but most fixtures are built with sc()/pad() using invented timestamps and T-99-xx ids; only the REAL.* literals are verbatim.",
    "failure_scenario": "A reader trusts the stated provenance and assumes the fixture values, not just the shapes, were taken from the live journal."
  },
  {
    "path": "plugins/delivery-pipeline/scripts/jira-project.cjs",
    "line_start": 67,
    "line_end": 69,
    "anchor": "// CLI only, deliberately: T-29-04's planner `require`s this file for the",
    "category": "comment",
    "confidence": 10,
    "severity": "WARNING",
    "kept": false,
    "summary": "The comment names T-29-04's planner as a consumer that requires this file, but the planner now lives in this file; the real requirers are T-29-05 and the tests.",
    "failure_scenario": "Stale rationale only; the require.main guard is still correct and nothing breaks at runtime."
  },
  {
    "path": "plugins/delivery-pipeline/scripts/jira-project.cjs",
    "line_start": 570,
    "line_end": 572,
    "anchor": "console.log(`nothing to project${out.reason ? ` — ${out.reason}` : ''}`);",
    "category": "history",
    "confidence": 10,
    "severity": "WARNING",
    "kept": false,
    "summary": "The T-29-04 commit message says every off-switch 'says nothing', but the CLI prints 'nothing to project — <reason>' on stdout on every off-switch.",
    "failure_scenario": "Wording mismatch only: unconfigured projects see one report line per round, which the code comment calls a deliberate report rather than a warning."
  },
  {
    "path": "plugins/delivery-pipeline/scripts/jira-project.cjs",
    "line_start": 187,
    "line_end": 189,
    "anchor": "// that write (T-29-04/05) are not in this ticket, and a guard behind",
    "category": "comment",
    "confidence": 0,
    "severity": "WARNING",
    "kept": false,
    "summary": "The comment lists T-29-04 among verbs that write and are not in this ticket, but this diff is T-29-04 and its plan verb is read-only.",
    "failure_scenario": "Pre-existing, unmodified comment (line 186 in the parent commit) and plan never calls mutate(), so there is no behavioural consequence."
  }
]
```

### Code review

No issues found. Checked for bugs and CLAUDE.md compliance.