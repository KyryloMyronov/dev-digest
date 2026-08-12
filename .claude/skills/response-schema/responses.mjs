// Extract the RESPONSE surface of this repo at a given git ref.
//
// "Response surface" is what a caller reads back from the API, which in
// DevDigest is assembled from three places:
//
//   1. contracts — exported Zod schemas under `server/src/vendor/shared/`.
//      These are the wire shapes. A handler returns its service's value and
//      Fastify serializes it; the contract is the only written-down description
//      of what comes back.
//   2. bindings — which contract an endpoint actually returns. No route in this
//      repo declares `schema: { response: … }` (verify: `grep -rn "response:"
//      server/src/modules/*/routes.ts`), so the binding lives on the CLIENT, in
//      the `api.get<Agent[]>('/agents')` generic. That generic is the repo's de
//      facto response declaration, so it is what this skill keys on. Route-side
//      `response:` schemas are read too and win when present.
//   3. the mirror — `client/src/vendor/shared/` is a hand-synced copy. When it
//      lags, the client's types describe a wire format the server no longer
//      sends, and both packages still compile.
//
// Node + a shallow scanner rather than the TypeScript compiler, on purpose:
// this reads files straight out of a git ref (`git show ref:path`) with no
// checkout, no install, and no tsconfig, and it must survive a branch that does
// not typecheck yet. What that costs is listed under "Parsing limits" in
// SKILL.md — read those before trusting a surprising finding.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  REPO_ROOT,
  git,
  matchesAny,
  sliceBalanced,
  stripComments,
  splitTopLevel,
  readExpression,
  lineAt,
  stringLiteral,
} from './lib.mjs';

/** Sentinel ref meaning "the working tree", so this runs before a commit. */
export const WORKTREE = 'WORKTREE';

const MAX_DEPTH = 14;

export const FILE_SETS = {
  contracts: ['server/src/vendor/shared/*.ts', 'server/src/vendor/shared/contracts/*.ts'],
  mirror: ['client/src/vendor/shared/*.ts', 'client/src/vendor/shared/contracts/*.ts'],
  routes: ['server/src/modules/*/routes.ts', 'server/src/app.ts'],
  // Every file a route's `schema:` may name, so a route-declared response
  // resolves even when the schema is local to the route file.
  schemas: [
    'server/src/vendor/shared/*.ts',
    'server/src/vendor/shared/contracts/*.ts',
    'server/src/modules/*/routes.ts',
    'server/src/modules/_shared/schemas.ts',
  ],
  callers: ['client/src/**/*.ts', 'client/src/**/*.tsx'],
};

/* ────────────────────────────── ref I/O ────────────────────────────── */

export function listFiles(ref) {
  const out =
    ref === WORKTREE
      ? git(['ls-files', '--cached', '--others', '--exclude-standard', '-z'])
      : git(['ls-tree', '-r', '--name-only', '-z', ref]);
  return out.split('\0').filter(Boolean);
}

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

/* ──────────────────────────── expression chain ──────────────────────────── */

/**
 * `Settings.partial()` → head `Settings`, calls `[partial]`.
 * `z.object({…}).extend({…})` → head `z`, calls `[object, extend]`.
 *
 * Modelling `z` as just another head is what lets one loop apply both the
 * builders (`z.object`) and the derivations (`.partial`) — the difference
 * between them is only which one comes first.
 */
function parseChain(text) {
  const t = text.trim();
  const m = /^([A-Za-z_$][\w$]*)/.exec(t);
  if (!m) return null;
  let i = m[0].length;
  const calls = [];
  while (i < t.length) {
    while (i < t.length && /\s/.test(t[i])) i++;
    if (t[i] !== '.') break;
    i++;
    while (i < t.length && /\s/.test(t[i])) i++;
    const nm = /^[A-Za-z_$][\w$]*/.exec(t.slice(i));
    if (!nm) break;
    i += nm[0].length;
    while (i < t.length && /\s/.test(t[i])) i++;
    let args = null;
    if (t[i] === '(') {
      const sliced = sliceBalanced(t, i);
      args = sliced.inner;
      i = sliced.end;
    }
    calls.push({ name: nm[0], args });
  }
  return { head: m[1], calls, rest: t.slice(i).trim() };
}

