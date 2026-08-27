import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { BlastResponse } from '@devdigest/shared';
import { getContext } from '../_shared/context.js';
import { IdParams } from '../_shared/schemas.js';
import { BlastService } from './service.js';

/**
 * L04 — blast module. Transport layer only.
 *   GET /pulls/:id/blast → blast radius of the PR's diff: changed symbols,
 *                          their callers, and the HTTP endpoints reachable
 *                          through the reverse import graph. Served entirely
 *                          from the repo-intel index — never calls an LLM.
 */
export default async function blastRoutes(appBase: FastifyInstance) {
  const app = appBase.withTypeProvider<ZodTypeProvider>();
  const { container } = app;
  const service = new BlastService(container, app.log);

  app.get(
    '/pulls/:id/blast',
    { schema: { params: IdParams, response: { 200: BlastResponse } } },
    async (req) => {
      const { workspaceId } = await getContext(container, req);
      return service.getBlast(workspaceId, req.params.id);
    },
  );
}
