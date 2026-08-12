// Diff two response surfaces and classify what breaks a *reader* of the API.
//
//   node check.mjs                          # origin/main → working tree
//   node check.mjs --base main --head HEAD
//   node check.mjs --json                   # machine readable
//   node check.mjs --fail-on=major          # default: critical
//
// Exit 0 = nothing at or above the fail level, 1 = response breaks found,
// 2 = the tool itself could not run.
//
// Severity here is about the reader, which is why it does not match
// `api-breaking-changes` rule for rule:
//
//   critical  a live reader gets `undefined`, `null`, or a different type at
//             runtime, and nothing fails to compile on the way there
//   major     a reader must change to stay correct
//   minor     only a *producer* pays — fixtures, seeds, adapters, mappers
//   info      wire-compatible; a label, a `switch`, or a docstring to update
//
// Every rule is documented with its migration in `rules.md`.

import { git, readAt, WORKTREE } from '../source-scan/scan.mjs';
import { buildResponseSurface, createReaderLookup } from './response-surface.mjs';
import { arrayDepth, describeShape, diffShape, typeOf, unwrap } from './shapes.mjs';

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
 * The ref this branch will merge into — merge-base, not the branch tip, so
 * everything merged into main since the fork does not read as "added here".
 */
function resolveBase(explicit) {
  const candidates = explicit
    ? [explicit]
    : [process.env.API_RESPONSE_BASE, 'origin/main', 'main'].filter(Boolean);

  for (const ref of candidates) {
    if (git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { soft: true })) {
      const mergeBase = git(['merge-base', ref, 'HEAD'], { soft: true });
      if (mergeBase) return { ref, sha: mergeBase.trim() };
    }
  }
  throw new Error(
    `no base ref found (tried ${candidates.join(', ')}). Pass --base <ref> or set API_RESPONSE_BASE.`,
  );
}

/* ──────────────────────── diff kind → rule table ──────────────────────── */

/**
 * One entry per shape difference `diffShape` can report. `severity` is from the
 * reader's point of view; `why` is what the reader actually experiences, and is
 * printed with the finding so the severity is never a bare assertion.
 */
const RULES = {
  'field-removed': {
    rule: 'response-field-removed',
    severity: 'critical',
    verb: 'is gone from the response',
    why: 'Readers get `undefined`. The studio types come from the hand-synced mirror, so this compiles on both sides until the mirror is synced — and renders blank rather than failing.',
  },
  'field-now-optional': {
    rule: 'response-field-now-optional',
    severity: 'critical',
    verb: 'became optional',
    why: 'The key can now be absent. Every reader written against the old shape assumes it is there, and reads `undefined` when it is not.',
  },
  'field-now-nullable': {
    rule: 'response-field-now-nullable',
    severity: 'major',
    verb: 'became nullable',
    why: 'The key is still present but the value can be `null`. Readers doing arithmetic, formatting, or `.length` on it break; `null` and `0` are different facts, so resolve the display default at the UI, never in the contract.',
  },
  'field-now-nullish': {
    rule: 'response-field-now-nullish',
    severity: 'critical',
    verb: 'became `.nullish()` — may be absent *or* null',
    why: 'One edit weakened both presence and value. A reader must now handle the key missing and the value being `null`; optional chaining alone covers only half of that.',
  },
  'field-type-changed': {
    rule: 'response-field-type-changed',
    severity: 'critical',
    verb: 'changed type',
    why: 'Serialized values change shape. Both packages can still compile while the wire format and the reader disagree.',
  },
  'type-changed': {
    rule: 'response-field-type-changed',
    severity: 'critical',
    verb: 'changed type',
    why: 'The payload is a different type than it was.',
  },
  'array-changed': {
    rule: 'response-array-changed',
    severity: 'critical',
    verb: 'changed array nesting',
    why: 'A reader that maps over this gets a non-iterable, or one that reads properties off it gets an array. Neither fails at compile time across the wire.',
  },
  'enum-value-removed': {
    rule: 'response-enum-value-removed',
    severity: 'major',
    verb: 'lost an enum value',
    why: 'Rows already persisted with the dropped value fail to parse on read. Migrate the data in the same change, or keep the value and mark it deprecated.',
  },
  'enum-value-added': {
    rule: 'response-enum-value-added',
    severity: 'minor',
    verb: 'gained an enum value',
    why: 'Forward-compatible on the wire, but exhaustive `switch`es, badge colour maps, and label lookups in the studio need the new case or they fall through to a default.',
  },
  'field-now-required': {
    rule: 'response-field-now-required',
    severity: 'minor',
    verb: 'became required',
    why: 'Readers are unaffected — this only binds producers. Every adapter, seed, fixture and mapper that builds this payload must now supply a value.',
  },
  'field-added-required': {
    rule: 'response-field-added-required',
    severity: 'minor',
    verb: 'is new and required',
    why: 'Additive for readers, breaking for whoever constructs the shape (fixtures, seeds, adapters).',
  },
  'field-not-nullable': {
    rule: 'response-field-not-nullable',
    severity: 'info',
    verb: 'is no longer nullable',
    why: 'Strictly safer for readers. Listed so the now-dead null branches in the studio can be cleaned up.',
  },
};

