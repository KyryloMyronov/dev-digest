import type { CSSProperties } from "react";

/**
 * SPEC-02 — the brief card. One card, full width, ABOVE the Intent/Blast grid
 * (AC-30 / design review D-0), so its three sections read top-to-bottom before
 * the two cards beside each other.
 */
export const s = {
  section: {
    display: "flex",
    flexDirection: "column",
    minWidth: 0,
  } satisfies CSSProperties,
  box: {
    border: "1px solid var(--border)",
    borderRadius: 8,
    background: "var(--bg-elevated)",
    padding: 18,
    display: "flex",
    flexDirection: "column",
    gap: 14,
  } satisfies CSSProperties,
  /* SectionLabel carries its own 14px bottom margin; inside the box that stacks
     with the flex gap, so cancel it here. */
  boxLabel: { marginBottom: -14 } satisfies CSSProperties,
  headRow: {
    display: "flex",
    alignItems: "center",
    gap: 10,
    flexWrap: "wrap",
  } satisfies CSSProperties,
  spacer: { flex: 1 } satisfies CSSProperties,

  /* ---- sections ---- */
  block: {
    display: "flex",
    flexDirection: "column",
    gap: 8,
    minWidth: 0,
  } satisfies CSSProperties,
  blockLabel: {
    fontSize: 11,
    fontWeight: 700,
    letterSpacing: "0.04em",
    textTransform: "uppercase",
    color: "var(--text-muted)",
  } satisfies CSSProperties,
  prose: {
    fontSize: 14,
    color: "var(--text-secondary)",
    lineHeight: 1.55,
  } satisfies CSSProperties,
  muted: {
    fontSize: 13,
    color: "var(--text-muted)",
    lineHeight: 1.5,
  } satisfies CSSProperties,

  /* ---- risks ---- */
  riskList: {
    display: "flex",
    flexDirection: "column",
    gap: 10,
    minWidth: 0,
  } satisfies CSSProperties,
  riskRow: {
    display: "flex",
    gap: 10,
    alignItems: "flex-start",
    minWidth: 0,
  } satisfies CSSProperties,
  riskBadgeWrap: { flexShrink: 0, paddingTop: 1 } satisfies CSSProperties,
  riskMain: {
    display: "flex",
    flexDirection: "column",
    gap: 3,
    minWidth: 0,
    flex: 1,
  } satisfies CSSProperties,
  /* Visual truncation only — the full string stays the accessible name (AC-45). */
  riskTitle: {
    fontSize: 13.5,
    fontWeight: 600,
    color: "var(--text-primary)",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  } satisfies CSSProperties,
  riskExplanation: {
    fontSize: 13,
    color: "var(--text-secondary)",
    lineHeight: 1.5,
  } satisfies CSSProperties,

  /* ---- the location control: `src/config.ts:12 — reason` ---- */
  locationRow: {
    display: "flex",
    alignItems: "center",
    gap: 6,
    flexWrap: "wrap",
    minWidth: 0,
  } satisfies CSSProperties,
  locationButton: {
    display: "inline-flex",
    alignItems: "center",
    gap: 5,
    background: "none",
    border: "none",
    padding: 0,
    margin: 0,
    font: "inherit",
    fontSize: 12,
    color: "var(--accent)",
    cursor: "pointer",
    textAlign: "left",
    maxWidth: "100%",
  } satisfies CSSProperties,
  reason: {
    fontSize: 12.5,
    color: "var(--text-secondary)",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    minWidth: 0,
  } satisfies CSSProperties,
  dash: { fontSize: 12.5, color: "var(--text-muted)" } satisfies CSSProperties,

  /* ---- focus ---- */
  focusList: {
    display: "flex",
    flexDirection: "column",
    gap: 7,
    minWidth: 0,
  } satisfies CSSProperties,

  /* ---- footer ---- */
  footer: {
    display: "flex",
    alignItems: "center",
    gap: 10,
    flexWrap: "wrap",
    fontSize: 12,
    color: "var(--text-muted)",
    borderTop: "1px solid var(--border)",
    paddingTop: 10,
  } satisfies CSSProperties,

  /* A live region has to be in the a11y tree, so it is clipped, not hidden. */
  srOnly: {
    position: "absolute",
    width: 1,
    height: 1,
    padding: 0,
    margin: -1,
    overflow: "hidden",
    clip: "rect(0 0 0 0)",
    whiteSpace: "nowrap",
    border: 0,
  } satisfies CSSProperties,
} as const;
