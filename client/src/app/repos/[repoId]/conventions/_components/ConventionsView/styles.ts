import type { CSSProperties } from "react";
import type { ConventionStatus } from "@devdigest/shared";

/** Co-located styles for the conventions screen. */
export const s = {
  main: { padding: "24px 32px 44px", maxWidth: 1180 } satisfies CSSProperties,
  header: {
    display: "flex",
    alignItems: "flex-start",
    gap: 14,
    marginBottom: 18,
  } satisfies CSSProperties,
  headerText: { flex: 1, minWidth: 0 } satisfies CSSProperties,
  h1: { fontSize: 24, fontWeight: 700, letterSpacing: "-0.02em" } satisfies CSSProperties,
  repoName: { color: "var(--accent)" } satisfies CSSProperties,
  subtitle: {
    fontSize: 14,
    color: "var(--text-secondary)",
    marginTop: 4,
  } satisfies CSSProperties,
  toolbar: {
    display: "flex",
    alignItems: "center",
    gap: 14,
    marginBottom: 16,
  } satisfies CSSProperties,
  counter: { fontSize: 13, color: "var(--text-muted)" } satisfies CSSProperties,
  toolbarSpacer: { marginLeft: "auto" } satisfies CSSProperties,
  stack: { display: "flex", flexDirection: "column", gap: 14 } satisfies CSSProperties,
  loadingStack: { display: "flex", flexDirection: "column", gap: 14 } satisfies CSSProperties,
} as const;

/** Accent colour of a card's left border, by review state. */
function statusAccent(status: ConventionStatus): string {
  if (status === "accepted") return "var(--ok)";
  if (status === "rejected") return "var(--crit)";
  return "var(--border-strong)";
}

/** Card styles — a function of the candidate's review state. */
export const card = {
  root: (status: ConventionStatus): CSSProperties => ({
    display: "flex",
    gap: 16,
    padding: 16,
    borderRadius: 10,
    border: "1px solid var(--border)",
    borderLeft: `3px solid ${statusAccent(status)}`,
    background: "var(--bg-surface)",
    // A rejected rule stays on screen and stays readable — it has to, or a
    // re-scan would look like it silently dropped something.
    opacity: status === "rejected" ? 0.6 : 1,
  }),
  body: { flex: 1, minWidth: 0 } satisfies CSSProperties,
  rule: {
    fontSize: 14.5,
    fontWeight: 600,
    fontStyle: "italic",
    lineHeight: 1.45,
  } satisfies CSSProperties,
  ruleRow: {
    display: "flex",
    alignItems: "flex-start",
    gap: 8,
    marginBottom: 10,
  } satisfies CSSProperties,
  editRow: { display: "flex", gap: 8, marginBottom: 10 } satisfies CSSProperties,
  editActions: { display: "flex", gap: 6, marginTop: 8 } satisfies CSSProperties,
  footer: {
    display: "flex",
    alignItems: "center",
    gap: 10,
    marginTop: 12,
  } satisfies CSSProperties,
  footerLabel: { fontSize: 12.5, color: "var(--text-secondary)" } satisfies CSSProperties,
  footerPct: { fontSize: 12.5, color: "var(--text-secondary)" } satisfies CSSProperties,
  actions: {
    display: "flex",
    flexDirection: "column",
    gap: 8,
    width: 148,
    flexShrink: 0,
  } satisfies CSSProperties,
} as const;

