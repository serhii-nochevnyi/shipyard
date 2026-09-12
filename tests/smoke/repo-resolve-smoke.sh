#!/usr/bin/env bash
set -euo pipefail

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
repo_root=$(cd "$script_dir/../.." && pwd)
resolver="$repo_root/plugins/delivery-pipeline/scripts/repo-resolve.cjs"
fixture=$(mktemp -d "${TMPDIR:-/tmp}/shipyard-repo-resolve-smoke.XXXXXX")
result_file=$(mktemp "${TMPDIR:-/tmp}/shipyard-repo-resolve-result.XXXXXX")
trap 'rm -rf "$fixture" "$result_file"' EXIT

project="$fixture/project"
bin="$fixture/bin"
mkdir -p "$bin"
mkdir -p "$project/.planning"
cat > "$project/.planning/config.json" <<'JSON'
{
  "pipeline": {}
}
JSON

# Discovery may inspect git metadata, but the unattended D3 branch must never
# reach a write-capable command. These shims make that boundary executable in
# the smoke test without contacting GitHub or a remote server.
cat > "$bin/git" <<'SH'
#!/usr/bin/env bash
if [[ "${1:-}" == "clone" ]]; then
  echo 'unexpected git clone' >&2
  exit 97
fi
exit 1
SH
cat > "$bin/gh" <<'SH'
#!/usr/bin/env bash
echo 'unexpected gh invocation' >&2
exit 97
SH
cat > "$bin/curl" <<'SH'
#!/usr/bin/env bash
echo 'unexpected curl invocation' >&2
exit 97
SH
chmod +x "$bin/git" "$bin/gh" "$bin/curl"

before=$(find "$fixture" -mindepth 1 -print | LC_ALL=C sort)
PATH="$bin:$PATH" node "$resolver" choose acme/service \
  --ticket T-30-04 \
  --project-dir "$project" \
  --non-interactive \
  --json > "$result_file"

node - "$result_file" <<'NODE'
const fs = require('fs');
const result = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
if (result.resolution !== 'track-only') throw new Error(`expected track-only, got ${result.resolution}`);
if (result.executable !== false) throw new Error('unattended resolution must not be executable');
if (result.decision !== 'skip' || result.operator_choice !== 'skip') {
  throw new Error(`expected unattended skip, got ${result.decision}/${result.operator_choice}`);
}
if (!result.park_reason) throw new Error('unattended resolution must carry park_reason');
NODE

after=$(find "$fixture" -mindepth 1 -print | LC_ALL=C sort)
if [[ "$before" != "$after" ]]; then
  echo 'repo-resolve smoke: unattended choice mutated the filesystem' >&2
  diff -u <(printf '%s\n' "$before") <(printf '%s\n' "$after") || true
  exit 1
fi

echo 'repo-resolve smoke: unattended choice parked without filesystem or network writes'
