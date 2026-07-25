#!/usr/bin/env bash
set -euo pipefail

# Stage the SAFE subset of the local SSH client config into the build context.
# Only `config`, `known_hosts` and `known_hosts2` are ever copied — never a
# private key, never authorized_keys.
#
# The staging directory is ALSO the default runtime mount source for
# /home/dev/.ssh-host (see docker-compose.yml), so it must always exist after
# this script runs: a machine with no ~/.ssh, or a CI runner, must still be able
# to build and start the container. Nothing to copy is therefore a WARNING, not
# a failure — the container then relies on SSH agent forwarding alone.

SOURCE_DIR="${LOCAL_SSH_DIR:-$HOME/.ssh}"
TARGET_DIR="${1:-.build/ssh-config}"
copied=0

rm -rf "$TARGET_DIR"
mkdir -p "$TARGET_DIR"

if [[ -d "$SOURCE_DIR" ]]; then
  for file in config known_hosts known_hosts2; do
    if [[ -f "$SOURCE_DIR/$file" ]]; then
      cp "$SOURCE_DIR/$file" "$TARGET_DIR/$file"
      chmod 600 "$TARGET_DIR/$file"
      copied=$((copied + 1))
    fi
  done
else
  echo "warning: no SSH directory at $SOURCE_DIR — staging an empty safe set" >&2
fi

if [[ "$copied" -eq 0 ]]; then
  echo "warning: no safe SSH client files (config, known_hosts, known_hosts2) in $SOURCE_DIR" >&2
  echo "         the container will rely on SSH agent forwarding for git access" >&2
  # Docker COPY needs a non-empty directory to be reliable across builders.
  : > "$TARGET_DIR/.keep"
fi

# Defence in depth: even though only the three files above are ever copied, make
# it impossible for a key to survive here if this list ever grows.
rm -f \
  "$TARGET_DIR"/authorized_keys \
  "$TARGET_DIR"/id_* \
  "$TARGET_DIR"/*.pem \
  "$TARGET_DIR"/*.key 2>/dev/null || true
