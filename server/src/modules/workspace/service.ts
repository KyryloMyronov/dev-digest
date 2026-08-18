import type { Container } from '../../platform/container.js';
import { WorkspaceRepository, type RepoRow } from './repository.js';

/**
 * F1 — workspace service (extracted from routes.ts; no behaviour change).
 * Where clones live + a summary of cloned repos.
 *
 * Cleanup and re-pull of individual repos belong to the repos module
 * (refresh/delete); this surface is read-only overview.
 */

export interface WorkspaceRepoSummary {
  id: string;
  full_name: string;
  clone_path: string | null;
  last_polled_at: string | null;
  cloned: boolean;
}

export interface WorkspaceOverview {
  workspaceId: string;
  cloneDir: string;
  repos: WorkspaceRepoSummary[];
}

/** Pure row → wire mapper. */
export function repoRowToSummary(r: RepoRow): WorkspaceRepoSummary {
  return {
    id: r.id,
    full_name: r.fullName,
    clone_path: r.clonePath,
    last_polled_at: r.lastPolledAt?.toISOString() ?? null,
    cloned: Boolean(r.clonePath),
  };
}

export class WorkspaceService {
  private repo: WorkspaceRepository;

  constructor(private container: Container) {
    this.repo = new WorkspaceRepository(container.db);
  }

  async getOverview(workspaceId: string): Promise<WorkspaceOverview> {
    const repos = await this.repo.listRepos(workspaceId);
    return {
      workspaceId,
      cloneDir: this.container.config.cloneDir,
      repos: repos.map(repoRowToSummary),
    };
  }
}
