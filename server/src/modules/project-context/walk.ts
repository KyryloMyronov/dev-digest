/**
 * project-context — the Markdown document walk (AC-1, AC-2, AC-6; NFR-5).
 *
 * Walks a clone directory and returns every `.md` file whose clone-relative path
 * has a directory segment in `CONTEXT_ROOTS`, at any depth, tagged with the
 * LEFTMOST matching segment.
 *
 * Templated on `repo-intel/pipeline/walk.ts`, which establishes that a
 * module-local walk over `node:fs/promises` is fine here — `node:fs` is a core
 * module and not an SDK, so it needs no adapter.
 *
 * ─── THREE DELIBERATE DIVERGENCES FROM THAT TEMPLATE ────────────────────────
 * Each will look like a bug to a reviewer who knows `pipeline/walk.ts`. They
 * are not; the reasons are load-bearing.
 *
 *   1. **No size filter.** The template drops files over `MAX_FILE_SIZE`.
 *      NFR-5 requires a 400 KB document to be *listed and previewable*, so the
 *      cap moves to read time only (`MAX_CONTEXT_DOCUMENT_BYTES`, AC-49). We
 *      return `size` from `stat()` and let the read path enforce it.
 *
 *   2. **Any-depth root matching (D-Q6a).** This is a full-clone walk with
 *      `EXCLUDED_DIRS` pruning, not a walk of three top-level directories. A
 *      file is a candidate iff its extension is `.md` AND some directory segment
 *      of its clone-relative path is in `CONTEXT_ROOTS`. The LEFTMOST match
 *      supplies AC-2's tag, so `docs/specs/x.md` is tagged `docs`.
 *
 *   3. **The cap reports its overflow instead of swallowing it.** The template
 *      records `stats.bounded`; AC-6 needs the omitted *number* in the response,
 *      so `total` is captured BEFORE truncation and returned alongside.
 *
 * `EXCLUDED_DIRS` is imported from `repo-intel/constants.ts` rather than
 * re-declared — that is legal (`constants.ts` is a module's public surface) and
 * it keeps the two walks agreeing on what is skipped. Note it prunes `vendor`,
 * so `server/src/vendor/**` and `client/src/vendor/**` documents are out of
 * scope by inheritance. `.gitignore` is NOT honoured (D-Q6c declined REC-4);
 * `EXCLUDED_DIRS` is the only thing holding the count down, and a repository
 * with a committed vendored tree outside those eight names will hit the cap.
 *
 * Measured on THIS repository: any-depth roots with `EXCLUDED_DIRS` applied
 * yield ~25 documents, so the 500 cap does not bite here (it would be ~111
 * without the pruning).
 */
import { readdir, stat } from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import { extname, join, relative, sep } from 'node:path';
import type { ContextDocSource } from '@devdigest/shared';
import { EXCLUDED_DIRS } from '../repo-intel/constants.js';
import { CONTEXT_ROOTS, MAX_CONTEXT_DOCUMENTS } from './constants.js';

const EXCLUDED_SET: ReadonlySet<string> = new Set(EXCLUDED_DIRS);
const ROOT_SET: ReadonlySet<string> = new Set(CONTEXT_ROOTS);

const MARKDOWN_EXT = '.md';

/** One discovered document, before token counts and attach counts are joined. */
export interface WalkedDoc {
  /** Clone-relative path, forward slashes (platform-agnostic, like `pr_files.path`). */
  path: string;
  /** AC-2 — the leftmost matching root segment. */
  source: ContextDocSource;
  /** Size in bytes, or null when the file could not be stat'd. */
  size: number | null;
}

export interface WalkContextResult {
  /** At most `MAX_CONTEXT_DOCUMENTS`, alphabetical by path. */
  files: WalkedDoc[];
  /** Candidates found BEFORE the cap (AC-6). */
  total: number;
  /** `total - files.length`. */
  omitted: number;
}

/**
 * The leftmost directory segment of `relPath` that is a configured root, or
 * null when there is none. Only DIRECTORY segments count — the final segment is
 * the filename, so `specs.md` at the clone root is not a match.
 */
export function sourceForPath(relPath: string): ContextDocSource | null {
  const segments = relPath.split('/');
  for (let i = 0; i < segments.length - 1; i += 1) {
    const seg = segments[i]!;
    if (ROOT_SET.has(seg)) return seg as ContextDocSource;
  }
  return null;
}

/**
 * Walk `root`, returning the capped document list plus the honest pre-cap total.
 *
 * Unreadable directories are swallowed (permissions, dangling symlink) so the
 * walk keeps making progress on the parts of the clone it CAN read, and symlinks
 * are never followed (loops, perf) — both as the template does.
 */
export async function walkContextDocs(root: string): Promise<WalkContextResult> {
  const found: WalkedDoc[] = [];
  await walkDir(root, root, found);

  // Stable order: alphabetical relpath, so "the first N" under the cap is
  // reproducible across runs and AC-6's "in path order" is honest.
  found.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  const total = found.length;
  const files = total > MAX_CONTEXT_DOCUMENTS ? found.slice(0, MAX_CONTEXT_DOCUMENTS) : found;
  return { files, total, omitted: total - files.length };
}

async function walkDir(root: string, dir: string, out: WalkedDoc[]): Promise<void> {
  let entries: Dirent[];
  try {
    entries = (await readdir(dir, { withFileTypes: true })) as Dirent[];
  } catch {
    // Unreadable directory — skip cleanly rather than failing the whole walk.
    return;
  }

  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue; // never follow symlinks (loops, perf)
    const name = entry.name;

    if (entry.isDirectory()) {
      if (EXCLUDED_SET.has(name)) continue;
      await walkDir(root, join(dir, name), out);
      continue;
    }

    if (!entry.isFile()) continue;
    if (extname(name).toLowerCase() !== MARKDOWN_EXT) continue;

    const full = join(dir, name);
    const rel = relative(root, full).split(sep).join('/');
    const source = sourceForPath(rel);
    if (!source) continue;

    // NO size filter here, on purpose — divergence (1) in the header. `stat`
    // is called for the reported size only; a failure leaves `size` null rather
    // than dropping a document the user can see on disk.
    let size: number | null = null;
    try {
      size = (await stat(full)).size;
    } catch {
      size = null;
    }

    out.push({ path: rel, source, size });
  }
}
