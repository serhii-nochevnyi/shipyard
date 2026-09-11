'use strict';

// Runtime context is deliberately process-local. A checkout can be driven by
// Claude Code and Codex at the same time, so the project file must not be the
// place where the active host is persisted. GSD's own precedence is the model:
// an explicit runtime context wins, then the installed runtime marker, and the
// old project-level value is only a compatibility fallback.

const fs = require('fs');
const path = require('path');

const KNOWN_RUNTIMES = new Set(['claude', 'codex']);

function normalizeRuntime(value) {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase().replace(/[\s_]+/g, '-');
  if (!normalized) return null;
  if (['claude', 'claude-code', 'claude-cli'].includes(normalized)) return 'claude';
  if (['codex', 'codex-cli', 'codex-app'].includes(normalized)) return 'codex';
  // Preserve future runtime ids without allowing path/control characters into
  // diagnostics or route tokens.
  const safe = normalized.replace(/[^a-z0-9.-]/g, '');
  return safe || null;
}

function nonEmpty(value) {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

function readJsonRuntime(root) {
  if (!root) return null;
  try {
    const file = path.join(root, '.planning', 'config.json');
    if (!fs.existsSync(file)) return null;
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? normalizeRuntime(parsed.runtime)
      : null;
  } catch {
    // The config reader owns malformed-config diagnostics. Runtime resolution
    // is advisory and must not turn that diagnostic into a stack trace.
    return null;
  }
}

function markerFromCoreHome(coreHome) {
  const home = nonEmpty(coreHome);
  if (!home) return null;
  try {
    const marker = path.join(home, '.gsd-runtime');
    if (!fs.existsSync(marker)) return null;
    return normalizeRuntime(fs.readFileSync(marker, 'utf8'));
  } catch {
    return null;
  }
}

function markerFromTools(toolsPath) {
  const tools = nonEmpty(toolsPath);
  if (!tools) return null;
  // <runtime-home>/gsd-core/bin/gsd-tools.cjs → <runtime-home>/gsd-core
  return markerFromCoreHome(path.resolve(path.dirname(tools), '..'));
}

function markerFromPath(candidate) {
  const source = nonEmpty(candidate);
  if (!source) return null;
  const normalized = source.split(path.sep).join('/');
  // Installed Codex Shipyard scripts live under <CODEX_HOME>/shipyard; Claude
  // plugin scripts live under <CLAUDE_HOME>/.claude/plugins. Do not classify the
  // repository itself: `/claude-shipyard/` is a project name, not a runtime.
  if (/(^|\/)\.codex(?:\/|$)/.test(normalized)) return 'codex';
  if (/(^|\/)\.claude(?:\/|$)/.test(normalized)) return 'claude';
  return null;
}

function hostRuntime(env) {
  const codexSession = ['CODEX_SANDBOX', 'CODEX_SANDBOX_NETWORK_DISABLED']
    .some((key) => nonEmpty(env[key]));
  if (codexSession) return { runtime: 'codex', source: 'codex-session-env' };

  if (nonEmpty(env.CLAUDE_PLUGIN_ROOT) || nonEmpty(env.CLAUDE_CODE_ENTRYPOINT)) {
    return { runtime: 'claude', source: 'claude-session-env' };
  }
  return null;
}

// CODEX_HOME identifies an installed Codex configuration, not necessarily the
// runtime of the current process: a Claude session on a dual-runtime machine
// may inherit that variable too. It is therefore weaker than a session signal
// and weaker than an explicit legacy project value. Bundle paths and GSD's own
// marker remain stronger, because they belong to the install actually executing.
function installedRuntime(env) {
  const codexHome = nonEmpty(env.CODEX_HOME);
  if (!codexHome) return null;
  try {
    return fs.existsSync(path.join(codexHome, 'config.toml'))
      ? { runtime: 'codex', source: 'codex-config-home' }
      : null;
  } catch {
    // An unreadable home is not proof that the current process is Codex.
    return null;
  }
}

function resolveRuntime(root, options = {}) {
  const env = options.env || process.env;
  const persisted = readJsonRuntime(root);
  const candidates = [
    [options.runtime, 'option'],
    [env.SHIPYARD_RUNTIME, 'shipyard-env'],
    [env.GSD_RUNTIME, 'gsd-env'],
    [options.runtimeMarker, 'runtime-marker'],
    [markerFromTools(options.gsdTools || env.SHIPYARD_GSD_TOOLS || env.GSD_TOOLS), 'gsd-tools-marker'],
    [markerFromCoreHome(options.gsdCoreHome || env.GSD_CORE_HOME), 'gsd-core-marker'],
    [markerFromPath(options.scriptPath), 'bundle-path'],
  ];

  for (const [value, source] of candidates) {
    const runtime = normalizeRuntime(value);
    if (runtime) {
      return {
        runtime,
        source,
        persisted,
        conflict: persisted && persisted !== runtime ? { persisted, effective: runtime } : null,
      };
    }
  }

  const host = hostRuntime(env);
  if (host) {
    return {
      runtime: host.runtime,
      source: host.source,
      persisted,
      conflict: persisted && persisted !== host.runtime
        ? { persisted, effective: host.runtime }
        : null,
    };
  }

  const persistedRuntime = normalizeRuntime(persisted);
  if (persistedRuntime) {
    return { runtime: persistedRuntime, source: 'project-config-legacy', persisted: persistedRuntime, conflict: null };
  }

  const installed = installedRuntime(env);
  if (installed) {
    return { runtime: installed.runtime, source: installed.source, persisted, conflict: null };
  }

  const fallback = normalizeRuntime(options.defaultRuntime);
  return { runtime: fallback, source: fallback ? 'default' : 'ambiguous', persisted, conflict: null };
}

module.exports = {
  KNOWN_RUNTIMES,
  normalizeRuntime,
  readJsonRuntime,
  resolveRuntime,
};
