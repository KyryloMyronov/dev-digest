import { z } from 'zod';

/**
 * SPEC-03 — the reviewer-ordered diff's per-file summaries.
 *
 * A NEW FILE rather than an addition to `contracts/brief.ts`, for three reasons
 * in the order they bite:
 *  1. it keeps SPEC-02's landed `brief.ts` edit collision-free;
 *  2. it keeps this feature's PAID, staleness-bearing payload out of
 *     `GET /pulls/:id/smart-diff`, whose own route comment calls that read
 *     "safe to fetch on every render of the diff tab"
 *     (`modules/pulls/routes.ts`);
 *  3. `SmartDiff` has no field that could carry a head SHA, a provider, a
 *     model, token counts or a cost, so folding this in would mean retyping the
 *     repo's only response-schema-declaring route.
 *
 * `SmartDiff`, `SmartDiffFile`, `SmartDiffGroup` and `finding_lines` are
 * UNCHANGED by this feature; `SmartDiffFile.pseudocode_summary` is deliberately
 * NOT reused (it cannot carry provenance or a staleness key).
 */

/** One persisted summary of one changed file, at one commit. */
export const PrFileSummary = z.object({
  /** Repo-relative path, exactly as `pr_files` stores it. */
  path: z.string(),
  /** The one-line description, already clamped to MAX_FILE_SUMMARY_CHARS. */
  summary: z.string(),
  /**
   * The commit this summary describes. Part of the row's primary key, so it can
   * never be absent: that is what makes the studio's staleness check a
   * comparison rather than a guess (AC-58).
   */
  head_sha: z.string(),
  // provider / model / tokens_in / tokens_out are `.nullish()` — fields the API
  // may never have computed, following the trap root `insights.md` records for
  // `PrMeta` (absent OR null are both legitimate).
  provider: z.string().nullish(),
  model: z.string().nullish(),
  // tokens_in / tokens_out / cost_usd are this file's SHARE of ONE structured
  // call over N files, apportioned by prompt tokens (SPEC-03 plan D-1), so
  // SUM(cost_usd) over one derivation's rows is exact — which is what makes
  // NFR-1's ceiling and AC-59's running total the same arithmetic. Never read
  // a single row's cost as the price of a call.
  tokens_in: z.number().int().nullish(),
  tokens_out: z.number().int().nullish(),
  /**
   * `.nullable()`, NOT `.optional()`: `null` is a FACT the studio must receive
   * and render as a placeholder ("unpriced model"), whereas an `.optional()`
   * field simply vanishes from the payload when absent and would be read as
   * "not computed yet". `null` and `0` are different facts and must never be
   * coalesced (root `insights.md` 2026-08-02).
   */
  cost_usd: z.number().nullable(),
  /** When this row was last derived. */
  created_at: z.string(),
});
export type PrFileSummary = z.infer<typeof PrFileSummary>;

/** The payload of `GET /pulls/:id/file-summaries`. */
export const PrFileSummariesResponse = z.object({
  /**
   * At most ONE row per path — the read projects the accumulated per-head-SHA
   * rows down to the current head's row, else the newest stale one (plan D-2).
   */
  summaries: z.array(PrFileSummary),
  // Computed AT READ TIME over the derivation-eligible set (non-boilerplate,
  // patch non-null): eligible paths with no summary at the PR's current head.
  // NOT a record of what one derivation's token cap dropped — the table has no
  // column for that (SPEC-03 plan D-2). AC-51's per-file control is what tells
  // "never derived" from "cap-omitted" on screen.
  omitted_files: z.array(z.string()),
  /** Eligible paths WITH a summary at the current head (AC-60's "n"). */
  selected: z.number().int(),
  /** Size of the derivation-eligible set (AC-60's "m"). */
  total: z.number().int(),
});
export type PrFileSummariesResponse = z.infer<typeof PrFileSummariesResponse>;

/**
 * The body of `POST /pulls/:id/file-summaries`. Both fields optional: a POST
 * with NO body at all is a PR-level derivation of the whole selection.
 */
export const FileSummaryDeriveInput = z.object({
  /** Summarise only this file (AC-12). Must be a changed file of the PR. */
  path: z.string().min(1).optional(),
  /** Ignore stored rows for the requested files and re-derive (AC-17). */
  force: z.boolean().optional(),
});
export type FileSummaryDeriveInput = z.infer<typeof FileSummaryDeriveInput>;