/* ────────────────────────────── the check ────────────────────────────── */

export function check({ baseRef, headRef }) {
  const base = buildResponseSurface(baseRef);
  const head = buildResponseSurface(headRef);
  const readersOf = createReaderLookup(headRef);

  const findings = [];
  const add = (f) => findings.push(f);

  const baseEp = new Map(base.endpoints.filter((e) => e.registered).map((e) => [e.key, e]));
  const headEp = new Map(head.endpoints.filter((e) => e.registered).map((e) => [e.key, e]));

  /** Which endpoints serve this contract, for the finding text. */
  const servedBy = (name) => head.contracts[name]?.servedBy ?? base.contracts[name]?.servedBy ?? [];

  /** Emit the shape diff between two response shapes under one subject. */
  const reportShapeDiff = (before, after, { subject, where, contract, endpoints }) => {
    const b = unwrap(before);
    const a = unwrap(after);

    // The flagship: `.partial()` on a response makes every field optional at
    // once, and the sibling skill cannot see inside a derived schema at all.
    if (a?.partialed && !b?.partialed && a.fields) {
      add({
        severity: 'critical',
        rule: 'response-shape-partialed',
        title: `${subject} is now \`.partial()\` — all ${Object.keys(a.fields).length} fields optional`,
        detail:
          'Every field on this response can now be absent, from a single `.partial()`. ' +
          `Fields: ${Object.keys(a.fields).join(', ')}. ` +
          'Readers assume presence on all of them.',
        where,
        ...(endpoints?.length ? { endpoints } : {}),
      });
      return; // the per-field noise underneath adds nothing
    }

    for (const d of diffShape(before, after)) {
      const spec = RULES[d.kind];
      if (!spec) continue;
      const detail =
        d.kind === 'enum-value-removed' || d.kind === 'enum-value-added'
          ? `\`${d.value}\`. ${spec.why}`
          : d.from && d.to
            ? `\`${d.from}\` → \`${d.to}\`. ${spec.why}`
            : spec.why;
      const readers =
        spec.severity === 'critical' && d.path ? readersOf(contract, d.path) : [];

      add({
        severity: spec.severity,
        rule: spec.rule,
        title: `${subject}: \`${d.path || '(payload)'}\` ${spec.verb}`,
        detail,
        where,
        ...(endpoints?.length ? { endpoints } : {}),
        ...(readers.length ? { readers } : {}),
      });
    }
  };

  /* 1 — response contracts: the shape most endpoints actually return. */
  const responseContracts = new Set(
    [...Object.values(base.contracts), ...Object.values(head.contracts)]
      .filter((c) => c.servedBy.length)
      .map((c) => c.name),
  );

  for (const name of responseContracts) {
    const b = base.contracts[name];
    const h = head.contracts[name];
    const eps = servedBy(name);

    if (b && !h) {
      add({
        severity: 'critical',
        rule: 'response-contract-removed',
        title: `response contract \`${name}\` no longer exists`,
        detail:
          `It was the response shape for ${eps.length ? eps.join(', ') : 'an endpoint'} at the base ref. ` +
          'Remember this repo ships contracts ahead of the features that use them — a contract with no ' +
          'module behind it is not dead, so check this removal was intended.',
        where: `${b.file}:${b.line}`,
        endpoints: eps,
      });
      continue;
    }
    if (!b || !h) continue;

    reportShapeDiff(b.shape, h.shape, {
      subject: `\`${name}\``,
      where: `${h.file}:${h.line}`,
      contract: name,
      endpoints: eps,
    });
  }

  /* 2 — per endpoint: which contract it returns, and whether it is still one. */
  for (const [key, h] of headEp) {
    const b = baseEp.get(key);
    if (!b) continue; // a new endpoint cannot break a reader

    const where = `${h.file}:${h.line}`;

    if (b.contract && h.contract && b.contract !== h.contract) {
      add({
        severity: 'critical',
        rule: 'response-contract-swapped',
        title: `\`${key}\` now returns \`${h.contract}\` instead of \`${b.contract}\``,
        detail:
          `Resolved through ${h.serviceMethod ?? h.via} → \`${h.returnType ?? typeOf(h.shape)}\`. ` +
          'Readers of this endpoint are typed against the old contract.',
        where,
      });
    } else if (arrayDepth(b.shape) !== arrayDepth(h.shape) && b.shape && h.shape) {
      add({
        severity: 'critical',
        rule: 'response-array-changed',
        title: `\`${key}\` response changed from \`${typeOf(b.shape)}\` to \`${typeOf(h.shape)}\``,
        detail:
          'A reader that maps over this gets a non-iterable, or one that reads properties off it gets ' +
          'an array. Nothing catches it at compile time across the wire.',
        where,
      });
    }

    // Declared `response:` statuses, when a route has them.
    for (const status of Object.keys(b.statuses ?? {}))
      if (h.statuses && !h.statuses[status])
        add({
          severity: 'major',
          rule: 'response-status-removed',
          title: `\`${key}\` no longer declares a ${status} response`,
          detail: 'The serializer for that status is gone; whatever the handler returns is sent unvalidated.',
          where,
        });

    // Inline and declared shapes have no contract name, so they are diffed here
    // rather than in pass 1. Contract-backed endpoints are already covered there.
    if (!h.contract && !b.contract && b.shape && h.shape)
      reportShapeDiff(b.shape, h.shape, {
        subject: `\`${key}\` response`,
        where,
        contract: null,
      });

    // A response we could verify before and cannot now: not a break, but the
    // check has gone blind on this endpoint, and silence would read as "safe".
    if (b.shape && !h.shape && readAt(baseRef, h.file) !== readAt(headRef, h.file))
      add({
        severity: 'info',
        rule: 'response-unresolvable',
        title: `\`${key}\` response shape can no longer be resolved`,
        detail:
          `Was \`${describeShape(b.shape)}\` via ${b.via}; now ${h.via}. Usually the handler stopped ` +
          'returning an annotated service method. Annotate the method\'s return type to restore coverage.',
        where,
      });
  }

  /* 3 — the client mirror, for response contracts only. */
  const responseFiles = new Set(
    [...responseContracts].map((n) => head.contracts[n]?.file).filter(Boolean),
  );
  for (const file of responseFiles) {
    const mirror = file.replace('server/src/vendor/shared', 'client/src/vendor/shared');
    if (readAt(baseRef, file) === readAt(headRef, file)) continue; // untouched here
    if (readAt(headRef, file) !== readAt(headRef, mirror))
      add({
        severity: 'major',
        rule: 'response-mirror-drift',
        title: `\`${file}\` changed but \`${mirror}\` did not follow`,
        detail:
          'This file holds response contracts the studio is typed from. Until the mirror is synced the ' +
          'client believes an older wire format while both packages still typecheck. Run ' +
          '`./scripts/check-contracts.sh --fix`, then `cd client && pnpm typecheck`.',
        where: mirror,
      });
  }

  const dedup = new Map();
  for (const f of findings) dedup.set(`${f.rule}|${f.title}|${f.where}`, f);

  return {
    base: baseRef,
    head: headRef,
    counts: {
      endpoints: { base: baseEp.size, head: headEp.size },
      resolved: { base: base.resolved, head: head.resolved },
      responseContracts: responseContracts.size,
    },
    findings: [...dedup.values()].sort((a, b) => rank(a.severity) - rank(b.severity)),
  };
}

