import type { Container } from '../../platform/container.js';
import type {
  FindingActionKind,
  PrIntentRecord,
  RunEventKind,
  RunTrace,
  UnifiedDiff,
} from '@devdigest/shared';
import { AppError, NotFoundError } from '../../platform/errors.js';
import type { AgentRow } from '../../db/rows.js';
import { RunLogger } from '../../platform/run-logger.js';
import { ReviewRepository } from './repository.js';
import { type ReviewDto, type ReviewDtoFinding } from './helpers.js';
import { ReviewRunExecutor, type Logger } from './run-executor.js';
import { loadDiff } from './diff-loader.js';
import { deriveIntent } from './intent-pipeline.js';
import { INTENT_DERIVE_JOB_KIND } from './constants.js';

/** Payload of an `intent.derive` job. */
export interface IntentJobPayload {
  workspaceId: string;
  prId: string;
}
import { actOnFinding as actOnFindingImpl } from './findings.js';
import { reviewToDto } from './helpers.js';

// Re-export DTO types + converters for backward-compatible imports from
// './service.js' (these previously lived here; logic now in ./helpers.ts).
export { findingRowToDto, reviewToDto } from './helpers.js';
export type { ReviewDto, ReviewDtoFinding } from './helpers.js';

/**
 * Review service (the core). Orchestrates:
 *   diff → assemblePrompt(system + repo-map + diff)
 *        → llm.completeStructured({ schema: Review }) (single-pass)
 *        → groundFindings(...) (citation gate — drops findings off the diff)
 *        → persist reviews + kept findings (+ grounding summary)
 *   while streaming RunEvents over container.runBus, and on completion writing
 *   the whole log as ONE RunTrace doc + an agent_runs row.
 *
 * Also: the finding accept/dismiss actions. The bulky run execution lives in
 * run-executor; this class keeps the public method surface.
 */
export class ReviewService {
  private repo: ReviewRepository;
  private agents: Container['agentsRepo'];
  private executor: ReviewRunExecutor;

  constructor(private container: Container) {
    this.repo = new ReviewRepository(container.db);
    this.agents = container.agentsRepo;
    this.executor = new ReviewRunExecutor(container, this.repo, this.agents);
  }

  // ===========================================================================
  // Run a review for one or all enabled agents on a PR.
  // ===========================================================================

  /**
   * Resolve which agents to run. `all` → all enabled agents; else a single agent.
   */
  async resolveTargets(
    workspaceId: string,
    opts: { agentId?: string; all?: boolean },
  ): Promise<AgentRow[]> {
    if (opts.all) return this.agents.listEnabled(workspaceId);
    if (opts.agentId) {
      const agent = await this.agents.getById(workspaceId, opts.agentId);
      if (!agent) throw new NotFoundError('Agent not found');
      return [agent];
    }
    throw new AppError('invalid_run_request', 'Provide agentId or all:true', 400);
  }

  /** Delete a whole review run (one agent's pass) + its findings (cascade). */
  async deleteReview(workspaceId: string, reviewId: string): Promise<boolean> {
    return this.repo.deleteReview(workspaceId, reviewId);
  }

  /** In-flight runs for a PR (server-side source of truth, survives reload). */
  async activeRuns(workspaceId: string, prId: string) {
    return this.repo.activeRunsForPull(workspaceId, prId);
  }

  /** All runs for a PR (any status), newest first — the run history (incl. failures). */
  async listRuns(workspaceId: string, prId: string) {
    return this.repo.listRunsForPull(workspaceId, prId);
  }

  /** Delete one run from the history (+ its trace). */
  async deleteRun(workspaceId: string, runId: string): Promise<boolean> {
    return this.repo.deleteAgentRun(workspaceId, runId);
  }

  /**
   * Cancel an in-flight run. Signals a live runner to stop at its next
   * checkpoint AND marks the DB row cancelled + completes the bus immediately —
   * so cancel also works for ORPHANED runs (whose background process died on a
   * server restart) where signalling alone would do nothing.
   */
  async cancelRun(runId: string): Promise<void> {
    this.publish(runId, 'info', 'Cancellation requested — stopping…');
    this.container.runBus.cancel(runId);
    await this.repo.cancelRunIfRunning(runId);
    this.container.runBus.complete(runId);
  }

  /** Reap runs left 'running' by a previous (now-dead) process. Called on boot. */
  async reapStaleRuns(): Promise<number> {
    return this.repo.reapStaleRunningRuns();
  }

  /**
   * Run a review for each target agent. Each agent gets its own runId
   * (= agent_runs.id) created up-front so the SSE route can be subscribed
   * before/while the run progresses. A partial failure in one agent does not
   * abort the others.
   */
  async runReview(
    workspaceId: string,
    prId: string,
    targets: AgentRow[],
    logger?: Logger,
  ): Promise<{ runs: { run_id: string; agent_id: string; agent_name: string }[]; reviews: ReviewDto[] }> {
    const pull = await this.repo.getPull(workspaceId, prId);
    if (!pull) throw new NotFoundError('Pull request not found');
    const repo = await this.repo.getRepo(pull.repoId);
    if (!repo) throw new NotFoundError('Repo not found');

    // Create the agent_run rows up front so a runId is available IMMEDIATELY —
    // the client persists these in global state and subscribes to the SSE
    // stream. The actual (slow) review runs in the background below.
    const runs: { run_id: string; agent_id: string; agent_name: string }[] = [];
    const jobs: { agent: AgentRow; runId: string }[] = [];
    for (const agent of targets) {
      const runId = await this.repo.createAgentRun({
        workspaceId,
        agentId: agent.id,
        prId,
        provider: agent.provider,
        model: agent.model,
      });
      runs.push({ run_id: runId, agent_id: agent.id, agent_name: agent.name });
      jobs.push({ agent, runId });
    }

    // Fire-and-forget: the HTTP response returns now with the runIds; reviews
    // are persisted as each agent finishes and the client refetches on SSE done.
    void this.executor.executeRuns(workspaceId, pull, repo, jobs, logger).catch((err) => {
      logger?.error({ prId, err: (err as Error).message }, 'review: background execution crashed');
    });

    return { runs, reviews: [] };
  }

