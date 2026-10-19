# T-52-06 local evidence

Only sandbox-assigned commands were run. Host-assigned publication and judgment tests remain pending.

## RED

`node --test tests/unit/code-review-core.test.cjs` first exited 1: MODULE_NOT_FOUND for code-review-core.cjs. The first implementation run exited 1: host identity/line-shift test lacked the required P-01 disposition; corrected the test input to supply unresolved with justification. Host judgment cases were authored before implementation and intentionally not run in the sandbox.

## Mutation checks

All mutations ran the exact sandbox argv `node --test tests/unit/code-review-core.test.cjs`; source was restored in finally.

| Mutation | Exit | Failed assertions |
| --- | --- | --- |
| keep-info | 1 | tracer drops INFO, keeps WARNING and evidenced BLOCKER, and rejects false passes; prior blockers require dispositions, unresolved stays once, resolved contradictions fail; prior blockers require dispositions, unresolved stays once, resolved contradictions fail (1.063166ms) | |
| allow-unevidenced-blocker | 1 | tracer drops INFO, keeps WARNING and evidenced BLOCKER, and rejects false passes; missing and unmatched citations are retained as new, never suppressible; evidence demotion covers every missing blocker field and unresolved prior input cannot match; evidence demotion covers every missing blocker field and unresolved prior input cannot match (0.16475ms) | |
| omit-ordinal | 1 | identical source lines have ordinals and are reread when a twin is inserted above; identical source lines have ordinals and are reread when a twin is inserted above (0.44375ms) | |
| trust-model-quote | 1 | missing and unmatched citations are retained as new, never suppressible; evidence demotion covers every missing blocker field and unresolved prior input cannot match; evidence demotion covers every missing blocker field and unresolved prior input cannot match (0.726209ms) | |
| reuse-earlier-ordinal | 1 | identical source lines have ordinals and are reread when a twin is inserted above; identical source lines have ordinals and are reread when a twin is inserted above (0.719708ms) | |
| count-incomplete | 1 | rounds count only complete full-scope lineage, independently of ticket set and contract; rounds count only complete full-scope lineage, independently of ticket set and contract (5.102292ms) | |
| ignore-ancestry | 1 | rounds count only complete full-scope lineage, independently of ticket set and contract; rounds count only complete full-scope lineage, independently of ticket set and contract (4.915708ms) | |
| allow-fourth-round | 1 | rounds count only complete full-scope lineage, independently of ticket set and contract; rounds count only complete full-scope lineage, independently of ticket set and contract (4.942542ms) | |
| repair-third-round | 1 | rounds count only complete full-scope lineage, independently of ticket set and contract; rounds count only complete full-scope lineage, independently of ticket set and contract (5.187667ms) | |
| ignore-disagreement | 1 | recorded disagreements match stored identity across shifts and survive into another round; recorded disagreements match stored identity across shifts and survive into another round (0.776625ms) | |
| allow-unknown-disagreement | 1 | recorded disagreements match stored identity across shifts and survive into another round; recorded disagreements match stored identity across shifts and survive into another round (1.550291ms) | |
| ignore-base-in-reuse-key | 1 | packet hides host digests, binds subject identity and refuses missing vocabulary; packet hides host digests, binds subject identity and refuses missing vocabulary (0.83825ms) | |
| ignore-contract-in-reuse-key | 1 | packet hides host digests, binds subject identity and refuses missing vocabulary; packet hides host digests, binds subject identity and refuses missing vocabulary (0.7995ms) | |
| hash-line-number | 1 | host identity survives line shifts, labels, whitespace and severity; statements differ; all lines map identically at context sizes 0, 3 and 50, and nearby fixes preserve identity; recorded disagreements match stored identity across shifts and survive into another round | |
| hash-model-id | 1 | host identity survives line shifts, labels, whitespace and severity; statements differ; identical source lines have ordinals and are reread when a twin is inserted above; all lines map identically at context sizes 0, 3 and 50, and nearby fixes preserve identity; prior blockers require dispositions, unresolved stays once, resolved contradictions fail; recorded disagreements match stored identity across shifts and survive into another round | |
| hash-model-rule | 1 | host identity survives line shifts, labels, whitespace and severity; statements differ; identical source lines have ordinals and are reread when a twin is inserted above; all lines map identically at context sizes 0, 3 and 50, and nearby fixes preserve identity; prior blockers require dispositions, unresolved stays once, resolved contradictions fail; recorded disagreements match stored identity across shifts and survive into another round | |
| hash-model-severity | 1 | host identity survives line shifts, labels, whitespace and severity; statements differ; identical source lines have ordinals and are reread when a twin is inserted above; all lines map identically at context sizes 0, 3 and 50, and nearby fixes preserve identity; prior blockers require dispositions, unresolved stays once, resolved contradictions fail; recorded disagreements match stored identity across shifts and survive into another round | |
| touch-entire-hunk | 1 | identical source lines have ordinals and are reread when a twin is inserted above; all lines map identically at context sizes 0, 3 and 50, and nearby fixes preserve identity; diff parser reads prefixes and exact counts, refuses malformed, renamed and deleted sections; prior blockers require dispositions, unresolved stays once, resolved contradictions fail; diff sections support standalone unified, spaces and Git quoted UTF-8 paths | |
| misread-zero-count-insertion | 1 | all lines map identically at context sizes 0, 3 and 50, and nearby fixes preserve identity | |
| drop-unresolved-citation | 1 | missing and unmatched citations are retained as new, never suppressible; evidence demotion covers every missing blocker field and unresolved prior input cannot match; untouched context warnings remain, changed warnings leave, and missing current citations never vanish | |
| key-rounds-by-ticket-digest | 1 | rounds count only complete full-scope lineage, independently of ticket set and contract | |
| count-lineageless-delta | 1 | rounds count only complete full-scope lineage, independently of ticket set and contract | |
| drop-suppressed-index-entry | 1 | recorded disagreements match stored identity across shifts and survive into another round | |

## Final sandbox checks

- `node --test tests/unit/code-review-core.test.cjs`: exit 0, 15 tests passed after restoration and the whitespace-quote correction.
- `node tests/unit/phase47-package-publication.test.cjs`: exit 0, 186 fixtures passed; fixture-only evidence, zero private or selected-reuse builds.
- `node --test tests/unit/legacy-pin-readers.test.cjs tests/unit/launch-upgrade-verification-record.test.cjs`: exit 0, 17 tests passed.
- `git diff --check`: exit 0.
- A read-only Python filesystem inventory of the canonical roots counted 164 files; plugins/shipyard counted 161. `git ls-tree HEAD plugins/delivery-pipeline/scripts/code-review-core.cjs` returned no parent entry. The temporary-builder count of 163 is an assertion for host verification, not locally verified evidence.

## Trusted host checks pending

These approved host-profile commands were intentionally not run in the sandbox:

- `node --test tests/unit/phase49-package-publication.test.cjs`
- `node --test tests/unit/role-artifact.test.cjs tests/unit/judgment-artifacts.test.cjs tests/unit/judgment-contract.test.cjs`

The candidate remains uncommitted. The trusted host owns staging, signing, candidate-tree authentication and the final verification result. No claim of full ticket verification is made here.
