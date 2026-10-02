#!/usr/bin/env bash
set -euo pipefail

# ensure-gsd-core.sh — install or upgrade gsd-core for one runtime.
#
#   ensure-gsd-core.sh <claude|codex> [version]
#
# WHY THIS EXISTS. shipyard is a superstructure over GSD: the Codex generator
# requires gsd-core's `runtime-artifact-conversion.cjs` to convert commands, and
# reads its model catalog to map a tier to a concrete model. Until now the
# installers only CHECKED for it and printed a manual `npx` hint, so nothing kept
# the two in step — and they drifted three ways on the same machine:
#
#   Claude plugin (the slash commands actually invoked)  1.10.0
#   ~/.claude/gsd-core (what gsd-tools resolves)          1.9.1
#   ~/.codex/gsd-core  (what OUR generator reads)         older still
#
# The last line is the one that matters: Codex artifacts were being generated
# through the oldest install on the box.
#
# VERSION POLICY. Default is `latest`, because a superstructure that pins GSD
# forever silently rots against it — the skew above is what that looks like.
# Set `GSD_CORE_VERSION` when a project needs a reproducible host toolchain.
#
# This is a NETWORK operation that writes to the user's runtime home, so it says
# what it is doing and what changed.

isolation_env() {
  node - "$1" "$2" <<'NODE'
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { spawnSync } = require('node:child_process');
const [runtime, supplied] = process.argv.slice(2);
const fail = message => { throw new Error(`isolation refusal: ${message}`); };
try {
  if (!['claude', 'codex'].includes(runtime)) fail('unknown runtime');
  if (!supplied || !path.isAbsolute(supplied) || path.resolve(supplied) === path.parse(supplied).root)
    fail('an absolute bounded candidate root is required');
  function physical(value) {
    if (!value || !path.isAbsolute(value)) fail(`nonabsolute destination: ${value}`);
    let ancestor = path.resolve(value);
    while (!fs.existsSync(ancestor)) {
      try { fs.lstatSync(ancestor); fail(`dangling alias: ${ancestor}`); } catch (e) { if (e.code !== 'ENOENT') throw e; }
      ancestor = path.dirname(ancestor);
    }
    if (ancestor !== path.resolve(value) && !fs.statSync(ancestor).isDirectory()) fail(`non-directory ancestor: ${ancestor}`);
    return path.join(fs.realpathSync(ancestor), path.relative(ancestor, path.resolve(value)));
  }
  function systemSpelling(value) {
    let absolute = path.resolve(value);
    if (process.platform === 'darwin') for (const prefix of ['/var', '/tmp']) {
      if ((absolute === prefix || absolute.startsWith(prefix + path.sep)) && fs.realpathSync(prefix) === '/private' + prefix)
        absolute = '/private' + absolute;
    }
    return absolute;
  }
  const declaredRoot = systemSpelling(supplied);
  if (physical(supplied) !== declaredRoot) fail('candidate root has an unsafe alias ancestor');
  const root = physical(supplied), ambient = physical(process.env.SHIPYARD_ORIGINAL_HOME || process.env.HOME || os.homedir());
  const inside = (base, target) => target === base || target.startsWith(base + path.sep);
  const nativeHome = physical(os.userInfo().homedir);
  for (const protectedPath of [...new Set([ambient, nativeHome].flatMap(home => [home, ...['.codex', '.claude', '.gsd', '.agents', '.npm', '.cache', '.config', '.local/state/shipyard', '.local/state/shipyard/codex', '.local/state/shipyard/claude'].map(p => path.join(home, p))]))]) {
    const protectedRoot = physical(protectedPath);
    if (root === protectedRoot || inside(root, protectedRoot) || (![ambient, nativeHome].includes(protectedPath) && !protectedPath.endsWith('/.local/state/shipyard') && inside(protectedRoot, root)))
      fail(`candidate aliases active state: ${protectedPath}`);
  }
  const env = { SHIPYARD_ISOLATION_ROOT: root, SHIPYARD_ORIGINAL_HOME: ambient, HOME: path.join(root, '.shipyard-home') };
  const defaults = {
    CODEX_HOME: runtime === 'codex' ? root : path.join(root, 'codex'),
    CLAUDE_CONFIG_DIR: path.join(root, 'claude'), CLAUDE_HOME: path.join(root, 'claude'),
    AGENTS_SKILLS_DIR: path.join(env.HOME, '.agents/skills'), CODEX_AGENTS_MD: null,
    GSD_CAPABILITIES_DIR: path.join(env.HOME, '.gsd/capabilities'), GSD_CAPABILITIES_ROOT: path.join(env.HOME, '.gsd/capabilities'),
    XDG_STATE_HOME: path.join(env.HOME, '.local/state'), XDG_CACHE_HOME: path.join(env.HOME, '.cache'),
    XDG_CONFIG_HOME: path.join(env.HOME, '.config'), XDG_DATA_HOME: path.join(env.HOME, '.local/share'),
    npm_config_cache: path.join(env.HOME, '.npm'), npm_config_prefix: path.join(env.HOME, '.npm-prefix'),
    npm_config_logs_dir: path.join(env.HOME, '.npm/_logs'), npm_config_tmp: path.join(root, '.shipyard-tmp'),
    npm_config_userconfig: path.join(env.HOME, '.npmrc'), npm_config_globalconfig: path.join(env.HOME, '.npm-prefix/etc/npmrc'),
    TMPDIR: path.join(root, '.shipyard-tmp'), TMP: path.join(root, '.shipyard-tmp'), TEMP: path.join(root, '.shipyard-tmp'),
  };
  for (const [key, fallback] of Object.entries(defaults)) {
    const upper = key.startsWith('npm_config_') ? key.toUpperCase() : key;
    if (process.env[key] !== undefined && process.env[upper] !== undefined && process.env[key] !== process.env[upper]) fail(`conflicting ${key}`);
    env[key] = process.env[key] ?? process.env[upper] ?? fallback;
  }
  env.CODEX_AGENTS_MD ??= path.join(env.CODEX_HOME, 'AGENTS.md');
  if (runtime === 'claude') {
    const config = process.env.CLAUDE_CONFIG_DIR ?? process.env.CLAUDE_HOME ?? defaults.CLAUDE_HOME;
    if (process.env.CLAUDE_CONFIG_DIR && process.env.CLAUDE_HOME && process.env.CLAUDE_CONFIG_DIR !== process.env.CLAUDE_HOME) fail('conflicting Claude homes');
    env.CLAUDE_CONFIG_DIR = env.CLAUDE_HOME = config;
  }
  for (const key of ['GSD_DEFAULTS_PATH', 'GSD_HOME', 'SHIPYARD_DOGFOOD_ROOT']) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  const writable = {};
  function validate(value) {
    const resolved = physical(value);
    if (!inside(root, resolved)) fail(`destination escapes candidate HOME envelope: ${value}`);
    const lexical = systemSpelling(value);
    if (!inside(declaredRoot, lexical)) fail(`destination escapes candidate HOME envelope lexically: ${value}`);
    let cursor = lexical;
    while (inside(root, cursor) && cursor !== path.dirname(cursor)) {
      if (fs.existsSync(cursor) && fs.lstatSync(cursor).isSymbolicLink()) fail(`symlink destination: ${cursor}`);
      cursor = path.dirname(cursor);
    }
    if (fs.existsSync(value)) {
      const stat = fs.lstatSync(value);
      if (!stat.isDirectory() && !stat.isFile()) fail(`unsafe file kind: ${value}`);
      if (stat.isFile() && stat.nlink > 1) fail(`hardlink destination: ${value}`);
    }
    return resolved;
  }
  function npmExecutable(value) {
    if (path.basename(path.dirname(value)) !== '.bin' || path.basename(path.dirname(path.dirname(value))) !== 'node_modules') return false;
    const dependencyRoot = path.dirname(path.dirname(value));
    const dependencyRoots = [env.npm_config_cache, env.npm_config_prefix, path.join(root, 'npm'),
      path.join(env.CLAUDE_CONFIG_DIR, 'plugins/cache'), path.join(env.CODEX_HOME, 'plugins/cache')].map(physical);
    if (!dependencyRoots.some(base => inside(root, base) && inside(base, dependencyRoot))) return false;
    const subtree = validate(dependencyRoot);
    const target = fs.realpathSync(value);
    if (!inside(subtree, target)) fail(`npm executable escapes npm subtree: ${value}`);
    validate(target);
    const stat = fs.statSync(target);
    if (!stat.isFile() || stat.nlink !== 1) fail(`unsafe npm executable target: ${value}`);
    validate(path.dirname(value));
    return true;
  }
  function scan(value) {
    let stat;
    try { stat = fs.lstatSync(value); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
    if (stat.isSymbolicLink() && npmExecutable(value)) return;
    validate(value);
    if (fs.lstatSync(value).isDirectory()) for (const name of fs.readdirSync(value)) scan(path.join(value, name));
  }
  validate(root); scan(root);
  const fileKeys = new Set(['CODEX_AGENTS_MD', 'GSD_DEFAULTS_PATH', 'npm_config_userconfig', 'npm_config_globalconfig']);
  for (const [key, value] of Object.entries(env)) if (!['SHIPYARD_ORIGINAL_HOME', 'SHIPYARD_ISOLATION_ROOT'].includes(key)) {
    writable[key] = validate(value);
    if (fs.existsSync(value) && fs.statSync(value).isDirectory() === fileKeys.has(key)) fail(`wrong destination kind for ${key}: ${value}`);
  }
  for (const key of ['npm_config_userconfig', 'npm_config_globalconfig']) {
    if (fs.existsSync(env[key]) && fs.statSync(env[key]).size > 0) fail(`unverified npm configuration: ${env[key]}`);
  }
  for (const key of Object.keys(env).filter(k => k.startsWith('npm_config_'))) env[key.toUpperCase()] = env[key];
  const probe = spawnSync(process.execPath, ['-e', "process.stdout.write(JSON.stringify({home:require('node:os').homedir(),tmp:require('node:os').tmpdir()}))"],
    { env: { ...process.env, ...env }, encoding: 'utf8', timeout: 10000 });
  if (probe.error || probe.status !== 0) fail('Node native HOME probe failed');
  let actual; try { actual = JSON.parse(probe.stdout); } catch { fail('Node native HOME probe returned invalid JSON'); }
  if (validate(actual.home) !== physical(env.HOME)) fail('Node native HOME differs from private child HOME');
  validate(actual.tmp);
  writable.nativeDefaults = validate(path.join(actual.home, '.gsd/defaults.json'));
  process.stdout.write(JSON.stringify({ environment: env, writable }));
} catch (error) { console.error(error.message); process.exitCode = 3; }
NODE
}

prepare_isolation() {
  local RUNTIME="$1" RUNTIME_HOME="$2" ENVELOPE="${3:-}" ISOLATION_JSON
  if [[ -n "${SHIPYARD_ISOLATION_ROOT+x}" || -n "${SHIPYARD_DOGFOOD_ROOT:-}" || "${SHIPYARD_INSTALL_KIND:-}" == dogfood || "$RUNTIME_HOME" != "$HOME/.$RUNTIME" ]]; then
    if [[ "$RUNTIME" == codex && -z "$ENVELOPE" && -z "${SHIPYARD_ISOLATION_ROOT+x}" ]]; then ENVELOPE="$RUNTIME_HOME"; fi
    ISOLATION_JSON="$(isolation_env "$RUNTIME" "$ENVELOPE")" || return $?
    eval "$(printf '%s' "$ISOLATION_JSON" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{for(const [k,v] of Object.entries(JSON.parse(s).environment)) console.log("export "+k+"="+"\x27"+v.replaceAll("\x27", "\x27\\\x27\x27")+"\x27");});')"
    mkdir -p -m 700 "$HOME" "$TMPDIR" "$npm_config_cache" "$npm_config_prefix"
  fi
}

if [[ "${1:-}" == --library ]]; then return 0; fi

if [[ "${1:-}" == --isolation-env ]]; then
  isolation_env "${2:-}" "${3:-}"
  exit $?
fi

RUNTIME="${1:-}"
VERSION="${2:-${GSD_CORE_VERSION:-latest}}"

case "$RUNTIME" in
  claude|codex) ;;
  *) echo "usage: ensure-gsd-core.sh <claude|codex> [version]" >&2; exit 2 ;;
