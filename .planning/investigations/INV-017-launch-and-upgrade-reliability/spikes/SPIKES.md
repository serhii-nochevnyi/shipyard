# Spikes S-1 and S2 (2026-10-15)

Run against the source at `be7ab4f3` (v0.72.2) from `plugins/delivery-pipeline/scripts`, read-only. Disposable fixtures only: `os.homedir` and `HOME` overridden to a scratch directory, scratch git projects, `SHIPYARD_GRAPH_DIR` unset; the scratch root is removed at the end. No repository, user-state or authority file was touched. Reproduce: `node spikes/s1-spike.cjs <abs path to plugins/delivery-pipeline/scripts>` and the same for `s2-spike.cjs`.

## S-1: legacy sidecar refusal and related launch states (`dispatch-record.recordInflight`, the entry all three hosts call)

| Fixture | Result |
|---|---|
| Clean project, `worktree` = project root | accepted; authority directory and key created |
| Same project, second dispatch | accepted |
| 3 pre-existing sidecars, no catalogue, `worktree` = project root (codex input shape) | **refused** `ARCHIVE_AUTHORITY_INVALID: unknown host provenance member before trusted mutation`; legacy bytes unchanged; **a new authority directory was created by the refused launch** |
| Same, claude input shape (`host: 'claude'`) | **refused**, identical |
| 3 sidecars, no catalogue, `worktree` = linked worktree (not "required") | accepted, **writes a fourth sidecar that is unpinned** |
| Then the project-root host launches | **refused** (the unpinned sidecar is an unknown member) |
| Clean project, record never cleared (failed-launch shape), then next launch | both accepted; the orphan sidecar is pinned and does not block later launches, it only accumulates |

Findings:
1. The refusal reproduces on v0.72.2 for the call shape that `codex-delivery-host`, `claude-role-host` (`prepared.canonical.worktree`, `claude-role-host.cjs:1460`) and `claude-delivery-host` (`:1139`) all pass: `worktree` = project root. By reading the three call sites, Claude hosts hit the same code; the spike exercised the shared `recordInflight`, not the Claude host CLIs end to end.
2. A refused launch still creates the authority directory (once per attempt), as code reading predicted.
3. Order dependency is real: a linked-worktree executor writes an unpinned sidecar on a project with legacy history, and the next project-root host (integrator, arch-review) refuses. MS1 must cover this case.
4. Orphan sidecars from failed launches are harmless to later launches (R-15 downgraded to accumulation only).
Not run: upgrade → downgrade → upgrade (S-2), pid reuse on the catalogue lock (S-3), partial catalogue shapes, symlinked members.

## S2: repository character class across subject grammars

Build or match with a repository string; `accept` / `refuse`:

| Repository | S2 seal (sealer) | S1 planning run subject | S3 integrator (run-contract) | S3 integrator (dispatch-record regex, copied) | S4 arch-review |
|---|---|---|---|---|---|
| `/Volumes/KINGSTON/claude-shipyard/.git` | accept | accept | accept | accept | accept |
| `/Volumes/My Disk/claude-shipyard/.git` (space) | accept | **refuse** | **refuse** | accept | **refuse** |
| `/Users/сергій/репо/.git` (Cyrillic) | accept | accept | accept | accept | accept |
| tab in path | accept | refuse | refuse | refuse | refuse |
| `;` in path | refuse | refuse | refuse | refuse | refuse |
| `serhii-nochevnyi/shipyard` (owner/repo) | accept | accept | accept | refuse (needs leading `/`) | accept |

Findings:
1. The grammars already disagree on whitespace: the seal pattern allows it (`[^;]+`), the run-contract and arch-review patterns reject it (`[^;\s]+`), the dispatch-record integrator regex allows it (`[^;\x00-\x1f]+`). The decided canonical identity, the realpath of `git --git-common-dir`, contains whitespace on any checkout under such a path; there the Claude integrator and arch-review subjects would refuse. This is a latent defect independent of this INV and a hard requirement on `repositoryIdentity()`: one character class and one parse used by all families.
2. The dispatch-record integrator regex requires a leading `/`, so the `owner/repo` form is not valid there; this is the divergence between the two identity forms.
3. The S3 dispatch-record column re-applies the regex copied from `dispatch-record.cjs:1511`, not the function.
