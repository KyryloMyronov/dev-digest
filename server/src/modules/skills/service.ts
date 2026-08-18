import type { Container } from '../../platform/container.js';
import type { Skill, SkillSource, SkillType, SkillVersion } from '@devdigest/shared';
import { SkillsRepository } from './repository.js';
import { toSkillDto, toSkillVersionDto } from './helpers.js';
import { DEFAULT_SKILL_SOURCE, DEFAULT_SKILL_TYPE } from './constants.js';

/**
 * Skills service. A skill is reusable review guidance — a name, a directive
 * description (its interface: what it is FOR, so an author can tell at a glance
 * whether it applies) and a markdown body that is appended to the prompt of
 * every agent that links it.
 *
 * A skill is TEXT ONLY. Nothing here executes, fetches or interprets the body;
 * the review pipeline concatenates it into a prompt block and that is the whole
 * contract. Imports are parsed in the browser and arrive as an ordinary create,
 * so no archive ever reaches this process.
 */

export interface CreateSkillInput {
  name: string;
  description: string;
  type?: SkillType;
  source?: SkillSource;
  body: string;
  enabled?: boolean;
  /** Files the body was derived from — set by the conventions extractor. */
  evidenceFiles?: string[] | null;
}

export interface UpdateSkillInput {
  name?: string;
  description?: string;
  type?: SkillType;
  body?: string;
  enabled?: boolean;
}

export class SkillsService {
  private repo: SkillsRepository;

  constructor(container: Container) {
    this.repo = new SkillsRepository(container.db);
  }

  async list(workspaceId: string): Promise<Skill[]> {
    const rows = await this.repo.list(workspaceId);
    return rows.map(toSkillDto);
  }

  async get(workspaceId: string, id: string): Promise<Skill | undefined> {
    const row = await this.repo.getById(workspaceId, id);
    return row ? toSkillDto(row) : undefined;
  }

  async create(workspaceId: string, input: CreateSkillInput): Promise<Skill> {
    const row = await this.repo.insert({
      workspaceId,
      name: input.name,
      description: input.description,
      type: input.type ?? DEFAULT_SKILL_TYPE,
      // The source is what the UI badges an imported skill with, and the only
      // record that this text came from outside. Default to 'manual' so a
      // caller can never accidentally launder an import into a local skill.
      source: input.source ?? DEFAULT_SKILL_SOURCE,
      body: input.body,
      ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
      ...(input.evidenceFiles !== undefined ? { evidenceFiles: input.evidenceFiles } : {}),
    });
    return toSkillDto(row);
  }

  async update(
    workspaceId: string,
    id: string,
    patch: UpdateSkillInput,
  ): Promise<Skill | undefined> {
    const row = await this.repo.update(workspaceId, id, patch);
    return row ? toSkillDto(row) : undefined;
  }

  async delete(workspaceId: string, id: string): Promise<boolean> {
    return this.repo.deleteById(workspaceId, id);
  }

  /**
   * Body history, newest first. Workspace-scoped through the parent: an unknown
   * or foreign skill returns undefined so the route can 404 instead of leaking
   * whether the id exists in another tenant.
   */
  async listVersions(workspaceId: string, id: string): Promise<SkillVersion[] | undefined> {
    const skill = await this.repo.getById(workspaceId, id);
    if (!skill) return undefined;
    const rows = await this.repo.listVersions(id);
    return rows.map(toSkillVersionDto);
  }

  /** Agents that would lose this skill if it were deleted. */
  async linkedAgentNames(workspaceId: string, id: string): Promise<string[] | undefined> {
    const skill = await this.repo.getById(workspaceId, id);
    if (!skill) return undefined;
    return this.repo.linkedAgentNames(workspaceId, id);
  }
}
