import { describe, it, expect, beforeEach } from 'vitest';
import type { LLMProvider, StructuredRequest, StructuredResult } from '@devdigest/shared';
import { renderPrompt } from '../src/platform/prompts.js';
import { ConfigError } from '../src/platform/errors.js';
import { deriveFileSummaries } from '../src/modules/file-summary/pipeline.js';
import type {
  FileSummaryRepository,
  FileSummaryRow,
  InsertFileSummary,
} from '../src/modules/file-summary/repository.js';
import {
  FILE_SUMMARY_MAX_OUTPUT_TOKENS,
  FILE_SUMMARY_PROMPT_TOKEN_CAP,
  MAX_FILE_SUMMARY_CHARS,
} from '../src/modules/file-summary/constants.js';
import type { Container } from '../src/platform/container.js';
import type { PullRow } from '../src/db/rows.js';
import { RunLogger, type PinoLike } from '../src/platform/run-logger.js';
import type { RunBus } from '../src/platform/sse.js';

/**
 * SPEC-03 — the file-summary derivation pipeline, end to end, with NO database
 * and NO real model.
 *
 * What is under test is the pipeline's own decisions: how many model calls it
 * makes, what it puts in them, what it refuses to persist, how one call's cost
 * is split across the rows it produced, and how it behaves when each dependency
 * is missing. The contract it must hold in every one of those cases is the same:
 * NEVER THROW (AC-15), and always say something exactly once (NFR-11).
 */

const WS = 'ws-1';
const HEAD = 'abc1234def';

/** Distinctive markers: NFR-11 asserts neither ever reaches a log line. */
const PATCH_MARKER = 'SECRET-PATCH-MARKER';
const SUMMARY_MARKER = 'SECRET-SUMMARY-MARKER';

type FileRow = { path: string; additions: number; deletions: number; patch: string | null };

const file = (path: string, over: Partial<FileRow> = {}): FileRow => ({
  path,
  additions: 10,
  deletions: 2,
  patch: `@@ -1,2 +1,3 @@\n+const x = 1; // ${PATCH_MARKER} ${path}`,
  ...over,
});

const CORE_FILES: FileRow[] = [
  file('src/config.ts', { additions: 40 }),
  file('src/api/users.ts', { additions: 20 }),
];

function summaryFixture(paths: string[]) {
  return {
    summaries: paths.map((p) => ({ path: p, summary: `${SUMMARY_MARKER} changes ${p}` })),
  };
}

// ------------------------------------------------------------------- stubs

function makeLog() {
  const events: { kind: string; msg: string }[] = [];
  const stdout: { level: string; obj: unknown; msg?: string }[] = [];
  const bus = {
    publish: (_runId: string, kind: string, msg: string) => events.push({ kind, msg }),
    buffer: () => [],
  } as unknown as RunBus;
  const pino: PinoLike = {
    info: (obj, msg) => stdout.push({ level: 'info', obj, msg }),
    warn: (obj, msg) => stdout.push({ level: 'warn', obj, msg }),
    error: (obj, msg) => stdout.push({ level: 'error', obj, msg }),
    debug: (obj, msg) => stdout.push({ level: 'debug', obj, msg }),
  };
  return { events, stdout, runLog: new RunLogger(bus, ['run-1'], pino) };
}

function makePull(over: Partial<PullRow> = {}): PullRow {
  return {
    id: 'pr-1',
    workspaceId: WS,
    repoId: 'repo-1',
    number: 482,
    title: 'Add rate limiting to public API endpoints',
    author: 'octocat',
    branch: 'feat/rate-limit',
    base: 'main',
    headSha: HEAD,
    body: null,
    ...over,
  } as PullRow;
}

const REPO = {
  id: 'repo-1',
  owner: 'acme',
  name: 'payments-api',
  fullName: 'acme/payments-api',
} as never;

/**
 * A recording LLM stub. Unlike `MockLLMProvider` it does NOT validate the
 * fixture against the schema, which is what lets AC-27 drive a genuinely
 * malformed answer through the pipeline's own parse step.
 */
