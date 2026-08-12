import {
  pgTable,
  uuid,
  text,
  jsonb,
  timestamp,
  doublePrecision,
  boolean,
  integer,
  vector,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { now } from './_shared';
import { workspaces } from './core';
import { repos } from './repos';

// ============================================================ Knowledge / RAG

export const memory = pgTable(
  'memory',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    repoId: uuid('repo_id').references(() => repos.id, { onDelete: 'cascade' }),
    scope: text('scope', { enum: ['repo', 'global', 'team'] }).notNull(),
    kind: text('kind', {
      enum: ['decision', 'convention', 'preference', 'fact', 'learning'],
    }).notNull(),
    content: text('content').notNull(),
    embedding: vector('embedding', { dimensions: 1536 }),
    confidence: doublePrecision('confidence'),
    sources: jsonb('sources'),
    createdAt: now(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
  },
  (t) => ({ wsIdx: index('memory_ws_idx').on(t.workspaceId) }),
);

/**
 * House rules the extractor derived from a repo's own source, each awaiting the
 * user's accept/reject.
 *
 * TWO rule columns on purpose. `sourceRule` is the model's original wording and
 * never changes — it is the identity a re-scan matches on, so a rule the user
 * has rewritten is recognised as already-seen instead of being re-inserted
 * alongside its own original. `rule` is what the UI shows and edits.
 *
 * `status` replaces an earlier `accepted` boolean: rejecting is a decision worth
 * remembering, so a re-scan does not offer the same rule again.
 */
export const conventions = pgTable(
  'conventions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    repoId: uuid('repo_id').references(() => repos.id, { onDelete: 'cascade' }),
    sourceRule: text('source_rule').notNull(),
    rule: text('rule').notNull(),
    evidencePath: text('evidence_path'),
    evidenceSnippet: text('evidence_snippet'),
    confidence: doublePrecision('confidence'),
    status: text('status', { enum: ['pending', 'accepted', 'rejected'] })
      .notNull()
      .default('pending'),
    /** Set once the user rewrote the rule or snippet — a re-scan must not overwrite it. */
    edited: boolean('edited').notNull().default(false),
    /** Last scan that still found this rule in the code. */
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
    createdAt: now(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    // The re-scan identity. Also the backstop that keeps two concurrent scans
    // from double-inserting the same rule.
    sourceRuleUq: uniqueIndex('conventions_source_rule_uq').on(
      t.workspaceId,
      t.repoId,
      t.sourceRule,
    ),
    repoIdx: index('conventions_repo_idx').on(t.repoId),
  }),
);

/**
 * One row per repo describing its LAST conventions scan — not a history.
 * Modeled on `repo_index_state`: the screen renders "detected from N sample
 * files · last scan 1h ago" and nothing renders a past scan, so a row whose
 * status is `queued`/`running` IS the "Scanning…" state the UI polls.
 *
 * `degraded` means the scan could not run for a reason that is not an error —
 * an unindexed repo, no clone on disk — with `reason` carrying which.
 */
export const conventionScanState = pgTable('convention_scan_state', {
  repoId: uuid('repo_id')
    .primaryKey()
    .references(() => repos.id, { onDelete: 'cascade' }),
  workspaceId: uuid('workspace_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  status: text('status', {
    enum: ['queued', 'running', 'done', 'failed', 'degraded'],
  }).notNull(),
  reason: text('reason'),
  /** Files the ranker offered. */
  sampleFiles: integer('sample_files').notNull().default(0),
  /** Files actually read and sent to the model. */
  selectedFiles: integer('selected_files').notNull().default(0),
  candidatesFound: integer('candidates_found').notNull().default(0),
  newCandidates: integer('new_candidates').notNull().default(0),
  provider: text('provider'),
  model: text('model'),
  /** Correlation with the `jobs` row. Deliberately no FK — jobs are prunable. */
  jobId: uuid('job_id'),
  startedAt: timestamp('started_at', { withTimezone: true }),
  finishedAt: timestamp('finished_at', { withTimezone: true }),
  error: text('error'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});
