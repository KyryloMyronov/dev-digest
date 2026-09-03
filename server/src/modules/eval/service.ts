import { randomUUID } from 'node:crypto';
import type {
  EvalBatchAccepted,
  EvalBatchEstimate,
  EvalBatchRecord,
  EvalCase,
  EvalCaseInput,
  EvalDashboard,
  EvalDashboardAgentRow,
  EvalExpectedFinding,
  EvalExpectation,
  EvalWorkspaceDashboard,
} from '@devdigest/shared';
import type { Container } from '../../platform/container.js';
import type { Logger } from '../../platform/logger.js';
import { NotFoundError, ValidationError } from '../../platform/errors.js';
import { parseUnifiedDiff } from '../../adapters/git/diff-parser.js';
import type { EvalCaseRow } from '../../db/rows.js';
import { EvalRepository } from './repository.js';
import { buildCaseFromFinding } from './case-builder.js';
import { runBatch, type BatchAgent, type BatchCase } from './runner.js';
import { alertFor, alertSentence } from './scoring.js';
import {
  AGENT_VERSION_EVAL_JOB_KIND,
  EVAL_BATCH_JOB_KIND,
  MAX_BATCHES_RETURNED,
  MAX_CASES_PER_AGENT,
  MAX_INPUT_DIFF_BYTES,
  EVAL_JOB_TIMEOUT_HEADROOM_MS,
} from './constants.js';

/**
 * SPEC-04 — the eval module's application service.
 *
 * CROSS-MODULE READS GO THROUGH THE CONTAINER, never through another module's
 * folder: `container.reviewRepo` (finding context, pr_files) and
 * `container.agentsRepo` (agent config, skill links) are the two published
 * seams `.dependency-cruiser.cjs` names. Nothing else in `modules/reviews/` or
 * `modules/agents/` is importable from here, and nothing here reaches for it.
 */

/** The payload of an `eval-batch` job. */
export interface EvalBatchJobPayload {
  workspaceId: string;
  agentId: string;
  batchId: string;
  caseIds: string[] | null;
  trigger: 'manual' | 'version-change';
}

const isEvalBatchPayload = (v: unknown): v is EvalBatchJobPayload =>
  typeof v === 'object' &&
  v !== null &&
  typeof (v as EvalBatchJobPayload).workspaceId === 'string' &&
  typeof (v as EvalBatchJobPayload).agentId === 'string' &&
  typeof (v as EvalBatchJobPayload).batchId === 'string';

export class EvalService {
  private repo: EvalRepository;

  /**
   * The IN-MEMORY active-batch registry (plan D-1/D-2).
   *
   * `batch_id`s currently executing. It is the whole source of the `running`
   * status — there is no status column — and it is deliberately per-process:
   * after a restart the set is empty and an interrupted batch reads `partial`,
   * which is TRUE. Nothing re-drives a `jobs` row after a restart
   * (`platform/jobs.ts`), so a stored `running` would be a lie that never
   * cleared itself.
   */
  private activeBatchIds = new Set<string>();
  /** agentId → batchId, for AC-40's "already running" refusal. */
  private activeByAgent = new Map<string, string>();

  /**
   * `repo` is injectable so the unit suite can drive every refusal without
   * Docker. It defaults to the real one, so the composition root passes two
   * arguments exactly as every other service does.
   */
  constructor(
    private container: Container,
    private log: Logger,
    repo?: EvalRepository,
  ) {
    this.repo = repo ?? new EvalRepository(container.db);
  }

  /** Called once at composition time. Both kinds run the SAME batch loop. */
  registerJobHandlers(): void {
    this.container.jobs.register(
      EVAL_BATCH_JOB_KIND,
      async (payload) => {
        if (!isEvalBatchPayload(payload)) return;
        await this.executeBatch(payload);
      },
      { timeoutMs: this.jobTimeoutMs() },
    );
  }

  /**
   * The deadline both eval job kinds register with: the batch's own wall clock
   * (AC-110) plus the headroom for the case in flight when it expires. Derived,
   * not duplicated, so `EVAL_BATCH_MAX_MS` stays the single knob.
   */
  jobTimeoutMs(): number {
    return this.container.config.evalBatchMaxMs + EVAL_JOB_TIMEOUT_HEADROOM_MS;
  }

