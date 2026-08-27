import { describe, it, expect } from 'vitest';
import { RepoIntelService } from '../src/modules/repo-intel/service.js';
import type { FullSymbolRow, IndexerEdgeRow, ResolvedCallerRow } from '../src/modules/repo-intel/repository.js';
import { MAX_CALLERS_PER_SYMBOL } from '../src/modules/repo-intel/constants.js';

/**
 * L04 — persistent blast + reverse-import walk (hermetic; the repository is
 * patched, no Postgres).
 *
 * Pins the read-time invariants the blast module builds on:
 *  - the caller cap is PER CHANGED SYMBOL (a hub symbol can't crowd others out),
 *    with the cut reported via `callersTruncatedFor`;
 *  - a symbol's declaration file is never among its callers;
 *  - callers sort by file rank DESC within a symbol;
 *  - getDependents walks reverse edges at most `maxDepth` levels and keeps the
 *    shortest chain per dependent.
 */

const FULL_STATE = { status: 'full' } as never;

function buildService(fakes: Record<string, unknown>): RepoIntelService {
  const container = { config: { repoIntelEnabled: true }, db: {} as never } as never;
  const svc = new RepoIntelService(container);
  (svc as unknown as { repo: Record<string, unknown> }).repo = {
    tryGetIndexState: async () => FULL_STATE,
    getFileFacts: async () => [],
    ...fakes,
  };
  return svc;
}

const symbol = (name: string, path = 'src/changed.ts'): FullSymbolRow => ({
  path,
  name,
  kind: 'function',
  line: 1,
  endLine: 2,
  exported: true,
  signature: null,
});

const caller = (o: Partial<ResolvedCallerRow>): ResolvedCallerRow => ({
  fromPath: 'src/caller.ts',
  toSymbol: 'a',
  declFile: 'src/changed.ts',
  line: 1,
  rank: 0,
  ...o,
});

describe('getBlastRadius (persistent path)', () => {
  it('caps callers per changed symbol and reports the cut', async () => {
    const many = Array.from({ length: MAX_CALLERS_PER_SYMBOL + 5 }, (_, i) =>
      caller({ fromPath: `src/c${i}.ts`, toSymbol: 'hub', rank: i }),
    );
    const few = [
      caller({ fromPath: 'src/x.ts', toSymbol: 'quiet', line: 3, rank: 1 }),
    ];
    const svc = buildService({
      getSymbolRows: async (_r: string, paths: string[]) =>
        paths.includes('src/changed.ts') ? [symbol('hub'), symbol('quiet')] : [],
      getResolvedCallers: async () => [...many, ...few],
    });

    const blast = await svc.getBlastRadius('r1', ['src/changed.ts']);
    const hub = blast.callers.filter((c) => c.viaSymbol === 'hub');
    const quiet = blast.callers.filter((c) => c.viaSymbol === 'quiet');
    expect(hub).toHaveLength(MAX_CALLERS_PER_SYMBOL);
    expect(quiet).toHaveLength(1); // NOT crowded out by the hub symbol
    expect(blast.callersTruncatedFor).toEqual(['hub']);
    // Within the symbol, the kept 20 are the TOP by rank (the rank-0..4 rows fell off).
    expect(Math.min(...hub.map((c) => c.rank))).toBe(5);
  });

  it('sorts a symbol’s callers by rank DESC', async () => {
    const svc = buildService({
      getSymbolRows: async (_r: string, paths: string[]) =>
        paths.includes('src/changed.ts') ? [symbol('a')] : [],
      getResolvedCallers: async () => [
        caller({ fromPath: 'src/low.ts', rank: 0.1 }),
        caller({ fromPath: 'src/high.ts', rank: 0.9 }),
      ],
    });
    const blast = await svc.getBlastRadius('r1', ['src/changed.ts']);
    expect(blast.callers.map((c) => c.file)).toEqual(['src/high.ts', 'src/low.ts']);
  });

  it('never lists the declaration file among a symbol’s callers', async () => {
    const svc = buildService({
      getSymbolRows: async (_r: string, paths: string[]) =>
        paths.includes('src/changed.ts') ? [symbol('a')] : [],
      getResolvedCallers: async () => [
        caller({ fromPath: 'src/changed.ts' }), // self-reference — must be dropped
        caller({ fromPath: 'src/other.ts' }),
      ],
    });
    const blast = await svc.getBlastRadius('r1', ['src/changed.ts']);
    expect(blast.callers.map((c) => c.file)).toEqual(['src/other.ts']);
  });
});

describe('getDependents (reverse-import walk)', () => {
  const edges: IndexerEdgeRow[] = [
    // changed.ts ← mid.ts ← route.ts (and route.ts also imports changed.ts directly)
    { fromFile: 'src/mid.ts', toFile: 'src/changed.ts' },
    { fromFile: 'src/route.ts', toFile: 'src/mid.ts' },
    { fromFile: 'src/route.ts', toFile: 'src/changed.ts' },
    { fromFile: 'src/deep.ts', toFile: 'src/route.ts' }, // depth 2 (via the direct edge)
    { fromFile: 'src/too-deep.ts', toFile: 'src/deep.ts' }, // depth 3 — beyond maxDepth 2
  ];
  const reverse = async (_r: string, toFiles: string[]) =>
    edges.filter((e) => toFiles.includes(e.toFile));

  it('walks at most maxDepth levels, keeping the shortest chain per file', async () => {
    const svc = buildService({
      getReverseEdges: reverse,
      getFileFacts: async (_r: string, files: string[]) =>
        files.includes('src/route.ts')
          ? [{ filePath: 'src/route.ts', endpoints: ['GET /things'], crons: [] }]
          : [],
    });

    const res = await svc.getDependents('r1', ['src/changed.ts'], 2);
    expect(res.degraded).toBeUndefined();
    expect(res.dependents).toContainEqual({ file: 'src/mid.ts', depth: 1 });
    // route.ts is reachable at depth 1 directly — the shorter chain wins.
    expect(res.dependents).toContainEqual({ file: 'src/route.ts', depth: 1 });
    expect(res.dependents).toContainEqual({ file: 'src/deep.ts', depth: 2 });
    expect(res.dependents.some((d) => d.file === 'src/too-deep.ts')).toBe(false);
    expect(res.endpointPaths).toEqual([
      { endpoint: 'GET /things', file: 'src/route.ts', chain: ['src/changed.ts', 'src/route.ts'] },
    ]);
  });

  it('degrades (never throws) without a usable index', async () => {
    const svc = buildService({ tryGetIndexState: async () => null, getReverseEdges: reverse });
    const res = await svc.getDependents('r1', ['src/changed.ts']);
    expect(res).toEqual({ endpointPaths: [], dependents: [], degraded: true, reason: 'no_data' });
  });

  it('degrades with flag_off when repo-intel is disabled', async () => {
    const container = { config: { repoIntelEnabled: false }, db: {} as never } as never;
    const svc = new RepoIntelService(container);
    const res = await svc.getDependents('r1', ['src/changed.ts']);
    expect(res).toEqual({ endpointPaths: [], dependents: [], degraded: true, reason: 'flag_off' });
  });
});
