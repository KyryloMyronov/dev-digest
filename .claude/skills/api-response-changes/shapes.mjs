// Deep Zod shape resolution, for response payloads.
//
// The sibling skill's `resolveShape()` stops at `X.pick/omit/partial/merge`
// and records `kind: 'derived'`. For a *response* that is the one place a break
// hides best: `.partial()` turns every field optional in eleven characters of
// diff, and comparing two `derived` blobs by text says only "it changed".
//
// So this resolves the chain. `Base.omit({secret:true}).extend({x:z.string()})
// .partial()` becomes a real field list with real `required`/`nullable` flags,
// which is the only way to say *which* fields a reader can no longer trust.
//
// Two deliberate differences from the sibling resolver:
//   * optionality is read from the parsed chain, not a regex over the field
//     text — `z.object({ a: z.string().optional() })` must not mark the *outer*
//     object optional, and a regex on the whole expression does exactly that.
//   * `.nullable()` is tracked per field, because for a response `T | null` is
//     a break for every reader that does not null-check, even though the key is
//     still present on the wire.

import { sliceBalanced, splitTopLevel } from '../source-scan/scan.mjs';

/** Ops that only narrow/annotate — the output shape survives them unchanged. */
const PASSTHROUGH_OPS = new Set([
  'describe', 'refine', 'superRefine', 'brand', 'readonly', 'catch',
  'strict', 'strip', 'passthrough', 'min', 'max', 'length', 'email', 'url',
  'uuid', 'regex', 'int', 'positive', 'nonnegative', 'negative', 'gt', 'gte',
  'lt', 'lte', 'trim', 'toLowerCase', 'startsWith', 'endsWith', 'datetime',
  'nonempty', 'finite', 'safe', 'multipleOf', 'step', 'includes', 'ip', 'cuid',
  'cuid2', 'ulid', 'emoji', 'base64', 'date', 'time', 'duration',
]);

/**
 * Split `Base.omit({...}).partial()` into a base constructor and its op chain.
 * `z.`-prefixed bases keep consuming dotted segments until the one that is
 * actually called (`z.coerce.number()` → base `z.coerce.number`), while a bare
 * identifier is the base on its own (`Settings.partial()` → base `Settings`).
 */
export function splitChain(text) {
  const t = text.trim();
  let i = 0;
  const skipWs = () => {
    while (i < t.length && /\s/.test(t[i])) i++;
  };
  const readIdent = () => {
    const m = /^[A-Za-z_$][\w$]*/.exec(t.slice(i));
    if (!m) return null;
    i += m[0].length;
    return m[0];
  };

  let base = readIdent();
  if (!base) return null;

  if (base === 'z') {
    for (;;) {
      skipWs();
      if (t[i] !== '.') break;
      const save = i;
      i++;
      skipWs();
      const seg = readIdent();
      if (!seg) {
        i = save;
        break;
      }
      base += `.${seg}`;
      skipWs();
      if (t[i] === '(') break; // this segment is the constructor being called
    }
  }

  skipWs();
  let baseArgs = null;
  if (t[i] === '(') {
    const { inner, end } = sliceBalanced(t, i);
    baseArgs = inner;
    i = end;
  }

  const ops = [];
  for (;;) {
    skipWs();
    if (t[i] !== '.') break;
    const save = i;
    i++;
    skipWs();
    const name = readIdent();
    skipWs();
    if (!name || t[i] !== '(') {
      i = save;
      break;
    }
    const { inner, end } = sliceBalanced(t, i);
    ops.push({ name, args: inner.trim() });
    i = end;
  }

  return { base, baseArgs, ops };
}

