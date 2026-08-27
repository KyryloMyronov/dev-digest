import type { CSSProperties } from "react";
import { LIST_WIDTH } from "./constants";

/** Co-located styles for the Project Context screen. */
export const s = {
  main: { padding: "24px 32px 44px", maxWidth: 1320 } satisfies CSSProperties,
  header: {
    display: "flex",
    alignItems: "flex-start",
    gap: 14,
    marginBottom: 18,
  } satisfies CSSProperties,
  headerText: { flex: 1, minWidth: 0 } satisfies CSSProperties,
  h1: { fontSize: 24, fontWeight: 700, letterSpacing: "-0.02em" } satisfies CSSProperties,
  repoName: { color: "var(--accent)" } satisfies CSSProperties,
  subtitle: { fontSize: 14, color: "var(--text-secondary)", marginTop: 4 } satisfies CSSProperties,

  split: { display: "flex", alignItems: "flex-start", gap: 20 } satisfies CSSProperties,
  listCol: { width: LIST_WIDTH, flexShrink: 0, minWidth: 0 } satisfies CSSProperties,
  previewCol: { flex: 1, minWidth: 0 } satisfies CSSProperties,

  overflowNote: {
    fontSize: 13,
    color: "var(--warn)",
    marginBottom: 10,
  } satisfies CSSProperties,

  list: {
    display: "flex",
    flexDirection: "column",
    gap: 2,
    border: "1px solid var(--border)",
    borderRadius: 10,
    background: "var(--bg-surface)",
    padding: 6,
  } satisfies CSSProperties,
  loadingStack: { display: "flex", flexDirection: "column", gap: 6 } satisfies CSSProperties,

  footer: {
    display: "flex",
    alignItems: "center",
    gap: 10,
    marginTop: 14,
    fontSize: 13,
    color: "var(--text-secondary)",
  } satisfies CSSProperties,

  previewPanel: {
    border: "1px solid var(--border)",
    borderRadius: 10,
    background: "var(--bg-surface)",
    minHeight: 320,
  } satisfies CSSProperties,
  previewHeader: {
    display: "flex",
    alignItems: "center",
    gap: 10,
    padding: "10px 14px",
    borderBottom: "1px solid var(--border)",
  } satisfies CSSProperties,
  previewPath: {
    fontSize: 13,
    color: "var(--text-primary)",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    minWidth: 0,
    flex: 1,
  } satisfies CSSProperties,
  previewMeta: { fontSize: 12, color: "var(--text-muted)", whiteSpace: "nowrap" } satisfies CSSProperties,
  previewBody: { padding: "16px 18px", fontSize: 14 } satisfies CSSProperties,
} as const;

/** One document row. `selected` is the only state that changes its chrome. */
export const row = {
  root: (selected: boolean): CSSProperties => ({
    display: "flex",
    alignItems: "center",
    gap: 10,
    width: "100%",
    textAlign: "left",
    padding: "8px 10px",
    borderRadius: 7,
    border: "1px solid " + (selected ? "var(--accent)" : "transparent"),
    background: selected ? "var(--accent-bg)" : "transparent",
    color: "var(--text-primary)",
    cursor: "pointer",
  }),
  /** The visible path. Truncation is presentational: `aria-label` keeps the
      full path, which is what AC-13 asserts. */
  path: {
    flex: 1,
    minWidth: 0,
    fontSize: 13,
    overflow: "hidden",
    whiteSpace: "nowrap",
  } satisfies CSSProperties,
  meta: {
    fontSize: 12,
    color: "var(--text-muted)",
    whiteSpace: "nowrap",
    display: "inline-flex",
    alignItems: "center",
    gap: 8,
  } satisfies CSSProperties,
} as const;
