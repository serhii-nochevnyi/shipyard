# Tracker projection and eligibility (read by `/shipyard:deliver`)

Used only when the project enables the tracker: `jira_transitions`
(`delivery_pipeline.jira_transitions`; `pipeline.*` is read too) maps OUR status to
THEIR target status NAME (`pr-open:In Progress, merged:Done`) and is EMPTY by
default; `jira_todo_statuses` gates eligibility.

**Tracker eligibility is opt-in by status NAME.** `jira_todo_statuses`
(`delivery_pipeline.jira_todo_statuses`) is a comma-separated allowlist such as
`To Do, Backlog, Selected for Development` (tracker spelling and order kept). Empty
disables the gate; matching uses the status NAME only, with no `statusCategory`
fallback. When the gate is enabled, a person may bypass it only for one explicitly
named ticket after the observation has been recorded — canonical ticket id and Jira
key, observation preserved, reason stated:

```bash
# Canonical argv shape: tracker-record.cjs override <T> <KEY> --reason <REASON> --graph <GRAPH>
# The four values are data from the adapter; never interpolate them into shell source.
node ${CLAUDE_PLUGIN_ROOT}/scripts/tracker-record.cjs override "$ticket_id" "$jira_key" \
  --reason "$override_reason" --graph "$project_graph"
```

This is an exact-ticket escape hatch, not a scope setting: `whole phase N`,
`everything reachable` and `all ready` never invoke `override`. The
generation-bound record expires on the next delivery snapshot and must rest on a
complete status-plus-assignee observation from the same generation. A missing
tracker answer is retained as `unknown`, never fabricated into a To Do/unassigned
pair.

Each emitted item carries `{ticket, key, from, to, target_status, ts}`: `to` is OUR
status (`pending`, `branched`, `pr-open`, `merged`), `target_status` is THEIR status
NAME off the map, `ts` is the driving `status_change`'s own timestamp. For EACH item:

1. Ask the connected tracker MCP for the issue's available transitions (e.g.
   `getTransitionsForJiraIssue`); no hand-rolled REST.
2. **Match on the TARGET STATUS, never on the transition's own name**, then
   transition **by that ID** (the only argument every MCP variant takes).
3. **Record it, with the id as the evidence** (use the `to` of the item actually
   performed; this alone advances the watermark and journals `jira_transition`; a
   report with no id is refused and an unrecorded transition is projected again):

   ```bash
   node ${CLAUDE_PLUGIN_ROOT}/scripts/jira-project.cjs record <T> <KEY> \
     --to <the performed item's "to"> --transition-id <id> --status "<the target status name>"
   ```
4. **Target not reachable → report it, do not retry** (an ordinary outcome; `--to` is
   OUR status; the item is withheld until a NEWER `status_change` arrives):

   ```bash
   node ${CLAUDE_PLUGIN_ROOT}/scripts/jira-project.cjs record --unreachable <T> <KEY> \
     --to <the item's own "to"> --offered "<the transitions that WERE offered>"
   ```
5. Never pass a comment through the transition (it may be dropped silently while
   the transition reports success); comments, worklogs and the phase Epic issue
   are out of scope. No tracker MCP connected, or the map empty → skip with ONE line.

## Eligibility read (only when `jira_todo_statuses` is non-empty)

After scope selection and before any pending ticket can enter `execute`, read each
pending ticket exactly once through the connected Jira MCP (its issue-read
operation, e.g. `getJiraIssue`, with only the issue key and the identifiers its
schema requires; no changelog/worklog). Read `status.name` and `assignee` from the
top-level response or from `fields.status`/`fields.assignee`: a literal `null`
assignee is explicitly unassigned; a missing or unreadable one is `unknown`.

MCP values are data, never shell source: the adapter passes them as its own argv
entries or, if the only runner is a shell, as variables in quoted arguments — never
interpolated into a constructed command, never `eval`:

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/tracker-record.cjs mark "$ticket_id" "$jira_key" \
  --status "$status_name" --assignee "$assignee_id" --graph "$project_graph"   # assignee_id "none" for a literal null
node ${CLAUDE_PLUGIN_ROOT}/scripts/tracker-record.cjs unknown "$ticket_id" "$jira_key" \
  --reason "$tracker_error" --graph "$project_graph"
```

`mark` records a successful observation; `unknown` records a failed or incomplete
call, keeping the tracker's error words. Read the cache after recording and
recompute the front before dispatching: a current-generation configured-status,
unassigned observation reaches `execute`; assigned, wrong-status, missing and
`unknown` observations park only that ticket with the tracker reason. If the
command names one exact ticket, the operator may then run `override` for it; a set
scope never does, and the front accepts an override only alongside a known
`eligible` or `ineligible` verdict. An unavailable Jira MCP is a per-ticket
`unknown`, not permission to proceed and not a reason to stop other tickets.
