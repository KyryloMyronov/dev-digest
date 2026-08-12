// Shared helpers for the pr-self-review skill.
//
// Node rather than bash on purpose: every script here emits or consumes JSON
// and handles arbitrary repo paths. Quoting those safely in shell is a bug
// farm; `git -z` + Node string handling is not.

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

/** Absolute path to the repo root, from git itself rather than `../../..`. */
export const REPO_ROOT = execFileSync('git', ['rev-parse', '--show-toplevel'], {
  encoding: 'utf8',
}).trim();

/** Run git, return trimmed stdout. `soft` turns a non-zero exit into null. */
export function git(args, { soft = false } = {}) {
  try {
    return execFileSync('git', args, {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (err) {
    if (soft) return null;
    throw new Error(`git ${args.join(' ')} failed: ${err.message}`);
  }
}

/** Run a `-z` git command, return the NUL-separated tokens without the tail. */
export function gitZ(args) {
  const out = git(args);
  return out.split('\0').filter((t) => t !== '');
}

/**
 * Minimal glob → RegExp. Supports `**` (any depth), `**​/` (optional depth),
 * `*` (one segment) and `?`. No brace expansion — write two patterns instead,
 * so the rule table stays greppable.
 */
export function globToRegExp(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        if (glob[i + 2] === '/') {
          re += '(?:.*/)?'; // `**/x` also matches a bare `x`
          i += 2;
        } else {
          re += '.*';
          i += 1;
        }
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else if ('\\^$.|+()[]{}'.includes(c)) {
      re += '\\' + c;
    } else {
      re += c;
    }
  }
  return new RegExp(`^${re}$`);
}

const globCache = new Map();

/** True when `path` matches any glob in `patterns`. */
export function matchesAny(path, patterns) {
  return patterns.some((p) => {
    let re = globCache.get(p);
    if (!re) {
      re = globToRegExp(p);
      globCache.set(p, re);
    }
    return re.test(path);
  });
}

/** sha1 of a file's current bytes on disk, or null when it is gone. */
export function contentHash(relPath) {
  const abs = join(REPO_ROOT, relPath);
  if (!existsSync(abs)) return null;
  try {
    return createHash('sha1').update(readFileSync(abs)).digest('hex').slice(0, 12);
  } catch {
    return null;
  }
}

/** Read a repo-relative file, or null if unreadable (deleted, binary, gone). */
export function readRepoFile(relPath) {
  const abs = join(REPO_ROOT, relPath);
  if (!existsSync(abs)) return null;
  try {
    return readFileSync(abs, 'utf8');
  } catch {
    return null;
  }
}

/**
 * Added lines for one file across the whole changeset.
 *
 * `git diff <base> -- <path>` compares the base commit to the WORKING TREE, so
 * a single call covers committed + staged + unstaged. Untracked files have no
 * diff, so the caller passes their content through `untrackedAsAdded`.
 *
 * Returns `[{ line, text }]` with `line` being the 1-based number in the file
 * as it stands now — that is what a reviewer needs to point at.
 */
export function addedLines(base, relPath, { untracked = false } = {}) {
  if (untracked) {
    const content = readRepoFile(relPath);
    if (content === null) return [];
    return content.split('\n').map((text, i) => ({ line: i + 1, text }));
  }

  const out = git(['diff', '--unified=0', '--no-color', base, '--', relPath], { soft: true });
  if (!out) return [];

  const result = [];
  let cursor = 0;
  for (const raw of out.split('\n')) {
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
    if (hunk) {
      cursor = Number(hunk[1]);
      continue;
    }
    if (raw.startsWith('+++')) continue;
    if (raw.startsWith('+')) {
      result.push({ line: cursor, text: raw.slice(1) });
      cursor += 1;
    }
  }
  return result;
}

/** Pretty-print bytes-free severity ordering used everywhere in the report. */
export const SEVERITY_ORDER = ['critical', 'major', 'minor', 'info'];

export function bySeverity(a, b) {
  return SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity);
}
