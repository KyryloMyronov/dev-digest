import type { Container } from '../../platform/container.js';
import type {
  Agent,
  AgentSkillDetail,
  AgentVersion,
  CiFailOn,
  ModelInfo,
  Provider,
  ReviewStrategy,
} from '@devdigest/shared';
import { AgentsRepository, type SkillLinkInput } from './repository.js';
// The eval module's PUBLIC surface — `types.ts` is one of the two files
// `no-cross-module-internals` allows across a module boundary.
import type { EvalTriggerField } from '../eval/types.js';
import { changedTriggerFields, toAgentDto, toAgentVersionDto } from './helpers.js';
// `skills` is another module's table; the row → DTO mapper is shared through
// `_shared/` because `agents` legitimately reads a skill row to inline it.
import { toSkillDto } from '../_shared/skills.js';

/**
 * A2 — agents service. Business logic for the Agents tab + Agent Editor.
 * Provider/model selection uses the LLM adapter's dynamic model list.
 *
 * An Agent = provider + model + system_prompt + linked skills + output_schema +
 * enabled. Config changes are versioned via `agent_versions` (repository).
 */

// Re-exported for backwards compatibility; implementation lives in ./helpers.
export { toAgentDto } from './helpers.js';

export interface CreateAgentInput {
  name: string;
  description?: string;
  provider: Provider;
  model: string;
  system_prompt: string;
  output_schema?: unknown;
  strategy?: ReviewStrategy;
  ci_fail_on?: CiFailOn;
  repo_intel?: boolean;
  auto_eval?: boolean;
  enabled?: boolean;
}

export interface UpdateAgentInput {
  name?: string;
  description?: string;
  provider?: Provider;
  model?: string;
  system_prompt?: string;
  output_schema?: unknown;
  strategy?: ReviewStrategy;
  ci_fail_on?: CiFailOn;
  repo_intel?: boolean;
  auto_eval?: boolean;
  enabled?: boolean;
}

export class AgentsService {
  private repo: AgentsRepository;

  constructor(private container: Container) {
    this.repo = new AgentsRepository(container.db);
  }

  async list(workspaceId: string): Promise<Agent[]> {
    const rows = await this.repo.list(workspaceId);
    return rows.map(toAgentDto);
  }

  async get(workspaceId: string, id: string): Promise<Agent | undefined> {
    const row = await this.repo.getById(workspaceId, id);
    return row ? toAgentDto(row) : undefined;
  }

  /** Delete an agent (and its versions/skill-links, via cascade). */
  async delete(workspaceId: string, id: string): Promise<boolean> {
    return this.repo.deleteById(workspaceId, id);
  }

  async create(workspaceId: string, input: CreateAgentInput, userId?: string): Promise<Agent> {
    const row = await this.repo.insert({
      workspaceId,
      name: input.name,
      description: input.description,
      provider: input.provider,
      model: input.model,
      systemPrompt: input.system_prompt,
      outputSchema: input.output_schema,
      ...(input.strategy !== undefined ? { strategy: input.strategy } : {}),
      ...(input.ci_fail_on !== undefined ? { ciFailOn: input.ci_fail_on } : {}),
      ...(input.repo_intel !== undefined ? { repoIntel: input.repo_intel } : {}),
      ...(input.auto_eval !== undefined ? { autoEval: input.auto_eval } : {}),
      enabled: input.enabled,
      createdBy: userId ?? null,
    });
    return toAgentDto(row);
  }

