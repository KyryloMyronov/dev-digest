import { describe, it, expect } from 'vitest';
import { parseUnifiedDiff } from '../src/adapters/git/diff-parser.js';
import { diffFromPrFiles } from '../src/modules/brief/diff.js';
import type { Container } from '../src/platform/container.js';

/**
 * SPEC-02 OQ-4 — closed by fixture rather than by reading the control flow.
 *
 * `parseUnifiedDiff` had no colocated test, and SPEC-02's claim that binary,
 * rename-only and mode-only files are genuinely ABSENT from `diff.files` rested
 * on one: `current.path` is set only from a `+++` line, and the parser ends with
 * `files.filter((f) => f.path)`. These fixtures pin that.
 *
 * It matters because it is what makes "file not present in diff" the honest
 * drop reason for a risk citing such a file (AC-25), rather than "no hunk
 * intersects" (AC-26).
 */

describe('parseUnifiedDiff — stanzas that carry no `+++` line', () => {
  it('yields no file for a BINARY stanza', () => {
    const raw = `diff --git a/assets/logo.png b/assets/logo.png
index 1234567..89abcde 100644
Binary files a/assets/logo.png and b/assets/logo.png differ`;
    expect(parseUnifiedDiff(raw).files).toEqual([]);
  });

  it('yields no file for a RENAME-ONLY stanza', () => {
    const raw = `diff --git a/src/old.ts b/src/new.ts
similarity index 100%
rename from src/old.ts
rename to src/new.ts`;
    expect(parseUnifiedDiff(raw).files).toEqual([]);
  });

  it('yields no file for a MODE-ONLY stanza', () => {
    const raw = `diff --git a/scripts/run.sh b/scripts/run.sh
old mode 100644
new mode 100755`;
    expect(parseUnifiedDiff(raw).files).toEqual([]);
  });

  it('keeps the ordinary files alongside them', () => {
    const raw = `diff --git a/assets/logo.png b/assets/logo.png
Binary files a/assets/logo.png and b/assets/logo.png differ
diff --git a/src/a.ts b/src/a.ts
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,1 +1,2 @@
 const a = 1;
+const b = 2;
diff --git a/scripts/run.sh b/scripts/run.sh
old mode 100644
new mode 100755`;
    const diff = parseUnifiedDiff(raw);
    expect(diff.files.map((f) => f.path)).toEqual(['src/a.ts']);
    expect(diff.files[0]!.additions).toBe(1);
    expect(diff.files[0]!.hunks[0]!.newLineNumbers).toEqual([1, 2]);
  });
});

describe('the pr_files reconstruction path', () => {
  function container(files: { path: string; patch: string | null }[]): Container {
    return { pullsRepo: { listFiles: async () => files } } as unknown as Container;
  }

  it('skips a row whose patch is null BEFORE it emits a +++ header', async () => {
    const diff = await diffFromPrFiles(
      container([
        { path: 'assets/logo.png', patch: null },
        { path: 'src/a.ts', patch: '@@ -1,0 +1,1 @@\n+const a = 1;' },
      ]),
      'pr-1',
    );
    expect(diff.files.map((f) => f.path)).toEqual(['src/a.ts']);
    // The binary file never reached the raw text at all, so nothing downstream
    // can mistake it for a file with no hunks.
    expect(diff.raw).not.toContain('assets/logo.png');
  });
});
