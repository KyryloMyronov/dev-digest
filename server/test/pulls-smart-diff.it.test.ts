/**
 * L03 · Smart Diff over the wire — GET /pulls/:id/smart-diff.
 *
 * The classifier itself is covered hermetically in `smart-diff.test.ts`; what
 * only a real DB can answer is wired up correctly here: the endpoint reads the
 * PR's persisted `pr_files`, joins the findings of each agent's CURRENT review
 * (a superseded pass highlights nothing; a fan-out keeps every agent), excludes
 * dismissed ones, never leaks another PR's findings, and 404s on an unknown id.
 *
 * The route carries a Zod `response` schema, so a payload that drifts from the
 * `SmartDiff` contract fails at serialization rather than reaching the studio —
 * these assertions therefore also prove the contract.
 *
 * No GitHub token is configured under NODE_ENV=test, so nothing is refetched
 * and the persisted rows are what the endpoint serves.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startPg, dockerAvailable, type PgFixture } from './helpers/pg.js';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/platform/config.js';
import { seed } from '../src/db/seed.js';
import * as t from '../src/db/schema.js';
import type { SmartDiff, SmartDiffRole } from '@devdigest/shared';

const hasDocker = await dockerAvailable();
const d = hasDocker ? describe : describe.skip;

const config = () => loadConfig({ ...process.env, NODE_ENV: 'test' } as NodeJS.ProcessEnv);

/** A stable uuid per agent label. `reviews.agent_id` has no FK, so any uuid does. */
const agentUuid = (label: string): string =>
  `00000000-0000-4000-8000-${label.charCodeAt(0).toString().padStart(12, '0')}`;

interface FindingSpec {
  file: string;
  startLine: number;
  endLine: number;
  dismissed?: boolean;
}

/** One review of a PR, with the findings it produced. */
interface ReviewSpec {
  findings: FindingSpec[];
  /** Which agent produced it — same id twice = a re-review of that agent. */
  agentId?: string;
  /** Minutes to offset `created_at` by; higher = newer. Default 0 (a tie). */
  minutesLater?: number;
}

