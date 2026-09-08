# ADR-003 — The conveyor follows the models it runs on

- **Status**: accepted
- **Date**: 2026-09-07
- **Supersedes**: nothing. Refines the two-layer model rule in `CLAUDE.md`
  (shipyard owns the TIER, GSD owns tier → model).

## Context

Three things moved under the conveyor within a fortnight, and the repository
records none of them:

- **Claude Code.** Since v2.1.219 the `opus` alias resolves to Opus 5, since
  v2.1.255 `fable` resolves to Fable 5.1; the Agent tool's `model` field now
  accepts full model ids and `inherit` as well as the four aliases
  (code.claude.com/docs/en/model-config, read 2026-09-07). The container pins
  Claude Code **2.1.200** — inside the image `opus` is still Opus 4.8 and
  `fable` is Fable 5. `CLAUDE.md`, `deliver.md`, `investigate.md`, `README.md`
  and `docs/` all state that the Agent tool REJECTS full ids; that is TRUE and
  stays. What they lack is the distinction from subagent frontmatter, and the
  version floors. Fable bills usage credits on some plans and asks
  for consent once; in a background or Remote Control session that prompt
  waits `dialogExpiry` (5 min) and then ENDS THE TURN without sending — an
  autonomy break for any org that has not consented yet.
- **Codex.** `gpt-6-astra` shipped 2026-09-03 (1M context, efforts
  low…max, opt-in per the Codex CLI notes; first-class config in CLI 0.153.1).
  This host's `~/.codex/config.toml` already names it as the default. GSD
  1.13.0's catalog still maps every Codex tier to `gpt-5.6-sol/terra/luna`, and
  `gen-codex-shipyard.cjs` BAKES the catalog's model into all seven
  `~/.codex/agents/shipyard-*.toml` files — today `gpt-5.6-terra` for every
  role, because `capForRuntime` deliberately caps the whole ladder to the
  workhorse tier on Codex. The baked model therefore differentiates nothing
  (every role gets the same one) and only OVERRIDES the user's newer default.
  GSD's own Codex agents carry no `model` key (`resolve_model_ids: omit`);
  `deliver.md` even claims ours do not either — the code and the prose
  disagree, and the code is the worse of the two. The generator also ignores
  GSD's user remap keys (`model_policy.runtime_tiers.codex.*`,
  `model_profile_overrides.codex.*`), which `CLAUDE.md` says it honours.
- **GSD.** Latest is 1.13.0 (2026-09-06). The image pins **1.7.0**, the Codex
  smoke pins 1.9.1, this host has the plugin at 1.13.0, the Claude npm global
  at 1.12.0 and the Codex global at 1.11.0. Nothing in 1.12/1.13 changes the
  conveyor's contracts (checked: model catalog for claude/codex identical to
  1.12, alias set unchanged, config keys the conveyor reads unchanged), but
  1.13 introduces a `gate-status:` COMMIT trailer for its TDD audit — a
  different mechanism from the conveyor's `gate_status:` PR-body trailer, close
  enough in spelling to be confused by a reader.

The recorded decision on `fable` is also in two places and they disagree:
`CLAUDE.md`, `README.md` and `deliver.md` say it is opt-in only; `ladderTier`
gives it to `arch-review` and `integrator` by default with its own argued
comment. The user confirmed on 2026-09-07 that the CODE is the decision:
judgment roles stay on `fable` on Claude, because the 1M window is what
distinguishes their work; the prose is what changes.

## Decision

- **D1 — Pins follow the runtimes the conveyor is tested on.** Claude Code
  ≥ 2.1.255 in the image (Fable 5.1; Opus 5 needs 2.1.219), gsd-core 1.13.0 in
  the image and in the Codex smoke. An image pin is verified by a human — the
  CI never builds it — so the ticket carries a checkpoint.
- **D2 — Codex agents carry EFFORT, not a model.** The generator stops writing
  `model =` from the catalog. `model_reasoning_effort` stays, because effort is
  what differentiates the roles on a capped runtime. A `model =` line is
  written only when the user's GSD remap names one for that tier — resolved
  through GSD's resolver, not by reading `runtimeTierDefaults` directly. No
  model id is hardcoded anywhere in shipyard: Astra reaches the agents through
  the user's own `config.toml` the moment nothing overrides it.
