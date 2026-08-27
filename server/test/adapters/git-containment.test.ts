/**
 * SPEC-01 AC-61 / AC-62 — `SimpleGitClient.readFile` containment guard.
 *
 * Hermetic: a real temp directory standing in for the clone dir, no git, no DB.
 * The guard is a pure path assertion made BEFORE any fs call, which is what
 * AC-62's "shall not read the file" needs — so the escape cases are asserted
 * against an fs spy that must never fire.
 *
 * `vi.mock` rather than `vi.spyOn(fsp, 'readFile')`: the adapter imports
 * `readFile` as a NAMED binding, and an ESM namespace object's properties are
 * non-configurable, so `spyOn` both throws ("Cannot redefine property") and
 * would not have intercepted that binding anyway. The factory delegates to the
 * real module so every other fs call in this file behaves normally.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { SimpleGitClient } from '../../src/adapters/git/simple-git.js';
import { ValidationError } from '../../src/platform/errors.js';

const readFileSpy = vi.hoisted(() => vi.fn());

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    readFile: (...args: unknown[]) => {
      readFileSpy(...args);
      return (actual.readFile as (...a: unknown[]) => unknown)(...args);
    },
  };
});

const REPO = { owner: 'acme', name: 'payments-api' };

describe('SimpleGitClient.readFile — clone containment (AC-61, AC-62)', () => {
  let cloneDir: string;
  let git: SimpleGitClient;

  beforeEach(async () => {
    readFileSpy.mockClear();
    cloneDir = await mkdtemp(join(tmpdir(), 'git-containment-'));
    await mkdir(join(cloneDir, REPO.owner, REPO.name, 'specs'), { recursive: true });
    await writeFile(join(cloneDir, REPO.owner, REPO.name, 'specs', 'a.md'), '# spec a\n');
    git = new SimpleGitClient(cloneDir);
  });

  afterEach(async () => {
    await rm(cloneDir, { recursive: true, force: true });
  });

  // AC-61 — an in-clone path resolves and is read.
  it('reads a path inside the clone and resolves it under the clone root', async () => {
    const text = await git.readFile(REPO, 'specs/a.md');

    expect(text).toBe('# spec a\n');
    // The resolved path handed to fs is the one under this repo's clone root —
    // AC-61's "resolve the joined path" observed on the call arguments.
    expect(readFileSpy).toHaveBeenCalledTimes(1);
    expect(readFileSpy.mock.calls[0]![0]).toBe(
      resolve(join(cloneDir, REPO.owner, REPO.name, 'specs', 'a.md')),
    );
  });

  // AC-62 — traversal is rejected with validation_error and performs no read.
  it.each([
    ['../../../etc/passwd'],
    ['specs/../../../../etc/passwd'],
    ['..'],
    ['../'],
    ['specs/../..'],
  ])('rejects %s with validation_error and never touches the disk', async (bad) => {
      await expect(git.readFile(REPO, bad)).rejects.toThrow(ValidationError);
      await expect(git.readFile(REPO, bad)).rejects.toMatchObject({
        code: 'validation_error',
        statusCode: 422,
      });
    expect(readFileSpy).not.toHaveBeenCalled();
  });

  /**
   * An ABSOLUTE path is neutralised, not rejected — and that is the ordering
   * the guard depends on. `join(root, '/etc/passwd')` yields `<root>/etc/passwd`
   * (a leading separator is just a separator to `join`), so the read stays
   * inside the clone and simply misses. Had the guard been written as
   * `resolve(root, relPath)` instead of `resolve(join(root, relPath))`, the
   * absolute argument would have WON and escaped to `/etc/passwd`. This test is
   * what pins that ordering.
   */
  it('neutralises an absolute path into a clone-relative read rather than escaping', async () => {
    await expect(git.readFile(REPO, '/etc/passwd')).rejects.toMatchObject({ code: 'ENOENT' });
    expect(readFileSpy).toHaveBeenCalledTimes(1);
    expect(readFileSpy.mock.calls[0]![0]).toBe(
      resolve(join(cloneDir, REPO.owner, REPO.name, 'etc', 'passwd')),
    );
  });

  /**
   * The sibling-prefix case the plan calls out explicitly: a bare
   * `startsWith(root)` would accept this, because `/…/payments-api-evil`
   * starts with `/…/payments-api`. The guard requires root + separator.
   */
  it('rejects a sibling directory whose name merely prefixes the clone root', async () => {
    await mkdir(join(cloneDir, REPO.owner, `${REPO.name}-evil`), { recursive: true });
    await writeFile(join(cloneDir, REPO.owner, `${REPO.name}-evil`, 'secret.md'), 'secret');

    await expect(git.readFile(REPO, `../${REPO.name}-evil/secret.md`)).rejects.toThrow(
      ValidationError,
    );
    expect(readFileSpy).not.toHaveBeenCalled();
  });

  /**
   * Symlink-shaped case, asserted HONESTLY rather than aspirationally.
   *
   * The guard is a *lexical* containment check (`path.resolve`), which is what
   * the spec's *Path traversal* section specifies. `resolve()` does not consult
   * the filesystem, so a symlink that LIVES inside the clone and points outside
   * it is lexically contained and the read follows it. Closing that would need
   * `realpath` on every read (an extra stat per read, plus a different failure
   * mode when the target does not exist), which is not what AC-61 describes.
   *
   * This test pins the current, deliberate behaviour so a future change to
   * `realpath` is a visible decision rather than a silent one. What the guard
   * DOES stop is the whole `..`-traversal family above, which is the vector
   * SPEC-01 names: a request parameter reaching `readFile`.
   */
  it('does not follow-check a symlink target (lexical containment, documented limit)', async () => {
    const outside = join(cloneDir, 'outside.md');
    await writeFile(outside, 'outside the clone');
    await symlink(outside, join(cloneDir, REPO.owner, REPO.name, 'link.md'));

    // Lexically contained → allowed, and the symlink is followed by fs.
    await expect(git.readFile(REPO, 'link.md')).resolves.toBe('outside the clone');
  });
});
