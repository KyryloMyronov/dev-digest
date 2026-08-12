// Extract the *response* surface of this repo at a given git ref.
//
// The response surface is "for every reachable endpoint, what shape does a
// caller get back". In DevDigest almost no route declares `response:`, so that
// question cannot be answered from the route file alone. It is answered by
// following a three-link chain:
//
//   app.get('/agents', async () => service.list(workspaceId))   routes.ts
//     → async list(ws: string): Promise<Agent[]>                service.ts
//       → export const Agent = z.object({...})                  vendor/shared
//
// That chain is why this skill exists next to `api-breaking-changes`, which
// compares the contracts as a flat set and cannot say which endpoint serves
// one. Here a finding names the endpoint, so "is this response still safe to
// read" is answerable per URL.
//
// Same engineering constraints as the sibling: read files straight out of a git
// ref with no checkout, no install, no tsconfig, and survive a branch that does
// not typecheck yet. The low-level source scanner is imported from that skill
// rather than duplicated; the Zod resolution is our own (`shapes.mjs`) because
// it has to resolve `.partial()` and friends.

import {
  WORKTREE,
  listFiles,
  readAt,
  lineAt,
  sliceBalanced,
  splitTopLevel,
  stringLiteral,
  stripComments,
  readExpression,
} from '../api-breaking-changes/surface.mjs';
import { matchesAny } from '../pr-self-review/lib.mjs';
import { resolveShape, typeOf } from './shapes.mjs';

export { WORKTREE, readAt, listFiles };

const HTTP_VERBS = ['get', 'post', 'put', 'patch', 'delete', 'options', 'head'];

export const FILE_SETS = {
  routes: ['server/src/modules/*/routes.ts', 'server/src/app.ts'],
  registry: ['server/src/modules/index.ts'],
  contracts: ['server/src/vendor/shared/*.ts', 'server/src/vendor/shared/contracts/*.ts'],
  // Anything that can name or declare a response shape.
  schemas: [
    'server/src/vendor/shared/*.ts',
    'server/src/vendor/shared/contracts/*.ts',
    'server/src/modules/*/routes.ts',
    'server/src/modules/*/service.ts',
    'server/src/modules/_shared/schemas.ts',
  ],
  // Where a route's return type is declared.
  services: ['server/src/modules/*/service.ts', 'server/src/modules/*/*.ts'],
  readers: ['client/src/**/*.ts', 'client/src/**/*.tsx'],
};

/* ─────────────────────────── the name index ─────────────────────────── */

/**
 * `name → declaration`, over every Zod schema and every `z.infer` type alias in
 * the schema file set.
 *
 * The alias half matters because a service returns the *type* (`Promise<Agent>`)
 * while the shape lives on the *schema*. In `shared` both are named the same
 * (`export const Agent` + `export type Agent = z.infer<typeof Agent>`), but
 * `export type PrDetail = z.infer<typeof PrDetailSchema>` also occurs, and
 * without the alias map that response resolves to nothing.
 */
