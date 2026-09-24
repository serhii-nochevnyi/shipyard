# Decisions

<!-- Every accepted position is recorded IMMEDIATELY at the moment of the decision, not at the end. -->
<!-- Record format: -->
<!-- ## <decision, as an affirmative statement> -->
<!-- **Why:** ... -->
<!-- **What was rejected:** ... -->
<!-- **Scope fence:** what this decision explicitly does NOT cover -->
<!-- These sections become the locked decisions in the ADR when Gate 1 is closed. -->

## Fix the friction with a hybrid by failure class
**Why:** Prose is what failed in session 3f4c2390; deterministic scripts with focused tests go where the model could not or did not comply (items 1, 2, 3, 4, 5 validator, 6 plan, 11), and prose/templates pinned by docs tests go where a pointer suffices (items 7 prose, 8, 9, 10). Decided by the user 2026-09-24.
**What was rejected:** Prose-first (repeats the failed approach); scripts-first for every item (largest surface for items that need only a pointer).
**Scope fence:** Does not change the ADR-014 grid, the dispatch boundary, refusal codes, or fail-closed receipt verification.

## Decompose bootstraps a minimal GSD project from the accepted ADR when one is missing
**Why:** Investigate must not stop without `.planning/` (it only needs `.planning/investigations/`), and decompose is the first consumer of `config.json`, `ROADMAP.md` and `REQUIREMENTS.md`; bootstrapping there keeps investigate free of GSD-owned files. Decided by the user 2026-09-24.
**What was rejected:** Bootstrapping at Gate 1 of investigate (makes investigate write GSD files); keeping the `/gsd-new-project` detour (produced invented requirements).
**Scope fence:** Creates only missing files, never rewrites existing ones; one phase per ADR; every requirement id maps 1:1 to an ADR `## Decision` bullet parsed by `adr-ingest.cjs`; refuses in plain language when the ADR has no decisions; adds no launch outside the decompose hosts.

## The stop gate enforces only in a session that deliver armed
**Why:** Sessions that never ran deliver (analysis, investigate) were blocked by a foreign worktree's front; a positive marker written by deliver keeps the cross-worktree discovery that fixed the measured 5h46m inert-gate loss while making the gate inert elsewhere. Decided by the user 2026-09-24.
**What was rejected:** Recording the owner inside the front (changes the front format); transcript scanning (slow and brittle inside the hook budget); narrowing to cwd (re-opens the inert-gate case).
**Scope fence:** The marker is per `session_id` and gitignored; a missing, unreadable or foreign marker means allow; existing stop-gate tests stay green; `--fork-session` yields a new id, so a forked session must re-arm.

## Jira export is a deterministic plan the agent executes through MCP
**Why:** A pure-data plan built from `tickets.json` fixes issue content, repo-namespaced labels and `is blocked by` link direction, so the model makes no judgement and link direction cannot be wrong; the agent keeps the acting half and no credential enters the conveyor, so accepted ADR-008 D4 stands. Decided by the user 2026-09-24.
**What was rejected:** A direct REST client with a token (supersedes ADR-008 D4, adds a secret); keeping model-by-hand export with a post-hoc verifier.
**Scope fence:** No network code in scripts; export never blocks decomposition; this initiative's own tickets are not exported.

## Order-only relations are not depends_on; the validator hints at suspected ones
**Why:** `depends_on` drives wave, `pr_base` and cascade, so ordering-only links serialized the MYD-17627 graph into 11 waves; aligning the prose to `validate-graph.cjs:545-549` and warning when a dependency shares no `files_modified` with its parent keeps the graph schema unchanged. Decided by the user 2026-09-24.
**What was rejected:** A new optional order-only graph field (schema change across state-sync, front, sentinel and deliver).
**Scope fence:** The hint is a warning, never a Gate 2 error; the contested-path rule and diamond warning are unchanged; real multi-parent code dependencies still linearize while the diamond-child backlog item is open.

## The UI gate is skipped only when the ADR declares no UI design source
**Why:** GSD supports `/gsd-plan-phase <N> --skip-ui`; an explicit ADR marker keeps the choice with the human and recorded, and removes an interactive detour for prototype scopes. Decided by the user 2026-09-24.
**What was rejected:** Asking once per phase (an interruption the ADR can answer); project-wide `workflow.ui_phase: false` (silences real UI work).
**Scope fence:** Without the marker decompose invokes GSD exactly as today; shipyard does not change GSD's UI detection.

## Host refusals carry a plain-language hint that commands relay to the user
**Why:** The session lost ~17 minutes explaining `receipts` and `typed callback`; a deterministic code-to-hint map with a remedy lets the command explain the refusal in the user's language. Derived from the fix list the user endorsed 2026-09-24.
**What was rejected:** Prose-only relay (untestable); a new stdout error envelope (changes an output contract).
**Scope fence:** Codes, exit status and fail-closed behaviour are unchanged; the hint never suggests bypassing a host; Claude and Codex hosts share the map.

## The auto-route hook routes research to investigate and stays silent on notifications and slash prompts
**Why:** The hook injected ~15 identical blocks per session and never pointed at investigate although `route.md:63` does. Derived from the endorsed fix list 2026-09-24.
**What was rejected:** Text-only filtering by the model; removing the hook.
**Scope fence:** The hook still only points at `/shipyard:route`; it injects on unparseable input; the Codex AGENTS.md block gets the same route; `make doctor` compares the installed hook.

## Gate 1 validates the ADR with adr-ingest against a shipped ADR template
**Why:** The session reverse-engineered `adr-ingest.cjs` to learn the ADR headings, and a malformed ADR was discovered one loop late. Derived from the endorsed fix list 2026-09-24.
**What was rejected:** A separate stricter ADR validator (second parser).
**Scope fence:** `adr-ingest.cjs` gains a no-write `--check` mode; the template is validated by the same function in a test; existing accepted ADRs are not re-validated.

## Decompose warns once when .planning is not tracked by git
**Why:** Untracked `.planning/` is supported but changes how deliver's worktrees find plans; nobody told the user. Derived from the endorsed fix list 2026-09-24.
**What was rejected:** Refusing untracked planning (breaks the proving ground); doing nothing.
**Scope fence:** Warning only, with the exact consequence and remedy; never blocks.

## gsd-tune names the missing file and the command that creates it
**Why:** "the conveyor's own project root" gave no next step on the exact preflight decompose runs first. Derived from the endorsed fix list 2026-09-24.
**What was rejected:** Walking up directories to find a config (can tune the wrong project).
**Scope fence:** Exit code 2 and the `gsd-tune:` prefix are unchanged; only the message text changes.

## Research handbacks respect their bound before the consumer judges them
**Why:** In this investigation all four verified research lines were discarded because one summary exceeded 500 characters that the worker never saw, and the refusal blamed the host installation. Found 2026-09-24; the user chose to include it.
**What was rejected:** Relaxing the 500-character bound or skipping the seal.
**Scope fence:** The bound is passed to the worker and enforced deterministically (declared output schema or host-side bounding with a plain-language refusal naming the line and length); the sealed envelope and receipt checks are unchanged.
