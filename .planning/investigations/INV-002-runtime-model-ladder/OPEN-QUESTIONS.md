# Open questions

- [x] What exact signals trigger each requested escalation rung, and which
      signals are intentionally excluded? → Role-scoped matrix recorded in
      DECISIONS: alternatives/very-complex for research, critical/checkpoint
      for decomposition, repeat/repeat_exhausted for repairs, contested /
      critical / measured window for judgement roles; fixed Luna roles are not
      model-promoted.
- [x] How can Claude Code preserve its existing palette while exposing the
      same role/escalation contract and mandatory dispatch evidence? → Keep the
      existing Claude palette as an immutable adapter input; require resolved
      alias/effort and an application receipt at its launch boundary.
- [x] What hard-fail behavior is safe for already-running parent sessions,
      inline fallbacks, unavailable models, and ambiguous runtime detection? →
      Refuse new routed dispatches lacking explicit runtime/model/effort,
      selected agent/launch arguments, or a receipt; historical sessions are
      not relabeled.
