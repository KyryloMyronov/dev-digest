import { PATH_MAX_CHARS } from "./constants";

/**
 * Head-truncate a path for display, keeping the basename intact (AC-14).
 *
 * PRESENTATIONAL ONLY. The row's accessible name is set from the raw, untouched
 * path (AC-13), so unicode, emoji and RTL paths pass through unchanged to
 * assistive technology no matter what this returns. The two criteria pull in
 * opposite directions and this is the seam where they are kept apart.
 *
 * Head truncation rather than tail: the end of a path (`.../auth/login.md`) is
 * what identifies a document; the front is usually shared boilerplate.
 */
export function truncatePathHead(path: string, max = PATH_MAX_CHARS): string {
  // Count in code points, not UTF-16 units, so a surrogate pair or an emoji is
  // never split in half.
  const chars = Array.from(path);
  if (chars.length <= max) return path;

  const slash = path.lastIndexOf("/");
  const basename = slash === -1 ? path : path.slice(slash + 1);
  const baseChars = Array.from(basename);
  // A basename longer than the budget is shown whole — dropping part of the
  // filename would leave the row unidentifiable, which is worse than overflow.
  if (baseChars.length >= max - 1) return `…${basename}`;

  const keep = max - 1 - baseChars.length;
  return `…${chars.slice(chars.length - keep - baseChars.length).join("")}`;
}

/** `1.2 KB` / `412 B` — a size a reviewer can read at a glance. */
export function formatBytes(bytes: number | null): string | null {
  if (bytes === null) return null;
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
}
