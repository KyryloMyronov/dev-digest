import { and, eq, sql } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import * as t from '../../db/schema.js';

/**
 * SPEC-03 — file-summary data-access. The ONLY layer in this module touching the
 * DB, and the ONLY file here allowed to import `drizzle-orm`
 * (`no-drizzle-outside-persistence` whitelists `repository.ts`).
 *
 * AC-4 LIVES HERE. Every read joins `pull_requests` and filters on
 * `workspace_id` — `pr_file_summaries` carries no `workspace_id` of its own,
 * exactly as `pr_intent` and `pr_brief` do not, and all three scope through
 * `pr_id → pull_requests`. Do NOT rely on the service having checked first: the
 * criterion is about the QUERY, and the integration test reads the same PR id
 * under a second workspace.
 *
 * AC-37 IS ENFORCED BY THE CALLER, asserted here only by shape:
 * `upsertSummaries` takes rows and writes them, and the PIPELINE is what
 * guarantees every row's path was in that derivation's own selection. Do not add
 * a "write whatever the model said" convenience on top of this.
 *
 * A FAILED derivation writes NOTHING. Unlike `pr_brief`, a failure row here
 * would not overwrite a good one (the PK includes `head_sha`) — but it would
 * still be SERVED by `listSummaries` as a summary. Do NOT add an
 * error-recording write.
 */

/** One row as the pipeline writes it. */
export interface InsertFileSummary {
  prId: string;
  path: string;
  headSha: string;
  summary: string;
  provider: string | null;
  model: string | null;
  /** This file's SHARE of the derivation's usage/cost (plan D-1). */
  tokensIn: number | null;
  tokensOut: number | null;
  costUsd: number | null;
}

/** A stored row, as read back. */
export type FileSummaryRow = typeof t.prFileSummaries.$inferSelect;

export class FileSummaryRepository {
  constructor(private db: Db) {}

  /**
   * The PR's summaries, ONE ROW PER PATH (plan D-2).
   *
   * `SELECT DISTINCT ON (fs.path) … ORDER BY fs.path,
   *  (fs.head_sha = p.head_sha) DESC, fs.created_at DESC`, via Drizzle's
   * `selectDistinctOn` (present in 0.38, so no raw fragment is needed for the
   * dedupe itself; the boolean ordering term is one `sql` expression).
   *
   * THE `(fs.head_sha = p.head_sha) DESC` TERM IS NOT DECORATION. It makes a
   * current-head row always win, so AC-49 renders the fresh summary and AC-58
   * fires only when NO current-head row exists — which is the only reading under
   * which those two criteria do not both apply to the same file. It also removes
   * the same-millisecond `created_at` tie entirely.
   *
   * Rows accumulate per head SHA (the PK includes it), so without this
   * projection NFR-5's 32 KB ceiling would grow without bound across
   * force-pushes.
   */
  async listSummaries(workspaceId: string, prId: string): Promise<FileSummaryRow[]> {
    return this.db
      .selectDistinctOn([t.prFileSummaries.path], {
        prId: t.prFileSummaries.prId,
        path: t.prFileSummaries.path,
        headSha: t.prFileSummaries.headSha,
        summary: t.prFileSummaries.summary,
        provider: t.prFileSummaries.provider,
        model: t.prFileSummaries.model,
        tokensIn: t.prFileSummaries.tokensIn,
        tokensOut: t.prFileSummaries.tokensOut,
        costUsd: t.prFileSummaries.costUsd,
        createdAt: t.prFileSummaries.createdAt,
      })
      .from(t.prFileSummaries)
      .innerJoin(t.pullRequests, eq(t.pullRequests.id, t.prFileSummaries.prId))
      .where(
        and(eq(t.prFileSummaries.prId, prId), eq(t.pullRequests.workspaceId, workspaceId)),
      )
      .orderBy(
        t.prFileSummaries.path,
        sql`(${t.prFileSummaries.headSha} = ${t.pullRequests.headSha}) desc`,
        sql`${t.prFileSummaries.createdAt} desc`,
      );
  }

  /**
   * The rows stored for one PR AT ONE HEAD — the pipeline's cache read (AC-16).
   *
   * Workspace-scoped like every other read here, and keyed on the head as well
   * as the PR: a force-push means a stored summary describes code that no longer
   * exists.
   */
  async listSummariesAtHead(
    workspaceId: string,
    prId: string,
    headSha: string,
  ): Promise<FileSummaryRow[]> {
    return this.db
      .select({
        prId: t.prFileSummaries.prId,
        path: t.prFileSummaries.path,
        headSha: t.prFileSummaries.headSha,
        summary: t.prFileSummaries.summary,
        provider: t.prFileSummaries.provider,
        model: t.prFileSummaries.model,
        tokensIn: t.prFileSummaries.tokensIn,
        tokensOut: t.prFileSummaries.tokensOut,
        costUsd: t.prFileSummaries.costUsd,
        createdAt: t.prFileSummaries.createdAt,
      })
      .from(t.prFileSummaries)
      .innerJoin(t.pullRequests, eq(t.pullRequests.id, t.prFileSummaries.prId))
      .where(
        and(
          eq(t.prFileSummaries.prId, prId),
          eq(t.prFileSummaries.headSha, headSha),
          eq(t.pullRequests.workspaceId, workspaceId),
        ),
      );
  }

  /**
   * Write N rows in ONE statement, upserting on `(pr_id, path, head_sha)`.
   *
   * `createdAt` is set from SQL `now()` in the conflict branch, never
   * `new Date()`: the column's default fires only on INSERT, so an omitted
   * `createdAt` keeps the original timestamp and the row reads as never
   * re-derived — and stamping a Node clock over a Postgres clock can go
   * BACKWARDS under a VM-hosted Postgres (server `insights.md` 2026-08-17).
   * D-2's `created_at DESC` tie-break depends on this being right.
   */
  async upsertSummaries(rows: InsertFileSummary[]): Promise<void> {
    if (rows.length === 0) return;
    await this.db
      .insert(t.prFileSummaries)
      .values(rows)
      .onConflictDoUpdate({
        target: [t.prFileSummaries.prId, t.prFileSummaries.path, t.prFileSummaries.headSha],
        set: {
          summary: sql`excluded.summary`,
          provider: sql`excluded.provider`,
          model: sql`excluded.model`,
          tokensIn: sql`excluded.tokens_in`,
          tokensOut: sql`excluded.tokens_out`,
          costUsd: sql`excluded.cost_usd`,
          createdAt: sql`now()`,
        },
      });
  }
}
