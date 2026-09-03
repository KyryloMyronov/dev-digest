import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import type { Db } from '../../db/client.js';
import * as t from '../../db/schema.js';
import type { EvalCaseRow, EvalRunRow } from '../../db/rows.js';
import type {
  EvalBatchRecord,
  EvalBatchStatus,
  EvalExpectation,
  EvalRunRecord,
} from '@devdigest/shared';
import { MAX_BATCHES_RETURNED } from './constants.js';

export type { EvalCaseRow, EvalRunRow };

/**
 * SPEC-04 — eval data access. Owns `eval_cases` and `eval_runs`, and is the ONLY
 * code in the module that imports `drizzle-orm` (`no-drizzle-outside-persistence`).
 *
 * TENANCY (AC-1, AC-2). Every method takes `workspaceId` FIRST. `eval_runs`
 * carries no `workspace_id`; a run's workspace is resolved by joining
 * `case_id → eval_cases.workspace_id`, always, and never assumed from
 * `eval_runs.agent_id` — which is denormalised for the dashboard read and could
 * name a foreign agent. A run whose `agent_id` is foreign must still be readable
 * in its own workspace; that is a property of this join and of nothing else.
 */

export interface InsertEvalCase {
  workspaceId: string;
  ownerKind: 'agent' | 'skill';
  ownerId: string;
  name: string;
  inputDiff: string;
  inputFiles?: unknown;
  inputMeta?: unknown;
  expectedOutput: unknown;
  expectation: EvalExpectation;
  notes?: string | null;
}

export interface UpdateEvalCase {
  name?: string;
  inputDiff?: string;
  inputFiles?: unknown;
  inputMeta?: unknown;
  expectedOutput?: unknown;
  expectation?: EvalExpectation;
  notes?: string | null;
}

/** The pre-inserted shape of one case's row at batch start (plan D-2). */
export interface InsertEvalRunSeed {
  caseId: string;
  agentId: string | null;
  agentVersion: number | null;
  batchId: string;
  trigger: 'manual' | 'version-change';
}

/** The metrics written back onto a seeded row once its case completes. */
export interface EvalRunResultPatch {
  actualOutput?: unknown;
  pass?: boolean | null;
  recall?: number | null;
  precision?: number | null;
  citationAccuracy?: number | null;
  durationMs?: number | null;
  costUsd?: number | null;
  error?: string | null;
}

/**
 * The `eval_runs.actual_output` blob the runner persists for a scored case.
 *
 * The findings are what the engine kept; `counts` is the scorer's tally, stored
 * so the batch aggregate can MICRO-average in one query. Nothing else in the
 * schema can carry it — `eval_runs` has per-case metric columns but no
 * numerator/denominator columns, and AC-45/AC-50/AC-52 are all ratios of sums.
 */
export interface PersistedActualOutput {
  findings: unknown[];
  counts: {
    expected: number;
    actual: number;
    matched: number;
    noise: number;
    kept: number;
    dropped: number;
  };
}

/** `sum(actual_output.counts.<key>)` over a batch's rows, 0 where absent. */
function countSum(col: AnyPgColumn, key: keyof PersistedActualOutput['counts']) {
  return sql<number>`coalesce(sum(coalesce((${col} -> 'counts' ->> ${key})::int, 0)), 0)::int`;
}

/** One raw batch aggregate row, before the status derivation is applied. */
interface BatchAggregateRow {
  batchId: string;
  agentId: string | null;
  agentName: string | null;
  agentVersion: number | null;
  trigger: string | null;
  ranAt: Date;
  casesTotal: number;
  casesRan: number;
  casesErrored: number;
  tracesPassed: number;
  /** Micro-average numerators/denominators, summed over the batch's rows. */
  expectedSum: number;
  matchedSum: number;
  actualSum: number;
  noiseSum: number;
  keptSum: number;
  droppedSum: number;
  costUsd: number | null;
}

export class EvalRepository {
  constructor(private db: Db) {}

  // ---- cases --------------------------------------------------------------

  async casesForOwner(
    workspaceId: string,
    ownerKind: 'agent' | 'skill',
    ownerId: string,
  ): Promise<EvalCaseRow[]> {
    return this.db
      .select()
      .from(t.evalCases)
      .where(
        and(
          eq(t.evalCases.workspaceId, workspaceId),
          eq(t.evalCases.ownerKind, ownerKind),
          eq(t.evalCases.ownerId, ownerId),
        ),
      )
      .orderBy(asc(t.evalCases.createdAt), asc(t.evalCases.id));
  }

