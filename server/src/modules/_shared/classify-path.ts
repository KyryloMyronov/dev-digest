import type { SmartDiffRole } from '@devdigest/shared';

/**
 * The deterministic path classifier behind the Smart Diff's grouping.
 *
 *   core        business logic — read this carefully
 *   wiring      configs, barrels/index files, docs — skim it
 *   boilerplate lock files, build output, snapshots — generated, ignore it
 *
 * MOVED HERE FROM `modules/pulls/smart-diff.ts` BY SPEC-03 (plan D-6) so the
 * file-summary derivation can honour AC-18 — "exclude every file the classifier
 * assigns `boilerplate` from a PR-level derivation's selection" — with the SAME
 * rules the tab groups by. `no-cross-module-internals` forbids
 * `modules/file-summary/**` importing `modules/pulls/smart-diff.js`, and
 * `_shared/` is on that rule's allow-list. `modules/pulls/smart-diff.ts`
 * re-exports `classifyPath`, so there is exactly ONE implementation — a second
 * copy is precisely the disagreement AC-18 exists to prevent.
 *
 * Pure functions only — no I/O, no DB, no container, no `this`, and **no model
 * call**. Classification is path-based and deterministic on purpose: the same
 * PR always groups the same way, the answer costs nothing, and it stays correct
 * with no provider key configured.
 *
 * THE RULES ARE UNCHANGED BY SPEC-03 and are a Non-goal of it: a behaviour
 * change here would silently move which group a file lands in, on the tab and
 * in the derivation at once. Where a rule is a judgement call rather than a
 * fact, it is called out below.
 */

// ---- Boilerplate: generated, machine-owned, not worth a reviewer's eyes -----

/** Dependency lock files, across the ecosystems this repo might index. */
export const LOCK_FILES = new Set([
  'pnpm-lock.yaml',
  'package-lock.json',
  'npm-shrinkwrap.json',
  'yarn.lock',
  'bun.lockb',
  'cargo.lock',
  'poetry.lock',
  'uv.lock',
  'pdm.lock',
  'composer.lock',
  'gemfile.lock',
  'go.sum',
]);

/**
 * A path segment anywhere in the path that makes the file generated output.
 *
 * `migrations` is here because drizzle-kit writes `src/db/migrations/**` and the
 * root rules forbid hand-editing an applied one — reviewing the SQL line by line
 * is not the point. `vendor` covers this repo's own mirrored trees
 * (`src/vendor/shared`, `client/src/vendor/ui`), which are synced, not authored.
 */
export const GENERATED_DIRS = new Set([
  'dist',
  'build',
  'out',
  '.next',
  'coverage',
  'node_modules',
  '__snapshots__',
  '__generated__',
  'generated',
  'migrations',
  'vendor',
]);

/** Generated file suffixes: snapshots, source maps, minified bundles, tsc cache. */
export const GENERATED_FILE_RE = /(\.snap|\.map|\.min\.js|\.min\.css|\.tsbuildinfo)$/;

// ---- Wiring: real files, but plumbing rather than behaviour -----------------

export const WIRING_FILES = new Set([
  'package.json',
  'pnpm-workspace.yaml',
  'docker-compose.yml',
  'docker-compose.yaml',
  '.gitignore',
  '.dockerignore',
  '.npmrc',
  '.nvmrc',
  '.editorconfig',
  'makefile',
  'license',
]);

export const WIRING_RULES: RegExp[] = [
  /** A barrel/entry file — it re-exports, it rarely decides anything. */
  /^index\.(ts|tsx|js|jsx|mjs|cjs)$/,
  /** `vitest.config.ts`, `next.config.mjs`, `drizzle.config.ts`, … */
  /\.config\.(ts|tsx|js|mjs|cjs|json|ya?ml)$/,
  /** `tsconfig.json`, `tsconfig.build.json`, `jsconfig.json` */
  /^(ts|js)config(\..+)?\.json$/,
  /** Dotfile config: `.eslintrc`, `.prettierrc.json`, `.env`, `.env.example` */
  /^\..+rc(\..+)?$/,
  /^\.env(\..+)?$/,
  /** `Dockerfile`, `Dockerfile.dev` */
  /^dockerfile(\..+)?$/,
  /** CI/infra descriptors and other declarative formats. */
  /\.(ya?ml|toml|ini|cfg)$/,
  /**
   * Docs. A judgement call: prose is neither logic nor generated output, and of
   * the three roles "skim it" is the honest one — a reviewer should read a
   * README change, but not before the code it describes.
   */
  /\.(md|mdx|txt|rst)$/,
];

/**
 * The role a changed file plays. Order matters: a `dist/index.js` is generated
 * output first and an index file second, so boilerplate is decided before
 * wiring, and anything left over is core.
 */
export function classifyPath(path: string): SmartDiffRole {
  const segments = path.split('/').filter(Boolean);
  const base = (segments[segments.length - 1] ?? path).toLowerCase();
  const dirs = segments.slice(0, -1).map((s) => s.toLowerCase());

  if (LOCK_FILES.has(base)) return 'boilerplate';
  if (GENERATED_FILE_RE.test(base)) return 'boilerplate';
  if (dirs.some((d) => GENERATED_DIRS.has(d))) return 'boilerplate';

  if (WIRING_FILES.has(base)) return 'wiring';
  if (dirs[0] === '.github') return 'wiring';
  if (WIRING_RULES.some((re) => re.test(base))) return 'wiring';

  return 'core';
}
