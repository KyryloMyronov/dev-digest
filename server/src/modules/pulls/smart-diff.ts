import type { ProposedSplit, SmartDiff, SmartDiffFile, SmartDiffRole } from '@devdigest/shared';
import {
  SMART_DIFF_MAX_LINES_PER_FINDING,
  SMART_DIFF_MAX_SPLITS,
  SMART_DIFF_SPLIT_MAX_DEPTH,
  SMART_DIFF_TOO_BIG_CORE_FILES,
  SMART_DIFF_TOO_BIG_LINES,
} from './constants.js';

/**
 * L03 — Smart Diff: group a PR's changed files by the ROLE they play in the
 * review, so the diff can be read in the order a human would want it.
 *
 *   core        business logic — read this carefully
 *   wiring      configs, barrels/index files, docs — skim it
 *   boilerplate lock files, build output, snapshots — generated, ignore it
 *
 * Pure functions only — no I/O, no DB, no container, no `this`, and **no model
 * call**. Classification is path-based and deterministic on purpose: the same
 * PR always groups the same way, the answer costs nothing, and it stays correct
 * with no provider key configured. Everything it needs is already persisted —
 * `pr_files` (what `GET /pulls/:id` serves) and the PR's findings (what
 * `GET /pulls/:id/reviews` serves).
 *
 * Where a rule is a judgement call rather than a fact, it is called out below.
 */

// ---- Boilerplate: generated, machine-owned, not worth a reviewer's eyes -----

