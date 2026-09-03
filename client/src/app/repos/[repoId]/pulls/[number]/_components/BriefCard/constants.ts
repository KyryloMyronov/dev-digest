import type { Severity } from "@devdigest/ui";

/**
 * SPEC-02 — the brief card's own numbers.
 *
 * The server clamps risks at 20 (`MAX_BRIEF_RISKS`, `modules/brief/constants.ts`)
 * and this card shows 10. THE TWO NUMBERS DIFFER ON PURPOSE (D-4): the gap is
 * what makes AC-39's "showing X of Y" line reachable at all. Raising this to 20
 * would silently delete that line from the UI.
 */
export const BRIEF_RISK_DISPLAY_CAP = 10;

/** AC-40. Matches the server's `MAX_FOCUS_ENTRIES`, so nothing is ever hidden. */
export const MAX_FOCUS_ENTRIES_SHOWN = 5;

/** Give up polling after this long; a job that has not landed by now is stuck. */
export const DERIVE_TIMEOUT_MS = 90_000;

/**
 * AC-38 — risks render CRITICAL → WARNING → SUGGESTION, whatever order the
 * payload lists them in.
 *
 * A LOCAL literal, not an import of the shared `Severity` Zod enum: importing a
 * runtime VALUE from `@devdigest/shared` breaks the webpack build while
 * `typecheck` and `vitest` both pass (client `insights.md`, 2026-08-11).
 */
export const SEVERITY_ORDER: Severity[] = ["CRITICAL", "WARNING", "SUGGESTION"];

/** How many characters of a path survive before the middle is elided (AC-45). */
export const PATH_HEAD_CHARS = 22;
export const PATH_TAIL_CHARS = 28;
