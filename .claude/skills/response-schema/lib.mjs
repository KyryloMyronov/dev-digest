// Self-contained helpers for the response-schema skill.
//
// Deliberately NOT importing from `../pr-self-review/lib.mjs`: this skill has to
// keep working when run on its own (a CI job that checks out only `.claude/`,
// a copy dropped into another repo), and the scanner below diverges from the
// one there anyway — it resolves derived Zod schemas and TypeScript type
// literals, which the endpoint-oriented scanner has no need for.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

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

/* ───────────────────────────── source scanning ───────────────────────────── */

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
 * `{ inner, end }` for the bracket at `openIdx`; strings are skipped whole.
 * `<` counts as a bracket so a generic argument can be sliced, but `=>` is
 * stepped over first so an arrow inside a type literal cannot close a depth.
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
 * file. Contract files are heavily JSDoc'd and those blocks contain example
 * payloads — parsing them as declarations invents fields that do not exist.
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

/** Split on top-level separators only (`,` plus, for type literals, `;`). */
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

/** The expression starting at `i`, up to the top-level `;`. */
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

export const lineAt = (src, idx) => src.slice(0, idx).split('\n').length;

/** `'/agents'` → `/agents`, else null. */
export function stringLiteral(text) {
  const m = /^(['"`])([\s\S]*)\1$/.exec((text ?? '').trim());
  return m ? m[2] : null;
}

export const SEVERITY_ORDER = ['critical', 'major', 'minor', 'info'];

/** One step gentler; `info` is the floor. */
export function downgrade(severity) {
  const i = SEVERITY_ORDER.indexOf(severity);
  return SEVERITY_ORDER[Math.min(i + 1, SEVERITY_ORDER.length - 1)];
}