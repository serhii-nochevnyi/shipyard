#!/usr/bin/env bash
set -euo pipefail

# Unit tests for the deterministic layer. No network or node_modules; run this
# suite on every edit.

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

unset CLAUDE_PLUGIN_ROOT CLAUDE_CODE_ENTRYPOINT CODEX_SANDBOX CODEX_SANDBOX_NETWORK_DISABLED

command -v node >/dev/null 2>&1 || { echo "node not found on PATH"; exit 1; }

# Every .cjs in the deterministic layer must at least parse.
for f in plugins/delivery-pipeline/scripts/*.cjs capabilities/delivery-pipeline/checks/*.cjs scripts/*.cjs; do
  node --check "$f" || { echo "syntax error in $f"; exit 1; }
done
for f in plugins/delivery-pipeline/scripts/*.sh scripts/*.sh tests/smoke/*.sh tests/unit/*.sh; do
  bash -n "$f" || { echo "syntax error in $f"; exit 1; }
done

unit_files=(tests/unit/*.test.cjs)
unit_git_home="$(mktemp -d "${TMPDIR:-/tmp}/shipyard-unit.XXXXXX")"
unit_pids=()
unit_active=()
unit_logs=()
unit_next=0
unit_active_count=0
unit_log_count=0
failed=0
unit_emitted=0

emit_logs() {
  if [[ "$unit_emitted" == 0 ]]; then
    unit_emitted=1
    local i
    for ((i=0; i<unit_log_count; i++)); do
      echo "═══ ${unit_files[$i]}"
      cat "${unit_logs[$i]}"
    done
  fi
}

cleanup() {
  local pid attempt running unit_pending
  unit_pending="$(jobs -p)"
  trap '' INT TERM
  for pid in ${unit_pids[@]+"${unit_pids[@]}"} $unit_pending; do
    kill -TERM -- "-$pid" 2>/dev/null || :
  done
  for ((attempt=0; attempt<40; attempt++)); do
    running=0
    for pid in ${unit_pids[@]+"${unit_pids[@]}"} $unit_pending; do
      if kill -0 -- "-$pid" 2>/dev/null; then running=1; fi
    done
    if [[ "$running" == 0 ]]; then break; fi
    sleep 0.05
  done
  for pid in ${unit_pids[@]+"${unit_pids[@]}"} $unit_pending; do
    kill -KILL -- "-$pid" 2>/dev/null || :
  done
  for pid in ${unit_pids[@]+"${unit_pids[@]}"} $unit_pending; do
    wait "$pid" 2>/dev/null || :
  done
  emit_logs
  rm -rf "$unit_git_home"
}
setup_handlers() {
  trap cleanup EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM
}

finish_workers() {
  cleanup
  trap - EXIT
}

setup_handlers

# @invariant: Job control gives each direct Node worker and its descendants a private process group.
set -m
while ((unit_next < ${#unit_files[@]} || unit_active_count > 0)); do
  while ((unit_next < ${#unit_files[@]} && unit_active_count < 4)); do
    unit_worker="$unit_git_home/$unit_next"
    mkdir -p "$unit_worker"/{home,tmp,codex,config,cache,state,data,runtime,claude}
    unit_logs[$unit_next]="$unit_worker/output"
    : >"${unit_logs[$unit_next]}"
    unit_log_count=$((unit_next + 1))
    chmod 700 "$unit_worker/runtime"
    cp /dev/null "$unit_worker/gitconfig"
    git config --file "$unit_worker/gitconfig" user.name 'Shipyard Unit Tests'
    git config --file "$unit_worker/gitconfig" user.email 'unit-tests@shipyard.invalid'
    git config --file "$unit_worker/gitconfig" commit.gpgsign false
    git config --file "$unit_worker/gitconfig" tag.gpgsign false
    git config --file "$unit_worker/gitconfig" init.defaultBranch main
    HOME="$unit_worker/home" CODEX_HOME="$unit_worker/codex" \
      CLAUDE_CONFIG_DIR="$unit_worker/claude" TMPDIR="$unit_worker/tmp" \
      TMP="$unit_worker/tmp" TEMP="$unit_worker/tmp" \
      XDG_CONFIG_HOME="$unit_worker/config" XDG_CACHE_HOME="$unit_worker/cache" \
      XDG_STATE_HOME="$unit_worker/state" XDG_DATA_HOME="$unit_worker/data" \
      XDG_RUNTIME_DIR="$unit_worker/runtime" GIT_CONFIG_GLOBAL="$unit_worker/gitconfig" \
      GIT_CONFIG_NOSYSTEM=1 node "${unit_files[$unit_next]}" >"${unit_logs[$unit_next]}" 2>&1 &
    unit_pids[$unit_next]=$!
    unit_active[unit_active_count]=$!
    unit_active_count=$((unit_active_count + 1))
    unit_next=$((unit_next + 1))
  done
  unit_remaining=()
  unit_remaining_count=0
  for unit_pid in ${unit_active[@]+"${unit_active[@]}"}; do
    if kill -0 "$unit_pid" 2>/dev/null; then
      unit_remaining[$unit_remaining_count]="$unit_pid"
      unit_remaining_count=$((unit_remaining_count + 1))
    else
      wait "$unit_pid" || failed=1
      if ! kill -0 -- "-$unit_pid" 2>/dev/null; then
        for ((unit_index=0; unit_index<unit_next; unit_index++)); do
          if [[ "${unit_pids[$unit_index]:-}" == "$unit_pid" ]]; then
            unset 'unit_pids[unit_index]'
            break
          fi
        done
      fi
    fi
  done
  unit_active=(${unit_remaining[@]+"${unit_remaining[@]}"})
  unit_active_count=$unit_remaining_count
  if ((unit_active_count > 0)); then sleep 0.05; fi
done
finish_workers

if [[ "$failed" != 0 ]]; then
  echo
  echo "unit tests FAILED"
  exit 1
fi
echo
echo "unit tests passed"
