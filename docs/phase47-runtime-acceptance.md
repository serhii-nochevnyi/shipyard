# T-47-19 current final publication

Current inspection requires `ADR-026-source-update-1`, handback SHA-256
`d788b6e1be9b78914d9e58f1d9fb88f5069a0ece2517a22e9b80973c75ebccfe`. A missing or invalid current selection refuses;
HOLD applies only after candidate authentication. No original or superseded stage
is a fallback for current acceptance.

The reviewed source is `8192ba38942be328b27f8aa54984eae7cd47231c`, tree
`4ba34341bc4e94620de21a4c81d58a2f627afdca`, after actual T18 merge
`72f033c994053654d5025e128081ee37be0e04b7`. D22 changed only canonical
`plugins/delivery-pipeline/scripts/architecture-target.cjs`; its generated mirror
is mechanically copied from the supported successor candidate. Current 15-owner
PLAN SHA-256 is `d12c3b870fda04f0dc1f2f6afcebedbfad619f8961662ac253ad2abd45d781e8`;
task sizes are 3/5/3/4. The signed fresh checker authenticates this amendment;
the historical checker retains its original contract and receipt meaning.

Current generation is `4e63582ca45a0dc5edd2f63fd46ccc07afbff13cf3e71f8d6bbb305715598d50` with 161 package files,
version `0.71.0+codex.3274a569f21d3bce`, package SHA-256 `56e4bb0aa02dbcacb9c0ab4764adc575d5b565cb8ca01d18ce630be80ea6aa8d`.
The seven host mirrors and two manifests are the exact nine-output delta from the
reviewed checked-in package, copied with original publication modes. The original
T05 stage has 160 files, sixteen native owners (thirteen T14 plus three T15), and
twenty historical mechanical outputs. Those inventories and all original receipts
remain historical anchors. Earlier fifteen/nineteen statements below are retained
historical prose, not the operative inventory.

Source configuration is independently pinned to
`2eb2a0475127916c4c120d7616d13df1393d116c07b2a5f259cd6453234c65f9` and checked against reviewed Git and
the source checkout. Operative coordinator configuration is separately pinned to
`6f3f3a35b9a0cbd31ec686b5b0f0bd67e0790d13d612cf42e3aa9f635ca969a0`. No equality waiver links the two.
Canonical bytes, modes and source ancestry remain strict on the checkout and the
signed epic branch. Only publication/test/docs descendants are admitted; even a
canonical change later reverted refuses. The supported builder is unchanged and
never invoked by either current consumer. Signature verification uses only an
owned temporary public keyring; no signing or installed native launch occurs.

The canonical context reader's `boundedBytes` rejects world-writable non-sticky
ancestors, but does not reject group-writable ancestors. Its leaf checks reject
symlinks and group/world-writable leaves, use `O_NOFOLLOW`, and compare descriptor
and pathname identity before/after reading; manifest/assets are checked against
pinned SHA-256 values. These checks do not establish directory-anchor protection
against every ancestor replacement race. Broader ancestor hardening is expressly
deferred. Changing that canonical reader requires separate source approval and a
new supported generation; no such fix or regenerated mirror is claimed here.

The entire original ledger is retained at `/Users/serhii/.local/state/shipyard/codex-decompose/6cba328f5f0de395b373ad6c77a164feb771363c4e6b7a96888b7075d52da7aa/phase47-final-generation-adr026-source-update-1/original-runtime-acceptance.json`,
SHA-256 `592439dcf4d663f9a072d280dfbb9b6866d43061ffda8094cdc5ddbd94c5d98d`, 48868 bytes,
and authenticated by the signed current handback. All twenty original obligation
rows, historical research/refusals/reasons/references and null accounting remain
unchanged. Current preparation is not installed identity or native acceptance.
`evidence_check: passed`, `status: HOLD`, `accepted: false`, `native_launches: 0`
is the expected valid missing-native smoke outcome, never a substitute for a pass
when source, selection or package authentication fails.