  /** Exposed for the phase-2 trigger, which registers the second kind itself. */
  get batchJobKinds(): readonly string[] {
    return [EVAL_BATCH_JOB_KIND, AGENT_VERSION_EVAL_JOB_KIND];
  }

  activeBatches(): ReadonlySet<string> {
    return this.activeBatchIds;
  }

  // ======================================================================
  // Cases
  // ======================================================================

  async listCases(workspaceId: string, agentId: string): Promise<EvalCase[]> {
    await this.requireAgent(workspaceId, agentId);
    const rows = await this.repo.casesForOwner(workspaceId, 'agent', agentId);
    return rows.map(toCaseDto);
  }

  async getCase(workspaceId: string, id: string): Promise<EvalCase> {
    const row = await this.repo.getCase(workspaceId, id);
    // AC-4 — a case belonging to another workspace is INDISTINGUISHABLE from one
    // that does not exist. Anything else is an existence oracle.
    if (!row) throw new NotFoundError('Eval case not found');
    return toCaseDto(row);
  }

  /**
   * AC-19-AC-25, AC-106, AC-107, AC-114 — create a case by hand.
   *
   * AC-114 is the criterion with the widest blast radius in the spec, so the
   * field list is written out LONGHAND and the body is never spread: the
   * workspace comes from the resolved context, the owner from the PATH. A body
   * carrying `owner_id`, `owner_kind` or a workspace cannot move the row.
   */
  async createCase(
    workspaceId: string,
    agentId: string,
    body: EvalCaseInput,
  ): Promise<EvalCase> {
    await this.requireAgent(workspaceId, agentId);
    // AC-3 — a skill-owned case is refused, not accepted-and-ignored: nothing in
    // this feature runs a skill's cases, and a case the system will never
    // execute is worse than no case.
    if (body.owner_kind === 'skill') {
      throw new ValidationError('Eval cases for skills are not supported', {
        path: ['owner_kind'],
      });
    }
    this.assertCaseBody(body.input_diff, body.expectation, body.expected_output);

    // AC-107 — the per-agent ceiling.
    const existing = await this.repo.countCasesForOwner(workspaceId, 'agent', agentId);
    if (existing >= MAX_CASES_PER_AGENT) {
      throw new ValidationError(
        `An agent may hold at most ${MAX_CASES_PER_AGENT} eval cases`,
        { path: ['owner_id'], limit: MAX_CASES_PER_AGENT },
      );
    }

    const row = await this.repo.insertCase({
      workspaceId,
      ownerKind: 'agent',
      ownerId: agentId,
      name: body.name,
      inputDiff: body.input_diff,
      inputFiles: body.input_files ?? null,
      inputMeta: body.input_meta ?? null,
      expectedOutput: body.expected_output,
      expectation: body.expectation,
      notes: body.notes ?? null,
    });
    return toCaseDto(row);
  }

  async updateCase(workspaceId: string, id: string, body: EvalCaseInput): Promise<EvalCase> {
    const existing = await this.repo.getCase(workspaceId, id);
    if (!existing) throw new NotFoundError('Eval case not found');
    this.assertCaseBody(body.input_diff, body.expectation, body.expected_output);

    // Named fields only (AC-114). `owner_kind`, `owner_id` and the workspace are
    // NOT in this list on purpose: an update must not be able to re-home a row.
    const row = await this.repo.updateCase(workspaceId, id, {
      name: body.name,
      inputDiff: body.input_diff,
      inputFiles: body.input_files ?? null,
      inputMeta: body.input_meta ?? null,
      expectedOutput: body.expected_output,
      expectation: body.expectation,
      notes: body.notes ?? null,
    });
    if (!row) throw new NotFoundError('Eval case not found');
    return toCaseDto(row);
  }

  /** AC-26 — the runs go with it, by `ON DELETE CASCADE`; see the repository. */
  async deleteCase(workspaceId: string, id: string): Promise<void> {
    const gone = await this.repo.deleteCase(workspaceId, id);
    if (!gone) throw new NotFoundError('Eval case not found');
  }

