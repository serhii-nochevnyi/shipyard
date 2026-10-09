'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync, spawnSync } = require('node:child_process');

const hostVerification = require('../../plugins/delivery-pipeline/scripts/host-verification.cjs');

const REPOSITORY = path.resolve(__dirname, '../..');
const HOST = '/Users/serhii/.local/state/shipyard/codex-decompose/6cba328f5f0de395b373ad6c77a164feb771363c4e6b7a96888b7075d52da7aa';
const HANDOFF = path.join(HOST, 'phase47-current-generation-20261006/generation.json');
const HANDOFF_SHA = '64e111070452b70065e4f1a71041c7b0a3091105f3e40a7253a3e9b25132fb81';
const FINAL_HANDOFF = path.join(HOST, 'phase47-final-generation-adr026-source-update-1/generation.json');
const FINAL_HANDOFF_SHA = 'd788b6e1be9b78914d9e58f1d9fb88f5069a0ece2517a22e9b80973c75ebccfe';
const FINAL_STAGE = 'shipyard-phase47-final-publication/INV-014-runtime-delivery-correctness/ADR-026-source-update-1';
const PLAN19_SHA = 'd12c3b870fda04f0dc1f2f6afcebedbfad619f8961662ac253ad2abd45d781e8';
const FINAL_SOURCE = '8192ba38942be328b27f8aa54984eae7cd47231c';
const SUCCESSOR_HANDOFF = path.join(HOST, 'phase47-final-generation-adr027-current-ticket-evidence/generation.json');
const SUCCESSOR_HANDOFF_SHA = 'a56da0e28c524cbc55821e10f5791404229f85442edc4424e808b3768b870f15';
const SUCCESSOR_APPROVAL_SHA = 'a7e71a2f9f2a53d3a828adb46a19544e40e98da50f8e5169b3c9f5d113d308fc';
const SUCCESSOR_STAGE = 'shipyard-phase47-final-publication/INV-014-runtime-delivery-correctness/ADR-027-current-ticket-evidence';
const SUCCESSOR_SOURCE = 'c9bd8ccae0c688e034cf9f94df4ad0cfc4c909b7';
const PLAN21_SHA = 'e0477ce6956720fd9697474731dea417626e7128cd84868c91b663d9a17a2f66';
const VOLUME_HANDOFF = path.join(HOST, 'phase47-final-generation-adr027-current-ticket-volume/generation.json');
const VOLUME_HANDOFF_SHA = '32eb9144cc872ee6f6f4747ef83e475905c565effee16f93f64dc7a7e8d7062f';
const VOLUME_APPROVAL_SHA = '547bc307249ac7aaa8ceaa0c690e473a8f34819333a8d2c0dad141307a3d304d';
const VOLUME_STAGE = 'shipyard-phase47-final-publication/INV-014-runtime-delivery-correctness/ADR-027-current-ticket-volume';
const VOLUME_SOURCE = '462683f52df5c3e2ab45a08d8a5e72f9281e5750';
const PLAN22_SHA = '5225fd21717e38d59a10c2921e1e1dfd8b54c0a2bc1c3e1115a623485095b7b7';
const PLAN23_SHA = 'c6a3f59e634d5683b2c7cda80520d0d4584dffb4bf9ad2d62bab67dddcedfc8c';
const OPERATOR = '2F485C0A455BA33463F66332900FCE87BD1BFF0D';
const BASELINE = '7eebae4812b3c67ccdbbb63c8c1603f7767b1466';
const PHASE = '.planning/phases/47-complete-deferred-decomposition-wait-attribution';
const STAGE_DIRECTORY = 'shipyard-phase47-publication/INV-014-runtime-delivery-correctness';
const SCRIPTS = ['bootstrap-shipyard-plugin.cjs', 'ensure-gsd-plugin.cjs', 'ensure-gsd-core.sh',
  'install-shipyard-codex.sh', 'install-shipyard-capability.sh', 'gen-codex-shipyard.cjs',
  'merge-codex-config.cjs', 'configure-codex-notify.cjs'];
const mirror = name => 'host/plugins/delivery-pipeline/scripts/' + name + '.cjs';
const ALLOCATION = {
  'T-47-05': ['deliver-dispatch', 'run-contract', 'codex-delivery-host', 'dispatch-record',
    'planning-result-sealer'].map(mirror),
  'T-47-11': ['claude-role-host', 'codex-dispatch-adapter', 'codex-arch-review-context',
    'role-artifact', 'codex-decompose-host', 'codex-planning-context-host', 'codex-notify',
    'host-verification'].map(mirror).concat('host/scripts/configure-codex-notify.cjs'),
  'T-47-12': ['host/plugins/delivery-pipeline/commands/investigate.md',
    'host/plugins/delivery-pipeline/commands/decompose.md', '.codex-plugin/plugin.json',
    'package-build.json', mirror('codex-runtime-host'), mirror('claude-runtime-host')],
};
const UNION = Object.values(ALLOCATION).flat().sort();
const CORRECTIVE = ['codex-arch-review-context', 'codex-runtime-host', 'codex-delivery-host',
  'codex-planning-context-host', 'orchestration-overhead', 'lock', 'architecture-target'].map(mirror)
  .concat('.codex-plugin/plugin.json', 'package-build.json').sort();
const SUCCESSOR_CORRECTIVE = ['role-artifact', 'codex-arch-review-context', 'claude-role-host'].map(mirror)
  .concat('.codex-plugin/plugin.json', 'package-build.json').sort();
const VOLUME_CORRECTIVE = [mirror('role-artifact'), '.codex-plugin/plugin.json', 'package-build.json'].sort();
const REPAIR_HANDOFF = path.join(HOST, 'phase47-final-generation-adr027-main-review-repair/generation.json');
const REPAIR_HANDOFF_SHA = '3b678863a64f1d65606fc37ebcc75dd30c9e8650acd797b3eada909e67b0ef23';
const REPAIR_STAGE = 'shipyard-phase47-final-publication/INV-014-runtime-delivery-correctness/ADR-027-main-review-repair';
const SOURCE39_SHA = '2eb2a0475127916c4c120d7616d13df1393d116c07b2a5f259cd6453234c65f9';
const COORDINATOR48_SHA = '1195fed6807740e886592ba92ca99913368becde6b21d8de8126ecf134a0efe9';
const HISTORICAL43_SHA = '63a18625794b2772663567c95401ad91358daf13974f9c18117e0ce237256780';
const REPAIR_PLANS = ['3b595c2d141f88edbc23f6211cf1d0dd5d86d4e7cd0445f9505bfed7337d9920',
  '921ed98c728a878df40ce45a657f5082b7c551e44a967d794192c3de54530fc2',
  'df2032950c47991c8c90a89eb63d62b4a78a13afe51665c1e669fa72aa71cf62',
  '9227da74913edf1e704826508b375c99413c65933b2f5b5aed6d743638bc96ac'];
const REPAIR_CORRECTIVE = ['codex-arch-review-context', 'claude-runtime-host', 'orchestration-overhead',
  'planning-result-sealer', 'codex-decompose-host', 'role-artifact'].map(mirror)
  .concat('.codex-plugin/plugin.json', 'package-build.json').sort();

const F1_HANDOFF = path.join(HOST, 'phase47-final-generation-adr027-main-review-repair-F1/generation.json');
const F1_HANDOFF_SHA = '27ca0d42db637e83f181d398f0d047959d4295a8486967cfe798dd24476e5509';
const F1_PUBLICATION_PINS = Object.freeze({
  selection_path: '/Volumes/KINGSTON/claude-shipyard/.git/shipyard-phase47-final-publication/INV-014-runtime-delivery-correctness/ADR-027-main-review-repair-F1/selection.json',
  selection_sha256: '68623cda4d53280dca2ad625589a45680b54949ed69afad81f3598cddc5d00f5',
  binding_path: '/Volumes/KINGSTON/claude-shipyard/.git/shipyard-phase47-final-publication/INV-014-runtime-delivery-correctness/ADR-027-main-review-repair-F1/12b4367bd4d9aaf0dbaea193a5c6693de09499c652a59b3d935d9cad5e022fa8/binding.json',
  binding_sha256: '3753108de3d078bc90ee50c8618f28f6170b03756c94f2419855ba80c1ed7523'
});
const F1_STAGE = REPAIR_STAGE + '-F1';
const F1_CORRECTIVE = VOLUME_CORRECTIVE;
const F1_SCOPE = '/tmp/phase47-F1-existing-contract-scope.json';
const F1_SCOPE_SHA = '853d28bce0ba31f135a12f197989a435516971242e03091dc9e73156c851b1a7';
const F1_MATERIALIZATION_SHA = '2ef15f5583c34ec9da5b77bbec010b031fcf0d5b98e68ff54664a0b94affaba2';
const F1_MATERIALIZATION_V2_SHA = 'd6a4c1a288f5f01445aa94511a4b3693c39b17e2853139bab5ce4046195273b4';

const R2_HANDOFF = path.join(HOST, 'phase47-final-generation-adr027-main-review-repair-R2/generation.json');
const R2_HANDOFF_SHA = 'b0b582fde0c832e89c4121cde4de34218a7ad3f3d1f73ce76767d7952375b5e5';
const R2_STAGE = REPAIR_STAGE + '-R2';
const R2_MATERIALIZATION_SHA = '2e620175880f10daacf7067685b76ffdbea116e7fca2f4e87e63364d917b9f74';
const R2_MATERIALIZATION_V2_SHA = 'b1537ddbf637f8b07deff897dc02ad1adced6ada61af99adb4c0e2d1af927045';
const R2_SCOPE = '/tmp/phase47-R2-existing-contract-scope.json';
const R2_SCOPE_SHA = '4647587d0324060505c1516ffe61e76fb45892e10d0ad7e62705f0141891be6a';
const F1_HISTORICAL_CONTRACT = { path: '/tmp/phase47-R2-pinned-F1-historical-source-contract.json',
  sha256: '71a6acf6f858715a5e04f4270ec2f52252bbee298259f513a69a59d7963d16ce' };

const T16_STAGE = '/Volumes/KINGSTON/claude-shipyard/.git/shipyard-phase47-final-publication/INV-014-runtime-delivery-correctness/ADR-027-main421-T16-R3';
const T16_HANDOFF = T16_STAGE + '/generation.json';
const T16_HANDOFF_SHA = '3f4b67549647d227c375da8d1042e5dbb601e80303cf3d52fe47ef1ff54b9eba';
const T16_SOURCE = 'd1e3fcb20c4c8d3786dd7fa7294bd519fa57618d';
const T16_CORRECTIVE = ['architecture-target', 'claude-role-host', 'codex-arch-review-context', 'deliver-dispatch', 'role-artifact'].map(mirror)
  .concat('host/plugins/delivery-pipeline/references/arch-review.md', '.codex-plugin/plugin.json', 'package-build.json').sort();

const R3_STAGE = T16_STAGE;
const R3_HANDOFF_SHA = T16_HANDOFF_SHA;
const R4_STAGE = R3_STAGE.replace('-R3', '-R4');
const R4_HANDOFF_SHA = 'd749a68e28c4355cd59c49b70ca42636d57d5cd318ff0a8d489e24383dd9a035';
const R4_CORRECTIVE = ['.codex-plugin/plugin.json', mirror('deliver-dispatch'), 'package-build.json'];

const R5_STAGE = R3_STAGE.replace('-R3', '-R5');
const R5_HANDOFF_SHA = 'bc0fd3d6dd33ee608056ef3e76aa5e835e48e538ca44699be5f44ae5a762a6b9';
const R5_CORRECTIVE = ['.codex-plugin/plugin.json', mirror('role-artifact'), 'package-build.json'];


const R6_STAGE = R3_STAGE.replace('-R3', '-R6');
const R6_HANDOFF_SHA = 'b3a59beb7e369cb891e5934fe974e1bcad9d3ba7c96078fa6d6595b294a40de9';
const R6_CORRECTIVE = ['.codex-plugin/plugin.json', mirror('gate-trailer'), mirror('role-artifact'), mirror('sentinel'), mirror('state-sync'), 'package-build.json'];

function validateR6Contract(handback, selection, binding) {
  assert.deepEqual(binding.previous_publication, {"path":"/Volumes/KINGSTON/claude-shipyard/.git/shipyard-phase47-final-publication/INV-014-runtime-delivery-correctness/ADR-027-main421-T16-R5/generation.json","sha256":"bc0fd3d6dd33ee608056ef3e76aa5e835e48e538ca44699be5f44ae5a762a6b9","selection_path":"/Volumes/KINGSTON/claude-shipyard/.git/shipyard-phase47-final-publication/INV-014-runtime-delivery-correctness/ADR-027-main421-T16-R5/selection.json","selection_sha256":"0ef7c97179ffaa88afd5386bc4550bf84e92f2d33ecb67ce0163964dbc284f90","binding_path":"/Volumes/KINGSTON/claude-shipyard/.git/shipyard-phase47-final-publication/INV-014-runtime-delivery-correctness/ADR-027-main421-T16-R5/binding.json","binding_sha256":"062570456684fd64cedd7e3dda05bad46f7379a33b308755755311c68570b979"});
  assert.deepEqual(binding.source_finalization, {"path":"/tmp/phase47-16-shared-epic-final-trusted-fixer-finalization.json","sha256":"ab3064f6d6948be1f41f88514377c8d5a83e2ea3bf60d044b7b2a96093b7bf14","commit":"fb444e75a115c57c70d27cb70f37c3a0e742a2df","tree":"4188f087f978ccda7cb9c942232e1c742aa532f0","verification":{"digest":"3f22588fadf574bf8f3e73eec91d586ed8b7196cb762ac4905f5196489f98c16","path":"/Users/serhii/.local/state/shipyard/codex/finalization/9724bc475b9461ad5008f65c939f17074448416305d2d83f41f80dc3a853209d/verification/3f22588fadf574bf8f3e73eec91d586ed8b7196cb762ac4905f5196489f98c16.json","outcome":"passed"},"fixer_result_path":"/tmp/phase47-16-shared-epic-parity-result.json","fixer_result_sha256":"593238c7bae5aee8881cfae3e668d0a3d8628e9e0acbb495a8fcd7aa82c13eec"});
  assert.deepEqual(binding.builder_inventory, {"path":"/tmp/phase47-16-shared-epic-candidate-inventory.json","sha256":"a0984feb89d0ffc4c3d2616fb2bd7d847b467af2e5a1993f2bedb3b550437a51"});
  assert.deepEqual(binding.publication_native_result, {"path":"/tmp/phase47-16-shared-epic-parity-result.json","sha256":"593238c7bae5aee8881cfae3e668d0a3d8628e9e0acbb495a8fcd7aa82c13eec"});
  assert.deepEqual(binding.build_sequence, "built-once-before-final-proof; native-complete-parity; original-two-formal-commands-on-final-tree; seal-without-rebuild");
  assert.deepEqual(handback.previous_publication, binding.previous_publication);
  assert.deepEqual(binding.source.head, "fb444e75a115c57c70d27cb70f37c3a0e742a2df");
  assert.deepEqual(binding.source.tree, "4188f087f978ccda7cb9c942232e1c742aa532f0");
  assert.deepEqual(binding.source.changes, ["plugins/delivery-pipeline/scripts/gate-trailer.cjs", "plugins/delivery-pipeline/scripts/role-artifact.cjs", "plugins/delivery-pipeline/scripts/sentinel.cjs", "plugins/delivery-pipeline/scripts/state-sync.cjs", "tests/unit/architecture-target.test.cjs", "tests/unit/role-artifact.test.cjs"]);
  for (const object of [handback, selection, binding]) assert.equal(object.version, '0.71.0+codex.c926509d9f20d683');
  for (const object of [handback, binding]) assert.deepEqual(object.changed_outputs, R6_CORRECTIVE);
  for (const object of [handback, selection]) {
    assert.equal(object.source_commit, binding.source.head);
    assert.equal(object.candidate_path, R6_STAGE+'/candidate');
    assert.equal(object.binding_path, R6_STAGE+'/binding.json');
    assert.equal(object.binding_sha256, '1e70af73894d13c982591ce6a4217c0321ea7ecb2062dcc957dec15f316e5b33');
  }
  assert.equal(handback.selection_path, R6_STAGE+'/selection.json');
  assert.equal(handback.selection_sha256, 'e8954ec3ba0060ace0bc6b3256043e0564b4797a6c154d0abd698662eba1a87c');
  const h=structuredClone(handback), sel=structuredClone(selection), b=structuredClone(binding);
  b.previous_publication={"path":"/Volumes/KINGSTON/claude-shipyard/.git/shipyard-phase47-final-publication/INV-014-runtime-delivery-correctness/ADR-027-main421-T16-R4/generation.json","sha256":"d749a68e28c4355cd59c49b70ca42636d57d5cd318ff0a8d489e24383dd9a035","selection_path":"/Volumes/KINGSTON/claude-shipyard/.git/shipyard-phase47-final-publication/INV-014-runtime-delivery-correctness/ADR-027-main421-T16-R4/selection.json","selection_sha256":"7034eb1d3381a625312b7e55da5eea92190b1eacdc2de0d9cf9a5ca9a3e25eae","binding_path":"/Volumes/KINGSTON/claude-shipyard/.git/shipyard-phase47-final-publication/INV-014-runtime-delivery-correctness/ADR-027-main421-T16-R4/binding.json","binding_sha256":"d6d9aa45d3354bc86c7a637ab70ccad8cc00ed95b755b7896f65a23ad7a57783"};
  b.source_finalization={"path":"/tmp/phase47-16-bounded-final-retry-trusted-fixer-finalization.json","sha256":"094bf1244879ae03fa95708b12b49df0de922dbc0eae815c4938d8b95e3e724b","commit":"74597623434d748357fcafedc87ed8d7397b7757","tree":"6c8bf92fe236af7058ae1bed7ecd3e99dfbe3090","verification":{"digest":"e6ba9e5707ac24ca70b0cf68a0905d67b344eeaa419ee1b1cb3d33c028c145e8","path":"/Users/serhii/.local/state/shipyard/codex/finalization/9724bc475b9461ad5008f65c939f17074448416305d2d83f41f80dc3a853209d/verification/e6ba9e5707ac24ca70b0cf68a0905d67b344eeaa419ee1b1cb3d33c028c145e8.json","outcome":"passed"},"fixer_result_path":"/tmp/phase47-16-bounded-clean-parity-result.json","fixer_result_sha256":"8f052bf028805172bdd4103289fd6201fb530a4cd517bce675af20b7e8dbcdf1"};
  b.builder_inventory={"path":"/tmp/phase47-16-bounded-clean-candidate-inventory.json","sha256":"402ad93713ccd39501ffc8360724f31ad7ea26a2e276cdb2b1bb919e00fc0cd6"};
  b.publication_native_result={"path":"/tmp/phase47-16-bounded-clean-parity-result.json","sha256":"8f052bf028805172bdd4103289fd6201fb530a4cd517bce675af20b7e8dbcdf1"};
  b.build_sequence="built-once-before-final-proof; native-complete-parity; original-two-formal-commands-on-final-tree; seal-without-rebuild";
  b.source.head="74597623434d748357fcafedc87ed8d7397b7757";
  b.source.tree="6c8bf92fe236af7058ae1bed7ecd3e99dfbe3090";
  b.source.changes=["plugins/delivery-pipeline/scripts/role-artifact.cjs", "tests/unit/architecture-target.test.cjs", "tests/unit/role-artifact.test.cjs"];
  h.previous_publication=b.previous_publication;
  h.changed_outputs=b.changed_outputs=R5_CORRECTIVE;
  for (const object of [h,sel,b]) object.version="0.71.0+codex.b8ac969962427971";
  for (const object of [h,sel]) {
    object.source_commit="74597623434d748357fcafedc87ed8d7397b7757";
    object.candidate_path="/Volumes/KINGSTON/claude-shipyard/.git/shipyard-phase47-final-publication/INV-014-runtime-delivery-correctness/ADR-027-main421-T16-R5/candidate";
    object.binding_path="/Volumes/KINGSTON/claude-shipyard/.git/shipyard-phase47-final-publication/INV-014-runtime-delivery-correctness/ADR-027-main421-T16-R5/binding.json";
    object.binding_sha256="062570456684fd64cedd7e3dda05bad46f7379a33b308755755311c68570b979";
  }
  h.selection_path="/Volumes/KINGSTON/claude-shipyard/.git/shipyard-phase47-final-publication/INV-014-runtime-delivery-correctness/ADR-027-main421-T16-R5/selection.json";
  h.selection_sha256="0ef7c97179ffaa88afd5386bc4550bf84e92f2d33ecb67ce0163964dbc284f90";
  validateR5Contract(h,sel,b);
}

function validateR5Contract(handback, selection, binding) {
  const prior = {path:R4_STAGE+'/generation.json',sha256:R4_HANDOFF_SHA,
    selection_path:R4_STAGE+'/selection.json',selection_sha256:'7034eb1d3381a625312b7e55da5eea92190b1eacdc2de0d9cf9a5ca9a3e25eae',
    binding_path:R4_STAGE+'/binding.json',binding_sha256:'d6d9aa45d3354bc86c7a637ab70ccad8cc00ed95b755b7896f65a23ad7a57783'};
  assert.deepEqual(binding.previous_publication, prior);
  assert.deepEqual(handback.previous_publication, prior);
  assert.equal(binding.source.head, '74597623434d748357fcafedc87ed8d7397b7757');
  assert.equal(binding.source.tree, '6c8bf92fe236af7058ae1bed7ecd3e99dfbe3090');
  assert.deepEqual(binding.source.changes, ['plugins/delivery-pipeline/scripts/role-artifact.cjs', 'tests/unit/architecture-target.test.cjs', 'tests/unit/role-artifact.test.cjs']);
  assert.deepEqual(binding.builder_inventory, {path:'/tmp/phase47-16-bounded-clean-candidate-inventory.json',sha256:'402ad93713ccd39501ffc8360724f31ad7ea26a2e276cdb2b1bb919e00fc0cd6'});
  assert.deepEqual(binding.publication_native_result, {path:'/tmp/phase47-16-bounded-clean-parity-result.json',sha256:'8f052bf028805172bdd4103289fd6201fb530a4cd517bce675af20b7e8dbcdf1'});
  assert.equal(binding.source_finalization.path, '/tmp/phase47-16-bounded-final-retry-trusted-fixer-finalization.json');
  assert.equal(binding.source_finalization.sha256, '094bf1244879ae03fa95708b12b49df0de922dbc0eae815c4938d8b95e3e724b');
  assert.equal(binding.source_finalization.verification.digest, 'e6ba9e5707ac24ca70b0cf68a0905d67b344eeaa419ee1b1cb3d33c028c145e8');
  assert.equal(binding.source_finalization.commit, binding.source.head);
  assert.equal(binding.source_finalization.tree, binding.source.tree);
  const h=structuredClone(handback), sel=structuredClone(selection), b=structuredClone(binding);
  for (const object of [handback, selection, binding]) assert.equal(object.version, '0.71.0+codex.b8ac969962427971');
  for (const object of [handback, binding]) assert.deepEqual(object.changed_outputs, R5_CORRECTIVE);
  for (const object of [handback, selection]) {
    assert.equal(object.source_commit, binding.source.head);
    assert.equal(object.candidate_path, R5_STAGE+'/candidate');
    assert.equal(object.binding_path, R5_STAGE+'/binding.json');
    assert.equal(object.binding_sha256, '062570456684fd64cedd7e3dda05bad46f7379a33b308755755311c68570b979');
  }
  assert.equal(handback.selection_path, R5_STAGE+'/selection.json');
  assert.equal(handback.selection_sha256, '0ef7c97179ffaa88afd5386bc4550bf84e92f2d33ecb67ce0163964dbc284f90');
  for (const object of [h,sel,b]) object.version='0.71.0+codex.daf277913a59a95f';
  for (const object of [h,sel]) {
    object.source_commit='6bd6943be0d617144803399b987a2877ed365c0c';
    object.candidate_path=R4_STAGE+'/candidate';object.binding_path=R4_STAGE+'/binding.json';
    object.binding_sha256=prior.binding_sha256;
  }
  h.selection_path=prior.selection_path;h.selection_sha256=prior.selection_sha256;
  h.changed_outputs=b.changed_outputs=R4_CORRECTIVE;
  b.source.head=b.source_finalization.commit='6bd6943be0d617144803399b987a2877ed365c0c';
  b.source.tree=b.source_finalization.tree='0588af073a11d35dab3abfd87aa5aa3349eca9aa';
  b.source.changes=['plugins/delivery-pipeline/scripts/deliver-dispatch.cjs','tests/unit/architecture-target.test.cjs','tests/unit/role-artifact.test.cjs'];
  b.source_finalization.verification.digest='c2fda6a34be316bf5af4ace1f1cd26d48f0d89abebb870a660817d662fc54323';
  b.builder_inventory={path:'/tmp/phase47-16-copilot-ci-repair-candidate-inventory.json',sha256:'d1ba21dd591a0e519689d3a4238eaa2699d8df867f6e5f05fe55f07d034f67a2'};
  b.publication_native_result={path:'/tmp/phase47-16-copilot-package-parity-result.json',sha256:'ba3b54faee7d91d449c96de098f6785d44b6a335caddf109eef10f7ad14a6fca'};
  const r4Previous={path:R3_STAGE+'/generation.json',sha256:R3_HANDOFF_SHA,
    selection_path:R3_STAGE+'/selection.json',selection_sha256:'cb368749284ad1dce8157c8c64ce37c6d7b44a6662b14d3a3b9907f4685f0a03',
    binding_path:R3_STAGE+'/binding.json',binding_sha256:'1f4c6584245d59dfb0fd8c8d2893d84201ad0854a2ebcd972a204e296b627f35'};
  h.previous_publication=b.previous_publication=r4Previous;
  validateR4Contract(h,sel,b);
}

function validateT16Contract(handback, selection, binding, final = false) {
  if (final) return validateR4Contract(handback, selection, binding);
  assert.equal(handback.schema, 'shipyard.phase47-t16-publication-generation.v1');
  assert.equal(selection.schema, 'shipyard.phase47-t16-publication-selection.v1');
  assert.equal(binding.schema, 'shipyard.phase47-t16-publication-binding.v1');
  for (const object of [handback, binding]) {
    assert.equal(object.actor, 'trusted-coordinator'); assert.equal(object.native_receipt, false);
    assert.equal(object.build_calls, 1); assert.deepEqual([...object.changed_outputs].sort(), T16_CORRECTIVE);
  }
  assert.equal(handback.status, 'completed'); assert.equal(binding.ticket, 'T-47-16');
  assert.equal(binding.phase_membership, 27); assert.equal(binding.outputs.length, 161);
  assert.equal(new Set(binding.outputs.map(row => row.path)).size, 161);
  assert.equal(binding.source.head, T16_SOURCE);
  assert.equal(binding.source.tree, '215134d0bc1063547f391ed654764e0afc823c1a');
  assert.equal(binding.source.config_sha256, COORDINATOR48_SHA);
  assert.equal(binding.source.plan_sha256, 'f52ee4c06fbc5af6a04c8298d4ca3176f0b14519183c0fbf2a54d2d589cb3c56');
  assert.equal(binding.builder, 'scripts/package-shipyard-codex.cjs');
  assert.equal(binding.source_finalization.verification.digest, '2e54221eabbf9cc97508791834c5ea737d6af66afe5c7a59da331b4256a41f36');
  assert.equal(binding.source_finalization.verification.outcome, 'passed');
  assert.equal(binding.source_finalization.commit, T16_SOURCE);
  assert.equal(binding.source_finalization.tree, binding.source.tree);
  assert.deepEqual(handback.previous_publication, binding.previous_publication);
  assert.equal(binding.previous_publication.path, R2_HANDOFF);
  assert.equal(binding.previous_publication.sha256, R2_HANDOFF_SHA);
  assert.equal(binding.previous_publication.selection_sha256, '1394f2b6cfb5447194b80a67b4e6456416cd3b1d1b40926da8b34073c995f3c1');
  assert.equal(binding.previous_publication.binding_sha256, 'e3e08aefe542e17732976f670950fbced1c094eafae96d80fca4c53c3491d6a7');
  for (const object of [handback, selection, binding]) assert.equal(object.version, '0.71.0+codex.b7fbd7d015a08f33');
  for (const object of [handback, selection]) {
    assert.equal(object.source_commit, T16_SOURCE);
    assert.equal(object.candidate_path, T16_STAGE + '/candidate');
    assert.equal(object.binding_path, T16_STAGE + '/binding.json');
    assert.equal(object.binding_sha256, '1f4c6584245d59dfb0fd8c8d2893d84201ad0854a2ebcd972a204e296b627f35');
  }
  assert.equal(handback.selection_path, T16_STAGE + '/selection.json');
  assert.equal(handback.selection_sha256, 'cb368749284ad1dce8157c8c64ce37c6d7b44a6662b14d3a3b9907f4685f0a03');
  assert.equal(selection.output_count, 161); assert.equal(handback.outputs, 161);
}

