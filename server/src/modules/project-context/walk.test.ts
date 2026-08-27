/**
 * project-context — walk unit tests (AC-1, AC-2, AC-6; NFR-5).
 *
 * Hermetic: a temp dir on disk, no DB, no git. Covers the three deliberate
 * divergences from `repo-intel/pipeline/walk.ts` explicitly, so a future reader
 * who "fixes" one of them fails a named test rather than silently changing
 * behaviour.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm, symlink, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { walkContextDocs, sourceForPath } from './walk.js';
import { MAX_CONTEXT_DOCUMENTS, MAX_CONTEXT_DOCUMENT_BYTES } from './constants.js';

async function write(root: string, rel: string, contents = 'x'): Promise<void> {
  const full = join(root, rel);
  await mkdir(dirname(full), { recursive: true });
  await writeFile(full, contents);
}

describe('sourceForPath — AC-2 leftmost-segment tie-break', () => {
  it('tags by the leftmost matching directory segment', () => {
    expect(sourceForPath('docs/specs/x.md')).toBe('docs');
    expect(sourceForPath('specs/docs/x.md')).toBe('specs');
    expect(sourceForPath('a/b/insights/x.md')).toBe('insights');
  });

  it('matches at any depth, not only the clone root (D-Q6a)', () => {
    expect(sourceForPath('packages/api/docs/api.md')).toBe('docs');
  });

  it('ignores a non-directory match — the filename segment never counts', () => {
    expect(sourceForPath('specs.md')).toBeNull();
    expect(sourceForPath('a/docs.md')).toBeNull();
  });

  it('returns null when no segment is a configured root', () => {
    expect(sourceForPath('README.md')).toBeNull();
    expect(sourceForPath('src/lib/notes.md')).toBeNull();
  });
});

describe('walkContextDocs', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'project-context-walk-'));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  // AC-1 — every .md under a configured root, at any depth.
  it('returns every .md under a configured root at any depth, and nothing else', async () => {
    await write(root, 'specs/a.md');
    await write(root, 'docs/guide/b.md');
    await write(root, 'packages/api/docs/c.md');
    await write(root, 'insights/d.md');
    await write(root, 'README.md'); // not under a root
    await write(root, 'specs/notes.txt'); // not markdown
    await write(root, 'src/index.ts'); // neither

    const res = await walkContextDocs(root);

    expect(res.files.map((f) => f.path)).toEqual([
      'docs/guide/b.md',
      'insights/d.md',
      'packages/api/docs/c.md',
      'specs/a.md',
    ]);
    expect(res.total).toBe(4);
    expect(res.omitted).toBe(0);
  });

  // AC-2 — the tag, observed on the walk's own output.
  it('tags each document with its leftmost root segment', async () => {
    await write(root, 'docs/specs/x.md');
    await write(root, 'specs/y.md');

    const res = await walkContextDocs(root);
    const byPath = new Map(res.files.map((f) => [f.path, f.source]));

    expect(byPath.get('docs/specs/x.md')).toBe('docs');
    expect(byPath.get('specs/y.md')).toBe('specs');
  });

  it('prunes EXCLUDED_DIRS, including vendor trees', async () => {
    await write(root, 'specs/keep.md');
    await write(root, 'node_modules/pkg/docs/skip.md');
    await write(root, 'dist/docs/skip.md');
    await write(root, 'src/vendor/shared/docs/skip.md');

    const res = await walkContextDocs(root);

    expect(res.files.map((f) => f.path)).toEqual(['specs/keep.md']);
    expect(res.total).toBe(1);
  });

  /**
   * DIVERGENCE 1 (no size filter) + NFR-5: a 400 KB document must be LISTED.
   * `pipeline/walk.ts` would have dropped this file; dropping it here would
   * make NFR-5 unsatisfiable, because a document that is not listed cannot be
   * previewed. The size cap lives at read time only.
   */
  it('lists a document at MAX_CONTEXT_DOCUMENT_BYTES and reports its size (NFR-5)', async () => {
    const big = 'a'.repeat(MAX_CONTEXT_DOCUMENT_BYTES);
    await write(root, 'specs/big.md', big);

    const res = await walkContextDocs(root);

    expect(res.files).toHaveLength(1);
    expect(res.files[0]!.size).toBe(MAX_CONTEXT_DOCUMENT_BYTES);
  });

  /**
   * DIVERGENCE 3 (cap with the overflow reported): AC-6 needs both numbers, so
   * `total` is captured before truncation. 600 files > the 500 cap.
   */
  it('caps at MAX_CONTEXT_DOCUMENTS and reports the omitted count (AC-6)', async () => {
    const count = 600;
    await Promise.all(
      Array.from({ length: count }, (_, i) =>
        write(root, `specs/doc-${String(i).padStart(4, '0')}.md`),
      ),
    );

    const res = await walkContextDocs(root);

    expect(res.files).toHaveLength(MAX_CONTEXT_DOCUMENTS);
    expect(res.total).toBe(count);
    expect(res.omitted).toBe(count - MAX_CONTEXT_DOCUMENTS);
    // "the FIRST 500 in path order" — the alphabetical sort happens before the
    // slice, so the boundary is deterministic across runs.
    expect(res.files[0]!.path).toBe('specs/doc-0000.md');
    expect(res.files[MAX_CONTEXT_DOCUMENTS - 1]!.path).toBe(
      `specs/doc-${String(MAX_CONTEXT_DOCUMENTS - 1).padStart(4, '0')}.md`,
    );
  });

  it('swallows an unreadable directory and keeps the rest of the walk', async () => {
    await write(root, 'specs/keep.md');
    const locked = join(root, 'docs', 'locked');
    await mkdir(locked, { recursive: true });
    await write(root, 'docs/locked/hidden.md');
    await chmod(locked, 0o000);

    try {
      const res = await walkContextDocs(root);
      // The readable half survives; nothing throws.
      expect(res.files.map((f) => f.path)).toContain('specs/keep.md');
    } finally {
      await chmod(locked, 0o755);
    }
  });

  it('never follows a symlink, neither a file nor a directory one', async () => {
    await write(root, 'specs/real.md');
    await write(root, 'outside/secret.md');
    await symlink(join(root, 'outside', 'secret.md'), join(root, 'specs', 'link.md'));
    await symlink(join(root, 'outside'), join(root, 'docs'));

    const res = await walkContextDocs(root);

    expect(res.files.map((f) => f.path)).toEqual(['specs/real.md']);
  });
});