  async countCasesForOwner(
    workspaceId: string,
    ownerKind: 'agent' | 'skill',
    ownerId: string,
  ): Promise<number> {
    const [row] = await this.db
      .select({ n: sql<number>`count(*)::int` })
      .from(t.evalCases)
      .where(
        and(
          eq(t.evalCases.workspaceId, workspaceId),
          eq(t.evalCases.ownerKind, ownerKind),
          eq(t.evalCases.ownerId, ownerId),
        ),
      );
    return row?.n ?? 0;
  }

  /** AC-4 — a case from another workspace resolves to undefined, i.e. 404. */
  async getCase(workspaceId: string, id: string): Promise<EvalCaseRow | undefined> {
    const [row] = await this.db
      .select()
      .from(t.evalCases)
      .where(and(eq(t.evalCases.workspaceId, workspaceId), eq(t.evalCases.id, id)));
    return row;
  }

  async countCasesInWorkspace(workspaceId: string): Promise<number> {
    const [row] = await this.db
      .select({ n: sql<number>`count(*)::int` })
      .from(t.evalCases)
      .where(eq(t.evalCases.workspaceId, workspaceId));
    return row?.n ?? 0;
  }

  /**
   * AC-114 — the caller passes a NAMED field list. Nothing here spreads a parsed
   * request body: `workspaceId`, `ownerKind` and `ownerId` come from the
   * resolved context and the path, so a body carrying them cannot move the row's
   * tenant or owner.
   */
  async insertCase(values: InsertEvalCase): Promise<EvalCaseRow> {
    const [row] = await this.db
      .insert(t.evalCases)
      .values({
        workspaceId: values.workspaceId,
        ownerKind: values.ownerKind,
        ownerId: values.ownerId,
        name: values.name,
        inputDiff: values.inputDiff,
        inputFiles: values.inputFiles as object | undefined,
        inputMeta: values.inputMeta as object | undefined,
        expectedOutput: values.expectedOutput as object,
        expectation: values.expectation,
        notes: values.notes ?? null,
      })
      .returning();
    return row!;
  }

  async updateCase(
    workspaceId: string,
    id: string,
    patch: UpdateEvalCase,
  ): Promise<EvalCaseRow | undefined> {
    const set: Record<string, unknown> = {};
    // Written out longhand, one named field at a time (AC-114).
    if (patch.name !== undefined) set.name = patch.name;
    if (patch.inputDiff !== undefined) set.inputDiff = patch.inputDiff;
    if (patch.inputFiles !== undefined) set.inputFiles = patch.inputFiles;
    if (patch.inputMeta !== undefined) set.inputMeta = patch.inputMeta;
    if (patch.expectedOutput !== undefined) set.expectedOutput = patch.expectedOutput;
    if (patch.expectation !== undefined) set.expectation = patch.expectation;
    if (patch.notes !== undefined) set.notes = patch.notes;
    if (Object.keys(set).length === 0) return this.getCase(workspaceId, id);

    const [row] = await this.db
      .update(t.evalCases)
      .set(set)
      .where(and(eq(t.evalCases.workspaceId, workspaceId), eq(t.evalCases.id, id)))
      .returning();
    return row;
  }

  /**
   * AC-26 needs NO code here beyond this delete: `eval_runs.case_id` is already
   * `ON DELETE CASCADE` (`db/schema/eval.ts`), so Postgres removes the runs. Do
   * not add a manual `delete(evalRuns)` — a redundant second delete is how the
   * two paths drift.
   */
  async deleteCase(workspaceId: string, id: string): Promise<boolean> {
    const rows = await this.db
      .delete(t.evalCases)
      .where(and(eq(t.evalCases.workspaceId, workspaceId), eq(t.evalCases.id, id)))
      .returning({ id: t.evalCases.id });
    return rows.length > 0;
  }

  /**
   * AC-16 — has this agent already got a case built from this finding?
   *
   * A containment scan over `input_meta.source_finding_ids`, scoped to the one
   * agent's cases. NO GIN index: the 50-case ceiling (AC-107) means this reads
   * at most 50 small JSONB blobs, which is cheaper than an index nothing else
   * would ever use.
   */
  async caseBySourceFinding(
    workspaceId: string,
    agentId: string,
    findingId: string,
  ): Promise<EvalCaseRow | undefined> {
    const rows = await this.casesForOwner(workspaceId, 'agent', agentId);
    return rows.find((r) => {
      const meta = r.inputMeta as { source_finding_ids?: unknown } | null;
      const ids = meta?.source_finding_ids;
      return Array.isArray(ids) && ids.includes(findingId);
    });
  }

