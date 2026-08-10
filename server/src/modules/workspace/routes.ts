import type { FastifyInstance } from 'fastify';
import { getContext } from '../_shared/context.js';
import { WorkspaceService } from './service.js';

/**
 * F1 — workspace manager: where clones live + a summary of cloned repos.
 *   GET /workspace → workspace info + cloneDir + cloned repos summary
 *
 * Transport only — the overview is assembled by WorkspaceService.
 */
export default async function workspaceRoutes(app: FastifyInstance) {
  const { container } = app;
  const service = new WorkspaceService(container);

  app.get('/workspace', async (req) => {
    const { workspaceId } = await getContext(container, req);
    return service.getOverview(workspaceId);
  });
}
