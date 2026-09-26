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

node - <<'NODE'
const fs = require('node:fs');
const path = require('node:path');

const root = process.cwd();
const plugin = JSON.parse(fs.readFileSync(path.join(root, 'plugins/delivery-pipeline/.claude-plugin/plugin.json'), 'utf8'));
const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
for (const command of plugin.commands) {
  const name = path.basename(command, '.md');
  if (!readme.includes('/shipyard:' + name)) throw new Error('README misses plugin command ' + name);
}
const capability = JSON.parse(fs.readFileSync(
  path.join(root, 'capabilities/delivery-pipeline/capability.json'), 'utf8'
));
const match = readme.match(/"codex_models":\s*"([^"]+)"/);
if (!match) throw new Error('README misses the Codex palette example');
if (match[1] !== capability.config['delivery_pipeline.codex_models'].default) {
  throw new Error('README Codex palette differs from capability.json');
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