  // ---- runs ---------------------------------------------------------------

  /** Plan D-2 — materialise the whole batch up front, every metric null. */
  async seedBatch(seeds: readonly InsertEvalRunSeed[]): Promise<EvalRunRow[]> {
    if (seeds.length === 0) return [];
    return this.db
      .insert(t.evalRuns)
      .values(
        seeds.map((s) => ({
          caseId: s.caseId,
          agentId: s.agentId,
          agentVersion: s.agentVersion,
          batchId: s.batchId,
          trigger: s.trigger,
        })),
      )
      .returning();
  }

  /** Update ONE seeded row in place as its case completes. */
  async completeRun(runId: string, patch: EvalRunResultPatch): Promise<void> {
    await this.db
      .update(t.evalRuns)
      .set({
        actualOutput: patch.actualOutput as object | undefined,
        pass: patch.pass ?? null,
        recall: patch.recall ?? null,
        precision: patch.precision ?? null,
        citationAccuracy: patch.citationAccuracy ?? null,
        durationMs: patch.durationMs ?? null,
        // AC-58 — persisted as reported/estimated, and NULL when neither. Never
        // 0: `z-ai/glm-4.7-flash` is genuinely priced at 0, so the distinction
        // is observable (root insights.md 2026-08-02).
        costUsd: patch.costUsd ?? null,
        error: patch.error ?? null,
        // `ran_at` is stamped by Postgres at insert and deliberately NOT rewritten
        // here — mixing a Postgres default with a Node `new Date()` is the
        // two-clocks trap (server/insights.md 2026-08-17).
      })
      .where(eq(t.evalRuns.id, runId));
  }

  /**
   * Every run row of one batch, tenancy-scoped through the case join.
   */
  async runsForBatch(workspaceId: string, batchId: string): Promise<EvalRunRow[]> {
    const rows = await this.db
      .select({ run: t.evalRuns })
      .from(t.evalRuns)
      .innerJoin(t.evalCases, eq(t.evalRuns.caseId, t.evalCases.id))
      .where(and(eq(t.evalCases.workspaceId, workspaceId), eq(t.evalRuns.batchId, batchId)))
      .orderBy(asc(t.evalRuns.ranAt));
    return rows.map((r) => r.run);
  }

  /**
   * AC-63's substrate — one batch's rows as `EvalRunRecord`s, with the case's
   * name and expectation joined and the scorer's counts unpacked.
   *
   * `expected_count` and `actual_count` are the two fields SPEC-04 added to
   * `EvalRunRecord`, and this is their only producer. They come out of
   * `actual_output.counts`, which the runner persists precisely because the
   * per-case metric columns are ratios and cannot be un-divided.
   */
  async runRecordsForBatch(workspaceId: string, batchId: string): Promise<EvalRunRecord[]> {
    const rows = await this.db
      .select({
        run: t.evalRuns,
        caseName: t.evalCases.name,
        expectation: t.evalCases.expectation,
      })
      .from(t.evalRuns)
      .innerJoin(t.evalCases, eq(t.evalRuns.caseId, t.evalCases.id))
      .where(and(eq(t.evalCases.workspaceId, workspaceId), eq(t.evalRuns.batchId, batchId)))
      .orderBy(asc(t.evalRuns.ranAt));

    return rows.map(({ run, caseName, expectation }) => {
      const counts = (run.actualOutput as PersistedActualOutput | null)?.counts;
      return {
        id: run.id,
        case_id: run.caseId,
        case_name: caseName,
        ran_at: run.ranAt.toISOString(),
        actual_output: run.actualOutput ?? null,
        pass: run.pass,
        recall: run.recall,
        precision: run.precision,
        citation_accuracy: run.citationAccuracy,
        duration_ms: run.durationMs,
        cost_usd: run.costUsd,
        agent_id: run.agentId,
        batch_id: run.batchId,
        agent_version: run.agentVersion,
        expectation,
        expected_count: counts?.expected ?? null,
        actual_count: counts?.actual ?? null,
        error: run.error,
      };
    });
  }

  /** AC-89 — does a version-change batch already exist for this agent+version? */
  async hasVersionChangeBatch(agentId: string, version: number): Promise<boolean> {
    const [row] = await this.db
      .select({ id: t.evalRuns.id })
      .from(t.evalRuns)
      .where(
        and(
          eq(t.evalRuns.agentId, agentId),
          eq(t.evalRuns.agentVersion, version),
          eq(t.evalRuns.trigger, 'version-change'),
        ),
      )
      .limit(1);
    return row !== undefined;
  }

