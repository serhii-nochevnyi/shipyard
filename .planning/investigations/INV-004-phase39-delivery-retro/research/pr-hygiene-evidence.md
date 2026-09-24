# Evidence — pipeline internals leak into target-project PRs (input to INV-004)

User requirement (2026-09-24): PRs the conveyor opens on a target project must
not carry the technical details of the conveyor and GSD tooling (plans, ticket
ids, phases, ADR numbers, state files, "everything else").

Observed on the proving ground `pdffiller/pdffiller-ai-assistant`:

- Ticket PR #702 — title `T-23-05: one resolved payload selects …`; body first
  line `Ticket: T-23-05`; second line `Jira: MYD-18127 · Phase 23 (ADR-024) ·
  cascades off \`ticket/T-23-04-…\` (PR #701)`; branch `ticket/T-23-05-…`.
- Epic PRs #693, #706 — title `epic: 22-batched-text-replacement integration`.
- Epic → main PR #693 carries `.planning/phases/22-batched-text-replacement/22-06-DEVIATIONS.md`
  and `.planning/phases/22-batched-text-replacement/BASELINE.md` into `main`
  (the proving ground tracks `.planning/`).
- Ticket PRs #702, #703, #706 carry no `.planning/` paths — the leak is in
  titles/bodies/branch names and in the epic integration diff.

Constraint to resolve: the `Ticket: <T>` first body line is a matching key for
ticket ↔ PR matching (see `scripts/*` greps below), so it cannot simply be
removed without an alternative key (branch name, hidden HTML marker, local
ledger of PR numbers).

Shipyard's own repository is out of scope for this rule (its PRs are about the
conveyor itself).
/Volumes/KINGSTON/claude-shipyard/plugins/delivery-pipeline/scripts/claude-delivery-host.cjs:53:    return { ...rest, runTicket: scope.ticket,
/Volumes/KINGSTON/claude-shipyard/plugins/delivery-pipeline/scripts/gsd-sync.cjs:870:    `- Ticket: ${plan.ticket}`,
/Volumes/KINGSTON/claude-shipyard/plugins/delivery-pipeline/scripts/role-artifact.cjs:404:  if (firstLine !== `Ticket: ${ticket}`) {
/Volumes/KINGSTON/claude-shipyard/plugins/delivery-pipeline/scripts/role-artifact.cjs:406:      expected: `Ticket: ${ticket}`,
