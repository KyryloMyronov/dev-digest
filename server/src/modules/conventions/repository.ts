import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import type { ConventionStatus } from '@devdigest/shared';
import type { Db } from '../../db/client.js';
import * as t from '../../db/schema.js';

/**
 * Conventions data-access layer. Owns `conventions` and `convention_scan_state`.
 *
 * Every read and write is workspace-scoped. `findRepo` is this module's own
 * scoped lookup against `repos` rather than a call into the repos module — the
 * same choice `polling/repository.ts` made, and the reason a module boundary
 * never has to be crossed to answer "is this repo mine?".
 */

export type ConventionRow = typeof t.conventions.$inferSelect;
export type ConventionScanRow = typeof t.conventionScanState.$inferSelect;

/** Just the repo facts a scan needs — the clone to read and the name to label with. */
export interface ScanRepo {
  id: string;
  fullName: string;
  clonePath: string | null;
}

export interface InsertConvention {
  workspaceId: string;
  repoId: string;
  sourceRule: string;
  rule: string;
  evidencePath: string;
  evidenceSnippet: string;
  confidence: number;
  lastSeenAt: Date;
}

export interface UpsertScan {
  repoId: string;
  workspaceId: string;
  status: ConventionScanRow['status'];
  reason?: string | null;
  sampleFiles?: number;
  selectedFiles?: number;
  candidatesFound?: number;
  newCandidates?: number;
  provider?: string | null;
  model?: string | null;
  jobId?: string | null;
  startedAt?: Date | null;
  finishedAt?: Date | null;
  error?: string | null;
}

export interface UpdateConvention {
  status?: ConventionStatus;
  rule?: string;
  evidenceSnippet?: string;
  edited?: boolean;
}

export class ConventionsRepository {
  constructor(private db: Db) {}

  async findRepo(workspaceId: string, repoId: string): Promise<ScanRepo | undefined> {
    const [row] = await this.db
      .select({
        id: t.repos.id,
        fullName: t.repos.fullName,
        clonePath: t.repos.clonePath,
      })
      .from(t.repos)
      .where(and(eq(t.repos.workspaceId, workspaceId), eq(t.repos.id, repoId)));
    return row;
  }

  /**
   * Highest confidence first, then oldest first. Deterministic so the UI, the
   * integration tests and the e2e flow all see the same order.
   */
  async listByRepo(workspaceId: string, repoId: string): Promise<ConventionRow[]> {
    return this.db
      .select()
      .from(t.conventions)
      .where(and(eq(t.conventions.workspaceId, workspaceId), eq(t.conventions.repoId, repoId)))
      .orderBy(sql`${t.conventions.confidence} desc nulls last`, asc(t.conventions.createdAt));
  }

  async listByStatus(
    workspaceId: string,
    repoId: string,
    status: ConventionStatus,
  ): Promise<ConventionRow[]> {
    return this.db
      .select()
      .from(t.conventions)
      .where(
        and(
          eq(t.conventions.workspaceId, workspaceId),
          eq(t.conventions.repoId, repoId),
          eq(t.conventions.status, status),
        ),
      )
      .orderBy(sql`${t.conventions.confidence} desc nulls last`, asc(t.conventions.createdAt));
  }

  async getById(
    workspaceId: string,
    repoId: string,
    id: string,
  ): Promise<ConventionRow | undefined> {
    const [row] = await this.db
      .select()
      .from(t.conventions)
      .where(
        and(
          eq(t.conventions.workspaceId, workspaceId),
          eq(t.conventions.repoId, repoId),
          eq(t.conventions.id, id),
        ),
      );
    return row;
  }

  async findManyByIds(
    workspaceId: string,
    repoId: string,
    ids: string[],
  ): Promise<ConventionRow[]> {
    if (ids.length === 0) return [];
    return this.db
      .select()
      .from(t.conventions)
      .where(
        and(
          eq(t.conventions.workspaceId, workspaceId),
          eq(t.conventions.repoId, repoId),
          inArray(t.conventions.id, ids),
        ),
      );
  }

  async update(
    workspaceId: string,
    repoId: string,
    id: string,
    patch: UpdateConvention,
  ): Promise<ConventionRow | undefined> {
    const [row] = await this.db
      .update(t.conventions)
      .set({ ...patch, updatedAt: new Date() })
      .where(
        and(
          eq(t.conventions.workspaceId, workspaceId),
          eq(t.conventions.repoId, repoId),
          eq(t.conventions.id, id),
        ),
      )
      .returning();
    return row;
  }

