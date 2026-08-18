/**
 * FINDINGS breakdown on the PR list — GET /repos/:id/pulls returns the
 * per-severity counts behind each row's findings counters.
 *
 * What's worth pinning down: the counts span EVERY review of the PR (the list
 * counter opens a modal onto the same set the detail page renders, so a
 * "latest review only" count would visibly disagree with it), a never-reviewed
 * PR is null rather than all-zero (the UI renders those differently), and one
 * PR's findings never bleed into another's row.
 *
 * No GitHub token is configured under NODE_ENV=test, so the route's sync step
 * is skipped and it serves persisted rows — which is what we assert on.
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

d('PR list findings breakdown (Testcontainers pg)', () => {
  let pg: PgFixture;
  let workspaceId: string;
  let repoId: string;

  let prSeq = 0;
  /** A PR in the shared repo, plus one review per `reviews` entry. */
  async function makePr(reviews: { severities: string[] }[]): Promise<string> {
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
    for (const rv of reviews) {
      const [review] = await pg.handle.db
        .insert(t.reviews)
        .values({ workspaceId, prId: pr!.id, kind: 'review', score: 61, model: 'seed' })
        .returning();
      for (const severity of rv.severities) {
        await pg.handle.db.insert(t.findings).values({
          reviewId: review!.id,
          file: 'src/config.ts',
          startLine: 12,
          endLine: 12,
          severity,
          category: 'security',
          title: `a ${severity} finding`,
          rationale: 'because',
          confidence: 0.9,
        });
      }
    }
    return pr!.id;
  }

  async function findingsOf(prId: string): Promise<PrMeta['findings']> {
    const app = await buildApp({ config: config(), db: pg.handle.db });
    const res = await app.inject({ method: 'GET', url: `/repos/${repoId}/pulls` });
    expect(res.statusCode).toBe(200);
    return (res.json() as PrMeta[]).find((p) => p.id === prId)?.findings;
  }

  beforeAll(async () => {
    pg = await startPg();
    await seed(pg.handle.db);
    const [ws] = await pg.handle.db.select().from(t.workspaces);
    workspaceId = ws!.id;
    const [repo] = await pg.handle.db
      .insert(t.repos)
      .values({ workspaceId, owner: 'acme', name: 'findings', fullName: 'acme/findings' })
      .returning();
    repoId = repo!.id;
  });
  afterAll(async () => {
    await pg?.stop();
  });

  it('counts findings per severity', async () => {
    const prId = await makePr([{ severities: ['CRITICAL', 'CRITICAL', 'WARNING', 'SUGGESTION'] }]);
    expect(await findingsOf(prId)).toEqual({ CRITICAL: 2, WARNING: 1, SUGGESTION: 1 });
  });

  it('sums across every review on the PR, not just the latest', async () => {
    const prId = await makePr([{ severities: ['CRITICAL'] }, { severities: ['CRITICAL', 'WARNING'] }]);
    expect(await findingsOf(prId)).toEqual({ CRITICAL: 2, WARNING: 1, SUGGESTION: 0 });
  });

  it('is null for a PR that has never been reviewed', async () => {
    const prId = await makePr([]);
    expect(await findingsOf(prId)).toBeNull();
  });

  it('is all-zero for a review that found nothing — not null', async () => {
    const prId = await makePr([{ severities: [] }]);
    expect(await findingsOf(prId)).toEqual({ CRITICAL: 0, WARNING: 0, SUGGESTION: 0 });
  });

  it('ignores a severity outside the three known buckets', async () => {
    // `findings.severity` is a plain text column, so an unknown value must be
    // dropped rather than become a phantom key on the wire payload.
    const prId = await makePr([{ severities: ['CRITICAL', 'NITPICK'] }]);
    expect(await findingsOf(prId)).toEqual({ CRITICAL: 1, WARNING: 0, SUGGESTION: 0 });
  });

  it('does not leak another PR’s findings into a row', async () => {
    const quiet = await makePr([{ severities: [] }]);
    await makePr([{ severities: ['CRITICAL', 'CRITICAL', 'CRITICAL'] }]);
    expect(await findingsOf(quiet)).toEqual({ CRITICAL: 0, WARNING: 0, SUGGESTION: 0 });
  });
});