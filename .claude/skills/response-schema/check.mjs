#!/usr/bin/env node
// Diff the response surface between two git refs and report what a caller
// reading the API would notice.
//
// Scope is deliberately one question — "does the payload coming back change
// shape?" — so the report stays short enough to read every time. Endpoints,
// request bodies, and the module registry are the `api-breaking-changes`
// skill's job; this one says nothing about them.

import { buildResponseSurface, WORKTREE, bindingKey } from './responses.mjs';
import { git, SEVERITY_ORDER, downgrade } from './lib.mjs';

const MAX_DIFF_DEPTH = 8;

/* ─────────────────────────────── shape diff ─────────────────────────────── */

/** Human-readable one-liner for a shape, used in "was X, now Y" wording. */
function describe(shape) {
  if (!shape) return 'nothing';
  switch (shape.kind) {
    case 'object': return `object{${Object.keys(shape.fields ?? {}).length} fields}`;
    case 'array': return `array of ${describe(shape.of)}`;
    case 'enum': return `enum(${(shape.values ?? []).join('|')})`;
    case 'scalar': return shape.type;
    case 'literal': return `literal ${shape.value}`;
    case 'union': return `union of ${(shape.members ?? []).length}`;
    case 'record': return `record of ${describe(shape.of)}`;
    case 'tuple': return `tuple[${(shape.items ?? []).length}]`;
    case 'ref': return `${shape.name} (unresolved)`;
    default: return shape.kind + (shape.text ? ` (${shape.text})` : '');
  }
}

/**
 * Compare two shapes and push findings.
 *
 * `path` is the field path inside the payload (`items[].status`), empty at the
 * root. Severity here is the "this endpoint is actually served" severity;
 * the caller downgrades it for contracts nothing returns yet.
 */
