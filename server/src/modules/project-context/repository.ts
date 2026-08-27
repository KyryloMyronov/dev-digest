/**
 * project-context data-access layer — SPEC-01.
 *
 * The ONLY file in this module allowed to import `drizzle-orm`
 * (`no-drizzle-outside-persistence` whitelists a module's own `repository.ts`),
 * and the only code that touches `agent_context_docs`, `skill_context_docs` and
 * `context_doc_tokens`.
 *
 * Every read the list endpoint needs is SET-BASED, deliberately: NFR-3 gives
 * `GET /repos/:id/context` an 800 ms p95 over 500 documents, which rules out a
 * per-document query. `list()` in the service is one walk plus exactly the two
 * lookups below plus `lastScanAt`.
 */
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import * as t from '../../db/schema.js';

/** One row the token-count job persists. */
export interface TokenCountUpsert {
  workspaceId: string;
  repoId: string;
  path: string;
  contentHash: string;
  tokens: number;
}

/** What the job needs to decide whether a document must be re-counted (AC-36). */
export interface CachedTokenRow {
  contentHash: string;
  tokens: number;
}

/** One persisted attachment row, in prompt order. `order` IS the prompt order. */
export interface ContextDocLinkRow {
  path: string;
  order: number;
}

export class ProjectContextRepository {
  constructor(private db: Db) {}

  /**
   * Every cached token count for a repository, as `path → tokens`. One query.
   * A path absent from the map has no cached row and therefore serves
   * `tokens: null` (AC-34).
   */
  async tokensForRepo(workspaceId: string, repoId: string): Promise<Map<string, number>> {
    const rows = await this.db
      .select({ path: t.contextDocTokens.path, tokens: t.contextDocTokens.tokens })
      .from(t.contextDocTokens)
      .where(
        and(
          eq(t.contextDocTokens.workspaceId, workspaceId),
          eq(t.contextDocTokens.repoId, repoId),
        ),
      );
    return new Map(rows.map((r) => [r.path, r.tokens]));
  }

  /**
   * Same rows as `tokensForRepo` but carrying the hash, for the job's
   * skip-if-unchanged decision. Kept separate so the read path never pulls a
   * column it does not use.
   */
  async cachedTokenRows(
    workspaceId: string,
    repoId: string,
  ): Promise<Map<string, CachedTokenRow>> {
    const rows = await this.db
      .select({
        path: t.contextDocTokens.path,
        contentHash: t.contextDocTokens.contentHash,
        tokens: t.contextDocTokens.tokens,
      })
      .from(t.contextDocTokens)
      .where(
        and(
          eq(t.contextDocTokens.workspaceId, workspaceId),
          eq(t.contextDocTokens.repoId, repoId),
        ),
      );
    return new Map(rows.map((r) => [r.path, { contentHash: r.contentHash, tokens: r.tokens }]));
  }

  /**
   * AC-15 — how many agents attach each path, workspace-wide. ONE `GROUP BY`,
   * never a per-document count: an N+1 here is what NFR-3 exists to prevent.
   * Served by `agent_context_docs_workspace_path_idx`.
   */
  async agentCountsByPath(workspaceId: string): Promise<Map<string, number>> {
    const rows = await this.db
      .select({
        path: t.agentContextDocs.path,
        count: sql<number>`count(distinct ${t.agentContextDocs.agentId})::int`,
      })
      .from(t.agentContextDocs)
      .where(eq(t.agentContextDocs.workspaceId, workspaceId))
      .groupBy(t.agentContextDocs.path);
    return new Map(rows.map((r) => [r.path, Number(r.count)]));
  }