class StubLlm implements Partial<LLMProvider> {
  readonly id = 'openai' as const;
  calls: StructuredRequest<unknown>[] = [];
  constructor(
    private result: {
      data: unknown;
      model?: string;
      tokensIn?: number;
      tokensOut?: number;
      costUsd?: number | null;
    },
    private throws?: Error,
  ) {}
  async completeStructured<T>(req: StructuredRequest<T>): Promise<StructuredResult<T>> {
    this.calls.push(req as StructuredRequest<unknown>);
    if (this.throws) throw this.throws;
    return {
      data: this.result.data as T,
      model: this.result.model ?? req.model,
      tokensIn: this.result.tokensIn ?? 1_000,
      tokensOut: this.result.tokensOut ?? 60,
      costUsd: this.result.costUsd === undefined ? 0.001 : this.result.costUsd,
      raw: JSON.stringify(this.result.data),
      attempts: 1,
    };
  }
}

function makeRepoStub(stored: FileSummaryRow[] = []) {
  const writes: InsertFileSummary[][] = [];
  const repo = {
    listSummariesAtHead: async (_ws: string, _prId: string, headSha: string) =>
      stored.filter((r) => r.headSha === headSha),
    listSummaries: async () => stored,
    upsertSummaries: async (rows: InsertFileSummary[]) => {
      writes.push(rows);
    },
  } as unknown as FileSummaryRepository;
  return { repo, writes };
}

function makeRejectingRepoStub() {
  return {
    listSummariesAtHead: async () => [],
    listSummaries: async () => [],
    upsertSummaries: async () => {
      throw new Error('deadlock detected');
    },
  } as unknown as FileSummaryRepository;
}

function makeContainer(
  opts: {
    llm?: StubLlm;
    llmThrows?: boolean;
    provider?: 'openai' | 'openrouter';
    model?: string;
    structuredOutputs?: boolean | null;
    files?: FileRow[];
    filesThrow?: boolean;
    verbose?: boolean;
    tokensPerBlock?: number;
  } = {},
): { container: Container; llm: StubLlm; featureModelIds: string[] } {
  const llm = opts.llm ?? new StubLlm({ data: summaryFixture(['src/config.ts', 'src/api/users.ts']) });
  const featureModelIds: string[] = [];
  const container = {
    config: { promptLogVerbose: opts.verbose ?? false },
    tokenizer: {
      count: (t: string) =>
        opts.tokensPerBlock !== undefined && t.startsWith('<untrusted')
          ? opts.tokensPerBlock
          : Math.ceil(t.length / 4),
    },
    featureModel: async (_ws: string, id: string) => {
      featureModelIds.push(id);
      return { provider: opts.provider ?? 'openrouter', model: opts.model ?? 'deepseek/deepseek-v4-flash' };
    },
    modelCatalog: {
      supportsStructuredOutputs: async () =>
        opts.structuredOutputs === undefined ? null : opts.structuredOutputs,
    },
    llm: async () => {
      if (opts.llmThrows) throw new ConfigError('OPENROUTER_API_KEY is not configured');
      return llm;
    },
    pullsRepo: {
      listFiles: async () => {
        if (opts.filesThrow) throw new Error('db down');
        return opts.files ?? CORE_FILES;
      },
    },
  } as unknown as Container;
  return { container, llm, featureModelIds };
}

let log: ReturnType<typeof makeLog>;
beforeEach(() => {
  log = makeLog();
});

function run(
  container: Container,
  repository: FileSummaryRepository,
  over: Partial<Parameters<typeof deriveFileSummaries>[2]> = {},
) {
  return deriveFileSummaries(container, repository, {
    workspaceId: WS,
    pull: makePull(),
    repo: REPO,
    runLog: log.runLog,
    ...over,
  });
}

/** The one exit line — the pipeline says exactly one thing about its outcome. */
function exitLines() {
  return log.events.filter(
    (e) => e.msg.startsWith('File summaries unavailable') || e.msg.startsWith('File summaries:'),
  );
}

// -------------------------------------------------------- selection reaching the call

