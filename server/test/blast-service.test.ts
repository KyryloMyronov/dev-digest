import { describe, it, expect } from 'vitest';
import { BlastService } from '../src/modules/blast/service.js';
import { NotFoundError } from '../src/platform/errors.js';
import type { Container } from '../src/platform/container.js';
import type { Logger } from '../src/platform/logger.js';
import type { BlastResult, DependentsResult, IndexState } from '../src/modules/repo-intel/types.js';

/**
 * L04 — Blast service mapping (hermetic; no Postgres, no clone).
 *
 * The load-bearing behaviour is the honesty contract: `status`/`reason` must
 * reflect what the index could actually answer, and empty arrays may only
 * appear alongside an explanation — never as a stand-in for missing data.
 */

const log = { debug: () => {} } as unknown as Logger;

const FULL_STATE: IndexState = {
  repoId: 'r1',
  status: 'full',
  filesIndexed: 100,
  filesSkipped: 0,
  durationMs: 10,
  lastIndexedSha: 'abc',
  indexerVersion: 2,
  updatedAt: new Date(0),
};

const BLAST: BlastResult = {
  changedSymbols: [
    { file: 'src/rate-limit.ts', name: 'rateLimit', kind: 'function' },
    { file: 'src/rate-limit.ts', name: 'bucketKey', kind: 'function' },
  ],
  callers: [
    { file: 'src/api/index.ts', symbol: 'buildRouter', viaSymbol: 'rateLimit', line: 23, rank: 0.9 },
    { file: 'src/server.ts', symbol: 'main', viaSymbol: 'rateLimit', line: 88, rank: 0.4 },
    { file: 'src/api/index.ts', symbol: 'buildRouter', viaSymbol: 'bucketKey', line: 30, rank: 0.9 },
  ],
  impactedEndpoints: ['GET /items'],
  factsByFile: {
    'src/api/index.ts': { endpoints: ['GET /items'], crons: ['nightly-sync'] },
    'src/server.ts': { endpoints: [], crons: [] },
  },
  degraded: false,
};

const DEPENDENTS: DependentsResult = {
  endpointPaths: [
    { endpoint: 'GET /items', file: 'src/api/index.ts', chain: ['src/rate-limit.ts', 'src/api/index.ts'] },
    { endpoint: 'POST /hooks', file: 'src/api/hooks.ts', chain: ['src/rate-limit.ts', 'src/server.ts', 'src/api/hooks.ts'] },
  ],
  dependents: [
    { file: 'src/api/index.ts', depth: 1 },
    { file: 'src/server.ts', depth: 1 },
    { file: 'src/api/hooks.ts', depth: 2 },
  ],
};

function buildService(opts: {
  pull?: { id: string; repoId: string } | undefined;
  files?: Array<{ path: string }>;
  state?: IndexState;
  blast?: BlastResult;
  dependents?: DependentsResult;
}): BlastService {
  const container = {
    pullsRepo: {
      findPull: async () => opts.pull,
      listFiles: async () => opts.files ?? [],
    },
    repoIntel: {
      getIndexState: async () => opts.state ?? FULL_STATE,
      getBlastRadius: async () => opts.blast ?? BLAST,
      getDependents: async () => opts.dependents ?? DEPENDENTS,
    },
  } as unknown as Container;
  return new BlastService(container, log);
}

const PULL = { id: 'pr-1', repoId: 'r1' };
const FILES = [{ path: 'src/rate-limit.ts' }];

