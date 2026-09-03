import type { CSSProperties } from "react";

/** Co-located styles for the /eval workspace dashboard. */
export const s = {
  page: { padding: "24px 32px 44px", maxWidth: 1180, margin: "0 auto" } satisfies CSSProperties,
  header: { display: "flex", alignItems: "center", gap: 14, marginBottom: 20 } satisfies CSSProperties,
  headerText: { flex: 1 } satisfies CSSProperties,
  h1: { fontSize: 24, fontWeight: 700, letterSpacing: "-0.02em" } satisfies CSSProperties,
  subtitle: { fontSize: 14, color: "var(--text-secondary)", marginTop: 4 } satisfies CSSProperties,
  sectionLabel: {
    fontSize: 12,
    letterSpacing: "0.06em",
    color: "var(--text-secondary)",
    margin: "24px 0 8px",
  } satisfies CSSProperties,
  table: { width: "100%", borderCollapse: "collapse", fontSize: 13 } satisfies CSSProperties,
  th: {
    textAlign: "left",
    padding: "8px 10px",
    color: "var(--text-secondary)",
    fontWeight: 500,
    borderBottom: "1px solid var(--border)",
  } satisfies CSSProperties,
  td: { padding: "8px 10px", borderBottom: "1px solid var(--border)" } satisfies CSSProperties,
  agentLink: {
    color: "var(--accent)",
    textDecoration: "none",
    fontWeight: 600,
    background: "none",
    border: 0,
    padding: 0,
    cursor: "pointer",
    font: "inherit",
  } satisfies CSSProperties,
  disabledTag: { color: "var(--text-secondary)", marginLeft: 8, fontSize: 12 } satisfies CSSProperties,
  confirmBody: { fontSize: 14, lineHeight: 1.6 } satisfies CSSProperties,
  confirmRow: { display: "flex", gap: 10, justifyContent: "flex-end" } satisfies CSSProperties,
};
