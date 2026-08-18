import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { MockLLMProvider } from '../src/adapters/mocks.js';
import { runConventionScan } from '../src/modules/conventions/pipeline.js';
import { matchKey } from '../src/modules/conventions/helpers.js';
import type {
  ConventionRow,
  ConventionsRepository,
} from '../src/modules/conventions/repository.js';
import type { Container } from '../src/platform/container.js';

/**
 * The conventions scan, end to end, with NO database and NO real model.
 *
 * A tmpdir stands in for the clone and an in-memory repository stub for the two
 * tables, so what is under test is the pipeline's own decisions: how many model
 * calls it makes, what it puts in them, what it throws away, and — the part a
 * user would notice going wrong — which of their decisions it preserves.
 *
 * `MockLLMProvider.structuredBySchema` keys fixtures by schema name, which is how
 * the two-step dialogue is driven here: one fixture for the selection call, one
 * for the extraction call.
 *
 * The LLM is a mock, so these assert what was SENT, never what a model concluded.
 */

const WS = 'ws-1';
const REPO = 'repo-1';

// --------------------------------------------------------------------------
// In-memory ConventionsRepository stub.
// --------------------------------------------------------------------------

interface ScanState {
  status: string;
  reason: string | null;
  sampleFiles: number;
  selectedFiles: number;
  candidatesFound: number;
  newCandidates: number;
  provider: string | null;
  model: string | null;
  error: string | null;
}

function makeRepoStub(opts: { clonePath: string | null; seed?: ConventionRow[] }) {
  const rows: ConventionRow[] = [...(opts.seed ?? [])];
  let scan: ScanState | null = null;

  const stub = {
    findRepo: async () =>
      opts.clonePath === undefined
        ? undefined
        : { id: REPO, fullName: 'acme/payments-api', clonePath: opts.clonePath },

    existingSourceRules: async () => rows.map((r) => r.sourceRule),

    insertMany: async (values: Parameters<ConventionsRepository['insertMany']>[0]) => {
      const seen = new Set(rows.map((r) => matchKey(r.sourceRule)));
      const written: ConventionRow[] = [];
      for (const v of values) {
        // Mirrors the real unique index on (workspace, repo, source_rule).
        if (seen.has(matchKey(v.sourceRule))) continue;
        seen.add(matchKey(v.sourceRule));
        const row = {
          id: `cv-${rows.length + written.length + 1}`,
          workspaceId: v.workspaceId,
          repoId: v.repoId,
          sourceRule: v.sourceRule,
          rule: v.rule,
          evidencePath: v.evidencePath,
          evidenceSnippet: v.evidenceSnippet,
          confidence: v.confidence,
          status: 'pending' as const,
          edited: false,
          lastSeenAt: v.lastSeenAt,
          createdAt: new Date(),
          updatedAt: new Date(),
        };
        written.push(row);
      }
      rows.push(...written);
      return written;
    },

    refreshSeen: async (
      _ws: string,
      _repo: string,
      sourceRule: string,
      seen: { confidence: number; evidencePath: string; evidenceSnippet: string; at: Date },
    ) => {
      for (const row of rows) {
        if (row.sourceRule !== sourceRule) continue;
        row.lastSeenAt = seen.at;
        // The rule that matters: refresh only an untouched, undecided row.
        if (row.status === 'pending' && !row.edited) {
          row.confidence = seen.confidence;
          row.evidencePath = seen.evidencePath;
          row.evidenceSnippet = seen.evidenceSnippet;
        }
      }
    },

    upsertScan: async (v: Record<string, unknown>) => {
      scan = { ...(scan ?? {}), ...v } as ScanState;
      return v as never;
    },
  };

  return {
    repo: stub as unknown as ConventionsRepository,
    rows,
    scanState: () => scan,
  };
}

function makeContainer(opts: {
  samples: string[];
  llm?: MockLLMProvider;
  llmThrows?: boolean;
  /** Defaults to openai, which is never gated by the structured-output preflight. */
  provider?: 'openai' | 'openrouter';
  model?: string;
  /** What the model catalogue reports. `null` = "don't know", the default. */
  structuredOutputs?: boolean | null;
}): { container: Container; llm: MockLLMProvider } {
  const llm = opts.llm ?? new MockLLMProvider('openai', {});
  const provider = opts.provider ?? ('openai' as const);
  const container = {
    repoIntel: { getConventionSamples: async () => opts.samples },
    featureModel: async () => ({ provider, model: opts.model ?? 'gpt-5.4' }),
    modelCatalog: {
      supportsStructuredOutputs: async () => opts.structuredOutputs ?? null,
    },
    llm: async () => {
      if (opts.llmThrows) throw new Error('OPENAI_API_KEY is not configured');
      return llm;
    },
  } as unknown as Container;
  return { container, llm };
}

