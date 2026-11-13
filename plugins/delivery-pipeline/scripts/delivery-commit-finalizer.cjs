'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { parse, owns } = require('./path-owner.cjs');
const prHygiene = require('./pr-hygiene.cjs');
const { resolveGraphDir } = require('./graph-dir.cjs');
const { scopeBase } = require('./diamond-parents.cjs');
const commitSigner = require('./commit-signer.cjs');
const { SCRATCH_FILES, isScratch } = require('./conveyor-scratch.cjs');
const MAX_GRAPH_BYTES = 8 * 1024 * 1024;

function fail(message, code) {
  const error = new Error(`delivery commit finalizer: ${message}`);
  if (code) error.code = code;
  throw error;
}

function graphRow(root, ticket) {
  const { dir, how } = resolveGraphDir([], root);
  let row;
  try {
    const file = path.join(dir, 'tickets.json');
    const stat = fs.lstatSync(file);
    if (how !== 'none' && stat.isFile() && !stat.isSymbolicLink() && stat.size <= MAX_GRAPH_BYTES) {
      const graph = JSON.parse(fs.readFileSync(file, 'utf8'));
      row = graph && graph.tickets && graph.tickets[ticket];
    }
  } catch {
    row = undefined;
  }
  if (!row || typeof row !== 'object' || typeof row.title !== 'string' || !row.title.trim()) {
    fail(`ticket ${ticket} has no canonical graph title to finalize a target-project commit subject`, 'TICKET_TITLE_UNAVAILABLE');
  }
  return row;
}

// @security: hygiene comes from the committed base and the title from the canonical graph, never agent text.
function finalizedSubject(ticket, root, base) {
  if (!prHygiene.applies({ root, ref: base })) {
    return `(${ticket}): finalize scoped changes`;
  }
  const row = graphRow(root, ticket);
  const title = row.title.trim();
  const subject = `${prHygiene.conventionalType(row.type)}: ${title[0].toLowerCase()}${title.slice(1)}`;
  const violations = prHygiene.check({ commits: [subject] }).violations
    .filter((violation) => violation.field === 'commits[0]');
  if (violations.length) {
    fail(`finalized commit subject failed pr-hygiene: ${violations.map((violation) => violation.rule).join(', ')}`,
      'COMMIT_SUBJECT_LEAK');
  }
  return subject;
}

function git(worktree, args, env, options = {}) {
  try {
    return execFileSync('git', ['-C', worktree, ...args], {
      encoding: options.binary ? 'buffer' : 'utf8',
      input: options.input,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      maxBuffer: 16 * 1024 * 1024,
    });
  } catch (error) {
    const detail = String(error.stderr || error.message).trim();
    fail(`git ${args[0]} failed${detail ? `: ${detail}` : ''}`);
  }
}

function verifiedSignature(root, commit, env) {
  try {
    return commitSigner.verifyCommitSignature(root, commit, { env });
  } catch (error) {
    if (error instanceof commitSigner.SignerError) fail(error.message);
    throw error;
  }
}

function entriesFromStatus(buffer) {
  const fields = buffer.toString('utf8').split('\0');
  const entries = [];
  for (let i = 0; i < fields.length - 1; i++) {
    const entry = fields[i];
    if (entry.length < 4 || entry[2] !== ' ') fail('unrecognized Git status entry');
    const status = entry.slice(0, 2);
    if (status.includes('U') || status === 'AA' || status === 'DD') fail('unmerged paths are present');
    entries.push({ path: entry.slice(3), status });
    if (/[RC]/.test(status)) {
      i++;
      if (i >= fields.length - 1) fail('incomplete Git rename status');
      entries.push({ path: fields[i], status });
    }
  }
  return entries;
}

