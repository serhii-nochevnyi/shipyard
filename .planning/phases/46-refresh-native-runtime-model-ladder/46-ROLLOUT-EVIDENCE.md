# T-46-06 rollout evidence — HOLD

Date: 2026-10-01. Automatic evidence report is source-complete for a DRAFT PR; deployment remains **HOLD / awaiting operator**. This report does not approve the blocking human checkpoint, activate a runtime, merge T-46-06, or complete phase 46. Eight required new pairs lack isolated exact application receipts. Report-authoring blockers: 0; rollout application gaps: 8 plus pending operator decision.

## Contract and source boundary

The supplied 46-06-PLAN contract was read in the dispatch, SHA-256 `85b33ebfefc3cda34487ff52017ec6bf6a14a374d156b3de82bd9b4620ef1bb4`. The same PLAN also exists in the ticket worktree. Supplied research context SHA-256 `2df970596ccb249822d6f56addcc5807800f7c676273223b67413e2a4a611f6d` provides context only. INV-011 sealed manifest/digest chain is unavailable in this bounded proof set and remains **unverified**, not accepted research evidence and not a blocker to documenting HOLD. No replacement research attestation is inferred.

Parent PR408 squash merge is `6bf4a496d84f7716da0655aaaf976c6502c88adc`, verified as an ancestor of this worktree HEAD. Its tree `7d5f0f59457c11dabc9ba3fbcfbc82da7ae7fc80` equals the independent reviewed head `992fd1fca755ce812ef04d3714f12e108378c090` tree. The premerge head is not asserted to be an ancestor. Parent proof and artifact hashes are below.

## Independent review disposition

Actual PR408 native Codex arch-review artifact SHA-256 `1758d9665077150300623b2ffefec9930ba9cddaac8e08391adcfc24bfe172f0` was read and hash-checked, including both referenced evidence/findings file digests. Outcome: **conform**, zero findings/blockers; no accepted fix required. Dispatch `dispatch-mupxtd22-9cac6594-afa3-4bd8-a1ba-b90683fae194`, launch `codex-01a0f8fa-0cbd-7e32-83bf-d3a81b49a531`. Its review covers reproduction, 37 rungs, repair refusals, pinned Sonnet and stale v6 attribution; it explicitly does not authorize activation. Coordinator independently verified Copilot APPROVED and exact-head CI passed; these are coordinator attestations, not newly queried remote results in this callback. Independent review of this evidence DRAFT remains host-owned.

## Exact verification results

Only the two PLAN verification commands were run, each once:

1. `node --test tests/unit/model-policy.test.cjs tests/unit/model-capability.test.cjs tests/unit/codex-dispatch-adapter.test.cjs tests/unit/claude-dispatch-adapter.test.cjs tests/unit/marketplace-install.test.cjs` — exit 0, 9 top-level tests passed, 0 failed. Log `/tmp/phase46-06-focused-tests.log`.
2. `bash tests/smoke/model-ladder-runtime-smoke.sh` — exit 0, reports 37 installed runtime rungs, fingerprints, installer validation, native Claude bytes and refusal cases. Log `/tmp/phase46-06-smoke.log`.

Scoped regression covers exact grid and conflicting/stale selection refusal, installed agent integrity, native mismatch negatives, authenticated adjacent repair progression and capability fallback. Retained Luna/medium sentinel and Fable measured-window routing/consent restrictions are regression requirements only; no extra live roles were invented. Historical v6 classification is supported by the independent review; no additional history suite was run. Fixture/smoke application is not account application evidence.

## Installed provenance and package comparison

Policy: `adr-014.v7`, hash `3978b08721ef8f2381aa1f31355c9fef1dafd4058a2093b4a5f06ee90cd44570`. Codex manifest declares this identity; all 14 declared static agent file hashes checked equal. Installed policy bytes compare with clean source and generated mirror below. Package-build version `0.70.0+codex.852f99a1cb762216`, content build digest `baceaab44caacb408876d267009c97d1f8b300cd2a44c708afd0c0fc9127a492` (distinct from SHA-256 of metadata file).

Codex isolated home: `/Volumes/KINGSTON/.wt-claude-shipyard/phase46-rollout-artifacts-20261001/codex-6bf4a496`. Claude config: `/Volumes/KINGSTON/.wt-claude-shipyard/phase46-rollout-artifacts-20261001/claude-6bf4a496/config`; actual dogfood plugin root is sibling `plugin-0.70.0`. Both public provenance files state dogfood, version 0.70.0, clean source SHA 6bf4a496. Both installer exits 0 are coordinator-observed; installation logs are hashed below. Claude launch must use this plugin directory; config dependency inventory alone is not shipyard plugin activation.