const SELECTION = {
  files: [
    { path: 'src/api/users.ts', reason: 'a route module' },
    { path: 'src/lib/redis.ts', reason: 'shared client' },
  ],
};

const EXTRACTION = {
  conventions: [
    {
      rule: 'Always use async/await instead of .then() chains.',
      evidence_path: 'src/api/users.ts',
      evidence_snippet: 'const user = await db.users.find(id);',
      confidence: 0.91,
    },
    {
      rule: 'Redis access goes through the src/lib/redis.ts singleton.',
      evidence_path: 'src/lib/redis.ts',
      evidence_snippet: 'export const redis = new Redis(config.redisUrl);',
      confidence: 0.85,
    },
  ],
};

function mockLlm(fixtures: Record<string, unknown>) {
  return new MockLLMProvider('openai', { structuredBySchema: fixtures });
}

// --------------------------------------------------------------------------

let clone: string;

beforeEach(async () => {
  clone = await mkdtemp(join(tmpdir(), 'devdigest-conventions-'));
  for (const [path, text] of [
    ['src/api/users.ts', 'const user = await db.users.find(id);\n'],
    ['src/lib/redis.ts', 'export const redis = new Redis(config.redisUrl);\n'],
  ] as const) {
    await mkdir(dirname(join(clone, path)), { recursive: true });
    await writeFile(join(clone, path), text, 'utf8');
  }
});

afterEach(async () => {
  await rm(clone, { recursive: true, force: true });
});

describe('runConventionScan — the happy path', () => {
  it('runs the two-step dialogue and persists the grounded rules', async () => {
    const { repo, rows, scanState } = makeRepoStub({ clonePath: clone });
    const { container } = makeContainer({
      samples: ['src/api/users.ts', 'src/lib/redis.ts'],
      llm: mockLlm({ ConventionFileSelection: SELECTION, ConventionExtraction: EXTRACTION }),
    });

    const out = await runConventionScan(container, repo, { workspaceId: WS, repoId: REPO });

    expect(out).toMatchObject({
      status: 'done',
      sampleFiles: 2,
      selectedFiles: 2,
      candidatesFound: 2,
      newCandidates: 2,
    });
    expect(rows.map((r) => r.rule)).toEqual([
      'Always use async/await instead of .then() chains.',
      'Redis access goes through the src/lib/redis.ts singleton.',
    ]);
    expect(rows.every((r) => r.status === 'pending')).toBe(true);
    expect(scanState()).toMatchObject({ status: 'done', sampleFiles: 2, provider: 'openai' });
  });

  it('calls the selection schema first, then the extraction schema', async () => {
    const { repo } = makeRepoStub({ clonePath: clone });
    const { container, llm } = makeContainer({
      samples: ['src/api/users.ts', 'src/lib/redis.ts'],
      llm: mockLlm({ ConventionFileSelection: SELECTION, ConventionExtraction: EXTRACTION }),
    });

    await runConventionScan(container, repo, { workspaceId: WS, repoId: REPO });

    const names = llm.calls.map((c) => (c.req as { schemaName: string }).schemaName);
    expect(names).toEqual(['ConventionFileSelection', 'ConventionExtraction']);
  });

  it('sends PATHS ONLY to the selection call — no file contents', async () => {
    // This is what makes the 2-step dialogue cheaper than one big call. If a
    // refactor ever inlines the file bodies here, the cost goes up an order of
    // magnitude with nothing failing.
    const { repo } = makeRepoStub({ clonePath: clone });
    const { container, llm } = makeContainer({
      samples: ['src/api/users.ts', 'src/lib/redis.ts'],
      llm: mockLlm({ ConventionFileSelection: SELECTION, ConventionExtraction: EXTRACTION }),
    });

    await runConventionScan(container, repo, { workspaceId: WS, repoId: REPO });

    const first = llm.calls[0]!.req as { messages: { content: string }[] };
    const sent = first.messages.map((m) => m.content).join('\n');
    expect(sent).toContain('src/api/users.ts');
    expect(sent).not.toContain('new Redis(config.redisUrl)');
  });

  it('labels each file with its path in the extraction call, so evidence is answerable', async () => {
    const { repo } = makeRepoStub({ clonePath: clone });
    const { container, llm } = makeContainer({
      samples: ['src/api/users.ts', 'src/lib/redis.ts'],
      llm: mockLlm({ ConventionFileSelection: SELECTION, ConventionExtraction: EXTRACTION }),
    });

    await runConventionScan(container, repo, { workspaceId: WS, repoId: REPO });

    const second = llm.calls[1]!.req as { messages: { content: string }[] };
    const sent = second.messages.map((m) => m.content).join('\n');
    expect(sent).toContain('path: src/api/users.ts');
    expect(sent).toContain('export const redis = new Redis(config.redisUrl);');
    // Untrusted repo content is delimiter-wrapped, per the engine's convention.
    expect(sent).toContain('<untrusted');
  });
});

