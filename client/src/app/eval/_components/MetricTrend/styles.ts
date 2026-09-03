import type { CSSProperties } from "react";

/** Co-located styles for MetricTrend. */
export const s = {
  wrap: { display: "flex", flexDirection: "column", gap: 10 } satisfies CSSProperties,
  svg: { display: "block", width: "100%", height: "auto", overflow: "visible" } satisfies CSSProperties,
  legend: {
    display: "flex",
    flexWrap: "wrap",
    gap: 16,
    fontSize: 12,
    color: "var(--text-secondary)",
  } satisfies CSSProperties,
  legendItem: { display: "flex", alignItems: "center", gap: 6 } satisfies CSSProperties,
  empty: {
    fontSize: 13,
    color: "var(--text-secondary)",
    padding: "18px 0",
  } satisfies CSSProperties,
  /**
   * Visually hidden, still in the accessibility tree. AC-75 asks for the
   * ordinals as TEXT, and a screen-reader table is the honest way to expose a
   * chart's numbers — the dataviz rule that "a table view exists" and the
   * criterion are the same requirement here.
   */
  srOnly: {
    position: "absolute",
    width: 1,
    height: 1,
    margin: -1,
    padding: 0,
    overflow: "hidden",
    clip: "rect(0 0 0 0)",
    whiteSpace: "nowrap",
    border: 0,
  } satisfies CSSProperties,
};
