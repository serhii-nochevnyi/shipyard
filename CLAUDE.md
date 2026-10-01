# CLAUDE.md

This repository contains Shipyard, a host-side delivery conveyor for software
projects. It does not contain application code or a separate execution
environment. The canonical implementation is the Claude Code plugin under
`plugins/delivery-pipeline/`; `scripts/gen-codex-shipyard.cjs` generates the
equivalent Codex skills and agents.

## Host setup

Claude Code uses the marketplace plugin plus the host hooks and capability:

```bash
claude plugin marketplace add serhii-nochevnyi/shipyard
claude plugin install shipyard@shipyard
make install-shipyard-claude-hook
make install-shipyard-capability
```

Codex uses its marketplace package and automatically installs the GSD plugin:

```bash
make package-shipyard-codex
node scripts/install-shipyard-marketplace.cjs codex --source "$PWD"
```

The installers write only to the selected runtime homes. Set `CLAUDE_HOME`,
`CODEX_HOME`, or `AGENTS_SKILLS_DIR` when an installation uses non-default
locations. Set `SHIPYARD_CODEX_PHASE=1` to install only investigation and
decomposition skills.


## Tests

```bash
make test-fast          # deterministic local checks
make test-unit          # parser, policy, attribution and matching tests
make test-graph         # graph and plan:post gate fixtures
make test-worktree      # local git worktree lifecycle
make test-worktree-gates
make test-sentinel      # state-sync, merge scope and sentinel fixtures
make test-docs          # user documentation and command-surface contract
make test-hooks         # Claude hook dependency bundle and migration
make test-codex-shipyard # generator, installer and capability integration
make test-releases      # release metadata contract
make test               # test-fast plus the host Codex and release checks
make capture-fixtures    # manual, scrubbed boundary-fixture capture; needs BOUNDARY=
make test-live           # one live round per runtime; needs gh auth and SHIPYARD_LIVE_REPO
make release             # tag once both runtimes have a fresh live receipt; needs VERSION=
make refresh-runtime-digests         # the only way to change the runtime-file digest pin
make install-shipyard-dogfood-claude # separate install root; DOGFOOD_ROOT= optional, defaults to a dedicated per-checkout home
make install-shipyard-dogfood-codex  # separate install root; DOGFOOD_ROOT= optional, defaults to a dedicated per-checkout home
make untrack-planning    # dry run; apply needs CONFIRM=untrack-planning
```

Run `make test-fast` after each edit. It requires only the host shell and Node;
the Codex smoke is separate because it installs GSD from the npm registry.

`tests/smoke/docs-smoke.sh` is the contract for the supported host workflow. It
checks the documented commands against `plugin.json`, verifies every `make`
target named by the README, checks the Claude and Codex installation paths, and
fails if removed execution paths or their files return.

## Architecture

The conveyor has three layers:

1. `plugins/delivery-pipeline/` contains the canonical commands, references,
   templates and deterministic scripts.
2. `capabilities/delivery-pipeline/` contains the global GSD gates. Its
   `plan:post` gate is applicability-scoped: unrelated GSD projects pass, while
   projects with a `delivery:` block fail closed on an invalid graph.
3. `scripts/gen-codex-shipyard.cjs` converts the canonical plugin through
   GSD's runtime converter and writes Codex-native skills, agents and payload.

Codex artifacts are generated. Edit the Claude command or shared script first,
then run `make package-shipyard-codex` and inspect the generated result.
The marketplace package under `plugins/shipyard` is generated; never edit its
`host/` copy directly. Ticket PRs into an `epic/*` branch, or stacked on a `ticket/*` branch, do not regenerate it and CI
skips its staleness check for them; regenerate it once on the epic before the
epic → `main` PR, where the check is enforced. GSD is a required marketplace dependency on both hosts.

The deterministic scripts own decisions that can be computed: frontmatter
parsing, graph validation, ticket and PR matching, state synchronization,
worktree lifecycle, dispatch records, model resolution, convergence and stop
conditions. When adding a rule, add a focused unit or fixture test with it.

