/**
 * project-context HTTP module — SPEC-01.
 *
 *   GET    /repos/:id/context            → ContextDocList
 *   GET    /repos/:id/context/doc?path=… → ContextDocContent
 *   POST   /repos/:id/context/reindex    → IndexStatus, 202 + the token-count job
 *   GET    /agents/:id/context-docs      → AgentContextDoc[]  (incl. inherited)
 *   POST   /agents/:id/context-docs      → attach one path
 *   PUT    /agents/:id/context-docs      → reorder (the full ordered list)
 *   DELETE /agents/:id/context-docs      → detach one path
 *   GET    /skills/:id/context-docs      → SkillContextDoc[]
 *   POST   /skills/:id/context-docs      → attach one path
 *   DELETE /skills/:id/context-docs      → detach one path
 *
 * The two attach families live in THIS module rather than in `agents`/`skills`,
 * even though `/agents/:id/skills` sets the opposite precedent: putting them
 * there would force either a second repository over these tables or a container
 * reach-around, and `repo-intel` already proves prefixes are not module-owned.
 * This is the OQ-5 seam decision made concrete.
 *
 * Route prefixes are NOT module-owned here: `repo-intel` already serves
 * `/repos/:id/index-state`, which is the precedent that lets this module own
 * every `/repos/:id/context*` route as well as the two attach families above.
 *
 * Job-handler registration lives here too, as it does in `repo-intel/routes.ts`:
 * this plugin runs once at app boot, so the TOKEN_COUNT handler exists for the
 * jobs `repos/service.ts` enqueues after a clone.
 *
 * Every route declares `schema: { params, querystring, response }`. That makes
 * the envelope's shape enforced at SERIALIZATION rather than hoped for — both
 * compilers from `fastify-type-provider-zod` are installed in `app.ts`, and
 * `server/insights.md` (2026-08-18) records that the convention works and simply
 * had no adopters.
 */
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  AgentContextDoc,
  ContextDocAttach,
  ContextDocContent,
  ContextDocList,
  ContextDocOrder,
  IndexStatus,
  SkillContextDoc,
} from '@devdigest/shared';
import { getContext } from '../_shared/context.js';
import { IdParams } from '../_shared/schemas.js';
import { ProjectContextService } from './service.js';
import { TOKEN_COUNT_JOB_KIND } from './constants.js';

/** AC-11's request parameter. Non-empty only — containment is the adapter's job. */
const DocQuery = z.object({ path: z.string().min(1) });

/**
 * Which repository an attachment list should be resolved against, so each row
 * can inline its `ContextDoc` (token count, size, source tag).
 *
 * OPTIONAL on the read and delete paths: an agent is a workspace-level object
 * and `agent_context_docs.path` is repo-agnostic (D-Q6f), so the list must still
 * render when no repository is selected or its clone is not ready — every `doc`
 * simply comes back null, which is AC-29's shape. It is REQUIRED on the two
 * write paths, where it is what makes the membership check possible.
 */
const DocsQuery = z.object({ repo_id: z.string().uuid().optional() });

/** Detach takes the path in the querystring: a `/` cannot ride in one path
    parameter, and DELETE bodies are awkward for every HTTP client. */
const DetachQuery = z.object({ path: z.string().min(1), repo_id: z.string().uuid().optional() });

