'use strict';

const { Worker, isMainThread, workerData, parentPort } = require('node:worker_threads');
const { test: registerTest, describe, after } = isMainThread ? require('node:test') : {};
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const Module = require('node:module');
const childProcess = require('node:child_process');
const h = require('../fixtures/phase53/semantic-result-helpers.cjs');
const cases = [];
const test = (title, run) => cases.push({ title, run });
const source = path.dirname(h.SCRIPTS);
const shipped = path.join(h.ROOT, 'plugins/shipyard/host/plugins/delivery-pipeline');
const self = 'tests/unit/phase53-z30-semantic-material-retention.test.cjs';
const physicalFiles = [self, ...['b', 'c', 'd', 'e', 'f'].map(suffix =>
  'tests/unit/phase53-z30' + suffix + '-semantic-material-retention.test.cjs')];
const historicalOwners = ['plugins/delivery-pipeline/scripts/role-artifact.cjs',
  'plugins/shipyard/host/plugins/delivery-pipeline/scripts/role-artifact.cjs',
  'plugins/shipyard/.codex-plugin/plugin.json', 'plugins/shipyard/package-build.json', ...physicalFiles.slice(0, 2)];
const previous = h.setup('phase53-z29-semantic-final-catalog-duplication.test.cjs',
  "\nfor (const runtime of ['codex', 'claude']) test(",
  'old, prior, canonicalPublicRole29, stagePackage, envelope, protectedInputs, retainedProducer, independentRoot');
const { old, prior, stagePackage, envelope, protectedInputs, independentRoot } = previous;
const a = () => {
  const file = path.join(source, 'scripts/role-artifact.cjs'), loaded = new Module(file, module);
  loaded.filename = file; loaded.paths = Module._nodeModulePaths(path.dirname(file));
  loaded._compile(fs.readFileSync(file, 'utf8') + '\nmodule.exports = { ...module.exports, semanticInputFiles, writeImmutableArtifactFile, readImmutableFile, withArchivePublication, HISTORICAL_ARCHIVE_MAX_BYTES };', file);
  return { ...old.internals(), ...loaded.exports };
};
const owners = ['plugins/delivery-pipeline/scripts/role-artifact.cjs',
  'plugins/shipyard/host/plugins/delivery-pipeline/scripts/role-artifact.cjs',
  'plugins/shipyard/.codex-plugin/plugin.json', 'plugins/shipyard/package-build.json',
  'tests/unit/phase53-z29i-recorded-integration-compatibility.test.cjs', ...physicalFiles];
const payloadFor = launch => JSON.parse((launch.input || launch.prompt)
  .match(/<AUTHENTICATED_SEMANTIC_REVIEW>\n([\s\S]*)\n<\/AUTHENTICATED_SEMANTIC_REVIEW>$/)[1]);
const canonicalRoster = [
  {
    "number": 1,
    "title": "Accept ordinary Codex semantic integration end to end",
    "wave": 1,
    "depends_on": [],
    "files": [
      "plugins/delivery-pipeline/scripts/codex-delivery-host.cjs",
      "plugins/delivery-pipeline/scripts/codex-runtime-host.cjs",
      "plugins/delivery-pipeline/scripts/claude-role-host.cjs",
      "plugins/delivery-pipeline/scripts/role-artifact.cjs",
      "tests/unit/codex-runtime-host.test.cjs",
      "tests/unit/phase53-codex-integration.test.cjs",
      "tests/unit/phase53-semantic-input-files.test.cjs",
      "plugins/delivery-pipeline/commands/deliver.md",
      "plugins/delivery-pipeline/references/integrator.md",
      "tests/unit/deliver-builders-contract.test.cjs",
      "tests/unit/phase49-incremental-integration.test.cjs",
      "tests/unit/integration-test-partitions.test.cjs",
      "tests/fixtures/phase49/integration-v3-caller.md"
    ]
  },
  {
    "number": 2,
    "title": "Reuse semantic review for Codex architecture",
    "wave": 2,
    "depends_on": [
      "01"
    ],
    "files": [
      "plugins/delivery-pipeline/scripts/codex-delivery-host.cjs",
      "plugins/delivery-pipeline/scripts/codex-arch-review-context.cjs",
      "plugins/delivery-pipeline/scripts/role-artifact.cjs",
      "plugins/delivery-pipeline/references/arch-review.md",
      "tests/unit/phase53-codex-architecture.test.cjs",
      "tests/unit/codex-arch-review-context.test.cjs",
      "tests/unit/architecture-target.test.cjs",
      "tests/unit/legacy-pin-readers.test.cjs"
    ]
  },
  {
    "number": 3,
    "title": "Run Claude integration and architecture on shared coordination",
    "wave": 3,
    "depends_on": [
      "02"
    ],
    "files": [
      "plugins/delivery-pipeline/scripts/claude-role-host.cjs",
      "plugins/delivery-pipeline/scripts/claude-runtime-host.cjs",
      "plugins/delivery-pipeline/scripts/dispatch-boundary.cjs",
      "plugins/delivery-pipeline/scripts/role-artifact.cjs",
      "plugins/delivery-pipeline/commands/deliver.md",
      "tests/unit/phase53-claude-review.test.cjs",
      "tests/unit/claude-role-host.test.cjs",
      "tests/unit/phase49-incremental-integration.test.cjs",
      "tests/unit/integration-test-partitions.test.cjs",
      "tests/fixtures/phase49/claude-v3-native-driver.cjs",
      "tests/unit/architecture-target.test.cjs",
      "tests/unit/phase49-current-review-admission.test.cjs",
      "tests/unit/deliver-builders-contract.test.cjs"
    ]
  },
  {
    "number": 4,
    "title": "Preserve code-review evidence and rounds on both runtimes",
    "wave": 4,
    "depends_on": [
      "03"
    ],
    "files": [
      "plugins/delivery-pipeline/scripts/codex-delivery-host.cjs",
      "plugins/delivery-pipeline/scripts/codex-code-review-context.cjs",
      "plugins/delivery-pipeline/scripts/claude-role-host.cjs",
      "plugins/delivery-pipeline/scripts/role-artifact.cjs",
      "plugins/delivery-pipeline/scripts/code-review-core.cjs",
      "plugins/delivery-pipeline/scripts/phase-code-review.cjs",
      "plugins/delivery-pipeline/references/code-review.md",
      "tests/unit/phase53-code-review.test.cjs",
      "tests/unit/code-review-core.test.cjs",
      "plugins/delivery-pipeline/scripts/claude-runtime-host.cjs",
      "tests/unit/claude-role-host.test.cjs",
      "tests/unit/codex-delivery-host.test.cjs",
      "tests/unit/codex-planning-context-host.test.cjs",
      "tests/unit/role-artifact.test.cjs",
      "tests/unit/claude-reference-content.test.cjs",
      "tests/unit/judgment-contract.test.cjs",
      "tests/unit/phase53-code-review-custody.test.cjs",
      "tests/fixtures/phase53/code-review-native-driver.cjs",
      "tests/unit/phase-code-review-publish.test.cjs"
    ]
  },
  {
    "number": 5,
    "title": "Reuse private preparation within unchanged delivery launches",
    "wave": 5,
    "depends_on": [
      "04"
    ],
    "files": [
      "plugins/delivery-pipeline/scripts/runtime-context.cjs",
      "plugins/delivery-pipeline/scripts/codex-runtime-host.cjs",
      "plugins/delivery-pipeline/scripts/codex-delivery-host.cjs",
      "plugins/delivery-pipeline/scripts/claude-runtime-host.cjs",
      "plugins/delivery-pipeline/scripts/claude-delivery-host.cjs",
      "plugins/delivery-pipeline/scripts/claude-role-host.cjs",
      "tests/unit/phase53-launch-reuse.test.cjs",
      "tests/unit/runtime-context.test.cjs",
      "tests/unit/codex-delivery-host.test.cjs"
    ]
  },
  {
    "number": 6,
    "title": "Reuse unchanged bootstrap plugin listing",
    "wave": 1,
    "depends_on": [],
    "files": [
      "scripts/ensure-gsd-plugin.cjs",
      "tests/unit/marketplace-install.test.cjs",
      "tests/unit/phase53-bootstrap-reuse.test.cjs"
    ]
  },
  {
    "number": 7,
    "title": "Reuse immutable verification facts inside one host operation",
    "wave": 5,
    "depends_on": [
      "04"
    ],
    "files": [
      "plugins/delivery-pipeline/scripts/role-artifact.cjs",
      "tests/unit/phase53-immutable-reuse.test.cjs",
      "tests/unit/host-verification.test.cjs"
    ]
  },
  {
    "number": 8,
    "title": "Reuse complete compatible CI observations through the waiter",
    "wave": 1,
    "depends_on": [],
    "files": [
      "plugins/delivery-pipeline/scripts/state-sync.cjs",
      "plugins/delivery-pipeline/scripts/wait-events.cjs",
      "plugins/delivery-pipeline/scripts/ci-wait.cjs",
      "plugins/delivery-pipeline/scripts/check-state.cjs",
      "tests/unit/phase53-ci-observation.test.cjs",
      "tests/unit/ci-wait.test.cjs",
      "tests/unit/state-sync-listing.test.cjs",
      "tests/unit/wait-events.test.cjs",
      "tests/unit/phase-code-review-publish.test.cjs",
      "tests/smoke/installed-launch/lib.cjs",
      "tests/unit/phase49-final-review-acceptance.test.cjs"
    ]
  },
  {
    "number": 9,
    "title": "Reconcile original review work and publication before retry",
    "wave": 6,
    "depends_on": [
      "05",
      "07",
      "08"
    ],
    "files": [
      "plugins/delivery-pipeline/scripts/dispatch-boundary.cjs",
      "plugins/delivery-pipeline/scripts/role-artifact.cjs",
      "plugins/delivery-pipeline/scripts/codex-delivery-host.cjs",
      "plugins/delivery-pipeline/scripts/codex-runtime-host.cjs",
      "plugins/delivery-pipeline/scripts/claude-role-host.cjs",
      "plugins/delivery-pipeline/scripts/claude-runtime-host.cjs",
      "plugins/delivery-pipeline/scripts/phase-code-review.cjs",
      "tests/unit/phase53-review-recovery.test.cjs",
      "tests/unit/phase-code-review-publish.test.cjs",
      "tests/unit/phase53-code-review.test.cjs"
    ]
  },
  {
    "number": 10,
    "title": "Ship the converted review path and retire active old generations",
    "wave": 7,
    "depends_on": [
      "06",
      "08",
      "09"
    ],
    "files": [
      "tests/smoke/phase53-review-acceptance.cjs",
      "tests/unit/phase53-shipping.test.cjs",
      "docs/gsd_multilevel_delivery_pipeline.md",
      "plugins/shipyard/host/plugins/delivery-pipeline/commands/deliver.md",
      "plugins/shipyard/host/plugins/delivery-pipeline/references/arch-review.md",
      "plugins/shipyard/host/plugins/delivery-pipeline/references/code-review.md",
      "plugins/shipyard/host/plugins/delivery-pipeline/references/integrator.md",
      "plugins/shipyard/host/plugins/delivery-pipeline/scripts/check-state.cjs",
      "plugins/shipyard/host/plugins/delivery-pipeline/scripts/ci-wait.cjs",
      "plugins/shipyard/host/plugins/delivery-pipeline/scripts/claude-delivery-host.cjs",
      "plugins/shipyard/host/plugins/delivery-pipeline/scripts/claude-role-host.cjs",
      "plugins/shipyard/host/plugins/delivery-pipeline/scripts/claude-runtime-host.cjs",
      "plugins/shipyard/host/plugins/delivery-pipeline/scripts/code-review-core.cjs",
      "plugins/shipyard/host/plugins/delivery-pipeline/scripts/codex-arch-review-context.cjs",
      "plugins/shipyard/host/plugins/delivery-pipeline/scripts/codex-code-review-context.cjs",
      "plugins/shipyard/host/plugins/delivery-pipeline/scripts/codex-delivery-host.cjs",
      "plugins/shipyard/host/plugins/delivery-pipeline/scripts/codex-runtime-host.cjs",
      "plugins/shipyard/host/plugins/delivery-pipeline/scripts/dispatch-boundary.cjs",
      "plugins/shipyard/host/plugins/delivery-pipeline/scripts/phase-code-review.cjs",
      "plugins/shipyard/host/plugins/delivery-pipeline/scripts/role-artifact.cjs",
      "plugins/shipyard/host/plugins/delivery-pipeline/scripts/runtime-context.cjs",
      "plugins/shipyard/host/plugins/delivery-pipeline/scripts/state-sync.cjs",
      "plugins/shipyard/host/plugins/delivery-pipeline/scripts/wait-events.cjs",
      "plugins/shipyard/host/scripts/ensure-gsd-plugin.cjs",
      "plugins/shipyard/.codex-plugin/plugin.json",
      "plugins/shipyard/package-build.json"
    ]
  },
  {
    "number": 11,
    "title": "Preserve independent CI check identity through publication and waiting",
    "wave": 9,
    "depends_on": [
      "12"
    ],
    "files": [
      "plugins/delivery-pipeline/scripts/check-state.cjs",
      "tests/unit/phase53-z11-ci-check-identity.test.cjs",
      "tests/unit/check-state.test.cjs",
      "tests/unit/phase53-ci-observation.test.cjs",
      "tests/smoke/installed-launch/lib.cjs",
      "tests/unit/ci-wait.test.cjs",
      "plugins/shipyard/host/plugins/delivery-pipeline/scripts/check-state.cjs",
      "plugins/shipyard/.codex-plugin/plugin.json",
      "plugins/shipyard/package-build.json"
    ]
  },
  {
    "number": 12,
    "title": "Accept stable complete Claude transcripts after delayed wakeups within existing bounds",
    "wave": 8,
    "depends_on": [
      "10"
    ],
    "files": [
      "plugins/delivery-pipeline/scripts/claude-runtime-host.cjs",
      "tests/unit/phase53-z12-claude-transcript-stability.test.cjs",
      "plugins/shipyard/host/plugins/delivery-pipeline/scripts/claude-runtime-host.cjs",
      "plugins/shipyard/.codex-plugin/plugin.json",
      "plugins/shipyard/package-build.json"
    ]
  },
  {
    "number": 13,
    "title": "Separate completed negative queries from failed required semantic reads",
    "wave": 10,
    "depends_on": [
      "11"
    ],
    "files": [
      "plugins/delivery-pipeline/scripts/codex-runtime-host.cjs",
      "plugins/delivery-pipeline/scripts/role-artifact.cjs",
      "tests/unit/phase53-z13-negative-query-outcomes.test.cjs",
      ".github/workflows/test.yml",
      "plugins/shipyard/host/plugins/delivery-pipeline/scripts/codex-runtime-host.cjs",
      "plugins/shipyard/host/plugins/delivery-pipeline/scripts/role-artifact.cjs",
      "plugins/shipyard/.codex-plugin/plugin.json",
      "plugins/shipyard/package-build.json"
    ]
  },
  {
    "number": 14,
    "title": "Authenticate ordered Codex initialization and exact semantic input at both consumers",
    "wave": 11,
    "depends_on": [
      "13"
    ],
    "files": [
      "plugins/delivery-pipeline/scripts/codex-runtime-host.cjs",
      "plugins/delivery-pipeline/scripts/role-artifact.cjs",
      "tests/unit/phase53-z14-codex-native-preamble.test.cjs",
      "tests/unit/phase53-z14b-codex-native-preamble-final.test.cjs",
      "tests/fixtures/phase53/codex-preamble-helpers.cjs",
      "plugins/shipyard/host/plugins/delivery-pipeline/scripts/codex-runtime-host.cjs",
      "plugins/shipyard/host/plugins/delivery-pipeline/scripts/role-artifact.cjs",
      "plugins/shipyard/.codex-plugin/plugin.json",
      "plugins/shipyard/package-build.json"
    ]
  },
  {
    "number": 15,
    "title": "Scope delivery worker support and seams while preserving complete independent final coverage",
    "wave": 12,
    "depends_on": [
      "14"
    ],
    "files": [
      "plugins/delivery-pipeline/scripts/role-artifact.cjs",
      "tests/unit/phase53-z15-responsibility-support.test.cjs",
      "plugins/shipyard/host/plugins/delivery-pipeline/scripts/role-artifact.cjs",
      "plugins/shipyard/.codex-plugin/plugin.json",
      "plugins/shipyard/package-build.json"
    ]
  },
  {
    "number": 16,
    "title": "Prove repaired normal source and package consumers without promoting historical evidence",
    "wave": 13,
    "depends_on": [
      "15"
    ],
    "files": [
      "tests/unit/phase53-z16-final-followup-acceptance.test.cjs",
      "tests/unit/phase53-z16b-final-followup-negative.test.cjs",
      "tests/fixtures/phase53/combined-followup-helpers.cjs"
    ]
  },
  {
    "number": 17,
    "title": "Prove actual GitHub job attempts before CI rerun supersession",
    "wave": 14,
    "depends_on": [
      "16"
    ],
    "files": [
      "plugins/delivery-pipeline/scripts/check-state.cjs",
      "plugins/shipyard/host/plugins/delivery-pipeline/scripts/check-state.cjs",
      "plugins/shipyard/.codex-plugin/plugin.json",
      "plugins/shipyard/package-build.json",
      "tests/unit/phase53-z17-ci-job-attempts.test.cjs",
      "tests/fixtures/phase53/github-job-attempts.json",
      "tests/unit/phase53-ci-observation.test.cjs",
      "plugins/delivery-pipeline/scripts/ci-wait.cjs",
      "plugins/shipyard/host/plugins/delivery-pipeline/scripts/ci-wait.cjs",
      "tests/unit/phase53-z17b-ci-wait-published-read.test.cjs",
      "plugins/delivery-pipeline/scripts/codex-runtime-host.cjs",
      "plugins/shipyard/host/plugins/delivery-pipeline/scripts/codex-runtime-host.cjs",
      "tests/unit/phase53-z17c-native-wait-lifecycle.test.cjs"
    ]
  },
  {
    "number": 18,
    "title": "Remove the aggregate publish-policy comment violation",
    "wave": 15,
    "depends_on": [
      "17"
    ],
    "files": [
      "plugins/delivery-pipeline/scripts/check-state.cjs",
      "plugins/shipyard/host/plugins/delivery-pipeline/scripts/check-state.cjs",
      "plugins/shipyard/.codex-plugin/plugin.json",
      "plugins/shipyard/package-build.json"
    ]
  },
  {
    "number": 19,
    "title": "Remove lossless semantic review wire duplication",
    "wave": 16,
    "depends_on": [
      "18"
    ],
    "files": [
      "plugins/delivery-pipeline/scripts/role-artifact.cjs",
      "tests/unit/phase53-z19-semantic-wire-dedup.test.cjs",
      "tests/unit/phase53-z17-ci-job-attempts.test.cjs",
      "tests/unit/phase53-z17b-ci-wait-published-read.test.cjs",
      "tests/unit/phase53-z17c-native-wait-lifecycle.test.cjs",
      "tests/unit/phase53-z15-responsibility-support.test.cjs",
      "tests/fixtures/phase53/combined-followup-helpers.cjs",
      "plugins/shipyard/host/plugins/delivery-pipeline/scripts/role-artifact.cjs",
      "plugins/shipyard/.codex-plugin/plugin.json",
      "plugins/shipyard/package-build.json"
    ]
  },
  {
    "number": 20,
    "title": "Validate equivalent repeated native context observations",
    "wave": 17,
    "depends_on": [
      "19"
    ],
    "files": [
      "plugins/delivery-pipeline/scripts/codex-runtime-host.cjs",
      "tests/unit/phase53-z20-native-context-repeats.test.cjs",
      "plugins/shipyard/host/plugins/delivery-pipeline/scripts/codex-runtime-host.cjs",
      "plugins/shipyard/.codex-plugin/plugin.json",
      "plugins/shipyard/package-build.json"
    ]
  },
  {
    "number": 21,
    "title": "Carry complete semantic reports through bounded authenticated wire",
    "wave": 18,
    "depends_on": [
      "20"
    ],
    "files": [
      "plugins/delivery-pipeline/scripts/role-artifact.cjs",
      "plugins/delivery-pipeline/scripts/codex-delivery-host.cjs",
      "plugins/delivery-pipeline/scripts/claude-role-host.cjs",
      "tests/fixtures/phase53/semantic-result-helpers.cjs",
      "tests/unit/phase53-z21-semantic-result-wire.test.cjs",
      "tests/unit/phase53-z21b-semantic-result-custody.test.cjs",
      "tests/unit/phase53-z17-ci-job-attempts.test.cjs",
      "tests/unit/phase53-z15-responsibility-support.test.cjs",
      "plugins/shipyard/host/plugins/delivery-pipeline/scripts/role-artifact.cjs",
      "plugins/shipyard/host/plugins/delivery-pipeline/scripts/codex-delivery-host.cjs",
      "plugins/shipyard/host/plugins/delivery-pipeline/scripts/claude-role-host.cjs",
      "plugins/shipyard/.codex-plugin/plugin.json",
      "plugins/shipyard/package-build.json"
    ]
  },
  {
    "number": 22,
    "title": "Retain complete incomplete-report inventories through legacy projection",
    "wave": 19,
    "depends_on": [
      "21"
    ],
    "files": [
      "plugins/delivery-pipeline/scripts/code-review-core.cjs",
      "plugins/delivery-pipeline/scripts/role-artifact.cjs",
      "tests/unit/phase53-z22-semantic-incomplete-projection.test.cjs",
      "tests/unit/phase53-z17-ci-job-attempts.test.cjs",
      "plugins/shipyard/host/plugins/delivery-pipeline/scripts/code-review-core.cjs",
      "plugins/shipyard/host/plugins/delivery-pipeline/scripts/role-artifact.cjs",
      "plugins/shipyard/.codex-plugin/plugin.json",
      "plugins/shipyard/package-build.json"
    ]
  },
  {
    "number": 23,
    "title": "Renew the original verification owner at synchronous command boundaries",
    "wave": 20,
    "depends_on": [
      "22"
    ],
    "files": [
      "plugins/delivery-pipeline/scripts/codex-delivery-host.cjs",
      "plugins/delivery-pipeline/scripts/host-verification.cjs",
      "plugins/delivery-pipeline/scripts/planning-writer-lease.cjs",
      "tests/unit/phase53-z23-verification-owner-heartbeat.test.cjs",
      "tests/unit/phase53-z17-ci-job-attempts.test.cjs",
      "tests/unit/codex-decompose-host.test.cjs",
      "plugins/shipyard/host/plugins/delivery-pipeline/scripts/codex-delivery-host.cjs",
      "plugins/shipyard/host/plugins/delivery-pipeline/scripts/host-verification.cjs",
      "plugins/shipyard/host/plugins/delivery-pipeline/scripts/planning-writer-lease.cjs",
      "plugins/shipyard/.codex-plugin/plugin.json",
      "plugins/shipyard/package-build.json"
    ]
  },
  {
    "number": 24,
    "title": "Retain exact historical semantic producers independently of Git history",
    "wave": 20,
    "depends_on": [
      "22"
    ],
    "files": [
      "tests/fixtures/phase53/semantic-result-helpers.cjs",
      "tests/unit/phase53-z24-historical-producer-reference.test.cjs",
      "tests/fixtures/phase53/historical-semantic-producer/manifest.json",
      "tests/fixtures/phase53/historical-semantic-producer/role-artifact.cjs.gz",
      "tests/fixtures/phase53/historical-semantic-producer/codex-delivery-host.cjs.gz",
      "tests/fixtures/phase53/historical-semantic-producer/claude-role-host.cjs.gz"
    ]
  },
  {
    "number": 25,
    "title": "Transport exact historical producer fixtures as canonical reviewable text",
    "wave": 21,
    "depends_on": [
      "24"
    ],
    "files": [
      "tests/fixtures/phase53/semantic-result-helpers.cjs",
      "tests/fixtures/phase53/historical-semantic-producer/manifest.json",
      "tests/fixtures/phase53/historical-semantic-producer/role-artifact.cjs.gz",
      "tests/fixtures/phase53/historical-semantic-producer/codex-delivery-host.cjs.gz",
      "tests/fixtures/phase53/historical-semantic-producer/claude-role-host.cjs.gz",
      "tests/fixtures/phase53/historical-semantic-producer/role-artifact.cjs.gz.b64",
      "tests/fixtures/phase53/historical-semantic-producer/codex-delivery-host.cjs.gz.b64",
      "tests/fixtures/phase53/historical-semantic-producer/claude-role-host.cjs.gz.b64",
      "tests/unit/phase53-z24-historical-producer-reference.test.cjs",
      "tests/unit/phase53-z25-historical-fixture-text-transport.test.cjs"
    ]
  },
  {
    "number": 26,
    "title": "Canonicalize protected path order before native initialization capture",
    "wave": 22,
    "depends_on": [
      "23",
      "25"
    ],
    "files": [
      "plugins/delivery-pipeline/scripts/codex-runtime-host.cjs",
      "plugins/shipyard/host/plugins/delivery-pipeline/scripts/codex-runtime-host.cjs",
      "plugins/shipyard/.codex-plugin/plugin.json",
      "plugins/shipyard/package-build.json",
      "tests/unit/phase53-z26-native-initialization-order.test.cjs",
      "tests/unit/phase53-z24-historical-producer-reference.test.cjs"
    ]
  },
  {
    "number": 27,
    "title": "Remove redundant code-review worker obligation vector with exact custody",
    "wave": 23,
    "depends_on": [
      "26"
    ],
    "files": [
      "plugins/delivery-pipeline/scripts/role-artifact.cjs",
      "plugins/shipyard/host/plugins/delivery-pipeline/scripts/role-artifact.cjs",
      "plugins/shipyard/.codex-plugin/plugin.json",
      "plugins/shipyard/package-build.json",
      "tests/unit/phase53-z27-semantic-worker-input-redundancy.test.cjs",
      "tests/unit/phase53-z15-responsibility-support.test.cjs"
    ]
  },
  {
    "number": 28,
    "title": "Remove redundant code-review final seam vector with exact custody",
    "wave": 24,
    "depends_on": [
      "27"
    ],
    "files": [
      "plugins/delivery-pipeline/scripts/role-artifact.cjs",
      "plugins/shipyard/host/plugins/delivery-pipeline/scripts/role-artifact.cjs",
      "plugins/shipyard/.codex-plugin/plugin.json",
      "plugins/shipyard/package-build.json",
      "tests/unit/phase53-z15-responsibility-support.test.cjs",
      "tests/unit/phase53-z19-semantic-wire-dedup.test.cjs",
      "tests/unit/phase53-z27-semantic-worker-input-redundancy.test.cjs",
      "tests/unit/phase53-z28-semantic-final-input-redundancy.test.cjs"
    ]
  },
  {
    "number": 29,
    "title": "Remove duplicate final obligation records through the protected catalog",
    "wave": 25,
    "depends_on": [
      "28"
    ],
    "files": [
      "plugins/delivery-pipeline/scripts/role-artifact.cjs",
      "plugins/shipyard/host/plugins/delivery-pipeline/scripts/role-artifact.cjs",
      "plugins/shipyard/.codex-plugin/plugin.json",
      "plugins/shipyard/package-build.json",
      "tests/unit/phase53-z15-responsibility-support.test.cjs",
      "tests/unit/phase53-z19-semantic-wire-dedup.test.cjs",
      "tests/unit/phase53-z27-semantic-worker-input-redundancy.test.cjs",
      "tests/unit/phase53-z28-semantic-final-input-redundancy.test.cjs",
      "tests/unit/phase53-z29-semantic-final-catalog-duplication.test.cjs"
    ]
  }
];
canonicalRoster.push({ number: 30, title: 'Retain complete current code-review material under its existing policy',
  wave: 26, depends_on: ['29'], files: historicalOwners });
const SCALED_TICKET_COUNT = 34;
const deliveredRoster = [
  {
    "number": 34,
    "title": "Relocate whole original role-artifact cases into readable physical test runners",
    "wave": 26,
    "depends_on": [
      "29"
    ],
    "files": [
      "tests/unit/role-artifact.test.cjs",
      "tests/unit/helpers/phase53-role-artifact-fixture.cjs",
      "tests/unit/phase53-z29t-role-architecture-archives.test.cjs",
      "tests/unit/phase53-z29u-role-containment.test.cjs",
      "tests/unit/phase53-z29v-role-code-review.test.cjs",
      "tests/unit/phase53-z29w-role-integration.test.cjs",
      "tests/unit/phase49-package-publication.test.cjs"
    ]
  },
  {
    "number": 32,
    "title": "Balance both original host suites across seven complete physical runners before CI repair",
    "wave": 27,
    "depends_on": [
      "34"
    ],
    "files": [
      "tests/unit/codex-delivery-host.test.cjs",
      "tests/unit/codex-runtime-host.test.cjs",
      "tests/unit/phase49-package-publication.test.cjs",
      "tests/unit/phase53-z23-verification-owner-heartbeat.test.cjs",
      "tests/unit/helpers/phase53-delivery-fixture.cjs",
      "tests/unit/helpers/phase53-original-fixer.cjs",
      "tests/unit/helpers/phase53-runtime-fixture.cjs",
      "tests/unit/phase53-z29a-fixer-original-custody.test.cjs",
      "tests/unit/phase53-z29b-fixer-source-history.test.cjs",
      "tests/unit/phase53-z29c-historical-direct.test.cjs",
      "tests/unit/phase53-z29d-historical-admitted.test.cjs",
      "tests/unit/phase53-z29e-historical-pending.test.cjs",
      "tests/unit/phase53-z29f-historical-action-repeat.test.cjs",
      "tests/unit/phase53-z29g-historical-action-covered.test.cjs"
    ]
  },
  {
    "number": 33,
    "title": "Recover provably unsent review publication and restrict legacy integration to recorded originals",
    "wave": 28,
    "depends_on": [
      "32"
    ],
    "files": [
      "plugins/delivery-pipeline/scripts/phase-code-review.cjs",
      "plugins/delivery-pipeline/scripts/codex-delivery-host.cjs",
      "plugins/delivery-pipeline/scripts/role-artifact.cjs",
      "plugins/shipyard/host/plugins/delivery-pipeline/scripts/phase-code-review.cjs",
      "plugins/shipyard/host/plugins/delivery-pipeline/scripts/codex-delivery-host.cjs",
      "plugins/shipyard/host/plugins/delivery-pipeline/scripts/role-artifact.cjs",
      "plugins/shipyard/.codex-plugin/plugin.json",
      "plugins/shipyard/package-build.json",
      "tests/unit/phase53-z29h-publication-unsent-recovery.test.cjs",
      "tests/unit/phase53-z29i-recorded-integration-compatibility.test.cjs",
      "tests/unit/phase53-z29f-historical-action-repeat.test.cjs",
      "tests/unit/phase53-z29g-historical-action-covered.test.cjs",
      "tests/unit/phase49-incremental-integration.test.cjs",
      "tests/unit/integration-test-partitions.test.cjs",
      "tests/unit/phase53-z17-ci-job-attempts.test.cjs"
    ]
  },
  {
    "number": 31,
    "title": "Complete the native Codex CI-fix host contract before T30 recovery",
    "wave": 29,
    "depends_on": [
      "33"
    ],
    "files": [
      "plugins/delivery-pipeline/scripts/deliver-dispatch.cjs",
      "plugins/delivery-pipeline/scripts/codex-delivery-host.cjs",
      "plugins/delivery-pipeline/scripts/base-merge.cjs",
      "plugins/delivery-pipeline/scripts/dispatch-boundary.cjs",
      "plugins/shipyard/host/plugins/delivery-pipeline/scripts/deliver-dispatch.cjs",
      "plugins/shipyard/host/plugins/delivery-pipeline/scripts/codex-delivery-host.cjs",
      "plugins/shipyard/host/plugins/delivery-pipeline/scripts/base-merge.cjs",
      "plugins/shipyard/host/plugins/delivery-pipeline/scripts/dispatch-boundary.cjs",
      "plugins/shipyard/.codex-plugin/plugin.json",
      "plugins/shipyard/package-build.json",
      "tests/unit/deliver-dispatch.test.cjs",
      "tests/unit/phase53-z29x-native-ci-fix-contract.test.cjs",
      "tests/unit/phase53-z29y-native-ci-fix-recovery.test.cjs",
      "tests/unit/phase53-z29z-generated-base-merge.test.cjs",
      "tests/unit/phase53-z17-ci-job-attempts.test.cjs",
      "tests/unit/codex-arch-review-context.test.cjs",
      "tests/unit/phase-code-review-publish.test.cjs",
      "plugins/delivery-pipeline/scripts/lock.cjs",
      "plugins/shipyard/host/plugins/delivery-pipeline/scripts/lock.cjs",
      "plugins/delivery-pipeline/scripts/conveyor-coverage.cjs",
      "plugins/shipyard/host/plugins/delivery-pipeline/scripts/conveyor-coverage.cjs"
    ]
  }
];
const deliveredPlans = {
  "34": "---\nphase: 53-simplify-delivery-process\nplan: \"34\"\ntitle: \"Relocate whole original role-artifact cases into readable physical test runners\"\ntype: execute\nwave: 26\ndepends_on: [\"53-29\"]\nfiles_modified:\n  - tests/unit/role-artifact.test.cjs\n  - tests/unit/helpers/phase53-role-artifact-fixture.cjs\n  - tests/unit/phase53-z29t-role-architecture-archives.test.cjs\n  - tests/unit/phase53-z29u-role-containment.test.cjs\n  - tests/unit/phase53-z29v-role-code-review.test.cjs\n  - tests/unit/phase53-z29w-role-integration.test.cjs\n  - tests/unit/phase49-package-publication.test.cjs\nautonomous: true\nrequirements: [\"F53-01\", \"F53-03\", \"F53-06\", \"F53-08\", \"F53-09\", \"F53-10\", \"F53-11\", \"F53-12\"]\ndelivery:\n  ticket: T-53-34\n  risk: high\n  human_checkpoint: review\nestimate:\n  tokens: 58000\n  raw_tokens: 58000\n  tasks: 3\n  confidence: low\nmust_haves:\n  truths:\n    - \"Every expanded original role-artifact registration, parameter value and assertion body exists exactly once across the default old physical residual and four new physical runners; original complete native/current/history/receipt/recovery/refusal lifecycles remain intact.\"\n    - \"Readable fixture definitions and physical registration exports are inert. Each executing runner owns its serial queue, private HOME/authority/gh/PATH resources and exact cleanup; Module._load, os/fs/event patches and present/absent environment values restore on failure.\"\n    - \"The complete carrier matrix preserves both runtimes, both transports and present/absent carrier values within its original lifecycle; D-32 native units, independent final, retained originals, current authority and recovery stay in their original atomic callbacks.\"\n    - \"The packaged consumer still invokes its eleven exact original role callbacks against real generated scripts, preserving canonical-to-package redirection and incremental source remap.\"\n    - \"Frozen manifest16 and first50 compact JSON bytes/hash remain exact. Four distinct t/u/v/w singleton files after semantic z29 give 55 unit/58 CI; full current/future traversal uses actual denominators.\"\n    - \"All eight complete publish-first HOST600 commands pass on one final candidate, with case180000/concurrency<=2/child8MiB unchanged; four-file fit is a future execution result, never a planning assertion.\"\n    - \"All seven owners are excluded from actual supported package inputs; complete generated inventory/types/modes/bytes and both identities remain equal, including genuine cold consumers and tamper refusals.\"\n  artifacts:\n    - path: tests/unit/role-artifact.test.cjs\n      provides: \"Whole physical residual and exact original optional selection behavior\"\n    - path: tests/unit/helpers/phase53-role-artifact-fixture.cjs\n      provides: \"Readable moved original definitions, explicit dependency/root context and runner-owned lifecycle\"\n    - path: tests/unit/phase53-z29t-role-architecture-archives.test.cjs\n      provides: \"Whole native architecture and phase-local authenticated archive allocations\"\n    - path: tests/unit/phase53-z29u-role-containment.test.cjs\n      provides: \"Whole containment and original readonly receipt authority allocations\"\n    - path: tests/unit/phase53-z29v-role-code-review.test.cjs\n      provides: \"Whole D37/history/foreign-current and complete carrier lifecycle allocations\"\n    - path: tests/unit/phase53-z29w-role-integration.test.cjs\n      provides: \"Whole compact integration and original D-32 allocations, independent union/package/discovery checks\"\n    - path: tests/unit/phase49-package-publication.test.cjs\n      provides: \"Precise original role callback collection across residual plus four physical owners\"\n  key_links:\n    - from: tests/unit/phase53-z29t-role-architecture-archives.test.cjs\n      to: tests/unit/helpers/phase53-role-artifact-fixture.cjs\n      via: \"Explicit serial runner lifecycle supplies original helpers without import effects\"\n    - from: tests/unit/phase49-package-publication.test.cjs\n      to: tests/unit/phase53-z29t-role-architecture-archives.test.cjs\n      via: \"Explicit inert original role registration under the existing packaged Module._load remap\"\n    - from: tests/unit/phase53-z29w-role-integration.test.cjs\n      to: tests/unit/shard-files.cjs\n      via: \"Real unitFiles/unitTasks/appendShard/selectTaskShard compare frozen first50 and complete current/future rosters\"\n---\n\n<objective>\nPer D-01/D-02/D-03/D-05/D-06/D-07/D-08 and accepted F53-01/03/06/08/09/10/11/12, make the complete existing role-artifact regression purpose physically runnable through four readable whole-case owners and the real existing packaged consumer. This is independent test-layout work after29, before32. The original native HOST status1 cause remains unknown; the later separate local full-file timeout motivates the allocation without reinterpreting the native receipt.\n\nOutput: seven exact test owners, three tasks and eight complete HOST600 commands. No product behavior, generated mirror, package ID, manifest, weight, generic harness, dependency, runtime policy, resource cap or new selector changes.\n</objective>\n\n<execution_context>\n@/Users/serhii/.codex/gsd-core/workflows/execute-plan.md\n@/Users/serhii/.codex/gsd-core/templates/summary.md\n@.shipyard/generated/gsd-delivery-rules/SKILL.md\n</execution_context>\n\n<context>\n@.planning/architecture/ADR-034-simplify-delivery-execution.md\n@.planning/phases/53-simplify-delivery-process/CONTEXT.md\n@.planning/phases/53-simplify-delivery-process/53-CONTEXT.md\n@.planning/phases/53-simplify-delivery-process/53-RESEARCH.md\n@.planning/phases/53-simplify-delivery-process/53-32-PLAN.md\n@tests/unit/role-artifact.test.cjs\n@tests/unit/assert-harness.cjs\n@tests/unit/phase49-package-publication.test.cjs\n@tests/unit/shard-files.cjs\n@scripts/package-shipyard-codex.cjs\n</context>\n\n## Evidence, source and actual consumers\n\nC=/Volumes/KINGSTON/.wt-claude-shipyard/phase53-investigate HEAD29cd89a5b2faa565bafeb83751036529944a4f7f/config214. E/SOURCE=/Volumes/KINGSTON/.wt-claude-shipyard/phase53-integration HEADb2f752233446f6569ffee4bd1720c8f383127fd1. D=/Users/serhii/.local/state/shipyard/phase53-delivery; F=D/final-repair-planning. F/T34-artifact-layout-diagnostic-research.json names the actual complete original diagnostics and authenticated failed receipt. Read those originals, not just its summary. Original E/tests/unit/role-artifact.test.cjs is344091 bytes/SHAf3579315c0e2e5ed2de65372e39c24b182b77307610aadeb07c2fd2481d79c8a and remains byte-identical in the preserved T32 candidate. Preserve D/T32-balanced-first-HOST-candidate-preserved/inventory.json and all14 member hashes/sizes/modes, every failed native receipt and unaccepted candidate.\n\nD/T32-balanced-second-HOST-failure-authenticated.json records four command passes, then role-artifact/judgment-artifacts/judgment-contract status1, timed_out=false, no retained failed-case detail; actual native cause UNKNOWN. D/T32-second-HOST-final-group-diagnostic.log and its stop JSON show a separate coordinator600s stop, with the two judgment files26+38 passes and role-artifact unfinished. D/T32-role-artifact-isolated-diagnostic.log and .json show the complete unfiltered role file alone stopped after600.016s, timed_out=true; its output reached D-32 capacity after prior carrier and frozen-custody cases. None is passing full-file proof. The earlier first-candidate runtime/delivery timeout remains a distinct historical failure. Do not retry an unchanged failed T32 layout or raise any bound.\n\nRead the complete original role source. Its wrapper:35\u201360 already chains callbacks via pendingCase, despite assert-harness.test itself starting asynchronous callbacks immediately. Preserve that serial causal barrier in every physical runner; a global Module._load race was a hypothesis, not an established cause. Existing native/receipt helpers are real. Source anchors below identify declarations; derive authoritative identities from the complete pre-edit source, not these line numbers alone.\n\nActual broad role-artifact.test.cjs reference inspection across tests/scripts/plugins/.github finds one dynamic source consumer: phase49-package-publication.test.cjs:1492\u20131556, exercise child. It compiles the old file with intercepted assert-harness, canonical\u2192packaged Module._load and incremental-integration source remap, then invokes eleven exact roleNames: seven native-terminal mutations, two foreign-catalogue booleans and both runtime aggregate-subject callbacks. This seam MUST collect registrations from residual+t/u/v/w after relocation. Preserve original callbacks/names/120000 child timeout/1MiB output/marker and real generated imports. Its delivery exercise is unchanged here; T32 later extends that same consumer for D/R registration. Compose these independent role/delivery seams rather than restoring the old whole consumer. Other role filename references in phase47 tests, repair/tdd evidence, captured CI job argv, manifest16 and weight705.6 are literal historical data, not dynamic loaders; leave them exact. Internal roleArtifactInternals and partitionFixtureHelpers compile production or phase49 fixtures; carrier loads codex-code-review-context/claude-role-host fixture exports. These existing source consumers retain exact source assertions/export boundaries and all runtime/transport cases.\n\nOriginal F2 direct CLI uses codex-arch-review-context.test.cjs exports. Original partition helpers compile phase49-incremental-integration.test.cjs exports, so future T33's original-restoration helper seam must be exercised on the actual combined tree. Do not assert unchanged-tree pass is new-tree proof. Inspect those exact source boundaries before any mechanical loading adaptation; no incidental fix is authorized.\n\nscripts/package-shipyard-codex.cjs:9\u201368 enumerates root scripts plus delivery-pipeline/capabilities, excludes all seven test paths and derives both identities from the whole package. Use its real disposable-destination build in new w's verification; no product/package scope is needed. shard-files.cjs:23\u201340/:70\u2013100 sorts physical names and appends tasks to frozen manifest16. Existing unit-shard.test.cjs traverses current rows dynamically; no functional change is needed there.\n\nDiscovery Level0, existing internal CommonJS patterns only. No install or external library. Actual estimate-calibration returned factor1/sample_count0/confidence low; raw58000 is projected context, not wall time or proven fit. Four runners are selected from whole original semantic groups and separate native-heavy integrations from archive/containment/history work. This is an allocation hypothesis to test with unchanged bounds, not a numerical speedup guarantee.\n\n## Fixed whole-case allocation and dependencies\n\n| Physical owner | Original declarations and exact parameters |\n|---|---|\n| Old role-artifact residual | All288\u2013800 bounded evidence/executor/PR/unknown-architecture cases; all1002\u20131218 protected archive cases; all2337\u20132440 subject/home cases; whole2787\u20132833 sealed foreign historical producer lifecycle. Keep its pre-existing authenticated compressed producer literal/body unchanged in the old residual, not newly encoded or hidden in a relocated runner. |\n| t role-architecture-archives | All805\u20131001 native architecture CLI/seal/source-race cases; all1266\u20131775 phase-local archive registrations; mixed-repository2175\u20132189; both foreign-catalogue cases2248\u20132266; both aggregate-original runtime cases2267\u20132327; whole2730\u20132755 coordinator-only native architecture case. |\n| u role-containment | All1800\u20132173 protected containment and readonly original receipt cases, including all exact loop values and fresh DIRECT CLI; completed-reference2190\u20132231 and focused-completeness2232\u20132247. |\n| v role-code-review | All2458\u20132729 legacy reordered membership/tamper/lineage/disagreement/reuse registrations; all2835\u20132904 foreign-current/native-input cases; whole2985\u20133106 carrier callback with its entire codex/claude\u00d7inline/partitioned\u00d7present/absent matrix and all seven mutations/restorations. |\n| w role-integration | Whole2906\u20132983 compact authentic integration; all3372\u20133753 D-32 callbacks, including entire frozen native unit/final/history/restart/current lifecycle, complete capacity negatives, whole Claude native lifecycle and both incomplete/needs-fix cases. |\n\nAll remaining top-level non-test helper declarations move readably into the single inert helper only where shared. Keep each original callback physically readable in its assigned file; its complete inner loops, assertions and same-custody lifecycle move together. The pre-edit complete declaration/expanded-name/parameter/body multiset determines exact multiplicity. No ordinal allocation, guessed timing, partial loop, new runtime omission, hidden source evaluator, callback strings, executable inventory, selector loader, generic registry or new name-prefix filter. New provenance is inert names/parameters/digests with explicit five-owner comparison, never executable callback data. Preserve original d37/reuse/legacy opt-in contracts and invalid-argument behavior through explicit inert collection; optional historical selections remain partial and never replace full physical verification.\n\nTask1 needs original29 only, creates shared lifecycle+t; Task2 needs that context and creates u/v/w; Task3 needs every physical owner, cuts over old registrations and precise packaged seam atomically and proves complete union. Every task owns at most five direct literal files. Only Task3's complete final cutover is eligible for global exact-once acceptance. The no-shared-owner dependency warning is intentional:34 consumes29's delivered canonical semantic/role authority through existing fixtures and its exact z29 discovery row; those are read-only prerequisites.\n\nDelivery chain:29 wave25\u219234 wave26\u219232 wave27\u219233 wave28\u219231 wave29\u219230 wave30. T32 needs34's real physical role regression union and packaged loader;33/31/30 consume the actual accepted prior generations. Preserve all existing F1/F2/P31-1/P31-2/F3 product obligations. R8 remains INCOMPLETE/zero semantic credit; manual/native/source/hypothesis identities never change.\n\nFrozen prefix is manifest16 and first50 compact-JSON SHAb6268014b4ae96454730fc1ee45a956acd518836daf2f787af6d6bdd73a02604, plus delivered first51. With q=4, full unit/CI counts are51\u219255/58 at34,62/65 at32,64/67 at33,67/70 at31,73/76 at30. Full suffix order after semantic z29 is a\u2013g, then h/i when present, then t/u/v/w, then x/y/z, then six z30 files. The55-row34 roster is an ordered subsequence after insertion of a\u2013g; it is not a62-row32 prefix. First58 a\u2013g prefix and later first60 a\u2013i prefix remain exact where present. Compare full source-derived rosters and exact insertions, not counts alone. Current phase roster is34 real plans; genuine future adds35. Preserve old evidence counts as history.\n\n<tasks>\n\n<task type=\"tracer\" tdd=\"true\">\n  <name>Task 1: Wire whole original native architecture cases through an inert runner-owned fixture</name>\n  <files>tests/unit/helpers/phase53-role-artifact-fixture.cjs, tests/unit/phase53-z29t-role-architecture-archives.test.cjs</files>\n  <behavior>\n    - Native original CLI receipt/seal/read/current/refusal lifecycle executes through the real same source-bound helpers.\n    - Fixture import and registration have no filesystem/child/HOME/PATH/harness/exit/native effects.\n    - Callback failure settles the local serial queue and preserves its failure while restoring every owned patch/resource.\n  </behavior>\n  <action>\nPer D-01/D-02/D-03/D-05/D-06/D-07/D-08 first retain the original complete declaration/expanded-name/parameter/body inventory from original29 role source with its fixed whole-file SHA. Preserve registration multiplicity, every original array and native fixture source pin. Add explicit provenance literals in new w during Task2; data cannot contain executable bodies.\n\nExtract only original shared definitions into createRoleArtifactFixture(context) and explicit createRoleArtifactLifecycle with start/run/cleanup, adapting names if actual established helper conventions require it. Inject actual unitDir/scriptsDir, assertion API and caller imports, so all original unit fixture paths and executing canonical/packaged script roots resolve identically. Do not use helper __dirname as the old unit directory. Lifecycle alone creates authority HOME/preload/gh shim, captures and restores os.homedir/PATH and exact present/absent environment keys, registers owned cleanup and serializes all callbacks using the original pendingCase ordering. Preserve existing nested fs/event/Module._load try/finally restoration and native fixture custody; never execute cleanup belonging to another runner. Generic assert-harness.cjs and production sources remain unchanged.\n\nRegister every t allocation as ordinary readable original test declarations in t, preserving original suite labels and expanded titles. Use explicit supplied test/context for inert collection and ordinary direct node:test entry with case180000/concurrency<=2, feeding the serial queue before callbacks. Do not execute old residual or any other physical runner as an aggregate. Run the complete t file, not a selected tracer callback. Original role source retains its registrations until Task3 cutover; do not claim default discovery or global uniqueness at this intermediate point. Failure/timeout stays failure; no unchanged blind retry or scope expansion.\n  </action>\n  <verify>\n    <automated>node --test tests/unit/phase53-z29t-role-architecture-archives.test.cjs</automated>\n  </verify>\n  <done>The complete original t allocation passes through actual native-boundary fixtures and current consumers with inert imports, explicit roots and correct runner-owned serial lifecycle; final exact-once cutover remains assigned to Task3.</done>\n</task>\n\n<task type=\"auto\" tdd=\"true\">\n  <name>Task 2: Preserve whole containment, code-review and native integration lifecycles in three physical owners</name>\n  <files>tests/unit/phase53-z29u-role-containment.test.cjs, tests/unit/phase53-z29v-role-code-review.test.cjs, tests/unit/phase53-z29w-role-integration.test.cjs</files>\n  <behavior>\n    - Original declarations/parameters/assertion bodies are intact and statically visible in the assigned physical files.\n    - Carrier executes all eight runtime/transport/presence combinations and every refusal/restoration within the original lifecycle.\n    - D-32 original units, independent final, claimed authority, receipts, original history, tamper and compatible restart remain the same complete atomic cases on both runtimes.\n  </behavior>\n  <action>\nPer D-02/D-03/D-05/D-06/D-07/D-08 move the exact u/v/w allocations, importing only inert original definitions through Task1's explicit context. Preserve all native/final/current/history/claimed/original-receipt/recovery assertions and exact parameter arrays, including both D-32 nonpassing modes. No assertion edits except exact mechanical path/import/loading substitutions independently recorded in provenance. Do not turn a long lifecycle into unrelated passing cases, remove timing, shrink original source material or reinterpret unsuccessful native output.\n\nReplace only the carrier's original child-loading seam, which previously patched assert-harness with a startsWith test-name selector. Export one explicit inert registerCarrierFreshness(test, context) that contains the original callback and have its child register that exact original lifecycle directly under the existing child marker. This is a mechanical loading change, not a new filter. The child must not execute v's history cases or recursively spawn again. Preserve its original full matrix, mutation/restore ordering, assertions, statuses and bounded child semantics. All original Module._load loaders for compact/partition/carrier fixtures retain their original source/export boundaries and restore even on failure; all callback evaluation stays readable source.\n\nIn w add self-contained literal original declaration/parameter/name/body fingerprints derived from Task1's authenticated source before relocation. Keep metadata distinct from new meta checks and compare exact original module+declaration+parameter identities with multiplicity. Reject missing/duplicate/foreign/body-changed/parameter-changed allocation and an empty physical runner. Original compressed historical producer stays in old source unchanged; no new VM/encoded callback mechanism is introduced. Do not self-approve expected inventory from two post-edit registries. Each complete new file has a real check before final cutover; Task3 adds the executable global exact-union checks after establishing all residual owners, without a test suppression flag.\n  </action>\n  <verify>\n    <automated>node --test tests/unit/phase53-z29u-role-containment.test.cjs\nnode --test tests/unit/phase53-z29v-role-code-review.test.cjs\nnode --test tests/unit/phase53-z29w-role-integration.test.cjs</automated>\n  </verify>\n  <done>All three complete allocations run with original assertions/parameters and same-session native/carrier/recovery custody; no hidden callback execution or selector-based substitute. Full physical union waits for Task3.</done>\n</task>\n\n<task type=\"auto\" tdd=\"true\">\n  <name>Task 3: Cut over the physical residual and precise packaged consumer, then prove the final complete tree</name>\n  <files>tests/unit/role-artifact.test.cjs, tests/unit/phase49-package-publication.test.cjs, tests/unit/phase53-z29w-role-integration.test.cjs</files>\n  <behavior>\n    - Original whole multiset equals residual+t/u/v/w exactly once; every physical default file runs only its own nonempty allocation.\n    - All eleven packaged role callback names resolve to the same original assertions under real package remapping.\n    - Frozen16/first50/first51, exact four singleton additions and every actual/future row are verified; complete package/two IDs/cold/tamper remain unchanged.\n    - All eight final-tree HOST commands pass without carrying prior-tree credit or altering limits.\n  </behavior>\n  <action>\nPer D-01/D-02/D-03/D-05/D-06/D-07/D-08 remove only the allocated original registrations from old role source and import inert shared definitions using original unit/script roots. Its default command runs the complete residual, never an aggregator. Retain all residual assertion bodies exactly, including the original authenticated compressed historical producer and its SHA check. Existing d37/reuse/legacy selections and original9/1/1 registration checks must operate on explicit collection across residual and named physical owners with original predicates/counts/invalid-argument semantics; move only the existing count/loading seams where necessary, never add new acceptance through a filter.\n\nAt phase49-package-publication's exact exercise role entry branch, collect residual and four explicit inert register exports into the existing callback collection, reject duplicate names, then invoke the unchanged eleven roleNames. Keep the delivery entry branch, original selected-name arrays/assertions, original canonical\u2192packaged Module._load mapping, source prefix assertion and incremental fixture read remap. The residual must retain the actual canonical import-prefix seam or replace only that exact branch's loading check with an equally exact explicit fixture-root assertion; document the mechanical substitution. All loading overrides restore in finally while the original child owns resources. No new generic loader, source-string callback evaluator or assertion scope change. T32 later adds D/R registrations to the delivery branch while retaining this role branch.\n\nComplete w's independent five-owner exact-union/inert/root/cleanup checks, including deliberate missing/duplicate/body/parameter tamper, nonempty owners, cross-runner isolation, queue failure/rejection settlement and nested patch restoration. New tests may inspect literal registrations and inert provenance; they may not read external E/D/W paths. Use the original pre-edit identities and narrowly enumerated mechanical substitution map, never relaxed canonicalization that would hide assertion changes.\n\nUsing actual unitFiles/unitTasks/readManifest/appendShard/selectTaskShard, prove original manifest16 bytes and first50 compact JSON hash, complete first51 and four t/u/v/w singleton additions yielding55/58. Prove order before x/y/z/z30 and with a\u2013i future insertions, actual full rosters and every actual/future denominator using a real disposable next-file append. No manifest/weights/workflow/selector change. Future phase membership35 is distinct from unit task counts.\n\nIn w use the supported whole builder in disposable test destinations only, comparing exact full baseline and candidate paths/types/modes/bytes and both identities independently. Run actual cold generated role consumers plus source/mirror/each-identity tamper refusal with exact restoration; source inputs exclude all seven owners. Product mirrors/IDs stay unchanged. Existing complete phase49 package suite supplies its original package/cold/tamper consumer duties too.\n\nFinally run all eight exact commands below on one unchanged final candidate, publish-first. The group supplies complete old physical residual and both whole unchanged judgment files; the four commands supply all moved original purpose exactly once. Full packaged and shard consumers are additional, not replacements. Do not add unrelated old delivery/runtime monolith runs to this independent prerequisite. Case180000/concurrency<=2/child8MiB/HOST600/native1MiB/result128KiB/TTL remain unchanged. Fit requires actual native HOST outcomes for every whole file; any failure/unknown remains explicit. Ordinary scoped source/comment checks, current-head CI/internal fixes before external-review-triggering PR open, code review/integration/target-required architecture and human APPROVED review precede guard merge. This test ticket gives no installed/native/R8/phase acceptance.\n  </action>\n  <verify>\n    <automated>node plugins/delivery-pipeline/scripts/publish-gate.cjs --base origin/main --working-tree --json\nnode --test tests/unit/role-artifact.test.cjs tests/unit/judgment-artifacts.test.cjs tests/unit/judgment-contract.test.cjs\nnode --test tests/unit/phase53-z29t-role-architecture-archives.test.cjs\nnode --test tests/unit/phase53-z29u-role-containment.test.cjs\nnode --test tests/unit/phase53-z29v-role-code-review.test.cjs\nnode --test tests/unit/phase53-z29w-role-integration.test.cjs\nnode --test tests/unit/phase49-package-publication.test.cjs\nnode --test tests/unit/unit-shard.test.cjs</automated>\n    <human-check>Actual current-head human APPROVED review precedes normal guard merge. Future unchanged-bound HOST fit and native/phase acceptance require their own genuine evidence.</human-check>\n  </verify>\n  <done>All five physical owners exactly preserve original complete case/parameter/assertion multiplicity and every same-session lifecycle; packaged eleven-callback collection, complete prefix/current-future selectors and whole package/two-ID/cold/tamper proof pass. All eight same-final-tree HOST600 commands pass with retained failures and no invented acceptance.</done>\n</task>\n\n</tasks>\n\n## Verification commands\n\n- `node plugins/delivery-pipeline/scripts/publish-gate.cjs --base origin/main --working-tree --json`\n- `node --test tests/unit/role-artifact.test.cjs tests/unit/judgment-artifacts.test.cjs tests/unit/judgment-contract.test.cjs`\n- `node --test tests/unit/phase53-z29t-role-architecture-archives.test.cjs`\n- `node --test tests/unit/phase53-z29u-role-containment.test.cjs`\n- `node --test tests/unit/phase53-z29v-role-code-review.test.cjs`\n- `node --test tests/unit/phase53-z29w-role-integration.test.cjs`\n- `node --test tests/unit/phase49-package-publication.test.cjs`\n- `node --test tests/unit/unit-shard.test.cjs`\n\n## Admission and planning-only boundary\n\nUse actual SOURCE frontmatter parser and host-verification.planCommands/assignPlan with actual pipeline-config.loadConfig(C)/repoValue verification_commands214. Add only missing exact argv with profile host/timeout_s600 in memory for simulation; actual coordinator admission follows independent checker. No config mutation, broad prefix or changed profile. Each five changed plans is<=60000 UTF8 bytes, scope<15, tasks<=3 with direct task scopes.\n\nUse actual SOURCE plan-delivery.deliverPlan with real C graphDir, current file SHA and real outside-C E worktree, exercising mode delivered. Proposed34 row and complete34-plan DAG/ownership/current-future roster stay in memory. Validate actual GSD frontmatter and plan structure, preserve all unrelated existing warnings. Compare frozen manifest16/first50 through actual SOURCE discovery functions and provisional exact filenames in memory. Existing prefix and runtime fit are not invented passes.\n\nOnly this new34 and existing32/33/31/30 PLAN files may change. Freeze other29 plans, CONTEXTs, research516575/SHA0537628e5648413fa9b21bfc5d7ba1ab076f5926ed260cc356d3bc4a1f05c137, config214, graph, GSD, C/E heads, all worktrees and original candidate bytes/modes/receipts. No product tests/builds/providers/installs/source edits/state-sync/commits/admission. F/T33-consistency-checker-authenticated.json and T33-scope-warning-dispositions.json retain their real ISSUES_FOUND/nonblocking accepted provenance; no fake PASS. Independent native checker follows this five-plan amendment.\n\n<threat_model>\n## Trust boundaries\n\n| Boundary | Description |\n|---|---|\n| Original source -> relocated coverage | Complete original identity/parameter/body multiset, not a post-edit count, authenticates purpose |\n| Inert definitions -> physical runner | Only explicit caller lifecycle owns filesystem/global patches/native fixtures/cleanup |\n| Package callback loader -> real generated source | Eleven original callbacks use actual packaged imports and unchanged source seams |\n| Physical discovery -> current/future selectors | Frozen manifest/first50 and exact sorted insertion govern complete coverage |\n| Diagnostic receipt -> acceptance claim | Native status1 and local timeout remain distinct; final-tree HOST evidence alone proves fit |\n\n## STRIDE threat register\n\n| Threat ID | Category | Component | Severity | Disposition | Mitigation plan |\n|---|---|---|---|---|---|\n| T-53-34-01 | Tampering | Original case allocation | high | mitigate | Tasks1\u20133 original digest/declaration/parameter/body inventory, fixed whole-case allocation and deliberate union tamper negatives |\n| T-53-34-02 | Elevation of privilege | Runner/global effects | high | mitigate | Explicit inert imports, serial pendingCase barrier, own HOME/PATH/os/fs/Module/event restoration even on failure |\n| T-53-34-03 | Spoofing | Packaged source consumer | high | mitigate | Task3 exact eleven callback registrations, genuine package import remapping and cold/tamper checks |\n| T-53-34-04 | Denial of service | Full original regression | high | mitigate | Four semantic physical allocations retain all atomic lifecycles; unchanged HOST600/case180000/concurrency2/8MiB outcomes required |\n| T-53-34-05 | Tampering | Prefix and package scope | high | mitigate | Actual frozen16/first50/first51, exact four insertions/full selectors and whole generated inventory/two IDs equality |\n| T-53-34-06 | Repudiation | Failure and phase evidence | high | mitigate | Preserve original native status1 unknown cause/local timeout distinction, failed receipts/candidates and new-tree-only proof; R8/phase credit unchanged |\n| T-53-SC | Tampering | npm/pip/cargo installs | high | mitigate | No install/dependency change; any later install proposal requires package legitimacy protocol |\n</threat_model>\n\n<verification>\nRequire seven owners/three tasks, complete original residual+four exact union, whole native/carrier/current/history/claimed/receipt/recovery lifecycles, inert lifecycle/cleanup, eleven actual packaged callbacks, frozen16/50/51 and55/58 current+future row identity, complete unchanged package/two-ID/cold/tamper and all eight final-tree HOST600 commands. T32/T33/T31/T30 recheck their relevant moved consumers on their own changed combined trees; oldtree passes never carry. Normal target-sensitive reviews/CI/current human approval remain owed; no ticket merge proves native phase acceptance.\n</verification>\n\n## Multi-source coverage audit\n\n| Source | Item | Plan assignment | Status |\n|---|---|---|---|\n| GOAL | Five delivery areas/both runtimes with complete normal review |34 preserves executable existing guarantees;01\u201333 retain product duties | COVERED |\n| REQ | F53-01/03/06/08/09 | Existing host/native originals/independent final/current/history/recovery preserved mechanically |Tasks1\u20133 | COVERED |\n| REQ | F53-10/11/12 | Truthful unchanged-bound complete regressions and scoped delivery support |Tasks1\u20133 plus all downstream final-tree checks | COVERED |\n| REQ | F53-02/04/05/07 | Remaining semantic/runtime/preparation/CI obligations |Existing01\u201333 unchanged in scope | COVERED |\n| RESEARCH | Complete unfiltered role alone exceeds600; original HOST cause unknown |Fixed whole allocation/future eight native HOST results; original failures retained | COVERED |\n| RESEARCH | Original multiset/full carrier/D32 lifecycle/import global restoration |Tasks1\u20133 exact provenance/queues/whole callbacks/no selectors | COVERED |\n| RESEARCH | Actual dynamic package loader and original source assertions |Task3 precise eleven-callback collection and cold/tamper | COVERED |\n| RESEARCH | Package excludes tests/frozenprefix/q4/current-future counts |Task3 complete package+actual selectors; downstream count/roster amendments | COVERED |\n| CONTEXT | D-01/D-02/D-03/D-05/D-06/D-07/D-08 |Objective/tasks preserve original history, whole evidence, actual source/runtime bounds and existing coordinator | COVERED |\n\nD-04 is superseded by D-05. Deferred research/planning optimization, product feature work in34, new framework/registry/scheduler/cache/provider policy, independent CI sharding and broad campaigns remain excluded.\n\n## Rollback\n\nSupported coordinator rollback restores these seven test owners and complete original default/packaged registrations with original receipts/candidates retained. If later32/33/31/30 consumed34, coordinate their dependency rollback and re-owe changed-head verification before removing the union. Restore whole callbacks/queues/resource ownership, no forced published history or erased failed evidence. Package/identities remain equal; no release authorization.\n\n<success_criteria>\nComplete original coverage exists exactly once in residual+t/u/v/w with whole carrier/native/final/history/claimed/receipt/recovery cases, readable inert definitions, precise packaged loader, unchanged package/two IDs and frozen prefix/full selectors. Eight complete same-final-tree HOST600 commands and ordinary delivery gates pass; native failed status1 cause and separate local timeout remain truthful, and native/R8/phase acceptance stays separately owed.\n</success_criteria>\n\n<output>\nThis callback writes only new53-34-PLAN.md and amended53-32/33/31/30-PLAN.md. Typed shipyard.codex-decompose-output.v1 artifact_paths lists exactly those five worktree-relative paths; normal host sealing authenticates the complete phase index. No commit/admission/state-sync. After execution the coordinator records original-to-physical source/body/parameter mapping, all eight same-tree HOST outcomes, lifecycle/consumer/package/prefix evidence and unresolved fit in .planning/phases/53-simplify-delivery-process/53-34-SUMMARY.md.\n</output>\n",
  "32": "---\nphase: 53-simplify-delivery-process\nplan: \"32\"\ntitle: \"Balance both original host suites across seven complete physical runners before CI repair\"\ntype: execute\nwave: 27\ndepends_on: [\"53-34\"]\nfiles_modified:\n  - tests/unit/codex-delivery-host.test.cjs\n  - tests/unit/codex-runtime-host.test.cjs\n  - tests/unit/phase49-package-publication.test.cjs\n  - tests/unit/phase53-z23-verification-owner-heartbeat.test.cjs\n  - tests/unit/helpers/phase53-delivery-fixture.cjs\n  - tests/unit/helpers/phase53-original-fixer.cjs\n  - tests/unit/helpers/phase53-runtime-fixture.cjs\n  - tests/unit/phase53-z29a-fixer-original-custody.test.cjs\n  - tests/unit/phase53-z29b-fixer-source-history.test.cjs\n  - tests/unit/phase53-z29c-historical-direct.test.cjs\n  - tests/unit/phase53-z29d-historical-admitted.test.cjs\n  - tests/unit/phase53-z29e-historical-pending.test.cjs\n  - tests/unit/phase53-z29f-historical-action-repeat.test.cjs\n  - tests/unit/phase53-z29g-historical-action-covered.test.cjs\nautonomous: true\nrequirements: [\"F53-01\", \"F53-06\", \"F53-08\", \"F53-09\", \"F53-10\", \"F53-11\", \"F53-12\"]\ndelivery:\n  ticket: T-53-32\n  risk: high\n  human_checkpoint: review\nestimate:\n  tokens: 90000\n  raw_tokens: 90000\n  tasks: 3\n  confidence: low\nmust_haves:\n  truths:\n    - \"On delivered E without unmerged T31 product, BOTH original expanded suite multisets equal two residual files plus seven physical runners, tagged by original module and preserving names/arrays/parameters/callback/assertion bodies and eight historical same-candidate lifecycles, with no missing/extra/duplicate/empty allocation.\"\n    - \"Readable shared fixture modules and physical registration imports are inert; explicit per-runner isolated HOME/CODEX_HOME/GPG/signing/env/serial lifecycle alone owns effects, cleanup and complete original callbacks.\"\n    - \"Each old delivery/runtime file executes its complete physical residual and never aggregates moved runners. Each original suite purpose is its module-tagged residual plus allocated whole cases in seven commands, discovered once, preserving original delivery opt-in selections and invalid-argument behavior.\"\n    - \"Runtime originalRuntimeCases/completedCases/codeReviewRuntimeFixture causal barriers remain explicit per runner; process-global fixture mutations cannot overlap and cleanup restores only the runner's own environment, os/fs patches and resources.\"\n    - \"The precise phase49 packaged loader explicitly registers residual plus all seven original physical owners and retains every selected callback/import redirection; z23 changes only its loading seam, retaining finalizer override/script root. The literal old codexPartitionFixture declaration/extraction boundary remains unchanged.\"\n    - \"Frozen baseline16/first50 SHA/first51 remain exact. Seven z29a\u2013g singleton owners append after delivered z29 and before future x/y/z and z30, yielding conditional62 unit/65 CI with delivered34 t/u/v/w; unchanged dynamic selectors cover every actual/future row.\"\n    - \"All20 complete publish-first HOST600 commands pass on one candidate under unchanged case180000/concurrency2/child8MiB/native1MiB/result128KiB/TTL bounds. Residual/matrix/action fit remains unknown until real outcomes; retained failure is never a success.\"\n    - \"Only14 test owners change. Actual builder inputs exclude tests/unit, so the whole supported package, every generated mirror and both identities remain byte-identical to E, independently inventoried and consumed cold with no product owner or feature added.\"\n  artifacts:\n    - path: tests/unit/codex-delivery-host.test.cjs\n      provides: \"Complete residual default suite, inert explicit registration and unchanged original opt-in/extractor behavior\"\n    - path: tests/unit/helpers/phase53-delivery-fixture.cjs\n      provides: \"Actual moved shared fixture implementation with explicit root/dependency/lifecycle injection and inert imports\"\n    - path: tests/unit/helpers/phase53-original-fixer.cjs\n      provides: \"Actual moved original fixer implementation preserving full signed/native/custody/recovery lifecycles\"\n    - path: tests/unit/codex-runtime-host.test.cjs\n      provides: \"Complete physical runtime residual with original local queues and causal barriers; no moved-runner aggregation\"\n    - path: tests/unit/helpers/phase53-runtime-fixture.cjs\n      provides: \"Readable original runtime fixture definitions, explicit registration context and runner-local queues with inert imports\"\n    - path: tests/unit/phase53-z29f-historical-action-repeat.test.cjs\n      provides: \"Isolated complete original action/normalized-repeat lifecycle and preserved original inventory provenance\"\n    - path: tests/unit/phase53-z29g-historical-action-covered.test.cjs\n      provides: \"Complete original action/normalized-covered-source lifecycle plus full union/inert/prefix proof\"\n    - path: tests/unit/phase49-package-publication.test.cjs\n      provides: \"Precise explicit cold packaged registration from residual plus seven owners with original assertions\"\n    - path: tests/unit/phase53-z23-verification-owner-heartbeat.test.cjs\n      provides: \"Loading-only compatibility with unchanged original finalizer/script-root behavior\"\n  key_links:\n    - from: tests/unit/codex-delivery-host.test.cjs\n      to: tests/unit/helpers/phase53-delivery-fixture.cjs\n      via: \"Explicit runner-owned lifecycle and inert registration preserve root-resolved real fixture calls\"\n    - from: tests/unit/phase53-z29f-historical-action-repeat.test.cjs\n      to: tests/unit/helpers/phase53-original-fixer.cjs\n      via: \"One full original historicalRecovery=action/normalized-repeat case with its original signed/native/tamper sequence\"\n    - from: tests/unit/phase53-z29c-historical-direct.test.cjs\n      to: tests/unit/helpers/phase53-runtime-fixture.cjs\n      via: \"Original arch-review receipt-recovery callback uses its real same-custody lifecycle and explicit local prerequisite/cleanup barrier\"\n    - from: tests/unit/phase49-package-publication.test.cjs\n      to: tests/unit/phase53-z29a-fixer-original-custody.test.cjs\n      via: \"Explicit inert collection of all residual+seven definitions, original selected names and canonical-to-packaged import remapping\"\n    - from: tests/unit/phase53-z29g-historical-action-covered.test.cjs\n      to: tests/unit/shard-files.cjs\n      via: \"Unchanged sorted physical discovery/append/select proves first51 plus seven a\u2013g and four34 rows\u219262 with exhaustive dynamic future selection\"\n---\n\n<objective>\nRepair the actual remaining full-file budget failure, per D-01/D-03/D-05/D-06/D-07/D-08 and F53-01/06/08/09/10/11/12. Mechanically relocate whole original delivery AND runtime scenarios into the same seven physical runners, preserving both complete original suites and every product contract. Deliver34 first; preserve its old-role residual, four runners/helper and precise packaged role-collection seam. T32 changes only its existing14 owners and composes its packaged delivery branch with the delivered34 role branch. The first fixer-only candidate timed out; retained failure is not passing evidence.\n\nOutput:14 exact test owners, the existing seven physical names and the 20 complete HOST600 commands. Three tasks own5/5/5 files (g shared for final new assertions), with residual/consumer cutover in Task3. Human APPROVED review on the actual current PR head precedes guard merge. No new32 product feature/configuration, provider launch, native phase acceptance, numerical speedup or assumed fit is authorized.\n</objective>\n\n<execution_context>\n@/Users/serhii/.codex/gsd-core/workflows/execute-plan.md\n@/Users/serhii/.codex/gsd-core/templates/summary.md\n@.shipyard/generated/gsd-delivery-rules/SKILL.md\n</execution_context>\n\n<context>\n@.planning/PROJECT.md\n@.planning/ROADMAP.md\n@.planning/STATE.md\n@.planning/architecture/ADR-034-simplify-delivery-execution.md\n@.planning/phases/53-simplify-delivery-process/CONTEXT.md\n@.planning/phases/53-simplify-delivery-process/53-CONTEXT.md\n@.planning/phases/53-simplify-delivery-process/53-RESEARCH.md\n</context>\n\n## Current amendment\n\nCurrent T34 amendment: C HEAD29cd89a5b2faa565bafeb83751036529944a4f7f/config214; E b2f752 unchanged. Earlier C/config/count/failure snapshots below retain their historical identities. Read53-34-PLAN.md for seven test-only owners and exact residual+t/u/v/w inventory/consumer seams. Actual dependency29\u219234\u219232\u219233\u219231\u219230 has waves25\u219226\u219227\u219228\u219229\u219230. Current membership is34 real plans, future35; do not replace an older member. Preserve all accepted F1/F2/P31-1/P31-2/F3 source obligations and F/T33-consistency-checker-authenticated.json plus real scope-warning dispositions. Native T32 status1/timed_out=false cause is UNKNOWN; later unfiltered local role-artifact-alone600s timeout is separate. Original failed receipts and D/T32-balanced-first-HOST-candidate-preserved14-file inventory remain immutable.\n\n## Context reads and custody\n\nC = /Volumes/KINGSTON/.wt-claude-shipyard/phase53-investigate, HEADbdc881b27cf0991a3c985f38b73f73bc6c7a0bc0. E/SOURCE = /Volumes/KINGSTON/.wt-claude-shipyard/phase53-integration; W32 = /Volumes/KINGSTON/.wt-claude-shipyard/.wt-phase53-investigate/T-53-32. E and W32 HEADb2f752233446f6569ffee4bd1720c8f383127fd1. D = /Users/serhii/.local/state/shipyard/phase53-delivery; F = D/final-repair-planning. Existing F/T32-before-balanced-runtime-PLAN.md is the38385-byte former PLAN32 SHA-2568ad0900c4409e9e4dbbfcaf825242113ebf44c2b02ee9e49cd180b9964e5214d. F/T32-frozen-before-balanced-runtime-planner.json has39 matching hashes including every other31 plan, research516575/config199/contexts/graph/state/roadmap. Preserve GSD, C/E/W heads and all12 W32 candidate paths/bytes/modes/hashes from D/T32-first-HOST-candidate-preserved/inventory.json. That earlier callback edited only53-32; its freeze remains historical. This revision changes only the five plans declared in Current amendment; other source/state/evidence stays frozen. No commit, provider, build, install or product test execution during planning.\n\nD/T32-first-HOST-failure-authenticated.json retains genuine receipt verification/native original SHA-2561797a6eb20db54665a4cc693d77fde1cdcfccc22922f5c896f453265313b8850: publish PASS; delivery/runtime/adapter ETIMEDOUT600; remaining14 not run; no commit. Independent FULL diagnostics D/T32-first-host-local-diagnostic.log and D/T32-first-runtime-adapter-local-diagnostic.log both terminated at600 seconds. The first reached v3 failed-unit near the end of185 residual definitions (D/T32-residual-diagnostic-case-progress.json); the second reached automatic original recorded integrator outcome-write. No assertion failure was observed; neither diagnostic passed. The old baseline timeout and prior action-location inference do not explain away these independently observed remaining bottlenecks. Do not replay the unchanged first layout or reopen a scope/research loop.\n\nImplementation source is actual delivered E plus the frozen first W32 candidate as an unaccepted mechanical layout. Compare every original callback against E, and delivery allocation against the actual first-candidate inventory as well; never treat that candidate's claimed346 delivery cases as a self-authenticating expectation. No unmerged T31 source may be borrowed. Preserve the archived14 T31 product owners and all of PLAN31's normatives, dependency and exact commands unchanged.\n\nRead E/tests/unit/codex-runtime-host.test.cjs (171287 bytes, SHA-256d058438845ba79fe7a942e81544019bdf77f497609876cc4ae364e8f71d8a38e): originalRuntimeCases wrapper9\u201316; root-relative captured native fixtures51\u201364; serial block1531\u20132559, especially completedCases1534\u20131540, real fixture1745\u20131924, complete role/fault groups2481\u20132522 and originalRuntimeCases.push(completedCases)2559; codeReviewRuntimeFixture2596\u20132639 awaits originalRuntimeCases at2597 before os.homedir mutation. These barriers protect real process-global state. Preserve their causal purpose through explicit runner-local prerequisites/queues, not by deleting await expressions. Source callbacks retain their original same-custody lifecycle and exact native captured parent/child data, scope/constants/current-record/schema/semantic-credit refusals.\n\nRead E/tests/unit/codex-delivery-host.test.cjs: signing/env/queue66\u2013117; originalFixerFixture2163\u20133275; matrices3279\u20133343/3483\u20133485; original code-review selection/fixture3792\u20134091; v2 path4093 onward; eight historical cases4274\u20134278; codexPartitionFixture4345\u20134485 and v3 cases4487\u20134617; original selectors/counts4619\u20134623. Line shifts do not replace declaration identity. Preserve the actual literal codexPartitionFixture declaration and next-declaration extraction boundary used by phase49-incremental-integration.test.cjs:694\u2013707/:733, which remains unowned.\n\nOnly two delivery loading seams change: phase49-package-publication.test.cjs:1492\u20131544 exact selected-name/callback list, Module import redirection and incremental source remap; phase53-z23-verification-owner-heartbeat.test.cjs:40\u201358 fixture loading with unchanged Z23_CANDIDATE finalizer override and caller script root. Existing W32 helpers already expose createDeliveryFixture/createDeliveryLifecycle and registerTests; extend their readable definitions/context rather than invent another API. Add helpers/phase53-runtime-fixture.cjs with an analogous explicit context; helpers contain definitions, actual original callbacks live in physical owners.\n\nBroad reference search: rg -n 'codex-runtime-host\\\\.test\\\\.cjs|codex-delivery-host\\\\.test\\\\.cjs' . --hidden, excluding .git/node_modules/.planning/.shipyard/generated package mirrors, found runtime references only in phase47 file lists, pipeline-config literal argv, captured registry provenance, frozen weights and audit records. No runtime source-slice consumer was found. Delivery has the two loading seams plus the literal partition extractor above. These file-list/provenance/weight records stay unchanged; a newly discovered functional consumer outside14 owners is an exact scope finding before writing it.\n\nscripts/package-shipyard-codex.cjs:9\u201323/:32\u201368 enumerates root scripts and delivery-pipeline/capabilities inputs, excluding tests/unit. Therefore no generated/product owner or identity edit is authorized. Task3 still proves full package equality/cold consumption independently. Discovery Level0/internal CommonJS; no external dependency. Actual estimate-calibration returned factor1/sample_count0/confidence low; raw90000\u00d71=90000 tokens for three5/5/5-file tasks sharing only g. This estimates context, never wall time or runtime fit.\n\n## Delivery order and exact ownership\n\nPlan the graph29 wave25\u219234 wave26\u219232 wave27\u219233 wave28\u219231 wave29\u219230 wave30. Graph stays frozen during this five-plan amendment; coordinator admission/Gate2 follows independent checker. W32's first implementation stays frozen during planning. Normal coordinator delivery later prepares the new candidate through supported native custody, preserves first failed evidence, and checks all20 commands on its final unchanged tree. After32 lands,31 restores only its archived14 product owners through supported clean preparation/merge and rechecks its original full purposes plus seven runners/two consumers on its final changed product tree. No32 or first-candidate result carries to that tree. PLAN31/30's original semantic/recovery/native/CI obligations remain exactly as written.\n\nOwnership is exactly the existing12 plus tests/unit/codex-runtime-host.test.cjs and tests/unit/helpers/phase53-runtime-fixture.cjs. Task1 owns three helpers plus c/d (5); Task2 owns a/b/e/f/g (5); Task3 owns two residual old suites, two actual consumers and g's final new checks (5). New runners may be assembled before final cutover, but no intermediate duplicate/incomplete global inventory is claimed accepted: all default/full feedback waits for Task3's atomic source-allocation cutover and complete exact-union check. Each task has a real whole-runner check. No generic assert-harness, adapter, production/package owner, manifest, selector, workflow, weights or filename change.\n\n### Fixed additional whole-case allocation\n\nKeep the first candidate's original fixer allocations in a/b and ALL eight historical lifecycles in c\u2013g unchanged. Historical filenames remain intentional; extra purpose is documented here and in explicit registration metadata. D below means original delivery module; R means original runtime module. E line ranges identify source only; the retained pre-edit declaration/parameter/body inventory is authoritative. Every callback remains whole, with its original arrays/parameters; restricting an original loop to an explicitly assigned set of its original parameter values is physical allocation, never a runtime name filter. Do not partition by ordinal parity, arbitrary case limit or guessed timing. This allocation separates source-defined heavy paths while retaining large a/b matrices. Fit is unproved until native executor/HOST outcomes.\n\n| Runner | Preserved first-candidate allocation | Additional D allocation | Additional R allocation |\n|---|---|---|---|\n| z29a-fixer-original-custody | Exact original custody/outcome/schema/publication-loss/action/actor/companion matrices | code-review builder request3810 and argument validation4050; v3 caller-authority4609 (three complete callbacks) | Entire original recorded arch-review cold refusal loop2519\u20132521, all eight mutation values |\n| z29b-fixer-source-history | Exact normalization/signed-repeat/source/scope/issue-history matrices | None | Entire original recorded integrator cold refusal loop2519\u20132521, all eight mutation values |\n| z29c-historical-direct | direct BOTH normalized-repeat/normalized-covered-source lifecycles | All eight code-review config success cases3928\u20133954 | arch-review completed progress live/cold2504\u20132506, orphan2507\u20132508 and all live/cold\u00d7eight receipt-reconciliation faults2509\u20132513 |\n| z29d-historical-admitted | admitted BOTH original mutations | All native-session refusal cases3956\u20133965, seal-drift cases3998\u20134023, semicolon preflight4058\u20134076 and wrapper live-change cases4078\u20134091 | integrator counterparts of c's progress/orphan/reconciliation allocation, all original parameters |\n| z29e-historical-pending | pending BOTH original mutations | private preparation3792; all caller-authority3967\u20133973, padded-role3975\u20133985, padded-request3987\u20133996 and prepared-context4025\u20134048 cases | Entire arch-review role block2481\u20132501: unused/unmeasured reservation, concurrent probe, missing ledger, five substitutions, pending probe and three partial-final faults |\n| z29f-historical-action-repeat | Whole action/normalized-repeat lifecycle | Whole v2 shared-preparation4093 path and both v3 positive cases4487\u20134564 | Entire integrator role block2481\u20132501 plus its automatic-original live/cold\u00d7three faults2514\u20132516 and dead-owner controller2517\u20132518 |\n| z29g-historical-action-covered | Whole action/normalized-covered-source lifecycle | All15 original v3 behavior-only refusal scenarios4566\u20134607 | arch-review automatic-original live/cold\u00d7three faults2514\u20132516 and dead-owner controller2517\u20132518 |\n\nExactly44 original code-review entry cases, all18 original v3 cases and the v2 case are assigned above; original44/8/1/1 selection semantics remain available via explicit registration across physical owners. R allocation moves94 expanded role-recovery cases (8+8+19+19+13+20+7); independently derive these counts from E before relying on them. Every other original D/R declaration remains in its respective physical residual. Preserve residual queues, local dependency barriers and unchanged original entry behavior; neither old file imports all runners for execution.\n\n<tasks>\n\n<task type=\"tracer\" tdd=\"true\">\n  <name>Task 1: Prove original delivery and runtime recovery through inert fixtures and c/d physical owners</name>\n  <files>tests/unit/helpers/phase53-delivery-fixture.cjs, tests/unit/helpers/phase53-original-fixer.cjs, tests/unit/helpers/phase53-runtime-fixture.cjs, tests/unit/phase53-z29c-historical-direct.test.cjs, tests/unit/phase53-z29d-historical-admitted.test.cjs</files>\n  <behavior>\n    - RED: a complete original arch-review outcome-write recovery runs through real fixture/native/recorder/cold-consumer custody in c, retaining the entire original callback, before expanding to all c/d allocations.\n    - Imports and explicit collection from three helpers/c/d create no fixture, signing key, child process, environment mutation, hook, harness done or test execution.\n    - Original D/R expanded names/arrays/parameters/callback/assertion bodies are inventoried before edits with original-module tags; c/d preserve both historical mutations and every assigned whole extra case.\n    - Per-runner originalRuntimeCases/completedCases barriers retain prerequisite ordering and prevent concurrent os/fs/environment mutation across delivery/runtime fixture families.\n  </behavior>\n  <action>\nPer D-01/D-03/D-05/D-06/D-07/D-08 and F53-01/06/08/09/10/11/12, first capture BOTH entire original E suites before editing any source layout: original module, declaration identity, expanded name, each original array/parameter value, callback/assertion body and narrowly documented mechanical path/context substitutions. Preserve multiplicity and original source digests. Independently reconcile D with the actual first W32 layout (old residual plus seven original declaration owners), using D/T32-first-HOST-candidate-preserved/inventory.json to authenticate its bytes. Capture R from actual E source, not a newly invented expected name list or an already relocated registry. Keep self-contained literal provenance data in the new owned runners; no delivered test depends on external C/E/W/D paths. Original inventory excludes new meta checks. Later exact union comparison keys on original module plus declaration/parameter identity so identical names across modules never collapse in a Map. Retain every original assertion/parameter and all eight historical same-candidate lifecycles.\n\nStart RED in c with the ACTUAL original arch-review receipt-recovery outcome-write callback calling phase49-review-continuation.test.cjs completedSourceReceiptRecoveryFixture with its original role/cold/fault arguments. Exercise the real full scenario, including original result reconciliation, rather than replacing it with a shortened synthetic success. Stub only original physical native/remote boundaries; actual signed recorders, native captured parent/child evidence, source/current/schema/semantic-credit refusals remain. Then implement the entire c/d assignments from the fixed allocation table, including both original direct/admitted historical mutations and the complete additional delivery/runtime callbacks. The whole c/d commands, not a selector, prove the two-stack tracer against E product.\n\nExtend the actual readable delivery fixture/original fixer helper definitions from the frozen candidate, mechanically retaining original fixture implementation and creating no product API. Add helpers/phase53-runtime-fixture.cjs by moving readable shared runtime definitions/constants from E, with explicit createRuntimeFixture/createRuntimeLifecycle context exports analogous to existing createDeliveryFixture/createDeliveryLifecycle. No original test callbacks/registration arrays hide in helpers; actual declarations belong to physical owners. No monolith source-string selector, VM loader, opaque evaluator, new generic framework, harness edit or adapter/production edit. A caller requiring any helper/owner receives definitions only; explicit registerTests collection submits callbacks without setup or execution. Native fixture registry reads and other effectful preparation occur only inside explicit lifecycle, not module import.\n\nResolve repository root from helpers' true depth, preserving original tests/fixtures/captured registry/templates, original native parent/child identities and nested phase49-review-continuation relative imports. Inject original scripts/import roots only through existing fixture seams; packaged consumer redirection remains authoritative. Do not make a copied helper resolve tests/fixtures under tests/unit/helpers or change original captured fixture provenance.\n\nEach physical owner creates one isolated explicit lifecycle, physical HOME/CODEX_HOME/GNUPGHOME/signing state and runner-owned serial execution context. Preserve delivery environment restoration exactly, including present-versus-absent HOME, CODEX_HOME, GNUPGHOME, GIT_CONFIG_GLOBAL, GIT_CONFIG_NOSYSTEM and SHIPYARD_COVERAGE_ROOT. Restore os.homedir, fs patches, listeners, serial promise queues and owned temporary resources in finally/on-completion; kill only the runner's own GPG agent. Export inert definitions/context, never a second production host API.\n\nThe runtime wrapper9\u201316 tracks prior asynchronous cases; completedCases1534\u20131540 waits before the serial block; push2559 makes that block a prerequisite of codeReviewRuntimeFixture's await2597. Translate these to explicit runner-local pending-original and completed queues. A runner mixing delivery/runtime cases serializes the process-global fixture sections and awaits its real local predecessors before any code-review HOME mutation. Preserve ordering of the original dependent phases; independent whole cases moved to another process need their actual shared-state prerequisite made local, not a cross-process fictional promise. Preserve each same-custody original lifecycle within a single callback. Never remove the await and claim equivalent coverage; new c/d tests must demonstrate a deferred predecessor blocks fixture mutation until it settles, error paths restore state and one runner cannot clean another's home.\n\nAssemble c/d while residual cutover remains assigned to Task3. Do not claim global default uniqueness or reuse any first-candidate PASS at this stage. Run each complete c/d command with unchanged case180000/concurrency2/HOST600/child8MiB limits. A retained single original scenario failure/timeout remains a failed task until its actual owned fixture cause is fixed with every assertion intact; no omission, skip or cap increase.\n  </action>\n  <verify>\n    <automated>node --test tests/unit/phase53-z29c-historical-direct.test.cjs\nnode --test tests/unit/phase53-z29d-historical-admitted.test.cjs</automated>\n  </verify>\n  <done>Both complete c/d runners pass against E product with exact original historical/extra callbacks, module-tagged pre-edit provenance, inert readable helpers, true root resolution and demonstrated local barrier/cleanup behavior. No full-suite/candidate fit is claimed before final cutover.</done>\n</task>\n\n<task type=\"auto\" tdd=\"true\">\n  <name>Task 2: Complete the remaining five physical allocations without changing original lifecycles</name>\n  <files>tests/unit/phase53-z29a-fixer-original-custody.test.cjs, tests/unit/phase53-z29b-fixer-source-history.test.cjs, tests/unit/phase53-z29e-historical-pending.test.cjs, tests/unit/phase53-z29f-historical-action-repeat.test.cjs, tests/unit/phase53-z29g-historical-action-covered.test.cjs</files>\n  <behavior>\n    - All original a/b matrix allocations and pending/action historical lifecycles remain complete; extra original D/R source groups equal the fixed table exactly.\n    - Registration inventories preserve module/declaration/parameter/name/body/multiplicity and do not register a scenario twice across physical owners.\n    - Helpers and every registration import are inert; runner-local lifecycle, queue/prerequisite barriers and cleanup isolate all extra delivery/runtime callbacks.\n  </behavior>\n  <action>\nPer D-01/D-03/D-05/D-06/D-07/D-08 and F53-06/08/09/10/11/12 start new allocation/barrier/import checks RED in these five existing new physical owners. Preserve the original first-candidate a/b allocations exactly: a's custody/outcome/schema/publication-loss/action/actor/companion matrices and b's normalization/signed-repeat/covered/uncovered source/scope/issue history. Preserve e's BOTH pending historical mutations; f's whole action/normalized-repeat; g's whole action/normalized-covered-source including genuine original executor custody. Every historical signed/native/tamper/recovery same-candidate sequence remains atomic and unchanged.\n\nInstall every additional whole declaration specified for a/b/e/f/g in the fixed table. Use explicit original parameter sets/arrays and retain callbacks/assertion bodies; preserve both live/cold values, all eight reconciliation fault values, all original refusal mutations and both role families exactly where assigned. f receives the integrator role's unmeasured and automatic recovery groups; e receives arch-review unmeasured; a/b receive their respective cold refusal matrices; g receives arch-review automatic/controller plus all15 v3 refusal scenarios. Do not distribute by ordinal, leave hidden callback selection in old files, duplicate declarations, trim a scenario or split one custody lifecycle. Filenames remain z29a\u2013g and their original complete allocations remain visible despite extra purpose.\n\nUse the three Task1 readable contexts. Every owner exports inert explicit registration and has an ordinary direct-entry lifecycle with its own queue/prerequisite context. Source/runtime constants and nested helpers keep their original root/provenance. All new assertions, module-tagged original provenance, callback/parameter equivalence and per-runner nonempty allocation checks reside in the seven new physical files, never as assertion growth in old suites. Store the full expected original inventories self-contained from Task1's authenticated pre-edit data; compare parameter/body fingerprints, not just case counts or two post-edit registries. The new meta checks are a separate inventory.\n\nIn new g retain authenticated self-contained pre-edit D/R provenance and per-owner allocation checks. The former delivery-only global union checks are superseded by Task3's complete D+R checks in this same new file; do not try to execute an unconverted runtime registration before final cutover. Preserve all original product assertions; these new layout meta checks evolve with the real layout. Ordinary old suite execution must never aggregate moved runners. Task3 owns the final global-union/negative/prefix/package checks and runs the complete g command again.\n\nRun each whole a/b/e/f/g command under unchanged case180000/concurrency2/child8MiB/HOST600/native1MiB/result128KiB/TTL bounds. Record actual failures, including any individually over-budget case, and fix only actual owned fixture defects without reducing original assertions or borrowing T31 product. These tests grant no real provider/installed/native phase acceptance. Defer global default/full companion feedback until Task3 cutover; no first-candidate or per-runner pass credits the final tree.\n  </action>\n  <verify>\n    <automated>node --test tests/unit/phase53-z29a-fixer-original-custody.test.cjs\nnode --test tests/unit/phase53-z29b-fixer-source-history.test.cjs\nnode --test tests/unit/phase53-z29e-historical-pending.test.cjs\nnode --test tests/unit/phase53-z29f-historical-action-repeat.test.cjs\nnode --test tests/unit/phase53-z29g-historical-action-covered.test.cjs</automated>\n  </verify>\n  <done>Five whole runners pass with their intact original matrices/historical lifecycles plus every assigned extra D/R scenario. Self-contained original inventories, inert import/registration and per-runner local barrier/cleanup checks exist in new physical owners. Final residual-union/consumer feedback remains Task3.</done>\n</task>\n\n<task type=\"auto\" tdd=\"true\">\n  <name>Task 3: Cut over both residuals and exact consumers, then verify the final complete candidate</name>\n  <files>tests/unit/codex-delivery-host.test.cjs, tests/unit/codex-runtime-host.test.cjs, tests/unit/phase49-package-publication.test.cjs, tests/unit/phase53-z23-verification-owner-heartbeat.test.cjs, tests/unit/phase53-z29g-historical-action-covered.test.cjs</files>\n  <behavior>\n    - The two ordinary old files execute their complete physical residuals; original D/R inventory equals residuals+seven exactly, without moved-runner aggregation/default duplication.\n    - All44/8/1/1 original delivery selector/count/invalid-argument semantics and the literal partition extractor boundary remain compatible.\n    - Both actual delivery loading seams retain precise callbacks, import remapping, finalizer override and caller root; runtime residual local queues preserve original causal ordering.\n    - All20 complete same-final-tree HOST600 commands pass, with exact first51\u219262/future selection and unchanged whole generated package/two identities/cold/tamper coverage.\n  </behavior>\n  <action>\nPer D-01/D-03/D-05/D-06/D-07/D-08 and F53-01/06/08/09/10/11/12 complete the mechanical cutover against Task1's actual E inventories and frozen first W32 allocation: remove only original callbacks now allocated to seven owners and move only shared definitions already represented in the three inert helpers. Old assertion/callback bodies remain mechanical preservation; add no assertion in these four old test files. All new assertions live in the seven new owners; this task finishes their global proof in g. Two old files become inert definition/registration modules on require and physical residual runners on direct execution. Neither imports/executes all moved runners. Every unallocated original callback remains exactly in its original residual file.\n\nRuntime default entry creates its own explicit context and preserves its original pending asynchronous cases, completedCases serial block and codeReviewRuntimeFixture prerequisite barrier, now over locally registered predecessors. Keep root-resolved captured registry/parent/child fixtures, real current-record/schema/custody/semantic refusals and complete callback lifecycles. There are no runtime text-slice consumers in the inspected tree; do not create one, edit phase47 file lists/config argv/registry/weights, or add an adapter owner. Enforce new import/queue/cleanup/root/module-tagged residual-union checks through the new owners.\n\nPreserve the literal old codexPartitionFixture declaration and its exact extraction end boundary for unchanged phase49-incremental-integration.test.cjs. Move other required delivery support definitions readably, leaving that compatibility declaration unchanged rather than replacing its body with a helper wrapper. Adapt original opt-in registration to explicitly collect its same original selections across D residual+seven with caller-owned collection/lifecycle only; default no-argument residual never aggregates. Preserve original modes, invalid arguments and exact selected names/44-entry/8-variant/1-default/1-legacy checks, transferring existing checks mechanically if their original physical placement would otherwise count only a residual. A partial mode is never accepted as full-suite verification.\n\nPreserve delivered34's exact eleven-role callback collection and inert helper imports unchanged. Change phase49-package-publication ONLY at its actual delivery fixture-loading seam1492\u20131544 to collect inert D residual plus all seven physical owners using explicit contexts; retain its original selected-name array, all selected callbacks, canonical\u2192packaged Module import redirection and incremental-integration source remap. R additions must not collide with selected D names or execute accidentally. Real packaged imports use the cold generated package, never canonical source by wrong-root accident. Change z23 ONLY at its existing text-sliced fixture-loading seam40\u201358 to explicit inert definitions, retaining its temporary/signing lifecycle, finalizeCommit Z23_CANDIDATE refusal and configured caller scripts root. No new generic loader, source-string callback evaluator, new framework or broadened consumer behavior.\n\nWrite RED then run the final exact-union and deliberate missing/duplicate/body/parameter-tamper negative checks in new g against BOTH original E inventories and independently against first-candidate D provenance: every original module/declaration/parameter/name/body exactly once across its residual+allocated owners; all eight historical lifecycles intact, no extra/missing/duplicate/empty allocation. Include inert import/registration of both residuals, three helpers and seven owners, with no child/signing/env/native/harness/exit effects. Exercise deferred barrier rejection/settlement, exact present/absent environment restoration, own-agent cleanup and true repository/fixture/package root behavior.\n\nRetain original prefix/selector proof in the new owners using unchanged unitFiles/unitTasks/appendShard/selectTaskShard. Preserve baseline16, first50 compact-JSON SHA-256b6268014b4ae96454730fc1ee45a956acd518836daf2f787af6d6bdd73a02604 and all first51 rows and delivered34's exact t/u/v/w rows as an ordered subsequence after a\u2013g insertion. Existing exact z29a\u2013g singleton names sort after delivered z29 and before future T31 x/y/z and z30. The new runtime helper is not an eighth test/shard; original runtime residual stays in its old row. Actual34 yields55/58,32 yields62/65,33 adds h/i yielding64/67,31 adds x/y/z yielding67/70 and30 adds six yielding73/76. First58 a\u2013g remains an exact prefix; t/u/v/w follows it at32. At33 first60 a\u2013i is exact, then t/u/v/w; do not confuse the full prior roster with an unchanged prefix. Iterate every actual/future row with actual.shards.length/next.shards.length and a real disposable future task changing the denominator; no manifest/workflow/weights/selector edit or first54-as-full-prefix shortcut.\n\nUse the real whole supported builder only in disposable test destinations. Source-confirm every enumerated builder input excludes all14 test owners. Independently compare exact full package relative paths/types/modes/bytes and both plugin.json/package-build identities between delivered-baseline package copied from unchanged checked-in plugins/shipyard and regenerated candidate. Actual cold packaged consumers and tamper refusals must pass. Tests remain self-contained, without external E checkout. Product mirrors/identities stay byte-identical; contrary actual builder input evidence is an exact scope finding before any product write.\n\nFinally run 20 publish-first commands below on ONE final unchanged tree. The first complete companion group runs both physical residuals plus adapter; the second original delivery companion purpose still runs its residual. Their moved original purposes are supplied by the SAME complete seven-runner set, with explicit module-tagged coverage for both original suites. Complete phase49/z23 consumers and all other original groups remain owed. No filters, shallow CASE limits, broadened command/profile/admission/timeout, cap increase, native scope change, stale first-candidate credit or omitted original scenario. If any residual/whole runner still times out, retain actual failure and fix only concrete owned fixture causes with all original assertions intact; do not claim fit or retry an unchanged layout as success.\n  </action>\n  <verify>\n    <automated>node plugins/delivery-pipeline/scripts/publish-gate.cjs --base origin/main --working-tree --json\nnode --test tests/unit/codex-delivery-host.test.cjs tests/unit/codex-runtime-host.test.cjs tests/unit/codex-dispatch-adapter.test.cjs\nnode --test tests/unit/phase53-z29g-historical-action-covered.test.cjs\nnode --test tests/unit/phase49-package-publication.test.cjs\nnode --test tests/unit/phase53-z23-verification-owner-heartbeat.test.cjs\nnode --test tests/unit/phase53-z29t-role-architecture-archives.test.cjs\nnode --test tests/unit/phase53-z29u-role-containment.test.cjs\nnode --test tests/unit/phase53-z29v-role-code-review.test.cjs\nnode --test tests/unit/phase53-z29w-role-integration.test.cjs</automated>\n    <human-check>Normal delivery requires current-head human APPROVED review before guard merge. All20 final-tree commands, actual currentCI and independent/native phase acceptance remain separate owed outcomes; fixture success supplies no native phase credit.</human-check>\n  </verify>\n  <done>Both original suites equal complete physical residuals+seven with intact assertions/lifecycles/local barriers, exact selectors/extractor/two loading seams and root/inert/cleanup proof. All20 final-tree HOST600 commands, frozen prefix/future selectors and unchanged full package/two identities/cold/tamper checks pass before32 delivery. Any failed/unknown fit remains reported as failure/unknown.</done>\n</task>\n\n</tasks>\n\n## Verification commands\n\n- `node plugins/delivery-pipeline/scripts/publish-gate.cjs --base origin/main --working-tree --json`\n- `node --test tests/unit/codex-delivery-host.test.cjs tests/unit/codex-runtime-host.test.cjs tests/unit/codex-dispatch-adapter.test.cjs`\n- `node --test tests/unit/pipeline-config.test.cjs tests/unit/phase-code-review.test.cjs tests/unit/deliver-dispatch.test.cjs`\n- `node --test tests/unit/run-contract.test.cjs tests/unit/run-store.test.cjs tests/unit/run-controller.test.cjs tests/unit/model-policy.test.cjs tests/unit/marketplace-install.test.cjs tests/unit/run-scope.test.cjs tests/unit/codex-delivery-host.test.cjs`\n- `node --test tests/unit/role-artifact.test.cjs tests/unit/judgment-artifacts.test.cjs tests/unit/judgment-contract.test.cjs`\n- `node --test tests/unit/phase53-immutable-reuse.test.cjs tests/unit/host-verification.test.cjs`\n- `node --test tests/unit/phase53-review-recovery.test.cjs tests/unit/phase-code-review-publish.test.cjs`\n- `node --test tests/unit/phase53-z29a-fixer-original-custody.test.cjs`\n- `node --test tests/unit/phase53-z29b-fixer-source-history.test.cjs`\n- `node --test tests/unit/phase53-z29c-historical-direct.test.cjs`\n- `node --test tests/unit/phase53-z29d-historical-admitted.test.cjs`\n- `node --test tests/unit/phase53-z29e-historical-pending.test.cjs`\n- `node --test tests/unit/phase53-z29f-historical-action-repeat.test.cjs`\n- `node --test tests/unit/phase53-z29g-historical-action-covered.test.cjs`\n- `node --test tests/unit/phase49-package-publication.test.cjs`\n- `node --test tests/unit/phase53-z23-verification-owner-heartbeat.test.cjs`\n- `node --test tests/unit/phase53-z29t-role-architecture-archives.test.cjs`\n- `node --test tests/unit/phase53-z29u-role-containment.test.cjs`\n- `node --test tests/unit/phase53-z29v-role-code-review.test.cjs`\n- `node --test tests/unit/phase53-z29w-role-integration.test.cjs`\n\n## Admission and planning boundary\n\nAll16 original exact commands remain verbatim in the Verification commands list, plus four complete T34 physical commands, for20. All old physical residual/judgment commands and the moved union run on this final combined tree. SOURCE planCommands/assignPlan uses actual loadConfig(C)/repoValue verification_commands214; only missing exact {argv,profile:host,timeout_s:600} rows are provisional in memory. Preserve all214 existing rows/settings, host600 and assignment bounds; coordinator admission follows independent checker.\n\nRead-only planning validation: actual GSD frontmatter.validate --schema plan and verify.plan-structure; actual E Source parser/dependency/ownership checks across all34 plans with the amended dependency depths; current PLAN32 UTF8<=60000; actual E plan-delivery.deliverPlan with canonical C graphDir, actual current T-53-32 graph row/current plan SHA and real W32 outside C, exercising the delivered-plan branch rather than its in-worktree shortcut. Keep exact validator warnings;14-file scope warning is nonblocking below mandatory15. The coordinator rationale is one mechanical two-suite relocation across existing physical owners, not an exemption or VERIFICATION_PASSED claim. Other existing warnings and high-risk/current-head review are unchanged. The previously documented unordered53-04/53-08 ownership overlap is unchanged; compare against the frozen prior PLAN32 and report it rather than rewriting unrelated delivered plans.\n\nF/T32-test-prerequisite-checker-authenticated.json retains the exact original ISSUES_FOUND/revision_required report and its three scope_sanity warnings:32 twelve files,31 fourteen and30 ten met the ten-file warning threshold, below the mandatory fifteen-file blocker. Original wording/receipt/coordinator disposition remain unchanged; this amendment does not relabel that report. Current32 owns fourteen, so the warning remains applicable with a refreshed count. Its two extra owners are the actual runtime residual and readable runtime helper needed to repair the independently observed full runtime timeout; all14 owners form one original-suite/consumer cutover, three tasks and90000/100000 calibrated low tokens. PLAN31/30 warnings/rationale and current-head review remain owed exactly as before. A fresh independent checker assesses the amendment; no mandatory blocker is waived.\n\nRetain F's39 historical freeze records; compare all still-immutable entries excluding the five authorized plan amendments. Freeze the other29 plans, research516575/config214/contexts/graph/GSD/C/E heads and every original preserved12/14-file T32 candidate hash/size/mode. Preserve every original downstream source obligation and exact HOST command while applying only the authorized34 wiring/count/roster amendments; all other29 plans remain byte-identical. Planning runs no product/tests/build/install/provider/config/graph/research/GSD/PR/commit action. Independent checker follows the complete five-plan amendment.\n\n<threat_model>\n## Trust boundaries\n\n| Boundary | Description |\n|---|---|\n| Two original suites \u2192 two residuals/seven owners | Original-module/declaration/parameter/body multiset, not counts or names alone, grants complete coverage |\n| Inert definitions \u2192 explicit runner lifecycle | Runtime/delivery queues, HOME/os/fs/signing effects and cleanup stay owned by the executing physical runner |\n| Package/z23 loader \u2192 exact original callbacks | Selected-name/canonical-package redirection/finalizer/caller-root semantics stay unchanged |\n| Physical discovery \u2192 unit/CI selection | Same seven names preserve actual frozen prefix and exhaustive current/future rows |\n| Unit-only source \u2192 product/evidence | Actual builder input proof/full cold package equality prevents product changes or fictional acceptance |\n\n## STRIDE threat register\n\n| Threat ID | Category | Component | Severity | Disposition | Mitigation plan |\n|---|---|---|---|---|---|\n| T-53-32-01 | Tampering | Both original suite allocations | high | mitigate | Tasks1\u20133 authenticate E/pre-edit D+R body/parameter inventories and first W32 D provenance; exact module-tagged union/eight whole historical lifecycles |\n| T-53-32-02 | Elevation of privilege | Runtime/delivery fixture lifecycle | high | mitigate | Three readable inert helpers; explicit per-runner queues/barriers, own HOME/GPG/env/os/fs restoration, no import signing/native/test/hook effects |\n| T-53-32-03 | Spoofing | Original packaged/z23 consumers | high | mitigate | Task3 exact D residual+seven explicit collection, original selected callbacks/remap; z23 finalizer/root and literal partition extractor preserved |\n| T-53-32-04 | Denial of service | Two residuals/seven whole runners | high | mitigate | Fixed source-group physical allocations, unchanged180000/concurrency2/8MiB/HOST600 bounds; actual final-tree failures retained, never omitted or labelled passed |\n| T-53-32-05 | Tampering | Prefix/current-future discovery | high | mitigate | Task3 frozen16/50/51, first58 a\u2013g plus34's four=62; actual full dynamic row traversal/default once; original opt-in modes remain partial selections |\n| T-53-32-06 | Repudiation | Verification/phase claims | high | mitigate | Twenty final-tree whole commands; neither first candidate nor planning grants fit;31 rechecks its changed tree; R8/native phase credit unchanged |\n| T-53-32-07 | Tampering | Product/package scope | high | mitigate | E production unchanged; whole real-builder inventory/two IDs/cold/tamper equality and14 exact test owners only |\n| T-53-SC | Tampering | npm/pip/cargo installs | high | mitigate | No dependency/install; later package proposal requires separate legitimacy protocol |\n</threat_model>\n\n<verification>\nFourteen exact owners, three tasks and20 complete publish-first HOST600 commands must pass on one unchanged FINAL candidate. Require both original E inventories versus two residuals+seven exact module-tagged union, preserved eight historical lifecycles and every whole additional D/R allocation, inert isolation/local barriers/root/cleanup, both precise consumers/literal extractor/original opt-ins, frozen prefix/full selectors and whole package/two identities/cold/tamper equality. Every old companion invocation still runs its physical residual; all seven whole commands supply the relocated purpose of BOTH suites. No source selector substitutes for complete physical coverage.\n\nNormal source/code review/independent integrator/target-required architecture/currentCI/current human review remain real delivery obligations. Ticket-to-epic architecture is skipped-by-target; integration-target review stays fresh. Preserve original unsuccessful/interrupted evidence, R8 INCOMPLETE/zero semantic credit and unknown actual Anthropic/native phase acceptance. Accepted internal fixes precede external-review-triggering PR open; recheck any open-time property immediately before open. PLAN33/31/30 retain complete original product purposes and exact commands while adding34 consumer rechecks on each changed tree. No ticket completion marks phase acceptance.\n</verification>\n\n## Multi-source coverage audit\n\nCOVERED assigns work, never executed acceptance. Unchanged plans retain all product duties.\n\n| Source | Item | Assignment | Status |\n|---|---|---|---|\n| GOAL | Both runtimes/five approved delivery areas/complete normal review | Test prerequisite32; unchanged01\u201331 retain all product obligations | COVERED |\n| REQ | F53-01/06/08/09 | Original fixture/coordinator/native/custody/recovery/current-cold semantics and actual shared support | Tasks1\u20133 | COVERED |\n| REQ | F53-10/11/12 | Complete original purposes, unchanged bounds/truthful outcomes, delivery-only scope | Tasks1\u20133; native acceptance stays with original product plans | COVERED |\n| REQ | F53-02/03/04/05/07 | Semantic/runtime/preparation/CI obligations | Unchanged01\u201331; no32 feature | COVERED |\n| RESEARCH/evidence | Actual full delivery residual and independent runtime/adapter timeout600 | Fixed whole source-group D/R allocations across same seven; final two residuals+seven checks | COVERED |\n| RESEARCH | Both original expanded inventories/names/arrays/params/callback/assertion bodies and multiplicity | Tasks1/2 authenticate E and first W32 D; Task3 exact original-module union | COVERED |\n| RESEARCH | Eight original historical lifecycles and existing a/b matrices | Fixed table/Tasks1\u20133 mechanical preservation | COVERED |\n| RESEARCH | Inert readable helpers; originalRuntimeCases/completedCases/codeReviewRuntimeFixture barriers | Task1 runtime context, Task2 whole owners, Task3 physical residual queues/root/cleanup | COVERED |\n| RESEARCH | Default residuals not aggregators; original opt-ins; exact packaged/z23/extractor seams | Task3; broad reference search found no additional runtime consumer | COVERED |\n| RESEARCH | Frozen16/50/51;34\u219255;32\u219262;33\u219264;31\u219267;30\u219273, actual future selectors | Task3 same7 filenames plus delivered34's four rows; precise actual/full rosters and downstream insertions | COVERED |\n| RESEARCH | Builder inputs/full inventory/two identities/cold/tamper | Task3 real supported builder in disposable test destinations;14 unit-only owners | COVERED |\n| RESEARCH/checker | Mandatory15-file bound, short actual delivered plan, exact existing admission |14 owners/three5/5/5-file tasks (g shared for final assertions), actual<=60000/assignPlan config214/deliverPlan checks; no waiver | COVERED |\n| CONTEXT | D-01/D-03/D-05/D-06/D-07/D-08 | Objective/actions preserve history/actual source/native truth/resources/existing coordination | COVERED |\n| CONTEXT | D-02 full originals/independent final | Original callbacks retained; actual semantic/final product duties unchanged01\u201331 | COVERED |\n\nD-04 remains superseded by D-05. Deferred/excluded: research/planning optimization, new general scheduler/cache/retry/verification framework, model/provider changes, independent CI/shard platforms, broad live campaigns and hypothetical tickets.\n\n## Rollback\n\nSupported coordinator rollback restores exactly14 test-layout/loading owners and the complete original D/R default suites, with original evidence/failed first W32 and archived14 T31 owners preserved. Restore whole callbacks/barriers; no missing case, fake pass or foreign-state cleanup. Product package/identities remain equal under actual builder inputs. If31 already consumes32, coordinate dependency rollback before removing its required complete regression union; changed heads re-owe normal CI/reviews. No forced published history or release authorization.\n\n<success_criteria>\nFourteen owners preserve BOTH full original suites in two default physical residuals plus the same seven complete runners, every original assertion/parameter/lifecycle/local barrier, original delivery opt-ins/extractor and precise two consumer seams. Frozen16/50/51, first58 a\u2013g plus34's four=62 and actual future selection remain exact; whole generated package/two identities/cold/tamper remain equal. All20 final-tree HOST600 commands and normal current-head gates pass before32 merge. Fit/failure/native/phase credit remain truthful; PLAN33/31/30 retain all original product/recheck obligations and exact commands, with34 wiring/counts amended.\n</success_criteria>\n\n<output>\nThis planning revision writes only new53-34-PLAN.md and amended53-32/33/31/30-PLAN.md. Typed shipyard.codex-decompose-output.v1 artifact_paths lists those five worktree-relative files; host sealing covers the full phase index. No commit/admission/state-sync. All other29 plans, research516575, CONTEXTs, config214, graph/GSD/CHEAD/EHEAD and all candidate/worktree bytes remain frozen; independent native checker follows. After later implementation the coordinator writes53-32-SUMMARY.md with authenticated original-to-physical D/R inventory/body/lifecycle mapping, actual20 final-tree command outcomes/timing/failure, inert/barrier/root/consumer proof, first51\u219262/future selectors, whole package equality and current-head delivery evidence.\n</output>\n",
  "33": "---\nphase: 53-simplify-delivery-process\nplan: \"33\"\ntitle: \"Recover provably unsent review publication and restrict legacy integration to recorded originals\"\ntype: execute\nwave: 28\ndepends_on: [\"53-32\"]\nfiles_modified:\n  - plugins/delivery-pipeline/scripts/phase-code-review.cjs\n  - plugins/delivery-pipeline/scripts/codex-delivery-host.cjs\n  - plugins/delivery-pipeline/scripts/role-artifact.cjs\n  - plugins/shipyard/host/plugins/delivery-pipeline/scripts/phase-code-review.cjs\n  - plugins/shipyard/host/plugins/delivery-pipeline/scripts/codex-delivery-host.cjs\n  - plugins/shipyard/host/plugins/delivery-pipeline/scripts/role-artifact.cjs\n  - plugins/shipyard/.codex-plugin/plugin.json\n  - plugins/shipyard/package-build.json\n  - tests/unit/phase53-z29h-publication-unsent-recovery.test.cjs\n  - tests/unit/phase53-z29i-recorded-integration-compatibility.test.cjs\n  - tests/unit/phase53-z29f-historical-action-repeat.test.cjs\n  - tests/unit/phase53-z29g-historical-action-covered.test.cjs\n  - tests/unit/phase49-incremental-integration.test.cjs\n  - tests/unit/integration-test-partitions.test.cjs\n  - tests/unit/phase53-z17-ci-job-attempts.test.cjs\nautonomous: true\nrequirements: [\"F53-01\", \"F53-04\", \"F53-06\", \"F53-08\", \"F53-09\", \"F53-10\", \"F53-11\", \"F53-12\"]\ndelivery:\n  ticket: T-53-33\n  risk: high\n  human_checkpoint: merge\n  preauthorized: true\nestimate:\n  tokens: 58000\n  raw_tokens: 58000\n  tasks: 3\n  confidence: low\nmust_haves:\n  truths:\n    - \"A status or comment attempt refused before its mutating request is invoked cannot permanently block publication at a subsequent accepted head; possibly issued operations retain original unknown/reconciliation and never blindly repeat POST/PATCH.\"\n    - \"Explicit legacy-v3 Codex integration consumes only authentic already recorded original units and final under their exact existing plan/native/session/receipt/source binding; a supplied existing or newly created plan SHA cannot authorize fresh native work.\"\n    - \"Missing original unit/final, stale or substituted original authority refuses with zero compatibility-path native launches; valid recorded completion/resealing and ordinary current/cold readers retain their original contracts.\"\n    - \"Current semantic integration still launches its actual two workers and independent final through the ordinary route. No second scheduler, registry, caller authority flag or provider/model change is introduced.\"\n    - \"All old declaration/parameter/title purposes survive the exact traceable contract promotions; the original D/R inventories, eight historical lifecycles, three opt-in selectors, six complete integration partitions and all unpromoted callbacks remain accounted for.\"\n    - \"Delivered T32 first58 a\u2013g rows remain exact; h/i insert before delivered34 t/u/v/w, yielding64 unit/67 CI;31 x/y/z yields67/70;30 six yields73/76 with actual/future denominators derived from discovery.\"\n    - \"Each original reconstruction and both original passes freshly read identical ordered raw Git facts through private bounded batches; complete packet/coverage/digest and every authority-check boundary remain unchanged, including replacements and maximum-body fallback.\"\n    - \"One unchanged candidate passes the sole local publication gate and full current-head CI covering all31 original command purposes, full139-source/>40-unit scenario and whole generated package/three mirrors/two identities/cold/tamper; diagnostics grant no native or phase acceptance.\"\n  artifacts:\n    - path: plugins/delivery-pipeline/scripts/phase-code-review.cjs\n      provides: \"Existing protected publication operation distinguishes prepared-not-issued from potentially issued\"\n    - path: plugins/delivery-pipeline/scripts/codex-delivery-host.cjs\n      provides: \"Recorded-original-only historical v3 consumer, current semantic route retained\"\n    - path: plugins/delivery-pipeline/scripts/role-artifact.cjs\n      provides: \"Private byte-framed Git batching within fresh reconstruction, unchanged separate bounds and authority timing\"\n    - path: tests/unit/phase53-z29h-publication-unsent-recovery.test.cjs\n      provides: \"Real public publication recovery/response-loss/duplicate prevention through hermetic remote boundary\"\n    - path: tests/unit/phase53-z29i-recorded-integration-compatibility.test.cjs\n      provides: \"Recorded-original fixtures, framing/refusal/budget/fallback/replacement/full-packet oracle/timing proofs and exact promotion/prefix/package checks\"\n    - path: tests/unit/phase53-z29g-historical-action-covered.test.cjs\n      provides: \"Original inventory enforcement with only explicitly enumerated promoted declarations\"\n    - path: tests/unit/integration-test-partitions.test.cjs\n      provides: \"Accepted385077bd helper suffix hash after exactly two inversions, unchanged complete107-case allocation\"\n    - path: plugins/shipyard/package-build.json\n      provides: \"Whole-builder identity matching all three changed generated mirrors and plugin version\"\n  key_links:\n    - from: plugins/delivery-pipeline/scripts/phase-code-review.cjs\n      to: tests/unit/phase53-z29h-publication-unsent-recovery.test.cjs\n      via: \"Protected original operation -> pre-send live check -> durable issued transition -> actual request -> original remote reconciliation\"\n    - from: plugins/delivery-pipeline/scripts/codex-delivery-host.cjs\n      to: plugins/delivery-pipeline/scripts/role-artifact.cjs\n      via: \"Existing exact plan/native originals -> validateIntegrationUnit/prepareIntegrationAggregate/sealJudgment -> currentIntegrationVerdict\"\n    - from: plugins/delivery-pipeline/scripts/role-artifact.cjs\n      to: tests/unit/phase53-z29i-recorded-integration-compatibility.test.cjs\n      via: \"rebuildReviewImpactPacket/read -> per-pass bounded cat-file metadata/content -> independent known-parent direct-reader parity and unchanged recheck refusal timing\"\n    - from: tests/unit/phase49-incremental-integration.test.cjs\n      to: tests/unit/phase53-z29i-recorded-integration-compatibility.test.cjs\n      via: \"Test-only original-restoration seam uses actual native boundary/recorders before historical consumption\"\n    - from: tests/unit/phase53-z29g-historical-action-covered.test.cjs\n      to: tests/unit/phase53-z29i-recorded-integration-compatibility.test.cjs\n      via: \"Exact old declaration/name/parameter/source hash -> exact promoted callback hash and preserved purpose\"\n    - from: scripts/package-shipyard-codex.cjs\n      to: plugins/shipyard/host/plugins/delivery-pipeline/scripts/codex-delivery-host.cjs\n      via: \"Whole canonical source generates complete package, mirrors and two identities\"\n---\n\n<objective>\nRepair F1/ARCH-53-03 unsent-publication poisoning and F2/ARCH-53-01 fresh legacy-v3 scheduling, preserving the accepted factory candidate. Address authenticated inherited HOST fit through private bounded Git transport inside existing reconstruction. Per D-01/D-02/D-03/D-05/D-06/D-07/D-08 implement accepted ADR-034 F53-01/04/06/08/09/10/11/12 without changing authority or coverage.\n\nPurpose: recover proven local refusals, retain uncertain remote effects/authentic historical originals and remove repeated per-blob process launches while retaining every complete reconstruction.\nOutput: three canonical sources/three generated mirrors/two identities, existing h/i regressions expanded inside i and four precise old fixture/provenance promotions. T31 retains pending-candidate findings; T30 owns F3. Current-head standing real user authorization at the human review checkpoint precedes guard merge. Native/phase acceptance remains unclaimed.\n</objective>\n\n<execution_context>\n@/Users/serhii/.codex/gsd-core/workflows/execute-plan.md\n@/Users/serhii/.codex/gsd-core/templates/summary.md\n@.shipyard/generated/gsd-delivery-rules/SKILL.md\n</execution_context>\n\n<context>\n@.planning/PROJECT.md\n@.planning/ROADMAP.md\n@.planning/STATE.md\n@.planning/architecture/ADR-034-simplify-delivery-execution.md\n@.planning/phases/53-simplify-delivery-process/CONTEXT.md\n@.planning/phases/53-simplify-delivery-process/53-CONTEXT.md\n@.planning/phases/53-simplify-delivery-process/53-RESEARCH.md\n@.planning/phases/53-simplify-delivery-process/53-32-PLAN.md\n</context>\n\n## Current amendment\n\nPR repair: C e21905f7e7165e6aa0af403547d22015b28191c7/E b2f752; PR660/W33 head c0ecc418b3753a1d1e7a456b0f173b334f121da9. D/T33-CI-run41494693364-shard37.log records109 PASS/1 FAIL at z17:575; D/T33-660-live-reviews.json retains unresolved PRRT_kwDOTmU9jc6yyxgn. Tasks1/3 own these two repairs; only z17 is added as owner15. Preserve original signed receipts/failed CI/reviews; no current CI pass/native acceptance. The genuine native review-fix host collects complete live feedback and signs the repair. This callback writes only PLAN33; final phase integrator stays on final epicPR.\n\nCurrent candidate is D/T33-cold-authority-cache-repair-candidate/inventory.json. Preserve its new-i-only private historicalCodexAuthority binding to deliveryhost's actual dependency and cold-cache invalid-window real-attempt test; other13 files,107 cases/eight lifecycles/17 promotions/two helper seams stay exact. Original19-command pass then part6 status1/20pass8fail/zero skip-cancel remains authenticated by ee434d98e33b61cfffcd70648603aa60e61fb99acb61bf0a79b64c4d76014403. Revised retry18 PASS then part5 was operator-cancelled, not product failure: D/T33-user-directed-CI-first-local-stop.json and T-53-33-user-authorized-long-HOST-v2-executor-result.json. Restore this candidate through genuine Native; no whole local31 retry or manual source commit.\n\nHistorical amendment: C a778a6397c253ccec527729f840acf82a099d5eb/config219; E b2f752; parent32 merged42f5b27cecb191aa0e0a35e8da6d34117ba358ea/tree83b90579478f8570b5a3ac6b4a9ada44759888cb. Authenticate F/T33-batched-Git-facts-research-authenticated.json for original researcher/index, unchanged516575-byte prefix/34 plans/config/heads/custody. Read research516575\u2013569593, full SHA45df66c6ca904fff8ce2ad1699f6fd4f06e9a66dd79eb4f627d6e0567f954517. Prior PLAN33 SHAfbcbbc4cfdb072ef5feb5f5434df7fdc98e2da08b25e3b68074f30973b197408; canonical/generated role-artifact brought historical scope to14/tasks2/6/6. Planning never authorizes ticket35, product/config/state/graph/other-plan writes, restart, tests, export or commit.\n\nHistorical factory: D/T33-accepted-factory-HOST-failure-authenticated.json/SHA73373cdc0dc59cae3b6e69b6b4be847a91e8911e90f86a11ce98bf4d862a0859; twelve-file inventory SHAc0fdcc669ab1e1420f28d9d2029c06968e08e2839ca9886d457dfeb721cdfdf1. HOST14 passed; original partition1 ETIMEDOUT600/16 NOTRUN/tree unchanged d7b4542684f2d052cff5f06d9e699044f9eb33ff/no commit/PR. Unchanged parent32 Source command timed out600023ms/baseline SHA37f5b9759eff8b5a4944295df84350924626e45c19a4d73109d714afd06361d0, no HOST credit. D/T33-profiled-inherited-fit-scope-finding.json/90s Worker profile:96.4%spawnSync/68.5%rebuildReviewImpactPacket inclusive overlap, diagnostic/nonadditive/no pass. Reported49 units/21 archives require normal original-plan/index inspection;139-source/>40-unit original scenario/payloads stay exact.\n\nCompose actual parent/candidate role-artifact SHA7b8e6c9fde7b4b5f505c0149d651caca6730dfa3cad236e56588d42797d78f5e, never older C ee7eb27df26f01c25e58f97a00e41e3664ecac4d59331b93d2fbb263530b581b. Preserve candidate sources/fixtures, AsyncLocalStorage isolation, exactly two helper inversions/suffix385077bd669ec7a0437d51882546c78457b1a5bb400807130d6cc49a680877ae; no third delta. Fresh31-purpose CI owed; old passes/profiles stay history/R8 INCOMPLETE/zero.\n\nHistorical parents: T34 PR652 merged8772f57f07d4209db0f9d75c7b988492538115af; signed32 bad1d7cf transported f8ca69da2ff6dafc29b6e9310c6be6b8f4469e6a/treef58e92e8489a78e0abedb6894248cb86b905e291. Preserve original HOST20 and refused review-fix20/tree7b4b56ea67562f684b46d11a953dceb91dbd5dbe/base-retarget refusal, D/T33-first-HOST-candidate-preserved/inventory.json and W32. Never merge parents under dependent HOST's frozen base.\n\nHistorical dispatch-mvy89ntt-f0607443-9b0a-4691-97d8-83248040ab3e/proposal7e77900f5fdf3cbd91dfd288566bf86c6e9fd7bccc9a073cda552665cec2dbdc: containment-refused after concurrent graph changes. Retain logs/F/T33-runtime-factory-proposal-after-failed-planner.md; no pass/recovery/weakening. Earlier accepted SHA5787f774b4e0a8c5d66105b5063c09897a48f76e28e5017cd0f26d36c52596be stays history.\n\nHistorical D/T33-first-HOST-failure-authenticated.json: native SHA3eb8d761751cb5e7368725709372025bd61269f2200d083f0fff6cdea99317d0/HOST SHAe99ca8d4db850c977a678bc1bf917de7c18427940802c00cb2843712b0e5038f; publish/h PASS,i status1/no timeout,28 NOTRUN. D/T33-first-i-full-diagnostic.log/json:351028ms/32 tests/31 PASS/1 FAIL/zero skip-cancel-todo/i:1165 factory expected1 actual0/no HOST credit. Retain scope SHA4472c538adc9d614047e237199d3f4c68a14fc2603b67bd13958568006150190/unapplied proposal SHAdedf3297572e24606e078e77d268efe0ae350b81c7c5874384daefd88b5233d0/all failures.\n\nHistorical T34 C29cd89a5b2faa565bafeb83751036529944a4f7f/config214/Eb2; read34's seven owners/residual+t/u/v/w. Preserve34 plans/future35, F1/F2/P31-1/P31-2/F3, F/T33-consistency-checker-authenticated.json/scope warnings. T32 status1/no-timeout cause UNKNOWN differs from later role-artifact-alone600s timeout; retain failed receipts/D/T32-balanced-first-HOST-candidate-preserved14-file inventory.\n\n## Source and custody\n\nHistorical manual custody: C=/Volumes/KINGSTON/.wt-claude-shipyard/phase53-investigate/HEAD0bd5b0815259364ac711f212b3b1fbdafa285d65/config199; E/SOURCE=/Volumes/KINGSTON/.wt-claude-shipyard/phase53-integration/HEADb2f752233446f6569ffee4bd1720c8f383127fd1/tree3373e280de8c65b3a18df5ce223a34db8c9f680c/29 merged. D=/Users/serhii/.local/state/shipyard/phase53-delivery; R=D/phase53-manual-review-like52; F=D/final-repair-planning. Read R/subject.json, integration-review.json/.md, architecture-review.json/.md, followup-scope.json, manual-review-manifest.json. Independent manual integration SHAf2f45a49b6bc97dccdff692884037b6151a4b1149e263f168b7de97c8222e720/architecture SHA9e5358fb85af3c1832871ad747105b48a80a35f1e71e4c176caaa3b864c248f5 reproduce five findings; C08/A14 proves POST0 poisoning/C09/C10 pending31 gaps within stated limits. Neither is native; R8 INCOMPLETE/zero/no Anthropic/phase acceptance.\n\nHistorical D/T32-balanced-first-HOST-candidate-preserved/inventory.json:14 immutable files; authenticate SHA/size/mode. Preserve two residuals/seven a\u2013g owners/three inert helpers/partial-refused results. T33 follows merged32/wave27 after34/wave26. Compose accepted parent32/preserved factory33 bytes against immutable baselines; no archived whole-file restoration or W32 edit.\n\nResearch prefix516575 bytes/SHA0537628e5648413fa9b21bfc5d7ba1ab076f5926ed260cc356d3bc4a1f05c137/full569593 stays unchanged. Prior33/34 scopes/freezes stay history. Unavailable external F/T33-frozen-before-manual-review-fixes-planner.json is retained at /tmp/T33-frozen-before-manual-review-fixes-planner.json; no hash waiver. Amend only33.\n\nExisting implementation to extend, located by publication/request and original-plan/native-record behavior searches:\n\n- E phase-code-review.cjs:404\u2013437 reads/creates protected operation; :443\u2013623 publish; :514\u2013548 status and :574\u2013610 comment are the exact persist\u2192second assertLive\u2192request gaps. readPublicationOperation/newPublicationOperation/persistPublication/withLock/remotePages already own bounded durable state and owner/nonce reconciliation. Reuse them.\n- E codex-delivery-host.cjs:1012\u20131039 partitionedCodexResult authenticates original durable/native result; :1183\u20131328 runCodexIntegrationPartitions currently launches missing units and always final; :1347\u20131376 prepareIntegratorInput creates/reopens plans; :3488\u20133495 is the public branch. Replace fresh dispatch in this branch. Claude-role-host.cjs:2406\u20132465 prepareReservedClaudeIntegration/completeRecordedClaudeIntegration is the existing recorded-only model; do not edit it or generalize all contracts.\n- Actual parent/candidate role-artifact.cjs:2887\u20133078 rebuildReviewImpactPacket/read owns per-blob Git size/content, two separate passes and lineage; :2851\u20132867 bounded reviewGit/endpoint inventory; :2695\u20132698 exact16/32MiB selection; :6282\u20136321 recheckPartitionRecord retains pins/identity/preflight/archive reconstruction. Extend only this private transport seam. Existing prepareIntegrationPartitions/validateIntegrationUnit/prepareIntegrationUnit/prepareIntegrationAggregate/sealIntegrationUnit/sealJudgment/currentIntegrationVerdict and native recorders retain every original call and timing.\n- Immutable32 z29f:204\u2013281 owns two fresh public acceptance callbacks; z29g:23\u201364 owns15 capacity/native scenarios and :13591\u201313766 checks exact original D/R inventories, allocation function hashes, shared definitions and opt-in selection. Only these exact delivery declarations need promotion; all R callbacks and all other D callbacks remain exact.\n- E phase49-incremental-integration.test.cjs:778\u2013808 supportedPartitionCaller/partitionCallerFromDocument already restores Claude originals via tests/fixtures/phase49/claude-v3-native-driver.cjs:15\u2013109. Add corresponding Codex fixture-only restoration through new i using the actual lower native boundary/recorder APIs. Its existing withCodexIngressHost also needs the minimal factory-capture/action-invocation delta: reloaded delivery/evidence modules retain an intercepted factory, but restoring runtime exports before action currently makes i fetch the un-intercepted factory. Retain that exact operation's intercepted factory through original recording, then restore on every exit. These are the only two authorized helper seams. Keep literal codexPartitionFixture extraction, every other readable helper, delivered34 helper/residual+t/u/v/w and precise packaged role-loading branch intact. Exercise all four moved role consumers and whole residual/judgment group on this combined changed source/phase49 fixture tree.\n- E integration-test-partitions.test.cjs:20\u201322 pins the helper suffix digest c4e32e7c562db3ac1786b3d8ed732894858ed3cb53c518d778b4d824c637a8d1; only this digest operand is promoted after the two exact authorized helper deltas. Preserve counts[1,1,24,25,28,28], all107 names, six complete partition mappings and existing invalid-argument/discovery assertions.\n- scripts/package-shipyard-codex.cjs is the sole whole builder. shard-files.cjs owns physical discovery/append/select; no shard manifest/workflow/weights/selector changes. z24/z29 package tests already provide full inventory/cold/tamper patterns.\n\nDiscovery uses authenticated appended source/protocol research and existing CommonJS/Git, without dependency/install/provider additions. Calibration factor1/sample_count0/confidence low/raw58000 remains a context estimate, not fit evidence. Chain29\u219234\u219232\u219233\u219231\u219230/waves25\u219226\u219227\u219228\u219229\u219230 serializes shared owners. No new ticket is needed.\n\n| Scope signal | Actual scope | Disposition |\n|---|---|---|\n| 10+ files warning |15 owners, tasks2/6/7 | Warning retained; the sole post-publication addition is existing z17's exact historical mirror normalization in Task3; existing implementation obligations remain intact |\n| 15+ files blocker |Exactly15, expressly authorized narrow repair | The actual shard37 failure supplies the precise scope finding for z17 only; no general waiver, additional owner/API or independent subsystem is authorized |\n\n## Exact old-contract promotions\n\nKeep the original frozen provenance dictionaries immutable. New i records a closed exact mapping containing original module, declaration, complete parameter values, exact title, old callback/source hash, exact new callback/source hash and expected new behavior/preserved purpose. Derive new hashes from actual changed source; never accept an arbitrary current hash or broad regex. Retain both old and new evidence. New setup/assertions live only in h/i; changes to old owners are the enumerated callback/operand or exactly the two helper seams specified below.\n\n| Immutable old identity | Old hash | Required promotion |\n|---|---|---|\n| D declaration4487, public Codex v3 preserves historical pins through independent units, exact-plan restart and one actual final | e03d227e6b6d44150d435e64b52b3e4bfaafe36d226c8febca2f6649ba3ae40e | Fresh public attempt refuses before native; the full historical pin/archive/tamper/restart/original-final purposes move to genuine recorded-original cases in new i |\n| D declaration4548, public Codex v3 accepts omitted capacity through original observed evidence | 9eafc25761bdaa2004fcb742ce8a046e3e5c5a19f794ae2319e608dbba8bc3ec | Omitted original plan/recorder refuses with zero launch; actual recorded acceptance/optional accounting/current consumer are proven in i |\n| D declaration4569, public Codex v3 refuses each of15 exact capacity/native scenarios with behavior-only capacity | f37104755ca7f7a84298c73b1c0b407ca66b023e476ebad92afaa6df667efb6e | No original authority refuses prelaunch for every original scenario; preserve each original lower-level capacity/native/input/result refusal in i's actual original recording/restoration cases |\n| phase49 helper: supportedPartitionCaller plus minimal withCodexIngressHost factory capture/action invocation only | Inherited32 file SHAe6c67d966bad622a699518651a9c4dfa28b6b9174f15c7a53c4e92f871b55bb6; original suffix digest below | Restore genuine originals before compatibility consumption and retain the exact original per-operation intercepted factory during recording; i inverts both deltas to prove the exact inherited source, rejecting any unrelated helper edit |\n| integration-test-partitions suffixDigest only | c4e32e7c562db3ac1786b3d8ed732894858ed3cb53c518d778b4d824c637a8d1 | New exact resulting suffix digest after both authorized helper deltas; i independently inverts both and proves the original suffix |\n\nThe15 scenario values remain exactly missing-renderer, unknown-window, foreign-window, foreign-counter, unknown-instructions, over-bound-unit, over-bound-template, over-bound-actual-final, changed-exact-input, wrong-output, incomplete-unit, failed-unit, source-substitution, native-input-substitution, native-result-substitution. Preserve original titles for the three opt-in selectors; their historical wording is identified by this explicit promotion. The unchanged caller-authority callback D4609/hashf73916184520d5968c2081c0904ad63c2b785759f3d3e753d755f1d5b752ab1a is not promoted.\n\nz29g's existing exact union/allocation/residual/source/selector checks may consult this closed mapping to transform only the17 enumerated original identities. Keep original dictionaries, counts, names, multiplicities, callback parameters, module tags, all unpromoted hashes/shared fixture definitions and all eight historical fixer lifecycles. Add mapping/schema/missing/duplicate/foreign-hash/extra-promotion negatives in i. Update only exact affected f/g allocation hashes and selectors' callback comparison operands through the same mapping. No generic regex allowlist, weakened union, silently dropped callback, replacement of original provenance or unconditional resealing of current source. Existing residual/shared fixture/package/z23 owners stay unmodified except the two explicitly owned phase49 helper seams; no new owner is authorized.\n\n<tasks>\n\n<task type=\"tracer\" tdd=\"true\">\n  <name>Task 1: Recover one provably unsent status publication through the next accepted head, then cover comments and response loss</name>\n  <files>plugins/delivery-pipeline/scripts/phase-code-review.cjs, tests/unit/phase53-z29h-publication-unsent-recovery.test.cjs</files>\n  <precondition>T32 is delivered under its genuine final-tree gates and the actual clean T33 worktree contains its complete accepted residual/helper/seven-runner layout.</precondition>\n  <behavior>\n    - RED public publish\u2192durable operation\u2192pre-send head drift\u2192zero status POST\u2192accepted new head\u2192one successful status publication.\n    - Comment creation and existing-comment PATCH each refuse before send on live/config drift and can publish under the next valid binding without an ambiguous old operation.\n    - A request invoked then losing its response remains unknown; original remote nonce/actor/repository/body reconciliation adds zero duplicate POST/PATCH, including restart.\n    - Prior pending records with no proven unsent marker remain possibly issued; foreign operation/owner/nonce/tampered state never gains cleanup or replay authority.\n    - Owner/Repo retains canonical preparation identity for status/comments and retries without duplicate mutations.\n  </behavior>\n  <action>\nPer D-03/D-05/D-06/D-07/D-08 and F53-06/08/09/11/12, first add a failing end-to-end hermetic test of F1 through actual phase-code-review.publish and its existing protected namespace/persistence/locks. Stub only remote transport/live PR boundaries, using existing phase-code-review-publish.test.cjs fixture patterns; do not use the manual VM probe as the regression. The test must observe actual local operation state and exact mutating transport invocation count, not infer unsent from an exception message.\n\nWithin the existing operation/lock encode prepared-not-issued versus potentially issued, preserving published and prior-operation reader semantics. Authenticate schema/owner/body/nonce/repository/config/subject and current operation equality before transitions. Persist prepared before the second assertLive. Once that check succeeds, persist the possibly-issued marker durably immediately before entering the mutating request call; a crash after that marker is ambiguous even if no request can later be proved. Remove or mark only the exact current authenticated prepared attempt when a local refusal proves the transport was never invoked. Under the lock a recovered authenticated prepared state is known unsent; a historical pending record without that proof stays uncertain. Do not infer safety from no matching remote object, a changed head, message text, a boolean supplied by the caller or a failed response parse. Keep existing bounds/private modes/fsync/atomic readback and one writer.\n\nApply the same transition ordering to status and both comment POST/PATCH branches; hygienic body creation/owner lookup/state validation/live/config refusal before issue cannot poison future publication. Preserve existing exact status context/body, comment binding/nonce, pagination, foreign actor/repository checks and limit/hygiene outcomes. Issued attempts reconcile only their original authenticated remote object; missing/duplicate/unavailable/changed response or head leaves explicit unknown and cannot auto-delete/replay. A later independent accepted head can replace only proven-unsent state, never an uncertain older request.\n\nPer D-03/D-05/D-08 resolve PRRT_kwDOTmU9jc6yyxgn: prepareOperation must preserve state.identity precedence over bindingIdentity's raw Owner/Repo selector. In h add real mixed-case public status/comment/retry regression through persisted preparation/readPublicationOperation, preserving remote checks/no duplicates. Task3 regenerates whole package/three mirrors/two identities; no new API.\n\nIn h add separate status/comment create/comment edit local-refusal cases, head/base/config/local-HEAD drift, persistence failure before issue, restart with prepared and issued state, old-format pending, foreign/tampered operation, response-loss remote original, malformed response and remote lookup ambiguity/unavailability. Verify successful exact new-head publication after proven unsent failure and repeated recovery without duplicate mutations. Keep original phase-code-review-publish tests unchanged and whole. No generic publication registry/retry framework, broader config, provider or TTL change.\n  </action>\n  <verify>\n    <automated>node plugins/delivery-pipeline/scripts/publish-gate.cjs --base origin/main --working-tree --json</automated>\n    <ci-regression>Full same-head CI coverage below.</ci-regression>\n  </verify>\n  <done>Actual public status/comment recovery distinguishes proven unsent from possible remote effects, permits the next accepted binding only in the former case, and reconciles issued originals without duplicate mutations; both complete files pass.</done>\n</task>\n\n<task type=\"auto\" tdd=\"true\">\n  <name>Task 2: Preserve recorded-only originals and batch fresh bounded Git facts with exact parity</name>\n  <files>plugins/delivery-pipeline/scripts/codex-delivery-host.cjs, plugins/delivery-pipeline/scripts/role-artifact.cjs, tests/unit/phase53-z29i-recorded-integration-compatibility.test.cjs, tests/unit/phase53-z29f-historical-action-repeat.test.cjs, tests/unit/phase53-z29g-historical-action-covered.test.cjs, tests/unit/phase49-incremental-integration.test.cjs</files>\n  <behavior>\n    - Fresh explicit v3 with no SHA, with caller-created fresh plan SHA, or with an authentic plan missing any original unit/final refuses with zero native dispatch.\n    - Genuine completed original units/final can be validated/resealed and reach ordinary current/gate and cold readers under unchanged exact original receipt/session/input/source identities with zero compatibility launches.\n    - Wrong runtime/role/dispatch/source/head/base/criteria/instructions/plan/input/native session/result/transcript/index fails at its real authentication boundary.\n    - Current semantic default still works; closed promotion mapping preserves all old purposes, exact unpromoted D/R inventories and selector semantics.\n    - Real Git old/new complete packets agree on all metadata/material/inventories/uncertainty/order/logical coverage/digest, including replacements; both passes retain separate limits and every recheck occurs freshly.\n    - Raw framing faults/nonzero/overflow refuse; exact framed chunks fit existing16MiB, maximum valid raw body uses preselected direct fallback, and changed authority refuses at the original next boundary.\n  </behavior>\n  <action>\nPer D-01/D-02/D-03/D-05/D-06/D-07/D-08 and F53-01/04/06/08/09/10/11/12 retain i's actual createCodexDeliveryHost public v3 regressions; start new batch tests RED. Require original plan/durable recorder, all unit/final native records and exact current binding; SHA/new plan alone is insufficient. Never create a fresh legacy plan, reserve/measure/admit missing native work or launchAgent/launchStatic/spawn to fill gaps. Missing work refuses/unknown with zero launches. Keep current semantic preparation/dispatch and versioned v1/v2/old readers unchanged.\n\nCompose the authenticated twelve-file factory candidate with actual accepted parent32, preserving publication/recorded-original behavior below, AsyncLocalStorage nested/error/concurrency cases,17 promotions, eight same-session lifecycles and all107 callbacks/[1,1,24,25,28,28]. Do not copy older C product bytes. New behavior starts with failing framing/parity tests inside already-new physical i, not another file/selector or old shard. Preserve current suffix385077bd669ec7a0437d51882546c78457b1a5bb400807130d6cc49a680877ae and BOTH exact existing phase49 helper inversions; batching needs no third delta.\n\nInside role-artifact's existing rebuildReviewImpactPacket/read, privately batch bounded Git metadata/content afresh in EACH reconstruction call and BOTH original passes. Keep every identity/pin/preflight/native/HMAC/archive/source/mutation check at its original timing. No prior packet/recheck reuse, cross-operation cache, async Git service/lifecycle, public option, caller transport or policy/cap change. Derive requests only from original eligible endpoint/affected traversal; retain order/first-OID dedup per pass, modes/nonregular uncertainty, aliases and all original graph/deletion/rename/impact/obligation/logical-coverage behavior. Preserve pass reset and original logical charging/read points; bound read-ahead by remaining material budget, including binary bytes. Preserve empty text versus binary, fatalUTF8/NUL, all per-path uncertainty and order.\n\nUse fixed execFileSync Git argv and raw Buffer protocol, metadata then content. Validate exact requested full OID/type/safe nonnegative size/order/count, bounded header, declared body byte length, separator and exact end; reject missing/malformed/truncated/extra/nonzero/overflow, unsafe arithmetic and metadata/content disagreement. Parse no text lines from bodies. Retain ordinary replacement refs; never require replacement bytes to hash to request OID or disable replacements. Chunk by complete framed bytes, headers/terminators included, within EXISTING16MiB subprocess maxBuffer; bound metadata/stdin too. A verified formerly valid raw body whose frame cannot fit selects the existing direct bounded raw-blob read BEFORE request at identical16MiB limit. Never omit it or fall back after malformed/overflow output. Preserve existing per-operation metadata/content timeouts and input/output caps exactly, separate per-object/per-pass aggregates and final serialized-lineage bound; retain the exact existing16/32MiB material conditional. Fewer process launches fetch the same raw facts; no authority success is cached.\n\nIn i retain a test-only independent original direct-reader oracle from exact known-parent role-artifact SHA7b8e6c9fde7b4b5f505c0149d651caca6730dfa3cad236e56588d42797d78f5e. Use controlled exact inverse of ONLY the reader seam and expected baseline whole-source hash before isolated Module loading; preserve baseline reader literal and reject extra source changes. Do not derive expected output from the batch implementation or approve a current hash. No production export/transport/validated flag. Compare actual realGit complete serialized packet, full metadata/inventories/material/uncertainty/order/logical coverage/digest, regular/executable aliases, deletes/renames, empty/multiline/binary/fatalUTF8/NUL and replacement-ref behavior. Add small subprocess-boundary fault fixtures for every header/body/separator/order/count/type/size/missing/extra/truncation/nonzero/overflow refusal; exact chunk thresholds, both pass budgets and original maximum raw-body fallback/oversize. Mutate real source/head/base/reference/instructions/preflight/archive/native/index between original operations; assert next original operation freshly reconstructs/refuses and prior success grants no authority. Exercise original full D36 unchanged:139 sources, >40 native units, all original payloads/oversized-final refusal/retained originals. Inspect reported49/21 only through normal protected plan/index consumers. Process counts are diagnostic; the full same-tree scenario remains required in actual current-head CI.\n\nReplace runCodexIntegrationPartitions' active missing-unit/final dispatch with recorded-only consumption patterned on completeRecordedClaudeIntegration. Reuse prepareIntegrationPartitions with the exact existing plan, existing unit validation/stage reconstruction, partitionedCodexResult and authenticated recorder/native parsing; validate unit completeness/outcome/context and final identity/input/coverage/full report. Prepare stages only to reconstruct and validate original input/identity. Read authentic already recorded results to complete missing seal/index/report/current publication steps, preserving receipt/session/dispatch/source/instruction pins. Do not require a fresh capacity observation merely to authenticate an unchanged original, and never treat missing admission as permission to launch. Validate/reseal only recorded originals under original contract. Keep original unknown/truncated/stale/refused outcomes explicit and full reports intact; no caller promotion, new registry, bypass flag, generalized contract rewrite or format relabelling.\n\nImplement all new fixture setup/assertions in inert-exporting i. Its test-only recordHistoricalCodexV3 equivalent to the existing Claude fixture uses real prepareNativeIntegratorContext/prepareIntegrationLineage/prepareIntegrationPartitions, actual native Codex runtime/dispatch boundary/createDurableRecorder, exact installed instructions, native transcript/session/task_complete/input reads and normal unit sealing. Stub only physical provider/remote boundaries using captured fixtures. Record original unit/final sessions before calling the public historical consumer. Preserve actual original admission/native errors and their ordering. Never call the retired public fresh route to seed originals; never forge HMAC, hardcode authority, use caller flags or install a production helper. Export fixture restoration inertly; importing i must register no tests/hooks/native work/environment changes. Register i's own regressions only as its physical runner. Retain isolated HOME/root cleanup and case180000/concurrency2/child8MiB.\n\nAt supportedPartitionCaller restore Codex originals like Claude through i using the fixture's real source-root recorder/runtime. In withCodexIngressHost capture only that operation's intercepted createCodexRuntimeHost and pass it through action invocation to private i recording. Preserve signature/intercept/action callbacks/parameters/cache reload/finally restoration. Use a readable explicit per-operation handoff. Any private i context must import inertly, scope to the action, restore on success/error, support nesting/throws and actual concurrency; no shared overwritable factory. Preserve per-case HOME/root and module/export/reader restoration. No public flag/provider registry/general DI/second scheduler/dynamic-source workaround/concurrency wrapper/extra file.\n\nrecordHistoricalCodexV3 uses that retained intercepted factory inside the action, never the restored module factory. Seed run_id with source-supported integration- (not original-); verify existing intercept contracts. Retain expected1 interception, actual ingress/ASCII completeness/capacity/source/native fault assertions, original callbacks/parameters/titles/refusal timing; no bypass or zero-count substitution. Outside the two seams preserve every helper/name/callback/partition mapping; semanticFixture/ordinary semantic callers keep their route. Resumed recording authenticates original plan/recorder/completion and finishes only fixture-original lower-native work before recorded-only public consumption. Preserve input/cold/package purposes; no broad phase49 rewrite/additional setup.\n\nPromote only the two f callbacks and15 g scenarios enumerated above to actual public prelaunch refusal with zero native invocations, preserving exact titles/parameters/selection counts. New i explicitly retains the original historical archive pin/inventory/tamper/restart/original final/current/cold purposes using completed originals; retain original optional accounting as unknown, native/result/source/coverage refusal matrix at its actual lower original boundary, and complete original reports. Genuine recorded acceptance includes missing seal/index acknowledgement recovery, repeated no-new-launch consumption, final-only and unit-only missing cases, forged/copied recorder/plan, malformed native and source/criteria drift. Separate fixture seeding launches from public consumption launches with actual counters.\n\nIn i add the closed old\u2192new map/integrity assertions; g changes only exact comparison operands/allocation fingerprints/selectors. Preserve frozen records/hashes/unpromoted callbacks/definitions/parameters/bodies, D/R tags/cardinalities/eight same-candidate lifecycles/default residuals/three selectors/invalid arguments. i rejects unknown/duplicate/missing/foreign-hash promotions and proves exact deltas. Its four-owner inverse audit inverts BOTH authorized phase49 helpers to inherited32 whole-file SHAe6c67d966bad622a699518651a9c4dfa28b6b9174f15c7a53c4e92f871b55bb6/original suffix SHAc4e32e7c562db3ac1786b3d8ed732894858ed3cb53c518d778b4d824c637a8d1; reject extra edits. Keep17 promotions closed/R247/unpromoted D unchanged. Only necessary private i fixture/provenance and resulting suffixDigest updates. Inversion proves provenance; compose legitimate repaired parent32 and separately authenticate its inherited delta, never arbitrary current-source approval/generic matching. Preserve z29a caller-authority, other shared helpers/residuals/both consumer-loading seams.\n\nIn i extend existing independent whole-package inventory/types/modes/bytes/two IDs and canonical/mirror tamper checks to role-artifact's third pair; preserve each-identity tamper/cold consumer checks and exact restoration.\n\ni proves exact baseline16/first50 SHAb6268014b4ae96454730fc1ee45a956acd518836daf2f787af6d6bdd73a02604/first51/delivered32 first58 a\u2013g. Preserve all62 delivered32 rows including34 t/u/v/w as ordered subsequence; insert singleton h/i after a\u2013g before t/u/v/w and x/y/z. Counts33=64unit/67CI,31=67/70,30=73/76. Require suffix a\u2013i,t/u/v/w,x/y/z,z30 as present/first60 a\u2013i then four34 rows. Preserve every prior row; enumerate actual/future rows with real lengths/disposable future task. g's historical first51\u219258 seven-only proof excludes exactly h/i via precise operand promotion, preserving historical assertions; i proves full current prefix. No selector/manifest/workflow/weights change.\n  </action>\n  <verify>\n    <automated>node plugins/delivery-pipeline/scripts/publish-gate.cjs --base origin/main --working-tree --json</automated>\n    <ci-regression>Full same-head CI coverage below.</ci-regression>\n  </verify>\n  <done>Fresh/missing v3 refuses before native; genuine originals reach current/cold consumers without new work. Fresh batched facts pass independent complete-packet/replacement/timing parity, fault/budget/chunk/max-body tests in whole i. Exact promotions/helper inversions/current suffix and all six complete107-case partitions remain intact; full original D36 is verified whole in current-head CI under unchanged case/native/material bounds.</done>\n</task>\n\n<task type=\"auto\" tdd=\"true\">\n  <name>Task 3: Retain the accepted suffix, generate all three mirrors and verify the complete candidate</name>\n  <files>tests/unit/integration-test-partitions.test.cjs, plugins/shipyard/host/plugins/delivery-pipeline/scripts/phase-code-review.cjs, plugins/shipyard/host/plugins/delivery-pipeline/scripts/codex-delivery-host.cjs, plugins/shipyard/host/plugins/delivery-pipeline/scripts/role-artifact.cjs, plugins/shipyard/.codex-plugin/plugin.json, plugins/shipyard/package-build.json, tests/unit/phase53-z17-ci-job-attempts.test.cjs</files>\n  <behavior>\n    - Both exact authorized phase49 helper deltas retain accepted385077bd suffix and invert to original hashes; all107 names/counts/partitions/discovery/invalid-argument checks remain intact.\n    - Whole generator derives three canonical mirrors/two identities; independent full inventory/types/modes/bytes, cold consumers and third-pair tamper checks pass.\n    - Every original full regression purpose passes in current-head CI on one final unchanged tree; original partial results/manual source proof never substitute for final acceptance.\n    - z17 preserves full current inventory/canonical parity and original captured hash with exactly9 historical mirror normalizations.\n  </behavior>\n  <action>\nPer D-03/D-05/D-06/D-07/D-08 and F53-06/08/09/10/11/12 retain candidate suffixDigest385077bd669ec7a0437d51882546c78457b1a5bb400807130d6cc49a680877ae. Keep old c4e32e7c562db3ac1786b3d8ed732894858ed3cb53c518d778b4d824c637a8d1/inherited whole-source hash and BOTH exact inversions in i. No third delta, assertion/title/count/partition change or digest bypass. Whole meta and all six complete partitions retain full original coverage.\n\nUse node scripts/package-shipyard-codex.cjs for whole supported generation. Copy ONLY three owned generated mirrors/two identities from complete output; no selective builder, hand edits, builder owner/API expansion or unowned inventory change. Require Task2's full i inventory/types/modes/bytes/two IDs, three-pair/each-identity tamper/restoration and cold recorded/publication checks in actual CI. Tests remain outside builder inputs.\n\nPer D-03/D-05/D-08/F53-06/09/11 repair only z17:545\u2013590 priorMirrors: add phase-code-review.cjs with original SHA2562d3a15adce1f1204481d769a7e2cae01ef3ba0bb31e8b5d7e42afe48acc148f4/mode420; count8\u21929. Actual Git capture.parent.source4f9da2383097a4c206a61741fbd24ac69646990c proves canonical/generated bytes identical41169/mode100644. Read-only W33 reconstruction with9 restores captured40a34a0f03f5a0dd5afa9ba94c1ddb382e84abc4936cc858fc7bf6ab99119807. Preserve preceding full current inventory equality, all canonical/mirror byte/mode assertions, strict captured comparison, cold/two-ID checks and immutable github-job-attempts.json. No current-hash substitution, skipped/weakened assertions, expanded exclusions or fixture rewrite. z17 already runs in shard37; retain command list/local1/full actual CI policy.\n\nRequire all regression purposes below in actual CI on the stable published candidate; locally run only the publication gate. Preserve case180000/concurrency2/child8MiB/native1MiB/result128KiB/TTL/CI900/max3 bounds. Both physical residual suites plus all seven moved runners supply the original full D/R union; new h/i and six full integration partitions are additional, not replacements. Whole phase49/package/z23/current semantic and affected fixture consumers stay genuine source/cold checks. No CASE limits, omitted scenarios, reduced assertions, partial selectors, cap/profile/timeouts or broad all-project loop. Retain actual failures and fix only declared owners. Existing product tests not modified retain their purposes under the real fixture seam; an actual new owner need is a scope finding before any write, never an implicit exemption. Leave product uncommitted for normal host signing/publication; no live provider acceptance is obtained from these fixtures.\n  </action>\n  <verify>\n    <automated>node plugins/delivery-pipeline/scripts/publish-gate.cjs --base origin/main --working-tree --json</automated>\n    <ci-regression>Full same-head CI coverage below.</ci-regression>\n    <human-check>Current-head standing real user authorization at the human review checkpoint precedes guard merge. Ordinary CI/code review/integration and target-required architecture remain real delivery gates; R8/native/phase acceptance remains unclaimed.</human-check>\n  </verify>\n  <done>Whole package/two IDs/cold/tamper and exact suffix/inventory checks pass; all original full-command purposes pass in actual same-head CI before guard merge, after genuine local admission/signing and prompt draft PR publication. No manual review is relabelled native acceptance.</done>\n</task>\n\n</tasks>\n\n## Current operational verification amendment\n\nUser authorization: local1 \u2192 genuine Source native finalization/signature \u2192 prompt concrete nonempty draft PR \u2192 full actual current-head CI \u2192 ticket reviews/human checkpoint/merge guard. Preserve scope/comment/current-source/ownership/scoped-tree checks. No broad sandbox/local regression or phase review before draft. After all ticket merges: phase code-review\u2192integrator\u2192architecture on actual final epicPR; ticket-to-epic architecture skipped-by-target. Standing user authorization is not GitHub APPROVED. Historical HOST outcomes stay history; diagnostic argv only for genuine CI failure. Source HOST1MiB is separate from child8MiB; bounds/semantic credit unchanged.\n\n## Verification commands\n\n- `node plugins/delivery-pipeline/scripts/publish-gate.cjs --base origin/main --working-tree --json`\n\n## Required current-head CI regression coverage\n\nHistorical HOST31 argv remain verbatim CI purposes. Each whole file maps to unitTasks/selectTaskShard via .github/workflows/test.yml/tests/unit/run.sh; grouped argv map to every file. Phase49: six selectors/all107 cases/[1,1,24,25,28,28]. Gate: rest publish+make test-fast-rest. No filtered/dropped cases. Dynamic append preserves first16/50/58 a\u2013g/60 a\u2013i;33=64unit/67checks, implemented31 x/y/z=67/70,30 z30/b/c/d/e/f=73/76. Future tests have not run. fail-fast:false/unit90min/rest30min/aggregate shards+every-unit+rest success unchanged. D/T33-CI-first-full-regression-coverage-source-proof.json proves scheduling, not CI success.\n\n- `node plugins/delivery-pipeline/scripts/publish-gate.cjs --base origin/main --working-tree --json`\n- `node --test tests/unit/phase53-z29h-publication-unsent-recovery.test.cjs`\n- `node --test tests/unit/phase53-z29i-recorded-integration-compatibility.test.cjs`\n- `node --test tests/unit/phase-code-review-publish.test.cjs`\n- `node --test tests/unit/codex-delivery-host.test.cjs tests/unit/codex-runtime-host.test.cjs tests/unit/codex-dispatch-adapter.test.cjs`\n- `node --test tests/unit/phase53-z29a-fixer-original-custody.test.cjs`\n- `node --test tests/unit/phase53-z29b-fixer-source-history.test.cjs`\n- `node --test tests/unit/phase53-z29c-historical-direct.test.cjs`\n- `node --test tests/unit/phase53-z29d-historical-admitted.test.cjs`\n- `node --test tests/unit/phase53-z29e-historical-pending.test.cjs`\n- `node --test tests/unit/phase53-z29f-historical-action-repeat.test.cjs`\n- `node --test tests/unit/phase53-z29g-historical-action-covered.test.cjs`\n- `node --test tests/unit/phase49-package-publication.test.cjs`\n- `node --test tests/unit/phase53-z23-verification-owner-heartbeat.test.cjs`\n- `node tests/unit/phase49-incremental-integration.test.cjs --integration-partition=1`\n- `node tests/unit/phase49-incremental-integration.test.cjs --integration-partition=2`\n- `node tests/unit/phase49-incremental-integration.test.cjs --integration-partition=3`\n- `node tests/unit/phase49-incremental-integration.test.cjs --integration-partition=4`\n- `node tests/unit/phase49-incremental-integration.test.cjs --integration-partition=5`\n- `node tests/unit/phase49-incremental-integration.test.cjs --integration-partition=6`\n- `node --test tests/unit/integration-test-partitions.test.cjs`\n- `node --test tests/unit/integration-final-root-context.test.cjs`\n- `node --test tests/unit/integration-live-proof-batch.test.cjs`\n- `node --test tests/unit/integration-impact-bound.test.cjs`\n- `node --test tests/unit/judgment-artifacts.test.cjs`\n- `node --test tests/unit/phase53-codex-integration.test.cjs`\n- `node --test tests/unit/role-artifact.test.cjs tests/unit/judgment-artifacts.test.cjs tests/unit/judgment-contract.test.cjs`\n- `node --test tests/unit/phase53-z29t-role-architecture-archives.test.cjs`\n- `node --test tests/unit/phase53-z29u-role-containment.test.cjs`\n- `node --test tests/unit/phase53-z29v-role-code-review.test.cjs`\n- `node --test tests/unit/phase53-z29w-role-integration.test.cjs`\n\n## Admission and planning validation\n\nSOURCE planCommands/loadConfig/repoValue/assignPlan assigns only local1. Config219/all entries/timeouts stay exact, including six authorized600\u21921800 integration overrides. Original31/24/18 lists are required CI purposes; Source scope/comment/receipt/source/ownership/scoped-tree/signing remain genuine.\n\nThe earlier three-plan admission is history. For this PLAN33-only repair preserve title/dependencies/wave/requirements/delivery/three tasks and the exact existing command list; scope is15 with only z17 added, below UTF8<=60000. Fresh host scope/GSD checks apply without editing31/30 or other plans.\n\nWrite only33; freeze every other plan/config/contexts/research/ADR/state/graph/GSD/heads/product/candidates/worktrees. No build/test/provider/install/export/commit/state-sync. Parent32 merged and PR660 published; genuine native review-fix collects complete live feedback and signs the repair after local1; full current-head CI precedes merge; R8 INCOMPLETE/zero.\n\n<threat_model>\n## Trust boundaries\n\n| Boundary | Description |\n|---|---|\n| Local protected publication -> remote mutation | Only durable exact original issue state distinguishes unsent from unknown remote effects |\n| Caller historical request -> original native authority | Plan SHA identifies existing work but cannot authorize missing native launches |\n| Fixture provenance -> executable coverage | Closed exact promotions retain original purposes without accepting arbitrary callback substitutions |\n| Canonical source -> whole generated package | Complete inventory and identities bind cold consumers to the same source fixes |\n| Git object subprocess -> fresh reconstruction | Raw metadata/body frames carry source facts under original per-pass and subprocess bounds |\n\n## STRIDE threat register\n\n| Threat ID | Category | Component | Severity | Disposition | Mitigation plan |\n|---|---|---|---|---|---|\n| T-53-33-01 | Denial of service | publication operation | high | mitigate | Task1 durable prepared/issued distinction releases only exact proven-unsent operation under existing lock |\n| T-53-33-02 | Tampering | status/comment POST/PATCH | high | mitigate | Task1 retains issued uncertainty and original nonce/body/actor/repository reconciliation; no request replay |\n| T-53-33-03 | Elevation of privilege | public Codex v3 | high | mitigate | Task2 authenticates every original native unit/final/recorder/input/current binding before recorded-only consumption; missing work refuses |\n| T-53-33-04 | Spoofing | historical native receipts | high | mitigate | Existing native/receipt/session/source/instruction validation and cold/tamper tests; SHA alone grants no authority |\n| T-53-33-05 | Tampering | fixture promotions | high | mitigate | Closed exact17-identity/source-hash promotion map; invert both authorized helper deltas to original whole-file/suffix hashes, retain per-operation interception and restoration/isolation, reject extra edits; unchanged remaining D/R dictionaries and negative promotion tests in i |\n| T-53-33-06 | Repudiation | package/verification claims | high | mitigate | Whole builder/full inventory/two IDs/cold tamper,31 same-tree commands, manual/native distinction and preserved failed originals |\n| T-53-33-07 | Tampering | role-artifact batch framing | high | mitigate | Task2/i exact OID/type/size/order/count/Buffer body/separator/end and malformed/truncated/extra/nonzero fault proofs |\n| T-53-33-08 | Spoofing | reconstructed source identity | high | mitigate | Task2/i known-parent hashed inverse/direct-reader realGit complete-packet and replacement parity; Task3 third-pair tamper proof |\n| T-53-33-09 | Denial of service | Git frame/material bounds | high | mitigate | Task2/i framed16MiB chunks, preselected max-raw fallback, safe arithmetic, both pass aggregates and final-lineage refusal proofs |\n| T-53-33-10 | Elevation of privilege | false cached authority | high | mitigate | Task2 retains each fresh reconstruction/check; i mutation-between-operations proves original next-boundary refusal; Task3 full31-purpose same-head CI acceptance |\n| T-53-SC | Tampering | npm/pip/cargo installs | high | mitigate | No installs/dependencies; any later package proposal requires legitimacy protocol |\n</threat_model>\n\n<verification>\nFifteen owners/three2-6-7 tasks/31 original full-command purposes plus already scheduled z17 cover F1/F2 and fresh bounded transport. Require unsent recovery/issued uncertainty including mixed-case canonical preparation identity, recorded-only current/cold consumption and zero missing-work launches; independent complete-packet/replacement parity, all framing/budget/fallback/timing proofs and full unchanged D36 fit. Preserve exact promotions/all original coverage, first58 a\u2013g/first60 a\u2013i plus34 t/u/v/w; physical32\u219262,33\u219264,31\u219267,30\u219273 and actual/future discovery. Whole package/three mirrors/two IDs/cold/tamper, immutable z17 captured inventory with exact ninth historical mirror, normal scope/comment/local admission/signature/current-head CI/ticket reviews/merge guard and final epicPR code-review\u2192integrator\u2192architecture remain owed. Ticket-to-epic architecture stays skipped-by-target; R8 INCOMPLETE/zero and unsuccessful originals stay retained.\n</verification>\n\n## Multi-source coverage audit\n\n| Source | Item | Assignment | Status |\n|---|---|---|---|\n| GOAL | Remove demonstrated repeated/blocked delivery work in five areas/both runtimes |33 fixes confirmed publication/legacy paths;01\u201332 retain other delivery duties | COVERED |\n| REQ | F53-01/04/09 | One current mechanism; historical readers only for recorded originals |Task2, original plans retain semantic implementation | COVERED |\n| REQ | F53-06/08/11 | Preserve authenticated originals/uncertainty and avoid duplicate effects |Tasks1\u20133; amended31 owns pending recovery findings | COVERED |\n| REQ | F53-10/12 | Runnable same-tree obligations; truthful scoped native evidence |31 commands/normal future acceptance, no research/planning feature | COVERED |\n| REQ | F53-02/03/05/07 | Semantic/full original/runtime/preparation/CI obligations |Unchanged01\u201329/32 plus amended31/30, no reduced scope | COVERED |\n| RESEARCH | Existing publication locks/atomic originals/current consumers/resource limits |Task1 exact existing seams and bounded states | COVERED |\n| RESEARCH | Versioned recorded-original compatibility without dual active schedulers |Task2 actual native recorder/session restoration and current/cold readers | COVERED |\n| RESEARCH/native diagnostic | Retain the original per-operation intercepted factory without weakening ingress/ASCII/capacity/source/native assertions |Task2 two exact helper seams/private i fixture, Task3 actual suffix operand; inverse both deltas to inherited32 whole-source and original suffix hashes | COVERED |\n| RESEARCH/appended516575\u2013569593 | Private per-call/both-pass bounded Git metadata/content, exact replacement/source/packet semantics and original limits |Task2 canonical role-artifact/i oracle, framing/chunk/fallback/refusal/timing; Task3 third mirror/tamper; all31 commands/full D36 | COVERED |\n| RESEARCH/manual evidence | F1/ARCH-53-03; F2/ARCH-53-01 |Tasks1/2 | COVERED |\n| RESEARCH/actual PR660 review and CI41494693364 shard37 | Mixed-case namespace and z17 historical inventory |Task1 canonical precedence/h regression; Task3 exact original mirror/count9 with current parity and original capture intact | COVERED |\n| RESEARCH/manual evidence | F3/ARCH-53-02; P31-1/ARCH-53-04; P31-2/ARCH-53-05 |Existing amended30; amended31 Tasks3/2 within existing owners | COVERED |\n| CONTEXT | D-01/D-03/D-05/D-06/D-07/D-08 |Objective/actions preserve history/source/native truth/resources/existing coordinator | COVERED |\n| CONTEXT | D-02 |Semantic workers/full originals/independent final unchanged; actual semantic regressions included | COVERED |\n\nD-04 remains superseded by D-05. Deferred research/planning optimization, new platforms/registries/schedulers/provider policy and independent CI sharding remain excluded. No source item is silently deferred.\n\n## Rollback\n\nUse coordinator rollback for15 owners, retaining receipts/operations/history. Restore original direct-reader transport only from authenticated actual parent, keeping authority/bounds and F1/F2 guards; regenerate whole package/three mirrors/two IDs. Never turn issued uncertainty into unsent, erase originals or reactivate fresh legacy scheduling. Coordinate downstream31 rollback; changed heads re-owe verification/CI/reviews. No force/reset or release authority.\n\n<success_criteria>\nF1 unsent recovery/issued no-duplicate uncertainty and F2 authentic recorded-only consumption retain current semantic review. Fresh batches preserve exact packet/source/replacement/timing/bounds; independent oracle/fault/fallback tests and unchanged full D36 fit pass. Exact promotions/factories/helper inversions/all107 cases remain intact. Whole package/three mirrors/two IDs/cold/tamper and all31 original command purposes pass on the exact published head in full CI before guard merge; R8/native/phase acceptance remains separately owed.\n</success_criteria>\n\n<output>\nExecution records local1/full CI31-purpose/z17 and implementation/package/native evidence in53-33-SUMMARY.md; retain signed receipts/failed CI/live reviews. This callback writes only53-33-PLAN.md, returning one typed artifact_path. No product/commit/export/admission/state-sync; other plans/config/state/source/candidates frozen. Native repair/current CI remain owed.\n</output>\n",
  "31": "---\nphase: 53-simplify-delivery-process\nplan: \"31\"\ntitle: \"Complete the native Codex CI-fix host contract before T30 recovery\"\ntype: execute\nwave: 29\ndepends_on: [\"53-33\"]\nfiles_modified:\n  - plugins/delivery-pipeline/scripts/deliver-dispatch.cjs\n  - plugins/delivery-pipeline/scripts/codex-delivery-host.cjs\n  - plugins/delivery-pipeline/scripts/base-merge.cjs\n  - plugins/delivery-pipeline/scripts/dispatch-boundary.cjs\n  - plugins/shipyard/host/plugins/delivery-pipeline/scripts/deliver-dispatch.cjs\n  - plugins/shipyard/host/plugins/delivery-pipeline/scripts/codex-delivery-host.cjs\n  - plugins/shipyard/host/plugins/delivery-pipeline/scripts/base-merge.cjs\n  - plugins/shipyard/host/plugins/delivery-pipeline/scripts/dispatch-boundary.cjs\n  - plugins/shipyard/.codex-plugin/plugin.json\n  - plugins/shipyard/package-build.json\n  - tests/unit/deliver-dispatch.test.cjs\n  - tests/unit/phase53-z29x-native-ci-fix-contract.test.cjs\n  - tests/unit/phase53-z29y-native-ci-fix-recovery.test.cjs\n  - tests/unit/phase53-z29z-generated-base-merge.test.cjs\n  - tests/unit/phase53-z17-ci-job-attempts.test.cjs\n  - tests/unit/codex-arch-review-context.test.cjs\n  - tests/unit/phase-code-review-publish.test.cjs\n  - plugins/delivery-pipeline/scripts/lock.cjs\n  - plugins/shipyard/host/plugins/delivery-pipeline/scripts/lock.cjs\n  - plugins/delivery-pipeline/scripts/conveyor-coverage.cjs\n  - plugins/shipyard/host/plugins/delivery-pipeline/scripts/conveyor-coverage.cjs\nautonomous: true\nrequirements: [\"F53-01\", \"F53-04\", \"F53-06\", \"F53-07\", \"F53-08\", \"F53-09\", \"F53-10\", \"F53-11\", \"F53-12\"]\ndelivery:\n  ticket: T-53-31\n  risk: high\n  human_checkpoint: merge\n  preauthorized: true\nestimate:\n  tokens: 58000\n  raw_tokens: 58000\n  tasks: 3\n  confidence: low\nmust_haves:\n  truths:\n    - \"Ordinary Codex CI builder/CLI privately binds canonical graph/plan/scope and OPEN live PR/repository/branch/head/base to physical failure bytes and actual remote checked-head/run/attempt/job.\"\n    - \"Bounded immutable external-failure custody independently rechecks SHA/length/regular-file identity/private modes/read brackets before launch, finalization and publication; historical logs plus separate PR head grant no authority.\"\n    - \"Actual ci-fix policy/static-agent/full native prompt/transcript/session/recorder identity survives artifact/HOST/signed fixer/publication/current consumption.\"\n    - \"Protected CI history/authentic predecessors alone determine first/progress/repeat/exhausted under unchanged ADR-014.v8 Sol low/high/xhigh; incompatible history/forged signals/ceilings refuse prelaunch.\"\n    - \"Original native/record/index/ack/signed-publication states reconcile before retry; uncertain push never replays; other roles retain their semantics.\"\n    - \"Only authenticated host-owned original CI operations gain private recorder recovery and genuine predecessor claim/consumption. Semantic recovery remains exactly semantic-prefixed integrator/arch-review/code-review with no prior; caller labels/IDs/flags grant none.\"\n    - \"Finished original CI acknowledgement authenticates its signed transition/publication/coverage/graph/source/signer/receipt and returns the retained result with green or pending new-head CI, zero new native launches and zero duplicate pushes.\"\n    - \"Generated conflict recovery durably retains exact generation/apply intent before effects, accepts only per-path original or intended write/mode/stage states, rejects third states and resumes the same signed covered merge.\"\n    - \"Trusted base-merge regenerates only supported generated conflicts from combined source, signs pinned parents/tree and records real coverage; same-original interruption reconciles. Arbitrary owned source conflicts/manual commits/fabricated coverage refuse.\"\n    - \"Frozen first51 remains exact. Delivered34 adds t/u/v/w;32 inserts a\u2013g for62 unit/65 CI;33 inserts h/i before t for64/67;31 appends x/y/z for67/70. Preserve first58 a\u2013g/first60 a\u2013i prefixes and full64\u219267 current/future rosters. Historical x/y/z-only51\u219254 excludes exactly a\u2013i,t/u/v/w.\"\n    - \"Final T31-tree CI re-proves delivered T32 residual+seven whole runners/two precise consumers/full original multiset/eight lifecycles/both old HOST purposes; no prior pass carries over changed host/recorder.\"\n  artifacts:\n    - path: plugins/delivery-pipeline/scripts/deliver-dispatch.cjs\n      provides: \"Real CI-specific request branch with canonical failure binding\"\n    - path: plugins/delivery-pipeline/scripts/codex-delivery-host.cjs\n      provides: \"CI-private preparation, native completion, candidate, coverage, publication and recovery\"\n    - path: plugins/delivery-pipeline/scripts/dispatch-boundary.cjs\n      provides: \"Private recorder-authorized original CI start/completion/record/index/finalization and fenced predecessor reconciliation\"\n    - path: tests/unit/phase53-z29x-native-ci-fix-contract.test.cjs\n      provides: \"Builder-to-current-consumer contract tracer and failure/identity/policy checks\"\n    - path: tests/unit/phase53-z29y-native-ci-fix-recovery.test.cjs\n      provides: \"Original completion/recovery, whole-package cold/tamper and physical-prefix proof\"\n    - path: plugins/delivery-pipeline/scripts/base-merge.cjs\n      provides: \"Trusted deterministic generated-package conflict completion with pinned signing, coverage and crash recovery\"\n    - path: tests/unit/phase53-z29z-generated-base-merge.test.cjs\n      provides: \"Actual generated-conflict merge, coverage/current-consumer and stale/tamper/recovery proof\"\n    - path: tests/unit/deliver-dispatch.test.cjs\n      provides: \"Precisely adapted existing promoted Codex builder operand; all other behavior preserved\"\n    - path: plugins/shipyard/package-build.json\n      provides: \"Whole-builder derived identity matching the generated mirrors and plugin version\"\n  key_links:\n    - from: plugins/delivery-pipeline/scripts/deliver-dispatch.cjs\n      to: plugins/delivery-pipeline/scripts/codex-delivery-host.cjs\n      via: \"CI request and actual graph-selector admission -> host-private CI subject\"\n    - from: plugins/delivery-pipeline/scripts/codex-delivery-host.cjs\n      to: plugins/delivery-pipeline/scripts/role-artifact.cjs\n      via: \"Original recorded ci-fix receipt -> existing generic repair seal/validate/read\"\n    - from: plugins/delivery-pipeline/scripts/codex-delivery-host.cjs\n      to: plugins/delivery-pipeline/scripts/dispatch-boundary.cjs\n      via: \"Original CI -> private recorder/predecessor -> authentic original ack\"\n    - from: plugins/delivery-pipeline/scripts/codex-delivery-host.cjs\n      to: plugins/delivery-pipeline/scripts/delivery-commit-finalizer.cjs\n      via: \"HOST/scoped tree/original CI -> signed fixer/full CI\"\n    - from: tests/unit/phase53-z29y-native-ci-fix-recovery.test.cjs\n      to: scripts/package-shipyard-codex.cjs\n      via: \"Whole package -> independent cold inventory\"\n    - from: plugins/delivery-pipeline/scripts/base-merge.cjs\n      to: scripts/package-shipyard-codex.cjs\n      via: \"Pinned combined source -> whole package -> exact tree -> trusted signed two-parent commit\"\n    - from: plugins/delivery-pipeline/scripts/base-merge.cjs\n      to: plugins/delivery-pipeline/scripts/conveyor-coverage.cjs\n      via: \"Original authenticated merge -> actual parents/tree -> existing writer/independent verifier\"\n---\n\n<objective>\nCurrent92e20405 continuation: finish original Task1/3 CI\u2192review/default-origin coverage verify/chain and legacy-private readonly custody. Fixtures66/67 are delivered; preserve current source, never restore archived candidates. FIRST read /Volumes/KINGSTON/.wt-claude-shipyard/.wt-phase53-investigate/T-53-31/.shipyard-role-artifacts/ci-inputs/remaining-current-repairs.md for exact proofs/constraints. Single local publication HOST; full24 purposes stay CI. This completes the original native CI/base-merge contract before T30; no CI-history reset/native-phase credit.\n\nOutput:21 owners/three tasks/local1/CI24+whole z17/archive/registry. Final-tree CI rechecks delivered32's seven whole runners/two consumers read-only. Current-head human APPROVED precedes guard merge; standing authority is separate.\n</objective>\n\n<execution_context>\n@/Users/serhii/.codex/gsd-core/workflows/execute-plan.md\n@/Users/serhii/.codex/gsd-core/templates/summary.md\n@.shipyard/generated/gsd-delivery-rules/SKILL.md\n</execution_context>\n\n<context>\n@.planning/PROJECT.md\n@.planning/ROADMAP.md\n@.planning/STATE.md\n@.planning/architecture/ADR-034-simplify-delivery-execution.md\n@.planning/phases/53-simplify-delivery-process/CONTEXT.md\n@.planning/phases/53-simplify-delivery-process/53-CONTEXT.md\n@.planning/phases/53-simplify-delivery-process/53-RESEARCH.md\n</context>\n\n## Current amendment\n\nHistorical T34: C HEAD29cd89a5b2faa565bafeb83751036529944a4f7f/config214; E b2f752 unchanged; earlier snapshot identities retained. Read53-34-PLAN.md: seven test-only owners/residual+t/u/v/w/consumer seams. Dependency29\u219234\u219232\u219233\u219231\u219230/waves25\u219226\u219227\u219228\u219229\u219230; exact34/future35 members. Preserve F1/F2/P31-1/P31-2/F3/F/T33-consistency-checker-authenticated.json/scope dispositions. Native T32 status1/timed_out=false cause UNKNOWN, distinct from later role-artifact-alone600s timeout. Failed receipts/D/T32-balanced-first-HOST-candidate-preserved14-file inventory immutable.\n\nHistorical post-publication: C HEAD2538551e; T31 PR664 native signed e871; generated base merge59e123003501d0af78bf30c9e10631b12d70be12 parents[e871,b45b7fe4]/genuine coverage. Then SOURCE=/Volumes/KINGSTON/.wt-claude-shipyard/phase53-source-host31 e871; GEN=D/T31-native-source-generation/generated; E=b2f752. T33 PR660 b45: native/local1 HOST pass/5 fresh actions/CI pending. Run41504586184/shard37:109 PASS/1 FAIL/110, D/T31-CI-run41504586184-shard37.log; z17 amendment followed. Head59 CI started; e871 jobs cancel normally. These receipts/digests retain their identities, never current-green credit.\n\nCurrent C HEAD94fa0b951b5f35e8ac218ce078a9636ae0ad994e. PR664 signed/pushed f2517e30eb9c5dd96efb99b8e4a170eca45d0f56 carries authenticated partial x/y fixture repair; prior372 CI logs remain in D. Prior372 run41520468477 failures: shard10/job125536035016 (201pass/1fail), shard14/job125536035153, shard66/job125536041862, shard67/job125536041825. Task3 adds exactly two old-test maintenance owners; all new scenarios remain x/y/z. Shard66's native selector correction is preserved, not accepted as a current CI pass. PRRT_kwDOTmU9jc6y0XO6 remains open; diagnosis was not a disproven implementation. Preserve D/T31-f251-review-repair-authenticated.json and W/.shipyard-repair-evidence.md, originals/history/policy selection; Task3 requires actual crash-association implementation/proof. Source ci-fix must collect fresh failure evidence and sign/publish repair\u2192full same-head CI/reviews. No callback/native/phase/R8 acceptance credit.\n\n## Context reads and custody\n\nC=canonical investigation; historical E/SOURCE=/Volumes/KINGSTON/.wt-claude-shipyard/phase53-integration; W=/Volumes/KINGSTON/.wt-claude-shipyard/.wt-phase53-investigate/T-53-31; D=/Users/serhii/.local/state/shipyard/phase53-delivery; F=D/final-repair-planning. Historical C HEAD3bc4165dd949137dd724c7cd2c1cdbad4e68dc16; clean E/W HEADb2f752233446f6569ffee4bd1720c8f383127fd1. Freeze W's14 uncommitted fixes/hashes/sizes/modes in D/T31-third-candidate-after-interrupted-host/inventory.json; F/T32-frozen-before-test-prerequisite-planner.json; no W mutation/redesign. Earlier callback only30/31/32;29 plans/research516575/config191/contexts/graph/GSD/C/E/W heads/14 archived bytes stayed exact.\n\nResearch516575 bytes/SHA-2560537628e5648413fa9b21bfc5d7ba1ab076f5926ed260cc356d3bc4a1f05c137; append488230 authenticated by F/T31-regression-budget-research-authenticated.json. CI/recorder/generated-merge checker receipts remain historical. D/T31-third-HOST-failure-authenticated.json: publish/x/y/z/whole-base-merge PASS, then full delivery/runtime/adapter ETIMEDOUT600/five commands unrun. E/W diagnostics byte-identical through timeout/no assertion failure; unfinished lifecycle finite-versus-stuck instruction UNKNOWN. No cross-tree pass credit. Preserve34's full residual+t/u/v/w/inert helper/packaged role branch while32 composes registration; CI rechecks all four on changed host/boundary.\n\nRead E canonical source/immutable R/pending-candidates/T-53-31 for manual findings; C product older. Prior33 custody: C HEAD0bd5b0815259364ac711f212b3b1fbdafa285d65/config199, E b2f752 unchanged, R=D/phase53-manual-review-like52. Earlier C/config/W are historical; no mutable W32 reads. Extend build/CLI/private repair/authenticatedReceipt/prepareRepair/repairCompletion/publication/generatedBaseMergeAuthority. Reuse read-only generic role-artifact ci-fix seal/validate/read, conveyor-coverage fixer/base-merge writers/readers, finalizer/host-verification exact argv; report missing owner before widening. dispatch-boundary owns private RECORDER_AUTHORITY/fences/original completion/record-index-finalize; semantic-prefix integrator/arch-review/code-review no-prior stays exact beside separate host-branded CI recovery. Preserve base-merge clean/fetch/unchanged/rerere/owned-conflict; sole whole generator: scripts/package-shipyard-codex.cjs build(destination).\n\nOld-test ownership: deliver-dispatch.test.cjs:594\u2013600 promoted Codex operand; z17 historical normalization; Task3's single original archive fixture and exact reader registry. No other old-test edits. T32 owns relocation/inert modules/seven z29a\u2013g/both loading seams; preserve them within17 T31 owners. Production PLAN_DIGEST_MISMATCH precedence stays. W z29y:380\u2013399 historical first51\u219254 excludes exactly thirteen z29a\u2013i/t/u/v/w only from task-set/disposable future-directory inputs, retaining operands/assertions. Separate new z29y proves full64\u219267/current-future selectors/exact a\u2013i,t/u/v/w,x/y/z. shard-files:23\u201340/:70\u2013100 still discovers sorted physical tasks once; manifest/selector/workflow/weights unchanged.\n\nLevel0/CommonJS/no install; calibration1/sample_count0/confidence low/raw58000=context, not fit/speedup. Scope14\u219215\u219217\u219219\u219221=six canonical/six mirrors/two IDs/old operand/three new tests/z17/archive fixture/reader registry. Ownership warning: inseparable whole-package CI, no broad waiver/independent subsystem. T32:14 layout owners; T33:12 publication/legacy/promotions; final-tree CI after32/33.\n\nR manual P31-1/ARCH-53-04/P31-2/ARCH-53-05 remain source/probe gaps, not native acceptance. Preserve33's recorded-original-only legacy guard/prepared-issued recovery/all34 exact final-review members. Historical research516575/config214/contexts/graph/STATE/ROADMAP stayed exact. Preserve20 HOST argv+four34/three tasks/resource-CI-policy limits; current owners21. Freeze=/tmp/T33-frozen-before-manual-review-fixes-planner.json (external F unwritable).\n\n<tasks>\n\n<task type=\"tracer\" tdd=\"true\">\n  <name>Task 1: Complete one builder-to-signed-current-consumer native CI repair path</name>\n  <files>plugins/delivery-pipeline/scripts/deliver-dispatch.cjs, plugins/delivery-pipeline/scripts/codex-delivery-host.cjs, plugins/delivery-pipeline/scripts/base-merge.cjs, plugins/delivery-pipeline/scripts/dispatch-boundary.cjs, tests/unit/phase53-z29x-native-ci-fix-contract.test.cjs, tests/unit/phase53-z29z-generated-base-merge.test.cjs</files>\n  <behavior>\n    - RED builder/CLI\u2192private CI\u2192original native/recorder\u2192artifact/HOST\u2192signed fixer\u2192publication\u2192independent current reader; preserve every original identity pin.\n    - Wrong subject/failure/current checked-head/run/attempt/job refuses at its actual boundary; CI has no review/thread authority.\n    - Unchanged limits:8MiB failure file reference,1MiB native input,128KiB result.\n    - Same original first/progress/repeat/exhausted survives record/index/finalize/ack interruption; semantic-first/no-prior remains exact.\n    - Real generated conflict\u2192whole package\u2192trusted signed covered merge precedes the new CI head.\n  </behavior>\n  <action>\n\n\nPer D-01/D-03/D-05/D-06/D-07/D-08, RED z29x traverses real builder/CLI/private preparation/native custody/durable recorder/generic artifact/HOST/finalizer/fixer coverage/cold current reader. Stub only physical model/remote boundaries; supported receipt production, no forged HMAC/native artifacts. Prove first/progress/repeat/exhausted preparation/original-completion/publication recovery before tracer feedback; Task2 adds adversaries.\n\nExtend Codex ci-fix build/CLI graph admission: canonical ticket/plan SHA/scope/repository/worktree/branch/recorded PR/failure path-SHA. Retain named refusal until complete, old argument/path errors/unsupported Claude branches. Canonical plan precedes caller authority/wrong-plan refusal. Task3 alone adapts old builder operands; CI/generated assertions stay x/y/z. T32 owns physical split; new full-prefix proof belongs z29y.\n\nBefore base-merge owned-conflict return add only generated-conflict completion: positive z29z merge\u2192coverage/full z29x pass in actual CI; Task3 adds negatives. Require actual Shipyard topology/pinned builder/exact canonical graph-plan-ticket/repository/physical worktree/branch/clean start/fetched single base. Eligibility derives from builder inventory/declared mirrors/plugin.json/package-build.json; every owned conflict eligible, unresolved canonical/non-generated refuse. No broad path-name/caller flags; preserve undeclared-conflict/generic/fetch/dirty/preexisting-merge/unchanged-tree/rerere.\n\nReuse protected host authority via narrow generatedBaseMergeAuthority preparation/read/advance, bounded private HMAC/atomic storage/existing per-worktree lock; expose no payload signer/CLI state writer. Before merge seal repository/graph/plan/scope/branch/ref/old head-tree/resolved fetched base commit-tree/builder bytes-mode-source/signer. Pin observed original conflict stages/AUTO_MERGE/combined non-generated staged entries. No saved validated flag or arbitrary pending MERGE_HEAD adoption; operations predating proof refuse reentry.\n\nWith no unresolved non-generated stage, build complete combined canonical source; independently pin full tree/inventory/types/modes/bytes. Use protected disposable script-root source/no shared Git alternates/separate protected destination/real pinned scripts/package-shipyard-codex.cjs. Builder must equal authenticated delivered incoming source, never changed/caller generator. Compare full package/both IDs; resolve derived declared entries only, leave unrelated equal entries, refuse other output/stale side IDs. Seal reproducible full source/package/index tree. Retain combined upstream semantics; unresolved canonical conflicts need separately authorized resolution.\n\nImmediately before commit recheck protected proof/physical roots/regular files/modes/read brackets/graph-plan-scope/unchanged HEAD-base-branch-signer/single MERGE_HEAD/conflict-index-source/full regenerated inventory. Trusted base-merge signs exact ordered oldHead/newBase/derived tree via existing signer checks and real recordMerge/createCoverageWriter kind base-merge. No single-parent finalizer/manual commit/invented receipt/HOST/CI. Independently verify signature/parents/tree/clean tracked state/coverage. Seal commit OID before old-head CAS publication; recover that same commit/coverage. No push. Task3 covers interruptions/refusals and genuine package outputs.\n\nUse executorPreflight/private repair with protected CI subject/history: canonical OPEN live PR/head-base/repository-branch-worktree-source/current graph-plan-scope/exact HOST assignment. Existing collectors pin complete compatible actual remote checked-head/workflow-run/attempt/jobs/named outcomes-cancellations/failure bytes. Pending/empty/cancelled/unavailable stay distinct. Reuse compatible epoch only; refresh missing/incompatible/new attempt-poll/final mutable facts. Caller metadata/separate PR head+historical log grants none.\n\nRetain bounded immutable host-owned external snapshots using existing private directory/atomic/locks. Authenticate original regular physical descriptor/stat brackets/bytes-SHA-length/ancestry; bind original+copy. Refuse symlink/ancestor/foreign-root/replacement/short-truncated-overflow/source-evidence races; recheck launch/HOST/candidate commit/publication. Keep8MiB file reference, no1MiB prompt inline/trusted flags/permissive normalization.\n\nUse ci-fix throughout selection/static instructions/receipt/full prompt-transcript/completion-result/private candidate/history/publication. Generalize shared receipt/finalizer/publication by expected repair role; no duplicate engine/review pagination-dispositions-thread actions. shipyard.repair-result.v1 identity/status/pushed=false/notes/hypothesis retains full producer evidence/reasoning/strict role/generic sealRole-validateRole-read. Preserve original prompt/transcript/session/provider/model/effort/static-agent/producer/registered policy pins.\n\nDerive CI signature/progress/repeat/exhausted only from protected CI history and actual original predecessor records/receipts, separate from review history, matching ticket/PR/repository/subject/compatible transition through existing boundary/policy APIs. Preserve ADR-014.v8 Sol low/high/xhigh prerequisites/ceilings. Before spawn reject caller promotion/missing-forged-foreign-stale predecessor/ceiling; builder refusal cannot become an applied predecessor.\n\nAdd separate dispatch-boundary CI recovery; sole recorder-write capability remains module-private RECORDER_AUTHORITY/existing wrappers. Semantic eligibility: exact semantic- prefix/integrator-arch-review-code-review/no prior. CI requires genuine host-prepared custody, never role lists/disguise/caller IDs/booleans/callbacks. codex-delivery-host's private WeakMap holds typed original-CI handles from genuine preparation/authenticated original. Narrow lazy boundary validator authenticates brand/sealed operation without initialization cycles or signing/key/token export. Restart restores handles only from authenticated private original envelope/full native-subject pins.\n\nAllocate newDispatchId once at preparation; seal physical recorder-store/ticket-repository-PR-worktree-branch-head-base/graph-plan-scope-HOST/actual checked-head-run-attempt-job-failure/role-runtime-policy-selection/genuine predecessor. Before boundary recording retain canonical prompt/static instructions/original native completion from onCompleted in bounded private operation; callback is no receipt. Reentry restores exact values/no new ID-launchStatic. All CI rungs use explicit dispatchAgent/host-only opaque handle: runtime recorder first/progress, authenticated selected predecessor recorder repeat/exhausted. Other roles' launchAgent/completedSource exact.\n\nUse one typed eligibility/subject validator at start/completion retention/pre-post record writer checks/recovery/finalization/ack. Before each mutation authenticate current controller/original operation/subject, exact CI runtime-role-policy-dispatch-store/native prompt-transcript-session-producer/ticket/host-proven transition. Reserved/started without authentic completion remains unknown, never relaunch. Recovery accepts original completed session's authenticated scoped dirty outputs, not arbitrary dirt or fresh-launch clean-baseline rules; recheck output/scope/tree/live/evidence before HOST/finalizer/publication. Preserve typed fencing/abortProvisional ownership: failed second validation aborts only own provisional record/index/marker, retains failure/completion and creates no ack/signature.\n\nExtend markOriginalStarted/retainOriginalCompletion/getOriginalDispatch/reconcileOriginal via separate typed CI path and module-authenticated retained subject/record. First/progress has no predecessor; repeat/exhausted requires actual original predecessor_dispatch_id/consumer, verified resolution.prior_applied/signals, ADR-014 prerequisite receipt and fenced claim. Keep generic no-prior restriction. Reuse repairCommit/recoverRepairCommitUnlocked with exact successor record input/original claim generation-token under receipt-mutation/claim locks before claim release/retryability. Cover both completion/marker write-order gaps. Durable admitted marker reserves exact predecessor-successor; absent/foreign/incompatible ownership refuses, no alternate claim/relaunch. Before marker require matching original fence; after marker finish only same committed successor. Effort/ID/copied receipt is no prior authority.\n\nByte-equal provisional record does not prove latest(runtime,role). Under original CI scope/locks restore exact record/missing index idempotently before finalization, even finalized-but-unindexed; refuse incompatible later index/consumer. Finalize original authenticated receipt/trace; independently reconcile/consume predecessor via committed fence/consumed marker. Handle expired/same-owner CI interruption without changing ordinary claim/TTL/consume/semantic no-prior; refuse foreign takeover/competing successor. Cover before record\u2192index\u2192finalized trace\u2192consumption\u2192host ack/post-ack. No recoverReserved.dispatch for existing records/stale-receipt spawn. Native completion remains original task_complete; separate sealed host ack follows independent receipt/index/finalization/consumption. Lost ack reconciles without semantic completed-source APIs/fabrication. Same session/receipt continues artifact/HOST/candidate/publication; no uncertain push replay.\n\nBefore finalization durably bind exact candidate/original CI operation; authenticate/reconcile candidate-finalization-signature-coverage-original receipt before old-head validation (Task3 crash contract). After T32/Tasks1\u20133: local1 HOST/one scoped unchanged tree/existing records/mutation brackets\u2192full actual CI. Authenticate original receipt/candidate; both repair roles use fixer coverage/trusted signer; failed verification never signs. Recheck subject/evidence/live precommit/publication. Reuse locks/reservations/native-record-index-ack-publication reconciliation; confirm remote pre-retry/unknown stays/no push replay. Preserve other roles' semantics/history/readers absent demonstrated format need.\n\nCI/generated/full-prefix assertions stay x/y/z; delivered T32 owns split assertions. No generic registry/cache/retry/policy/cap/TTL/provider/tuning change. Prefer no comments; indispensable own-line @contract/@invariant/@security max120 chars. Leave source uncommitted for host signing/publication; isolated fixture commits use actual trusted base-merge.\n  </action>\n  <verify>\n    <automated>node plugins/delivery-pipeline/scripts/publish-gate.cjs --base origin/main --working-tree --json</automated>\n    <ci-regression>Full same-head CI coverage below.</ci-regression>\n  </verify>\n  <done>Both complete tracer files pass in actual current-head CI, proving the full CI/current-consumer and signed covered generated-merge paths, including the specified private original/predecessor recovery. Semantic eligibility and declared ownership remain exact. Fixture evidence grants no native phase acceptance.</done>\n</task>\n\n<task type=\"auto\" tdd=\"true\">\n  <name>Task 2: Prove CI refusal/recovery, generated package and preserved role behavior</name>\n  <files>tests/unit/phase53-z29y-native-ci-fix-recovery.test.cjs, plugins/shipyard/host/plugins/delivery-pipeline/scripts/deliver-dispatch.cjs, plugins/shipyard/host/plugins/delivery-pipeline/scripts/codex-delivery-host.cjs, plugins/shipyard/host/plugins/delivery-pipeline/scripts/dispatch-boundary.cjs, plugins/shipyard/.codex-plugin/plugin.json, plugins/shipyard/package-build.json</files>\n  <behavior>\n    - Each specified foreign/stale/physical/policy/native/candidate/coverage negative grants no unauthorized launch/commit/publication.\n    - Same authentic original recovers completion/record/index/ack/publication; finished original acknowledgement returns under new green/pending CI; unknown push stays pending without replay.\n    - Independent full inventory/two identities/cold readers and separate tamper refusals pass.\n    - Historical x/y/z-only input retains exact first51\u219254; separate full proof preserves T32 first58 a\u2013g and T33 first60 a\u2013i plus34 t/u/v/w to64, then appends x/y/z to67, including every actual/future selector; z29's23 cases/51/54 stay exact.\n  </behavior>\n  <action>\nPer D-02/D-03/D-05/D-07/D-08/F53-06/07/08/09/10, RED z29y uses existing fixture/native/recorder seams. Independently cover each subject, evidence same-length/growth/truncation/short-read/missing/directory/symlink/ancestor/race/overflow, mode/physical-root changes, wrong remote checked head/attempt/job/incompatible reused observation. Assert applicable prelaunch and late precommit/publication refusals; restore exact bytes between negatives. Exercise absent/forged/foreign/stale predecessors/caller signature promotion/cross-role history/real progress reset/repeat-exhausted prerequisites/ceilings. Assert actual unchanged Sol low/high/xhigh/original native-prompt-producer pins, no mocked policy selection.\n\nP31-2/ARCH-53-05: implement the finished-original branch in prepareCiRepair BEFORE fresh collectRepairCi failure collection (Task1 owns the canonical host change; this task owns z29y proof). Authenticate the original sealed finished operation, original failed subject/failure custody, exact signed old\u2192new transition, confirmed publication, full HOST/fixer coverage, graph/plan/source/signer and original native receipt/session/result. Reconstruct/recheck the authentic original completion rather than requiring the repaired new head to be failed. For the same finished operation, green or pending CI at its signed successor head and lost successful return must return the retained result with zero new native launches, zero duplicate commit and zero duplicate push. Fresh CI collection applies only to a genuinely new operation/rung; retain stale/foreign/tampered refusal and uncertain publication reconciliation. Do not borrow old failure authority for new work. In z29y add separate green, pending and lost-return cold reentry plus wrong signed head/receipt/coverage/graph/signer/publication/source negatives through actual host/recorder APIs. Manual C10 is only a narrow probe; actual final-tree CI proof is required.\n\nExercise native-completed/unrecorded/recorded-unindexed/indexed-unacknowledged/candidate-finalization/confirmed-pending publication and Task3's candidate-only/CLI/cold crash points. Preserve original session/recorder/receipt/launch-push counts/failed records; refuse missing/foreign completion/artifact-coverage substitution/stale signed parents-tree-verification digest/uncertain publication. No CI review-thread actions; cases x/y/z; T32 owns split/loading.\n\nIn z29x/y real createDurableRecorder/host-owned CI proves separate cold first/progress/verified low\u2192high/high\u2192xhigh recovery/all Task1 interruptions: completion-marker ordering/record\u2192index/finalized-unindexed/consumed\u2192ack/lost successful ack. Preserve dispatch/native session-task_complete/full prompt-transcript-result/record-receipt/fence/rung: one launch/original, one predecessor consumption. Test expired same-owner/foreign takeover/concurrent recovery-claim/mismatched marker-record-index-consumed/later incompatible index/no foreign overwrite. Both writer checks/recovery enforce exact provisional abort ownership/no fenced ack/current-owner reentry. Resume through artifact/HOST/fixer finalization/current consumer.\n\nReject forged/serialized/unbranded CI handles/copied fields-IDs/wrong recorder/semantic-disguised CI/executor/review-fix/research/decomposition/prefix-free reviews through actual boundary calls. Genuine semantic-prefixed integrator/arch-review/code-review first/no-prior stays valid; priors refuse. Only Task3's precise old-fixture/registry maintenance is allowed. Preserve complete current34-member phase-code-review graph/plan roster/policy, no old31/32 substitution. Recheck all eleven original commands/seven whole split runners/four34 runners/two precise whole consumers on the final tree; no purpose substitution or pass carry.\n\nRun whole node scripts/package-shipyard-codex.cjs; only six mirrors/two IDs change. Task3 owns base-merge/lock/coverage mirrors/final IDs; Task2 other three. No hand copying/stale IDs/scope expansion. Independently inventory full entries/types/modes/bytes/recompute both IDs; cold processes load real package for original-CI recorder/ack/repair-artifact/current consumption. Separately tamper canonical/mirrors/each ID/boundary, restore exact custody; no facade/canonical-only equality.\n\nPreserve baseline16/frozen first50 compact-JSON SHA-256b6268014b4ae96454730fc1ee45a956acd518836daf2f787af6d6bdd73a02604/first51/z29's23 cases/51/54. Historical z29y input/future-directory list alone excludes exactly thirteen z29a\u2013i/34 t/u/v/w, retaining literal first51\u219254/digest/three-name assertions. Separate z29y uses complete discovery: immutable T32 first58 a\u2013g; T33 h/i before t/u/v/w gives first60 a\u2013i then four34 rows\u219264; append x/y/z once\u219267unit/70CI; later six T30\u219273/76. Preserve original multiset/eight lifecycles via residual+seven whole files/no duplicate discovery-execution. Actual inventory determines every current/future denominator/full64\u219267/exact first58/60, never assumed first54. Manifest/selector/workflow/weights/case180000ms/concurrency2/child8MiB/HOST600/native1MiB/result128KiB/TTL/isolated package setup unchanged.\n\nAfter T32/T33/Tasks1\u20133/local1/signature/draft PR require actual same-head CI/all24 original producer/config/policy/native/recorder/coverage/artifact/verification/recovery/current-cold/generic base-merge purposes. Retain failures; no filters/invented switches/raised bounds/skips/assertion removal. Genuine new T30 failure repair remains later native acceptance.\n  </action>\n  <verify>\n    <automated>node plugins/delivery-pipeline/scripts/publish-gate.cjs --base origin/main --working-tree --json</automated>\n    <ci-regression>Full same-head CI coverage below.</ci-regression>\n    <human-check>Ordinary delivery requires this prerequisite's current-head CI/reviews/human checkpoint and merge before T30 base merge; real CI repair acceptance remains unknown until a genuine new T30 failure is observed.</human-check>\n  </verify>\n  <done>Refusal/recovery/package/cold/tamper/prefix cases pass with original authority: cold reentry adds zero native launches, no duplicate work/push replay. No policy/provider/cap/unowned edit; Task3 retains final24-purpose same-head CI verification.</done>\n</task>\n\n<task type=\"auto\" tdd=\"true\">\n  <name>Task 3: Prove supported generated-conflict completion and recovery before the T30 handoff</name>\n  <files>tests/unit/phase53-z29z-generated-base-merge.test.cjs, tests/unit/deliver-dispatch.test.cjs, plugins/shipyard/host/plugins/delivery-pipeline/scripts/base-merge.cjs, plugins/shipyard/.codex-plugin/plugin.json, plugins/shipyard/package-build.json, tests/unit/phase53-z17-ci-job-attempts.test.cjs, tests/unit/codex-arch-review-context.test.cjs, tests/unit/phase-code-review-publish.test.cjs, plugins/delivery-pipeline/scripts/lock.cjs, plugins/shipyard/host/plugins/delivery-pipeline/scripts/lock.cjs, plugins/delivery-pipeline/scripts/conveyor-coverage.cjs, plugins/shipyard/host/plugins/delivery-pipeline/scripts/conveyor-coverage.cjs</files>\n  <behavior>\n    - Real divergent generations retain both canonical changes through complete combined generation, exact signed parents/tree, existing coverage and independent normal consumption.\n    - Every specified stale/tamper/foreign/failure/non-generated-conflict negative refuses; generic regressions remain exact.\n    - Each specified interruption, including own partial write/chmod/staging, reconciles the same original commit without duplicate commit, unsigned adoption, push replay or caller authority.\n    - Whole z17 remains110 cases with full current inventory/canonical byte-mode parity and immutable capture hash; exact historical normalization count9\u219212 includes33's ninth entry.\n    - The original genuine-prior-CI-archive fixture ignores caller bookkeeping and admits its authenticated archive to the following architecture review through supported native CI custody; exact reader registry audits the new host while retaining detection/unknown-reader refusal.\n    - Wrapped board.tickets preserves exact live-base authentication; candidate-only/finalization/CLI/cold recovery reconciles the original operation without duplicate commit/launch/push.\n  </behavior>\n  <action>\n\nFresh ae3 review repair/D/T31-ae3a-review-repair-authenticated.json leaves PRRT_kwDOTmU9jc6y4MeL: shared lock TTL120s expires during synchronous180s generation. Extend lock.cjs atomic owner/takeover with fixed process-owned generated-merge locking. Default acquire/withLock/TTLs/callers unchanged; no toggles/TTL increase/duplicate framework/public authority. Bind process lifetime/PID-reuse/token; synchronous live owners cannot age out. Preserve ownerless/dead recovery; fence proof/writes/chmods/staging/sign/HEAD effects. Owned z tests: actual contenders/dead-reused owners/blocked work; same original cold merge/one signed commit. Whole-builder lock mirror.\n\nHistorical2a52 diagnoses/lock normalization remain verbatim in D/T31-coverage-consumer-scope-amendment.json; original logs/receipts unchanged.\n\nPer D-03/D-05/D-06/D-07/D-08/F53-06/08/09/10/12 expand z29z RED with real disposable repos/complete package-builder/Git-signing-injection and independent conveyor-coverage.verify/normal consumers. Signing/coverage remain real; fault injection cannot construct production HMAC/coverage/signatures. Generated-merge setup/assertions stay x/y/z. Whole base-merge.test.cjs stays byte-identical. Change only deliver-dispatch.test.cjs:594\u2013600 promoted-Codex success condition/role operand, preserving title/setup/cases/path-SHA-prompt/Claude-other refusals.\n\nCross-role coverage: own conveyor-coverage.cjs and mirror. Actual default verify/chain refuses authentic4632's remote-namespaced record. Fix same-repository canonical/default/actual-origin alias consumption, preserving HMAC/repo/receipt/native/signature/parents/tree/repository_id/foreign refusals. No namespace scan/caller alias/override/record rewrite/corrupt-conflicting fallback/gate waiver. Keep new CI preparation's canonical graph repo stable; old authentic remote originals remain readable. Owned x/y: full chain/CI\u2192review/default/foreign repo/missing-tampered-foreign refusals. D/T31-4632-coverage-consumer-scope-proof.json binds source/chain failure.\n\nz17 existing real-isolated-builder/priorMirrors retains all13 originals and adds original4f9 conveyor-coverage.cjs mode420/SHAe4ef6439fa74c309e3f00f411ec7d3d3094778602755a3fe6bd742c6a447c789; exact count13\u219214. Preserve immutable40a34a0f03f5a0dd5afa9ba94c1ddb382e84abc4936cc858fc7bf6ab99119807/all110 cases/full current inventory/canonical byte-mode parity/original Git+archive refs/no old-shard scenarios. Prior exact13-entry ancestry/diagnoses remain verbatim in D/T31-coverage-consumer-scope-amendment.json; new behavior stays x/y/z.\n\nShard10: ONLY adapt codex-arch-review-context.test.cjs's original 'a genuine prior Codex repair archive cannot supply host bookkeeping and remains admitted by the following review' fixture (f251:1238): replace obsolete prompt-only ci-fix setup with canonical PR/plan/failure evidence/genuine supported builder/private lifecycle/custody/public archive/actual native CI operation. Retain all caller-bookkeeping refusal/ignored-field assertions/original authenticated archive/following architecture admission. No forged receipt/lowered production admission/refusal-precedence change/new scenario/helper owner; new behavior stays x/y/z.\n\nShard14: independently audit real codex-delivery-host.cjs check-rollup uses for existing authenticated observation/checked-head/pending/failure classification. AFTER audit record host in phase-code-review-publish.test.cjs's exact existing assertReaderRegistry lists where detected. Retain all consumers/direct-path-built import/direct-check detection/unknown-new-reader refusal. Never exclude host/suppress detection; new behavior stays x/y/z.\n\nShard66: retain f251's exact run_id operation selection and fresh physical failure selectors for each builder-produced successor in owned x/y; preserve original assertions. Shard67: complete effectiveBaseRef's board.tickets unwrapping consistently with preparation in the already-owned canonical host, regenerate its mirror, and prove wrapped-state generated-base merge in z29z with exact live-base authentication unchanged.\n\nCrash PRRT_kwDOTmU9jc6y0XO6: native diagnosis of durable candidate/original-operation association never implemented/executed/disproved it; no-code diagnosis/escalation is no failed implementation hypothesis. Genuine high attempt tentatively implemented then removed solely under that exclusion. Retain D/T31-f251-review-repair-authenticated.json/W/.shipyard-repair-evidence.md verbatim/original receipts-history/policy; no-repeat applies to actually disproven attempts. Task1 implements approved host recovery: durable exact candidate/original-operation binding BEFORE finalization; reconcile exact candidate/finalization/signature/coverage/original receipt-operation BEFORE old-head validation, including crash before signed_result persistence. Task2 x/y candidate-only/CLI/cold proofs retain same operation/session/zero duplicate commit-launch-push/independent authentication. No public bypass/new feature/diagnosis-as-pass.\n\nStart genuine divergent supported generations retaining both canonical edits; verify full combined inventory/types/modes/bytes/two IDs/distinct tree where appropriate/ordered parents/configured signer/verify-commit/clean tracked state/no MERGE_HEAD-AUTO_MERGE/base-merge coverage/normal acceptance. Include combined upstream role-artifact edit; refuse its unresolved owned conflict without semantic loss. Direct canonical/staged-cold entrypoints share contract. Old whole suite preserves generic clean/mechanical/owned-conflict/unchanged-tree/rerere/fetch.\n\nIndependently mutate repository/physical worktree/branch/head/base/graph/plan/scope/builder bytes-mode-source/combined snapshot/generated types-modes-bytes-two IDs/conflict stages-MERGE_HEAD-AUTO_MERGE-index/signer/private proof-key-ancestry. Cover missing/forged/foreign/stale/oversized/truncated proof/path-ancestor-symlink/undeclared outputs/non-generated conflicts and late generation-staging-commit-coverage races. Retain failures; unchanged-tree stays exact, caller flags/pending merge/manual commit never authorize completion.\n\nP31-1/ARCH-53-04: BEFORE apply atomically retain full authoritative combined generation/bounded protected intent. Per eligible path bind original bytes/type/executable mode/unmerged stages and intended generated bytes/mode/resolved stages to full original/intended index/source under existing per-worktree lock/HMAC. Resume admits per-path mixes of exactly original/intended states, including index changed by own first git add. Idempotently reconcile remaining writes/chmods/adds/recompute full intended package-tree; refuse third states/unrelated index-source changes/foreign operations. Keep last retained source/package until replacement durable. Extend Task1's existing canonical-host generatedBaseMergeAuthority only, no general journal/continuation API. z29z injects after one write/chmod/first add/partial multiple-conflict resolution, then cold reenters exact original argv. Require one same signed commit/exact ordered parents-tree-configured signer/full inventory-two IDs/independent genuine coverage/current consumer; no second commit/old-host fixture reuse. Negatives: third bytes-mode-stage-index tamper/interrupted retention replacement. Manual C09 is no full crash proof.\n\nRecovery uses exact public base-merge argv/no continue; only authenticated original proof precedes dirty/preexisting refusal. Before writes compare all pins/operation-owned stages/sealed resolved tree; recompute full package vs sealed source-output-tree, never saved pass. Faults: prepared-not-started/post-conflict/staged/signed-before-HEAD/HEAD-before-cleanup/committed-uncovered/coverage-before-ack. Seal signed OID before CAS/no second commit; verify signature/parents/tree/physical state/same coverage/idempotent writer equality after ambiguous write. Refuse changed HEAD-base-index-merge-state-signer-proof/foreign abort-reset/manual commit/synthetic receipt/push. Completion idempotent; later head/base changes retain history only.\n\nWhole builder alone generates six mirrors/two final IDs; independently verify full inventory/IDs/cold/tamper after source corrections. Preserve delivered T32 layout/T33 guarded source/promotions. Final same-tree actual CI owes all24 purposes/every split runner/both whole consumers. Keep case180000/concurrency2/child8MiB/native1MiB/result128KiB/TTL. Bounded deterministic generated-package exception only; no general merge/continuation/retry/cache/registry/caller bypass.\n  </action>\n  <verify>\n    <automated>node plugins/delivery-pipeline/scripts/publish-gate.cjs --base origin/main --working-tree --json</automated>\n    <ci-regression>Full same-head CI coverage below.</ci-regression>\n    <human-check>Deliver and merge T31 under its current-head human review before T30 consumes this supported mechanism; actual T30 merge, fresh remote CI and native CI repair acceptance remain future obligations.</human-check>\n  </verify>\n  <done>Actual same-head CI passes z29z/generic merge generation/signature/coverage/recovery/refusals, whole z17's110 cases/12 historical rows/hash/inventory/parity, original archive fixture and audited exact reader registry. Wrapped-base and candidate/finalization/CLI/cold recovery keep original authority/one operation/no duplicate commit-launch-push. All24 purposes/T32 residual+seven/both consumers pass before guard merge; no historical credit.</done>\n</task>\n\n</tasks>\n\n## Current operational verification amendment\n\nAuthorization: local1\u2192Source native finalization/signature\u2192prompt concrete nonempty draft\u2192full current-head CI\u2192ticket reviews/human checkpoint/merge guard. Preserve scope/comment/current-source/ownership/scoped-tree checks; no broad sandbox/local regression/predraft phase review. Final epicPR after ticket merges: phase code-review\u2192integrator\u2192architecture; ticket-to-epic architecture skipped-by-target. Standing authority\u2260GitHub APPROVED. HOST historical; diagnostics only genuine CI failure; HOST1MiB/child8MiB/bounds/credit unchanged.\n\n## Verification commands\n\n- `node plugins/delivery-pipeline/scripts/publish-gate.cjs --base origin/main --working-tree --json`\n\n## Required current-head CI regression coverage\n\nHOST24 argv remain verbatim CI purposes; whole files\u2192unitTasks/selectTaskShard via .github/workflows/test.yml/tests/unit/run.sh, grouped argv\u2192every file. Phase49 six selectors/all107/[1,1,24,25,28,28]; gate rest publish+make test-fast-rest. No filtered/dropped cases. Dynamic append preserves first16/50/58 a\u2013g/60 a\u2013i;33=64unit/67checks;31 x/y/z=67/70;30 z30/b/c/d/e/f=73/76. Future unrun. fail-fast:false/unit90min/rest30min/aggregate shards+every-unit+rest success unchanged. D/T33-CI-first-full-regression-coverage-source-proof.json proves scheduling only.\n\nScheduled whole tests/unit/phase53-z17-ci-job-attempts.test.cjs:110 cases/current inventory/canonical parity/12-row immutable-parent normalization on repaired current head. No new local argv/profile/selector/shard.\n\nSame-head CI also runs whole codex-arch-review-context.test.cjs (archive/bookkeeping/following review), whole phase-code-review-publish.test.cjs (audited exact registry/all consumers/detection/refusals), x/y/z (new cases/fresh selectors/wrapped live base/candidate-finalization/CLI-cold crashes). Run41520468477 failures10/14/66/67/prior372 logs stay historical; no f251 pass carry/new local command/profile/selector/allowlist/bound.\n\n- `node plugins/delivery-pipeline/scripts/publish-gate.cjs --base origin/main --working-tree --json`\n- `node --test tests/unit/phase53-z29x-native-ci-fix-contract.test.cjs`\n- `node --test tests/unit/phase53-z29y-native-ci-fix-recovery.test.cjs`\n- `node --test tests/unit/phase53-z29z-generated-base-merge.test.cjs`\n- `node --test tests/unit/base-merge.test.cjs`\n- `node --test tests/unit/codex-delivery-host.test.cjs tests/unit/codex-runtime-host.test.cjs tests/unit/codex-dispatch-adapter.test.cjs`\n- `node --test tests/unit/pipeline-config.test.cjs tests/unit/phase-code-review.test.cjs tests/unit/deliver-dispatch.test.cjs`\n- `node --test tests/unit/run-contract.test.cjs tests/unit/run-store.test.cjs tests/unit/run-controller.test.cjs tests/unit/model-policy.test.cjs tests/unit/marketplace-install.test.cjs tests/unit/run-scope.test.cjs tests/unit/codex-delivery-host.test.cjs`\n- `node --test tests/unit/role-artifact.test.cjs tests/unit/judgment-artifacts.test.cjs tests/unit/judgment-contract.test.cjs`\n- `node --test tests/unit/phase53-immutable-reuse.test.cjs tests/unit/host-verification.test.cjs`\n- `node --test tests/unit/phase53-review-recovery.test.cjs tests/unit/phase-code-review-publish.test.cjs`\n- `node --test tests/unit/phase53-z29a-fixer-original-custody.test.cjs`\n- `node --test tests/unit/phase53-z29b-fixer-source-history.test.cjs`\n- `node --test tests/unit/phase53-z29c-historical-direct.test.cjs`\n- `node --test tests/unit/phase53-z29d-historical-admitted.test.cjs`\n- `node --test tests/unit/phase53-z29e-historical-pending.test.cjs`\n- `node --test tests/unit/phase53-z29f-historical-action-repeat.test.cjs`\n- `node --test tests/unit/phase53-z29g-historical-action-covered.test.cjs`\n- `node --test tests/unit/phase49-package-publication.test.cjs`\n- `node --test tests/unit/phase53-z23-verification-owner-heartbeat.test.cjs`\n- `node --test tests/unit/phase53-z29t-role-architecture-archives.test.cjs`\n- `node --test tests/unit/phase53-z29u-role-containment.test.cjs`\n- `node --test tests/unit/phase53-z29v-role-code-review.test.cjs`\n- `node --test tests/unit/phase53-z29w-role-integration.test.cjs`\n\n## Admission and delivery order\n\nCI preserves20+four34 argv=24 purposes/both oldhost residual+seven unions. SOURCE parser/loadConfig/repoValue/assignPlan admits local1; config219/entries/timeouts/six1800 integration overrides unchanged. Fresh Gate2/GSD/checker; no config write.\n\nDependency29\u219234\u219232\u219233\u219231\u219230/waves25\u219226\u219227\u219228\u219229\u219230. Historical prepublication: merge test-only34\u219232 from clean E, never unmerged W31 product. Preserve frozen14-file archive/unpublished dirty W31 before base operations; clean backed-up owned paths only. After34/32/33 use clean supported worktree/native host/fast-forward or base-merge. Three-way archived14-owner DELTA vs immutable b2f752\u2192accepted33 epic; no14-file restore over33 legacy guard/package IDs. Retain baseline guards/publication fixes/promotions/T32 files-helpers-adapters/unowned h-i/34 t-u-v-w/helper/residual bytes. No dirty W31 baseMerge/manual product commit/force/rebase. Whole-builder regeneration/resulting-tree verification required; shared31/30 IDs forbid parallel implementation/publication. Source ordinary executor/original receipt/local1 HOST/signed candidate/scope/comment/prompt draft/full CI/reviews/human checkpoint/guard delivers31; sentinel-merge epic FIRST. Red OPEN PR642 forbids executor/review-fix/other provider-session/generic Agent/hand-built CI repair.\n\nThen delivered T31 trusted base-merge: T-53-30/actual worktree/fresh live base/canonical --graph/--json. Before fresh CI/preparation require Task1/3 full combined generation/signed oldHead-newBase-tree/independent real coverage/clean completion. Same-argv recovery needs original authenticated proof. No old W entrypoint/unproved W-native-committed SOURCE bootstrap/manual commit-coverage/stale ours-theirs/rebase-force-reset/direct epic commit. Non-generated conflicts preserve both semantics for authorized resolution/verification; verify claimed old-owner byte equality. Normal nonforce publication refreshes actual checked-head/head/base CI;70fd logs historical. Green still owes amended30 ownership/semantic reconciliation; red uses delivered ci-fix builder/new failure bytes/accepted amended30\u2192native repair/HOST/finalization/new CI/reviews.\n\n<threat_model>\n## Trust boundaries\n\n| Boundary | Description |\n|---|---|\n| Caller/graph/live CI \u2192 host-private subject | Only authenticated canonical/current checked-head failure facts authorize launch |\n| Native runtime/original recorder \u2192 candidate/repair consumer | Actual role/policy/session/prompt/transcript and complete result custody grant authority |\n| Private original CI operation \u2192 recorder recovery | Only authenticated host operation and genuine predecessor fence authorize private record/index/finalization; caller labels/IDs grant none |\n| HOST/candidate \u2192 signed commit/publication | One tree, exact commands, original fixer coverage and current live facts govern publication |\n| Canonical source \u2192 generated installed package | Complete independent inventory and both identities bind the actual combined source |\n| Diverged signed branches \u2192 generated-conflict merge/coverage | Protected original operation pins graph/source/parents/tree/signer; deterministic generation and existing coverage independently authorize completion |\n\n## STRIDE threat register\n\n| Threat ID | Category | Component | Severity | Disposition | Mitigation plan |\n|---|---|---|---|---|---|\n| T-53-31-01 | Spoofing | CI launch subject | high | mitigate | Task1 canonical scope/OPEN PR/current head/base/actual checked-head/run/attempt/job; Task2 independent foreign/stale negatives |\n| T-53-31-02 | Tampering | External failure custody | high | mitigate | Task1 protected immutable physical snapshot/exact bytes/modes/read brackets; Task2 substitutions/races/overflow and late rechecks |\n| T-53-31-03 | Elevation of privilege | CI policy/history | high | mitigate | CI-specific protected predecessors, existing policy verification/ceilings and no caller promotion or review-history reuse |\n| T-53-31-04 | Repudiation | Native completion/artifact | high | mitigate | Complete original ci-fix prompt/transcript/session/receipt/producer pins, generic repair seal/validate/current read; no fabricated receipt |\n| T-53-31-05 | Tampering | Candidate/fixer coverage/publication | high | mitigate | Exact HOST one tree, original CI receipt, real fixer coverage and trusted signature; refuse failed verification/stale subject |\n| T-53-31-06 | Denial of service | Recovery/unknown publication | high | mitigate | Reconcile original native/record/index/ack/signed publication before retry; keep unknown push pending, no replay |\n| T-53-31-07 | Tampering | Package/physical coverage | high | mitigate | Whole-builder inventory/two IDs/cold/tamper; delivered T32 full original residual+seven/eight lifecycles/consumer seams rechecked read-only on final T31 tree; exact first58 a\u2013g/first60 a\u2013i, full64\u219267/future union |\n| T-53-31-08 | Tampering | Generated-conflict completion | high | mitigate | Tasks1/3 exact derived generated-only set, complete combined source/whole builder, sealed source/index/parents/tree, late checks; arbitrary owned source conflicts refuse |\n| T-53-31-09 | Elevation of privilege | Merge signing and coverage recovery | high | mitigate | Protected host original-operation proof, configured signer, exact signed commit before HEAD CAS, actual existing base-merge writer/reader; no manual adoption or forged coverage |\n| T-53-31-10 | Repudiation | Interrupted generated base merge | high | mitigate | Task3 same-argv original-state reconciliation across commit/HEAD/cleanup/coverage/ack, idempotent exact record, stale/tamper/foreign refusal and no push replay |\n| T-53-31-11 | Elevation of privilege | Original CI recorder eligibility | high | mitigate | Tasks1\u20132 opaque host-owned authenticated CI operation, module-private RECORDER_AUTHORITY, exact semantic-first/no-prior separation and forged/cross-role refusals |\n| T-53-31-12 | Tampering | CI index/predecessor/ack recovery | high | mitigate | Tasks1\u20132 exact original record/index repair under existing locks, authenticated repair marker/fence/consumption, current writer checks and cold interrupted-original tests without native/push replay |\n| T-53-SC | Tampering | npm/pip/cargo installs | high | mitigate | No new packages/install; a later package proposal requires the separate legitimacy protocol |\n</threat_model>\n\n<verification>\nOnly31:21 owners/three tasks/local1/UTF8<=60000; other plans/config219/contexts/Source frozen. Source Gate2/GSD verify; metadata grants no product/native credit.\n\nAfter32/33/Tasks1\u20133 owe actual stable-tree CI24/current reviews/human approval/merge\u2192T30 signed-covered-clean base merge/fresh remote CI. Genuine red\u2192original native ci-fix/artifact/HOST/fixer/new CI/reviews; green owes amended30 scope/semantics. Preserve candidate/HOST/CI/refusal history; no fabricated ci_rerun. Fixtures grant no native/phase credit. Source/CodeReview/integrator/target-required architecture/current CI/R8 INCOMPLETE/zero semantic credit/no actual Anthropic acceptance remain.\n</verification>\n\n## Multi-source coverage audit\n\nCOVERED assigns work, not acceptance. Unchanged01\u201329/amended30 retain other requirements; none omitted/deferred.\n\n| Source | Assignment | Status |\n|---|---|---|\n| GOAL; F53-01/04/06\u201312 |31 Tasks1\u20133 native CI/evidence/recorder/recovery/generated merge; unchanged01\u201329 and30 cover remaining five-area/both-runtime work | COVERED |\n| F53-02/03/05 | Amended30/unchanged01\u201329 full semantic originals/review/preparation | COVERED |\n| Research/source/checker | Tasks1\u20133 builder/CLI/external custody/actual policy/epoch/original completion/uncertain push/private recorder/semantic exclusions; full package/cold/tamper/prefix; supported T30 handoff | COVERED |\n| Research/context D-01/02/03/05/06/07/08 |32 residual+seven/eight lifecycles/two consumers\u219231 full CI24; frozen51/58/60/67, full73/76/exact34-future35;30 all61 purposes/eight positives/six timed files; history/authority/scope/resources/coordinator unchanged | COVERED |\n| Actual CI/native/review | Task3 archive/registry/wrapped base/crash association/strict process-owned merge lock; all current-head CI/reviews owed | COVERED |\n\nD-04 research/planning expansion stays superseded by D-05; deferred research/planning optimization, generic platforms, policy changes and broad CI campaigns are excluded. A31-1 unmerged bootstrap is not selected; A31-2 six-file T30 fit and actual native failure/head remain unknown until normal delivery. Generic artifact sufficiency is source-backed by repairResultData/genericEnvelope; an actual missing extension must return a precise scope finding, not an undeclared owner.\n\n## Rollback\n\nCoordinator rollback reverses accepted31 host/merge/fixture-registry/x-y-z changes/whole-package regeneration. Keep delivered32 layout/loading union unless explicitly rolling back32 through its supported path; no oldhost aggregation/stale prefixes. Retain original/signed-native-failed history; authentic pins reconcile merge, never reset foreign state. Restored refusal grants no T30 merge/executor repair. Changed head/base re-owes CI/reviews; no release authority.\n\n<success_criteria>\nAcceptance: authentic CI/current/private first\u2192progress\u2192repeat\u2192exhausted/semantic eligibility; exact signed generated merge/original recovery/full package/inventory/prefix; read-only delivered32 residual+7/8 lifecycles/inert helpers/two consumers;21 owners/three tasks/local1/full24 CI+z17/archive/registry. Wrapped base/candidate-crash association;31 before supported T30 merge/fresh red CI. No planning/native/phase credit.\n</success_criteria>\n\n<output>\nExecution records local1/CI24+whole z17/archive/registry and unchanged implementation/history/package/native evidence in53-31-SUMMARY.md. Callback: only53-31-PLAN.md; no commit/export/admission/state-sync; independent checker follows.\n</output>\n"
};
const profiles = Object.freeze({
  scaled: Object.freeze({ name: 'actual34-indexed', count: SCALED_TICKET_COUNT, owners,
    roster: [...canonicalRoster.filter(row => row.number !== 30), ...deliveredRoster,
      { ...canonicalRoster.at(-1), wave: 30, depends_on: ['31'], files: owners }] }),
  historical: Object.freeze({ name: 'historical30-full', count: 30, owners: historicalOwners, roster: canonicalRoster }),
});
for (const profile of Object.values(profiles)) {
  Object.freeze(profile.owners); Object.freeze(profile.roster);
  for (const row of profile.roster) {
    Object.freeze(row.files); Object.freeze(row.depends_on); Object.freeze(row);
  }
}
const governingContext = 'D-01/D-02/D-03/D-05/D-06/D-07/D-08: retain full scope, originals, failures and independent native authority. R8 INCOMPLETE; zero semantic credit.';
const requirements = ['F53-02', 'F53-03', 'F53-04', 'F53-06', 'F53-08', 'F53-09', 'F53-10', 'F53-11', 'F53-12'];
function configure30(f, future = false, oversized = true, profile = profiles.scaled) {
  const setup = h.setup('phase53-codex-integration.test.cjs', "test('ordinary Codex caller", 'write, commit');
  const graph = JSON.parse(fs.readFileSync(path.join(f.graphDir, 'tickets.json'))), template = f.rows['T-49-02'];
  const futureNumber = profile.count + 1;
  const roster = [...h.clone(profile.roster), ...(future ? [{ number: futureNumber, title: 'Future dependency consumer', wave: 31,
    depends_on: ['30'], files: ['src/future-provider.cjs', 'src/future-consumer.cjs'] }] : [])];
  assert.equal(roster.length, profile.count + Number(future));
  const exactSources = new Set([...profile.owners, ...(profile === profiles.scaled ? deliveredRoster.flatMap(row => row.files) : [])]);
  const files = new Set(roster.flatMap(row => row.files));
  if (profile === profiles.scaled) {
    const prerequisiteFiles = [...new Set(deliveredRoster.flatMap(row => row.files))];
    for (const file of prerequisiteFiles) setup.write(f.worktree, file, fs.readFileSync(path.join(h.ROOT, file)));
    old.git(f.worktree, 'add', '--', ...prerequisiteFiles);
    setup.commit(f, 'complete delivered prerequisite sources on the fixture base');
    f.base = f.head; f.pr.baseRefOid = f.base;
    old.git(f.worktree, 'update-ref', 'refs/heads/main', f.base);
    old.git(f.worktree, 'update-ref', 'refs/remotes/origin/main', f.base);
  }

  for (const file of files) setup.write(f.worktree, file, exactSources.has(file)
    ? fs.readFileSync(path.join(h.ROOT, file))
    : '"use strict";\nmodule.exports = ' + JSON.stringify({ fixture: 'canonical30', path: file,
      contract: 'Preserve producer value, consumer failures, INFO and exact original authority.' }) + ';\n');
  if (future) {
    setup.write(f.worktree, 'src/future-provider.cjs', 'exports.value = ' + futureNumber + ';\n');
    setup.write(f.worktree, 'src/future-consumer.cjs', "module.exports = require('./future-provider.cjs').value;\n");
  }
  if (oversized) {
    const padding = 'src/generated-material-retention-padding.txt';
    roster.find(row => row.number === 1).files = [...roster.find(row => row.number === 1).files, padding];
    files.add(padding);
    setup.write(f.worktree, padding, '');
  }
  for (const entry of roster) {
    const number = String(entry.number).padStart(2, '0'), id = 'T-49-' + number;
    const depends_on = entry.depends_on.map(n => 'T-49-' + n);
    const row = { ...template, title: entry.title, branch: 'ticket/' + id, wave: entry.wave,
      files: entry.files, depends_on, plan: '.planning/phases/' + f.phase + '/49-' + number + '-PLAN.md' };
    f.rows[id] = row; f.state[id] = { status: 'merged', pr: 100 + entry.number, branch: row.branch,
      followup: { depends_on, prior_failure: 'actual29 diff4543996/default4194304 refused before model; no verdict',
        review: 'Retain INFO, limitations, disagreements and all original dispositions. R8 INCOMPLETE; zero credit' } };
    setup.write(f.worktree, row.plan, '---\nphase: 49\nplan: "' + number + '"\ntitle: ' + row.title
      + '\nfiles_modified: ' + JSON.stringify(row.files) + '\ndepends_on: ' + JSON.stringify(depends_on)
      + '\nwave: ' + row.wave + '\nrequirements: ' + JSON.stringify(requirements)
      + '\ndelivery: {risk: high, human_checkpoint: review}\n---\nADR-014\n'
      + '## Objective\nEvaluate the complete declared producer and consumer contract for ' + id + '.\n'
      + '## Context\n' + governingContext + '\n'
      + '## Acceptance criteria\n- Read every declared owner and dependency, preserve exact source, original INFO and failures.\n'
      + '## Tasks\n1. Implement the producer boundary.\n2. Verify complete consumer acceptance and failure behavior.\n'
      + '## Carried findings and dispositions\nINFO remains in originals; prior refusal remains prelaunch history.\n'
      + '## Verification commands\n- `node --test tests/unit/phase53-code-review.test.cjs`\n'
      + (profile === profiles.scaled && deliveredPlans[entry.number]
        ? '## Complete accepted prerequisite plan (original phase53 identity)\n' + deliveredPlans[entry.number] : ''));
  }
  const contextFiles = ['.planning/PROJECT.md', '.planning/STATE.md', '.planning/ROADMAP.md',
    '.planning/phases/' + f.phase + '/CONTEXT.md', '.planning/phases/' + f.phase + '/49-CONTEXT.md',
    '.planning/phases/' + f.phase + '/49-RESEARCH.md'];
  const contextPurpose = [
    'Complete ' + profile.name + ' code-review fixture: all ' + profile.owners.length + ' owners and every declared member remain in scope.',
    'Every fixture member is merged. Actual next native fit, current-head review, integration, architecture and CI remain owed.',
    'Five delivery areas: launches, verification, CI, review and recovery. Research/planning optimization remains deferred.',
    'Two parallel semantic responsibilities retain complete sources, required context, INFO, original failures and an independent final.',
    'Full current/future membership, plans, source aliases, criteria and carried dispositions remain required through cold consumers.',
    'Only current code-review material selects existing16777216; archive/catalog/original limits remain4194304. Storage proves no native judgment.',
  ];
  for (const [index, relative] of contextFiles.entries()) setup.write(f.worktree, relative,
    '# Complete canonical30 bounded fixture\n' + governingContext + '\n' + contextPurpose[index]
      + '\nMembers: ' + roster.map(row => 'T-49-' + String(row.number).padStart(2, '0')).join(', ') + '\n');
  setup.write(f.worktree, 'src/shared-contract.cjs', 'exports.value = 1;\n');
  setup.write(f.worktree, 'src/provider.cjs', "const shared = require('./shared-contract.cjs'); exports.value = shared.value;\n");
  graph.tickets = f.rows;
  setup.write(f.worktree, '.planning/graph/tickets.json', JSON.stringify(graph));
  setup.write(f.worktree, '.planning/graph/delivery-state.json', JSON.stringify(f.state));
  f.context30 = contextFiles.map(relative => ({ path: relative,
    content: fs.readFileSync(path.join(f.worktree, relative), 'utf8') }));
  const governing = { fixture: 'canonical30', context: governingContext, context_files: f.context30,
    roster, tickets: f.rows, delivery_state: f.state,
    owners: profile.owners.map(relative => ({ path: relative, sha256: h.hash(fs.readFileSync(path.join(f.worktree, relative))) })) };
  const finalPlan = f.rows['T-49-' + String(roster.at(-1).number).padStart(2, '0')].plan;
  setup.write(f.worktree, finalPlan, fs.readFileSync(path.join(f.worktree, finalPlan), 'utf8')
    + '## Complete bounded governing metadata\n' + JSON.stringify(governing) + '\n');
  old.git(f.worktree, 'add', '--', ...files);
  if (oversized) {
    const diff = childProcess.execFileSync('git', ['-C', f.worktree, 'diff', '--cached', '--no-ext-diff',
      '--no-textconv', '--unified=50', f.base, ...require(path.join(source, 'scripts/development-artifacts.cjs')).productPathspec()],
    { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
    const padding = 'src/generated-material-retention-padding.txt';
    setup.write(f.worktree, padding, 'x'.repeat(Math.max(1, 4194305 - Buffer.byteLength(diff))));
    old.git(f.worktree, 'add', '--', padding);
  }
  setup.commit(f, 'complete bounded canonical30 roster and source');
  f.memberHead = f.head;
  const binding = h.setup('phase53-codex-architecture.test.cjs', "test('caller architecture", 'phaseBinding').phaseBinding(f);
  const inventoryPath = h.physical(f.root, path.join(f.root, 'canonical30-roster.json'));
  fs.writeFileSync(inventoryPath, JSON.stringify({ rows: [] }), { mode: 0o600 });
  require(path.join(source, 'scripts/role-artifact.cjs')).registerPhaseArchiveRoster({ worktreePath: f.worktree,
    graphDir: f.graphDir, binding, inventoryPath, expectedInventoryDigest: h.hash(fs.readFileSync(inventoryPath)) });
  f.roster30 = roster; f.profile30 = profile; f.future30 = future;
  for (const file of exactSources) assert.deepEqual(fs.readFileSync(path.join(f.worktree, file)),
    fs.readFileSync(path.join(h.ROOT, file)), 'complete actual owner/prerequisite: ' + file);
}
function nativeHelpers30() {
  const file = path.join(h.ROOT, 'tests/fixtures/phase53/semantic-result-helpers.cjs');
  const loaded = new Module(file, module);
  loaded.filename = file; loaded.paths = Module._nodeModulePaths(path.dirname(file));
  const text = fs.readFileSync(file, 'utf8');
  const end = text.indexOf('async function publicRole('); assert.ok(end > 0);
  loaded._compile(text.slice(0, end) + '\nmodule.exports = { historicalSources, addReads };', file);
  return loaded.exports;
}
async function ownedPublicRole(role, runtime, options = {}) {
  const home = fs.realpathSync(process.env.HOME);
  assert.ok(path.basename(home).startsWith('z21-case-'));
  os.homedir = () => home;
  let plugin, api, restore, originalLoad, snapshots, nativeViews;
  await phase30('package setup', () => {
    for (const file of Object.keys(require.cache)) if (file.startsWith(source + path.sep)
        || file.startsWith(path.join(home, 'producer-'))) delete require.cache[file];
    const { historicalSources } = nativeHelpers30();
    const historical = options.historical ? historicalSources(options.historicalShared ? ['role-artifact.cjs']
      : ['role-artifact.cjs', 'codex-delivery-host.cjs', 'claude-role-host.cjs']) : [];
    plugin = fs.mkdtempSync(path.join(home, 'producer-'));
    fs.cpSync(source, plugin, { recursive: true });
    for (const [name, bytes] of historical) fs.writeFileSync(h.physical(home, path.join(plugin, 'scripts', name)), bytes);
    const smoke = h.setup('../smoke/phase53-review-acceptance.cjs', 'async function observeRetirement', 'routePayload');
    restore = smoke.routePayload(plugin); originalLoad = Module._load;
    api = require(path.join(plugin, 'scripts/role-artifact.cjs')); snapshots = new Map(); nativeViews = new Map();
    const observed = { ...api, ...(api.authenticateSemanticStageResult ? { authenticateSemanticStageResult(input) {
      const result = api.authenticateSemanticStageResult(input);
      nativeViews.set(result.assignment_id || 'final', h.clone(result)); return result;
    } } : {}), prepareSemanticReview(...args) {
      const value = api.prepareSemanticReview(...args); snapshots.set(value.snapshot_sha256, value); return value;
    } };
    Module._load = function(request, parent, ...args) {
      if (request !== 'node:test' && Module._resolveFilename(request, parent) === path.join(plugin, 'scripts/role-artifact.cjs')) return observed;
      return originalLoad.call(this, request, parent, ...args);
    };
  });
  try {
    const integration = h.setup('phase53-codex-integration.test.cjs', "test('ordinary Codex caller", 'publicIntegrationFixture');
    await integration.publicIntegrationFixture(async f => {
      let prepared, completed, failure, current, originals = [];
      const expected = new Map();
      await phase30('fixture setup', async () => {
        const code = h.setup('phase53-code-review.test.cjs', "for (const runtime of ['codex', 'claude']) {", 'fixture, setup');
        const preamble = require('../fixtures/phase53/codex-preamble-helpers.cjs');
        const { addReads } = nativeHelpers30();
        code.setup(f); preamble.installInstructions(f);
        await options.configureFixture?.(f);
        let installed = false;
        const controls = { session: options.session, reuseFinalSession: options.reuseFinalSession,
          native(rows, payload) {
            if (runtime === 'codex') {
              for (const row of rows) if (row.type === 'turn_context') delete row.payload.workspace_roots;
              const usage = rows.findIndex(row => row.payload?.type === 'token_count');
              if (usage >= 0) rows.splice(usage, 1);
              const { registered, template } = require('../fixtures/phase53/code-review-native-driver.cjs');
              const initial = template(registered('codex-agent-stream', 'codex-agent-stream-parent.jsonl'), row => row.payload?.role === 'user');
              const fields = preamble.initialization(f.worktree).payload;
              initial.payload.content = fields.content;
              initial.payload.internal_chat_message_metadata_passthrough = fields.internal_chat_message_metadata_passthrough;
              rows.splice(rows.findIndex(row => row.payload?.role === 'user'), 0, initial);
            }
            addReads(runtime, rows); options.native?.(rows, payload);
          },
          result(result, payload) {
            const snapshot = snapshots.get(payload.snapshot_sha256); assert.ok(snapshot);
            h.richReport(result, snapshot, options); options.result?.(result, payload);
            expected.set(result.assignment_id || 'final', h.clone(result));
            if (!options.full && !options.historical) {
              const wire = h.indexed(result, snapshot);
              for (const key of Object.keys(result)) delete result[key]; Object.assign(result, wire);
            }
          },
          onLaunch(...args) {
            if (!installed && runtime === 'codex') {
              const { fastPullRequestFixture } = h.setup('phase53-claude-review.test.cjs',
                "for (const role of ['integrator'", 'fastPullRequestFixture');
              const { projectOptions } = h.setup('phase49-incremental-integration.test.cjs',
                '\nif (require.main === module && integrationSelection.list)', 'projectOptions');
              fastPullRequestFixture(f, projectOptions(f)); installed = true;
            }
            options.onLaunch?.(...args);
          } };
        prepared = code.fixture(f, runtime, controls);
      });
      const produce = async () => {
        try { completed = await prepared.run(); } catch (error) { failure = error; }
        if (options.refusal) {
          assert.ok(failure, 'native refusal is required'); assert.match(failure.code || '', options.refusal);
        } else {
          if (failure) throw failure;
          assert.equal(prepared.launches.length, 3);
          assert.equal(new Set(prepared.launches.map(row => row.session)).size, 3);
        }
      };
      if (options.runPrepared) completed = await options.runPrepared(prepared, f, api, snapshots, nativeViews);
      else await phase30('producer', produce);
      const context = { f, api, plugin, prepared, snapshots, expected, originals, completed, failure, nativeViews };
      await phase30('current consumer', () => {
        current = api.currentCodeReviewVerdict(h.inputFor(f)); context.current = current;
        if (options.refusal) assert.equal(current, null); else assert.equal(current?.authenticated, true);
      });
      await phase30('original reader', () => {
        for (const launch of prepared.launches.filter(row => row.payload.stage === 'worker')) {
          const original = api.readSemanticOriginal({ worktreePath: f.worktree, snapshot_sha256: launch.payload.snapshot_sha256,
            assignment_id: launch.payload.assignment.id });
          const wireText = launch.text || launch.originalText;
          assert.equal(original.original_text, wireText);
          assert.deepEqual(original.result, expected.get(launch.payload.assignment.id));
          assert.equal(Object.hasOwn(original.reference, 'snapshot_sha256'), false);
          const manifest = JSON.parse(fs.readFileSync(path.join(f.worktree, original.reference.artifact_ref)));
          assert.equal(fs.readFileSync(path.join(f.worktree, manifest.files.findings.path), 'utf8'), wireText + '\n');
          for (const pin of [original.native.native_pin, original.native.output_pin]) {
            const raw = fs.readFileSync(pin.path); assert.equal(raw.length, pin.bytes); assert.equal(h.hash(raw), pin.sha256);
          }
          originals.push(original);
        }
        if (!options.historical && !options.refusal) {
          assert.equal(nativeViews.size, 3);
          for (const [key, view] of nativeViews) assert.deepEqual(view, expected.get(key));
        }
      });
      for (const [name, consumer] of [['producer', plugin], ['shipped', shipped]]) {
        await phase30('cold ' + name + ' current', () => {
          const value = h.cold(f, role, consumer);
          assert.deepEqual(value, current); context[name + 'Verdict'] = value;
        });
        await phase30('cold ' + name + ' originals', () => {
          assert.deepEqual(context[name + 'Originals'] = h.cold(f, role, consumer, originals), originals);
        });
      }
      await phase30('staged package', () => { context.staged = stagePackage(f.root); });
      await phase30('cold staged current', () => {
        assert.deepEqual(context.stagedVerdict = h.cold(f, role, context.staged), current);
      });
      await phase30('cold staged originals', () => {
        assert.deepEqual(context.stagedOriginals = h.cold(f, role, context.staged, originals), originals);
      });
      await phase30('unchanged recovery', async () => {
        context.recoveryArchive = h.inventory(path.join(f.worktree, '.shipyard-role-artifacts'));
        context.recoveryAuthority = h.inventory(api.archiveAuthorityDirectory(f.worktree));
        const count = prepared.launches.length;
        if (!options.refusal) {
          context.recovered = await prepared.run();
          assert.deepEqual(context.recovered.result, completed.result);
        }
        assert.equal(prepared.launches.length, count);
        assert.deepEqual(h.inventory(path.join(f.worktree, '.shipyard-role-artifacts')), context.recoveryArchive);
        assert.deepEqual(h.inventory(api.archiveAuthorityDirectory(f.worktree)), context.recoveryAuthority);
      });
      if ([0, 1, 4, 5].includes(workerData.index)) {
        let before, originalsBefore, pins;
        await phase30('expanded full wire refuses existing bound', () => {
          const expanded = expected.get('final'), text = JSON.stringify(expanded);
          before = h.inventory(path.join(f.worktree, '.shipyard-role-artifacts'));
          originalsBefore = h.clone(originals);
          pins = evidence(context).launches.map(row => prepared.recorder.getVerifiedRecord(row.dispatch_id));
          assert.ok(Buffer.byteLength(text) > 131072);
          assert.throws(() => h.internals().semanticWireBound({ result: expanded, text }),
            error => error.code === 'SEMANTIC_REVIEW_RESULT_OVER_BOUND');
          for (const [key, view] of nativeViews) {
            assert.deepEqual(view, expected.get(key));
            for (const seam of view.seams) {
              assert.ok(Array.isArray(seam.evidence));
              assert.equal(typeof seam.observation.reviewer, 'string');
              assert.equal(typeof seam.observation.order, 'number');
            }
          }
        });
        await phase30('post-overflow current', () => assert.deepEqual(api.currentCodeReviewVerdict(h.inputFor(f)), current));
        await phase30('post-overflow cold', () => {
          assert.deepEqual(h.cold(f, role, context.staged), current);
          assert.deepEqual(h.cold(f, role, context.staged, originals), originalsBefore);
          assert.deepEqual(h.inventory(path.join(f.worktree, '.shipyard-role-artifacts')), before);
          assert.deepEqual(evidence(context).launches.map(row => prepared.recorder.getVerifiedRecord(row.dispatch_id)), pins);
          assert.equal(prepared.launches.length, 3);
        });
      }
      if (options.phasedInspect) await options.inspect(context);
      else await phase30('purpose assertions', () => options.inspect?.(context));
    });
  } finally { Module._load = originalLoad; restore(); }
}

async function canonicalPublic30(runtime, options) {
  const load = Module._load, facades = new Map();
  const inflightDispatchId = 'canonicalfixture29-' + runtime + '-review';
  let fixture, bookkeeping, dispatch;
  Module._load = function(request, parent, ...args) {
    const exported = load.call(this, request, parent, ...args);
    const filename = Module._resolveFilename(request, parent);
    if (typeof filename !== 'string' || !filename.startsWith(path.join(process.env.HOME, 'producer-')))
      return exported;
    if (facades.has(filename)) return facades.get(filename);
    if (filename.endsWith('/scripts/codex-code-review-context.cjs')) {
      const facade = { ...exported, prepareSemantic(scope, launch, settings) {
        if (scope.worktree !== fixture?.worktree) return exported.prepareSemantic(scope, launch, settings);
        const context = exported.prepareSemantic(scope, launch, { ...settings, inflightDispatchId });
        exported.admitBookkeeping(context);
        return context;
      } };
      facades.set(filename, facade); return facade;
    }
    if (runtime === 'codex' && filename.endsWith('/scripts/codex-delivery-host.cjs')) {
      const facade = { ...exported, createCodexDeliveryHost(settings) {
        const host = exported.createCodexDeliveryHost(settings);
        if (settings.scope?.worktree !== fixture?.worktree) return host;
        return { ...host, run(request) {
          return host.run(request.role === 'code-review'
            ? { ...request, dispatch_id: inflightDispatchId } : request);
        } };
      } };
      facades.set(filename, facade); return facade;
    }
    return exported;
  };
  try {
    await ownedPublicRole('code-review', runtime, { ...options,
      async configureFixture(f) {
        fixture = f; await options.configureFixture(f);
        const setup = h.setup('phase53-codex-integration.test.cjs', "test('ordinary Codex caller", 'commit');
        const binding = h.setup('phase53-codex-architecture.test.cjs', "test('caller architecture", 'phaseBinding').phaseBinding(f);
        dispatch = require(path.join(source, 'scripts/dispatch-record.cjs'));
        bookkeeping = { graphDir: f.graphDir, worktree: f.worktree, ticket: binding.subject,
          role: 'code-review', host: runtime, dispatch_id: inflightDispatchId, pid: process.pid, refreshBoard: false };
        dispatch.recordInflight(bookkeeping);
        setup.commit(f, 'CANONICALFIXTURE29 retain genuine preparation bookkeeping');
        f.memberHead = f.head;
      },
      async inspect(context) {
        try { await options.inspect(context); }
        finally { if (bookkeeping) dispatch.clearInflight(bookkeeping); }
      },
    });
  } finally { Module._load = load; }
}
async function public30(runtime, options = {}) {
  const profile = options.profile || profiles.scaled;
  return canonicalPublic30(runtime, { ...options,
    result(result, payload) {
      if (profile === profiles.scaled) for (const [index, seam] of result.seams.entries()) {
        seam.rationale = options.incomplete ? 'Context unavailable.' : 'Checked.';
        seam.evidence = ['src/provider.cjs:1', 'src/consumer.cjs:1'];
        seam.observation = { order: index, reviewer: result.assignment_id || 'independent-final' };
      }
      options.result?.(result, payload);
    },
    native(rows, payload) {
      if (payload.material.some(row => row.bytes > 4194304)) oversizedRead(runtime, rows, payload);
      options.native?.(rows, payload);
    },
    onLaunch(launch, all) {
      if (all.length === 2) {
        assert.equal(all[0].payload.stage, 'worker'); assert.equal(launch.payload.stage, 'worker');
        assert.equal(all[0].text || all[0].originalText, undefined, 'both fixture workers are simultaneously in flight');
      }
      if (launch.payload.stage === 'final') {
        assert.equal(all.length, 3); assert.equal(launch.payload.originals.length, 2);
        assert.ok(all.slice(0, 2).every(row => row.text || row.originalText));
      }
      options.onLaunch?.(launch, all);
    },
    configureFixture(f) { configure30(f, options.future, options.oversized !== false, profile); options.configureFixture?.(f); },
  });
}

function evidence(context, consumer = context.plugin) {
  const { f, prepared, snapshots } = context;
  const api = old.internals(consumer), snapshot = [...snapshots.values()][0];
  const record = api.semanticRecord(f.worktree, snapshot.snapshot_sha256);
  const launches = prepared.launches.map(row => envelope(api, f, snapshot, row));
  return { api, snapshot, record, launches };
}
function assertPositive(context, full, future) {
  const { f, prepared, originals, expected, current, completed, recovered } = context;
  const { api, snapshot, record, launches } = evidence(context), staged = context.staged;
  assert.equal(snapshot.identity.ticket_set.length, f.profile30.count + Number(future));
  assert.equal(snapshot.responsibility_tickets.length, f.roster30.length);
  for (const entry of f.roster30) {
    const id = 'T-49-' + String(entry.number).padStart(2, '0');
    const ticket = snapshot.responsibility_tickets.find(row => row.id === id);
    assert.ok(ticket); assert.deepEqual(ticket.files, entry.files);
    assert.deepEqual(ticket.depends_on, entry.depends_on.map(n => 'T-49-' + n));
    const plan = snapshot.material.find(row => row.aliases.some(alias => alias.path === ticket.plan));
    assert.ok(plan); assert.match(plan.content, /Acceptance criteria/); assert.ok(plan.content.includes(governingContext));
    assert.ok(snapshot.pins.some(pin => pin.path === ticket.plan));
    for (const file of entry.files) assert.ok(snapshot.material.some(row => row.aliases.some(alias => alias.path === file)), file);
  }
  assert.deepEqual([...snapshot.assignments.flatMap(row => row.primary_obligation_ids)].sort(),
    snapshot.obligations.map(row => row.id).sort());
  assert.equal(new Set(snapshot.assignments.flatMap(row => row.primary_obligation_ids)).size, snapshot.obligations.length);
  if (future) {
    assert.ok(snapshot.obligations.some(row => row.path === 'src/future-consumer.cjs'));
    assert.ok(snapshot.seams.some(row => row.consumer === 'src/future-consumer.cjs' && row.producer === 'src/future-provider.cjs'));
  }
  assert.ok(snapshot.identity.bookkeeping.length);
  const governingPlan = snapshot.material.find(row => row.aliases.some(alias => alias.path ===
    f.rows['T-49-' + (future ? String(f.profile30.count + 1) : '30')].plan));
  assert.ok(governingPlan.content.includes(JSON.stringify(f.state)));
  assert.ok(governingPlan.content.includes('actual29 diff4543996/default4194304 refused before model; no verdict'));
  for (const context of f.context30) {
    assert.ok(governingPlan.content.includes(JSON.stringify(context.content).slice(1, -1)), context.path);
    assert.ok(context.content.includes(governingContext));
  }
  assert.equal(snapshot.criteria, require(path.join(source, 'scripts/claude-reference-content.cjs')).loadClaudeReferenceContent('code-review'));
  assert.equal(prepared.launches.length, 3); assert.equal(originals.length, 2);
  assert.equal(new Set(prepared.launches.map(row => row.session)).size, 3);
  const diff = snapshot.material.find(row => row.content.startsWith('diff --git') && row.bytes > 4194304);
  assert.ok(diff, 'complete public producer diff exceeds archive default');
  const exactDiff = childProcess.execFileSync('git', ['-C', f.worktree, 'diff', '--no-ext-diff', '--no-textconv',
    '--unified=50', snapshot.identity.merge_base + '...' + snapshot.identity.head,
    ...require(path.join(source, 'scripts/development-artifacts.cjs')).productPathspec()],
  { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  assert.equal(diff.content, exactDiff); assert.equal(diff.bytes, Buffer.byteLength(exactDiff));
  assert.equal(diff.sha256, h.hash(exactDiff));
  assert.ok(diff.aliases.length); assert.deepEqual(fs.readFileSync(launches.at(-1) && payloadFor(launches.at(-1)).material
    .find(row => row.source_id === diff.source_id).read_path), Buffer.from(exactDiff));
  for (const [index, launch] of launches.entries()) {
    const observed = prepared.launches[index], payload = payloadFor(launch);
    const supplied = observed.payload.material.find(row => row.source_id === diff.source_id);
    if (supplied) {
      assert.equal(supplied.content, exactDiff);
      assert.equal(supplied.sha256, diff.sha256); assert.deepEqual(supplied.aliases, diff.aliases);
    } else {
      assert.equal(launch.stage, 'worker');
      assert.ok(!snapshot.assignments.find(row => row.id === launch.assignment_id).required_material_source_ids.includes(diff.source_id));
    }
    const trusted = api.trustedRecord({ recorder: prepared.recorder, dispatchId: launch.dispatch_id });
    const result = api.authenticatedSemanticResult(trusted, launch, record);
    assert.equal(result.native.reads.semantic_credit, false); assert.deepEqual(result.native.reads.incomplete, []);
    const readId = 'z21-read-' + payload.material.findIndex(row => row.source_id === diff.source_id);
    if (supplied) assert.ok(result.native.reads.completed.some(row => row.call_id === readId), 'actual complete oversized read');
    assert.equal(result.native.resource_failure, null);
    assert.deepEqual(result.result, expected.get(launch.assignment_id || 'final'));
    assert.ok(Buffer.byteLength(launch.input) <= 1048576);
    assert.equal(api.semanticPreflight(snapshot, launch).result_limit_bytes, 131072);
  }
  assert.ok(prepared.launches.slice(0, 2).some(row => row.payload.material.some(item => item.source_id === diff.source_id)));
  for (const [index, original] of originals.entries()) {
    assert.equal(original.original_text, prepared.launches[index].text || prepared.launches[index].originalText);
    assert.deepEqual(original.result, expected.get(original.reference.assignment_id));
    assert.ok(original.result.findings.some(row => row.severity === 'INFO'));
    assert.ok(original.result.conclusions.length >= 2); assert.deepEqual(original.result.limitations, []);
    assert.equal(original.native.reads.semantic_credit, false);
    assert.equal(original.native.session_id, prepared.launches[index].session);
    const trusted = prepared.recorder.getVerifiedRecord(original.reference.dispatch_id);
    assert.equal(trusted.receipt.runtime, snapshot.runtime); assert.equal(trusted.receipt.role, 'code-review');
    assert.equal(trusted.receipt.observed_effort, trusted.receipt.applied_effort);
    assert.notEqual(original.native.session_id, prepared.launches.at(-1).session);
    assert.equal(JSON.parse(original.original_text).result_format, full ? undefined : 'snapshot-indexed.v1');
    const descriptor = payloadFor(launches.at(-1)).originals[index];
    assert.deepEqual(descriptor.reference, original.reference);
    assert.equal(fs.readFileSync(descriptor.read_path, 'utf8'), original.original_text);
    if (!full) assert.deepEqual(JSON.parse(fs.readFileSync(descriptor.expanded_view.read_path)), original.result);
  }
  assert.deepEqual(expected.get('final').originals, originals.map(row => row.reference));
  assert.equal(current.authenticated, true); assert.deepEqual(context.stagedVerdict, current);
  assert.deepEqual(context.stagedOriginals, originals);
  assert.deepEqual(recovered.result, completed.result); assert.equal(prepared.launches.length, 3);
  assert.deepEqual(h.inventory(path.join(f.worktree, '.shipyard-role-artifacts')), context.recoveryArchive);
  assert.deepEqual(h.inventory(context.api.archiveAuthorityDirectory(f.worktree)), context.recoveryAuthority);
  old.bounds(api, snapshot, launches, originals, record);
  process.stdout.write(JSON.stringify({ fixture: f.profile30.name, runtime: snapshot.runtime,
    members: f.roster30.length, wire: full ? 'full' : 'snapshot-indexed.v1', complete_diff_bytes: diff.bytes,
    workers: 2, independent_final: 1, actual_next_native_fit: 'owed', R8: 'INCOMPLETE', semantic_credit: false }) + '\n');
}
for (const runtime of ['codex', 'claude']) for (const full of [false, true]) for (const future of [false, true]) {
  test(runtime + ' complete oversized ' + (full ? 'full' : 'indexed') + ' ' + (future ? 'future member' : 'current roster'),
    () => public30(runtime, { full, future, profile: full ? profiles.historical : profiles.scaled, inspect(context) { assertPositive(context, full, future); } }));
}
function storage(role = 'code-review', size = 0) {
  const root = fs.mkdtempSync(path.join(process.env.HOME, 'storage30-'));
  const worktree = path.join(root, 'worktree'), input_root = path.join(root, 'inputs');
  fs.mkdirSync(worktree); fs.mkdirSync(input_root, { mode: 0o700 });
  const content = 'a'.repeat(size), hash = h.hash(content);
  return { root, snapshot: { role, identity: { worktree }, material: [
    { source_id: 's-' + hash, content, sha256: hash, bytes: size, aliases: [{ path: 'src/value.cjs', pointer: '/source' }] }],
  obligations: [], seams: [] }, input_root };
}
function rejectedWrite(run) { assert.throws(run, error => error.code === 'ARTIFACT_WRITE'); }
for (const [role, maximum] of [['code-review', 16777216], ['integrator', 4194304], ['arch-review', 4194304]]) {
  test(role + ' storage-only selected/default exact boundary and one-byte overflow', () => {
    const api = a(), record = storage(role, maximum);
    const inputs = api.semanticInputFiles(record, [], true), file = inputs.material[0].read_path;
    assert.equal(fs.statSync(file).size, maximum);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.equal(fs.statSync(record.input_root).mode & 0o777, 0o700);
    assert.equal(inputs.material[0].sha256, h.hash(record.snapshot.material[0].content));
    const stat = fs.statSync(file);
    assert.deepEqual(api.semanticInputFiles(record, [], true), inputs);
    assert.equal(fs.statSync(file).ino, stat.ino); assert.equal(fs.statSync(file).mtimeMs, stat.mtimeMs);
    assert.deepEqual(api.semanticInputFiles(record), inputs);
    const overflow = storage(role, maximum + 1);
    rejectedWrite(() => api.semanticInputFiles(overflow, [], true));
    assert.deepEqual(fs.readdirSync(overflow.input_root), []);
    assert.equal(require(path.join(source, 'scripts/claude-role-host.cjs')).CODE_REVIEW_MATERIAL_MAX_BYTES, 16777216);
    assert.equal(api.HISTORICAL_ARCHIVE_MAX_BYTES, 4194304);
  });
}
for (const kind of ['catalog', 'original', 'expanded-original']) test(kind + ' storage-only exact default4MiB and +1', () => {
  const api = a();
  for (const overflow of [false, true]) {
    const record = storage(), bound = 4194304 + Number(overflow); let originals = [];
    if (kind === 'catalog') {
      record.snapshot.responsibility_view_version = 1;
      record.snapshot.obligations = [{ value: '' }];
      const inputs = api.semanticInputFiles(record, [], false, true);
      const bytes = h.stable({ responsibility_view_version: 1, material: inputs.material,
        obligations: record.snapshot.obligations, seams: [] });
      record.snapshot.obligations[0].value = 'x'.repeat(bound - Buffer.byteLength(bytes));
    } else {
      const original = { reference: { assignment_id: 'storage-only' }, native: {},
        original_text: '{"evidence":""}', result: { evidence: '' } };
      if (kind === 'original') original.original_text = JSON.stringify({ evidence: 'x'.repeat(bound - 15) });
      else {
        original.original_text = '{"result_format":"snapshot-indexed.v1"}';
        original.result.evidence = 'x'.repeat(bound - Buffer.byteLength(h.stable(original.result)));
      }
      originals = [original];
    }
    if (overflow) {
      rejectedWrite(() => api.semanticInputFiles(record, originals, true));
      assert.deepEqual(fs.readdirSync(record.input_root), [], 'failed publication rolls back only created sidecars');
    } else {
      const result = api.semanticInputFiles(record, originals, true);
      const descriptor = kind === 'catalog' ? result.catalog : kind === 'original' ? result.originals[0] : result.originals[0].expanded_view;
      assert.equal(descriptor.bytes, bound); assert.equal(fs.statSync(descriptor.read_path).size, bound);
      assert.deepEqual(api.semanticInputFiles(record, originals), result);
    }
  }
});
test('unrelated sidecars and archive writer keep default exact4MiB and +1 without native authority', () => {
  const api = a(), record = storage();
  for (const name of ['catalog.json', 'original.json', 'original-view.json', 'unrelated.txt', 'historical-archive.json']) {
    const file = path.join(record.root, name), bytes = Buffer.alloc(4194304, 97);
    api.writeImmutableArtifactFile(fs, file, bytes, name);
    assert.equal(fs.statSync(file).size, bytes.length);
    rejectedWrite(() => api.writeImmutableArtifactFile(fs, file + '-overflow', Buffer.alloc(4194305), name));
  }
});
for (const mutation of ['same-length', 'growth', 'truncation', 'missing', 'symlink', 'directory', 'ancestor'])
  test('storage-only immutable exact reader refuses ' + mutation + ' and never replaces accepted bytes', () => {
    const api = a(), record = storage('code-review', 4194305);
    const inputs = api.semanticInputFiles(record, [], true), file = inputs.material[0].read_path;
    const saved = fs.readFileSync(file), held = path.join(record.root, 'held');
    if (mutation === 'ancestor') {
      fs.renameSync(record.input_root, held); fs.symlinkSync(held, record.input_root);
    } else {
      fs.renameSync(file, held);
      if (mutation === 'same-length') fs.writeFileSync(file, Buffer.alloc(saved.length, 98));
      if (mutation === 'growth') fs.writeFileSync(file, Buffer.concat([saved, Buffer.from('b')]));
      if (mutation === 'truncation') fs.writeFileSync(file, saved.subarray(1));
      if (mutation === 'symlink') fs.symlinkSync(held, file);
      if (mutation === 'directory') fs.mkdirSync(file);
    }
    try {
      assert.throws(() => api.semanticInputFiles(record));
      if (!['missing', 'ancestor'].includes(mutation)) assert.throws(() => api.semanticInputFiles(record, [], true));
      if (mutation === 'ancestor') assert.throws(() => api.semanticInputFiles(record, [], true));
      assert.deepEqual(fs.readFileSync(mutation === 'ancestor' ? path.join(held, path.basename(file)) : held), saved);
    } finally {
      if (mutation === 'ancestor') { fs.unlinkSync(record.input_root); fs.renameSync(held, record.input_root); }
      else { fs.rmSync(file, { recursive: true, force: true }); fs.renameSync(held, file); }
    }
    assert.deepEqual(api.semanticInputFiles(record), inputs);
  });
test('storage-only path confinement rejects reviewed-worktree storage and nonphysical publication ancestry', () => {
  const api = a(), record = storage('code-review', 4194305);
  for (const input_root of [record.snapshot.identity.worktree, path.join(record.snapshot.identity.worktree, 'inputs'), 'relative'])
    assert.throws(() => api.semanticInputFiles({ ...record, input_root }, [], true));
  const alias = path.join(record.root, 'alias'); fs.symlinkSync(record.input_root, alias);
  assert.throws(() => api.semanticInputFiles({ ...record, input_root: path.join(alias, 'nested') }, [], true));
  assert.deepEqual(fs.readdirSync(record.input_root), []);
});
test('storage-only racing immutable publication authenticates winner bytes and rolls back only its own inodes', () => {
  const api = a(), record = storage(), link = fs.linkSync;
  for (const same of [true, false]) {
    const file = path.join(record.root, 'race-' + same), intended = Buffer.from('intended'); let raced = false;
    fs.linkSync = function(from, to) {
      if (to === file && !raced) {
        raced = true; fs.writeFileSync(file, same ? intended : Buffer.from('external'), { mode: 0o600 });
        throw Object.assign(Error('concurrent winner'), { code: 'EEXIST' });
      }
      return link.call(this, from, to);
    };
    try {
      const publish = () => api.withArchivePublication(record.snapshot.identity.worktree,
        () => api.writeImmutableArtifactFile(fs, file, intended, 'race'));
      if (same) assert.deepEqual(publish(), intended); else rejectedWrite(publish);
      assert.equal(raced, true); assert.equal(fs.readFileSync(file, 'utf8'), same ? 'intended' : 'external');
      assert.ok(!fs.readdirSync(record.root).some(name => name.endsWith('.tmp')));
    } finally { fs.linkSync = link; }
  }
  const existing = path.join(record.root, 'existing'); api.writeImmutableArtifactFile(fs, existing, 'original', 'existing');
  const created = path.join(record.root, 'created');
  assert.throws(() => api.withArchivePublication(record.snapshot.identity.worktree, () => {
    api.writeImmutableArtifactFile(fs, existing, 'original', 'existing');
    api.writeImmutableArtifactFile(fs, created, 'new', 'created');
    throw Error('publication fails');
  }), /publication fails/);
  assert.equal(fs.existsSync(created), false); assert.equal(fs.readFileSync(existing, 'utf8'), 'original');
});
function assertRefused(context, staged) {
  const { f, api } = context;
  assert.equal(api.currentCodeReviewVerdict(h.inputFor(f)), null);
  assert.equal(h.cold(f, 'code-review', staged), null);
}
async function retainedMutation30(label, file, change, checks) {
  let bytes, stat, held;
  const restore = () => {
    if (!held) return;
    try { fs.lstatSync(file); fs.rmSync(file); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    fs.renameSync(held, file); held = null;
    const restored = fs.statSync(file);
    for (const key of ['dev', 'ino', 'mode', 'size', 'mtimeMs']) assert.equal(restored[key], stat[key], label + ' restored ' + key);
    assert.deepEqual(fs.readFileSync(file), bytes); assert.equal(h.hash(fs.readFileSync(file)), h.hash(bytes));
  };
  try {
    await phase30(label + ' prepare', () => {
      bytes = fs.readFileSync(file); stat = fs.statSync(file); held = file + '.owned-exact-original';
      fs.renameSync(file, held);
      if (change === 'symlink') fs.symlinkSync(held, file);
      else if (change !== null) fs.writeFileSync(file, typeof change === 'function' ? change(bytes) : change, { mode: stat.mode & 0o777 });
      checks.prepare();
    });
    await phase30(label + ' current', checks.current);
    await phase30(label + ' staged-cold', () => { try { checks.cold(); } finally { restore(); } });
  } finally { restore(); }
}
for (const runtime of ['codex', 'claude']) test(runtime + ' oversized retained material and catalog mutations refuse prepare/current/staged-cold',
  () => public30(runtime, { phasedInspect: true, async inspect(context) {
    let e, payload, material;
    const { f, api, current, staged } = context;
    await phase30('mutation setup', () => {
      e = evidence(context); payload = payloadFor(e.launches.at(-1));
      material = payload.material.find(row => row.bytes > 4194304); assert.ok(material);
    });
    const checks = {
      prepare: () => assert.throws(() => api.prepareSemanticFinal({ prepared: e.snapshot })),
      current: () => assert.equal(api.currentCodeReviewVerdict(h.inputFor(f)), null),
      cold: () => assert.equal(h.cold(f, 'code-review', staged), null),
    };
    for (const [name, change] of [['missing', null], ['same-length', bytes => Buffer.alloc(bytes.length, 97)],
      ['truncation', bytes => bytes.subarray(1)], ['growth', bytes => Buffer.concat([bytes, Buffer.from('x')])], ['symlink', 'symlink']])
      await retainedMutation30('material ' + name, material.read_path, change, checks);
    for (const [name, mutate] of [['obligation', value => value.obligations.pop()],
      ['material', value => value.material.pop()], ['alias', value => { value.material[0].aliases[0].path = 'foreign.cjs'; }]])
      await retainedMutation30('catalog ' + name, payload.catalog.read_path, bytes => {
        const value = JSON.parse(bytes); mutate(value); return h.stable(value);
      }, checks);
    const substitutions = [p => { p.material[0].sha256 = '0'.repeat(64); },
      p => { p.material[0].aliases[0].path = 'foreign.cjs'; }, p => { p.material[0].read_path += '.alias'; },
      p => { p.catalog.read_path += '.alias'; }, p => { p.obligation_ids.pop(); },
      p => { p.required_context.push({ reason: 'omitted governing context' }); }];
    for (const [index, mutate] of substitutions.entries()) await phase30('launch-view ' + index, () => {
      const changed = prior.rebound(e.launches.at(-1), mutate);
      assert.throws(() => e.api.assertSemanticLaunchView(changed, e.record, protectedInputs(payload)));
    });
    await phase30('restored current', () => {
      const restored = api.prepareSemanticFinal({ prepared: e.snapshot });
      const { receipt_store, ...originalLaunch } = e.launches.at(-1); assert.deepEqual(restored, originalLaunch);
      assert.deepEqual(api.currentCodeReviewVerdict(h.inputFor(f)), current);
    });
    await phase30('restored staged-cold', () => assert.deepEqual(h.cold(f, 'code-review', staged), current));
  } }));
for (const runtime of ['codex', 'claude']) test(runtime + ' source head base criteria graph planning and instruction drift refuse current/cold',
  () => public30(runtime, { oversized: false, phasedInspect: true, async inspect(context) {
    let e, targets;
    const { f, api, plugin, current, staged } = context;
    await phase30('drift setup', () => {
      e = evidence(context);
      const agent = e.snapshot.pins.find(pin => pin.sha256 === e.snapshot.agent_sha256);
      targets = [path.join(f.worktree, self), path.join(plugin, 'references/code-review.md'),
        path.resolve(agent.root, agent.path), path.join(f.worktree, f.rows['T-49-30'].plan)];
    });
    const checks = {
      prepare: () => assert.throws(() => api.prepareSemanticFinal({ prepared: e.snapshot })),
      current: () => assert.equal(api.currentCodeReviewVerdict(h.inputFor(f)), null),
      cold: () => assert.equal(h.cold(f, 'code-review', staged), null),
    };
    for (const [index, file] of targets.entries()) await retainedMutation30('governing ' + index, file,
      bytes => Buffer.concat([bytes, Buffer.from('\nchanged governing input\n')]), checks);
    await retainedMutation30('graph', path.join(f.graphDir, 'tickets.json'), bytes => {
      const value = JSON.parse(bytes); value.tickets['T-49-30'].title += ' drift'; return JSON.stringify(value);
    }, { ...checks, prepare: () => {} });
    for (const [name, ref, replacement] of [['head', 'refs/heads/' + f.pr.headRefName, e.snapshot.identity.merge_base],
      ['base', old.git(f.worktree, 'rev-parse', '--symbolic-full-name', e.snapshot.identity.base_ref), e.snapshot.identity.head]]) {
      let saved;
      try {
        await phase30(name + ' prepare', () => {
          saved = old.git(f.worktree, 'rev-parse', ref); old.git(f.worktree, 'update-ref', ref, replacement); checks.prepare();
        });
        await phase30(name + ' current', checks.current);
        await phase30(name + ' staged-cold', () => { try { checks.cold(); } finally { old.git(f.worktree, 'update-ref', ref, saved); saved = null; } });
      } finally { if (saved) old.git(f.worktree, 'update-ref', ref, saved); }
    }
    await phase30('drift restored current', () => assert.deepEqual(api.currentCodeReviewVerdict(h.inputFor(f)), current));
    await phase30('drift restored staged-cold', () => assert.deepEqual(h.cold(f, 'code-review', staged), current));
  } }));

function oversizedRead(runtime, rows, payload) {
  const index = payload.material.findIndex(row => row.bytes > 4194304);
  assert.ok(index >= 0); const id = 'z21-read-' + index;
  const call = rows.find(row => runtime === 'codex' ? row.payload?.type === 'function_call' && row.payload.call_id === id
    : row.message?.content?.[0]?.type === 'tool_use' && row.message.content[0].id === id);
  const output = rows.find(row => runtime === 'codex' ? row.payload?.type === 'function_call_output' && row.payload.call_id === id
    : row.message?.content?.[0]?.type === 'tool_result' && row.message.content[0].tool_use_id === id);
  assert.ok(call && output);
  const raw = runtime === 'codex' ? JSON.parse(output.payload.output).output : output.message.content[0].content;
  assert.equal(Buffer.byteLength(raw), payload.material[index].bytes);
  assert.equal(h.hash(raw), payload.material[index].sha256);
  return { id, call, output };
}
for (const runtime of ['codex', 'claude']) for (const failure of ['missing-output', 'failed', 'truncated', 'unread'])
  test(runtime + ' real oversized read ' + failure + ' cannot grant a passing final', () => public30(runtime, {
    refusal: runtime === 'claude' && failure === 'unread' ? undefined : /SEMANTIC_REVIEW_INCOMPLETE/,
    result(result, payload) {
      if (runtime === 'claude' && failure === 'unread' && result.stage === 'final') {
        result.completeness = 'incomplete'; result.outcome = 'human-review-required';
        const source = payload.material.find(row => row.bytes > 4194304);
        const catalog = JSON.parse(fs.readFileSync(payload.catalog.read_path));
        const obligation = catalog.obligations.find(row => row.source_id === source.source_id);
        assert.ok(obligation); result.unread = [obligation.id];
        result.limitations = ['Complete oversized material was not examined.'];
      }
    },
    native(rows, payload) {
      if (payload.stage !== 'final') return;
      const { output } = oversizedRead(runtime, rows, payload);
      if (failure === 'missing-output' || runtime === 'claude' && failure === 'unread') rows.splice(rows.indexOf(output), 1);
      else if (runtime === 'codex') output.payload.output = JSON.stringify(failure === 'unread'
        ? { output: 'unread' } : { exit_code: failure === 'failed' ? 1 : 0, output: 'Explicit incomplete oversized read',
          ...(failure === 'truncated' ? { truncated: true } : {}) });
      else if (failure !== 'unread') {
        const block = output.message.content[0]; block.content = 'Explicit incomplete oversized read';
        if (failure === 'failed') block.is_error = true; else block.truncated = true;
      }
    },
    inspect(context) {
      const { f, api, completed, originals, prepared } = context, e = evidence(context), staged = stagePackage(f.root);
      const final = e.launches.at(-1), trusted = e.api.trustedRecord({ recorder: prepared.recorder, dispatchId: final.dispatch_id });
      const native = e.api.authenticatedSemanticResult(trusted, final, e.record).native;
      assert.equal(native.reads.semantic_credit, false); assert.equal(originals.length, 2);
      assert.ok(originals.every(row => row.native.reads.incomplete.length === 0));
      if (runtime === 'claude' && failure === 'unread') {
        assert.ok(native.reads.incomplete.some(row => row.reason === 'missing-output'));
        assert.equal(completed.result.verdict, 'incomplete');
        assert.equal(api.currentCodeReviewVerdict(h.inputFor(f)).verdict, 'incomplete');
        assert.equal(h.cold(f, 'code-review', staged).verdict, 'incomplete');
      } else {
        assert.equal(completed, undefined);
        const id = 'z21-read-' + payloadFor(final).material.findIndex(row => row.bytes > 4194304);
        assert.ok(native.reads.incomplete.some(row => row.call_id === id
          && row.reason === (runtime === 'codex' && failure === 'failed' ? 'unfinished-or-failed' : failure)));
        assertRefused(context, staged);
      }
    },
  }));
for (const runtime of ['codex', 'claude']) test(runtime + ' full blocked unread and missing context originals remain incomplete with INFO',
  () => public30(runtime, { incomplete: true,
    result(result) { if (result.assignment_id === 'code-correctness') result.completeness = 'blocked'; },
    inspect(context) {
      const { f, originals, current, recovered, completed } = context, staged = stagePackage(f.root);
      assert.equal(current.verdict, 'incomplete'); assert.equal(completed.result.verdict, 'incomplete');
      for (const [index, original] of originals.entries()) {
        assert.equal(original.result.completeness, index ? 'incomplete' : 'blocked');
        assert.ok(original.result.limitations.length && original.result.required_context.length && original.result.unread.length);
        assert.ok(original.result.findings.some(row => row.severity === 'INFO'));
        assert.ok(original.result.findings.some(row => row.severity === 'BLOCKER'));
        assert.ok(original.result.seams.every(row => row.disposition === 'unresolved'));
        assert.equal(JSON.parse(original.original_text).result_format, 'snapshot-indexed.v1');
        assert.deepEqual(h.internals().decodeSemanticResult(JSON.parse(original.original_text),
          evidence(context).launches[index], evidence(context).snapshot), original.result);
      }
      assert.deepEqual(h.cold(f, 'code-review', staged), current); assert.deepEqual(h.cold(f, 'code-review', staged, originals), originals);
      assert.deepEqual(recovered.result, completed.result);
    } }));
for (const runtime of ['codex', 'claude']) for (const stage of ['worker', 'final'])
  test(runtime + ' native ' + stage + ' resource failure retains incomplete authority', () => public30(runtime, {
    oversized: false, refusal: /SEMANTIC_REVIEW_INCOMPLETE/,
    native(rows, payload) {
      if (payload.stage !== stage) return;
      if (runtime === 'codex') {
        const driver = require('../fixtures/phase53/code-review-native-driver.cjs');
        const marker = driver.template(driver.registered('codex-agent-stream', 'codex-agent-stream-parent.jsonl'), row => row.type === 'event_msg');
        marker.payload = { type: 'compacted' }; rows.splice(-2, 0, marker);
      } else rows.at(-1).message.stop_reason = 'max_tokens';
    },
    inspect(context) {
      const { prepared, completed, originals } = context, e = evidence(context);
      assert.equal(completed, undefined);
      const observed = e.launches.filter(row => row.stage === stage);
      assert.ok(observed.length);
      for (const launch of observed) {
        const trusted = e.api.trustedRecord({ recorder: prepared.recorder, dispatchId: launch.dispatch_id });
        const native = e.api.authenticatedSemanticResult(trusted, launch, e.record).native;
        assert.ok(native.resource_failure); assert.equal(native.reads.semantic_credit, false);
      }
      if (stage === 'worker') assert.ok(originals.every(row => row.native.resource_failure));
      assertRefused(context, stagePackage(context.f.root));
    },
  }));
for (const runtime of ['codex', 'claude']) for (const omission of ['seam', 'context'])
  test(runtime + ' independent final ' + omission + ' omission cannot pass', () => public30(runtime, {
    oversized: false, refusal: /SEMANTIC_REVIEW_(?:INCOMPATIBLE|INCOMPLETE)/,
    result(result) {
      if (result.stage !== 'final') return;
      if (omission === 'seam') result.seams[0].disposition = 'unresolved';
      else result.required_context = ['Required complete governing context is unavailable.'];
    },
    inspect(context) { assert.equal(context.completed, undefined); assertRefused(context, stagePackage(context.f.root)); },
  }));
function completeInventory(root, relative = '') {
  const rows = [];
  for (const name of fs.readdirSync(path.join(root, relative)).sort((a, b) => a.localeCompare(b))) {
    const entry = path.posix.join(relative, name), file = path.join(root, entry), stat = fs.lstatSync(file);
    assert.equal(stat.isSymbolicLink(), false); assert.equal(fs.realpathSync(file), file);
    assert.ok(stat.isDirectory() || stat.isFile());
    rows.push({ path: entry, type: stat.isDirectory() ? 'directory' : 'file', mode: stat.mode & 0o777,
      ...(stat.isFile() ? { bytes: stat.size, sha256: h.hash(fs.readFileSync(file)) } : {}) });
    if (stat.isDirectory()) rows.push(...completeInventory(root, entry));
  }
  return rows;
}
function completePackage(root) {
  const inventory = completeInventory(root), shippedRoot = path.resolve(shipped, '../../..');
  assert.deepEqual(inventory, completeInventory(shippedRoot));
  for (const row of inventory.filter(row => row.type === 'file'))
    assert.deepEqual(fs.readFileSync(path.join(root, row.path)), fs.readFileSync(path.join(shippedRoot, row.path)));
  for (const relative of ['plugins/delivery-pipeline', 'capabilities/delivery-pipeline']) {
    const original = path.join(h.ROOT, relative), mirror = path.join(root, 'host', relative);
    assert.deepEqual(completeInventory(mirror), completeInventory(original));
    for (const row of completeInventory(original).filter(row => row.type === 'file'))
      assert.deepEqual(fs.readFileSync(path.join(mirror, row.path)), fs.readFileSync(path.join(original, row.path)));
  }
  const content = crypto.createHash('sha256');
  for (const row of inventory.filter(row => row.type === 'file'
    && !['package-build.json', '.codex-plugin/plugin.json'].includes(row.path)))
    content.update(row.path + '\0').update(fs.readFileSync(path.join(root, row.path)));
  const digest = content.digest('hex'), bytes = fs.readFileSync(path.join(root, '.codex-plugin/plugin.json'));
  const manifest = JSON.parse(bytes), identity = JSON.parse(fs.readFileSync(path.join(root, 'package-build.json')));
  const version = JSON.parse(fs.readFileSync(path.join(h.ROOT, 'plugins/delivery-pipeline/.claude-plugin/plugin.json'))).version;
  assert.equal(manifest.version, version + '+codex.' + digest.slice(0, 16));
  assert.equal(identity.version, manifest.version); assert.equal(identity.digest, h.hash(Buffer.concat([Buffer.from(digest + '\0'), bytes])));
  return inventory;
}
test('whole supported package independently authenticates every entry type/mode/byte and both identities', () => {
  const root = path.resolve(stagePackage(process.env.HOME), '../../..'), before = completePackage(root);
  for (const relative of ['host/scripts/gen-codex-shipyard.cjs',
    'host/plugins/delivery-pipeline/scripts/role-artifact.cjs', '.codex-plugin/plugin.json', 'package-build.json']) {
    const file = path.join(root, relative), bytes = fs.readFileSync(file);
    prior.withBytes(file, Buffer.concat([bytes, Buffer.from('\n')]), () => assert.throws(() => completePackage(root)));
  }
  const canonical = path.join(source, 'scripts/role-artifact.cjs'), original = fs.readFileSync(canonical);
  prior.withBytes(canonical, Buffer.concat([original, Buffer.from('\n')]), () => assert.throws(() => completePackage(root)));
  const file = path.join(root, 'host/plugins/delivery-pipeline/scripts/role-artifact.cjs');
  const mode = fs.statSync(file).mode & 0o777, held = path.join(process.env.HOME, 'held-package-source');
  try { fs.chmodSync(file, mode ^ 0o100); assert.throws(() => completePackage(root)); }
  finally { fs.chmodSync(file, mode); }
  fs.renameSync(file, held); fs.symlinkSync(held, file);
  try { assert.throws(() => completePackage(root)); } finally { fs.unlinkSync(file); fs.renameSync(held, file); }
  const extra = path.join(root, 'unlisted-source'); fs.writeFileSync(extra, 'unexpected');
  try { assert.throws(() => completePackage(root)); } finally { fs.unlinkSync(extra); }
  assert.deepEqual(completePackage(root), before);
});
test('physical z30/z30b reconstructs generation53/checks56 and visits every actual/future selector preserving frozen prefixes', () => {
  const s = require('./shard-files.cjs'), manifest = s.readManifest(), files = s.unitFiles();
  const actual = s.appendShard(manifest, s.unitTasks(files)), first50 = actual.shards.slice(0, 50);
  assert.equal(h.hash(fs.readFileSync(path.join(__dirname, 'shard-manifest.json'))),
    '3501664855f340726c19021508856700eb970b654dd7de8d86d8cbcf79fbb20b');
  assert.equal(h.hash(JSON.stringify(first50)), 'b6268014b4ae96454730fc1ee45a956acd518836daf2f787af6d6bdd73a02604');
  assert.deepEqual(actual.shards.slice(0, 16), manifest.shards);
  const first39 = [...require('../fixtures/phase53/github-job-attempts.json').parent.shards,
    ['phase53-z17-ci-job-attempts.test.cjs'], ['phase53-z17b-ci-wait-published-read.test.cjs'],
    ['phase53-z17c-native-wait-lifecycle.test.cjs']];
  const first50Independent = [...first39, ['phase53-z19-semantic-wire-dedup.test.cjs'],
    ['phase53-z20-native-context-repeats.test.cjs'], ['phase53-z21-semantic-result-wire.test.cjs'],
    ['phase53-z21b-semantic-result-custody.test.cjs'], ['phase53-z22-semantic-incomplete-projection.test.cjs'],
    ['phase53-z23-verification-owner-heartbeat.test.cjs'], ['phase53-z24-historical-producer-reference.test.cjs'],
    ['phase53-z25-historical-fixture-text-transport.test.cjs'], ['phase53-z26-native-initialization-order.test.cjs'],
    ['phase53-z27-semantic-worker-input-redundancy.test.cjs'], ['phase53-z28-semantic-final-input-redundancy.test.cjs']];
  assert.deepEqual(first50, first50Independent);
  const first51 = [...first50Independent, ['phase53-z29-semantic-final-catalog-duplication.test.cjs']];
  assert.deepEqual(actual.shards.slice(0, 51), first51);
  const filenames = physicalFiles.map(file => path.basename(file));
  const historical53 = s.appendShard({ ...manifest, shards: first51 }, [...first51.flat(), ...filenames.slice(0, 2)].sort());
  assert.deepEqual(historical53.shards, [...first51, ...filenames.slice(0, 2).map(file => [file])]);
  assert.equal(historical53.shards.length, 53); assert.equal(historical53.shards.length + 3, 56);

  const delivered = ['a-fixer-original-custody', 'b-fixer-source-history', 'c-historical-direct',
    'd-historical-admitted', 'e-historical-pending', 'f-historical-action-repeat', 'g-historical-action-covered',
    'h-publication-unsent-recovery', 'i-recorded-integration-compatibility', 't-role-architecture-archives',
    'u-role-containment', 'v-role-code-review', 'w-role-integration', 'x-native-ci-fix-contract',
    'y-native-ci-fix-recovery', 'z-generated-base-merge'].map(name => ['phase53-z29' + name + '.test.cjs']);
  const first58 = [...first51, ...delivered.slice(0, 7)], first60 = [...first51, ...delivered.slice(0, 9)];
  const first67 = [...first51, ...delivered];
  const historical54 = s.appendShard({ ...manifest, shards: first51 }, [...first51.flat(), ...delivered.slice(-3).flat()].sort());
  assert.equal(historical54.shards.length, 54);
  assert.deepEqual(historical54.shards, [...first51, ...delivered.slice(-3)]);

  assert.deepEqual(actual.shards.slice(0, 58), first58); assert.deepEqual(actual.shards.slice(0, 60), first60);
  assert.deepEqual(actual.shards.slice(0, 67), first67);
  for (const [count, selected] of [[55, delivered.slice(9, 13)],
    [62, [...delivered.slice(0, 7), ...delivered.slice(9, 13)]], [64, delivered.slice(0, 13)], [67, delivered]]) {
    const generation = s.appendShard({ ...manifest, shards: first51 }, [...first51.flat(), ...selected.flat()].sort());
    assert.equal(generation.shards.length, count); assert.equal(generation.shards.length + 3, count + 3);
    assert.deepEqual(generation.shards.slice(0, 51), first51);
  }
  const generation = s.appendShard({ ...manifest, shards: first67 }, [...first67.flat(), ...filenames].sort());
  assert.deepEqual(generation.shards, [...first67, ...filenames.map(file => [file])]);
  assert.equal(generation.shards.length, 73); assert.equal(generation.shards.length + 3, 76);
  const registered = new Set(generation.shards.flat());
  const appended = s.unitTasks(files).filter(task => !registered.has(task));
  assert.deepEqual(actual.shards, [...generation.shards, ...appended.map(task => [task])]);
  for (const file of filenames) assert.equal(actual.shards.flat().filter(row => row === file).length, 1);
  assert.equal(cases.length, 61); assert.equal(new Set(cases.map(entry => entry.title)).size, 61);
  const partitions = physicalFiles.map((_, shard) => cases.flatMap((entry, index) => purposeOwners[index] === shard ? [index] : []));
  assert.deepEqual(partitions.flat().sort((a, b) => a - b), Array.from({ length: 61 }, (_, index) => index));
  assert.equal(new Set(partitions.flat()).size, 61);
  for (const [index] of cases.entries()) {
    assert.deepEqual(partitions.flatMap((indices, shard) => indices.includes(index) ? [physicalFiles[shard]] : []),
      [provenance[index].owner]);
    assert.equal(provenance[index].original_id, index);
    assert.equal(provenance[index].assertion_operands_and_outcomes, cases[index].run.toString());
  }
  for (const [shard, relative] of physicalFiles.entries()) {
    const entrypoint = path.join(h.ROOT, relative);
    const titles = childProcess.execFileSync(process.execPath, ['-e', `
      const assert = require('node:assert/strict'), Module = require('node:module');
      const load = Module._load, titles = [];
      Module._load = function(request, ...args) {
        if (request === 'node:test') return { describe(title, options, run) { run(); }, after() {},
          test(title) { titles.push(title); } };
        if (request === 'node:worker_threads') return { isMainThread: true,
          Worker: class { constructor() { throw Error('import or registration launched a worker'); } } };
        return load.call(this, request, ...args);
      };
      const shared = require(process.argv[1]);
      require(process.argv[2]);
      assert.deepEqual(titles, []);
      shared.runShard(process.argv[2]);
      process.stdout.write(JSON.stringify(titles));
    `, path.join(h.ROOT, self), entrypoint], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
    assert.deepEqual(JSON.parse(titles), partitions[shard].flatMap(index => provenance[index].tests.map(row => row.title)));
  }
  assert.deepEqual([...actual.shards.flat()].sort(), s.unitTasks(files));
  const checks = ['shards', ...actual.shards.map((_, i) => `unit (shard ${i + 1}/${actual.shards.length})`), 'gates and smoke', 'test-fast'];
  assert.equal(new Set(checks).size, actual.shards.length + 3);
  for (let i = 0; i < actual.shards.length; i++)
    assert.deepEqual(s.selectTaskShard(`${i + 1}/${actual.shards.length}`), actual.shards[i]);
  const directory = path.join(process.env.HOME, 'future-tests'); fs.mkdirSync(directory);
  for (const file of files) fs.writeFileSync(path.join(directory, file), '');
  const future = 'zz-genuine-future-retention.test.cjs'; fs.writeFileSync(path.join(directory, future), '');
  const next = s.appendShard(actual, s.unitTasks(s.unitFiles(directory)));
  assert.equal(next.shards.length, actual.shards.length + 1);
  assert.deepEqual(next.shards.slice(0, actual.shards.length), actual.shards); assert.deepEqual(next.shards.at(-1), [future]);
  assert.deepEqual([...next.shards.flat()].sort(), s.unitTasks(s.unitFiles(directory)));
  assert.equal(new Set(['shards', ...next.shards.map((_, i) => `unit (shard ${i + 1}/${next.shards.length})`),
    'gates and smoke', 'test-fast']).size, next.shards.length + 3);
  for (let i = 0; i < next.shards.length; i++)
    assert.deepEqual(s.selectTaskShard(`${i + 1}/${next.shards.length}`, directory, actual), next.shards[i]);
});
for (const runtime of ['codex', 'claude']) for (const generation of ['original-no-format', 'retained28'])
  test(runtime + ' genuine ' + generation + ' producer preserves full prefix/init/session/original custody and cold recovery', async () => {
    const run = () => ownedPublicRole('code-review', runtime, {
      ...(generation === 'original-no-format' ? { historical: true, historicalShared: true } : {}), full: true,
      inspect(context) {
        const { f, prepared, originals, expected, current, recovered, completed } = context;
        const e = evidence(context, source), staged = stagePackage(f.root);
        for (const launch of e.launches) {
          const body = payloadFor(launch);
          e.api.assertSemanticLaunchView(launch, e.record, protectedInputs(body));
          const trusted = e.api.trustedRecord({ recorder: prepared.recorder, dispatchId: launch.dispatch_id });
          const authenticated = e.api.authenticatedSemanticResult(trusted, launch, e.record);
          assert.deepEqual(authenticated.result, expected.get(launch.assignment_id || 'final'));
          assert.equal(authenticated.native.reads.semantic_credit, false);
          assert.equal(h.hash(launch.input), launch.input_sha256);
          const prefix = 'substituted prefix\n' + launch.input;
          for (const changed of [{ ...launch, input: prefix, input_sha256: h.hash(prefix) },
            { ...launch, dispatch_id: 'foreign-session-dispatch' }, prior.rebound(launch, p => {
              p.reviewed_identity.head = '0'.repeat(40);
            }), prior.rebound(launch, p => { p.material[0].aliases[0].path = 'foreign.cjs'; })])
            assert.throws(() => e.api.authenticatedSemanticResult(trusted, changed, e.record));
          if (launch.stage === 'final') {
            if (generation === 'original-no-format') assert.equal(Object.hasOwn(body, 'result_formats'), false);
            for (const mutate of [p => p.originals.reverse(), p => { p.originals[0].reference.dispatch_id = 'foreign'; },
              p => { delete p.obligations; }, p => { p.originals[0].native.session_id = 'foreign'; }])
              assert.throws(() => e.api.authenticatedSemanticResult(trusted, prior.rebound(launch, mutate), e.record));
          }
        }
        assert.equal(new Set(prepared.launches.map(row => row.session)).size, 3);
        for (const original of originals) {
          assert.deepEqual(JSON.parse(original.original_text), original.result);
          assert.ok(original.result.findings.some(row => row.severity === 'INFO'));
        }
        assert.deepEqual(h.cold(f, 'code-review', staged), current);
        assert.deepEqual(h.cold(f, 'code-review', staged, originals), originals);
        assert.deepEqual(recovered.result, completed.result); assert.equal(prepared.launches.length, 3);
      },
    });
    if (generation === 'retained28') await previous.retainedProducer(run); else await run();
  });
function interrupt30(predicate) {
  const original = fs.linkSync; let interrupted = false;
  fs.linkSync = function(from, to, ...args) {
    if (!interrupted && predicate(String(to))) {
      interrupted = true; throw Object.assign(Error('owned fixture interrupted publication'), { code: 'FIXTURE_CRASH' });
    }
    return original.call(this, from, to, ...args);
  };
  return { restore() { fs.linkSync = original; }, get interrupted() { return interrupted; } };
}
for (const runtime of ['codex', 'claude']) test(runtime + ' compatible original completion repairs record/index/ack without duplicate native dispatch',
  () => public30(runtime, {
    async runPrepared(prepared, f, api, snapshots, nativeViews) {
      let sessions, recordIds;
      await phase30('recovery record', async () => {
      const failedRecord = interrupt30(file => /\/record-[a-f0-9]+\.json$/.test(file));
      try { await assert.rejects(prepared.run()); } finally { failedRecord.restore(); }
      assert.equal(failedRecord.interrupted, true); assert.equal(prepared.launches.length, 2);
      sessions = prepared.launches.map(row => row.session);
      recordIds = prepared.launches.map(row => 'semantic-worker-' + h.hash(JSON.stringify([
        row.payload.snapshot_sha256, 'worker', row.payload.assignment.id])));
      const recorder = require(path.join(source, 'scripts/dispatch-boundary.cjs')).createDurableRecorder(prepared.recorder.storeDir);
      assert.deepEqual(recordIds.map(id => recorder.getOriginalDispatch(id).state).sort(), ['native-completed', 'recorded']);
      });
      await phase30('recovery index', async () => {
      const failedIndex = interrupt30(file => file.includes('integration-semantic-original-'));
      try { await assert.rejects(prepared.run()); } finally { failedIndex.restore(); }
      assert.equal(failedIndex.interrupted, true); assert.equal(prepared.launches.length, 2);
      assert.deepEqual(prepared.launches.map(row => row.session), sessions);
      });
      await phase30('recovery acknowledgement', async () => {
      const failedAck = interrupt30(file => file.includes('integration-semantic-delivered-'));
      try { await assert.rejects(prepared.run()); } finally { failedAck.restore(); }
      assert.equal(failedAck.interrupted, true); assert.equal(prepared.launches.length, 3);
      assert.equal(api.currentCodeReviewVerdict(h.inputFor(f)).authenticated, true);
      });
      return phase30('recovery complete', async () => {
      const result = await prepared.run();
      assert.deepEqual(prepared.launches.slice(0, 2).map(row => row.session), sessions);
      assert.equal(prepared.launches.length, 3);
      const authority = a(), snapshot = [...snapshots.values()][0];
      const record = authority.semanticRecord(f.worktree, snapshot.snapshot_sha256);
      for (const observed of prepared.launches) {
        const launch = envelope(authority, f, snapshot, observed);
        const trusted = authority.trustedRecord({ recorder: prepared.recorder, dispatchId: launch.dispatch_id });
        const recovered = authority.authenticatedSemanticResult(trusted, launch, record);
        nativeViews.set(launch.assignment_id || 'final', recovered.result);
      }
      return result;
      });
    },
    inspect(context) {
      const { f, api, originals, prepared, completed, recovered, current } = context;
      assert.equal(originals.length, 2); assert.equal(prepared.launches.length, 3);
      assert.deepEqual(recovered.result, completed.result);
      assert.deepEqual(h.cold(f, 'code-review', stagePackage(f.root)), current);
      assert.deepEqual(h.cold(f, 'code-review', source, originals), originals);
      const before = h.inventory(api.archiveAuthorityDirectory(f.worktree));
      assert.ok(before.length);
    },
  }));
for (const runtime of ['codex', 'claude']) test(runtime + ' native exact prefix/init/session and original-reference substitutions refuse',
  () => public30(runtime, { oversized: false, inspect(context) {
    const { f, prepared, originals, current } = context, e = evidence(context), staged = stagePackage(f.root);
    const final = e.launches.at(-1), trusted = e.api.trustedRecord({ recorder: prepared.recorder, dispatchId: final.dispatch_id });
    for (const mutate of [p => p.originals.reverse(), p => { p.originals[0].reference.dispatch_id = 'other-worker'; },
      p => { p.originals[0].native.session_id = prepared.launches.at(-1).session; },
      p => { p.originals[0].sha256 = h.hash('substituted original'); }, p => { p.originals[0].read_path += '.foreign'; },
      p => { p.reviewed_identity.base = '0'.repeat(40); }, p => { delete p.result_formats; }])
      assert.throws(() => e.api.authenticatedSemanticResult(trusted, prior.rebound(final, mutate), e.record));
    const native = e.api.authenticatedSemanticResult(trusted, final, e.record).native;
    const pin = e.api.partitionNativePin(prepared.recorder.getVerifiedRecord(final.dispatch_id));
    const originalRows = fs.readFileSync(pin.path, 'utf8').trim().split('\n').map(JSON.parse);
    const verifier = require(path.join(source, 'scripts/' + runtime + '-runtime-host.cjs'));
    const verify = rows => runtime === 'codex' ? verifier.verifySemanticReads(rows.map(row => JSON.stringify(row)).join('\n'), {
      input: final.input, initialContext: trusted.receipt.runtime_evidence.initial_context.launch, sessionId: native.session_id })
      : verifier.verifySemanticReads(rows.map(row => JSON.stringify(row)).join('\n'), native.session_id);
    const rows = h.clone(originalRows);
    if (runtime === 'codex') {
      const output = rows.findIndex(row => row.payload?.type === 'function_call_output');
      const read = rows.splice(output, 1)[0]; rows.splice(rows.findIndex(row => row.payload?.role === 'user'), 0, read);
    } else rows.find(row => row.message?.content?.[0]?.type === 'tool_result').sessionId = 'rebound-session';
    assert.throws(() => verify(rows));
    assert.deepEqual(h.cold(f, 'code-review', staged), current);
    assert.deepEqual(h.cold(f, 'code-review', staged, originals), originals);
  } }));
function assertMaterialNormalization30() {
  const file = path.join(__dirname, 'phase53-z29i-recorded-integration-compatibility.test.cjs');
  const text = fs.readFileSync(file, 'utf8');
  const first = text.indexOf('const gitReaderDeltas = '), last = text.indexOf('\nfunction isolatedImpactReader(', first);
  assert.ok(first > 0 && last > first);
  const loaded = new Module(file, module); loaded.filename = file; loaded.paths = Module._nodeModulePaths(__dirname);
  loaded._compile("const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');\n"
    + "const hash = value => require('node:crypto').createHash('sha256').update(value).digest('hex');\n"
    + 'const scripts = ' + JSON.stringify(h.SCRIPTS) + ';\n' + text.slice(first, last)
    + '\nmodule.exports = { originalGitReaderSource, materialRetentionDeltas };', file);
  const { originalGitReaderSource, materialRetentionDeltas } = loaded.exports;
  const current = fs.readFileSync(path.join(h.SCRIPTS, 'role-artifact.cjs'), 'utf8');
  originalGitReaderSource(current); assert.equal(materialRetentionDeltas.length, 3);
  for (const { before, after } of materialRetentionDeltas) {
    assert.equal(current.split(after).length, 2);
    for (const changed of [current.replace(after, ''), current + after, current.replace(after, before)])
      assert.throws(() => originalGitReaderSource(changed));
  }
}
test('independent full/indexed stage and result overflow remain real bounds after material retention', () => {
  assertMaterialNormalization30();
  const api = a(), snapshot = h.currentSized('code-review');
  const fixture = h.sizingRecord(snapshot);
  try {
    const current = fixture.record.snapshot;
    for (const mutate of [value => { value.material[0].sha256 = '0'.repeat(64); },
      value => { value.material[0].aliases[0].path = 'src/substituted.cjs'; },
      value => { value.assignments[0].primary_obligation_ids.pop(); }]) {
      const changed = h.clone(current); mutate(changed); delete changed.snapshot_sha256;
      changed.snapshot_sha256 = h.hash(h.stable(changed));
      assert.throws(() => api.assertSemanticSnapshot(changed));
    }
    const worker = api.semanticBuildLaunch(fixture.record, 'worker', current.assignments[0].id, [], true);
    const indexed = api.semanticStructuralResult(current, worker);
    api.semanticWireBound({ result: indexed, text: JSON.stringify(indexed) });
    const full = api.decodeSemanticResult(indexed, worker, current);
    assert.deepEqual(api.decodeSemanticResult(full, worker, current), full);
    for (const mutate of [wire => { wire.reviewed_identity = current.identity; },
      wire => { wire.coverage = full.coverage; }, wire => { wire.coverage_indices.push(9007199254740992); },
      wire => { wire.unread_indices = [-1]; }, wire => { wire.result_format = 'foreign-format'; }]) {
      const bad = h.clone(indexed); mutate(bad);
      assert.throws(() => api.decodeSemanticResult(bad, worker, current));
    }
    assert.throws(() => api.semanticWireBound({ result: { ...indexed, evidence_markdown: 'x'.repeat(131072) },
      text: JSON.stringify(indexed) }), error => error.code === 'SEMANTIC_REVIEW_RESULT_OVER_BOUND');
    assert.throws(() => api.semanticWireBound({ result: indexed, text: JSON.stringify(indexed) + ' '.repeat(131072) }),
      error => error.code === 'SEMANTIC_REVIEW_RESULT_OVER_BOUND');
    const large = h.clone(current); large.identity.complete_context = 'x'.repeat(1048576);
    delete large.snapshot_sha256; large.snapshot_sha256 = h.hash(h.stable(large));
    api.assertSemanticSnapshot(large);
    assert.throws(() => api.semanticBuildLaunch({ ...fixture.record, snapshot: large }, 'worker', large.assignments[0].id, [], true),
      error => error.code === 'SEMANTIC_REVIEW_INPUT_OVER_BOUND' && error.details.input_limit_bytes === 1048576);
  } finally { fixture.close(); }
});
for (const runtime of ['codex', 'claude']) test(runtime + ' original wire and indexed expanded view custody refuse replacement without resealing',
  () => public30(runtime, { oversized: false, phasedInspect: true, async inspect(context) {
    const { f, api, originals, current, prepared, staged } = context;
    let e, final, descriptor, trusted, before;
    await phase30('custody setup', () => {
      e = evidence(context); final = e.launches.at(-1); descriptor = payloadFor(final).originals[0];
      trusted = e.api.trustedRecord({ recorder: prepared.recorder, dispatchId: final.dispatch_id });
      before = h.inventory(path.join(f.worktree, '.shipyard-role-artifacts'));
    });
    for (const [kind, input] of [['wire', descriptor], ['expanded', descriptor.expanded_view]]) {
      assert.ok(input);
      for (const [name, change] of [['missing', null], ['same-length', bytes => Buffer.alloc(bytes.length, 97)],
        ['truncation', bytes => bytes.subarray(1)], ['growth', bytes => Buffer.concat([bytes, Buffer.from('x')])]]) {
        await retainedMutation30(kind + ' ' + name, input.read_path, change, {
          prepare: () => {
            assert.throws(() => e.api.authenticatedSemanticResult(trusted, final, e.record));
            if (change !== null) assert.throws(() => api.prepareSemanticFinal({ prepared: e.snapshot }));
          },
          current: () => assert.equal(api.currentCodeReviewVerdict(h.inputFor(f)), null),
          cold: () => assert.equal(h.cold(f, 'code-review', staged), null),
        });
        await phase30(kind + ' ' + name + ' exact restoration', () => {
          const restored = api.prepareSemanticFinal({ prepared: e.snapshot });
          const { receipt_store, ...originalLaunch } = final; assert.deepEqual(restored, originalLaunch);
          assert.equal(fs.statSync(input.read_path).mode & 0o777, 0o600);
          assert.equal(prepared.launches.length, 3);
          assert.deepEqual(api.currentCodeReviewVerdict(h.inputFor(f)), current);
        });
      }
    }
    await retainedMutation30('native original', originals[0].native.native_pin.path,
      bytes => Buffer.concat([bytes, Buffer.from('\n')]), {
        prepare: () => assert.throws(() => api.readSemanticOriginal({ worktreePath: f.worktree,
          snapshot_sha256: e.snapshot.snapshot_sha256, assignment_id: originals[0].reference.assignment_id })),
        current: () => assert.equal(api.currentCodeReviewVerdict(h.inputFor(f)), null),
        cold: () => assert.equal(h.cold(f, 'code-review', staged), null),
      });
    await phase30('custody restored inventory', () => {
      assert.deepEqual(h.inventory(path.join(f.worktree, '.shipyard-role-artifacts')), before);
      assert.equal(prepared.launches.length, 3);
    });
    await phase30('custody restored current', () => assert.deepEqual(api.currentCodeReviewVerdict(h.inputFor(f)), current));
    await phase30('custody restored cold', () => {
      assert.deepEqual(h.cold(f, 'code-review', staged), current);
      assert.deepEqual(h.cold(f, 'code-review', staged, originals), originals);
    });
  } }));

test('bounded exact reader detects short read and file identity races without accepting storage as a verdict', () => {
  const api = a(), record = storage('code-review', 4194305);
  const inputs = api.semanticInputFiles(record, [], true), file = inputs.material[0].read_path;
  const before = fs.readFileSync(file);
  const shortRead = Object.create(fs); shortRead.readSync = () => 0;
  assert.throws(() => api.readImmutableFile(shortRead, file, 'short fixture read', before.length, before.length),
    error => error.code === 'ARTIFACT_MUTATED');
  const raced = Object.create(fs), stat = fs.fstatSync;
  let reads = 0;
  raced.fstatSync = function(fd) {
    const current = stat.call(fs, fd);
    if (++reads > 1) return { ...current, ino: current.ino + 1 };
    return current;
  };
  assert.throws(() => api.readImmutableFile(raced, file, 'raced fixture read', before.length, before.length),
    error => error.code === 'ARTIFACT_MUTATED');
  assert.deepEqual(fs.readFileSync(file), before); assert.deepEqual(api.semanticInputFiles(record), inputs);
});
test('two concurrent physical immutable publishers reuse exact enlarged bytes under the existing lock', async () => {
  const api = a(), record = storage('code-review', 4194305), content = record.snapshot.material[0].content;
  const expected = api.semanticInputFiles(record, [], true), file = expected.material[0].read_path;
  const before = fs.statSync(file), gate = new SharedArrayBuffer(4), ready = [], children = [];
  const finished = [];
  try {
    for (let index = 0; index < 2; index++) {
      let announce, refuseReady;
      ready.push(new Promise((resolve, reject) => { announce = resolve; refuseReady = reject; }));
      const worker = new Worker(`
        const { workerData: data, parentPort } = require('node:worker_threads');
        const fs = require('node:fs'), Module = require('node:module'), path = require('node:path');
        require('node:os').homedir = () => data.home;
        const file = path.join(data.scripts, 'role-artifact.cjs'), loaded = new Module(file);
        loaded.filename = file; loaded.paths = Module._nodeModulePaths(data.scripts);
        loaded._compile(fs.readFileSync(file, 'utf8') + '\\nmodule.exports = { semanticInputFiles };', file);
        parentPort.postMessage('ready');
        while (Atomics.load(new Int32Array(data.gate), 0) === 0)
          Atomics.wait(new Int32Array(data.gate), 0, 0);
        const value = loaded.exports.semanticInputFiles(data.record, [], true);
        parentPort.postMessage(value);
      `, { eval: true, workerData: { home: process.env.HOME, scripts: h.SCRIPTS, record, gate } });
      children.push(worker);
      finished.push(new Promise((resolve, reject) => {
        let observed;
        worker.on('message', value => { if (value === 'ready') announce(); else observed = value; });
        worker.once('error', error => { refuseReady(error); reject(error); });
        worker.once('exit', code => {
          if (code || !observed) {
            const error = Error('physical publisher did not finish');
            refuseReady(error); reject(error);
          } else resolve(observed);
        });
      }));
    }
    const completion = Promise.all(finished);
    completion.catch(() => {});
    await Promise.race([Promise.all(ready), completion]); Atomics.store(new Int32Array(gate), 0, 1); Atomics.notify(new Int32Array(gate), 0, 2);
    const results = await completion;
    assert.deepEqual(results, [expected, expected]);
    assert.equal(fs.statSync(file).ino, before.ino); assert.equal(fs.statSync(file).mtimeMs, before.mtimeMs);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600); assert.equal(fs.readFileSync(file, 'utf8'), content);
  } finally { await Promise.all(children.map(worker => worker.terminate())); }
});
const purposeOwners = [0, 1, 0, 1, 0, 1, 0, 1, 2, 3, 4, 2, 3, 4, 5, 2, 3, 4, 5, 2, 3, 4, 5, 3,
  2, 3, 2, 3, 4, 4, 4, 4, 5, 5, 5, 5, 2, 3, 4, 4, 5, 5, 4, 4, 5, 5, 1, 1,
  4, 4, 5, 5, 4, 5, 4, 5, 2, 2, 3, 3, 5];
const publicPurposes = new Set([...Array.from({ length: 8 }, (_, i) => i),
  ...Array.from({ length: 22 }, (_, i) => i + 24), ...Array.from({ length: 8 }, (_, i) => i + 48), 57, 58]);
const lifecyclePhases = ['package setup', 'fixture setup', 'producer', 'current consumer', 'original reader',
  'cold producer current', 'cold producer originals', 'cold shipped current', 'cold shipped originals',
  'staged package', 'cold staged current', 'cold staged originals', 'unchanged recovery', 'purpose assertions'];
const sharedAssertionSources = Object.freeze({ public_lifecycle: ownedPublicRole.toString(),
  positive: assertPositive.toString(), exact_oversized_read: oversizedRead.toString(),
  retained_mutation: retainedMutation30.toString(), package_inventory: completeInventory.toString(),
  package_identity: completePackage.toString() });
const provenance = cases.map((entry, id) => ({ original_id: id, original_title: entry.title,
  owner: physicalFiles[purposeOwners[id]], assertion_operands_and_outcomes: entry.run.toString(),
  phases: publicPurposes.has(id) ? lifecyclePhases.flatMap(name => name === 'producer' && [52, 53].includes(id)
    ? ['recovery record', 'recovery index', 'recovery acknowledgement', 'recovery complete'] : [name]) : ['purpose assertions'],
}));
for (const row of provenance) {
  row.shared_assertions = publicPurposes.has(row.original_id) ? ['public_lifecycle'] : [];
  if (row.original_id < 8) {
    const full = row.original_id % 4 >= 2, future = row.original_id % 2 === 1;
    row.parameters = { runtime: row.original_id < 4 ? 'codex' : 'claude', full, future,
      member_count: (full ? 30 : SCALED_TICKET_COUNT) + Number(future), owner_count: full ? 6 : 11 };
    row.shared_assertions.push('positive', 'exact_oversized_read');
  }
  if ([24, 25, 26, 27, 57, 58].includes(row.original_id)) row.shared_assertions.push('retained_mutation');
  if (row.original_id >= 28 && row.original_id <= 35) {
    row.parameters = { runtime: row.original_id < 32 ? 'codex' : 'claude',
      failure: ['missing-output', 'failed', 'truncated', 'unread'][(row.original_id - 28) % 4] };
    row.shared_assertions.push('exact_oversized_read');
  }
  if ([52, 53].includes(row.original_id)) row.expected_physical_launch_counts = [2, 2, 3, 3, 3];
  if (row.original_id === 46) row.shared_assertions.push('package_inventory', 'package_identity');
  for (const name of row.shared_assertions) assert.ok(sharedAssertionSources[name]);
}
for (const id of [0, 1, 4, 5]) provenance[id].phases.splice(-1, 0,
  'expanded full wire refuses existing bound', 'post-overflow current', 'post-overflow cold');
for (const id of [24, 25]) provenance[id].phases.splice(-1, 1, 'mutation setup',
  ...['material missing', 'material same-length', 'material truncation', 'material growth', 'material symlink',
    'catalog obligation', 'catalog material', 'catalog alias'].flatMap(label =>
    ['prepare', 'current', 'staged-cold'].map(boundary => label + ' ' + boundary)),
  ...Array.from({ length: 6 }, (_, index) => 'launch-view ' + index), 'restored current', 'restored staged-cold');
for (const id of [26, 27]) provenance[id].phases.splice(-1, 1, 'drift setup',
  ...['governing 0', 'governing 1', 'governing 2', 'governing 3', 'graph', 'head', 'base'].flatMap(label =>
    ['prepare', 'current', 'staged-cold'].map(boundary => label + ' ' + boundary)),
  'drift restored current', 'drift restored staged-cold');
for (const id of [57, 58]) provenance[id].phases.splice(-1, 1, 'custody setup',
  ...['wire', 'expanded'].flatMap(kind => ['missing', 'same-length', 'truncation', 'growth'].flatMap(name =>
    ['prepare', 'current', 'staged-cold', 'exact restoration'].map(boundary => kind + ' ' + name + ' ' + boundary))),
  ...['prepare', 'current', 'staged-cold'].map(boundary => 'native original ' + boundary),
  'custody restored inventory', 'custody restored current', 'custody restored cold');
provenance[47].historical_layout = { purposes: 61, physical_files: 2, parity: [31, 30],
  first_generation: [52, 55], accepted_two_file_generation: [53, 56], proposed_six_file_generation: [59, 62] };
provenance[47].historical_titles = [
  'physical z30 reconstructs generation52/checks55 and visits every actual/future selector preserving frozen prefixes',
  provenance[47].original_title,
];
for (const row of provenance) row.tests = ['physical setup', ...row.phases].map(phase => ({
  entrypoint: row.owner, scenario: row.original_id, phase, title: row.original_title + ' / ' + phase,
}));
let phaseIndex30 = 0;
async function phase30(name, run) {
  const expected = provenance[workerData.index].tests[++phaseIndex30];
  assert.ok(expected); assert.equal(expected.phase, name);
  const identity = { ...expected, entrypoint: workerData.entrypoint, source: __filename };
  parentPort.postMessage({ ready: identity });
  const command = await new Promise(resolve => parentPort.once('message', resolve));
  assert.deepEqual(command, identity, 'exact entrypoint/scenario/phase/title command');
  const value = await run();
  parentPort.postMessage({ completed: identity });
  return value;
}
function runShard(entrypoint) {
  const relative = path.relative(h.ROOT, entrypoint).split(path.sep).join('/');
  const shard = physicalFiles.indexOf(relative);
  assert.ok(shard >= 0); assert.equal(path.join(h.ROOT, relative), entrypoint);
  assert.equal(fs.realpathSync(entrypoint), entrypoint);
  assert.equal(cases.length, 61); assert.equal(provenance.length, 61);
  if (!isMainThread) {
    assert.equal(workerData.entrypoint, entrypoint);
    assert.equal(workerData.source, __filename);
    assert.equal(provenance[workerData.index].owner, relative);
    assert.equal(workerData.title, cases[workerData.index].title);
    os.homedir = () => fs.realpathSync(process.env.HOME);
    Promise.resolve().then(async () => {
      independentRoot();
      if (publicPurposes.has(workerData.index)) await cases[workerData.index].run();
      else await phase30('purpose assertions', cases[workerData.index].run);
      assert.equal(phaseIndex30, provenance[workerData.index].phases.length);
      parentPort.postMessage({ finished: workerData }); parentPort.close();
    }).catch(error => setImmediate(() => { throw error; }));
    return;
  }
  describe('phase 53 complete semantic material retention ' + path.basename(relative), { concurrency: 2 }, () => {
    for (const [index, entry] of cases.entries()) {
      if (purposeOwners[index] !== shard) continue;
      describe(entry.title, { concurrency: false }, () => {
        let home, worker, identity, failure, ready, awaiting, exited, finished = false;
        const pending = new Map();
        const wait = key => pending.has(key) ? Promise.resolve(pending.get(key))
          : new Promise((resolve, reject) => { awaiting = { key, resolve, reject }; });
        const signal = (key, value) => {
          if (awaiting?.key === key) { const saved = awaiting; awaiting = null; saved.resolve(value); }
          else pending.set(key, value);
        };
        after(async () => { await worker?.terminate(); if (home) fs.rmSync(home, { recursive: true, force: true }); });
        registerTest(entry.title + ' / physical setup', {}, async t => {
          const stop = () => {
            failure = Error('physical setup prerequisite timed out or was cancelled');
            if (awaiting) { awaiting.reject(failure); awaiting = null; }
            worker?.terminate();
          };
          t.signal.addEventListener('abort', stop, { once: true });
          try {
          home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'z21-case-z30-' + shard + '-')));
          const temporary = h.physical(home, path.join(home, 'tmp')); fs.mkdirSync(temporary);
          const env = { ...process.env };
          for (const key of Object.keys(env)) if (/^(?:GIT_|SHIPYARD_|GSD_|CODEX_|CLAUDE_|ANTHROPIC_|OPENAI_|GH_|GITHUB_|SSH_|GPG_|GNUPG)/.test(key)) delete env[key];
          for (const key of ['NODE_TEST_CONTEXT', 'NODE_OPTIONS', 'NODE_PATH']) delete env[key];
          Object.assign(env, { HOME: home, CODEX_HOME: path.join(home, '.codex'), TMPDIR: temporary, TMP: temporary, TEMP: temporary,
            XDG_CONFIG_HOME: path.join(home, '.config'), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_SYSTEM: os.devNull,
            GIT_CONFIG_GLOBAL: os.devNull, GIT_TERMINAL_PROMPT: '0', GIT_ALLOW_PROTOCOL: 'file',
            GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'maintenance.autoDetach', GIT_CONFIG_VALUE_0: 'false',
            GIT_CONFIG_KEY_1: 'gc.autoDetach', GIT_CONFIG_VALUE_1: 'false' });
          const fixture = h.setup('phase53-z24-historical-producer-reference.test.cjs', '\nif (isMainThread) {', 'squashCandidate');
          const candidate = fixture.squashCandidate(temporary, env);
          identity = { entrypoint: path.join(candidate, relative), source: path.join(candidate, self), index, title: entry.title };
          worker = new Worker(identity.entrypoint, { workerData: identity, env });
          worker.on('message', message => {
            if (message.ready) { ready = message.ready; signal('ready', ready); }
            else if (message.completed) signal('completed', message.completed);
            else if (message.finished) { assert.deepEqual(message.finished, identity); finished = true; }
          });
          const fail = error => { failure ||= error; if (awaiting) { awaiting.reject(failure); awaiting = null; } };
          worker.once('error', fail);
          worker.once('exit', code => {
            exited = code;
            if (code || !finished) fail(Error(entry.title + ' exited without complete assertions: ' + code));
            else signal('exit', code);
          });
          await wait('ready'); pending.delete('ready');
          } catch (error) { failure = error; throw error; }
          finally { t.signal.removeEventListener('abort', stop); }
        });
        for (const [ordinal, test] of provenance[index].tests.slice(1).entries()) {
          registerTest(test.title, {}, async t => {
            if (failure) throw Error('owned prerequisite failed: ' + failure.message, { cause: failure });
            const stop = () => {
              failure = Error(test.title + ' prerequisite timed out or was cancelled');
              if (awaiting) { awaiting.reject(failure); awaiting = null; }
              worker?.terminate();
            };
            t.signal.addEventListener('abort', stop, { once: true });
            try {
              if (ordinal) { ready = await wait('ready'); pending.delete('ready'); }
              const command = { ...test, entrypoint: identity.entrypoint, source: identity.source };
              assert.deepEqual(ready, command);
              worker.postMessage(command);
              assert.deepEqual(await wait('completed'), command); pending.delete('completed');
              if (ordinal === provenance[index].phases.length - 1) {
                if (exited === undefined) await wait('exit');
                assert.equal(exited, 0); assert.equal(finished, true);
              }
            } catch (error) { failure = error; throw error; }
            finally { t.signal.removeEventListener('abort', stop); }
          });
        }
      });
    }
  });
}
module.exports = { runShard, provenance, sharedAssertionSources };
if (require.main === module) runShard(__filename);