describe('what the derivation sends (AC-12, AC-13, AC-18, AC-22, AC-25)', () => {
  it('AC-13 — a body with no path summarises the PR-level selection, boilerplate excluded', async () => {
    const files = [...CORE_FILES, file('pnpm-lock.yaml', { additions: 4_000 })];
    const { container, llm } = makeContainer({ files });
    const { repo, writes } = makeRepoStub();

    const outcome = await run(container, repo);

    const message = String(llm.calls[0]!.messages[1]!.content);
    expect(message).toContain('<untrusted source="file:src/config.ts">');
    expect(message).toContain('<untrusted source="file:src/api/users.ts">');
    expect(message).not.toContain('pnpm-lock.yaml');
    expect(outcome.summaries?.map((s) => s.path)).toEqual(['src/config.ts', 'src/api/users.ts']);
    expect(writes[0]!.map((r) => r.path)).toEqual(['src/config.ts', 'src/api/users.ts']);
  });

  it('AC-12 — a body carrying a path summarises only that file', async () => {
    const llm = new StubLlm({ data: summaryFixture(['src/api/users.ts']) });
    const { container } = makeContainer({ llm });
    const { repo, writes } = makeRepoStub();

    const outcome = await run(container, repo, { path: 'src/api/users.ts' });

    const message = String(llm.calls[0]!.messages[1]!.content);
    expect(message).toContain('<untrusted source="file:src/api/users.ts">');
    expect(message).not.toContain('file:src/config.ts');
    expect(outcome.summaries?.map((s) => s.path)).toEqual(['src/api/users.ts']);
    expect(writes[0]).toHaveLength(1);
  });

  it('AC-22 — a PR of only null-patch files exits no_files with NO model request', async () => {
    const { container, llm } = makeContainer({
      files: [file('assets/logo.png', { patch: null }), file('bin/tool', { patch: null })],
    });
    const { repo, writes } = makeRepoStub();

    const outcome = await run(container, repo);

    expect(outcome.reason).toBe('no_files');
    expect(llm.calls).toHaveLength(0);
    expect(writes).toHaveLength(0);
  });

  it('AC-15 — a PR with no persisted files exits no_files rather than throwing', async () => {
    const { container, llm } = makeContainer({ files: [] });
    const { repo } = makeRepoStub();

    const outcome = await run(container, repo);

    expect(outcome.reason).toBe('no_files');
    expect(llm.calls).toHaveLength(0);
  });

  it('AC-15 — a failing file read degrades to no_files rather than throwing', async () => {
    const { container } = makeContainer({ filesThrow: true });
    const { repo } = makeRepoStub();

    await expect(run(container, repo)).resolves.toMatchObject({ reason: 'no_files' });
  });
});

// ------------------------------------------------------------------ the call itself

describe('the model request (AC-23, AC-24, AC-31, AC-39; NFR-2)', () => {
  it('AC-24 / NFR-2 — exactly ONE structured request for a ten-file selection', async () => {
    const files = Array.from({ length: 10 }, (_, i) => file(`src/f${i}.ts`));
    const llm = new StubLlm({ data: summaryFixture(files.map((f) => f.path)) });
    const { container } = makeContainer({ files, llm });
    const { repo, writes } = makeRepoStub();

    await run(container, repo);

    expect(llm.calls).toHaveLength(1);
    expect(writes[0]).toHaveLength(10);
  });

  it('AC-23 — the request declares an explicit maxTokens, and maxRetries is 0', async () => {
    const { container, llm } = makeContainer();
    const { repo } = makeRepoStub();

    await run(container, repo);

    expect(llm.calls[0]!.maxTokens).toBe(FILE_SUMMARY_MAX_OUTPUT_TOKENS);
    // AC-39 / NFR-2's mechanism: the provider loops `maxRetries + 1` times.
    expect(llm.calls[0]!.maxRetries).toBe(0);
  });

  it('AC-31 — the provider and model are resolved through the `file_summary` id', async () => {
    const { container, featureModelIds } = makeContainer();
    const { repo, writes } = makeRepoStub();

    await run(container, repo);

    expect(featureModelIds).toEqual(['file_summary']);
    expect(writes[0]![0]!.provider).toBe('openrouter');
    expect(writes[0]![0]!.model).toBe('deepseek/deepseek-v4-flash');
  });

  it('AC-39 / NFR-2 — a failed request is abandoned, never re-issued', async () => {
    const llm = new StubLlm({ data: {} }, new Error('502 upstream'));
    const { container } = makeContainer({ llm });
    const { repo, writes } = makeRepoStub();

    const outcome = await run(container, repo);

    expect(outcome.reason).toBe('llm_failed');
    expect(llm.calls).toHaveLength(1);
    expect(writes).toHaveLength(0);
  });

  it('AC-32 — an unconstructable provider exits llm_unavailable with no model request', async () => {
    const { container, llm } = makeContainer({ llmThrows: true });
    const { repo } = makeRepoStub();

    const outcome = await run(container, repo);

    expect(outcome.reason).toBe('llm_unavailable');
    expect(llm.calls).toHaveLength(0);
  });
});