function validateR4Contract(handback, selection, binding) {
  const prior = binding.previous_publication;
  assert.deepEqual(prior, {path: R3_STAGE + '/generation.json', sha256: R3_HANDOFF_SHA,
    selection_path: R3_STAGE + '/selection.json', selection_sha256: 'cb368749284ad1dce8157c8c64ce37c6d7b44a6662b14d3a3b9907f4685f0a03',
    binding_path: R3_STAGE + '/binding.json', binding_sha256: '1f4c6584245d59dfb0fd8c8d2893d84201ad0854a2ebcd972a204e296b627f35'});
  assert.deepEqual(handback.previous_publication, prior);
  assert.equal(binding.build_sequence, 'built-once-before-final-proof; native-complete-parity; original-two-formal-commands-on-final-tree; seal-without-rebuild');
  assert.deepEqual(binding.builder_inventory, {path:'/tmp/phase47-16-copilot-ci-repair-candidate-inventory.json',sha256:'d1ba21dd591a0e519689d3a4238eaa2699d8df867f6e5f05fe55f07d034f67a2'});
  assert.deepEqual(binding.publication_native_result, {path:'/tmp/phase47-16-copilot-package-parity-result.json',sha256:'ba3b54faee7d91d449c96de098f6785d44b6a335caddf109eef10f7ad14a6fca'});
  assert.equal(binding.source.head, '6bd6943be0d617144803399b987a2877ed365c0c');
  assert.equal(binding.source.tree, '0588af073a11d35dab3abfd87aa5aa3349eca9aa');
  assert.deepEqual(binding.source.changes, ['plugins/delivery-pipeline/scripts/deliver-dispatch.cjs', 'tests/unit/architecture-target.test.cjs', 'tests/unit/role-artifact.test.cjs']);
  assert.equal(binding.source_finalization.verification.digest, 'c2fda6a34be316bf5af4ace1f1cd26d48f0d89abebb870a660817d662fc54323');
  assert.equal(binding.source_finalization.commit, binding.source.head);
  assert.equal(binding.source_finalization.tree, binding.source.tree);
  for (const object of [handback, selection, binding]) assert.equal(object.version, '0.71.0+codex.daf277913a59a95f');
  for (const object of [handback, binding]) assert.deepEqual(object.changed_outputs, R4_CORRECTIVE);
  const h = structuredClone(handback), sel = structuredClone(selection), b = structuredClone(binding);
  for (const object of [h, sel, b]) object.version = '0.71.0+codex.b7fbd7d015a08f33';
  for (const object of [h, sel]) {
    assert.equal(object.source_commit, binding.source.head);
    assert.equal(object.candidate_path, R4_STAGE + '/candidate');
    assert.equal(object.binding_path, R4_STAGE + '/binding.json');
    assert.equal(object.binding_sha256, 'd6d9aa45d3354bc86c7a637ab70ccad8cc00ed95b755b7896f65a23ad7a57783');
    object.source_commit = T16_SOURCE; object.candidate_path = R3_STAGE + '/candidate';
    object.binding_path = R3_STAGE + '/binding.json'; object.binding_sha256 = '1f4c6584245d59dfb0fd8c8d2893d84201ad0854a2ebcd972a204e296b627f35';
  }
  assert.equal(h.selection_path, R4_STAGE + '/selection.json');
  assert.equal(h.selection_sha256, '7034eb1d3381a625312b7e55da5eea92190b1eacdc2de0d9cf9a5ca9a3e25eae');
  h.selection_path = R3_STAGE + '/selection.json'; h.selection_sha256 = 'cb368749284ad1dce8157c8c64ce37c6d7b44a6662b14d3a3b9907f4685f0a03';
  h.changed_outputs = b.changed_outputs = T16_CORRECTIVE;
  b.source.head = b.source_finalization.commit = T16_SOURCE;
  b.source.tree = b.source_finalization.tree = '215134d0bc1063547f391ed654764e0afc823c1a';
  b.source_finalization.verification.digest = '2e54221eabbf9cc97508791834c5ea737d6af66afe5c7a59da331b4256a41f36';
  h.previous_publication = b.previous_publication = {path:R2_HANDOFF,sha256:R2_HANDOFF_SHA,
    selection_sha256:'1394f2b6cfb5447194b80a67b4e6456416cd3b1d1b40926da8b34073c995f3c1',binding_sha256:'e3e08aefe542e17732976f670950fbced1c094eafae96d80fca4c53c3491d6a7'};
  validateT16Contract(h, sel, b);
}

const R2_HISTORY_ADMISSION = Symbol('authenticated literal-pinned R2 history');
const R2_HISTORY_CONTRACT = Object.freeze({ path: '/tmp/phase47-R2-historical-authentication-contract.json',
  sha256: 'f587d3fa29eada2708cc44ab56270e78a312b4a28e0c388446d39e99c74000ba' });

function validateR2HistoricalAdmission(contract, snapshot) {
  assert.equal(contract.schema, 'shipyard.phase47-r2-historical-authentication.v1');
  assert.equal(contract.actor, 'trusted-coordinator');
  assert.equal(contract.native_receipt, false);
  assert.deepEqual(contract.snapshot, { path: '/tmp/phase47-R2-historical-authentication-before-T16.json',
    sha256: 'ce4f18bb385e2894182d35e395a1dffd933492fd568496cae32458db266101fc', bytes: 684623 });
  assert.deepEqual(contract.original_handoff, { path: R2_HANDOFF, sha256: R2_HANDOFF_SHA });
  assert.deepEqual(contract.validated_current, { head: '265110621c8097a83867a9e9dd7958c0e7830cb2',
    tree: 'e713fcbb21a22761c956bae621529544947e67dd',
    canonical_input_digest: '9365fc4817abc41cce69798cb84bf9a8938e4b9d1e0645ba5dce5a9781aebbd0', source_ancestor: true });
  assert.equal(contract.original_raw_board_retained, false);
  assert.equal(contract.original_raw_board_reconstructed, false);
  assert.equal(contract.rebuilds, 0);
  assert.deepEqual(snapshot.current, contract.validated_current);
  assert.equal(snapshot.handback.selection_sha256, '1394f2b6cfb5447194b80a67b4e6456416cd3b1d1b40926da8b34073c995f3c1');
  assert.equal(snapshot.handback.binding_sha256, 'e3e08aefe542e17732976f670950fbced1c094eafae96d80fca4c53c3491d6a7');
  assert.equal(snapshot.selected.binding.canonical_input_digest, contract.validated_current.canonical_input_digest);
}

function authenticateR2History(common, root = REPOSITORY) {
  const key = '/private/tmp/operator-public-key.asc';
  read(key, 'a2831936134d378395058b84e81ae9411c4da03800933700f1d995ebd51f89c3');
  const contract = authenticateHandback('/private/tmp/phase47-R2-historical-authentication-contract.json', R2_HISTORY_CONTRACT.sha256, key);
  const snapshot = JSON.parse(reference({ ...contract.snapshot, path: '/private/tmp/phase47-R2-historical-authentication-before-T16.json' }, true));
  validateR2HistoricalAdmission(contract, snapshot);
  const authenticated = authenticateRepairSuccessor(common, root, 'R2-history', R2_HISTORY_ADMISSION);
  for (const field of ['handback', 'selected', 'approval'])
    assert.deepEqual(authenticated[field], snapshot[field], 'original R2 historical identity moved: ' + field);
  return authenticated;
}

const R7_STAGE = R3_STAGE.replace('-R3', '-R7');
const R7_HANDOFF_SHA = '5d8f2d08de1421849719fdd3db3f3f01b9b8caca474b5b9a4efc485857cbec1a';
const R7_CORRECTIVE = [".codex-plugin/plugin.json","host/plugins/delivery-pipeline/scripts/role-artifact.cjs","host/plugins/delivery-pipeline/scripts/sentinel.cjs","host/plugins/delivery-pipeline/scripts/state-sync.cjs","package-build.json"];

function validateR7Contract(handback, selection, binding) {
  assert.deepEqual(handback.source_commit, "cab5dc80ac223814713088fc5077860882508b8c");
  assert.deepEqual(handback.selection_path, "/Volumes/KINGSTON/claude-shipyard/.git/shipyard-phase47-final-publication/INV-014-runtime-delivery-correctness/ADR-027-main421-T16-R7/selection.json");
  assert.deepEqual(handback.selection_sha256, "94f3a5b13babfa51b5389b0c7b9d4ab8a9f3abf504e4561672f0bfa76eb42c92");
  assert.deepEqual(handback.binding_path, "/Volumes/KINGSTON/claude-shipyard/.git/shipyard-phase47-final-publication/INV-014-runtime-delivery-correctness/ADR-027-main421-T16-R7/binding.json");
  assert.deepEqual(handback.binding_sha256, "777583fc79ee9b539d348e4e1285a58f135b51ec250ac16e72a058d66beb72c1");
  assert.deepEqual(handback.candidate_path, "/Volumes/KINGSTON/claude-shipyard/.git/shipyard-phase47-final-publication/INV-014-runtime-delivery-correctness/ADR-027-main421-T16-R7/candidate");
  assert.deepEqual(handback.version, "0.71.0+codex.bf58e0d9b9d7b99f");
  assert.deepEqual(handback.changed_outputs, [".codex-plugin/plugin.json","host/plugins/delivery-pipeline/scripts/role-artifact.cjs","host/plugins/delivery-pipeline/scripts/sentinel.cjs","host/plugins/delivery-pipeline/scripts/state-sync.cjs","package-build.json"]);
  assert.deepEqual(handback.previous_publication, {"path":"/Volumes/KINGSTON/claude-shipyard/.git/shipyard-phase47-final-publication/INV-014-runtime-delivery-correctness/ADR-027-main421-T16-R6/generation.json","sha256":"b3a59beb7e369cb891e5934fe974e1bcad9d3ba7c96078fa6d6595b294a40de9","selection_path":"/Volumes/KINGSTON/claude-shipyard/.git/shipyard-phase47-final-publication/INV-014-runtime-delivery-correctness/ADR-027-main421-T16-R6/selection.json","selection_sha256":"e8954ec3ba0060ace0bc6b3256043e0564b4797a6c154d0abd698662eba1a87c","binding_path":"/Volumes/KINGSTON/claude-shipyard/.git/shipyard-phase47-final-publication/INV-014-runtime-delivery-correctness/ADR-027-main421-T16-R6/binding.json","binding_sha256":"1e70af73894d13c982591ce6a4217c0321ea7ecb2062dcc957dec15f316e5b33"});
  assert.deepEqual(selection.candidate_path, "/Volumes/KINGSTON/claude-shipyard/.git/shipyard-phase47-final-publication/INV-014-runtime-delivery-correctness/ADR-027-main421-T16-R7/candidate");
  assert.deepEqual(selection.binding_path, "/Volumes/KINGSTON/claude-shipyard/.git/shipyard-phase47-final-publication/INV-014-runtime-delivery-correctness/ADR-027-main421-T16-R7/binding.json");
  assert.deepEqual(selection.binding_sha256, "777583fc79ee9b539d348e4e1285a58f135b51ec250ac16e72a058d66beb72c1");
  assert.deepEqual(selection.source_commit, "cab5dc80ac223814713088fc5077860882508b8c");
  assert.deepEqual(selection.version, "0.71.0+codex.bf58e0d9b9d7b99f");
  assert.deepEqual(binding.source.head, "cab5dc80ac223814713088fc5077860882508b8c");
  assert.deepEqual(binding.source.tree, "df908628cd1016a4f7d41c89661b23f1dbaa4f94");
  assert.deepEqual(binding.source.changes, ["plugins/delivery-pipeline/scripts/role-artifact.cjs","plugins/delivery-pipeline/scripts/sentinel.cjs","plugins/delivery-pipeline/scripts/state-sync.cjs","tests/unit/architecture-target.test.cjs","tests/unit/sentinel.test.cjs","tests/unit/state-sync-listing.test.cjs"]);
  assert.deepEqual(binding.source_finalization, {"path":"/tmp/phase47-16-planning-root-final-trusted-fixer-finalization.json","sha256":"3cf075199ae9c73a8683155f994c618579aef3e71416dfdb0f9708ad08661a3b","commit":"cab5dc80ac223814713088fc5077860882508b8c","tree":"df908628cd1016a4f7d41c89661b23f1dbaa4f94","verification":{"digest":"b2d78c0ad1a32bda4557eb9c25df6b33bdf9c5e340c79d214c440fa2a51a7bb9","path":"/Users/serhii/.local/state/shipyard/codex/finalization/9724bc475b9461ad5008f65c939f17074448416305d2d83f41f80dc3a853209d/verification/b2d78c0ad1a32bda4557eb9c25df6b33bdf9c5e340c79d214c440fa2a51a7bb9.json","outcome":"passed"},"fixer_result_path":"/tmp/phase47-16-planning-root-parity-result.json","fixer_result_sha256":"82f9bd8a6d20ed93da685fa8e1f30fc9a269c8243d678f75f7ea087e99a47570"});
  assert.deepEqual(binding.previous_publication, {"path":"/Volumes/KINGSTON/claude-shipyard/.git/shipyard-phase47-final-publication/INV-014-runtime-delivery-correctness/ADR-027-main421-T16-R6/generation.json","sha256":"b3a59beb7e369cb891e5934fe974e1bcad9d3ba7c96078fa6d6595b294a40de9","selection_path":"/Volumes/KINGSTON/claude-shipyard/.git/shipyard-phase47-final-publication/INV-014-runtime-delivery-correctness/ADR-027-main421-T16-R6/selection.json","selection_sha256":"e8954ec3ba0060ace0bc6b3256043e0564b4797a6c154d0abd698662eba1a87c","binding_path":"/Volumes/KINGSTON/claude-shipyard/.git/shipyard-phase47-final-publication/INV-014-runtime-delivery-correctness/ADR-027-main421-T16-R6/binding.json","binding_sha256":"1e70af73894d13c982591ce6a4217c0321ea7ecb2062dcc957dec15f316e5b33"});
  assert.deepEqual(binding.changed_outputs, [".codex-plugin/plugin.json","host/plugins/delivery-pipeline/scripts/role-artifact.cjs","host/plugins/delivery-pipeline/scripts/sentinel.cjs","host/plugins/delivery-pipeline/scripts/state-sync.cjs","package-build.json"]);
  assert.deepEqual(binding.version, "0.71.0+codex.bf58e0d9b9d7b99f");
  assert.deepEqual(binding.builder_inventory, {"path":"/tmp/phase47-16-planning-root-candidate-inventory.json","sha256":"61a2df1c6ac216650d120e8c477cb42ffbacf86ed6de44e14baca2d166e24d17"});
  assert.deepEqual(binding.publication_native_result, {"path":"/tmp/phase47-16-planning-root-parity-result.json","sha256":"82f9bd8a6d20ed93da685fa8e1f30fc9a269c8243d678f75f7ea087e99a47570"});
  const h=structuredClone(handback), s=structuredClone(selection), b=structuredClone(binding);
  h.source_commit="fb444e75a115c57c70d27cb70f37c3a0e742a2df";
  h.selection_path="/Volumes/KINGSTON/claude-shipyard/.git/shipyard-phase47-final-publication/INV-014-runtime-delivery-correctness/ADR-027-main421-T16-R6/selection.json";
  h.selection_sha256="e8954ec3ba0060ace0bc6b3256043e0564b4797a6c154d0abd698662eba1a87c";
  h.binding_path="/Volumes/KINGSTON/claude-shipyard/.git/shipyard-phase47-final-publication/INV-014-runtime-delivery-correctness/ADR-027-main421-T16-R6/binding.json";
  h.binding_sha256="1e70af73894d13c982591ce6a4217c0321ea7ecb2062dcc957dec15f316e5b33";
  h.candidate_path="/Volumes/KINGSTON/claude-shipyard/.git/shipyard-phase47-final-publication/INV-014-runtime-delivery-correctness/ADR-027-main421-T16-R6/candidate";
  h.version="0.71.0+codex.c926509d9f20d683";
  h.changed_outputs=[".codex-plugin/plugin.json","host/plugins/delivery-pipeline/scripts/gate-trailer.cjs","host/plugins/delivery-pipeline/scripts/role-artifact.cjs","host/plugins/delivery-pipeline/scripts/sentinel.cjs","host/plugins/delivery-pipeline/scripts/state-sync.cjs","package-build.json"];
  h.previous_publication={"path":"/Volumes/KINGSTON/claude-shipyard/.git/shipyard-phase47-final-publication/INV-014-runtime-delivery-correctness/ADR-027-main421-T16-R5/generation.json","sha256":"bc0fd3d6dd33ee608056ef3e76aa5e835e48e538ca44699be5f44ae5a762a6b9","selection_path":"/Volumes/KINGSTON/claude-shipyard/.git/shipyard-phase47-final-publication/INV-014-runtime-delivery-correctness/ADR-027-main421-T16-R5/selection.json","selection_sha256":"0ef7c97179ffaa88afd5386bc4550bf84e92f2d33ecb67ce0163964dbc284f90","binding_path":"/Volumes/KINGSTON/claude-shipyard/.git/shipyard-phase47-final-publication/INV-014-runtime-delivery-correctness/ADR-027-main421-T16-R5/binding.json","binding_sha256":"062570456684fd64cedd7e3dda05bad46f7379a33b308755755311c68570b979"};
  s.candidate_path="/Volumes/KINGSTON/claude-shipyard/.git/shipyard-phase47-final-publication/INV-014-runtime-delivery-correctness/ADR-027-main421-T16-R6/candidate";
  s.binding_path="/Volumes/KINGSTON/claude-shipyard/.git/shipyard-phase47-final-publication/INV-014-runtime-delivery-correctness/ADR-027-main421-T16-R6/binding.json";
  s.binding_sha256="1e70af73894d13c982591ce6a4217c0321ea7ecb2062dcc957dec15f316e5b33";
  s.source_commit="fb444e75a115c57c70d27cb70f37c3a0e742a2df";
  s.version="0.71.0+codex.c926509d9f20d683";
  b.source.head="fb444e75a115c57c70d27cb70f37c3a0e742a2df";
  b.source.tree="4188f087f978ccda7cb9c942232e1c742aa532f0";
  b.source.changes=["plugins/delivery-pipeline/scripts/gate-trailer.cjs","plugins/delivery-pipeline/scripts/role-artifact.cjs","plugins/delivery-pipeline/scripts/sentinel.cjs","plugins/delivery-pipeline/scripts/state-sync.cjs","tests/unit/architecture-target.test.cjs","tests/unit/role-artifact.test.cjs"];
  b.source_finalization={"path":"/tmp/phase47-16-shared-epic-final-trusted-fixer-finalization.json","sha256":"ab3064f6d6948be1f41f88514377c8d5a83e2ea3bf60d044b7b2a96093b7bf14","commit":"fb444e75a115c57c70d27cb70f37c3a0e742a2df","tree":"4188f087f978ccda7cb9c942232e1c742aa532f0","verification":{"digest":"3f22588fadf574bf8f3e73eec91d586ed8b7196cb762ac4905f5196489f98c16","path":"/Users/serhii/.local/state/shipyard/codex/finalization/9724bc475b9461ad5008f65c939f17074448416305d2d83f41f80dc3a853209d/verification/3f22588fadf574bf8f3e73eec91d586ed8b7196cb762ac4905f5196489f98c16.json","outcome":"passed"},"fixer_result_path":"/tmp/phase47-16-shared-epic-parity-result.json","fixer_result_sha256":"593238c7bae5aee8881cfae3e668d0a3d8628e9e0acbb495a8fcd7aa82c13eec"};
  b.previous_publication={"path":"/Volumes/KINGSTON/claude-shipyard/.git/shipyard-phase47-final-publication/INV-014-runtime-delivery-correctness/ADR-027-main421-T16-R5/generation.json","sha256":"bc0fd3d6dd33ee608056ef3e76aa5e835e48e538ca44699be5f44ae5a762a6b9","selection_path":"/Volumes/KINGSTON/claude-shipyard/.git/shipyard-phase47-final-publication/INV-014-runtime-delivery-correctness/ADR-027-main421-T16-R5/selection.json","selection_sha256":"0ef7c97179ffaa88afd5386bc4550bf84e92f2d33ecb67ce0163964dbc284f90","binding_path":"/Volumes/KINGSTON/claude-shipyard/.git/shipyard-phase47-final-publication/INV-014-runtime-delivery-correctness/ADR-027-main421-T16-R5/binding.json","binding_sha256":"062570456684fd64cedd7e3dda05bad46f7379a33b308755755311c68570b979"};
  b.changed_outputs=[".codex-plugin/plugin.json","host/plugins/delivery-pipeline/scripts/gate-trailer.cjs","host/plugins/delivery-pipeline/scripts/role-artifact.cjs","host/plugins/delivery-pipeline/scripts/sentinel.cjs","host/plugins/delivery-pipeline/scripts/state-sync.cjs","package-build.json"];
  b.version="0.71.0+codex.c926509d9f20d683";
  b.builder_inventory={"path":"/tmp/phase47-16-shared-epic-candidate-inventory.json","sha256":"a0984feb89d0ffc4c3d2616fb2bd7d847b467af2e5a1993f2bedb3b550437a51"};
  b.publication_native_result={"path":"/tmp/phase47-16-shared-epic-parity-result.json","sha256":"593238c7bae5aee8881cfae3e668d0a3d8628e9e0acbb495a8fcd7aa82c13eec"};
  validateR6Contract(h,s,b);
}

const R8_STAGE = R3_STAGE.replace('-R3', '-R8');
const R8_HANDOFF_SHA = '5792799323c1533de10e65fe418aca8b640691db640f24f6623361381e7bccd0';
const R8_CORRECTIVE = [".codex-plugin/plugin.json","host/plugins/delivery-pipeline/commands/deliver.md","host/plugins/delivery-pipeline/references/arch-review.md","host/plugins/delivery-pipeline/references/pr-sentinel.md","host/plugins/delivery-pipeline/scripts/role-artifact.cjs","host/plugins/delivery-pipeline/skills/delivery-rules/SKILL.md","package-build.json"];

function validateR8Contract(handback, selection, binding) {
  assert.deepEqual(handback, {"schema":"shipyard.phase47-t16-publication-generation.v1","actor":"trusted-coordinator","native_receipt":false,"authority":"Operator standing phase47 repair authorization; existing T47-16 supported publisher ownership","status":"completed","source_commit":"0b7791c208c2d3069c868d39af4f6bd9b2720e3c","selection_path":"/Volumes/KINGSTON/claude-shipyard/.git/shipyard-phase47-final-publication/INV-014-runtime-delivery-correctness/ADR-027-main421-T16-R8/selection.json","selection_sha256":"e53f5bcff100db381aba215bc899f541250f9102ee24a14ab84014a02e5d821d","binding_path":"/Volumes/KINGSTON/claude-shipyard/.git/shipyard-phase47-final-publication/INV-014-runtime-delivery-correctness/ADR-027-main421-T16-R8/binding.json","binding_sha256":"c9de489f0d340ba0d49c28d6a18b0c95b9915db81d549e31bebe0b99e05b52d7","candidate_path":"/Volumes/KINGSTON/claude-shipyard/.git/shipyard-phase47-final-publication/INV-014-runtime-delivery-correctness/ADR-027-main421-T16-R8/candidate","version":"0.71.0+codex.b319402d6ef6389f","outputs":161,"changed_outputs":[".codex-plugin/plugin.json","host/plugins/delivery-pipeline/commands/deliver.md","host/plugins/delivery-pipeline/references/arch-review.md","host/plugins/delivery-pipeline/references/pr-sentinel.md","host/plugins/delivery-pipeline/scripts/role-artifact.cjs","host/plugins/delivery-pipeline/skills/delivery-rules/SKILL.md","package-build.json"],"previous_publication":{"path":"/Volumes/KINGSTON/claude-shipyard/.git/shipyard-phase47-final-publication/INV-014-runtime-delivery-correctness/ADR-027-main421-T16-R7/generation.json","sha256":"5d8f2d08de1421849719fdd3db3f3f01b9b8caca474b5b9a4efc485857cbec1a","selection_path":"/Volumes/KINGSTON/claude-shipyard/.git/shipyard-phase47-final-publication/INV-014-runtime-delivery-correctness/ADR-027-main421-T16-R7/selection.json","selection_sha256":"94f3a5b13babfa51b5389b0c7b9d4ab8a9f3abf504e4561672f0bfa76eb42c92","binding_path":"/Volumes/KINGSTON/claude-shipyard/.git/shipyard-phase47-final-publication/INV-014-runtime-delivery-correctness/ADR-027-main421-T16-R7/binding.json","binding_sha256":"777583fc79ee9b539d348e4e1285a58f135b51ec250ac16e72a058d66beb72c1"},"build_calls":1});
  assert.deepEqual(selection, {"schema":"shipyard.phase47-t16-publication-selection.v1","candidate_path":"/Volumes/KINGSTON/claude-shipyard/.git/shipyard-phase47-final-publication/INV-014-runtime-delivery-correctness/ADR-027-main421-T16-R8/candidate","binding_path":"/Volumes/KINGSTON/claude-shipyard/.git/shipyard-phase47-final-publication/INV-014-runtime-delivery-correctness/ADR-027-main421-T16-R8/binding.json","binding_sha256":"c9de489f0d340ba0d49c28d6a18b0c95b9915db81d549e31bebe0b99e05b52d7","source_commit":"0b7791c208c2d3069c868d39af4f6bd9b2720e3c","version":"0.71.0+codex.b319402d6ef6389f","output_count":161});
  assert.deepEqual(binding.schema, "shipyard.phase47-t16-publication-binding.v1");
  assert.deepEqual(binding.actor, "trusted-coordinator");
  assert.deepEqual(binding.native_receipt, false);
  assert.deepEqual(binding.ticket, "T-47-16");
  assert.deepEqual(binding.phase_membership, 27);
  assert.deepEqual(binding.source.head, "0b7791c208c2d3069c868d39af4f6bd9b2720e3c");
  assert.deepEqual(binding.source.tree, "4a4afdf128ea7bc533004800a8a2a5d1f9856cc7");
  assert.deepEqual(binding.source.status_sha256, "6e45799e5a3580b192b5210dd523a70d0b18bd525166ef2d4a911c29488d4db9");
  assert.deepEqual(binding.source.index_sha256, "b0ccd33707914bceb1fed67170744a3e282a3d1447c36ccab910c49e7e787270");
  assert.deepEqual(binding.source.graph_sha256, "0ddd4abafcf43255f6cca8caa16e61c25d3475acd7016bcfc7c6272e6c6c2392");
  assert.deepEqual(binding.source.delivery_state_sha256, "7b7c07cbbac8d7d0bf10b8c639fe6c9da75230974098e482f36e0fdcbcabef96");
  assert.deepEqual(binding.source.config_sha256, "1195fed6807740e886592ba92ca99913368becde6b21d8de8126ecf134a0efe9");
  assert.deepEqual(binding.source.plan_sha256, "f52ee4c06fbc5af6a04c8298d4ca3176f0b14519183c0fbf2a54d2d589cb3c56");
  assert.deepEqual(binding.source.worktree, "/Volumes/KINGSTON/worktrees/phase47-authenticated-delivery/T-47-16-native-landing");
  assert.deepEqual(binding.source.common, "/Volumes/KINGSTON/claude-shipyard/.git");
  assert.deepEqual(binding.source.changes, ["plugins/delivery-pipeline/commands/deliver.md","plugins/delivery-pipeline/references/arch-review.md","plugins/delivery-pipeline/references/pr-sentinel.md","plugins/delivery-pipeline/scripts/role-artifact.cjs","plugins/delivery-pipeline/skills/delivery-rules/SKILL.md","tests/unit/role-artifact.test.cjs"]);
  assert.deepEqual(binding.source_finalization, {"path":"/tmp/phase47-16-pr452-final-trusted-fixer-finalization.json","sha256":"f4e5324daa6630f54972323c9c4420f691d54ba031fa76cdfc80ba6eb9394fd3","commit":"0b7791c208c2d3069c868d39af4f6bd9b2720e3c","tree":"4a4afdf128ea7bc533004800a8a2a5d1f9856cc7","verification":{"digest":"a38ee7ab4425f7e49a55510bf962df87608e33b722cd4b0d17126716e4e1460b","path":"/Users/serhii/.local/state/shipyard/codex/finalization/9948690cafe3db51f405d431c9f1d12f7529e3300907234e81c069fcbe642162/verification/a38ee7ab4425f7e49a55510bf962df87608e33b722cd4b0d17126716e4e1460b.json","outcome":"passed"},"fixer_result_path":"/tmp/phase47-16-pr452-review-fix-result.json","fixer_result_sha256":"90c94c82cbeb98954044f4ce4c71f221f738f22c2dc23c62a2d946a6d308c85f"});
  assert.deepEqual(binding.previous_publication, {"path":"/Volumes/KINGSTON/claude-shipyard/.git/shipyard-phase47-final-publication/INV-014-runtime-delivery-correctness/ADR-027-main421-T16-R7/generation.json","sha256":"5d8f2d08de1421849719fdd3db3f3f01b9b8caca474b5b9a4efc485857cbec1a","selection_path":"/Volumes/KINGSTON/claude-shipyard/.git/shipyard-phase47-final-publication/INV-014-runtime-delivery-correctness/ADR-027-main421-T16-R7/selection.json","selection_sha256":"94f3a5b13babfa51b5389b0c7b9d4ab8a9f3abf504e4561672f0bfa76eb42c92","binding_path":"/Volumes/KINGSTON/claude-shipyard/.git/shipyard-phase47-final-publication/INV-014-runtime-delivery-correctness/ADR-027-main421-T16-R7/binding.json","binding_sha256":"777583fc79ee9b539d348e4e1285a58f135b51ec250ac16e72a058d66beb72c1"});
  assert.deepEqual(binding.source_snapshots, {"graph":{"path":"/Volumes/KINGSTON/claude-shipyard/.git/shipyard-phase47-final-publication/INV-014-runtime-delivery-correctness/ADR-027-main421-T16-R8/source-graph.json","sha256":"0ddd4abafcf43255f6cca8caa16e61c25d3475acd7016bcfc7c6272e6c6c2392"},"state":{"path":"/Volumes/KINGSTON/claude-shipyard/.git/shipyard-phase47-final-publication/INV-014-runtime-delivery-correctness/ADR-027-main421-T16-R8/source-delivery-state.json","sha256":"7b7c07cbbac8d7d0bf10b8c639fe6c9da75230974098e482f36e0fdcbcabef96"}});
  assert.deepEqual(binding.changed_outputs, [".codex-plugin/plugin.json","host/plugins/delivery-pipeline/commands/deliver.md","host/plugins/delivery-pipeline/references/arch-review.md","host/plugins/delivery-pipeline/references/pr-sentinel.md","host/plugins/delivery-pipeline/scripts/role-artifact.cjs","host/plugins/delivery-pipeline/skills/delivery-rules/SKILL.md","package-build.json"]);
  assert.deepEqual(binding.version, "0.71.0+codex.b319402d6ef6389f");
  assert.deepEqual(binding.installed_native_obligations, "HOLD; no promotion");
  assert.deepEqual(binding.builder, "scripts/package-shipyard-codex.cjs");
  assert.deepEqual(binding.build_calls, 1);
  assert.deepEqual(binding.build_sequence, "built-once-before-final-proof; native-complete-parity; original-two-formal-commands-on-final-tree; seal-without-rebuild");
  assert.deepEqual(binding.builder_inventory, {"path":"/tmp/phase47-16-pr452-candidate-inventory.json","sha256":"a003127099ff3a327804d6405620e6a57a4ba504c93ce5368a7dbff8fb4f6699"});
  assert.deepEqual(binding.publication_native_result, {"path":"/tmp/phase47-16-pr452-parity-result.json","sha256":"e5b93cd1aa6cbf42b2bd1aff135f03222bd561ba3ada0de2b4e37e387aa43ce7"});
  assert.equal(binding.outputs.length, 161);
  assert.equal(new Set(binding.outputs.map(row => row.path)).size, 161);
}

