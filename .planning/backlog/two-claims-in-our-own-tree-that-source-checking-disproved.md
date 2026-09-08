# Two claims in our own tree that source-checking disproved

**Found:** 2026-09-08, by the `arch-review` role on PR #51 (T-25-02), which
checked both against installed sources instead of accepting them from its brief.
Both were repeated to it by the orchestrator, so this note records the SOURCE of
the error, not the reviewer's finding.

## 1. `pipeline-config.cjs` claims GSD clamps `max` to `xhigh` on Codex. It does not.

`resolveEffort` contains:

    // `max` is Anthropic-only; GSD clamps it to xhigh on Codex.
    if (level === 'max' && runtime === 'codex') return 'xhigh';

Verified against gsd-core 1.13.0's `model-catalog.cjs`: `codexModelEffort._baseline`
INCLUDES `max`, `advertisedCodexEffort` returns that baseline for any model it
does not name by hand, and the caller passes an advertised level through
unchanged. So GSD performs no such clamp.

The clamp's EFFECT is still aligned with the operator's decision of 2026-09-07
(`max` and `xhigh` are not worth their cost on Codex, and Astra's best results
are at `high`) — ADR-005 D6. What is false is the justification written beside
it, and a false justification is worse than none: it is the sentence a future
reader would cite to keep the line when the real reason had expired. T-25-02
removes the clamp for a stated reason of its own (ADR-005 D7), which settles
this file; the lesson to keep is that **a comment asserting a THIRD PARTY's
behaviour must name where it was checked and when.** This repository already
learned the same thing about `workflow.use_worktrees` and about `model_profile`'s
`golden`/`quality` vocabulary — both recorded in `CLAUDE.md`, both found the
same way.

## 2. ADR-003 D2 now contradicts correct code, and ADR-005 does not supersede it

ADR-003 D2 reads "No model id is hardcoded anywhere in shipyard: Astra reaches
the agents through the user's own `config.toml` the moment nothing overrides
it." T-25-02 legitimately introduces `DEFAULT_CODEX_MODELS` and a declared
default in `capability.json` — two model ids as VALUES, which is exactly what
ADR-005 D7 mandates (the palette must exist somewhere, and a user remap is
resolved through GSD's own resolver above it).

ADR-005's `Supersedes` line names D3 only, so D2 still reads as live policy
while the merged code contradicts it. Bookkeeping, but the kind that turns into
a wrong reviewer verdict later: a future `arch-review` reading ADR-003 D2
against `pipeline-config.cjs` would be correct to call it a violation.

The fix belongs in a ticket that owns `.planning/architecture/` — amend ADR-003
D2 to say "no model id is hardcoded in a DISPATCH path", and extend ADR-005's
`Supersedes` to name D2. Note that `CLAUDE.md` also states the rule as absolute
and its enforcing test's `COMMENT` regex exempts markdown headings, blockquotes
and `*` bullets, so the prose is slightly ahead of what the test checks; the
tree is clean today, so this is a contract to tighten rather than a defect to
chase.

## 3. ADR-003's own Context still holds the sentence its ticket was written to fix

Found by `arch-review` on PR #53 (T-25-03), 2026-09-08. ADR-003's Context reads
"the Agent tool's `model` field now accepts full model ids and `inherit` as well
as the four aliases". That is false — the tool's schema is
`model: enum ["sonnet","opus","haiku","fable"]`, verified first-hand against the
live schema twice in this session; full ids and `inherit` belong to the SUBAGENT
DEFINITION surface, which is a different thing entirely.

T-25-03 corrected the sentence everywhere it ships (`CLAUDE.md`, `README.md`,
`docs/`, both `commands/`), and it could not touch the ADR because
`.planning/architecture/` is not in its `files_modified`. So the governing
record still carries the claim the code contradicts — the same shape as item 2
above, one document over.

Both belong in one small ticket that owns `.planning/architecture/`: amend
ADR-003's Context (the tool is enum-validated; the definition file is the other
surface), amend ADR-003 D2 (no model id in a DISPATCH path), and extend
ADR-005's `Supersedes` to name D2 as well as D3.
