/**
 * project-context service — hermetic unit tests.
 *
 * Covers AC-1, AC-2, AC-4, AC-6 and AC-11's server half plus NFR-5's read-time
 * cap. A tmpdir stands in for the clone, an in-memory repository stub for the
 * three tables, and a `GitClient` reading that tmpdir is injected through the
 * container — no Postgres, no git.
 *
 * The tenancy criteria (AC-3, AC-15, AC-30, AC-34, AC-36) live in
 * `test/project-context.it.test.ts` instead: they need real persisted rows and a
 * second `workspace_id`, which a stub cannot prove.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Container } from '../../platform/container.js';
import { AppError } from '../../platform/errors.js';
import { ProjectContextService } from './service.js';
import type { ProjectContextRepository } from './repository.js';
import { MAX_CONTEXT_DOCUMENTS, MAX_CONTEXT_DOCUMENT_BYTES } from './constants.js';

const WS = 'ws-1';
const REPO_ID = 'repo-1';

function makeRepoStub(opts: {
  clonePath: string | null;
  tokens?: Record<string, number>;
  attachCounts?: Record<string, number>;
  scannedAt?: Date | null;
  missingRepo?: boolean;
}) {
  const stub = {
    repoForContext: async () =>
      opts.missingRepo
        ? null
        : {
            owner: 'acme',
            name: 'payments-api',
            fullName: 'acme/payments-api',
            clonePath: opts.clonePath,
          },
    tokensForRepo: async () => new Map(Object.entries(opts.tokens ?? {})),
    agentCountsByPath: async () => new Map(Object.entries(opts.attachCounts ?? {})),
    lastScanAt: async () => opts.scannedAt ?? null,
  };
  return stub as unknown as ProjectContextRepository;
}

function makeContainer(root: string): Container {
  return {
    db: {},
    git: {
      readFile: async (_ref: { owner: string; name: string }, p: string) =>
        (await import('node:fs/promises')).readFile(join(root, p), 'utf8'),
    },
  } as unknown as Container;
}

async function write(root: string, rel: string, contents = 'x'): Promise<void> {
  const full = join(root, rel);
  await mkdir(dirname(full), { recursive: true });
  await writeFile(full, contents);
}

describe('ProjectContextService.list', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'project-context-svc-'));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  // AC-1 + AC-2 — observed on the parsed envelope, not on the walk.
  it('returns every document under a configured root, tagged by its leftmost segment', async () => {
    await write(root, 'specs/api.md');
    await write(root, 'docs/specs/nested.md');
    await write(root, 'packages/web/docs/ui.md');
    await write(root, 'README.md');

    const svc = new ProjectContextService(makeContainer(root), makeRepoStub({ clonePath: root }));
    const res = await svc.list(WS, REPO_ID);

    expect(res.files.map((f) => [f.path, f.source])).toEqual([
      ['docs/specs/nested.md', 'docs'],
      ['packages/web/docs/ui.md', 'docs'],
      ['specs/api.md', 'specs'],
    ]);
    expect(res.total).toBe(3);
    expect(res.omitted).toBe(0);
  });

  // AC-30 + AC-34, at the payload level: the persisted count, else null.
  it('serves the persisted token count and null when there is no cached row', async () => {
    await write(root, 'specs/counted.md');
    await write(root, 'specs/uncounted.md');

    const svc = new ProjectContextService(
      makeContainer(root),
      makeRepoStub({ clonePath: root, tokens: { 'specs/counted.md': 417 } }),
    );
    const res = await svc.list(WS, REPO_ID);
    const byPath = new Map(res.files.map((f) => [f.path, f.tokens]));

    expect(byPath.get('specs/counted.md')).toBe(417);
    // `null`, not absent and not 0 — the studio branches on it (AC-35).
    expect(byPath.get('specs/uncounted.md')).toBeNull();
    expect(Object.keys(res.files[0]!)).toContain('tokens');
  });

  // AC-15's payload half; the count itself is proven against real rows in the it-test.
  it('carries the attaching-agent count, defaulting to an honest zero', async () => {
    await write(root, 'specs/a.md');
    await write(root, 'specs/b.md');

    const svc = new ProjectContextService(
      makeContainer(root),
      makeRepoStub({ clonePath: root, attachCounts: { 'specs/a.md': 3 } }),
    );
    const res = await svc.list(WS, REPO_ID);
    const byPath = new Map(res.files.map((f) => [f.path, f.attached_agents]));

    expect(byPath.get('specs/a.md')).toBe(3);
    expect(byPath.get('specs/b.md')).toBe(0);
  });

  // AC-16's server half.
  it('reports scanned_at as an ISO string, or null when never scanned', async () => {
    await write(root, 'specs/a.md');
    const when = new Date('2026-08-27T10:00:00.000Z');

    const scanned = await new ProjectContextService(
      makeContainer(root),
      makeRepoStub({ clonePath: root, scannedAt: when }),
    ).list(WS, REPO_ID);
    expect(scanned.scanned_at).toBe('2026-08-27T10:00:00.000Z');

    const never = await new ProjectContextService(
      makeContainer(root),
      makeRepoStub({ clonePath: root, scannedAt: null }),
    ).list(WS, REPO_ID);
    expect(never.scanned_at).toBeNull();
  });

  // AC-6 — the cap and the omitted number, on the envelope.
  it('caps the list and reports how many were omitted', async () => {
    const count = MAX_CONTEXT_DOCUMENTS + 100;
    await Promise.all(
      Array.from({ length: count }, (_, i) =>
        write(root, `specs/d-${String(i).padStart(4, '0')}.md`),
      ),
    );

    const svc = new ProjectContextService(makeContainer(root), makeRepoStub({ clonePath: root }));
    const res = await svc.list(WS, REPO_ID);

    expect(res.files).toHaveLength(MAX_CONTEXT_DOCUMENTS);
    expect(res.total).toBe(count);
    expect(res.omitted).toBe(100);
  });

  it('returns an empty envelope, not an error, for a clone with no documents', async () => {
    await write(root, 'src/index.ts');

    const svc = new ProjectContextService(makeContainer(root), makeRepoStub({ clonePath: root }));
    const res = await svc.list(WS, REPO_ID);

    expect(res).toEqual({ files: [], total: 0, omitted: 0, scanned_at: null });
  });

  // AC-4 — both halves of "no clone directory on disk".
  it('throws 409 repo_not_cloned when clone_path is null', async () => {
    const svc = new ProjectContextService(makeContainer(root), makeRepoStub({ clonePath: null }));

    await expect(svc.list(WS, REPO_ID)).rejects.toMatchObject({
      code: 'repo_not_cloned',
      statusCode: 409,
    });
  });

  it('throws 409 repo_not_cloned when clone_path points at nothing on disk', async () => {
    const svc = new ProjectContextService(
      makeContainer(root),
      makeRepoStub({ clonePath: join(root, 'gone') }),
    );

    const err = await svc.list(WS, REPO_ID).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).code).toBe('repo_not_cloned');
    // The message names the repository, which is what AC-5's copy renders.
    expect((err as AppError).message).toContain('acme/payments-api');
  });

  it('404s a repo id that does not resolve in this workspace', async () => {
    const svc = new ProjectContextService(
      makeContainer(root),
      makeRepoStub({ clonePath: root, missingRepo: true }),
    );

    await expect(svc.list(WS, REPO_ID)).rejects.toMatchObject({
      code: 'repo_not_found',
      statusCode: 404,
    });
  });

  // NFR-5 — a 400 KB document must be LISTED (it is previewable below).
  it('lists a document at the 400 KB limit', async () => {
    await write(root, 'specs/big.md', 'a'.repeat(MAX_CONTEXT_DOCUMENT_BYTES));

    const svc = new ProjectContextService(makeContainer(root), makeRepoStub({ clonePath: root }));
    const res = await svc.list(WS, REPO_ID);

    expect(res.files).toHaveLength(1);
    expect(res.files[0]!.size).toBe(MAX_CONTEXT_DOCUMENT_BYTES);
  });
});

describe('ProjectContextService.readDoc', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'project-context-read-'));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  // AC-11, server half.
  it('returns a discovered document’s text with its path and size', async () => {
    const body = '# API spec\n\nSome **markdown**.\n';
    await write(root, 'specs/api.md', body);

    const svc = new ProjectContextService(makeContainer(root), makeRepoStub({ clonePath: root }));

    await expect(svc.readDoc(WS, REPO_ID, 'specs/api.md')).resolves.toEqual({
      path: 'specs/api.md',
      content: body,
      size: Buffer.byteLength(body),
    });
  });

  // NFR-5's other half: at the limit it is previewable, past it it is not.
  it('previews a document at exactly the 400 KB cap', async () => {
    await write(root, 'specs/big.md', 'a'.repeat(MAX_CONTEXT_DOCUMENT_BYTES));
    const svc = new ProjectContextService(makeContainer(root), makeRepoStub({ clonePath: root }));

    const res = await svc.readDoc(WS, REPO_ID, 'specs/big.md');
    expect(res.size).toBe(MAX_CONTEXT_DOCUMENT_BYTES);
  });

  it('refuses a document over the 400 KB cap without reading it', async () => {
    await write(root, 'specs/huge.md', 'a'.repeat(MAX_CONTEXT_DOCUMENT_BYTES + 1));
    const svc = new ProjectContextService(makeContainer(root), makeRepoStub({ clonePath: root }));

    await expect(svc.readDoc(WS, REPO_ID, 'specs/huge.md')).rejects.toMatchObject({
      code: 'doc_too_large',
      statusCode: 413,
    });
  });

  /**
   * Membership is checked against the WALK, not against the parameter. That is
   * what makes the adapter's containment guard (AC-61/62) a second line of
   * defence rather than the only one: a traversal never even reaches it, and a
   * real file outside the configured roots is not readable through this route.
   */
  it('404s doc_not_found for a path outside the discovered set', async () => {
    await write(root, 'specs/a.md');
    await write(root, 'src/secret.ts', 'const KEY = 1;');
    const svc = new ProjectContextService(makeContainer(root), makeRepoStub({ clonePath: root }));

    for (const bad of ['specs/missing.md', 'src/secret.ts', '../../../etc/passwd']) {
      await expect(svc.readDoc(WS, REPO_ID, bad)).rejects.toMatchObject({
        code: 'doc_not_found',
        statusCode: 404,
      });
    }
  });

  it('throws 409 repo_not_cloned before attempting any read', async () => {
    const svc = new ProjectContextService(makeContainer(root), makeRepoStub({ clonePath: null }));

    await expect(svc.readDoc(WS, REPO_ID, 'specs/a.md')).rejects.toMatchObject({
      code: 'repo_not_cloned',
      statusCode: 409,
    });
  });
});
