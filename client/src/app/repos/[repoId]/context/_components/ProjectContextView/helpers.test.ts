/**
 * Path truncation (AC-14) and size formatting.
 *
 * AC-14 says "truncate at the head and keep the file's basename visible", and
 * AC-13 says the accessible name must be the FULL path. This helper is the only
 * place the two are allowed to diverge, so its edge cases are pinned here rather
 * than only through the rendered row.
 */
import { describe, it, expect } from "vitest";
import { truncatePathHead, formatBytes } from "./helpers";
import { PATH_MAX_CHARS } from "./constants";

describe("truncatePathHead", () => {
  it("returns a short path untouched", () => {
    expect(truncatePathHead("specs/api.md")).toBe("specs/api.md");
  });

  it("returns a path exactly at the budget untouched", () => {
    const path = `${"a".repeat(PATH_MAX_CHARS - 3)}/b.md`.slice(-PATH_MAX_CHARS);
    expect(truncatePathHead(path).startsWith("…")).toBe(false);
  });

  it("drops the head and keeps the basename when over the budget", () => {
    const path =
      "packages/services/billing/internal/docs/architecture/decisions/0042-keys.md";
    const out = truncatePathHead(path);

    expect(out.startsWith("…")).toBe(true);
    expect(out).toContain("0042-keys.md");
    expect(out).not.toBe(path);
    expect(Array.from(out).length).toBeLessThanOrEqual(PATH_MAX_CHARS);
  });

  it("keeps an over-long basename whole rather than cutting the filename", () => {
    const basename = `${"x".repeat(PATH_MAX_CHARS + 10)}.md`;
    const out = truncatePathHead(`docs/${basename}`);
    // Truncating INTO the filename would leave the row unidentifiable, which is
    // worse than overflowing its column.
    expect(out).toBe(`…${basename}`);
  });

  /**
   * Counted in code points, so a surrogate pair is never split into a lone
   * half — that would render as a replacement character and change the visible
   * basename. The accessible name is untouched either way (AC-13).
   */
  it("never splits a surrogate pair or an emoji", () => {
    const path = `docs/${"é".repeat(40)}/🔐-secrets.md`;
    const out = truncatePathHead(path);

    expect(out).toContain("🔐-secrets.md");
    expect(out).not.toContain("�");
    expect(Array.from(out).every((c) => c.codePointAt(0) !== 0xd83d)).toBe(true);
  });

  it("handles a path with no directory component", () => {
    expect(truncatePathHead("a.md")).toBe("a.md");
  });
});

describe("formatBytes", () => {
  it("formats bytes, kilobytes and null", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(2048)).toBe("2.0 KB");
    expect(formatBytes(400 * 1024)).toBe("400 KB");
    expect(formatBytes(null)).toBeNull();
  });
});