  /**
   * The mean `cost_usd` of the workspace's PRICED case runs — AC-72's estimate
   * basis. `null` when no priced run exists; never 0.
   */
  async meanPricedCaseCost(workspaceId: string): Promise<number | null> {
    const [row] = await this.db
      .select({ mean: sql<number | null>`avg(${t.evalRuns.costUsd})` })
      .from(t.evalRuns)
      .innerJoin(t.evalCases, eq(t.evalRuns.caseId, t.evalCases.id))
      .where(
        and(eq(t.evalCases.workspaceId, workspaceId), sql`${t.evalRuns.costUsd} is not null`),
      );
    const mean = row?.mean;
    return mean === null || mean === undefined ? null : Number(mean);
  }

  // ---- the batch aggregate (plan D-2) -------------------------------------

  /**
   * ONE query, aggregate in SQL — never N+1 over batches, which is what NFR-3
   * rests on. `eval_runs (agent_id, ran_at DESC)` and `eval_runs (batch_id)` are
   * the indexes this reads.
   */
  private batchAggregateQuery(workspaceId: string) {
    return this.db
      .select({
        batchId: sql<string>`${t.evalRuns.batchId}`,
        agentId: sql<string | null>`max(${t.evalRuns.agentId}::text)`,
        agentName: sql<string | null>`max(${t.agents.name})`,
        agentVersion: sql<number | null>`max(${t.evalRuns.agentVersion})`,
        trigger: sql<string | null>`max(${t.evalRuns.trigger})`,
        ranAt: sql<Date>`min(${t.evalRuns.ranAt})`,
        casesTotal: sql<number>`count(*)::int`,
        // AC-37, VERBATIM: cases_ran is the count of rows that produced a SCORE.
        casesRan: sql<number>`count(${t.evalRuns.pass})::int`,
        casesErrored: sql<number>`count(${t.evalRuns.error})::int`,
        tracesPassed: sql<number>`count(*) filter (where ${t.evalRuns.pass})::int`,
        // The batch metrics are MICRO-averages (AC-45, AC-50, AC-52 + plan D-6):
        // Sigma matched / Sigma expected, 1 - Sigma noise / Sigma actual, and
        // Sigma kept / Sigma (kept+dropped). `avg()` over the per-case columns
        // would be a MACRO-average and would weight a one-expectation case the
        // same as a ten-expectation one, which is not what any of those criteria
        // say. The per-case counts are persisted by the runner alongside the
        // findings, in `actual_output.counts`; a row the batch never reached has
        // no `actual_output` and contributes 0 to every sum.
        expectedSum: countSum(t.evalRuns.actualOutput, 'expected'),
        matchedSum: countSum(t.evalRuns.actualOutput, 'matched'),
        actualSum: countSum(t.evalRuns.actualOutput, 'actual'),
        noiseSum: countSum(t.evalRuns.actualOutput, 'noise'),
        keptSum: countSum(t.evalRuns.actualOutput, 'kept'),
        droppedSum: countSum(t.evalRuns.actualOutput, 'dropped'),
        costUsd: sql<number | null>`sum(${t.evalRuns.costUsd})`,
      })
      .from(t.evalRuns)
      .innerJoin(t.evalCases, eq(t.evalRuns.caseId, t.evalCases.id))
      .leftJoin(t.agents, eq(t.evalRuns.agentId, t.agents.id))
      .groupBy(t.evalRuns.batchId);
  }

  /**
   * Derive a batch's status from its rows (plan D-2) — there is no status column.
   *
   *   running   the eval service reports this batch id as active
   *   failed    every row carries an `error`
   *   complete  every row is scored-or-errored
   *   partial   anything else
   *
   * The active set is passed IN so this stays stateless: the registry lives in
   * the service, and a repository that owned it could not be constructed twice.
   * After an API restart the set is empty, so an interrupted batch reads
   * `partial` — which is true.
   */
  private deriveStatus(row: BatchAggregateRow, activeBatchIds: ReadonlySet<string>): EvalBatchStatus {
    if (activeBatchIds.has(row.batchId)) return 'running';
    if (row.casesTotal > 0 && row.casesErrored === row.casesTotal) return 'failed';
    if (row.casesRan + row.casesErrored >= row.casesTotal) return 'complete';
    return 'partial';
  }

