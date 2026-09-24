# Research

Four research lines ran through `claude-investigation-host.cjs` at `133447a7`
(epic 39 tip + INV-open commit) as `claude-opus-5-5/medium`; all four sealed with
verified receipts (first fan-out to seal end to end after T-39-12). Full findings:
`research/system-state.md`, `research/alternatives.md`, `research/constraints.md`,
`research/risks.md`. `P = plugins/delivery-pipeline`.

## Current system state

- (4) `P/scripts/claude-role-host.cjs:363` and `:826` refuse `isDraft === true`
  for arch-review ("live PR identity differs…", no remedy); executors open drafts
  (`P/commands/deliver.md:1983`) and undraft only after conform (`:2320-2335`).
  No test covers a draft PR.
- (5) `claude-role-host.cjs:123-124` refuses any porcelain output including
  untracked files. Five places treat the same scratch set four ways
  (`codex-delivery-host.cjs:20`, `delivery-commit-finalizer.cjs:8`,
  `claude-delivery-host.cjs:606-610`, `base-merge.cjs:140-167`,
  `ticket-worktree.sh:394-410`); `.gitignore` covers none; the role host's own
  evidence file and `.shipyard-role-artifacts/` archive make a second review in the
  same worktree refuse. `WORKTREE_MUTATED` (`:796-813`) leaves the mutation in place.
- (6) `revalidateLiveInputs` rejects `STALE_CONTEXT` when a non-member ticket opens a
  PR (`:841-848`, `:885-891`) while changed members only expire (`:853-892`).
- (7) `P/scripts/gate-trailer.cjs` `runCarry` requires head tree and merge-base tree
  unchanged (`:450-454`, `:519-524`); a sibling squash always changes both.
- (8) `P/scripts/role-artifact.cjs` binds executor manifests to the live base tip
  (`:568-603`); a `historical` mode exists for repair/drift only (`:2241`, `:2286-2310`).
- (12) `P/scripts/gsd-sync.cjs:603-613` blocks every PLAN without a delivery-state row.
- (new) `DIFF_MAX_BYTES` 1 MiB (`claude-role-host.cjs:21`, `:341-345`); layered bounds
  `PROMPT_MAX_BYTES` 1.5 MB, `PACKET_MAX_TOKENS` 360k, ADR-014 window promotion at
  250k tokens. Epic 39 diff at `--unified=50`: 1,935,272 B total, 1,465,974 B
  `.planning`, 469,298 B code (≈117k tokens).
- Worktree conditions matrix (`research/system-state.md` §3): only the role host
  checks cleanliness; no host checks plan readability under `--restricted`
  (`claude-runtime-host.cjs:684,694`, no `--add-dir`), signing, or leftovers;
  `.shipyard-role-artifacts/` is tracked in this repo (3 files from phase 38) and
  untracked scratch elsewhere. Role-host tests fail 13/13 under global GPG signing.
- No phase 40 code exists; ADR-017 seams (T-40-15 dispatch, T-40-16 sentinel
  preflight) are planned only. `main` is at 0.62.0 and is not an ancestor of epic 39.

## Constraints

### Technical

- No weakening of head, base or round binding; any carry must be a new mechanical
  proof (`research/constraints.md` C-T6..C-T9).
- One scratch policy consumed by every host; the post-run check snapshots scratch
  digests (C-T3, C-T4).
- Integrator fix must satisfy diff, prompt and token bounds and not move ADR-014
  window promotion (C-T1); works with tracked and untracked `.planning` (C-P4).
- `gsd-sync` stays offline and fail-closed (C-T11).
- Every refusal names a copyable remedy; one focused test per rule (C-P3, C-P6).

### Product

- Draft stays the "not certified" signal (C-P2).
- ADR-017 decisions, the ADR-014 grid and fail-closed receipts are not re-decided.

### Delivery

- Files shared with phase 40: `claude-role-host.cjs` (T-40-16, T-40-22),
  `role-artifact.cjs` (T-40-18), `gate-trailer.cjs`/`sentinel.cjs` (T-40-19),
  `deliver.md` (T-40-24), `state-sync.cjs` (T-40-02/03/19/27).
- ADR-017: phase 40 tickets wait for epic 39 on `main`; epic 39 cannot reach `main`
  without an integrator verdict (release circularity, RISKS R1).
- T-40-22's provenance sidecar would re-create defect (5) inside the role host (R4).

## Unknowns

- Whether `--restricted` denies reads outside cwd (mirrored).
- Whether a diff-identity carry proof is sound under rename detection (mirrored).
