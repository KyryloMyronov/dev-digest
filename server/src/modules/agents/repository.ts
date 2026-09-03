import { and, asc, desc, eq } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import * as t from '../../db/schema.js';
import type { CiFailOn, Provider, ReviewStrategy } from '@devdigest/shared';
import { DEFAULT_AGENT_DESCRIPTION, INITIAL_AGENT_VERSION } from './constants.js';
import { isConfigChange } from './helpers.js';

/**
 * A2 — agents data-access. Owns `agents`, `agent_versions`, and the
 * `agent_skills` link table (shared with A1's skills repository, but A2 owns the
 * agent side: link/reorder/list for an agent). Workspace-scoped throughout.
 */

import type { AgentRow, AgentVersionRow } from '../../db/rows.js';
export type { AgentRow, AgentVersionRow };

export interface InsertAgent {
  workspaceId: string;
  name: string;
  description?: string;
  provider: Provider;
  model: string;
  systemPrompt: string;
  outputSchema?: unknown;
  strategy?: ReviewStrategy;
  ciFailOn?: CiFailOn;
  repoIntel?: boolean;
  autoEval?: boolean;
  enabled?: boolean;
  createdBy?: string | null;
}

export interface UpdateAgent {
  name?: string;
  description?: string;
  provider?: Provider;
  model?: string;
  systemPrompt?: string;
  outputSchema?: unknown;
  strategy?: ReviewStrategy;
  ciFailOn?: CiFailOn;
  repoIntel?: boolean;
  autoEval?: boolean;
  enabled?: boolean;
}

/** A skill linked to an agent (with its order), joined from agent_skills. */
export interface LinkedSkillRow {
  skill: typeof t.skills.$inferSelect;
  order: number;
  /**
   * The PER-AGENT switch (`agent_skills.enabled`) — NOT `skills.enabled`. A block
   * reaches the prompt only when both are true; see `buildSkillBlocks` in
   * `modules/reviews/run-executor.ts`.
   */
  enabled: boolean;
}

/** One entry of a full link-set replacement: the skill, and its per-agent switch. */
export interface SkillLinkInput {
  skillId: string;
  /** Defaults to true — attaching a skill means using it. */
  enabled?: boolean;
}

export class AgentsRepository {
  constructor(private db: Db) {}

  async list(workspaceId: string): Promise<AgentRow[]> {
    return this.db.select().from(t.agents).where(eq(t.agents.workspaceId, workspaceId));
  }

  async listEnabled(workspaceId: string): Promise<AgentRow[]> {
    return this.db
      .select()
      .from(t.agents)
      .where(and(eq(t.agents.workspaceId, workspaceId), eq(t.agents.enabled, true)));
  }

  async getById(workspaceId: string, id: string): Promise<AgentRow | undefined> {
    const [row] = await this.db
      .select()
      .from(t.agents)
      .where(and(eq(t.agents.workspaceId, workspaceId), eq(t.agents.id, id)));
    return row;
  }

  /** Delete an agent (scoped to workspace). Versions/skill-links cascade;
   *  agent_runs keep their history with agent_id set null. Returns false if
   *  no such agent existed in the workspace. */
  async deleteById(workspaceId: string, id: string): Promise<boolean> {
    const rows = await this.db
      .delete(t.agents)
      .where(and(eq(t.agents.workspaceId, workspaceId), eq(t.agents.id, id)))
      .returning({ id: t.agents.id });
    return rows.length > 0;
  }

  /** Insert an agent AND record version 1 in agent_versions (immutable snapshot). */
  async insert(values: InsertAgent): Promise<AgentRow> {
    const [row] = await this.db
      .insert(t.agents)
      .values({
        workspaceId: values.workspaceId,
        name: values.name,
        description: values.description ?? DEFAULT_AGENT_DESCRIPTION,
        provider: values.provider,
        model: values.model,
        systemPrompt: values.systemPrompt,
        outputSchema: (values.outputSchema as object | undefined) ?? null,
        ...(values.strategy !== undefined ? { strategy: values.strategy } : {}),
        ...(values.ciFailOn !== undefined ? { ciFailOn: values.ciFailOn } : {}),
        ...(values.repoIntel !== undefined ? { repoIntel: values.repoIntel } : {}),
        ...(values.autoEval !== undefined ? { autoEval: values.autoEval } : {}),
        enabled: values.enabled ?? true,
        version: INITIAL_AGENT_VERSION,
        createdBy: values.createdBy ?? null,
      })
      .returning();
    await this.snapshotVersion(row!, INITIAL_AGENT_VERSION);
    return row!;
  }