function diffShape(base, head, path, push, depth = 0) {
  if (!base || !head || depth > MAX_DIFF_DEPTH) return;
  const at = (p) => p || '(root)';
  // Last path segment. Contracts embed one another (`Review.findings[]` is a
  // `Finding`), so one edited field surfaces once per embedding contract. `sig`
  // is what lets the report collapse those back into the single change they are.
  const leaf = (p) => p.split('.').pop() || '(root)';

  if (base.kind !== head.kind) {
    const cardinality =
      (base.kind === 'array') !== (head.kind === 'array') &&
      ['object', 'array', 'scalar', 'record'].includes(base.kind) &&
      ['object', 'array', 'scalar', 'record'].includes(head.kind);
    push({
      rule: cardinality ? 'response-cardinality-changed' : 'response-type-changed',
      severity: cardinality ? 'critical' : 'major',
      sig: `kind:${leaf(path)}:${base.kind}>${head.kind}`,
      path,
      detail: `${at(path)} was ${describe(base)}, now ${describe(head)}`,
    });
    return;
  }

  switch (base.kind) {
    case 'object': {
      const bf = base.fields ?? {};
      const hf = head.fields ?? {};
      for (const [name, b] of Object.entries(bf)) {
        const p = path ? `${path}.${name}` : name;
        const h = hf[name];
        if (!h) {
          push({
            rule: 'response-field-removed',
            severity: 'critical',
            sig: `removed:${leaf(p)}`,
            path: p,
            detail: `\`${p}\` is no longer in the payload`,
          });
          continue;
        }
        if (b.required && !h.required)
          push({
            rule: 'response-field-now-optional',
            severity: 'major',
            sig: `optional:${leaf(p)}`,
            path: p,
            detail: `\`${p}\` was always present, now optional`,
          });
        if (!b.required && h.required)
          push({
            rule: 'response-field-now-required',
            severity: 'minor',
            sig: `required:${leaf(p)}`,
            path: p,
            detail: `\`${p}\` was optional, now always present`,
          });
        if (!b.nullable && h.nullable)
          push({
            rule: 'response-field-now-nullable',
            severity: 'major',
            sig: `nullable:${leaf(p)}`,
            path: p,
            detail: `\`${p}\` can now be null`,
          });
        diffShape(b.shape, h.shape, p, push, depth + 1);
      }
      for (const [name, h] of Object.entries(hf)) {
        if (bf[name]) continue;
        if (h.required)
          push({
            rule: 'response-field-added-required',
            severity: 'minor',
            sig: `added:${name}`,
            path: path ? `${path}.${name}` : name,
            detail: `new always-present field \`${name}\``,
          });
      }
      return;
    }
    case 'array':
      return diffShape(base.of, head.of, `${path}[]`, push, depth + 1);
    case 'record':
      return diffShape(base.of, head.of, `${path}{}`, push, depth + 1);
    case 'tuple': {
      const bi = base.items ?? [];
      const hi = head.items ?? [];
      if (bi.length !== hi.length)
        push({
          rule: 'response-type-changed',
          severity: 'major',
          path,
          detail: `${at(path)} tuple length ${bi.length} → ${hi.length}`,
        });
      bi.forEach((b, i) => diffShape(b, hi[i], `${path}[${i}]`, push, depth + 1));
      return;
    }
    case 'enum': {
      const bv = base.values ?? [];
      const hv = head.values ?? [];
      for (const v of bv.filter((v) => !hv.includes(v)))
        push({
          rule: 'response-enum-value-removed',
          severity: 'major',
          sig: `enum-del:${leaf(path)}:${v}`,
          path,
          detail: `${at(path)} no longer returns \`${v}\``,
        });
      for (const v of hv.filter((v) => !bv.includes(v)))
        push({
          rule: 'response-enum-value-added',
          severity: 'minor',
          sig: `enum-add:${leaf(path)}:${v}`,
          path,
          detail: `${at(path)} can now return \`${v}\``,
        });
      return;
    }
    case 'union': {
      const bm = base.members ?? [];
      const hm = head.members ?? [];
      if (bm.length !== hm.length) {
        push({
          rule: 'response-type-changed',
          severity: 'major',
          path,
          detail: `${at(path)} union arms ${bm.length} → ${hm.length}`,
        });
        return;
      }
      bm.forEach((b, i) => diffShape(b, hm[i], `${path}|${i}`, push, depth + 1));
      return;
    }
    case 'scalar':
      if (base.type !== head.type)
        push({
          rule: path ? 'response-field-type-changed' : 'response-type-changed',
          severity: 'major',
          sig: `type:${leaf(path)}:${base.type}>${head.type}`,
          path,
          detail: `${at(path)} was \`${base.type}\`, now \`${head.type}\``,
        });
      return;
    case 'literal':
      if (base.value !== head.value)
        push({
          rule: path ? 'response-field-type-changed' : 'response-type-changed',
          severity: 'major',
          sig: `literal:${leaf(path)}:${base.value}>${head.value}`,
          path,
          detail: `${at(path)} was \`${base.value}\`, now \`${head.value}\``,
        });
      return;
    case 'ref':
      if (base.name !== head.name)
        push({
          rule: path ? 'response-field-type-changed' : 'response-type-changed',
          severity: 'major',
          sig: `ref:${leaf(path)}:${base.name}>${head.name}`,
          path,
          detail: `${at(path)} was \`${base.name}\`, now \`${head.name}\` (neither resolved)`,
        });
      return;
    default:
      // opaque / unknown / cycle — the scanner could not model it. Say so
      // instead of staying silent, so nobody reads silence as "no change".
      if ((base.text ?? '') !== (head.text ?? ''))
        push({
          rule: 'response-shape-opaque',
          severity: 'info',
          path,
          detail: `${at(path)} changed but could not be modelled (${describe(base)} → ${describe(head)})`,
        });
  }
}

/* ───────────────────────────── surface compare ───────────────────────────── */

/** Endpoints whose declared response type names this contract. */
function servingEndpoints(surface, name) {
  const re = new RegExp(`\\b${name}\\b`);
  return surface.bindings.filter((b) => re.test(b.typeText ?? ''));
}