/* ────────────────────────────── reporting ────────────────────────────── */

const ICON = { critical: '🛑', major: '⚠️ ', minor: '·', info: 'ℹ️ ' };

function render(result) {
  const { counts, findings } = result;
  const lines = [];
  lines.push('# API response-change check');
  lines.push('');
  lines.push(`base \`${result.base}\` → head \`${result.head}\``);
  lines.push('');
  lines.push(
    `Surface: ${counts.endpoints.head} reachable endpoints, ${counts.resolved.head} with a ` +
      `resolvable response shape (${counts.resolved.base} at base) · ` +
      `${counts.responseContracts} contracts served as a response.`,
  );
  lines.push('');

  if (!findings.length) {
    lines.push('**No response changes that break a reader.**');
    lines.push('');
    lines.push('New endpoints and new optional fields are additive and not reported.');
    return lines.join('\n');
  }

  const tally = SEVERITY_ORDER.map((s) => [s, findings.filter((f) => f.severity === s).length]).filter(
    ([, n]) => n,
  );
  const breaking = findings.some((f) => f.severity === 'critical' || f.severity === 'major');
  lines.push(
    `**${breaking ? 'Response breaks found' : 'No response breaks'}** — ` +
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
      if (f.endpoints?.length) lines.push(`   served by: ${f.endpoints.join(', ')}`);
      if (f.readers?.length) lines.push(`   read at: ${f.readers.join(', ')}`);
    }
  }

  lines.push('');
  lines.push('Rationale and the migration for each rule: `.claude/skills/api-response-changes/rules.md`.');
  return lines.join('\n');
}

const USAGE = `api-response-changes — what this change does to API response payloads

  node check.mjs [--base <ref>] [--head <ref|WORKTREE>] [--json] [--fail-on=<level>]

  --base       ref to compare against (default: origin/main, then main; the
               merge-base with HEAD is used, not the branch tip)
  --head       ref to inspect (default: WORKTREE — uncommitted work included)
  --json       emit the finding list as JSON instead of a report
  --fail-on    critical | major | minor | info   (default: critical)

  API_RESPONSE_BASE=<ref> sets the default base.

  node response-surface.mjs [ref] --summary    # what each endpoint returns
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
    process.stderr.write(`api-response-changes: ${err.message}\n`);
    process.exit(2);
  }
}