function validateSquashPublication(evidence, source, common, commitTree, ancestor) {
  assert.equal(common, '/Volumes/KINGSTON/claude-shipyard/.git');
  assert.equal(evidence.schema, 'shipyard.phase47-t16-squash-publication.v1');
  assert.equal(evidence.actor, 'trusted-coordinator');
  assert.equal(evidence.native_receipt, false);
  assert.equal(evidence.ticket, 'T-47-16');
  assert.equal(evidence.repo, 'serhii-nochevnyi/shipyard');
  assert.equal(evidence.pr, 452);
  assert.equal(evidence.head, '0b7791c208c2d3069c868d39af4f6bd9b2720e3c');
  assert.equal(source.head, evidence.head);
  assert.equal(evidence.source_stage_sha256, R8_HANDOFF_SHA);
  assert.equal(evidence.source_tree, source.tree);
  assert.equal(evidence.merge_tree, source.tree);
  assert.match(evidence.merge_commit, /^[0-9a-f]{40}$/);
  assert.equal(evidence.base_commit, '265110621c8097a83867a9e9dd7958c0e7830cb2');
  assert.equal(evidence.state, 'MERGED');
  assert.equal(commitTree(evidence.merge_commit), source.tree);
  ancestor(evidence.base_commit, evidence.merge_commit);
  ancestor(evidence.merge_commit, 'HEAD');
}

function admitT16CurrentSource(root, source, generation, key) {
  const direct = spawnSync('git', ['-C', root, 'merge-base', '--is-ancestor', source.head, 'HEAD']);
  if (direct.status === 0) return;
  assert.equal(direct.status, 1, 'Git ancestry check failed');
  assert.equal(generation, 8, 'only literal R8 admits signed squash publication');
  const common = gitText(root, 'rev-parse', '--path-format=absolute', '--git-common-dir');
  const file = fs.realpathSync('/tmp/phase47-452-merged-publication.json');
  const evidence = authenticateHandback(file, sha(read(file)), key);
  validateSquashPublication(evidence, source, common,
    commit => gitText(root, 'rev-parse', commit + '^{tree}'),
    (before, after) => git(root, 'merge-base', '--is-ancestor', before, after));
}

function authenticateT16Successor(common, root = REPOSITORY, generation = 8) {
  if (generation === true) generation = 3;
  if (generation === false) generation = 8;
  assert([3,4,5,6,7,8].includes(generation), 'unknown T16 generation');
  const historical = generation !== 8;
  const T16_STAGE = generation === 3 ? R3_STAGE : generation === 4 ? R4_STAGE : generation === 5 ? R5_STAGE : generation === 6 ? R6_STAGE : generation === 7 ? R7_STAGE : R8_STAGE;
  const T16_HANDOFF = T16_STAGE + '/generation.json';
  const T16_HANDOFF_SHA = generation === 3 ? R3_HANDOFF_SHA : generation === 4 ? R4_HANDOFF_SHA : generation === 5 ? R5_HANDOFF_SHA : generation === 6 ? R6_HANDOFF_SHA : generation === 7 ? R7_HANDOFF_SHA : R8_HANDOFF_SHA;
  const T16_CORRECTIVE = generation === 3 ? module.exports.T16_CORRECTIVE : generation === 4 ? R4_CORRECTIVE : generation === 5 ? R5_CORRECTIVE : generation === 6 ? R6_CORRECTIVE : generation === 7 ? R7_CORRECTIVE : R8_CORRECTIVE;
  assert.equal(common, '/Volumes/KINGSTON/claude-shipyard/.git');
  const key = path.join(path.dirname(REPAIR_HANDOFF), 'operator-public-key.asc');
  read(key, 'a2831936134d378395058b84e81ae9411c4da03800933700f1d995ebd51f89c3');
  const handback = authenticateHandback(T16_HANDOFF, T16_HANDOFF_SHA, key);
  const selection = authenticateHandback(T16_STAGE + '/selection.json', handback.selection_sha256, key);
  const binding = authenticateHandback(T16_STAGE + '/binding.json', selection.binding_sha256, key);
  if (generation === 8) validateR8Contract(handback, selection, binding);
  else if (generation === 7) validateR7Contract(handback, selection, binding);
  else if (generation === 6) validateR6Contract(handback, selection, binding);
  else if (generation === 5) validateR5Contract(handback, selection, binding);
  else validateT16Contract(handback, selection, binding, generation === 4);
  for (const [name, digest] of [['graph', binding.source.graph_sha256], ['state', binding.source.delivery_state_sha256]]) {
    const ref = binding.source_snapshots[name]; assert.equal(ref.sha256, digest);
    assert.equal(ref.path, T16_STAGE + (name === 'graph' ? '/source-graph.json' : '/source-delivery-state.json'));
    read(ref.path, digest, true);
  }
  const graph = JSON.parse(read(binding.source_snapshots.graph.path));
  assert.equal(Object.keys(graph.tickets).filter(id => /^T-47-\d+$/.test(id)).length, 27);
  const source = binding.source;
  assert.equal(gitText(root, 'rev-parse', source.head + '^{tree}'), source.tree);
  const signatureHome = fs.realpathSync(fs.mkdtempSync('/private/tmp/p47-git-'));
  try {
    const keyring = path.join(signatureHome, 'operator.gpg');
    execFileSync('gpg', ['--batch', '--no-options', '--homedir', signatureHome, '--dearmor', '--output', keyring, key], {stdio: 'pipe', timeout: 10000});
    const raw = git(root, 'cat-file', 'commit', source.head).toString('utf8');
    const headerEnd = raw.indexOf('\n\n');
    const headers = raw.slice(0, headerEnd).split('\n');
    const signature = [], payloadHeaders = [];
    let inSignature = false;
    for (const line of headers) {
      if (line.startsWith('gpgsig ')) { assert.equal(signature.length, 0); inSignature = true; signature.push(line.slice(7)); }
      else if (inSignature && line.startsWith(' ')) signature.push(line.slice(1));
      else { inSignature = false; payloadHeaders.push(line); }
    }
    assert(signature.length > 0, 'unsigned T16 Git source');
    const signatureFile = path.join(signatureHome, 'commit.asc'), payloadFile = path.join(signatureHome, 'commit');
    fs.writeFileSync(signatureFile, signature.join('\n') + '\n');
    fs.writeFileSync(payloadFile, payloadHeaders.join('\n') + raw.slice(headerEnd));
    const signed = execFileSync('gpgv', ['--homedir', signatureHome, '--keyring', keyring, '--status-fd', '1', signatureFile, payloadFile],
      {encoding: 'utf8', stdio: 'pipe', timeout: 30000});
    validateOperatorSignature(signed);
  } finally { fs.rmSync(signatureHome, {recursive: true, force: true}); }
  for (const row of source.inputs) {
    assert.equal(sha(git(root, 'show', source.head + ':' + row.path)), row.sha256);
    assert.equal(git(root, 'show', source.head + ':' + row.path).length, row.bytes);
    assert.equal(gitText(root, 'ls-tree', source.head, '--', row.path).split(' ')[0], row.mode === 0o755 ? '100755' : '100644');
  }
  if (!historical) assert.deepEqual(canonicalInputs(root), source.inputs.map(({path, sha256}) => ({path, sha256})), 'T16 source publication pending: canonical source drift');
  if (!historical) {
    admitT16CurrentSource(root, source, generation, key);
    for (const row of source.inputs) assert.equal(physical(path.join(root, row.path)).mode & 0o777, row.mode);
  }
  const finalization = JSON.parse(read(fs.realpathSync(binding.source_finalization.path), binding.source_finalization.sha256));
  const proofRef = binding.source_finalization.verification;
  const envelope = JSON.parse(read(proofRef.path));
  assert.equal(sha(canon(envelope)), proofRef.digest);
  const proof = hostVerification.readEvidence(proofRef.path, proofRef.digest);
  assert(proof, 'authenticated T16 HOST proof required');
  assert.equal(proof.ticket, 'T-47-16');
  assert.equal(proof.plan_sha256, source.plan_sha256);
  assert.equal(proof.results.length, 2);
  assert(proof.results.every(row => row.status === 0 && row.outcome === 'passed' && row.timeout_ms === 600000
    && row.tree_before === source.tree && row.tree_after === source.tree));
  const native = JSON.parse(read(fs.realpathSync(binding.source_finalization.fixer_result_path), binding.source_finalization.fixer_result_sha256));
  assert.equal(native.ticket, 'T-47-16');
  assert.equal(native.role, generation === 3 || generation === 8 ? 'review-fix' : 'ci-fix');
  assert.equal(native.receipt.dispatch_id, native.dispatch_id);
  reference(native.receipt.runtime_evidence.transcript);
  assert.equal(native.receipt.runtime_evidence.ticket, 'T-47-16');
  assert.equal(finalization.committed.commit, source.head);
  assert.equal(finalization.committed.tree, source.tree);
  assert.equal(finalization.committed.signer, '2F485C0A455BA33463F66332900FCE87BD1BFF0D');
  assert.equal(finalization.coverage.covered, true);
  reauthenticateRepairCoverage({current_head: source.head, coverage: finalization.coverage}, root);
  assert.equal(finalization.verification.digest, binding.source_finalization.verification.digest);
  if (generation >= 4) {
    const sourceNative = JSON.parse(read(generation === 4 ? '/private/tmp/phase47-16-copilot-ci-repair-result.json' : generation === 5 ? '/private/tmp/phase47-16-bounded-verdict-lookup-result.json' : generation === 6 ? '/private/tmp/phase47-16-shared-epic-repo-fix-result.json' : generation === 7 ? '/private/tmp/phase47-16-planning-artifact-root-result.json' : '/private/tmp/phase47-16-pr452-review-fix-result.json', generation === 4 ? 'dfdbc82033718d11dfd2b8a83f13518cde566d206ee6649698592d890c5e72ae' : generation === 5 ? 'cf09547bcd4bd5b419e43b3284042bd7a13407071256d00fd916e6f3d2b171f9' : generation === 6 ? '8e6b32a17a71eb72f0fece5350629500fb40ee21dfec34a342c981d32ee96843' : generation === 7 ? 'c462cc116e905a500792522c86bc8b3b2be6f3aa6b51e5414fc6e436b3a2326f' : '90c94c82cbeb98954044f4ce4c71f221f738f22c2dc23c62a2d946a6d308c85f'));
    assert.equal(sourceNative.role, 'review-fix'); assert.equal(sourceNative.ticket, 'T-47-16');
    reference(sourceNative.receipt.runtime_evidence.transcript);
    read(fs.realpathSync(binding.builder_inventory.path), binding.builder_inventory.sha256);
    read(fs.realpathSync(binding.publication_native_result.path), binding.publication_native_result.sha256);
    if (generation === 8) {
      const publisher = JSON.parse(read(fs.realpathSync(binding.publication_native_result.path), binding.publication_native_result.sha256));
      assert.equal(publisher.ticket, 'T-47-16');
      assert.equal(publisher.role, 'ci-fix');
      assert.equal(publisher.receipt.dispatch_id, publisher.dispatch_id);
      assert.equal(publisher.receipt.runtime_evidence.ticket, 'T-47-16');
      reference(publisher.receipt.runtime_evidence.transcript);
    }
  }
  read('/Volumes/KINGSTON/worktrees/phase47-investigation/claude-shipyard/.planning/config.json', source.config_sha256);
  assert.equal(sha(git(root, 'show', source.head + ':.planning/config.json')), SOURCE39_SHA);
  read(path.join(source.worktree, '.planning/config.json'), SOURCE39_SHA);
  const previous = generation === 3 ? authenticateR2History(common, root) : authenticateT16Successor(common, root, generation - 1);
  assert.equal(previous.handback.selection_sha256, binding.previous_publication.selection_sha256);
  const parentOutputs = new Map(previous.selected.binding.outputs.map(row => [row.path, row]));
  const delta = binding.outputs.filter(row => {const before = parentOutputs.get(row.path);
    assert(before, 'foreign T16 inventory member');
    return before.sha256 !== row.sha256 || before.publication_mode !== row.publication_mode;
  }).map(row => row.path).sort();
  assert.deepEqual(delta, T16_CORRECTIVE, 'T16 measured delta differs from exact original owners');
  if (generation === 3) {
    const publication = JSON.parse(read('/private/tmp/phase47-16-main421-publication-trusted-fixer-finalization.json',
      '7304cfdb4df2924ee9a22820ce9b1f07d9c1fcb68a5590b49b7aa5939793a8ef'));
    assert.equal(publication.committed.commit, '63209e88de5213bb378b07b61cb7b64a4bc3d44f');
    assert.equal(publication.committed.previousHead, source.head);
    assert.equal(publication.committed.tree, gitText(root, 'rev-parse', publication.committed.commit + '^{tree}'));
    assert.equal(publication.verification.digest, '564d45fca85cc6b2a2b5b088eb4c1d6b15571974660a1e483946468f13256c8d');
    const proof = hostVerification.readEvidence(publication.verification.path, publication.verification.digest);
    assert(proof && proof.ticket === 'T-47-16' && proof.results.length === 2);
    assert(proof.results.every(row => row.status === 0 && row.outcome === 'passed'
      && row.tree_before === publication.committed.tree && row.tree_after === publication.committed.tree));
    reauthenticateRepairCoverage({current_head: publication.committed.commit, coverage: publication.coverage}, root);
    const native = JSON.parse(read(fs.realpathSync(publication.fixer_result_path), publication.fixer_result_sha256));
    assert.equal(native.role, 'ci-fix'); assert.equal(native.ticket, 'T-47-16');
    reference(native.receipt.runtime_evidence.transcript);
  }
  const published = generation === 3 ? '63209e88de5213bb378b07b61cb7b64a4bc3d44f' : source.head;
  git(root, 'merge-base', '--is-ancestor', source.head, published);
  for (const row of binding.outputs) {
    assert.equal(sha(git(root, 'show', published + ':plugins/shipyard/' + row.path)), row.sha256, 'published T16 byte drift');
    assert.equal(gitText(root, 'ls-tree', published, '--', 'plugins/shipyard/' + row.path).split(' ')[0], row.publication_mode === 0o755 ? '100755' : '100644');
  }
  const actual = inventory(selection.candidate_path, false, true);
  assert.deepEqual(actual, binding.outputs.map(row => ({path: row.path, sha256: row.sha256, bytes: row.bytes, mode: row.sealed_mode})));
  const contentHash = crypto.createHash('sha256');
  for (const row of actual) {
    if (['package-build.json', '.codex-plugin/plugin.json'].includes(row.path)) continue;
    contentHash.update(row.path + '\0'); contentHash.update(read(path.join(selection.candidate_path, row.path)));
  }
  const content = contentHash.digest('hex');
  const manifestBytes = read(path.join(selection.candidate_path, '.codex-plugin/plugin.json'));
  const manifest = JSON.parse(manifestBytes);
  const build = JSON.parse(read(path.join(selection.candidate_path, 'package-build.json')));
  const packageDigest = sha(Buffer.concat([Buffer.from(content + '\0'), manifestBytes]));
  assert.equal(build.digest, packageDigest); assert.equal(manifest.version, binding.version);
  assert.equal(build.version, binding.version);
  assert.equal(binding.version.split('+codex.')[1], content.slice(0, 16));
  const outputs = binding.outputs.map(row => ({...row, git_mode: row.publication_mode === 0o755 ? '100755' : '100644'}));
  return { handback, selected: { root: T16_STAGE, selectionPath: handback.selection_path, selection,
    binding: {...binding, outputs, source_content_sha256: content, package_sha256: packageDigest, canonical_input_digest: sha(canon(source.inputs))}, t16: true }, current: {source_publication: 'verified'}, planning: { historical_only: true, current_authority: false, predecessor: previous.planning } };
}

function recheckT16Successor(authenticated, root = REPOSITORY) {
  assert.deepEqual(authenticateT16Successor('/Volumes/KINGSTON/claude-shipyard/.git', root), authenticated, 'T16 authority moved during inspection');
}

function validatePreviousCurrentPublication(ref, previous) {
  assert.equal(ref.path, F1_HANDOFF);
  assert.equal(ref.sha256, F1_HANDOFF_SHA);
  assert.deepEqual(ref.historical_source_contract, F1_HISTORICAL_CONTRACT);
  for (const key of ['selection_path', 'selection_sha256', 'binding_path', 'binding_sha256'])
    assert.equal(ref[key], previous[key], 'previous GENF1 drift: ' + key);
}

function validateR2Scope(scope) {
  assert.equal(scope.finding.id, 'F2');
  assert.equal(scope.source_pr, 449);
  assert.deepEqual(scope.preserve_previous_current_generation, { path: F1_HANDOFF, sha256: F1_HANDOFF_SHA });
  validateF1Scope({ ...scope, finding: { ...scope.finding, id: 'F1' }, source_pr: 447 });
}

function validatePreviousRepairPublication(ref, previous) {
  assert.equal(ref.path, REPAIR_HANDOFF);
  assert.equal(ref.sha256, REPAIR_HANDOFF_SHA);
  for (const key of ['selection_path', 'selection_sha256', 'binding_path', 'binding_sha256'])
    assert.equal(ref[key], previous[key], 'previous GEN27 drift: ' + key);
}

function validateF1Scope(scope) {
  assert.equal(scope.schema, 'shipyard.phase47-existing-contract-remedy.v1');
  assert.equal(scope.actor, 'trusted-coordinator');
  assert.equal(scope.native_receipt, false);
  assert.equal(scope.status, 'approved');
  assert.equal(scope.finding.id, 'F1');
  assert.equal(scope.ticket_count, 27);
  assert.equal(scope.new_tickets, 0);
  assert.equal(scope.source_ticket, 'T-47-26');
  assert.equal(scope.source_pr, 447);
  assert.equal(scope.publication_ticket, 'T-47-27');
  assert.deepEqual([...scope.actual_corrective_package_outputs].sort(), F1_CORRECTIVE);
  assert.deepEqual(scope.preserve_previous_generation, { path: REPAIR_HANDOFF, sha256: REPAIR_HANDOFF_SHA });
  assert.deepEqual(scope.plan_pins.map(row => row.sha256), REPAIR_PLANS);
  assert.equal(scope.config_sha256, COORDINATOR48_SHA);
  assert.equal(scope.historical_index_sha256, 'f28d939b31f05fc9ca1da2ce024151e04449a4c1e84315fd56b0d449bf2fc58e');
  assert.deepEqual([...scope.publication_files].sort(), REPAIR_OWNERS);
}

function validateFreshMaterializations(v1, v2, previousV1, previousV2, handoffSHA, v1SHA, operation = F1_HANDOFF) {
  for (const [fresh, previous] of [[v1, previousV1], [v2, previousV2]]) {
    assert.deepEqual(fresh.current_handoff, { path: operation, sha256: handoffSHA });
    const normalized = structuredClone(fresh);
    normalized.current_handoff = previous.current_handoff;
    if (fresh === v2) {
      assert.deepEqual(fresh.previous_materialization,
        { path: path.join(path.dirname(operation), 'historical-materialization.json'), sha256: v1SHA });
      normalized.previous_materialization = previous.previous_materialization;
    }
    for (const row of fresh === v1 ? [normalized.entry] : normalized.entries) {
      assert.equal(path.dirname(row.retained_path), path.dirname(operation));
      row.retained_path = path.join(path.dirname(REPAIR_HANDOFF), path.basename(row.retained_path));
    }
    assert.deepEqual(normalized, previous, 'fresh materialization must retain exact original mappings and bytes');
  }
}

const REPAIR_OWNERS = ['tests/unit/phase47-package-publication.test.cjs',
  'tests/smoke/phase47-runtime-acceptance.cjs', 'tests/unit/phase47-runtime-acceptance.test.cjs',
  ...REPAIR_CORRECTIVE.map(relative => 'plugins/shipyard/' + relative),
  'docs/phase47-runtime-acceptance.md', 'docs/audits/phase47-runtime-acceptance.json',
  'docs/audits/phase47-runtime-handoff.md'].sort();

function validateRepairContract(handback, approval, followup = false) {
  const corrective = followup ? F1_CORRECTIVE : REPAIR_CORRECTIVE;
  assert.equal(handback.purpose, 'ADR-027-main-review-repair');
  assert.equal(approval.schema, 'shipyard.phase47-current-source-approval.v1');
  assert.equal(approval.purpose, handback.purpose);
  assert.equal(approval.actor, 'trusted-coordinator');
  assert.equal(approval.native_receipt, false);
  assert.equal(approval.status, 'approved');
  assert.match(approval.source_head, /^[a-f0-9]{40}$/);
  assert.notEqual(approval.source_head, VOLUME_SOURCE, 'stale volume source');
  assert.equal(approval.source_head, handback.source_head);
  assert.deepEqual(Object.keys(handback.corrective_allocation), ['T-47-27']);
  assert.deepEqual([...handback.corrective_allocation['T-47-27']].sort(), corrective);
  assert.deepEqual([...handback.changed_outputs].sort(), corrective);
  for (const key of ['successor_planner', 'current_checker', 'current_research', 'source_correction',
    'tail_plan_amendments', 'delivery_metadata_amendment', 'corrective_allocation', 'prior_final_handoff'])
    assert.deepEqual(approval[key], handback[key], 'repair approval drift: ' + key);
  assert.deepEqual(approval.tail_plan_amendments.map(row => row.sha256), REPAIR_PLANS);
  assert.equal(approval.reviewed_source_config_sha256, SOURCE39_SHA);
  assert.equal(approval.coordinator_config_sha256, COORDINATOR48_SHA);
  assert.deepEqual(approval.source_correction.strict_configuration_identity,
    { source39: SOURCE39_SHA, coordinator48: COORDINATOR48_SHA, historical43: HISTORICAL43_SHA });
  assert.equal(approval.source_correction.command_approval.path, '/tmp/phase47-main-review-exact-command-approval.json');
  assert.equal(approval.source_correction.command_approval.sha256,
    '2e7bd51c86d5eff1d65fe09fcf3d366cd27d5dd98eea86a7af0689ae2009696e');
  assert.equal(approval.prior_final_handoff.path, VOLUME_HANDOFF);
  assert.equal(approval.prior_final_handoff.sha256, VOLUME_HANDOFF_SHA);
  if (followup) {
    assert.equal(approval.source_head, followup === 'R2' ? '15a205063774993bc35404b5c8c8f1013f98b016' : '485058d9797efc40469a6db005dc4449e68015b1');
    assert.equal(approval.source_correction.scope_disposition.path, followup === 'R2' ? R2_SCOPE : F1_SCOPE);
    assert.match(approval.source_correction.scope_disposition.sha256, /^[a-f0-9]{64}$/);
    assert.equal(approval.source_correction.previous_repair_publication.path, REPAIR_HANDOFF);
    assert.equal(approval.source_correction.previous_repair_publication.sha256, REPAIR_HANDOFF_SHA);
  }
  if (followup === 'R2') validatePreviousCurrentPublication(approval.source_correction.previous_current_publication, F1_PUBLICATION_PINS);
  const verdict = approval.current_checker.verdict;
  assert.equal(verdict.verdict || verdict.status, 'passed');
  assert.deepEqual(verdict.blockers, []);
  assert.deepEqual(verdict.artifact_paths, []);
  for (let i = 0; i < 4; i++)
    assert.equal(verdict.input_sha256[PHASE + '/47-' + (24 + i) + '-PLAN.md'], REPAIR_PLANS[i]);
}

const MATERIALIZATION = path.join(path.dirname(REPAIR_HANDOFF), 'historical-materialization.json');
const MATERIALIZATION_SHA = '991222edd7862d6a04d32bbd919ce0527644fd89e1ef221fd705525582a9d3fa';

function validateVolumeMaterialization(record, indexRef, indexed, entry) {
  assert.equal(record.schema, 'shipyard.phase47-historical-planner-materialization.v1');
  assert.equal(record.actor, 'trusted-coordinator');
  assert.equal(record.native_receipt, false);
  assert.deepEqual(record.volume_handoff, { path: VOLUME_HANDOFF, sha256: VOLUME_HANDOFF_SHA });
  assert.deepEqual(record.current_handoff, { path: REPAIR_HANDOFF, sha256: REPAIR_HANDOFF_SHA });
  assert.deepEqual(record.original_artifact_index, indexRef);
  assert.equal(record.entry.original_path, indexed.path);
  assert.equal(record.entry.original_path, entry.path);
  assert.equal(record.entry.original_physical_path, entry.physical_path);
  assert.equal(record.entry.bytes, indexed.bytes);
  assert.equal(record.entry.bytes, entry.bytes);
  assert.equal(record.entry.sha256, indexed.sha256);
  assert.equal(record.entry.sha256, entry.sha256);
  assert.equal(record.entry.sha256, '79c335ae5ab21f168ac86d1d890e66a577c621c1e5c180d1e2b0e3eccfa240b0');
  assert.equal(record.entry.bytes, 224296);
  assert.equal(record.entry.retained_path, path.join(path.dirname(REPAIR_HANDOFF), 'volume-original-CONTEXT.md'));
  assert.deepEqual(record.current_context, { path: entry.physical_path, bytes: 237493,
    sha256: 'cccdfc72ae92f372c8d886a0ed6399cd22ad862fb9c955a4801c4a6761e1d76d' });
}

