import { z } from 'zod';

/**
 * SPEC-04 — Agent Evals: the API-facing shapes the eval module serves.
 *
 * These EXTEND the barrel; they do not modify existing contract files. The
 * vocabulary of an eval case (`EvalExpectation`, `EvalExpectedFinding`) lives
 * next to `EvalCase` in `knowledge.ts`; the batch shapes live here because they
 * are new API surface, and `eval-ci.ts` imports `EvalBatchRecord` from this file
 * for its `EvalDashboard.batches` extension.
 *
 * Import DAG (acyclic, verified): findings ← knowledge ← eval-agent ← eval-ci.
 */

// ===========================================================================
// A batch — N eval_runs rows sharing one batch_id
// ===========================================================================

/**
 * A batch's lifecycle, DERIVED at read time from its pre-inserted `eval_runs`
 * rows (plan D-2) — there is no batch table and no status column:
 *  - `running`  the eval service reports this batch id in its active set
 *  - `failed`   every row carries an `error`
 *  - `complete` every row is scored or errored
 *  - `partial`  anything else — a cost/wall-clock stop, or an API restart
 *
 * `running` is a fourth value rather than an absence because the studio polls
 * a batch while it is still in flight (plan D-1).
 */
export const EvalBatchStatus = z.enum(['running', 'complete', 'partial', 'failed']);
export type EvalBatchStatus = z.infer<typeof EvalBatchStatus>;

/**
 * One batch as both dashboard tables draw it (`v7 · 17/20 pass · $0.23`).
 *
 * The three metrics and `cost_usd` are `.nullable()`, never `.optional()`:
 * `null` is a fact the studio renders as a placeholder — "not computed" — and
 * it is not `0` (root insights.md 2026-08-02).
 */
export const EvalBatchRecord = z.object({
  batch_id: z.string(),
  agent_id: z.string().nullable(),
  agent_name: z.string().nullable(),
  agent_version: z.number().int().nullable(),
  ran_at: z.string(),
  trigger: z.string().nullable(),
  status: EvalBatchStatus,
  recall: z.number().nullable(),
  precision: z.number().nullable(),
  citation_accuracy: z.number().nullable(),
  traces_passed: z.number().int(),
  traces_total: z.number().int(),
  cases_ran: z.number().int(),
  cases_total: z.number().int(),
  cost_usd: z.number().nullable(),
});
export type EvalBatchRecord = z.infer<typeof EvalBatchRecord>;

/**
 * The 202 body of every run route (AC-27, AC-116, AC-43), mirroring
 * `IntentDeriveAccepted` (`modules/reviews/routes.ts:28`). `batch_id` is
 * nullable so a skipped agent in a workspace-wide run can still be reported:
 * `degraded: true` with a `reason` and nothing enqueued.
 */
export const EvalBatchAccepted = z.object({
  status: z.literal('accepted'),
  batch_id: z.string().nullable(),
  cases: z.number().int(),
  degraded: z.boolean().nullish(),
  reason: z.string().nullish(),
  agent_id: z.string().nullish(),
});
export type EvalBatchAccepted = z.infer<typeof EvalBatchAccepted>;

// ===========================================================================
// The workspace dashboard (/eval)
// ===========================================================================

/**
 * One agent's row on `/eval` — its latest batch's numbers, or nulls plus a case
 * count when it has cases and has never run (spec D-5).
 */
export const EvalDashboardAgentRow = z.object({
  agent_id: z.string(),
  agent_name: z.string(),
  agent_version: z.number().int(),
  enabled: z.boolean(),
  cases_total: z.number().int(),
  latest_batch_id: z.string().nullable(),
  latest_ran_at: z.string().nullable(),
  recall: z.number().nullable(),
  precision: z.number().nullable(),
  citation_accuracy: z.number().nullable(),
  traces_passed: z.number().int().nullable(),
  traces_total: z.number().int().nullable(),
  cost_usd: z.number().nullable(),
});
export type EvalDashboardAgentRow = z.infer<typeof EvalDashboardAgentRow>;

/**
 * `GET /eval` — the whole workspace in one read. `EvalDashboard` is
 * single-owner and cannot express this screen (spec D-30), so this is a new
 * shape rather than a loosening of that one.
 */
export const EvalWorkspaceDashboard = z.object({
  agents: z.array(EvalDashboardAgentRow),
  /** Newest first, capped at 50 (AC-71, AC-108). */
  batches: z.array(EvalBatchRecord),
  cases_total: z.number().int(),
});
export type EvalWorkspaceDashboard = z.infer<typeof EvalWorkspaceDashboard>;

/**
 * `GET /eval/estimate` — what "Run all agents" would cost (AC-72).
 * `est_cost_usd` is `null` when no priced batch exists to extrapolate from,
 * which the studio must render as "unknown", never as `$0.00`.
 */
export const EvalBatchEstimate = z.object({
  agents: z.number().int(),
  cases: z.number().int(),
  est_cost_usd: z.number().nullable(),
});
export type EvalBatchEstimate = z.infer<typeof EvalBatchEstimate>;
