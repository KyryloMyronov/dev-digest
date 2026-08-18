import { sql } from 'drizzle-orm';
import { pgTable, uuid, text, integer, jsonb, timestamp, doublePrecision } from 'drizzle-orm/pg-core';
import { now } from './_shared';
import { workspaces } from './core';
import { pullRequests } from './pulls';

// ============================================================ Review & findings

export const reviews = pgTable('reviews', {
  id: uuid('id').primaryKey().defaultRandom(),
  workspaceId: uuid('workspace_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  prId: uuid('pr_id')
    .notNull()
    .references(() => pullRequests.id, { onDelete: 'cascade' }),
  agentId: uuid('agent_id'),
  /** The agent_run that produced this review (links the timeline run ↔ review). */
  runId: uuid('run_id'),
  kind: text('kind', { enum: ['summary', 'review'] }).notNull(),
  verdict: text('verdict'),
  summary: text('summary'),
  score: integer('score'),
  model: text('model'),
  createdAt: now(),
});

export const findings = pgTable('findings', {
  id: uuid('id').primaryKey().defaultRandom(),
  reviewId: uuid('review_id')
    .notNull()
    .references(() => reviews.id, { onDelete: 'cascade' }),
  file: text('file').notNull(),
  startLine: integer('start_line').notNull(),
  endLine: integer('end_line').notNull(),
  severity: text('severity').notNull(),
  category: text('category').notNull(),
  title: text('title').notNull(),
  rationale: text('rationale').notNull(),
  suggestion: text('suggestion'),
  confidence: doublePrecision('confidence').notNull(),
  kind: text('kind').notNull().default('finding'),
  trifectaComponents: jsonb('trifecta_components').$type<string[]>(),
  acceptedAt: timestamp('accepted_at', { withTimezone: true }),
  dismissedAt: timestamp('dismissed_at', { withTimezone: true }),
});

/**
 * L03 — the derived intent of a PR. One row per PR (the PK is `pr_id`), so a
 * re-derivation overwrites in place and `head_sha` is the staleness key, mirroring
 * how `pull_requests.last_reviewed_sha` marks a review stale.
 *
 * A FAILED derivation writes NO row — a failure row would poison the cache. The
 * Live Log is the only record of a failure, which is why it logs at `error`.
 */
export const prIntent = pgTable('pr_intent', {
  prId: uuid('pr_id')
    .primaryKey()
    .references(() => pullRequests.id, { onDelete: 'cascade' }),
  intent: text('intent').notNull(),
  inScope: jsonb('in_scope').$type<string[]>().notNull().default(sql`'[]'::jsonb`),
  outOfScope: jsonb('out_of_scope').$type<string[]>().notNull().default(sql`'[]'::jsonb`),
  /** Coarse category (IntentChangeType). Plain text + Zod validation, like
   *  `agent_runs.status` — a pg enum would need a migration to extend. */
  changeType: text('change_type'),
  /** 0–1. NULL = never recorded, which is NOT the same fact as a low score. */
  confidence: doublePrecision('confidence'),
  /** Signal ids actually used, e.g. ['title','branch','spec:docs/plan.md']. */
  sources: jsonb('sources').$type<string[]>().notNull().default(sql`'[]'::jsonb`),
  provider: text('provider'),
  model: text('model'),
  tokensIn: integer('tokens_in'),
  tokensOut: integer('tokens_out'),
  /** NULL = unpriced model OR served from cache; 0 = a genuinely free model.
   *  Never coalesce the two (see root insights.md 2026-08-02). */
  costUsd: doublePrecision('cost_usd'),
  /** The commit this intent describes. NULL on a pre-L03 row ⇒ treated as stale. */
  headSha: text('head_sha'),
  /** Last derived at — the upsert must set this explicitly on conflict, or a
   *  re-derivation silently keeps the original timestamp. */
  createdAt: now(),
});

export const prBrief = pgTable('pr_brief', {
  prId: uuid('pr_id')
    .primaryKey()
    .references(() => pullRequests.id, { onDelete: 'cascade' }),
  json: jsonb('json').notNull(),
});
