'use strict';

// path-owner.cjs — the ONE answer to "does this `files_modified` entry own this
// path", asked by Gate 2's overlap check, the scope gate and base-merge.
//
// The three asked it separately and all three asked it wrong: each cut a
// declaration at its first wildcard character and treated the stump as a
// directory prefix. `src/foo*.ts` became `src/foo`, which owns `src/foo` and NOT
// `src/fooBar.ts`; `src/*.ts` became `src`, which owns everything under it
// including files that are not TypeScript. That is neither glob matching nor a
// directory contract, and it was wrong in both directions at once:
//
//   * Gate 2 PASSED two unordered tickets declaring `src/foo*.ts` and
//     `src/fooBar.ts` — a genuine collision, admitted.
//   * the scope gate REJECTED the first ticket's own legitimate edit to
//     `src/fooBar.ts` — a false blocker on a correct branch.
//   * base-merge classified that same file as undeclared, took the BASE's
//     edition over the ticket's implementation, committed it, and exited 0
//     reporting `resolved mechanically`. It is the only mechanical conflict
//     resolver the conveyor has, and it was deciding from a wrong owner.
//
// (Audit F01, 2026-09-07; ADR-004 D1.) So the matcher is exact BY CONSTRUCTION:
// it either answers precisely or reports that it cannot parse the declaration,
// and a declaration it cannot parse is a Gate 2 error rather than a guess. The
// grammar is deliberately small — three forms, listed in `parse` — because every
// form it accepts is a form all three callers must agree about, and the accepted
// set already covers every declaration in this repository.
//
// The asymmetry worth naming: a BARE path owns its subtree (`tests/fixtures`
// owns `tests/fixtures/a/b`) while a GLOB never reaches past the segment it
// matches (`src/*` does not own `src/a/b.ts`). The first is required — a
// declaration cannot be known to name a file rather than a directory without
// touching the working tree, and Gate 2 must not depend on the tree
// (`tests/fixtures` is a real declaration here for a directory that does not
// exist yet). The second is the conservative reading of a wildcard. Both gates
// and the overlap check share these answers, so a path that satisfies one cannot
// fail another.

// Characters that can never appear in an accepted declaration. `*` is handled by
// the grammar below; these have no meaning the matcher could answer exactly.
const FORBIDDEN = /[?[\]{}]/;

// Parse a `files_modified` declaration. Accepted, and nothing else:
//
//   - an exact path        `src/api/auth.ts`, `CLAUDE.md`
//   - a directory          `tests/fixtures`, `tests/fixtures/`, `tests/fixtures/**`
//   - one `*` inside ONE path segment, never crossing a separator:
//                          `src/*.ts`, `src/foo*.ts`, `src/*/x.ts`
//
// Returns `{kind, segs, subtree}` or `{error, decl}`. `kind` is `'file'` for an
// exact path, `'dir'` for an explicit directory spelling and `'glob'` when a
// segment carries the wildcard. `subtree` says whether the declaration owns
// everything beneath its match, which is what separates the first two forms from
// the third.
//
// The rejection always carries `decl`, because the caller reporting it is Gate 2
// and a Gate 2 error that does not name the entry is not actionable.
//
// (Written as line comments on purpose: a `*` before a separator closes a block
// comment, and every example in this file is a path pattern.)
function parse(decl) {
  const d = decl == null ? '' : String(decl);
  const reject = (error) => ({ error, decl: d });

  if (!d.trim()) return reject('the declaration is empty');
  const bad = d.match(FORBIDDEN);
  if (bad) {
    return reject(`"${bad[0]}" is not part of the accepted grammar (no character classes, braces or single-character wildcards)`);
  }

  // `dir/**` — the explicit subtree spelling. Everything before it must be
  // literal: `src/foo*/**` mixes a wildcard segment with a subtree and there is
  // no exact answer for it.
  if (d.endsWith('/**')) {
    const body = d.slice(0, -3).replace(/\/+$/, '');
    if (!body) return reject('`/**` with no directory before it would own the whole repository');
    if (body.includes('*')) return reject('`/**` after a wildcard segment has no exact answer — declare the directory, or the segment glob, not both');
    return { kind: 'dir', segs: body.split('/'), subtree: true };
  }
  // Any other `**` is either mid-pattern (`src/**/x.ts`) or a declaration owning
  // everything (`**`). Neither is answerable within this grammar.
  if (d.includes('**')) {
    return reject('`**` is accepted only as the trailing `dir/**` — a mid-pattern `**` crosses directory boundaries with no exact answer');
  }

  // `dir/` — the other explicit subtree spelling.
  if (/\/+$/.test(d)) {
    const body = d.replace(/\/+$/, '');
    if (!body) return reject('the declaration is just a separator');
    if (body.includes('*')) return reject('a trailing `/` after a wildcard segment has no exact answer');
    return { kind: 'dir', segs: body.split('/'), subtree: true };
  }

  const stars = (d.match(/\*/g) || []).length;
  if (stars === 0) {
    // A bare path. It owns itself AND its subtree: whether it names a file or a
    // directory is a fact about the working tree, and this matcher must answer
    // without one.
    return { kind: 'file', segs: d.split('/'), subtree: true };
  }
  if (stars > 1) {
    return reject('more than one `*` — the grammar accepts a single `*` inside one path segment');
  }
  return { kind: 'glob', segs: d.split('/'), subtree: false };
}