  /**
   * Update an agent. Any config change bumps the version and snapshots the new
   * config into agent_versions (reproducibility for eval).
   */
  async update(
    workspaceId: string,
    id: string,
    patch: UpdateAgent,
  ): Promise<AgentRow | undefined> {
    const existing = await this.getById(workspaceId, id);
    if (!existing) return undefined;

    // A config-affecting change (anything except just toggling enabled) bumps version.
    const configChanged = isConfigChange(existing, patch);
    const nextVersion = configChanged ? existing.version + 1 : existing.version;

    const [row] = await this.db
      .update(t.agents)
      .set({
        ...(patch.name !== undefined ? { name: patch.name } : {}),
        ...(patch.description !== undefined ? { description: patch.description } : {}),
        ...(patch.provider !== undefined ? { provider: patch.provider } : {}),
        ...(patch.model !== undefined ? { model: patch.model } : {}),
        ...(patch.systemPrompt !== undefined ? { systemPrompt: patch.systemPrompt } : {}),
        ...(patch.outputSchema !== undefined
          ? { outputSchema: patch.outputSchema as object }
          : {}),
        ...(patch.strategy !== undefined ? { strategy: patch.strategy } : {}),
        ...(patch.ciFailOn !== undefined ? { ciFailOn: patch.ciFailOn } : {}),
        ...(patch.repoIntel !== undefined ? { repoIntel: patch.repoIntel } : {}),
        // `auto_eval` is an OPERATIONAL switch, not review config, so it is set
        // here but deliberately absent from `isConfigChange`: putting it in the
        // bump rule would make turning auto-eval ON immediately enqueue one.
        ...(patch.autoEval !== undefined ? { autoEval: patch.autoEval } : {}),
        ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
        ...(configChanged ? { version: nextVersion } : {}),
      })
      .where(and(eq(t.agents.workspaceId, workspaceId), eq(t.agents.id, id)))
      .returning();

    if (configChanged && row) await this.snapshotVersion(row, nextVersion);
    return row;
  }

  private async snapshotVersion(
    row: AgentRow,
    version: number,
    extra: { restored_from?: number } = {},
  ): Promise<void> {
    const skills = await this.skillIdsForAgent(row.id);
    await this.db
      .insert(t.agentVersions)
      .values({
        agentId: row.id,
        version,
        configJson: {
          provider: row.provider,
          model: row.model,
          system_prompt: row.systemPrompt,
          output_schema: row.outputSchema,
          strategy: row.strategy,
          ci_fail_on: row.ciFailOn,
          repo_intel: row.repoIntel,
          skills,
          ...extra,
        },
      })
      // Left as-is DELIBERATELY: a version may legitimately have no snapshot,
      // and spec D-9 / AC-99 depend on that being possible. A bumped version is
      // new, so this always inserts on the paths below.
      .onConflictDoNothing();
  }

  /**
   * AC-80-AC-84 — a skill-link change is a CONFIG change.
   *
   * A separate method rather than a flag threaded through `update`: `update` is
   * the server's most-exercised write path (`agents-versions.it.test.ts`,
   * `skills.it.test.ts`, `skills-prompt.it.test.ts` all drive it), and its
   * semantics stay byte-identical here.
   *
   * Call it AFTER the link mutation has landed, so `snapshotVersion` reads the
   * NEW link set — the snapshot's whole purpose is to record what the agent
   * looked like at that version, and `config_json.skills` is the half that just
   * changed.
   */
  async bumpVersionForSkillChange(
    workspaceId: string,
    agentId: string,
  ): Promise<AgentRow | undefined> {
    const existing = await this.getById(workspaceId, agentId);
    if (!existing) return undefined;
    const nextVersion = existing.version + 1;
    const [row] = await this.db
      .update(t.agents)
      .set({ version: nextVersion })
      .where(and(eq(t.agents.workspaceId, workspaceId), eq(t.agents.id, agentId)))
      .returning();
    if (row) await this.snapshotVersion(row, nextVersion);
    return row;
  }

  /**
   * AC-103 / AC-104 — write the restored config forward as a NEW version.
   *
   * Never a rewrite of history: `agent_versions` is immutable, and a restore
   * that edited an old row would destroy the evidence the compare screen exists
   * to show. The new snapshot carries `restored_from`, which is the only record
   * that this version was a rollback rather than an edit.
   */
  async restoreVersion(
    workspaceId: string,
    agentId: string,
    version: number,
  ): Promise<AgentRow | undefined> {
    const existing = await this.getById(workspaceId, agentId);
    if (!existing) return undefined;
    const snapshot = await this.getVersion(agentId, version);
    if (!snapshot) return undefined;
    // The snapshot is untyped jsonb by design (an older snapshot may carry a
    // drifted shape), so the enum-typed columns are read through the contract's
    // own unions rather than as bare strings.
    const cfg = snapshot.configJson as {
      provider?: Provider;
      model?: string;
      system_prompt?: string;
      output_schema?: unknown;
      strategy?: ReviewStrategy;
      ci_fail_on?: CiFailOn;
      repo_intel?: boolean;
    };

    const nextVersion = existing.version + 1;
    const [row] = await this.db
      .update(t.agents)
      .set({
        ...(cfg.provider !== undefined ? { provider: cfg.provider } : {}),
        ...(cfg.model !== undefined ? { model: cfg.model } : {}),
        ...(cfg.system_prompt !== undefined ? { systemPrompt: cfg.system_prompt } : {}),
        ...(cfg.output_schema !== undefined
          ? { outputSchema: (cfg.output_schema as object | null) ?? null }
          : {}),
        ...(cfg.strategy !== undefined ? { strategy: cfg.strategy } : {}),
        ...(cfg.ci_fail_on !== undefined ? { ciFailOn: cfg.ci_fail_on } : {}),
        ...(cfg.repo_intel !== undefined ? { repoIntel: cfg.repo_intel } : {}),
        version: nextVersion,
      })
      .where(and(eq(t.agents.workspaceId, workspaceId), eq(t.agents.id, agentId)))
      .returning();
    if (row) await this.snapshotVersion(row, nextVersion, { restored_from: version });
    return row;
  }