/** Dependency lock files, across the ecosystems this repo might index. */
const LOCK_FILES = new Set([
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
const GENERATED_DIRS = new Set([
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
const GENERATED_FILE_RE = /(\.snap|\.map|\.min\.js|\.min\.css|\.tsbuildinfo)$/;

// ---- Wiring: real files, but plumbing rather than behaviour -----------------

const WIRING_FILES = new Set([
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

const WIRING_RULES: RegExp[] = [
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

// ---- Inputs ----------------------------------------------------------------

/** One changed file, as `pr_files` stores it (patch text is not needed here). */
export interface SmartDiffFileInput {
  path: string;
  additions: number;
  deletions: number;
}

/** One finding's anchor range, as `findings` stores it. */
export interface FindingRange {
  file: string;
  startLine: number;
  endLine: number;
}

/** A finding plus the identity of the review it came from. */
export interface ReviewedFinding extends FindingRange {
  reviewId: string;
  /** Null for a review with no agent behind it — treated as one bucket. */
  agentId: string | null;
  reviewedAt: Date;
}

/**
 * Keep only the findings of each agent's CURRENT review — the latest review per
 * agent, not the latest review overall.
 *
 * "The latest review" is not a single row here: one `POST /pulls/:id/review`
 * with `all: true` fans out to one review per enabled agent, all landing within
 * milliseconds of each other. Taking the newest row would keep one agent's
 * findings and silently drop every other agent's from the same pass, so the
 * grouping is per agent: a re-review supersedes that agent's previous findings
 * and leaves the other agents' newest reviews alone.
 *
 * Reviews with no `agent_id` share one bucket — they cannot be told apart, and
 * the alternative (one bucket per review) would keep every one of them and
 * defeat the point.
 */
export function latestReviewPerAgent(findings: ReviewedFinding[]): FindingRange[] {
  /** Bucket key. A literal that cannot collide with a uuid. */
  const NO_AGENT = 'no-agent';
  const currentPerAgent = new Map<string, { reviewId: string; at: number }>();
  for (const f of findings) {
    const key = f.agentId ?? NO_AGENT;
    const at = f.reviewedAt.getTime();
    const held = currentPerAgent.get(key);
    // Ties on `created_at` are real (a fan-out writes N reviews at once), so
    // break them on review id — arbitrary, but stable across calls, which is
    // what stops the highlighted lines flickering between two reads.
    if (!held || at > held.at || (at === held.at && f.reviewId > held.reviewId)) {
      currentPerAgent.set(key, { reviewId: f.reviewId, at });
    }
  }
  const current = new Set([...currentPerAgent.values()].map((v) => v.reviewId));
  return findings
    .filter((f) => current.has(f.reviewId))
    .map(({ file, startLine, endLine }) => ({ file, startLine, endLine }));
}

/**
 * Findings and diffs disagree about leading `./` and `/` often enough to be
 * worth normalising; beyond that the two sides are the same repo-relative path
 * and an inexact match is better left unmatched than guessed at.
 */
function normalizePath(path: string): string {
  return path.replace(/^\.?\//, '');
}

/** Total changed lines of a file — the size signal the whole feature keys off. */
function changedLines(f: SmartDiffFileInput): number {
  return f.additions + f.deletions;
}

/**
 * The lines each file's findings point at, so the viewer can highlight them.
 *
 * A range is expanded to every line it covers (highlighting only the first line
 * of a 20-line finding hides most of what it is about) but capped per finding:
 * a finding spanning hundreds of lines is a remark about the file, and painting
 * the whole file is the same as painting nothing.
 */
export function findingLinesByPath(ranges: FindingRange[]): Map<string, number[]> {
  const acc = new Map<string, Set<number>>();
  for (const r of ranges) {
    const key = normalizePath(r.file);
    const start = Math.max(1, r.startLine);
    const end = Math.max(start, Math.min(r.endLine, start + SMART_DIFF_MAX_LINES_PER_FINDING - 1));
    let set = acc.get(key);
    if (!set) acc.set(key, (set = new Set<number>()));
    for (let line = start; line <= end; line++) set.add(line);
  }
  return new Map([...acc].map(([path, set]) => [path, [...set].sort((a, b) => a - b)]));
}

// ---- Split suggestion ------------------------------------------------------

/** The first `depth` directory segments of a path — a file's "area". */
function areaOf(path: string, depth: number): string {
  const segments = normalizePath(path).split('/').filter(Boolean);
  return segments.slice(0, Math.min(depth, segments.length - 1)).join('/') || '(root)';
}

/**
 * Propose smaller PRs by grouping the reviewable files into areas of the tree.
 *
 * The depth is chosen, not fixed: the shallowest depth that actually separates
 * the files. Depth 1 splits a polyrepo change (`server/` vs `client/`); in a
 * change confined to `server/src/modules` only a deeper cut says anything. When
 * no depth separates them the PR is one coherent area and there is nothing
 * honest to suggest — an empty list, rather than an arbitrary cut.
 */
export function proposeSplits(paths: string[], linesOf: (path: string) => number): ProposedSplit[] {
  if (paths.length < 2) return [];

  let chosen: Map<string, string[]> | null = null;
  for (let depth = 1; depth <= SMART_DIFF_SPLIT_MAX_DEPTH; depth++) {
    const byArea = new Map<string, string[]>();
    for (const p of paths) {
      const area = areaOf(p, depth);
      const list = byArea.get(area);
      if (list) list.push(p);
      else byArea.set(area, [p]);
    }
    if (byArea.size >= 2) {
      chosen = byArea;
      break;
    }
  }
  if (!chosen) return [];

  const areas = [...chosen].sort((a, b) => {
    const byLines =
      b[1].reduce((n, p) => n + linesOf(p), 0) - a[1].reduce((n, p) => n + linesOf(p), 0);
    return byLines !== 0 ? byLines : a[0].localeCompare(b[0]);
  });

  // Cap the list: past a handful of suggestions this stops being advice. The
  // tail is merged rather than dropped, so every changed file is accounted for.
  if (areas.length <= SMART_DIFF_MAX_SPLITS) {
    return areas.map(([name, files]) => ({ name, files: [...files].sort() }));
  }
  const head = areas.slice(0, SMART_DIFF_MAX_SPLITS - 1);
  const tail = areas.slice(SMART_DIFF_MAX_SPLITS - 1);
  return [
    ...head.map(([name, files]) => ({ name, files: [...files].sort() })),
    { name: 'everything else', files: tail.flatMap(([, files]) => files).sort() },
  ];
}

// ---- Composition ----------------------------------------------------------

/** Groups are emitted most-worth-reading first, and empty roles are omitted. */
const ROLE_ORDER: SmartDiffRole[] = ['core', 'wiring', 'boilerplate'];

/**
 * Build the SmartDiff for a PR from its changed files and its findings.
 *
 * `too_big` deliberately ignores boilerplate: a 6 000-line `pnpm-lock.yaml`
 * bump is not a large PR to review, and telling someone to split one would be
 * the grouping's first wrong answer. `total_lines` stays the honest total of
 * every changed line, which is what the "large PR" banner reports.
 */
export function buildSmartDiff(files: SmartDiffFileInput[], findings: FindingRange[]): SmartDiff {
  const lines = findingLinesByPath(findings);

  const classified = files.map((f) => {
    const finding_lines = lines.get(normalizePath(f.path)) ?? [];
    const file: SmartDiffFile = {
      path: f.path,
      additions: f.additions,
      deletions: f.deletions,
      finding_lines,
    };
    return { role: classifyPath(f.path), file, size: changedLines(f) };
  });

  const groups = ROLE_ORDER.map((role) => ({
    role,
    files: classified
      .filter((c) => c.role === role)
      // Findings first, then the biggest change: the order a reviewer should
      // open these files in.
      .sort(
        (a, b) =>
          b.file.finding_lines.length - a.file.finding_lines.length ||
          b.size - a.size ||
          a.file.path.localeCompare(b.file.path),
      )
      .map((c) => c.file),
  })).filter((g) => g.files.length > 0);

  const total_lines = classified.reduce((n, c) => n + c.size, 0);
  const reviewable = classified.filter((c) => c.role !== 'boilerplate');
  const reviewableLines = reviewable.reduce((n, c) => n + c.size, 0);
  const coreFiles = classified.filter((c) => c.role === 'core').length;
  const too_big =
    reviewableLines > SMART_DIFF_TOO_BIG_LINES || coreFiles > SMART_DIFF_TOO_BIG_CORE_FILES;

  const sizeByPath = new Map(classified.map((c) => [c.file.path, c.size]));
  return {
    groups,
    split_suggestion: {
      too_big,
      total_lines,
      proposed_splits: too_big
        ? proposeSplits(
            reviewable.map((c) => c.file.path),
            (p) => sizeByPath.get(p) ?? 0,
          )
        : [],
    },
  };
}
