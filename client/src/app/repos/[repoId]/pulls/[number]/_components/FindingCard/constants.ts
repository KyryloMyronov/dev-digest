/** Constants for FindingCard. */

/** Severity → CSS colour token. */
export const SEV_COLOR: Record<string, string> = {
  CRITICAL: "var(--crit)",
  WARNING: "var(--warn)",
  SUGGESTION: "var(--sugg)",
  INFO: "var(--info)",
};

/** Fallback colour for an unknown severity. */
export const SEV_COLOR_FALLBACK = "var(--text-muted)";


/**
 * SPEC-04 AC-5 — finding kinds for which "Turn into eval case" is OMITTED.
 *
 * These four are not diff-anchored review findings in the ordinary sense — a
 * secret leak and a lethal trifecta are full-file or cross-file claims — so a
 * frozen single-file case built from one would assert something the engine does
 * not evaluate that way. The action is omitted, NOT disabled: AC-5 and AC-6 are
 * two different states, and collapsing them would tell the reviewer to accept
 * or dismiss a finding that would still offer nothing afterwards.
 */
export const EVAL_CASE_EXCLUDED_KINDS: readonly string[] = [
  "secret_leak",
  "phantom",
  "hook",
  "lethal_trifecta",
];
