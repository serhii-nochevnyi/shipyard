Written 2026-10-19 BEFORE the second experiment was run (identity by host, two arms).
Arm P: prototype reviewer on the logic of code-review:code-review (confidence >= 80 filter).
Arm G: the installed gsd-code-reviewer agent, unmodified.
Same head (9b4e167188), same four inputs A1 A2 B1 B2. Host identity of a finding = sha256(path + "\n" + normalised text of the source line the finding cites, read from that run's own checkout). No model-written rule slug is used.
Mechanical metrics (no judgement): K = number of distinct identities; K4 = identities present in all four runs; K2 = identities present in at least two runs; stable = K4 / K2.
Proposed pass criterion (the operator has not yet accepted it): K4 >= 3 and stable >= 0.8, and the severity/confidence class of a K4 identity does not change between runs.
The old criterion (>=5 defects in all four runs, identity unchanged) is reported alongside for comparison.
