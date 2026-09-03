import { z } from 'zod';
import { Severity } from './findings.js';

/**
 * PR Brief building blocks: Intent, Blast radius, Risks, PR History,
 * Smart Diff. Composed into PrBrief.
 *
 * CANONICAL SHAPES, so two nearly-identical types are not confused:
 *  - `BlastRadius` below is composed into the legacy `PrBrief` and carries an
 *    LLM-written `summary`. `contracts/blast.ts`'s `BlastResponse` is the
 *    canonical shape of `GET /pulls/:id/blast` — index-derived, no LLM.
 *  - `PrBrief` below is the legacy composed shape, served by nothing.
 *    `PrBriefRecord` is canonical for `GET /pulls/:id/brief` (SPEC-02).
 */

// ---- Intent ----
export const Intent = z.object({
  intent: z.string(),
  in_scope: z.array(z.string()),
  out_of_scope: z.array(z.string()),
});
export type Intent = z.infer<typeof Intent>;

// ---- Blast radius ----
export const ChangedSymbol = z.object({
  name: z.string(),
  file: z.string(),
  kind: z.string(),
});
export type ChangedSymbol = z.infer<typeof ChangedSymbol>;

export const BlastCaller = z.object({
  name: z.string(),
  file: z.string(),
  line: z.number().int(),
});
export type BlastCaller = z.infer<typeof BlastCaller>;

export const DownstreamImpact = z.object({
  symbol: z.string(),
  callers: z.array(BlastCaller),
  endpoints_affected: z.array(z.string()),
  crons_affected: z.array(z.string()),
});
export type DownstreamImpact = z.infer<typeof DownstreamImpact>;

export const BlastRadius = z.object({
  changed_symbols: z.array(ChangedSymbol),
  downstream: z.array(DownstreamImpact),
  summary: z.string(),
});
export type BlastRadius = z.infer<typeof BlastRadius>;

// ---- Risks ----

/**
 * Legacy severity vocabulary. RETAINED, unused by SPEC-02: `Risk.severity` now
 * uses the product's `Severity` so the UI kit's SeverityBadge (icon + label)
 * renders it. Kept because the starter's schema-and-contracts-ahead-of-features
 * rule holds and no consumer exists to break.
 */
export const RiskSeverity = z.enum(['high', 'medium', 'low']);
export type RiskSeverity = z.infer<typeof RiskSeverity>;

export const Risk = z.object({
  /**
   * MODEL-AUTHORED FREE TEXT. Deliberately not an enum — it is a hint, never a
   * control input.
   *
   * NEVER pass this to groundCitations. It is model-authored free text, and
   * FULL_FILE_KINDS (reviewer-core/src/grounding.ts:16) would exempt a risk
   * claiming kind:"phantom" from line anchoring — bypassing AC-24/AC-26.
   */
  kind: z.string(),
  title: z.string(),
  explanation: z.string(),
  severity: Severity,
  /** The changed file this risk is about — must be present in the PR's diff. */
  file: z.string(),
  /** New-side line range, gated against a real diff hunk before persistence. */
  start_line: z.number().int(),
  end_line: z.number().int(),
  /** legacy — superseded by `file` + the line range. Nothing emits it, and a
   *  `.nullish()` field simply serialises away when absent. */
  file_refs: z.array(z.string()).nullish(),
});
export type Risk = z.infer<typeof Risk>;

export const Risks = z.object({
  risks: z.array(Risk),
});
export type Risks = z.infer<typeof Risks>;

// ---- PR History ----
export const PrHistoryItem = z.object({
  pr_number: z.number().int(),
  title: z.string(),
  merged_at: z.string(),
  author: z.string(),
  files_overlap: z.array(z.string()),
  notes: z.string(),
});
export type PrHistoryItem = z.infer<typeof PrHistoryItem>;

export const PrHistory = z.object({
  history: z.array(PrHistoryItem),
});
export type PrHistory = z.infer<typeof PrHistory>;

// ---- Smart Diff ----
export const SmartDiffRole = z.enum(['core', 'wiring', 'boilerplate']);
export type SmartDiffRole = z.infer<typeof SmartDiffRole>;