describe('runConventionScan — degraded, without spending a model call', () => {
  it('reports not_indexed and makes ZERO model calls when the sample is empty', async () => {
    // repo-intel returns [] for both "disabled" and "never indexed". Either way
    // there is nothing to reason about, and a scan that billed for it would be
    // charging the user for a guess.
    const { repo, scanState } = makeRepoStub({ clonePath: clone });
    const { container, llm } = makeContainer({ samples: [] });

    const out = await runConventionScan(container, repo, { workspaceId: WS, repoId: REPO });

    expect(out).toMatchObject({ status: 'degraded', reason: 'not_indexed', sampleFiles: 0 });
    expect(llm.calls).toHaveLength(0);
    expect(scanState()).toMatchObject({ status: 'degraded', reason: 'not_indexed' });
  });

  it('reports no_clone and makes ZERO model calls when the repo has no clone', async () => {
    const { repo } = makeRepoStub({ clonePath: null });
    const { container, llm } = makeContainer({ samples: ['src/api/users.ts'] });

    const out = await runConventionScan(container, repo, { workspaceId: WS, repoId: REPO });

    expect(out).toMatchObject({ status: 'degraded', reason: 'no_clone', sampleFiles: 1 });
    expect(llm.calls).toHaveLength(0);
  });

  it('reports no_clone when every selected file has vanished from disk', async () => {
    const { repo } = makeRepoStub({ clonePath: clone });
    const { container } = makeContainer({
      samples: ['src/gone.ts'],
      llm: mockLlm({
        ConventionFileSelection: { files: [{ path: 'src/gone.ts', reason: 'x' }] },
        ConventionExtraction: EXTRACTION,
      }),
    });

    const out = await runConventionScan(container, repo, { workspaceId: WS, repoId: REPO });
    expect(out).toMatchObject({ status: 'degraded', reason: 'no_clone' });
  });

  it('reports no_candidates when the model finds nothing', async () => {
    const { repo } = makeRepoStub({ clonePath: clone });
    const { container } = makeContainer({
      samples: ['src/api/users.ts'],
      llm: mockLlm({
        ConventionFileSelection: SELECTION,
        ConventionExtraction: { conventions: [] },
      }),
    });

    const out = await runConventionScan(container, repo, { workspaceId: WS, repoId: REPO });
    expect(out).toMatchObject({ status: 'done', reason: 'no_candidates', candidatesFound: 0 });
  });
});

