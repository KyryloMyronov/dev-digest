import type { CSSProperties } from "react";

/** Co-located styles for SkillEditorModal. */
export const e = {
  body: { padding: "20px 24px 4px" } satisfies CSSProperties,
  footer: { display: "flex", alignItems: "center", gap: 10, width: "100%" } satisfies CSSProperties,
  error: {
    flex: 1,
    minWidth: 0,
    fontSize: 12.5,
    color: "var(--crit)",
    lineHeight: 1.4,
  } satisfies CSSProperties,
} as const;