// Does one path SEGMENT match a segment pattern carrying at most one `*`?
function segMatch(pattern, seg) {
  const star = pattern.indexOf('*');
  if (star === -1) return pattern === seg;
  const pre = pattern.slice(0, star);
  const post = pattern.slice(star + 1);
  // `>=` and not `>`: the `*` may absorb nothing, so `foo*.ts` matches `foo.ts`.
  return seg.length >= pre.length + post.length && seg.startsWith(pre) && seg.endsWith(post);
}

// Can one path satisfy two segment patterns at once? With at most one `*` each,
// a witness exists iff the literal prefixes are prefix-compatible and the
// suffixes are suffix-compatible — and then `longerPrefix + longerSuffix` IS a
// witness. Built and checked rather than asserted, so the answer carries its own
// proof.
function segIntersect(a, b) {
  const ga = a.includes('*');
  const gb = b.includes('*');
  if (!ga && !gb) return a === b;
  if (!ga) return segMatch(b, a);
  if (!gb) return segMatch(a, b);
  const sa = a.indexOf('*');
  const sb = b.indexOf('*');
  const pa = a.slice(0, sa);
  const qa = a.slice(sa + 1);
  const pb = b.slice(0, sb);
  const qb = b.slice(sb + 1);
  const pre = pa.length >= pb.length ? pa : pb;
  const post = qa.length >= qb.length ? qa : qb;
  if (!pre.startsWith(pa) || !pre.startsWith(pb)) return false;
  if (!post.endsWith(qa) || !post.endsWith(qb)) return false;
  const witness = pre + post;
  return segMatch(a, witness) && segMatch(b, witness);
}

/**
 * Does `decl` own `p`?
 *
 * An unparseable declaration owns NOTHING. That is not the caller's licence to
 * pass one: Gate 2 rejects such an entry, and the two worktree gates refuse to
 * run against one, precisely because "owns nothing" would let base-merge take
 * the base's edition over a file it cannot reason about.
 */
function owns(decl, p) {
  const r = parse(decl);
  if (r.error) return false;
  const segs = String(p == null ? '' : p).replace(/\/+$/, '').split('/');
  if (r.subtree) {
    if (segs.length < r.segs.length) return false;
    for (let i = 0; i < r.segs.length; i++) if (r.segs[i] !== segs[i]) return false;
    return true;
  }
  if (segs.length !== r.segs.length) return false;
  for (let i = 0; i < r.segs.length; i++) if (!segMatch(r.segs[i], segs[i])) return false;
  return true;
}

/**
 * Could any single path satisfy BOTH declarations?
 *
 * This is Gate 2's overlap question, and it is deliberately not "do these look
 * alike": two unordered tickets whose declarations can intersect are an error,
 * so the answer must be about the set of paths each one admits.
 *
 * An unparseable declaration is assumed to collide. It fails closed on purpose —
 * Gate 2 reports the entry itself as an error, and while it is in the graph the
 * overlap question must never come back "safe".
 */
function mayIntersect(a, b) {
  const ra = parse(a);
  const rb = parse(b);
  if (ra.error || rb.error) return true;
  const n = Math.min(ra.segs.length, rb.segs.length);
  for (let i = 0; i < n; i++) if (!segIntersect(ra.segs[i], rb.segs[i])) return false;
  if (ra.segs.length === rb.segs.length) return true;
  // One declaration is deeper than the other. It can only be reached if the
  // shallower one owns a subtree — a glob stops at the segment it matches.
  const shorter = ra.segs.length < rb.segs.length ? ra : rb;
  return shorter.subtree === true;
}

/**
 * The leading LITERAL part of a declaration, for the validator's warnings (a
 * declaration with no literal prefix at all, i.e. one that leads with a wildcard
 * segment; a ticket whose paths all live under a top-level directory this repo
 * does not have).
 *
 * It stops at the first wildcard SEGMENT, which is the fix to the old
 * `globPrefix`: cutting at the wildcard CHARACTER produced `src/foo` from
 * `src/foo*.ts` and then compared it as a directory. Never used to decide
 * ownership — that is `owns`, and this is a hint for a human-readable message.
 */
function literalPrefix(decl) {
  const d = (decl == null ? '' : String(decl)).replace(/\/+$/, '');
  const out = [];
  for (const seg of d.split('/')) {
    if (/[*?[\]{}]/.test(seg)) break;
    out.push(seg);
  }
  return out.join('/');
}

/** Does the declaration carry a wildcard segment? (`dir/**` does not.) */
function isGlob(decl) {
  const r = parse(decl);
  return !r.error && r.kind === 'glob';
}

/**
 * The accepted grammar as one sentence, so every caller's error message says the
 * same thing. A gate that rejects without naming what it would accept sends the
 * reader to the source.
 */
const GRAMMAR =
  'accepted: an exact path (src/api/auth.ts), a directory (tests/fixtures, tests/fixtures/ or tests/fixtures/**), ' +
  'or a single * inside one path segment (src/*.ts, src/foo*.ts) — * never crosses /';

module.exports = { parse, owns, mayIntersect, literalPrefix, isGlob, segMatch, GRAMMAR };