/** Files that differ between the two refs — used to scope the mirror rule. */
function changedFiles(base, head) {
  const out =
    head === WORKTREE
      ? git(['diff', '--name-only', base], { soft: true })
      : git(['diff', '--name-only', `${base}...${head}`], { soft: true });
  const tracked = new Set((out ?? '').split('\n').filter(Boolean));
  if (head === WORKTREE)
    for (const f of (git(['ls-files', '--others', '--exclude-standard'], { soft: true }) ?? '')
      .split('\n')
      .filter(Boolean))
      tracked.add(f);
  return tracked;
}

/** `server/src/vendor/shared/x.ts` → its hand-synced client twin. */
const mirrorPath = (p) => p.replace('server/src/vendor/shared/', 'client/src/vendor/shared/');

/** True when the type text is an inline literal rather than a named contract. */
const isInlineType = (t) => !!t && !/^[A-Z][\w$]*(\[\])?$/.test(t.trim());

/**
 * Collapse the same underlying change reported against several contracts.
 *
 * Contracts nest: `Review.findings[]` is a `Finding`, `ReviewRecord.findings[]`
 * is a `FindingRecord`, and so on. Dropping one field from `Finding` therefore
 * shows up five times. The reader needs the change once — with the served
 * endpoints attached — not once per embedding, so the widest-reaching instance
 * becomes the finding and the rest become an `also via:` line.
 */
function collapseBySignature(list) {
  const groups = new Map();
  const out = [];
  for (const f of list) {
    if (!f.sig) {
      out.push(f);
      continue;
    }
    const g = groups.get(f.sig);
    if (g) g.push(f);
    else groups.set(f.sig, [f]);
  }

  for (const group of groups.values()) {
    // Prefer a served contract, then the shallowest path — that is the one
    // closest to where the field is actually declared.
    const sorted = [...group].sort(
      (a, b) =>
        Number(b.served) - Number(a.served) ||
        (a.path ?? '').split('.').length - (b.path ?? '').split('.').length ||
        (a.contract ?? '').localeCompare(b.contract ?? ''),
    );
    const [primary, ...rest] = sorted;
    out.push({
      ...primary,
      served: group.some((f) => f.served),
      endpoints: [...new Set(group.flatMap((f) => f.endpoints ?? []))],
      alsoIn: rest.map((f) => `${f.contract}${f.path ? `.${f.path}` : ''}`),
    });
  }
  return out;
}

