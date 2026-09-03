import {
  pgTable,
  uuid,
  text,
  integer,
  boolean,
  jsonb,
  timestamp,
  doublePrecision,
  index,
} from 'drizzle-orm/pg-core';
import { now } from './_shared';
import { workspaces } from './core';
import { agents } from './agents';
import { pullRequests } from './pulls';

// ============================================================ Eval / Conformance / Compose

export const evalCases = pgTable(
  'eval_cases',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    ownerKind: text('owner_kind', { enum: ['skill', 'agent'] }).notNull(),
    ownerId: uuid('owner_id').notNull(),
    name: text('name').notNull(),
    inputDiff: text('input_diff'),
    inputFiles: jsonb('input_files'),
    inputMeta: jsonb('input_meta'),
    expectedOutput: jsonb('expected_output'),
    // SPEC-04 — what this case asserts (AC-7, AC-8). Drizzle's `enum` here is
    // TypeScript-only inference: it emits NO CHECK constraint, exactly like
    // `agents.provider`. The two values are enforced by Zod at the route. A
    // pgEnum would need a migration to extend, which is why this repo avoids
    // one (see the note at `schema/reviews.ts:72-73`).
    expectation: text('expectation', { enum: ['must_find', 'must_not_flag'] })
      .notNull()
      .default('must_find'),
    createdAt: now(),
    notes: text('notes'),
  },
  (t) => ({
    // Postgres does not auto-index a foreign key or a (kind, id) owner pair, and
    // every read in this feature is "the cases of ONE agent".
    ownerIdx: index('eval_cases_owner_idx').on(t.ownerKind, t.ownerId),
  }),
);

/**
 * One execution of one case.
 *
 * TENANCY (SPEC-04 AC-2): this table carries NO `workspace_id`, deliberately.
 * A run's workspace is resolved through `case_id → eval_cases.workspace_id`,
 * exactly as `pr_intent`/`pr_brief` scope through `pr_id`. A second tenancy
 * path that could disagree with the first is what AC-2 exists to forbid — do
 * not add one.
 *
 * A BATCH is not a table: N rows sharing a `batch_id` are inserted up front with
 * every metric null and updated in place as each case completes, and the batch's
 * status is DERIVED on read (plan D-2). That is why `batch_id` takes no FK.
 */
export const evalRuns = pgTable(
  'eval_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    caseId: uuid('case_id')
      .notNull()
      .references(() => evalCases.id, { onDelete: 'cascade' }),
    // DENORMALISED for the dashboard read, and NOT the tenancy path (AC-2).
    // `ON DELETE SET NULL`: deleting an agent must not erase the record of what
    // it scored. A run whose agent_id names a FOREIGN agent is still readable in
    // its own workspace — that is the observation that proves the join above is
    // the only tenancy path.
    agentId: uuid('agent_id').references(() => agents.id, { onDelete: 'set null' }),
    // The agent's `version` at execution time (AC-32). No FK: `agent_versions`'
    // PK is composite and a snapshot may legitimately be absent
    // (`snapshotVersion` is onConflictDoNothing).
    agentVersion: integer('agent_version'),
    // The batch this row belongs to. No FK — there is no batch table.
    batchId: uuid('batch_id'),
    // How the batch was started: 'manual' (AC-33) or 'version-change' (AC-90).
    trigger: text('trigger', { enum: ['manual', 'version-change'] }),
    ranAt: timestamp('ran_at', { withTimezone: true }).defaultNow().notNull(),
    actualOutput: jsonb('actual_output'),
    pass: boolean('pass'),
    recall: doublePrecision('recall'),
    precision: doublePrecision('precision'),
    citationAccuracy: doublePrecision('citation_accuracy'),
    durationMs: integer('duration_ms'),
    costUsd: doublePrecision('cost_usd'),
    // The provider's message (AC-36) or the post-retry parse error (AC-111).
    // A row with `error` set and `pass` null is a case that ran and failed; a
    // row with both null is a case the batch never reached.
    error: text('error'),
  },
  (t) => ({
    // The dashboard reads "this agent's batches, newest first".
    agentRanAtIdx: index('eval_runs_agent_ran_at_idx').on(t.agentId, t.ranAt.desc()),
    // The batch aggregate groups by batch_id.
    batchIdx: index('eval_runs_batch_idx').on(t.batchId),
  }),
);

export const conformanceChecks = pgTable('conformance_checks', {
  id: uuid('id').primaryKey().defaultRandom(),
  prId: uuid('pr_id')
    .notNull()
    .references(() => pullRequests.id, { onDelete: 'cascade' }),
  specId: text('spec_id').notNull(),
  completenessPct: doublePrecision('completeness_pct'),
  items: jsonb('items'),
});

export const composedReviews = pgTable('composed_reviews', {
  id: uuid('id').primaryKey().defaultRandom(),
  prId: uuid('pr_id')
    .notNull()
    .references(() => pullRequests.id, { onDelete: 'cascade' }),
  body: text('body').notNull(),
  verdict: text('verdict'),
  postedAt: timestamp('posted_at', { withTimezone: true }),
  githubReviewId: text('github_review_id'),
});