**Active routed dispatch policy (ADR-014 v7, accepted):** ADR-014 supersedes ADR-005 and ADR-012 for model and effort selection. The one boundary contract has two independent native grids: Codex Sol is `gpt-6.1-sol`, Luna is `gpt-6-luna`; Claude Sonnet is `claude-sonnet-5-5`, Opus is `claude-opus-5-5`, and Fable is a measured-window-only ceiling. Do not alias either grid through the other, and do not use a compatibility palette, generic GSD tier default, or per-role override as launch authority.

**Codex grid:** research Sol/high → Sol/xhigh only for explicit very-complex; decomposition Sol/high → Sol/xhigh only for explicit critical/checkpoint; executor Sol/low → Sol/high only for explicit `critical`/`checkpoint`; pr-sentinel Luna/medium; integrator Sol/high → Sol/xhigh only for contested, explicit `critical`/`checkpoint`, or a measured window; drift-check Sol/low; arch-review Sol/high → Sol/xhigh only for contested, explicit `critical`/`checkpoint`, or a measured window; ci-fix and review-fix Sol/low → Sol/high for verified `repeat` → Sol/xhigh for verified `repeat_exhausted`.

**Claude grid:** research Sonnet/xhigh → Opus/high only for explicit `very-complex` (`alternatives` remains evidence but does not promote); decomposition Sonnet/xhigh → Opus/high only for explicit `critical`/`checkpoint`; executor Sonnet/medium → Sonnet/xhigh only for explicit `critical`/`checkpoint`; pr-sentinel Sonnet/low; integrator Sonnet/xhigh → Opus/high only for `contested`, explicit `critical`/`checkpoint`, or a measured window; drift-check Sonnet/medium; arch-review Sonnet/xhigh → Opus/high for `critical`/`checkpoint`/`contested` → Fable/medium for a measured window; ci-fix and review-fix Sonnet/high → Sonnet/xhigh for verified `repeat` → Opus/high for verified `repeat_exhausted`. Fixed mechanical roles do not promote from global window or complexity signals.

**Mandatory boundary:** every routed launch must resolve → validate → launch → receipt. The selected runtime-native model and effort must be explicit at launch; validate the policy fingerprint and selected generated Codex agent or dynamic launch arguments before side effects; then record requested and applied model/effort with an application receipt. Unknown or ambiguous runtimes, unsupported selections, stale or missing generated variants, conflicting overrides, inline or session-inherited selection, and missing receipts hard-refuse. A successful process exit is not evidence that the runtime applied the selection. Historical ADR reasoning stays in ADR-005 and ADR-012; it is not operating guidance.

`model-policy.cjs` is the versioned reader for routed model and effort selections.
`pipeline-config.cjs` remains a compatibility reader; it cannot authorize routed
dispatches. Claude launches use the runtime-native model ID, including
`claude-sonnet-5-5` and `claude-opus-5-5`; Codex writes a concrete
model and effort into generated agent files because its agents are static.
Codex model ids are resolved from the runtime-native ADR-014 grid; the active
policy is `adr-014.v7` and historical v6 receipts remain unchanged. Legacy
palette input is compatibility-only and cannot authorize a routed dispatch.

Fable is a Claude-only ceiling and is reached only by an explicit measured
route with `pipeline.fable: auto`. The default remains conservative. A Codex
capability file is required when the installer needs to validate measured model
availability; the README documents its format and installation flow.

`gsd-tune.cjs` reports configuration drift and can apply safe host defaults:

```bash
make gsd-tune
make gsd-tune-apply
make doctor
```

Run these commands from the target project's root so its `.planning/config.json`
is the file being evaluated.

`make doctor` can be run from this checkout to compare the source with the
installed Claude hook and Codex bundle. It is read-only.

## Editing rules

- Keep the Claude plugin canonical and regenerate Codex outputs after shared
  changes.
- Keep shell scripts on `set -euo pipefail` and validate preconditions early.
- Keep generated state and measurements in the existing `.planning` locations.
- Preserve unrelated worktree changes; this repository is often edited while a
  delivery session is active.
- Update `README.md` when the supported command or installation flow changes.
- Change the runtime-file digest pin only with `make refresh-runtime-digests`
  and the printed trailer.

The detailed conveyor protocol is in
[`docs/gsd_multilevel_delivery_pipeline.md`](docs/gsd_multilevel_delivery_pipeline.md).