describe('runConventionScan — failures never reach the JobRunner', () => {
  it('records llm_unavailable when no API key is configured', async () => {
    const { repo, scanState } = makeRepoStub({ clonePath: clone });
    const { container } = makeContainer({ samples: ['src/api/users.ts'], llmThrows: true });

    const out = await runConventionScan(container, repo, { workspaceId: WS, repoId: REPO });

    expect(out).toMatchObject({ status: 'failed', reason: 'llm_unavailable' });
    expect(scanState()).toMatchObject({ error: 'OPENAI_API_KEY is not configured' });
  });

  it('records model_unsupported WITHOUT calling the model, when it cannot do structured outputs', async () => {
    // The whole point of a preflight: a model that cannot serve a strict
    // json_schema must cost zero calls, not fail after paying for one.
    const { repo, scanState } = makeRepoStub({ clonePath: clone });
    const { container, llm } = makeContainer({
      samples: ['src/api/users.ts'],
      provider: 'openrouter',
      model: 'google/gemma-4-31b-it:free',
      structuredOutputs: false,
      llm: mockLlm({ ConventionFileSelection: SELECTION, ConventionExtraction: EXTRACTION }),
    });

    const out = await runConventionScan(container, repo, { workspaceId: WS, repoId: REPO });

    expect(out).toMatchObject({ status: 'failed', reason: 'model_unsupported' });
    expect(llm.calls).toHaveLength(0);
    // The offending model is named on the row — the generic catch does not do this.
    expect(scanState()).toMatchObject({
      provider: 'openrouter',
      model: 'google/gemma-4-31b-it:free',
      sampleFiles: 1,
    });
  });

  it('proceeds when the catalogue does not know whether the model supports them', async () => {
    // `null` is our ignorance, not the model's limitation. Blocking on it would
    // break every scan the moment OpenRouter's /models is unreachable.
    const { repo } = makeRepoStub({ clonePath: clone });
    const { container, llm } = makeContainer({
      samples: ['src/api/users.ts', 'src/lib/redis.ts'],
      provider: 'openrouter',
      model: 'some/unlisted-model',
      structuredOutputs: null,
      llm: mockLlm({ ConventionFileSelection: SELECTION, ConventionExtraction: EXTRACTION }),
    });

    const out = await runConventionScan(container, repo, { workspaceId: WS, repoId: REPO });

    expect(out).toMatchObject({ status: 'done' });
    expect(llm.calls).toHaveLength(2);
  });

  it('RESOLVES rather than rejects when the model throws', async () => {
    // JobRunner retries a rejected handler twice. For a deterministic failure
    // that would mean three full scans — and three bills — for one broken run.
    const { repo, scanState } = makeRepoStub({ clonePath: clone });
    const { container } = makeContainer({
      samples: ['src/api/users.ts'],
      // No fixture for the selection schema → the mock's schema parse throws.
      llm: mockLlm({}),
    });

    await expect(
      runConventionScan(container, repo, { workspaceId: WS, repoId: REPO }),
    ).resolves.toMatchObject({ status: 'failed' });
    expect(scanState()!.error).toBeTruthy();
  });

  it('records no_repo for a stale job payload', async () => {
    const { repo } = makeRepoStub({ clonePath: undefined as unknown as null });
    const { container } = makeContainer({ samples: ['src/api/users.ts'] });

    const out = await runConventionScan(container, repo, { workspaceId: WS, repoId: REPO });
    expect(out).toMatchObject({ status: 'failed', reason: 'no_repo' });
  });
});

describe('runConventionScan — grounding', () => {
  it('drops a rule citing a file that was never sent, and keeps the rest', async () => {
    const { repo, rows } = makeRepoStub({ clonePath: clone });
    const { container } = makeContainer({
      samples: ['src/api/users.ts', 'src/lib/redis.ts'],
      llm: mockLlm({
        ConventionFileSelection: SELECTION,
        ConventionExtraction: {
          conventions: [
            EXTRACTION.conventions[0]!,
            {
              rule: 'All handlers return Result<T, ApiError>.',
              evidence_path: 'src/api/public/index.ts', // never opened
              evidence_snippet: 'function handler(): Result<Item[], ApiError> {',
              confidence: 0.78,
            },
          ],
        },
      }),
    });

    const out = await runConventionScan(container, repo, { workspaceId: WS, repoId: REPO });

    expect(out.candidatesFound).toBe(1);
    expect(rows.map((r) => r.evidencePath)).toEqual(['src/api/users.ts']);
  });

  it('falls back to the top-ranked files when the model hallucinates every pick', async () => {
    const { repo } = makeRepoStub({ clonePath: clone });
    const { container, llm } = makeContainer({
      samples: ['src/api/users.ts', 'src/lib/redis.ts'],
      llm: mockLlm({
        ConventionFileSelection: { files: [{ path: 'nowhere/at/all.ts', reason: 'x' }] },
        ConventionExtraction: EXTRACTION,
      }),
    });

    const out = await runConventionScan(container, repo, { workspaceId: WS, repoId: REPO });

    // The scan still ran on real files instead of aborting.
    expect(out).toMatchObject({ status: 'done', selectedFiles: 2 });
    const second = llm.calls[1]!.req as { messages: { content: string }[] };
    expect(second.messages.map((m) => m.content).join('\n')).toContain('path: src/api/users.ts');
  });
});