Run the six existing publication groups (`candidate`, `launch`, `caller`,
`integration`, `relay`, `complete`) sequentially using
`node tests/unit/phase47-package-publication.test.cjs --group <group>`.
Relay checks every non-manifest package file; complete checks all 161 files.
The sandbox smoke and `node scripts/refresh-runtime-digests.cjs --check .` follow
publication. The acceptance unit command and all three assigned final HOST tuples
belong exclusively to the trusted verifier with current scoped candidate-tree,
source and PLAN admission. At the sandbox executor handback, their results were pending. The trusted
coordinator subsequently reported all twelve exact PLAN19 commands passed and
signed predecessor commit `c21e04e1e7863bb1f07a562145a8c2faaf46241a`, tree
`af3fd000fac48cf083d5dbd245ec3b21a7324444`, with verification evidence digest
`1fd8c0dc7d7674dfc322daf21c36a7636cad44a8af7e882f8dbe2a608231dba3`
(the commit trailer retains this digest). The authenticated publication result
`/tmp/phase47-19-final-publication-result.json` identifies that commit/tree.
The coordinator also reports CI run `37626213827` passed for that predecessor.
These are predecessor results, not verification of these subsequent document edits.
The protected host evidence is unavailable to this review-fix sandbox; exact
per-command host output and CI status cannot be independently rechecked here.
Fresh post-edit trusted verification and publication remain pending. A denial remains unresolved and genuine assertion failure blocks.
No global install, push, GitHub message, finalizer or coverage action is performed
by this executor.

After genuine 19 handback and delivery merge, the coordinator obtains full phase
architecture and integrator judgments at the actual final integration head/base
and complete membership including 18/19. These are retained final obligations,
not a prerequisite to this executor's native handback. Ticket target skips do not
supply a conformity verdict. Phase 48 remains independent.

Post-edit sandbox diagnostics: `node --test tests/unit/phase47-runtime-acceptance.test.cjs`
exited 1 (17 passed, one packaged public-load-order test failed with
`native spawn must be reached`). The exact smoke command
`node tests/smoke/phase47-runtime-acceptance.cjs --evidence docs/audits/phase47-runtime-acceptance.json`
exited 1 (`ERR_ASSERTION`). Direct `validateLedger` diagnosis identified
coordinator `delivery-state.json` digest drift: observed
`c1e4d846c924100c3412b61e59cef52fe98cce58d0dfa962d3f90d4ca6a6ae24`, expected
`be5bc64f990bd6f15cb679939f32ac81fbff165796dfaf8f3c62f0cdd8605d0d`.
These are unresolved post-edit checks for the trusted coordinator; no authority,
source, graph, generation or expected digest was changed to bypass refusal.

## Retained original T08 procedure (historical)

The text below is the original procedure at the retained ledger snapshot. Its
source/package and delivery-state statements describe that earlier handback.

# Phase47 isolated runtime acceptance

T-47-08 implements bounded evidence inspection. Its two Verification commands
can pass while phase acceptance remains **HOLD**. Exit zero means supplied
evidence was checked and every uncovered property stayed explicit; only
`accepted: true` with no open obligations means acceptance. A fixture result,
merged ticket, transport exit zero or matching cache bytes cannot supply native
proof. No public rollout, signing, merge or prior UAT completion is authorized.

The delivered PLAN SHA-256 is
`99710c9577d76ead5514b1ba00e5277571ef6ff9827f8d06cb692ef6284fe42c`.
The delivered context is the execution contract; unavailable planning documents
are not reconstructed. The immutable generation is
`bbf5ec33bf9b5bd1e5361254fb740c90c2e91d48f31b3f7bee700848fea76c34`.
It contains 160 package files. The landed publication checker allocates twenty
changed outputs (five plus nine plus six), including the Claude native guard;
the delivered prose's nineteen-output count does not permit dropping that file.

The pinned package digest is
`6be2bdeefdcb339c4a19fe863cb05462083dd4de194306b92688f063bd68991a`;
the plugin manifest digest is
`62820bdf169cb1d4d2ab35dfe9fb07a7dbb21f67a97935de014989cabf1b3e1d`;
the version is `0.71.0+codex.08a9403153faa8aa`. The original source is
`29e0b404fecd7cd711ee5cf29de9a3dfc8e44e82`, tree
`adace6f023b8b6913a313dcced9c0f01386e0ccb`, on baseline
`7eebae4812b3c67ccdbbb63c8c1603f7767b1466`.

Run the safe, unpaid checks from the assigned worktree:

```sh
node --test tests/unit/phase47-runtime-acceptance.test.cjs
node tests/smoke/phase47-runtime-acceptance.cjs --evidence docs/audits/phase47-runtime-acceptance.json
```

