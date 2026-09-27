#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if [ "$#" -ne 1 ] || [ -z "$1" ]; then
  echo "usage: scripts/release.sh <version>" >&2
  exit 2
fi
version="$1"

manifest_version="$(node -e 'process.stdout.write(String(require(process.argv[1]).version))' "$ROOT/plugins/delivery-pipeline/.claude-plugin/plugin.json")"
if [ "$version" != "$manifest_version" ]; then
  echo "release: refused — version $version differs from plugin.json version $manifest_version" >&2
  exit 1
fi

if [ -n "$(git status --porcelain)" ]; then
  echo "release: refused — the working tree is dirty" >&2
  exit 1
fi

if git rev-parse -q --verify "refs/tags/v$version" >/dev/null; then
  echo "release: refused — tag v$version already exists" >&2
  exit 1
fi

tree_sha="$(git rev-parse 'HEAD^{tree}')"
set +e
check_json="$(node "$ROOT/plugins/delivery-pipeline/scripts/live-receipt.cjs" check --version "$version" --tree-sha "$tree_sha")"
check_status=$?
set -e
if [ "$check_status" -ne 0 ]; then
  echo "release: refused — no fresh passing live receipt for v$version at tree $tree_sha" >&2
  echo "$check_json" >&2
  for runtime in $(printf '%s' "$check_json" | node -e '
    const r = JSON.parse(require("fs").readFileSync(0, "utf8") || "{}");
    const all = [...(r.missing || []), ...(r.stale || []), ...(r.failed || []).map((f) => f.runtime)];
    process.stdout.write([...new Set(all)].join(" "));
  '); do
    echo "  run: bash tests/live/live-round.sh --runtime $runtime" >&2
  done
  exit 1
fi

bash "$ROOT/tests/smoke/release-notes-smoke.sh"

git tag -a "v$version" -m "v$version"
echo "release: tagged v$version at $(git rev-parse HEAD)"
echo "push with: git push origin v$version"
