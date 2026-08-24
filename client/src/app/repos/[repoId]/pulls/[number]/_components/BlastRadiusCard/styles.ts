import type { CSSProperties } from "react";

export const s = {
  /* The card fills its Overview grid cell so its edges line up with the Intent
     card beside it, whichever is taller. */
  section: {
    flex: 1,
    display: "flex",
    flexDirection: "column",
    minWidth: 0,
  } satisfies CSSProperties,
  card: {
    flex: 1,
    border: "1px solid var(--border)",
    borderRadius: 8,
    background: "var(--bg-elevated)",
    padding: 18,
    display: "flex",
    flexDirection: "column",
    gap: 14,
  } satisfies CSSProperties,
  /* SectionLabel carries its own 14px bottom margin; inside the card that
     stacks with the card's flex gap, so cancel it here. */
  cardLabel: { marginBottom: -14 } satisfies CSSProperties,
  statsRow: {
    display: "flex",
    alignItems: "center",
    gap: 18,
    flexWrap: "wrap",
  } satisfies CSSProperties,
  stat: {
    display: "inline-flex",
    alignItems: "center",
    gap: 6,
    fontSize: 13,
    color: "var(--text-secondary)",
  } satisfies CSSProperties,
  statNum: { fontWeight: 700, color: "var(--text-primary)" } satisfies CSSProperties,
  modeToggle: {
    display: "inline-flex",
    alignItems: "center",
    gap: 2,
    padding: 2,
    borderRadius: 8,
    border: "1px solid var(--border)",
    background: "var(--bg)",
  } satisfies CSSProperties,
  banner: (degraded: boolean) =>
    ({
      display: "flex",
      alignItems: "flex-start",
      gap: 8,
      padding: "10px 12px",
      borderRadius: 7,
      fontSize: 13,
      lineHeight: 1.5,
      border: `1px solid ${degraded ? "var(--danger, var(--warn))" : "var(--warn)"}`,
      background: "var(--bg-hover)",
      color: "var(--text-secondary)",
    }) satisfies CSSProperties,
  symbolList: { display: "flex", flexDirection: "column", gap: 4 } satisfies CSSProperties,
  symbolHeader: (expanded: boolean) =>
    ({
      display: "flex",
      alignItems: "center",
      gap: 8,
      padding: "9px 12px",
      borderRadius: 7,
      background: expanded ? "var(--bg-hover)" : "transparent",
      cursor: "pointer",
      userSelect: "none",
    }) satisfies CSSProperties,
  symbolName: {
    fontSize: 13,
    fontWeight: 600,
    color: "var(--text-primary)",
  } satisfies CSSProperties,
  symbolMeta: {
    marginLeft: "auto",
    fontSize: 12,
    color: "var(--text-muted)",
    whiteSpace: "nowrap",
  } satisfies CSSProperties,
  /* 19px left padding puts the tree guide line under the header's chevron. */
  symbolBody: {
    padding: "10px 12px 12px 19px",
    display: "flex",
    flexDirection: "column",
    gap: 10,
  } satisfies CSSProperties,
  callerTree: {
    display: "flex",
    flexDirection: "column",
    gap: 8,
    borderLeft: "1px solid var(--border)",
    paddingLeft: 12,
  } satisfies CSSProperties,
  callerRow: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    fontSize: 13,
  } satisfies CSSProperties,
  truncatedNote: { fontSize: 12, color: "var(--text-muted)" } satisfies CSSProperties,
  chipRow: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    flexWrap: "wrap",
    paddingLeft: 13,
  } satisfies CSSProperties,
  /* Collapsible "affected endpoints" bar pinned to the card's bottom edge,
     past a divider — marginTop:auto absorbs the slack when the Intent card
     beside this one is taller. */
  footer: {
    marginTop: "auto",
    borderTop: "1px solid var(--border)",
    paddingTop: 14,
    display: "flex",
    flexDirection: "column",
    gap: 10,
  } satisfies CSSProperties,
  endpointsBar: {
    display: "flex",
    alignItems: "center",
    gap: 10,
    padding: "11px 14px",
    border: "1px solid var(--border)",
    borderRadius: 8,
    background: "var(--bg)",
    cursor: "pointer",
    userSelect: "none",
  } satisfies CSSProperties,
  endpointsBarTitle: {
    fontSize: 13,
    fontWeight: 600,
    color: "var(--text-primary)",
  } satisfies CSSProperties,
  endpointList: {
    display: "flex",
    flexDirection: "column",
    gap: 8,
    padding: "0 4px",
  } satisfies CSSProperties,
  endpointRow: {
    display: "flex",
    alignItems: "center",
    gap: 10,
    flexWrap: "wrap",
    fontSize: 13,
  } satisfies CSSProperties,
  chain: {
    fontSize: 12,
    color: "var(--text-muted)",
  } satisfies CSSProperties,
  emptyNote: { fontSize: 13, color: "var(--text-muted)" } satisfies CSSProperties,
} as const;