  /**
   * AC-5-AC-18 — turn an accepted or dismissed finding into a frozen case.
   *
   * Returns `created: false` when AC-16's idempotency hit, so the route can
   * answer 200 instead of 201 without re-deriving why.
   */
  async createCaseFromFinding(
    workspaceId: string,
    findingId: string,
  ): Promise<{ case: EvalCase; created: boolean }> {
    const ctx = await this.container.reviewRepo.findingContext(findingId);
    if (!ctx) throw new NotFoundError('Finding not found');
    // AC-4 — tenancy is the PULL's workspace; a finding of a foreign PR 404s.
    if (ctx.pull.workspaceId !== workspaceId) throw new NotFoundError('Finding not found');

    // AC-18 — a review that predates agent attribution has no agent to own the
    // case, and an ownerless case can never be run.
    const agentId = ctx.review.agentId;
    if (!agentId) {
      throw new ValidationError('That finding’s review is not attributed to an agent', {
        path: ['review', 'agent_id'],
      });
    }
    await this.requireAgent(workspaceId, agentId);

    // AC-16 — idempotent by SOURCE FINDING ID, before anything is built.
    const already = await this.repo.caseBySourceFinding(workspaceId, agentId, findingId);
    if (already) return { case: toCaseDto(already), created: false };

    const existingCases = await this.repo.casesForOwner(workspaceId, 'agent', agentId);
    if (existingCases.length >= MAX_CASES_PER_AGENT) {
      throw new ValidationError(
        `An agent may hold at most ${MAX_CASES_PER_AGENT} eval cases`,
        { limit: MAX_CASES_PER_AGENT },
      );
    }

    const prFiles = await this.container.reviewRepo.getPrFiles(ctx.pull.id);
    const built = buildCaseFromFinding({
      finding: ctx.finding,
      pull: ctx.pull,
      prFiles,
      existingNames: existingCases.map((c) => c.name),
    });
    // AC-17 — the builder REFUSES rather than throwing; the 422 is decided here,
    // where the transport taxonomy lives.
    if (!built.ok) {
      throw new ValidationError('That finding’s file is not part of its pull request’s diff', {
        path: ['finding', 'file'],
      });
    }
    if (Buffer.byteLength(built.value.inputDiff, 'utf8') > MAX_INPUT_DIFF_BYTES) {
      throw new ValidationError('The frozen diff exceeds the 256 KB ceiling', {
        path: ['input_diff'],
        limit: MAX_INPUT_DIFF_BYTES,
      });
    }

    const row = await this.repo.insertCase({
      workspaceId,
      ownerKind: 'agent',
      ownerId: agentId,
      name: built.value.name,
      inputDiff: built.value.inputDiff,
      inputMeta: built.value.inputMeta,
      expectedOutput: built.value.expectedOutput,
      expectation: built.value.expectation,
    });
    return { case: toCaseDto(row), created: true };
  }

  // ======================================================================
  // Running a batch — the 202 path (plan D-1)
  // ======================================================================

  /**
   * AC-27 / AC-35 / AC-39 / AC-40 — validate synchronously, enqueue, answer 202.
   *
   * The order is load-bearing. `container.llm` is awaited BEFORE the batch id
   * exists, so AC-39's missing key is a `config_error` on the request rather
   * than a batch that fails silently on the queue — "before any model call" is
   * literally true because nothing has been enqueued yet.
   */
  async acceptAgentBatch(
    workspaceId: string,
    agentId: string,
    caseIds: string[] | null = null,
  ): Promise<EvalBatchAccepted> {
    const agent = await this.requireAgent(workspaceId, agentId);

    const cases = await this.repo.casesForOwner(workspaceId, 'agent', agentId);
    const selected = caseIds ? cases.filter((c) => caseIds.includes(c.id)) : cases;
    // AC-35 — nothing to measure is a refusal, not an empty batch.
    if (selected.length === 0) {
      throw new ValidationError('That agent has no eval cases to run', { path: ['agent_id'] });
    }
    // AC-40 — one batch per agent at a time.
    if (this.activeByAgent.has(agentId)) {
      throw new ValidationError('A batch is already running for that agent', {
        path: ['agent_id'],
      });
    }
    // AC-39 — throws ConfigError → 500 `config_error`, before any model call.
    await this.container.llm(agent.provider as BatchAgent['provider']);

    const batchId = randomUUID();
    this.markActive(agentId, batchId);
    // Plan D-2 / the spec's sequence diagram: MATERIALISE THE BATCH BEFORE THE
    // ENQUEUE. The studio begins polling as soon as it has this 202, and a batch
    // whose rows only appear when the queue reaches the job would read as
    // absent — not `running` — for as long as the queue is busy.
    await this.repo.seedBatch(
      selected.map((c) => ({
        caseId: c.id,
        agentId,
        agentVersion: agent.version, // AC-32
        batchId,
        trigger: 'manual' as const, // AC-33
      })),
    );
    try {
      await this.container.jobs.enqueue(workspaceId, EVAL_BATCH_JOB_KIND, {
        workspaceId,
        agentId,
        batchId,
        caseIds: selected.map((c) => c.id),
        trigger: 'manual',
      } satisfies EvalBatchJobPayload);
    } catch (err) {
      // A queue that will not take the job must not leave the agent wedged.
      this.clearActive(agentId, batchId);
      throw err;
    }
    return { status: 'accepted', batch_id: batchId, cases: selected.length, agent_id: agentId };
  }

