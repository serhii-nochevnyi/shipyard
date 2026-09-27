'use strict';

const fs = require('node:fs');
const path = require('node:path');

const GSD_PLUGIN_ID = 'gsd-core@gsd-core';

function installedGsdPluginRoot(configRoot) {
  const registry = path.join(configRoot, 'plugins', 'installed_plugins.json');
  let data;
  try {
    const stat = fs.lstatSync(registry);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) return null;
    data = JSON.parse(fs.readFileSync(registry, 'utf8'));
  } catch {
    return null;
  }
  const plugins = data && typeof data === 'object' && data.plugins && typeof data.plugins === 'object'
    ? data.plugins : data;
  const entries = plugins && Array.isArray(plugins[GSD_PLUGIN_ID]) ? plugins[GSD_PLUGIN_ID] : [];
  const entry = entries.find((item) => item && item.scope === 'user') || entries[0];
  if (!entry || typeof entry.installPath !== 'string' || !entry.installPath) return null;
  const cache = path.resolve(configRoot, 'plugins', 'cache');
  const root = path.resolve(entry.installPath);
  if (!root.startsWith(`${cache}${path.sep}`)) return null;
  return root;
}

// @contract: <config>/agents wins; else the GSD plugin installed under <config>/plugins/cache.
function claudeGsdAgentDirectory(configRoot, role) {
  const legacy = path.join(configRoot, 'agents');
  if (fs.existsSync(path.join(legacy, `${role}.md`))) return legacy;
  const plugin = installedGsdPluginRoot(configRoot);
  if (plugin && fs.existsSync(path.join(plugin, 'agents', `${role}.md`))) return path.join(plugin, 'agents');
  return legacy;
}

module.exports = { GSD_PLUGIN_ID, installedGsdPluginRoot, claudeGsdAgentDirectory };