d('GET /pulls/:id/smart-diff (Testcontainers pg)', () => {
  let pg: PgFixture;
  let workspaceId: string;
  let repoId: string;
  let prSeq = 0;

  /** A PR with the given files and one row per entry in `reviews`. */
  async function makePr(
    files: { path: string; additions?: number; deletions?: number }[],
    reviews: ReviewSpec[] = [],
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
        filesCount: files.length,
        status: 'open',
      })
      .returning();

    for (const f of files) {
      await pg.handle.db.insert(t.prFiles).values({
        prId: pr!.id,
        path: f.path,
        additions: f.additions ?? 1,
        deletions: f.deletions ?? 0,
        patch: null,
      });
    }

    // `created_at` is stamped explicitly rather than left to `defaultNow()`:
    // several reviews written in one loop would otherwise land microseconds
    // apart, which is the tie case, not the supersede case we want to pin.
    const base = new Date('2026-08-18T12:00:00.000Z');
    for (const spec of reviews) {
      const createdAt = new Date(base.getTime() + (spec.minutesLater ?? 0) * 60_000);
      const [review] = await pg.handle.db
        .insert(t.reviews)
        .values({
          workspaceId,
          prId: pr!.id,
          kind: 'review',
          score: 61,
          model: 'seed',
          createdAt,
          ...(spec.agentId ? { agentId: agentUuid(spec.agentId) } : {}),
        })
        .returning();
      for (const f of spec.findings) {
        await pg.handle.db.insert(t.findings).values({
          reviewId: review!.id,
          file: f.file,
          startLine: f.startLine,
          endLine: f.endLine,
          severity: 'WARNING',
          category: 'bug',
          title: 'a finding',
          rationale: 'because',
          confidence: 0.9,
          ...(f.dismissed ? { dismissedAt: new Date() } : {}),
        });
      }
    }
    return pr!.id;
  }

  async function smartDiffOf(prId: string): Promise<SmartDiff> {
    const app = await buildApp({ config: config(), db: pg.handle.db });
    const res = await app.inject({ method: 'GET', url: `/pulls/${prId}/smart-diff` });
    expect(res.statusCode).toBe(200);
    return res.json() as SmartDiff;
  }

  const linesFor = (diff: SmartDiff, path: string): number[] | undefined =>
    diff.groups.flatMap((g) => g.files).find((f) => f.path === path)?.finding_lines;

  const roleOf = (diff: SmartDiff, path: string): SmartDiffRole | undefined =>
    diff.groups.find((g) => g.files.some((f) => f.path === path))?.role;

  beforeAll(async () => {
    pg = await startPg();
    await seed(pg.handle.db);
    const [ws] = await pg.handle.db.select().from(t.workspaces);
    workspaceId = ws!.id;
    const [repo] = await pg.handle.db
      .insert(t.repos)
      .values({ workspaceId, owner: 'acme', name: 'smartdiff', fullName: 'acme/smartdiff' })
      .returning();
    repoId = repo!.id;
  });
  afterAll(async () => {
    await pg?.stop();
  });

  it('groups the PR’s persisted files by role', async () => {
    const prId = await makePr([
      { path: 'server/src/modules/pulls/service.ts', additions: 40 },
      { path: 'server/package.json', additions: 2 },
      { path: 'server/pnpm-lock.yaml', additions: 900 },
    ]);
    const diff = await smartDiffOf(prId);
    expect(diff.groups.map((g) => g.role)).toEqual(['core', 'wiring', 'boilerplate']);
    expect(roleOf(diff, 'server/src/modules/pulls/service.ts')).toBe('core');
    expect(roleOf(diff, 'server/package.json')).toBe('wiring');
    expect(roleOf(diff, 'server/pnpm-lock.yaml')).toBe('boilerplate');
    expect(diff.split_suggestion.total_lines).toBe(942);
  });

  it('carries every finding of the agent’s current review', async () => {
    const prId = await makePr(
      [{ path: 'src/a.ts', additions: 60 }],
      [
        {
          agentId: 'general',
          findings: [
            { file: 'src/a.ts', startLine: 12, endLine: 13 },
            { file: 'src/a.ts', startLine: 40, endLine: 40 },
          ],
        },
      ],
    );
    expect(linesFor(await smartDiffOf(prId), 'src/a.ts')).toEqual([12, 13, 40]);
  });

  it('ignores an agent’s superseded review — only the re-review highlights', async () => {
    const prId = await makePr(
      [{ path: 'src/a.ts', additions: 60 }],
      [
        { agentId: 'general', findings: [{ file: 'src/a.ts', startLine: 12, endLine: 12 }] },
        {
          agentId: 'general',
          minutesLater: 30,
          findings: [{ file: 'src/a.ts', startLine: 40, endLine: 40 }],
        },
      ],
    );
    expect(linesFor(await smartDiffOf(prId), 'src/a.ts')).toEqual([40]);
  });

  it('keeps every agent when one run fans out, and when one ran earlier', async () => {
    // `all: true` writes several reviews at once (the tie case, minutesLater 0);
    // `security` last ran half an hour before, and must still count — its pass
    // is current for that agent, and nothing has superseded it.
    const prId = await makePr(
      [{ path: 'src/a.ts', additions: 60 }],
      [
        { agentId: 'general', findings: [{ file: 'src/a.ts', startLine: 12, endLine: 12 }] },
        { agentId: 'perf', findings: [{ file: 'src/a.ts', startLine: 20, endLine: 20 }] },
        {
          agentId: 'security',
          minutesLater: -30,
          findings: [{ file: 'src/a.ts', startLine: 30, endLine: 30 }],
        },
      ],
    );
    expect(linesFor(await smartDiffOf(prId), 'src/a.ts')).toEqual([12, 20, 30]);
  });

  it('drops a dismissed finding — a waved-off line stops being highlighted', async () => {
    const prId = await makePr(
      [{ path: 'src/a.ts', additions: 60 }],
      [
        {
          agentId: 'general',
          findings: [
            { file: 'src/a.ts', startLine: 7, endLine: 7 },
            { file: 'src/a.ts', startLine: 9, endLine: 9, dismissed: true },
          ],
        },
      ],
    );
    expect(linesFor(await smartDiffOf(prId), 'src/a.ts')).toEqual([7]);
  });

  it('does not leak another PR’s findings', async () => {
    const noisy = await makePr(
      [{ path: 'src/shared.ts', additions: 10 }],
      [{ agentId: 'general', findings: [{ file: 'src/shared.ts', startLine: 3, endLine: 3 }] }],
    );
    const quiet = await makePr([{ path: 'src/shared.ts', additions: 10 }]);
    expect(linesFor(await smartDiffOf(noisy), 'src/shared.ts')).toEqual([3]);
    expect(linesFor(await smartDiffOf(quiet), 'src/shared.ts')).toEqual([]);
  });

  it('serves an empty grouping for a PR with no persisted files', async () => {
    // No GitHub token under NODE_ENV=test, so the detail fallback imports
    // nothing — the endpoint must still answer with a valid, empty payload.
    const prId = await makePr([]);
    const diff = await smartDiffOf(prId);
    expect(diff.groups).toEqual([]);
    expect(diff.split_suggestion).toEqual({
      too_big: false,
      total_lines: 0,
      proposed_splits: [],
    });
  });

  it('404s on an unknown PR id', async () => {
    const app = await buildApp({ config: config(), db: pg.handle.db });
    const res = await app.inject({
      method: 'GET',
      url: '/pulls/00000000-0000-0000-0000-000000000000/smart-diff',
    });
    expect(res.statusCode).toBe(404);
  });
});
