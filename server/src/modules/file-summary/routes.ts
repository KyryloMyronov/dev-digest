import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { FileSummaryDeriveInput, PrFileSummariesResponse } from '@devdigest/shared';
import { getContext } from '../_shared/context.js';
import { IdParams } from '../_shared/schemas.js';
import { FileSummaryService } from './service.js';

/**
 * SPEC-03 — file-summary module. Transport layer only.
 *   GET  /pulls/:id/file-summaries → the persisted summaries + the AC-60 counts
 *   POST /pulls/:id/file-summaries → QUEUE a derivation (202 + jobId)
 *
 * Every handler starts with `getContext` for tenancy, then delegates. No
 * business logic here, and no HTTP type below this file.
 */
export default async function fileSummaryRoutes(appBase: FastifyInstance) {
  const app = appBase.withTypeProvider<ZodTypeProvider>();
  const { container } = app;
  const service = new FileSummaryService(container);
  service.registerJobHandler();

  /** 202 body of the POST — the job receipt, never the result. */
  type FileSummaryDeriveAccepted =
    | { status: 'accepted'; jobId: string }
    | { status: 'accepted'; degraded: true; reason: string };

  // ---- Read (AC-1, AC-2, AC-3, AC-7) --------------------------------------
  // The response schema is what makes AC-3 true: a payload that does not match
  // fails SERIALIZATION and the request 500s, rather than a drifted shape
  // reaching the studio. Note it also STRIPS unknown keys, so the service must
  // compose exactly `PrFileSummariesResponse` — extra fields would silently stop
  // being sent rather than erroring.
  //
  // AC-1's empty case needs no envelope and no `null`: the response is an OBJECT
  // with `summaries: []`, so the top-level-nullable question the brief route had
  // to settle does not arise here.
  app.get(
    '/pulls/:id/file-summaries',
    { schema: { params: IdParams, response: { 200: PrFileSummariesResponse } } },
    async (req) => {
      const { workspaceId } = await getContext(container, req);
      return service.getSummaries(workspaceId, req.params.id);
    },
  );

  // ---- Queue a derivation (AC-8, AC-9, AC-10, AC-11, AC-14) ---------------
  // 202, never the result: the derivation makes a model call over many files'
  // patches, so it goes through JobRunner rather than being awaited in the
  // request (`AGENTS.md` — "anything slow goes through JobRunner"). 202 whether
  // or not the enqueue took, so the studio has ONE path: poll until fresh. An
  // unknown PR still 404s (AC-5), and a `path` that is not a changed file of
  // this PR is a 422 with NO job enqueued (AC-14).
  //
  // `body: FileSummaryDeriveInput.nullish()` — THE `.nullish()` IS LOAD-BEARING,
  // and plan AMENDMENT A-1 is why. Fastify sets `req.body = null` for a POST with
  // no body and no content-type (which is exactly what the studio's `apiFetch`
  // sends), and a bare `z.object` REJECTS `null` with a 422:
  //   `Expected object, received null`
  // Measured through `app.inject()` before anything downstream was built on it,
  // and the gate test in `test/file-summary-routes.test.ts` pins it.
  //
  // `.nullish()` is the only option that accepts a body-less POST AND still
  // rejects a malformed one (`{path: 42}` / `{force: 'yes'}` are 422). The
  // sibling `POST /pulls/:id/brief`'s tolerant hand-parse was considered and
  // DECLINED by the author: it swallows a malformed body silently, losing
  // validation this route gets for free. So the repo convention holds here —
  // ONE declared Zod schema serves request validation and client typing — and
  // the handler's `req.body ?? {}` is what copes with the `null`.
  //
  // NFR-7's limit is 10, not the intent/brief 5, and the reason belongs here:
  // ONE route serves TWO shapes, and the cheap per-file shape is clicked while
  // reading — a limit of 5 would stop a reviewer mid-file on a nine-file PR.
  app.post(
    '/pulls/:id/file-summaries',
    {
      schema: { params: IdParams, body: FileSummaryDeriveInput.nullish() },
      config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    },
    async (req, reply): Promise<FileSummaryDeriveAccepted> => {
      const { workspaceId } = await getContext(container, req);
      const jobId = await service.enqueueDerivation(workspaceId, req.params.id, req.body ?? {});
      reply.code(202);
      return jobId
        ? { status: 'accepted', jobId }
        : { status: 'accepted', degraded: true, reason: 'no_handler' };
    },
  );
}
