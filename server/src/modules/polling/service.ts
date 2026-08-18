import type { Container } from '../../platform/container.js';
import { NotFoundError } from '../../platform/errors.js';
import { PollingRepository } from './repository.js';

/**
 * F1 — polling service (extracted from routes.ts; no behaviour change).
 *
 * MANUAL refresh that ONLY syncs the PR list (new/updated PRs appear, head_sha
 * updates). It does NOT trigger any review — review is manual, owned by A2.
 *
 * Unlike the pulls list read, this path is NOT local-first: the user explicitly
 * asked to sync, so a missing token or a GitHub outage must surface as an error
 * rather than silently report zero synced PRs.
 */

export interface PollResult {
  synced: number;
  reviewTriggered: false;
}

export class PollingService {
  private repo: PollingRepository;

  constructor(private container: Container) {
    this.repo = new PollingRepository(container.db);
  }

  async poll(workspaceId: string, repoId: string): Promise<PollResult> {
    const repo = await this.repo.findRepo(workspaceId, repoId);
    if (!repo) throw new NotFoundError('Repo not found');

    const gh = await this.container.github();
    const pulls = await gh.listPullRequests({ owner: repo.owner, name: repo.name });

    let synced = 0;
    for (const pr of pulls) {
      await this.container.pullsRepo.upsertPull({
        workspaceId,
        repoId: repo.id,
        number: pr.number,
        title: pr.title,
        author: pr.author,
        branch: pr.branch,
        base: pr.base,
        headSha: pr.head_sha,
        additions: pr.additions,
        deletions: pr.deletions,
        filesCount: pr.files_count,
        status: pr.status,
        // The poll payload carries no opened_at; on insert the column stays
        // null and the next full list read fills it in.
        openedAt: null,
        updatedAt: pr.updated_at ? new Date(pr.updated_at) : null,
      });
      synced++;
    }

    await this.repo.touchLastPolledAt(repo.id, new Date());

    // NOTE: no review is triggered here — manual trigger only.
    return { synced, reviewTriggered: false };
  }
}