/** Keys set truthy in a `.pick({ a: true })` / `.omit({ a: true })` argument. */
function maskKeys(args) {
  const keys = [];
  for (const entry of splitTopLevel(args.replace(/^\s*\{/, '').replace(/\}\s*$/, ''))) {
    const m = /^(?:(['"])([^'"]+)\1|([A-Za-z_$][\w$]*))\s*:\s*(.+)$/.exec(entry);
    if (m && /^true\b/.test(m[4].trim())) keys.push(m[2] ?? m[3]);
  }
  return keys;
}

/** String literals inside a `z.enum([...])` argument. */
const enumValues = (args) => [...args.matchAll(/(['"`])([^'"`]*)\1/g)].map((m) => m[2]);

const isObject = (s) => s?.kind === 'object' && s.fields;

/** A short, comparable type tag for a resolved shape. */
export function typeOf(shape) {
  if (!shape) return 'unknown';
  switch (shape.kind) {
    case 'object':
      return 'object';
    case 'array':
      return `${typeOf(shape.of)}[]`;
    case 'enum':
      return 'enum';
    case 'union':
      return 'union';
    case 'record':
      return `record<${typeOf(shape.of)}>`;
    case 'literal':
      return `literal(${shape.value})`;
    default:
      return shape.type ?? shape.text ?? shape.kind;
  }
}

/** Human-readable one-liner for a shape, for finding text. */
export function describeShape(shape) {
  if (!shape) return 'unresolved';
  if (isObject(shape)) return `{ ${Object.keys(shape.fields).join(', ')} }`;
  return typeOf(shape) + (shape.nullable ? ' | null' : '');
}

/**
 * Resolve a schema expression against a name index into a comparable shape:
 *
 *   { kind:'object', fields: { name: { required, nullable, type, shape } } }
 *   { kind:'array', of }  { kind:'enum', values }  { kind:'union', of }
 *   { kind:'record', of } { kind:'literal', value } { kind:'scalar', type }
 *   { kind:'ref'|'unknown'|'cycle', text }
 *
 * `optional`/`nullable` on the shape itself are the *wrapper* flags, i.e. what
 * `.optional()` at the end of the expression means for the field holding it.
 */
export function resolveShape(expr, index, file, seen = new Set(), depth = 0) {
  const text = (expr ?? '').trim().replace(/;$/, '');
  if (!text) return { kind: 'unknown', text: '' };
  if (depth > 12) return { kind: 'unknown', text: text.slice(0, 80) };

  const chain = splitChain(text);
  if (!chain) return { kind: 'unknown', text: text.slice(0, 80) };

  const sub = (e, extraSeen = seen) => resolveShape(e, index, file, extraSeen, depth + 1);
  let shape;

  switch (chain.base) {
    case 'z.object':
      shape = { kind: 'object', fields: parseFields(chain.baseArgs ?? '', index, file, seen, depth) };
      break;
    case 'z.array':
      shape = { kind: 'array', of: sub(chain.baseArgs ?? '') };
      break;
    case 'z.enum':
    case 'z.nativeEnum':
      shape = { kind: 'enum', values: enumValues(chain.baseArgs ?? '') };
      break;
    case 'z.literal':
      shape = { kind: 'literal', value: (chain.baseArgs ?? '').trim() };
      break;
    case 'z.record':
      // `z.record(K, V)` — the value type is what a reader consumes.
      shape = { kind: 'record', of: sub(splitTopLevel(chain.baseArgs ?? '').pop() ?? '') };
      break;
    case 'z.union':
    case 'z.discriminatedUnion': {
      const args = splitTopLevel(chain.baseArgs ?? '');
      const listText = chain.base === 'z.union' ? args[0] : args[1];
      const list = listText ? splitTopLevel(listText.replace(/^\s*\[/, '').replace(/\]\s*$/, '')) : [];
      shape = { kind: 'union', of: list.map((m) => sub(m)) };
      if (chain.base === 'z.discriminatedUnion') shape.discriminator = args[0]?.replace(/['"`]/g, '');
      break;
    }
    case 'z.intersection': {
      const [a, b] = splitTopLevel(chain.baseArgs ?? '').map((m) => sub(m));
      shape = mergeShapes(a, b);
      break;
    }
    case 'z.lazy':
      shape = sub((chain.baseArgs ?? '').replace(/^\s*\(\s*\)\s*=>/, ''));
      break;
    case 'z.optional':
    case 'z.nullable':
      shape = { ...sub(chain.baseArgs ?? ''), [chain.base === 'z.optional' ? 'optional' : 'nullable']: true };
      break;
    default: {
      if (chain.base.startsWith('z.')) {
        shape = { kind: 'scalar', type: chain.base.replace('z.coerce.', 'z.') };
        break;
      }
      // A named schema: follow it through the index, guarding cycles.
      if (seen.has(chain.base)) {
        shape = { kind: 'cycle', text: chain.base };
        break;
      }
      const hit = index.lookup(chain.base, file);
      shape = hit
        ? resolveShape(hit.expr, index, hit.file, new Set([...seen, chain.base]), depth + 1)
        : { kind: 'ref', text: chain.base };
      break;
    }
  }

  return applyOps(shape, chain.ops, index, file, seen, depth);
}

/** Union of two object shapes; a non-object on either side wins as unresolved. */
function mergeShapes(a, b) {
  if (isObject(a) && isObject(b)) return { kind: 'object', fields: { ...a.fields, ...b.fields } };
  return isObject(a) ? a : isObject(b) ? b : { kind: 'unknown', text: 'intersection' };
}

/** Walk the `.partial().omit({…})` tail, transforming the shape as Zod would. */
function applyOps(shape, ops, index, file, seen, depth) {
  let out = shape;
  const fields = () => (isObject(out) ? { ...out.fields } : null);

  for (const op of ops) {
    if (PASSTHROUGH_OPS.has(op.name)) continue;

    switch (op.name) {
      case 'optional':
        out = { ...out, optional: true };
        break;
      case 'nullable':
        out = { ...out, nullable: true };
        break;
      case 'nullish':
        out = { ...out, optional: true, nullable: true };
        break;
      case 'default':
        // A default fills the value in, so the key is always present on the way out.
        out = { ...out, optional: false, hasDefault: true };
        break;
      case 'array':
        out = { kind: 'array', of: out };
        break;
      case 'partial':
      case 'deepPartial': {
        const f = fields();
        if (!f) break;
        for (const k of Object.keys(f)) f[k] = { ...f[k], required: false };
        out = { ...out, fields: f, partialed: true };
        break;
      }
      case 'required': {
        const f = fields();
        if (!f) break;
        for (const k of Object.keys(f)) f[k] = { ...f[k], required: true };
        out = { ...out, fields: f };
        break;
      }
      case 'pick': {
        const f = fields();
        if (!f) break;
        const keep = new Set(maskKeys(op.args));
        out = {
          ...out,
          fields: Object.fromEntries(Object.entries(f).filter(([k]) => keep.has(k))),
        };
        break;
      }
      case 'omit': {
        const f = fields();
        if (!f) break;
        const drop = new Set(maskKeys(op.args));
        out = {
          ...out,
          fields: Object.fromEntries(Object.entries(f).filter(([k]) => !drop.has(k))),
        };
        break;
      }
      case 'extend': {
        const f = fields();
        if (!f) break;
        out = { ...out, fields: { ...f, ...parseFields(op.args, index, file, seen, depth) } };
        break;
      }
      case 'merge':
      case 'and':
        out = mergeShapes(out, resolveShape(op.args, index, file, seen, depth + 1));
        break;
      case 'or':
        out = { kind: 'union', of: [out, resolveShape(op.args, index, file, seen, depth + 1)] };
        break;
      case 'transform':
      case 'pipe':
        // The output type is arbitrary TypeScript we cannot read — say so rather
        // than reporting the input shape as if it were the response.
        out = { kind: 'transformed', text: typeOf(out), from: out };
        break;
      default:
        break; // unknown op: assume shape-preserving
    }
  }

  return out;
}

/**
 * Fields of a `z.object({...})` body. Each field's optionality comes from its
 * own resolved chain, so `.optional()` nested inside a value never leaks out to
 * the field holding it.
 */
export function parseFields(inner, index, file, seen, depth) {
  const body = inner.trim().replace(/^\{/, '').replace(/\}$/, '');
  const fields = {};

  for (const entry of splitTopLevel(body)) {
    const m = /^(?:(['"])([^'"]+)\1|([A-Za-z_$][\w$]*))\s*:\s*([\s\S]+)$/.exec(entry);
    if (!m) continue;
    const name = m[2] ?? m[3];
    const shape = resolveShape(m[4].trim(), index, file, seen, depth + 1);
    fields[name] = {
      required: !shape.optional,
      nullable: Boolean(shape.nullable),
      type: typeOf(shape),
      ...(isObject(shape) || shape.kind === 'array' || shape.kind === 'enum' ? { shape } : {}),
    };
  }

  return fields;
}

/**
 * Peel `array` / `transformed` wrappers off a shape to reach the object a
 * reader actually destructures. `Agent[]` and `Agent` break their readers in
 * the same way, so field diffing works on the element either way — the
 * array-ness itself is compared separately.
 */
export function unwrap(shape, depth = 0) {
  if (!shape || depth > 8) return shape;
  if (shape.kind === 'array') return unwrap(shape.of, depth + 1);
  if (shape.kind === 'transformed') return unwrap(shape.from, depth + 1);
  return shape;
}

/** Array nesting depth, so `Agent` → `Agent[]` is visible as a change. */
export function arrayDepth(shape, depth = 0) {
  if (!shape || depth > 8) return 0;
  if (shape.kind === 'array') return 1 + arrayDepth(shape.of, depth + 1);
  if (shape.kind === 'transformed') return arrayDepth(shape.from, depth + 1);
  return 0;
}

/**
 * Field-by-field diff of two response shapes, recursing into nested objects and
 * array elements so a break reports as `agent.config.model`, not `agent`.
 *
 * Only differences that a *reader* of the response can feel are emitted; the
 * caller decides severity.
 */
export function diffShape(before, after, path = '', depth = 0) {
  const diffs = [];
  if (depth > 6) return diffs;

  const b = unwrap(before);
  const a = unwrap(after);
  if (!b || !a) return diffs;

  if (arrayDepth(before) !== arrayDepth(after))
    diffs.push({ kind: 'array-changed', path, from: typeOf(before), to: typeOf(after) });

  if (b.kind === 'enum' && a.kind === 'enum') {
    for (const v of b.values.filter((v) => !a.values.includes(v)))
      diffs.push({ kind: 'enum-value-removed', path, value: v });
    for (const v of a.values.filter((v) => !b.values.includes(v)))
      diffs.push({ kind: 'enum-value-added', path, value: v });
    return diffs;
  }

  if (!isObject(b) || !isObject(a)) {
    // Two unresolved-but-differently-named shapes tell us nothing useful; only
    // report when both sides resolved to a real, comparable type.
    const [tb, ta] = [typeOf(b), typeOf(a)];
    if (tb !== ta && b.kind !== 'ref' && a.kind !== 'ref' && b.kind !== 'unknown' && a.kind !== 'unknown')
      diffs.push({ kind: 'type-changed', path, from: tb, to: ta });
    return diffs;
  }

  for (const [name, bf] of Object.entries(b.fields)) {
    const at = path ? `${path}.${name}` : name;
    const af = a.fields[name];

    if (!af) {
      diffs.push({ kind: 'field-removed', path: at });
      continue;
    }
    // `.nullish()` weakens presence and value in one edit — one finding, not two.
    const lostPresence = bf.required && !af.required;
    const gainedNull = !bf.nullable && af.nullable;
    if (lostPresence && gainedNull) diffs.push({ kind: 'field-now-nullish', path: at });
    else {
      if (lostPresence) diffs.push({ kind: 'field-now-optional', path: at });
      if (gainedNull) diffs.push({ kind: 'field-now-nullable', path: at });
    }
    if (!bf.required && af.required) diffs.push({ kind: 'field-now-required', path: at });
    if (bf.nullable && !af.nullable) diffs.push({ kind: 'field-not-nullable', path: at });
    if (bf.type !== af.type)
      diffs.push({ kind: 'field-type-changed', path: at, from: bf.type, to: af.type });

    if (bf.shape && af.shape) diffs.push(...diffShape(bf.shape, af.shape, at, depth + 1));
  }

  for (const [name, af] of Object.entries(a.fields)) {
    if (b.fields[name]) continue;
    const at = path ? `${path}.${name}` : name;
    // Additive for readers; only the required ones cost a producer anything.
    if (af.required) diffs.push({ kind: 'field-added-required', path: at });
  }

  return diffs;
}