function buildIndex(ref, files) {
  const byFile = new Map(); // file → Map(name → expr)
  const byName = new Map(); // name → [{ file, expr }]
  const aliases = new Map(); // type name → schema name

  for (const file of files.filter((f) => matchesAny(f, FILE_SETS.schemas))) {
    const src = readAt(ref, file);
    if (!src) continue;
    const clean = stripComments(src);
    const perFile = new Map();

    const decl = /(?:^|\n)\s*(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*(?::\s*[^=;]+)?=\s*/g;
    let m;
    while ((m = decl.exec(clean))) {
      const expr = readExpression(clean, m.index + m[0].length);
      if (!/\bz\s*\.|\.(extend|merge|pick|omit|partial|and)\s*\(/.test(expr)) continue;
      perFile.set(m[1], expr);
      if (!byName.has(m[1])) byName.set(m[1], []);
      byName.get(m[1]).push({ file, expr, line: lineAt(clean, m.index) });
    }

    for (const a of clean.matchAll(
      /(?:^|\n)\s*(?:export\s+)?type\s+([A-Za-z_$][\w$]*)\s*=\s*z\s*\.\s*infer\s*<\s*typeof\s+([A-Za-z_$][\w$]*)\s*>/g,
    ))
      aliases.set(a[1], a[2]);

    byFile.set(file, perFile);
  }

  return {
    byFile,
    byName,
    aliases,
    /** Same file wins, then the alias target, then any declaration of the name. */
    lookup(name, file) {
      const local = byFile.get(file)?.get(name);
      if (local) return { file, expr: local };
      const direct = byName.get(name)?.[0];
      if (direct) return { file: direct.file, expr: direct.expr };
      const alias = aliases.get(name);
      if (alias && alias !== name) {
        const hit = byName.get(alias)?.[0];
        if (hit) return { file: hit.file, expr: hit.expr };
      }
      return null;
    },
  };
}

/* ───────────────────────────── the registry ───────────────────────────── */

/** Registered module key → route file, from `src/modules/index.ts`. */
function readRegistry(ref) {
  const src = readAt(ref, 'server/src/modules/index.ts');
  if (!src) return null;
  const clean = stripComments(src);

  const imports = new Map();
  for (const m of clean.matchAll(/import\s+([A-Za-z_$][\w$]*)\s+from\s+(['"])([^'"]+)\2/g))
    imports.set(m[1], `server/src/modules/${m[3].replace(/^\.\//, '').replace(/\.js$/, '.ts')}`);

  const decl = /const\s+modules\s*(?::[^=]+)?=\s*\{/.exec(clean);
  if (!decl) return null;
  const { inner } = sliceBalanced(clean, clean.indexOf('{', decl.index + decl[0].length - 1));

  const registered = new Map();
  for (const entry of splitTopLevel(inner)) {
    const m = /^(?:([A-Za-z_$][\w$]*)\s*:\s*)?([A-Za-z_$][\w$]*)$/.exec(entry);
    if (m) registered.set(m[1] ?? m[2], imports.get(m[2]) ?? null);
  }
  return registered;
}

/* ────────────────────── service return-type index ────────────────────── */

/** Read a return-type annotation: everything between `):` and the body `{`. */
function readReturnType(src, i) {
  const start = i;
  let depth = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === '<' || c === '(' || c === '[') depth++;
    else if (c === '>' || c === ')' || c === ']') depth--;
    else if ((c === '{' || c === ';') && depth <= 0) break;
    i++;
  }
  return src.slice(start, i).trim();
}

/**
 * `ClassName.method` → declared return type, for every method with one.
 *
 * A method with no annotation is skipped rather than guessed: an inferred return
 * type needs the compiler, and a wrong response shape is worse than none.
 */
function buildServiceIndex(ref, files) {
  const methods = new Map(); // `Class.method` → { type, file, line }

  for (const file of files.filter((f) => matchesAny(f, FILE_SETS.services))) {
    const src = readAt(ref, file);
    if (!src) continue;
    const clean = stripComments(src);

    const classes = [...clean.matchAll(/(?:^|\n)\s*(?:export\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/g)].map(
      (m) => ({ name: m[1], at: m.index }),
    );
    const classAt = (idx) => {
      let name = null;
      for (const c of classes) if (c.at < idx) name = c.name;
      return name;
    };

    // `async list(ws: string): Promise<Agent[]> {`
    const re = /(?:^|\n)\s*(?:public\s+|private\s+|protected\s+)?(?:async\s+)?([A-Za-z_$][\w$]*)\s*\(/g;
    let m;
    while ((m = re.exec(clean))) {
      const name = m[1];
      if (['if', 'for', 'while', 'switch', 'catch', 'return', 'constructor', 'function'].includes(name)) continue;
      const open = m.index + m[0].length - 1;
      const { end } = sliceBalanced(clean, open);
      let i = end;
      while (i < clean.length && /\s/.test(clean[i])) i++;
      if (clean[i] !== ':') continue; // no annotation — do not guess
      const cls = classAt(m.index);
      if (!cls) continue;
      methods.set(`${cls}.${name}`, {
        type: readReturnType(clean, i + 1),
        file,
        line: lineAt(clean, m.index),
      });
    }
  }

  return methods;
}

/**
 * `Promise<Agent[] | undefined>` → `{ name:'Agent', depth:1, optional:true }`.
 * `void`, `boolean` and inline object types resolve to a name of `null` with
 * the raw text kept, so the caller can still shape-compare literal responses.
 */
export function parseTypeExpr(text) {
  let t = (text ?? '').trim();
  // Greedy to the final `>`, because `sliceBalanced` pairs (), {} and [] only —
  // angle brackets are not brackets to it.
  for (const wrapper of ['Promise', 'Awaited']) {
    const m = new RegExp(`^${wrapper}\\s*<([\\s\\S]*)>$`).exec(t);
    if (m) t = m[1].trim();
  }

  let optional = false;
  const parts = splitUnion(t);
  const kept = parts.filter((p) => {
    if (/^(undefined|null|void)$/.test(p)) {
      optional = true;
      return false;
    }
    return true;
  });
  t = kept.join(' | ').trim();

  let depth = 0;
  for (;;) {
    const arr = /^(.*)\[\]$/.exec(t.trim());
    if (arr) {
      t = arr[1].trim();
      depth++;
      continue;
    }
    const gen = /^(?:Array|ReadonlyArray)\s*<([\s\S]+)>$/.exec(t.trim());
    if (gen) {
      t = gen[1].trim();
      depth++;
      continue;
    }
    break;
  }

  const name = /^[A-Za-z_$][\w$]*$/.test(t) ? t : null;
  return { name, depth, optional, text: t, union: kept.length > 1 };
}

/** Primitive type names — a response, but never a contract. */
const PRIMITIVES = new Set([
  'string', 'number', 'boolean', 'bigint', 'Date', 'unknown', 'any', 'object', 'symbol',
]);

export const isPrimitiveType = (name) => PRIMITIVES.has(name);

/**
 * `{ repo: Repo; created?: boolean }` →
 * `{ repo: { type:'Repo', optional:false }, created: { type:'boolean', optional:true } }`.
 *
 * Enough of a TypeScript type-literal reader for two real cases: following
 * `const { repo } = await service.add(...); return repo;`, and shape-checking a
 * response whose type is declared inline (`Promise<{ status: 'refreshing' }>`)
 * rather than as a named contract.
 */
export function parseTypeLiteral(text) {
  const t = (text ?? '').trim();
  if (!t.startsWith('{')) return null;
  const inner = sliceBalanced(t, 0).inner;
  const out = {};
  for (const entry of splitTopLevel(inner.replace(/;/g, ','))) {
    const m = /^([A-Za-z_$][\w$]*)\s*(\?)?\s*:\s*([\s\S]+)$/.exec(entry.trim());
    if (m) out[m[1]] = { type: m[3].trim(), optional: Boolean(m[2]) };
  }
  return Object.keys(out).length ? out : null;
}

/** A TypeScript type → the same coarse tag `shapes.mjs` uses for Zod types. */
function tsTypeTag(type) {
  const t = type.trim();
  const arr = /^(.*)\[\]$/.exec(t);
  if (arr) return `${tsTypeTag(arr[1])}[]`;
  if (/^['"`]/.test(t)) return `literal(${t.replace(/['"`]/g, '')})`;
  if (/^(string|number|boolean|bigint)$/.test(t)) return `z.${t}`;
  return t;
}

/** An inline object type → a comparable object shape. */
function shapeFromTypeLiteral(text) {
  const lit = parseTypeLiteral(text);
  if (!lit) return null;
  const fields = {};
  for (const [name, { type, optional }] of Object.entries(lit)) {
    const members = splitUnion(type);
    const nullable = members.some((m) => /^(null|undefined)$/.test(m));
    const real = members.filter((m) => !/^(null|undefined)$/.test(m));
    fields[name] = {
      required: !optional && !members.some((m) => m === 'undefined'),
      nullable,
      type: real.length === 1 ? tsTypeTag(real[0]) : 'union',
    };
  }
  return { kind: 'object', fields, inlineType: true };
}

/** Split a type union on top-level `|` only. */
function splitUnion(text) {
  const parts = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if ('<([{'.includes(c)) depth++;
    else if ('>)]}'.includes(c)) depth--;
    else if (c === '|' && depth === 0) {
      parts.push(text.slice(start, i).trim());
      start = i + 1;
    }
  }
  parts.push(text.slice(start).trim());
  return parts.filter(Boolean);
}

/* ──────────────────────────── route extraction ──────────────────────────── */

/** Does this argument text look like the handler function? */
const isHandler = (arg) => /^(async\s*)?(\(|function\b|[A-Za-z_$][\w$]*\s*=>)/.test(arg.trim());

/**
 * The handler's own return-type annotation: `async (req): Promise<PrMeta[]> =>`.
 *
 * Better evidence than anything downstream — the author wrote the response type
 * on the route itself. Several `pulls` handlers query the DB inline and build the
 * payload with spreads, so without this they resolve to a misleading partial
 * object literal instead of `PrDetail`.
 */
function readHandlerReturnType(handler) {
  if (!handler) return null;
  const t = handler.trim();
  let i = /^async\b/.test(t) ? 5 : 0;
  while (i < t.length && /\s/.test(t[i])) i++;
  if (t[i] !== '(') return null;

  i = sliceBalanced(t, i).end;
  while (i < t.length && /\s/.test(t[i])) i++;
  if (t[i] !== ':') return null;
  i++;

  const start = i;
  let depth = 0;
  while (i < t.length) {
    const c = t[i];
    if ('<([{'.includes(c)) depth++;
    else if ('>)]}'.includes(c)) {
      // `=>` closes the annotation; a `>` closing a generic does not.
      if (c === '>' && t[i - 1] === '=' && depth === 0) break;
      depth--;
    }
    i++;
  }
  const type = t.slice(start, i).replace(/=$/, '').trim();
  return type || null;
}

/** `app.get('/x', opts?, handler)` registrations, handler text included. */
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

    const opts = args.find((a, i) => i > 0 && a.trim().startsWith('{'));
    const handler = [...args].reverse().find(isHandler) ?? null;

    routes.push({
      method: m[1].toUpperCase(),
      path,
      file,
      line: lineAt(clean, m.index),
      responseRefs: opts ? readResponseRefs(opts) : null,
      handler,
    });
    re.lastIndex = Math.max(re.lastIndex, end);
  }
  return routes;
}

/** `{ schema: { response: { 200: X } } }` → `{ '200': 'X' }`. */
function readResponseRefs(optsText) {
  const at = /\bschema\s*:\s*\{/.exec(optsText);
  if (!at) return null;
  const { inner } = sliceBalanced(optsText, optsText.indexOf('{', at.index + at[0].length - 1));

  for (const entry of splitTopLevel(inner)) {
    const m = /^([A-Za-z_$][\w$]*)\s*:\s*([\s\S]+)$/.exec(entry);
    if (!m || m[1] !== 'response') continue;
    const brace = m[2].indexOf('{');
    if (brace === -1) continue;
    const out = {};
    for (const r of splitTopLevel(sliceBalanced(m[2], brace).inner)) {
      const rm = /^['"]?(\d{3})['"]?\s*:\s*([\s\S]+)$/.exec(r);
      if (rm) out[rm[1]] = rm[2].trim();
    }
    return Object.keys(out).length ? out : null;
  }
  return null;
}

/* ─────────────────────── handler → response shape ─────────────────────── */

/** `{ ok: true }` → an object shape with literal-inferred field types. */
function inlineObjectShape(text) {
  const brace = text.indexOf('{');
  if (brace === -1) return null;
  const fields = {};
  for (const entry of splitTopLevel(sliceBalanced(text, brace).inner)) {
    const m = /^(?:\.\.\.)?(?:(['"])([^'"]+)\1|([A-Za-z_$][\w$]*))\s*:\s*([\s\S]+)$/.exec(entry.trim());
    if (!m) continue;
    const v = m[4].trim();
    const type = /^(true|false)$/.test(v)
      ? 'z.boolean'
      : /^-?\d/.test(v)
        ? 'z.number'
        : /^['"`]/.test(v)
          ? 'z.string'
          : 'unknown';
    fields[m[2] ?? m[3]] = { required: true, nullable: false, type };
  }
  return Object.keys(fields).length ? { kind: 'object', fields, inline: true } : null;
}

/**
 * What does this handler send back?
 *
 * Reads the handler body for `return <expr>` / `reply.send(<expr>)`, then walks
 * one hop back through local `const x = await service.m(...)` bindings to the
 * service method whose return type names the response contract.
 *
 * Returns the first resolvable candidate. Handlers here return one shape on the
 * success path and `throw` on the failure paths (`NotFoundError`), so the first
 * resolvable return is the response — error payloads are the error handler's
 * shape, not this route's.
 */
function readHandlerResponse(handler, serviceVars) {
  if (!handler) return null;

  const brace = handler.indexOf('{');
  const body = brace === -1 ? handler.replace(/^[^=]*=>/, '') : sliceBalanced(handler, brace).inner;

  // Local bindings, in three forms that all occur in these routes:
  //   const agent = await service.get(...)
  //   links = await service.setSkills(...)        (declared bare as `let links`)
  //   const { repo, created } = await service.add(...)
  const bindings = new Map();
  for (const m of body.matchAll(
    /\b(?:(?:const|let|var)\s+)?([A-Za-z_$][\w$]*)\s*=\s*(?:await\s+)?([A-Za-z_$][\w$]*)\s*\.\s*([A-Za-z_$][\w$]*)\s*\(/g,
  ))
    if (!bindings.has(m[1])) bindings.set(m[1], { recv: m[2], method: m[3] });

  for (const m of body.matchAll(
    /\b(?:const|let|var)\s*\{([^}]*)\}\s*=\s*(?:await\s+)?([A-Za-z_$][\w$]*)\s*\.\s*([A-Za-z_$][\w$]*)\s*\(/g,
  ))
    for (const part of splitTopLevel(m[1])) {
      const nm = /^([A-Za-z_$][\w$]*)(?:\s*:\s*([A-Za-z_$][\w$]*))?$/.exec(part.trim());
      if (!nm) continue;
      const local = nm[2] ?? nm[1];
      if (!bindings.has(local)) bindings.set(local, { recv: m[2], method: m[3], prop: nm[1] });
    }

  const candidates = [];
  for (const m of body.matchAll(/\breturn\b\s*([\s\S]{0,400}?)(?:;|\n\s*\})/g)) candidates.push(m[1].trim());
  for (const m of body.matchAll(/\breply\s*\.\s*send\s*\(/g))
    candidates.push(sliceBalanced(body, body.indexOf('(', m.index + m[0].length - 1)).inner.trim());

  for (const raw of candidates) {
    const expr = raw.replace(/^await\s+/, '').trim();
    if (!expr) continue;

    if (expr.startsWith('{')) {
      const shape = inlineObjectShape(expr);
      if (shape) return { via: 'inline-literal', shape };
      continue;
    }

    const call = /^([A-Za-z_$][\w$]*)\s*\.\s*([A-Za-z_$][\w$]*)\s*\(/.exec(expr);
    if (call && serviceVars.has(call[1]))
      return { via: 'service-return', cls: serviceVars.get(call[1]), method: call[2] };

    const ident = /^([A-Za-z_$][\w$]*)$/.exec(expr);
    if (ident && bindings.has(ident[1])) {
      const b = bindings.get(ident[1]);
      if (serviceVars.has(b.recv))
        return {
          via: 'service-return',
          cls: serviceVars.get(b.recv),
          method: b.method,
          ...(b.prop ? { prop: b.prop } : {}),
        };
    }
  }

  return null;
}

/** `const service = new AgentsService(app.container)` → var → class name. */
function readServiceVars(src) {
  const vars = new Map();
  for (const m of src.matchAll(
    /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::\s*[^=;]+)?=\s*new\s+([A-Za-z_$][\w$]*)\s*\(/g,
  ))
    vars.set(m[1], m[2]);
  return vars;
}

/* ────────────────────────────── the surface ────────────────────────────── */

export const canonical = (path) => path.replace(/\$\{[^}]*\}/g, '*').replace(/:[A-Za-z_$][\w$]*/g, '*');
export const endpointKey = (e) => `${e.method} ${canonical(e.path)}`;

/**
 * The response surface at `ref`:
 *
 *   endpoints[]  one entry per registered route, each with the resolved
 *                response shape and how it was resolved (`via`)
 *   contracts{}  every exported schema in `shared`, deeply resolved, flagged
 *                with whether an endpoint actually serves it
 */
export function buildResponseSurface(ref) {
  const files = listFiles(ref);
  const index = buildIndex(ref, files);
  const services = buildServiceIndex(ref, files);
  const registry = readRegistry(ref);
  const registeredFiles = new Set([...(registry?.values() ?? [])].filter(Boolean));

  const endpoints = [];
  const servedContracts = new Map(); // contract name → [endpoint keys]

  for (const file of files.filter((f) => matchesAny(f, FILE_SETS.routes))) {
    const src = readAt(ref, file);
    if (!src) continue;
    const clean = stripComments(src);
    const serviceVars = readServiceVars(clean);
    const isModuleRoute = file !== 'server/src/app.ts';

    for (const r of extractRoutes(src, file)) {
      const entry = {
        key: endpointKey(r),
        method: r.method,
        path: r.path,
        file,
        line: r.line,
        module: isModuleRoute ? file.split('/')[3] : 'app',
        registered: !isModuleRoute || registeredFiles.has(file),
        via: 'unresolved',
        contract: null,
        statuses: null,
        shape: null,
      };

      /**
       * A TypeScript return type → the contract it names and that contract's
       * shape. `prop` descends into one property first, for
       * `const { repo } = await service.add(...); return repo;`.
       */
      const resolveTyped = (typeText, prop) => {
        let parsed = parseTypeExpr(typeText);
        if (prop) {
          const propType = parseTypeLiteral(parsed.text)?.[prop]?.type;
          if (!propType) return null;
          parsed = parseTypeExpr(propType);
        }
        if (!parsed.name) {
          // An inline object type — no contract to name, but still comparable.
          const shape = shapeFromTypeLiteral(parsed.text);
          return shape ? { contract: null, arrayDepth: parsed.depth, shape } : null;
        }
        const primitive = isPrimitiveType(parsed.name);
        const base = primitive
          ? { kind: 'scalar', type: parsed.name }
          : resolveShape(parsed.name, index, file);
        return {
          contract: primitive ? null : parsed.name,
          arrayDepth: parsed.depth,
          shape:
            parsed.depth > 0 && base.kind !== 'ref'
              ? Array.from({ length: parsed.depth }).reduce((acc) => ({ kind: 'array', of: acc }), base)
              : base,
        };
      };

      // 1 — a declared `response:` schema is the strongest signal there is.
      if (r.responseRefs) {
        entry.via = 'response-schema';
        entry.statuses = {};
        for (const [status, expr] of Object.entries(r.responseRefs))
          entry.statuses[status] = { expr, shape: resolveShape(expr, index, file) };
        const ok = entry.statuses['200'] ?? Object.values(entry.statuses)[0];
        entry.shape = ok?.shape ?? null;
        entry.contract = /^[A-Za-z_$][\w$]*$/.test(ok?.expr ?? '') ? ok.expr : null;
      } else {
        // 2 — the handler's own `): Promise<PrDetail> =>` annotation. Ranked
        // above the service hop because it is the author's statement about this
        // endpoint, and above the inline literal because handlers that build a
        // payload with spreads would otherwise resolve to a partial shape.
        const annotated = readHandlerReturnType(r.handler);
        const fromAnnotation = annotated ? resolveTyped(annotated) : null;

        if (fromAnnotation) {
          entry.via = 'handler-annotation';
          entry.returnType = annotated;
          Object.assign(entry, fromAnnotation);
        } else {
          // 3 — otherwise follow the handler into the service's return type.
          const found = readHandlerResponse(r.handler, serviceVars);
          if (found?.via === 'service-return') {
            const sig = services.get(`${found.cls}.${found.method}`);
            entry.serviceMethod = `${found.cls}.${found.method}`;
            const resolved = sig ? resolveTyped(sig.type, found.prop) : null;
            if (resolved) {
              entry.via = 'service-return';
              entry.returnType = sig.type;
              if (found.prop) entry.returnProp = found.prop;
              Object.assign(entry, resolved);
            }
          } else if (found?.via === 'inline-literal') {
            // 4 — last resort: a literal built in the handler (`{ ok: true }`).
            entry.via = 'inline-literal';
            entry.shape = found.shape;
          }
        }
      }

      if (entry.contract) {
        if (!servedContracts.has(entry.contract)) servedContracts.set(entry.contract, []);
        servedContracts.get(entry.contract).push(entry.key);
      }
      endpoints.push(entry);
    }
  }

  const contracts = {};
  for (const file of files.filter((f) => matchesAny(f, FILE_SETS.contracts))) {
    const src = readAt(ref, file);
    if (!src) continue;
    const clean = stripComments(src);
    for (const m of clean.matchAll(
      /(?:^|\n)\s*export\s+const\s+([A-Za-z_$][\w$]*)\s*(?::\s*[^=;]+)?=\s*/g,
    )) {
      const name = m[1];
      const expr = readExpression(clean, m.index + m[0].length);
      if (!/\bz\s*\.|\.(extend|merge|pick|omit|partial|and)\s*\(/.test(expr)) continue;
      contracts[name] = {
        name,
        file,
        line: lineAt(clean, m.index),
        shape: resolveShape(expr, index, file),
        servedBy: servedContracts.get(name) ?? [],
      };
    }
  }

  return {
    ref,
    endpoints,
    contracts,
    resolved: endpoints.filter((e) => e.shape).length,
  };
}

/**
 * Studio code that reads a response field, so a break can be reported with the
 * component that will render a blank.
 *
 * The contract name must appear in the file before its fields are searched —
 * without that anchor, `.name` matches half the studio. The consequence is the
 * inverse error: a component that receives the object through an untyped prop is
 * missed. Reader lists are therefore a lead, never a completeness claim.
 *
 * Client sources are read once and reused across every finding.
 */
export function createReaderLookup(ref) {
  let cache = null;

  return function readers(contract, fieldPath, limit = 4) {
    if (!contract) return [];
    if (!cache) {
      cache = [];
      for (const file of listFiles(ref).filter((f) => matchesAny(f, FILE_SETS.readers))) {
        const src = readAt(ref, file);
        if (src) cache.push({ file, src });
      }
    }

    const leaf = fieldPath.split('.').pop();
    const named = new RegExp(`\\b${contract}\\b`);
    const read = new RegExp(`\\.${leaf}\\b|\\[['"\`]${leaf}['"\`]\\]`, 'g');
    const hits = [];

    for (const { file, src } of cache) {
      if (!named.test(src)) continue;
      for (const m of src.matchAll(read)) {
        hits.push(`${file}:${lineAt(src, m.index)}`);
        if (hits.length >= limit) return hits;
      }
    }
    return hits;
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const ref = process.argv[2] ?? WORKTREE;
  const surface = buildResponseSurface(ref);
  if (process.argv.includes('--summary')) {
    for (const e of surface.endpoints.filter((x) => x.registered))
      process.stdout.write(
        `${e.method.padEnd(6)} ${e.path.padEnd(42)} ${e.via.padEnd(16)} ${
          e.contract ?? ''
        }${e.shape ? ` ${typeOf(e.shape)}` : ''}\n`,
      );
  } else {
    process.stdout.write(JSON.stringify(surface, null, 2) + '\n');
  }
}
