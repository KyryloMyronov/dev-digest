import type { CSSProperties } from "react";
import { CARD_GRID_COLS, PREVIEW_WIDTH } from "./constants";

/** Co-located styles for SkillsListView and its card. */
export const s = {
  page: { display: "flex", height: "calc(100vh - 52px)", minHeight: 0 } satisfies CSSProperties,
  main: { flex: 1, minWidth: 0, overflow: "auto", padding: "24px 32px 44px" } satisfies CSSProperties,
  header: { display: "flex", alignItems: "center", gap: 14, marginBottom: 20 } satisfies CSSProperties,
  headerText: { flex: 1, minWidth: 0 } satisfies CSSProperties,
  h1: { fontSize: 24, fontWeight: 700, letterSpacing: "-0.02em" } satisfies CSSProperties,
  subtitle: { fontSize: 14, color: "var(--text-secondary)", marginTop: 4 } satisfies CSSProperties,
  search: {
    display: "flex",
    alignItems: "center",
    gap: 10,
    padding: "8px 12px",
    borderRadius: 7,
    border: "1px solid var(--border)",
    background: "var(--bg-surface)",
    width: 200,
  } satisfies CSSProperties,
  searchIcon: { color: "var(--text-muted)" } satisfies CSSProperties,
  searchInput: {
    flex: 1,
    fontSize: 13,
    background: "transparent",
    border: "none",
    outline: "none",
    color: "var(--text-primary)",
  } satisfies CSSProperties,
  grid: { display: "grid", gridTemplateColumns: CARD_GRID_COLS, gap: 14 } satisfies CSSProperties,
  aside: {
    width: PREVIEW_WIDTH,
    flexShrink: 0,
    borderLeft: "1px solid var(--border)",
    background: "var(--bg-surface)",
    display: "flex",
    flexDirection: "column",
    minHeight: 0,
  } satisfies CSSProperties,
} as const;

/** Card styles — a function of the card's selected/enabled state. */
export const card = {
  root: (active: boolean, enabled: boolean): CSSProperties => ({
    border: `1px solid ${active ? "var(--accent)" : "var(--border)"}`,
    borderRadius: 10,
    background: "var(--bg-surface)",
    padding: 14,
    cursor: "pointer",
    // A disabled skill stays legible but visibly inert — it is still in the
    // library and still linkable, it just contributes nothing to any prompt.
    opacity: enabled ? 1 : 0.55,
    display: "flex",
    flexDirection: "column",
    gap: 8,
  }),
  headerRow: { display: "flex", alignItems: "center", gap: 8 } satisfies CSSProperties,
  name: {
    flex: 1,
    minWidth: 0,
    fontSize: 14,
    fontWeight: 650,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  } satisfies CSSProperties,
  description: {
    fontSize: 12.5,
    color: "var(--text-secondary)",
    lineHeight: 1.5,
    display: "-webkit-box",
    WebkitLineClamp: 3,
    WebkitBoxOrient: "vertical",
    overflow: "hidden",
  } satisfies CSSProperties,
  metaRow: { display: "flex", alignItems: "center", gap: 8, marginTop: "auto" } satisfies CSSProperties,
} as const;
