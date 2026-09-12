# ADR-014 data model

The policy is represented as role-scoped ordered rungs:

```json
{
  "role": "research",
  "rungs": [
    {"name":"base", "model":"terra", "effort":"high"},
    {"name":"alternatives", "model":"sol", "effort":"medium"},
    {"name":"very-complex", "model":"astra", "effort":"medium"}
  ],
  "signals": {
    "alternatives": "rung:alternatives",
    "very-complex": "rung:very-complex"
  }
}
```

Fixed roles have a single rung. Repair roles have ordered evidence-backed
progression. The model label is logical until the runtime adapter resolves it
to a concrete ID or an existing Claude palette alias. Every result carries a
policy fingerprint so stale generated artifacts and cross-version receipts are
detectable.
