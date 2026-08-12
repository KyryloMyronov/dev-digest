// Extract the API surface of this repo at a given git ref.
//
// "API surface" here is three things, because in DevDigest a wire break can
// come from any of them:
//
//   1. endpoints — `app.<verb>('/path')` inside the route files of the modules
//      that `src/modules/index.ts` actually registers. A module dropped from
//      that registry removes every one of its endpoints without touching a
//      single route file, so the registry is part of the surface.
//   2. contracts — the exported Zod schemas in `server/src/vendor/shared/`.
//      Routes here declare almost no `response:` schema (responses are typed by
//      the service return type), so the response wire format lives in the
//      contracts, not on the route.
//   3. consumers — the studio's `api.get/post/...` call sites, so a removed
//      endpoint can be reported with the code that still calls it.
//
// Node + regex rather than the TypeScript compiler on purpose: this must read
// files out of an arbitrary git ref (`git show ref:path`) without a checkout,
// install, or tsconfig, and it must survive a branch whose code does not
// typecheck yet. The parse is deliberately shallow — see PARSING LIMITS at the
// bottom of SKILL.md for what that costs.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { git, REPO_ROOT, matchesAny } from '../pr-self-review/lib.mjs';

/** Sentinel ref meaning "the working tree", so this runs before a commit. */
export const WORKTREE = 'WORKTREE';

const HTTP_VERBS = ['get', 'post', 'put', 'patch', 'delete', 'options', 'head'];

export const FILE_SETS = {
  routes: ['server/src/modules/*/routes.ts', 'server/src/app.ts'],
  registry: ['server/src/modules/index.ts'],
  contracts: ['server/src/vendor/shared/*.ts', 'server/src/vendor/shared/contracts/*.ts'],
  // Everything a route's `schema:` may reference by name.
  schemas: [
    'server/src/vendor/shared/*.ts',
    'server/src/vendor/shared/contracts/*.ts',
    'server/src/modules/*/routes.ts',
    'server/src/modules/_shared/schemas.ts',
  ],
  consumers: ['client/src/**/*.ts', 'client/src/**/*.tsx'],
};

/* ────────────────────────────── ref I/O ────────────────────────────── */

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

/* ─────────────────────── tiny TS/JS source scanner ─────────────────────── */

const PAIRS = { '(': ')', '{': '}', '[': ']' };

/** Index just past the string starting at `i`. Handles `${...}` in templates. */
function skipString(src, i) {
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

/** `{ inner, end }` for the bracket at `openIdx`; strings are skipped whole. */
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
    if (c === open) depth++;
    else if (c === close) {
      depth--;
      if (depth === 0) return { inner: src.slice(openIdx + 1, i), end: i + 1 };
    }
    i++;
  }
  return { inner: src.slice(openIdx + 1), end: src.length };
}

/**
 * Drop comments, keeping every newline so reported line numbers still match
 * the file on disk. A JSDoc block above a route is the single most common
 * source of a phantom `app.get(...)` match — those blocks document routes.
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

/** Split `a, b, c` on top-level commas only. */
export function splitTopLevel(text) {
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
    else if (c === ',' && depth === 0) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
    i++;
  }
  parts.push(text.slice(start));
  return parts.map((p) => p.trim()).filter(Boolean);
}

/** The expression starting at `i`, up to the top-level `;` or newline-ish end. */
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