export function compareSurfaces(baseSurface, headSurface, { base, head }) {
  const findings = [];
  const contractFindings = [];
  const add = (f) => findings.push(f);

  /* 1 — contracts: the wire shapes themselves. */
  const names = new Set([...Object.keys(baseSurface.contracts), ...Object.keys(headSurface.contracts)]);
  for (const name of [...names].sort()) {
    const b = baseSurface.contracts[name];
    const h = headSurface.contracts[name];
    const serves = servingEndpoints(headSurface, name).concat(
      h ? [] : servingEndpoints(baseSurface, name),
    );
    const served = serves.length > 0;

    if (b && !h) {
      add({
        rule: 'response-type-removed',
        severity: 'critical',
        title: `response type \`${name}\` is gone`,
        detail: served
          ? 'An endpoint still declares it as its response type.'
          : 'Nothing returns it today; still a compile break for every import.',
        where: `${b.file}:${b.line}`,
        contract: name,
        served,
        endpoints: serves.map(bindingKey),
      });
      continue;
    }
    if (!b || !h) continue;

    const local = [];
    diffShape(b.shape, h.shape, '', (f) => local.push(f));
    for (const f of local)
      contractFindings.push({
        ...f,
        title: `\`${name}\`: ${f.detail}`,
        where: `${h.file}:${h.line}`,
        contract: name,
        served,
        endpoints: serves.map(bindingKey),
      });
  }
  for (const f of collapseBySignature(contractFindings)) add(f);

  /* 2 — bindings: which type an endpoint returns, and inline literal payloads. */
  const bByKey = new Map(baseSurface.bindings.map((x) => [x.key, x]));
  const hByKey = new Map(headSurface.bindings.map((x) => [x.key, x]));

  for (const [key, h] of hByKey) {
    const b = bByKey.get(key);
    if (!b) continue;

    if (b.typeText !== h.typeText) {
      add({
        rule: 'response-binding-changed',
        severity: 'major',
        title: `\`${key}\` now returns \`${h.typeText}\` (was \`${b.typeText}\`)`,
        detail:
          h.source === 'route'
            ? 'Declared on the route, so this is the served shape.'
            : 'Declared by the studio call site — the type callers are written against.',
        where: `${h.file}:${h.line}`,
        served: true,
        endpoints: [key],
      });
      continue; // the swap is the finding; a field-level diff across two
      // different types would just restate it
    }

    // Inline payloads (`{ ok: boolean }`) have no contract, so the contract
    // pass above never sees them — diff them here.
    if (isInlineType(h.typeText)) {
      const local = [];
      diffShape(b.shape, h.shape, '', (f) => local.push(f));
      for (const f of local)
        add({
          ...f,
          title: `\`${key}\` inline response: ${f.detail}`,
          where: `${h.file}:${h.line}`,
          served: true,
          endpoints: [key],
        });
    }
  }

  for (const [key, b] of bByKey) {
    if (hByKey.has(key)) continue;
    add({
      rule: 'response-binding-removed',
      severity: 'info',
      title: `nothing declares a response type for \`${key}\` any more`,
      detail: 'The call site is gone or was retyped. Not a wire break on its own.',
      where: `${b.file}:${b.line}`,
      served: false,
      endpoints: [key],
    });
  }

  /* 3 — mirror: the client's copy of a contract this change touched. */
  const touched = changedFiles(base, head);
  for (const [name, h] of Object.entries(headSurface.contracts)) {
    if (!touched.has(h.file) && !touched.has(mirrorPath(h.file))) continue;
    const twin = headSurface.mirror[name];
    if (!twin) {
      add({
        rule: 'response-mirror-drift',
        severity: 'major',
        title: `\`${name}\` has no counterpart in the client mirror`,
        detail: `Expected in ${mirrorPath(h.file)}. The studio's types cannot describe this payload.`,
        where: `${h.file}:${h.line}`,
        served: servingEndpoints(headSurface, name).length > 0,
        endpoints: [],
      });
      continue;
    }
    const local = [];
    diffShape(twin.shape, h.shape, '', (f) => local.push(f));
    if (local.length)
      add({
        rule: 'response-mirror-drift',
        severity: 'major',
        title: `\`${name}\`: the client mirror disagrees with the server contract`,
        detail: `${local.length} difference(s), first: ${local[0].detail}. Run ./scripts/check-contracts.sh --fix`,
        where: `${twin.file}:${twin.line}`,
        served: servingEndpoints(headSurface, name).length > 0,
        endpoints: [],
      });
  }

  /* Contracts nothing returns yet are real, but a step less urgent: this repo
     ships contracts ahead of the features that use them (see CLAUDE.md), and a
     report that cries critical over an unwired schema is a report people skip. */
  for (const f of findings) {
    f.effective = f.served === false ? downgrade(f.severity) : f.severity;
  }

  return findings.sort(
    (a, b) =>
      SEVERITY_ORDER.indexOf(a.effective) - SEVERITY_ORDER.indexOf(b.effective) ||
      (a.contract ?? '').localeCompare(b.contract ?? ''),
  );
}

/* ───────────────────────────────── report ───────────────────────────────── */

const ICON = { critical: '🚨', major: '⚠️ ', minor: '·', info: 'ℹ️ ' };