  /**
   * AC-16 — when the token scan last ran for this repository, or null when it
   * never has. The newest `computed_at` among the repo's cached rows: the
   * document *list* is a live walk, so the persisted token scan is the only
   * "scan" with a recorded time, and it is the one D-Q4's reindex endpoint
   * triggers.
   *
   * `ORDER BY … DESC LIMIT 1` rather than `MAX(...)`: expressing the aggregate
   * needs `sql<Date | null>`, and a UNION inside a generic type argument makes
   * `sql<...>` ambiguous with a `<` comparison — `tsc` picks the comparison and
   * the file stops parsing. Same result, no ambiguity.
   */
  async lastScanAt(workspaceId: string, repoId: string): Promise<Date | null> {
    const [row] = await this.db
      .select({ at: t.contextDocTokens.computedAt })
      .from(t.contextDocTokens)
      .where(
        and(
          eq(t.contextDocTokens.workspaceId, workspaceId),
          eq(t.contextDocTokens.repoId, repoId),
        ),
      )
      .orderBy(desc(t.contextDocTokens.computedAt))
      .limit(1);
    return row?.at ?? null;
  }

  /**
   * Persist one document's count. `computed_at` is stamped with SQL `now()`
   * on BOTH paths — the column's `defaultNow()` fires only on insert, and
   * mixing it with a Node `new Date()` on the conflict path mixes two clocks
   * that drift under a VM-hosted Postgres (see `server/insights.md`, 2026-08-17).
   */
  async upsertTokenCount(values: TokenCountUpsert): Promise<void> {
    await this.db
      .insert(t.contextDocTokens)
      .values({
        workspaceId: values.workspaceId,
        repoId: values.repoId,
        path: values.path,
        contentHash: values.contentHash,
        tokens: values.tokens,
        computedAt: sql`now()`,
      })
      .onConflictDoUpdate({
        target: [t.contextDocTokens.repoId, t.contextDocTokens.path],
        set: {
          contentHash: values.contentHash,
          tokens: values.tokens,
          computedAt: sql`now()`,
        },
      });
  }

  /**
   * The repo's clone location and its owner/name, workspace-scoped (AC-3).
   * `clonePath` is null until the clone job has run — AC-4's `repo_not_cloned`.
   */
  async repoForContext(
    workspaceId: string,
    repoId: string,
  ): Promise<{ owner: string; name: string; fullName: string; clonePath: string | null } | null> {
    const [row] = await this.db
      .select({
        owner: t.repos.owner,
        name: t.repos.name,
        fullName: t.repos.fullName,
        clonePath: t.repos.clonePath,
      })
      .from(t.repos)
      .where(and(eq(t.repos.workspaceId, workspaceId), eq(t.repos.id, repoId)));
    return row ?? null;
  }

  /**
   * Unscoped repo lookup for the token-count JOB, which runs off a queue and
   * has no request context. Mirrors `RepoRepository.workspaceIdFor`'s reasoning:
   * the payload came out of an already-authenticated path, and the job needs the
   * `workspace_id` in order to scope everything it writes.
   */
  async repoForJob(
    repoId: string,
  ): Promise<{ workspaceId: string; owner: string; name: string; clonePath: string | null } | null> {
    const [row] = await this.db
      .select({
        workspaceId: t.repos.workspaceId,
        owner: t.repos.owner,
        name: t.repos.name,
        clonePath: t.repos.clonePath,
      })
      .from(t.repos)
      .where(eq(t.repos.id, repoId));
    return row ?? null;
  }

  /**
   * Does this skill exist in THIS workspace? Existence only — the parent-
   * ownership check on the two skill writes needs nothing else from the row.
   *
   * Deliberately a read of another module's table, and the cost is stated:
   * `skills` is owned by `modules/skills/`, so this makes `project-context` its
   * SECOND reader. The two alternatives are worse. `SkillsRepository.getById`
   * is that module's private internal (`no-cross-module-internals`), and a
   * `container.skillsRepo` getter adds composition-root surface for one
   * existence probe. This mirrors `repoForContext` directly above, which
   * already reads `t.repos` through the shared schema for the same reason.
   */
  async skillForContext(workspaceId: string, skillId: string): Promise<{ id: string } | null> {
    const [row] = await this.db
      .select({ id: t.skills.id })
      .from(t.skills)
      .where(and(eq(t.skills.workspaceId, workspaceId), eq(t.skills.id, skillId)));
    return row ?? null;
  }

