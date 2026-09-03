import type { EvalExpectation, EvalExpectedFinding, Finding } from '@devdigest/shared';
import { reviewPullRequest } from '@devdigest/reviewer-core';
import type { Container } from '../../platform/container.js';
import type { Logger } from '../../platform/logger.js';
import { parseUnifiedDiff } from '../../adapters/git/diff-parser.js';
import { skillPromptBlock, toSkillDto } from '../_shared/skills.js';
import type { EvalRepository, PersistedActualOutput } from './repository.js';
import { scoreBatch, scoreCase, type ScoredCaseInput } from './scoring.js';

/**
 * SPEC-04 — the batch runner: one agent, N frozen cases, one `batch_id`.
 *
 * ONION. No third-party SDK appears here. The provider arrives already resolved
 * as an `LLMProvider` from `container.llm(agent.provider)`, and the engine
 * arrives as `reviewPullRequest` from `@devdigest/reviewer-core` — both of which
 * are ports, not vendors (`no-vendor-sdks-outside-adapters`).
 *
 * NOTHING on this path touches `container.git` or `container.github` (AC-31):
 * the reviewed diff is `parseUnifiedDiff(case.input_diff)`, frozen at case
 * creation, and a case outlives the branch it came from. It also never calls
 * `ReviewRunExecutor` and never writes an `agent_runs` row (AC-34) — an eval is
 * not a review of a pull request and must not pollute the run history.
 */

/** The agent config a batch runs under. Rows are the service's to fetch. */
export interface BatchAgent {
  id: string;
  version: number;
  provider: 'openai' | 'anthropic' | 'openrouter';
  model: string;
  systemPrompt: string;
  strategy: 'auto' | 'single-pass' | 'map-reduce';
}

/** One frozen case, as the runner needs it. */
export interface BatchCase {
  id: string;
  inputDiff: string;
  expectation: EvalExpectation;
  expectedOutput: readonly EvalExpectedFinding[];
  /** `input_meta.task` — AC-28's frozen task framing. */
  task: string | null;
}

export interface RunBatchInput {
  workspaceId: string;
  batchId: string;
  agent: BatchAgent;
  cases: readonly BatchCase[];
  trigger: 'manual' | 'version-change';
}

export interface RunBatchDeps {
  container: Container;
  repo: EvalRepository;
  log: Logger;
  /** Injected so a test can drive AC-110 without waiting on real time. */
  now?: () => number;
}

/**
 * The only shape the actual-finding side of the scorer needs. `Finding` carries
 * far more, and reading only these four fields is what keeps AC-57 honest:
 * `kind` is present so the LOG cannot claim it was unavailable, and is never
 * consulted by `matchesRange`.
 */
function toActual(f: Finding): { file: string; start_line: number; end_line: number; kind?: string | null } {
  return { file: f.file, start_line: f.start_line, end_line: f.end_line, kind: f.kind ?? null };
}

/**
 * AC-30 — one skill block per link whose `agent_skills.enabled` AND
 * `skills.enabled` are both true, in link order.
 *
 * These three lines duplicate `buildSkillBlocks`
 * (`modules/reviews/run-executor.ts`) deliberately, exactly as the spec says.
 * That method does I/O and run logging and lives in another module's private
 * file; `modules/_shared/skills.ts` is pure by convention and exists precisely
 * so a second module can compose the same blocks without importing the first.
 */
export function skillBlocksFor(
  links: readonly { skill: { enabled: boolean }; enabled: boolean }[],
): string[] {
  return links
    .filter((l) => l.enabled && l.skill.enabled)
    .map((l) => skillPromptBlock(toSkillDto(l.skill as Parameters<typeof toSkillDto>[0])));
}

/** Why a batch stopped short of its case list. Both leave it deriving `partial`. */
export type BatchStopReason = 'cost_ceiling' | 'wall_clock';

export interface RunBatchResult {
  batchId: string;
  casesRan: number;
  casesErrored: number;
  stoppedBy: BatchStopReason | null;
  totalCostUsd: number | null;
}

/**
 * Execute one batch, serially, updating each pre-inserted row in place.
 *
 * Plan D-2: the rows are seeded before the job runs, with every metric null. A case
 * the loop never reaches (AC-41's cost ceiling, AC-110's wall clock, a process
 * restart) keeps its all-null row, and that is exactly what makes the batch read
 * `partial` rather than `complete` — there is no status column to forget to set.
 */