// --------------------------------------------------------------- the preflight

describe('the structured-output preflight (AC-29, AC-30)', () => {
  it('AC-29 — an explicit false abandons the derivation BEFORE any request', async () => {
    const { container, llm } = makeContainer({ provider: 'openrouter', structuredOutputs: false });
    const { repo, writes } = makeRepoStub();

    const outcome = await run(container, repo);

    expect(outcome.reason).toBe('model_unsupported');
    expect(llm.calls).toHaveLength(0);
    expect(writes).toHaveLength(0);
  });

  it('AC-30 — a null answer proceeds: our ignorance is not the model’s limitation', async () => {
    const { container, llm } = makeContainer({ provider: 'openrouter', structuredOutputs: null });
    const { repo } = makeRepoStub();

    const outcome = await run(container, repo);

    expect(llm.calls).toHaveLength(1);
    expect(outcome.reason).toBeUndefined();
  });

  it('AC-29 — the preflight is skipped for a non-openrouter provider', async () => {
    // OpenAI publishes no capability list, so the catalogue would answer `null`
    // for every model; gating on the provider is what keeps that honest.
    const { container, llm } = makeContainer({ provider: 'openai', structuredOutputs: false });
    const { repo } = makeRepoStub();

    await run(container, repo);

    expect(llm.calls).toHaveLength(1);
  });
});

// ------------------------------------------------------------------ the cache

describe('the cache (AC-16, AC-17)', () => {
  const storedRow = (path: string, headSha = HEAD): FileSummaryRow =>
    ({
      prId: 'pr-1',
      path,
      headSha,
      summary: 'stored summary',
      provider: 'openrouter',
      model: 'deepseek/deepseek-v4-flash',
      tokensIn: 100,
      tokensOut: 5,
      costUsd: 0.0001,
      createdAt: new Date('2026-08-28T10:00:00.000Z'),
    }) as FileSummaryRow;

  it('AC-16 — every requested file already stored at this head ⇒ NO model request', async () => {
    const { container, llm } = makeContainer();
    const { repo, writes } = makeRepoStub([
      storedRow('src/config.ts'),
      storedRow('src/api/users.ts'),
    ]);

    const outcome = await run(container, repo);

    expect(llm.calls).toHaveLength(0);
    expect(writes).toHaveLength(0);
    expect(outcome.cached).toBe(true);
    expect(outcome.summaries?.map((s) => s.path).sort()).toEqual([
      'src/api/users.ts',
      'src/config.ts',
    ]);
  });

  it('AC-16 — a row stored at a DIFFERENT head does not satisfy the cache', async () => {
    const { container, llm } = makeContainer();
    const { repo } = makeRepoStub([
      storedRow('src/config.ts', 'oldsha'),
      storedRow('src/api/users.ts', 'oldsha'),
    ]);

    const outcome = await run(container, repo);

    expect(llm.calls).toHaveLength(1);
    expect(outcome.cached).toBeUndefined();
  });

  it('AC-16 — a partially cached selection derives only the missing file', async () => {
    const llm = new StubLlm({ data: summaryFixture(['src/api/users.ts']) });
    const { container } = makeContainer({ llm });
    const { repo, writes } = makeRepoStub([storedRow('src/config.ts')]);

    const outcome = await run(container, repo);

    const message = String(llm.calls[0]!.messages[1]!.content);
    expect(message).toContain('file:src/api/users.ts');
    expect(message).not.toContain('file:src/config.ts');
    expect(writes[0]!.map((r) => r.path)).toEqual(['src/api/users.ts']);
    // Both render: the cached one is returned alongside the derived one.
    expect(outcome.summaries?.map((s) => s.path).sort()).toEqual([
      'src/api/users.ts',
      'src/config.ts',
    ]);
  });

  it('AC-17 — force re-derives a file that is already stored at this head', async () => {
    const { container, llm } = makeContainer();
    const { repo, writes } = makeRepoStub([
      storedRow('src/config.ts'),
      storedRow('src/api/users.ts'),
    ]);

    const outcome = await run(container, repo, { force: true });

    expect(llm.calls).toHaveLength(1);
    expect(writes[0]).toHaveLength(2);
    expect(outcome.cached).toBeUndefined();
  });
});

