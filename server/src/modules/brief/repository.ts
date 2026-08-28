import { and, eq, sql } from 'drizzle-orm';
import type { PrBriefRecord } from '@devdigest/shared';
import type { Db } from '../../db/client.js';
import * as t from '../../db/schema.js';
import type { BriefBlob } from './types.js';

/**
 * SPEC-02 — brief data-access. The ONLY layer in this module touching the DB,
 * and the ONLY file here allowed to import `drizzle-orm`
 * (`no-drizzle-outside-persistence` whitelists `repository.ts`).
 *
 * AC-3 LIVES HERE. Every read joins `pull_requests` and filters on
 * `workspace_id` — `pr_brief` carries no `workspace_id` of its own, exactly as
 * `pr_intent` does not, and both scope through `pr_id → pull_requests`. Do NOT
 * rely on the service having checked first: the criterion is about the query,
 * and the integration test reads the same PR id under a second workspace.
 *
 * AC-11 IS A *NON*-WRITE. A failed derivation must leave the row untouched.
 * That is achieved by the pipeline never calling `upsertBrief` on a failure
 * path — the same reason `pr_intent` writes no failure row: a failure row would
 * overwrite a good earlier derivation and poison the cache. Do NOT add a
 * "record the error" write here later.
 */

/** The provenance columns the pipeline writes alongside the blob. */
export interface InsertBrief {
  json: BriefBlob;
  provider: string | null;
  model: string | null;
  tokensIn: number | null;
  tokensOut: number | null;
  costUsd: number | null;
  headSha: string | null;
}

export class BriefRepository {
  constructor(private db: Db) {}

  /**
   * The PR's persisted brief, or undefined. Composes the wire shape from the
   * JSONB body plus the provenance columns — `PrBriefRecord` exactly, no extra
   * keys: the route's response schema strips unknowns, so a service returning
   * more would silently stop sending them.
   */
  async getBrief(workspaceId: string, prId: string): Promise<PrBriefRecord | undefined> {
    const [row] = await this.db
      .select({ brief: t.prBrief })
      .from(t.prBrief)
      .innerJoin(t.pullRequests, eq(t.pullRequests.id, t.prBrief.prId))
      .where(and(eq(t.prBrief.prId, prId), eq(t.pullRequests.workspaceId, workspaceId)));
    if (!row) return undefined;

    const blob = (row.brief.json ?? {}) as Partial<BriefBlob>;
    return {
      pr_id: row.brief.prId,
      why: blob.why ?? null,
      risks: blob.risks ?? [],
      focus: blob.focus ?? null,
      grounding: blob.grounding ?? null,
      omitted_files: blob.omitted_files ?? [],
      provider: row.brief.provider,
      model: row.brief.model,
      tokens_in: row.brief.tokensIn,
      tokens_out: row.brief.tokensOut,
      cost_usd: row.brief.costUsd,
      head_sha: row.brief.headSha,
      created_at: row.brief.createdAt?.toISOString() ?? null,
    };
  }

  /**
   * Write the PR's brief, overwriting any previous derivation.
   *
   * `createdAt` is set EXPLICITLY in the conflict branch: it means "last
   * derived at", and the column default only fires on insert, so leaving it out
   * would make a re-derivation keep the original timestamp and read as never
   * re-derived. `now()`, not `new Date()`: the insert path takes the column
   * default, which Postgres evaluates on ITS clock; stamping the update from
   * the host's clock mixes two clocks in one column and can go backwards under
   * a VM-hosted Postgres.
   */
  async upsertBrief(prId: string, values: InsertBrief): Promise<void> {
    const row = { prId, ...values };
    await this.db
      .insert(t.prBrief)
      .values(row)
      .onConflictDoUpdate({
        target: t.prBrief.prId,
        set: { ...row, createdAt: sql`now()` },
      });
  }
}
