---
phase: "54"
slug: "let-an-operator-grant-one-more-code-review-round"
status: draft
nyquist_compliant: false
wave_0_complete: false
created: "2026-11-02"
---

# Phase 54 — Validation Strategy

Derived from the "Validation Architecture" section of `54-RESEARCH.md` (sha256 `a91cd6cd9b9c4ce2641f062de57ffa9e584f9eb0a863c0f902783df66fcec17c`, the file as revised in cycle 1, in which every `path:line` of that section was re-checked against `749604b9`), the output of the phase-54 `gsd-phase-researcher`. The framework table, the run block, the requirement rows, the sampling rate and the Wave 0 gaps carry the research's content; the research's `§Pitfall`/`§Pattern` cross-references are dropped and its "Test files that pin the cap or the wording" subsection is condensed to two paragraphs here. It adds no requirement of its own; per-ticket verification commands live in each PLAN.md and are scoped to its `files_modified`. Wave 0 files below do not exist yet; `wave_0_complete` stays false until the tickets that create them land.

### Test Framework
| Property | Value |
|----------|-------|
| Framework | Node built-in `node:test` (TAP output: `code-review-core`, `refusal-hints`, `claude-role-host`, `phase-code-review`, `phase-code-review-publish`, `codex-code-review-context`) or the in-repo `assert-harness.cjs` (`role-artifact`, `deliver-dispatch`: "N passed, 0 failed"); each file is a standalone script |
| Config file | none; `tests/unit/run.sh` gives each file a private environment (`:10`, `:103-125`); a new `tests/unit/*.test.cjs` is picked up by `unit_files=(tests/unit/*.test.cjs)` (`run.sh:21`) and by `shard-files.cjs:22`, default shard weight 5 (`shard-files.cjs:10`), with no registration |
| Quick run command | `node tests/unit/<file>.test.cjs` in the `run.sh` environment below; inside a `node:test` file scope with `node --test-name-pattern '<regex>' tests/unit/<file>.test.cjs` (verified: `'rounds count'` selects 1 test of `code-review-core`, 1 pass) |
| Full suite command | `make test-unit` (CI's job per CONTEXT; CI runs `UNIT_SHARD=<i>/<n>` at `.github/workflows/test.yml:73`) |

Run one file in `run.sh`'s environment. The block mirrors `run.sh:10` (unset the four host markers) and `:103-125` (per-worker `HOME`, `CODEX_HOME`, `CLAUDE_CONFIG_DIR`, `TMPDIR`/`TMP`/`TEMP`, `XDG_*`, `GIT_CONFIG_GLOBAL`, `GIT_CONFIG_NOSYSTEM=1`, git identity, `init.defaultBranch main`); `code-review-core` (26/26) and `refusal-hints` (23/23) ran green with it. Every `node …` command in the table below runs inside it:

```bash
W="$(mktemp -d)"; mkdir -p "$W"/{home,tmp,codex,config,cache,state,data,runtime,claude}; chmod 700 "$W/runtime"
git config --file "$W/gitconfig" user.name t; git config --file "$W/gitconfig" user.email t@t.invalid
git config --file "$W/gitconfig" commit.gpgsign false; git config --file "$W/gitconfig" tag.gpgsign false
git config --file "$W/gitconfig" init.defaultBranch main
env -u CLAUDE_PLUGIN_ROOT -u CLAUDE_CODE_ENTRYPOINT -u CODEX_SANDBOX -u CODEX_SANDBOX_NETWORK_DISABLED \
  HOME="$W/home" CODEX_HOME="$W/codex" CLAUDE_CONFIG_DIR="$W/claude" TMPDIR="$W/tmp" TMP="$W/tmp" TEMP="$W/tmp" \
  XDG_CONFIG_HOME="$W/config" XDG_CACHE_HOME="$W/cache" XDG_STATE_HOME="$W/state" XDG_DATA_HOME="$W/data" \
  XDG_RUNTIME_DIR="$W/runtime" GIT_CONFIG_GLOBAL="$W/gitconfig" GIT_CONFIG_NOSYSTEM=1 \
  node tests/unit/code-review-core.test.cjs
```

`role-artifact.test.cjs` is very large. `--code-review-d37-only` selects four name groups, six cases: three exact names and one prefix (`role-artifact.test.cjs:42-46`); `d37Selected` is counted at `:49` and asserted equal to 6 at `:2315`; `--code-review-reuse-only` selects one case (`:50`, `:2316`); only one selection flag is accepted (`:39-40`). A new case that must run under the flag has to be added to `d37Case` and `d37Selected` raised in the same change, or it is skipped silently.

### Phase Requirements → Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| REQ-204 | `extend` writes a 0600 record in a 0700 directory under the overridden home; a wrong or missing `--confirm` refuses; the record mutation matrix (json, oversize, directory, symlink, mode, namespace-mode, ancestor-symlink, schema, repository, selector, pr, base, unreadable, wrong owner); the read path creates no directory | unit | `node tests/unit/phase-code-review.test.cjs` (fixture `:46-74`, CLI spawn pattern `:102-118`) and one new `tests/unit/*.test.cjs` for the store (matrix pattern `phase-code-review-publish.test.cjs:885-921`, path helper `:655-660`) | ✅ fixtures; ❌ new cases, Wave 0 |
| REQ-205 | `extend` refuses under the child marker (direct call and CLI) and creates nothing; the record path is outside the worktree and the planning checkout; both runtime hosts put the marker in the child environment | unit | `node tests/unit/phase-code-review.test.cjs`; marker asserted like `claude-runtime-host.test.cjs:272-279` and `codex-runtime-host.test.cjs:304-307` (run both files) | ❌ Wave 0 |
| REQ-206 | no record → `limit`; a record for another head, base or PR does not apply; several records clamp at 5; sequence round 4 → push → new record; the three call sites agree | unit | `node tests/unit/code-review-core.test.cjs` (table `:167-180`, `:352-372`, stubbed `isAncestor`); `node --test-name-pattern 'D37 fix tickets' tests/unit/phase-code-review.test.cjs` (`:180-229`); `claude-role-host.test.cjs:2435-2468`; `codex-code-review-context.test.cjs:243-254`, `:1060-1093`; history shape `role-artifact.test.cjs:1933-1980` | ✅ pattern; ❌ cases |
| REQ-207 | normalize, seal and replay-depth at 5; a five-deep carried lineage authenticates; rc.2 reader throws on a sealed round-4 verdict | unit | `node tests/unit/role-artifact.test.cjs --code-review-d37-only` (a new case registered in `d37Case`, `d37Selected` raised at `:2315`); `node tests/unit/code-review-core.test.cjs` for the `normalizeResult` ceiling | ❌ Wave 0 (no test of `role-artifact.cjs:3190` exists) |
| REQ-208 | an extended round is delta or refuses; `repairAllowed` is true for 1-2 only; `repair: 'human'` for rounds 4 and 5 | unit | `code-review-core.test.cjs:180` extended from `[1,2,3]` to `[1,2,3,4,5]`; `phase-code-review.test.cjs:193` (`round < 3 ? 'tickets' : 'human'`) and the `:180-229` loop extended | ✅ pattern |
| REQ-209 | status text ≤140 with an extension at maximum counts; comment header carries the line; named hints for the extend command and `report`; hygiene on the comment; every text offering `report` says project-wide | unit | `node tests/unit/phase-code-review-publish.test.cjs` (`:382-396`, comment footer `:182`, `:360`, limit text `:212`); `node tests/unit/refusal-hints.test.cjs`; the order-sensitive wording regexes in `phase-code-review.test.cjs`, `deliver-dispatch.test.cjs`, `deliver-builders-contract.test.cjs`, `claude-role-host.test.cjs:2465` | ✅ pattern |
| REQ-210 | the reference states rounds 1-5 with a fourth round only on a record; the reference tests still pass | unit | `node tests/unit/judgment-contract.test.cjs`, `node tests/unit/claude-reference-content.test.cjs`, `node tests/unit/source-contract.test.cjs` | ✅ |
| REQ-211 | one delta per batch of fixes; a record voided by a head move costs nothing; the ceiling is final; net-lines report | unit + PR text | the core and `phase-code-review` tests above; `git diff --shortstat <base>...HEAD -- . ':!plugins/shipyard'` in each PR | ✅ |
| REQ-212 | the six files carry `1.0.0-rc.5`; plugin and capability versions agree; the mirror matches the source | unit + smoke | `node tests/unit/files-contract.test.cjs` (`:504-508`), `node tests/unit/marketplace-install.test.cjs` (`:60-104`), `make test-releases` (needs network and `gh`) | ✅ |

### Test files that pin the cap or the wording (reproduces ADR-035's "nine")

Seven files pin the cap, the limit state or its text: `code-review-core.test.cjs` (`:167-180`, `:352-372`; `repairAllowed` at `:180`), `code-review-foreign-contract.test.cjs` (`:52`), `phase-code-review.test.cjs` (`:180-229`, `:418-419`, `:449`, `:465`, `:718`), `phase-code-review-publish.test.cjs` (`:187-215`, `:382-396`), `role-artifact.test.cjs` (`:1933-1980`, `:2287`: `assert.equal(status.round_cap, 3);`, which stays true because `round_cap` stays 3), `claude-role-host.test.cjs` (`:2435-2468`; `:2465`: `/three rounds/`) and `codex-code-review-context.test.cjs` (`:243-254`, `:1060-1093`). Two more pin only the `report` wording: `deliver-dispatch.test.cjs` (`:1128`, `:1165`, `:1185`, `:1191`) and `deliver-builders-contract.test.cjs` (`:71`, `:195`). That is nine files. The comment footer wording is pinned by `phase-code-review-publish.test.cjs:182` and `:360`. Every wording regex is order-sensitive: the state word, then `delivery_pipeline.code_review`, then `report`; `three rounds` stays in the limit reason or its three assertions (`phase-code-review.test.cjs:222`, `claude-role-host.test.cjs:2465`) move in the same ticket.

Structure that constrains a ticket: `phase-code-review-publish.test.cjs:1047-1072` runs the packaged mirror copy of `phase-code-review.cjs` beside the source copy on one publication record and lock, so the record format, directory hash and lock name stay unchanged; `codex-code-review-context.test.cjs:622-637` appends a byte to each of the 15 pinned host sources and expects `STALE_CONTEXT`; `phase-code-review-publish.test.cjs:208` requires that no namespace directory exists after a refused publication.

### Sampling Rate
- **Per task commit:** the single touched test file(s) in the clean environment above, scoped with `--test-name-pattern` where the file is `node:test`-based (the three slowest files take 4-8 minutes whole), plus `node --check` on each touched script.
- **Per wave merge:** all touched test files whole; `make test-comment-policy COMMENT_POLICY_BASE=origin/epic/harness-simplification` (`Makefile:109-110`).
- **Phase gate:** CI's full suite (`UNIT_SHARD` at `.github/workflows/test.yml:73`, `make test-fast-rest` at `:121`); the executor does not run it locally.

### Wave 0 Gaps
- [ ] A committed S1/S4 record and test (round-4/5 seal, five-deep carried lineage, rc.2 reader throws), because no test covers `role-artifact.cjs:3190`.
- [ ] Extension-record tests: a new `tests/unit/*.test.cjs`, auto-picked by `run.sh:21` and `shard-files.cjs:22`, not packaged.
- [ ] An extended-round case in the status-grammar maximum test (`phase-code-review-publish.test.cjs:382-396`).
- [ ] A child-marker assertion in the two runtime-host tests (`claude-runtime-host.test.cjs:272-279`, `codex-runtime-host.test.cjs:304-307`).
- [ ] Every new `role-artifact.test.cjs` case that must run under `--code-review-d37-only` registered in `d37Case`, with `d37Selected` raised at `:2315` in the same change.
- [x] Baselines for the previously unmeasured files (`role-artifact --code-review-d37-only` 6 passed, `claude-role-host` 235/235, `deliver-dispatch` 41 passed): closed, recorded in `54-RESEARCH.md` §Environment Availability.
- [ ] no framework install needed.
