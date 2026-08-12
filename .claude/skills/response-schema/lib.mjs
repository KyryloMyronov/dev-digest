// Severity helpers for the response-schema skill.
//
// The source scanner and git-ref I/O that used to live here now live once, in
// `../source-scan/scan.mjs`, shared with `api-breaking-changes` and
// `api-response-changes`. Two copies of that scanner had already drifted on
// whether `<` belongs in the bracket-pairing table — the fix and the invariant
// are documented at the top of `scan.mjs` and in the root `insights.md`.
//
// The original standalone-ness argument still holds: `scan.mjs` is a sibling
// under `.claude/skills/`, so a CI job or a copy that checks out only `.claude/`
// still has everything this skill needs.

export const SEVERITY_ORDER = ['critical', 'major', 'minor', 'info'];

/** One step gentler; `info` is the floor. */
export function downgrade(severity) {
  const i = SEVERITY_ORDER.indexOf(severity);
  return SEVERITY_ORDER[Math.min(i + 1, SEVERITY_ORDER.length - 1)];
}