  /** D-9 / AC-116 — a ONE-CASE batch over the same runner and the same scoring. */
  async acceptCaseRun(workspaceId: string, caseId: string): Promise<EvalBatchAccepted> {
    const row = await this.repo.getCase(workspaceId, caseId);
    if (!row) throw new NotFoundError('Eval case not found');
    if (row.ownerKind !== 'agent') {
      throw new ValidationError('Only agent-owned eval cases can be run', {
        path: ['owner_kind'],
      });
    }
    return this.acceptAgentBatch(workspaceId, row.ownerId, [row.id]);
  }

  /**
   * AC-42 / AC-43 — one batch per ENABLED agent that has at least one case.
   *
   * An agent whose provider key does not resolve is SKIPPED with
   * `degraded: true` rather than failing the whole request. No AC covers this;
   * it is a plan decision, and the reason is that "run all agents" is a bulk
   * action — one misconfigured agent must not deny the other nine their batch.
   */
  async acceptWorkspaceRun(workspaceId: string): Promise<EvalBatchAccepted[]> {
    const agents = await this.container.agentsRepo.listEnabled(workspaceId);
    const withCases = await this.repo.agentIdsWithCases(
      workspaceId,
      agents.map((a) => a.id),
    );
    const out: EvalBatchAccepted[] = [];
    for (const agent of agents) {
      if (!withCases.has(agent.id)) continue;
      try {
        out.push(await this.acceptAgentBatch(workspaceId, agent.id));
      } catch (err) {
        out.push({
          status: 'accepted',
          batch_id: null,
          cases: 0,
          degraded: true,
          reason: reasonOf(err),
          agent_id: agent.id,
        });
      }
    }
    return out;
  }

  /**
   * The job handler's body. Also called directly by the phase-2 trigger, so the
   * two paths cannot diverge.
   */
  async executeBatch(payload: EvalBatchJobPayload): Promise<void> {
    const { workspaceId, agentId, batchId } = payload;
    const agentRow = await this.container.agentsRepo.getById(workspaceId, agentId);
    if (!agentRow) {
      this.clearActive(agentId, batchId);
      return;
    }
    const all = await this.repo.casesForOwner(workspaceId, 'agent', agentId);
    const cases = payload.caseIds ? all.filter((c) => payload.caseIds!.includes(c.id)) : all;

    this.markActive(agentId, batchId);
    try {
      await runBatch(
        {
          workspaceId,
          batchId,
          agent: {
            id: agentRow.id,
            version: agentRow.version,
            provider: agentRow.provider as BatchAgent['provider'],
            model: agentRow.model,
            systemPrompt: agentRow.systemPrompt,
            strategy: agentRow.strategy as BatchAgent['strategy'],
          },
          cases: cases.map(toBatchCase),
          trigger: payload.trigger,
        },
        { container: this.container, repo: this.repo, log: this.log },
      );
    } finally {
      // ALWAYS clears, including on a throw: a batch that stays marked active
      // would read `running` forever and AC-40 would refuse the agent for the
      // process's whole lifetime.
      this.clearActive(agentId, batchId);
    }
  }

  // ======================================================================
  // Reads
  // ======================================================================