GSD payload VERSION is **1.14.0 in both homes**; Claude enabled marketplace dependency is **1.15.0**, inventory git SHA `6eeaf87441370e7e2c29f6829f4d6cb428ccec95`, settings enable `gsd-core@gsd-core`. These are distinct installed surfaces, not a claim that the payload is 1.15.0 or that a dependency discovery applied a worker model.

Installer-log caveat: the preexisting Codex install log reports removal of legacy global runtime in `/Users/serhii/.gsd/defaults.json`. This callback did not perform that action or inspect/change that file; the log prevents a blanket assertion that the earlier installer touched isolated paths only. Operator must assess that installer side effect before activation. No active homes/controllers were changed by this callback.

- plugins/delivery-pipeline/scripts → /Volumes/KINGSTON/.wt-claude-shipyard/phase46-rollout-artifacts-20261001/codex-6bf4a496/shipyard/scripts: 111 matching files; differences []
- plugins/delivery-pipeline → /Volumes/KINGSTON/.wt-claude-shipyard/phase46-rollout-artifacts-20261001/claude-6bf4a496/plugin-0.70.0: 137 matching files; differences []
- plugins/delivery-pipeline → plugins/shipyard/host/plugins/delivery-pipeline: 137 matching files; differences []

## Native discovery and actual attempt

Both supplied actual isolated auth discoveries report `authenticated:false`, exit 1; Claude auth method is `none`. Account entitlement is **unknown**, not proven unsupported. No authenticated model-list receipt is available and discovery cannot stand in for application.

The one authorized Codex executor attempt used installed `codex-delivery-host.cjs --args-file /tmp/phase46-06-isolated-executor-request.json`, through `/tmp/phase46-06-isolated-executor-entry.cjs` binding the isolated agents/manifest. Request scope run ID `phase46-06-isolated-evidence-c667e5d2-a476-466c-97f5-701e4cb56fb0`, ticket T-46-06, role executor, signal risk high (not fabricated critical). Coordinator records host exit 1; actual host log reports `CodexRuntimeHostError: Codex process exited 1`; result file has no verified application receipt. Canonical target low is a policy expectation, not an applied/observed tuple. No verified native session or application dispatch ID can be reported. Request/result/entry/log bytes are hashed below. No retries, auth/login launches, availability prompts, credentials copying or synthetic repair/signals were used.

This report's authoring dispatch uses the existing active authenticated Codex account with candidate installed agent manifest. It is excluded from isolated entitlement and application proof, regardless of model selected for this authoring role.

| Required model | Effort | Outcome | Concrete reason |
|---|---|---|---|
| `gpt-6.1-sol` | `low` | HOLD | Ordinary executor authorized; actual isolated installed host attempt exited 1, no verified receipt. Applied/observed/session receipt: absent. |
| `gpt-6.1-sol` | `high` | HOLD | Ordinary research/review would require its own authorized role; no isolated authentication or such role receipt supplied. Applied/observed/session receipt: absent. |
| `gpt-6.1-sol` | `xhigh` | HOLD | No genuine very-complex research or critical judgment signal; no isolated authentication. Applied/observed/session receipt: absent. |
| `claude-sonnet-5-5` | `low` | HOLD | No bounded actionable sentinel duty authorized; isolated auth absent. Applied/observed/session receipt: absent. |
| `claude-sonnet-5-5` | `medium` | HOLD | Ordinary executor/drift route cannot apply without isolated auth; no Claude role receipt. Applied/observed/session receipt: absent. |
| `claude-sonnet-5-5` | `high` | HOLD | No authentic fixer duty or repair predecessor supplied; isolated auth absent. Applied/observed/session receipt: absent. |
| `claude-sonnet-5-5` | `xhigh` | HOLD | No authorized ordinary research instance or authenticated critical executor receipt; isolated auth absent. Applied/observed/session receipt: absent. |
| `claude-opus-5-5` | `high` | HOLD | No genuine very-complex/contested/critical judgment or authenticated exhausted repair chain; isolated auth absent. Applied/observed/session receipt: absent. |

For every row, requested target is the policy tuple shown; applied and observed are unknown, receipt reference/session IDs absent. No alias, older model or effort downgrade is accepted. Missing observation is HOLD; no false unsupported-model refusal is claimed. Other pairs were not launched because isolated authentication and/or a genuinely authorized role/signal was absent.

## Rollback and operator boundary

