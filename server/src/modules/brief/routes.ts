import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { PrBriefRecord } from '@devdigest/shared';
import { getContext } from '../_shared/context.js';
import { IdParams } from '../_shared/schemas.js';
import { BriefService } from './service.js';

/**
 * SPEC-02 — brief module. Transport layer only.
 *   GET  /pulls/:id/brief → the persisted brief record, or null (never derives)
 *   POST /pulls/:id/brief → QUEUE a derivation (202 + jobId)
 *
 * Every handler starts with `getContext` for tenancy, then delegates. No
 * business logic here, and no HTTP type below this file.
 */
export default async function briefRoutes(appBase: FastifyInstance) {
  const app = appBase.withTypeProvider<ZodTypeProvider>();
  const { container } = app;
  const service = new BriefService(container);
  service.registerBriefJobHandler();

  /** 202 body of `POST /pulls/:id/brief` — the job receipt, never the result. */
  type BriefDeriveAccepted =
    | { status: 'accepted'; jobId: string }
    | { status: 'accepted'; degraded: true; reason: string };

  // ---- Read (AC-1, AC-2, AC-60) -------------------------------------------
  // The response schema is what makes AC-60 true: a payload that does not match
  // fails SERIALIZATION and the request 500s, rather than a drifted shape
  // reaching the studio. Note it also STRIPS unknown keys, so the repository
  // must compose exactly `PrBriefRecord` — extra fields would silently stop
  // being sent rather than erroring.
  //
  // `.nullable()` at the top level is deliberate and load-bearing: AC-1
  // requires `null` for a PR with no brief, which a bare object schema would
  // reject.
  app.get(
    '/pulls/:id/brief',
    { schema: { params: IdParams, response: { 200: PrBriefRecord.nullable() } } },
    async (req) => {
      const { workspaceId } = await getContext(container, req);
      return service.getBrief(workspaceId, req.params.id);
    },
  );

  // ---- Queue a derivation (AC-6, AC-7, AC-8, AC-9) ------------------------
  // 202, never the result: the derivation makes a model call over the whole
  // diff, so it goes through JobRunner rather than being awaited in the request
  // (`AGENTS.md` — "anything slow goes through JobRunner"). 202 whether or not
  // the enqueue took, so the studio has ONE path: poll until fresh. An unknown
  // PR still 404s.
  //
  // Tight per-route limit (AC-9): this is the expensive endpoint, and the limit
  // also bounds the duplicate-derivation case. Byte-identical to the intent
  // POST's limit.
  app.post(
    '/pulls/:id/brief',
    { schema: { params: IdParams }, config: { rateLimit: { max: 5, timeWindow: '1 minute' } } },
    async (req, reply): Promise<BriefDeriveAccepted> => {
      const { workspaceId } = await getContext(container, req);
      // Tolerant manual parse: the body is optional and `{force:true}` is its
      // only meaningful content.
      const force = (req.body as { force?: unknown } | undefined)?.force === true;
      const jobId = await service.enqueueBriefDerivation(workspaceId, req.params.id, force);
      reply.code(202);
      return jobId
        ? { status: 'accepted', jobId }
        : { status: 'accepted', degraded: true, reason: 'no_handler' };
    },
  );
}