  async batchesForAgent(workspaceId: string, agentId: string): Promise<EvalBatchRecord[]> {
    await this.requireAgent(workspaceId, agentId);
    return this.repo.batchesForAgent(workspaceId, agentId, this.activeBatchIds);
  }

  /** AC-72 — what "Run all agents" would cost, before the click. */
  async estimate(workspaceId: string): Promise<EvalBatchEstimate> {
    const agents = await this.container.agentsRepo.listEnabled(workspaceId);
    const counts = await this.repo.caseCountsByAgent(workspaceId);
    let cases = 0;
    let agentCount = 0;
    for (const a of agents) {
      const n = counts.get(a.id) ?? 0;
      if (n === 0) continue;
      agentCount += 1;
      cases += n;
    }
    const mean = await this.repo.meanPricedCaseCost(workspaceId);
    // `null` means "no priced batch to extrapolate from" — which the studio must
    // render as unknown, NEVER as $0.00 (root insights.md 2026-08-02).
    return { agents: agentCount, cases, est_cost_usd: mean === null ? null : mean * cases };
  }

  /** AC-69, AC-70, AC-71, AC-108 — `/eval`. */
  async workspaceDashboard(workspaceId: string): Promise<EvalWorkspaceDashboard> {
    const [agents, counts, batches, casesTotal] = await Promise.all([
      this.container.agentsRepo.list(workspaceId),
      this.repo.caseCountsByAgent(workspaceId),
      this.repo.batchesForWorkspace(workspaceId, this.activeBatchIds, MAX_BATCHES_RETURNED),
      this.repo.countCasesInWorkspace(workspaceId),
    ]);

    const latestByAgent = new Map<string, EvalBatchRecord>();
    for (const b of batches) {
      if (b.agent_id && !latestByAgent.has(b.agent_id)) latestByAgent.set(b.agent_id, b);
    }

    const rows: EvalDashboardAgentRow[] = agents.map((a) => {
      const latest = latestByAgent.get(a.id) ?? null;
      return {
        agent_id: a.id,
        agent_name: a.name,
        agent_version: a.version,
        enabled: a.enabled,
        cases_total: counts.get(a.id) ?? 0,
        // Spec D-5 — an agent with cases and no batch renders its case count and
        // NO metrics. Nulls here, not zeroes: it has not scored 0, it has not run.
        latest_batch_id: latest?.batch_id ?? null,
        latest_ran_at: latest?.ran_at ?? null,
        recall: latest?.recall ?? null,
        precision: latest?.precision ?? null,
        citation_accuracy: latest?.citation_accuracy ?? null,
        traces_passed: latest?.traces_passed ?? null,
        traces_total: latest?.traces_total ?? null,
        cost_usd: latest?.cost_usd ?? null,
      };
    });

    return { agents: rows, batches, cases_total: casesTotal };
  }

  /** AC-73 / AC-74 — `/eval/agents/:agentId`. */
  async agentDashboard(workspaceId: string, agentId: string): Promise<EvalDashboard> {
    const agent = await this.requireAgent(workspaceId, agentId);
    const batches = await this.repo.batchesForAgent(
      workspaceId,
      agentId,
      this.activeBatchIds,
      MAX_BATCHES_RETURNED,
    );
    const casesTotal = await this.repo.countCasesForOwner(workspaceId, 'agent', agentId);

    const [current, previous] = batches; // newest first
    const alert = alertFor(previous ?? null, current ?? null);
    // AC-63 — the per-case expected/actual counts the Evals tab renders. Only
    // the latest batch: the tab shows "what this case did last time", not a
    // history, and the batch table above it already carries the history.
    const recentRuns = current
      ? await this.repo.runRecordsForBatch(workspaceId, current.batch_id)
      : [];

    return {
      owner_kind: 'agent',
      owner_id: agentId,
      cases_total: casesTotal,
      // `EvalDashboard.current` is a SHIPPED shape with non-nullable numbers, so
      // it cannot express "not computed". It is filled with 0 and left as the
      // legacy surface; `batches` below is what SPEC-04's screens read, and it
      // carries the honest nulls.
      current: {
        recall: current?.recall ?? 0,
        precision: current?.precision ?? 0,
        citation_accuracy: current?.citation_accuracy ?? 0,
        traces_passed: current?.traces_passed ?? 0,
        traces_total: current?.traces_total ?? 0,
        cost_usd: current?.cost_usd ?? null,
      },
      delta: {
        recall: delta(current?.recall, previous?.recall),
        precision: delta(current?.precision, previous?.precision),
        citation_accuracy: delta(current?.citation_accuracy, previous?.citation_accuracy),
      },
      trend: [],
      recent_runs: recentRuns,
      // AC-74 — the server ships a convenience sentence that NOTHING reads; the
      // studio composes its banner from the two structured fields through
      // next-intl (plan D-14), so the English lives in the catalogue.
      alert: alertSentence(alert),
      batches,
      alert_metric: alert?.metric ?? null,
      alert_delta: alert?.delta ?? null,
      agent_name: agent.name,
      agent_version: agent.version,
    };
  }

