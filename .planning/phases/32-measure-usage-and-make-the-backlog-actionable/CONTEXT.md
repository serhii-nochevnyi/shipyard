# Phase 32 — execution scope, 2026-09-10

The operator requested completion of the interrupted Claude work and taking the
optimization waves into execution. ADR-011 is adopted for this program.

Start with T-32-01/02, two file-disjoint, read-only CLI slices of wave 0. They may
be implemented ahead of phases 30/31 because they touch none of their owners.
No cold-start/config/dispatch modification is authorized by these two contracts.
OPT-03–05 and the cold-start/statistics wiring remainder still require their own
plans after ownership revalidation. The two tickets do NOT complete all of phase
32 or satisfy wave 0's prospective-baseline and cold-start exit gates by themselves.
Do not declare the full optimization program validated from fixture tests.

Jira export is disabled by project configuration. No high-risk checkpoint tickets
exist in this initial slice. All normal CI, scope and review gates remain.
