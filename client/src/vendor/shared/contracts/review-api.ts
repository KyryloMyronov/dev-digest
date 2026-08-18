import { z } from 'zod';
import { Finding, Verdict } from './findings.js';
import { Intent, SmartDiff } from './brief.js';

/**
 * A2 — Review-Core API surface contracts. These extend the core
 * Review/Finding/Intent/SmartDiff contracts with the persisted/transport shapes
 * the reviewer endpoints return. A2 owns this file; the barrel re-exports it.
 *
 * Distinct from `Finding` (the raw LLM-output unit): `FindingRecord` adds the
 * persisted row identity + action timestamps so the UI can render accept/dismiss
 * state and the `review_id` it belongs to.
 */

export const FindingRecord = Finding.extend({
  review_id: z.string(),
  accepted_at: z.string().nullable(),
  dismissed_at: z.string().nullable(),
});
export type FindingRecord = z.infer<typeof FindingRecord>;

/** A persisted review with its kept findings + grounding summary. */
export const ReviewRecord = z.object({
  id: z.string(),
  pr_id: z.string(),
  agent_id: z.string().nullable(),
  run_id: z.string().nullable(),
  agent_name: z.string().nullish(),
  kind: z.enum(['summary', 'review']),
  verdict: Verdict.nullable(),
  summary: z.string().nullable(),
  score: z.number().int().nullable(),
  model: z.string().nullable(),
  grounding: z.string().nullish(),
  created_at: z.string(),
  findings: z.array(FindingRecord),
});
export type ReviewRecord = z.infer<typeof ReviewRecord>;

/**
 * Response of `POST /pulls/:id/review`. Each requested agent produces a run that
 * streams over SSE at `/runs/:runId/events`; clients subscribe per run. The
 * persisted reviews are also returned once the (synchronous) run completes.
 */
export const ReviewRunTarget = z.object({
  run_id: z.string(),
  agent_id: z.string(),
  agent_name: z.string(),
});
export type ReviewRunTarget = z.infer<typeof ReviewRunTarget>;

export const ReviewRunResponse = z.object({
  pr_id: z.string(),
  runs: z.array(ReviewRunTarget),
  reviews: z.array(ReviewRecord),
});
export type ReviewRunResponse = z.infer<typeof ReviewRunResponse>;

// ---- L03 · Intent layer ----

/** Coarse change categories. Kept small on purpose — a wide taxonomy makes the
 *  cheap classifier less consistent without making the review any better. */
export const IntentChangeType = z.enum([
  'feature',
  'bugfix',
  'refactor',
  'perf',
  'docs',
  'test',
  'chore',
  'revert',
  'security',
  'other',
]);
export type IntentChangeType = z.infer<typeof IntentChangeType>;

/**
 * Which signals the derivation actually used. `spec:<path>` entries carry the
 * resolved path, so the id list is open-ended and typed as string.
 * `ticket_key_unresolved` = a Jira-style key was seen but no tracker is wired,
 * and it must NEVER count as documentation.
 */
export const INTENT_SOURCE_KINDS = [
  'title',
  /** A body long enough to count as documentation — lifts the confidence cap. */
  'pr_body',
  /** A body too short/boilerplate to document anything — does NOT lift the cap. */
  'pr_body_stub',
  'branch',
  'commits',
  'files',
  'ticket',
  'ticket_key_unresolved',
] as const;

/**
 * Intent persisted for a PR (the Intent plus the pr_id it scopes) and the
 * provenance of the derivation.
 *
 * Every added field is nullish or defaulted: a record written before L03 (or by
 * an older server) still parses.
 */
export const PrIntentRecord = Intent.extend({
  pr_id: z.string(),
  change_type: IntentChangeType.nullish(),
  /**
   * 0–1. `null` = never recorded, which is NOT the same fact as a genuinely low
   * score. Capped at 0.45 when no documentation was available — the model's own
   * self-reported number is a ceiling, never the answer.
   */
  confidence: z.number().min(0).max(1).nullish(),
  /** Signals actually used, e.g. `['title','branch','spec:docs/plans/x.md']`. */
  sources: z.array(z.string()).default([]),
  /** Derived from `sources` at read time — drives the low-confidence badge. */
  derived_from: z.enum(['documented', 'indirect']).nullish(),
  provider: z.string().nullish(),
  model: z.string().nullish(),
  /** null both when the model is unpriced AND when this came from cache. */
  cost_usd: z.number().nullish(),
  /** The commit this intent describes; a mismatch with the PR head = stale. */
  head_sha: z.string().nullish(),
  created_at: z.string().nullish(),
});
export type PrIntentRecord = z.infer<typeof PrIntentRecord>;

/** Smart-diff response for a PR (the SmartDiff). */
export const SmartDiffResponse = SmartDiff;
export type SmartDiffResponse = z.infer<typeof SmartDiffResponse>;
