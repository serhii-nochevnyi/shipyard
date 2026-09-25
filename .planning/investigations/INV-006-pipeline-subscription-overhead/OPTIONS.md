# Options

Implementation alternatives pending formal research. The scope and sequencing
are already captured; the following are comparison candidates, not decisions.

| Candidate | Benefit | Risk | Evidence needed |
| --- | --- | --- | --- |
| Extend existing host/controller/handoff paths | Reuses ownership and evidence contracts | Existing coupling may need migration | Caller and persistence map |
| Add narrow adapters around those paths | Can isolate recovery and measurement | Duplicated state or inconsistent admission | Source-of-truth and failure analysis |

Compare per concern: projection fingerprints, continuation, finalization and
usage joins. Do not choose a second general orchestration framework by default.