const MATERIALIZATION_V2 = path.join(path.dirname(REPAIR_HANDOFF), 'historical-materialization-2.json');
const MATERIALIZATION_V2_SHA = 'db4c2aab32ae33189521720758c76446faac578b5e476e81a5431b45c5bdcf97';
const ORIGINAL_ENTRIES = [
  {
    "predecessor_handoff": {
      "path": "/Users/serhii/.local/state/shipyard/codex-decompose/6cba328f5f0de395b373ad6c77a164feb771363c4e6b7a96888b7075d52da7aa/phase47-final-generation-adr027-current-ticket-evidence/generation.json",
      "sha256": "a56da0e28c524cbc55821e10f5791404229f85442edc4424e808b3768b870f15"
    },
    "native_result": {
      "path": "/Users/serhii/.local/state/shipyard/codex-decompose/6cba328f5f0de395b373ad6c77a164feb771363c4e6b7a96888b7075d52da7aa/phase47-final-generation-adr027-current-ticket-evidence/archive-scope-research.json",
      "sha256": "b057fb77b837ed2ab60925f7608d449a85c832903a7cb0e68c32ff633018a1b5"
    },
    "original_artifact_index": {
      "path": "/Users/serhii/.local/state/shipyard/codex-decompose/6cba328f5f0de395b373ad6c77a164feb771363c4e6b7a96888b7075d52da7aa/sealed/research-index/ecd87dce49a54e56541794f6a0c94017a36a8098209476d8728dc0a0ad93c6cf.json",
      "bytes": 420,
      "content_bytes": 420,
      "sha256": "ecd87dce49a54e56541794f6a0c94017a36a8098209476d8728dc0a0ad93c6cf",
      "digest": "ecd87dce49a54e56541794f6a0c94017a36a8098209476d8728dc0a0ad93c6cf"
    },
    "original_path": "/Volumes/KINGSTON/worktrees/phase47-investigation/claude-shipyard/.planning/phases/47-complete-deferred-decomposition-wait-attribution/47-RESEARCH.md",
    "original_physical_path": "/Volumes/KINGSTON/worktrees/phase47-investigation/claude-shipyard/.planning/phases/47-complete-deferred-decomposition-wait-attribution/47-RESEARCH.md",
    "bytes": 110608,
    "sha256": "ea7733d74705aa856a74d0d3919697e06dfa2efaf2715a4fec6ba8455deab5ff",
    "retained_path": "/Users/serhii/.local/state/shipyard/codex-decompose/6cba328f5f0de395b373ad6c77a164feb771363c4e6b7a96888b7075d52da7aa/phase47-final-generation-adr027-main-review-repair/original-ea7733d74705aa856a74d0d3919697e06dfa2efaf2715a4fec6ba8455deab5ff-47-RESEARCH.md",
    "current_sha256": "1d81a2022e3b5812897bbe61178818054eb3f58a6955616b476967a61caba6ec",
    "current_bytes": 216250
  },
  {
    "predecessor_handoff": {
      "path": "/Users/serhii/.local/state/shipyard/codex-decompose/6cba328f5f0de395b373ad6c77a164feb771363c4e6b7a96888b7075d52da7aa/phase47-final-generation-adr027-current-ticket-volume/generation.json",
      "sha256": "32eb9144cc872ee6f6f4747ef83e475905c565effee16f93f64dc7a7e8d7062f"
    },
    "native_result": {
      "path": "/Users/serhii/.local/state/shipyard/codex-decompose/6cba328f5f0de395b373ad6c77a164feb771363c4e6b7a96888b7075d52da7aa/phase47-final-generation-adr027-current-ticket-volume/successor-planner.json",
      "sha256": "6817edca92f38d04d311b8919d5667b05388bec122e95c0bd9a1cd252cec9add"
    },
    "original_artifact_index": {
      "path": "/Users/serhii/.local/state/shipyard/codex-decompose/6cba328f5f0de395b373ad6c77a164feb771363c4e6b7a96888b7075d52da7aa/sealed/decomposition-index/f7a7ec24e883c18f095e518536cf670ae080538d739b4e3ffb40a652c264f6df.json",
      "bytes": 8418,
      "content_bytes": 8418,
      "sha256": "f7a7ec24e883c18f095e518536cf670ae080538d739b4e3ffb40a652c264f6df",
      "digest": "f7a7ec24e883c18f095e518536cf670ae080538d739b4e3ffb40a652c264f6df"
    },
    "original_path": "/Volumes/KINGSTON/worktrees/phase47-investigation/claude-shipyard/.planning/phases/47-complete-deferred-decomposition-wait-attribution/CONTEXT.md",
    "original_physical_path": "/Volumes/KINGSTON/worktrees/phase47-investigation/claude-shipyard/.planning/phases/47-complete-deferred-decomposition-wait-attribution/CONTEXT.md",
    "bytes": 224296,
    "sha256": "79c335ae5ab21f168ac86d1d890e66a577c621c1e5c180d1e2b0e3eccfa240b0",
    "retained_path": "/Users/serhii/.local/state/shipyard/codex-decompose/6cba328f5f0de395b373ad6c77a164feb771363c4e6b7a96888b7075d52da7aa/phase47-final-generation-adr027-main-review-repair/original-79c335ae5ab21f168ac86d1d890e66a577c621c1e5c180d1e2b0e3eccfa240b0-CONTEXT.md",
    "current_sha256": "cccdfc72ae92f372c8d886a0ed6399cd22ad862fb9c955a4801c4a6761e1d76d",
    "current_bytes": 237493
  },
  {
    "predecessor_handoff": {
      "path": "/Users/serhii/.local/state/shipyard/codex-decompose/6cba328f5f0de395b373ad6c77a164feb771363c4e6b7a96888b7075d52da7aa/phase47-final-generation-adr027-current-ticket-volume/generation.json",
      "sha256": "32eb9144cc872ee6f6f4747ef83e475905c565effee16f93f64dc7a7e8d7062f"
    },
    "native_result": {
      "path": "/Users/serhii/.local/state/shipyard/codex-decompose/6cba328f5f0de395b373ad6c77a164feb771363c4e6b7a96888b7075d52da7aa/phase47-final-generation-adr027-current-ticket-volume/archive-scope-research.json",
      "sha256": "b01b085cb661e3a0ea7ca795d6d083369de00e39105722cec2d031412ff4b5d5"
    },
    "original_artifact_index": {
      "path": "/Users/serhii/.local/state/shipyard/codex-decompose/6cba328f5f0de395b373ad6c77a164feb771363c4e6b7a96888b7075d52da7aa/sealed/research-index/748bb1f44b72dde3604cef458dc0ea728c78e266bf64ddcd0f105496d73cfe69.json",
      "bytes": 420,
      "content_bytes": 420,
      "sha256": "748bb1f44b72dde3604cef458dc0ea728c78e266bf64ddcd0f105496d73cfe69",
      "digest": "748bb1f44b72dde3604cef458dc0ea728c78e266bf64ddcd0f105496d73cfe69"
    },
    "original_path": "/Volumes/KINGSTON/worktrees/phase47-investigation/claude-shipyard/.planning/phases/47-complete-deferred-decomposition-wait-attribution/47-RESEARCH.md",
    "original_physical_path": "/Volumes/KINGSTON/worktrees/phase47-investigation/claude-shipyard/.planning/phases/47-complete-deferred-decomposition-wait-attribution/47-RESEARCH.md",
    "bytes": 137184,
    "sha256": "e5c93b9cbbe1d31986d17a1f6fbfe98ca2fd0ce4528fab106c8247649504fa44",
    "retained_path": "/Users/serhii/.local/state/shipyard/codex-decompose/6cba328f5f0de395b373ad6c77a164feb771363c4e6b7a96888b7075d52da7aa/phase47-final-generation-adr027-main-review-repair/original-e5c93b9cbbe1d31986d17a1f6fbfe98ca2fd0ce4528fab106c8247649504fa44-47-RESEARCH.md",
    "current_sha256": "1d81a2022e3b5812897bbe61178818054eb3f58a6955616b476967a61caba6ec",
    "current_bytes": 216250
  }
];

function validateOriginalMaterialization(record, predecessor, resultRef, indexRef, indexed, entry) {
  assert.equal(record.schema, 'shipyard.phase47-historical-planner-materialization.v2');
  assert.equal(record.actor, 'trusted-coordinator');
  assert.equal(record.native_receipt, false);
  assert.deepEqual(record.current_handoff, { path: REPAIR_HANDOFF, sha256: REPAIR_HANDOFF_SHA });
  assert.deepEqual(record.previous_materialization, { path: MATERIALIZATION, sha256: MATERIALIZATION_SHA });
  assert.deepEqual(record.entries, ORIGINAL_ENTRIES, 'fixed three original entries required');
  const matches = record.entries.filter(row => row.predecessor_handoff.path === predecessor.path
    && row.original_path === entry.path && row.sha256 === indexed.sha256);
  assert.equal(matches.length, 1, 'unknown original entry');
  const row = matches[0];
  assert.deepEqual(row.predecessor_handoff, predecessor);
  assert.equal(row.native_result.path, resultRef.path);
  assert.equal(row.native_result.sha256, resultRef.sha256);
  assert.deepEqual(row.original_artifact_index, indexRef);
  assert.equal(indexed.path, row.original_path, 'foreign original index entry path');
  assert.equal(row.original_physical_path, entry.physical_path || entry.path);
  assert.equal(row.bytes, indexed.bytes);
  assert.equal(row.bytes, entry.bytes);
  assert.equal(row.sha256, entry.sha256);
  return row;
}

function historicalOriginalEntry(predecessor, resultRef, indexRef, indexed, entry) {
  const expected = ORIGINAL_ENTRIES.find(row => row.predecessor_handoff.path === predecessor.path
    && row.original_path === entry.path && row.sha256 === indexed.sha256);
  if (!expected) return reference({ ...entry, path: entry.physical_path || entry.path });
  const record = authenticateHandback(MATERIALIZATION_V2, MATERIALIZATION_V2_SHA);
  const row = validateOriginalMaterialization(record, predecessor, resultRef, indexRef, indexed, entry);
  authenticateHandback(MATERIALIZATION, MATERIALIZATION_SHA);
  authenticateHandback(predecessor.path, predecessor.sha256);
  read(REPAIR_HANDOFF, REPAIR_HANDOFF_SHA, true);
  const result = JSON.parse(reference(resultRef));
  assert.equal(result.status, 'completed');
  assert.equal(result.receipt.gsd_role, path.basename(entry.path) === 'CONTEXT.md'
    ? 'gsd-planner' : 'gsd-phase-researcher');
  assert.deepEqual(result.artifact_index, indexRef);
  const index = JSON.parse(reference(indexRef));
  assert.deepEqual(index.entries.filter(member => member.path === indexed.path), [indexed]);
  reference({ path: row.original_physical_path, bytes: row.current_bytes, sha256: row.current_sha256 });
  return reference({ path: row.retained_path, bytes: row.bytes, sha256: row.sha256 }, true);
}

function historicalVolumeEntry(indexRef, indexed, entry, resultRef) {
  const row = ORIGINAL_ENTRIES.find(row => row.predecessor_handoff.path === VOLUME_HANDOFF
    && row.original_path === entry.path && row.sha256 === indexed.sha256);
  return historicalOriginalEntry({ path: VOLUME_HANDOFF, sha256: VOLUME_HANDOFF_SHA },
    resultRef || (row ? row.native_result : {}), indexRef, indexed, entry);
}

function reauthenticateRepairCoverage(repair, worktree = REPOSITORY, verify = null) {
  const cv = require('../../plugins/delivery-pipeline/scripts/conveyor-coverage.cjs');
  const root = path.resolve(HOST, '../../coverage');
  const coverage = (verify || cv.verify)({ commit: repair.current_head, repo: repair.coverage.record.repo,
    worktree, root, keyPath: path.join(root, 'coverage.key') });
  assert.equal(coverage.covered, true, coverage.reason);
  assert.deepEqual(coverage, repair.coverage);
  return coverage;
}

function authenticateRepairSuccessor(common, root = REPOSITORY, historical = false, historicalContract = null) {
  assert([false, true, 'F1', 'R2-history'].includes(historical), 'unknown repair historical selector');
  if (historical === 'R2-history') assert.equal(historicalContract, R2_HISTORY_ADMISSION, 'signed pinned R2 historical admission required');
  const originalRepair = historical === true;
  const operation = originalRepair ? REPAIR_HANDOFF : historical === 'F1' ? F1_HANDOFF : R2_HANDOFF;
  const pin = originalRepair ? REPAIR_HANDOFF_SHA : historical === 'F1' ? F1_HANDOFF_SHA : R2_HANDOFF_SHA;
  const stage = originalRepair ? REPAIR_STAGE : historical === 'F1' ? F1_STAGE : R2_STAGE;
  const corrective = originalRepair ? REPAIR_CORRECTIVE : F1_CORRECTIVE;
  assert(pin, 'actual signed main-review-repair generation is pending');
  const handback = authenticateHandback(operation, pin);
  const approvalRef = handback.current_source_approval;
  assert.equal(approvalRef.path, path.join(path.dirname(operation), 'source-approval.json'));
  assert.equal(approvalRef.signature_path, approvalRef.path + '.asc');
  const approval = authenticateHandback(approvalRef.path, approvalRef.sha256);
  validateRepairContract(handback, approval, originalRepair ? false : historical === 'F1' ? true : 'R2');
  const selected = selectedArtifact(common, handback, stage);
  selected.repair = true;
  selected.followup = !originalRepair;
  const source = selected.binding.source;
  assert.equal(source.head, approval.source_head);
  assert.equal(source.tree, approval.source_tree);
  assert.equal(approval.source_identity_sha256, handback.source_identity_sha256);
  assert.equal(approval.canonical_input_digest, selected.binding.canonical_input_digest);
  assert.deepEqual(approval.parent_commits, source.parent_commits);
  assert.deepEqual(approval.provenance, source.provenance);
  const prior = authenticateVolumeSuccessor(common, root, true);
  for (const key of ['generation_id', 'source_head', 'selection_path', 'selection_sha256', 'binding_path', 'binding_sha256'])
    assert.equal(handback.prior_final_handoff[key], prior.handback[key], 'volume predecessor drift: ' + key);
  for (const key of ['original_handoff_path', 'original_handoff_sha256', 'original_source_head',
    'original_source_identity_sha256', 'original_index_sha256']) {
    assert.equal(handback[key], prior.handback[key]);
    assert.equal(approval[key], handback[key]);
  }
  assert.equal(handback.original_generation_id, prior.handback.original_generation_id);
  assert.equal(handback.original_configuration_snapshot.sha256, SOURCE39_SHA);
  reference(handback.original_configuration_snapshot, true);
  reference({ path: path.join(path.dirname(operation), 'historical43-config.json'), sha256: HISTORICAL43_SHA }, true);
  reference({ path: path.join(path.dirname(operation), 'coordinator48-config.json'), sha256: COORDINATOR48_SHA }, true);
  assert.deepEqual(JSON.parse(reference(handback.original_ledger, true)), JSON.parse(git(root,
    'show', source.head + ':docs/audits/phase47-runtime-acceptance.json')));
  assert.equal(sha(reference(handback.prior_handoff_document, true)), sha(git(root,
    'show', source.head + ':docs/audits/phase47-runtime-handoff.md')));
  for (let i = 0; i < 4; i++) {
    const ref = approval.tail_plan_amendments[i];
    assert.equal(ref.path, path.join(source.repository, PHASE, '47-' + (24 + i) + '-PLAN.md'));
    reference(ref);
  }
  const planner = JSON.parse(reference(approval.successor_planner));
  assert.equal(planner.status, 'completed');
  assert.equal(planner.receipt.dispatch_id, approval.successor_planner.dispatch_id);
  assert.deepEqual(planner.artifact_index, approval.successor_planner.artifact_index);
  validateCurrentNative(planner, 'gsd-planner', null, true);
  const index = JSON.parse(reference(planner.artifact_index));
  const entries = approval.successor_planner.historical_materialized_entries;
  assert.equal(index.entries.length, 28);
  assert.equal(entries.length, index.entries.length);
  assert.deepEqual(entries.map(row => row.path).sort(), index.entries.map(row => row.path).sort());
  for (const entry of entries) {
    const indexed = index.entries.find(row => row.path === entry.path);
    assert.equal(indexed.sha256, entry.sha256);
    assert.equal(indexed.bytes, entry.bytes);
    reference({ ...entry, path: entry.physical_path });
  }
  const checkerRef = approval.current_checker, checker = JSON.parse(reference(checkerRef));
  assert.equal(checker.receipt.dispatch_id, checkerRef.dispatch_id);
  assert.deepEqual(checker.receipt.runtime_evidence.native_child_evidence, checkerRef.native_child_evidence);
  assert.deepEqual(checker.receipt.runtime_evidence.transcript, checkerRef.transcript);
  assert.equal(checkerRef.native_child_transcript.sha256, checkerRef.native_child_evidence.sha256);
  const records = validateCurrentNative(checker, 'gsd-plan-checker', checkerRef.native_child_transcript);
  const finals = records.filter(row => row.type === 'response_item' && row.payload?.role === 'assistant'
    && row.payload.phase === 'final_answer');
  assert.equal(finals.length, 1, 'unique original checker final required');
  const text = finals[0].payload.content.filter(row => row.type === 'output_text').map(row => row.text).join('');
  assert.deepEqual(JSON.parse(text), checkerRef.verdict);
  assert.equal(checkerRef.verdict.task_sha256 || checkerRef.verdict.input_sha256.TASK_FILE,
    checkerRef.native_child_evidence.task_relay.sha256);
  const research = JSON.parse(reference(approval.current_research));
  assert.equal(research.status, 'completed');
  validateCurrentNative(research, 'gsd-phase-researcher', null, true);
  for (const entry of JSON.parse(reference(research.artifact_index)).entries) reference(entry);
  for (const ref of approval.delivery_metadata_amendment.amendments) reference(ref, true);
  const preservation = JSON.parse(reference(approval.original19_plan_preservation));
  assert.equal(preservation.count, 19);
  assert.equal(preservation.files.length, 19);
  for (const entry of preservation.files) reference({ ...entry, path: path.join(source.repository, entry.path) });
  const correction = approval.source_correction;
  reference(correction.command_approval);
  if (!historical || historical === 'R2-history') {
    assert(R2_SCOPE_SHA, 'signed R2 scope pin pending trusted adoption');
    assert.equal(correction.scope_disposition.sha256, R2_SCOPE_SHA);
    assert.equal(correction.scope_disposition.path, R2_SCOPE);
    assert.equal(fs.realpathSync('/tmp'), '/private/tmp', 'foreign system temporary root');
    const scope = authenticateHandback('/private/tmp/phase47-R2-existing-contract-scope.json', R2_SCOPE_SHA,
      path.join(path.dirname(REPAIR_HANDOFF), 'operator-public-key.asc'));
    validateR2Scope(scope);
    const sourceFix = correction.source_repairs.find(row => row.ticket === 'T-47-26');
    assert.deepEqual(scope.source_finalization, { path: sourceFix.finalization.path, sha256: sourceFix.finalization.sha256 });
    const previous = authenticateRepairSuccessor(common, root, true, correction.previous_repair_publication.historical_source_contract);
    validatePreviousRepairPublication(correction.previous_repair_publication, previous.handback);
    const previousCurrent = authenticateRepairSuccessor(common, root, 'F1', correction.previous_current_publication.historical_source_contract);
    validatePreviousCurrentPublication(correction.previous_current_publication, previousCurrent.handback);
    assert(R2_MATERIALIZATION_SHA && R2_MATERIALIZATION_V2_SHA, 'fresh signed original-input materializations pending trusted adoption');
    const freshV1 = authenticateHandback(path.join(path.dirname(operation), 'historical-materialization.json'), R2_MATERIALIZATION_SHA);
    const freshV2 = authenticateHandback(path.join(path.dirname(operation), 'historical-materialization-2.json'), R2_MATERIALIZATION_V2_SHA);
    validateFreshMaterializations(freshV1, freshV2,
      authenticateHandback(MATERIALIZATION, MATERIALIZATION_SHA),
      authenticateHandback(MATERIALIZATION_V2, MATERIALIZATION_V2_SHA), pin, R2_MATERIALIZATION_SHA, operation);
    for (const row of [freshV1.entry, ...freshV2.entries])
      reference({ path: row.retained_path, bytes: row.bytes, sha256: row.sha256 }, true);
  }
  if (historical === 'F1') {
    assert.equal(correction.scope_disposition.path, F1_SCOPE);
    assert.equal(correction.scope_disposition.sha256, F1_SCOPE_SHA);
    assert.equal(fs.realpathSync('/tmp'), '/private/tmp');
    const scope = authenticateHandback('/private/tmp/phase47-F1-existing-contract-scope.json', F1_SCOPE_SHA,
      path.join(path.dirname(REPAIR_HANDOFF), 'operator-public-key.asc'));
    validateF1Scope(scope);
    const sourceFix = correction.source_repairs.find(row => row.ticket === 'T-47-26');
    assert.deepEqual(scope.source_finalization, { path: sourceFix.finalization.path, sha256: sourceFix.finalization.sha256 });
    const previous = authenticateRepairSuccessor(common, root, true, correction.previous_repair_publication.historical_source_contract);
    validatePreviousRepairPublication(correction.previous_repair_publication, previous.handback);
    const v1 = authenticateHandback(path.join(path.dirname(operation), 'historical-materialization.json'), F1_MATERIALIZATION_SHA);
    const v2 = authenticateHandback(path.join(path.dirname(operation), 'historical-materialization-2.json'), F1_MATERIALIZATION_V2_SHA);
    validateFreshMaterializations(v1, v2, authenticateHandback(MATERIALIZATION, MATERIALIZATION_SHA),
      authenticateHandback(MATERIALIZATION_V2, MATERIALIZATION_V2_SHA), pin, F1_MATERIALIZATION_SHA);
    for (const row of [v1.entry, ...v2.entries]) reference({ path: row.retained_path, bytes: row.bytes, sha256: row.sha256 }, true);
  }
  reference(correction.scope_disposition);
  assert.deepEqual(correction.prior_source_correction, prior.approval.source_correction);
  assert(path.isAbsolute(correction.consumer_contract_ready.worktree));
  assert.match(correction.consumer_contract_ready.evidence_sha256, /^[a-f0-9]{64}$/);
  assert.equal(correction.consumer_contract_ready.native_receipt, false);
  for (const file of ['tests/unit/phase47-package-publication.test.cjs', 'tests/smoke/phase47-runtime-acceptance.cjs',
    'tests/unit/phase47-runtime-acceptance.test.cjs']) assert(correction.consumer_contract_ready.declared_delta.includes(file));
  assert.deepEqual(correction.source_repairs.map(row => row.ticket), ['T-47-24', 'T-47-25', 'T-47-26']);
  for (const repair of correction.source_repairs) {
    const result = JSON.parse(reference(repair.native_executor));
    assert.equal(result.receipt.compliance, 'verified');
    assert.equal(result.receipt.runtime, 'codex');
    assert.equal(result.ticket, repair.ticket);
    assert.equal(result.receipt.role, 'executor');
    assert.equal(result.receipt.dispatch_id, result.dispatch_id);
    assert.deepEqual(result.receipt, repair.native_executor.receipt);
    reference(result.receipt.runtime_evidence.transcript);
    assert.equal(result.artifact.status, 'committed');
    git(root, 'merge-base', '--is-ancestor', result.artifact.commit, repair.current_head);
    assert.deepEqual(repair.actual_merge, source.parent_commits[repair.ticket]);
    assert.equal(repair.current_head, repair.actual_merge.head);
    const finalization = JSON.parse(reference(repair.finalization));
    assert.equal(finalization.committed.commit, repair.finalization.commit);
    assert.equal(finalization.committed.tree, repair.finalization.tree);
    assert.equal(finalization.current_config_sha256, COORDINATOR48_SHA);
    assert.deepEqual(finalization.verification, repair.finalization.verification);
    git(root, 'merge-base', '--is-ancestor', repair.finalization.commit, repair.current_head);
    const verification = hostVerification.readEvidence(repair.finalization.verification.path, repair.finalization.verification.digest);
    assert(verification, 'authenticated source repair verification required');
    assert.equal(verification.ticket, repair.ticket);
    assert.equal(verification.plan_sha256, REPAIR_PLANS[Number(repair.ticket.slice(-2)) - 24]);
    assert.equal(verification.results.length, repair.ticket === 'T-47-25' ? 1 : 2);
    assert(verification.results.every(row => row.outcome === 'passed'
      && row.tree_before === repair.finalization.tree && row.tree_after === repair.finalization.tree));
    assert.deepEqual(verification, repair.host_verification);
    assert.equal(repair.coverage.covered, true);
    reauthenticateRepairCoverage(repair, root);
  }
  assert.equal(source.head, source.parent_commits['T-47-26'].merge);
  assert.deepEqual(selected.binding.outputs.map(row => row.path), prior.selected.binding.outputs.map(row => row.path));
  assert.equal(selected.binding.outputs.length, 161);
  const delta = selected.binding.outputs.filter(entry => sha(git(root, 'show', source.head + ':plugins/shipyard/' + entry.path)) !== entry.sha256
    || gitText(root, 'ls-tree', source.head, '--', 'plugins/shipyard/' + entry.path).split(' ')[0] !== entry.git_mode).map(row => row.path).sort();
  assert.deepEqual(delta, corrective, 'actual supported builder delta drift');
  const current = historical === 'R2-history' ? validateHistoricalSource(root, selected.binding, approval, 'R2-history')
    : historical ? validateHistoricalSource(root, selected.binding, approval, true, historicalContract) : validateSource(root, selected.binding, approval);
  if (historical === 'R2-history') validateSignedHistoricalParents(source, approval,
    (before, after) => git(root, 'merge-base', '--is-ancestor', before, after));
  return { handback, selected, approval, prior, planning: prior.planning, current };
}

function recheckRepairSuccessor(authenticated, root = REPOSITORY) {
  assert.deepEqual(authenticateRepairSuccessor(authenticated.selected.binding.source.common, root), authenticated,
    'main-review-repair successor changed during inspection');
}

const CALLER = ['codex-arch-review-context', 'role-artifact', 'codex-decompose-host',
  'codex-planning-context-host'].map(mirror);
const GROUPS = {
  candidate: [], launch: ALLOCATION['T-47-05'],
  caller: [...ALLOCATION['T-47-05'], ...CALLER],
  integration: [...ALLOCATION['T-47-05'], ...ALLOCATION['T-47-11']],
  relay: UNION.filter(p => !['.codex-plugin/plugin.json', 'package-build.json'].includes(p)),
  complete: UNION,
};
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const canon = value => Array.isArray(value) ? '[' + value.map(canon).join(',') + ']'
  : value && typeof value === 'object' ? '{' + Object.keys(value).sort()
    .map(key => JSON.stringify(key) + ':' + canon(value[key])).join(',') + '}' : JSON.stringify(value);
const git = (root, ...args) => execFileSync('git', ['-C', root, ...args], {
  stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000, maxBuffer: 32 * 1024 * 1024,
});
const gitText = (root, ...args) => git(root, ...args).toString().trim();

function physical(file, directory = false, sealed = false) {
  assert(path.isAbsolute(file) && path.normalize(file) === file, 'nonabsolute or moved physical path');
  let current = path.parse(file).root;
  for (const part of file.slice(current.length).split('/').filter(Boolean)) {
    current = path.join(current, part);
    assert(!fs.lstatSync(current).isSymbolicLink(), 'symlinked physical path: ' + current);
  }
  const stat = fs.lstatSync(file);
  assert(directory ? stat.isDirectory() : stat.isFile(), 'wrong physical type: ' + file);
  assert.equal(fs.realpathSync(file), file, 'moved physical path');
  if (sealed) {
    assert.equal(stat.mode & 0o222, 0, 'unsealed physical path: ' + file);
    assert.equal(stat.uid, process.getuid(), 'foreign sealed owner');
  }
  return stat;
}

