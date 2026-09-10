# Rollout — ADR-013 GSD workflow synchronization

1. Add the canonical synchronizer and unit tests using temporary planning
   roots; prove idempotency, conflict refusal, source-fingerprint drift, and
   evidence status mapping.
2. Add the capability gate and installer/generator coverage; run the Claude and
   Codex smoke suites.
3. Run the synchronizer in write mode in this repository, review generated
   planning artifacts, then run `--check` and the installed GSD health/progress
   queries.
4. Keep any phase reported `pending` or `gaps_found` in that state until its
   existing integration owner supplies evidence. Do not mass-edit integration
   reports to satisfy the new projection.
5. Add synchronization to the delivery command's finalization instructions so
   manual fallback paths also publish the same state.
