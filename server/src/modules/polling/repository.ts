import { and, eq } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import * as t from '../../db/schema.js';

/**
 * F1 — polling data-access layer (extracted from routes.ts; no behaviour
 * change).
 *
 * Owns only the poll bookkeeping on `repos` (`last_polled_at`). The PR rows the
 * poll writes belong to the pulls module — the service reaches them through
 * `container.pullsRepo`, so `pull_requests` still has exactly one repository.
 */

export type RepoRow = typeof t.repos.$inferSelect;

export class PollingRepository {
  constructor(private db: Db) {}

  async findRepo(workspaceId: string, repoId: string): Promise<RepoRow | undefined> {
    const [row] = await this.db
      .select()
      .from(t.repos)
      .where(and(eq(t.repos.workspaceId, workspaceId), eq(t.repos.id, repoId)));
    return row;
  }

  async touchLastPolledAt(repoId: string, at: Date): Promise<void> {
    await this.db.update(t.repos).set({ lastPolledAt: at }).where(eq(t.repos.id, repoId));
  }
}