/** `'/agents'` / `"/agents"` / `` `/agents` `` → `/agents`, else null. */
export function stringLiteral(text) {
  const t = text.trim();
  const m = /^(['"`])([\s\S]*)\1$/.exec(t);
  return m ? m[2] : null;
}

/* ───────────────────────────── zod shapes ───────────────────────────── */

/** Coarse type tag: `z.string().uuid()` → `z.string`, `Provider` → `Provider`. */
function typeTag(expr) {
  const z = /^z\s*\.\s*([A-Za-z]+)/.exec(expr.trim());
  if (z) return `z.${z[1]}`;
  const id = /^([A-Za-z_$][\w$]*)/.exec(expr.trim());
  return id ? id[1] : 'unknown';
}

/**
 * Fields of a `z.object({...})` body. `.optional()`/`.nullish()`/`.default()`
 * make a field non-required; `.nullable()` alone does NOT — the key must still
 * be present, so a required→nullable change is a value change, not a shape one.
 */
function parseObjectFields(inner) {
  const fields = {};
  for (const entry of splitTopLevel(inner)) {
    const m = /^(?:(['"])([^'"]+)\1|([A-Za-z_$][\w$]*))\s*:\s*([\s\S]+)$/.exec(entry);
    if (!m) continue;
    const name = m[2] ?? m[3];
    const expr = m[4].trim();
    fields[name] = {
      required: !/\.(optional|nullish|default)\s*\(/.test(expr),
      nullable: /\.(nullable|nullish)\s*\(/.test(expr),
      type: typeTag(expr),
    };
  }
  return fields;
}

/**
 * Resolve a schema expression to a comparable shape. Identifiers are looked up
 * in the ref's schema index — same file first, then anywhere — because a route
 * body is usually local while a response contract lives in `shared`.
 */
export function resolveShape(expr, index, file, seen = new Set(), depth = 0) {
  const text = (expr ?? '').trim().replace(/;$/, '');
  if (!text || depth > 8) return { kind: 'unknown', text };

  const objIdx = text.search(/z\s*\.\s*object\s*\(/);
  if (objIdx === 0) {
    const brace = text.indexOf('{', text.indexOf('('));
    if (brace !== -1) return { kind: 'object', fields: parseObjectFields(sliceBalanced(text, brace).inner) };
  }

  // `Base.extend({...})` — merge the base's fields with the extension's.
  const ext = /^([A-Za-z_$][\w$.]*)\s*\.\s*extend\s*\(/.exec(text);
  if (ext) {
    const base = resolveShape(ext[1], index, file, seen, depth + 1);
    const brace = text.indexOf('{', ext[0].length - 1);
    const own = brace === -1 ? {} : parseObjectFields(sliceBalanced(text, brace).inner);
    return { kind: 'object', fields: { ...(base.fields ?? {}), ...own } };
  }

  const arr = /^z\s*\.\s*array\s*\(/.exec(text);
  if (arr) {
    const { inner } = sliceBalanced(text, text.indexOf('('));
    return { kind: 'array', of: resolveShape(inner, index, file, seen, depth + 1) };
  }

  const enu = /^z\s*\.\s*enum\s*\(/.exec(text);
  if (enu) {
    const { inner } = sliceBalanced(text, text.indexOf('('));
    const values = [...inner.matchAll(/(['"`])([^'"`]*)\1/g)].map((m) => m[2]);
    return { kind: 'enum', values };
  }

  // `X.pick/omit/partial/…` — record the wrapper, don't pretend to model it.
  if (/^[A-Za-z_$][\w$.]*\s*\.\s*(pick|omit|partial|merge|and|or)\s*\(/.test(text))
    return { kind: 'derived', text: text.slice(0, 120) };

  // A bare identifier (possibly with a `.nullable()` tail) → follow it.
  const id = /^([A-Za-z_$][\w$]*)\s*(?:\.\s*(?:nullable|optional|nullish|describe)\s*\([^)]*\))*$/.exec(text);
  if (id) {
    const name = id[1];
    if (seen.has(name)) return { kind: 'cycle', text: name };
    const hit = index.lookup(name, file);
    if (hit) return resolveShape(hit.expr, index, hit.file, new Set([...seen, name]), depth + 1);
    return { kind: 'ref', text: name };
  }

  return { kind: 'other', text: typeTag(text) };
}

/* ─────────────────────────── surface builders ─────────────────────────── */

/** name → declaration expression, for every `const X = …` in the schema files. */
function buildSchemaIndex(ref, files) {
  const byFile = new Map(); // file → Map(name → expr)
  const byName = new Map(); // name → [{ file, expr }]

  for (const file of files.filter((f) => matchesAny(f, FILE_SETS.schemas))) {
    const src = readAt(ref, file);
    if (!src) continue;
    const clean = stripComments(src);
    const perFile = new Map();
    const re = /(?:^|\n)\s*(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*(?::\s*[^=;]+)?=\s*/g;
    let m;
    while ((m = re.exec(clean))) {
      const name = m[1];
      const expr = readExpression(clean, m.index + m[0].length);
      if (!/\bz\s*\.|\.extend\s*\(|^[A-Z][\w$]*$/.test(expr)) continue; // not a schema
      perFile.set(name, expr);
      if (!byName.has(name)) byName.set(name, []);
      byName.get(name).push({ file, expr, exported: /export\s+const/.test(m[0]) });
    }
    byFile.set(file, perFile);
  }

  return {
    byFile,
    byName,
    /** Same file wins; otherwise the first declaration of that name. */
    lookup(name, file) {
      const local = byFile.get(file)?.get(name);
      if (local) return { file, expr: local };
      const any = byName.get(name)?.[0];
      return any ? { file: any.file, expr: any.expr } : null;
    },
  };
}

/** Registered module name → route file, from `src/modules/index.ts`. */
function readRegistry(ref) {
  const src = readAt(ref, 'server/src/modules/index.ts');
  if (!src) return null;
  const clean = stripComments(src);

  const imports = new Map();
  for (const m of clean.matchAll(/import\s+([A-Za-z_$][\w$]*)\s+from\s+(['"])([^'"]+)\2/g)) {
    const rel = m[3].replace(/^\.\//, '').replace(/\.js$/, '.ts');
    imports.set(m[1], `server/src/modules/${rel}`);
  }

  const decl = /const\s+modules\s*(?::[^=]+)?=\s*\{/.exec(clean);
  if (!decl) return null;
  const { inner } = sliceBalanced(clean, clean.indexOf('{', decl.index + decl[0].length - 1));

  const registered = new Map();
  for (const entry of splitTopLevel(inner)) {
    const m = /^(?:([A-Za-z_$][\w$]*)\s*:\s*)?([A-Za-z_$][\w$]*)$/.exec(entry);
    if (!m) continue;
    const key = m[1] ?? m[2];
    registered.set(key, imports.get(m[2]) ?? null);
  }
  return registered;
}

/** `app.get('/x', …)` registrations in one file. */
function extractRoutes(src, file) {
  const clean = stripComments(src);
  const routes = [];
  const re = new RegExp(
    `\\b(?:app|fastify|server|router|instance)\\s*\\.\\s*(${HTTP_VERBS.join('|')})\\s*(?:<[^<>()]*>)?\\s*\\(`,
    'g',
  );
  let m;
  while ((m = re.exec(clean))) {
    const openIdx = m.index + m[0].length - 1;
    const { inner, end } = sliceBalanced(clean, openIdx);
    const args = splitTopLevel(inner);
    const path = args[0] ? stringLiteral(args[0]) : null;
    if (!path || !path.startsWith('/')) continue;

    const opts = args[1] && args[1].startsWith('{') ? args[1] : null;
    routes.push({
      method: m[1].toUpperCase(),
      path,
      file,
      line: lineAt(clean, m.index),
      schemaRefs: opts ? readSchemaRefs(opts) : {},
    });
    re.lastIndex = Math.max(re.lastIndex, end);
  }
  return routes;
}

/** `{ schema: { body: X, params: Y, querystring: Z, response: {200: R} } }`. */
function readSchemaRefs(optsText) {
  const at = /\bschema\s*:\s*\{/.exec(optsText);
  if (!at) return {};
  const { inner } = sliceBalanced(optsText, optsText.indexOf('{', at.index + at[0].length - 1));

  const refs = {};
  for (const entry of splitTopLevel(inner)) {
    const m = /^([A-Za-z_$][\w$]*)\s*:\s*([\s\S]+)$/.exec(entry);
    if (!m) continue;
    const [, key, expr] = m;
    if (key === 'response') {
      const brace = expr.indexOf('{');
      if (brace === -1) continue;
      refs.response = {};
      for (const r of splitTopLevel(sliceBalanced(expr, brace).inner)) {
        const rm = /^['"]?(\d{3})['"]?\s*:\s*([\s\S]+)$/.exec(r);
        if (rm) refs.response[rm[1]] = rm[2].trim();
      }
    } else if (['body', 'params', 'querystring', 'headers'].includes(key)) {
      refs[key] = expr.trim();
    }
  }
  return refs;
}

/** Studio call sites: `api.get<T>('/x')`, `apiFetch<T>('/x', {method})`, SSE. */
function extractConsumerCalls(src, file) {
  const clean = stripComments(src);
  const calls = [];
  const norm = (raw) =>
    raw
      .replace(/\$\{[^}]*\}/g, ':param') // `/repos/${id}` → `/repos/:param`
      .replace(/\?.*$/, '')
      .replace(/\/+$/, '') || '/';

  const helper = /\bapi\s*\.\s*(get|post|put|patch|del|delete)\s*(?:<[\s\S]*?>)?\s*\(\s*(['"`])([^'"`]*)\2/g;
  for (const m of clean.matchAll(helper)) {
    if (!m[3].startsWith('/')) continue;
    calls.push({
      method: (m[1] === 'del' ? 'delete' : m[1]).toUpperCase(),
      path: norm(m[3]),
      file,
      line: lineAt(clean, m.index),
    });
  }

  const raw = /\bapiFetch\s*(?:<[\s\S]*?>)?\s*\(\s*(['"`])([^'"`]*)\1([\s\S]{0,160}?)\)/g;
  for (const m of clean.matchAll(raw)) {
    if (!m[2].startsWith('/')) continue;
    const method = /method\s*:\s*['"`](\w+)['"`]/.exec(m[3]);
    calls.push({
      method: (method?.[1] ?? 'GET').toUpperCase(),
      path: norm(m[2]),
      file,
      line: lineAt(clean, m.index),
    });
  }

  // `new EventSource(`${API_BASE}/runs/${id}/events`)` and friends.
  for (const m of clean.matchAll(/API_BASE\}?([^'"`]*)/g)) {
    if (!m[1].startsWith('/')) continue;
    calls.push({ method: 'GET', path: norm(m[1]), file, line: lineAt(clean, m.index), sse: true });
  }

  return calls;
}

/**
 * `/agents/:id` → `/agents/*` — how two paths are compared for identity, so
 * renaming a path *parameter* is not mistaken for removing an endpoint.
 * `${…}` collapses too: `/findings/:id/${action}` is one route registration per
 * loop iteration (reviews/routes.ts), and the literal text is all we can see.
 */
export const canonical = (path) =>
  path.replace(/\$\{[^}]*\}/g, '*').replace(/:[A-Za-z_$][\w$]*/g, '*');
export const endpointKey = (e) => `${e.method} ${canonical(e.path)}`;

/**
 * Does `endpointPath` serve `callPath`? Segment-wise, where `*` on either side
 * matches any one segment. Deliberately loose in the same direction Fastify is:
 * a call to `/findings/x/accept` is served by `/findings/:id/${action}`.
 */
export function servesPath(endpointPath, callPath) {
  const a = canonical(endpointPath).split('/');
  const b = canonical(callPath).split('/');
  if (a.length !== b.length) return false;
  return a.every((seg, i) => seg === '*' || b[i] === '*' || seg === b[i]);
}

/**
 * The full surface at `ref`.
 * Endpoints from unregistered modules are collected too, but marked
 * `registered: false` — dropping a module from the registry is itself a break.
 */
export function buildSurface(ref) {
  const files = listFiles(ref);
  const index = buildSchemaIndex(ref, files);
  const registry = readRegistry(ref);
  const registeredFiles = new Set([...(registry?.values() ?? [])].filter(Boolean));

  const endpoints = [];
  for (const file of files.filter((f) => matchesAny(f, FILE_SETS.routes))) {
    const src = readAt(ref, file);
    if (!src) continue;
    const isModuleRoute = file !== 'server/src/app.ts';
    for (const r of extractRoutes(src, file)) {
      const shapes = {};
      for (const slot of ['body', 'params', 'querystring', 'headers']) {
        if (r.schemaRefs[slot]) shapes[slot] = resolveShape(r.schemaRefs[slot], index, file);
      }
      if (r.schemaRefs.response) {
        shapes.response = {};
        for (const [status, expr] of Object.entries(r.schemaRefs.response))
          shapes.response[status] = resolveShape(expr, index, file);
      }
      endpoints.push({
        ...r,
        key: endpointKey(r),
        registered: !isModuleRoute || registeredFiles.has(file),
        module: isModuleRoute ? file.split('/')[3] : 'app',
        shapes,
      });
    }
  }

  const contracts = {};
  for (const file of files.filter((f) => matchesAny(f, FILE_SETS.contracts))) {
    const src = readAt(ref, file);
    if (!src) continue;
    const clean = stripComments(src);
    for (const m of clean.matchAll(/(?:^|\n)\s*export\s+const\s+([A-Za-z_$][\w$]*)\s*(?::\s*[^=;]+)?=\s*/g)) {
      const name = m[1];
      const expr = readExpression(clean, m.index + m[0].length);
      if (!/\bz\s*\.|\.extend\s*\(|^[A-Z][\w$]*$/.test(expr)) continue;
      contracts[name] = { name, file, line: lineAt(clean, m.index), shape: resolveShape(expr, index, file) };
    }
  }

  const consumers = [];
  for (const file of files.filter((f) => matchesAny(f, FILE_SETS.consumers))) {
    const src = readAt(ref, file);
    if (src) consumers.push(...extractConsumerCalls(src, file));
  }

  return {
    ref,
    registry: registry ? [...registry.keys()] : null,
    endpoints,
    contracts,
    consumers: consumers.map((c) => ({ ...c, key: endpointKey(c) })),
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const ref = process.argv[2] ?? WORKTREE;
  process.stdout.write(JSON.stringify(buildSurface(ref), null, 2) + '\n');
}
