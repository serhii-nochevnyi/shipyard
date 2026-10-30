#!/usr/bin/env bash
set -euo pipefail

# Unit tests for the deterministic layer. No network or node_modules; run this
# suite on every edit.

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

unset CLAUDE_PLUGIN_ROOT CLAUDE_CODE_ENTRYPOINT CODEX_SANDBOX CODEX_SANDBOX_NETWORK_DISABLED

command -v node >/dev/null 2>&1 || { echo "node not found on PATH"; exit 1; }

# @contract: UNIT_SHARD=<i>/<n> runs one slice; UNIT_WORKERS=<n|auto> sets concurrency, default 4.
unit_workers="${UNIT_WORKERS:-4}"
if [[ "$unit_workers" == auto ]]; then
  unit_workers="$(getconf _NPROCESSORS_ONLN 2>/dev/null || echo 4)"
fi
[[ "$unit_workers" =~ ^[1-9][0-9]*$ ]] || { echo "UNIT_WORKERS must be a positive integer or auto, got '${UNIT_WORKERS:-}'"; exit 2; }

unit_files=(tests/unit/*.test.cjs)
if [[ -n "${UNIT_SHARD:-}" ]]; then
  unit_selection="$(node tests/unit/shard-files.cjs "$UNIT_SHARD")" || exit $?
  [[ -n "$unit_selection" ]] || { echo "UNIT_SHARD=$UNIT_SHARD selected no unit tests"; exit 1; }
  unit_files=()
  while IFS= read -r unit_file; do unit_files+=("$unit_file"); done <<<"$unit_selection"
fi
unit_sweep=1
if [[ -n "${UNIT_SHARD:-}" && "${UNIT_SHARD%%/*}" != 1 ]]; then unit_sweep=0; fi
unit_progress=0
if [[ -n "${UNIT_SHARD:-}" ]]; then unit_progress=1; fi

if [[ "$unit_sweep" == 1 ]]; then
  for f in plugins/delivery-pipeline/scripts/*.cjs capabilities/delivery-pipeline/checks/*.cjs scripts/*.cjs; do
    node --check "$f" || { echo "syntax error in $f"; exit 1; }
  done
  for f in plugins/delivery-pipeline/scripts/*.sh scripts/*.sh tests/smoke/*.sh tests/unit/*.sh; do
    bash -n "$f" || { echo "syntax error in $f"; exit 1; }
  done
fi

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

while ((unit_next < ${#unit_files[@]} || unit_active_count > 0)); do
  while ((unit_next < ${#unit_files[@]} && unit_active_count < unit_workers)); do
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
    if [[ "$unit_progress" == 1 ]]; then
      echo "unit worker start: ${unit_files[$unit_next]}"
    fi
    # @invariant: Enable private worker process groups only during launch, suppressing asynchronous job notices.
    set -m
    HOME="$unit_worker/home" CODEX_HOME="$unit_worker/codex" \
      CLAUDE_CONFIG_DIR="$unit_worker/claude" TMPDIR="$unit_worker/tmp" \
      TMP="$unit_worker/tmp" TEMP="$unit_worker/tmp" \
      XDG_CONFIG_HOME="$unit_worker/config" XDG_CACHE_HOME="$unit_worker/cache" \
      XDG_STATE_HOME="$unit_worker/state" XDG_DATA_HOME="$unit_worker/data" \
      XDG_RUNTIME_DIR="$unit_worker/runtime" GIT_CONFIG_GLOBAL="$unit_worker/gitconfig" \
      GIT_CONFIG_NOSYSTEM=1 node "${unit_files[$unit_next]}" >"${unit_logs[$unit_next]}" 2>&1 &
    unit_pids[$unit_next]=$!
    unit_active[unit_active_count]=$!
    set +m
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
      unit_status=0
      wait "$unit_pid" || unit_status=$?
      if [[ "$unit_status" != 0 ]]; then failed=1; fi
      if [[ "$unit_progress" == 1 ]]; then
        for ((unit_index=0; unit_index<unit_next; unit_index++)); do
          if [[ "${unit_pids[$unit_index]:-}" == "$unit_pid" ]]; then
            echo "unit worker complete: ${unit_files[$unit_index]} status=$unit_status"
            break
          fi
        done
      fi
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
