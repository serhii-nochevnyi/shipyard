# Phase 46 isolated installation proof and remaining HOLD

Date: 2026-10-02. Scope: T-46-08 / P46-D, P46-E. This proof path was absent on parent `66519ad3f633bcdb1123213310983c34b7a56e0a`; it was created by the prior core execution and is updated in this continuation.

The original authenticated integration at `1ead39a290966aacc3cb37a0feb2acb851b58300` found F1: GSD wrote `runtime: codex` to shared defaults and Shipyard removed that key. The historical before-image is unavailable. No restoration is claimed. The operator explicitly accepted the current shared-defaults bytes as the baseline; this supersedes a demand to reconstruct unknown historical bytes, without erasing the violation.

Three actual controlled installation stages exited 0 and preserved that approved baseline's recorded bytes, mode, uid, gid and mtime. Their complete argv, cwd, actual environment overrides, exits and log hashes appear below. This was an external OS HOME workaround against the earlier source, with sibling OS homes and npm cache in the retained rollout-artifact directory. It does not prove that the published installers were isolated, and it did not execute this new source guard. The corrected guard would reject that external npm cache unless its destination was changed to lie within the candidate envelope.

The corrected-source regression uses temporary fixture homes and a deliberately aggressive fake npx that writes through `os.homedir()`. The source generator, installer, tuner and generated package bootstrap are real. Fixture capabilities, converter, marketplace CLI responses and application records are fixture evidence only. A negative control demonstrates outside-write detection; native-home divergence refuses before installation or state creation. Actual controlled current-safe-link installation is still required later by the coordinator. No real installer, authentication command or native model call was run by T-46-08.

Fresh redacted status records establish both OS profiles authenticated. Claude dedicated candidate OS HOME authentication exited 0 / loggedIn true at `2026-10-02T09:47:30.624434+00:00`, using a dedicated isolated macOS Keychain; active default/search Keychain metadata and shared defaults remain unchanged. The earlier normal-home observation remains historical. Authentication proves no model entitlement or native model/effort application. This continuation read only redacted status JSON, never credential/password/Keychain files or archives.

Chronology: the original violation at integration head `1ead39a290966aacc3cb37a0feb2acb851b58300` precedes the external workaround recorded below. Prior core work is retained at `6d1bfbc4`; the later controlled-source attempt records raw source head `3eea0e4d58e327970c5a70aa3e498317a79d88ae`, distinct from this continuation's starting head `b7b565d68d7f64bf9ace72d776b41a24280f3f62`. That attempt's Codex installation exited 0, Claude dependency exited 0, and Claude hook exited 3 on its dependency-created contained npm `node_modules/.bin/anthropic-ai-sdk` link. All three recorded shared defaults unchanged. Core VERSION was 1.14.0 as requested, but the actually discovered enabled Claude marketplace dependency was **1.15.0**; the marketplace pin 1.14.0 was not honored. This failed two-stage attempt is historical and does not prove installation of the current safe-link correction.

The read-only guard now accepts only npm `.bin` executable links whose fully resolved regular, single-link file targets remain physically in the same candidate npm subtree. Outside, dangling, cyclic, directory, active-state, hardlink and other symlink hazards still refuse before any write. The later npm-cache-only source failed the hook as recorded below; corrected plugin-cache installation remains pending with the coordinator. Durable retention must contain redacted-only status filenames `codex-authenticated-status.json`, `claude-authenticated-normal-home-status.json`, and `claude-authenticated-dedicated-home-status.json`, plus attempts/log hashes; no credential or Keychain material belongs in published or durable proof. No new durable sealing is claimed here.

PR408 was APPROVED by `copilot-pull-request-reviewer[bot]` at exact head `992fd1fca755ce812ef04d3714f12e108378c090`, with both retained checks completed/success at that head. This is historical merged PR408 evidence, not a current T-46-08 approval, current CI pass, human review or rollout decision.

**HOLD:** all eight actual native pairs, rollback rehearsal, final release live-round, operator rollout checkpoint and activation. T-46-06 retains native evidence and operator authority; ADR-023 D6 remains with its existing owner. Retained prior identity observations do not constitute an executed rollback rehearsal. No synthetic native receipts, full-suite result or quota saving is asserted.

