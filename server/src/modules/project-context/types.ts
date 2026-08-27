/**
 * project-context public types — SPEC-01.
 *
 * The module's second public surface after `constants.ts`
 * (`no-cross-module-internals` whitelists exactly those two files). `run-executor`
 * imports `ResolvedContext` from here in Cut 2, and that import is legal
 * precisely because this is `types.ts`.
 */

/** Why a resolved document did not make it into the prompt (AC-43/45/49). */
export type ContextSkipReason = 'unread' | 'oversize' | 'budget';

/**
 * What the run-start resolver hands back. Cut 2's `run-executor` turns `texts`
 * into the engine's `specs` input (AC-41), `injected` into the trace's
 * `specs_read` (AC-51), and `skipped` into `specs_skipped` (D-Q5).
 */
export interface ResolvedContext {
  /** Document bodies, in prompt order, already budget- and size-filtered. */
  texts: string[];
  /** Repository-relative paths of the documents in `texts`, same order. */
  injected: string[];
  /** Everything resolved but not injected, with the reason. */
  skipped: { path: string; reason: ContextSkipReason }[];
}

/**
 * The cross-module seam (D-OQ5). Exposed as `container.projectContext` so no
 * module reaches into this one's service.
 *
 * **It must never throw and never fail a review** — AC-47 and AC-48 are
 * absolute, and failing a run over the grounding layer is worse than reviewing
 * without it. Same posture as `container.repoIntel`: an empty result means "no
 * enrichment", not an error.
 *
 * IMPLEMENTED IN CUT 2 (plan steps 20–21). Declared here in Cut 1 so the seam's
 * shape is fixed and reviewed at the Cut-1 gate, before the resolver, the run
 * path and both attach surfaces are built on it.
 */
export interface ProjectContext {
  /**
   * Resolve, read, size-filter and budget-filter the documents a run should
   * inject: the agent's own attachments first in persisted order, then those
   * inherited from its enabled skills in skill order, de-duplicated on first
   * occurrence (AC-21, AC-22).
   *
   * Returns an empty `ResolvedContext` rather than throwing, for any reason.
   */
  resolveForRun(input: {
    workspaceId: string;
    agentId: string;
    repoOwner: string;
    repoName: string;
    /**
     * Optional Live Log sink, injected by the caller (Cut 2 addition — the only
     * change to this interface since the Cut-1 gate, and additive).
     *
     * There is no ambient logger below `routes.ts` in this codebase: the run's
     * `RunLogger` is the only logger that exists, and it is owned by
     * `run-executor`. Since AC-47 and AC-48 are absorbed INSIDE the facade, a
     * degrade would otherwise be invisible in the Live Log — so the sink is
     * injected the same way `reviewPullRequest` takes `onEvent`. AC-44 and
     * AC-46's per-document lines are still emitted by the caller from
     * `skipped`, not from here.
     */
    onLog?: (msg: string) => void;
  }): Promise<ResolvedContext>;
}