/** The evidence panel: a path header over a mono snippet. */
export const ev = {
  root: {
    border: "1px solid var(--border)",
    borderRadius: 7,
    background: "var(--code-bg)",
    overflow: "hidden",
  } satisfies CSSProperties,
  head: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    padding: "7px 10px",
    borderBottom: "1px solid var(--border)",
  } satisfies CSSProperties,
  path: {
    flex: 1,
    minWidth: 0,
    fontSize: 12,
    color: "var(--text-secondary)",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  } satisfies CSSProperties,
  pre: {
    margin: 0,
    padding: "10px 12px",
    fontSize: 12.5,
    lineHeight: 1.6,
    color: "var(--text-primary)",
    // Wrap rather than scroll: a snippet is a few lines, and a horizontal
    // scrollbar inside a card is a worse trade than a wrapped line.
    whiteSpace: "pre-wrap",
    wordBreak: "break-word",
    overflowX: "auto",
  } satisfies CSSProperties,
  copyBtn: {
    display: "flex",
    alignItems: "center",
    gap: 5,
    padding: "3px 7px",
    fontSize: 11,
    borderRadius: 5,
    border: "1px solid var(--border)",
    background: "transparent",
    color: "var(--text-muted)",
    cursor: "pointer",
  } satisfies CSSProperties,
} as const;

/** The create-skill modal. */
export const modal = {
  banner: {
    display: "flex",
    alignItems: "flex-start",
    gap: 10,
    padding: "12px 14px",
    borderRadius: 8,
    border: "1px solid var(--accent-border, var(--border))",
    background: "var(--accent-bg, var(--bg-hover))",
    fontSize: 13,
    lineHeight: 1.5,
    color: "var(--text-secondary)",
    marginBottom: 20,
  } satisfies CSSProperties,
  bannerIcon: { color: "var(--accent)", flexShrink: 0, marginTop: 2 } satisfies CSSProperties,
  grid2: {
    display: "grid",
    gridTemplateColumns: "1fr 1fr",
    gap: 20,
    alignItems: "start",
  } satisfies CSSProperties,
  footer: { display: "flex", alignItems: "center", gap: 12, width: "100%" } satisfies CSSProperties,
  footNote: {
    display: "flex",
    alignItems: "center",
    gap: 6,
    fontSize: 12,
    color: "var(--text-muted)",
  } satisfies CSSProperties,
  footerSpacer: { marginLeft: "auto" } satisfies CSSProperties,
  error: { fontSize: 12.5, color: "var(--crit)" } satisfies CSSProperties,
} as const;

/** The line-numbered skill-body editor. */
export const bodyEditor = {
  root: {
    border: "1px solid var(--border)",
    borderRadius: 8,
    background: "var(--code-bg)",
    overflow: "hidden",
  } satisfies CSSProperties,
  head: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    padding: "8px 10px",
    borderBottom: "1px solid var(--border)",
  } satisfies CSSProperties,
  filename: { fontSize: 12.5, color: "var(--text-primary)" } satisfies CSSProperties,
  tokens: { fontSize: 11.5, color: "var(--text-muted)" } satisfies CSSProperties,
  headSpacer: { marginLeft: "auto" } satisfies CSSProperties,
  scroll: { maxHeight: 340, overflow: "auto", padding: "10px 0" } satisfies CSSProperties,
  line: { display: "flex", gap: 12 } satisfies CSSProperties,
  gutter: {
    width: 44,
    flexShrink: 0,
    textAlign: "right",
    fontSize: 12,
    lineHeight: 1.6,
    color: "var(--text-muted)",
    userSelect: "none",
    // Top-aligned so a line that wraps to several visual rows still shows ONE
    // number, level with its first row.
    alignSelf: "flex-start",
  } satisfies CSSProperties,
  text: {
    flex: 1,
    minWidth: 0,
    paddingRight: 12,
    fontSize: 12.5,
    lineHeight: 1.6,
    whiteSpace: "pre-wrap",
    wordBreak: "break-word",
  } satisfies CSSProperties,
  heading: { color: "var(--accent)", fontWeight: 600 } satisfies CSSProperties,
  plain: { color: "var(--text-primary)" } satisfies CSSProperties,
  textarea: {
    display: "block",
    width: "100%",
    // Same metrics as the preview, so toggling does not reflow the text.
    fontSize: 12.5,
    lineHeight: 1.6,
    padding: "10px 12px",
    minHeight: 340,
    resize: "vertical",
    border: "none",
    outline: "none",
    background: "var(--code-bg)",
    color: "var(--text-primary)",
  } satisfies CSSProperties,
} as const;
