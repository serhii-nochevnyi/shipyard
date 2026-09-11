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

# A clone is a separate explicit write step. Use a local source so this proof
# does not depend on GitHub credentials or a network server, then hand the
# resulting checkout to the same ticket-worktree base selector used by delivery.
source_repo="$fixture/source"
clone_project="$fixture/clone-project"
clone_root="$fixture/checkouts"
clone_destination="$clone_root/service"
mkdir -p "$source_repo" "$clone_project/.planning" "$clone_root"
git -C "$source_repo" init -q
git -C "$source_repo" config user.email shipyard-tests@example.invalid
git -C "$source_repo" config user.name 'Shipyard Tests'
git -C "$source_repo" remote add origin git@github.com:acme/service.git
printf 'seed\n' > "$source_repo/README.md"
git -C "$source_repo" add README.md
git -C "$source_repo" commit -qm seed
git -C "$source_repo" branch -M main
git -C "$source_repo" branch epic/base

node - "$resolver" "$source_repo" "$clone_project" "$clone_root" "$clone_destination" <<'NODE'
const fs = require('fs');
const [resolver, source, project, root, destination] = process.argv.slice(2);
const mod = require(resolver);
const result = mod.cloneRepository({
  ticket: 'T-30-07',
  repo: 'acme/service',
  config: { repos: {}, repos_root: root },
  projectRoot: project,
  destination,
  base: 'epic/base',
  cloneUrl: source,
});
if (!result.executable) throw new Error(result.reason);
if (result.base_ref !== 'origin/epic/base' || result.base_verified !== true) {
  throw new Error(`base verification missing: ${JSON.stringify(result)}`);
}
if (!fs.existsSync(destination)) throw new Error('clone destination was not created');
NODE

if [[ "$(git -C "$clone_destination" rev-parse --is-shallow-repository)" != "false" ]]; then
  echo 'repo-resolve smoke: clone must be full, not shallow' >&2
  exit 1
fi
git -C "$clone_destination" rev-parse --verify --quiet 'refs/remotes/origin/epic/base^{commit}' >/dev/null
if [[ "$(git -C "$clone_destination" remote get-url origin)" != "git@github.com:acme/service.git" ]]; then
  echo 'repo-resolve smoke: clone origin identity was not preserved' >&2
  exit 1
fi

worktree_root="$fixture/ticket-worktrees"
worktree_path=$(cd "$clone_destination" && SHIPYARD_WORKTREE_ROOT="$worktree_root" bash \
  "$repo_root/plugins/delivery-pipeline/scripts/ticket-worktree.sh" \
  create T-30-07 ticket/T-30-07 epic/base 2>/dev/null)
if [[ ! -d "$worktree_path" ]]; then
  echo 'repo-resolve smoke: ticket-worktree could not use the verified origin base' >&2
  exit 1
fi
if [[ "$(git -C "$worktree_path" rev-parse --abbrev-ref HEAD)" != "ticket/T-30-07" ]]; then
  echo 'repo-resolve smoke: ticket-worktree selected the wrong branch' >&2
  exit 1
fi
echo 'repo-resolve smoke: full clone verified origin/epic/base and ticket-worktree compatibility'