  // ======================================================================
  // Internals
  // ======================================================================

  private markActive(agentId: string, batchId: string): void {
    this.activeBatchIds.add(batchId);
    this.activeByAgent.set(agentId, batchId);
  }

  private clearActive(agentId: string, batchId: string): void {
    this.activeBatchIds.delete(batchId);
    if (this.activeByAgent.get(agentId) === batchId) this.activeByAgent.delete(agentId);
  }

  /** AC-4 — unknown OR foreign resolves the same way: 404. */
  private async requireAgent(workspaceId: string, agentId: string) {
    const agent = await this.container.agentsRepo.getById(workspaceId, agentId);
    if (!agent) throw new NotFoundError('Agent not found');
    return agent;
  }

  /** AC-22, AC-23, AC-24, AC-106 — the body rules shared by create and update. */
  private assertCaseBody(
    inputDiff: string,
    expectation: EvalExpectation,
    expected: readonly EvalExpectedFinding[],
  ): void {
    // AC-106 / NFR-5 — measured in BYTES, not characters: a diff of emoji is
    // four times the length its `.length` reports.
    if (Buffer.byteLength(inputDiff, 'utf8') > MAX_INPUT_DIFF_BYTES) {
      throw new ValidationError('input_diff exceeds the 256 KB ceiling', {
        path: ['input_diff'],
        limit: MAX_INPUT_DIFF_BYTES,
      });
    }
    // AC-24 — prose, whitespace or a hand-edited fragment that parses to zero
    // files would score citation accuracy 0 forever, silently (spec D-7).
    if (parseUnifiedDiff(inputDiff).files.length === 0) {
      throw new ValidationError('input_diff does not parse to any file', {
        path: ['input_diff'],
      });
    }
    // AC-23 — a must_find case with nothing to find asserts nothing.
    // AC-22 — a must_not_flag case with an empty array is the NORMAL shape.
    if (expectation === 'must_find' && expected.length === 0) {
      throw new ValidationError('A must_find case needs at least one expected finding', {
        path: ['expected_output'],
      });
    }
  }
}

// -------------------------------------------------------------- pure mappers

/** Row → DTO at the boundary. Kept pure and out of the class on purpose. */
export function toCaseDto(row: EvalCaseRow): EvalCase {
  return {
    id: row.id,
    owner_kind: row.ownerKind,
    owner_id: row.ownerId,
    name: row.name,
    input_diff: row.inputDiff ?? '',
    input_files: row.inputFiles ?? null,
    input_meta: row.inputMeta ?? null,
    expected_output: (row.expectedOutput ?? []) as EvalExpectedFinding[],
    expectation: row.expectation,
    notes: row.notes,
  };
}

function toBatchCase(row: EvalCaseRow): BatchCase {
  const meta = row.inputMeta as { task?: unknown } | null;
  return {
    id: row.id,
    inputDiff: row.inputDiff ?? '',
    expectation: row.expectation,
    expectedOutput: (row.expectedOutput ?? []) as EvalExpectedFinding[],
    task: typeof meta?.task === 'string' ? meta.task : null,
  };
}

const delta = (a: number | null | undefined, b: number | null | undefined): number =>
  typeof a === 'number' && typeof b === 'number' ? a - b : 0;

/** The `reason` on a skipped agent's degraded entry — a code, never a message. */
function reasonOf(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : 'error';
}
