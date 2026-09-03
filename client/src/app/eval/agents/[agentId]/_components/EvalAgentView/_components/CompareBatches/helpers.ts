import { PROMPT_DIFF_MAX_CHARS } from "./constants";

/** One line of the AC-97 diff. `kind` is what the a11y tree carries. */
export interface DiffLine {
  kind: "added" | "removed" | "unchanged";
  text: string;
}

/**
 * AC-96 / AC-97 — a line-level diff of two system prompts.
 *
 * A longest-common-subsequence diff, computed in O(n·m) over the LINE arrays.
 * Both sides are truncated to 8 000 characters first (AC-98), so n and m are
 * bounded and the quadratic table can never blow up on a 40 000-character
 * prompt.
 *
 * Pure: no React, no I/O, so the marking rule is unit-testable on its own.
 */
export function diffLines(before: string, after: string): DiffLine[] {
  const a = truncate(before).split("\n");
  const b = truncate(after).split("\n");

  // lcs[i][j] = length of the longest common subsequence of a[i:] and b[j:].
  const lcs: number[][] = Array.from({ length: a.length + 1 }, () =>
    new Array<number>(b.length + 1).fill(0),
  );
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }

  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push({ kind: "unchanged", text: a[i]! });
      i += 1;
      j += 1;
    } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) {
      out.push({ kind: "removed", text: a[i]! });
      i += 1;
    } else {
      out.push({ kind: "added", text: b[j]! });
      j += 1;
    }
  }
  while (i < a.length) out.push({ kind: "removed", text: a[i++]! });
  while (j < b.length) out.push({ kind: "added", text: b[j++]! });
  return out;
}

/** AC-98 — a 40 000-character prompt must not be rendered whole. */
export function truncate(text: string): string {
  return text.length > PROMPT_DIFF_MAX_CHARS ? text.slice(0, PROMPT_DIFF_MAX_CHARS) : text;
}

export function wasTruncated(...texts: string[]): boolean {
  return texts.some((x) => x.length > PROMPT_DIFF_MAX_CHARS);
}