| Native pair | Actual application |
|---|---|
| gpt-6.1-sol / low | HOLD — exact same-session application receipt absent |
| gpt-6.1-sol / high | HOLD — exact same-session application receipt absent |
| gpt-6.1-sol / xhigh | HOLD — exact same-session application receipt absent |
| claude-sonnet-5-5 / low | HOLD — genuine bounded sentinel duty and receipt absent |
| claude-sonnet-5-5 / medium | HOLD — exact same-session application receipt absent |
| claude-sonnet-5-5 / high | HOLD — genuine fixer duty/predecessor and receipt absent |
| claude-sonnet-5-5 / xhigh | HOLD — genuine authorized role receipt absent |
| claude-opus-5-5 / high | HOLD — genuine escalation duty/chain and receipt absent |

Prior core execution's retained byte verification used read-only Python `hashlib.sha256(Path(path).read_bytes())`, JSON parsing and `tarfile.open(archive, 'r:').extractfile(member).read()` in the T-46-08 worktree; exit 0. Every referenced approved archive member and post-baseline durable file matched its manifest's byte count and SHA-256. Nothing was extracted to disk; the retained installer harness was hashed only, never executed. Absolute references and bounded source records follow so CI and future review do not require private paths.

```json
{
  "operator_baseline_acceptance": {
    "schema": "shipyard.operator-baseline-acceptance.v1",
    "decision": "accept-current-shared-defaults-as-baseline-and-test-fresh-isolated-installation",
    "operator_statement": "Зафіксувати поточний стан як базовий і перевірити нову ізольовану інсталяцію",
    "historical_restoration_claim": false,
    "baseline_file": "baseline.json",
    "attempts_file": "attempts.json"
  },
  "baseline": {
    "source": "/Users/serhii/.gsd/defaults.json",
    "baseline_disposition": "operator-approved current state; no historical restoration claim",
    "sha256": "2edab0e2e95e8d265da9c66fcf4de6d5193b3511b629d4d07920dda4ac4ee4b0",
    "bytes": 1005,
    "mode": 420,
    "uid": 502,
    "gid": 20,
    "mtime_ns": 1790884560384023081
  },
  "attempts": [
    {
      "stage": "codex-install",
      "argv": [
        "bash",
        "scripts/install-shipyard-codex.sh",
        "--dogfood-root",
        "/Volumes/KINGSTON/.wt-claude-shipyard/phase46-isolated-recheck-20261002/codex-candidate",
        "--project-dir",
        "/Volumes/KINGSTON/.wt-claude-shipyard/phase46-isolated-recheck-source-20261002"
      ],
      "cwd": "/Volumes/KINGSTON/.wt-claude-shipyard/phase46-isolated-recheck-source-20261002",
      "environment_overrides": {
        "GSD_CORE_VERSION": "1.14.0",
        "NPM_CONFIG_CACHE": "/Volumes/KINGSTON/.wt-claude-shipyard/phase46-rollout-artifacts-20261001/npm-cache",
        "HOME": "/Volumes/KINGSTON/.wt-claude-shipyard/phase46-isolated-recheck-20261002/codex-os-home",
        "SHIPYARD_CODEX_CAPABILITIES_FILE": "/Users/serhii/.codex/shipyard/codex-capabilities.json"
      },
      "exit": 0,
      "log": "/Volumes/KINGSTON/.wt-claude-shipyard/phase46-isolated-recheck-20261002/codex-install.log",
      "log_bytes": 7911,
      "log_sha256": "9a9b17de260b931cdc852f65bb46196d17f9e4298ec6876b80aa911ba2a73c21",
      "shared_defaults_after": {
        "sha256": "2edab0e2e95e8d265da9c66fcf4de6d5193b3511b629d4d07920dda4ac4ee4b0",
        "bytes": 1005,
        "mode": 420,
        "uid": 502,
        "gid": 20,
        "mtime_ns": 1790884560384023081
      }
    },
    {
      "stage": "claude-dependency",
      "argv": [
        "bash",
        "scripts/ensure-gsd-core.sh",
        "claude"
      ],
      "cwd": "/Volumes/KINGSTON/.wt-claude-shipyard/phase46-isolated-recheck-source-20261002",
      "environment_overrides": {
        "GSD_CORE_VERSION": "1.14.0",
        "NPM_CONFIG_CACHE": "/Volumes/KINGSTON/.wt-claude-shipyard/phase46-rollout-artifacts-20261001/npm-cache",
        "HOME": "/Volumes/KINGSTON/.wt-claude-shipyard/phase46-isolated-recheck-20261002/claude-os-home",
        "CLAUDE_CONFIG_DIR": "/Volumes/KINGSTON/.wt-claude-shipyard/phase46-isolated-recheck-20261002/claude-candidate/config",
        "CLAUDE_HOME": "/Volumes/KINGSTON/.wt-claude-shipyard/phase46-isolated-recheck-20261002/claude-candidate/config"
      },
      "exit": 0,
      "log": "/Volumes/KINGSTON/.wt-claude-shipyard/phase46-isolated-recheck-20261002/claude-dependency.log",
      "log_bytes": 3941,
      "log_sha256": "9ef2d9fb665bc4b94148d3e78f9be9d6a13d4ff3f7065909800891f2cd22e726",
      "shared_defaults_after": {
        "sha256": "2edab0e2e95e8d265da9c66fcf4de6d5193b3511b629d4d07920dda4ac4ee4b0",
        "bytes": 1005,
        "mode": 420,
        "uid": 502,
        "gid": 20,
        "mtime_ns": 1790884560384023081
      }
    },
    {
      "stage": "claude-install",
      "argv": [
        "bash",
        "scripts/install-shipyard-claude-hook.sh",
        "--dogfood-root",
        "/Volumes/KINGSTON/.wt-claude-shipyard/phase46-isolated-recheck-20261002/claude-candidate/plugin-0.70.0"
      ],
      "cwd": "/Volumes/KINGSTON/.wt-claude-shipyard/phase46-isolated-recheck-source-20261002",
      "environment_overrides": {
        "GSD_CORE_VERSION": "1.14.0",
        "NPM_CONFIG_CACHE": "/Volumes/KINGSTON/.wt-claude-shipyard/phase46-rollout-artifacts-20261001/npm-cache",
        "HOME": "/Volumes/KINGSTON/.wt-claude-shipyard/phase46-isolated-recheck-20261002/claude-os-home",
        "CLAUDE_CONFIG_DIR": "/Volumes/KINGSTON/.wt-claude-shipyard/phase46-isolated-recheck-20261002/claude-candidate/config",
        "CLAUDE_HOME": "/Volumes/KINGSTON/.wt-claude-shipyard/phase46-isolated-recheck-20261002/claude-candidate/config",
        "SHIPYARD_GSD_AUTO_INSTALL": "0"
      },
      "exit": 0,
      "log": "/Volumes/KINGSTON/.wt-claude-shipyard/phase46-isolated-recheck-20261002/claude-install.log",
      "log_bytes": 353,
      "log_sha256": "bbf169da755b2576584e130fb941c2f10aa09ffbeb1a5ed6d9c247e086b4b6a7",
      "shared_defaults_after": {
        "sha256": "2edab0e2e95e8d265da9c66fcf4de6d5193b3511b629d4d07920dda4ac4ee4b0",
        "bytes": 1005,
        "mode": 420,
        "uid": 502,
        "gid": 20,
        "mtime_ns": 1790884560384023081
      }
    }
  ],
  "codex_manifest_identity": {
    "shipyard_version": "0.70.0",
    "policy_version": "adr-014.v7",
    "policy_hash": "3978b08721ef8f2381aa1f31355c9fef1dafd4058a2093b4a5f06ee90cd44570",
    "gsd_lib": "/Volumes/KINGSTON/.wt-claude-shipyard/phase46-isolated-recheck-20261002/codex-candidate/gsd-core/bin/lib/runtime-artifact-conversion.cjs",
    "gsd_lib_digest": "80024b9440212fd061de02f41d82f2b1132d4f733b6adbc41db3e42bc4417a8b",
    "capabilities_file": "codex-capabilities.json",
    "capabilities_digest": "a92ffce4b6ae1b6f1fd31f3e422387e50c5d88815bed3c3d1133757737551550",
    "codexHome": "/Volumes/KINGSTON/.wt-claude-shipyard/phase46-isolated-recheck-20261002/codex-candidate",
    "skills": [
      "shipyard-route",
      "shipyard-investigate",
      "shipyard-decompose",
      "shipyard-deliver",
      "shipyard-bench",
      "shipyard-delivery-rules"
    ],
    "agent_digests": {
      "shipyard-inv-research.toml": "46dd0705615a108372d9775e9651862ec387184c3a6d919993c34180234e5469",
      "shipyard-inv-research-critical.toml": "82bd478be22658d4fbbaeefd8b3e85f71147a98282558102e1c4b04476de7fc3",
      "shipyard-pr-sentinel.toml": "400496ce1e014914ea0fa750c1278282c6894515274a9f473faa613fefaf9818",
      "shipyard-integrator.toml": "b48c76102d514062186a214e488176e59ad191a8db62ce32e19779ef637e5347",
      "shipyard-integrator-critical.toml": "9416b11249298b1227870be67cb901a9dd2f5fbb01e0780655ad176dd09c89b8",
      "shipyard-drift-check.toml": "005a0286ec3312508f53e98508733a167afd55b4a5d5079cae395895d7245c97",
      "shipyard-arch-review.toml": "0175d1412d7f97f0545301190cef145ccc9fcc438ea17390034e443a713a0e38",
      "shipyard-arch-review-critical.toml": "6ad906893e7d2658eec886a3a42322f1849f9d4688c51375d9fd8487930e753c",
      "shipyard-ci-fix.toml": "bfaca49e89772cffb6ea960f4ed2881362c8b466eda1381d0b5a1aa7dad555ff",
      "shipyard-ci-fix-repeat.toml": "3783c92daaeb23586876229d3ed678c7d419335f04266b7c8128148118b115f4",
      "shipyard-ci-fix-deep.toml": "756f22e395c77da856ee635ad5113cc3d751aba8d0eae11069de3831a6d5f157",
      "shipyard-review-fix.toml": "ef28d838d3ec73ef49645faf6c1cefc949159378de4877f7721af45fb91f2e06",
      "shipyard-review-fix-repeat.toml": "2bfdc07ee745d6d34c10b368ee1accc7f4a4938f1338cbe2d0fbf489aa911213",
      "shipyard-review-fix-deep.toml": "6441f07f8af97f3fccd1c96665f200fc6eabe03f21fb6c2795821c35d006e4a7"
    }
  },
  "codex_provenance": {
    "schema": "shipyard.host-provenance.v1",
    "install_kind": "dogfood",
    "version": "0.70.0",
    "source_sha": "1ead39a290966aacc3cb37a0feb2acb851b58300",
    "dirty": false,
    "source_root": "/Volumes/KINGSTON/.wt-claude-shipyard/phase46-isolated-recheck-source-20261002"
  },
  "claude_provenance": {
    "schema": "shipyard.host-provenance.v1",
    "install_kind": "dogfood",
    "version": "0.70.0",
    "source_sha": "1ead39a290966aacc3cb37a0feb2acb851b58300",
    "dirty": false,
    "source_root": "/Volumes/KINGSTON/.wt-claude-shipyard/phase46-isolated-recheck-source-20261002"
  },
  "claude_plugin": {
    "name": "shipyard",
    "description": "Artifact-driven delivery pipeline on top of GSD: deep investigation, ticket decomposition with a dependency graph, and per-ticket worktree->PR delivery babysat to green (CI + CodeRabbit/Copilot re-review). See docs/gsd_multilevel_delivery_pipeline.md.",
    "version": "0.70.0",
    "dependencies": [
      "gsd-core@gsd-core"
    ],
    "author": {
      "name": "Nochevnyi Serhii"
    },
    "keywords": [
      "delivery",
      "gsd",
      "investigation",
      "tickets",
      "worktree",
      "pr"
    ],
    "commands": [
      "./commands/route.md",
      "./commands/investigate.md",
      "./commands/decompose.md",
      "./commands/deliver.md",
      "./commands/bench.md"
    ],
    "skills": [
      "./skills/delivery-rules"
    ]
  },
  "pr408_review": [
    {
      "commit_id": "992fd1fca755ce812ef04d3714f12e108378c090",
      "state": "APPROVED",
      "submitted_at": "2026-10-01T19:36:02Z",
      "user": "copilot-pull-request-reviewer[bot]"
    }
  ],
  "pr408_checks": [
    {
      "conclusion": "success",
      "head_sha": "992fd1fca755ce812ef04d3714f12e108378c090",
      "name": "copilot-pull-request-reviewer",
      "status": "completed"
    },
    {
      "conclusion": "success",
      "head_sha": "992fd1fca755ce812ef04d3714f12e108378c090",
      "name": "test-fast",
      "status": "completed"
    }
  ],
  "codex_authenticated_status": {
    "observed_at": "2026-10-02T09:17:22.364747+00:00",
    "runtime": "codex",
    "exit": 0,
    "logged_in": true,
    "credential_storage": "isolated profile file",
    "shared_defaults_unchanged": true
  },
  "claude_authenticated_normal_home_status": {
    "observed_at": "2026-10-02T09:17:36.496972+00:00",
    "runtime": "claude",
    "environment": "normal-home",
    "exit": 0,
    "loggedIn": true,
    "authMethod": "claude.ai",
    "apiProvider": "firstParty"
  },
  "durable_archive": {
    "archive": "/Users/serhii/.local/state/shipyard/evidence/phase46/66dd4bb8c6e9d32db180c797af242482ac338c0c8d44abeb8b3d831e5fb0b2aa.tar",
    "manifest": "/Users/serhii/.local/state/shipyard/evidence/phase46/b5d88a1cff138c2835629e53f240300b99897a3154427afda09879ee7455a36b.manifest.json",
    "sha256": "66dd4bb8c6e9d32db180c797af242482ac338c0c8d44abeb8b3d831e5fb0b2aa"
  },
  "post_baseline_observations": {
    "manifest": "/Users/serhii/.local/state/shipyard/evidence/phase46/7a43dd38cc1d47877f688359c08dcc42d57389b97e54f6bb3b8ff0602baf6c02.manifest.json",
    "sha256": "7a43dd38cc1d47877f688359c08dcc42d57389b97e54f6bb3b8ff0602baf6c02"
  },
  "retained_files": [
    {
      "path": "/Volumes/KINGSTON/.wt-claude-shipyard/phase46-isolated-recheck-20261002/operator-baseline-acceptance.json",
      "bytes": 440,
      "sha256": "ce258b2ae716cc5e9dfc4e9f45b436b0501be0719b6e8b9300a0e756707c8751"
    },
    {
      "path": "/Volumes/KINGSTON/.wt-claude-shipyard/phase46-isolated-recheck-20261002/baseline.json",
      "bytes": 300,
      "sha256": "6e48a9f5d47dfe44c900ce074bb6afd2be99fd3da29d0c62c0e4bbb852b44535"
    },
    {
      "path": "/Volumes/KINGSTON/.wt-claude-shipyard/phase46-isolated-recheck-20261002/attempts.json",
      "bytes": 3904,
      "sha256": "dd98c0936bc77cd7f21b349fea602057cf946f10dc12bf09bb5db2516e4c8470"
    },
    {
      "path": "/Volumes/KINGSTON/.wt-claude-shipyard/phase46-isolated-recheck-20261002/codex-install.log",
      "bytes": 7911,
      "sha256": "9a9b17de260b931cdc852f65bb46196d17f9e4298ec6876b80aa911ba2a73c21"
    },
    {
      "path": "/Volumes/KINGSTON/.wt-claude-shipyard/phase46-isolated-recheck-20261002/claude-dependency.log",
      "bytes": 3941,
      "sha256": "9ef2d9fb665bc4b94148d3e78f9be9d6a13d4ff3f7065909800891f2cd22e726"
    },
    {
      "path": "/Volumes/KINGSTON/.wt-claude-shipyard/phase46-isolated-recheck-20261002/claude-install.log",
      "bytes": 353,
      "sha256": "bbf169da755b2576584e130fb941c2f10aa09ffbeb1a5ed6d9c247e086b4b6a7"
    },
    {
      "path": "/Volumes/KINGSTON/.wt-claude-shipyard/phase46-isolated-recheck-20261002/codex-candidate/agents/.shipyard-manifest.json",
      "bytes": 23673,
      "sha256": "3ed7020f9a2dd20530f43a00e69d70a2865bab3bf0d2bbc3ded2899503708dcc"
    },
    {
      "path": "/Volumes/KINGSTON/.wt-claude-shipyard/phase46-isolated-recheck-20261002/codex-candidate/agents/.shipyard-provenance.json",
      "bytes": 275,
      "sha256": "2e48819f10a08c7620659a235d77992f03a482b27641f8935244be0eb1623d0f"
    },
    {
      "path": "/Volumes/KINGSTON/.wt-claude-shipyard/phase46-isolated-recheck-20261002/claude-candidate/plugin-0.70.0/.shipyard-provenance.json",
      "bytes": 275,
      "sha256": "2e48819f10a08c7620659a235d77992f03a482b27641f8935244be0eb1623d0f"
    },
    {
      "path": "/Volumes/KINGSTON/.wt-claude-shipyard/phase46-isolated-recheck-20261002/claude-candidate/plugin-0.70.0/.claude-plugin/plugin.json",
      "bytes": 736,
      "sha256": "274152db71826dd71f5e58b0fa1f1a46b465cc42261ba9496185b76bb5d4ce09"
    },
    {
      "path": "/Volumes/KINGSTON/.wt-claude-shipyard/phase46-isolated-recheck-20261002/codex-authenticated-status.json",
      "bytes": 197,
      "sha256": "f3b3875a9d6eedb87bc66980fc4f0a00104dfc1c4f1c0521b7f82eb3bdbe41c3"
    },
    {
      "path": "/Volumes/KINGSTON/.wt-claude-shipyard/phase46-isolated-recheck-20261002/claude-authenticated-normal-home-status.json",
      "bytes": 203,
      "sha256": "55b892bf77f4c79a70a286bcc439de50b4aa74959d54401ad772da8a5e8d93f6"
    },
    {
      "path": "/tmp/phase46-isolated-recheck.py",
      "bytes": 2408,
      "sha256": "744fe0ef8971269c730f210e5ab8efd54c89f9465864523ea3ee87975f992300"
    },
    {
      "path": "/tmp/phase46-408-review-retained.json",
      "bytes": 160,
      "sha256": "e790be862e6df4f3544a591277b38e7bc07b5c17813978cc305f07db0b164431"
    },
    {
      "path": "/tmp/phase46-408-checks-retained.json",
      "bytes": 260,
      "sha256": "ba22d98e6ad6cee38625da9bd698678cc4a11b59de789904805267669963673c"
    },
    {
      "path": "/tmp/phase46-approved-isolation-durable-archive.json",
      "bytes": 370,
      "sha256": "77fdd80f7629233955be99d872df5bf7ebce2f164351ffd86cdc5f887ffa9560"
    },
    {
      "path": "/tmp/phase46-post-baseline-observations-durable.json",
      "bytes": 232,
      "sha256": "a2c9ffaac9b81643aad009f48a3b21fcdb3b12115ab6c01a4769a1505c9368a0"
    },
    {
      "path": "/Users/serhii/.local/state/shipyard/evidence/phase46/b5d88a1cff138c2835629e53f240300b99897a3154427afda09879ee7455a36b.manifest.json",
      "bytes": 2625,
      "sha256": "b5d88a1cff138c2835629e53f240300b99897a3154427afda09879ee7455a36b"
    },
    {
      "path": "/Users/serhii/.local/state/shipyard/evidence/phase46/7a43dd38cc1d47877f688359c08dcc42d57389b97e54f6bb3b8ff0602baf6c02.manifest.json",
      "bytes": 3456,
      "sha256": "7a43dd38cc1d47877f688359c08dcc42d57389b97e54f6bb3b8ff0602baf6c02"
    },
    {
      "path": "/Users/serhii/.local/state/shipyard/evidence/phase46/66dd4bb8c6e9d32db180c797af242482ac338c0c8d44abeb8b3d831e5fb0b2aa.tar",
      "bytes": 30720,
      "sha256": "66dd4bb8c6e9d32db180c797af242482ac338c0c8d44abeb8b3d831e5fb0b2aa"
    },
    {
      "path": "/Volumes/KINGSTON/.wt-claude-shipyard/phase46-isolated-recheck-20261002/claude-authenticated-dedicated-home-status.json",
      "bytes": 343,
      "sha256": "07c9e8972517125b59f79be7b4c7bd6a0242afcb577be5f2a1b2811384c3905c"
    },
    {
      "path": "/Volumes/KINGSTON/.wt-claude-shipyard/phase46-postfix-install-cleanenv-20261002/attempts.json",
      "bytes": 1778,
      "sha256": "a9208523e10e57ed274864f68afb93bf949698c4df94c5a086064abd1c491266"
    },
    {
      "path": "/Volumes/KINGSTON/.wt-claude-shipyard/phase46-postfix-install-cleanenv-20261002/codex-install.log",
      "bytes": 8231,
      "sha256": "e16eb67e6e58c2dfcc1e3e0366ebc420c5e74c1415afbf2e7b990d1a9837d014"
    },
    {
      "path": "/Volumes/KINGSTON/.wt-claude-shipyard/phase46-postfix-install-cleanenv-20261002/claude-dependency.log",
      "bytes": 4240,
      "sha256": "77014ddb0dd1edd59c8a3bb4e843b8750b271c50fcb4f14004e73770f6c7820a"
    },
    {
      "path": "/Volumes/KINGSTON/.wt-claude-shipyard/phase46-postfix-install-cleanenv-20261002/claude-install.log",
      "bytes": 204,
      "sha256": "7c150e090fae1bc3d78576aa84f8e9f381dc983f47146cac415c6e97772eafad"
    }
  ],
  "claude_authenticated_dedicated_home_status": {
    "observed_at": "2026-10-02T09:47:30.624434+00:00",
    "runtime": "claude",
    "exit": 0,
    "loggedIn": true,
    "authMethod": "claude.ai",
    "apiProvider": "firstParty",
    "isolated_os_home": true,
    "credential_storage": "dedicated isolated macOS Keychain",
    "active_keychain_metadata_unchanged": true,
    "shared_defaults_unchanged": true
  },
  "controlled_source_attempts": [
    {
      "stage": "codex-install",
      "exit": 0,
      "source_head": "3eea0e4d58e327970c5a70aa3e498317a79d88ae",
      "environment_overrides": {
        "SHIPYARD_CODEX_CAPABILITIES_FILE": "/Users/serhii/.codex/shipyard/codex-capabilities.json"
      },
      "log_bytes": 8231,
      "log_sha256": "e16eb67e6e58c2dfcc1e3e0366ebc420c5e74c1415afbf2e7b990d1a9837d014",
      "shared_defaults_unchanged": true
    },
    {
      "stage": "claude-dependency",
      "exit": 0,
      "source_head": "3eea0e4d58e327970c5a70aa3e498317a79d88ae",
      "environment_overrides": {
        "SHIPYARD_ISOLATION_ROOT": "/Volumes/KINGSTON/.wt-claude-shipyard/phase46-postfix-install-cleanenv-20261002/claude",
        "CLAUDE_CONFIG_DIR": "/Volumes/KINGSTON/.wt-claude-shipyard/phase46-postfix-install-cleanenv-20261002/claude/config",
        "CLAUDE_HOME": "/Volumes/KINGSTON/.wt-claude-shipyard/phase46-postfix-install-cleanenv-20261002/claude/config"
      },
      "log_bytes": 4240,
      "log_sha256": "77014ddb0dd1edd59c8a3bb4e843b8750b271c50fcb4f14004e73770f6c7820a",
      "shared_defaults_unchanged": true
    },
    {
      "stage": "claude-install",
      "exit": 3,
      "source_head": "3eea0e4d58e327970c5a70aa3e498317a79d88ae",
      "environment_overrides": {
        "SHIPYARD_ISOLATION_ROOT": "/Volumes/KINGSTON/.wt-claude-shipyard/phase46-postfix-install-cleanenv-20261002/claude",
        "CLAUDE_CONFIG_DIR": "/Volumes/KINGSTON/.wt-claude-shipyard/phase46-postfix-install-cleanenv-20261002/claude/config",
        "CLAUDE_HOME": "/Volumes/KINGSTON/.wt-claude-shipyard/phase46-postfix-install-cleanenv-20261002/claude/config",
        "SHIPYARD_GSD_AUTO_INSTALL": "0"
      },
      "log_bytes": 204,
      "log_sha256": "7c150e090fae1bc3d78576aa84f8e9f381dc983f47146cac415c6e97772eafad",
      "shared_defaults_unchanged": true
    }
  ],
  "controlled_source_dependency_versions": {
    "requested_core": "1.14.0",
    "observed_core": "1.14.0",
    "observed_claude_marketplace": "1.15.0",
    "marketplace_pin_honored": false
  },
  "current_safe_link_controlled_install": "pending coordinator execution"
}
```

