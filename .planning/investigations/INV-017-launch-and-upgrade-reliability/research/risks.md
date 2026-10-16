# INV-017 — Line 4: risks and unknowns

Investigation: INV-017-launch-and-upgrade-reliability
Line: `risks` (risks and unknowns) — drafts for `RISKS.md` and `OPEN-QUESTIONS.md`
Source revision: `d8a70decb32e5420fb69f8eebc17be08e82d6d86` (`git rev-parse HEAD`, branch `main`)
Policy hash: `3978b08721ef8f2381aa1f31355c9fef1dafd4058a2093b4a5f06ee90cd44570` (ADR-014, `adr-014.v7`)
Runtime selection (caller-resolved): `claude-sonnet-5-5` / `xhigh`; exact policy signals preserved as DATA: `{}`
Date: 2026-10-15
Contract: `artifactContract: planning.v1`, research line `risks`.

This file is a risk and unknown register. It does not choose a design, does not close Gate 1 and
does not write an accepted ADR. Likelihood is left **unknown** wherever no measurement exists.
Severity is the impact if the scenario occurs, labelled as a judgement.

Evidence labels used below:
- **[V#]** = verified by a command in the Command log (section 9). The command, the path and the
  output or exit status are recorded there.
- **[R]** = read directly from a file with the Read/Grep tools; the path:line is cited.
- **[A]** = assumption or inference, not verified by a command; the next check is named.

---

## 1. Scope, limits and things this line did not do

- Production code, planning scaffolding, `.planning/graph/**`, the authority directories under
  `~/.local/state/shipyard/` and the installed bundle under `~/.codex/shipyard` were **not**
  modified. `git status --short -- plugins scripts tests Makefile .github README.md CLAUDE.md`
  printed nothing (exit 0) after all work [V24].
- No file under `~/.local/state/shipyard/` was read (research contract), and nothing outside the
  checkout was read. The four probes that execute repository scripts ran with `env -i` and a scratch
  `HOME` under `$TMPDIR`, so they could not reach real user state [V17, V18, V21, V22].
- **Blocked by the session sandbox (not retried):**
  1. A multi-operation shell command that listed `~/.local/state/shipyard` and ran `git check-ignore`
     was denied (a compound command; the listing was forbidden by the contract anyway). The two git
     parts were re-run as single commands [V12, V13].
  2. `grep -n "unknown host provenance member" /Users/serhii/.codex/shipyard/scripts/role-artifact.cjs`
     was denied (`permissions.blockReadsOutsideWorkingDirectories`). Consequence: the installed
     bundle was **not** compared with the source. See U-02.
- No spike was run. Where throwaway code would be needed, section 8 lists a `/gsd-spike`.

## 2. Deployment-state check (hypothesis #1 for "X does not happen in <env>")

The problem statement is "a refusal happens after upgrade", not "a feature is absent", but the
contract asks to prove the code is present before defect analysis.

| Question | Command | Result |
|---|---|---|
| Is `d8a70dec` on the integration branch? | `git merge-base --is-ancestor d8a70dec main` | exit 0 [V25] |
| Is it in a published release? | `git merge-base --is-ancestor d8a70dec v0.72.0` / `... v0.71.0` | exit 0 / exit 1 [V25] |
| Which tags contain it? | `git tag --contains d8a70dec` | `phase-47`, `v0.72.0`, `v0.72.1`, `v0.72.2` [V26] |
| Do source and packaged host scripts match? | `diff -rq plugins/delivery-pipeline/scripts plugins/shipyard/host/plugins/delivery-pipeline/scripts` | only difference: untracked `.claude` dir in source [V27] |
| Did the route change after `d8a70dec`? | `git diff --stat d8a70dec HEAD -- role-artifact.cjs dispatch-record.cjs codex-runtime-host.cjs codex-delivery-host.cjs` | empty output (no change) [V28] |

Conclusions:
- The mandatory bookkeeping route is **present** in `main` and in three published tags. The refusal
  is a defect in upgrade compatibility, not the absence of code. Blast radius: every installation of
  `v0.72.0`–`v0.72.2` that carries local history from before `d8a70dec`.
- **Version is not a usable upgrade marker from `main`:** `plugins/delivery-pipeline/.claude-plugin/plugin.json`
  is `0.71.0` at `main` HEAD but `0.72.2` at tag `v0.72.2` [V29]. `make doctor` reports
  `Shipyard 0.71.0` for this checkout [V21]. A migration that keys on the package version would
  misclassify dogfood builds from `main` (see R-14).
- Whether the user's *installed* `~/.codex/shipyard` equals this source is **unverified** (U-02).
  `LAUNCH-REFUSAL.md` cites `role-artifact.cjs:3954` and `dispatch-record.cjs:1294`. In this
  checkout `dispatch-record.cjs:1294` is `authenticateBookkeeping` (matches) but
  `role-artifact.cjs:3954` is the `read` CLI branch; the refusal message is at
  `role-artifact.cjs:1827` [R, V3]. Either the installed copy has a different layout or the citation is
  imprecise.

## 3. Findings that ground the risks

### F1. The local-bookkeeping admission route and its handling of pre-existing history

- `dispatch-record.cjs:1294-1300` `authenticateBookkeeping(cwd, fn, writtenPaths, required)`: returns
  `fn()` directly only when `!required`, `.shipyard-role-artifacts` is absent **and**
  `historicalBookkeepingPins(worktree).length === 0`. Otherwise it calls
  `role-artifact.cjs trustedBookkeepingMutation`. [R]
- `dispatch-record.cjs:1302-1305` `localInflightBookkeeping(input, cwd)` is true when
  `input.worktree` equals the project worktree. `recordInflight` (`:1533-1555`) and `clearInflight`
  (`:1593-1609`) pass it as `required`, so a local in-flight launch **always** enters the trusted
  route; so does `writeProvenanceOnce` (`:1564-1582`). [R]
- `git show d8a70dec --format= -- plugins/delivery-pipeline/scripts/dispatch-record.cjs` shows that
  before `d8a70dec` `mutate()` used plain `withLock(...)` and `writeProvenanceOnce` had no
  authentication wrapper. `d8a70dec` introduced `authenticateBookkeeping`, `localInflightBookkeeping`
  and the `authenticate` argument [V4].
- `role-artifact.cjs:1808-1871` `trustedBookkeepingMutation`: reads `historicalBookkeepingPins`
  (`:1777-1792`, returns `[]` if `catalogue.json` is absent), lists
  `.planning/graph/provenance/*`, and at `:1825-1827` refuses with `ARCHIVE_AUTHORITY_INVALID`
  `unknown host provenance member before trusted mutation` if any physical file is not in the
  authenticated set. There is no branch that treats such a file as historical/unverified. [R]
- After a successful mutation the catalogue is rewritten with `bookkeeping_state` =
  authenticated paths ∪ written paths (`:1854-1868`). A project that starts clean therefore becomes
  fully pinned; a project that already has provenance files can never take the first step. [R]
- Two catalogue shapes already coexist under the same schema label
  `shipyard.role-archive-catalogue.v1`: `payload.bookkeeping_state` and the older
  `records[].bookkeeping` + `latest_bookkeeping` (`:1781-1791`, `:1829`). The schema string was not
  bumped when a field was added. [R]
- Authority state lives outside the repository: `role-artifact.cjs:985-1009` computes
  `~/.local/state/shipyard/role-artifact-authority/<sha256(realpath(worktree))>/` using
  `os.homedir()`, with a per-worktree `hmac.key` and an HMAC-authenticated `catalogue.json`
  (`:1037-1065`). `:1045-1046` refuses to create a new key if protected records exist without the
  original key. [R]
- The existing legacy admission, `admitHistoricalArchive` (`:2050-2077`), requires retained manifest,
  receipt and three archive identities per archive (`:1982`) and compares the **archive** inventory
  (`.shipyard-role-artifacts`). Its message when no catalogue exists is
  `archive catalogue is missing; explicit trusted legacy admission is required` (`:1061`). It does
  not take dispatch sidecars. [R] (`LAUNCH-REFUSAL.md` reaches the same conclusion.)
- Both runtimes reach the route, but not equally. `codex-delivery-host.cjs:1872` and
  `claude-role-host.cjs:1350` build the in-flight record **with** `worktree`, so for them
  `required` is true. `claude-delivery-host.cjs:1133` builds `{ graphDir, dispatch_id, pid }` **without**
  `worktree`, so `localInflightBookkeeping` is false and the Claude delivery host enters the trusted
  route only when `.shipyard-role-artifacts` exists or the catalogue already has pins
  (`dispatch-record.cjs:1297-1298`). [R, V10, V34]
- Provenance sidecars are untracked: `git ls-files .planning/graph/provenance` prints nothing [V13];
  `git check-ignore -v` names `.git/info/exclude:10` [V12]. `.git/info/exclude` is repo-local and is
  not part of a clone, so a fresh clone does not carry the exclusion. [A] — next check: find which
  component writes the line `# shipyard: per-run graph state written into ticket worktrees` (grep of the
  repo for that text found nothing outside audits [V14]; the writer is unknown, see U-09).

### F2. Resolution of Codex home, capabilities and runtime — the rules disagree

Codex home:

| Site | Rule |
|---|---|
| `codex-runtime-host.cjs:395, 441, 729, 882` | `env.CODEX_HOME || process.env.CODEX_HOME || os.homedir()/.codex` |
| `codex-delivery-host.cjs:707` | `env.CODEX_HOME || os.homedir()/.codex` (+ `/agents`) |
| `codex-decompose-host.cjs:518` | `options.env.CODEX_HOME || os.homedir()/.codex` (+ `/agents`) |
| `codex-agent.cjs:69-72` | `--agent-dir` flag, else `env.CODEX_HOME || os.homedir()/.codex` (+ `/agents`) |
| `dispatch-record.cjs:450-455` | `SHIPYARD_CODEX_AGENT_DIR || CODEX_HOME/agents || ~/.codex/agents` (an extra variable no other site reads) |
| `gsd-tune.cjs:784` | `process.env.CODEX_HOME || process.env.HOME/.codex` (`HOME`, not `os.homedir()`) |
| `codex-notify.cjs:26` | `process.env.CODEX_HOME || <bundle>/../..` (relative to the script, not `~/.codex`) |
| `session-observer.cjs:295` | `process.env.CODEX_HOME || os.homedir()/.codex` |
| `runtime-context.cjs:105-116` | `CODEX_HOME` counts only as a weak runtime signal and only if `config.toml` exists in it |
| `scripts/shipyard-doctor.cjs:217-218` | `--codex-home` flag, else `os.homedir()/.codex`; **never reads `CODEX_HOME`** |
| `scripts/install-shipyard-codex.sh:34-35` | refuses empty `CODEX_HOME`; else `${CODEX_HOME:-$HOME/.codex}` |
| `scripts/install-shipyard-marketplace.cjs:79-104` | requires absolute `CODEX_HOME` when set; pins/deletes it for children by install kind |

Verified: with `CODEX_HOME=<scratch>` and no flag, `shipyard-doctor.cjs --json` reports
`codex_home` = `$HOME/.codex`, i.e. it ignores the variable [V22] ([R] `shipyard-doctor.cjs:217-218`).

Capabilities file:

| Site | Rule |
|---|---|
| `codex-runtime-host.cjs:160-171` `capabilitiesFrom` | `options.capabilities` object, else `options.capabilitiesFile || process.env.SHIPYARD_CODEX_CAPABILITIES_FILE || CODEX_HOME/shipyard/codex-capabilities.json`; no `~/.codex` default; reads **`process.env`, not `options.env`** |
| `codex-delivery-host.cjs:710` | `options.capabilitiesFile || env.SHIPYARD_CODEX_CAPABILITIES_FILE`; no `CODEX_HOME` fallback |
| `codex-agent.cjs:84-96` | options / `--capabilities-file` only; **no environment variable at all** |
| `gsd-tune.cjs:283-285` | `--capabilities` / `--capabilities-file` / `SHIPYARD_CODEX_CAPABILITIES_FILE` |
| `scripts/gen-codex-shipyard.cjs:248-260` | `--capabilities` / env / else probe `codex debug models` (`readCodexCliCapabilities`, `:38-`) |
| `scripts/bootstrap-shipyard-plugin.cjs:104-114` | env, else probe and write `<home>/shipyard-plugin/capabilities.json`, then pass it to the installer |
| `scripts/install-shipyard-codex.sh:125-128` | **requires** `SHIPYARD_CODEX_CAPABILITIES_FILE`; exits 2 without it |

What the installer writes: `gen-codex-shipyard.cjs:355` writes `bundle/codex-capabilities.json` and
`:366-367` records `capabilities_file` and `capabilities_digest` in the manifest. The bundle path is
`<CODEX_HOME>/shipyard/codex-capabilities.json` (header comment `:20-21`). That is the same path
`capabilitiesFrom` falls back to when `CODEX_HOME` is set. [R] I could not confirm the file exists in
the user's real `~/.codex/shipyard` (U-02).

Reproduction of the observed second refusal, with an empty environment and a scratch HOME [V17, V18]:
- `env -i PATH=... HOME=<scratch> node codex-runtime-host.cjs --capability-only` printed
  `{"status":"unavailable","reason":"capability_evidence_missing","detail":"codex-runtime-host: explicit Codex capability evidence is required"}` and **exit 0**.
- With `CODEX_HOME=<scratch>/.codex` set, the detail changed to
  `cannot read Codex capability evidence: ENOENT ... <scratch>/.codex/shipyard/codex-capabilities.json`, still exit 0.
So the same install works when `CODEX_HOME` points at it and fails when nothing is exported, although
the file is at a predictable location. Agent and session lookups default to `~/.codex` while
capabilities lookup does not (`codex-runtime-host.cjs:395` vs `:168`).

Active runtime: `runtime-context.cjs:195-253` `resolveDispatchContext` accepts only explicit signals
(`SHIPYARD_RUNTIME`, `GSD_RUNTIME`, runtime marker, `GSD_TOOLS`/`GSD_CORE_HOME` marker, bundle path,
`CODEX_SANDBOX*`, `CLAUDE_PLUGIN_ROOT`/`CLAUDE_CODE_ENTRYPOINT`) and throws `AMBIGUOUS_RUNTIME` when
none exists; it throws on any conflict between signals (`:224-227`). The non-routed
`resolveRuntime` (`:118-168`) has a different, longer precedence including `project-config-legacy`
and `CODEX_HOME`. Callers: `pipeline-config.cjs:1113,1129,1885`, `codex-agent.cjs:152,163`,
`gsd-tune.cjs:386`. [R, V30]

Claude equivalents: `claude-runtime-host.cjs:358-371` use
`environment.CLAUDE_CONFIG_DIR || process.env.CLAUDE_CONFIG_DIR || <HOME>/.claude` and `HOME` from
`environment.HOME || os.homedir()` (`:362`) but `process.env.HOME || os.homedir()` at `:413`. The
Claude installers use `CLAUDE_HOME` and `CLAUDE_CONFIG_DIR` (`install-shipyard-marketplace.cjs:12`).
[R] `CLAUDE_HOME` is not read by the Claude runtime host. [A] — next check: grep `CLAUDE_HOME` in
`claude-*.cjs` (not done; see U-08).

### F3. Order of operations in the Codex launch makes failures sequential and leaves state behind

- `codex-delivery-host.cjs:1871-1889` (`runCli`): `recordInflight(...)` runs first (bookkeeping
  mutation and provenance sidecar), and only afterwards `createCodexDeliveryHost(...)` runs the
  capability probe (`codex-runtime-host.cjs:1537-1550`). [R]
- Consequence 1: the legacy-provenance refusal masks the capability refusal. This matches
  `LAUNCH-REFUSAL.md` where the second refusal appeared only after the first was removed. Any fix for
  one will expose the next unless a preflight reports all of them together.
- Consequence 2: if the probe fails after `recordInflight`, the `finally` at
  `codex-delivery-host.cjs:1936-1940` calls `clearInflight`, which deletes only the in-flight row
  (`dispatch-record.cjs:1599-1606`). The provenance sidecar is "written once ... never overwritten"
  (`:1563`) and is never removed. So every refused launch after the first successful
  `recordInflight` leaves one more sidecar that is now **authenticated and pinned**
  (`trustedBookkeepingMutation` writes it into `bookkeeping_state`). [R] — inferred from code, not
  executed; confirming it needs the spike in section 8 (S-1).
- Stderr hint printing: `codex-delivery-host.cjs:1981` prints `formatHint(error.code)` only for errors
  that reach the top-level catch.

### F4. The phase + repository + ADR subject has four different shapes and no shared implementation

| Where | Shape | Evidence |
|---|---|---|
| Documentation of the sealed envelope | `phase=<phase>;repository=<repo>;adr=<ADR digest>` | `plugins/delivery-pipeline/commands/decompose.md:302` and `:400` [R] |
| Build-side subject (producer, Codex) | `phase=<N>;input=<INV-or-ADR id>;repository=<repo>` | `deliver-dispatch.cjs:986` [R] |
| Sealer-side subject (both hosts) | `phase=<N>;repository=<repo>` | `codex-decompose-host.cjs:140`, `claude-decompose-host.cjs:175` [R] |
| Run-contract parser (consumer) | `^phase=(\d+);input=((?:INV|ADR)-...);repository=[^;\s]+$` for role `decomposition` | `run-contract.cjs:233-235` [R] |
| In-flight subject check | delegates to `normalizeTicketIdentity` for research/decomposition | `dispatch-record.cjs:1500-1507` [R] |
| Integrator subject | `phase=<n>;repository=<id>;tickets=<64hex>` — built in two places (`claude-role-host.cjs:612`, `role-artifact.cjs:2794`), parsed by two separate regexes (`run-contract.cjs:228`, `dispatch-record.cjs:1509`). The arch-review aggregate subject adds `;pr=;head=;base=` and has its own regex (`architecture-target.cjs:8`, built at `:57`) | [R, V8] |
| Tests that use `adr=` | `tests/unit/planning-artifacts.test.cjs:434,520,528` | [R, V9] |

- `grep` for `adr=` outside docs, audits and the packaged copy finds only `decompose.md:302,400` and
  the three test lines; **no production code builds or checks an `adr=` component** [V9]. The only
  "ADR digest" check described in `decompose.md:312-314` ("phase/repository/ADR identity ... a wrong
  phase or ADR digest ... is a hard refusal") has no matching code in `planning-result-sealer.cjs`:
  `decompositionIdentity` (`:237-259`) accepts any non-empty `subject` string, and
  `sealDecomposition` (`:296-327`) writes it unchanged. [R, V7]
- `context-packet.cjs:523` compares `packet.subject` with the launch `expected.subject` by string
  equality, so the build-side subject (with `input=`) and the sealer-side subject (without it) must
  never be compared directly. [R] Whether any code path compares them is unknown (U-05).
- Consequence for the stated goal: "building and verifying use one implementation" has no existing
  shared symbol to extend. The grammar is split across prose, two producers, one sealer and
  several regexes. The earlier mismatch incident is not reproducible from the repository alone
  (U-04).

### F5. Preflight surface — which refusals carry a supported remedy

`refusal-hints.cjs:8-73` has 16 named codes. I checked which observed refusal codes have an entry [V19]:

| Code | Where it comes from | Hint | Remedy quality |
|---|---|---|---|
| `ARCHIVE_AUTHORITY_INVALID` | `role-artifact.cjs:1827` etc. | **unnamed** (default hint) | default text says "Re-run the command and check the surrounding stderr" — re-running reproduces it deterministically |
| `ARCHIVE_AUTHORITY_REQUIRED`, `ARCHIVE_AUTHORITY_BUSY` | `:1061`, `:1882-1908` | unnamed | none |
| `RUNTIME_CAPABILITY_MISSING` | `codex-runtime-host.cjs:152-169` | unnamed | none (becomes `RUNTIME_UNAVAILABLE` after the probe wraps it) |
| `RUNTIME_UNAVAILABLE` | `codex-runtime-host.cjs:1549` | named | **wrong for this cause**: "Install and authenticate the runtime, then re-run." while the cause is missing capability evidence (`refusal-hints.cjs:53-56`) |
| `LEGACY_WRITER_STATE` | `planning-writer-lease.cjs:105-144` | unnamed | none |
| `AMBIGUOUS_RUNTIME`, `UNKNOWN_RUNTIME`, `STALE_POLICY`, `INVALID_STORE`, `SOURCE_REVISION_UNAVAILABLE` | `runtime-context.cjs`, `model-policy-internal.cjs:889`, `run-store.cjs:267`, `codex-decompose-host.cjs:130` | unnamed | none |

- Hints are wired in only four entry points: `codex-delivery-host.cjs:23`, `codex-decompose-host.cjs:18`,
  `claude-investigation-host.cjs:12`, `claude-decompose-host.cjs:17` [V11]. `claude-delivery-host.cjs`
  and `claude-role-host.cjs` do not import `refusal-hints.cjs`, so Claude delivery and role refusals
  carry no hint at all. [R]
- `make doctor` (`scripts/shipyard-doctor.cjs`): runs against empty scratch homes and returns
  `status: "ok"`, exit 0, with every installation check `skip` [V21]. It inspects hook/bundle
  manifests, agent manifests, provenance and cache-vs-release identity (`:126-199`, `:360-399`). It
  has no check for the capabilities file, the active runtime, the project's provenance/catalogue
  state or `SHIPYARD_*` variables (`grep` for `capabilit`/`catalogue`/`authority` finds only the
  source capability JSON at `:13,221-227`) [R]. A missing install is reported as healthy.
- `codex-runtime-host.cjs --capability-only` (`:1644-1681`) is an existing read-only capability
  probe, but it prints `status: "unavailable"` and exits **0** [V17, V18], so a script cannot gate on
  its exit status.
- `host-verification.cjs` is a plan-command allow-list verifier, not an environment check
  (`function` list `:15-304` has no environment, capability or provenance function) [R, V15].
  `phase-integrator-preflight.cjs` and `sentinel-preflight.cjs` contain no reference to
  `CODEX_HOME`, capabilities, provenance, catalogue or runtime [V16]. They are scope preflights, not
  launch preflights.

### F6. What existing tests do and do not cover

- Unit coverage of the route: `tests/unit/role-artifact.test.cjs:987-1016` (trusted updates;
  changed bytes refused; a `forged.json` added **after** the catalogue exists is refused with
  `/unknown host provenance/`), `:1050-1077` (live lock timeout never invokes the writer),
  `tests/unit/dispatch-record.test.cjs:2181-2205` (external canonical graph history is not admitted
  as ticket-local bookkeeping, legacy file left untouched). [R, V5]
- No test combines **pre-existing provenance + no catalogue + local in-flight launch**; `grep` for
  `unknown host provenance|trustedBookkeepingMutation|historicalBookkeepingPins|bookkeeping_state`
  in `tests/` returns only the three files above [V5]. The refused scenario is the one INV-015 hit.
- The fail-closed assertion at `role-artifact.test.cjs:1013-1014` pins the behaviour that any
  migration must preserve for **new or altered** files.
- Environment-less launch: the literal patterns `env -i`, `unset CODEX_HOME`,
  `unset SHIPYARD_CODEX_CAPABILITIES_FILE` do not occur in `tests/smoke/*.sh`,
  `tests/live/live-round.sh` or `tests/unit/marketplace-installer.test.cjs` [V20]. The installer
  tests do clear the variables at **installer** level (`marketplace-installer.test.cjs:460,614,679,768`
  pass `CODEX_HOME: undefined` / `SHIPYARD_CODEX_CAPABILITIES_FILE: undefined`) [V35], and
  `codex-shipyard-smoke.sh:152` asserts that a bare install without capability evidence is refused
  [V36]. I found no test that runs a **host launch** (`codex-delivery-host` / `codex-runtime-host`)
  with both variables unset and expects success; the `codex-runtime-host.test.cjs` environments always
  pass `CODEX_HOME` (e.g. `:240,299,329`) [V35]. `tests/smoke/codex-shipyard-smoke.sh` sets `HOME`,
  `CODEX_HOME` and `AGENTS_SKILLS_DIR` itself (header `:28-40`); the two variables appear 83 times in it
  [V6]. The search was by pattern, so a differently-phrased test could exist (U-10).
- **Existing tests pin the explicit-evidence contract:** `codex-shipyard-smoke.sh:152`
  (`explicit Codex host capability evidence is required`) and `codex-runtime-host.test.cjs:512`
  (`reason === 'capability_evidence_missing'`), plus `phase47-launch-contract.test.cjs:178` and
  `claude-runtime-host.test.cjs:643` [V36]. Making the launcher discover capabilities changes these
  assertions (R-24).
- CI runs only `make test-fast` (`.github/workflows/test.yml`, `make test-fast` step). It excludes
  `test-codex-shipyard` (network) and `test-live`. No CI job installs the packaged host and runs an
  ordinary command. [R]
- `tests/live/live-round.sh --runtime claude|codex` is manual (`make test-live`, `Makefile:116-118`)
  and uses `tests/fixtures/live-project` and `live-receipt.cjs`; only its first 60 lines were read.
  Whether it drives the real CLI through an installed package, and whether it covers an upgrade with
  old history, is **not** evidenced (U-10).
- `tests/smoke/phase47-runtime-acceptance.cjs` hard-codes the user's home-directory handoff path
  (`HANDOFF = '/Users/serhii/.local/state/shipyard/codex-decompose/...'`, `:15`) and baseline
  `7eebae48...` (`:12`); it is a phase-47 acceptance script, not a reusable installed-package e2e. [R]

### F7. Concurrency and lock behaviour of the authority namespace

- `withArchiveAuthorityLock` (`role-artifact.cjs:1874-1898`): if `catalogue.lock` exists and its
  `owner.pid` is alive (`process.kill(pid, 0)`), it fails **immediately** with
  `ARCHIVE_AUTHORITY_BUSY` — no wait. When the lock directory is absent, or its recorded owner is not
  alive or unreadable, it goes on to `acquire(..., { waitMs: 1000 })`, and any failure there is also
  reported as `ARCHIVE_AUTHORITY_BUSY` (`:1891-1894`). [R]
- A second session in the same worktree therefore refuses while the first holds the lock; hint is
  unnamed (F5). If a crashed owner's pid is later reused by an unrelated live process, the lock would
  look live. [A] — not verified; next check: unit test with a reused pid (spike S-3).
- `planning-writer-lease.cjs:85-88,92` uses `os.userInfo().homedir`, which ignores the `HOME`
  environment variable, while the authority namespace uses `os.homedir()` (honours `HOME`). An e2e
  that scratches `HOME` still reaches the real `~/.local/state/shipyard/planning-writers/shared`
  for planning launches. [R, V23] This is a test-isolation hazard.
- `legacyPlanningWriterRoots` / `assertNoLegacyPlanningWriter` (`:90-147`) refuse with
  `LEGACY_WRITER_STATE` when private writer state from older hosts is not a well-formed, released
  lease. This is a **second** pre-existing-state refusal class on the same upgrade path, also
  unnamed. [R]

### F8. Other pre-existing-state surfaces on the upgrade path

- `run-store.cjs:265-267` `normalizeStore`: any store whose `schema`/`version` differ throws
  `INVALID_STORE` `run store has an unknown schema` (no migration path in the file; the only
  schema strings are `shipyard.run-store.v1` / `shipyard.run-record.v1`, `:10-11`). [R]
- `dispatch-record.cjs:1186-1204` `load(..., strict)`: a strict update of an unreadable or
  differently-shaped `dispatches.json` throws `dispatch store cannot be safely updated`. [R]
- `inflightGraphDir` (`codex-delivery-host.cjs:130-135`) and `deliver-dispatch.cjs:562-563` read
  `SHIPYARD_GRAPH_DIR`; when it points elsewhere the recorder uses a different graph than the
  worktree one (`dispatch-record.test.cjs:2181-2205` covers one such case). [R]

### F9. Installer and packaging constraints that shape rollout

- The Codex package under `plugins/shipyard/host/**` is tracked (161 files, `git ls-files plugins/shipyard | wc -l`)
  and mirrors `plugins/delivery-pipeline/scripts` [V27, V31]. Every fix to a script therefore ships
  in two copies, and `.github/workflows/test.yml` runs `scripts/check-runtime-digest-trailer.cjs`
  against `tests/unit/runtime-file-digests.json` (a `Runtime-Digest-Refresh:` commit trailer is
  required) [R].
- Installed state differs by install kind: release marketplace (`~/.codex/shipyard`,
  `~/.codex/shipyard-plugin`), dogfood (`${XDG_STATE_HOME:-~/.local/state}/shipyard/dogfood/<runtime>/<digest16>`),
  and the legacy direct installer (`README.md:119-123` says not to run it alongside the marketplace
  one). README `:105-109` says the bootstrap reads models from `codex debug models` and that
  `SHIPYARD_CODEX_CAPABILITIES_FILE` "can" supply evidence; README `:163` says the dogfood install
  "still needs" it. Two documented rules disagree about whether the variable is required. [R]

---

## 4. Risk register (draft for `RISKS.md`)

Format of `RISKS.md`: `## <risk>` / `severity: low|medium|high` / `mitigation: <what we do>`.
Below, each risk also carries id, scenario, evidence, likelihood and the native acceptance need.
"mitigation" states a direction or guard, not a design choice; the design belongs to the user.

### Scenario matrix (the scenarios the contract names)

| Scenario | Outcome today (evidence) | Risk ids |
|---|---|---|
| Fresh install, no history | Works by construction: no sidecars, `recordInflight` creates the catalogue (`role-artifact.cjs:1808-1868`; clean fixture accepted per `LAUNCH-REFUSAL.md` table). Capability evidence still needs `CODEX_HOME` or the explicit variable (F2) | R-02, R-12 |
| Upgrade with old history (sidecars, no catalogue) | **Refuses** `ARCHIVE_AUTHORITY_INVALID` (observed in INV-015; code F1) | R-01, R-03, R-04 |
| Upgrade with partial history (catalogue exists for archives, sidecars not pinned; or some sidecars pinned) | Refuses on the first unpinned member; catalogue-shape drift (F1) | R-05 |
| Missing capabilities file | `RUNTIME_UNAVAILABLE` with the wrong remedy, exit 0 on the probe [V17, V18] | R-02, R-06, R-24 |
| Stale capabilities file (models/efforts no longer match ADR-014 grid) | `validateCodexCapabilities` fails at install (`gsd-tune.cjs:120-137`); at launch `readCapabilities` checks only that the lists are non-empty (`codex-runtime-host.cjs:149-157`) — staleness vs the policy grid is not re-checked [R] | R-07 |
| Multiple Codex homes | Rules differ per script (F2); doctor ignores `CODEX_HOME` [V22] | R-08 |
| Dogfood vs global install | Separate homes, shared authority namespace (F1), different version stamps (R-14) | R-09, R-14 |
| Concurrent sessions | Immediate `ARCHIVE_AUTHORITY_BUSY` without a named remedy (F7) | R-10 |
| Rollback after migration | Not evidenced anywhere in the repository (U-07) | R-11 |
| Legacy records later mistaken for verified evidence | Possible through any "pin existing files" shortcut (F1) | R-03 |

### R-01 Every upgraded project with pre-existing provenance is blocked at first launch
severity: high
likelihood: unknown (observed once in this checkout: 64 sidecars; `LAUNCH-REFUSAL.md`). Population of affected projects is unknown (U-01).
evidence: F1; shipped in tags `v0.72.0`–`v0.72.2` [V25, V26].
mitigation: no safe-by-default recovery exists in the code; a design must treat legacy sidecars as historical/unverified without admitting them to trusted evidence. Decision belongs to the user.
native acceptance: launch on a fixture carrying N pre-existing sidecars and no catalogue must succeed on both runtimes with no manual step and must leave the legacy files byte-identical.

### R-02 Missing environment variable or file blocks work before any role runs, with a misleading remedy
severity: high
likelihood: unknown (observed once; any shell that does not export the variables hits it, F2).
evidence: F2, F5; probes [V17, V18]. The only named hint says "Install and authenticate the runtime" (`refusal-hints.cjs:53-56`).
mitigation: a single discovery rule and a named, accurate remedy. Until then the user cannot learn the cause from the message.
native acceptance: launch from a shell with `env -i`-equivalent environment (only `PATH`/`HOME`) on both runtimes.

### R-03 Legacy records are promoted to trusted evidence by a convenience shortcut
severity: high
likelihood: unknown; it is the most obvious "quick fix" (pin whatever is on disk). The sidecar content (`dispatch_id, ticket, role, recorded_at` + install stamp, `dispatch-record.cjs:1564-1582`) is not itself authenticated. `LAUNCH-REFUSAL.md` states the observations "establish missing admission evidence, not maliciousness or proof of authenticity".
evidence: F1 (`:1854-1868` pins whatever is on disk at the time of the mutation); `role-artifact.test.cjs:1013-1014` forbids unknown members.
mitigation: any migration must record legacy status explicitly (a marker that downstream consumers can read), must never place legacy hashes in the same set that `historicalBookkeepingPins` returns as authenticated, and must keep the forged-member refusal for new files. Needs a consumer audit (U-03): which readers treat a catalogue member as proof.
native acceptance: (a) legacy file + new launch → legacy remains marked unverified in every report; (b) altered legacy file → not silently re-pinned; (c) a new unknown file added after migration still refuses.

### R-04 Deleting or moving history is used as the recovery
severity: high
likelihood: unknown; it already happened once (user-authorized archive-and-delete, `LAUNCH-REFUSAL.md`).
evidence: F1. Deleting history also removes forensic and usage-attribution joins (dispatch ids are the join key to transcripts, `dispatch-record.cjs:1207-1216`).
mitigation: remedy text must never suggest deletion; PROBLEM.md already rules it out of scope.
native acceptance: upgrade test must pass with history left in place and the history directory compared before/after by digest.

### R-05 Partial or mixed catalogue states
severity: medium
likelihood: unknown.
scenarios: catalogue exists (from archive admission) but sidecars were never pinned; catalogue carries the older `latest_bookkeeping` shape and no `bookkeeping_state`; catalogue lost while archives remain (`:1045-1046` refuses to mint a new key).
evidence: F1 (`:1777-1792`, `:1829`, `:1045-1046`).
mitigation: migration must enumerate and test each shape; schema label `...catalogue.v1` is overloaded (U-06).
native acceptance: fixtures for each shape on both runtimes.

### R-06 Refusals are discovered one at a time (masking)
severity: medium
likelihood: high given current ordering — verified by code order (F3) and by the observed INV-015 sequence.
evidence: F3.
mitigation: a preflight must collect all independent incompatibilities (provenance state, capabilities, runtime, agents manifest, writer state) and report them together before `recordInflight`.
native acceptance: a fixture with two simultaneous defects (legacy sidecars + no capabilities) must report both in one run.

### R-07 Stale or mismatched capabilities are accepted at launch
severity: medium
likelihood: unknown.
evidence: launch-time `readCapabilities` validates only non-empty `supportedModels`/`supportedEfforts` (`codex-runtime-host.cjs:149-157`); full grid validation is install-time (`gsd-tune.cjs:120-137`). The probe also checks `codex --version` and `exec --help` markers (`:184-208`).
mitigation: decide whether launch re-validates the grid; no change to ADR-014 (out of scope).
native acceptance: capabilities file from before a model-grid change → named refusal with a supported remedy, not a late selection failure.

### R-08 Multiple Codex homes resolve differently
severity: medium
likelihood: unknown; the dogfood design intentionally creates multiple homes (`README.md:152-161`).
evidence: F2 (differing fallbacks, `SHIPYARD_CODEX_AGENT_DIR`, `HOME` vs `os.homedir()`, doctor ignoring `CODEX_HOME` [V22]).
mitigation: one resolver used by hosts, doctor and tuner; the validated pair (home, capabilities) passed to children as the single source.
native acceptance: two homes present (release and dogfood), launch must name which one was selected and use it for agents, sessions and capabilities consistently.

### R-09 Dogfood and global installs share one authority namespace and project history
severity: medium
likelihood: unknown.
evidence: authority path depends only on `os.homedir()` and the worktree realpath (`role-artifact.cjs:985-1009`), not on the install; each sidecar is stamped by the writing host (`hostProvenance.current`, `dispatch-record.cjs:1568`). Different hosts of different versions will write and read the same `catalogue.json` (F1 shape drift).
mitigation: version/marker discipline in the catalogue (U-06); tests with host versions N and N+1 against the same state.
native acceptance: run host A then host B (different install kinds) against the same project; neither may refuse the other's history.

### R-10 Concurrent sessions refuse each other with no remedy
severity: medium
likelihood: unknown.
evidence: F7 (immediate `ARCHIVE_AUTHORITY_BUSY` when the owner pid is alive; unnamed hint).
mitigation: named remedy and bounded wait; verify stale-lock detection under pid reuse (S-3).
native acceptance: two simultaneous launches in one project: one proceeds, the other either waits within a bound or reports a named, supported recovery; no state corruption (catalogue byte-compare).

### R-11 Rollback after migration is unproven
severity: high
likelihood: unknown.
evidence: nothing in the repository describes downgrade; the older host (`d8a70dec^`) ignores the authority directory (`git show d8a70dec` shows the route is new), so a downgrade would likely work, but a re-upgrade after the old host has added sidecars outside the catalogue would re-trigger R-01 for those files. [A] — next check: spike S-2 (host N → host N-1 → host N on one fixture).
mitigation: a migration should be idempotent and re-runnable, and must not rewrite or move legacy files.
native acceptance: upgrade → downgrade → upgrade on one fixture; digest-compare history after each step.

### R-12 Fresh install works but fails at first ordinary command if the capabilities file path is not discoverable
severity: medium
likelihood: unknown.
evidence: `install-shipyard-codex.sh:125-128` demands the variable at install time; the marketplace bootstrap supplies it internally (`bootstrap-shipyard-plugin.cjs:104-114`) and the runtime later needs the same file (`codex-runtime-host.cjs:166-168`). The README says both "can supply" (`:109`) and "still needs" (`:163`).
mitigation: single documented rule; installer output should state the capabilities file path it recorded.
native acceptance: fresh marketplace install in a scratch home followed by an ordinary command with no exports.

### R-13 The decomposition subject grammar diverges (ADR-digest incident class)
severity: high
likelihood: unknown (an earlier incident occurred; its record is not in the repository, U-04).
evidence: F4 — four shapes, no `adr=` in production code, sealer accepts any string.
mitigation: one module that builds and parses the subject, used by both hosts, the sealer and `run-contract`; documentation derived from it.
native acceptance: round-trip test: subject built by the build step is accepted by the host, the sealer and the verifier on both runtimes; a wrong phase/repository/digest is refused with a named code.

### R-14 Version number cannot serve as the migration/upgrade marker
severity: medium
likelihood: unknown.
evidence: `plugin.json` is `0.71.0` on `main` and `0.72.2` at tag `v0.72.2` [V29]; `d8a70dec` is in `v0.72.0` but not `v0.71.0` [V25]. A build from `main` that contains `d8a70dec` therefore carries `plugin.json` version `0.71.0`, the same string as a release that does not contain it. [A for dogfood version stamping: the Codex package adds a content-hash suffix (`README.md:119-122`), which was not examined.]
mitigation: a capability or schema marker in state instead of the package version.
native acceptance: dogfood build and release build against the same project must make the same migration decision.

### R-15 Failed launches accumulate pinned sidecars
severity: low
likelihood: unknown; follows from code reading (F3), not executed.
evidence: F3 consequence 2.
mitigation: ordering (probe before record) or explicit cleanup of an own, never-launched sidecar; do not delete foreign history.
native acceptance: N refused launches must not grow `.planning/graph/provenance` (count before/after).

### R-16 Preflight reports "healthy" for a broken install
severity: medium
likelihood: observed (empty homes give `status: ok`, exit 0 [V21]).
evidence: F5.
mitigation: doctor/preflight must distinguish "nothing installed" from "ok"; exit non-zero or named status.
native acceptance: doctor against an empty home and against a home with a missing capabilities file must not report ok.

### R-17 Capability probe exits 0 when unavailable
severity: low
likelihood: observed [V17, V18].
evidence: `codex-runtime-host.cjs:1672-1679` sets `process.exitCode = 0` and `probeCodexRuntime` returns an object for `unavailable`.
mitigation: a launcher must read the JSON `status`, not the exit code, or the probe contract must change (compat for existing callers is unknown, U-11).
native acceptance: wrapper test that a missing file results in non-zero from the supported entry point.

### R-18 Hints missing on Claude delivery and role hosts
severity: medium
likelihood: observed by code reading.
evidence: F5 (`refusal-hints.cjs` imported by four files only [V11]).
mitigation: same hint surface for both runtimes.
native acceptance: each preflight refusal code produces a hint with a runnable remedy on both runtimes.

### R-19 Second pre-existing-state class (`LEGACY_WRITER_STATE`, `INVALID_STORE`) would surface after the first is fixed
severity: medium
likelihood: unknown.
evidence: F7, F8.
mitigation: the upgrade inventory must cover every persisted state family, not only provenance sidecars.
native acceptance: upgrade fixture containing runs store, writer lease, dispatches.json and sidecars from the previous release.

### R-20 E2E isolation leaks into real user state
severity: medium
likelihood: unknown.
evidence: `planning-writer-lease.cjs:86,92` uses `os.userInfo().homedir` (ignores `HOME`) [V23]; `tests/smoke/phase47-runtime-acceptance.cjs:15` hard-codes a real home path.
mitigation: e2e harness must isolate every state root (authority, writers, dogfood, `SHIPYARD_GRAPH_DIR`, `XDG_STATE_HOME`) and assert after the run that the real roots are unchanged.
native acceptance: pre/post digest of the real `~/.local/state/shipyard` listing is unchanged by the e2e (done by the harness, not by this line).

### R-21 Authority state is tied to the checkout's realpath and the user's home
severity: medium
likelihood: unknown; this repository sits on an external volume (`/Volumes/KINGSTON`), so a changed mount name changes the realpath.
evidence: `archiveAuthorityDirectory` hashes `fs.realpathSync(worktree)` (`role-artifact.cjs:1007-1009`). Moving or re-mounting the checkout, restoring the repo on a new machine or a changed `HOME` leaves provenance in the repo and the authority elsewhere → R-01 again. [A] for the mount-rename case; code evidence for the path rule.
mitigation: the migration must be re-runnable and the refusal must name the authority directory it looked in.
native acceptance: copy the project to a new path with history; launch must behave as upgrade-with-history, not as a hard failure.

### R-22 Generated package and digest pins drift from source
severity: low
likelihood: unknown.
evidence: F9 (two copies, digest trailer in CI).
mitigation: regenerate the package and refresh digests in the same change; verify with the existing diff.
native acceptance: `diff -rq` between source and packaged scripts is clean after the change [V27 shows the current baseline].

### R-24 Auto-discovery of capabilities changes a pinned "explicit evidence" contract
severity: medium
likelihood: certain if discovery is added (tests assert the current contract); whether it weakens evidence is unknown.
evidence: F6 (`codex-shipyard-smoke.sh:152`, `codex-runtime-host.test.cjs:512`, `phase47-launch-contract.test.cjs:178`, `claude-runtime-host.test.cjs:643`) [V36]; `capabilitiesFrom` error text `explicit Codex capability evidence is required` (`codex-runtime-host.cjs:169`); `gen-codex-shipyard.cjs:38-` already probes `codex debug models`, so a probe-based source exists. A file written at install time is a snapshot; it can be older than the live Codex catalog (R-07).
mitigation: decide which sources count as explicit evidence (installer-written bundle file, live probe, both) and state it in the contract; update the pinned tests deliberately; do not change ADR-014.
native acceptance: launch succeeds with discovered evidence and refuses with a named remedy when the evidence is missing, unreadable or does not cover the ADR-014 grid, on both homes.

### R-23 The fix itself weakens provenance
severity: high
likelihood: unknown; any admission code path is a new authority.
evidence: constraints from PROBLEM.md (no bypass of provenance, receipts or host admission; no silent trust; ADR-014 unchanged); `trustedBookkeepingMutation` is the only writer of `bookkeeping_state`.
mitigation: keep the writer and the lease host-owned; any migration is a host-run, audited step with its own receipt; no environment variable or flag lets a caller declare legacy files trusted.
native acceptance: negative tests for forged, altered, symlinked and out-of-namespace members still refuse after the change.

---

## 5. Native acceptance needs (what must be proven on real entry points)

These are needs, not designs. "Real entry point" means a supported command an operator or agent runs
against an installed package, not an in-process call.

| # | Need | Entry points that exist today | Notes |
|---|---|---|---|
| N-1 | Launch with no environment variables, Codex | marketplace install (`codex plugin add shipyard@shipyard`, `README.md:111-117`), then `node <home>/shipyard/scripts/deliver-dispatch.cjs build ...` and `node <home>/shipyard/scripts/codex-delivery-host.cjs --args-file ...` (the sequence in `LAUNCH-REFUSAL.md`) | The user-facing ordinary command is not a documented single command; the INV-015 evidence uses internal host commands (U-12) |
| N-2 | Launch with no environment variables, Claude | `claude-delivery-host.cjs`, `claude-role-host.cjs`, `claude-decompose-host.cjs`, `claude-investigation-host.cjs` through the plugin commands | No evidence collected on Claude's no-env behaviour (U-08) |
| N-3 | Upgrade carrying old history: (a) sidecars + no catalogue, (b) catalogue for archives only, (c) catalogue with legacy `latest_bookkeeping`, (d) altered legacy file, (e) new unknown file after migration, (f) symlinked member | none as an installed-package test; unit seams only (F6) | Fixture state must be created without touching `~/.local/state/shipyard` (R-20) |
| N-4 | Full UI cycle through the existing supported path on the installed package | not identified in this line; PROBLEM.md scopes it to "existing supported UI path through real entry points" | Entry point list is U-13 |
| N-5 | Missing/stale/unreadable capabilities on both homes | `codex-runtime-host.cjs --capability-only` (exit 0 always, [V17, V18]) | |
| N-6 | Multiple Codex homes (release + dogfood) | `make install-shipyard-dogfood-codex`; marketplace install | Doctor ignores `CODEX_HOME` [V22] |
| N-7 | Concurrent sessions in one project | two host launches | Expect BUSY handling (F7) |
| N-8 | Rollback: upgrade → downgrade → upgrade | install previous tag then current | History digest compared after each step |
| N-9 | Round trip of the phase/repository/ADR subject through build → host → sealer → verifier on both runtimes | `deliver-dispatch.cjs build decomposition ...`, both decompose hosts | F4 |
| N-10 | Preflight output names every incompatibility in one pass, with a supported remedy per code, on both runtimes | none today (F5) | |
| N-11 | After the e2e, the real user state is unchanged | harness check | R-20 |

Evidence to keep for each: the exact command, exit status, stdout/stderr, digests of the project
state before and after, and the live receipt where the existing live harness applies.

## 6. Open questions (draft for `OPEN-QUESTIONS.md`)

Each is also a checkbox in the required format. They are unknowns, not absorbed into prose.

- [ ] U-01: How many existing projects carry provenance sidecars written before `d8a70dec` and how many upgraded installs exist at `v0.72.0`–`v0.72.2`? — owner: user (maintainer telemetry/knowledge)
- [ ] U-02: Is the installed bundle at `~/.codex/shipyard` byte-identical to this source at `v0.72.x`? `LAUNCH-REFUSAL.md` cites `role-artifact.cjs:3954`, while this source has the refusal at `:1827` (`:3954` is the `read` command). Compare with `sha256sum` of the installed files versus `plugins/shipyard/host/plugins/delivery-pipeline/scripts/*` (this session could not read `~/.codex`). — owner: user (needs read access outside the sandbox) or a worker with that access
- [ ] U-03: Which readers treat membership in the catalogue (`bookkeeping_state`, `latest_bookkeeping`, `records[].bookkeeping`) as proof of authenticity, so a migration can be shown not to promote legacy files? (`codex-arch-review-context.cjs:446,823,965,1105` use the pins; no full consumer audit was done.) — owner: research (next worker)
- [ ] U-04: Where is the record of the earlier ADR-digest producer/consumer mismatch (phase + repository + ADR digest)? The repository has no `adr=` production code (F4), so the incident cannot be reproduced from source alone. — owner: user
- [ ] U-05: Is there any code path that compares the build-side decomposition subject (`phase;input;repository`, `deliver-dispatch.cjs:986`) with the sealer-side subject (`phase;repository`, `codex-decompose-host.cjs:140`)? If not, what verifies the "ADR digest" promised at `decompose.md:312-314`? — owner: research
- [ ] U-06: Does the `shipyard.role-archive-catalogue.v1` label need a version bump or an explicit migration marker, given that `bookkeeping_state` was added under the same label (`role-artifact.cjs:1781-1791`)? — owner: user (design decision after research)
- [ ] U-07: What happens when the host is downgraded and re-upgraded around a migration (R-11)? Is downgrade a supported operation for marketplace installs? — owner: user
- [ ] U-08: What is the behaviour of the Claude hosts with no `CLAUDE_*`/`SHIPYARD_*` variables, and does `CLAUDE_HOME` (read by installers) have any reader in the Claude runtime host? Only `CLAUDE_CONFIG_DIR` was seen in `claude-runtime-host.cjs:363,371`. — owner: research (not measured in this line)
- [ ] U-09: Which component writes the `.git/info/exclude` entries `.planning/graph/provenance/` and `.planning/graph/runs/`, and what happens in a fresh clone where they are absent (sidecars would show as untracked files and could be committed)? — owner: research
- [ ] U-10: Does any existing live or smoke test cover upgrade-with-old-history or a host launch with no exported variables? `tests/live/live-round.sh` was only read to its header and the search was by pattern. — owner: research
- [ ] U-11: Is changing the exit code or output contract of `codex-runtime-host.cjs --capability-only` (always exit 0, JSON `status`) compatible with its callers (`grep` shows `parseCliArguments`/`probeCodexRuntime` at `:1644-1689`; callers outside the repo are unknown)? — owner: user
- [ ] U-12: What is the supported "ordinary command" for an operator? `LAUNCH-REFUSAL.md` used `deliver-dispatch.cjs build` + `codex-delivery-host.cjs --args-file`, which PROBLEM.md calls internal host commands. Which slash command or skill maps to it on each runtime? — owner: user
- [ ] U-13: Which real entry points run the "existing supported UI path" for the installed-package full UI cycle (N-4), without deciding UI-SPEC/UI-review design? — owner: user
- [ ] U-14: Is a live owner pid reused after a crash able to hold `catalogue.lock` forever (R-10)? — owner: research (spike S-3)
- [ ] U-15: Is the `HOME` versus `os.userInfo().homedir` split in `planning-writer-lease.cjs:86,92` intended? It makes `HOME`-based e2e isolation incomplete. — owner: user (maintainer of the writer lease)
- [ ] U-16: Do two documentation statements about `SHIPYARD_CODEX_CAPABILITIES_FILE` ("can supply", `README.md:109`; "still needs", `:163`) both hold, and which is the intended contract after this INV? — owner: user
- [ ] U-17: Does a launch that fails after `recordInflight` leave an orphan pinned sidecar (R-15)? — owner: research (spike S-1)
- [ ] U-18: Which sources count as "explicit Codex capability evidence" for a launcher that discovers it (installer-written `codex-capabilities.json`, a live `codex debug models` probe, or both), given tests that pin the current explicit-evidence refusal (R-24)? — owner: user (design decision after research)
- [ ] U-19: Should the Claude delivery host, which today omits `worktree` from its in-flight record (`claude-delivery-host.cjs:1133`), enter the same bookkeeping route as the Codex host and `claude-role-host`, or is the difference intended? — owner: user (maintainer of the Claude hosts)

(Items raised by `OPEN-QUESTIONS.md` at intake that this line informs but does not close: the three
"owner: research" questions on environment resolution, pre-existing records and refusals are
answered descriptively in F1, F2 and F5; the digest question is partly answered in F4; the questions
owned by the user after research remain open.)

## 7. Assumptions (not command-backed) and where they would break

| # | Assumption | Next check |
|---|---|---|
| A-1 | Older hosts (`d8a70dec^`) ignore the authority directory, so downgrade works | spike S-2 |
| A-2 | A failed launch leaves a pinned sidecar | spike S-1 |
| A-3 | A reused pid can look like a live lock owner | spike S-3 |
| A-4 | A clone does not carry `.git/info/exclude` entries | `git clone` into scratch dir and list excludes (not run; needs a clone) |
| A-5 | Renaming the mount point changes `realpath` and so the authority key | spike with a symlinked and a copied project path |
| A-6 | The installed bundle matches this source | compare digests (blocked) |
| A-7 | Real concurrent-session frequency, project count and installed versions in the field | user input |

## 8. Spikes recommended (not run; throwaway code is out of this line's scope)

- `/gsd-spike "failed Codex launch after recordInflight leaves a pinned provenance sidecar"` — S-1 (R-15, F3).
- `/gsd-spike "upgrade N -> downgrade N-1 -> upgrade N on a disposable fixture with legacy sidecars, comparing history digests"` — S-2 (R-11).
- `/gsd-spike "catalogue.lock with a dead owner whose pid is reused by a live process"` — S-3 (R-10).
- `/gsd-spike "installed-package e2e harness with fully isolated HOME, XDG_STATE_HOME, SHIPYARD_GRAPH_DIR and planning-writers root"` — S-4 (R-20, N-1..N-11).
- `/gsd-spike "round-trip decomposition subject through build, host, sealer and verifier on both runtimes"` — S-5 (R-13).

## 9. Command log

All commands ran from `/Volumes/KINGSTON/claude-shipyard` unless noted. "exit" is the shell status.
Tool-based reads (Read/Grep) are cited inline as [R] with path:line; the Bash commands are below.

| ID | Command | Result |
|---|---|---|
| V1 | `git rev-parse HEAD` | `d8a70decb32e5420fb69f8eebc17be08e82d6d86` |
| V2 | `git status --short \| head -5` (run together with V1 at start) | first lines: `.planning/graph/*.json` modified, `.planning/...` untracked; no product files in the first five lines (the session context lists the full snapshot: planning and audit files only) |
| V3 | `wc -l plugins/delivery-pipeline/scripts/role-artifact.cjs plugins/shipyard/host/plugins/delivery-pipeline/scripts/role-artifact.cjs && grep -n "unknown host provenance member" <both files>`; plus Read of `role-artifact.cjs` lines 3940-3970 | both files 4047 lines; refusal text at `:1827` in both; `:3954` is `} else if (command === 'read') {` |
| V4 | `git show d8a70dec --format= -- plugins/delivery-pipeline/scripts/dispatch-record.cjs` | diff adds `authenticateBookkeeping`, `localInflightBookkeeping`, `authenticate` argument; `mutate` previously `withLock` only |
| V5 | Grep `unknown host provenance\|trustedBookkeepingMutation\|historicalBookkeepingPins\|legacy bookkeeping\|bookkeeping_state` in `tests/` | `tests/unit/role-artifact.test.cjs` (992-1068), `tests/unit/dispatch-record.test.cjs:2189,2198`, `tests/unit/codex-arch-review-context.test.cjs:920,924` |
| V6 | Grep count `SHIPYARD_CODEX_CAPABILITIES_FILE\|CODEX_HOME` in `tests/` | 247 occurrences in 23 files; `codex-shipyard-smoke.sh` 83 |
| V7 | Grep `decomposition-result\.v1\|decomposition-index` in `plugins/delivery-pipeline/scripts` | only `planning-result-sealer.cjs:305,314`, `claude-dispatch-adapter.cjs:25`, hosts' index roots |
| V8 | Grep `phase=.*repository=\|PHASE_SUBJECT\|...` in `plugins/delivery-pipeline/scripts` | subject builders and regexes listed in F4 |
| V9 | Grep `[;\`]adr=\|\badr=` repo-wide excluding audits, INV-014 research and packaged copy | `decompose.md:302,400`; `tests/unit/planning-artifacts.test.cjs:434,520,528`; one INV-008 research line |
| V10 | Grep `recordInflight\|clearInflight` excluding `dispatch-record.cjs` | `codex-delivery-host.cjs:1878,1938`, `claude-delivery-host.cjs:1141,1160`, `claude-role-host.cjs:1353,1428` |
| V11 | Grep `refusal-hints\|formatHint\|hintFor` in scripts | used by `codex-model-remap`, `codex-decompose-host`, `claude-investigation-host`, `codex-delivery-host`, `claude-decompose-host` only |
| V12 | `git check-ignore -v .planning/graph/provenance/x.json` | `.git/info/exclude:10:.planning/graph/provenance/` |
| V13 | `git ls-files .planning/graph/provenance` | empty |
| V14 | Grep `per-run graph state` repo-wide excluding audits | no matches |
| V15 | Grep `function \|module.exports\|process\.env\|capabilit\|CODEX_HOME\|provenance` in `host-verification.cjs` | no environment/capability/provenance check; plan-command verifier only |
| V16 | Grep `process\.env\|CODEX_HOME\|capabilit\|provenance\|catalogue\|runtime` in `sentinel-preflight.cjs` / `phase-integrator-preflight.cjs` | `sentinel-preflight.cjs`: no matches; `phase-integrator-preflight.cjs:45,209` only generic env/digest |
| V17 | `env -i PATH="$PATH" HOME="$TMPDIR/inv017-empty-home" node plugins/delivery-pipeline/scripts/codex-runtime-host.cjs --capability-only` | `status:"unavailable"`, `reason:"capability_evidence_missing"`, detail `explicit Codex capability evidence is required`; **exit 0** |
| V18 | same with `CODEX_HOME="$TMPDIR/inv017-empty-home/.codex"` | detail `cannot read Codex capability evidence: ENOENT ... .codex/shipyard/codex-capabilities.json`; **exit 0** |
| V19 | `env -i ... node -e` loading `refusal-hints.cjs` and testing `Object.hasOwn(HINTS, code)` for 11 codes | only `RUNTIME_UNAVAILABLE` named; `ARCHIVE_AUTHORITY_INVALID/REQUIRED/BUSY`, `RUNTIME_CAPABILITY_MISSING`, `LEGACY_WRITER_STATE`, `AMBIGUOUS_RUNTIME`, `UNKNOWN_RUNTIME`, `STALE_POLICY`, `INVALID_STORE`, `SOURCE_REVISION_UNAVAILABLE` unnamed; exit 0 |
| V20 | `grep -n "no env\|env -i\|unset CODEX_HOME\|unset SHIPYARD_CODEX_CAPABILITIES_FILE\|--no-env" tests/smoke/*.sh tests/live/live-round.sh tests/unit/marketplace-installer.test.cjs` | no output |
| V21 | `env -i ... node scripts/shipyard-doctor.cjs --codex-home <scratch> --claude-home <scratch> --json` | `status:"ok"`, `source_version:"0.71.0"`, checks `claude`/`codex`/`codex-agents` all `skip`; exit 0 |
| V22 | `env -i ... CODEX_HOME=<scratch-env> node scripts/shipyard-doctor.cjs --claude-home <scratch> --json \| grep -n '"codex_home"'` | `"codex_home": "<HOME>/.codex"` — the variable is ignored |
| V23 | `grep -n "os.userInfo\|userInfo()" plugins/delivery-pipeline/scripts/*.cjs` | `planning-writer-lease.cjs:86,92` only |
| V24 | `git status --short -- plugins scripts tests Makefile .github README.md CLAUDE.md` (end of work) | no output, exit 0 |
| V25 | `git merge-base --is-ancestor d8a70dec main`; `... v0.72.0`; `... v0.71.0` | exit 0; exit 0; exit 1 |
| V26 | `git tag --contains d8a70dec`; `git tag --sort=-creatordate \| head -5` | `phase-47 v0.72.0 v0.72.1 v0.72.2`; latest tags `v0.72.2 v0.72.1 v0.72.0 phase-47 v0.71.0` |
| V27 | `diff -rq plugins/delivery-pipeline/scripts plugins/shipyard/host/plugins/delivery-pipeline/scripts` | `Only in plugins/delivery-pipeline/scripts: .claude`; exit 1 (only that difference) |
| V28 | `git diff --stat d8a70dec HEAD -- role-artifact.cjs dispatch-record.cjs codex-runtime-host.cjs codex-delivery-host.cjs` | no output |
| V29 | `git show v0.72.2:plugins/delivery-pipeline/.claude-plugin/plugin.json \| grep '"version"'`; same at HEAD and `v0.71.0` | `0.72.2`; `0.71.0`; `0.71.0` |
| V30 | Grep `resolveDispatchContext\|routed:\s*true\|resolveRuntime\(` excluding `runtime-context.cjs` | `pipeline-config.cjs:1113,1129,1697,1864,1870,1885,1889`, `codex-agent.cjs:152,163`, `gsd-tune.cjs:386` |
| V31 | `git ls-files plugins/shipyard \| wc -l` | 161 tracked files |
| V32 | `git log -1 --format='%H %cd' v0.72.2`; `git log --oneline -4 v0.72.2 -- plugins/delivery-pipeline/scripts/role-artifact.cjs` | `be7ab4f3... Thu Oct 15 17:32:48 2026`; `c7633d9e (#456)`, `d8a70dec (#421)`, `a4e22676`, `e4c95e82` |
| V33 | `git worktree list` | main checkout plus four linked worktrees, all marked `prunable` (two under `~/.local/state/shipyard/investigations/...`, two under `/Volumes/KINGSTON/worktrees/...`) — stale worktree registrations exist; relevance to authority keys is unexamined |
| V34 | `grep -n "const inflight = \|inflight = {" claude-delivery-host.cjs claude-role-host.cjs codex-delivery-host.cjs` (in `plugins/delivery-pipeline/scripts`) | `claude-delivery-host.cjs:1133` no `worktree`; `claude-role-host.cjs:1350` and `codex-delivery-host.cjs:1872` include `worktree` |
| V35 | Grep `delete .*CODEX_HOME\|CODEX_HOME: undefined\|SHIPYARD_CODEX_CAPABILITIES_FILE` in `tests/unit/marketplace-installer.test.cjs`; Grep `SHIPYARD_CODEX_CAPABILITIES_FILE\|CODEX_HOME` in `tests/unit/codex-runtime-host.test.cjs` | installer tests clear both variables at lines 460, 614, 679, 750, 768, 812, 823, 876; runtime-host tests always set `CODEX_HOME` (e.g. 240, 299, 329, 366, 413, 459, 658) |
| V36 | Grep `capability evidence is required\|capability_evidence_missing\|RUNTIME_CAPABILITY_MISSING` in `tests/` | `codex-shipyard-smoke.sh:152`, `codex-runtime-smoke.sh:309,382`, `phase47-launch-contract.test.cjs:178`, `codex-runtime-host.test.cjs:512`, `claude-runtime-host.test.cjs:643` |

Source files read (all under the checkout): `plugins/delivery-pipeline/scripts/{codex-runtime-host,codex-delivery-host,codex-decompose-host,codex-agent,runtime-context,dispatch-record,role-artifact,run-contract,run-store,planning-writer-lease,planning-result-sealer,deliver-dispatch,claude-role-host,claude-runtime-host,gsd-tune,refusal-hints,context-packet}.cjs`; `scripts/{shipyard-doctor,gen-codex-shipyard,bootstrap-shipyard-plugin,install-shipyard-codex.sh,install-shipyard-marketplace.cjs}`; `Makefile`; `README.md`; `CLAUDE.md`; `.github/workflows/test.yml`; `tests/unit/{role-artifact,dispatch-record}.test.cjs`; `tests/smoke/{codex-shipyard-smoke.sh,phase47-runtime-acceptance.cjs}`; `tests/live/live-round.sh`; `docs/audits/2026-10-03-phase47-launch-fix.md`; `docs/audits/2026-10-03-phase47-runtime-failure-state-fix.md`; `.planning/investigations/INV-015-ui-lifecycle-integration/LAUNCH-REFUSAL.md`; INV-017 `PROBLEM.md`, `RESEARCH-CONTRACT.md`, `DECISIONS.md`, `OPEN-QUESTIONS.md`, `EVIDENCE.md`.

## 10. Draft `RISKS.md` entries (condensed)

```
## Upgraded project with pre-existing provenance refuses every launch (R-01)
severity: high
mitigation: treat legacy sidecars as historical/unverified in a host-owned, receipted migration; never pin them as authenticated; keep refusal for new/altered members.

## Missing env/capabilities refuses with a misleading remedy (R-02, R-06, R-16, R-17, R-18)
severity: high
mitigation: one discovery rule and one preflight that reports every incompatibility before recordInflight, with named, accurate remedies on both runtimes.

## Legacy records promoted to trusted evidence (R-03, R-23)
severity: high
mitigation: explicit legacy marker in state; consumer audit; negative tests for forged/altered/symlinked members.

## History deleted as recovery (R-04)
severity: high
mitigation: no remedy text suggests deletion; upgrade tests leave history byte-identical.

## Rollback after migration unproven (R-11, R-21)
severity: high
mitigation: idempotent, re-runnable migration that does not rewrite legacy files; upgrade→downgrade→upgrade acceptance.

## Decomposition subject grammar divergence (R-13)
severity: high
mitigation: one build/parse module for both hosts, sealer and run-contract; round-trip acceptance on both runtimes.

## Mixed catalogue shapes, multiple homes, dogfood vs global (R-05, R-08, R-09, R-14)
severity: medium
mitigation: explicit schema/marker, one home resolver, host N / host N+1 acceptance.

## Concurrent sessions and lock behaviour (R-10)
severity: medium
mitigation: named remedy and bounded wait; stale-lock check under pid reuse.

## E2E isolation and generated-package drift (R-20, R-22)
severity: medium
mitigation: harness isolates every state root and checks real roots are unchanged; regenerate package and digests with the change.

## Capability discovery changes a pinned explicit-evidence contract; stale capabilities accepted (R-07, R-24)
severity: medium
mitigation: decide which sources count as explicit evidence and whether launch re-validates the ADR-014 grid; update pinned tests deliberately; no ADR-014 change.

## Orphan pinned sidecars from failed launches (R-15)
severity: low
mitigation: ordering (probe before record) or cleanup limited to the launch's own sidecar.
```
