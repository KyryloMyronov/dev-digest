import type { CSSProperties } from "react";

/** Co-located styles for the routed eval case editor. */
export const s = {
  page: { padding: "24px 32px 44px", maxWidth: 980, margin: "0 auto" } satisfies CSSProperties,
  header: { display: "flex", alignItems: "center", gap: 12, marginBottom: 18 } satisfies CSSProperties,
  headerText: { flex: 1 } satisfies CSSProperties,
  h1: { fontSize: 22, fontWeight: 700, letterSpacing: "-0.02em" } satisfies CSSProperties,
  back: {
    background: "none",
    border: 0,
    padding: 0,
    cursor: "pointer",
    color: "var(--accent)",
    font: "inherit",
    fontSize: 13,
  } satisfies CSSProperties,
  segmented: { display: "flex", gap: 8 } satisfies CSSProperties,
  diffPane: {
    margin: 0,
    padding: 12,
    borderRadius: 8,
    border: "1px solid var(--border)",
    background: "var(--code-bg)",
    fontSize: 12.5,
    whiteSpace: "pre-wrap",
    maxHeight: 260,
    overflow: "auto",
  } satisfies CSSProperties,
  badgeRow: { display: "flex", alignItems: "center", gap: 8 } satisfies CSSProperties,
  error: {
    marginTop: 10,
    padding: "8px 12px",
    borderRadius: 8,
    border: "1px solid var(--crit)",
    background: "var(--crit-bg)",
    fontSize: 13,
  } satisfies CSSProperties,
  footer: { display: "flex", gap: 10, marginTop: 18 } satisfies CSSProperties,
};
