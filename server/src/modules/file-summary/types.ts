import type { PrFileSummary } from '@devdigest/shared';

/**
 * SPEC-03 — file-summary module public types.
 *
 * PUBLIC SURFACE, like `constants.ts` (`no-cross-module-internals` whitelists
 * both).
 */

/** Payload of a `file-summary.derive` job. */
export interface FileSummaryJobPayload {
  workspaceId: string;
  prId: string;
  /** Summarise only this file (AC-12). Absent ⇒ a PR-level derivation. */
  path?: string;
  /** Ignore stored rows for the requested files and re-derive (AC-17). */
  force?: boolean;
}

/**
 * Why a derivation produced nothing. Mirrors `BriefSkipReason`'s and
 * `IntentSkipReason`'s vocabulary so the three derivation surfaces read alike.
 */
export type FileSummarySkipReason =
  | 'no_files'
  | 'llm_unavailable'
  | 'model_unsupported'
  | 'llm_failed'
  | 'parse_failed';

export interface DeriveFileSummariesOutcome {
  /** Echoed back so the caller's later log lines share this operation's id. */
  correlationId: string;
  /** What was derived (or served from store) — the wire shape, one per file. */
  summaries?: PrFileSummary[];
  /** Selected paths the prompt token cap left out (AC-21). */
  omitted?: string[];
  reason?: FileSummarySkipReason;
  /** True when every requested file already had a row and no model call was made. */
  cached?: boolean;
}
