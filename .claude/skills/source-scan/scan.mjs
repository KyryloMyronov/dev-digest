// One source scanner for the skills that read this repo's TypeScript without
// compiling it.
//
// Three skills need the same two capabilities: read a file out of an arbitrary
// git ref with no checkout, and pick structure out of TS/JS source text with a
// bracket-aware scan rather than the compiler. Before this file, that logic
// existed twice — `api-breaking-changes/surface.mjs` and
// `response-schema/lib.mjs` — and the two copies had already drifted apart on
// the one detail that matters most (see ANGLE BRACKETS below), which cost a
// silent wrong answer and two superseding entries in the root `insights.md`.
//
// Why regex-and-brackets instead of the TypeScript compiler, in all callers:
// this has to read `git show <ref>:<path>` with no checkout, no install and no
// tsconfig, and it has to survive a branch whose code does not typecheck yet.
// The parse is deliberately shallow. Each calling skill documents what that
// costs it under its own "Parsing limits".
//
// ── ANGLE BRACKETS ──────────────────────────────────────────────────────────
// `<` IS in `PAIRS`, and that is safe for every caller. `sliceBalanced` moves
// depth only on `c === open` or `c === close`, where `open` is the character at
// the index you pass. So `<` participates in depth **only when you anchor the
// slice at a `<` yourself** — inside a `(`, `{` or `[` slice it is an ordinary
// character, and `a < 5 && b > 3` cannot unbalance anything.
//
// The hazard was never the pairing table; it is the call site. Anchor a slice at
// a `<` only where you have already proved that `<` opens a generic — e.g. after
// matching `/\bapi\s*\.\s*get\s*(?=<)/`, or at `t.indexOf('<')` in a string you
// know is a type expression. Do NOT go looking for the next `<` in arbitrary
// source, where it may be a comparison, JSX, or the arrow of `=>`.
//
// For a *fully wrapped* generic (`Promise<Agent[]>` in its entirety) do not slice
// at all — match greedily to the final `>`:
//   new RegExp('^' + wrapper + '\\s*<([\\s\\S]*)>$')
// That is cheaper and cannot be thrown off by a nested arrow.
//
// `=>` is stepped over before any depth accounting, so an arrow inside a type
// literal (`Array<{ cb: (x: number) => boolean }>`) cannot close an angle depth.
// That step is harmless for the other three bracket kinds, whose open/close
// characters are never `=` or `>`.
// ────────────────────────────────────────────────────────────────────────────

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/* ──────────────────────────────── git ──────────────────────────────── */

export const REPO_ROOT = execFileSync('git', ['rev-parse', '--show-toplevel'], {
  encoding: 'utf8',
}).trim();

/** Run git, return stdout. `soft` turns a non-zero exit into null. */
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

/* ──────────────────────────────── globs ──────────────────────────────── */

