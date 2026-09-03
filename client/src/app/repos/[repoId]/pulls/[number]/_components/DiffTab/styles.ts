import type { CSSProperties } from "react";

/** Co-located styles for the DiffTab / Smart Diff view. */
export const s = {
  wrap: { display: "flex", flexDirection: "column", gap: 14 } satisfies CSSProperties,
  headerRight: { display: "flex", alignItems: "center", gap: 10 } satisfies CSSProperties,
  modeToggle: {
    display: "inline-flex",
    alignItems: "center",
    gap: 2,
    padding: 2,
    borderRadius: 7,
    border: "1px solid var(--border)",
  } satisfies CSSProperties,
  groups: { display: "flex", flexDirection: "column", gap: 14 } satisfies CSSProperties,
  group: { display: "flex", flexDirection: "column", gap: 8 } satisfies CSSProperties,
  groupHeader: {
    display: "flex",
    alignItems: "center",
    gap: 10,
    padding: "6px 2px",
    background: "none",
    border: "none",
    cursor: "pointer",
    textAlign: "left",
    width: "100%",
  } satisfies CSSProperties,
  groupHint: {
    fontSize: 12,
    color: "var(--text-muted)",
    flex: 1,
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  } satisfies CSSProperties,
  groupMeta: { fontSize: 12, color: "var(--text-muted)" } satisfies CSSProperties,
  // ---- SPEC-03 · the reviewer-ordered chrome --------------------------------
  /** AC-41 — the count + aggregate line, a SIBLING under the section label:
   *  `SectionLabel` has no slot beneath it and `vendor/**` is do-not-touch. */
  aggregate: {
    display: "flex",
    alignItems: "center",
    gap: 10,
    marginTop: -8,
    marginBottom: 12,
    fontSize: 12,
    color: "var(--text-secondary)",
  } satisfies CSSProperties,
  /** AC-48 — the one sentence separating this ordering from the brief's focus. */
  vsBrief: {
    fontSize: 12,
    lineHeight: "17px",
    color: "var(--text-secondary)",
    marginBottom: 12,
  } satisfies CSSProperties,
  /**
   * AC-71 / AC-73 — the status region. `--text-secondary`, never
   * `--text-muted`: 5.98:1 vs 3.15:1 on `--bg-elevated` in dark.
   */
  statusRegion: {
    fontSize: 12,
    lineHeight: "17px",
    color: "var(--text-secondary)",
  } satisfies CSSProperties,
  /** AC-55 — the read failed; an explicit state with a retry control. */
  summariesError: {
    display: "flex",
    alignItems: "center",
    gap: 10,
    padding: "10px 12px",
    borderRadius: 7,
    border: "1px solid var(--warn)",
    background: "var(--warn-bg)",
    fontSize: 12,
    color: "var(--text-primary)",
  } satisfies CSSProperties,
  splitCard: {
    display: "flex",
    flexDirection: "column",
    gap: 8,
    padding: "12px 14px",
    borderRadius: 7,
    border: "1px solid var(--warn)",
    background: "var(--warn-bg)",
  } satisfies CSSProperties,
  splitTitle: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    fontSize: 13,
    fontWeight: 600,
    color: "var(--text-primary)",
  } satisfies CSSProperties,
  splitBody: { fontSize: 12, color: "var(--text-secondary)" } satisfies CSSProperties,
  splitList: {
    display: "flex",
    flexDirection: "column",
    gap: 4,
    margin: 0,
    padding: 0,
    listStyle: "none",
  } satisfies CSSProperties,
  splitRow: {
    display: "flex",
    alignItems: "baseline",
    gap: 8,
    fontSize: 12,
    color: "var(--text-secondary)",
  } satisfies CSSProperties,
} as const;
