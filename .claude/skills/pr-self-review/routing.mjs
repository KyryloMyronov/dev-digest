// Phase 2 — map changed files onto the skills in `.claude/skills/`.
//
// This table is the single source of truth. `routing.md` explains the policy
// and how to extend it; it deliberately does NOT copy the table, because two
// copies of a routing table means one stale copy.
//
// Rule order does not matter — every matching rule contributes. A file can
// (and usually should) pick up several skills.

import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { matchesAny, REPO_ROOT } from './lib.mjs';

export const RULES = [
  // ---- frontend -----------------------------------------------------------
  {
    id: 'client-ui',
    match: ['client/src/app/**', 'client/src/components/**'],
    skills: ['frontend-ui-architecture', 'react-best-practices', 'next-best-practices'],
    why: 'React components and App Router routes',
  },
  {
    id: 'client-hooks',
    match: ['client/src/lib/hooks/**'],
    skills: ['frontend-ui-architecture', 'react-best-practices'],
    why: 'data-fetching hooks — state placement and hook rules',
  },
  {
    id: 'client-lib',
    match: ['client/src/lib/**'],
    skills: ['frontend-ui-architecture'],
    why: 'shared client layer — where logic is allowed to live',
  },
  {
    id: 'client-tests',
    match: ['client/**/*.test.ts', 'client/**/*.test.tsx'],
    skills: ['react-testing-library'],
    why: 'component and hook tests',
  },

  // ---- backend ------------------------------------------------------------
  {
    id: 'server-routes',
    match: ['server/src/modules/*/routes.ts'],
    skills: ['fastify-best-practices', 'onion-architecture'],
    why: 'presentation ring — transport only, no business logic',
  },
  {
    id: 'server-services',
    match: ['server/src/modules/*/service.ts', 'server/src/adapters/**'],
    skills: ['onion-architecture'],
    why: 'application ring and adapter implementations',
  },
  {
    // Catch-all for module internals. Added after the coverage report showed
    // constants.ts / helpers.ts / run-executor.ts falling through the rules
    // above — every file inside a module still lives on some ring.
    id: 'server-modules',
    match: ['server/src/modules/**'],
    skills: ['onion-architecture'],
    why: 'anything inside a module belongs to a ring and obeys the dependency rule',
  },
  {
    id: 'server-composition-root',
    match: ['server/src/platform/**', 'server/.dependency-cruiser.cjs'],
    skills: ['onion-architecture'],
    why: 'the composition root and the lint config that enforces the rings — change them together',
  },
  {
    id: 'server-persistence',
    match: ['server/src/modules/*/repository*.ts', 'server/src/db/**'],
    skills: ['drizzle-orm-patterns', 'onion-architecture'],
    why: 'the only ring allowed to know drizzle-orm',
  },
  {
    id: 'server-schema',
    match: ['server/src/db/schema.ts', 'server/src/db/schema/**'],
    skills: ['postgresql-table-design'],
    why: 'table design, types, indexes, constraints',
  },
  {
    id: 'reviewer-core',
    match: ['reviewer-core/src/**'],
    skills: ['onion-architecture'],
    why: 'domain core (ring 1) — must stay free of I/O',
  },

  // ---- contracts ----------------------------------------------------------
  {
    id: 'contracts',
    match: ['server/src/vendor/shared/**', 'client/src/vendor/shared/**'],
    skills: ['zod'],
    checks: ['./scripts/check-contracts.sh'],
    why: 'the shared Zod contracts, mirrored across two packages',
  },

  // ---- docs-only guidance (no skill exists for these) ----------------------
  {
    id: 'server-tests',
    match: ['server/test/**', 'reviewer-core/**/*.test.ts'],
    skills: [],
    docs: ['TESTING.md'],
    why: 'unit and integration suites — strategy and suite map',
  },
  {
    // Deliberately skill-free: marks prose as routed so it stops showing up
    // as a coverage gap. Reviewing markdown with a React skill helps nobody.
    id: 'prose',
    match: ['**/*.md', '**/*.mdc'],
    skills: [],
    why: 'documentation — no code skill applies',
  },
  {
    id: 'e2e',
    match: ['e2e/**'],
    skills: [],
    docs: ['e2e/AGENTS.md'],
    why: 'deterministic browser flows — conventions live in the package AGENTS.md',
  },
  {
    id: 'ci',
    match: ['.github/workflows/**', 'scripts/**'],
    skills: [],
    docs: ['TESTING.md'],
    why: 'CI and dev scripts — suite map and strategy',
  },

  // ---- universal ----------------------------------------------------------
  // Flagged so the coverage report can tell "reviewed by a domain skill" from
  // "only picked up the catch-alls" — the latter is a routing gap to fill.
  {
    id: 'typescript',
    match: ['**/*.ts', '**/*.tsx', '**/*.mts', '**/*.mjs'],
    skills: ['typescript-expert'],
    universal: true,
    why: 'every TypeScript file',
  },
  {
    id: 'security',
    match: ['**'],
    exclude: ['**/*.md', '**/*.mdc', 'client/messages/**', '**/*.snap'],
    skills: ['security'],
    universal: true,
    why: 'every changed file that can execute gets an OWASP pass',
  },
];