function read(file, digest, sealed = false) {
  const before = physical(file, false, sealed);
  assert(before.size <= 32 * 1024 * 1024, 'physical input exceeds read bound');
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  let bytes;
  try {
    const opened = fs.fstatSync(fd);
    bytes = fs.readFileSync(fd);
    const after = physical(file, false, sealed), final = fs.fstatSync(fd);
    for (const field of ['dev', 'ino', 'size', 'mode', 'mtimeMs', 'ctimeMs']) {
      assert.equal(opened[field], before[field], 'physical input replaced before open');
      assert.equal(final[field], before[field], 'physical descriptor replaced during read');
      assert.equal(after[field], before[field], 'physical input replaced during read');
    }
    assert.equal(bytes.length, before.size, 'physical input truncated');
  } finally { fs.closeSync(fd); }
  if (digest !== undefined) assert.equal(sha(bytes), digest, 'digest mismatch: ' + file);
  return bytes;
}

function inventory(root, editorExclusions = false, sealed = false, prefix = '') {
  physical(root, true, sealed);
  const entries = [];
  // Keep the builder's localeCompare path/NUL/bytes ordering.
  for (const entry of fs.readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const file = path.join(root, entry.name);
    if (editorExclusions && /\.(bak|orig|rej|swp)$|(?:^|\/)\.DS_Store$|~$/.test(file)) continue;
    const relative = prefix + entry.name;
    assert(!entry.isSymbolicLink(), 'symlinked inventory member');
    if (entry.isDirectory()) entries.push(...inventory(file, editorExclusions, sealed, relative + '/'));
    else {
      const bytes = read(file, undefined, sealed);
      entries.push({ path: relative, sha256: sha(bytes), bytes: bytes.length,
        mode: physical(file).mode & 0o777 });
    }
  }
  return entries;
}

function canonicalInputs(root) {
  const files = ['scripts/package-shipyard-codex.cjs', ...SCRIPTS.map(name => 'scripts/' + name)];
  for (const directory of ['plugins/delivery-pipeline', 'capabilities/delivery-pipeline'])
    for (const entry of inventory(path.join(root, directory), true)) files.push(directory + '/' + entry.path);
  return [...new Set(files)].sort().map(relative => ({ path: relative, sha256: sha(read(path.join(root, relative))) }));
}

function validateAllocation(allocation) {
  assert.deepEqual(Object.keys(allocation).sort(), Object.keys(ALLOCATION).sort(), 'publication owner drift');
  for (const ticket of Object.keys(ALLOCATION))
    assert.deepEqual([...allocation[ticket]].sort(), [...ALLOCATION[ticket]].sort(), 'publication allocation drift: ' + ticket);
  assert.equal(new Set(Object.values(allocation).flat()).size, 20, 'publication union must contain twenty outputs');
}

function validateHandback(handback, selection, binding, selectionPath) {
  assert.equal(handback.schema, 'shipyard.phase47-coordinator-generation.v1');
  assert.equal(handback.actor, 'trusted-coordinator');
  assert.equal(handback.operation, 'generate');
  assert.equal(handback.status, 'completed', 'missing completed preparation');
  assert.equal(handback.native_receipt, false, 'host preparation is not a native receipt');
  assert.match(handback.command_sha256, /^[a-f0-9]{64}$/);
  assert.equal(handback.selection_path, selectionPath);
  assert.equal(handback.selection_sha256, sha(read(selectionPath)));
  for (const key of ['generation_id', 'candidate_path', 'binding_path', 'binding_sha256', 'candidate_sha256'])
    assert.equal(handback[key], selection[key], 'handback/selection mismatch: ' + key);
  assert.equal(handback.source_head, binding.source.head);
  assert.equal(handback.source_identity_sha256, sha(canon(binding.source)), 'original source identity drift');
  assert.equal(handback.original_index_sha256, binding.source.plan_index_sha256);
  assert.equal(handback.historical_manifest_sha256, binding.source.plan_manifest_sha256);
  assert.deepEqual(handback.current_plan_amendments, binding.source.current_plan_amendments);
  validateAllocation(handback.publication_allocation);
  assert.deepEqual([...handback.changed_outputs].sort(), handback.purpose === 'ADR-027-main-review-repair' ? ([F1_STAGE, R2_STAGE].some(stage => selectionPath === path.join(binding.source.common, stage, 'selection.json')) ? F1_CORRECTIVE : REPAIR_CORRECTIVE) : handback.purpose === 'ADR-027-current-ticket-volume' ? VOLUME_CORRECTIVE : handback.purpose === 'ADR-027-current-ticket-evidence' ? SUCCESSOR_CORRECTIVE : handback.purpose === 'ADR-026-final'
    ? (handback.source_update ? CORRECTIVE : CORRECTIVE.filter(p => p !== mirror('architecture-target'))) : UNION,
    'unexpected generation scope');
  if (handback.purpose === 'ADR-026-final')
    validateCorrective(handback.corrective_allocation, handback.source_update
      ? CORRECTIVE : CORRECTIVE.filter(p => p !== mirror('architecture-target')));
}

function selectedArtifact(common, handback, stage = STAGE_DIRECTORY) {
  const root = path.join(common, stage);
  assert.equal(physical(root, true).uid, process.getuid(), 'foreign publication root');
  assert.equal(physical(root, true).mode & 0o077, 0, 'public publication root');
  const selectionPath = path.join(root, 'selection.json');
  const selection = JSON.parse(read(selectionPath, handback.selection_sha256, true));
  assert.match(selection.generation_id, /^[a-f0-9]{64}$/);
  const generation = path.join(root, selection.generation_id);
  assert.equal(selection.candidate_path, path.join(generation, 'candidate'), 'moved candidate selection');
  assert.equal(selection.binding_path, path.join(generation, 'binding.json'), 'moved binding selection');
  assert.deepEqual(fs.readdirSync(root).sort(), [selection.generation_id, 'selection.json'].sort(), 'unselected generation');
  physical(generation, true, true);
  assert.deepEqual(fs.readdirSync(generation).sort(), ['binding.json', 'candidate']);
  const binding = JSON.parse(read(selection.binding_path, selection.binding_sha256, true));
  assert.equal(binding.generation_id, selection.generation_id);
  assert.equal(binding.canonical_input_digest, selection.generation_id);
  assert.equal(binding.source.canonical_input_digest, binding.canonical_input_digest);
  assert.equal(sha(canon(binding.source.identities)), binding.canonical_input_digest);
  assert.equal(sha(canon(binding.outputs)), selection.candidate_sha256);
  assert.equal(binding.source.common, common, 'foreign git common identity');
  validateAllocation(binding.source.publication_allocation);
  validateHandback(handback, selection, binding, selectionPath);
  const actual = inventory(selection.candidate_path, false, true).sort((a, b) => a.path.localeCompare(b.path));
  assert.equal(actual.length, binding.outputs.length, 'candidate inventory membership drift');
  for (let index = 0; index < actual.length; index++) {
    const observed = actual[index], expected = binding.outputs[index];
    for (const key of ['path', 'sha256', 'bytes']) assert.equal(observed[key], expected[key], 'sealed output mismatch: ' + key);
    assert([0o644, 0o755].includes(expected.publication_mode), 'invalid publication mode');
    assert.equal(expected.git_mode, expected.publication_mode === 0o755 ? '100755' : '100644');
    assert.equal(expected.sealed_mode, expected.publication_mode & ~0o222);
    assert.equal(observed.mode, expected.sealed_mode, 'sealed execute bit/mode mismatch');
  }
  const hash = crypto.createHash('sha256');
  for (const entry of actual) {
    if (['package-build.json', '.codex-plugin/plugin.json'].includes(entry.path)) continue;
    hash.update(entry.path + '\0'); hash.update(read(path.join(selection.candidate_path, entry.path)));
  }
  const content = hash.digest('hex');
  assert.equal(content, binding.source_content_sha256);
  const manifestBytes = read(path.join(selection.candidate_path, '.codex-plugin/plugin.json'));
  const manifest = JSON.parse(manifestBytes);
  const build = JSON.parse(read(path.join(selection.candidate_path, 'package-build.json')));
  const packageDigest = sha(Buffer.concat([Buffer.from(content + '\0'), manifestBytes]));
  assert.equal(packageDigest, binding.package_sha256);
  assert.equal(build.digest, packageDigest);
  assert.equal(manifest.version, binding.version);
  assert.equal(build.version, binding.version);
  assert.equal(binding.version, JSON.parse(read(path.join(selection.candidate_path,
    'host/plugins/delivery-pipeline/.claude-plugin/plugin.json'))).version + '+codex.' + content.slice(0, 16));
  for (const input of binding.source.identities) {
    if (input.path === 'scripts/package-shipyard-codex.cjs') continue;
    const output = 'host/' + input.path;
    assert.equal(sha(read(path.join(selection.candidate_path, output))), input.sha256, 'mixed canonical package bytes');
  }
  return { root, selectionPath, selection, binding };
}

function validateOperatorSignature(result) {
  const valid = result.split('\n').filter(line => line.startsWith('[GNUPG:] VALIDSIG '));
  assert.equal(valid.length, 1, 'missing unique operator signature');
  assert(valid[0].split(' ').slice(2).includes(OPERATOR), 'wrong operator signature');
}

function authenticateHandback(file = HANDOFF, digest = HANDOFF_SHA, publicKey = path.join(path.dirname(file), 'operator-public-key.asc')) {
  const bytes = read(file, digest, true);
  const signature = read(file + '.asc', undefined, true);
  const keyBytes = read(publicKey);
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-p47-signature-')));
  fs.chmodSync(home, 0o700);
  try {
    const keyring = path.join(home, 'operator.gpg');
    execFileSync('gpg', ['--batch', '--no-options', '--homedir', home, '--dearmor', '--output', keyring, publicKey], {
      stdio: ['ignore', 'pipe', 'pipe'], timeout: 10000,
    });
    const result = execFileSync('gpgv', ['--homedir', home, '--keyring', keyring,
      '--status-fd', '1', file + '.asc', file], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 10000,
    });
    validateOperatorSignature(result);
    read(file, sha(bytes), true);
    read(file + '.asc', sha(signature), true);
    read(publicKey, sha(keyBytes));
    return JSON.parse(bytes);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
}

function validateCorrective(allocation, expected = CORRECTIVE) {
  assert.deepEqual(Object.keys(allocation), ['T-47-19'], 'corrective owner drift');
  assert.deepEqual([...allocation['T-47-19']].sort(), expected, 'corrective allocation drift');
}

function validateSourceUpdate(update) {
  assert.equal(update.commit, FINAL_SOURCE, 'foreign source update');
  assert.equal(update.parent, '72f033c994053654d5025e128081ee37be0e04b7', 'foreign source parent');
  assert.equal(update.canonical_path, 'plugins/delivery-pipeline/scripts/architecture-target.cjs');
  assert.equal(update.added_generated_owner, 'plugins/shipyard/' + mirror('architecture-target'));
  assert.equal(update.current19_plan_sha256, PLAN19_SHA);
  assert.equal(update.current_owner_count, 15);
  assert.equal(update.current_corrective_outputs, 9);
  assert.deepEqual(update.task_sizes, [3, 5, 3, 4]);
}

function validateConfigurations(root, source, approval) {
  if (approval) {
    assert.equal(source.config_sha256, approval.reviewed_source_config_sha256, 'reviewed source config binding');
    assert.equal(source.coordinator_config_sha256, approval.coordinator_config_sha256, 'coordinator config binding');
    read(path.join(source.repository, '.planning/config.json'), approval.coordinator_config_sha256);
    assert.equal(sha(git(root, 'show', source.head + ':.planning/config.json')), source.config_sha256,
      'unreviewed source configuration');
  } else read(path.join(source.repository, '.planning/config.json'), source.config_sha256);
  read(path.join(root, '.planning/config.json'), source.config_sha256);
}

function validateDescendant(root, source, revision = 'HEAD') {
  git(root, 'merge-base', '--is-ancestor', source.head, revision);
  assert.deepEqual(canonicalInputs(root), source.identities, 'canonical source descendant drift');
  assert.deepEqual(source.input_modes, source.identities.map(entry => ({ path: entry.path,
    mode: physical(path.join(root, entry.path)).mode & 0o777 })), 'canonical descendant mode drift');
  for (const entry of source.identities) {
    assert.equal(sha(git(root, 'show', revision + ':' + entry.path)), entry.sha256, 'committed canonical descendant drift');
    const treeMode = gitText(root, 'ls-tree', revision, '--', entry.path).split(' ')[0];
    assert.equal(treeMode, source.input_modes.find(row => row.path === entry.path).mode === 0o755 ? '100755' : '100644');
  }
  const changed = gitText(root, 'log', '--format=', '--name-only', source.head + '..' + revision)
    .split('\n').filter(Boolean);
  for (const relative of changed)
    assert(/^(?:plugins\/shipyard\/|tests\/|docs\/|\.shipyard-(?:evidence|pr-body)\.md$)/.test(relative),
      'unapproved publication descendant: ' + relative);
}

function reference(reference, sealed = false) {
  const digest = reference.sha256 || reference.digest;
  assert.match(digest || '', /^[a-f0-9]{64}$/, 'signed reference digest required');
  let file = reference.path;
  if (file.startsWith('/tmp/')) {
    assert.equal(fs.realpathSync('/tmp'), '/private/tmp', 'foreign system temporary root');
    file = '/private/tmp/' + file.slice(5);
  }
  const bytes = read(file, digest, sealed);
  if (reference.bytes !== undefined) assert.equal(bytes.length, reference.bytes, 'reference byte count drift');
  return bytes;
}

function authenticateOriginal(common) {
  const handback = authenticateHandback();
  const selected = selectedArtifact(common, handback);
  const planning = validatePlanning(handback, selected.binding.source, true);
  return { handback, selected, planning, historical_only: true };
}

function authenticateFinal(common, root = REPOSITORY, historical = false) {
  const handback = authenticateHandback(FINAL_HANDOFF, FINAL_HANDOFF_SHA);
  assert.equal(handback.purpose, 'ADR-026-final');
  const selected = selectedArtifact(common, handback, FINAL_STAGE);
  selected.final = true;
  const approvalRef = handback.current_source_approval;
  assert.equal(approvalRef.path, path.join(path.dirname(FINAL_HANDOFF), 'source-approval.json'));
  assert.equal(approvalRef.signature_path, approvalRef.path + '.asc');
  const approval = authenticateHandback(approvalRef.path, approvalRef.sha256);
  assert.equal(approval.schema, 'shipyard.phase47-current-source-approval.v1');
  assert.equal(approval.purpose, 'ADR-026-final');
  assert.equal(approval.status, 'approved');
  assert.equal(approval.actor, 'trusted-coordinator');
  assert.equal(approval.native_receipt, false);
  assert.equal(approval.source_head, FINAL_SOURCE);
  assert.equal(approval.source_head, selected.binding.source.head);
  assert.equal(approval.source_tree, selected.binding.source.tree);
  assert.equal(approval.source_identity_sha256, handback.source_identity_sha256);
  assert.equal(approval.canonical_input_digest, selected.binding.canonical_input_digest);
  validateCorrective(approval.corrective_allocation);
  for (const key of ['source_update', 'successor_planner', 'current_checker', 'tail_plan_amendments',
    'delivery_metadata_amendment', 'corrective_allocation'])
    assert.deepEqual(approval[key], handback[key], 'signed approval/handback drift: ' + key);
  assert.deepEqual(approval.parent_commits, selected.binding.source.parent_commits);
  assert.deepEqual(approval.provenance, selected.binding.source.provenance);
  validateSourceUpdate(approval.source_update);
  const update = approval.source_update;
  assert.equal(gitText(root, 'rev-parse', update.commit + '^'), update.parent);
  assert.equal(gitText(root, 'diff', '--name-only', update.parent, update.commit), update.canonical_path,
    'source update membership drift');
  assert.equal(selected.binding.source.parent_commits['T-47-18'].merge, update.parent, 'actual T18 merge required');
  assert.equal(approval.original_handoff_path, HANDOFF);
  assert.equal(approval.original_handoff_sha256, HANDOFF_SHA);
  for (const key of ['original_handoff_path', 'original_handoff_sha256', 'original_source_head',
    'original_source_identity_sha256', 'original_index_sha256'])
    assert.equal(handback[key], approval[key], 'original signed approval anchor drift');
  const original = authenticateHandback();
  const originalSelected = selectedArtifact(common, original);
  assert.equal(original.generation_id, handback.original_generation_id);
  assert.equal(original.source_head, approval.original_source_head);
  assert.equal(original.source_identity_sha256, approval.original_source_identity_sha256);
  assert.equal(original.original_index_sha256, approval.original_index_sha256);
  git(root, 'merge-base', '--is-ancestor', original.source_head, approval.source_head);
  assert.equal(gitText(root, 'rev-parse', original.source_head + '^{tree}'), originalSelected.binding.source.tree);
  reference(handback.original_configuration_snapshot, true);
  assert.equal(handback.original_configuration_snapshot.sha256, originalSelected.binding.source.config_sha256);
  assert.equal(sha(git(root, 'show', original.source_head + ':.planning/config.json')),
    handback.original_configuration_snapshot.sha256, 'historical configuration approval drift');
  const planning = validatePlanning(original, originalSelected.binding.source, true);
  for (const amendment of selected.binding.source.current_plan_amendments) reference(amendment);
  assert.deepEqual(planOwners(reference(selected.binding.source.current_plan_amendments[0])),
    planOwners(read(path.join(path.dirname(HANDOFF), 'captured-coordinator-47-05-PLAN.md'))));
  const supersededRef = update.superseded_final_generation;
  assert.equal(supersededRef.path, path.join(HOST, 'phase47-final-generation-adr026/generation.json'));
  assert.equal(supersededRef.sha256, '83441e6d3f4a65b8b6018e9a753c1c7ea95a64181cf49a4b8877d679f55ae799');
  const superseded = authenticateHandback(supersededRef.path, supersededRef.sha256);
  for (const key of ['generation_id', 'source_head', 'selection_path', 'selection_sha256'])
    assert.equal(superseded[key], supersededRef[key], 'superseded history drift');
  assert.equal(superseded.source_head, update.parent);
  selectedArtifact(common, superseded, 'shipyard-phase47-final-publication/INV-014-runtime-delivery-correctness/ADR-026');
  reference(update.prior19_plan);
  assert.deepEqual(approval.tail_plan_amendments.map(ref => path.basename(ref.path)), ['47-18-PLAN.md', '47-19-PLAN.md']);
  const plans = approval.tail_plan_amendments.map(ref => reference(ref));
  assert.equal(approval.tail_plan_amendments[1].sha256, PLAN19_SHA);
  const currentOwners = planOwners(plans[1]);
  assert.deepEqual(currentOwners, ['tests/unit/phase47-package-publication.test.cjs',
    'tests/smoke/phase47-runtime-acceptance.cjs', 'tests/unit/phase47-runtime-acceptance.test.cjs',
    ...CORRECTIVE.map(relative => 'plugins/shipyard/' + relative),
    'docs/phase47-runtime-acceptance.md', 'docs/audits/phase47-runtime-acceptance.json',
    'docs/audits/phase47-runtime-handoff.md'].sort(), 'current fifteen-owner contract drift');
  const planner = JSON.parse(reference(approval.successor_planner));
  assert.equal(planner.status, 'completed');
  assert.equal(planner.receipt.dispatch_id, approval.successor_planner.dispatch_id);
  assert.equal(planner.receipt.compliance, 'verified');
  assert.equal(planner.receipt.gsd_role, 'gsd-planner');
  assert.deepEqual(planner.artifact_index, approval.successor_planner.artifact_index);
  reference(planner.artifact_index);
  const checkerRef = approval.current_checker, checker = JSON.parse(reference(checkerRef));
  assert.equal(checker.dispatch_id, checkerRef.dispatch_id);
  assert.equal(checker.receipt.compliance, 'verified');
  assert.equal(checker.receipt.gsd_role, 'gsd-plan-checker');
  assert.equal(checker.policy_hash, selected.binding.source.policy_sha256);
  assert.deepEqual(checker.receipt.runtime_evidence.native_child_evidence, checkerRef.native_child_evidence);
  reference(checkerRef.transcript);
  const native = reference(checkerRef.native_child_transcript, true);
  assert.equal(sha(native), checkerRef.native_child_evidence.sha256);
  const records = native.toString().trim().split('\n').map(line => JSON.parse(line));
  const meta = records.find(row => row.type === 'session_meta')?.payload;
  assert.equal(meta?.id, checkerRef.native_child_evidence.session_id);
  assert.equal(meta?.parent_thread_id, checkerRef.native_child_evidence.parent_thread_id);
  assert.equal(meta?.agent_role, 'gsd-plan-checker');
  const complete = records.filter(row => row.type === 'event_msg' && row.payload?.type === 'task_complete');
  assert.equal(complete.length, 1, 'missing unique native checker completion');
  assert.deepEqual(JSON.parse(complete[0].payload.last_agent_message), checkerRef.verdict, 'native checker verdict drift');
  assert.equal(checkerRef.verdict.input_sha256.task, checkerRef.native_child_evidence.task_relay.sha256);
  assert.equal(checkerRef.verdict.status, 'passed');
  assert.deepEqual(checkerRef.verdict.blockers, []);
  assert.equal(checkerRef.verdict.input_sha256.plan19, PLAN19_SHA);
  assert.equal(checkerRef.verdict.input_sha256.plan18, approval.tail_plan_amendments[0].sha256);
  const metadata = approval.delivery_metadata_amendment;
  for (const ref of [...metadata.prior_plans, ...metadata.current_plans, metadata.canonical_coverage_registration,
    metadata.initial_trusted_publication, metadata.current_fixer_result, metadata.trusted_finalization]) reference(ref);
  const verificationRef = metadata.trusted_finalization.verification;
  const verificationBytes = read(verificationRef.path);
  assert.equal(sha(canon(JSON.parse(verificationBytes))), verificationRef.digest, 'supported verification envelope drift');
  const verificationEnvelope = JSON.parse(read(verificationRef.path));
  assert.equal(sha(canon(verificationEnvelope)), verificationRef.digest, 'signed verification envelope drift');
  assert.equal(verificationEnvelope.format, 'shipyard.host-authenticated.v1');
  const verification = hostVerification.readEvidence(verificationRef.path, verificationRef.digest);
  assert(verification, 'authenticated HOST verification payload required');
  assert(verification && verification.ticket === 'T-47-18', 'authentic retained fixer verification required');
  assert.equal(verification.plan_sha256, approval.tail_plan_amendments[0].sha256);
  assert(verification.results.length && verification.results.every(row => row.outcome === 'passed'));
  read(verificationRef.path, sha(verificationBytes));
  assert.equal(metadata.trusted_finalization.verification.outcome, 'passed');
  assert.equal(metadata.trusted_finalization.coverage.covered, true);
  const fixer = JSON.parse(reference(metadata.current_fixer_result));
  assert.equal(fixer.receipt?.dispatch_id || fixer.dispatch_id, metadata.current_fixer_result.dispatch_id);
  const originalLedger = JSON.parse(reference(handback.original_ledger, true));
  assert.equal(originalLedger.ticket, 'T-47-08');
  const historicalPaths = originalSelected.binding.outputs.map(entry => entry.path);
  const currentPaths = selected.binding.outputs.map(entry => entry.path);
  assert.equal(historicalPaths.length, 160, 'original package inventory drift');
  assert.deepEqual(currentPaths.filter(relative => !historicalPaths.includes(relative)), [mirror('architecture-target')]);
  assert(historicalPaths.every(relative => currentPaths.includes(relative)), 'historical package member removed');
  const delta = selected.binding.outputs.filter(entry => {
    const relative = 'plugins/shipyard/' + entry.path;
    const bytes = git(root, 'show', selected.binding.source.head + ':' + relative);
    const mode = gitText(root, 'ls-tree', selected.binding.source.head, '--', relative).split(' ')[0];
    return sha(bytes) !== entry.sha256 || mode !== entry.git_mode;
  }).map(entry => entry.path).sort();
  assert.deepEqual(delta, CORRECTIVE, 'actual complete reviewed-source publication delta drift');
  const current = historical ? { historical_only: true } : validateSource(root, selected.binding, approval);
  return { handback, selected, approval, original, originalSelected, planning, current };
}

function validateSuccessorContract(handback, approval) {
  assert.equal(handback.purpose, 'ADR-027-current-ticket-evidence');
  assert.equal(approval.schema, 'shipyard.phase47-current-source-approval.v1');
  assert.equal(approval.purpose, handback.purpose);
  assert.equal(approval.status, 'approved');
  assert.equal(approval.actor, 'trusted-coordinator');
  assert.equal(approval.native_receipt, false);
  assert.equal(approval.source_head, SUCCESSOR_SOURCE);
  assert.equal(handback.source_head, SUCCESSOR_SOURCE);
  assert.deepEqual(approval.corrective_allocation, { 'T-47-21': handback.corrective_allocation['T-47-21'] });
  assert.deepEqual(Object.keys(handback.corrective_allocation), ['T-47-21']);
  assert.deepEqual([...approval.corrective_allocation['T-47-21']].sort(), SUCCESSOR_CORRECTIVE);
  assert.deepEqual([...handback.changed_outputs].sort(), SUCCESSOR_CORRECTIVE);
  for (const key of ['successor_planner', 'current_checker', 'current_research', 'source_correction',
    'tail_plan_amendments', 'delivery_metadata_amendment', 'corrective_allocation', 'prior_final_handoff'])
    assert.deepEqual(approval[key], handback[key], 'successor approval drift: ' + key);
  assert.equal(approval.tail_plan_amendments[0].sha256, 'd4f25b6a0668eb2848b73dc0738f6c166883a232aa607142b5b9d066537bc9c6');
  assert.equal(approval.tail_plan_amendments[1].sha256, PLAN21_SHA);
  assert.equal(approval.current_checker.verdict.input_sha256.plan21, PLAN21_SHA);
  assert.equal(approval.current_checker.verdict.input_sha256.plan20, approval.tail_plan_amendments[0].sha256);
  assert.equal(approval.current_checker.verdict.status, 'passed');
  assert.deepEqual(approval.current_checker.verdict.blockers, []);
}