Prior reviewed metadata identifies source `845fd6d7f22aac05f96288e80604ac48c394ae49`, package `0.70.0+codex.1cbb4290ddee735b`, content build digest `a2065eb34c43c0873d6a43659758f444bb4822293aa356160c006ba9df88964d`. Archive `prior-reviewed-845fd6d7.tar` is 19,865,600 bytes; its actual SHA-256 equals metadata `c3e054c407e56ad18adb819a7dc6f914a5db9afa97f98ba2c8e55fe6e5420edf`. This verifies archived identity, not a restore rehearsal or new review of historical bytes. Operator rollback restores this prior reviewed package/policy through the supported installer while retaining receipts and logs.

Old-policy in-flight work remains owned by its original policy; v6 receipts stay historical and must not be relabeled v7. No graph/receipt/history/config/PLAN/SUMMARY bytes were modified. D6/controller ownership stays separate. No activation, signing, commit, push or checkpoint approval occurred in this callback.

Operator checkpoint remains blocking and pending. To reconsider HOLD, the operator must arrange authorized authentication within isolated homes and authentic bounded role duties/signals, then obtain eight host-owned exact same-session requested = applied = observed receipts under the v7 hash, review package/dependency provenance and installer caveat, preserve rollback/history, and explicitly decide rollout. No new native launches belong inside the checkpoint. A host may sign the source-complete evidence report for a DRAFT PR while deployment stays HOLD; signing does not resolve these application gaps.

## Actual artifact SHA-256 inventory

Paths below are read-only proof references, not secrets or full private transcripts. Preserve these external artifacts with the host evidence archive before their temporary locations expire.