esac

command -v node >/dev/null 2>&1 || { echo "error: node not found on PATH" >&2; exit 1; }
RUNTIME_HOME="${CODEX_HOME:-$HOME/.codex}"
[[ "$RUNTIME" != claude ]] || RUNTIME_HOME="${CLAUDE_CONFIG_DIR:-${CLAUDE_HOME:-$HOME/.claude}}"
prepare_isolation "$RUNTIME" "$RUNTIME_HOME" "${SHIPYARD_ISOLATION_ROOT:-}"

command -v npx  >/dev/null 2>&1 || { echo "error: npx not found on PATH" >&2; exit 1; }

if [[ "$RUNTIME" == "claude" ]]; then
  HOME_DIR="${CLAUDE_CONFIG_DIR:-${CLAUDE_HOME:-$HOME/.claude}}"
  export CLAUDE_CONFIG_DIR="$HOME_DIR"
  FLAGS=(--claude --global --profile=full)
else
  HOME_DIR="${CODEX_HOME:-$HOME/.codex}"
  FLAGS=(--codex --global)
fi
CORE="$HOME_DIR/gsd-core"

# The install writes a VERSION file, so before/after is answerable exactly. Use
# it. Comparing directory trees instead is what produced a confidently wrong
# reading earlier — the npm package layout and the installed layout are different
# artifacts, so a file-count diff between them measures nothing.
installed_version() { cat "$CORE/VERSION" 2>/dev/null | tr -d '\n\r' || true; }

