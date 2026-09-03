import type { CSSProperties } from "react";

/** Co-located styles for CompareBatches. */
export const s = {
  table: { width: "100%", borderCollapse: "collapse", fontSize: 13, marginBottom: 18 } satisfies CSSProperties,
  th: {
    textAlign: "left",
    padding: "8px 10px",
    color: "var(--text-secondary)",
    fontWeight: 500,
    borderBottom: "1px solid var(--border)",
  } satisfies CSSProperties,
  td: { padding: "8px 10px", borderBottom: "1px solid var(--border)" } satisfies CSSProperties,
  sectionLabel: {
    fontSize: 12,
    letterSpacing: "0.06em",
    color: "var(--text-secondary)",
    margin: "16px 0 8px",
  } satisfies CSSProperties,
  diff: {
    margin: 0,
    padding: 12,
    borderRadius: 8,
    border: "1px solid var(--border)",
    background: "var(--code-bg)",
    fontSize: 12.5,
    maxHeight: 320,
    overflow: "auto",
  } satisfies CSSProperties,
  line: (kind: "added" | "removed" | "unchanged"): CSSProperties => ({
    display: "block",
    whiteSpace: "pre-wrap",
    background:
      kind === "added" ? "var(--code-add)" : kind === "removed" ? "var(--code-del)" : "transparent",
  }),
  notice: { fontSize: 13, color: "var(--text-secondary)" } satisfies CSSProperties,
  /**
   * AC-97 — added / removed / unchanged must be distinguishable in the
   * ACCESSIBILITY TREE, not by colour alone. There is no `.sr-only` utility in
   * this design system, so the clip is declared here rather than assumed.
   */
  srOnly: {
    position: "absolute",
    width: 1,
    height: 1,
    margin: -1,
    padding: 0,
    overflow: "hidden",
    clip: "rect(0 0 0 0)",
    whiteSpace: "nowrap",
    border: 0,
  } satisfies CSSProperties,
  footerRow: { display: "flex", gap: 10, justifyContent: "flex-end" } satisfies CSSProperties,
};
