/**
 * The prompt budget for one run's project context, mirrored on the client.
 *
 * The server owns the enforcement (`PROJECT_CONTEXT_TOKEN_BUDGET` in
 * `modules/project-context/constants.ts` — it is where AC-45 stops adding
 * documents). This copy exists only so the footer can turn red BEFORE a run
 * silently drops documents (AC-33). Kept as ONE named constant on this side too,
 * so the two numbers move in one edit each rather than being scattered.
 */
export const PROJECT_CONTEXT_TOKEN_BUDGET = 8000;
