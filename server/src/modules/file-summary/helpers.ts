import type { PrFileSummary } from '@devdigest/shared';
import { MAX_FILE_SUMMARY_CHARS } from './constants.js';

/**
 * SPEC-03 — pure helpers for the file-summary module (side-effect free; operate
 * purely on their arguments — no DB, no network, no `this`), matching
 * `modules/reviews/helpers.ts`.
 */

/** The columns `toWire` needs — a structural subset of the stored row. */
export interface StoredFileSummary {
  path: string;
  summary: string;
  headSha: string;
  provider: string | null;
  model: string | null;
  tokensIn: number | null;
  tokensOut: number | null;
  costUsd: number | null;
  createdAt: Date;
}

/**
 * A stored row → the wire shape. Used by the pipeline's cache exit and by the
 * service's read, so the two cannot disagree about how a row is serialised.
 *
 * Composes EXACTLY `PrFileSummary`, no extra keys: the route's response schema
 * strips unknowns, so a stray field would silently stop being sent.
 */
export function toWire(row: StoredFileSummary): PrFileSummary {
  return {
    path: row.path,
    summary: row.summary,
    head_sha: row.headSha,
    provider: row.provider,
    model: row.model,
    tokens_in: row.tokensIn,
    tokens_out: row.tokensOut,
    cost_usd: row.costUsd,
    created_at: row.createdAt.toISOString(),
  };
}

/**
 * AC-28 / AC-74 — clamp a model-authored summary to `MAX_FILE_SUMMARY_CHARS`.
 *
 * IN CODE, because a strict `json_schema` IGNORES `.max()` on a string — the
 * same reason `reviews/constants.ts` and `modules/brief/pipeline.ts` clamp their
 * own outputs. AC-74 is the DIRECTION of the rule: truncate and KEEP, never
 * reject the derivation over a long summary.
 */
export function clampSummary(summary: string): string {
  return summary.slice(0, MAX_FILE_SUMMARY_CHARS);
}