function scopedStatus(worktree, env) {
  const entries = entriesFromStatus(git(worktree, ['status', '--porcelain=v1', '-z', '--untracked-files=all'], env, { binary: true }));
  for (const name of SCRATCH_FILES) {
    let file;
    try {
      file = fs.lstatSync(path.join(worktree, name));
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw error;
    }
    if (!file.isFile() || file.isSymbolicLink()) fail(`scratch document must be a regular non-symlink file: ${name}`);
  }
  const paths = new Set();
  for (const entry of entries) {
    if (entry.status === '??' && isScratch(entry.path, { forJudge: false })) {
      continue;
    } else {
      paths.add(entry.path);
    }
  }
  return [...paths];
}

function nulPaths(buffer) {
  return buffer.toString('utf8').split('\0').filter(Boolean);
}

function validDeclaration(declaration) {
  if (typeof declaration !== 'string' || !declaration || declaration.includes('\0') || declaration.includes('\\')) return false;
  const body = declaration.endsWith('/**') ? declaration.slice(0, -3) : declaration.replace(/\/+$/, '');
  if (body.startsWith('/') || body.split('/').some((segment) => !segment || segment === '.' || segment === '..')) return false;
  return !parse(declaration).error;
}

function requireOid(value, label) {
  if (typeof value !== 'string' || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value)) fail(`${label} must be a full commit ID`);
  return value;
}

function indexSnapshot(indexPath) {
  const stat = fs.lstatSync(indexPath, { bigint: true });
  if (!stat.isFile() || stat.isSymbolicLink()) fail('ordinary Git index must be a regular file');
  return { stat, bytes: fs.readFileSync(indexPath) };
}

function sameIndex(indexPath, original) {
  const current = indexSnapshot(indexPath);
  return current.bytes.equals(original.bytes) &&
    ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'].every((field) => current.stat[field] === original.stat[field]);
}

function indexEntries(worktree, env) {
  const entries = new Map();
  for (const entry of nulPaths(git(worktree, ['ls-files', '--stage', '-z'], env, { binary: true }))) {
    const tab = entry.indexOf('\t');
    if (tab < 0) fail('unrecognized Git index entry');
    entries.set(entry.slice(tab + 1), entry.slice(0, tab));
  }
  return entries;
}

function diamondTree(root, base, expectedBranch, env, graphDir) {
  const { dir, how } = resolveGraphDir(graphDir ? ['--graph', graphDir] : [], root);
  if (how === 'none') return null;
  let tickets;
  try {
    tickets = JSON.parse(fs.readFileSync(path.join(dir, 'tickets.json'), 'utf8')).tickets || {};
  } catch {
    return null;
  }
  const row = Object.values(tickets).find((candidate) => candidate && candidate.branch === expectedBranch);
  if (!row) return null;
  let measured;
  try {
    measured = scopeBase({ root, base, row, tickets, env });
  } catch (error) {
    fail(error.message);
  }
  return measured.kind === 'tree' ? measured.tree : null;
}

function caseCollisions(tracked, added) {
  const known = new Map();
  for (const file of tracked) {
    const parts = file.split('/');
    for (let length = 1; length <= parts.length; length += 1) {
      const prefix = parts.slice(0, length).join('/');
      const key = prefix.toLowerCase();
      if (!known.has(key)) known.set(key, new Set());
      known.get(key).add(prefix);
    }
  }
  const collisions = [];
  for (const file of added) {
    const parts = file.split('/');
    for (let length = 1; length <= parts.length; length += 1) {
      const prefix = parts.slice(0, length).join('/');
      const spellings = known.get(prefix.toLowerCase());
      if (spellings && !spellings.has(prefix)) { collisions.push({ path: file, existing: [...spellings][0] }); break; }
    }
  }
  return collisions;
}

function ignoresCase(root, env) {
  try {
    return execFileSync('git', ['-C', root, 'config', '--get', '--type=bool', 'core.ignorecase'],
      { encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'ignore'] }).trim() === 'true';
  } catch { return false; }
}

function scopeMatcher(declared, ignoreCase) {
  const fold = ignoreCase ? (value) => value.toLowerCase() : (value) => value;
  const folded = declared.map(fold);
  return Object.freeze({
    covered: (file) => folded.some((entry) => owns(entry, fold(file))),
    fold,
  });
}

