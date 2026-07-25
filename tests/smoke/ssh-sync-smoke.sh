#!/usr/bin/env bash
set -euo pipefail

[[ -f scripts/sync-local-ssh-config.sh ]] || { echo "missing scripts/sync-local-ssh-config.sh"; exit 1; }

tmpdir="$(mktemp -d)"
trap 'rm -rf "$tmpdir"' EXIT

perms() { stat -f %Lp "$1" 2>/dev/null || stat -c %a "$1"; }

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
printf 'PRIVATE-KEY-MUST-NOT-BE-COPIED\n' > "$source_dir/id_rsa"
printf 'AUTHORIZED-KEYS-MUST-NOT-BE-COPIED\n' > "$source_dir/authorized_keys"

LOCAL_SSH_DIR="$source_dir" ./scripts/sync-local-ssh-config.sh "$target_dir"

test -f "$target_dir/config"
test -f "$target_dir/known_hosts"
grep -q 'Host github.com' "$target_dir/config"
[[ "$(perms "$target_dir/config")" == "600" ]] || { echo "staged config is not 600"; exit 1; }

for forbidden in id_ed25519 id_rsa authorized_keys; do
  test ! -e "$target_dir/$forbidden" || { echo "$forbidden was staged into the build context"; exit 1; }
done

# This directory is ALSO the default runtime mount source for /home/dev/.ssh-host
# (docker-compose.yml), so it must always exist afterwards: a machine with no
# ~/.ssh, or a CI runner, still has to be able to build and start the container.
empty_source="$tmpdir/no-ssh-here"
empty_target="$tmpdir/target-empty"
LOCAL_SSH_DIR="$empty_source" ./scripts/sync-local-ssh-config.sh "$empty_target" 2>/dev/null
test -d "$empty_target" || { echo "staging dir was not created for a host without ~/.ssh"; exit 1; }
test -f "$empty_target/.keep" || { echo "empty staging dir has no placeholder — docker COPY may fail"; exit 1; }

# ...and a ~/.ssh that exists but holds only private keys is likewise non-fatal.
keys_only="$tmpdir/keys-only"
mkdir -p "$keys_only"
printf 'PRIVATE\n' > "$keys_only/id_ed25519"
keys_target="$tmpdir/target-keys-only"
LOCAL_SSH_DIR="$keys_only" ./scripts/sync-local-ssh-config.sh "$keys_target" 2>/dev/null
test ! -e "$keys_target/id_ed25519" || { echo "a private key was staged"; exit 1; }
test -f "$keys_target/.keep" || { echo "keys-only staging produced no placeholder"; exit 1; }

echo "ssh sync smoke passed"