The smoke command reads the exclusive selection/binding and the original
coordinator handback pinned by the existing publication checker, recomputes
canonical input and complete package digests, checks source ancestry and bytes,
and checks both Verification argv/profile/timeout assignments through existing
T-47-10 admission. Later mechanical publication HEADs are admissible only with
identical canonical inputs; original source HEAD/tree remain unchanged.
The checkout's current head, tree and dirty-status digest are reported separately.
Unrelated tuning changes do not invalidate canonical source identity; current
policy and applicable exact-command admission must still match.

Original INV014 archives are checked with planning-result-sealer and the original
durable boundary HMAC envelope, without opening its creating recorder. The
runner never creates a receipt key, replays a completed role, installs a package
or deletes host resources during inspection. Signature checks, when original
approved-host proof is supplied, use a private temporary verification keyring
containing only the public key and remove only that owned directory. Diagnostics
contain identities/digest references, not findings, transcripts or private keys.

The unit command projects only scoped, already owned fixtures onto package
bytes in disposable test directories. It executes both public detached CLI
load orders, completed and artifact-producing blocked semantic callbacks, and
legitimate plus indirect notification callbacks with independent caps and exact
owned cleanup. It also refuses altered/missing/extra package files, lost modes,
foreign/tampered receipts, denied first-call heredocs followed by later hashes,
invented counters and unsafe switches. These deterministic observations do not
establish that an operator's runtime was installed or behaviorally accepted.

Before any isolated install, the trusted rollout owner must authenticate 12's
original complete parity result and unchanged exclusive 05 stage. Current-head
human review, signing and merge are separate gates: PR433 is recorded as draft,
pr-open on the inspected delivery snapshot. Bytes already present in this
dependency worktree do not close that gate. Preserve PR418's original
head/snapshot history. Do not run package generation, refresh-runtime writes,
marketplace generator tests or gsd-sync to repair a missing handoff.

The supported installer entry is an explicit Codex marketplace invocation:

```text
node scripts/install-shipyard-marketplace.cjs codex --source <approved-source-root>
```

The source must contain the exact published package. Record the full installer
argv, source revision/tree/dirty inventory, explicit runtime=codex, capability
file/digest, owned destination and environment before executing it. Use the
existing dedicated dogfood target selected by this installer, never the shared
default Codex home. Its installed cache's bootstrap entry is:

```text
bash <installed-package-root>/host/scripts/ensure-gsd-core.sh --launch-bootstrap
```

Record the actual resulting environment and successful outcome. Omit an
unsuitable inherited TMPDIR; do not rewrite global config or change policy.
Preserve the emergency notification mitigation until replacement proof exists.
These templates are procedural prerequisites, not authorized executor commands.
There is no install or current safe rollback identity supplied in this handoff.

Supply the existing host's original evidence in the ledger before native work.
Each obligation stores governing inputs, original argv arrays/environment,
outcome/exit, owner and original digest references. `HOLD`, `open` and `blocked`
require a reason and no accepted `proof`; unaccepted historical references remain
in `retained_references`. A `proven` row uses `kind: approved-host` with the
existing host-verification evidence path, byte SHA-256 and canonical evidence
digest. The trusted host supplies a detached operator-signed applicability
descriptor, `shipyard.phase47-acceptance-approval.v1`, not a model verdict.
It binds ticket/PLAN, exact installation identity and per-property commands,
environment, governing inputs, unchanged assertion tree, original artifact
references and a separately recorded implementation approval reference.
The pinned operator fingerprint is
`2F485C0A455BA33463F66332900FCE87BD1BFF0D`. Every signature/public-key reference
includes original path and byte digest. This descriptor associates existing
assertions; it does not grant a new host runner or replace assertion authority.

The installation identity includes runtime/root, actual native bundle root
(`<runtime-root>/shipyard`), complete package cache root/digests, original
source HEAD/tree/dirty state, current worktree HEAD/tree/dirty digest,
repository/common directory, controller/run, provenance sidecar, native CLI
executable bytes, runtime capability evidence, registered capability and
generated agent manifest/individual agent digests. Both the cache and every
actual bundle executable must match the immutable candidate. Ambiguous runtime,
unsuitable environment, foreign provenance or missing capability refuses.

