#!/usr/bin/env node
'use strict';

// @contract: Run from the installed Codex package's host/scripts directory.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { ensure } = require('./ensure-gsd-plugin.cjs');
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));

function installedFilesMatch(home, nativeSkills, manifest) {
  if (!manifest?.agent_digests || !manifest.skill_digests || !manifest.bundle_digests) return false;
  const groups = [[path.join(home, 'agents'), manifest.agent_digests],
    [path.join(home, 'shipyard'), manifest.bundle_digests],
    [nativeSkills, Object.fromEntries(Object.entries(manifest.skill_digests).map(([name, value]) => [`${name}/SKILL.md`, value]))]];
  try {
    return groups.every(([root, files]) => Object.entries(files).every(([file, expected]) => {
      const target = path.resolve(root, file);
      return target.startsWith(root + path.sep) && !fs.lstatSync(target).isSymbolicLink()
        && hash(fs.readFileSync(target)) === expected;
    }));
  } catch { return false; }
}

function migrationCandidates(skillsDir, previous) {
  const candidates = [];
  for (const name of previous?.skills || []) {
    if (!/^shipyard-[a-z-]+$/.test(name)) throw new Error('Unsafe previous skill ownership record');
    const dir = path.join(skillsDir, name);
    if (!fs.existsSync(dir)) continue;
    if (fs.lstatSync(dir).isSymbolicLink() || !fs.lstatSync(dir).isDirectory()) {
      throw new Error(`Refusing to migrate non-directory ${dir}`);
    }
    const files = fs.readdirSync(dir);
    if (files.length !== 1 || files[0] !== 'SKILL.md' || fs.lstatSync(path.join(dir, 'SKILL.md')).isSymbolicLink()
      || hash(fs.readFileSync(path.join(dir, 'SKILL.md'))) !== previous.skill_digests?.[name]) {
      throw new Error(`Local modifications in ${dir}; preserve/reconcile them before marketplace migration`);
    }
    candidates.push(dir);
  }
  return candidates;
}

function bootstrap({ packageRoot = path.resolve(__dirname, '../..'), projectDir = process.cwd() } = {}) {
  const home = path.resolve(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'));
  const metadata = read(path.join(packageRoot, 'package-build.json'));
  const stateDir = path.join(home, 'shipyard-plugin');
  const marker = path.join(stateDir, 'installed.json');
  const skillsDir = process.env.AGENTS_SKILLS_DIR || path.join(os.homedir(), '.agents/skills');
  const nativeSkills = path.join(home, 'shipyard-native-skills');
  fs.mkdirSync(stateDir, { recursive: true });
  const lock = path.join(stateDir, 'install.lock');
  try { fs.mkdirSync(lock); } catch (error) {
    if (error.code === 'EEXIST') throw new Error(`Shipyard setup already running (lock: ${lock}); retry after it completes`);
    throw error;
  }
  try {
    let previous;
    try { previous = read(path.join(home, 'agents/.shipyard-manifest.json')); } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    const candidates = migrationCandidates(skillsDir, previous);
    // @contract: An unowned skill collision stops migration.
    for (const name of metadata.skills) {
      const target = path.join(skillsDir, name);
      if (fs.existsSync(target) && !candidates.includes(target)) throw new Error(`Unowned duplicate: ${target}`);
    }
    const gsd = ensure('codex');
    let current;
    try { current = read(marker); } catch {}
    if (current?.build === metadata.digest && current.gsd === gsd.version && candidates.length === 0
      && metadata.skills.every(s => fs.existsSync(path.join(nativeSkills, s, 'SKILL.md')))
      && installedFilesMatch(home, nativeSkills, previous)
      && fs.existsSync(path.join(home, 'shipyard/scripts/codex-runtime-host.cjs'))
      && fs.existsSync(path.join(home, 'gsd-core/bin/lib/runtime-artifact-conversion.cjs'))) return;

    const host = path.join(packageRoot, 'host');
    const capabilities = process.env.SHIPYARD_CODEX_CAPABILITIES_FILE || path.join(stateDir, 'capabilities.json');
    if (!process.env.SHIPYARD_CODEX_CAPABILITIES_FILE) {
      const { readCodexCliCapabilities } = require(path.join(host, 'scripts/gen-codex-shipyard.cjs'));
      fs.writeFileSync(capabilities, JSON.stringify(readCodexCliCapabilities(), null, 2) + '\n');
    }
    const env = { ...process.env, CODEX_HOME: home, AGENTS_SKILLS_DIR: nativeSkills,
      SHIPYARD_CODEX_MARKETPLACE: '1',
      SHIPYARD_PROJECT_DIR: projectDir, SHIPYARD_CODEX_CAPABILITIES_FILE: capabilities };
    // @contract: A matching GSD runtime needs no network reinstall per session.
    const versionFile = path.join(home, 'gsd-core/VERSION');
    const coreVersion = fs.existsSync(versionFile) ? fs.readFileSync(versionFile, 'utf8').trim() : null;
    env.GSD_CORE_VERSION = gsd.version;
    env.SHIPYARD_GSD_AUTO_INSTALL = coreVersion === gsd.version
      && fs.existsSync(path.join(home, 'gsd-core/bin/lib/runtime-artifact-conversion.cjs')) ? '0' : '1';
    const result = spawnSync('bash', [path.join(host, 'scripts/install-shipyard-codex.sh')],
      { env, stdio: 'inherit', timeout: 300000 });
    if (result.error || result.status !== 0) throw new Error(`Shipyard host setup failed: ${result.error?.message || result.status}`);

    // @contract: Back up exact owned originals outside skill discovery after host setup.
    const backup = fs.mkdtempSync(path.join(stateDir, 'previous-skills-'));
    const moved = [];
    try {
      for (const source of candidates) {
        const destination = path.join(backup, path.basename(source));
        fs.renameSync(source, destination);
        moved.push([source, destination]);
      }
    } catch (error) {
      for (const [source, destination] of moved.reverse()) fs.renameSync(destination, source);
      throw error;
    }
    fs.writeFileSync(marker, JSON.stringify({ build: metadata.digest, gsd: gsd.version, backup }, null, 2) + '\n');
    console.log('✓ Shipyard marketplace host ready. Start a new Codex session to load registered agents.');
  } finally { fs.rmdirSync(lock); }
}
module.exports = { bootstrap, migrationCandidates, installedFilesMatch };
if (require.main === module) {
  try { bootstrap(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
