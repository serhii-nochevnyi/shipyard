#!/usr/bin/env bash
set -euo pipefail

[[ -f scripts/sync-local-ssh-config.sh ]] || { echo "missing scripts/sync-local-ssh-config.sh"; exit 1; }

tmpdir="$(mktemp -d)"
trap 'rm -rf "$tmpdir"' EXIT

source_dir="$tmpdir/source"
target_dir="$tmpdir/target"
mkdir -p "$source_dir"

cat > "$source_dir/config" <<'EOF'
Host github.com
  HostName github.com
  User git
  IdentityFile ~/.ssh/id_ed25519
EOF

printf 'github.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAITestKey\n' > "$source_dir/known_hosts"
printf 'PRIVATE-KEY-MUST-NOT-BE-COPIED\n' > "$source_dir/id_ed25519"

LOCAL_SSH_DIR="$source_dir" ./scripts/sync-local-ssh-config.sh "$target_dir"

test -f "$target_dir/config"
test -f "$target_dir/known_hosts"
test ! -e "$target_dir/id_ed25519"
grep -q 'Host github.com' "$target_dir/config"

echo "ssh sync smoke passed"