| Artifact | Bytes | SHA-256 |
|---|---:|---|
| `/tmp/phase46-06-parent-proof.json` | 686 | `e7eac611d9dbbbfb02ceaac5e4aef836bcc2348b18be93a37c091bdaaa4e9c9b` |
| `/Volumes/KINGSTON/.wt-claude-shipyard/.wt-inv-011-model-ladder-refresh/T-46-05/.shipyard-role-artifacts/0d6c8c04367d9f12f364f06c423c0bf870e9eaf6463ee07a72b8a5e516bdeb79/.shipyard-role-artifact.json` | 5102 | `1758d9665077150300623b2ffefec9930ba9cddaac8e08391adcfc24bfe172f0` |
| `/Volumes/KINGSTON/.wt-claude-shipyard/.wt-inv-011-model-ladder-refresh/T-46-05/.shipyard-role-artifacts/0d6c8c04367d9f12f364f06c423c0bf870e9eaf6463ee07a72b8a5e516bdeb79/.shipyard-arch-review-evidence.md` | 21840 | `5a95c76f109a9cb12bea34b17955c6e0d46129ee9008a17820a0771881424f5e` |
| `/Volumes/KINGSTON/.wt-claude-shipyard/.wt-inv-011-model-ladder-refresh/T-46-05/.shipyard-role-artifacts/0d6c8c04367d9f12f364f06c423c0bf870e9eaf6463ee07a72b8a5e516bdeb79/findings.json` | 505 | `9daeecd85200ea3ed3ec8093a2bf33d1b1516865f684b7298433bb213819a959` |
| `plugins/shipyard/package-build.json` | 300 | `89bd9c70fb2e26c48be7c8aab8dbe073ec5eafda2e6f0f77cf628817d6e42c9f` |
| `/Volumes/KINGSTON/.wt-claude-shipyard/phase46-rollout-artifacts-20261001/codex-6bf4a496/agents/.shipyard-manifest.json` | 23673 | `f7de4a7ba43e4a47abc0ca2d86740cfe54738008a4a428476fbecf16b8bcc952` |
| `/Volumes/KINGSTON/.wt-claude-shipyard/phase46-rollout-artifacts-20261001/codex-6bf4a496/agents/.shipyard-provenance.json` | 275 | `d5883022011d597b27cca45a7b4249f71916eb2e896c3a877c1a347426eb2af5` |
| `/Volumes/KINGSTON/.wt-claude-shipyard/phase46-rollout-artifacts-20261001/codex-6bf4a496/shipyard/scripts/model-policy-internal.cjs` | 46225 | `84ed98ee287d2b5066f8099b74d11550dcf75d52a6ebd69cc7d6e75a2375176a` |
| `plugins/delivery-pipeline/scripts/model-policy-internal.cjs` | 46225 | `84ed98ee287d2b5066f8099b74d11550dcf75d52a6ebd69cc7d6e75a2375176a` |
| `/Volumes/KINGSTON/.wt-claude-shipyard/phase46-rollout-artifacts-20261001/claude-6bf4a496/plugin-0.70.0/.shipyard-provenance.json` | 275 | `d5883022011d597b27cca45a7b4249f71916eb2e896c3a877c1a347426eb2af5` |
| `/Volumes/KINGSTON/.wt-claude-shipyard/phase46-rollout-artifacts-20261001/claude-6bf4a496/plugin-0.70.0/.claude-plugin/plugin.json` | 736 | `274152db71826dd71f5e58b0fa1f1a46b465cc42261ba9496185b76bb5d4ce09` |
| `/Volumes/KINGSTON/.wt-claude-shipyard/phase46-rollout-artifacts-20261001/codex-6bf4a496/gsd-core/VERSION` | 6 | `45b2d9dc7463345bd6fa29edce2c10899765b1d22fee137d902edd0bd9bf2d37` |
| `/Volumes/KINGSTON/.wt-claude-shipyard/phase46-rollout-artifacts-20261001/claude-6bf4a496/config/gsd-core/VERSION` | 6 | `45b2d9dc7463345bd6fa29edce2c10899765b1d22fee137d902edd0bd9bf2d37` |
| `/Volumes/KINGSTON/.wt-claude-shipyard/phase46-rollout-artifacts-20261001/claude-6bf4a496/config/plugins/installed_plugins.json` | 471 | `cf676a0663c6d6047abe66527bbf0f51072121c8e7e5a8622b349404be6a7ce5` |
| `/Volumes/KINGSTON/.wt-claude-shipyard/phase46-rollout-artifacts-20261001/claude-6bf4a496/config/settings.json` | 9530 | `94fe09aaa10e368ff7ef2d8f4150c290ca386852564d21969cce181e7322fa5d` |
| `/Volumes/KINGSTON/.wt-claude-shipyard/phase46-rollout-artifacts-20261001/prior-reviewed.json` | 414 | `820d3a49efd081c99d35d4f8e4988fbfcb56eda89d9ab25ce0446b6c3d5d9e32` |
| `/Volumes/KINGSTON/.wt-claude-shipyard/phase46-rollout-artifacts-20261001/prior-reviewed-845fd6d7.tar` | 19865600 | `c3e054c407e56ad18adb819a7dc6f914a5db9afa97f98ba2c8e55fe6e5420edf` |
| `/tmp/phase46-06-isolated-executor-request.json` | 2044 | `dc87ba6d6fe239b9eb05bd6b31810f5109046a52ab442d2b1e214cd7d6291dc0` |
| `/tmp/phase46-06-isolated-executor-result.json` | 0 | `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` |
| `/tmp/phase46-06-isolated-executor-host.log` | 1087 | `86b1bb37b96aaca12f36dc6e4f94023d6ac2c9641d212faab802046b5dd4f4af` |
| `/tmp/phase46-06-isolated-executor-entry.cjs` | 548 | `fc288105c24708a82b29b1757be32f4a5ba7a8b82e4a4cb5ca4152b134fd1b51` |
| `/tmp/phase46-06-codex-discovery.json` | 223 | `70c708643d30dd05000f4efdb888973a03a60ce8e9348d346d8e4f84ad767d2c` |
| `/tmp/phase46-06-claude-discovery.json` | 289 | `048a9197cfe8f73f2c552648f331f87a8950fd92843cd61276c09fc515ede111` |
| `/tmp/phase46-06-codex-auth-status.log` | 14 | `a06d5ca8261150a5175e866fc3dc401070fb4ea30e849a1b9394b7e252fa1677` |
| `/tmp/phase46-06-claude-auth-status.log` | 360 | `dfe60f6ddce94e2eed92c1d9f0464673e7e141a7217e9d760961a3e9753729b8` |
| `/tmp/phase46-06-isolated-codex-install.log` | 7564 | `e6d94b4ec2afc98b67a4f532842581c9949e9bf33ac5d9ce95dbee0e60e65290` |
| `/tmp/phase46-06-isolated-claude-install.log` | 353 | `8df26986091ac339820b41e1f5e68e7d6d09e743e3b5109013d0e6c448d6530d` |
| `/tmp/phase46-06-isolated-claude-dependency.log` | 3941 | `6424200e689236719b713076938e7bebac042b1b81a7a71ece9ec0465834855b` |
| `/tmp/phase46-06-focused-tests.log` | 7596 | `bbf8271f6fc4c1dad4729606b80e43464ba582ad7100180a725a8913beb4ebe5` |
| `/tmp/phase46-06-smoke.log` | 132 | `2cc759ab908ac0b29b54d67fecdc1f4b8a1267639a6a0570e3f5ff6c5ff746e2` |