function authenticateSuccessor(common, root = REPOSITORY, historical = false) {
  const handback = authenticateHandback(SUCCESSOR_HANDOFF, SUCCESSOR_HANDOFF_SHA);
  const approvalRef = handback.current_source_approval;
  assert.equal(approvalRef.path, path.join(path.dirname(SUCCESSOR_HANDOFF), 'source-approval.json'));
  assert.equal(approvalRef.sha256, SUCCESSOR_APPROVAL_SHA);
  assert.equal(approvalRef.signature_path, approvalRef.path + '.asc');
  const approval = authenticateHandback(approvalRef.path, SUCCESSOR_APPROVAL_SHA);
  validateSuccessorContract(handback, approval);
  const selected = selectedArtifact(common, handback, SUCCESSOR_STAGE);
  selected.successor = true;
  const source = selected.binding.source;
  assert.equal(approval.source_tree, source.tree);
  assert.equal(approval.source_identity_sha256, handback.source_identity_sha256);
  assert.equal(approval.canonical_input_digest, selected.binding.canonical_input_digest);
  assert.deepEqual(approval.parent_commits, source.parent_commits);
  assert.deepEqual(approval.provenance, source.provenance);
  const prior = authenticateFinal(common, root, true);
  for (const key of ['generation_id', 'source_head', 'selection_path', 'selection_sha256', 'binding_path', 'binding_sha256'])
    assert.equal(handback.prior_final_handoff[key], prior.handback[key], 'T19 predecessor drift: ' + key);
  assert.equal(handback.prior_final_handoff.path, FINAL_HANDOFF);
  assert.equal(handback.prior_final_handoff.sha256, FINAL_HANDOFF_SHA);
  assert.equal(handback.original_handoff_path, HANDOFF);
  assert.equal(handback.original_handoff_sha256, HANDOFF_SHA);
  assert.equal(handback.original_generation_id, prior.original.generation_id);
  assert.equal(handback.original_index_sha256, prior.original.original_index_sha256);
  reference(handback.original_configuration_snapshot, true);
  assert.equal(handback.original_configuration_snapshot.sha256, prior.originalSelected.binding.source.config_sha256);
  reference(handback.original_ledger, true);
  reference(handback.prior_handoff_document, true);
  assert.deepEqual(JSON.parse(reference(handback.original_ledger, true)), JSON.parse(git(root, 'show', SUCCESSOR_SOURCE + ':docs/audits/phase47-runtime-acceptance.json')));
  assert.equal(sha(reference(handback.prior_handoff_document, true)), sha(git(root, 'show', SUCCESSOR_SOURCE + ':docs/audits/phase47-runtime-handoff.md')));
  for (const ref of approval.tail_plan_amendments) reference(ref);
  const planner = JSON.parse(reference(approval.successor_planner));
  assert.equal(planner.status, 'completed');
  assert.equal(planner.receipt.compliance, 'verified');
  assert.equal(planner.receipt.gsd_role, 'gsd-planner');
  assert.equal(planner.receipt.dispatch_id, approval.successor_planner.dispatch_id);
  assert.deepEqual(planner.artifact_index, approval.successor_planner.artifact_index);
  reference(planner.receipt.runtime_evidence.transcript);
  const plannerChild = planner.receipt.runtime_evidence.native_child_evidence;
  assert.equal(plannerChild.agent_role, 'gsd-planner');
  const plannerRaw = read('/Users/serhii/.codex/sessions/2026/10/07/rollout-2026-10-07T18-50-31-01a1170f-26ce-7203-9e61-40c863b26c3e.jsonl', plannerChild.sha256).toString();
  require('../smoke/phase47-runtime-acceptance.cjs').validateInlineFirstCall(plannerRaw, plannerChild.task_relay, plannerChild);
  const plannerRecords = plannerRaw.trim().split('\n').map(line => JSON.parse(line));
  const plannerMeta = plannerRecords.find(row => row.type === 'session_meta')?.payload;
  assert.equal(plannerMeta?.id, plannerChild.session_id);
  assert.equal(plannerMeta?.parent_thread_id, plannerChild.parent_thread_id);
  assert.equal(plannerMeta?.agent_role, 'gsd-planner');
  const index = JSON.parse(reference(planner.artifact_index));
  for (const entry of approval.successor_planner.historical_materialized_entries) {
    const original = index.entries.find(row => row.path === entry.path);
    assert(original, 'native planner index member missing');
    assert.equal(original.sha256, entry.sha256);
    historicalOriginalEntry({ path: SUCCESSOR_HANDOFF, sha256: SUCCESSOR_HANDOFF_SHA },
      approval.successor_planner, planner.artifact_index, original, entry);
  }
  const checkerRef = approval.current_checker, checker = JSON.parse(reference(checkerRef));
  assert.equal(checker.dispatch_id, checkerRef.dispatch_id);
  assert.equal(checker.receipt.compliance, 'verified');
  assert.equal(checker.receipt.gsd_role, 'gsd-plan-checker');
  assert.deepEqual(checker.receipt.runtime_evidence.native_child_evidence, checkerRef.native_child_evidence);
  reference(checkerRef.transcript);
  const childRaw = reference(checkerRef.native_child_transcript, true).toString();
  require('../smoke/phase47-runtime-acceptance.cjs').validateInlineFirstCall(childRaw,
    checkerRef.native_child_evidence.task_relay, checkerRef.native_child_evidence);
  const records = childRaw.trim().split('\n').map(line => JSON.parse(line));
  const meta = records.find(row => row.type === 'session_meta')?.payload;
  assert.equal(meta?.id, checkerRef.native_child_evidence.session_id);
  assert.equal(meta?.parent_thread_id, checkerRef.native_child_evidence.parent_thread_id);
  assert.equal(meta?.agent_role, 'gsd-plan-checker');
  const completed = records.filter(row => row.type === 'event_msg' && row.payload?.type === 'task_complete');
  assert.equal(completed.length, 1);
  assert.deepEqual(JSON.parse(completed[0].payload.last_agent_message), checkerRef.verdict);
  assert.equal(checkerRef.native_child_transcript.sha256, checkerRef.native_child_evidence.sha256);
  assert.equal(checkerRef.verdict.input_sha256.task, checkerRef.native_child_evidence.task_relay.sha256);
  const historicalResearch = JSON.parse(reference(approval.current_research));
  for (const entry of JSON.parse(reference(historicalResearch.artifact_index)).entries)
    historicalOriginalEntry({ path: SUCCESSOR_HANDOFF, sha256: SUCCESSOR_HANDOFF_SHA },
      approval.current_research, historicalResearch.artifact_index, entry, entry);
  for (const ref of approval.delivery_metadata_amendment.amendments) reference(ref, true);
  const preservedPlans = JSON.parse(reference(approval.original19_plan_preservation));
  assert.equal(preservedPlans.count, 19);
  assert.equal(preservedPlans.files.length, 19);
  for (const entry of preservedPlans.files)
    reference({ ...entry, path: path.join(source.repository, entry.path) });
  assert.equal(preservedPlans.files.find(row => path.basename(row.path) === '47-19-PLAN.md').sha256, PLAN19_SHA);
  for (const key of ['executor', 'fixer', 'fixture_fixer']) {
    const result = JSON.parse(reference(approval.source_correction[key]));
    assert.equal(result.ticket, 'T-47-20');
    assert.equal(result.receipt.compliance, 'verified');
    assert.equal(result.receipt.runtime, 'codex');
    assert.equal(result.receipt.role, key === 'executor' ? 'executor' : 'ci-fix');
    assert.equal(result.receipt.dispatch_id, result.dispatch_id);
    if (key === 'executor') assert.equal(result.status, 'verification_failed');
  }
  for (const key of ['prior_six_owner_finalization', 'trusted_finalization']) reference(approval.source_correction[key]);
  assert.deepEqual(approval.source_correction.actual_merge, source.parent_commits['T-47-20']);
  assert.equal(source.parent_commits['T-47-20'].merge, SUCCESSOR_SOURCE);
  const verificationRef = approval.source_correction.trusted_finalization.verification;
  const verificationEnvelope = JSON.parse(read(verificationRef.path));
  assert.equal(sha(canon(verificationEnvelope)), verificationRef.digest, 'signed verification envelope drift');
  assert.equal(verificationEnvelope.format, 'shipyard.host-authenticated.v1');
  const verification = hostVerification.readEvidence(verificationRef.path, verificationRef.digest);
  assert(verification, 'authenticated HOST verification payload required');
  assert.equal(verification.ticket, 'T-47-20');
  assert.equal(verification.plan_sha256, approval.tail_plan_amendments[0].sha256);
  assert.equal(verification.results.length, 4);
  assert(verification.results.every(row => row.outcome === 'passed'));
  assert.deepEqual(verification, approval.source_correction.host_verification);
  assert.deepEqual(selected.binding.outputs.map(row => row.path), prior.selected.binding.outputs.map(row => row.path));
  const delta = selected.binding.outputs.filter(entry => sha(git(root, 'show', source.head + ':plugins/shipyard/' + entry.path)) !== entry.sha256
    || gitText(root, 'ls-tree', source.head, '--', 'plugins/shipyard/' + entry.path).split(' ')[0] !== entry.git_mode).map(row => row.path).sort();
  assert.deepEqual(delta, SUCCESSOR_CORRECTIVE);
  const current = historical ? validateHistoricalSource(root, selected.binding, approval) : validateSource(root, selected.binding, approval);
  return { handback, selected, approval, prior, planning: prior.planning, current };
}

const HISTORICAL_CONTRACT_PATH = '/tmp/phase47-F1-pinned-historical-source-contract.json';
const HISTORICAL_CONTRACT_SHA = '07b20e75d00b8c40d7b4db4d8c6baf360e47860f998c9fc9c4035727990e9a14';

function authenticatePinnedHistoricalContract(ref, binding, approval) {
  const f1 = binding.source?.head === '485058d9797efc40469a6db005dc4449e68015b1';
  if (f1) assert.deepEqual(ref, F1_HISTORICAL_CONTRACT);
  const operation = f1 ? F1_HANDOFF : REPAIR_HANDOFF;
  const pin = f1 ? F1_HANDOFF_SHA : REPAIR_HANDOFF_SHA;
  if (!f1) assert.deepEqual(ref, { path: HISTORICAL_CONTRACT_PATH, sha256: HISTORICAL_CONTRACT_SHA });
  assert.equal(fs.realpathSync('/tmp'), '/private/tmp', 'foreign system temporary root');
  const contract = authenticateHandback(f1 ? '/private/tmp/phase47-R2-pinned-F1-historical-source-contract.json' : '/private/tmp/phase47-F1-pinned-historical-source-contract.json', ref.sha256,
    path.join(path.dirname(REPAIR_HANDOFF), 'operator-public-key.asc'));
  const original = authenticateHandback(operation, pin);
  assert.deepEqual(contract.original_generation, { path: operation, sha256: pin });
  assert.deepEqual(contract.original_approval, original.current_source_approval);
  assert.equal(contract.original_binding.path, original.binding_path);
  assert.equal(contract.original_binding.sha256, original.binding_sha256);
  assert.deepEqual(JSON.parse(reference(contract.original_binding, true)), binding);
  assert.deepEqual(authenticateHandback(contract.original_approval.path, contract.original_approval.sha256), approval);
  validatePinnedHistoricalIdentity(contract, binding.source, original, f1);
}

function validatePinnedHistoricalIdentity(contract, source, original, f1 = false) {
  assert.equal(contract.original_generation.path, f1 ? F1_HANDOFF : REPAIR_HANDOFF);
  assert.equal(contract.original_generation.sha256, f1 ? F1_HANDOFF_SHA : REPAIR_HANDOFF_SHA);
  assert.equal(sha(canon(source)), contract.original_source_identity_sha256);
  assert.equal(original.source_identity_sha256, contract.original_source_identity_sha256);
  assert.equal(source.head, contract.original_source_head);
  assert.equal(source.delivery_state_sha256, contract.original_delivery_state_digest);
  assert.equal(contract.original_parent_count, 26);
}

function validateSignedHistoricalParents(source, approval, ancestor) {
  assert.deepEqual(source.parent_commits, approval.parent_commits);
  assert.deepEqual(source.provenance, approval.provenance);
  const count = source.parent_commits['T-47-26'] ? 26 : source.parent_commits['T-47-22'] ? 22 : source.parent_commits['T-47-20'] ? 20 : 18;
  const parents = Array.from({ length: count }, (_, n) => 'T-47-' + String(n + 1).padStart(2, '0'));
  assert.deepEqual(Object.keys(source.parent_commits).sort(), parents);
  assert.deepEqual(Object.keys(source.provenance).sort(), parents);
  assert.match(source.delivery_state_sha256, /^[a-f0-9]{64}$/);
  for (const id of parents) {
    const commit = source.parent_commits[id], row = source.provenance[id];
    assert(Number.isSafeInteger(row.pr) && row.pr > 0);
    assert.equal(typeof row.base, 'string');
    assert(row.base.length > 0 && !/\s/.test(row.base));
    assert.equal(row.url, 'https://github.com/serhii-nochevnyi/shipyard/pull/' + row.pr);
    assert.match(row.state_sha256, /^[a-f0-9]{64}$/);
    assert.match(commit.head, /^[a-f0-9]{40}$/);
    assert(Array.isArray(commit.base_merge_commits));
    for (const merge of [commit.merge, ...commit.base_merge_commits]) {
      assert.match(merge, /^[a-f0-9]{40}$/);
      ancestor(merge, source.head);
    }
  }
}

function validateHistoricalSource(root, binding, approval, repair = false, historicalContract = null) {
  const source = binding.source;
  assert.equal(gitText(root, 'rev-parse', source.head + '^{tree}'), source.tree);
  assert.equal(source.coordinator_config_sha256, approval.coordinator_config_sha256);
  assert.equal(approval.coordinator_config_sha256, repair ? COORDINATOR48_SHA : HISTORICAL43_SHA);
  reference({ path: repair ? path.join(path.dirname(REPAIR_HANDOFF), 'coordinator48-config.json') : '/tmp/phase47-coordinator-config-before-main-review-commands.json', sha256: approval.coordinator_config_sha256 });
  assert.equal(sha(git(root, 'show', source.head + ':.planning/config.json')), approval.reviewed_source_config_sha256);
  assert.equal(source.config_sha256, approval.reviewed_source_config_sha256);
  assert.equal(source.coordinator_config_sha256, approval.coordinator_config_sha256);
  for (const input of source.identities) {
    assert.equal(sha(git(root, 'show', source.head + ':' + input.path)), input.sha256);
    assert.equal(gitText(root, 'ls-tree', source.head, '--', input.path).split(' ')[0],
      source.input_modes.find(row => row.path === input.path).mode === 0o755 ? '100755' : '100644');
  }
  assert.equal(sha(canon(source.identities)), binding.canonical_input_digest);
  if (repair && repair !== 'R2-history') {
    authenticatePinnedHistoricalContract(historicalContract, binding, approval);
    validateSignedHistoricalParents(source, approval,
      (before, after) => git(root, 'merge-base', '--is-ancestor', before, after));
  } else if (repair !== 'R2-history') {
    validateSignedHistoricalParents(source, approval,
      (before, after) => git(root, 'merge-base', '--is-ancestor', before, after));
  }
  return { historical_only: true, source_head: source.head };
}

function validateVolumeContract(handback, approval) {
  assert.equal(handback.purpose, 'ADR-027-current-ticket-volume');
  assert.equal(approval.schema, 'shipyard.phase47-current-source-approval.v1');
  assert.equal(approval.purpose, handback.purpose);
  assert.equal(approval.actor, 'trusted-coordinator');
  assert.equal(approval.native_receipt, false);
  assert.equal(approval.status, 'approved');
  assert.equal(approval.source_head, VOLUME_SOURCE);
  assert.equal(handback.source_head, VOLUME_SOURCE);
  assert.deepEqual(Object.keys(handback.corrective_allocation), ['T-47-23']);
  assert.deepEqual([...handback.corrective_allocation['T-47-23']].sort(), VOLUME_CORRECTIVE);
  assert.deepEqual([...handback.changed_outputs].sort(), VOLUME_CORRECTIVE);
  for (const key of ['successor_planner', 'current_checker', 'current_research', 'source_correction',
    'tail_plan_amendments', 'delivery_metadata_amendment', 'corrective_allocation', 'prior_final_handoff'])
    assert.deepEqual(approval[key], handback[key], 'volume approval drift: ' + key);
  assert.deepEqual(approval.tail_plan_amendments.map(row => row.sha256), [PLAN22_SHA, PLAN23_SHA]);
  const checker = approval.current_checker.verdict;
  assert.equal(checker.status, 'passed');
  assert.deepEqual(checker.blockers, []);
  assert.equal(checker.input_sha256[PHASE + '/47-22-PLAN.md'], PLAN22_SHA);
  assert.equal(checker.input_sha256[PHASE + '/47-23-PLAN.md'], PLAN23_SHA);
  assert.equal(approval.reviewed_source_config_sha256, '2eb2a0475127916c4c120d7616d13df1393d116c07b2a5f259cd6453234c65f9');
  assert.equal(approval.coordinator_config_sha256, '63a18625794b2772663567c95401ad91358daf13974f9c18117e0ce237256780');
}

function validateCurrentNative(result, role, childPath = null, currentRepair = false) {
  assert.equal(result.receipt.compliance, 'verified');
  assert.equal(result.receipt.runtime, 'codex');
  assert.equal(result.receipt.runtime_evidence.dispatch_id, result.receipt.dispatch_id);
  if (Object.hasOwn(result, 'dispatch_id')) assert.equal(result.dispatch_id, result.receipt.dispatch_id);
  if (role.startsWith('gsd-')) assert.equal(result.receipt.gsd_role, role);
  else assert.equal(result.receipt.role, role);
  const evidence = result.receipt.runtime_evidence;
  reference(evidence.transcript);
  const child = evidence.native_child_evidence;
  assert(child, 'genuine native child evidence required');
  if (role.startsWith('gsd-')) assert.equal(child.agent_role, role);
  const raw = childPath ? reference(childPath, true).toString()
    : read(path.join('/Users/serhii/.codex/sessions/2026/10/08',
      currentRepair ? (role === 'gsd-planner'
        ? 'rollout-2026-10-08T06-53-18-01a119a4-e321-7821-8aca-d3b24c7d1677.jsonl'
        : 'rollout-2026-10-08T04-55-25-01a11938-f689-75d0-b112-97f18b5d95ab.jsonl') : role === 'gsd-planner' ? 'rollout-2026-10-08T01-18-03-01a11871-f17d-79f2-a373-a4568376243a.jsonl'
        : 'rollout-2026-10-08T01-09-16-01a11869-e6f6-7d23-8cc0-72519234af8b.jsonl'), child.sha256).toString();
  require('../smoke/phase47-runtime-acceptance.cjs').validateInlineFirstCall(raw, child.task_relay, child);
  const records = raw.trim().split('\n').map(line => JSON.parse(line));
  const meta = records.find(row => row.type === 'session_meta')?.payload;
  assert.equal(meta?.id, child.session_id);
  assert.equal(meta?.parent_thread_id, child.parent_thread_id);
  assert.equal(meta?.agent_role, child.agent_role);
  return records;
}

function authenticateVolumeSuccessor(common, root = REPOSITORY, historical = false) {
  const handback = authenticateHandback(VOLUME_HANDOFF, VOLUME_HANDOFF_SHA);
  const approvalRef = handback.current_source_approval;
  assert.equal(approvalRef.path, path.join(path.dirname(VOLUME_HANDOFF), 'source-approval.json'));
  assert.equal(approvalRef.sha256, VOLUME_APPROVAL_SHA);
  assert.equal(approvalRef.signature_path, approvalRef.path + '.asc');
  const approval = authenticateHandback(approvalRef.path, VOLUME_APPROVAL_SHA);
  validateVolumeContract(handback, approval);
  const selected = selectedArtifact(common, handback, VOLUME_STAGE);
  selected.volume = true;
  const source = selected.binding.source;
  assert.equal(approval.source_tree, source.tree);
  assert.equal(approval.source_identity_sha256, handback.source_identity_sha256);
  assert.equal(approval.canonical_input_digest, selected.binding.canonical_input_digest);
  assert.deepEqual(approval.parent_commits, source.parent_commits);
  assert.deepEqual(approval.provenance, source.provenance);
  const prior = authenticateSuccessor(common, root, true);
  assert.equal(handback.prior_final_handoff.path, SUCCESSOR_HANDOFF);
  assert.equal(handback.prior_final_handoff.sha256, SUCCESSOR_HANDOFF_SHA);
  for (const key of ['generation_id', 'source_head', 'selection_path', 'selection_sha256', 'binding_path', 'binding_sha256'])
    assert.equal(handback.prior_final_handoff[key], prior.handback[key], 'T21 predecessor drift: ' + key);
  for (const key of ['original_handoff_path', 'original_handoff_sha256', 'original_source_head',
    'original_source_identity_sha256', 'original_index_sha256']) {
    assert.equal(handback[key], prior.handback[key]);
    assert.equal(approval[key], handback[key]);
  }
  assert.equal(handback.original_generation_id, prior.handback.original_generation_id);
  reference(handback.original_configuration_snapshot, true);
  assert.equal(handback.original_configuration_snapshot.sha256, approval.reviewed_source_config_sha256);
  assert.deepEqual(JSON.parse(reference(handback.original_ledger, true)), JSON.parse(git(root,
    'show', VOLUME_SOURCE + ':docs/audits/phase47-runtime-acceptance.json')));
  assert.equal(sha(reference(handback.prior_handoff_document, true)), sha(git(root,
    'show', VOLUME_SOURCE + ':docs/audits/phase47-runtime-handoff.md')));
  for (const ref of approval.tail_plan_amendments) reference(ref);
  const planner = JSON.parse(reference(approval.successor_planner));
  assert.equal(planner.status, 'completed');
  assert.equal(planner.receipt.dispatch_id, approval.successor_planner.dispatch_id);
  assert.deepEqual(planner.artifact_index, approval.successor_planner.artifact_index);
  validateCurrentNative(planner, 'gsd-planner');
  const index = JSON.parse(reference(planner.artifact_index));
  assert.equal(index.entries.length, 24);
  assert.equal(approval.successor_planner.historical_materialized_entries.length, 24);
  for (const entry of approval.successor_planner.historical_materialized_entries) {
    const indexed = index.entries.find(row => row.path === entry.path);
    assert(indexed, 'missing planner index entry');
    assert.equal(indexed.sha256, entry.sha256);
    assert.equal(indexed.bytes, entry.bytes);
    historical ? historicalVolumeEntry(planner.artifact_index, indexed, entry, approval.successor_planner)
      : reference({ ...entry, path: entry.physical_path });
  }
  const checkerRef = approval.current_checker, checker = JSON.parse(reference(checkerRef));
  assert.equal(checker.dispatch_id, checkerRef.dispatch_id);
  assert.deepEqual(checker.receipt.runtime_evidence.native_child_evidence, checkerRef.native_child_evidence);
  reference(checkerRef.transcript);
  assert.equal(checkerRef.native_child_transcript.sha256, checkerRef.native_child_evidence.sha256);
  const records = validateCurrentNative(checker, 'gsd-plan-checker', checkerRef.native_child_transcript);
  const mismatchedEvidence = structuredClone(checker);
  mismatchedEvidence.receipt.runtime_evidence.dispatch_id += '-foreign';
  assert.throws(() => validateCurrentNative(mismatchedEvidence, 'gsd-plan-checker',
    checkerRef.native_child_transcript), { code: 'ERR_ASSERTION' },
  'matching wrapper and receipt must not mask a foreign evidence dispatch');
  const absentWrapper = structuredClone(checker);
  delete absentWrapper.dispatch_id;
  assert.deepEqual(validateCurrentNative(absentWrapper, 'gsd-plan-checker',
    checkerRef.native_child_transcript), records);
  absentWrapper.receipt.runtime_evidence.dispatch_id += '-foreign';
  assert.throws(() => validateCurrentNative(absentWrapper, 'gsd-plan-checker',
    checkerRef.native_child_transcript), { code: 'ERR_ASSERTION' },
  'absent wrapper still requires the evidence dispatch to match the receipt');
  const mismatchedWrapper = structuredClone(checker);
  mismatchedWrapper.dispatch_id += '-foreign';
  assert.throws(() => validateCurrentNative(mismatchedWrapper, 'gsd-plan-checker',
    checkerRef.native_child_transcript), { code: 'ERR_ASSERTION' },
  'supplied wrapper dispatch must independently match the receipt');
  const completed = records.filter(row => row.type === 'event_msg' && row.payload?.type === 'task_complete');
  assert.equal(completed.length, 1);
  assert.deepEqual(JSON.parse(completed[0].payload.last_agent_message), checkerRef.verdict);
  assert.equal(checkerRef.verdict.input_sha256.TASK_FILE, checkerRef.native_child_evidence.task_relay.sha256);
  const research = JSON.parse(reference(approval.current_research));
  assert.equal(research.status, 'completed');
  validateCurrentNative(research, 'gsd-phase-researcher');
  const researchIndex = JSON.parse(reference(research.artifact_index));
  for (const entry of researchIndex.entries)
    historical ? historicalOriginalEntry({ path: VOLUME_HANDOFF, sha256: VOLUME_HANDOFF_SHA },
      approval.current_research, research.artifact_index, entry, entry) : reference(entry);
  for (const ref of approval.delivery_metadata_amendment.amendments) reference(ref, true);
  const preserved = JSON.parse(reference(approval.original19_plan_preservation));
  assert.equal(preserved.count, 19);
  assert.equal(preserved.files.length, 19);
  for (const entry of preserved.files) reference({ ...entry, path: path.join(source.repository, entry.path) });
  assert.equal(preserved.files.find(row => path.basename(row.path) === '47-19-PLAN.md').sha256, PLAN19_SHA);
  const correction = approval.source_correction;
  for (const key of ['executor', 'fixer', 'current_completion', 'current_cost_fixer']) {
    const result = JSON.parse(reference(correction[key]));
    assert.equal(result.ticket, 'T-47-22');
    assert.equal(result.receipt.compliance, 'verified');
    assert.equal(result.receipt.runtime, 'codex');
    assert.equal(result.receipt.role, ['executor', 'current_completion'].includes(key) ? 'executor' : 'ci-fix');
    assert.equal(result.receipt.dispatch_id, result.dispatch_id);
    reference(result.receipt.runtime_evidence.transcript);
    if (key === 'executor') assert.equal(result.status, 'verification_failed');
    if (key === 'current_completion') {
      assert.equal(result.artifact.schema, 'shipyard.codex-delivery-artifact.v1');
    }
  }
  reference(correction.current_cost_fixer.actual_prior_ci_cancellation);
  for (const key of ['historical_review_finalization', 'historical_initial_finalization', 'diagnostic', 'trusted_finalization'])
    reference(correction[key]);
  assert.deepEqual(correction.actual_merge, source.parent_commits['T-47-22']);
  assert.equal(source.parent_commits['T-47-22'].merge, VOLUME_SOURCE);
  const verificationRef = correction.trusted_finalization.verification;
  const envelope = JSON.parse(read(verificationRef.path));
  assert.equal(sha(canon(envelope)), verificationRef.digest);
  assert.equal(envelope.format, 'shipyard.host-authenticated.v1');
  const verification = hostVerification.readEvidence(verificationRef.path, verificationRef.digest);
  assert(verification, 'authenticated HOST verification payload required');
  assert.equal(verification.ticket, 'T-47-22');
  assert.equal(verification.plan_sha256, PLAN22_SHA);
  assert.equal(verification.results.length, 2);
  assert(verification.results.every(row => row.outcome === 'passed' && row.tree_before === source.tree && row.tree_after === source.tree));
  assert.deepEqual(verification, correction.host_verification);
  assert.deepEqual(selected.binding.outputs.map(row => row.path), prior.selected.binding.outputs.map(row => row.path));
  assert.equal(selected.binding.outputs.length, 161);
  const delta = selected.binding.outputs.filter(entry => sha(git(root, 'show', source.head + ':plugins/shipyard/' + entry.path)) !== entry.sha256
    || gitText(root, 'ls-tree', source.head, '--', 'plugins/shipyard/' + entry.path).split(' ')[0] !== entry.git_mode).map(row => row.path).sort();
  assert.deepEqual(delta, VOLUME_CORRECTIVE);
  const current = historical ? validateHistoricalSource(root, selected.binding, approval) : validateSource(root, selected.binding, approval);
  return { handback, selected, approval, prior, planning: prior.planning, current };
}

function recheckVolumeSuccessor(authenticated, root = REPOSITORY) {
  assert.deepEqual(authenticateVolumeSuccessor(authenticated.selected.binding.source.common, root), authenticated,
    'volume successor changed during inspection');
}

function recheckSuccessor(authenticated, root = REPOSITORY) {
  const refreshed = authenticateSuccessor(authenticated.selected.binding.source.common, root);
  assert.deepEqual(refreshed, authenticated, 'successor changed during inspection');
}

function recheckFinal(authenticated, root = REPOSITORY) {
  const { handback, selected, approval, original } = authenticated;
  read(FINAL_HANDOFF, FINAL_HANDOFF_SHA, true);
  reference(handback.current_source_approval, true);
  read(handback.current_source_approval.signature_path, undefined, true);
  selectedArtifact(selected.binding.source.common, handback, FINAL_STAGE);
  selectedArtifact(selected.binding.source.common, original);
  reference(handback.original_ledger, true);
  validateSource(root, selected.binding, approval);
}

function validateParents(source, state, getPullRequest, ancestor, final = false) {
  const parents = final ? Array.from({ length: source.parent_commits['T-47-26'] ? 26 : source.parent_commits['T-47-22'] ? 22 : source.parent_commits['T-47-20'] ? 20 : 18 }, (_, n) => 'T-47-' + String(n + 1).padStart(2, '0')) : ['T-47-13', 'T-47-03', 'T-47-04', 'T-47-09', 'T-47-15', 'T-47-14'];
  assert.deepEqual(Object.keys(source.parent_commits).sort(), [...parents].sort());
  assert.deepEqual(Object.keys(source.provenance).sort(), [...parents].sort());
  for (const id of parents) {
    const row = state[id], commit = source.parent_commits[id], provenance = source.provenance[id];
    assert(row && row.status === 'merged', 'parent is not a direct merged row: ' + id);
    assert(Number.isSafeInteger(row.pr) && row.pr > 0, 'missing real parent PR');
    assert.equal(row.pr, provenance.pr);
    assert.equal(row.merge_sha, commit.merge);
    assert.equal(row.base, provenance.base);
    assert.equal(row.url, provenance.url);
    assert.equal(sha(canon(row)), provenance.state_sha256, 'parent state/provenance mismatch');
    assert.equal(provenance.url, 'https://github.com/serhii-nochevnyi/shipyard/pull/' + row.pr);
    if (getPullRequest) {
      const pr = getPullRequest(row.pr);
      assert.equal(pr.number, row.pr);
      assert.equal(pr.state, 'MERGED');
      assert.equal(pr.headRefOid, commit.head, 'live parent head association mismatch');
      assert.equal(pr.mergeCommit.oid, commit.merge, 'live parent merge association mismatch');
      assert.equal(pr.baseRefName, provenance.base);
    }
    assert.match(commit.head, /^[a-f0-9]{40}$/);
    assert(Array.isArray(commit.base_merge_commits));
    for (const merged of [commit.merge, ...commit.base_merge_commits]) {
      assert.match(merged, /^[a-f0-9]{40}$/); ancestor(merged, source.head);
    }
  }
}

