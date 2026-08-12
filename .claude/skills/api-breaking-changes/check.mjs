// Diff two API surfaces and classify what breaks a caller.
//
//   node check.mjs                          # origin/main → working tree
//   node check.mjs --base main --head HEAD
//   node check.mjs --json                   # machine readable
//   node check.mjs --fail-on=major          # default: critical
//
// Exit 0 = nothing at or above the fail level, 1 = breaking changes found,
// 2 = the tool itself could not run (bad ref, no base branch).
//
// Every rule is documented with its rationale in `rules.md`; the `rule` field
// on each finding is the anchor there. If you add a rule here, add it there —
// a severity nobody can justify is a severity people learn to ignore.

import { git, readAt, WORKTREE } from '../source-scan/scan.mjs';
import { buildSurface, canonical, servesPath } from './surface.mjs';

const SEVERITY_ORDER = ['critical', 'major', 'minor', 'info'];
const rank = (s) => SEVERITY_ORDER.indexOf(s);

/* ───────────────────────────── arguments ───────────────────────────── */

function parseArgs(argv) {
  const opts = { base: null, head: WORKTREE, json: false, failOn: 'critical' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') opts.json = true;
    else if (a === '--base') opts.base = argv[++i];
    else if (a === '--head') opts.head = argv[++i];
    else if (a.startsWith('--base=')) opts.base = a.slice(7);
    else if (a.startsWith('--head=')) opts.head = a.slice(7);
    else if (a.startsWith('--fail-on=')) opts.failOn = a.slice(10);
    else if (a === '--help' || a === '-h') opts.help = true;
    else throw new Error(`unknown argument: ${a}`);
  }
  if (!SEVERITY_ORDER.includes(opts.failOn))
    throw new Error(`--fail-on must be one of ${SEVERITY_ORDER.join('|')}`);
  return opts;
}

/**
 * The ref this branch will merge into. Same order as pr-self-review, and the
 * same reason: silently falling back to HEAD would diff a branch against itself
 * and green-light every removal on it.
 */
function resolveBase(explicit) {
  const candidates = explicit
    ? [explicit]
    : [process.env.API_BREAKING_BASE, 'origin/main', 'main'].filter(Boolean);

  for (const ref of candidates) {
    if (git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { soft: true })) {
      const mergeBase = git(['merge-base', ref, 'HEAD'], { soft: true });
      // Merge-base, not the branch tip: otherwise everything merged into main
      // since this branch forked reads as "added by this PR".
      if (mergeBase) return { ref, sha: mergeBase.trim() };
    }
  }
  throw new Error(
    `no base ref found (tried ${candidates.join(', ')}). Pass --base <ref> or set API_BREAKING_BASE.`,
  );
}

/* ─────────────────────────── shape comparison ─────────────────────────── */

const fieldsOf = (shape) => (shape?.kind === 'array' ? shape.of?.fields : shape?.fields) ?? null;

/** Field-level deltas between two resolved shapes. `slot` is only for wording. */
function diffShape(before, after, slot) {
  const out = [];
  if (!before && !after) return out;

  if (before?.kind === 'enum' || after?.kind === 'enum') {
    const b = new Set(before?.values ?? []);
    const a = new Set(after?.values ?? []);
    const removed = [...b].filter((v) => !a.has(v));
    const added = [...a].filter((v) => !b.has(v));
    if (removed.length) out.push({ change: 'enum-value-removed', values: removed });
    if (added.length) out.push({ change: 'enum-value-added', values: added });
    return out;
  }

  const bf = fieldsOf(before);
  const af = fieldsOf(after);
  if (!bf || !af) {
    // One side is a shape this parser cannot model (union, pick/omit, a plain
    // ref). Say so rather than inventing a delta from nothing.
    if (before && after && JSON.stringify(before) !== JSON.stringify(after))
      out.push({ change: 'shape-unmodelled', from: before.kind, to: after.kind });
    return out;
  }

  for (const [name, b] of Object.entries(bf)) {
    const a = af[name];
    if (!a) {
      out.push({ change: 'field-removed', field: name, was: b });
      continue;
    }
    if (!b.required && a.required) out.push({ change: 'field-now-required', field: name });
    // `.nullish()` weakens both axes at once; report the stronger fact only, or
    // every required→nullish change reads as two separate breaks.
    if (b.required && !a.required) out.push({ change: 'field-now-optional', field: name });
    else if (!b.nullable && a.nullable) out.push({ change: 'field-now-nullable', field: name });
    if (b.type !== a.type) out.push({ change: 'field-type-changed', field: name, from: b.type, to: a.type });
  }
  for (const [name, a] of Object.entries(af)) {
    if (!bf[name]) out.push({ change: 'field-added', field: name, required: a.required, slot });
  }
  return out;
}

