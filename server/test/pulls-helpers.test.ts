import { describe, it, expect } from 'vitest';
import { prRowToMeta, prRowToDetail } from '../src/modules/pulls/helpers.js';
import type { PullRow, PrFileRow, PrCommitRow } from '../src/modules/pulls/repository.js';

/**
 * Unit coverage for the pulls row → wire mappers. These were unreachable while
 * the logic lived inline in a 381-line route handler; extracting them made the
 * mapping hermetically testable (no DB, no HTTP, no GitHub).
 *
 * The invariants that matter here are the three-way distinctions the PR list
 * depends on: never-reviewed vs reviewed-and-clean, no-settled-run vs zero
 * cost, and camelCase row keys vs snake_case wire keys.
 */

const BASE: PullRow = {
  id: 'pr-1',
  workspaceId: 'ws-1',
  repoId: 'repo-1',
  number: 7,
  title: 'feat: add thing',
  author: 'octocat',
  branch: 'feature/thing',
  base: 'main',
  headSha: 'abc123',
  lastReviewedSha: null,
  additions: 10,
  deletions: 2,
  filesCount: 3,
  status: 'open',
  body: null,
  openedAt: new Date('2026-01-01T00:00:00Z'),
  updatedAt: new Date('2026-01-02T00:00:00Z'),
};

const NOW = new Date('2026-01-03T00:00:00Z').getTime();
const NO_ROLLUPS = { score: undefined, costUsd: undefined, findings: undefined };

describe('prRowToMeta', () => {
  it('maps camelCase row keys onto the snake_case wire shape', () => {
    const meta = prRowToMeta(BASE, NO_ROLLUPS, NOW);
    expect(meta).toMatchObject({
      id: 'pr-1',
      number: 7,
      head_sha: 'abc123',
      files_count: 3,
      opened_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-02T00:00:00.000Z',
    });
  });

  it('reports a never-reviewed PR as null findings, not zeroed counts', () => {
    const meta = prRowToMeta(BASE, NO_ROLLUPS, NOW);
    expect(meta.findings).toBeNull();
    expect(meta.score).toBeNull();
    expect(meta.cost_usd).toBeNull();
  });

  it('keeps reviewed-and-clean distinct from never-reviewed', () => {
    const meta = prRowToMeta(
      BASE,
      { score: 100, costUsd: 0, findings: { CRITICAL: 0, WARNING: 0, SUGGESTION: 0 } },
      NOW,
    );
    // All-zero counts are a real answer ("we looked, it was clean"), so the
    // object must survive rather than collapse to null.
    expect(meta.findings).toEqual({ CRITICAL: 0, WARNING: 0, SUGGESTION: 0 });
    // 0 is a real cost, not "unknown" — `??` must not turn it into null.
    expect(meta.cost_usd).toBe(0);
    expect(meta.score).toBe(100);
  });

  it('preserves an explicit null score on a review that produced none', () => {
    const meta = prRowToMeta(BASE, { ...NO_ROLLUPS, score: null }, NOW);
    expect(meta.score).toBeNull();
  });

  it('derives review status rather than echoing the GitHub merge state', () => {
    // head never reviewed → needs_review, even though the DB column says 'open'
    expect(prRowToMeta(BASE, NO_ROLLUPS, NOW).status).toBe('needs_review');

    // head reviewed and recent → reviewed
    const reviewed = { ...BASE, lastReviewedSha: 'abc123' };
    expect(prRowToMeta(reviewed, NO_ROLLUPS, NOW).status).toBe('reviewed');

    // merged/closed keep GitHub's state verbatim
    expect(prRowToMeta({ ...BASE, status: 'merged' }, NO_ROLLUPS, NOW).status).toBe('merged');
  });
});

describe('prRowToDetail', () => {
  const files: PrFileRow[] = [
    { id: 'f1', prId: 'pr-1', path: 'src/a.ts', additions: 5, deletions: 1, patch: '@@ -1 +1 @@' },
    { id: 'f2', prId: 'pr-1', path: 'src/b.ts', additions: 5, deletions: 1, patch: null },
  ];
  const commits: PrCommitRow[] = [
    {
      id: 'c1',
      prId: 'pr-1',
      sha: 'deadbee',
      message: 'add thing',
      author: 'octocat',
      committedAt: new Date('2026-01-01T12:00:00Z'),
    },
  ];

  it('serialises files and commits into the wire shape', () => {
    const detail = prRowToDetail(BASE, files, commits);
    expect(detail.files).toEqual([
      { path: 'src/a.ts', additions: 5, deletions: 1, patch: '@@ -1 +1 @@' },
      { path: 'src/b.ts', additions: 5, deletions: 1, patch: null },
    ]);
    expect(detail.commits).toEqual([
      {
        sha: 'deadbee',
        message: 'add thing',
        author: 'octocat',
        committed_at: '2026-01-01T12:00:00.000Z',
      },
    ]);
  });

  it('keeps the GitHub merge state on detail (unlike the list, which derives)', () => {
    // The list maps 'open' → needs_review/reviewed/stale; detail must not.
    expect(prRowToDetail(BASE, [], []).status).toBe('open');
  });

  it('tolerates a PR with no files, commits or body', () => {
    const detail = prRowToDetail(BASE, [], []);
    expect(detail.files).toEqual([]);
    expect(detail.commits).toEqual([]);
    expect(detail.body).toBeNull();
  });

  it('emits null for a missing committed_at rather than dropping the commit', () => {
    const undated: PrCommitRow[] = [{ ...commits[0]!, committedAt: null }];
    const detail = prRowToDetail(BASE, [], undated);
    expect(detail.commits).toHaveLength(1);
    expect(detail.commits[0]!.committed_at).toBeNull();
  });
});