/** Zod calls that change nothing a caller can observe in the shape. */
const TRANSPARENT = new Set([
  'describe', 'refine', 'superRefine', 'brand', 'readonly', 'catch', 'strict',
  'strip', 'passthrough', 'catchall', 'min', 'max', 'length', 'email', 'url',
  'uuid', 'regex', 'trim', 'int', 'positive', 'nonnegative', 'negative',
  'gt', 'gte', 'lt', 'lte', 'startsWith', 'endsWith', 'datetime', 'coerce',
  'finite', 'safe', 'multipleOf', 'nonempty', 'toLowerCase', 'toUpperCase',
]);

/** Calls that mark a value absent-able rather than reshaping it. */
const PRESENCE = new Set(['optional', 'nullable', 'nullish', 'default']);

/* ─────────────────────────────── zod shapes ─────────────────────────────── */

const scalar = (type) => ({ kind: 'scalar', type });

/** Key set of `{ a: true, b: true }`, as used by `.pick()` / `.omit()`. */
function maskKeys(args) {
  if (!args) return [];
  return splitTopLevel(args.replace(/^\{|\}$/g, ''))
    .map((e) => /^(?:(['"])([^'"]+)\1|([A-Za-z_$][\w$]*))\s*:/.exec(e))
    .filter(Boolean)
    .map((m) => m[2] ?? m[3]);
}

/** Fields of a `z.object({…})` body, each resolved to a nested shape. */
function parseObjectFields(inner, ctx, depth) {
  const fields = {};
  for (const entry of splitTopLevel(inner)) {
    const m = /^(?:(['"])([^'"]+)\1|([A-Za-z_$][\w$]*))\s*:\s*([\s\S]+)$/.exec(entry);
    if (!m) continue;
    const name = m[2] ?? m[3];
    const shape = resolveZod(m[4].trim(), ctx, depth + 1);
    fields[name] = {
      required: !shape.optional,
      nullable: !!shape.nullable,
      type: shape.type ?? shape.kind,
      shape,
    };
  }
  return fields;
}

/** Merge two object shapes; `b` wins on a shared key. */
function mergeObjects(a, b) {
  if (a?.kind !== 'object' || b?.kind !== 'object')
    return { kind: 'opaque', text: 'intersection of non-objects' };
  return { kind: 'object', fields: { ...a.fields, ...b.fields } };
}

/** Apply `.partial()` / `.required()` — with or without an explicit key mask. */
function setRequired(shape, required, args) {
  if (shape.kind !== 'object') return shape;
  const only = maskKeys(args);
  const fields = {};
  for (const [k, f] of Object.entries(shape.fields)) {
    const touch = only.length === 0 || only.includes(k);
    fields[k] = touch ? { ...f, required } : f;
  }
  return { ...shape, fields };
}

/** Build the base shape from `z.<name>(args)`. */
function fromZod(name, args, ctx, depth) {
  switch (name) {
    case 'object':
    case 'strictObject':
    case 'looseObject': {
      const brace = args?.indexOf('{') ?? -1;
      const inner = brace === -1 ? (args ?? '') : sliceBalanced(args, brace).inner;
      return { kind: 'object', fields: parseObjectFields(inner, ctx, depth) };
    }
    case 'array':
      return { kind: 'array', of: resolveZod(args ?? '', ctx, depth + 1) };
    case 'enum':
    case 'nativeEnum': {
      const values = [...(args ?? '').matchAll(/(['"`])([^'"`]*)\1/g)].map((m) => m[2]);
      return { kind: 'enum', values };
    }
    case 'literal':
      return { kind: 'literal', value: stringLiteral(args ?? '') ?? (args ?? '').trim() };
    case 'union':
    case 'or': {
      const list = (args ?? '').trim();
      const open = list.indexOf('[');
      const inner = open === -1 ? list : sliceBalanced(list, open).inner;
      return { kind: 'union', members: splitTopLevel(inner).map((m) => resolveZod(m, ctx, depth + 1)) };
    }
    case 'discriminatedUnion': {
      const parts = splitTopLevel(args ?? '');
      const list = parts[1] ?? '';
      const open = list.indexOf('[');
      const inner = open === -1 ? list : sliceBalanced(list, open).inner;
      return {
        kind: 'union',
        discriminator: stringLiteral(parts[0] ?? '') ?? undefined,
        members: splitTopLevel(inner).map((m) => resolveZod(m, ctx, depth + 1)),
      };
    }
    case 'intersection': {
      const parts = splitTopLevel(args ?? '');
      return mergeObjects(resolveZod(parts[0] ?? '', ctx, depth + 1), resolveZod(parts[1] ?? '', ctx, depth + 1));
    }
    case 'tuple': {
      const list = (args ?? '').trim();
      const open = list.indexOf('[');
      const inner = open === -1 ? list : sliceBalanced(list, open).inner;
      return { kind: 'tuple', items: splitTopLevel(inner).map((m) => resolveZod(m, ctx, depth + 1)) };
    }
    case 'record': {
      const parts = splitTopLevel(args ?? '');
      return { kind: 'record', of: resolveZod(parts[parts.length - 1] ?? '', ctx, depth + 1) };
    }
    case 'lazy':
      return { kind: 'opaque', text: 'z.lazy' };
    default:
      return scalar(`z.${name}`);
  }
}

/**
 * Resolve a Zod expression to a comparable shape.
 *
 * Derived schemas (`.partial()`, `.pick()`, `.omit()`, `.merge()`,
 * `.required()`) are resolved into real field lists rather than recorded as an
 * opaque wrapper — `Settings.partial()` turning every field optional is exactly
 * the mandatory→optional change this skill exists to catch, and a wrapper it
 * cannot see through is a wrapper it cannot report.
 */
export function resolveZod(expr, ctx, depth = 0, seen = new Set()) {
  const text = (expr ?? '').trim().replace(/;$/, '');
  if (!text) return { kind: 'unknown', text: '' };
  if (depth > MAX_DEPTH) return { kind: 'opaque', text: 'max depth' };

  const chain = parseChain(text);
  if (!chain || chain.rest) return { kind: 'opaque', text: text.slice(0, 80) };

  let shape;
  let calls = chain.calls;

  if (chain.head === 'z') {
    let i = 0;
    while (i < calls.length && calls[i].name === 'coerce') i++; // `z.coerce.number()`
    if (i >= calls.length) return { kind: 'opaque', text };
    shape = fromZod(calls[i].name, calls[i].args, ctx, depth);
    calls = calls.slice(i + 1);
  } else {
    if (seen.has(chain.head)) return { kind: 'cycle', text: chain.head };
    const hit = ctx.index.lookup(chain.head, ctx.file);
    shape = hit
      ? resolveZod(hit.expr, { ...ctx, file: hit.file }, depth + 1, new Set([...seen, chain.head]))
      : { kind: 'ref', name: chain.head };
  }

  for (const call of calls) {
    if (TRANSPARENT.has(call.name)) continue;
    if (PRESENCE.has(call.name)) {
      if (call.name === 'nullable' || call.name === 'nullish') shape = { ...shape, nullable: true };
      if (call.name !== 'nullable') shape = { ...shape, optional: true };
      continue;
    }
    switch (call.name) {
      case 'array':
        shape = { kind: 'array', of: shape };
        break;
      case 'extend': {
        const brace = call.args?.indexOf('{') ?? -1;
        const inner = brace === -1 ? '' : sliceBalanced(call.args, brace).inner;
        shape =
          shape.kind === 'object'
            ? { ...shape, fields: { ...shape.fields, ...parseObjectFields(inner, ctx, depth) } }
            : shape;
        break;
      }
      case 'merge':
      case 'and':
        shape = mergeObjects(shape, resolveZod(call.args ?? '', ctx, depth + 1));
        break;
      case 'partial':
        shape = setRequired(shape, false, call.args);
        break;
      case 'required':
        shape = setRequired(shape, true, call.args);
        break;
      case 'pick':
      case 'omit': {
        if (shape.kind !== 'object') break;
        const keys = maskKeys(call.args);
        const keep = (k) => (call.name === 'pick' ? keys.includes(k) : !keys.includes(k));
        shape = {
          ...shape,
          fields: Object.fromEntries(Object.entries(shape.fields).filter(([k]) => keep(k))),
        };
        break;
      }
      case 'transform':
      case 'pipe':
        // The output type stops being the schema's own type; say so rather than
        // reporting field diffs that describe the input.
        shape = { kind: 'opaque', text: `${call.name}()`, transformed: true };
        break;
      default:
        break; // an unknown method is assumed not to reshape
    }
  }

  return shape;
}

/* ─────────────────────────── TypeScript type text ─────────────────────────── */

const TS_PRIMITIVES = new Set([
  'string', 'number', 'boolean', 'unknown', 'any', 'void', 'never', 'null',
  'undefined', 'bigint', 'symbol', 'object', 'Date',
]);

/**
 * Resolve the TypeScript text inside `api.get<…>()` to the same shape language.
 *
 * A bare identifier is looked up in the contract index, because the contracts
 * export `const Agent` and `type Agent = z.infer<typeof Agent>` under one name —
 * so `api.get<Agent>()` and the Zod contract are the same shape by construction.
 */
export function resolveTs(text, ctx, depth = 0, seen = new Set()) {
  let t = (text ?? '').trim();
  if (!t) return { kind: 'unknown', text: '' };
  if (depth > MAX_DEPTH) return { kind: 'opaque', text: 'max depth' };

  while (t.startsWith('(') && sliceBalanced(t, 0).end === t.length) t = sliceBalanced(t, 0).inner.trim();

  // `A | B` — a `| null` arm is nullability, anything else is a real union.
  const arms = splitTopLevelType(t, '|');
  if (arms.length > 1) {
    const nullish = arms.filter((a) => a === 'null' || a === 'undefined');
    const rest = arms.filter((a) => a !== 'null' && a !== 'undefined');
    if (rest.length === 1) {
      const inner = resolveTs(rest[0], ctx, depth + 1, seen);
      return {
        ...inner,
        nullable: inner.nullable || arms.includes('null'),
        optional: inner.optional || arms.includes('undefined'),
      };
    }
    return { kind: 'union', members: rest.map((a) => resolveTs(a, ctx, depth + 1, seen)) };
  }

  if (t.endsWith('[]')) return { kind: 'array', of: resolveTs(t.slice(0, -2), ctx, depth + 1, seen) };

  const generic = /^(Array|ReadonlyArray|Promise)\s*</.exec(t);
  if (generic) {
    const { inner } = sliceBalanced(t, t.indexOf('<'));
    const of = resolveTs(inner, ctx, depth + 1, seen);
    return generic[1] === 'Promise' ? of : { kind: 'array', of };
  }

  if (t.startsWith('{')) {
    const { inner } = sliceBalanced(t, 0);
    const fields = {};
    for (const entry of splitTopLevel(inner, [';', ','])) {
      const m = /^(?:(['"])([^'"]+)\1|([A-Za-z_$][\w$]*))\s*(\?)?\s*:\s*([\s\S]+)$/.exec(entry);
      if (!m) continue;
      const name = m[2] ?? m[3];
      const shape = resolveTs(m[5].trim(), ctx, depth + 1, seen);
      fields[name] = {
        required: !m[4] && !shape.optional,
        nullable: !!shape.nullable,
        type: shape.type ?? shape.kind,
        shape,
      };
    }
    return { kind: 'object', fields };
  }

  if (/^(['"`])/.test(t)) return { kind: 'literal', value: stringLiteral(t) ?? t };
  if (TS_PRIMITIVES.has(t)) return scalar(`ts.${t}`);

  const id = /^([A-Za-z_$][\w$]*)$/.exec(t);
  if (id) {
    if (seen.has(id[1])) return { kind: 'cycle', text: id[1] };
    const hit = ctx.index.lookup(id[1], ctx.file);
    if (hit) return resolveZod(hit.expr, { ...ctx, file: hit.file }, depth + 1, new Set([...seen, id[1]]));
    return { kind: 'ref', name: id[1] };
  }

  return { kind: 'opaque', text: t.slice(0, 80) };
}

/** Split a type on a top-level `|` or `&`, respecting `<>` as well as brackets. */
function splitTopLevelType(text, sep) {
  const parts = [];
  let start = 0;
  let depth = 0;
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === "'" || c === '"' || c === '`') {
      i = skipStringLocal(text, i);
      continue;
    }
    if ('([{<'.includes(c)) depth++;
    else if (')]}>'.includes(c)) depth--;
    else if (c === sep && depth === 0) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
    i++;
  }
  parts.push(text.slice(start));
  return parts.map((p) => p.trim()).filter(Boolean);
}

function skipStringLocal(src, i) {
  const q = src[i];
  i++;
  while (i < src.length) {
    if (src[i] === '\\') i += 2;
    else if (src[i] === q) return i + 1;
    else i++;
  }
  return i;
}

/* ─────────────────────────── surface construction ─────────────────────────── */

const DECL_RE = /(?:^|\n)\s*(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*(?::\s*[^=;]+)?=\s*/g;
const isSchemaExpr = (expr) => /\bz\s*\.|\.(extend|merge|partial|required|pick|omit|passthrough|strict)\s*\(/.test(expr);

/** name → declaration expression, across every file a response may reference. */
function buildSchemaIndex(ref, files, patterns) {
  const byFile = new Map();
  const byName = new Map();

  for (const file of files.filter((f) => matchesAny(f, patterns))) {
    const src = readAt(ref, file);
    if (!src) continue;
    const clean = stripComments(src);
    const perFile = new Map();
    for (const m of clean.matchAll(DECL_RE)) {
      const expr = readExpression(clean, m.index + m[0].length);
      if (!isSchemaExpr(expr) && !/^[A-Z][\w$]*(\s*\.|$)/.test(expr)) continue;
      perFile.set(m[1], expr);
      if (!byName.has(m[1])) byName.set(m[1], []);
      byName.get(m[1]).push({ file, expr });
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

/** Exported contracts in one file set, resolved to shapes. */
function collectContracts(ref, files, patterns, index) {
  const out = {};
  for (const file of files.filter((f) => matchesAny(f, patterns))) {
    const src = readAt(ref, file);
    if (!src) continue;
    const clean = stripComments(src);
    for (const m of clean.matchAll(/(?:^|\n)\s*export\s+const\s+([A-Za-z_$][\w$]*)\s*(?::\s*[^=;]+)?=\s*/g)) {
      const expr = readExpression(clean, m.index + m[0].length);
      if (!isSchemaExpr(expr) && !/^[A-Z][\w$]*(\s*\.|$)/.test(expr)) continue;
      out[m[1]] = {
        name: m[1],
        file,
        line: lineAt(clean, m.index) + 1,
        shape: resolveZod(expr, { index, file }),
      };
    }
  }
  return out;
}

/** `/repos/${id}/pulls` → `/repos/:param/pulls`; query string dropped. */
const normalizePath = (raw) =>
  raw.replace(/\$\{[^}]*\}/g, ':param').replace(/\?.*$/, '').replace(/\/+$/, '') || '/';

export const canonical = (path) => path.replace(/\$\{[^}]*\}/g, '*').replace(/:[A-Za-z_$][\w$]*/g, '*');
export const bindingKey = (b) => `${b.method} ${canonical(b.path)}`;

const CALLER_VERBS = ['get', 'post', 'put', 'patch', 'del', 'delete'];

/**
 * `api.get<Agent[]>('/agents')` call sites — the repo's response declarations.
 * The generic is sliced with balanced angle brackets rather than a lazy regex
 * so `api.post<{ status: string; jobId?: string }>` survives intact.
 */
function extractCallerBindings(src, file, ctx) {
  const clean = stripComments(src);
  const bindings = [];
  const re = new RegExp(`\\bapi\\s*\\.\\s*(${CALLER_VERBS.join('|')})\\s*(?=<)`, 'g');
  let m;
  while ((m = re.exec(clean))) {
    const lt = clean.indexOf('<', m.index);
    const { inner: typeText, end, unbalanced } = sliceBalanced(clean, lt);
    if (unbalanced) continue;
    let i = end;
    while (i < clean.length && /\s/.test(clean[i])) i++;
    if (clean[i] !== '(') continue;
    const args = splitTopLevel(sliceBalanced(clean, i).inner);
    const path = args[0] ? stringLiteral(args[0]) : null;
    if (!path || !path.startsWith('/')) continue;

    bindings.push({
      method: (m[1] === 'del' ? 'delete' : m[1]).toUpperCase(),
      path: normalizePath(path),
      typeText: typeText.trim(),
      shape: resolveTs(typeText.trim(), ctx),
      source: 'caller',
      file,
      line: lineAt(clean, m.index),
    });
    re.lastIndex = end;
  }
  return bindings;
}

/**
 * Route-declared `schema: { response: { 200: X } }`. None exist in this repo
 * today; when one is added it is authoritative and outranks the client generic.
 */
function extractRouteBindings(src, file, ctx) {
  const clean = stripComments(src);
  const bindings = [];
  const re = /\b(?:app|fastify|server|router|instance)\s*\.\s*(get|post|put|patch|delete|options|head)\s*(?:<[^<>()]*>)?\s*\(/g;
  let m;
  while ((m = re.exec(clean))) {
    const open = m.index + m[0].length - 1;
    const { inner, end } = sliceBalanced(clean, open);
    re.lastIndex = Math.max(re.lastIndex, end);
    const args = splitTopLevel(inner);
    const path = args[0] ? stringLiteral(args[0]) : null;
    if (!path || !path.startsWith('/')) continue;
    const opts = args[1]?.startsWith('{') ? args[1] : null;
    if (!opts) continue;

    const at = /\bschema\s*:\s*\{/.exec(opts);
    if (!at) continue;
    const schemaInner = sliceBalanced(opts, opts.indexOf('{', at.index + at[0].length - 1)).inner;
    for (const entry of splitTopLevel(schemaInner)) {
      const em = /^response\s*:\s*([\s\S]+)$/.exec(entry);
      if (!em) continue;
      const brace = em[1].indexOf('{');
      if (brace === -1) continue;
      for (const r of splitTopLevel(sliceBalanced(em[1], brace).inner)) {
        const rm = /^['"]?(\d{3}|[1-5]xx)['"]?\s*:\s*([\s\S]+)$/.exec(r);
        if (!rm) continue;
        if (!/^2/.test(rm[1])) continue; // only success payloads are the response contract
        bindings.push({
          method: m[1].toUpperCase(),
          path: normalizePath(path),
          status: rm[1],
          typeText: rm[2].trim(),
          shape: resolveZod(rm[2].trim(), { ...ctx, file }),
          source: 'route',
          file,
          line: lineAt(clean, m.index),
        });
      }
    }
  }
  return bindings;
}

/** Contract names a binding's type text mentions — used to mark them served. */
function referencedNames(typeText) {
  return [...(typeText ?? '').matchAll(/\b([A-Z][\w$]*)\b/g)].map((m) => m[1]);
}

/** The full response surface at `ref`. */
export function buildResponseSurface(ref) {
  const files = listFiles(ref);
  const index = buildSchemaIndex(ref, files, FILE_SETS.schemas);
  const ctx = { index, file: '' };

  const contracts = collectContracts(ref, files, FILE_SETS.contracts, index);

  const mirrorIndex = buildSchemaIndex(ref, files, FILE_SETS.mirror);
  const mirror = collectContracts(ref, files, FILE_SETS.mirror, mirrorIndex);

  const bindings = [];
  for (const file of files.filter((f) => matchesAny(f, FILE_SETS.routes))) {
    const src = readAt(ref, file);
    if (src) bindings.push(...extractRouteBindings(src, file, ctx));
  }
  for (const file of files.filter((f) => matchesAny(f, FILE_SETS.callers))) {
    const src = readAt(ref, file);
    if (src) bindings.push(...extractCallerBindings(src, file, { index, file }));
  }

  // A route-declared response outranks a client generic for the same endpoint.
  const byKey = new Map();
  for (const b of bindings) {
    const key = bindingKey(b);
    const prev = byKey.get(key);
    if (!prev || (b.source === 'route' && prev.source === 'caller')) byKey.set(key, { ...b, key });
    else if (prev.source === b.source) {
      prev.alsoAt = [...(prev.alsoAt ?? []), `${b.file}:${b.line}`];
    }
  }

  const served = new Set();
  for (const b of byKey.values()) for (const n of referencedNames(b.typeText)) served.add(n);

  return {
    ref,
    contracts,
    mirror,
    bindings: [...byKey.values()].sort((a, b) => a.key.localeCompare(b.key)),
    /** Contract names reachable over the wire, so unread schemas stay quiet. */
    served: [...served].sort(),
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const ref = process.argv[2] ?? WORKTREE;
  process.stdout.write(JSON.stringify(buildResponseSurface(ref), null, 2) + '\n');
}