/** Skill directories that actually exist on disk right now. */
export function installedSkills() {
  return new Set(
    readdirSync(join(REPO_ROOT, '.claude/skills'), { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name),
  );
}

/** Route one path. Returns the skills, docs, extra checks and matched rules. */
export function route(path) {
  const skills = new Set();
  const docs = new Set();
  const checks = new Set();
  const rules = [];
  let domainRule = false;

  for (const rule of RULES) {
    if (!matchesAny(path, rule.match)) continue;
    if (rule.exclude && matchesAny(path, rule.exclude)) continue;
    rules.push(rule.id);
    rule.skills.forEach((s) => skills.add(s));
    (rule.docs ?? []).forEach((d) => docs.add(d));
    (rule.checks ?? []).forEach((c) => checks.add(c));
    if (!rule.universal) domainRule = true;
  }

  return {
    skills: [...skills],
    docs: [...docs],
    checks: [...checks],
    rules,
    // No non-universal rule matched → nothing in routing.md speaks to this
    // file. Not an error, but worth surfacing so the table can grow.
    uncovered: !domainRule,
  };
}

/** Route a whole changeset and build the coverage view. */
export function routeAll(files) {
  const installed = installedSkills();
  const routed = files.map((f) => ({ ...f, routing: route(f.path) }));

  const bySkill = new Map();
  const checks = new Set();
  for (const f of routed) {
    for (const s of f.routing.skills) {
      if (!bySkill.has(s)) bySkill.set(s, []);
      bySkill.get(s).push(f.path);
    }
    f.routing.checks.forEach((c) => checks.add(c));
  }

  const missing = [...bySkill.keys()].filter((s) => !installed.has(s));

  return {
    files: routed,
    bySkill: [...bySkill.entries()]
      .map(([skill, paths]) => ({ skill, count: paths.length, paths }))
      .sort((a, b) => b.count - a.count || a.skill.localeCompare(b.skill)),
    uncovered: routed.filter((f) => f.routing.uncovered).map((f) => f.path),
    checks: [...checks],
    // A rule pointing at a skill nobody installed routes to nothing.
    missingSkills: missing,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const installed = installedSkills();
  console.log('| rule | match | skills |');
  console.log('|---|---|---|');
  for (const r of RULES) {
    const skills =
      r.skills.map((s) => (installed.has(s) ? s : `${s} ⚠️ not installed`)).join(', ') ||
      (r.docs ?? []).map((d) => `→ ${d}`).join(', ') ||
      '—';
    console.log(`| \`${r.id}\` | ${r.match.map((m) => `\`${m}\``).join(' ')} | ${skills} |`);
  }
}
