import { z } from 'zod';

/**
 * Blast Radius endpoint contract (GET /pulls/:id/blast).
 *
 * Computed entirely from the repo-intel index — no LLM. Deliberately separate
 * from `contracts/brief.ts` BlastRadius: that shape is composed into PrBrief
 * and carries an LLM-written `summary`; this one carries what the index can
 * assert — per-caller line/rank, truncation, endpoint chains, and an honest
 * `status` instead of empty arrays when data is missing.
 */

// ---- Index-derived completeness of the answer ----
export const BlastStatus = z.enum(['full', 'partial', 'degraded']);
export type BlastStatus = z.infer<typeof BlastStatus>;

// ---- One caller of a changed symbol ----
export const BlastCallerOut = z.object({
  file: z.string(),
  /** Enclosing symbol at the reference site. */
  symbol: z.string(),
  /** 1-based line of the reference. */
  line: z.number().int(),
  /** file_rank.rank of the caller file; 0 when unranked or degraded. */
  rank: z.number(),
});
export type BlastCallerOut = z.infer<typeof BlastCallerOut>;

// ---- One changed symbol with its downstream impact ----
export const BlastSymbolImpact = z.object({
  symbol: z.string(),
  /** File declaring the symbol (never listed among its own callers). */
  file: z.string(),
  kind: z.string(),
  /** Sorted by rank DESC, capped at 20 per symbol. */
  callers: z.array(BlastCallerOut),
  /** True when the 20-caller cap cut this list. */
  callers_truncated: z.boolean(),
  /** "METHOD /path" facts of this symbol's caller files. */
  endpoints_affected: z.array(z.string()),
  crons_affected: z.array(z.string()),
});
export type BlastSymbolImpact = z.infer<typeof BlastSymbolImpact>;

// ---- An endpoint reachable through the reverse import graph ----
export const BlastEndpointPath = z.object({
  /** "METHOD /path". */
  endpoint: z.string(),
  /** Route file serving the endpoint. */
  file: z.string(),
  /** Import chain: changed file → … → route file (≤ 2 hops). */
  chain: z.array(z.string()),
});
export type BlastEndpointPath = z.infer<typeof BlastEndpointPath>;

// ---- Response ----
export const BlastResponse = z.object({
  status: BlastStatus,
  /** Human explanation, present whenever status !== 'full'. */
  reason: z.string().nullish(),
  changed_files: z.array(z.string()),
  impacts: z.array(BlastSymbolImpact),
  /** Reverse-import walk results (depth ≤ 2), union'd with caller-file facts. */
  endpoints: z.array(BlastEndpointPath),
});
export type BlastResponse = z.infer<typeof BlastResponse>;