  // ---- agent_versions (immutable config snapshots) ------------------------

  /** All config snapshots for an agent, newest version first. */
  async listVersions(agentId: string): Promise<AgentVersionRow[]> {
    return this.db
      .select()
      .from(t.agentVersions)
      .where(eq(t.agentVersions.agentId, agentId))
      .orderBy(desc(t.agentVersions.version));
  }

  /** A single config snapshot, or undefined if that version was never recorded. */
  async getVersion(agentId: string, version: number): Promise<AgentVersionRow | undefined> {
    const [row] = await this.db
      .select()
      .from(t.agentVersions)
      .where(and(eq(t.agentVersions.agentId, agentId), eq(t.agentVersions.version, version)));
    return row;
  }

  // ---- agent_skills link table (A2 owns the agent side) -------------------

  /** Skills linked to an agent, in `order` ascending — the prompt's block order. */
  async linkedSkills(agentId: string): Promise<LinkedSkillRow[]> {
    const rows = await this.db
      .select({
        skill: t.skills,
        order: t.agentSkills.order,
        enabled: t.agentSkills.enabled,
      })
      .from(t.agentSkills)
      .innerJoin(t.skills, eq(t.agentSkills.skillId, t.skills.id))
      .where(eq(t.agentSkills.agentId, agentId))
      .orderBy(asc(t.agentSkills.order));
    return rows.map((r) => ({ skill: r.skill, order: r.order, enabled: r.enabled }));
  }

  async skillIdsForAgent(agentId: string): Promise<string[]> {
    const links = await this.linkedSkills(agentId);
    return links.map((l) => l.skill.id);
  }

  /**
   * Link a skill to an agent at a given order (idempotent: upserts order).
   *
   * The conflict path sets `order` and deliberately NOT `enabled`: re-linking an
   * already-attached skill must not silently re-enable a link the user muted.
   */
  async linkSkill(agentId: string, skillId: string, order: number): Promise<void> {
    await this.db
      .insert(t.agentSkills)
      .values({ agentId, skillId, order })
      .onConflictDoUpdate({
        target: [t.agentSkills.agentId, t.agentSkills.skillId],
        set: { order },
      });
  }

  /**
   * Flip ONE link's per-agent switch, leaving every `order` untouched — this is
   * what makes the with/without comparison one click and one click back.
   * Returns false when the agent has no such link, so the route can 404.
   */
  async setLinkEnabled(agentId: string, skillId: string, enabled: boolean): Promise<boolean> {
    const rows = await this.db
      .update(t.agentSkills)
      .set({ enabled })
      .where(and(eq(t.agentSkills.agentId, agentId), eq(t.agentSkills.skillId, skillId)))
      .returning({ skillId: t.agentSkills.skillId });
    return rows.length > 0;
  }

  async unlinkSkill(agentId: string, skillId: string): Promise<void> {
    await this.db
      .delete(t.agentSkills)
      .where(and(eq(t.agentSkills.agentId, agentId), eq(t.agentSkills.skillId, skillId)));
  }

  /**
   * Replace the full set of linked skills for an agent, assigning order = index
   * and carrying each link's `enabled` through. Used by the "Skills" editor tab
   * (attach / reorder / detach-by-omission); skills absent from `links` are
   * unlinked.
   *
   * Delete-then-insert runs in ONE transaction on purpose. The intermediate state
   * is an agent with no skills at all, so a review that started between the two
   * statements would assemble a prompt with the skills block missing entirely —
   * a silently wrong run rather than a failed one.
   */
  async setSkills(agentId: string, links: SkillLinkInput[]): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.delete(t.agentSkills).where(eq(t.agentSkills.agentId, agentId));
      if (links.length === 0) return;
      await tx.insert(t.agentSkills).values(
        links.map((l, i) => ({
          agentId,
          skillId: l.skillId,
          order: i,
          enabled: l.enabled ?? true,
        })),
      );
    });
  }
}
