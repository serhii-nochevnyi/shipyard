'use strict';

const { Worker, isMainThread, workerData, parentPort } = require('node:worker_threads');
const { test: registerTest, describe } = isMainThread ? require('node:test') : {};
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
const physicalFiles = [self, 'tests/unit/phase53-z30b-semantic-material-retention.test.cjs'];
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
  'plugins/shipyard/.codex-plugin/plugin.json', 'plugins/shipyard/package-build.json', ...physicalFiles];
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
  wave: 26, depends_on: ['29'], files: owners });
const governingContext = 'D-01/D-02/D-03/D-05/D-06/D-07/D-08: retain full scope, originals, failures and independent native authority. R8 INCOMPLETE; zero semantic credit.';
const requirements = ['F53-02', 'F53-03', 'F53-04', 'F53-06', 'F53-08', 'F53-09', 'F53-10', 'F53-11', 'F53-12'];
function configure30(f, future = false, oversized = true) {
  const setup = h.setup('phase53-codex-integration.test.cjs', "test('ordinary Codex caller", 'write, commit');
  const graph = JSON.parse(fs.readFileSync(path.join(f.graphDir, 'tickets.json'))), template = f.rows['T-49-02'];
  const roster = [...canonicalRoster, ...(future ? [{ number: 31, title: 'Future dependency consumer', wave: 27,
    depends_on: ['30'], files: ['src/future-provider.cjs', 'src/future-consumer.cjs'] }] : [])];
  const files = new Set(roster.flatMap(row => row.files));
  for (const file of files) setup.write(f.worktree, file, owners.includes(file)
    ? fs.readFileSync(path.join(h.ROOT, file))
    : '"use strict";\nmodule.exports = ' + JSON.stringify({ fixture: 'canonical30', path: file,
      contract: 'Preserve producer value, consumer failures, INFO and exact original authority.' }) + ';\n');
  if (future) {
    setup.write(f.worktree, 'src/future-provider.cjs', 'exports.value = 31;\n');
    setup.write(f.worktree, 'src/future-consumer.cjs', "module.exports = require('./future-provider.cjs').value;\n");
  }
  if (oversized) {
    const file = path.join(f.worktree, self);
    fs.appendFileSync(file, "\nvoid '" + 'complete fixture source contract;'.repeat(100000) + "';\n");
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
      + '## Verification commands\n- `node --test tests/unit/phase53-code-review.test.cjs`\n');
  }
  const contextFiles = ['.planning/PROJECT.md', '.planning/STATE.md', '.planning/ROADMAP.md',
    '.planning/phases/' + f.phase + '/CONTEXT.md', '.planning/phases/' + f.phase + '/49-CONTEXT.md',
    '.planning/phases/' + f.phase + '/49-RESEARCH.md'];
  const contextPurpose = [
    'Complete current code-review fixture: all six canonical owners and every declared member remain in scope.',
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
    owners: owners.map(relative => ({ path: relative, sha256: h.hash(fs.readFileSync(path.join(f.worktree, relative))) })) };
  const finalPlan = f.rows['T-49-' + String(roster.at(-1).number).padStart(2, '0')].plan;
  setup.write(f.worktree, finalPlan, fs.readFileSync(path.join(f.worktree, finalPlan), 'utf8')
    + '## Complete bounded governing metadata\n' + JSON.stringify(governing) + '\n');
  old.git(f.worktree, 'add', '--', ...files); setup.commit(f, 'complete bounded canonical30 roster and source');
  f.memberHead = f.head;
  const binding = h.setup('phase53-codex-architecture.test.cjs', "test('caller architecture", 'phaseBinding').phaseBinding(f);
  const inventoryPath = h.physical(f.root, path.join(f.root, 'canonical30-roster.json'));
  fs.writeFileSync(inventoryPath, JSON.stringify({ rows: [] }), { mode: 0o600 });
  require(path.join(source, 'scripts/role-artifact.cjs')).registerPhaseArchiveRoster({ worktreePath: f.worktree,
    graphDir: f.graphDir, binding, inventoryPath, expectedInventoryDigest: h.hash(fs.readFileSync(inventoryPath)) });
  f.roster30 = roster;
}
async function public30(runtime, options = {}) {
  const compile = Module.prototype._compile;
  let recoveryHook = false;
  if (options.runPrepared) Module.prototype._compile = function(text, filename) {
    if (filename === path.join(h.ROOT, 'tests/fixtures/phase53/semantic-result-helpers.cjs')
        && text.includes('context.recoveryArchive = inventory')) {
      const original = 'try { completed = await prepared.run(); }';
      assert.equal(text.split(original).length, 2);
      text = text.replace(original, 'try { completed = await options.runPrepared(prepared, f, api, snapshots, nativeViews); }');
      recoveryHook = true;
    }
    return compile.call(this, text, filename);
  };
  try {
  return await previous.canonicalPublicRole29(runtime, { ...options,
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
    configureFixture(f) { configure30(f, options.future, options.oversized !== false); options.configureFixture?.(f); } });
  } finally {
    Module.prototype._compile = compile;
    if (options.runPrepared) assert.equal(recoveryHook, true);
  }
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
  const { api, snapshot, record, launches } = evidence(context), staged = stagePackage(f.root);
  assert.equal(snapshot.identity.ticket_set.length, future ? 31 : 30);
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
    f.rows['T-49-' + (future ? '31' : '30')].plan));
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
  { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, timeout: 180000 });
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
  assert.equal(current.authenticated, true); assert.deepEqual(h.cold(f, 'code-review', staged), current);
  assert.deepEqual(h.cold(f, 'code-review', staged, originals), originals);
  assert.deepEqual(recovered.result, completed.result); assert.equal(prepared.launches.length, 3);
  assert.deepEqual(h.inventory(path.join(f.worktree, '.shipyard-role-artifacts')), context.recoveryArchive);
  assert.deepEqual(h.inventory(context.api.archiveAuthorityDirectory(f.worktree)), context.recoveryAuthority);
  old.bounds(api, snapshot, launches, originals, record);
  process.stdout.write(JSON.stringify({ fixture: 'canonical30-bounded', runtime: snapshot.runtime,
    members: f.roster30.length, wire: full ? 'full' : 'snapshot-indexed.v1', complete_diff_bytes: diff.bytes,
    workers: 2, independent_final: 1, actual_next_native_fit: 'owed', R8: 'INCOMPLETE', semantic_credit: false }) + '\n');
}
for (const runtime of ['codex', 'claude']) for (const full of [false, true]) for (const future of [false, true]) {
  test(runtime + ' complete oversized ' + (full ? 'full' : 'indexed') + ' ' + (future ? 'future member' : 'current roster'),
    () => public30(runtime, { full, future, inspect(context) { assertPositive(context, full, future); } }));
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
for (const runtime of ['codex', 'claude']) test(runtime + ' oversized retained material and catalog mutations refuse prepare/current/staged-cold',
  () => public30(runtime, { inspect(context) {
    const { f, api, current } = context, e = evidence(context), staged = stagePackage(f.root);
    const final = e.launches.at(-1), payload = payloadFor(final);
    const material = payload.material.find(row => row.bytes > 4194304);
    const bytes = fs.readFileSync(material.read_path);
    for (const changed of [null, Buffer.alloc(bytes.length, 97), bytes.subarray(1), Buffer.concat([bytes, Buffer.from('x')])])
      prior.withBytes(material.read_path, changed, () => {
        assert.throws(() => api.prepareSemanticFinal({ prepared: e.snapshot }));
        assertRefused(context, staged);
      });
    const held = path.join(f.root, 'material-held');
    fs.renameSync(material.read_path, held); fs.symlinkSync(held, material.read_path);
    try { assert.throws(() => api.prepareSemanticFinal({ prepared: e.snapshot })); assertRefused(context, staged); }
    finally { fs.unlinkSync(material.read_path); fs.renameSync(held, material.read_path); }
    const catalog = fs.readFileSync(payload.catalog.read_path), object = JSON.parse(catalog);
    for (const mutate of [value => value.obligations.pop(), value => value.material.pop(),
      value => { value.material[0].aliases[0].path = 'foreign.cjs'; }]) {
      const changed = h.clone(object); mutate(changed);
      prior.withBytes(payload.catalog.read_path, h.stable(changed), () => {
        assert.throws(() => api.prepareSemanticFinal({ prepared: e.snapshot })); assertRefused(context, staged);
      });
    }
    for (const mutate of [p => { p.material[0].sha256 = '0'.repeat(64); },
      p => { p.material[0].aliases[0].path = 'foreign.cjs'; }, p => { p.material[0].read_path += '.alias'; },
      p => { p.catalog.read_path += '.alias'; }, p => { p.obligation_ids.pop(); },
      p => { p.required_context.push({ reason: 'omitted governing context' }); }]) {
      const changed = prior.rebound(final, mutate);
      assert.throws(() => e.api.assertSemanticLaunchView(changed, e.record, protectedInputs(payload)));
    }
    assert.deepEqual(h.cold(f, 'code-review', staged), current);
  } }));
for (const runtime of ['codex', 'claude']) test(runtime + ' source head base criteria graph planning and instruction drift refuse current/cold',
  () => public30(runtime, { oversized: false, inspect(context) {
    const { f, api, plugin, current } = context, e = evidence(context), staged = stagePackage(f.root);
    const agent = e.snapshot.pins.find(pin => pin.sha256 === e.snapshot.agent_sha256);
    const targets = [path.join(f.worktree, self), path.join(plugin, 'references/code-review.md'),
      path.resolve(agent.root, agent.path), path.join(f.worktree, f.rows['T-49-30'].plan)];
    for (const file of targets) {
      const bytes = fs.readFileSync(file);
      prior.withBytes(file, Buffer.concat([bytes, Buffer.from('\nchanged governing input\n')]), () => {
        assert.throws(() => api.prepareSemanticFinal({ prepared: e.snapshot })); assertRefused(context, staged);
      });
    }
    const graphPath = path.join(f.graphDir, 'tickets.json'), graph = JSON.parse(fs.readFileSync(graphPath));
    const changed = h.clone(graph); changed.tickets['T-49-30'].title += ' drift';
    prior.withBytes(graphPath, JSON.stringify(changed), () => assertRefused(context, staged));
    for (const [ref, replacement] of [['refs/heads/' + f.pr.headRefName, e.snapshot.identity.merge_base],
      [old.git(f.worktree, 'rev-parse', '--symbolic-full-name', e.snapshot.identity.base_ref), e.snapshot.identity.head]]) {
      const saved = old.git(f.worktree, 'rev-parse', ref);
      old.git(f.worktree, 'update-ref', ref, replacement);
      try { assert.throws(() => api.prepareSemanticFinal({ prepared: e.snapshot })); assertRefused(context, staged); }
      finally { old.git(f.worktree, 'update-ref', ref, saved); }
    }
    assert.deepEqual(h.cold(f, 'code-review', staged), current);
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
  () => public30(runtime, { oversized: false, incomplete: true, full: true,
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
        assert.deepEqual(JSON.parse(original.original_text), original.result);
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
  const generation = s.appendShard({ ...manifest, shards: first51 }, [...first51.flat(), ...filenames].sort());
  assert.deepEqual(generation.shards, [...first51, ...filenames.map(file => [file])]);
  assert.equal(generation.shards.length, 53); assert.equal(generation.shards.length + 3, 56);
  assert.deepEqual(actual.shards.slice(0, generation.shards.length), generation.shards);
  for (const file of filenames) assert.equal(actual.shards.flat().filter(row => row === file).length, 1);
  assert.equal(cases.length, 61); assert.equal(new Set(cases.map(entry => entry.title)).size, 61);
  const partitions = physicalFiles.map((_, shard) => cases.flatMap((entry, index) => index % 2 === shard ? [index] : []));
  assert.deepEqual(partitions.map(indices => indices.length), [31, 30]);
  assert.deepEqual(partitions.flat().sort((a, b) => a - b), Array.from({ length: 61 }, (_, index) => index));
  assert.equal(partitions[0].filter(index => partitions[1].includes(index)).length, 0);
  for (const [index] of cases.entries())
    assert.deepEqual(partitions.flatMap((indices, shard) => indices.includes(index) ? [physicalFiles[shard]] : []),
      [physicalFiles[index % 2]]);
  for (const [shard, relative] of physicalFiles.entries()) {
    const entrypoint = path.join(h.ROOT, relative);
    const titles = childProcess.execFileSync(process.execPath, ['-e', `
      const assert = require('node:assert/strict'), Module = require('node:module');
      const load = Module._load, titles = [];
      Module._load = function(request, ...args) {
        if (request === 'node:test') return { describe(title, options, run) { run(); },
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
    `, path.join(h.ROOT, self), entrypoint], { encoding: 'utf8', timeout: 180000, maxBuffer: 8 * 1024 * 1024 });
    assert.deepEqual(JSON.parse(titles), partitions[shard].map(index => cases[index].title));
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
    const run = () => old.publicRole('code-review', runtime, {
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
      const failedRecord = interrupt30(file => /\/record-[a-f0-9]+\.json$/.test(file));
      try { await assert.rejects(prepared.run()); } finally { failedRecord.restore(); }
      assert.equal(failedRecord.interrupted, true); assert.equal(prepared.launches.length, 2);
      const sessions = prepared.launches.map(row => row.session);
      const recordIds = prepared.launches.map(row => 'semantic-worker-' + h.hash(JSON.stringify([
        row.payload.snapshot_sha256, 'worker', row.payload.assignment.id])));
      const recorder = require(path.join(source, 'scripts/dispatch-boundary.cjs')).createDurableRecorder(prepared.recorder.storeDir);
      assert.deepEqual(recordIds.map(id => recorder.getOriginalDispatch(id).state).sort(), ['native-completed', 'recorded']);
      const failedIndex = interrupt30(file => file.includes('integration-semantic-original-'));
      try { await assert.rejects(prepared.run()); } finally { failedIndex.restore(); }
      assert.equal(failedIndex.interrupted, true); assert.equal(prepared.launches.length, 2);
      const failedAck = interrupt30(file => file.includes('integration-semantic-delivered-'));
      try { await assert.rejects(prepared.run()); } finally { failedAck.restore(); }
      assert.equal(failedAck.interrupted, true); assert.equal(prepared.launches.length, 3);
      assert.equal(api.currentCodeReviewVerdict(h.inputFor(f)).authenticated, true);
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
test('independent full/indexed stage and result overflow remain real bounds after material retention', () => {
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
  () => public30(runtime, { oversized: false, inspect(context) {
    const { f, api, originals, current, prepared } = context, e = evidence(context), staged = stagePackage(f.root);
    const final = e.launches.at(-1), descriptor = payloadFor(final).originals[0];
    const trusted = e.api.trustedRecord({ recorder: prepared.recorder, dispatchId: final.dispatch_id });
    const before = h.inventory(path.join(f.worktree, '.shipyard-role-artifacts'));
    for (const input of [descriptor, descriptor.expanded_view]) {
      assert.ok(input);
      const bytes = fs.readFileSync(input.read_path);
      for (const changed of [null, Buffer.alloc(bytes.length, 97), bytes.subarray(1), Buffer.concat([bytes, Buffer.from('x')])])
        prior.withBytes(input.read_path, changed, () => {
          assert.throws(() => e.api.authenticatedSemanticResult(trusted, final, e.record));
          assertRefused(context, staged);
          if (changed === null) {
            const restored = api.prepareSemanticFinal({ prepared: e.snapshot });
            const { receipt_store, ...originalLaunch } = final;
            assert.deepEqual(restored, originalLaunch);
            assert.deepEqual(fs.readFileSync(input.read_path), bytes);
            assert.equal(fs.statSync(input.read_path).mode & 0o777, 0o600);
            assert.equal(prepared.launches.length, 3);
            assert.deepEqual(api.currentCodeReviewVerdict(h.inputFor(f)), current);
          } else assert.throws(() => api.prepareSemanticFinal({ prepared: e.snapshot }));
        });
    }
    const nativeFile = originals[0].native.native_pin.path, raw = fs.readFileSync(nativeFile);
    prior.withBytes(nativeFile, Buffer.concat([raw, Buffer.from('\n')]), () => {
      assert.throws(() => api.readSemanticOriginal({ worktreePath: f.worktree,
        snapshot_sha256: e.snapshot.snapshot_sha256, assignment_id: originals[0].reference.assignment_id }));
      assertRefused(context, staged);
    });
    assert.deepEqual(h.inventory(path.join(f.worktree, '.shipyard-role-artifacts')), before);
    assert.deepEqual(h.cold(f, 'code-review', staged), current); assert.equal(prepared.launches.length, 3);
    assert.deepEqual(h.cold(f, 'code-review', staged, originals), originals);
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
      let announce;
      ready.push(new Promise(resolve => { announce = resolve; }));
      const worker = new Worker(`
        const { workerData: data, parentPort } = require('node:worker_threads');
        const fs = require('node:fs'), Module = require('node:module'), path = require('node:path');
        require('node:os').homedir = () => data.home;
        const file = path.join(data.scripts, 'role-artifact.cjs'), loaded = new Module(file);
        loaded.filename = file; loaded.paths = Module._nodeModulePaths(data.scripts);
        loaded._compile(fs.readFileSync(file, 'utf8') + '\\nmodule.exports = { semanticInputFiles };', file);
        parentPort.postMessage('ready');
        Atomics.wait(new Int32Array(data.gate), 0, 0, 180000);
        const value = loaded.exports.semanticInputFiles(data.record, [], true);
        parentPort.postMessage(value);
      `, { eval: true, workerData: { home: process.env.HOME, scripts: h.SCRIPTS, record, gate } });
      children.push(worker);
      finished.push(new Promise((resolve, reject) => {
        let observed;
        worker.on('message', value => { if (value === 'ready') announce(); else observed = value; });
        worker.once('error', reject);
        worker.once('exit', code => code || !observed ? reject(Error('physical publisher did not finish')) : resolve(observed));
      }));
    }
    await Promise.all(ready); Atomics.store(new Int32Array(gate), 0, 1); Atomics.notify(new Int32Array(gate), 0, 2);
    const results = await Promise.all(finished);
    assert.deepEqual(results, [expected, expected]);
    assert.equal(fs.statSync(file).ino, before.ino); assert.equal(fs.statSync(file).mtimeMs, before.mtimeMs);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600); assert.equal(fs.readFileSync(file, 'utf8'), content);
  } finally { await Promise.all(children.map(worker => worker.terminate())); }
});
function runShard(entrypoint) {
  const relative = path.relative(h.ROOT, entrypoint).split(path.sep).join('/');
  const shard = physicalFiles.indexOf(relative);
  assert.ok(shard >= 0); assert.equal(path.join(h.ROOT, relative), entrypoint);
  assert.equal(fs.realpathSync(entrypoint), entrypoint);
  if (!isMainThread) {
    assert.equal(workerData.entrypoint, entrypoint);
    assert.ok(Number.isInteger(workerData.index) && workerData.index >= 0 && workerData.index < cases.length);
    assert.equal(workerData.index % 2, shard); assert.equal(workerData.title, cases[workerData.index].title);
    os.homedir = () => fs.realpathSync(process.env.HOME);
    Promise.resolve().then(() => { independentRoot(); return cases[workerData.index].run(); })
      .then(() => parentPort.postMessage({ completed: true, ...workerData }))
      .catch(error => setImmediate(() => { throw error; }));
    return;
  }
  describe('phase 53 complete semantic material retention ' + path.basename(relative), { concurrency: 2 }, () => {
    for (const [index, entry] of cases.entries()) {
      if (index % 2 !== shard) continue;
      registerTest(entry.title, { timeout: 180000 }, async t => {
        const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'z21-case-z30-' + shard + '-')));
        const temporary = h.physical(home, path.join(home, 'tmp')); fs.mkdirSync(temporary);
        let worker;
        t.after(async () => { await worker?.terminate(); fs.rmSync(home, { recursive: true, force: true }); });
        const env = { ...process.env };
        for (const key of Object.keys(env)) if (/^(?:GIT_|SHIPYARD_|GSD_|CODEX_|CLAUDE_|ANTHROPIC_|OPENAI_|GH_|GITHUB_|SSH_|GPG_|GNUPG)/.test(key)) delete env[key];
        for (const key of ['NODE_TEST_CONTEXT', 'NODE_OPTIONS', 'NODE_PATH']) delete env[key];
        Object.assign(env, { HOME: home, CODEX_HOME: path.join(home, '.codex'), TMPDIR: temporary, TMP: temporary, TEMP: temporary,
          XDG_CONFIG_HOME: path.join(home, '.config'), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_SYSTEM: os.devNull,
          GIT_CONFIG_GLOBAL: os.devNull, GIT_TERMINAL_PROMPT: '0', GIT_ALLOW_PROTOCOL: 'file' });
        const fixture = h.setup('phase53-z24-historical-producer-reference.test.cjs', '\nif (isMainThread) {', 'squashCandidate');
        const candidate = fixture.squashCandidate(temporary, env);
        const identity = { entrypoint: path.join(candidate, relative), index, title: entry.title };
        await new Promise((resolve, reject) => {
          worker = new Worker(identity.entrypoint, { workerData: identity, env });
          let completed = false, failure;
          worker.once('message', message => { completed = message?.completed === true
            && message.entrypoint === identity.entrypoint && message.index === index && message.title === entry.title; });
          worker.once('error', error => { failure = error; });
          worker.once('exit', code => failure ? reject(failure) : code || !completed
            ? reject(Error(entry.title + ' exited without assertions: ' + code)) : resolve());
        });
      });
    }
  });
}
module.exports = { runShard };
if (require.main === module) runShard(__filename);
