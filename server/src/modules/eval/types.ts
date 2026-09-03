/**
 * SPEC-04 — the eval module's PUBLIC surface, half two.
 *
 * INTERFACES ONLY. Nothing here may import this module's service, repository,
 * runner or routes: `types.ts` is importable from outside the module, so an
 * import here would drag a private file across the boundary with it.
 */

/** The allow-listed config fields whose change can trigger an auto-eval (AC-85). */
export type EvalTriggerField =
  | 'system_prompt'
  | 'model'
  | 'provider'
  | 'strategy'
  | 'output_schema'
  | 'skills';

/**
 * `container.evalTrigger` — the seam the `agents` module calls after a version
 * bump, so it never learns that an eval module exists.
 *
 * Why a facade rather than `jobs.enqueue` straight from `AgentsRepository`
 * (which is what the spec's hop 13 draws): AC-87's debounce is an IN-MEMORY
 * pending marker owned by this module. `JobRunner.enqueue` schedules on a
 * p-queue immediately and exposes no cancel, so de-duplicating after the fact is
 * impossible; the marker has to be consulted BEFORE enqueueing, and a marker
 * this module owns cannot be read from inside `agents`.
 *
 * Like `container.repoIntel`, it DEGRADES instead of throwing — AC-91 requires
 * a version bump to complete and return the agent even when no `eval-batch`
 * handler is registered.
 */
export interface EvalTrigger {
  /**
   * Called after `agents.version` was bumped and snapshotted.
   *
   * @param changed the config fields this bump actually changed. Only the
   *   allow-list above can trigger a batch; `ci_fail_on`, `repo_intel`, `name`
   *   and `description` bump the version and enqueue nothing (AC-85, D-13).
   */
  onAgentVersionBumped(
    workspaceId: string,
    agentId: string,
    version: number,
    changed: readonly EvalTriggerField[],
  ): Promise<void>;
}