/* ───────────────────────────── rename scoring ───────────────────────────── */

function levenshtein(a, b) {
  const dp = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = dp[j];
      dp[j] = Math.min(dp[j] + 1, dp[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return dp[b.length];
}

const similarity = (a, b) => 1 - levenshtein(a, b) / Math.max(a.length, b.length, 1);

/**
 * Pair each removed endpoint with the added endpoint most likely to *be* it.
 * A rename and a removal are both breaking, but only a rename has a migration
 * a reviewer can paste into the PR description, so it is worth the guess.
 */
function pairRenames(removed, added) {
  const pairs = [];
  const takenAdds = new Set();
  for (const r of removed) {
    let best = null;
    for (const a of added) {
      if (takenAdds.has(a.key)) continue;
      const sameMethod = a.method === r.method;
      const score =
        similarity(canonical(r.path), canonical(a.path)) * (sameMethod ? 1 : 0.7) +
        // Same path, different verb is a rename of the method, not of the path.
        (canonical(a.path) === canonical(r.path) ? 0.4 : 0);
      if (!best || score > best.score) best = { added: a, score, sameMethod };
    }
    if (best && best.score >= 0.62) {
      takenAdds.add(best.added.key);
      pairs.push({ removed: r, added: best.added, sameMethod: best.sameMethod });
    } else {
      pairs.push({ removed: r, added: null });
    }
  }
  return pairs;
}

/* ────────────────────────────── the check ────────────────────────────── */

export function check({ baseRef, headRef }) {
  const base = buildSurface(baseRef);
  const head = buildSurface(headRef);
  const findings = [];
  const add = (f) => findings.push(f);

  const reachable = (s) => s.endpoints.filter((e) => e.registered);
  const byKey = (list) => new Map(list.map((e) => [e.key, e]));

  const baseReach = byKey(reachable(base));
  const headReach = byKey(reachable(head));
  const headAll = byKey(head.endpoints);

  /* 1 — a module dropped from the registry takes every route with it. */
  const baseModules = new Set(base.registry ?? []);
  const headModules = new Set(head.registry ?? []);
  for (const name of baseModules) {
    if (headModules.has(name)) continue;
    const lost = [...baseReach.values()].filter((e) => e.module === name);
    add({
      severity: 'critical',
      rule: 'module-unregistered',
      title: `module \`${name}\` is no longer registered`,
      detail:
        `\`server/src/modules/index.ts\` no longer registers \`${name}\`, so its ` +
        `${lost.length} endpoint(s) are unreachable even though the route file may still exist.`,
      where: 'server/src/modules/index.ts',
      endpoints: lost.map((e) => `${e.method} ${e.path}`),
    });
  }

  /* 2 — endpoints removed, renamed, or re-verbed. */
  const removed = [...baseReach.values()].filter((e) => !headReach.has(e.key));
  const added = [...headReach.values()].filter((e) => !baseReach.has(e.key));

  for (const { removed: r, added: a, sameMethod } of pairRenames(removed, added)) {
    // Already reported as a whole-module unregistration — don't double-count.
    if (!headModules.has(r.module) && baseModules.has(r.module)) continue;

    const stillDeclared = headAll.get(r.key);
    const consumers = head.consumers.filter(
      (c) => c.method === r.method && servesPath(r.path, c.path),
    );
    const consumerNote = consumers.length
      ? ` Studio still calls it from ${consumers.map((c) => `${c.file}:${c.line}`).join(', ')}.`
      : '';

    if (a && sameMethod && canonical(a.path) !== canonical(r.path)) {
      add({
        severity: 'critical',
        rule: 'endpoint-renamed',
        title: `\`${r.method} ${r.path}\` → \`${a.method} ${a.path}\``,
        detail:
          `The path changed, so every existing caller gets a 404. Ship the new path ` +
          `alongside the old one, or update all callers in the same PR.${consumerNote}`,
        where: `${a.file}:${a.line}`,
        consumers: consumers.map((c) => `${c.file}:${c.line}`),
      });
    } else if (a && !sameMethod) {
      add({
        severity: 'critical',
        rule: 'endpoint-method-changed',
        title: `\`${r.method} ${r.path}\` is now \`${a.method} ${a.path}\``,
        detail: `Callers using ${r.method} get a 404 (Fastify does not fall back across verbs).${consumerNote}`,
        where: `${a.file}:${a.line}`,
        consumers: consumers.map((c) => `${c.file}:${c.line}`),
      });
    } else if (stillDeclared && !stillDeclared.registered) {
      add({
        severity: 'critical',
        rule: 'endpoint-unreachable',
        title: `\`${r.method} ${r.path}\` is declared but not registered`,
        detail:
          `The route still exists in ${stillDeclared.file} but its module is not in the ` +
          `registry, so nothing serves it.${consumerNote}`,
        where: `${stillDeclared.file}:${stillDeclared.line}`,
        consumers: consumers.map((c) => `${c.file}:${c.line}`),
      });
    } else {
      add({
        severity: 'critical',
        rule: 'endpoint-removed',
        title: `\`${r.method} ${r.path}\` was removed`,
        detail: `Existing callers get a 404.${consumerNote}`,
        where: `${r.file}:${r.line}`,
        consumers: consumers.map((c) => `${c.file}:${c.line}`),
      });
    }
  }

  /* 3 — surviving endpoints: path-param renames and request-shape changes. */
  for (const [key, b] of baseReach) {
    const h = headReach.get(key);
    if (!h) continue;

    if (b.path !== h.path) {
      add({
        severity: 'info',
        rule: 'path-param-renamed',
        title: `\`${b.method} ${b.path}\` → \`${h.path}\``,
        detail:
          'Only the parameter name changed, so the wire format is unaffected — but any ' +
          'generated client, doc, or test that names the parameter needs updating.',
        where: `${h.file}:${h.line}`,
      });
    }

    for (const slot of ['body', 'params', 'querystring', 'headers']) {
      const before = b.shapes[slot];
      const after = h.shapes[slot];

      if (!before && after && Object.values(fieldsOf(after) ?? {}).some((f) => f.required)) {
        add({
          severity: 'major',
          rule: 'request-validation-added',
          title: `\`${h.method} ${h.path}\` now validates \`${slot}\``,
          detail:
            `The route had no \`${slot}\` schema before; requests that were accepted ` +
            'unvalidated can now fail with a 422.',
          where: `${h.file}:${h.line}`,
        });
        continue;
      }

      for (const d of diffShape(before, after, slot)) {
        const at = `\`${h.method} ${h.path}\` ${slot}`;
        if (d.change === 'field-added' && d.required)
          add({
            severity: 'major',
            rule: 'request-field-added-required',
            title: `${at}: new required field \`${d.field}\``,
            detail: 'Requests that do not send it now fail validation with a 422.',
            where: `${h.file}:${h.line}`,
          });
        else if (d.change === 'field-now-required')
          add({
            severity: 'major',
            rule: 'request-field-now-required',
            title: `${at}: \`${d.field}\` is no longer optional`,
            detail: 'Callers that omitted it now get a 422.',
            where: `${h.file}:${h.line}`,
          });
        else if (d.change === 'field-type-changed')
          add({
            severity: 'major',
            rule: 'request-field-type-changed',
            title: `${at}: \`${d.field}\` changed from \`${d.from}\` to \`${d.to}\``,
            detail: 'Values a caller already sends may stop validating.',
            where: `${h.file}:${h.line}`,
          });
        else if (d.change === 'enum-value-removed')
          add({
            severity: 'major',
            rule: 'request-enum-value-removed',
            title: `${at}: dropped accepted value(s) ${d.values.map((v) => `\`${v}\``).join(', ')}`,
            detail: 'A caller still sending one gets a 422.',
            where: `${h.file}:${h.line}`,
          });
        else if (d.change === 'field-removed')
          add({
            severity: 'minor',
            rule: 'request-field-removed',
            title: `${at}: \`${d.field}\` is no longer accepted`,
            detail:
              'Zod strips unknown keys by default, so the request still succeeds — but ' +
              'silently ignores a value the caller thinks it is sending.',
            where: `${h.file}:${h.line}`,
          });
      }
    }

    // Response schemas, when a route declares them (rare here — responses are
    // usually typed by the service return type and shaped by the contracts).
    for (const status of new Set([
      ...Object.keys(b.shapes.response ?? {}),
      ...Object.keys(h.shapes.response ?? {}),
    ])) {
      for (const d of diffShape(b.shapes.response?.[status], h.shapes.response?.[status], 'response')) {
        if (d.change === 'field-removed' || d.change === 'field-now-optional' || d.change === 'field-now-nullable')
          add({
            severity: 'critical',
            rule: 'response-field-weakened',
            title: `\`${h.method} ${h.path}\` ${status} response: \`${d.field}\` ${
              d.change === 'field-removed' ? 'removed' : d.change.replace('field-now-', 'now ')
            }`,
            detail: 'Consumers reading that field break at runtime, not at compile time.',
            where: `${h.file}:${h.line}`,
          });
      }
    }
  }

  /* 4 — shared contracts: the response wire format both sides are built on. */
  const baseNames = Object.keys(base.contracts);
  const headNames = Object.keys(head.contracts);
  const goneNames = baseNames.filter((n) => !headNames.includes(n));
  const newNames = headNames.filter((n) => !baseNames.includes(n));

  for (const name of goneNames) {
    const b = base.contracts[name];
    const twin = newNames.find(
      (n) =>
        JSON.stringify(Object.keys(fieldsOf(head.contracts[n].shape) ?? {})) ===
          JSON.stringify(Object.keys(fieldsOf(b.shape) ?? {})) &&
        Object.keys(fieldsOf(b.shape) ?? {}).length > 0,
    );
    add({
      severity: 'critical',
      rule: twin ? 'contract-renamed' : 'contract-removed',
      title: twin
        ? `contract \`${name}\` was renamed to \`${twin}\``
        : `contract \`${name}\` was removed`,
      detail: twin
        ? 'Same fields, new export name. The client mirror and every import of the old name must move with it.'
        : `\`${name}\` is part of the published wire format in \`@devdigest/shared\`; removing it breaks any importer and any client parsing that payload.`,
      where: `${b.file}:${b.line}`,
    });
  }

  for (const name of headNames.filter((n) => baseNames.includes(n))) {
    const b = base.contracts[name];
    const h = head.contracts[name];
    for (const d of diffShape(b.shape, h.shape, 'contract')) {
      const at = `contract \`${name}\``;
      if (d.change === 'field-removed')
        add({
          severity: 'critical',
          rule: 'contract-field-removed',
          title: `${at}: \`${d.field}\` was removed`,
          detail: 'Any consumer reading that field now reads `undefined`; TypeScript will not catch it on data crossing the wire.',
          where: `${h.file}:${h.line}`,
        });
      else if (d.change === 'field-now-optional' || d.change === 'field-now-nullable')
        add({
          severity: 'major',
          rule: 'contract-field-weakened',
          title: `${at}: \`${d.field}\` is now ${d.change === 'field-now-optional' ? 'optional' : 'nullable'}`,
          detail: 'Consumers written against the old shape assume it is always present.',
          where: `${h.file}:${h.line}`,
        });
      else if (d.change === 'field-now-required')
        add({
          severity: 'major',
          rule: 'contract-field-now-required',
          title: `${at}: \`${d.field}\` is now required`,
          detail: 'Every producer of this shape — adapters, seeds, fixtures, the client when it sends it — must now supply it.',
          where: `${h.file}:${h.line}`,
        });
      else if (d.change === 'field-type-changed')
        add({
          severity: 'major',
          rule: 'contract-field-type-changed',
          title: `${at}: \`${d.field}\` changed from \`${d.from}\` to \`${d.to}\``,
          detail: 'Serialized values change shape even when TypeScript still compiles on both sides.',
          where: `${h.file}:${h.line}`,
        });
      else if (d.change === 'enum-value-removed')
        add({
          severity: 'major',
          rule: 'contract-enum-value-removed',
          title: `${at}: dropped value(s) ${d.values.map((v) => `\`${v}\``).join(', ')}`,
          detail: 'Rows already persisted with a dropped value fail to parse on read.',
          where: `${h.file}:${h.line}`,
        });
      else if (d.change === 'enum-value-added')
        add({
          severity: 'info',
          rule: 'contract-enum-value-added',
          title: `${at}: new value(s) ${d.values.map((v) => `\`${v}\``).join(', ')}`,
          detail: 'Forward-compatible on the wire, but exhaustive switches and UI label maps need the new case.',
          where: `${h.file}:${h.line}`,
        });
      else if (d.change === 'field-added' && d.required)
        add({
          severity: 'minor',
          rule: 'contract-field-added-required',
          title: `${at}: new required field \`${d.field}\``,
          detail: 'Additive for readers, breaking for anything that constructs this shape (fixtures, seeds, adapters).',
          where: `${h.file}:${h.line}`,
        });
    }
  }

  /* 5 — the client mirror, but only for contract files this change touched. */
  for (const file of new Set(Object.values(head.contracts).map((c) => c.file))) {
    const mirror = file.replace('server/src/vendor/shared', 'client/src/vendor/shared');
    const changedHere = readAt(baseRef, file) !== readAt(headRef, file);
    if (!changedHere) continue; // pre-existing drift is not this PR's finding
    if (readAt(headRef, file) !== readAt(headRef, mirror))
      add({
        severity: 'major',
        rule: 'contract-mirror-drift',
        title: `\`${file}\` changed but \`${mirror}\` did not follow`,
        detail:
          'The client is built from the mirror, so its types now disagree with the wire ' +
          'format while both packages still typecheck. Run `./scripts/check-contracts.sh --fix`, ' +
          'then re-typecheck the client — and expect it to also land unrelated pre-existing drift.',
        where: mirror,
      });
  }

  /* 6 — client calls with nothing serving them, whatever caused it. */
  for (const c of head.consumers) {
    if (c.sse) continue; // built by string concat; too loose to judge
    const served = [...headReach.values()].some((e) => e.method === c.method && servesPath(e.path, c.path));
    if (served) continue;
    const existedBefore = [...baseReach.values()].some(
      (e) => e.method === c.method && servesPath(e.path, c.path),
    );
    add({
      // Pre-existing orphans are not this change's fault: the studio ships
      // hooks ahead of the API on purpose in this starter (`CLAUDE.md`:
      // "schema and contracts exist ahead of the features that use them").
      // Reporting them as breaks would train people to skip the whole report.
      severity: existedBefore ? 'critical' : 'info',
      rule: 'consumer-without-endpoint',
      title: `studio calls \`${c.method} ${c.path}\` and no route serves it`,
      detail: existedBefore
        ? 'The endpoint this call relied on is gone as of this change.'
        : 'Unserved at the base ref too — pre-existing, listed so a genuine removal is never mistaken for one of these.',
      where: `${c.file}:${c.line}`,
    });
  }

  const dedup = new Map();
  for (const f of findings) dedup.set(`${f.rule}|${f.title}|${f.where}`, f);

  return {
    base: baseRef,
    head: headRef,
    counts: {
      endpoints: { base: baseReach.size, head: headReach.size },
      contracts: { base: baseNames.length, head: headNames.length },
      consumers: head.consumers.length,
    },
    findings: [...dedup.values()].sort((a, b) => rank(a.severity) - rank(b.severity)),
  };
}