  async setStatusMany(
    workspaceId: string,
    repoId: string,
    ids: string[],
    status: ConventionStatus,
  ): Promise<ConventionRow[]> {
    if (ids.length === 0) return [];
    return this.db
      .update(t.conventions)
      .set({ status, updatedAt: new Date() })
      .where(
        and(
          eq(t.conventions.workspaceId, workspaceId),
          eq(t.conventions.repoId, repoId),
          inArray(t.conventions.id, ids),
        ),
      )
      .returning();
  }

  /**
   * Insert the candidates a scan has not seen before.
   *
   * `onConflictDoNothing` against `conventions_source_rule_uq` is the backstop
   * for two scans racing on the same repo: the second one's duplicates vanish
   * instead of erroring the job. Returns only the rows actually written, which is
   * what the scan reports as `new_candidates`.
   */
  async insertMany(values: InsertConvention[]): Promise<ConventionRow[]> {
    if (values.length === 0) return [];
    return this.db
      .insert(t.conventions)
      .values(values.map((v) => ({ ...v, status: 'pending' as const })))
      .onConflictDoNothing({
        target: [t.conventions.workspaceId, t.conventions.repoId, t.conventions.sourceRule],
      })
      .returning();
  }

  /**
   * Refresh a rule the scan saw again.
   *
   * Bumps `last_seen_at` unconditionally, but refreshes the confidence and
   * evidence ONLY while the row is still `pending` and unedited — a decision the
   * user has made, or wording they have rewritten, must survive every later scan.
   */
  async refreshSeen(
    workspaceId: string,
    repoId: string,
    sourceRule: string,
    seen: { confidence: number; evidencePath: string; evidenceSnippet: string; at: Date },
  ): Promise<void> {
    const scope = and(
      eq(t.conventions.workspaceId, workspaceId),
      eq(t.conventions.repoId, repoId),
      eq(t.conventions.sourceRule, sourceRule),
    );

    await this.db.update(t.conventions).set({ lastSeenAt: seen.at }).where(scope);

    await this.db
      .update(t.conventions)
      .set({
        confidence: seen.confidence,
        evidencePath: seen.evidencePath,
        evidenceSnippet: seen.evidenceSnippet,
        updatedAt: seen.at,
      })
      .where(and(scope, eq(t.conventions.status, 'pending'), eq(t.conventions.edited, false)));
  }

  /** Every `source_rule` already stored for this repo — the re-scan match set. */
  async existingSourceRules(workspaceId: string, repoId: string): Promise<string[]> {
    const rows = await this.db
      .select({ sourceRule: t.conventions.sourceRule })
      .from(t.conventions)
      .where(and(eq(t.conventions.workspaceId, workspaceId), eq(t.conventions.repoId, repoId)));
    return rows.map((r) => r.sourceRule);
  }

  async getScan(workspaceId: string, repoId: string): Promise<ConventionScanRow | undefined> {
    const [row] = await this.db
      .select()
      .from(t.conventionScanState)
      .where(
        and(
          eq(t.conventionScanState.workspaceId, workspaceId),
          eq(t.conventionScanState.repoId, repoId),
        ),
      );
    return row;
  }

  /** One row per repo: insert it, or overwrite the fields this call supplies. */
  async upsertScan(values: UpsertScan): Promise<ConventionScanRow> {
    const { repoId, workspaceId, ...rest } = values;
    const set = { ...rest, updatedAt: new Date() };
    const [row] = await this.db
      .insert(t.conventionScanState)
      .values({ repoId, workspaceId, ...set })
      .onConflictDoUpdate({ target: t.conventionScanState.repoId, set })
      .returning();
    return row!;
  }

  /** Most recent scans across the workspace. Unused by routes; handy in tests. */
  async listRecentScans(workspaceId: string, limit = 20): Promise<ConventionScanRow[]> {
    return this.db
      .select()
      .from(t.conventionScanState)
      .where(eq(t.conventionScanState.workspaceId, workspaceId))
      .orderBy(desc(t.conventionScanState.updatedAt))
      .limit(limit);
  }
}
