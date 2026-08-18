import type { PrDetail, PrFindingCounts, PrMeta } from '@devdigest/shared';
import type { PrCommitRow, PrFileRow, PullRow } from './repository.js';
import { deriveReviewStatus } from './status.js';

/**
 * F1 — pulls pure helpers (extracted from routes.ts; no behaviour change).
 * Pure functions only — no I/O, no DB, no container, no `this`.
 *
 * Row types (camelCase, Drizzle) and wire types (snake_case, `@devdigest/shared`)
 * are different shapes on purpose; this is the one place they meet.
 */

export interface PrMetaRollups {
  /** Latest `kind='review'` score; `undefined` when never scored. */
  score: number | null | undefined;
  /** Latest settled run cost; `undefined` when no settled run. */
  costUsd: number | null | undefined;
  /** Per-severity counts; `undefined` when never reviewed (→ `null` on the wire). */
  findings: PrFindingCounts | undefined;
}

/** One PR-list row → the `PrMeta` wire shape. */
export function prRowToMeta(row: PullRow, rollups: PrMetaRollups, now: number): PrMeta {
  return {
    id: row.id,
    number: row.number,
    title: row.title,
    author: row.author,
    branch: row.branch,
    base: row.base,
    head_sha: row.headSha,
    additions: row.additions,
    deletions: row.deletions,
    files_count: row.filesCount,
    status: deriveReviewStatus({
      ghStatus: row.status,
      lastReviewedSha: row.lastReviewedSha,
      headSha: row.headSha,
      updatedAt: row.updatedAt,
      now,
    }),
    opened_at: row.openedAt?.toISOString() ?? null,
    updated_at: row.updatedAt?.toISOString() ?? null,
    score: rollups.score ?? null,
    cost_usd: rollups.costUsd ?? null,
    findings: rollups.findings ?? null,
  };
}

/**
 * Persisted PR + its files/commits → the `PrDetail` wire shape. Used on the
 * offline path, where GitHub is unreachable and the DB is the only source.
 * `status` stays GitHub's merge state here (unlike the list, which derives a
 * review-freshness status).
 */
export function prRowToDetail(
  row: PullRow,
  files: PrFileRow[],
  commits: PrCommitRow[],
): PrDetail {
  return {
    id: row.id,
    number: row.number,
    title: row.title,
    author: row.author,
    branch: row.branch,
    base: row.base,
    head_sha: row.headSha,
    additions: row.additions,
    deletions: row.deletions,
    files_count: row.filesCount,
    status: row.status as PrDetail['status'],
    opened_at: row.openedAt?.toISOString() ?? null,
    updated_at: row.updatedAt?.toISOString() ?? null,
    body: row.body ?? null,
    files: files.map((f) => ({
      path: f.path,
      additions: f.additions,
      deletions: f.deletions,
      patch: f.patch ?? null,
    })),
    commits: commits.map((c) => ({
      sha: c.sha,
      message: c.message,
      author: c.author,
      committed_at: c.committedAt?.toISOString() ?? null,
    })),
  };
}