export async function runBatch(
  input: RunBatchInput,
  deps: RunBatchDeps,
): Promise<RunBatchResult> {
  const { container, repo, log } = deps;
  const now = deps.now ?? (() => Date.now());
  const startedAt = now();

  const maxUsd = container.config.evalBatchMaxUsd;
  const maxMs = container.config.evalBatchMaxMs;

  // The rows were SEEDED ON THE REQUEST, before the job was enqueued — that is
  // what the spec's sequence diagram draws, and it is load-bearing rather than
  // cosmetic: the studio starts polling `GET /agents/:id/eval-runs` the moment
  // it has its 202, and a batch whose rows appear only once the queue picks the
  // job up would read as absent for as long as the queue is busy. AC-66's
  // running state would then flicker on rather than come on.
  const seeds = await repo.runsForBatch(input.workspaceId, input.batchId);
  const runIdByCase = new Map(seeds.map((s) => [s.caseId, s.id]));

  // Resolved ONCE for the batch: a per-case resolve would multiply the secret
  // lookup by the case count for no benefit, and AC-39 has already proven the
  // key resolves before the job was ever enqueued.
  const llm = await container.llm(input.agent.provider);
  const links = await container.agentsRepo.linkedSkills(input.agent.id);
  const skills = skillBlocksFor(links);

  const scored: ScoredCaseInput[] = [];
  const pricedCosts: number[] = [];
  let runningCost = 0;
  let casesErrored = 0;
  let stoppedBy: BatchStopReason | null = null;

  for (const c of input.cases) {
    // AC-110 — the wall clock, checked at the SAME checkpoint as the cost so a
    // batch can never start a call it has already run out of budget for.
    if (now() - startedAt > maxMs) {
      stoppedBy = 'wall_clock';
      break;
    }
    // AC-41 (plan D-12) — the estimate is the running MEAN of this batch's
    // completed, PRICED cases. It binds only once at least one case reported a
    // number: an unpriced model reports `null` throughout, the mean never
    // exists, the ceiling never binds, and AC-110's clock is the only limit
    // (OQ-6, unchanged).
    if (pricedCosts.length > 0) {
      const mean = pricedCosts.reduce((a, b) => a + b, 0) / pricedCosts.length;
      if (runningCost + mean > maxUsd) {
        stoppedBy = 'cost_ceiling';
        break;
      }
    }

    const runId = runIdByCase.get(c.id);
    if (!runId) continue;
    const caseStarted = now();

    try {
      // AC-31 — the reviewed diff is the case's OWN frozen text. No clone, no
      // GitHub call, no `container.git`.
      const diff = parseUnifiedDiff(c.inputDiff);
      const outcome = await reviewPullRequest({
        // AC-28 / AC-29 — these slots and NOTHING else. `specs`, `repoMap`,
        // `callers`, `memory`, `intent` and `prDescription` are OMITTED rather
        // than passed empty: `assemblePrompt` drops an absent section, and an
        // empty string would still render a heading. An eval measures the
        // system prompt, the model and the skills, holding the repository's
        // contribution constant at nothing.
        systemPrompt: input.agent.systemPrompt,
        model: input.agent.model,
        diff,
        llm,
        strategy: input.agent.strategy,
        ...(skills.length > 0 ? { skills } : {}),
        ...(c.task ? { task: c.task } : {}),
      });

      const actual = outcome.review.findings.map(toActual);
      const scoredCase: ScoredCaseInput = {
        caseId: c.id,
        expectation: c.expectation,
        expected: c.expectedOutput,
        actual,
        droppedCount: outcome.dropped.length,
      };
      scored.push(scoredCase);
      const perCase = scoreCase(scoredCase);

      // AC-58 — as reported or estimated, and NULL when neither. Never 0:
      // `z-ai/glm-4.7-flash` is genuinely priced at 0, so "free" and "unknown"
      // are distinct facts (root insights.md 2026-08-02).
      const costUsd = typeof outcome.costUsd === 'number' ? outcome.costUsd : null;
      if (costUsd !== null) {
        pricedCosts.push(costUsd);
        runningCost += costUsd;
      }

      const persisted: PersistedActualOutput = {
        findings: outcome.review.findings,
        counts: {
          expected: perCase.expectedCount,
          actual: perCase.actualCount,
          matched: perCase.matchedCount,
          noise: perCase.noiseCount,
          kept: perCase.actualCount,
          dropped: outcome.dropped.length,
        },
      };

      await repo.completeRun(runId, {
        actualOutput: persisted,
        pass: perCase.pass,
        recall:
          perCase.expectedCount === 0 ? null : perCase.matchedCount / perCase.expectedCount,
        precision:
          perCase.actualCount === 0 ? null : 1 - perCase.noiseCount / perCase.actualCount,
        citationAccuracy: perCase.citationAccuracy,
        durationMs: now() - caseStarted,
        costUsd,
        error: null,
      });

      // AC-113 / NFR-12 / NFR-16 — EXACTLY one info line per case, carrying the
      // batch id, the case id and the three metric values, and nothing else. No
      // diff, no expected output, no finding body, no provider message: an eval
      // case is purpose-built to hold attacker-shaped content and a customer's
      // frozen diff, and the log is the one place it must never reach.
      log.info(
        {
          batch_id: input.batchId,
          case_id: c.id,
          recall: perCase.expectedCount === 0 ? null : perCase.matchedCount / perCase.expectedCount,
          precision: perCase.actualCount === 0 ? null : 1 - perCase.noiseCount / perCase.actualCount,
          citation_accuracy: perCase.citationAccuracy,
        },
        'eval case scored',
      );
    } catch (err) {
      // AC-36 (provider failure) and AC-111 (post-retry schema failure) are the
      // same persistence: the row records the message and THE BATCH CONTINUES.
      // One dead case must not cost the other nineteen.
      casesErrored += 1;
      scored.push({
        caseId: c.id,
        expectation: c.expectation,
        expected: c.expectedOutput,
        actual: [],
        droppedCount: 0,
        errored: true,
      });
      await repo.completeRun(runId, {
        pass: null,
        durationMs: now() - caseStarted,
        costUsd: null,
        error: truncateError(err),
      });
      log.info(
        {
          batch_id: input.batchId,
          case_id: c.id,
          recall: null,
          precision: null,
          citation_accuracy: null,
        },
        'eval case scored',
      );
    }
  }

  // Computed for the caller's benefit only — the SERVED batch metrics are
  // derived from the rows on read (plan D-2), so there is nothing to write here
  // and no second copy to drift.
  const batch = scoreBatch(scored);

  return {
    batchId: input.batchId,
    casesRan: batch.tracesTotal - casesErrored,
    casesErrored,
    stoppedBy,
    totalCostUsd: pricedCosts.length > 0 ? runningCost : null,
  };
}

/** Provider messages can be a page of HTML; the column is not a transcript. */
function truncateError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.length > 500 ? `${msg.slice(0, 500)}…` : msg;
}
