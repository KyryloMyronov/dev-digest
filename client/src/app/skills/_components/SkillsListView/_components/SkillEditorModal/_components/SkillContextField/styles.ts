import type { CSSProperties } from "react";

/** Co-located styles for the skill editor's project-context surface. */
export const c = {
  wrap: { display: "flex", flexDirection: "column", gap: 10 } satisfies CSSProperties,
  list: {
    listStyle: "none",
    margin: 0,
    padding: 0,
    display: "flex",
    flexDirection: "column",
    gap: 6,
  } satisfies CSSProperties,
  row: (unresolved: boolean): CSSProperties => ({
    display: "flex",
    alignItems: "center",
    gap: 8,
    padding: "6px 10px",
    borderRadius: 7,
    border: `1px solid ${unresolved ? "var(--crit)" : "var(--border)"}`,
    background: "var(--bg-surface)",
  }),
  path: { fontSize: 12.5, color: "var(--text-primary)" } satisfies CSSProperties,
  right: { marginLeft: "auto", display: "flex", alignItems: "center", gap: 8 } satisfies CSSProperties,
  sectionHead: {
    display: "flex",
    alignItems: "center",
    gap: 6,
    marginTop: 4,
    fontSize: 11,
    fontWeight: 700,
    letterSpacing: "0.06em",
    textTransform: "uppercase",
    color: "var(--text-muted)",
  } satisfies CSSProperties,
  chips: { display: "flex", flexWrap: "wrap", gap: 6 } satisfies CSSProperties,
  empty: { fontSize: 12.5, color: "var(--text-muted)", margin: 0 } satisfies CSSProperties,
  footer: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 10,
    marginTop: 4,
  } satisfies CSSProperties,
  error: { fontSize: 12, color: "var(--crit)" } satisfies CSSProperties,
} as const;