function validateDeliveryState(source, ancestor, final = false) {
  const state = JSON.parse(read(path.join(source.repository, '.planning/graph/delivery-state.json')));
  validateParents(source, state, null, ancestor, final);
}

function planOwners(bytes) {
  const text = bytes.toString();
  const owners = text.match(/^files_modified:\s*\n((?:[ \t]+- [^\n]+\n)+)/m);
  assert(owners, 'missing current PLAN ownership');
  return owners[1].split('\n').filter(Boolean).map(line => line.replace(/^\s*-\s*/, '').trim()).sort();
}

function validatePlanning(handback, source, historical = false) {
  const manifest = JSON.parse(read(handback.historical_manifest_path, source.plan_manifest_sha256, true));
  assert.equal(manifest.schema, 'shipyard.phase47-plan-snapshot.v1');
  assert.equal(manifest.phase, 47);
  assert.equal(manifest.original_index_sha256, source.plan_index_sha256);
  assert.equal(manifest.policy_hash, source.policy_sha256);
  const index = JSON.parse(read(manifest.original_index_path, source.plan_index_sha256));
  read(manifest.original_index_copy, source.plan_index_sha256, true);
  const originalResult = JSON.parse(read(manifest.original_result_path, manifest.original_result_sha256));
  assert.equal(originalResult.schema, 'shipyard.decomposition-result.v1');
  assert.equal(originalResult.status, 'completed', 'missing original completed planning result');
  assert.equal(originalResult.repository, manifest.repository);
  assert.equal(originalResult.source_revision, manifest.source_revision);
  assert.equal(originalResult.policy_hash, manifest.policy_hash);
  assert.equal(originalResult.receipt.dispatch_id, manifest.planner_dispatch);
  assert.equal(originalResult.receipt.runtime, 'codex');
  assert.equal(originalResult.receipt.role, 'decomposition');
  assert.equal(originalResult.artifact_index.path, manifest.original_index_path);
  assert.equal(originalResult.artifact_index.sha256, source.plan_index_sha256);
  assert.equal(originalResult.plan_count, 16);
  const names = Array.from({ length: 15 }, (_, n) => '47-' + String(n + 1).padStart(2, '0') + '-PLAN.md').concat('CONTEXT.md').sort();
  assert.equal(manifest.entries.length, 16);
  assert.equal(index.entries.length, 16);
  assert.deepEqual(manifest.entries.map(entry => path.basename(entry.path)).sort(), names);
  for (const entry of manifest.entries) {
    assert.equal(entry.physical_path, path.join(manifest.root, path.basename(entry.path)));
    assert.equal(read(entry.physical_path, entry.sha256, true).length, entry.bytes);
    const original = index.entries.find(row => row.path === entry.original_path);
    assert(original, 'snapshot is missing original index membership');
    assert.equal(original.sha256, entry.sha256);
    assert.equal(original.bytes, entry.bytes);
  }
  const nativeOwners = ['47-14-PLAN.md', '47-15-PLAN.md'].map(name =>
    planOwners(read(path.join(manifest.root, name))));
  assert.deepEqual(nativeOwners.map(owners => owners.length), [13, 3], 'original native ownership drift');
  assert.equal(new Set(nativeOwners.flat()).size, 16);
  const capturedPath = path.join(path.dirname(HANDOFF), 'captured-coordinator-47-05-PLAN.md');
  const captured = read(capturedPath, source.current_plan_amendments[0].sha256, true);
  const current = historical ? captured : read(source.current_plan_amendments[0].path);
  assert.deepEqual(planOwners(current), planOwners(captured), 'later handback reference changed owners');
  if (!historical) assert.equal(sha(current), '70e5ce04dd05e5bba28ebdec7d0dc833fc158a7b844b1f7d58b26f782b2849cf', 'unreviewed current coordinator amendment');
  assert.deepEqual(planOwners(captured), ['tests/unit/phase47-package-publication.test.cjs',
    ...ALLOCATION['T-47-05'].map(relative => 'plugins/shipyard/' + relative)].sort());
  const successor = read(source.current_plan_amendments[1].path, source.current_plan_amendments[1].sha256);
  assert.deepEqual(planOwners(successor), ALLOCATION['T-47-11'].map(relative => 'plugins/shipyard/' + relative).sort());
  return { manifest_sha256: source.plan_manifest_sha256, index_sha256: source.plan_index_sha256,
    captured_plan_sha256: sha(captured), current_plan_sha256: sha(current), historical_only: historical,
    original_result_path: manifest.original_result_path, original_result_sha256: manifest.original_result_sha256,
    original_dispatch_id: originalResult.receipt.dispatch_id };
}

function validateSource(root, binding, approval = null) {
  const source = binding.source;
  const ancestor = (before, after) => git(root, 'merge-base', '--is-ancestor', before, after);
  ancestor(BASELINE, source.head); ancestor(source.head, 'HEAD');
  assert.equal(gitText(root, 'rev-parse', source.head + '^{tree}'), source.tree);
  assert.equal(gitText(source.repository, 'rev-parse', '--path-format=absolute', '--git-common-dir'), source.common);
  const inputs = canonicalInputs(root);
  assert.deepEqual(inputs, source.identities, 'canonical source drift');
  assert.equal(sha(canon(inputs)), binding.canonical_input_digest);
  assert.deepEqual(inputs.map(entry => ({ path: entry.path, mode: physical(path.join(root, entry.path)).mode & 0o777 })), source.input_modes);
  for (const entry of inputs) {
    assert.equal(sha(git(root, 'show', source.head + ':' + entry.path)), entry.sha256, 'unreviewed canonical input');
    const mode = gitText(root, 'ls-files', '--stage', '--', entry.path).split(' ')[0];
    assert.equal(mode, source.input_modes.find(row => row.path === entry.path).mode === 0o755 ? '100755' : '100644');
  }
  assert.deepEqual(source.dirty, []);
  assert.equal(source.status_sha256, sha(''));
  assert.equal(source.diff_sha256, sha(''));
  assert.equal(source.index_sha256, sha(git(root, 'ls-tree', '-r', source.head).toString().split('\n').filter(Boolean)
    .map(line => line.replace(/^(\d+) blob ([a-f0-9]+)\t/, '$1 $2 0\t') + '\0').join('')));
  validateConfigurations(root, source, approval);
  if (approval) {
    validateDescendant(root, source);
    const canonicalRef = 'refs/heads/' + source.provenance['T-47-18'].base;
    validateDescendant(root, source, canonicalRef);
    assert.equal(sha(git(root, 'show', canonicalRef + ':.planning/config.json')),
      approval.reviewed_source_config_sha256, 'canonical reviewed configuration drift');
  }
  assert.equal(require(path.join(root, 'plugins/delivery-pipeline/scripts/model-policy.cjs'))
    .resolveDispatch({ runtime: 'codex', role: 'research' }).policy_hash, source.policy_sha256, 'policy drift');
  const graph = JSON.parse(read(path.join(source.repository, '.planning/graph/tickets.json'), source.graph_sha256));
  for (const [id, row] of Object.entries(graph.tickets)) {
    if (!id.startsWith('T-47-')) continue;
    for (const dep of [...(row.depends_on || []), ...(row.cross_phase_deps || [])])
      assert(!/^T-48-/.test(dep), 'phase48 dependency in bound canonical graph');
  }
  const commits = gitText(root, 'log', '--format=%s', BASELINE + '..' + source.head);
  assert(!/^T-48-/m.test(commits), 'phase48 changes in selected source ancestry');
  validateDeliveryState(source, ancestor, Boolean(approval));
  return { head: gitText(root, 'rev-parse', 'HEAD'), tree: gitText(root, 'rev-parse', 'HEAD^{tree}'),
    canonical_input_digest: binding.canonical_input_digest, source_ancestor: true };
}

function validatePublication(root, selected, group) {
  const { binding, selection } = selected;
  const published = path.join(root, 'plugins/shipyard');
  const observed = inventory(published);
  const outputs = new Map(binding.outputs.map(entry => [entry.path, entry]));
  const final = selected.t16 === true || selected.repair === true || selected.final === true || selected.successor === true || selected.volume === true;
  const permitted = selected.t16 ? binding.changed_outputs : selected.repair ? (selected.followup ? F1_CORRECTIVE : REPAIR_CORRECTIVE) : selected.volume ? VOLUME_CORRECTIVE : selected.successor ? SUCCESSOR_CORRECTIVE : final ? CORRECTIVE : UNION;
  const required = final && ['relay', 'complete'].includes(group)
    ? binding.outputs.map(entry => entry.path).filter(relative => group === 'complete'
      || !['.codex-plugin/plugin.json', 'package-build.json'].includes(relative)) : GROUPS[group];
  for (const entry of observed) {
    const expected = outputs.get(entry.path);
    assert(expected, 'unexpected checked-in package path: ' + entry.path);
    if (entry.sha256 !== expected.sha256 || entry.mode !== expected.publication_mode) {
      assert(permitted.includes(entry.path), 'unexpected publication delta: ' + entry.path);
      if (selected.repair || selected.t16) {
        assert.equal(entry.sha256, sha(git(root, 'show', binding.source.head + ':plugins/shipyard/' + entry.path)),
          'partial current publication must retain exact pre-T27 bytes');
        const baselineMode = gitText(root, 'ls-tree', binding.source.head, '--', 'plugins/shipyard/' + entry.path).split(' ')[0];
        assert.equal(entry.mode, baselineMode === '100755' ? 0o755 : 0o644,
          'partial current publication mode drift');
      }
    }
    const indexMode = gitText(root, 'ls-files', '--stage', '--', 'plugins/shipyard/' + entry.path).split(' ')[0];
    if (!indexMode) assert.equal(entry.path, mirror('codex-arch-review-context'), 'unreviewed new package path');
    else assert.equal(indexMode, expected.git_mode, 'package git index mode drift');
  }
  for (const output of binding.outputs)
    if (!observed.some(entry => entry.path === output.path)) {
      assert(!selected.repair && !selected.t16, 'missing current package inventory member');
      assert.equal(output.path, mirror('codex-arch-review-context'), 'unexpected missing package path');
    }
  for (const relative of required) {
    const expected = outputs.get(relative);
    assert(expected, 'missing publication ledger member');
    const file = path.join(published, relative);
    read(file, expected.sha256);
    assert.equal(physical(file).mode & 0o777, expected.publication_mode, 'publication mode mismatch');
    const indexMode = gitText(root, 'ls-files', '--stage', '--', 'plugins/shipyard/' + relative).split(' ')[0];
    if (!indexMode) {
      assert.equal(relative, mirror('codex-arch-review-context'), 'missing publication git index mode');
      assert.equal(gitText(root, 'ls-files', '--stage', '--', relative.slice(5)).split(' ')[0], expected.git_mode,
        'new collector lacks reviewed canonical git mode');
    } else assert.equal(indexMode, expected.git_mode, 'git index mode mismatch');
    if (relative.startsWith('host/')) read(path.join(root, relative.slice(5)), expected.sha256);
    read(path.join(selection.candidate_path, relative), expected.sha256, true);
  }
  return required.length;
}