/* ────────────────────────────── reporting ────────────────────────────── */

const ICON = { critical: '🛑', major: '⚠️ ', minor: '·', info: 'ℹ️ ' };

function render(result) {
  const { counts, findings } = result;
  const lines = [];
  lines.push('# API breaking-change check');
  lines.push('');
  lines.push(`base \`${result.base}\` → head \`${result.head}\``);
  lines.push('');
  lines.push(
    `Surface: ${counts.endpoints.base} → ${counts.endpoints.head} reachable endpoints · ` +
      `${counts.contracts.base} → ${counts.contracts.head} shared contracts · ` +
      `${counts.consumers} studio call sites.`,
  );
  lines.push('');

  if (!findings.length) {
    lines.push('**No breaking changes detected.**');
    lines.push('');
    lines.push('Additive changes (new endpoints, new optional fields) are not reported.');
    return lines.join('\n');
  }

  const tally = SEVERITY_ORDER.map((s) => [s, findings.filter((f) => f.severity === s).length]).filter(
    ([, n]) => n,
  );
  // Lead with the verdict: a wall of `info` should not read like a wall of breaks.
  const breaking = findings.some((f) => f.severity === 'critical' || f.severity === 'major');
  lines.push(
    `**${breaking ? 'Breaking changes found' : 'No breaking changes'}** — ` +
      tally.map(([s, n]) => `${n} ${s}`).join(' · '),
  );

  for (const sev of SEVERITY_ORDER) {
    const group = findings.filter((f) => f.severity === sev);
    if (!group.length) continue;
    lines.push('');
    lines.push(`## ${sev}`);
    for (const f of group) {
      lines.push('');
      lines.push(`${ICON[f.severity]} ${f.title}  \`[${f.rule}]\``);
      lines.push(`   ${f.detail}`);
      lines.push(`   → ${f.where}`);
      if (f.endpoints?.length) lines.push(`   affected: ${f.endpoints.join(', ')}`);
    }
  }

  lines.push('');
  lines.push('Rationale and the migration for each rule: `.claude/skills/api-breaking-changes/rules.md`.');
  return lines.join('\n');
}