// ----------------------------------------------------- parsing, gating, clamping

describe('what comes back (AC-27, AC-28, AC-37, AC-38, AC-74; NFR-4)', () => {
  it('AC-27 — output missing `summary` is a recorded parse failure that persists NOTHING', async () => {
    const llm = new StubLlm({ data: { summaries: [{ path: 'src/config.ts' }] } });
    const { container } = makeContainer({ llm });
    const { repo, writes } = makeRepoStub();

    const outcome = await run(container, repo);

    expect(outcome.reason).toBe('parse_failed');
    expect(outcome.summaries).toBeUndefined();
    expect(writes).toHaveLength(0);
  });

  it('AC-38 / AC-37 — a path absent from the selection is discarded with a recorded reason', async () => {
    const llm = new StubLlm({
      data: summaryFixture(['src/config.ts', 'src/never-changed.ts', 'pnpm-lock.yaml']),
    });
    const { container } = makeContainer({ llm });
    const { repo, writes } = makeRepoStub();

    const outcome = await run(container, repo);

    expect(writes[0]!.map((r) => r.path)).toEqual(['src/config.ts']);
    expect(outcome.summaries?.map((s) => s.path)).toEqual(['src/config.ts']);
    const discardLine = log.events.find((e) => e.msg.includes('discarded'));
    expect(discardLine?.msg).toContain('src/never-changed.ts');
    expect(discardLine?.msg).toContain('pnpm-lock.yaml');
  });

  it('AC-37 — a duplicated path is written once, keeping the first answer', async () => {
    const llm = new StubLlm({
      data: {
        summaries: [
          { path: 'src/config.ts', summary: 'first answer' },
          { path: 'src/config.ts', summary: 'second answer' },
        ],
      },
    });
    const { container } = makeContainer({ files: [CORE_FILES[0]!], llm });
    const { repo, writes } = makeRepoStub();

    await run(container, repo);

    expect(writes[0]).toHaveLength(1);
    expect(writes[0]![0]!.summary).toBe('first answer');
  });

  it('AC-28 / AC-74 / NFR-4 — a 900-character summary is TRUNCATED AND KEPT', async () => {
    const long = 'x'.repeat(880) + 'TAILMARKER';
    const llm = new StubLlm({ data: { summaries: [{ path: 'src/config.ts', summary: long }] } });
    const { container } = makeContainer({ files: [CORE_FILES[0]!], llm });
    const { repo, writes } = makeRepoStub();

    const outcome = await run(container, repo);

    const persisted = writes[0]![0]!.summary;
    expect(persisted).toHaveLength(MAX_FILE_SUMMARY_CHARS);
    expect(persisted).toBe(long.slice(0, MAX_FILE_SUMMARY_CHARS));
    // AC-74's DIRECTION: the derivation still reports success.
    expect(outcome.reason).toBeUndefined();
    expect(outcome.summaries?.[0]!.summary).toHaveLength(MAX_FILE_SUMMARY_CHARS);
  });

  it('AC-27 — output whose every path is unselected is a parse failure, not an empty success', async () => {
    const llm = new StubLlm({ data: summaryFixture(['src/invented.ts']) });
    const { container } = makeContainer({ llm });
    const { repo, writes } = makeRepoStub();

    const outcome = await run(container, repo);

    expect(outcome.reason).toBe('parse_failed');
    expect(writes).toHaveLength(0);
  });
});