Planner/checker obligations additionally require original authenticated native
receipts and child transcript/task digests. Their **first call** must have used
filesystem read-only inline `python -c` or `node -e`, with its computed task hash
in that same call's output. A denied original heredoc plus a later hash, a suffix,
an output file alone or a model claim does not satisfy this amended-input gate.
Keep a separately authenticated `validate-graph` exit-zero obligation. The runner
does not launch replacement planners/checkers or rerun accepted researchers.

Require independent final combined fifteen-file implementation approval with
separate 47-14 thirteen-file and 47-15 two-file ownership, distinct approved
pure-ticket/canonical/runtime source maps and human/trusted-host exact-byte
bootstrap approval. The experimental architecture target judgment cannot approve
its own implementation. Installed critical architecture evidence must bind
canonical graph, current PR/head/base/draft, complete architecture corpus and
decisions, installed capability/agent identity, original context/launch digest
echoes, receipt/transcript and sealed judgment. Use the existing shared
role-artifact boundary immediately before each actual writer, including a fresh
process after clearInflight. Mutable archive rebinding, corpus/path replacement,
symlinks and descriptor races refuse. Full generated instructions and complete
prompt/corpus/input byte accounting plus actual native model capacity proof
remain required; missing capacity is HOLD.

The actual caller obligation requires one genuine planning-context detached
trace per distinct supported Codex path, or command-backed proof that paths are
shared. Keep the original dispatch, measured parent waiter observations and
separate original child usage. Unknown counters remain null and efficiency
inconclusive. Bounded installed notification lifecycle and 04's original approved
exact-argv candidate-bound host/GPG assertions with disposable cleanup are
separate obligations. Reuse them only when governing inputs match; denial is
HOLD and an actual assertion failure blocks. Historical GPG cause remains unknown.

Only after applicable prerequisite proof and explicit signed execution authority
may the rollout owner invoke:

```text
node tests/smoke/phase47-runtime-acceptance.cjs --native --runtime codex --candidate <exact-selected-candidate> --runtime-root <owned-isolated-runtime> --evidence <current-ledger>
```

The collection descriptor, `shipyard.phase47-native-authorization.v1`, binds the
same ticket/PLAN/installation, authenticated writer release, separate
implementation approval, safe rollback package digest, original prerequisite
references, canonical graph/config, full environment, bounded timeout and an
existing installed builder-produced request reference. Native argv must be exactly
`node <runtime-root>/shipyard/scripts/codex-planning-context-host.cjs --args-file <request>`;
record it before launch. Existing canonical config must admit that exact argv
as a host command with the same timeout (at most 600 seconds). The current
Verification allow-list alone does not authorize a paid collection.

The request is parsed by the actual installed host. Only the supported
`gsd-phase-researcher` trace is collected here; planner/checker proof is supplied.
Provider/model remain selected by unchanged host policy. Use the approved PATH,
CODEX_HOME, capability file and canonical SHIPYARD_GRAPH_DIR; TMPDIR and
NODE_OPTIONS must be absent. The resolved native CLI bytes must agree with the
installation identity. The runner reports command/outcome digests and leaves
acceptance HOLD pending original evidence validation. Timeout/error/nonzero exit
is nonzero; inspect original dispatch recovery before any retry. A host invocation
does not establish a count of paid launches. Native receipts stay in their existing
trusted archives; the coordinator preserves the completed result outside checkout.

Stop on identity/containment drift, stale or disputed original context,
unreleased writer, invalid semantic result, suppressed legitimate notification,
recursion beyond the independent cap, host authority regression or missing
rollback proof. Retain original errors and accepted siblings. New product defects
go to their 01/02/03/04/06/07 owners; this ticket cannot change those products.

Rollback is HOLD until the owner names the exact prior reviewed safe package,
digest/version/source and approved supported-installer argv/environment for the
same owned runtime. Restore only that package under existing rollout authority,
preserving the known notify mitigation. Do not infer that an older launch-incompatible
package is safe. Retain candidate stage, sealed receipts/archives, dirty preparation,
backups and unrelated installations. Maintenance may delete only authenticated
exact owned disposables after checking prior disposal; no broad path/PID cleanup
is inferred. Follow the separate durable handoff before any refresh or failed-role
retry. No current installed release is claimed by this procedure.
