#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

fail() {
  echo "docs smoke: $*" >&2
  exit 1
}

[[ -f README.md ]] || fail "README.md is missing"
[[ -f CLAUDE.md ]] || fail "CLAUDE.md is missing"
[[ -f Makefile ]] || fail "Makefile is missing"

for word in docker container kubernetes k8s dockerfile compose image entrypoint; do
  if grep -Eiq "(^|[^[:alnum:]_])$word([^[:alnum:]_]|$)" README.md; then
    fail "README still documents the retired $word path"
  fi
done

for retired in \
  Dockerfile Dockerfile.base docker-compose.yml .env.example config/mcp-config.default.json \
  k8s scripts/dev.sh scripts/entrypoint.sh scripts/install-claude-plugins.sh \
  scripts/bootstrap-atlassian-rovo-oauth.sh scripts/shipyard-trust.sh \
  scripts/sync-karpathy-skills.sh scripts/sync-local-ssh-config.sh \
  tests/smoke/base-image-smoke.sh tests/smoke/overlay-image-smoke.sh \
  tests/smoke/runtime-smoke.sh tests/smoke/mcp-runtime-smoke.sh \
  tests/smoke/k8s-manifest-smoke.sh tests/smoke/ssh-sync-smoke.sh
 do
  [[ ! -e "$retired" ]] || fail "retired execution path remains: $retired"
done

for cmd in route investigate decompose deliver bench; do
  grep -q "/shipyard:$cmd" README.md || fail "README misses /shipyard:$cmd"
  grep -q "\$shipyard:shipyard-$cmd" README.md || fail "README misses marketplace skill shipyard-$cmd"
done

node -e 'const fs = require("node:fs");
const path = require("node:path");

const root = process.cwd();
const plugin = JSON.parse(fs.readFileSync(path.join(root, "plugins/delivery-pipeline/.claude-plugin/plugin.json"), "utf8"));
const readme = fs.readFileSync(path.join(root, "README.md"), "utf8");
for (const command of plugin.commands) {
  const name = path.basename(command, ".md");
  if (!readme.includes("/shipyard:" + name)) throw new Error("README misses plugin command " + name);
}
const capability = JSON.parse(fs.readFileSync(
  path.join(root, "capabilities/delivery-pipeline/capability.json"), "utf8"
));
const match = readme.match(/"codex_models":\s*"([^"]+)"/);
if (!match) throw new Error("README misses the Codex palette example");
if (match[1] !== capability.config["delivery_pipeline.codex_models"].default) {
  throw new Error("README Codex palette differs from capability.json");
}'

node <<'NODE'
const fs = require('node:fs');
const assert = require('node:assert/strict');
const launcher = 'bash scripts/ensure-gsd-core.sh --launch-marketplace';
for (const [file, count] of [['README.md', 2], ['CLAUDE.md', 1]]) {
  const text = fs.readFileSync(file, 'utf8');
  const examples = [...text.matchAll(/```(?:bash|sh)\n([\s\S]*?)```/g)].flatMap(match => match[1].split('\n'));
  const routes = examples.filter(line => /install-shipyard-marketplace\.cjs|--launch-marketplace/.test(line));
  assert.equal(routes.length, count, file + ' primary marketplace example count');
  for (const route of routes) assert.equal(route, launcher + ' codex --source "$PWD"', file + ' must preserve guarded runtime/source');
}
const make = fs.readFileSync('Makefile', 'utf8');
assert.ok(make.includes('package-shipyard-codex:\n\tsource scripts/ensure-gsd-core.sh --library && validate_isolated_node_options && node scripts/package-shipyard-codex.cjs\n'));
assert.ok(make.includes('install-shipyard-codex: package-shipyard-codex\n'));
assert.ok(make.includes('dogfood_root = $(shell source scripts/ensure-gsd-core.sh --library && validate_isolated_node_options && SHIPYARD_DOGFOOD_RUNTIME='));
for (const [target, runtime, source] of [
  ['install-shipyard-marketplace-codex', 'codex', ''],
  ['install-shipyard-marketplace-claude', 'claude', ''],
  ['install-shipyard-codex', 'codex', ' --source "$(CURDIR)"'],
]) {
  const recipe = make.match(new RegExp('^' + target + '(?:: package-shipyard-codex|:)\\n((?:\\t[^\\n]*\\n)+)', 'm'));
  assert.ok(recipe, target + ' recipe missing');
  const lines = recipe[1].trim().split('\n').map(line => line.trim());
  assert.deepEqual(lines.filter(line => /install-shipyard-marketplace\.cjs|--launch-marketplace/.test(line)),
    [launcher + ' ' + runtime + source], target + ' must preserve guarded runtime/source');
  if (source) {
    assert.deepEqual(lines, [
      launcher + ' ' + runtime + source,
    ], target + ' must validate before package Node startup and retain generation');
  }
}
NODE

while IFS= read -r target; do
  [[ -z "$target" ]] && continue
  grep -qE "^$target:" Makefile || fail "README references missing make target: $target"
done < <(grep -oE 'make [a-z][a-z0-9-]+' README.md | awk '{print $2}' | sort -u)

grep -q 'make test-fast' .github/workflows/test.yml || fail "CI must run make test-fast"
grep -q "node-version: '24.15.0'" .github/workflows/test.yml || fail "CI Node version is not pinned"
if grep -Eiq 'docker|container|k8s|kubernetes|dockerfile|image|entrypoint' .github/workflows/test.yml; then
  fail "CI still names a retired execution path"
fi

grep -q 'STOP_DIR=' scripts/install-shipyard-claude-hook.sh || fail "Claude installer has no stable hook bundle"
grep -q 'copy_stop_bundle' scripts/install-shipyard-claude-hook.sh || fail "Claude installer does not copy dependencies"
grep -q 'OLD_STOP_CMD' scripts/install-shipyard-claude-hook.sh || fail "Claude installer does not migrate the old hook"
grep -q 'usage-attribution.cjs' README.md || fail "README misses usage attribution"
grep -q 'usage-report.cjs' README.md || fail "README misses usage report"

echo "docs smoke passed"