function finalizeDeliveryCommit(options) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) fail('trusted host options are required');
  const { ticket, worktree, expectedBranch, expectedBase, expectedHead, expectedSigner } = options;
  const declared = options.files_modified;
  if (typeof ticket !== 'string' || !/^T-\d{2}-\d{2}$/.test(ticket)) fail('ticket must be a ticket ID');
  if (typeof worktree !== 'string' || !path.isAbsolute(worktree)) fail('worktree must be an absolute path');
  if (typeof expectedBranch !== 'string' || !expectedBranch) fail('expectedBranch is required');
  requireOid(expectedBase, 'expectedBase');
  requireOid(expectedHead, 'expectedHead');
  if (!Array.isArray(declared) || !declared.length || declared.some((entry) => !validDeclaration(entry))) {
    fail('files_modified must contain valid repository-relative declarations');
  }
  if (typeof expectedSigner !== 'string' || !expectedSigner.trim()) fail('expectedSigner is required');
  const { verificationEvidenceDigest } = options;

  const root = fs.realpathSync(worktree);
  const env = { ...process.env, GIT_OPTIONAL_LOCKS: '0' };
  delete env.GIT_INDEX_FILE;
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  delete env.GIT_COMMON_DIR;

  if (path.resolve(git(root, ['rev-parse', '--show-toplevel'], env).trim()) !== root) fail('worktree is not the repository root');
  const branchRef = git(root, ['symbolic-ref', '--quiet', 'HEAD'], env).trim();
  if (branchRef !== `refs/heads/${expectedBranch}`) fail('branch differs from expectedBranch');
  const head = git(root, ['rev-parse', '--verify', 'HEAD^{commit}'], env).trim();
  if (head !== expectedHead) fail('HEAD differs from expectedHead');
  const base = git(root, ['rev-parse', '--verify', `${expectedBase}^{commit}`], env).trim();
  if (base !== expectedBase) fail('base differs from expectedBase');
  let ancestor;
  try {
    ancestor = git(root, ['merge-base', base, head], env).trim();
  } catch {
    fail('expectedBase is not an ancestor of HEAD');
  }
  if (ancestor !== base) fail('expectedBase is not an ancestor of HEAD');
  const subject = finalizedSubject(ticket, root, base);

  const matcher = scopeMatcher(declared, ignoresCase(root, env));
  const covered = matcher.covered;
  const from = diamondTree(root, base, expectedBranch, env, options.graphDir) || base;
  const committed = nulPaths(git(root, ['diff', '--name-only', '-z', '--no-renames', from, head], env, { binary: true }));
  const status = scopedStatus(root, env);
  const outside = [...new Set([...committed, ...status].filter((file) => !covered(file)))];
  if (outside.length) fail(`out-of-scope paths: ${outside.join(', ')}`);
  const resume = !status.length && options.resumeCommitted === true;
  if (!status.length && !resume) fail('no worktree changes to commit');
  if (resume && !committed.length) fail('no committed changes to resume');
  if (resume && options.expectedTree === undefined) fail('resume requires expectedTree from fresh verification');

  if (typeof verificationEvidenceDigest !== 'string' || !/^[0-9a-f]{64}$/.test(verificationEvidenceDigest)) {
    fail('trusted finalization requires the signed verification evidence digest (SHA-256)');
  }

  const indexPath = path.resolve(root, git(root, ['rev-parse', '--git-path', 'index'], env).trim());
  const originalIndex = indexSnapshot(indexPath);

  const signingKey = git(root, ['config', '--get', 'user.signingkey'], env).trim();
  if (!signingKey) fail('host Git signer is not configured');
  try {
    commitSigner.signingFormat(root, env);
  } catch (error) {
    if (error instanceof commitSigner.SignerError) fail(error.message, error.code);
    throw error;
  }

  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'delivery-commit-index-'));
  const privateEnv = { ...env, GIT_INDEX_FILE: path.join(temporary, 'index') };
  try {
    git(root, ['read-tree', head], privateEnv);
    if (status.length) stageStatus(root, privateEnv, status, options.caseOnlyRenames);
    const staged = nulPaths(git(root, ['diff', '--cached', '--name-only', '-z', '--no-renames', head], privateEnv, { binary: true }));
    if (!staged.length && !resume) fail('no staged changes to commit');
    validateCaseTransition(root, from, privateEnv, options.caseOnlyRenames || []);
    const stagedOutside = staged.filter((file) => !covered(file));
    if (stagedOutside.length) fail(`out-of-scope staged paths: ${stagedOutside.join(', ')}`);
    const stagedFolded = new Set(staged.map(matcher.fold));
    if (status.some((file) => !stagedFolded.has(matcher.fold(file)))) fail('worktree changes could not all be staged');
    const originalEntries = indexEntries(root, env);
    const privateEntries = indexEntries(root, privateEnv);
    const originallyStaged = nulPaths(git(root, ['diff', '--cached', '--name-only', '-z', '--no-renames', head], env, { binary: true }));
    if (originallyStaged.some((file) => originalEntries.get(file) !== privateEntries.get(file))) {
      fail('staged index content differs from worktree content');
    }
    const currentStatus = scopedStatus(root, env);
    if (currentStatus.some((file) => !covered(file))) fail('out-of-scope changes appeared during finalization');
    if (currentStatus.length !== status.length || currentStatus.some((file) => !status.includes(file))) {
      fail('worktree paths changed during finalization');
    }
    if (nulPaths(git(root, ['diff', '--name-only', '-z'], privateEnv, { binary: true })).length) {
      fail('worktree content changed during finalization');
    }
    if (git(root, ['rev-parse', '--verify', 'HEAD^{commit}'], env).trim() !== head ||
        git(root, ['symbolic-ref', '--quiet', 'HEAD'], env).trim() !== branchRef) fail('branch moved during finalization');

    const tree = git(root, ['write-tree'], privateEnv).trim();
    if (options.expectedTree !== undefined && tree !== requireOid(options.expectedTree, 'expectedTree')) {
      fail('scoped tree differs from expectedTree');
    }
    const verificationTrailer = `\n\nShipyard-Verification-Evidence: ${verificationEvidenceDigest}`;
    const commit = git(root, ['commit-tree', '-S', tree, '-p', head], privateEnv, {
      input: `${subject}${verificationTrailer}\n`,
    }).trim();
    const signature = verifiedSignature(root, commit, env);
    if (!['G', 'U'].includes(signature.code) || signature.signer !== expectedSigner.trim()) {
      fail('commit signature does not match expectedSigner');
    }
    const recordedEvidenceDigest = verificationEvidenceDigestFromMessage(
      git(root, ['show', '-s', '--format=%B', commit], env));
    if (recordedEvidenceDigest !== verificationEvidenceDigest) {
      fail('signed commit does not bind the supplied verification evidence digest');
    }
    const lockPath = `${indexPath}.lock`;
    let lockFd;
    let ownsLock = false;
    try {
      lockFd = fs.openSync(lockPath, 'wx', 0o600);
      ownsLock = true;
      if (!sameIndex(indexPath, originalIndex)) fail('ordinary Git index changed during finalization');
      const finalStatus = scopedStatus(root, env);
      if (finalStatus.length !== status.length || finalStatus.some((file) => !status.includes(file)) ||
          nulPaths(git(root, ['diff', '--name-only', '-z'], privateEnv, { binary: true })).length) {
        fail('worktree changed during signing');
      }
      if (git(root, ['symbolic-ref', '--quiet', 'HEAD'], env).trim() !== branchRef ||
          git(root, ['rev-parse', '--verify', 'HEAD^{commit}'], env).trim() !== head) {
        fail('branch moved during signing');
      }
      fs.writeFileSync(lockFd, fs.readFileSync(privateEnv.GIT_INDEX_FILE));
      fs.fsyncSync(lockFd);
      fs.closeSync(lockFd);
      lockFd = undefined;
      git(root, ['update-ref', branchRef, commit, head], env);
      try {
        fs.renameSync(lockPath, indexPath);
        ownsLock = false;
      } catch (error) {
        git(root, ['update-ref', branchRef, head, commit], env);
        throw error;
      }
    } finally {
      if (lockFd !== undefined) fs.closeSync(lockFd);
      if (ownsLock) fs.rmSync(lockPath, { force: true });
    }
    return Object.freeze({ ticket, worktree: root, base, previousHead: head, commit, tree, signer: signature.signer, changed: resume ? committed : staged,
      verificationEvidenceDigest });
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

function validateCaseTransition(root, from, env, pairs) {
  const tracked = nulPaths(git(root, ['ls-tree', '-r', '-z', '--name-only', from], env, { binary: true }));
  const added = nulPaths(git(root, ['diff', '--cached', '--name-only', '-z', '--no-renames', '--diff-filter=A', from], env, { binary: true }));
  const removed = nulPaths(git(root, ['diff', '--cached', '--name-only', '-z', '--no-renames', '--diff-filter=D', from], env, { binary: true }));
  const seen = new Set();
  for (const pair of pairs) {
    if (!pair || typeof pair.from !== 'string' || typeof pair.to !== 'string' || pair.from === pair.to
        || pair.from.toLowerCase() !== pair.to.toLowerCase() || seen.has(pair.from.toLowerCase())
        || !tracked.includes(pair.from) || tracked.includes(pair.to) || !removed.includes(pair.from) || !added.includes(pair.to)) {
      fail('case-only rename differs from the exact tracked removal and addition');
    }
    seen.add(pair.from.toLowerCase());
  }
  const collisions = caseCollisions(tracked.filter(file => !pairs.some(pair => pair.from === file)), added);
  if (collisions.length) fail('case-colliding paths: ' + collisions.map(pair => pair.path + ' differs only in letter case from tracked ' + pair.existing).join('; '));
}

function caseOnlyRenamesFromPlan(text, declarations) {
  const { data, errors } = require('./frontmatter.cjs').parseFrontmatter(text);
  const pairs = data?.case_only_renames;
  if (pairs === undefined) return [];
  if (errors.length || !Array.isArray(pairs) || pairs.length > 32
      || !['review', 'merge', true].includes(data?.delivery?.human_checkpoint)) fail('case_only_renames requires a reviewed plan checkpoint');
  const seen = new Set();
  for (const pair of pairs) {
    if (!pair || Object.keys(pair).sort().join(',') !== 'from,to'
        || !validDeclaration(pair.from) || !validDeclaration(pair.to)
        || /[?*[]/.test(pair.from + pair.to) || pair.from === pair.to
        || pair.from.toLowerCase() !== pair.to.toLowerCase()
        || !declarations.includes(pair.from) || !declarations.includes(pair.to)
        || seen.has(pair.from.toLowerCase())) fail('invalid or undeclared case_only_renames pair');
    seen.add(pair.from.toLowerCase());
  }
  return pairs.map(pair => Object.freeze({ ...pair }));
}

function stageStatus(root, env, status, pairs = []) {
  if (!pairs.length) {
    if (status.length) git(root, ['add', '--all', '--', ...status.map(file => `:(literal)${file}`)], env);
    return;
  }
  const tracked = nulPaths(git(root, ['ls-files', '-z'], env, { binary: true }));
  pairs = pairs.filter(pair => tracked.includes(pair.from));
  const allowed = pairs.map(pair => pair.from);
  const collisions = caseCollisions(tracked.filter(file => !allowed.includes(file)), status.filter(file => !allowed.includes(file)));
  if (collisions.length) fail('case-colliding paths: ' + collisions.map(pair => pair.path + ' differs only in letter case from tracked ' + pair.existing).join('; '));
  for (const pair of pairs) {
    if (!tracked.includes(pair.from) || tracked.includes(pair.to) || !status.includes(pair.from) || !status.includes(pair.to)) {
      fail('case-only rename no longer matches the admitted tracked removal and addition');
    }
    git(root, ['update-index', '--force-remove', '--', pair.from], env);
  }
  const paths = status.filter(file => !allowed.includes(file));
  if (paths.length) git(root, ['-c', 'core.ignorecase=false', 'add', '--all', '--', ...paths.map(file => `:(literal)${file}`)], env);
}

function executorCandidate(options) {
  const root = fs.realpathSync(options.worktree);
  const env = { ...process.env };
  for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE']) delete env[key];
  const head = git(root, ['rev-parse', '--verify', 'HEAD^{commit}'], env).trim();
  if (git(root, ['symbolic-ref', '--quiet', '--short', 'HEAD'], env).trim() !== options.expectedBranch) {
    fail('executor branch changed during dispatch');
  }
  if (git(root, ['merge-base', options.expectedHead, head], env).trim() !== options.expectedHead) {
    fail('executor HEAD is not a descendant of its admitted HEAD');
  }
  if (git(root, ['merge-base', options.expectedBase, head], env).trim() !== options.expectedBase) {
    fail('executor base is not an ancestor of HEAD');
  }
  const from = diamondTree(root, options.expectedBase, options.expectedBranch, env, options.graphDir) || options.expectedBase;
  const changed = nulPaths(git(root, ['diff', '--name-only', '-z', '--no-renames', from, head], env, { binary: true }));
  const status = scopedStatus(root, env);
  if (head !== options.expectedHead && status.length) fail('executor HEAD moved and the worktree is not clean for resume');
  const { covered } = scopeMatcher(options.files_modified, ignoresCase(root, env));
  if ([...changed, ...status].some(file => !covered(file))) fail('executor candidate has out-of-scope paths');
  if (!status.length && !changed.length) fail('no committed changes or worktree changes to finalize');
  return Object.freeze({ ...options, expectedHead: head, resumeCommitted: status.length === 0, resumeDiffBase: from, committedPaths: changed });
}

function verificationEvidenceDigestFromMessage(message) {
  if (typeof message !== 'string') return null;
  const trailers = message.split(/\r?\n/).filter((line) => line.startsWith('Shipyard-Verification-Evidence:'));
  if (!trailers.length) return undefined;
  if (trailers.length !== 1) return null;
  const match = /^Shipyard-Verification-Evidence: ([0-9a-f]{64})$/.exec(trailers[0]);
  return match ? match[1] : null;
}

function scopedTree(options) {
  if (!options || typeof options !== 'object') fail('trusted host options are required');
  const declared = options.files_modified;
  if (!Array.isArray(declared) || !declared.length || declared.some((entry) => !validDeclaration(entry))) {
    fail('files_modified must contain valid repository-relative declarations');
  }
  const root = fs.realpathSync(options.worktree);
  const env = { ...process.env, GIT_OPTIONAL_LOCKS: '0' };
  for (const key of ['GIT_INDEX_FILE', 'GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR']) delete env[key];
  const head = git(root, ['rev-parse', '--verify', 'HEAD^{commit}'], env).trim();
  if (options.expectedHead !== undefined && head !== requireOid(options.expectedHead, 'expectedHead')) {
    fail('HEAD differs from expectedHead');
  }
  const status = scopedStatus(root, env);
  const { covered } = scopeMatcher(declared, ignoresCase(root, env));
  const outside = status.filter((file) => !covered(file));
  if (outside.length) fail(`out-of-scope paths: ${outside.join(', ')}`);
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'delivery-scoped-tree-'));
  const privateEnv = { ...env, GIT_INDEX_FILE: path.join(temporary, 'index') };
  try {
    git(root, ['read-tree', head], privateEnv);
    if (status.length) if (status.length) stageStatus(root, privateEnv, status, options.caseOnlyRenames);
    const changed = nulPaths(git(root, ['diff', '--cached', '--name-only', '-z', '--no-renames', head], privateEnv, { binary: true }));
    return Object.freeze({ head, tree: git(root, ['write-tree'], privateEnv).trim(), changed: Object.freeze(changed) });
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

module.exports = Object.freeze({ finalizeDeliveryCommit, executorCandidate, caseOnlyRenamesFromPlan, caseCollisions, scopeMatcher, scopedTree, verificationEvidenceDigestFromMessage });