const USAGE = `api-breaking-changes — detect wire-format breaks between two refs

  node check.mjs [--base <ref>] [--head <ref|WORKTREE>] [--json] [--fail-on=<level>]

  --base       ref to compare against (default: origin/main, then main; the
               merge-base with HEAD is used, not the branch tip)
  --head       ref to inspect (default: WORKTREE — uncommitted work included)
  --json       emit the finding list as JSON instead of a report
  --fail-on    critical | major | minor | info   (default: critical)

  API_BREAKING_BASE=<ref> sets the default base.
`;

if (import.meta.url === `file://${process.argv[1]}`) {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`${err.message}\n\n${USAGE}`);
    process.exit(2);
  }
  if (opts.help) {
    process.stdout.write(USAGE);
    process.exit(0);
  }
  try {
    const base = resolveBase(opts.base);
    const result = check({ baseRef: base.sha, headRef: opts.head });
    result.base = `${base.ref} @ ${base.sha.slice(0, 8)}`;
    process.stdout.write(opts.json ? JSON.stringify(result, null, 2) + '\n' : render(result) + '\n');
    const worst = result.findings[0];
    process.exit(worst && rank(worst.severity) <= rank(opts.failOn) ? 1 : 0);
  } catch (err) {
    process.stderr.write(`api-breaking-changes: ${err.message}\n`);
    process.exit(2);
  }
}
