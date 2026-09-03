import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  EvalBatchAccepted,
  EvalBatchEstimate,
  EvalBatchRecord,
  EvalCase,
  EvalCaseInput,
  EvalDashboard,
  EvalWorkspaceDashboard,
} from '@devdigest/shared';
import { getContext } from '../_shared/context.js';
import { IdParams } from '../_shared/schemas.js';
import type { EvalService } from './service.js';

/**
 * SPEC-04 — the eval module's transport layer. Thirteen routes, no logic.
 *
 * TWO THINGS THAT ARE NOT TASTE:
 *
 *  1. **Anything under `/agents/` uses `:id`.** The agents module already
 *     registers `/agents/:id/*`; a second param NAME on the same prefix is a
 *     find-my-way conflict, not a stylistic difference. `:agentId` appears only
 *     under the different `/eval/agents/:agentId` prefix.
 *  2. **The four action POSTs declare NO `body:` schema.** They take no body,
 *     and a declared Zod body schema REJECTS a body-less POST with 422
 *     (`server/insights.md` 2026-08-29). `eval-routes.test.ts` proves each one
 *     answers 202 to an empty request, because the failure mode is quiet enough
 *     to ship a criterion green and unproven.
 *
 * A declared `response:` schema also STRIPS unknown keys, so each service
 * return shape is exactly the contract it is serialised against.
 */

const AgentIdParams = z.object({ agentId: z.string().uuid() });

export default async function evalRoutes(appBase: FastifyInstance) {
  const app = appBase.withTypeProvider<ZodTypeProvider>();
  const { container } = app;
  // Resolved from the COMPOSITION ROOT, not constructed here: the service owns
  // the in-memory active-batch registry, and the phase-2 trigger runs its
  // batches through the same instance. Two would mean two registries — AC-40
  // would stop refusing a concurrent batch.
  const service = container.evalService;
  service.registerJobHandlers();
  // Touched once so the composition root constructs it and registers the
  // `agent-version-eval` handler; AC-91 is what happens when it is overridden
  // with something that registers nothing.
  void container.evalTrigger;
  // Decorated for the test suite, which mounts this plugin directly.
  app.decorate('evalService', service);

  // ---- cases ---------------------------------------------------------------

  /** AC-5-AC-18. 201 when created, **200** when AC-16's idempotency hit. */
  app.post(
    '/findings/:id/eval-case',
    { schema: { params: IdParams, response: { 200: EvalCase, 201: EvalCase } } },
    async (req, reply) => {
      const { workspaceId } = await getContext(container, req);
      const { case: dto, created } = await service.createCaseFromFinding(
        workspaceId,
        req.params.id,
      );
      reply.code(created ? 201 : 200);
      return dto;
    },
  );

  app.get(
    '/agents/:id/eval-cases',
    { schema: { params: IdParams, response: { 200: z.array(EvalCase) } } },
    async (req) => {
      const { workspaceId } = await getContext(container, req);
      return service.listCases(workspaceId, req.params.id);
    },
  );

  /**
   * AC-19-AC-25, AC-107, AC-109. The body schema is what delivers AC-19 and
   * AC-109 — `EvalCaseInput.expected_output` is `z.array(EvalExpectedFinding).max(20)`,
   * so a 21-entry array and a wrong-shaped entry are both 422 with the failing
   * Zod path in `error.details` (AC-20), before the service is reached.
   */
  app.post(
    '/agents/:id/eval-cases',
    { schema: { params: IdParams, body: EvalCaseInput, response: { 201: EvalCase } } },
    async (req, reply) => {
      const { workspaceId } = await getContext(container, req);
      const dto = await service.createCase(workspaceId, req.params.id, req.body);
      reply.code(201);
      return dto;
    },
  );

  app.get(
    '/eval-cases/:id',
    { schema: { params: IdParams, response: { 200: EvalCase } } },
    async (req) => {
      const { workspaceId } = await getContext(container, req);
      return service.getCase(workspaceId, req.params.id);
    },
  );

  app.put(
    '/eval-cases/:id',
    { schema: { params: IdParams, body: EvalCaseInput, response: { 200: EvalCase } } },
    async (req) => {
      const { workspaceId } = await getContext(container, req);
      return service.updateCase(workspaceId, req.params.id, req.body);
    },
  );

  /** AC-26 — the runs cascade; see `EvalRepository.deleteCase`. */
  app.delete(
    '/eval-cases/:id',
    { schema: { params: IdParams, response: { 200: z.object({ ok: z.literal(true) }) } } },
    async (req) => {
      const { workspaceId } = await getContext(container, req);
      await service.deleteCase(workspaceId, req.params.id);
      return { ok: true as const };
    },
  );

  // ---- runs (the four body-less action POSTs) ------------------------------

  /** AC-27, AC-33, AC-35, AC-39, AC-40 — 202, work on the JobRunner. */
  app.post(
    '/agents/:id/eval-runs',
    { schema: { params: IdParams, response: { 202: EvalBatchAccepted } } },
    async (req, reply) => {
      const { workspaceId } = await getContext(container, req);
      const accepted = await service.acceptAgentBatch(workspaceId, req.params.id);
      reply.code(202);
      return accepted;
    },
  );

  /** AC-116 / plan D-9 — a one-case batch over the same runner. */
  app.post(
    '/eval-cases/:id/runs',
    { schema: { params: IdParams, response: { 202: EvalBatchAccepted } } },
    async (req, reply) => {
      const { workspaceId } = await getContext(container, req);
      const accepted = await service.acceptCaseRun(workspaceId, req.params.id);
      reply.code(202);
      return accepted;
    },
  );

  /** AC-42, AC-43 — one batch per enabled agent that has at least one case. */
  app.post(
    '/eval/runs',
    { schema: { response: { 202: z.array(EvalBatchAccepted) } } },
    async (req, reply) => {
      const { workspaceId } = await getContext(container, req);
      const accepted = await service.acceptWorkspaceRun(workspaceId);
      reply.code(202);
      return accepted;
    },
  );

  // ---- reads ---------------------------------------------------------------

  /** AC-61, AC-62, AC-66 — the poll behind AC-27's 202. */
  app.get(
    '/agents/:id/eval-runs',
    { schema: { params: IdParams, response: { 200: z.array(EvalBatchRecord) } } },
    async (req) => {
      const { workspaceId } = await getContext(container, req);
      return service.batchesForAgent(workspaceId, req.params.id);
    },
  );

  /** AC-72 — read before the confirmation, so a click has a price on it. */
  app.get(
    '/eval/estimate',
    { schema: { response: { 200: EvalBatchEstimate } } },
    async (req) => {
      const { workspaceId } = await getContext(container, req);
      return service.estimate(workspaceId);
    },
  );

  /** AC-69, AC-70, AC-71, AC-108. */
  app.get(
    '/eval',
    { schema: { response: { 200: EvalWorkspaceDashboard } } },
    async (req) => {
      const { workspaceId } = await getContext(container, req);
      return service.workspaceDashboard(workspaceId);
    },
  );

  /** AC-73, AC-74. `:agentId` is legal HERE — a different prefix. */
  app.get(
    '/eval/agents/:agentId',
    { schema: { params: AgentIdParams, response: { 200: EvalDashboard } } },
    async (req) => {
      const { workspaceId } = await getContext(container, req);
      return service.agentDashboard(workspaceId, req.params.agentId);
    },
  );
}

declare module 'fastify' {
  interface FastifyInstance {
    evalService: EvalService;
  }
}
