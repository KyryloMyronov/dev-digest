import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { SkillSource, SkillType } from '@devdigest/shared';
import { getContext } from '../_shared/context.js';
import { IdParams } from '../_shared/schemas.js';
import { NotFoundError } from '../../platform/errors.js';
import { SkillsService } from './service.js';

/**
 * Skills module — CRUD over the reusable review-guidance library.
 *   GET    /skills                → list (workspace-scoped, by name)
 *   GET    /skills/:id            → one skill
 *   POST   /skills                → create (also the landing point for an import)
 *   PUT    /skills/:id            → update; a body change versions the old one
 *   DELETE /skills/:id            → delete (cascades every agent link)
 *   GET    /skills/:id/versions   → body history, newest first
 *   GET    /skills/:id/agents     → names of agents linking it (delete warning)
 *
 * There is no import endpoint on purpose: a `.md`/`.zip` is parsed in the
 * browser and confirmed in a preview, then saved through `POST /skills` like any
 * other skill. Executable members of an archive are dropped client-side and
 * never reach this process.
 */

const CreateSkillBody = z.object({
  name: z.string().min(1),
  description: z.string(),
  type: SkillType.optional(),
  source: SkillSource.optional(),
  body: z.string().min(1),
  enabled: z.boolean().optional(),
  // The files a skill was DERIVED from — written by the conventions extractor,
  // which posts here like any other create. Absent for a hand-written skill.
  evidence_files: z.array(z.string()).nullish(),
});

const UpdateSkillBody = z.object({
  name: z.string().min(1).optional(),
  description: z.string().optional(),
  type: SkillType.optional(),
  body: z.string().min(1).optional(),
  enabled: z.boolean().optional(),
});

export default async function skillsRoutes(appBase: FastifyInstance) {
  const app = appBase.withTypeProvider<ZodTypeProvider>();
  const service = new SkillsService(app.container);

  app.get('/skills', async (req) => {
    const { workspaceId } = await getContext(app.container, req);
    return service.list(workspaceId);
  });

  app.get('/skills/:id', { schema: { params: IdParams } }, async (req) => {
    const { workspaceId } = await getContext(app.container, req);
    const skill = await service.get(workspaceId, req.params.id);
    if (!skill) throw new NotFoundError('Skill not found');
    return skill;
  });

  app.post('/skills', { schema: { body: CreateSkillBody } }, async (req, reply) => {
    const { workspaceId } = await getContext(app.container, req);
    const { evidence_files: evidenceFiles, ...rest } = req.body;
    const skill = await service.create(workspaceId, {
      ...rest,
      ...(evidenceFiles !== undefined ? { evidenceFiles } : {}),
    });
    reply.status(201);
    return skill;
  });

  app.put('/skills/:id', { schema: { params: IdParams, body: UpdateSkillBody } }, async (req) => {
    const { workspaceId } = await getContext(app.container, req);
    const skill = await service.update(workspaceId, req.params.id, req.body);
    if (!skill) throw new NotFoundError('Skill not found');
    return skill;
  });

  app.delete('/skills/:id', { schema: { params: IdParams } }, async (req) => {
    const { workspaceId } = await getContext(app.container, req);
    const ok = await service.delete(workspaceId, req.params.id);
    if (!ok) throw new NotFoundError('Skill not found');
    return { ok: true };
  });

  app.get('/skills/:id/versions', { schema: { params: IdParams } }, async (req) => {
    const { workspaceId } = await getContext(app.container, req);
    const versions = await service.listVersions(workspaceId, req.params.id);
    if (!versions) throw new NotFoundError('Skill not found');
    return versions;
  });

  app.get('/skills/:id/agents', { schema: { params: IdParams } }, async (req) => {
    const { workspaceId } = await getContext(app.container, req);
    const names = await service.linkedAgentNames(workspaceId, req.params.id);
    if (!names) throw new NotFoundError('Skill not found');
    return names;
  });
}
