// Read-only diagnostic. No agents, network requests, or project mutations.
// Exit 0 means observations completed, not that the implementation is correct.
const fs = require('fs');
const path = require('path');
const root = path.resolve(process.argv[2] || process.cwd());
const scripts = path.join(root, 'plugins/delivery-pipeline/scripts');
const { computeFront } = require(path.join(scripts, 'front.cjs'));
const pc = require(path.join(scripts, 'pipeline-config.cjs'));
const result = [];

// Step 4 explicitly permits sending later PRs to a fresh guard while the
// earlier guard works. Model the two actual spawns separately, then give the
// counter exactly the persisted role/at shape activeDispatches returns.
const spawns = [
  { agent: 'guard-wave-1', role: 'pr-sentinel', tickets: ['T-01-01', 'T-01-02'] },
  { agent: 'guard-wave-2', role: 'pr-sentinel', tickets: ['T-01-03'] },
  { agent: 'executor-4', role: 'executor', tickets: ['T-01-04'] },
  { agent: 'executor-5', role: 'executor', tickets: ['T-01-05'] },
];
const dispatched = {};
for (const [i, spawn] of spawns.entries()) {
  for (const ticket of spawn.tickets) {
    dispatched[ticket] = { role: spawn.role, at: new Date(Date.now() - (5 - i) * 60_000).toISOString() };
  }
}
const front = computeFront({}, {}, { maxConcurrentAgents: 4, dispatched });
result.push({ probe: 'two-live-guards', actual_agents_in_fixture: spawns.length,
  expected_free: 0, observed_capacity: front.capacity });

const guardContract = fs.readFileSync(path.join(root, 'plugins/delivery-pipeline/references/pr-sentinel.md'), 'utf8');
result.push({ probe: 'background-judgment-contract',
  reads_prior_arch_review: guardContract.includes('arch_review'),
  writes_arch_review: /log-event\.cjs\s+arch_review/.test(guardContract),
  resolves_arch_review: /pipeline-config\.cjs model arch-review/.test(guardContract),
  supplies_input_measurement: guardContract.includes('--input-tokens'),
});

for (const runtime of ['claude', 'codex']) {
  const cfg = { ...pc.DEFAULTS, gsd: { ...pc.DEFAULTS.gsd, runtime } };
  result.push({ probe: 'built-in-role-baseline', runtime, roles: pc.ROLES.map(role => {
    const model = pc.resolveModel(role, {}, cfg);
    return { role, tier_alias: model, requested_effort: pc.resolveEffort(role, model, cfg, {}) };
  }) });
}

// An optional third argument inspects an installed bundle. Script payloads are
// copied byte-for-byte by the generator; generated skills/agents are excluded.
if (process.argv[3]) {
  const installed = path.resolve(process.argv[3]);
  const files = ['front.cjs', 'pipeline-config.cjs', 'dispatch-record.cjs', 'gsd-tune.cjs'];
  result.push({ probe: 'installed-script-parity', installed, files: files.map(file => {
    const target = path.join(installed, 'scripts', file);
    return { file, exists: fs.existsSync(target), same: fs.existsSync(target)
      && fs.readFileSync(target).equals(fs.readFileSync(path.join(scripts, file))) };
  }) });
}
process.stdout.write(JSON.stringify(result, null, 2) + '\n');