export default async function projectContextRoutes(appBase: FastifyInstance) {
  const app = appBase.withTypeProvider<ZodTypeProvider>();
  const { container } = app;

  const service = new ProjectContextService(container);
  service.registerTokenCountJobHandler();

  app.get(
    '/repos/:id/context',
    { schema: { params: IdParams, response: { 200: ContextDocList } } },
    async (req) => {
      const { workspaceId } = await getContext(container, req);
      return service.list(workspaceId, req.params.id);
    },
  );

  app.get(
    '/repos/:id/context/doc',
    { schema: { params: IdParams, querystring: DocQuery, response: { 200: ContextDocContent } } },
    async (req) => {
      const { workspaceId } = await getContext(container, req);
      return service.readDoc(workspaceId, req.params.id, req.query.path);
    },
  );

  /**
   * AC-63 — respond 202 having enqueued the job, without waiting for it.
   *
   * The response is the EXISTING `IndexStatus` rather than a fourth new type:
   * `useReindexContext` is already typed against it, which is what makes the
   * second shipped-but-404ing hook start resolving with no client retype.
   *
   * 202 even when the enqueue fails, following `repo-intel/routes.ts`: the UI
   * can then keep polling the list instead of showing an inline failure, and
   * nothing observable differs between the two paths — which is exactly why the
   * enqueue-failure hop carries no criterion of its own.
   */
  app.post(
    '/repos/:id/context/reindex',
    { schema: { params: IdParams, response: { 202: IndexStatus } } },
    async (req, reply) => {
      const { workspaceId } = await getContext(container, req);
      let queued = false;
      try {
        await container.jobs.enqueue(workspaceId, TOKEN_COUNT_JOB_KIND, {
          repoId: req.params.id,
        });
        queued = true;
      } catch {
        // swallow — degraded path
      }
      reply.code(202);
      return {
        status: queued ? ('parsing' as const) : ('idle' as const),
        pct: 0,
        message: queued ? 'Counting project-context tokens' : 'Could not queue the token scan',
      };
    },
  );

  // ------------------------------------------- attachments (SPEC-01 Cut 2) ---
  //
  // Transport only, as everywhere else: parse, resolve tenancy, delegate. The
  // membership validation AC-18/AC-20 depend on lives in the service (it needs
  // the discovery walk), and it throws `AppError`, which the single handler in
  // `app.ts` maps to the envelope.

  app.get(
    '/agents/:id/context-docs',
    {
      schema: {
        params: IdParams,
        querystring: DocsQuery,
        response: { 200: z.array(AgentContextDoc) },
      },
    },
    async (req) => {
      const { workspaceId } = await getContext(container, req);
      return service.agentDocs(workspaceId, req.params.id, req.query.repo_id);
    },
  );

  app.post(
    '/agents/:id/context-docs',
    {
      schema: {
        params: IdParams,
        body: ContextDocAttach,
        response: { 200: z.array(AgentContextDoc) },
      },
    },
    async (req) => {
      const { workspaceId } = await getContext(container, req);
      return service.attachAgentDoc(
        workspaceId,
        req.params.id,
        req.body.repo_id,
        req.body.path,
      );
    },
  );

  /** AC-19 — the full ordered list in one request, mirroring `useSetAgentSkills`. */
  app.put(
    '/agents/:id/context-docs',
    {
      schema: {
        params: IdParams,
        body: ContextDocOrder,
        response: { 200: z.array(AgentContextDoc) },
      },
    },
    async (req) => {
      const { workspaceId } = await getContext(container, req);
      return service.setAgentDocs(
        workspaceId,
        req.params.id,
        req.body.repo_id,
        req.body.paths,
      );
    },
  );

  app.delete(
    '/agents/:id/context-docs',
    {
      schema: {
        params: IdParams,
        querystring: DetachQuery,
        response: { 200: z.array(AgentContextDoc) },
      },
    },
    async (req) => {
      const { workspaceId } = await getContext(container, req);
      return service.detachAgentDoc(
        workspaceId,
        req.params.id,
        req.query.path,
        req.query.repo_id,
      );
    },
  );

  app.get(
    '/skills/:id/context-docs',
    {
      schema: {
        params: IdParams,
        querystring: DocsQuery,
        response: { 200: z.array(SkillContextDoc) },
      },
    },
    async (req) => {
      const { workspaceId } = await getContext(container, req);
      return service.skillDocs(workspaceId, req.params.id, req.query.repo_id);
    },
  );

  app.post(
    '/skills/:id/context-docs',
    {
      schema: {
        params: IdParams,
        body: ContextDocAttach,
        response: { 200: z.array(SkillContextDoc) },
      },
    },
    async (req) => {
      const { workspaceId } = await getContext(container, req);
      return service.attachSkillDoc(
        workspaceId,
        req.params.id,
        req.body.repo_id,
        req.body.path,
      );
    },
  );

  app.delete(
    '/skills/:id/context-docs',
    {
      schema: {
        params: IdParams,
        querystring: DetachQuery,
        response: { 200: z.array(SkillContextDoc) },
      },
    },
    async (req) => {
      const { workspaceId } = await getContext(container, req);
      return service.detachSkillDoc(
        workspaceId,
        req.params.id,
        req.query.path,
        req.query.repo_id,
      );
    },
  );
}
