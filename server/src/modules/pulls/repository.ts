import { and, count, desc, eq, inArray, isNull } from 'drizzle-orm';
import type { PrFindingCounts } from '@devdigest/shared';
import type { Db } from '../../db/client.js';
import * as t from '../../db/schema.js';

/**
 * F1 — pulls data-access layer (extracted from routes.ts; no behaviour change).
 * The ONLY place that touches `pull_requests`, `pr_files` and `pr_commits`.
 *
 * Reads that cross into `reviews` / `agent_runs` are rollups for the PR list,
 * not ownership of those tables — they stay read-only here.
 */

export type PullRow = typeof t.pullRequests.$inferSelect;
export type RepoRow = typeof t.repos.$inferSelect;
export type PrFileRow = typeof t.prFiles.$inferSelect;
export type PrCommitRow = typeof t.prCommits.$inferSelect;

/** One PR as GitHub's list payload describes it (already snake_cased by the adapter). */
export interface UpsertPullValues {
  workspaceId: string;
  repoId: string;
  number: number;
  title: string;
  author: string;
  branch: string;
  base: string;
  headSha: string;
  additions: number;
  deletions: number;
  filesCount: number;
  status: string;
  openedAt: Date | null;
  updatedAt: Date | null;
}

/**
 * One non-dismissed finding plus the identity of the review it came from — the
 * shape `smart-diff.ts` needs to decide which reviews are current.
 */
export interface ReviewedFindingRow {
  reviewId: string;
  /** Null for a review with no agent behind it (seeded, or a legacy row). */
  agentId: string | null;
  reviewedAt: Date;
  file: string;
  startLine: number;
  endLine: number;
}

export interface DiffStats {
  additions: number;
  deletions: number;
  filesCount: number;
}

export class PullsRepository {
  constructor(private db: Db) {}

  // ---- Lookups (workspace-scoped) ------------------------------------------

  async findRepo(workspaceId: string, repoId: string): Promise<RepoRow | undefined> {
    const [row] = await this.db
      .select()
      .from(t.repos)
      .where(and(eq(t.repos.workspaceId, workspaceId), eq(t.repos.id, repoId)));
    return row;
  }

  /** Repo behind a PR. Not workspace-scoped — the PR lookup already was. */
  async findRepoById(repoId: string): Promise<RepoRow | undefined> {
    const [row] = await this.db.select().from(t.repos).where(eq(t.repos.id, repoId));
    return row;
  }

  async findPull(workspaceId: string, prId: string): Promise<PullRow | undefined> {
    const [row] = await this.db
      .select()
      .from(t.pullRequests)
      .where(and(eq(t.pullRequests.workspaceId, workspaceId), eq(t.pullRequests.id, prId)));
    return row;
  }

  async listByRepo(repoId: string): Promise<PullRow[]> {
    return this.db.select().from(t.pullRequests).where(eq(t.pullRequests.repoId, repoId));
  }

  // ---- Writes ---------------------------------------------------------------

  /** Idempotent import — unique on (repo_id, number). */
  async upsertPull(values: UpsertPullValues): Promise<void> {
    await this.db
      .insert(t.pullRequests)
      .values(values)
      .onConflictDoUpdate({
        target: [t.pullRequests.repoId, t.pullRequests.number],
        set: {
          title: values.title,
          headSha: values.headSha,
          status: values.status,
          updatedAt: values.updatedAt,
        },
      });
  }

  async updateDiffStats(prId: string, stats: DiffStats): Promise<void> {
    await this.db.update(t.pullRequests).set(stats).where(eq(t.pullRequests.id, prId));
  }

  async updateDetail(prId: string, values: DiffStats & { body: string | null }): Promise<void> {
    await this.db.update(t.pullRequests).set(values).where(eq(t.pullRequests.id, prId));
  }

  /** Replace the persisted file list wholesale (delete + insert). */
  async replaceFiles(
    prId: string,
    files: { path: string; additions: number; deletions: number; patch: string | null }[],
  ): Promise<void> {
    await this.db.delete(t.prFiles).where(eq(t.prFiles.prId, prId));
    if (files.length > 0) {
      await this.db.insert(t.prFiles).values(files.map((f) => ({ prId, ...f })));
    }
  }

  /** Replace the persisted commit list wholesale (delete + insert). */
  async replaceCommits(
    prId: string,
    commits: { sha: string; message: string; author: string; committedAt: Date | null }[],
  ): Promise<void> {
    await this.db.delete(t.prCommits).where(eq(t.prCommits.prId, prId));
    if (commits.length > 0) {
      await this.db.insert(t.prCommits).values(commits.map((c) => ({ prId, ...c })));
    }
  }

  async listFiles(prId: string): Promise<PrFileRow[]> {
    return this.db.select().from(t.prFiles).where(eq(t.prFiles.prId, prId));
  }

  async listCommits(prId: string): Promise<PrCommitRow[]> {
    return this.db.select().from(t.prCommits).where(eq(t.prCommits.prId, prId));
  }