Prior core verification and RED evidence remain historical at signed core `6d1bfbc4`.
This native continuation added a two-stage fake-npx regression first: the exact
marketplace command exited 1 with a contained `.bin/anthropic-ai-sdk` refusal
(`/tmp/T-46-08-continuation-red.log`). After the narrow guard correction and
mechanical package generation, all four exact PLAN commands below exited 0
through `createHostProfileRunner`, allowing PATH/LANG/LC_ALL only. Local raw
outputs/status records are `/tmp/T-46-08-host-{0,1,2,3}.{log,json}`; these are
unsealed fixture verification, not host finalization or native receipts.

| Command | Exit |
|---|---|
| `node --test tests/unit/marketplace-installer.test.cjs` | 0 (30 pass / 0 fail) |
| `node --test tests/unit/gen-codex-shipyard.test.cjs tests/unit/gsd-tune.test.cjs tests/unit/marketplace-install.test.cjs` | 0 (3 owners pass) |
| `bash tests/smoke/docs-smoke.sh` | 0 |
| `bash -n scripts/ensure-gsd-core.sh scripts/install-shipyard-codex.sh scripts/install-shipyard-claude-hook.sh` | 0 |

No broader suite, real dependency installer, auth probe, account/Keychain/GPG
operation, native launch, commit or push was performed by this continuation.
No credential/password/Keychain file or archive was read. The coordinator owns
actual current-safe-link fixed-source controlled installation. Trusted host
owns staging, signing, finalization/sealing and current-head independent review.
All eight native pairs, rollback rehearsal, final release live-round, operator
checkpoint and activation remain HOLD under T-46-06 and ADR-023 D6 ownership.

