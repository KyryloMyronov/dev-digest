import type { CSSProperties } from "react";
import type { Line } from "./helpers";
import { SEV, type Severity } from "@devdigest/ui";

/** Co-located styles for the DiffViewer (extracted from inline styles). */
export const s = {
  list: { display: "flex", flexDirection: "column", gap: 10 } satisfies CSSProperties,
  empty: { padding: "24px", fontSize: 14, color: "var(--text-muted)", textAlign: "center" } satisfies CSSProperties,
  fileCard: {
    border: "1px solid var(--border)",
    borderRadius: 7,
    overflow: "hidden",
    background: "var(--bg-elevated)",
  } satisfies CSSProperties,
  // SPEC-03 D-3: the header row is a NON-INTERACTIVE container. It owns two
  // real buttons (the disclosure control and the derive control) plus the
  // finding-jump badge, and a <button> may not contain interactive descendants
  // — so the fold affordance is the nested `fileDisclosure` button, not this
  // div. Accepted cost: clicking the badge strip no longer folds the card.
  fileHeader: {
    display: "flex",
    alignItems: "center",
    gap: 10,
    padding: "10px 12px",
  } satisfies CSSProperties,
  // SPEC-03 AC-69/AC-70 — the disclosure control. A real <button>, so Enter AND
  // Space come free from the platform; `flex: 1` (moved off `filePath`) keeps
  // most of the old header-wide click target for nothing.
  fileDisclosure: {
    display: "flex",
    alignItems: "center",
    gap: 10,
    flex: 1,
    minWidth: 0,
    padding: 0,
    border: "none",
    background: "none",
    color: "inherit",
    font: "inherit",
    textAlign: "left",
    cursor: "pointer",
  } satisfies CSSProperties,
  fileIcon: { color: "var(--text-muted)" } satisfies CSSProperties,
  // `flex: 1, minWidth: 0` moved to `fileDisclosure` (SPEC-03): the ellipsis
  // stays here, on the text, and the growth is on the button around it.
  filePath: {
    fontSize: 13,
    fontWeight: 500,
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  } satisfies CSSProperties,
  fileStat: { fontSize: 12 } satisfies CSSProperties,
  // Bare-button wrapper for the finding badge: clickable without inheriting
  // the header's fold toggle, visually just the badge.
  findingJump: {
    display: "inline-flex",
    alignItems: "center",
    padding: 0,
    border: "none",
    background: "none",
    cursor: "pointer",
    font: "inherit",
  } satisfies CSSProperties,
  // ---- SPEC-03 · the derived one-line summary -----------------------------
  /** The summary row, between the header and the body (AC-49 / AC-50). */
  summaryRow: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    padding: "7px 12px",
    borderTop: "1px solid var(--border)",
  } satisfies CSSProperties,
  /**
   * AC-73 — `--text-secondary`, NOT `--text-muted`.
   * `#999999` on `--bg-elevated` `#1c1c1c` measures 5.98:1 (dark) and `#595964`
   * on `#ffffff` measures 6.92:1 (light). `--text-muted` measures 3.15:1 on
   * `--bg-elevated` in dark — the shipped group hint uses it, and copying that
   * would ship the failure this criterion exists to prevent.
   */
  summaryText: {
    fontSize: 12,
    lineHeight: "17px",
    color: "var(--text-secondary)",
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  } satisfies CSSProperties,
  /** AC-54 — the summary line's loading placeholder. */
  summarySkeleton: {
    display: "block",
    height: 10,
    width: "42%",
    borderRadius: 4,
    background: "var(--bg-hover)",
  } satisfies CSSProperties,
  /** The per-file derivation control (AC-51/AC-52/AC-53). */
  deriveBtn: {
    display: "inline-flex",
    alignItems: "center",
    gap: 5,
    padding: "2px 8px",
    borderRadius: 5,
    border: "1px solid var(--border)",
    background: "none",
    color: "var(--text-secondary)",
    font: "inherit",
    fontSize: 12,
    cursor: "pointer",
  } satisfies CSSProperties,
  /** AC-65/AC-72 — the per-line severity mark: icon AND text, in the margin. */
  lineSeverity: {
    display: "inline-flex",
    alignItems: "center",
    gap: 3,
    flexShrink: 0,
    padding: "0 4px",
    fontSize: 10,
    fontWeight: 600,
    letterSpacing: "0.02em",
  } satisfies CSSProperties,
  addText: { color: "var(--code-add-text)" } satisfies CSSProperties,
  delText: { color: "var(--code-del-text)" } satisfies CSSProperties,
  fileBody: {
    borderTop: "1px solid var(--border)",
    padding: "8px 0",
    background: "var(--bg-surface)",
  } satisfies CSSProperties,
  noDiff: {
    padding: "14px 18px",
    fontSize: 13,
    color: "var(--text-muted)",
    textAlign: "center",
  } satisfies CSSProperties,
  hunk: {
    fontSize: 12,
    lineHeight: "20px",
    color: "var(--accent-text)",
    background: "var(--accent-bg)",
    padding: "0 14px",
  } satisfies CSSProperties,
  lineNo: {
    width: 44,
    textAlign: "right",
    padding: "0 10px 0 0",
    color: "var(--text-muted)",
    userSelect: "none",
    flexShrink: 0,
  } satisfies CSSProperties,
  lineText: {
    flex: 1,
    whiteSpace: "pre-wrap",
    wordBreak: "break-word",
    color: "var(--text-primary)",
    paddingRight: 12,
  } satisfies CSSProperties,
} as const;

/** Chevron rotates 90deg when the file card is open. */
export function chevronFor(open: boolean): CSSProperties {
  return {
    color: "var(--text-muted)",
    transform: open ? "rotate(90deg)" : "none",
    transition: "transform .12s",
  };
}

/** Row background per line kind (add/del tinted, others transparent). */
export function lineRowFor(kind: Line["kind"]): CSSProperties {
  const background = kind === "add" ? "var(--code-add)" : kind === "del" ? "var(--code-del)" : "transparent";
  return { display: "flex", alignItems: "stretch", fontSize: 13, lineHeight: "20px", background };
}

/**
 * A line a review finding points at. Deliberately a left rule + a wash rather
 * than a background swap: the add/del tint is what tells you whether the line
 * was added or removed, and a finding must not overwrite that fact.
 */
export function findingRowFor(kind: Line["kind"], severity?: Severity | null): CSSProperties {
  // SPEC-03 AC-65 — the rule takes the finding's OWN severity colour when one
  // resolves. AC-67: with no severity this is byte-identical to the shipped
  // behaviour (`var(--warn)`), which is the severity-neutral highlight, and it
  // must stay reachable and unchanged.
  const rule = severity ? SEV[severity].c : "var(--warn)";
  const wash = severity ? SEV[severity].bg : "var(--warn-bg)";
  return {
    ...lineRowFor(kind),
    boxShadow: `inset 3px 0 0 0 ${rule}`,
    background:
      kind === "add"
        ? "var(--code-add)"
        : kind === "del"
          ? "var(--code-del)"
          : wash,
  };
}

/** Gutter sign colour per line kind. */
export function lineSignFor(kind: Line["kind"]): CSSProperties {
  return {
    width: 14,
    textAlign: "center",
    color: kind === "add" ? "var(--code-add-text)" : kind === "del" ? "var(--code-del-text)" : "var(--text-muted)",
    flexShrink: 0,
  };
}
