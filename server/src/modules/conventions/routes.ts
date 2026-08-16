import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { ConventionStatus } from '@devdigest/shared';
import { getContext } from '../_shared/context.js';
import { ConventionsService } from './service.js';
import { MAX_RULE_CHARS, MAX_SNIPPET_CHARS } from './constants.js';

/**
 * Conventions module — derive a repo's house rules from its own source, review
 * them, and compose the accepted ones into a Skill.
 *
 *   GET    /repos/:repoId/conventions              → { scan, items } in one read
 *   POST   /repos/:repoId/conventions/scan         → enqueue a scan (202)
 *   PATCH  /repos/:repoId/conventions/:id          → accept / reject / rewrite one
 *   POST   /repos/:repoId/conventions/status       → set many at once ("Deselect all")
 *   GET    /repos/:repoId/conventions/skill-draft  → compose (NOT save) a skill
 *
 * There is no create and no delete: candidates are written only by a scan, and
 * rejecting is a status, not a deletion — a rejected rule has to stay on record
 * or the next scan would offer it again.
 *
 * `skill-draft` is deliberately a GET that writes nothing. The user edits the
 * draft and saves it through `POST /skills`, so the skills module remains the
 * only writer of the `skills` table and cancelling costs nothing.
 *
 * Job-handler registration lives here: this plugin runs once at boot, mirroring
 * `repo-intel/routes.ts`.
 */

const RepoParams = z.object({ repoId: z.string().uuid() });

const ConventionParams = z.object({
  repoId: z.string().uuid(),
  id: z.string().uuid(),
});

const UpdateConventionBody = z
  .object({
    status: ConventionStatus.optional(),
    rule: z.string().min(1).max(MAX_RULE_CHARS).optional(),
    evidence_snippet: z.string().max(MAX_SNIPPET_CHARS).optional(),
  })
  // An empty patch is a caller bug, not a no-op success: it would bump
  // `updated_at` and report a change that never happened.
  .refine((b) => Object.keys(b).length > 0, {
    message: 'Provide at least one of status, rule or evidence_snippet',
  });

const SetStatusBody = z.object({
  ids: z.array(z.string().uuid()).min(1).max(200),
  status: ConventionStatus,
});

export default async function conventionsRoutes(appBase: FastifyInstance) {
  const app = appBase.withTypeProvider<ZodTypeProvider>();
  const { container } = app;
  const service = new ConventionsService(container);
  service.registerScanJobHandler();

  app.get('/repos/:repoId/conventions', { schema: { params: RepoParams } }, async (req) => {
    const { workspaceId } = await getContext(container, req);
    return service.list(workspaceId, req.params.repoId);
  });

  app.post(
    '/repos/:repoId/conventions/scan',
    { schema: { params: RepoParams } },
    async (req, reply) => {
      const { workspaceId } = await getContext(container, req);
      // 202 whether or not the enqueue took, so the UI has one path: poll the
      // scan row. An unknown repo still 404s — enqueueScan checks first.
      const jobId = await service.enqueueScan(workspaceId, req.params.repoId);
      reply.code(202);
      return jobId
        ? { status: 'accepted', jobId }
        : { status: 'accepted', degraded: true, reason: 'no_handler' };
    },
  );

  app.patch(
    '/repos/:repoId/conventions/:id',
    { schema: { params: ConventionParams, body: UpdateConventionBody } },
    async (req) => {
      const { workspaceId } = await getContext(container, req);
      return service.updateCandidate(workspaceId, req.params.repoId, req.params.id, req.body);
    },
  );

  app.post(
    '/repos/:repoId/conventions/status',
    { schema: { params: RepoParams, body: SetStatusBody } },
    async (req) => {
      const { workspaceId } = await getContext(container, req);
      return service.setStatusMany(
        workspaceId,
        req.params.repoId,
        req.body.ids,
        req.body.status,
      );
    },
  );

  app.get(
    '/repos/:repoId/conventions/skill-draft',
    { schema: { params: RepoParams } },
    async (req) => {
      const { workspaceId } = await getContext(container, req);
      return service.buildSkillDraft(workspaceId, req.params.repoId);
    },
  );
}