  private toBatchRecord(
    row: BatchAggregateRow,
    activeBatchIds: ReadonlySet<string>,
  ): EvalBatchRecord {
    const num = (v: number | null | undefined) => (v === null || v === undefined ? null : Number(v));
    const status = this.deriveStatus(row, activeBatchIds);
    // AC-38 — an all-failed batch reports all three metrics null, not 0. The
    // same holds for a batch that has scored nothing YET (a running or restarted
    // one): "no case produced a score" is not the same fact as AC-51's "the
    // cases ran and produced no finding", which is the only state that earns
    // `precision = 1`.
    const nothingScored = row.casesRan === 0;
    const expectedSum = Number(row.expectedSum);
    const matchedSum = Number(row.matchedSum);
    const actualSum = Number(row.actualSum);
    const noiseSum = Number(row.noiseSum);
    const keptSum = Number(row.keptSum);
    const candidateSum = keptSum + Number(row.droppedSum);
    const metrics =
      status === 'failed' || nothingScored
        ? { recall: null, precision: null, citationAccuracy: null }
        : {
            recall: expectedSum === 0 ? null : matchedSum / expectedSum,
            precision: actualSum === 0 ? 1 : 1 - noiseSum / actualSum,
            citationAccuracy: candidateSum === 0 ? null : keptSum / candidateSum,
          };
    return {
      batch_id: row.batchId,
      agent_id: row.agentId,
      agent_name: row.agentName,
      agent_version: row.agentVersion === null ? null : Number(row.agentVersion),
      ran_at: new Date(row.ranAt).toISOString(),
      trigger: row.trigger,
      status,
      recall: metrics.recall,
      precision: metrics.precision,
      citation_accuracy: metrics.citationAccuracy,
      traces_passed: Number(row.tracesPassed),
      traces_total: Number(row.casesTotal),
      cases_ran: Number(row.casesRan),
      cases_total: Number(row.casesTotal),
      cost_usd: num(row.costUsd),
    };
  }

  /** A single agent's batches, newest first. Drives the Evals tab's poll. */
  async batchesForAgent(
    workspaceId: string,
    agentId: string,
    activeBatchIds: ReadonlySet<string> = new Set(),
    limit = MAX_BATCHES_RETURNED,
  ): Promise<EvalBatchRecord[]> {
    const rows = (await this.batchAggregateQuery(workspaceId)
      .where(and(eq(t.evalCases.workspaceId, workspaceId), eq(t.evalRuns.agentId, agentId)))
      .orderBy(desc(sql`min(${t.evalRuns.ranAt})`))
      .limit(limit)) as unknown as BatchAggregateRow[];
    return rows.map((r) => this.toBatchRecord(r, activeBatchIds));
  }

  /** AC-71 / AC-108 — the workspace's 50 newest batches, newest first. */
  async batchesForWorkspace(
    workspaceId: string,
    activeBatchIds: ReadonlySet<string> = new Set(),
    limit = MAX_BATCHES_RETURNED,
  ): Promise<EvalBatchRecord[]> {
    const rows = (await this.batchAggregateQuery(workspaceId)
      .where(eq(t.evalCases.workspaceId, workspaceId))
      .orderBy(desc(sql`min(${t.evalRuns.ranAt})`))
      .limit(limit)) as unknown as BatchAggregateRow[];
    return rows.map((r) => this.toBatchRecord(r, activeBatchIds));
  }

  /** Case counts per agent, for the workspace dashboard's rows. */
  async caseCountsByAgent(workspaceId: string): Promise<Map<string, number>> {
    const rows = await this.db
      .select({ ownerId: t.evalCases.ownerId, n: sql<number>`count(*)::int` })
      .from(t.evalCases)
      .where(and(eq(t.evalCases.workspaceId, workspaceId), eq(t.evalCases.ownerKind, 'agent')))
      .groupBy(t.evalCases.ownerId);
    return new Map(rows.map((r) => [r.ownerId, Number(r.n)]));
  }

  /** Agent ids that own at least one case — AC-43's "has ≥1 case" filter. */
  async agentIdsWithCases(workspaceId: string, agentIds: readonly string[]): Promise<Set<string>> {
    if (agentIds.length === 0) return new Set();
    const rows = await this.db
      .selectDistinct({ ownerId: t.evalCases.ownerId })
      .from(t.evalCases)
      .where(
        and(
          eq(t.evalCases.workspaceId, workspaceId),
          eq(t.evalCases.ownerKind, 'agent'),
          inArray(t.evalCases.ownerId, [...agentIds]),
        ),
      );
    return new Set(rows.map((r) => r.ownerId));
  }
}
