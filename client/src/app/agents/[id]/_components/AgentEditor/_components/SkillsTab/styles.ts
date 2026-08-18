import type { CSSProperties } from "react";

/** Co-located styles for the agent SkillsTab. */
export const s = {
  wrap: { maxWidth: 860 } satisfies CSSProperties,
  header: { display: "flex", alignItems: "center", gap: 12, marginBottom: 6 } satisfies CSSProperties,
  h2: { fontSize: 18, fontWeight: 700 } satisfies CSSProperties,
  hint: { fontSize: 13, color: "var(--text-secondary)", marginBottom: 18, lineHeight: 1.5 } satisfies CSSProperties,
  list: {
    listStyle: "none",
    margin: 0,
    padding: 0,
    display: "flex",
    flexDirection: "column",
    gap: 8,
  } satisfies CSSProperties,
  row: (enabled: boolean): CSSProperties => ({
    display: "flex",
    alignItems: "center",
    gap: 12,
    padding: "8px 12px",
    borderRadius: 8,
    border: "1px solid var(--border)",
    background: enabled ? "var(--bg-hover)" : "var(--bg-surface)",
    // A disabled link stays fully readable — it is still attached and still
    // ordered; only its contribution to the prompt is off.
    opacity: enabled ? 1 : 0.62,
  }),
  reorder: { display: "flex", flexDirection: "column", gap: 2 } satisfies CSSProperties,
  reorderBtn: (disabled: boolean): CSSProperties => ({
    width: 22,
    height: 18,
    display: "grid",
    placeItems: "center",
    padding: 0,
    borderRadius: 4,
    border: "1px solid var(--border)",
    background: "transparent",
    color: disabled ? "var(--text-muted)" : "var(--text-secondary)",
    cursor: disabled ? "not-allowed" : "pointer",
    opacity: disabled ? 0.4 : 1,
  }),
  name: { fontSize: 13.5, color: "var(--text-primary)" } satisfies CSSProperties,
  rowRight: { marginLeft: "auto", display: "flex", alignItems: "center", gap: 8 } satisfies CSSProperties,
  availableHead: {
    display: "flex",
    alignItems: "center",
    gap: 6,
    marginTop: 28,
    marginBottom: 10,
    fontSize: 11,
    fontWeight: 700,
    letterSpacing: "0.06em",
    textTransform: "uppercase",
    color: "var(--text-muted)",
  } satisfies CSSProperties,
  availableEmpty: { fontSize: 13, color: "var(--text-muted)" } satisfies CSSProperties,
  availableList: { display: "flex", flexWrap: "wrap", gap: 8 } satisfies CSSProperties,
} as const;