  async update(
    workspaceId: string,
    id: string,
    patch: UpdateAgentInput,
  ): Promise<Agent | undefined> {
    // Read BEFORE the write: AC-85's allow-list is a comparison, and after the
    // update the old values are gone.
    const before = await this.repo.getById(workspaceId, id);
    const row = await this.repo.update(workspaceId, id, {
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.description !== undefined ? { description: patch.description } : {}),
      ...(patch.provider !== undefined ? { provider: patch.provider } : {}),
      ...(patch.model !== undefined ? { model: patch.model } : {}),
      ...(patch.system_prompt !== undefined ? { systemPrompt: patch.system_prompt } : {}),
      ...(patch.output_schema !== undefined ? { outputSchema: patch.output_schema } : {}),
      ...(patch.strategy !== undefined ? { strategy: patch.strategy } : {}),
      ...(patch.ci_fail_on !== undefined ? { ciFailOn: patch.ci_fail_on } : {}),
      ...(patch.repo_intel !== undefined ? { repoIntel: patch.repo_intel } : {}),
      // A missing `auto_eval` must NOT clear an existing one — the same
      // `!== undefined` rule every other field here follows.
      ...(patch.auto_eval !== undefined ? { autoEval: patch.auto_eval } : {}),
      ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
    });
    if (row && before && row.version > before.version) {
      await this.notifyVersionBump(
        workspaceId,
        id,
        row.version,
        changedTriggerFields(before, {
          ...(patch.provider !== undefined ? { provider: patch.provider } : {}),
          ...(patch.model !== undefined ? { model: patch.model } : {}),
          ...(patch.system_prompt !== undefined ? { systemPrompt: patch.system_prompt } : {}),
          ...(patch.strategy !== undefined ? { strategy: patch.strategy } : {}),
          ...(patch.output_schema !== undefined ? { outputSchema: patch.output_schema } : {}),
        }),
      );
    }
    return row ? toAgentDto(row) : undefined;
  }

  /**
   * Config history for an agent, newest version first. Workspace-scoped: returns
   * undefined when the agent isn't in this workspace (the route maps that to 404)
   * so version snapshots can't be read across tenants.
   */
  async listVersions(workspaceId: string, agentId: string): Promise<AgentVersion[] | undefined> {
    const agent = await this.repo.getById(workspaceId, agentId);
    if (!agent) return undefined;
    const rows = await this.repo.listVersions(agentId);
    return rows.map(toAgentVersionDto);
  }

  /**
   * A single config snapshot for an agent. Returns undefined when the agent isn't
   * in this workspace OR that version was never recorded (route → 404).
   */
  async getVersion(
    workspaceId: string,
    agentId: string,
    version: number,
  ): Promise<AgentVersion | undefined> {
    const agent = await this.repo.getById(workspaceId, agentId);
    if (!agent) return undefined;
    const row = await this.repo.getVersion(agentId, version);
    return row ? toAgentVersionDto(row) : undefined;
  }

  /**
   * The agent's linked skills, ordered, each with its skill inlined.
   *
   * `AgentSkillDetail` rather than the bare `AgentSkillLink`: the Skills tab
   * renders a whole agent's list in one response, so inlining saves an N+1 over
   * `/skills/:id`. Every link mutation below returns this same full list, so the
   * client seeds its cache from the response instead of refetching.
   */
  async skillLinks(agentId: string): Promise<AgentSkillDetail[]> {
    const links = await this.repo.linkedSkills(agentId);
    return links.map((l) => ({
      agent_id: agentId,
      skill_id: l.skill.id,
      order: l.order,
      enabled: l.enabled,
      skill: toSkillDto(l.skill),
    }));
  }

  /**
   * Replace the agent's whole ordered link set. `links` carries each entry's
   * per-agent `enabled`, so a reorder and a toggle are one save — and a reorder
   * cannot silently re-enable a muted link by falling back to the default.
   */
  async setSkills(
    workspaceId: string,
    agentId: string,
    links: SkillLinkInput[],
  ): Promise<AgentSkillDetail[] | undefined> {
    const agent = await this.repo.getById(workspaceId, agentId);
    if (!agent) return undefined;
    await this.repo.setSkills(agentId, links);
    await this.afterSkillChange(workspaceId, agentId); // AC-83, AC-84
    return this.skillLinks(agentId);
  }

  /** Link a single skill (append or set order) — additive to existing links. */
  async linkSkill(
    workspaceId: string,
    agentId: string,
    skillId: string,
    order?: number,
  ): Promise<AgentSkillDetail[] | undefined> {
    const agent = await this.repo.getById(workspaceId, agentId);
    if (!agent) return undefined;
    const existing = await this.repo.linkedSkills(agentId);
    const resolvedOrder = order ?? existing.length;
    await this.repo.linkSkill(agentId, skillId, resolvedOrder);
    await this.afterSkillChange(workspaceId, agentId); // AC-80, AC-84
    return this.skillLinks(agentId);
  }

  /**
   * Flip one link's per-agent switch. The link keeps its slot in the
   * concatenation, which is the point: switching a skill off and back on changes
   * nothing about the prompt except the presence of that one block.
   *
   * Returns `undefined` for an unknown/foreign agent AND for a skill this agent
   * has not linked — both are a 404 to the caller.
   */
  async setSkillEnabled(
    workspaceId: string,
    agentId: string,
    skillId: string,
    enabled: boolean,
  ): Promise<AgentSkillDetail[] | undefined> {
    const agent = await this.repo.getById(workspaceId, agentId);
    if (!agent) return undefined;
    const updated = await this.repo.setLinkEnabled(agentId, skillId, enabled);
    if (!updated) return undefined;
    await this.afterSkillChange(workspaceId, agentId); // AC-82, AC-84
    return this.skillLinks(agentId);
  }

  /** Detach one skill from this agent. The skill itself is untouched. */
  async unlinkSkill(
    workspaceId: string,
    agentId: string,
    skillId: string,
  ): Promise<AgentSkillDetail[] | undefined> {
    const agent = await this.repo.getById(workspaceId, agentId);
    if (!agent) return undefined;
    await this.repo.unlinkSkill(agentId, skillId);
    await this.afterSkillChange(workspaceId, agentId); // AC-81, AC-84
    return this.skillLinks(agentId);
  }

  /**
   * AC-80-AC-84 — the one place a skill-link change becomes a version bump.
   *
   * Called AFTER the link mutation, so the snapshot records the NEW link set.
   */
  private async afterSkillChange(workspaceId: string, agentId: string): Promise<void> {
    const row = await this.repo.bumpVersionForSkillChange(workspaceId, agentId);
    if (row) await this.notifyVersionBump(workspaceId, agentId, row.version, ['skills']);
  }

  /**
   * AC-85 / AC-91 — tell the eval module a version moved, and never let that
   * stop the bump.
   *
   * `container.evalTrigger` is a facade that degrades rather than throwing (it
   * swallows a missing job handler itself), and this second guard is the
   * belt-and-braces: the caller of `PUT /agents/:id` is entitled to its 200
   * whatever the eval module is doing.
   */
  private async notifyVersionBump(
    workspaceId: string,
    agentId: string,
    version: number,
    changed: EvalTriggerField[],
  ): Promise<void> {
    if (changed.length === 0) return;
    try {
      await this.container.evalTrigger.onAgentVersionBumped(
        workspaceId,
        agentId,
        version,
        changed,
      );
    } catch {
      /* the bump stands; auto-eval is best-effort by design (AC-91) */
    }
  }

  /**
   * AC-102-AC-105 — restore an older config as a NEW version.
   *
   * Returns undefined for an unknown/foreign agent AND for a version that was
   * never snapshotted (`snapshotVersion` is `onConflictDoNothing`, so a version
   * legitimately may have none) — both are a 404 to the caller.
   *
   * AC-105: this path deliberately does NOT notify the eval trigger. A restore
   * bumps the version, and billing a whole batch for a rollback is exactly what
   * spec D-21 exists to prevent.
   */
  async restoreVersion(
    workspaceId: string,
    agentId: string,
    version: number,
  ): Promise<Agent | undefined> {
    const row = await this.repo.restoreVersion(workspaceId, agentId, version);
    return row ? toAgentDto(row) : undefined;
  }

  /**
   * Dynamic model list from the provider adapter's /models. Degrades gracefully
   * to [] if the provider key is not configured (the editor still renders).
   */
  async listModels(provider: Provider): Promise<ModelInfo[]> {
    try {
      const llm = await this.container.llm(provider);
      return await llm.listModels();
    } catch {
      return [];
    }
  }
}