/** Minimal glob → RegExp: `**` any depth, `*` one segment, `?` one char. */
export function globToRegExp(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        if (glob[i + 2] === '/') {
          re += '(?:.*/)?';
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

/* ───────────────────────────── ref I/O ───────────────────────────── */

/** Sentinel ref meaning "the working tree", so a check runs before a commit. */
export const WORKTREE = 'WORKTREE';

/** All tracked paths at `ref`; for the working tree, tracked + untracked. */
export function listFiles(ref) {
  const out =
    ref === WORKTREE
      ? git(['ls-files', '--cached', '--others', '--exclude-standard', '-z'])
      : git(['ls-tree', '-r', '--name-only', '-z', ref]);
  return out.split('\0').filter(Boolean);
}

/** File content at `ref`, or null when the file does not exist there. */
export function readAt(ref, path) {
  if (ref === WORKTREE) {
    const abs = join(REPO_ROOT, path);
    if (!existsSync(abs)) return null;
    try {
      return readFileSync(abs, 'utf8');
    } catch {
      return null;
    }
  }
  return git(['show', `${ref}:${path}`], { soft: true });
}

/* ───────────────────────── source scanning ───────────────────────── */

const PAIRS = { '(': ')', '{': '}', '[': ']', '<': '>' };

/** Index just past the string starting at `i`. Handles `${…}` in templates. */
export function skipString(src, i) {
  const quote = src[i];
  i++;
  while (i < src.length) {
    const c = src[i];
    if (c === '\\') {
      i += 2;
      continue;
    }
    if (quote === '`' && c === '$' && src[i + 1] === '{') {
      i = sliceBalanced(src, i + 1).end;
      continue;
    }
    if (c === quote) return i + 1;
    i++;
  }
  return i;
}

/**
 * `{ inner, end }` for the bracket at `openIdx`; strings are skipped whole, and
 * `=>` is stepped over before any depth accounting.
 *
 * Anchoring at a `<` is allowed, and only valid where you have already proved
 * that `<` opens a generic — read ANGLE BRACKETS at the top of this file before
 * writing such a call. `unbalanced: true` marks the run-to-end fallback, which
 * is how a caller tells "the whole rest of the file" from a real slice.
 */
export function sliceBalanced(src, openIdx) {
  const open = src[openIdx];
  const close = PAIRS[open];
  let depth = 0;
  let i = openIdx;
  while (i < src.length) {
    const c = src[i];
    if (c === "'" || c === '"' || c === '`') {
      i = skipString(src, i);
      continue;
    }
    if (c === '=' && src[i + 1] === '>') {
      i += 2;
      continue;
    }
    if (c === open) depth++;
    else if (c === close) {
      depth--;
      if (depth === 0) return { inner: src.slice(openIdx + 1, i), end: i + 1 };
    }
    i++;
  }
  return { inner: src.slice(openIdx + 1), end: src.length, unbalanced: true };
}

/**
 * Drop comments, keeping every newline so reported line numbers still match the
 * file on disk.
 *
 * Not cosmetic: a JSDoc block above a route is the single most common source of
 * a phantom `app.get(...)` match, and the contract files are heavily JSDoc'd
 * with example payloads — parsing those as declarations invents fields that do
 * not exist.
 */
export function stripComments(src) {
  let out = '';
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) {
        if (src[i] === '\n') out += '\n';
        i++;
      }
      i += 2;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      const end = skipString(src, i);
      out += src.slice(i, end);
      i = end;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/**
 * Split on top-level separators only. `seps` defaults to `,`; pass `[',', ';']`
 * for a TypeScript type literal, whose members may use either.
 *
 * Depth counts `([{` only — angle brackets are deliberately not counted here,
 * because this runs over argument lists and object bodies where `<` is as likely
 * to be a comparison as a generic.
 */
export function splitTopLevel(text, seps = [',']) {
  const parts = [];
  let start = 0;
  let depth = 0;
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === "'" || c === '"' || c === '`') {
      i = skipString(text, i);
      continue;
    }
    if ('([{'.includes(c)) depth++;
    else if (')]}'.includes(c)) depth--;
    else if (seps.includes(c) && depth === 0) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
    i++;
  }
  parts.push(text.slice(start));
  return parts.map((p) => p.trim()).filter(Boolean);
}

/** The expression starting at `i`, up to the top-level `;` or end of input. */
export function readExpression(src, i) {
  const start = i;
  let depth = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === "'" || c === '"' || c === '`') {
      i = skipString(src, i);
      continue;
    }
    if ('([{'.includes(c)) depth++;
    else if (')]}'.includes(c)) depth--;
    else if (c === ';' && depth === 0) break;
    i++;
  }
  return src.slice(start, i).trim();
}

/** 1-based line number of `idx`, for `file:line` output. */
export const lineAt = (src, idx) => src.slice(0, idx).split('\n').length;

/** `'/agents'` / `"/agents"` / `` `/agents` `` → `/agents`, else null. */
export function stringLiteral(text) {
  const m = /^(['"`])([\s\S]*)\1$/.exec((text ?? '').trim());
  return m ? m[2] : null;
}
