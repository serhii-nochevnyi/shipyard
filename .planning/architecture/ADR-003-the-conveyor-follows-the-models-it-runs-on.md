# ADR-003 — The conveyor follows the models it runs on

- **Status**: accepted
- **Date**: 2026-09-07
- **Supersedes**: nothing. Refines the two-layer model rule in `CLAUDE.md`
  (shipyard owns the TIER, GSD owns tier → model).

## Context

Three things moved under the conveyor within a fortnight, and the repository
records none of them:

- **Claude Code.** Since v2.1.219 the `opus` alias resolves to Opus 5, since
  v2.1.255 `fable` resolves to Fable 5.1. The model-config page
  (code.claude.com/docs/en/model-config, read 2026-09-07) lists full model ids
  and `inherit` alongside the four aliases — and that list is about SUBAGENT
  FRONTMATTER, the `model:` field in a `.claude/agents/*.md` file, which does
  take them. It is NOT the Agent TOOL's `model` parameter, which is
  enum-validated against exactly the four aliases, so a full id or a suffixed
  alias like `opus[1m]` is rejected on input. Two surfaces, one word: a docs
  page listing full ids is not permission for a dispatch to emit one.
  *(Corrected 2026-09-08. This paragraph originally attributed that list to the
  Agent tool's own parameter — the same conflation D4 below exists to remove, so
  the two halves of this ADR contradicted each other from the day it was
  accepted, and the Context was the half a reader reaches first. The surfaces
  are NAMED rather than the sentence deleted, because "but the docs page lists
  them" is the objection the next reader raises and the answer is that the page
  describes the other surface. The wrong sentence is deliberately not quoted
  back: a record that repeats a false claim verbatim is a record no `grep` can
  clear.)* The container pins Claude Code **2.1.200** — inside the image `opus`
  is still Opus 4.8 and `fable` is Fable 5. `CLAUDE.md`, `deliver.md`,
  `investigate.md`, `README.md` and `docs/` all state that the Agent tool
  REJECTS full ids; that is TRUE and stays. What they lack is the distinction
  from subagent frontmatter, and the version floors. Fable bills usage credits
  on some plans and asks for consent once; in a background or Remote Control
  session that prompt waits `dialogExpiry` (5 min) and then ENDS THE TURN
  without sending — an autonomy break for any org that has not consented yet.
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
- **D2 — Codex agents carry EFFORT, not a model.** ~~The generator stops
  writing `model =` from the catalog.~~ ~~No model id is hardcoded anywhere in
  shipyard: Astra reaches the agents through the user's own `config.toml` the
  moment nothing overrides it.~~ — **both clauses SUPERSEDED by ADR-005 D6/D7/D8
  (struck 2026-09-09). The generator writes `model =` on purpose now**: the
  Codex palette (`pipeline.codex_models`, declared in `capability.json`) is an
  ordered list of `{model, effort, min_cli}`, its first entry is the workhorse
  floor every role gets and its last is the ceiling the integrator takes
  unconditionally, and D8's `-deep` variants exist precisely because a static
  `.toml` cannot be re-parameterised per dispatch. So a model id IS written into
  eleven agent files, and the palette default is the one place an id may appear
  as a value — enforced by `tests/unit/gen-codex-shipyard.test.cjs` over
  `plugins/` and `scripts/`.

  What survives is the rest of the decision, intact: `model_reasoning_effort`
  stays and is still what differentiates the roles per file; and a user's GSD
  remap still OUTRANKS the palette, resolved through GSD's own resolver rather
  than by reading `runtimeTierDefaults` directly.

  *Struck rather than rewritten, in D3's format and for D3's reason: the
  sentence is why the decision existed, so a reader who remembers it must see
  that it moved. Flagged by the integrator of phase 27's epic — ADR-005's
  `Supersedes`, rewritten by T-27-08 in that same epic, already named this
  clause retired while the clause itself still stood, which is the exact defect
  one document over that D3's own note describes.*
- **D3 — ~~`fable` stays the default for judgment on Claude~~ — SUPERSEDED by
  ADR-005 D1/D4 (amended 2026-09-08). `fable` is the default for NOTHING; it is
  a ceiling earned through three mechanical routes, and the prose names the
  consent hazard.** What survives of this decision is the part about aliases,
  and it survives intact: aliases remain the ONLY thing shipyard emits, and for
  the Agent tool that is enforced by the tool itself (enum-validated), not only
  by our policy. `opus[1m]` is therefore unreachable from a dispatch: an agent
  can have a 1M window only as `fable` (native) or `sonnet` (Sonnet 5, native)
  — the fact that re-opened the judgment tier, and that ADR-005 then closed
  again on a measurement (the largest input in the system is the phase epic
  diff at ~52k tokens, and the integrator's own measured run was 291k against
  a 1M window at twice the price).

  *Struck through rather than rewritten, because the sentence is why this
  decision existed and a reader who remembers it needs to see that it moved.
  Flagged by the integrator of phase 25's epic as its follow-up E, after
  `b85d510` amended this ADR's Consequences without closing D3 — which is the
  same defect one document over: an amendment that lands beside a stale
  assertion and leaves it standing.*
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