// ------------------------------------------------------ persistence + apportionment

describe('what is persisted (AC-33, AC-34, AC-35; NFR-1, plan D-1)', () => {
  it('AC-33 — every row carries the summary, head SHA, provider, model, tokens and cost', async () => {
    const llm = new StubLlm({
      data: summaryFixture(['src/config.ts', 'src/api/users.ts']),
      model: 'deepseek/deepseek-v4-flash',
      tokensIn: 2_400,
      tokensOut: 50,
      costUsd: 0.0042,
    });
    const { container } = makeContainer({ llm });
    const { repo, writes } = makeRepoStub();

    const outcome = await run(container, repo);

    for (const row of writes[0]!) {
      expect(row.prId).toBe('pr-1');
      expect(row.headSha).toBe(HEAD);
      expect(row.provider).toBe('openrouter');
      expect(row.model).toBe('deepseek/deepseek-v4-flash');
      expect(row.summary.length).toBeGreaterThan(0);
      expect(row.tokensIn).not.toBeNull();
      expect(row.tokensOut).not.toBeNull();
    }
    // D-1's exactness: the shares SUM to the call's own figures.
    expect(writes[0]!.reduce((n, r) => n + (r.costUsd ?? 0), 0)).toBe(0.0042);
    expect(writes[0]!.reduce((n, r) => n + (r.tokensIn ?? 0), 0)).toBe(2_400);
    expect(writes[0]!.reduce((n, r) => n + (r.tokensOut ?? 0), 0)).toBe(50);
    // …and the wire shape carries the same shares.
    expect(outcome.summaries!.reduce((n, s) => n + (s.cost_usd ?? 0), 0)).toBe(0.0042);
  });

  it('AC-34 — an unpriced model persists cost_usd null on EVERY row, never 0', async () => {
    const llm = new StubLlm({
      data: summaryFixture(['src/config.ts', 'src/api/users.ts']),
      costUsd: null,
    });
    const { container } = makeContainer({ llm });
    const { repo, writes } = makeRepoStub();

    await run(container, repo);

    expect(writes[0]!.map((r) => r.costUsd)).toEqual([null, null]);
  });

  it('AC-34 — a genuinely free model persists 0 on every row, never null', async () => {
    const llm = new StubLlm({
      data: summaryFixture(['src/config.ts', 'src/api/users.ts']),
      costUsd: 0,
    });
    const { container } = makeContainer({ llm });
    const { repo, writes } = makeRepoStub();

    await run(container, repo);

    expect(writes[0]!.map((r) => r.costUsd)).toEqual([0, 0]);
  });

  it('AC-35 — a rejected write still returns the derived summaries to the caller', async () => {
    const { container } = makeContainer();
    const outcome = await run(container, makeRejectingRepoStub());

    expect(outcome.reason).toBeUndefined();
    expect(outcome.summaries).toHaveLength(2);
    expect(log.events.some((e) => e.msg.includes('derived but not persisted'))).toBe(true);
  });

  it('NFR-1 — a derivation at the NFR-3 cap costs at most $0.02, summed across its rows', async () => {
    // THE PRICE IS STUBBED ON PURPOSE. Keeping it out of `pricing.ts` is what
    // makes this assertion honest independently of the shipped table — the
    // arithmetic, not the vendor's current number, is what NFR-1 fixes.
    // Real-world check, for the record: 48 000 × $0.088606/1M ≈ $0.00425 in,
    // plus ~700 out × $0.177212/1M ≈ $0.00012 → ≈ $0.0044, ~4.5× headroom.
    const STUB_PRICE = { in: 0.09, out: 0.18 }; // USD per 1M tokens
    const tokensIn = FILE_SUMMARY_PROMPT_TOKEN_CAP;
    const tokensOut = 700;
    const costUsd = (tokensIn * STUB_PRICE.in + tokensOut * STUB_PRICE.out) / 1_000_000;

    const files = Array.from({ length: 28 }, (_, i) => file(`src/f${i}.ts`, { additions: 100 - i }));
    const llm = new StubLlm({
      data: summaryFixture(files.map((f) => f.path)),
      tokensIn,
      tokensOut,
      costUsd,
    });
    const { container } = makeContainer({ files, llm });
    const { repo, writes } = makeRepoStub();

    await run(container, repo);

    const summed = writes[0]!.reduce((n, r) => n + (r.costUsd ?? 0), 0);
    expect(summed).toBe(costUsd);
    expect(summed).toBeLessThanOrEqual(0.02);
  });

  it('AC-20 / AC-21 — the cap omits a tail and the outcome records it', async () => {
    // Every fenced block costs 20 000 tokens, so only two fit the 48 000 budget.
    const files = Array.from({ length: 5 }, (_, i) => file(`src/f${i}.ts`, { additions: 100 - i }));
    const llm = new StubLlm({ data: summaryFixture(['src/f0.ts', 'src/f1.ts']) });
    const { container } = makeContainer({ files, llm, tokensPerBlock: 20_000 });
    const { repo, writes } = makeRepoStub();

    const outcome = await run(container, repo);

    expect(outcome.omitted).toEqual(['src/f2.ts', 'src/f3.ts', 'src/f4.ts']);
    expect(writes[0]!.map((r) => r.path)).toEqual(['src/f0.ts', 'src/f1.ts']);
  });
});

