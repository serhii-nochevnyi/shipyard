# Phase 30 integration review

- **Phase:** 30 — A ticket you cannot reach is not deliverable
- **Implementation head reviewed:** `origin/main` at `100f0c47da59f7542fb2a14527084a1db4dd3f1a`
- **Implementation tree:** `6cb7cacb80b4a508aae2c0158438cef940e779a4`
- **Integration PR:** #123, merge commit `ba2a0674303c2ee1b66e35efb095cb237de8c8cc`
- **Tickets:** T-30-01 / PR #109, T-30-02 / PR #110, T-30-03 / PR #111,
  T-30-04 / PR #113, T-30-05 / PR #114, T-30-06 / PR #115,
  T-30-07 / PR #116, T-30-08 / PR #117, T-30-09 / PR #118,
  T-30-10 / PR #122
- **Review mode:** inline Codex repository review; no separate reviewer result is claimed

## Verdict

**passed (repository-verifiable acceptance)**

The phase forms one reachable path from a delivery ticket to an executable
checkout. Configuration is checked first, origin-based discovery is bounded to
declared roots, cloning is an explicit write step, and the clone is accepted
only after origin and base-ref checks. The sentinel then uses the observed PR
branch while retaining same-phase, checkpoint, and merged-parent boundaries.

## Cross-ticket coherence

1. `repo-resolve.cjs` owns the configured-checkout, discovery, operator-choice,
   clone, adoption, persistence, and quarantine decisions. `state-sync.cjs`
   consumes `resolveAndPersistRepository`, so the board and delivery path share
   one resolution result (`plugins/delivery-pipeline/scripts/repo-resolve.cjs:739-787, 1465-1575`; `plugins/delivery-pipeline/scripts/state-sync.cjs:499-510`).
2. The same destination validator is used for supplied checkouts and clone
   destinations. It applies the absolute-root and `sub_repos` nesting policy
   before a filesystem write (`plugins/delivery-pipeline/scripts/repo-resolve.cjs:833-847, 901-937, 1201-1225`).
3. The explicit clone path follows the project's origin protocol, uses a full
   `git clone`, verifies `origin/<base>`, and refuses an existing mismatched
   path without deleting or replacing it (`plugins/delivery-pipeline/scripts/repo-resolve.cjs:1005-1010, 1150-1177, 1235-1268, 1321-1395`).
4. The sentinel accepts both the canonical and observed branch identities only
   for tickets in the same phase and repository. Open checkpoint parents remain
   human holds and merged-parent branches remain limbs (`plugins/delivery-pipeline/scripts/sentinel.cjs:535-573, 921-990`).
5. The command-backed verification rule is carried through role references and
   workflow prompt builders, and the source contract checks the complete set of
   required callers (`plugins/delivery-pipeline/references/arch-review.md:1-120`; `tests/unit/source-contract.test.cjs`).

## Acceptance sweep

