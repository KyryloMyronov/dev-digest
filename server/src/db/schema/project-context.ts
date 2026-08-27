/**
 * project-context — SPEC-01 schema.
 *
 * Three tables, all created in one migration:
 *   - agentContextDocs   — which documents an agent injects, and in what order.
 *   - skillContextDocs   — same, per skill; an agent inherits its skills' docs.
 *   - contextDocTokens   — the token-count cache, keyed by (repo, path).
 *
 * The two link tables are written only by Cut 2 of the build, and they are
 * created here anyway: that matches the repository's stated
 * schema-ahead-of-features policy, and it is what lets AC-15's
 * `attached_agents` count be honest in Cut 1 — `COUNT(*)` over an empty table
 * returns 0 truthfully, where a hardcoded zero would have to be revisited.
 *
 * THREE DESIGN NOTES, so none of them reads as a mistake in review:
 *
 * 1. **No surrogate key.** The `postgresql-table-design` skill prefers
 *    `BIGINT GENERATED ALWAYS AS IDENTITY`. Every one of this repository's ~35
 *    tables uses `uuid().defaultRandom()` or a composite PK, and `agent_skills`
 *    (`./agents.ts`) — the table these two link tables copy — is a composite PK
 *    with no surrogate. Consistency with the existing schema wins. The skill's
 *    *index* advice is followed: Postgres does not index FK columns, so the ones
 *    the PK cannot serve are indexed explicitly below.
 *
 * 2. **`agent_skills` has no `workspace_id`; these three do.** So "modelled on
 *    `agent_skills`" is true of everything except tenancy. The root `AGENTS.md`
 *    requires `workspace_id` on every domain table, and AC-3 / AC-18 / AC-20
 *    test it, so the divergence from the template table is deliberate.
 *
 * 3. **`path` is a join key, not a foreign key.** Documents live in a git clone
 *    and have no row of their own, so an attachment can outlive the file it
 *    names — which is exactly what AC-29 (render the row as unresolved) and
 *    AC-43 (record it as skipped) exist for. Nothing here stores a document
 *    *body*: `context_doc_tokens` holds a hash and a count, never the text.
 */
import { pgTable, uuid, text, integer, timestamp, primaryKey, index } from 'drizzle-orm/pg-core';
import { workspaces } from './core';
import { repos } from './repos';
import { agents } from './agents';
import { skills } from './skills';

/**
 * Documents attached directly to an agent. `order` IS the prompt order (AC-21).
 * PK `(agent_id, path)` makes an attach idempotent.
 *
 * `path` carries no `repo_id` on purpose: an agent is a workspace-level object,
 * so the same attachment resolves against whichever repository the reviewed PR
 * belongs to (D-Q6f). AC-29 is how the user sees a path that does not resolve.
 */
export const agentContextDocs = pgTable(
  'agent_context_docs',
  {
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    path: text('path').notNull(),
    order: integer('order').notNull().default(0),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.agentId, t.path] }),
    // AC-15 counts attachments per PATH across the workspace, and the PK leads
    // with `agent_id`, so the PK cannot serve that scan.
    workspacePathIdx: index('agent_context_docs_workspace_path_idx').on(t.workspaceId, t.path),
  }),
);

/**
 * Documents attached to a skill. An agent's enabled skills contribute these
 * after the agent's own attachments (AC-21). PK `(skill_id, path)` — leading
 * with `skill_id`, so no extra index on that column is needed.
 */
export const skillContextDocs = pgTable(
  'skill_context_docs',
  {
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    skillId: uuid('skill_id')
      .notNull()
      .references(() => skills.id, { onDelete: 'cascade' }),
    path: text('path').notNull(),
    order: integer('order').notNull().default(0),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.skillId, t.path] }),
    workspacePathIdx: index('skill_context_docs_workspace_path_idx').on(t.workspaceId, t.path),
  }),
);

/**
 * Token-count cache, one row per discovered document per repository.
 *
 * `contentHash` is what lets a re-scan skip a document whose text has not moved
 * (AC-36), following `symbols.content_hash` in `./context.ts`. The list endpoint
 * reads `tokens` from here and NEVER computes it (NFR-3); a path with no row
 * serves `tokens: null` (AC-34).
 *
 * PK `(repo_id, path)` leads with `repo_id`, which is the range scan the list
 * endpoint does, so no separate FK index is needed.
 */
export const contextDocTokens = pgTable(
  'context_doc_tokens',
  {
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    repoId: uuid('repo_id')
      .notNull()
      .references(() => repos.id, { onDelete: 'cascade' }),
    path: text('path').notNull(),
    contentHash: text('content_hash').notNull(),
    tokens: integer('tokens').notNull(),
    computedAt: timestamp('computed_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.repoId, t.path] }),
  }),
);
