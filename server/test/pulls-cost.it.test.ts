/**
 * COST on the PR list — GET /repos/:id/pulls returns the LATEST SETTLED run's
 * cost per PR.
 *
 * The two things worth pinning down: a newer failed run must not blank out the
 * column (cost would flicker to "—" every time a run errored), and "latest
 * review" is deliberately not reused as the lookup — a failed run produces no
 * review at all, so the two orderings can disagree.
 *
 * No GitHub token is configured under NODE_ENV=test, so the route's sync step
 * is skipped and it serves persisted rows — which is exactly what we assert on.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startPg, dockerAvailable, type PgFixture } from './helpers/pg.js';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/platform/config.js';
import { seed } from '../src/db/seed.js';
import * as t from '../src/db/schema.js';
import type { PrMeta } from '@devdigest/shared';

const hasDocker = await dockerAvailable();
const d = hasDocker ? describe : describe.skip;

const config = () => loadConfig({ ...process.env, NODE_ENV: 'test' } as NodeJS.ProcessEnv);

const AT = (iso: string) => new Date(iso);

d('PR list cost column (Testcontainers pg)', () => {
  let pg: PgFixture;
  let workspaceId: string;
  let repoId: string;

  /** A PR in the shared repo, plus whatever runs the case needs. */
  let prSeq = 0;
  async function makePr(
    runs: { status: string; costUsd: number | null; ranAt: Date }[],
  ): Promise<string> {
    const number = ++prSeq;
    const [pr] = await pg.handle.db
      .insert(t.pullRequests)
      .values({
        workspaceId,
        repoId,
        number,
        title: `PR ${number}`,
        author: 'marisa.koch',
        branch: `feat/${number}`,
        base: 'main',
        headSha: `sha${number}`,
        additions: 1,
        deletions: 0,
        filesCount: 1,
        status: 'open',
      })
      .returning();
    for (const r of runs) {
      await pg.handle.db.insert(t.agentRuns).values({
        workspaceId,
        prId: pr!.id,
        status: r.status,
        costUsd: r.costUsd,
        ranAt: r.ranAt,
      });
    }
    return pr!.id;
  }

  async function listPulls(): Promise<PrMeta[]> {
    const app = await buildApp({ config: config(), db: pg.handle.db });
    const res = await app.inject({ method: 'GET', url: `/repos/${repoId}/pulls` });
    expect(res.statusCode).toBe(200);
    return res.json() as PrMeta[];
  }

  async function costOf(prId: string): Promise<number | null | undefined> {
    const body = await listPulls();
    return body.find((p) => p.id === prId)?.cost_usd;
  }

  beforeAll(async () => {
    pg = await startPg();
    await seed(pg.handle.db);
    const [ws] = await pg.handle.db.select().from(t.workspaces);
    workspaceId = ws!.id;
    const [repo] = await pg.handle.db
      .insert(t.repos)
      .values({ workspaceId, owner: 'acme', name: 'costed', fullName: 'acme/costed' })
      .returning();
    repoId = repo!.id;
  });
  afterAll(async () => {
    await pg?.stop();
  });

  it('returns the newest done run’s cost, not the oldest', async () => {
    const prId = await makePr([
      { status: 'done', costUsd: 0.05, ranAt: AT('2026-06-01T10:00:00Z') },
      { status: 'done', costUsd: 0.42, ranAt: AT('2026-06-02T10:00:00Z') },
    ]);
    expect(await costOf(prId)).toBeCloseTo(0.42);
  });

  it('ignores a newer FAILED run instead of blanking the column', async () => {
    const prId = await makePr([
      { status: 'done', costUsd: 0.31, ranAt: AT('2026-06-01T10:00:00Z') },
      { status: 'failed', costUsd: null, ranAt: AT('2026-06-03T10:00:00Z') },
    ]);
    expect(await costOf(prId)).toBeCloseTo(0.31);
  });

  it('ignores a run still in flight', async () => {
    const prId = await makePr([
      { status: 'done', costUsd: 0.12, ranAt: AT('2026-06-01T10:00:00Z') },
      { status: 'running', costUsd: null, ranAt: AT('2026-06-04T10:00:00Z') },
    ]);
    expect(await costOf(prId)).toBeCloseTo(0.12);
  });

  it('is null for a PR that has never been run', async () => {
    const prId = await makePr([]);
    expect(await costOf(prId)).toBeNull();
  });

  it('is null when the latest done run’s model was not priced', async () => {
    const prId = await makePr([
      { status: 'done', costUsd: 0.5, ranAt: AT('2026-06-01T10:00:00Z') },
      { status: 'done', costUsd: null, ranAt: AT('2026-06-05T10:00:00Z') },
    ]);
    expect(await costOf(prId)).toBeNull();
  });

  it('keeps a genuinely free model as 0, not null', async () => {
    const prId = await makePr([{ status: 'done', costUsd: 0, ranAt: AT('2026-06-01T10:00:00Z') }]);
    expect(await costOf(prId)).toBe(0);
  });
});