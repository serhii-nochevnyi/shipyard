# Backlog source index

Run `node plugins/delivery-pipeline/scripts/backlog-index.cjs --root <project>`.
Use `--query advisor` to select relevant sections, `--limit 100` to change the
20-item output limit, and `--manifest <json>` to read existing lifecycle evidence.
`--help` describes the CLI. Exit 2 reports invalid input or a filesystem failure.
Output states total/matched counts and truncation explicitly.

The CLI inventories `.planning/backlog/**/*.md` and phase directories starting
with `999.`, `999-` or exactly `999` under `.planning/phases`. Missing optional
directories are empty. Source symlinks are refused. Local notes and GSD phases
have separate source-qualified IDs. Markdown headings outside code fences become
individual sections, with a heading hash and occurrence number distinguishing
repeated headings. Renaming a source or its heading requires an explicit manifest
migration; unrelated files do not alter existing IDs. File hashes invalidate
verification when source content changes. Original text is never rewritten.

An optional JSON manifest has `schema_version: 1` and an `items` array. Each item
has `id`, `status` and optional `source_hash`, `revision`, `verification` fields.
Statuses: untriaged, verified_open, planned, in_progress, verified_closed, deferred,
superseded. Verified states require a 40-character revision, SHA-256 source hash
and nonempty verification-command/evidence strings. Duplicate IDs and unsupported
states are errors. Stale verification is shown as untriaged with prior_status;
orphans are reported, not deleted. The supplied manifest remains unchanged.

This initial index validates evidence structure only. It does not prove that a
commit landed or that recorded verification was actually performed; closure must
be verified by the reviewer before writing the manifest. No current source note
is automatically considered fixed. The following integration package owns the
manifest writer, verified lifecycle transitions and cold-start wiring. This CLI
alone does not complete REQ-86. It does not create tickets, mutate the graph,
install or patch GSD, export to Jira, or load the entire backlog into every agent.
