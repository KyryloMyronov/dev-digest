import { sql } from 'drizzle-orm';
import {
  pgTable,
  uuid,
  text,
  integer,
  jsonb,
  timestamp,
  doublePrecision,
  primaryKey,
} from 'drizzle-orm/pg-core';
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

/**
 * SPEC-02 — the derived PR brief (why / risks / review focus). One row per PR
 * (the PK is `pr_id`), so a re-derivation overwrites in place and `head_sha` is
 * the staleness key, exactly as `pr_intent` above.
 *
 * A FAILED derivation writes NO row — a failure row would overwrite a good
 * earlier derivation and poison the cache (AC-11).
 *
 * No `workspace_id`: `pr_brief` and `pr_intent` both scope through
 * `pr_id → pull_requests.workspace_id`. The scoping is asserted at the
 * repository, which is where the criterion actually lives (AC-3).
 *
 * No index beyond the PK: every read is by primary key and nothing queries
 * inside the JSONB, so neither a GIN index nor a generated column earns its
 * cost.
 */
export const prBrief = pgTable('pr_brief', {
  prId: uuid('pr_id')
    .primaryKey()
    .references(() => pullRequests.id, { onDelete: 'cascade' }),
  /** The model-derived BODY only: { why, risks, focus, grounding,
   *  omitted_files }. Deliberately NOT typed as the wire shape — the blob is a
   *  strict subset of `PrBriefRecord`; `modules/brief/types.ts`'s `BriefBlob`
   *  is what it is typed against, so column and wire shape cannot be confused. */
  json: jsonb('json').notNull(),
  provider: text('provider'),
  model: text('model'),
  tokensIn: integer('tokens_in'),
  tokensOut: integer('tokens_out'),
  /** NULL = unpriced model OR served from cache; 0 = a genuinely free model.
   *  Never coalesce the two (see root insights.md 2026-08-02). */
  costUsd: doublePrecision('cost_usd'),
  /** The commit this brief describes. NULL on a pre-SPEC-02 row ⇒ treated as stale. */
  headSha: text('head_sha'),
  /** Last derived at — the upsert must set this explicitly on conflict, or a
   *  re-derivation silently keeps the original timestamp. */
  createdAt: now(),
});

/**
 * SPEC-03 — one derived one-line summary per changed file per commit.
 *
 * WHY A TABLE AND NOT A COLUMN ON `pr_files` (plan P-5), because the next
 * reader will ask: `replaceFiles` is a wholesale `DELETE`+`INSERT`
 * (`modules/pulls/repository.ts`) fired by `getDetail` on EVERY
 * `GET /pulls/:id` when GitHub is reachable (`modules/pulls/service.ts`). A
 * summary column would be destroyed by the next page load.
 *
 * `head_sha` IS PART OF THE PK AND THEREFORE NOT NULL — unlike
 * `pr_intent.head_sha` / `pr_brief.head_sha`, which are nullable and treated as
 * stale. A summary cannot exist without naming the commit it describes, which
 * is what makes AC-58 a comparison rather than a guess, and what makes a
 * force-push produce a NEW row instead of silently overwriting the description
 * of the old patch.
 *
 * AND THEREFORE (plan D-2): rows ACCUMULATE per head SHA, so the read projects
 * to ONE ROW PER PATH — `DISTINCT ON (path)` ordered so a current-head row
 * always wins (`modules/file-summary/repository.ts`). Without that projection
 * AC-49 (render the fresh summary) and AC-58 (badge the stale one) would both
 * fire for one file, and NFR-5's 32 KB response ceiling would be unbounded
 * across force-pushes.
 *
 * A FAILED derivation writes NO row. Unlike `pr_brief` a failure row here would
 * not overwrite a good one (the PK includes `head_sha`), but it would still be
 * SERVED as a summary. Do not add an error-recording write.
 *
 * No separate index on the FK: Postgres does not auto-index foreign-key
 * columns, but `pr_id` is the LEADING column of the composite PK, so its B-tree
 * already serves both the cascade and every read this feature performs
 * (`WHERE pr_id = $1`, optionally `AND head_sha = $2`). A second index would be
 * dead weight. No GIN index and no JSONB — nothing queries inside a summary.
 *
 * No `workspace_id`: scopes through `pr_id → pull_requests.workspace_id`,
 * exactly as `pr_intent` and `pr_brief` do. AC-4 asserts the scoping holds, at
 * the repository, which is where the criterion lives.
 */
export const prFileSummaries = pgTable(
  'pr_file_summaries',
  {
    prId: uuid('pr_id')
      .notNull()
      .references(() => pullRequests.id, { onDelete: 'cascade' }),
    path: text('path').notNull(),
    headSha: text('head_sha').notNull(),
    summary: text('summary').notNull(),
    provider: text('provider'),
    model: text('model'),
    /** This file's SHARE of the derivation's tokens, apportioned by prompt
     *  tokens (plan D-1) — NOT the whole call's usage. */
    tokensIn: integer('tokens_in'),
    tokensOut: integer('tokens_out'),
    /** This file's SHARE of the derivation's cost, so SUM(cost_usd) over one
     *  derivation's rows is exact (plan D-1). NULL = unpriced model; 0 = a
     *  genuinely free model. Never coalesce the two (root insights.md
     *  2026-08-02). */
    costUsd: doublePrecision('cost_usd'),
    /** Last derived at — the upsert must set this from SQL `now()` on conflict,
     *  or a re-derivation silently keeps the original timestamp AND the
     *  `created_at DESC` tie-break of D-2's projection reads the wrong row. */
    createdAt: now(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.prId, t.path, t.headSha] }),
  }),
);