describe('BlastService.getBlast', () => {
  it('throws NotFoundError for an unknown PR', async () => {
    const svc = buildService({ pull: undefined });
    await expect(svc.getBlast('ws', 'nope')).rejects.toBeInstanceOf(NotFoundError);
  });

  it('reports degraded (not empty-and-fine) when pr_files were never synced', async () => {
    const svc = buildService({ pull: PULL, files: [] });
    const res = await svc.getBlast('ws', 'pr-1');
    expect(res.status).toBe('degraded');
    expect(res.reason).toContain('not synced');
    expect(res.impacts).toEqual([]);
    expect(res.endpoints).toEqual([]);
  });

  it('maps per-symbol impacts with callers and caller-file facts', async () => {
    const svc = buildService({ pull: PULL, files: FILES });
    const res = await svc.getBlast('ws', 'pr-1');

    expect(res.status).toBe('full');
    expect(res.reason).toBeUndefined();
    expect(res.changed_files).toEqual(['src/rate-limit.ts']);

    const rateLimit = res.impacts.find((i) => i.symbol === 'rateLimit');
    expect(rateLimit).toMatchObject({ file: 'src/rate-limit.ts', kind: 'function' });
    expect(rateLimit!.callers).toEqual([
      { file: 'src/api/index.ts', symbol: 'buildRouter', line: 23, rank: 0.9 },
      { file: 'src/server.ts', symbol: 'main', line: 88, rank: 0.4 },
    ]);
    expect(rateLimit!.endpoints_affected).toEqual(['GET /items']);
    expect(rateLimit!.crons_affected).toEqual(['nightly-sync']);
    expect(rateLimit!.callers_truncated).toBe(false);
  });

  it('serves the reverse-walk endpoints with their chains', async () => {
    const svc = buildService({ pull: PULL, files: FILES });
    const res = await svc.getBlast('ws', 'pr-1');
    expect(res.endpoints).toContainEqual({
      endpoint: 'POST /hooks',
      file: 'src/api/hooks.ts',
      chain: ['src/rate-limit.ts', 'src/server.ts', 'src/api/hooks.ts'],
    });
    // The walk already carries GET /items — no duplicate from factsByFile.
    expect(res.endpoints.filter((e) => e.endpoint === 'GET /items')).toHaveLength(1);
  });

  it('marks callers_truncated from the facade truncation list', async () => {
    const svc = buildService({
      pull: PULL,
      files: FILES,
      blast: { ...BLAST, callersTruncatedFor: ['rateLimit'] },
    });
    const res = await svc.getBlast('ws', 'pr-1');
    expect(res.impacts.find((i) => i.symbol === 'rateLimit')!.callers_truncated).toBe(true);
    expect(res.impacts.find((i) => i.symbol === 'bucketKey')!.callers_truncated).toBe(false);
  });

  it('maps a partial index to status=partial with an explanation', async () => {
    const svc = buildService({
      pull: PULL,
      files: FILES,
      state: { ...FULL_STATE, status: 'partial', filesSkipped: 7, reason: 'soft budget reached' },
    });
    const res = await svc.getBlast('ws', 'pr-1');
    expect(res.status).toBe('partial');
    expect(res.reason).toContain('7 files skipped');
    expect(res.reason).toContain('soft budget reached');
  });

  it('maps a degraded blast (ripgrep fallback) to status=degraded with an explanation', async () => {
    const svc = buildService({
      pull: PULL,
      files: FILES,
      state: { ...FULL_STATE, status: 'degraded', degraded: true, degradedReason: 'no_data' },
      blast: { ...BLAST, factsByFile: undefined, degraded: true, reason: 'no_data' },
      dependents: { endpointPaths: [], dependents: [], degraded: true, reason: 'no_data' },
    });
    const res = await svc.getBlast('ws', 'pr-1');
    expect(res.status).toBe('degraded');
    expect(res.reason).toContain('not been indexed');
    // Impacts still carry what the fallback found; facts are honestly empty.
    expect(res.impacts.find((i) => i.symbol === 'rateLimit')!.endpoints_affected).toEqual([]);
  });

  it('flags partial when only the graph walk is unavailable', async () => {
    const svc = buildService({
      pull: PULL,
      files: FILES,
      dependents: { endpointPaths: [], dependents: [], degraded: true, reason: 'no_data' },
    });
    const res = await svc.getBlast('ws', 'pr-1');
    expect(res.status).toBe('partial');
    expect(res.reason).toContain('Endpoint paths are unavailable');
    // Caller-file facts still surface as chain-length-1 endpoint entries.
    expect(res.endpoints).toContainEqual({
      endpoint: 'GET /items',
      file: 'src/api/index.ts',
      chain: ['src/api/index.ts'],
    });
  });
});