function stageContracts(selected) {
  const stage = selected.selection.candidate_path;
  const packageRoot = path.join(stage, 'host/plugins/delivery-pipeline');
  const fixtureHome = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-p47-contracts-')));
  const preload = path.join(fixtureHome, 'stage-preload.cjs');
  fs.writeFileSync(preload, `const Module=require('node:module'),path=require('node:path');
    require('node:os').homedir=()=>${JSON.stringify(fixtureHome)};
    const original=Module._resolveFilename,canonical=${JSON.stringify(path.join(REPOSITORY, 'plugins/delivery-pipeline'))},stage=${JSON.stringify(packageRoot)};
    Module._resolveFilename=function(request,parent,...rest){const resolved=original.call(this,request,parent,...rest);
      return resolved.startsWith(canonical+path.sep)?stage+resolved.slice(canonical.length):resolved;};
    const fs=require('node:fs'),copy=fs.cpSync;
    fs.cpSync=function(source,destination,...rest){const result=copy.call(this,source,destination,...rest);
      if(String(source)===stage){const target=fs.realpathSync(destination);
        require('node:assert/strict').ok(target.startsWith(fs.realpathSync(require('node:os').tmpdir())+path.sep));
        const restore=file=>{const stat=fs.lstatSync(file);fs.chmodSync(file,(stat.mode&0o777)|0o200);
          if(stat.isDirectory())for(const name of fs.readdirSync(file))restore(path.join(file,name));};restore(target);}
      return result;};`);
  const env = { ...process.env, SHIPYARD_TEST_PACKAGE_ROOT: packageRoot, NODE_OPTIONS: '--require=' + preload };
  delete env.SHIPYARD_GRAPH_DIR;
  try {
    const launch = spawnSync(process.execPath, [path.join(__dirname, 'phase47-launch-contract.test.cjs')], {
      encoding: 'utf8', env, timeout: 600000, maxBuffer: 16 * 1024 * 1024,
    });
    assert.equal(launch.status, 0, 'stage-bound launch contract failed:\n' + launch.stdout + launch.stderr);
    const script = `const fs=require('node:fs'),Module=require('node:module');
      const filename=${JSON.stringify(path.join(__dirname, 'codex-arch-review-context.test.cjs'))};
      const source=fs.readFileSync(filename,'utf8').replaceAll('../../plugins/delivery-pipeline',${JSON.stringify(packageRoot)});
      const main=new Module(filename);main.filename=filename;main.paths=Module._nodeModulePaths(${JSON.stringify(__dirname)});
      main._compile(source,filename);main.exports.registerTests(require('node:test'));`;
    const architecture = spawnSync(process.execPath, ['-e', script], {
      encoding: 'utf8', env, timeout: 600000, maxBuffer: 16 * 1024 * 1024,
    });
    assert.equal(architecture.status, 0, 'staged collector/shared consumer contract failed:\n' + architecture.stdout + architecture.stderr);
    for (const names of [['deliver-dispatch', 'codex-decompose-host'], ['codex-decompose-host', 'deliver-dispatch']]) {
      const result = spawnSync(process.execPath, ['-e', `const root=${JSON.stringify(packageRoot)};
        for(const name of ${JSON.stringify(names)})require(root+'/scripts/'+name+'.cjs');
        const delivery=require(root+'/scripts/deliver-dispatch.cjs');
        require('node:assert/strict').equal(typeof delivery.dispatchStateDir,'function');`], {
        encoding: 'utf8', env, timeout: 10000,
      });
      assert.equal(result.status, 0, 'staged public load order failed: ' + result.stderr);
    }
    const detachedScript = `const fs=require('node:fs'),Module=require('node:module');
      const filename=${JSON.stringify(path.join(__dirname, 'codex-decompose-host.test.cjs'))};
      const source=fs.readFileSync(filename,'utf8').replaceAll('../../plugins/delivery-pipeline',${JSON.stringify(packageRoot)});
      const main=new Module(filename);main.filename=filename;main.paths=Module._nodeModulePaths(${JSON.stringify(__dirname)});
      process.mainModule=main;main._compile(source,filename);`;
    const detached = spawnSync(process.execPath, ['--test-name-pattern', '^fresh public .* detached CLI', '-e', detachedScript], {
      encoding: 'utf8', env, timeout: 600000, maxBuffer: 16 * 1024 * 1024,
    });
    assert.equal(detached.status, 0, 'staged public detached CLI contract failed:\n' + detached.stdout + detached.stderr);
    assert.match(detached.stdout, /tests 2\b/, 'both public detached contracts must execute');
    const evidence = result => ({ stdout_sha256: sha(result.stdout), stderr_sha256: sha(result.stderr),
      exit_code: result.status, tests: Number(result.stdout.match(/(?:# |ℹ )tests (\d+)/)?.[1]),
      passed: Number(result.stdout.match(/(?:# |ℹ )pass (\d+)/)?.[1]) });
    return { launch: evidence(launch), architecture: evidence(architecture),
      detached: evidence(detached), public_load_orders: 2 };
  } finally { fs.rmSync(fixtureHome, { recursive: true, force: true }); }
}

function check(group) {
  assert(Object.hasOwn(GROUPS, group), 'unknown publication group');
  const common = gitText(REPOSITORY, 'rev-parse', '--path-format=absolute', '--git-common-dir');
  const authenticated = authenticateT16Successor(common);
  const { handback, selected, current, planning } = authenticated;
  const count = validatePublication(REPOSITORY, selected, group);
  const contracts = group === 'candidate' ? null : stageContracts(selected);
  recheckT16Successor(authenticated);
  validatePublication(REPOSITORY, selected, group);
  return { status: 'completed', ticket: 'T-47-27', group, generation_kind: 't16-source-repair', generation_id: null,
    source_head: selected.binding.source.head, source_identity_sha256: null,
    current_admission: current, handback_path: R8_STAGE + "/generation.json", handback_sha256: R8_HANDOFF_SHA,
    selection_path: selected.selectionPath, selection_sha256: handback.selection_sha256,
    binding_path: selected.selection.binding_path, binding_sha256: selected.selection.binding_sha256,
    candidate_path: selected.selection.candidate_path, candidate_sha256: null,
    package_sha256: selected.binding.package_sha256, version: selected.binding.version,
    output_count: selected.binding.outputs.length, publication_count: count, build_calls: 0, planning,
    corrective_outputs: R8_CORRECTIVE, historical_successor_output_count: SUCCESSOR_CORRECTIVE.length, historical_corrective_output_count: CORRECTIVE.length, original_output_count: UNION.length, original_native_owner_count: 16,
    contracts, covered_groups: group === 'complete' ? Object.keys(GROUPS) : [group],
    successor_corrective_output_count: F1_CORRECTIVE.length, inspector_build_calls: 0,
    remaining_obligations: ['current exact HOST verification', 'T-47-08 installed/native acceptance',
      'post-delivery aggregate architecture and integrator judgments'] };
}

function privateFixtures(authenticatedSignatureFixture = false) {
  const temporary = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-p47-publication-')));
  const root = path.join(temporary, 'repo');
  const write = (relative, bytes, mode = 0o644) => {
    const file = path.join(root, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, bytes); fs.chmodSync(file, mode); return file;
  };
  let cases = 0;
  const rejects = (name, action) => { assert.throws(action, undefined, name); cases++; };
  try {
    const evidenceDirectory = path.join(temporary, 'host-evidence');
    fs.mkdirSync(evidenceDirectory, { mode: 0o700 });
    const evidencePath = path.join(evidenceDirectory, 'verification.json');
    const keyPath = path.join(evidenceDirectory, 'hmac.key');
    const fixtureKey = crypto.randomBytes(32);
    fs.writeFileSync(keyPath, fixtureKey, { mode: 0o600 });
    for (const ticket of ['T-47-18', 'T-47-20']) {
      const payload = { schema: 'shipyard.host-verification.v1', ticket,
        plan_sha256: sha(ticket), results: [{ outcome: 'passed' }] };
      const envelope = { format: 'shipyard.host-authenticated.v1', payload,
        integrity: { algorithm: 'hmac-sha256', mac: crypto.createHmac('sha256', fixtureKey)
          .update(canon(payload)).digest('hex') } };
      const admit = (value = envelope) => {
        fs.writeFileSync(evidencePath, JSON.stringify(value), { mode: 0o600 });
        const authenticated = hostVerification.readEvidence(evidencePath, sha(canon(value)));
        assert(authenticated, 'authenticated HOST verification payload required');
        assert.deepEqual(authenticated, payload);
      };
      admit(); cases++;
      rejects(ticket + ' invalid MAC with recomputed public digest', () => admit({ ...envelope,
        integrity: { ...envelope.integrity, mac: '0'.repeat(64) } }));
      rejects(ticket + ' tampered payload with recomputed public digest', () => admit({ ...envelope,
        payload: { ...payload, ticket: 'foreign' } }));
      const malformed = { ...payload, schema: 'foreign' };
      rejects(ticket + ' authenticated wrong schema', () => admit({ ...envelope, payload: malformed,
        integrity: { algorithm: 'hmac-sha256', mac: crypto.createHmac('sha256', fixtureKey)
          .update(canon(malformed)).digest('hex') } }));
      fs.writeFileSync(keyPath, crypto.randomBytes(32));
      rejects(ticket + ' wrong key', () => admit());
      fs.writeFileSync(keyPath, fixtureKey);
      fs.chmodSync(keyPath, 0o644);
      rejects(ticket + ' public key permissions', () => admit());
      fs.chmodSync(keyPath, 0o600);
      fs.chmodSync(evidencePath, 0o644);
      rejects(ticket + ' public evidence permissions', () => admit());
      fs.chmodSync(evidencePath, 0o600);
      admit(); cases++;
    }
    const successorFixture = {
      purpose: 'ADR-027-current-ticket-evidence', source_head: SUCCESSOR_SOURCE,
      changed_outputs: SUCCESSOR_CORRECTIVE, corrective_allocation: { 'T-47-21': SUCCESSOR_CORRECTIVE },
      tail_plan_amendments: [{ sha256: 'd4f25b6a0668eb2848b73dc0738f6c166883a232aa607142b5b9d066537bc9c6' }, { sha256: PLAN21_SHA }],
      current_checker: { verdict: { status: 'passed', blockers: [], input_sha256: {
        plan20: 'd4f25b6a0668eb2848b73dc0738f6c166883a232aa607142b5b9d066537bc9c6', plan21: PLAN21_SHA } } },
    };
    const successorApproval = { ...successorFixture, schema: 'shipyard.phase47-current-source-approval.v1',
      status: 'approved', actor: 'trusted-coordinator', native_receipt: false };
    validateSuccessorContract(successorFixture, successorApproval); cases++;
    for (const mutation of [{ purpose: 'ADR-026-final' }, { source_head: FINAL_SOURCE },
      { actor: 'foreign' }, { native_receipt: true }, { status: 'pending' },
      { corrective_allocation: { 'T-47-21': CORRECTIVE } },
      { tail_plan_amendments: [{ sha256: PLAN19_SHA }, { sha256: PLAN19_SHA }] }])
      rejects('successor refuses stale or expanded authority', () =>
        validateSuccessorContract(successorFixture, { ...successorApproval, ...mutation }));
    const volumeFixture = { purpose: 'ADR-027-current-ticket-volume', source_head: VOLUME_SOURCE,
      changed_outputs: VOLUME_CORRECTIVE, corrective_allocation: { 'T-47-23': VOLUME_CORRECTIVE },
      tail_plan_amendments: [{ sha256: PLAN22_SHA }, { sha256: PLAN23_SHA }],
      current_checker: { verdict: { status: 'passed', blockers: [], input_sha256: {
        [PHASE + '/47-22-PLAN.md']: PLAN22_SHA, [PHASE + '/47-23-PLAN.md']: PLAN23_SHA } } } };
    const volumeApproval = { ...volumeFixture, schema: 'shipyard.phase47-current-source-approval.v1',
      status: 'approved', actor: 'trusted-coordinator', native_receipt: false,
      reviewed_source_config_sha256: '2eb2a0475127916c4c120d7616d13df1393d116c07b2a5f259cd6453234c65f9',
      coordinator_config_sha256: '63a18625794b2772663567c95401ad91358daf13974f9c18117e0ce237256780' };
    validateVolumeContract(volumeFixture, volumeApproval); cases++;
    for (const mutation of [{ purpose: successorFixture.purpose }, { source_head: SUCCESSOR_SOURCE },
      { actor: 'foreign' }, { native_receipt: true }, { status: 'pending' },
      { corrective_allocation: { 'T-47-23': SUCCESSOR_CORRECTIVE } },
      { tail_plan_amendments: [{ sha256: PLAN21_SHA }, { sha256: PLAN21_SHA }] },
      { reviewed_source_config_sha256: volumeApproval.coordinator_config_sha256 },
      { coordinator_config_sha256: volumeApproval.reviewed_source_config_sha256 },
      { prior_final_handoff: { path: FINAL_HANDOFF } }, { source_correction: {} },
      { current_checker: { verdict: { status: 'pending' } } }])
      rejects('volume successor refuses moved or expanded authority', () =>
        validateVolumeContract(volumeFixture, { ...volumeApproval, ...mutation }));
    rejects('volume handback expanded output allocation', () => validateVolumeContract({ ...volumeFixture,
      changed_outputs: SUCCESSOR_CORRECTIVE }, volumeApproval));
    const repairFixture = { purpose: 'ADR-027-main-review-repair', source_head: 'a'.repeat(40),
      changed_outputs: REPAIR_CORRECTIVE, corrective_allocation: { 'T-47-27': REPAIR_CORRECTIVE },
      tail_plan_amendments: REPAIR_PLANS.map(sha256 => ({ sha256 })),
      prior_final_handoff: { path: VOLUME_HANDOFF, sha256: VOLUME_HANDOFF_SHA },
      source_correction: { strict_configuration_identity: { source39: SOURCE39_SHA,
        coordinator48: COORDINATOR48_SHA, historical43: HISTORICAL43_SHA },
      command_approval: { path: '/tmp/phase47-main-review-exact-command-approval.json',
        sha256: '2e7bd51c86d5eff1d65fe09fcf3d366cd27d5dd98eea86a7af0689ae2009696e' } },
      current_checker: { verdict: { status: 'passed', blockers: [], artifact_paths: [], input_sha256:
        Object.fromEntries(REPAIR_PLANS.map((digest, i) => [PHASE + '/47-' + (24 + i) + '-PLAN.md', digest])) } } };
    const repairApproval = { ...repairFixture, schema: 'shipyard.phase47-current-source-approval.v1',
      status: 'approved', actor: 'trusted-coordinator', native_receipt: false,
      reviewed_source_config_sha256: SOURCE39_SHA, coordinator_config_sha256: COORDINATOR48_SHA };
    validateRepairContract(repairFixture, repairApproval); cases++;
    for (const mutation of [{ purpose: 'ADR-027-current-ticket-volume' }, { source_head: VOLUME_SOURCE },
      { actor: 'foreign' }, { native_receipt: true }, { status: 'pending' },
      { corrective_allocation: { 'T-47-27': VOLUME_CORRECTIVE } },
      { reviewed_source_config_sha256: COORDINATOR48_SHA }, { coordinator_config_sha256: SOURCE39_SHA },
      { coordinator_config_sha256: HISTORICAL43_SHA }, { prior_final_handoff: { path: SUCCESSOR_HANDOFF } },
      { current_checker: { verdict: { status: 'blocked', blockers: [] } } },
      { tail_plan_amendments: REPAIR_PLANS.slice().reverse().map(sha256 => ({ sha256 })) }])
      rejects('main-review-repair refuses stale, foreign or expanded authority', () =>
        validateRepairContract(repairFixture, { ...repairApproval, ...mutation }));
    rejects('main-review-repair refuses expanded stage delta', () => validateRepairContract({ ...repairFixture,
      changed_outputs: [...REPAIR_CORRECTIVE, mirror('lock')] }, repairApproval));
    const currentUpdate = { commit: '8192ba38942be328b27f8aa54984eae7cd47231c',
      parent: '72f033c994053654d5025e128081ee37be0e04b7',
      canonical_path: 'plugins/delivery-pipeline/scripts/architecture-target.cjs',
      added_generated_owner: 'plugins/shipyard/' + mirror('architecture-target'),
      current19_plan_sha256: 'd12c3b870fda04f0dc1f2f6afcebedbfad619f8961662ac253ad2abd45d781e8',
      current_owner_count: 15, current_corrective_outputs: 9, task_sizes: [3, 5, 3, 4] };
    validateSourceUpdate(currentUpdate); cases++;
    for (const mutation of [{ commit: 'f'.repeat(40) }, { parent: 'f'.repeat(40) },
      { canonical_path: 'foreign' }, { added_generated_owner: 'foreign' },
      { current_owner_count: 14 }, { current_corrective_outputs: 8 }, { task_sizes: [3, 5, 2, 4] }])
      rejects('current source update refuses contract drift', () => validateSourceUpdate({ ...currentUpdate, ...mutation }));
    fs.mkdirSync(root);
    git(root, 'init', '-q', '-b', 'main');
    git(root, 'config', 'user.name', 'Publication Fixture');
    git(root, 'config', 'user.email', 'publication@example.invalid');
    git(root, 'config', 'commit.gpgsign', 'false');
    write('scripts/package-shipyard-codex.cjs', read(path.join(REPOSITORY, 'scripts/package-shipyard-codex.cjs')));
    for (const script of SCRIPTS) write('scripts/' + script, '// private fixture\n');
    write('plugins/delivery-pipeline/.claude-plugin/plugin.json', JSON.stringify({
      name: 'shipyard', version: '0.71.0', description: 'Private publication fixture', author: { name: 'Fixture' },
    }));
    for (const name of ['route', 'investigate', 'decompose', 'deliver', 'bench'])
      write('plugins/delivery-pipeline/commands/' + name + '.md', '---\ndescription: private fixture\n---\n');
    write('plugins/delivery-pipeline/skills/delivery-rules/SKILL.md', 'description: private fixture\n');
    write('capabilities/delivery-pipeline/capability.json', '{}\n');
    for (const relative of UNION.filter(relative => relative.startsWith('host/plugins/')))
      if (!fs.existsSync(path.join(root, relative.slice(5))))
        write(relative.slice(5), '// private fixture\n', relative === mirror('codex-decompose-host') ? 0o755 : 0o644);
    write('.planning/config.json', '{"reviewed":true}\n');
    git(root, 'add', '.'); git(root, 'commit', '-qm', 'private reviewed inputs');
    const common = gitText(root, 'rev-parse', '--path-format=absolute', '--git-common-dir');
    const inputs = canonicalInputs(root), generation = sha(canon(inputs));
    const durable = path.join(common, STAGE_DIRECTORY), generationRoot = path.join(durable, generation);
    const candidate = path.join(generationRoot, 'candidate');
    const bindingPath = path.join(generationRoot, 'binding.json'), selectionPath = path.join(durable, 'selection.json');
    fs.mkdirSync(generationRoot, { recursive: true, mode: 0o700 }); fs.chmodSync(durable, 0o700);
    const buildCalls = 0;
    const builder = require(path.join(root, 'scripts/package-shipyard-codex.cjs'));
    for (const input of inputs.filter(row => row.path !== 'scripts/package-shipyard-codex.cjs')) {
      const target = path.join(candidate, 'host', input.path);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, read(path.join(root, input.path)));
      fs.chmodSync(target, physical(path.join(root, input.path)).mode & 0o777);
    }
    fs.mkdirSync(path.join(candidate, 'hooks'));
    fs.writeFileSync(path.join(candidate, 'hooks/hooks.json'), '{}\n');
    const fixtureContent = crypto.createHash('sha256');
    for (const entry of inventory(candidate)) {
      fixtureContent.update(entry.path + '\0'); fixtureContent.update(read(path.join(candidate, entry.path)));
    }
    const fixtureDigest = fixtureContent.digest('hex');
    const fixtureManifest = Buffer.from(JSON.stringify({ version: '0.71.0+codex.' + fixtureDigest.slice(0, 16) }));
    fs.mkdirSync(path.join(candidate, '.codex-plugin'));
    fs.writeFileSync(path.join(candidate, '.codex-plugin/plugin.json'), fixtureManifest);
    fs.writeFileSync(path.join(candidate, 'package-build.json'), JSON.stringify({
      version: JSON.parse(fixtureManifest).version, digest: sha(Buffer.concat([Buffer.from(fixtureDigest + '\0'), fixtureManifest])) }));
    const source = { head: gitText(root, 'rev-parse', 'HEAD'), common,
      identities: inputs, input_modes: inputs.map(entry => ({ path: entry.path,
        mode: physical(path.join(root, entry.path)).mode & 0o777 })),
      canonical_input_digest: generation, publication_allocation: ALLOCATION,
      plan_index_sha256: sha('private index'), plan_manifest_sha256: sha('private manifest'),
      current_plan_amendments: [] };
    const outputs = inventory(candidate).map(entry => {
      const publication = entry.mode === 0o755 ? 0o755 : 0o644;
      return { path: entry.path, sha256: entry.sha256, bytes: entry.bytes,
        git_mode: publication === 0o755 ? '100755' : '100644', publication_mode: publication,
        sealed_mode: publication & ~0o222 };
    });
    const contentHash = crypto.createHash('sha256');
    for (const entry of outputs) {
      if (['.codex-plugin/plugin.json', 'package-build.json'].includes(entry.path)) continue;
      contentHash.update(entry.path + '\0'); contentHash.update(read(path.join(candidate, entry.path)));
    }
    const build = JSON.parse(read(path.join(candidate, 'package-build.json')));
    const binding = { generation_id: generation, canonical_input_digest: generation, source, outputs,
      source_content_sha256: contentHash.digest('hex'), package_sha256: build.digest, version: build.version };
    fs.writeFileSync(bindingPath, JSON.stringify(binding), { flag: 'wx', mode: 0o400 });
    const selection = { generation_id: generation, candidate_path: candidate, binding_path: bindingPath,
      binding_sha256: sha(read(bindingPath)), candidate_sha256: sha(canon(outputs)) };
    fs.writeFileSync(selectionPath, JSON.stringify(selection), { flag: 'wx', mode: 0o400 });
    const sealDirectories = directory => {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true }))
        if (entry.isDirectory()) sealDirectories(path.join(directory, entry.name));
      fs.chmodSync(directory, 0o500);
    };
    for (const output of outputs) fs.chmodSync(path.join(candidate, output.path), output.sealed_mode);
    sealDirectories(candidate); fs.chmodSync(generationRoot, 0o500);
    const handback = { schema: 'shipyard.phase47-coordinator-generation.v1', actor: 'trusted-coordinator',
      operation: 'generate', status: 'completed', native_receipt: false, command_sha256: sha('private build'),
      ...selection, selection_path: selectionPath, selection_sha256: sha(read(selectionPath)),
      source_head: source.head, source_identity_sha256: sha(canon(source)),
      original_index_sha256: source.plan_index_sha256, historical_manifest_sha256: source.plan_manifest_sha256,
      current_plan_amendments: [], publication_allocation: ALLOCATION, changed_outputs: UNION };
    const consume = () => {
      const methods = ['writeFileSync', 'appendFileSync', 'mkdirSync', 'chmodSync', 'renameSync', 'unlinkSync', 'rmSync', 'cpSync'];
      const original = new Map(methods.map(name => [name, fs[name]]));
      for (const name of methods) fs[name] = () => { throw new Error('inspection attempted write: ' + name); };
      try { return selectedArtifact(common, handback); }
      finally { for (const [name, method] of original) fs[name] = method; }
    };
    consume(); cases++;
    const buildsBefore = buildCalls;
    git(root, '-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-qm', 'private mechanical descendant');
    git(root, 'merge-base', '--is-ancestor', source.head, 'HEAD');
    const reused = consume();
    assert.equal(buildCalls - buildsBefore, 0);
    assert.equal(reused.binding.source.head, source.head);
    assert.notEqual(source.head, gitText(root, 'rev-parse', 'HEAD'));
    assert.equal(sha(canon(reused.binding.source)), handback.source_identity_sha256); cases++;
    rejects('missing preparation', () => selectedArtifact(path.join(temporary, 'missing-common'), handback));
    for (const changed of [{ status: 'pending' }, { native_receipt: true }, { source_head: 'f'.repeat(40) },
      { source_identity_sha256: sha('foreign') }, { candidate_sha256: sha('foreign') },
      { selection_path: path.join(temporary, 'moved-selection.json') }])
      rejects('handback mismatch', () => selectedArtifact(common, { ...handback, ...changed }));
    rejects('unexpected owner path', () => validateAllocation({ ...ALLOCATION,
      'T-47-11': [...ALLOCATION['T-47-11'], 'host/alternate-module.cjs'] }));
    const originalSelection = read(selectionPath);
    const hiddenSelection = path.join(temporary, 'original-selection.json');
    fs.renameSync(selectionPath, hiddenSelection);
    rejects('missing selection', consume);
    fs.symlinkSync(hiddenSelection, selectionPath); rejects('symlinked selection', consume);
    fs.unlinkSync(selectionPath); fs.renameSync(hiddenSelection, selectionPath);
    const unselected = path.join(durable, 'f'.repeat(64)); fs.mkdirSync(unselected);
    rejects('unselected existing generation', consume); fs.rmdirSync(unselected);
    fs.chmodSync(selectionPath, 0o600);
    fs.writeFileSync(selectionPath, JSON.stringify({ ...selection, candidate_path: './candidate' }));
    fs.chmodSync(selectionPath, 0o400);
    rejects('relative selection', () => consume());
    fs.chmodSync(selectionPath, 0o600); fs.writeFileSync(selectionPath, originalSelection); fs.chmodSync(selectionPath, 0o400);
    const originalBinding = read(bindingPath);
    fs.chmodSync(bindingPath, 0o600); fs.appendFileSync(bindingPath, ' '); fs.chmodSync(bindingPath, 0o400);
    rejects('tampered binding', consume);
    fs.chmodSync(bindingPath, 0o600); fs.writeFileSync(bindingPath, originalBinding); fs.chmodSync(bindingPath, 0o400);
    fs.chmodSync(generationRoot, 0o700);
    const hiddenBinding = path.join(temporary, 'original-binding.json');
    fs.renameSync(bindingPath, hiddenBinding); rejects('missing binding', consume);
    fs.symlinkSync(hiddenBinding, bindingPath); rejects('symlinked binding', consume);
    fs.unlinkSync(bindingPath); fs.renameSync(hiddenBinding, bindingPath); fs.chmodSync(generationRoot, 0o500);
    const executable = path.join(candidate, mirror('codex-decompose-host'));
    assert.equal(physical(executable).mode & 0o777, 0o555);
    fs.chmodSync(executable, 0o444); rejects('lost sealed execute bit', consume); fs.chmodSync(executable, 0o555);
    fs.chmodSync(executable, 0o755); rejects('unsealed executable', consume); fs.chmodSync(executable, 0o555);
    for (const relative of [mirror('claude-runtime-host'), mirror('claude-role-host'), mirror('codex-arch-review-context'), mirror('role-artifact')]) {
      const file = path.join(candidate, relative), original = read(file), directory = path.dirname(file);
      fs.chmodSync(file, 0o644); fs.writeFileSync(file, 'stale private module\n'); fs.chmodSync(file, 0o444);
      rejects('stale installed consumer ' + relative, consume);
      fs.chmodSync(file, 0o644); fs.writeFileSync(file, original); fs.chmodSync(file, 0o444);
      fs.chmodSync(directory, 0o700); fs.unlinkSync(file);
      rejects('missing installed consumer ' + relative, consume);
      fs.symlinkSync(bindingPath, file); rejects('symlink installed consumer', consume); fs.unlinkSync(file);
      fs.writeFileSync(file, original, { mode: 0o444 }); fs.chmodSync(directory, 0o500);
    }
    validateDescendant(root, source); cases++;
    const finalRoot = path.join(common, FINAL_STAGE);
    fs.mkdirSync(path.dirname(finalRoot), { recursive: true });
    fs.cpSync(durable, finalRoot, { recursive: true }); fs.chmodSync(finalRoot, 0o700);
    const finalSelection = { ...selection, candidate_path: path.join(finalRoot, generation, 'candidate'),
      binding_path: path.join(finalRoot, generation, 'binding.json') };
    const finalSelectionPath = path.join(finalRoot, 'selection.json');
    fs.chmodSync(finalSelectionPath, 0o600);
    fs.writeFileSync(finalSelectionPath, JSON.stringify(finalSelection)); fs.chmodSync(finalSelectionPath, 0o400);
    const finalHandback = { ...handback, purpose: 'ADR-026-final', source_update: currentUpdate,
      changed_outputs: CORRECTIVE, corrective_allocation: { 'T-47-19': CORRECTIVE },
      ...finalSelection, selection_path: finalSelectionPath, selection_sha256: sha(read(finalSelectionPath)) };
    sealDirectories(path.join(finalRoot, generation, 'candidate'));
    fs.chmodSync(path.join(finalRoot, generation), 0o500);
    const finalConsume = () => selectedArtifact(common, finalHandback, FINAL_STAGE);
    finalConsume(); cases++;
    rejects('current selector never falls back to original namespace', () => selectedArtifact(common, finalHandback));
    rejects('corrective allocation cannot replace historical twenty outputs', () => finalConsumeWithDrift());
    function finalConsumeWithDrift() {
      return selectedArtifact(common, { ...finalHandback, publication_allocation: { 'T-47-19': CORRECTIVE } }, FINAL_STAGE);
    }
    fs.mkdirSync(path.join(finalRoot, 'unselected'), { mode: 0o500 });
    rejects('additional final generation refuses', finalConsume);
    fs.rmdirSync(path.join(finalRoot, 'unselected'));
    if (authenticatedSignatureFixture) {
    const signatureRoot = path.join(temporary, 'signature'); fs.mkdirSync(signatureRoot);
    const fixtureApproval = path.join(signatureRoot, 'generation.json');
    for (const name of ['generation.json', 'generation.json.asc', 'operator-public-key.asc']) {
      fs.writeFileSync(path.join(signatureRoot, name), read(path.join(path.dirname(HANDOFF), name)));
      fs.chmodSync(path.join(signatureRoot, name), 0o400);
    }
    authenticateHandback(fixtureApproval, HANDOFF_SHA); cases++;
    fs.chmodSync(fixtureApproval, 0o600);
    fs.writeFileSync(fixtureApproval, JSON.stringify({ ...JSON.parse(read(fixtureApproval)), actor: 'foreign' }));
    fs.chmodSync(fixtureApproval, 0o400);
    rejects('self-supplied digest cannot authenticate changed signed bytes',
      () => authenticateHandback(fixtureApproval, sha(read(fixtureApproval))));
    fs.unlinkSync(fixtureApproval + '.asc');
    rejects('missing signature refuses despite matching digest',
      () => authenticateHandback(fixtureApproval, sha(read(fixtureApproval))));
    }
    const coordinator = path.join(temporary, 'coordinator');
    fs.mkdirSync(path.join(coordinator, '.planning'), { recursive: true });
    fs.writeFileSync(path.join(coordinator, '.planning/config.json'), '{"admission":"host"}\n');
    const sourceConfig = sha(read(path.join(root, '.planning/config.json')));
    const coordinatorConfig = sha(read(path.join(coordinator, '.planning/config.json')));
    const configured = { ...source, repository: coordinator, config_sha256: sourceConfig,
      coordinator_config_sha256: coordinatorConfig };
    const configApproval = { reviewed_source_config_sha256: sourceConfig, coordinator_config_sha256: coordinatorConfig };
    validateConfigurations(root, configured, configApproval); cases++;
    rejects('distinct configuration pins cannot be swapped', () => validateConfigurations(root,
      { ...configured, config_sha256: coordinatorConfig }, configApproval));
    fs.appendFileSync(path.join(coordinator, '.planning/config.json'), 'drift');
    rejects('operative coordinator config drift', () => validateConfigurations(root, configured, configApproval));
    fs.writeFileSync(path.join(coordinator, '.planning/config.json'), '{"admission":"host"}\n');
    fs.appendFileSync(path.join(root, '.planning/config.json'), 'drift');
    rejects('reviewed checkout config drift', () => validateConfigurations(root, configured, configApproval));
    write('.planning/config.json', '{"reviewed":true}\n');
    write('docs/publication.md', 'private publication descendant\n');
    git(root, 'add', 'docs'); git(root, 'commit', '-qm', 'private docs descendant');
    validateDescendant(root, source); cases++;
    const mutationFile = 'plugins/delivery-pipeline/scripts/role-artifact.cjs';
    const unchangedInput = read(path.join(root, mutationFile));
    write(mutationFile, 'foreign canonical update\n');
    git(root, 'add', mutationFile); git(root, 'commit', '-qm', 'private canonical drift');
    rejects('canonical descendant refuses', () => validateDescendant(root, source));
    write(mutationFile, unchangedInput); git(root, 'add', mutationFile); git(root, 'commit', '-qm', 'private revert');
    rejects('reverted canonical movement still refuses', () => validateDescendant(root, source));
    git(root, 'checkout', '--detach', source.head);
    const noWriteMethods = ['writeFileSync', 'appendFileSync', 'mkdirSync', 'renameSync', 'chmodSync',
      'unlinkSync', 'rmSync', 'cpSync', 'linkSync', 'symlinkSync'];
    const savedMethods = new Map(noWriteMethods.map(name => [name, fs[name]]));
    const savedBuild = builder.build;
    try {
      for (const name of noWriteMethods) fs[name] = () => { throw new Error('consumer attempted write: ' + name); };
      builder.build = () => { throw new Error('consumer attempted builder'); };
      consume(); validateDescendant(root, source); cases++;
    } finally {
      for (const [name, method] of savedMethods) fs[name] = method;
      builder.build = savedBuild;
    }
    const canonical = path.join(root, 'plugins/delivery-pipeline/scripts/role-artifact.cjs');
    const originalCanonical = read(canonical); fs.appendFileSync(canonical, 'drift\n');
    rejects('source drift', () => assert.deepEqual(canonicalInputs(root), source.identities));
    fs.writeFileSync(canonical, originalCanonical);
    fs.cpSync(candidate, path.join(root, 'plugins/shipyard'), { recursive: true });
    for (const output of outputs) fs.chmodSync(path.join(root, 'plugins/shipyard', output.path), output.publication_mode);
    const unsealPublication = directory => {
      fs.chmodSync(directory, 0o755);
      for (const entry of fs.readdirSync(directory, { withFileTypes: true }))
        if (entry.isDirectory()) unsealPublication(path.join(directory, entry.name));
    };
    unsealPublication(path.join(root, 'plugins/shipyard'));
    git(root, 'add', 'plugins/shipyard');
    for (const group of Object.keys(GROUPS)) validatePublication(root, consume(), group);
    cases++;
    git(root, '-c', 'commit.gpgsign=false', 'commit', '-qm', 'private pre-T27 package baseline');
    const repairSelected = { ...consume(), repair: true, binding: { ...binding,
      source: { ...binding.source, head: gitText(root, 'rev-parse', 'HEAD') } } };
    validatePublication(root, repairSelected, 'complete'); cases++;
    const partialPath = mirror('claude-runtime-host');
    const partialFile = path.join(root, 'plugins/shipyard', partialPath), partialBytes = read(partialFile);
    const partialBinding = structuredClone(repairSelected.binding);
    partialBinding.outputs.find(row => row.path === partialPath).sha256 = sha('new supported fixture bytes');
    const partialSelected = { ...repairSelected, binding: partialBinding };
    validatePublication(root, partialSelected, 'candidate'); cases++;
    rejects('partial publication cannot claim complete parity', () => validatePublication(root, partialSelected, 'complete'));
    fs.writeFileSync(partialFile, 'foreign allocated bytes');
    rejects('allocated current byte forgery refuses even in candidate mode', () => validatePublication(root, partialSelected, 'candidate'));
    fs.writeFileSync(partialFile, partialBytes);
    fs.unlinkSync(partialFile);
    rejects('current candidate requires complete package membership', () => validatePublication(root, repairSelected, 'candidate'));
    fs.writeFileSync(partialFile, partialBytes);
    const noWrite = ['writeFileSync', 'appendFileSync', 'mkdirSync', 'chmodSync', 'renameSync', 'unlinkSync', 'rmSync', 'cpSync'];
    const originalMethods = new Map(noWrite.map(name => [name, fs[name]]));
    try {
      for (const name of noWrite) fs[name] = () => { throw new Error('current publication inspector wrote ' + name); };
      validatePublication(root, repairSelected, 'candidate'); cases++;
    } finally { for (const [name, method] of originalMethods) fs[name] = method; }
    const newCollector = 'plugins/shipyard/' + mirror('codex-arch-review-context');
    git(root, 'update-index', '--force-remove', newCollector);
    validatePublication(root, consume(), 'caller'); cases++;
    git(root, 'update-index', '--chmod=+x', 'plugins/delivery-pipeline/scripts/codex-arch-review-context.cjs');
    rejects('unreviewed new collector mode', () => validatePublication(root, consume(), 'caller'));
    git(root, 'update-index', '--chmod=-x', 'plugins/delivery-pipeline/scripts/codex-arch-review-context.cjs');
    git(root, 'add', newCollector);
    fs.chmodSync(path.join(root, 'plugins/shipyard', mirror('codex-decompose-host')), 0o644);
    rejects('lost publication execute bit', () => validatePublication(root, consume(), 'caller'));
    fs.chmodSync(path.join(root, 'plugins/shipyard', mirror('codex-decompose-host')), 0o755);
    git(root, 'update-index', '--chmod=-x', 'plugins/shipyard/' + mirror('codex-decompose-host'));
    rejects('wrong git index mode', () => validatePublication(root, consume(), 'caller'));
    git(root, 'update-index', '--chmod=+x', 'plugins/shipyard/' + mirror('codex-decompose-host'));
    const claude = path.join(root, 'plugins/shipyard', mirror('claude-runtime-host'));
    fs.writeFileSync(claude, 'tampered published Claude\n');
    for (const group of ['relay', 'complete']) rejects('Claude publication mismatch', () => validatePublication(root, consume(), group));
    fs.writeFileSync(claude, read(path.join(candidate, mirror('claude-runtime-host'))));
    fs.unlinkSync(claude);
    for (const group of ['relay', 'complete']) rejects('missing Claude publication', () => validatePublication(root, consume(), group));
    fs.writeFileSync(claude, read(path.join(candidate, mirror('claude-runtime-host'))));
    const unchanged = path.join(root, 'plugins/shipyard/hooks/hooks.json'); fs.appendFileSync(unchanged, 'unexpected\n');
    rejects('unexpected package delta', () => validatePublication(root, consume(), 'candidate'));
    const parents = ['T-47-13', 'T-47-03', 'T-47-04', 'T-47-09', 'T-47-15', 'T-47-14'];
    const state = {}, parentSource = { head: source.head, parent_commits: {}, provenance: {} };
    const live = {};
    for (const [index, id] of parents.entries()) {
      const pr = index + 1, base = 'epic/47', merge = source.head, head = sha(id).slice(0, 40);
      state[id] = { status: 'merged', pr, merge_sha: merge, base, url: 'https://github.com/serhii-nochevnyi/shipyard/pull/' + pr };
      parentSource.parent_commits[id] = { head, merge, base_merge_commits: [merge] };
      parentSource.provenance[id] = { pr, base, url: state[id].url, state_sha256: sha(canon(state[id])) };
      live[pr] = { number: pr, state: 'MERGED', headRefOid: head, mergeCommit: { oid: merge }, baseRefName: base };
    }
    const ancestry = (before, after) => git(root, 'merge-base', '--is-ancestor', before, after);
    validateParents(parentSource, state, number => live[number], ancestry); cases++;
    rejects('nested state rows', () => validateParents(parentSource, { tickets: state }, number => live[number], ancestry));
    for (const edit of [{ number: 999 }, { state: 'OPEN' }, { headRefOid: 'f'.repeat(40) },
      { mergeCommit: { oid: 'f'.repeat(40) } }, { baseRefName: 'main' }])
      rejects('foreign live parent association', () => validateParents(parentSource, state,
        number => ({ ...live[number], ...(number === 1 ? edit : {}) }), ancestry));
    const originalMerge = parentSource.parent_commits['T-47-13'].base_merge_commits;
    parentSource.parent_commits['T-47-13'].base_merge_commits = ['f'.repeat(40)];
    rejects('unmerged base_merge', () => validateParents(parentSource, state, number => live[number], ancestry));
    parentSource.parent_commits['T-47-13'].base_merge_commits = originalMerge;
    const finalState = {}, finalSource = { repository: root, head: source.head, parent_commits: {}, provenance: {} };
    for (let n = 1; n <= 18; n++) {
      const id = 'T-47-' + String(n).padStart(2, '0');
      finalState[id] = { status: 'merged', pr: n, merge_sha: source.head, base: 'epic/47',
        url: 'https://github.com/serhii-nochevnyi/shipyard/pull/' + n };
      finalSource.parent_commits[id] = { head: sha(id).slice(0, 40), merge: source.head, base_merge_commits: [source.head] };
      finalSource.provenance[id] = { pr: n, base: 'epic/47', url: finalState[id].url,
        state_sha256: sha(canon(finalState[id])) };
    }
    finalState['T-47-19'] = { status: 'pending' };
    const saveBoard = () => write('.planning/graph/delivery-state.json', JSON.stringify(finalState));
    finalSource.delivery_state_sha256 = sha(read(saveBoard()));
    validateDeliveryState(finalSource, ancestry, true); cases++;
    finalState['T-47-19'] = { status: 'pr-open', pr: 438 };
    finalState['T-48-01'] = { status: 'pending' };
    saveBoard();
    assert.notEqual(sha(read(path.join(root, '.planning/graph/delivery-state.json'))), finalSource.delivery_state_sha256);
    validateDeliveryState(finalSource, ancestry, true); cases++;
    for (const id of Object.keys(finalSource.parent_commits)) {
      const original = finalState[id];
      for (const mutation of [{ ...original, projection: 'changed' }, undefined,
        { ...original, merge_sha: 'f'.repeat(40) }]) {
        if (mutation) finalState[id] = mutation; else delete finalState[id];
        saveBoard();
        rejects('final signed parent mutation/missing/merge drift: ' + id,
          () => validateDeliveryState(finalSource, ancestry, true));
      }
      finalState[id] = original;
    }
    saveBoard(); validateDeliveryState(finalSource, ancestry, true); cases++;
    assert.equal(buildCalls, 0); consume();
    return { passed: cases, private_build_calls: buildCalls, selected_reuse_build_calls: 0 };
  } finally {
    const writable = directory => {
      fs.chmodSync(directory, 0o700);
      for (const entry of fs.readdirSync(directory, { withFileTypes: true }))
        if (entry.isDirectory()) writable(path.join(directory, entry.name));
    };
    writable(temporary); fs.rmSync(temporary, { recursive: true, force: true });
  }
}

module.exports = { R8_STAGE, R8_HANDOFF_SHA, R8_CORRECTIVE, validateR8Contract, R7_STAGE, R7_HANDOFF_SHA, R7_CORRECTIVE, validateR7Contract, validateSquashPublication, R6_STAGE, R6_HANDOFF_SHA, R6_CORRECTIVE, validateR6Contract, R5_STAGE, R5_HANDOFF_SHA, R5_CORRECTIVE, validateR5Contract, R3_STAGE, R3_HANDOFF_SHA, R4_STAGE, R4_HANDOFF_SHA, R4_CORRECTIVE, validateR4Contract, R2_HISTORY_CONTRACT, validateR2HistoricalAdmission, authenticateR2History, T16_STAGE, T16_HANDOFF, T16_HANDOFF_SHA, T16_CORRECTIVE, validateT16Contract, authenticateT16Successor, recheckT16Successor, R2_HANDOFF, R2_HANDOFF_SHA, F1_HISTORICAL_CONTRACT, validateR2Scope, validatePreviousCurrentPublication, validatePinnedHistoricalIdentity, validateSignedHistoricalParents, authenticatePinnedHistoricalContract, F1_HANDOFF, F1_HANDOFF_SHA, F1_CORRECTIVE, validateF1Scope, validateFreshMaterializations, validatePreviousRepairPublication, REPAIR_OWNERS, reauthenticateRepairCoverage, validateOriginalMaterialization, ORIGINAL_ENTRIES, MATERIALIZATION_V2, MATERIALIZATION_V2_SHA, validateOperatorSignature, validateVolumeMaterialization, historicalVolumeEntry, MATERIALIZATION, MATERIALIZATION_SHA, validateRepairContract, authenticateRepairSuccessor, recheckRepairSuccessor, REPAIR_HANDOFF, REPAIR_HANDOFF_SHA, REPAIR_CORRECTIVE, REPAIR_PLANS, SOURCE39_SHA, COORDINATOR48_SHA, HISTORICAL43_SHA, validatePublication, authenticateVolumeSuccessor, recheckVolumeSuccessor, validateVolumeContract, VOLUME_CORRECTIVE, VOLUME_HANDOFF, VOLUME_HANDOFF_SHA, authenticateSuccessor, recheckSuccessor, validateSuccessorContract, SUCCESSOR_CORRECTIVE, SUCCESSOR_HANDOFF, SUCCESSOR_HANDOFF_SHA, check, authenticateOriginal, authenticateFinal, recheckFinal, selectedArtifact, validateSourceUpdate,
  validateDescendant, validateConfigurations, CORRECTIVE, FINAL_HANDOFF, FINAL_HANDOFF_SHA };

if (require.main === module) {
  try {
    if (process.argv.length === 2) {
      console.log(JSON.stringify({ status: 'passed', fixture_only: true, fixtures: privateFixtures() }));
    } else {
      assert.equal(process.argv.length, 4, 'usage: node phase47-package-publication.test.cjs --group <group>');
      assert.equal(process.argv[2], '--group');
      assert(Object.hasOwn(GROUPS, process.argv[3]), 'unknown publication group');
      const fixtures = privateFixtures(true);
      console.log(JSON.stringify({ ...check(process.argv[3]), fixtures }));
    }
  } catch (error) {
    console.error(JSON.stringify({ status: 'blocked', ticket: 'T-47-23', reason: error.message }));
    process.exitCode = 1;
  }
}
