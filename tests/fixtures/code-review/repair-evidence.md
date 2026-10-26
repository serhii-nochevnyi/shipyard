# T-52-06 native review repair evidence

Baseline: `cfcc12637749df106fd542d29966591acf29f40e`, clean tracked tree.
The existing untracked `.shipyard-drift-evidence.md` is preserved.

## RED

`node --test tests/unit/code-review-core.test.cjs` exited 1 before implementation:
15 passed, 3 failed.

- CR-01, three twins across three rounds: disagreement recipients were
  `[true, false, false]`, expected `[false, true, false]` after the ordinal shift.
- CR-01, single target: reloading the unchanged carrier after the ordinal shift
  threw `DISPOSITION_TARGET_UNKNOWN`.
- CR-03: collision resolution prefixed a 128-byte id with `P-01:`, exceeding
  the artifact's 128-byte limit.

CR-02's sealing regression is authored before the implementation. Its execution
belongs to the assigned trusted host command, which must not run in this sandbox.
The baseline sealing branch rejects `coverage.length > 128`; the regression
passes 129 small references through normalization and sealing and checks the
shared 2000-asset boundary and incomplete-coverage refusal.

The inline source review also reproduced the recorded-WARNING/returned-BLOCKER
shape mismatch: the same core command exited 1 with 20 passes and one failure
because the WARNING retained a `fix_ticket`. Removing the repair field when
restoring the sealed WARNING severity repairs that path.

## GREEN sandbox checks

- `node --test tests/unit/code-review-core.test.cjs`: exit 0, 21 tests passed.
- `node tests/unit/phase47-package-publication.test.cjs`: exit 0,
  `{"status":"passed","fixture_only":true,"fixtures":{"passed":186,"private_build_calls":0,"selected_reuse_build_calls":0}}`.
- `node --test tests/unit/legacy-pin-readers.test.cjs tests/unit/launch-upgrade-verification-record.test.cjs`:
  exit 0, 17 tests passed.
- `git diff --check`: exit 0.

## Repair review

Inline deep source review traced normalization through complete finding
validation, complete-result serialization, archive validation, authenticated
prior lookup and current verdict lookup. The new host-only retained
`disagreement_identity` survives those paths; it remains separate from the
current source identity and is omitted from reviewer packets. Retained bindings
take precedence over ordinal collisions. Model-supplied binding and suppression
fields are ignored during normalization. The seal rejects malformed bindings
and duplicate retained targets. The carrier schema is unchanged.

Collision labels reserve all original labels before generating replacements,
including when a model label already equals a generated candidate. Replacements
are ASCII and bounded even for 128-byte multibyte labels. Finding identity,
blocking counts and repair payloads do not depend on these labels.

Coverage sealing reads `FILE_LIMITS.assets` from the existing shared module;
it retains the coverage-status and incomplete-verdict checks. Input-manifest
coverage validation remains with its owning ticket. The host regressions cover
129 and 2000 entries, refusal at 2001, unknown status and an unread partition.
They have not been executed in this sandbox.

The path-prefix regex was rewritten with equivalent character classes to avoid
the comment scanner's adjacent-slash ambiguity. The declared path/identity core
tests pass. The publication comment gate remains a coordinator obligation.

No canonical packaged file was added by this repair. The inherited
`currentSourceInventories` already pins 164 inputs, 161 committed outputs and
163 builder outputs; it is retained, together with historical selections.
`git ls-files scripts plugins/delivery-pipeline capabilities/delivery-pipeline | wc -l`
reports 164; `git ls-files plugins/shipyard | wc -l` reports 161.

The canonical `52-06-REVIEW.md` was not delivered and is absent from this
worktree; its complete text was requested. The three repair scopes above come
from the delivered Revision 14 PLAN. This inline review does not replace the
coordinator's fresh native deep review or its publication clearance.

## Verification boundary

The assigned host commands remain pending trusted execution:

- `node --test tests/unit/phase49-package-publication.test.cjs`
- `node --test tests/unit/role-artifact.test.cjs tests/unit/judgment-artifacts.test.cjs tests/unit/judgment-contract.test.cjs`

No host command, GPG setup, socket setup, stage, signature, commit or publication
is performed by this executor.
