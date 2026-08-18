import type { CSSProperties } from "react";

/** Co-located styles for the per-severity findings modal. */
export const s = {
  body: { padding: "16px 24px 22px" } satisfies CSSProperties,
  loadingStack: {
    display: "flex",
    flexDirection: "column",
    gap: 12,
  } satisfies CSSProperties,
  list: {
    display: "flex",
    flexDirection: "column",
    gap: 10,
  } satisfies CSSProperties,
  item: (sevColor: string, muted: boolean): CSSProperties => ({
    borderRadius: 8,
    // All-longhand: mixing `border` with `borderLeft` makes React warn when a
    // shorthand and a non-shorthand update on the same rerender.
    borderStyle: "solid",
    borderColor: "var(--border)",
    borderWidth: 1,
    borderLeftWidth: 3,
    borderLeftColor: sevColor,
    background: "var(--bg-surface)",
    padding: "12px 14px",
    opacity: muted ? 0.6 : 1,
  }),
  head: {
    display: "flex",
    alignItems: "flex-start",
    gap: 12,
  } satisfies CSSProperties,
  badgeWrap: { paddingTop: 1 } satisfies CSSProperties,
  headMain: { flex: 1, minWidth: 0 } satisfies CSSProperties,
  titleRow: {
    display: "flex",
    alignItems: "center",
    gap: 10,
    flexWrap: "wrap",
  } satisfies CSSProperties,
  title: (dismissed: boolean): CSSProperties => ({
    fontSize: 14,
    fontWeight: 600,
    color: "var(--text-primary)",
    textDecoration: dismissed ? "line-through" : "none",
  }),
  acceptedTag: { fontSize: 12, fontWeight: 600, color: "var(--ok)" } satisfies CSSProperties,
  dismissedTag: {
    fontSize: 12,
    fontWeight: 600,
    color: "var(--text-muted)",
  } satisfies CSSProperties,
  metaRow: {
    display: "flex",
    alignItems: "center",
    gap: 12,
    marginTop: 5,
    flexWrap: "wrap",
  } satisfies CSSProperties,
  prose: {
    fontSize: 13,
    lineHeight: 1.6,
    color: "var(--text-secondary)",
    marginTop: 10,
  } satisfies CSSProperties,
  suggestionWrap: { marginTop: 12 } satisfies CSSProperties,
  suggestionLabel: {
    fontSize: 12,
    fontWeight: 700,
    letterSpacing: "0.05em",
    color: "var(--text-muted)",
    marginBottom: 6,
    textTransform: "uppercase",
  } satisfies CSSProperties,
  footer: {
    display: "flex",
    justifyContent: "flex-end",
    gap: 10,
    alignItems: "center",
  } satisfies CSSProperties,
} as const;