- **D3 — `fable` stays the default for judgment on Claude; the prose says so and
  names the consent hazard.** Aliases remain the ONLY thing shipyard emits,
  and for the Agent tool that is enforced by the tool itself (enum-validated),
  not only by our policy. `opus[1m]` is therefore unreachable from a dispatch:
  an agent can have a 1M window only as `fable` (native) or `sonnet` (Sonnet 5,
  native) — the fact that re-opens the judgment tier.
- **D4 — Prose names the tools as they are.** Every sentence claiming the Agent
  tool rejects full ids is KEPT and gains the frontmatter distinction plus the
  version floors; "Fable 5" → "Fable 5.1"; one line
  disambiguates GSD's `gate-status:` commit trailer from the conveyor's
  `gate_status:` PR trailer; `opus` = Opus 5 with the version floor stated.
- **Not decided here.** `best` (Claude Code's "latest Fable where available,
  else opus") is documented for `/model`, not for the Agent tool's `model`
  field, and GSD's alias set lacks it — it is not adopted until both accept it.
  Whether Astra should be Codex's top tier is GSD's catalog decision, not ours.

## Consequences

Three tickets, one phase. The pins ticket is free of every file phase 24 owns
and can run at once; the two prose/generator tickets touch `deliver.md`,
`pipeline-config.cjs` and `README.md`, so they depend on phase 24's epic
landing on `main` (cross-phase parents wait for a MERGE, by design).
Operational, not tickets: after the release, the installers refresh both
gsd-core installs to 1.13.0 and regenerate the Codex agents; Codex CLI 0.147.0
on this host predates first-class Astra config (0.153.1) — the user's call.

## D1's verification, settled 2026-09-08 — and what the release must therefore say

D1 says an image pin "is verified by a human — the CI never builds it — so the
ticket carries a checkpoint". That checkpoint came due, and here is how it was
answered.

**Verified, on the epic head `d6890db`:** `make test-codex-shipyard` exits 0
(`codex-shipyard smoke: OK`), exercising the 233 lines T-25-02 changed in
`scripts/gen-codex-shipyard.cjs`. It was run against the EPIC and not `main`,
because `main` does not contain the generator's changes and a green there would
have proved nothing. The smoke is fully isolated — `mktemp -d`,
`export HOME="$WORK"`, `CODEX_HOME` inside it, `trap 'rm -rf' EXIT` — so it
touches no real Codex install; that was checked before running it, not after.

**NOT verified, by the operator's decision:** `make test-base`,
`test-overlay`, `test-runtime`, `test-mcp-runtime`. The operator declined the
build on 2026-09-08 ("не збирай"), and the reason it cannot be shortcut is that
`tests/smoke/base-image-smoke.sh:12` **runs `make build-base` itself** — it is a
build, not an assertion. The images on this host are four weeks old, which
predates T-25-01's pins entirely, so running the smoke against them would have
produced a green that describes the previous pin. That is the exact shape of
false assurance this phase spent its reviews finding, and taking it would have
been worse than the honest gap.

**So the pins ship verified by READING.** `Dockerfile.base` carries
`ARG CLAUDE_CODE_VERSION=2.1.263` (above the 2.1.255 floor Fable 5.1 needs and
the 2.1.219 floor Opus 5 needs), and all five build homes of
`GSD_CORE_VERSION` agree at 1.13.0 with a `docs-smoke.sh` assertion now holding
them together (T-25-06). What no one has observed is the image those numbers
produce.

**The release notes must say this in their own words**, not leave it to be
inferred: the container's toolchain pins are updated and unbuilt. A reader who
assumes a tagged release was built is the person this sentence exists for. And
whoever next builds the image should treat the first `make build-base` +
`build-dev-image` as the deferred half of T-25-01's checkpoint — if it fails,
the failure belongs to this phase and not to whatever change happens to be in
flight then.