describe('runConventionScan — a re-scan preserves the user’s decisions', () => {
  function decidedRow(over: Partial<ConventionRow>): ConventionRow {
    return {
      id: 'cv-seed',
      workspaceId: WS,
      repoId: REPO,
      sourceRule: 'Always use async/await instead of .then() chains.',
      rule: 'Always use async/await instead of .then() chains.',
      evidencePath: 'src/api/users.ts',
      evidenceSnippet: 'old snippet',
      confidence: 0.5,
      status: 'pending',
      edited: false,
      lastSeenAt: null,
      createdAt: new Date('2026-08-01T00:00:00.000Z'),
      updatedAt: new Date('2026-08-01T00:00:00.000Z'),
      ...over,
    };
  }

  it('leaves an ACCEPTED row’s status and wording alone, and adds only what is new', async () => {
    const { repo, rows } = makeRepoStub({
      clonePath: clone,
      seed: [decidedRow({ status: 'accepted' })],
    });
    const { container } = makeContainer({
      samples: ['src/api/users.ts', 'src/lib/redis.ts'],
      llm: mockLlm({ ConventionFileSelection: SELECTION, ConventionExtraction: EXTRACTION }),
    });

    const out = await runConventionScan(container, repo, { workspaceId: WS, repoId: REPO });

    expect(out).toMatchObject({ candidatesFound: 2, newCandidates: 1 });
    const seeded = rows.find((r) => r.id === 'cv-seed')!;
    expect(seeded.status).toBe('accepted');
    // Seen again, so the timestamp moves…
    expect(seeded.lastSeenAt).not.toBeNull();
    // …but a decided row is not re-scored or re-evidenced.
    expect(seeded.confidence).toBe(0.5);
    expect(seeded.evidenceSnippet).toBe('old snippet');
    expect(rows).toHaveLength(2);
  });

  it('leaves a REJECTED row rejected, so the same rule is not offered again', async () => {
    const { repo, rows } = makeRepoStub({
      clonePath: clone,
      seed: [decidedRow({ status: 'rejected' })],
    });
    const { container } = makeContainer({
      samples: ['src/api/users.ts'],
      llm: mockLlm({ ConventionFileSelection: SELECTION, ConventionExtraction: EXTRACTION }),
    });

    await runConventionScan(container, repo, { workspaceId: WS, repoId: REPO });

    expect(rows.find((r) => r.id === 'cv-seed')!.status).toBe('rejected');
    expect(rows.filter((r) => matchKey(r.sourceRule) === matchKey(decidedRow({}).sourceRule)))
      .toHaveLength(1);
  });

  it('leaves an EDITED row’s wording alone even while it is still pending', async () => {
    const { repo, rows } = makeRepoStub({
      clonePath: clone,
      seed: [
        decidedRow({ edited: true, rule: 'Prefer async/await. Never chain .then().' }),
      ],
    });
    const { container } = makeContainer({
      samples: ['src/api/users.ts'],
      llm: mockLlm({ ConventionFileSelection: SELECTION, ConventionExtraction: EXTRACTION }),
    });

    await runConventionScan(container, repo, { workspaceId: WS, repoId: REPO });

    const seeded = rows.find((r) => r.id === 'cv-seed')!;
    expect(seeded.rule).toBe('Prefer async/await. Never chain .then().');
    expect(seeded.evidenceSnippet).toBe('old snippet');
  });

  it('DOES refresh an untouched pending row, so a better citation lands', async () => {
    const { repo, rows } = makeRepoStub({ clonePath: clone, seed: [decidedRow({})] });
    const { container } = makeContainer({
      samples: ['src/api/users.ts'],
      llm: mockLlm({ ConventionFileSelection: SELECTION, ConventionExtraction: EXTRACTION }),
    });

    await runConventionScan(container, repo, { workspaceId: WS, repoId: REPO });

    const seeded = rows.find((r) => r.id === 'cv-seed')!;
    expect(seeded.confidence).toBe(0.91);
    expect(seeded.evidenceSnippet).toBe('const user = await db.users.find(id);');
  });

  it('creates no duplicates when the same scan runs twice', async () => {
    const { repo, rows } = makeRepoStub({ clonePath: clone });
    const { container } = makeContainer({
      samples: ['src/api/users.ts', 'src/lib/redis.ts'],
      llm: mockLlm({ ConventionFileSelection: SELECTION, ConventionExtraction: EXTRACTION }),
    });

    await runConventionScan(container, repo, { workspaceId: WS, repoId: REPO });
    const second = await runConventionScan(container, repo, { workspaceId: WS, repoId: REPO });

    expect(second).toMatchObject({ candidatesFound: 2, newCandidates: 0 });
    expect(rows).toHaveLength(2);
  });
});