| Ticket | Integrated result | Evidence |
|---|---|---|
| T-30-01 | Claims that can be checked name commands; arch-review and source-contract enforce the rule. | `plugins/delivery-pipeline/references/`; `plugins/delivery-pipeline/workflows/`; `tests/unit/source-contract.test.cjs` |
| T-30-02 | Configured absolute checkouts resolve first; unavailable, invalid, and malformed inputs remain track-only or refuse before mutation. | `repo-resolve.cjs:739-787`; `tests/unit/repo-resolve.test.cjs` |
| T-30-03 | Discovery matches normalized GitHub origin over declared one-level roots and reports none, one, ambiguity, or quarantine explicitly. | `repo-resolve.cjs:641-730`; `tests/unit/repo-resolve.test.cjs` |
| T-30-04 | Clone, existing-path, and skip are explicit choices; unattended choice parks without writes. | `repo-resolve.cjs:901-1002`; `tests/unit/repo-resolve.test.cjs`; `tests/smoke/repo-resolve-smoke.sh` |
| T-30-05 | Repository roots and destinations use the shared absolute/nesting validator. | `repo-resolve.cjs:833-847, 1201-1225`; `tests/unit/pipeline-config.test.cjs`; `tests/unit/repo-resolve.test.cjs` |
| T-30-06 | SSH and HTTPS project origins select the matching repository URL; credentials and inconsistent metadata are refused. | `repo-resolve.cjs:128-187, 210-257, 1271-1283`; `tests/unit/repo-resolve.test.cjs` |
| T-30-07 | The clone command has no shallow, filter, or single-branch option and the required `origin/<base>` ref is verified. | `repo-resolve.cjs:1005-1010, 1180-1199, 1321-1395`; `tests/smoke/repo-resolve-smoke.sh` |
| T-30-08 | A matching checkout is adopted; non-Git and origin-mismatched paths are refused untouched, including concurrent/repeated resolution. | `repo-resolve.cjs:939-967, 1235-1268`; `tests/unit/repo-resolve.test.cjs`; `tests/unit/record-stores.test.cjs` |
| T-30-09 | Successful resolution is written back atomically; failures remain trackable and do not stop unrelated repositories. | `repo-resolve.cjs:445-513, 575-589`; `state-sync.cjs:499-510`; `tests/unit/repo-resolve.test.cjs`; `tests/unit/pipeline-config.test.cjs` |
| T-30-10 | Sentinel stack checks and child retargeting use observed PR branches without widening phase, repository, checkpoint, or limb boundaries. | `sentinel.cjs:921-1005, 1144-1207`; `tests/unit/sentinel.test.cjs` |

## Verification evidence

The following commands were run from the clean integration worktree at the
implementation head named above:

- `node --test tests/unit/repo-resolve.test.cjs tests/unit/pipeline-config.test.cjs tests/unit/source-contract.test.cjs tests/unit/record-stores.test.cjs tests/unit/sentinel.test.cjs` — exit 0.
- `node --test tests/unit/tracker-eligibility.test.cjs tests/unit/tracker-record.test.cjs tests/unit/tracker-wiring-contract.test.cjs tests/unit/delivery-cold-start-contract.test.cjs tests/unit/front.test.cjs tests/unit/log-event.test.cjs tests/unit/judgment-contract.test.cjs` — exit 0 for the cross-phase consumer suite.
- `bash tests/smoke/repo-resolve-smoke.sh` — both unattended no-write and full-clone/base-ref checks passed.
- `bash tests/smoke/sentinel-smoke.sh` — 168 assertions passed.
- `node --check plugins/delivery-pipeline/scripts/repo-resolve.cjs` — exit 0.
- `node --check plugins/delivery-pipeline/scripts/sentinel.cjs` — exit 0.
- `node plugins/delivery-pipeline/scripts/validate-graph.cjs` — exit 0; 130 ticket records validated.

The integration PR and every ticket PR listed above are recorded as merged in
`.planning/graph/delivery-state.json`. No cross-ticket coherence, acceptance,
or repository-local verification finding remains for this phase.

## Machine result

```json
{
  "outcome": "passed",
  "phase": "30-a-ticket-you-cannot-reach-is-not-deliverable",
  "head": "100f0c47da59f7542fb2a14527084a1db4dd3f1a",
  "head_tree": "6cb7cacb80b4a508aae2c0158438cef940e779a4",
  "base": "origin/main",
  "base_tree": "6cb7cacb80b4a508aae2c0158438cef940e779a4",
  "ticket_set": ["T-30-01", "T-30-02", "T-30-03", "T-30-04", "T-30-05", "T-30-06", "T-30-07", "T-30-08", "T-30-09", "T-30-10"],
  "ticket_set_digest": "8bf2dc1dd5da4d5d79b7278c2707d91cd66b1c40d5c4ec15c15d287adc2cc07e",
  "blocking_count": 0,
  "findings": []
}
```

**Final verdict: passed.**
