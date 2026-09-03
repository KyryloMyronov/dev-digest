import type { PrBriefRecord, Risk, PrBriefWhy, ReviewFocus } from '@devdigest/shared';

/**
 * SPEC-02 — brief module public types.
 *
 * PUBLIC SURFACE, like `constants.ts` (`no-cross-module-internals` whitelists
 * both).
 */

/** Payload of a `brief.derive` job. */
export interface BriefJobPayload {
  workspaceId: string;
  prId: string;
  /** Ignore the cached row and re-derive (AC-13). */
  force?: boolean;
}

/**
 * What goes into `pr_brief.json` — the MODEL-DERIVED BODY ONLY.
 *
 * Deliberately a strict subset of the wire shape: the provenance (`head_sha`,
 * `provider`, `model`, `tokens_in`, `tokens_out`, `cost_usd`, `created_at`)
 * lives in COLUMNS, mirroring `pr_intent`, so AC-19 can assert per-column and
 * NFR-1's 64 KB is a statement about this blob. `repository.ts` composes
 * `PrBriefRecord = { pr_id } ∪ blob ∪ columns` on read.
 */
export interface BriefBlob {
  why?: PrBriefWhy | null;
  risks: Risk[];
  focus?: ReviewFocus | null;
  grounding: { kept: number; dropped: number };
  omitted_files: string[];
}

/**
 * Why a derivation produced nothing. Mirrors `IntentSkipReason`'s vocabulary
 * so the two failure surfaces read alike.
 */
export type BriefSkipReason =
  | 'no_diff'
  | 'llm_unavailable'
  | 'model_unsupported'
  | 'llm_failed'
  | 'parse_failed';

export interface DeriveBriefOutcome {
  /** Echoed back so the caller's later log lines share this operation's id. */
  correlationId: string;
  record?: PrBriefRecord;
  reason?: BriefSkipReason;
  /** True when the record came from `pr_brief` and no model call was made. */
  cached?: boolean;
}