Latest actual controlled source `cbf11a60841a1a9228267ba01cb6b02e64fe856a`
(signed by the trusted host, per operator report) ran a fresh full installation:
Codex 0, Claude dependency 0, Claude hook 3 on
`claude/config/plugins/cache/gsd-core/gsd-core/1.15.0/node_modules/.bin/acorn`.
All three redacted attempts record shared defaults unchanged. The previous npm
cache correction therefore did not complete the actual plugin-cache hook path.
The current guard includes candidate runtime plugin caches and requires the fully
resolved single-link regular executable to stay in its own physical dependency
`node_modules` subtree. External Codex `tmp/arg0` shims remain forbidden.
Only redacted `attempts.json` and `claude-install.log` were read for this latest
observation; no other fresh installation, authentication or credential artifact
was read. Corrected plugin-cache source installation remains pending coordinator
execution; all eight native pairs and release remain HOLD.

```json
{
  "source_head": "cbf11a60841a1a9228267ba01cb6b02e64fe856a",
  "attempts_path": "/Volumes/KINGSTON/.wt-claude-shipyard/phase46-postfix-safe-links-fresh-20261002/attempts.json",
  "attempts_bytes": 1778,
  "attempts_sha256": "dc986b34a50110d51f471b9442f39457c2153d9bf962881d0a85529bcb7c37d3",
  "attempts": [
    {
      "stage": "codex-install",
      "exit": 0,
      "source_head": "cbf11a60841a1a9228267ba01cb6b02e64fe856a",
      "environment_overrides": {
        "SHIPYARD_CODEX_CAPABILITIES_FILE": "/Users/serhii/.codex/shipyard/codex-capabilities.json"
      },
      "log_bytes": 8231,
      "log_sha256": "e6466d84be9c5d2142790cabda0bf2ce26e4ea4a90e7c536c27ced0b89653ba1",
      "shared_defaults_unchanged": true
    },
    {
      "stage": "claude-dependency",
      "exit": 0,
      "source_head": "cbf11a60841a1a9228267ba01cb6b02e64fe856a",
      "environment_overrides": {
        "SHIPYARD_ISOLATION_ROOT": "/Volumes/KINGSTON/.wt-claude-shipyard/phase46-postfix-safe-links-fresh-20261002/claude",
        "CLAUDE_CONFIG_DIR": "/Volumes/KINGSTON/.wt-claude-shipyard/phase46-postfix-safe-links-fresh-20261002/claude/config",
        "CLAUDE_HOME": "/Volumes/KINGSTON/.wt-claude-shipyard/phase46-postfix-safe-links-fresh-20261002/claude/config"
      },
      "log_bytes": 4240,
      "log_sha256": "1cf62cd34257eac326083b2b1075078451bd2eb7bba0ca0356541b57209f7c26",
      "shared_defaults_unchanged": true
    },
    {
      "stage": "claude-install",
      "exit": 3,
      "source_head": "cbf11a60841a1a9228267ba01cb6b02e64fe856a",
      "environment_overrides": {
        "SHIPYARD_ISOLATION_ROOT": "/Volumes/KINGSTON/.wt-claude-shipyard/phase46-postfix-safe-links-fresh-20261002/claude",
        "CLAUDE_CONFIG_DIR": "/Volumes/KINGSTON/.wt-claude-shipyard/phase46-postfix-safe-links-fresh-20261002/claude/config",
        "CLAUDE_HOME": "/Volumes/KINGSTON/.wt-claude-shipyard/phase46-postfix-safe-links-fresh-20261002/claude/config",
        "SHIPYARD_GSD_AUTO_INSTALL": "0"
      },
      "log_bytes": 197,
      "log_sha256": "32cb9a9b403c422ba20e6ee420bbb328d85b5dcc51f1a6e857c48b616b8e55fc",
      "shared_defaults_unchanged": true
    }
  ],
  "claude_install_log": {
    "path": "/Volumes/KINGSTON/.wt-claude-shipyard/phase46-postfix-safe-links-fresh-20261002/claude-install.log",
    "bytes": 197,
    "sha256": "32cb9a9b403c422ba20e6ee420bbb328d85b5dcc51f1a6e857c48b616b8e55fc",
    "text": "isolation refusal: symlink destination: /Volumes/KINGSTON/.wt-claude-shipyard/phase46-postfix-safe-links-fresh-20261002/claude/config/plugins/cache/gsd-core/gsd-core/1.15.0/node_modules/.bin/acorn\n"
  },
  "fixed_plugin_cache_controlled_install": "pending coordinator execution"
}
```
