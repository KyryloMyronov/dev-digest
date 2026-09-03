import { randomUUID } from 'node:crypto';
import type { Container } from '../../platform/container.js';
import type { Logger } from '../../platform/logger.js';
import { AGENT_VERSION_EVAL_JOB_KIND } from './constants.js';
import type { EvalTrigger, EvalTriggerField } from './types.js';
import { EvalRepository } from './repository.js';
import type { EvalService } from './service.js';

/**
 * SPEC-04 phase 2 — `container.evalTrigger`.
 *
 * WHY A FACADE AT ALL, since the spec's hop 13 draws `AgentsRepository.update`
 * calling `container.jobs.enqueue` directly: AC-87's debounce is an IN-MEMORY
 * pending marker, and it has to be consulted BEFORE the enqueue.
 * `JobRunner.enqueue` schedules on a p-queue immediately and exposes no cancel,
 * so de-duplicating a queued row after the fact is impossible. A marker the eval
 * module owns cannot be read from inside `agents`, so the seam is an interface
 * in `modules/eval/types.ts` (a legal cross-module import) with the
 * implementation here.
 *
 * Like `container.repoIntel`, it DEGRADES INSTEAD OF THROWING. AC-91 requires a
 * version bump to complete and return the agent even when no handler is
 * registered, and `jobs.enqueue` throws in exactly that case.
 */

/** AC-85 / plan D-13 — the exhaustive allow-list. Nothing else can enqueue. */
const TRIGGERING_FIELDS: ReadonlySet<EvalTriggerField> = new Set<EvalTriggerField>([
  'system_prompt',
  'model',
  'provider',
  'strategy',
  'output_schema',
  'skills',
]);

export interface AgentVersionEvalPayload {
  workspaceId: string;
  agentId: string;
  version: number;
}

const isPayload = (v: unknown): v is AgentVersionEvalPayload =>
  typeof v === 'object' &&
  v !== null &&
  typeof (v as AgentVersionEvalPayload).workspaceId === 'string' &&
  typeof (v as AgentVersionEvalPayload).agentId === 'string' &&
  typeof (v as AgentVersionEvalPayload).version === 'number';

export class EvalTriggerService implements EvalTrigger {
  /**
   * AC-87 / NFR-17 — agent ids with an `agent-version-eval` job queued or
   * running. In memory, per process, for the same reason the active-batch set
   * is: the queue holds no cancellable handle, so the only place a duplicate can
   * be refused is before it is scheduled.
   */
  private pending = new Set<string>();
  private repo: EvalRepository;

  constructor(
    private container: Container,
    private log: Logger,
    private service: EvalService,
  ) {
    this.repo = new EvalRepository(container.db);
  }

  /** Registers the second job kind. The batch loop itself is the service's. */
  registerJobHandler(): void {
    this.container.jobs.register(
      AGENT_VERSION_EVAL_JOB_KIND,
      async (payload, ctx) => {
        if (!isPayload(payload)) return;
        try {
          await this.handle(payload, ctx.jobId);
        } finally {
          // Cleared when the job FINISHES, not when it starts. "Already pending"
          // in AC-87 means queued-or-running: clearing at start would let a bump
          // landing one tick later queue a second job, and NFR-17's five rapid
          // edits would produce five. It is also what makes AC-88 reachable —
          // the bumps dropped while this job was in flight are exactly why its
          // payload can name a version the agent has already moved past.
          this.pending.delete(payload.agentId);
        }
      },
      // The same deadline the manual batch kind registers with: the batch loop
      // is the service's, so its timeout is too.
      { timeoutMs: this.service.jobTimeoutMs() },
    );
  }

  /** Test seam — AC-87's marker has to be observable to be mutation-checkable. */
  pendingAgents(): ReadonlySet<string> {
    return this.pending;
  }