// -------------------------------------------------------------- the prompt + logs

describe('the prompt and the logs (AC-26; NFR-11)', () => {
  it('AC-26 — the rendered system prompt states that fenced content is data', async () => {
    const text = await renderPrompt('file-summary.system.md', {});
    expect(text).toContain('<untrusted>');
    expect(text.toUpperCase()).toContain('DATA');
    expect(text).toMatch(/never instructions/i);
  });

  it('NFR-11 — a successful derivation logs its outcome exactly once, and at `result`', async () => {
    const { container } = makeContainer();
    const { repo } = makeRepoStub();

    await run(container, repo);

    const exits = exitLines();
    expect(exits).toHaveLength(1);
    expect(exits[0]!.kind).toBe('result');
  });

  it.each([
    ['no_files', { files: [] as FileRow[] }],
    ['llm_unavailable', { llmThrows: true }],
    ['model_unsupported', { provider: 'openrouter' as const, structuredOutputs: false }],
  ])('NFR-11 — the %s exit logs exactly once, at `error`', async (_reason, opts) => {
    const { container } = makeContainer(opts);
    const { repo } = makeRepoStub();

    await run(container, repo);

    const exits = exitLines();
    expect(exits).toHaveLength(1);
    expect(exits[0]!.kind).toBe('error');
  });

  it('NFR-11 — a failed request logs exactly once, at `error`', async () => {
    const llm = new StubLlm({ data: {} }, new Error('502 upstream'));
    const { container } = makeContainer({ llm });
    const { repo } = makeRepoStub();

    await run(container, repo);

    const exits = exitLines();
    expect(exits).toHaveLength(1);
    expect(exits[0]!.kind).toBe('error');
  });

  it('NFR-11 — NO patch text and NO summary text appears in any log line', async () => {
    const { container } = makeContainer({ verbose: true });
    const { repo } = makeRepoStub();

    await run(container, repo);

    const everything = [
      ...log.events.map((e) => e.msg),
      ...log.stdout.map((s) => `${s.msg ?? ''} ${JSON.stringify(s.obj)}`),
    ].join('\n');
    expect(everything).not.toContain(PATCH_MARKER);
    expect(everything).not.toContain(SUMMARY_MARKER);
    // …while the provenance IS there: names and sizes only.
    expect(everything).toContain('file:src/config.ts');
  });
});