  private publish(runId: string, kind: RunEventKind, msg: string, data?: unknown) {
    return this.container.runBus.publish(runId, kind, msg, data);
  }

  // ===========================================================================
  // Finding actions
  // ===========================================================================

  async actOnFinding(
    workspaceId: string,
    findingId: string,
    action: FindingActionKind,
  ): Promise<{ finding: ReviewDtoFinding }> {
    return actOnFindingImpl(this.repo, workspaceId, findingId, action);
  }

  // ===========================================================================
  // Reads
  // ===========================================================================

  async reviewsForPull(workspaceId: string, prId: string): Promise<ReviewDto[]> {
    const pull = await this.repo.getPull(workspaceId, prId);
    if (!pull) throw new NotFoundError('Pull request not found');
    const rows = await this.repo.reviewsForPull(prId);
    const names = new Map<string, string>();
    for (const { review } of rows) {
      if (review.agentId && !names.has(review.agentId)) {
        const a = await this.agents.getById(workspaceId, review.agentId);
        if (a) names.set(review.agentId, a.name);
      }
    }
    return rows.map(({ review, findings }) =>
      reviewToDto(review, findings, review.agentId ? names.get(review.agentId) : null),
    );
  }

  async getRunTrace(runId: string): Promise<RunTrace | undefined> {
    return this.repo.getRunTrace(runId);
  }

  // ===========================================================================
  // L03 — intent layer
  // ===========================================================================

  /**
   * The PR's persisted intent, or null when nothing has been derived yet.
   * Deliberately never derives: a GET must not spend a model call.
   */
  async getIntent(workspaceId: string, prId: string): Promise<PrIntentRecord | null> {
    const pull = await this.repo.getPull(workspaceId, prId);
    if (!pull) throw new NotFoundError('Pull request not found');
    return (await this.repo.getIntent(prId)) ?? null;
  }

  /** Register the intent-derivation handler. Called once, from the routes plugin. */
  registerIntentJobHandler(): void {
    this.container.jobs.register(INTENT_DERIVE_JOB_KIND, async (payload) => {
      const { workspaceId, prId } = payload as IntentJobPayload;
      // Deliberately swallows: `runIntentDerivation` throws `AppError` when the
      // derivation yields nothing, and a REJECTED handler is retried twice by
      // JobRunner — three billed derivations for one broken model config. The
      // pipeline has already persisted (or deliberately not persisted) its own
      // outcome and logged the reason by the time we get here.
      await this.runIntentDerivation(workspaceId, prId).catch(() => undefined);
    });
  }

  /**
   * Queue a re-derivation (the "Re-derive" button). Returns the job id, or null
   * when the enqueue itself failed — the route answers 202 either way so the UI
   * has ONE path: poll the intent until it is fresh for the current head.
   *
   * The PR is validated HERE rather than in the handler, so an unknown id still
   * 404s instead of being accepted and silently discarded.
   */
  async enqueueIntentDerivation(workspaceId: string, prId: string): Promise<string | null> {
    const pull = await this.repo.getPull(workspaceId, prId);
    if (!pull) throw new NotFoundError('Pull request not found');
    try {
      const job = await this.container.jobs.enqueue(workspaceId, INTENT_DERIVE_JOB_KIND, {
        workspaceId,
        prId,
      } satisfies IntentJobPayload);
      return job.id;
    } catch {
      return null;
    }
  }

  /**
   * Run a derivation inline, ignoring the cached row. Used by the job handler
   * and by tests; NOT reachable from a route — the model call, the GitHub call
   * and the clone reads belong on `JobRunner`, not in a request.
   *
   * Throws `AppError` when the derivation yields nothing, so the one caller that
   * wants a hard failure (a test) gets one. The job handler catches it.
   */
  async runIntentDerivation(
    workspaceId: string,
    prId: string,
    logger?: Logger,
  ): Promise<PrIntentRecord> {
    const pull = await this.repo.getPull(workspaceId, prId);
    if (!pull) throw new NotFoundError('Pull request not found');
    const repo = await this.repo.getRepo(pull.repoId);
    if (!repo) throw new NotFoundError('Repository not found');

    const diff = await loadDiff(this.container, this.repo, workspaceId, pull, repo).catch(
      () => ({ raw: '', files: [] }) as UnifiedDiff,
    );

    // No runIds: this is not a review run, so the events mirror to pino only.
    const runLog = new RunLogger(this.container.runBus, [], logger, { prId });
    const outcome = await deriveIntent(this.container, this.repo, {
      workspaceId,
      pull,
      repo,
      diff,
      runLog,
      force: true,
    });
    if (!outcome.record) {
      throw new AppError(
        'intent_unavailable',
        `Could not derive the intent of this pull request (${outcome.reason ?? 'unknown'}).`,
        400,
      );
    }
    return outcome.record;
  }
}