  /**
   * L03 · Smart Diff — the PR's findings with the review each came from. Same
   * read-only cross into `reviews`/`findings` as the list rollups below: the
   * smart diff highlights findings, it does not own them.
   *
   * Every review is returned, not just the newest; picking which ones count is
   * a policy decision (`smart-diff.ts#latestReviewPerAgent`), and SQL is the
   * wrong place for it — `agent_id` is nullable and ties on `created_at` are
   * real, both of which are far easier to reason about (and test) in one pure
   * function than in a window function.
   *
   * Dismissed findings are excluded here, because that is a fact about the
   * finding rather than a policy: a line the reviewer has already waved off must
   * not keep painting itself. Accepted ones stay — accepting a finding means it
   * is real, which is exactly when you want to see the line.
   */
  async findingsWithReviewByPr(prId: string): Promise<ReviewedFindingRow[]> {
    return this.db
      .select({
        reviewId: t.findings.reviewId,
        agentId: t.reviews.agentId,
        reviewedAt: t.reviews.createdAt,
        file: t.findings.file,
        startLine: t.findings.startLine,
        endLine: t.findings.endLine,
      })
      .from(t.findings)
      .innerJoin(t.reviews, eq(t.findings.reviewId, t.reviews.id))
      .where(and(eq(t.reviews.prId, prId), isNull(t.findings.dismissedAt)));
  }

  // ---- PR-list rollups ------------------------------------------------------
  // Computed on read from `reviews` / `agent_runs` (no FK denormalisation); the
  // list is small, so an IN-query + JS grouping per fact is cheap.

  /** Latest `kind='review'` score per PR. Absent → never scored. */
  async latestReviewScoreByPr(prIds: string[]): Promise<Map<string, number | null>> {
    const out = new Map<string, number | null>();
    if (prIds.length === 0) return out;
    const rows = await this.db
      .select({ prId: t.reviews.prId, score: t.reviews.score })
      .from(t.reviews)
      .where(and(inArray(t.reviews.prId, prIds), eq(t.reviews.kind, 'review')))
      .orderBy(desc(t.reviews.createdAt));
    // Rows are newest-first → first seen per PR is the latest review.
    for (const rv of rows) {
      if (!out.has(rv.prId)) out.set(rv.prId, rv.score);
    }
    return out;
  }

  /**
   * Latest SETTLED run cost per PR.
   *
   * Its own query rather than a join onto the reviews one: "latest review" and
   * "latest settled run" are not guaranteed to be the same row (a failed run
   * produces no review; a review can be deleted independently). Restricted to
   * `status='done'` so the column doesn't blank out mid-run.
   */
  async latestSettledRunCostByPr(prIds: string[]): Promise<Map<string, number | null>> {
    const out = new Map<string, number | null>();
    if (prIds.length === 0) return out;
    const rows = await this.db
      .select({ prId: t.agentRuns.prId, costUsd: t.agentRuns.costUsd })
      .from(t.agentRuns)
      .where(and(inArray(t.agentRuns.prId, prIds), eq(t.agentRuns.status, 'done')))
      .orderBy(desc(t.agentRuns.ranAt));
    for (const run of rows) {
      if (run.prId && !out.has(run.prId)) out.set(run.prId, run.costUsd);
    }
    return out;
  }

  /**
   * Finding counts by severity, summed over EVERY review of the PR — a counter
   * opens a modal onto the same set the detail page renders, so a
   * latest-review-only count would visibly disagree with it.
   *
   * A PR with any review at all gets a counts object — all-zero when that review
   * found nothing. Never-reviewed PRs stay absent from the map (→ null on the
   * wire), which is a different fact from "reviewed and clean".
   */
  async findingCountsByPr(prIds: string[]): Promise<Map<string, PrFindingCounts>> {
    const out = new Map<string, PrFindingCounts>();
    if (prIds.length === 0) return out;

    // Deliberately NOT derived from the latest-review query: that one filters
    // kind='review', so a findings-bearing 'summary' review would otherwise
    // report its PR as never reviewed.
    const reviewed = await this.db
      .selectDistinct({ prId: t.reviews.prId })
      .from(t.reviews)
      .where(inArray(t.reviews.prId, prIds));
    for (const { prId } of reviewed) {
      out.set(prId, { CRITICAL: 0, WARNING: 0, SUGGESTION: 0 });
    }

    const rows = await this.db
      .select({ prId: t.reviews.prId, severity: t.findings.severity, n: count() })
      .from(t.findings)
      .innerJoin(t.reviews, eq(t.findings.reviewId, t.reviews.id))
      .where(inArray(t.reviews.prId, prIds))
      .groupBy(t.reviews.prId, t.findings.severity);
    for (const row of rows) {
      const counts = out.get(row.prId);
      // `findings.severity` is a plain text column, so an unknown value must be
      // dropped rather than become a phantom key on the wire payload.
      if (counts && row.severity in counts) {
        counts[row.severity as keyof PrFindingCounts] += row.n;
      }
    }
    return out;
  }
}
