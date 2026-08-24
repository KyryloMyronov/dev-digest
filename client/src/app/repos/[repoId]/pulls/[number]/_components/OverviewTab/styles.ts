import type { CSSProperties } from "react";

export const s = {
  /* Intent | Blast Radius side by side (img.png); wraps to one column when the
     viewport can't fit two readable cards. */
  cardsGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(min(420px, 100%), 1fr))",
    gap: 24,
  } satisfies CSSProperties,
  /* minWidth:0 lets long mono paths inside a card shrink/wrap instead of
     forcing its grid track wider than the column; the flex column lets the
     card inside stretch to the row height, so both cards' edges align. */
  gridCell: {
    minWidth: 0,
    display: "flex",
    flexDirection: "column",
  } satisfies CSSProperties,
  descriptionBox: {
    border: "1px solid var(--border)",
    borderRadius: 8,
    background: "var(--bg-elevated)",
    padding: 18,
    fontSize: 14,
    color: "var(--text-secondary)",
    whiteSpace: "pre-wrap",
    lineHeight: 1.55,
  } satisfies CSSProperties,
} as const;
