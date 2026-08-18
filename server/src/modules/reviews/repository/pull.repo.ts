import { and, eq, sql } from 'drizzle-orm';
import type { Db } from '../../../db/client.js';
import * as t from '../../../db/schema.js';
import type { Intent, PrIntentRecord } from '@devdigest/shared';
import { IntentChangeType } from '@devdigest/shared';
import type { PullRow } from '../../../db/rows.js';
import { classifySources } from '../intent-sources.js';

// ---- PR lookup (workspace-scoped) -----------------------------------------

export async function getPull(
  db: Db,
  workspaceId: string,
  prId: string,
): Promise<PullRow | undefined> {
  const [row] = await db
    .select()
    .from(t.pullRequests)
    .where(and(eq(t.pullRequests.workspaceId, workspaceId), eq(t.pullRequests.id, prId)));
  return row;
}

export async function getRepo(
  db: Db,
  repoId: string,
): Promise<typeof t.repos.$inferSelect | undefined> {
  const [row] = await db.select().from(t.repos).where(eq(t.repos.id, repoId));
  return row;
}

export async function getPrFiles(
  db: Db,
  prId: string,
): Promise<(typeof t.prFiles.$inferSelect)[]> {
  return db.select().from(t.prFiles).where(eq(t.prFiles.prId, prId));
}

/**
 * Record the commit a review just ran against, so the PR list can derive
 * `reviewed` vs `needs_review` (head moved since the last review) vs `stale`.
 */
export async function markReviewed(db: Db, prId: string, sha: string): Promise<void> {
  await db
    .update(t.pullRequests)
    .set({ lastReviewedSha: sha })
    .where(eq(t.pullRequests.id, prId));
}

// ---- intent ---------------------------------------------------------------

/**
 * What the intent pipeline persists. `derived_from` is deliberately absent: it is
 * a function of `sources` and is computed on read, so the rule lives in exactly
 * one place and old rows can never disagree with new ones.
 */
export interface InsertIntent extends Intent {
  changeType: string | null;
  confidence: number | null;
  sources: string[];
  provider: string | null;
  model: string | null;
  tokensIn: number | null;
  tokensOut: number | null;
  costUsd: number | null;
  headSha: string | null;
}

/**
 * Write the PR's intent, overwriting any previous derivation.
 *
 * `createdAt` is set EXPLICITLY in the conflict branch: it means "last derived
 * at", and the column default only fires on insert, so leaving it out would make
 * a re-derivation keep the original timestamp and read as stale forever.
 */
export async function upsertIntent(db: Db, prId: string, intent: InsertIntent): Promise<void> {
  const values = {
    prId,
    intent: intent.intent,
    inScope: intent.in_scope,
    outOfScope: intent.out_of_scope,
    changeType: intent.changeType,
    confidence: intent.confidence,
    sources: intent.sources,
    provider: intent.provider,
    model: intent.model,
    tokensIn: intent.tokensIn,
    tokensOut: intent.tokensOut,
    costUsd: intent.costUsd,
    headSha: intent.headSha,
  };
  await db
    .insert(t.prIntent)
    .values(values)
    .onConflictDoUpdate({
      target: t.prIntent.prId,
      // `now()`, not `new Date()`: the insert path takes the column default,
      // which Postgres evaluates on ITS clock. Stamping the update from the
      // host's clock instead mixes two clocks in one column, and any skew
      // between them makes a fresh derivation look older than the one it
      // replaced. (Observed: 50ms backwards against a VM-hosted Postgres.)
      set: { ...values, createdAt: sql`now()` },
    });
}

export async function getIntent(db: Db, prId: string): Promise<PrIntentRecord | undefined> {
  const [row] = await db.select().from(t.prIntent).where(eq(t.prIntent.prId, prId));
  if (!row) return undefined;
  return {
    pr_id: row.prId,
    intent: row.intent,
    in_scope: row.inScope,
    out_of_scope: row.outOfScope,
    change_type: IntentChangeType.safeParse(row.changeType).data ?? null,
    confidence: row.confidence,
    sources: row.sources,
    // Computed, never stored — see InsertIntent.
    derived_from: classifySources(row.sources),
    provider: row.provider,
    model: row.model,
    cost_usd: row.costUsd,
    head_sha: row.headSha,
    created_at: row.createdAt?.toISOString() ?? null,
  };
}