export const SmartDiffFile = z.object({
  path: z.string(),
  pseudocode_summary: z.string().nullish(),
  additions: z.number().int(),
  deletions: z.number().int(),
  finding_lines: z.array(z.number().int()),
});
export type SmartDiffFile = z.infer<typeof SmartDiffFile>;

export const SmartDiffGroup = z.object({
  role: SmartDiffRole,
  files: z.array(SmartDiffFile),
});
export type SmartDiffGroup = z.infer<typeof SmartDiffGroup>;

export const ProposedSplit = z.object({
  name: z.string(),
  files: z.array(z.string()),
});
export type ProposedSplit = z.infer<typeof ProposedSplit>;

export const SmartDiff = z.object({
  groups: z.array(SmartDiffGroup),
  split_suggestion: z.object({
    too_big: z.boolean(),
    total_lines: z.number().int(),
    proposed_splits: z.array(ProposedSplit),
  }),
});
export type SmartDiff = z.infer<typeof SmartDiff>;

// ---- Composed PR Brief (legacy, served by nothing) ----
/**
 * RETAINED, UNTOUCHED, SERVED BY NOTHING. It composes `Intent`, `BlastRadius`,
 * `Risks` and `PrHistory`, two of which SPEC-02 does not build (no faithful
 * source for PR history; the blast card owns its own contract). The canonical
 * wire shape of `GET /pulls/:id/brief` is `PrBriefRecord`, below.
 */
export const PrBrief = z.object({
  intent: Intent,
  blast: BlastRadius,
  risks: Risks,
  history: PrHistory,
});
export type PrBrief = z.infer<typeof PrBrief>;

// ==================================================== SPEC-02 · the PR brief

/** Why the change exists, in the brief's own words, plus the signals used. */
export const PrBriefWhy = z.object({
  summary: z.string(),
  sources: z.array(z.string()).default([]),
});
export type PrBriefWhy = z.infer<typeof PrBriefWhy>;

/**
 * One "start reading here" entry. `start_line`/`end_line` are nullish on
 * purpose: an entry may point at a whole file, and it grounds on file presence
 * alone in that case (SPEC-02 AC-27).
 */
export const FocusEntry = z.object({
  file: z.string(),
  start_line: z.number().int().nullish(),
  end_line: z.number().int().nullish(),
  reason: z.string(),
});
export type FocusEntry = z.infer<typeof FocusEntry>;

export const ReviewFocus = z.object({
  entries: z.array(FocusEntry),
});
export type ReviewFocus = z.infer<typeof ReviewFocus>;

/**
 * The brief persisted for a PR — the wire shape of `GET /pulls/:id/brief`.
 * Mirrors `PrIntentRecord` (`contracts/review-api.ts`) field for field where
 * the facts are the same.
 *
 * EVERY field the API may not have computed is `.nullish()`, never required: a
 * section the derivation did not produce must be genuinely ABSENT so the studio
 * can render that section's own empty state while its siblings keep rendering
 * (AC-47). An empty object would be a different, wrong fact.
 */
export const PrBriefRecord = z.object({
  pr_id: z.string(),
  why: PrBriefWhy.nullish(),
  risks: z.array(Risk).default([]),
  focus: ReviewFocus.nullish(),
  /** Citation-gate counts. `kept: 0, dropped: >0` = everything was ungrounded,
   *  which is NOT the same fact as "no risks found" (AC-29). */
  grounding: z
    .object({ kept: z.number().int(), dropped: z.number().int() })
    .nullish(),
  /** Changed files the prompt token cap left out (AC-67). */
  omitted_files: z.array(z.string()).default([]),
  provider: z.string().nullish(),
  model: z.string().nullish(),
  tokens_in: z.number().int().nullish(),
  tokens_out: z.number().int().nullish(),
  /** null both when the model is unpriced AND when this came from cache;
   *  0 only when the model's price is genuinely zero. Never coalesce. */
  cost_usd: z.number().nullish(),
  /** The commit this brief describes; a mismatch with the PR head = stale. */
  head_sha: z.string().nullish(),
  created_at: z.string().nullish(),
});
export type PrBriefRecord = z.infer<typeof PrBriefRecord>;