resolved="$VERSION"
if [[ "$VERSION" == "latest" ]]; then
  if ! resolved="$(npm view @opengsd/gsd-core version 2>/dev/null)"; then
    [[ -z "${SHIPYARD_ISOLATION_ROOT:-}" ]] || { echo "isolation dependency version query failed" >&2; exit 1; }
    resolved=latest
  fi
fi
prepare_isolation "$RUNTIME" "$RUNTIME_HOME" "${SHIPYARD_ISOLATION_ROOT:-}"
before="$(installed_version)"

if [[ -n "$before" ]]; then
  if [[ "$before" == "$resolved" ]]; then
    echo "→ gsd-core $before already current for $RUNTIME — reinstalling to be sure"
  else
    echo "→ gsd-core $before → $resolved for $RUNTIME"
  fi
else
  echo "→ gsd-core missing for $RUNTIME — installing $resolved"
fi

# @contract: Both runtimes require the GSD payload and enabled marketplace plugin.
if npx --yes "@opengsd/gsd-core@${VERSION}" "${FLAGS[@]}" </dev/null; then
  prepare_isolation "$RUNTIME" "$RUNTIME_HOME" "${SHIPYARD_ISOLATION_ROOT:-}"
  HOME_DIR="${CODEX_HOME:-$HOME/.codex}"
  [[ "$RUNTIME" != claude ]] || HOME_DIR="${CLAUDE_CONFIG_DIR:-${CLAUDE_HOME:-$HOME/.claude}}"
  CORE="$HOME_DIR/gsd-core"
  after="$(installed_version)"
  # Report what the FILE says, not what was asked for: an install that quietly
  # landed something else is exactly the case worth seeing.
  echo "✓ gsd-core ${after:-$resolved} installed for $RUNTIME → $CORE"
  if [[ -n "$after" && -n "$resolved" && "$resolved" != "latest" && "$after" != "$resolved" ]]; then
    echo "error: asked for $resolved, VERSION says $after" >&2
    exit 1
  fi
  # `[[ cond ]] && func` as the LAST statement returns 1 when cond is false, so on
  # codex this script exited 1 and the caller's `set -e` aborted the whole install
  # right after reporting success. An `if` has no such tail.
  node "$(dirname "${BASH_SOURCE[0]}")/ensure-gsd-plugin.cjs" "$RUNTIME"
  prepare_isolation "$RUNTIME" "$RUNTIME_HOME" "${SHIPYARD_ISOLATION_ROOT:-}"
else
  echo "⚠ gsd-core install failed for $RUNTIME (offline? npm registry unreachable?)." >&2
  # For Codex this IS fatal further down — the generator cannot convert a command
  # without gsd-core — so say that here rather than failing later with a stack.
  echo "  Dependency setup is incomplete; the Shipyard installation is stopped." >&2
  echo "  Install it manually when you have a network: npx --yes @opengsd/gsd-core@latest --${RUNTIME} --global" >&2
  exit 1
fi