  // ------------------------------------------------- attachments (Cut 2) -----
  //
  // Modelled on `AgentsRepository`'s `agent_skills` methods: `onConflictDoUpdate`
  // on the composite PK setting `order` ONLY (re-attaching must not silently
  // undo other state), reads ordered by `order` ascending because that IS the
  // prompt order, and the bulk replace runs delete-then-insert in ONE
  // transaction so no run can observe an agent with no attachments at all.
  //
  // Every one of them scopes by `workspace_id` as well as by the owning id
  // (AC-18, AC-20) — the PK alone would let a foreign workspace's agent id
  // reach a row.

  /** AC-18 — the agent's own attachments, in prompt order. */
  async agentDocs(workspaceId: string, agentId: string): Promise<ContextDocLinkRow[]> {
    return this.db
      .select({ path: t.agentContextDocs.path, order: t.agentContextDocs.order })
      .from(t.agentContextDocs)
      .where(
        and(
          eq(t.agentContextDocs.workspaceId, workspaceId),
          eq(t.agentContextDocs.agentId, agentId),
        ),
      )
      .orderBy(asc(t.agentContextDocs.order), asc(t.agentContextDocs.path));
  }

  /**
   * AC-18 — attach one path, appended at the end of the current order.
   *
   * The `max(order) + 1` read and the insert share one transaction so two
   * concurrent attaches cannot both claim the same slot. Idempotent: a path the
   * agent already attaches keeps its existing `order` (the conflict path sets
   * `order` to the value already stored, which is a no-op the PK makes safe).
   */
  async attachAgentDoc(workspaceId: string, agentId: string, path: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      const [existing] = await tx
        .select({ order: t.agentContextDocs.order })
        .from(t.agentContextDocs)
        .where(and(eq(t.agentContextDocs.agentId, agentId), eq(t.agentContextDocs.path, path)));
      if (existing) return;

      const [max] = await tx
        .select({ next: sql<number>`coalesce(max(${t.agentContextDocs.order}) + 1, 0)::int` })
        .from(t.agentContextDocs)
        .where(eq(t.agentContextDocs.agentId, agentId));

      await tx
        .insert(t.agentContextDocs)
        .values({ workspaceId, agentId, path, order: Number(max?.next ?? 0) })
        .onConflictDoUpdate({
          target: [t.agentContextDocs.agentId, t.agentContextDocs.path],
          set: { order: Number(max?.next ?? 0) },
        });
    });
  }

  /** AC-18 — detach one path. Returns false when the agent had no such row. */
  async detachAgentDoc(workspaceId: string, agentId: string, path: string): Promise<boolean> {
    const rows = await this.db
      .delete(t.agentContextDocs)
      .where(
        and(
          eq(t.agentContextDocs.workspaceId, workspaceId),
          eq(t.agentContextDocs.agentId, agentId),
          eq(t.agentContextDocs.path, path),
        ),
      )
      .returning({ path: t.agentContextDocs.path });
    return rows.length > 0;
  }

  /**
   * AC-19 — replace the agent's whole ordered list, `order = index`. The client
   * sends the full list, exactly as `useSetAgentSkills` does, so a reorder is
   * one round trip rather than N.
   *
   * Delete-then-insert in ONE transaction, for `setSkills`'s reason: the
   * intermediate state is an agent with no attachments, and a review that
   * started between the two statements would assemble a prompt with the whole
   * project-context block missing — a silently wrong run rather than a failed
   * one.
   */
  async setAgentDocs(workspaceId: string, agentId: string, paths: string[]): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx
        .delete(t.agentContextDocs)
        .where(
          and(
            eq(t.agentContextDocs.workspaceId, workspaceId),
            eq(t.agentContextDocs.agentId, agentId),
          ),
        );
      if (paths.length === 0) return;
      // De-duplicated: the PK is `(agent_id, path)`, so a repeated path in the
      // submitted list would abort the whole insert. First occurrence wins,
      // which is the same tie-break the resolver applies (AC-22).
      const unique = [...new Set(paths)];
      await tx
        .insert(t.agentContextDocs)
        .values(unique.map((path, i) => ({ workspaceId, agentId, path, order: i })));
    });
  }

  /** AC-20 — the skill's attachments, in prompt order. */
  async skillDocs(workspaceId: string, skillId: string): Promise<ContextDocLinkRow[]> {
    return this.db
      .select({ path: t.skillContextDocs.path, order: t.skillContextDocs.order })
      .from(t.skillContextDocs)
      .where(
        and(
          eq(t.skillContextDocs.workspaceId, workspaceId),
          eq(t.skillContextDocs.skillId, skillId),
        ),
      )
      .orderBy(asc(t.skillContextDocs.order), asc(t.skillContextDocs.path));
  }

  /** AC-20 — attach one path to a skill, appended. Mirrors `attachAgentDoc`. */
  async attachSkillDoc(workspaceId: string, skillId: string, path: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      const [existing] = await tx
        .select({ order: t.skillContextDocs.order })
        .from(t.skillContextDocs)
        .where(and(eq(t.skillContextDocs.skillId, skillId), eq(t.skillContextDocs.path, path)));
      if (existing) return;

      const [max] = await tx
        .select({ next: sql<number>`coalesce(max(${t.skillContextDocs.order}) + 1, 0)::int` })
        .from(t.skillContextDocs)
        .where(eq(t.skillContextDocs.skillId, skillId));

      await tx
        .insert(t.skillContextDocs)
        .values({ workspaceId, skillId, path, order: Number(max?.next ?? 0) })
        .onConflictDoUpdate({
          target: [t.skillContextDocs.skillId, t.skillContextDocs.path],
          set: { order: Number(max?.next ?? 0) },
        });
    });
  }

  /** AC-20 — detach one path from a skill. False when there was no such row. */
  async detachSkillDoc(workspaceId: string, skillId: string, path: string): Promise<boolean> {
    const rows = await this.db
      .delete(t.skillContextDocs)
      .where(
        and(
          eq(t.skillContextDocs.workspaceId, workspaceId),
          eq(t.skillContextDocs.skillId, skillId),
          eq(t.skillContextDocs.path, path),
        ),
      )
      .returning({ path: t.skillContextDocs.path });
    return rows.length > 0;
  }

  /**
   * AC-21 — every attachment of a SET of skills, grouped by skill id, each
   * group in its own `order`. ONE query for all of an agent's skills: the
   * resolver runs on the critical path of every LLM call (NFR-1), so a
   * per-skill query would be an N+1 exactly where it costs most.
   *
   * A skill with no attachments is simply absent from the map.
   */
  async docsForSkills(
    workspaceId: string,
    skillIds: string[],
  ): Promise<Map<string, ContextDocLinkRow[]>> {
    const out = new Map<string, ContextDocLinkRow[]>();
    if (skillIds.length === 0) return out;

    const rows = await this.db
      .select({
        skillId: t.skillContextDocs.skillId,
        path: t.skillContextDocs.path,
        order: t.skillContextDocs.order,
      })
      .from(t.skillContextDocs)
      .where(
        and(
          eq(t.skillContextDocs.workspaceId, workspaceId),
          inArray(t.skillContextDocs.skillId, skillIds),
        ),
      )
      .orderBy(asc(t.skillContextDocs.order), asc(t.skillContextDocs.path));

    for (const r of rows) {
      const list = out.get(r.skillId) ?? [];
      list.push({ path: r.path, order: r.order });
      out.set(r.skillId, list);
    }
    return out;
  }
}