function report(findings, { base, head, onlyServed }) {
  const lines = [];
  const shown = onlyServed ? findings.filter((f) => f.served !== false) : findings;

  lines.push(`# Response schema diff — ${base} → ${head === WORKTREE ? 'working tree' : head}`);
  lines.push('');

  if (!shown.length) {
    lines.push('No response shape changes. Additive optional fields are not reported.');
    return lines.join('\n');
  }

  for (const sev of SEVERITY_ORDER) {
    const group = shown.filter((f) => f.effective === sev);
    if (!group.length) continue;
    lines.push(`## ${sev}`, '');
    for (const f of group) {
      lines.push(`${ICON[sev]} ${f.title}  \`[${f.rule}]\``);
      if (f.detail && !f.title.includes(f.detail)) lines.push(`   ${f.detail}`);
      if (f.alsoIn?.length) {
        const shown = f.alsoIn.slice(0, 4).join(', ');
        const more = f.alsoIn.length > 4 ? ` +${f.alsoIn.length - 4} more` : '';
        lines.push(`   same change also reaches: ${shown}${more}`);
      }
      if (f.endpoints?.length) lines.push(`   served by: ${[...new Set(f.endpoints)].join(', ')}`);
      if (f.served === false) lines.push('   nothing returns this type yet — severity lowered one step');
      lines.push(`   → ${f.where}`);
      lines.push('');
    }
  }

  const hidden = findings.length - shown.length;
  if (hidden) lines.push(`(${hidden} finding(s) on types nothing returns hidden by --only-served)`);
  lines.push('Rationale and the migration for each rule: `.claude/skills/response-schema/rules.md`.');
  return lines.join('\n');
}

/* ────────────────────────────────── cli ────────────────────────────────── */

const HELP = `
response-schema — what changed in the payloads this API returns

  node .claude/skills/response-schema/check.mjs [options]

  --base <ref>     default origin/main (falls back to main)
  --head <ref>     default the working tree, so it runs before a commit
  --fail-on <sev>  exit 1 at or above this severity (default critical)
  --only-served    hide types no endpoint returns yet
  --json           machine-readable findings
  --help

Exit 0 clean · 1 findings at or above --fail-on · 2 the check could not run.
`;

function parseArgs(argv) {
  const opts = { failOn: 'critical', json: false, onlyServed: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => argv[++i];
    if (a === '--help' || a === '-h') opts.help = true;
    else if (a === '--json') opts.json = true;
    else if (a === '--only-served') opts.onlyServed = true;
    else if (a === '--base') opts.base = val();
    else if (a === '--head') opts.head = val();
    else if (a === '--fail-on') opts.failOn = val();
    else if (a.startsWith('--base=')) opts.base = a.slice(7);
    else if (a.startsWith('--head=')) opts.head = a.slice(7);
    else if (a.startsWith('--fail-on=')) opts.failOn = a.slice(10);
    else throw new Error(`unknown option: ${a}`);
  }
  return opts;
}

/** `origin/main` when it exists, else `main` — works on a fresh local clone. */
function defaultBase() {
  for (const ref of ['origin/main', 'main']) {
    if (git(['rev-parse', '--verify', '--quiet', ref], { soft: true })) return ref;
  }
  throw new Error('no origin/main or main to compare against; pass --base');
}

function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`${err.message}\n${HELP}`);
    return 2;
  }
  if (opts.help) {
    process.stdout.write(HELP);
    return 0;
  }
  if (!SEVERITY_ORDER.includes(opts.failOn)) {
    process.stderr.write(`--fail-on must be one of ${SEVERITY_ORDER.join(', ')}\n`);
    return 2;
  }

  const base = opts.base ?? defaultBase();
  const head = opts.head ?? WORKTREE;

  if (!git(['rev-parse', '--verify', '--quiet', base], { soft: true })) {
    process.stderr.write(`base ref not found: ${base}\n`);
    return 2;
  }
  if (head !== WORKTREE && !git(['rev-parse', '--verify', '--quiet', head], { soft: true })) {
    process.stderr.write(`head ref not found: ${head}\n`);
    return 2;
  }

  const findings = compareSurfaces(buildResponseSurface(base), buildResponseSurface(head), { base, head });
  const shown = opts.onlyServed ? findings.filter((f) => f.served !== false) : findings;

  if (opts.json) {
    process.stdout.write(JSON.stringify({ base, head, findings: shown }, null, 2) + '\n');
  } else {
    process.stdout.write(report(findings, { base, head, onlyServed: opts.onlyServed }) + '\n');
  }

  const threshold = SEVERITY_ORDER.indexOf(opts.failOn);
  return shown.some((f) => SEVERITY_ORDER.indexOf(f.effective) <= threshold) ? 1 : 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    process.exitCode = main();
  } catch (err) {
    process.stderr.write(`response-schema failed: ${err.message}\n`);
    process.exitCode = 2;
  }
}