  async onAgentVersionBumped(
    workspaceId: string,
    agentId: string,
    version: number,
    changed: readonly EvalTriggerField[],
  ): Promise<void> {
    // AC-85 — the allow-list, first. A bump that touched only `ci_fail_on`,
    // `repo_intel`, `name` or `description` still bumps and is still
    // snapshotted (AC-84); it just enqueues nothing.
    if (!changed.some((f) => TRIGGERING_FIELDS.has(f))) return;

    const agent = await this.container.agentsRepo.getById(workspaceId, agentId);
    if (!agent?.autoEval) return;

    // AC-87 / NFR-17 — five rapid bumps queue at most one job.
    if (this.pending.has(agentId)) return;
    this.pending.add(agentId);

    try {
      await this.container.jobs.enqueue(workspaceId, AGENT_VERSION_EVAL_JOB_KIND, {
        workspaceId,
        agentId,
        version,
      } satisfies AgentVersionEvalPayload);
    } catch (err) {
      // AC-91 — `jobs.enqueue` throws when no handler is registered
      // (`platform/jobs.ts:50-51`). The version bump must still complete and
      // return the agent, so this is swallowed and logged ONCE rather than
      // propagated. Degradation, not failure — the `repoIntel` posture.
      this.pending.delete(agentId);
      this.log.warn(
        { agent_id: agentId, version, err: (err as Error).message },
        'auto-eval not enqueued',
      );
    }
  }

  /**
   * The handler. Two skips, then the SAME batch loop a manual run uses.
   */
  private async handle(payload: AgentVersionEvalPayload, jobId: string): Promise<void> {
    const { workspaceId, agentId, version } = payload;

    const agent = await this.container.agentsRepo.getById(workspaceId, agentId);
    if (!agent) return;
    // AC-88 — the DURABLE half of the debounce. Five bumps that collapsed into
    // one job may still deliver a payload naming version 3 while the agent is
    // already on 7; measuring a config nobody is running is worse than not
    // measuring.
    if (agent.version > version) {
      this.log.info(
        { agent_id: agentId, payload_version: version, current_version: agent.version },
        'auto-eval skipped: stale version',
      );
      return;
    }
    // AC-89 — the same payload delivered twice must not bill a second batch.
    if (await this.repo.hasVersionChangeBatch(agentId, version)) {
      this.log.info({ agent_id: agentId, version }, 'auto-eval skipped: batch already exists');
      return;
    }

    const cases = await this.repo.casesForOwner(workspaceId, 'agent', agentId);
    if (cases.length === 0) return;

    const batchId = randomUUID();
    await this.repo.seedBatch(
      cases.map((c) => ({
        caseId: c.id,
        agentId,
        agentVersion: agent.version, // AC-32
        batchId,
        // AC-90 — `version-change` on EVERY row of this batch. It is also what
        // AC-89 reads back on the next delivery.
        trigger: 'version-change' as const,
      })),
    );

    // AC-92 / OQ-3 (plan D-1) — this kind registers with its own deadline
    // (`EVAL_BATCH_MAX_MS` + headroom, see `constants.ts`), so the JobRunner
    // timeout fires only on a batch that outran the spec's own wall clock. When
    // it does, `withTimeout` rejects the race but does NOT abort the underlying
    // promise (`platform/resilience.ts:13-24`), and `TimeoutError` carries no
    // status/code so `defaultIsRetryable` returns false: the `jobs` row goes
    // `failed` while this batch runs on and persists normally, and nothing
    // retries it. That is ACCEPTED. This timer is the one thing that makes the
    // two reconcilable by hand — it pairs the batch id with the job id at the
    // exact moment the row went red.
    const deadline = setTimeout(() => {
      this.log.error(
        { batch_id: batchId, job_id: jobId, agent_id: agentId, version },
        'auto-eval job exceeded the runner timeout; the batch is still running',
      );
    }, this.container.jobs.timeoutFor(AGENT_VERSION_EVAL_JOB_KIND));
    // Node would otherwise hold the process open for two minutes after a batch
    // that finished in one second.
    deadline.unref?.();

    try {
      await this.service.executeBatch({
        workspaceId,
        agentId,
        batchId,
        caseIds: cases.map((c) => c.id),
        trigger: 'version-change',
      });
    } catch (err) {
      this.log.error(
        { batch_id: batchId, job_id: jobId, agent_id: agentId, version, err: (err as Error).message },
        'auto-eval batch did not complete cleanly',
      );
      throw err;
    } finally {
      clearTimeout(deadline);
    }
  }
}
