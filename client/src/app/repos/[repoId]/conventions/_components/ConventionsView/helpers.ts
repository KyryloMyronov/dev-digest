import type { ConventionCandidate, ConventionScan } from "@devdigest/shared";
import { CHARS_PER_TOKEN, CONFIDENCE_OK, CONFIDENCE_WARN } from "./constants";

/** Pure helpers for the conventions screen. */

/** A confidence in 0..1 as a whole percentage, or null when the model gave none. */
export function confidencePct(value: number | null | undefined): number | null {
  if (value === null || value === undefined || Number.isNaN(value)) return null;
  return Math.round(Math.min(1, Math.max(0, value)) * 100);
}

/**
 * Meter colour for a confidence percentage.
 *
 * Thresholds match the kit's `ConfidenceNum`, so this meter and the kit's
 * numeric readout can never call the same score green and amber.
 */
export function confidenceColor(pct: number | null): string {
  if (pct === null) return "var(--text-muted)";
  if (pct >= CONFIDENCE_OK) return "var(--ok)";
  if (pct >= CONFIDENCE_WARN) return "var(--warn)";
  return "var(--text-muted)";
}

export function acceptedIds(items: ConventionCandidate[]): string[] {
  return items.filter((c) => c.status === "accepted").map((c) => c.id);
}

/**
 * Compact relative time, e.g. "3h". A colocated copy of the PR list's helper
 * rather than a shared one: the two screens format the same idea, and promoting
 * a ten-line pure function to `src/` for a second caller buys nothing.
 *
 * The "ago" suffix lives in the message, not here.
 */
export function relativeTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "—";
  const m = Math.max(0, Math.round((Date.now() - then) / 60_000));
  if (m < 1) return "now";
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}

/** True while a scan is queued or running — the "Scanning…" state. */
export function isScanning(scan: ConventionScan | undefined): boolean {
  return scan?.status === "queued" || scan?.status === "running";
}

/**
 * Rough token count for a body the user has edited.
 *
 * The server counts exactly with a real tokenizer; once the text diverges from
 * what it counted, this stands in. Labelled "~" in the UI so the approximation
 * is never presented as the real number.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/** Split a markdown body into lines for the gutter view. */
export function bodyLines(body: string): string[] {
  return body.split("\n");
}

/** True for a markdown ATX heading line — the only line we colour. */
export function isHeadingLine(line: string): boolean {
  return /^#{1,6}\s/.test(line);
}
