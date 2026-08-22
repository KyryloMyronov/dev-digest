import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { get, resolveRepo, type ConventionsView } from '../api.js';
import { guarded, jsonResult } from '../format.js';

export function registerGetConventions(server: McpServer) {
  server.registerTool(
    'get_conventions',
    {
      title: 'Get repo conventions',
      description: 'Get the coding conventions DevDigest extracted from a repo.',
      inputSchema: {
        repo: z.string().describe('Repo name, e.g. "owner/name"'),
        status: z
          .enum(['accepted', 'pending', 'rejected', 'all'])
          .optional()
          .describe('Filter, default "accepted"'),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    guarded(async ({ repo, status }) => {
      const resolved = await resolveRepo(repo);
      const view = await get<ConventionsView>(`/repos/${resolved.id}/conventions`);
      const wanted = status ?? 'accepted';
      const items = view.items
        .filter((c) => wanted === 'all' || c.status === wanted)
        .map((c) => ({
          id: c.id,
          status: c.status,
          rule: c.rule,
          ...(c.evidence_path ? { evidence: c.evidence_path } : {}),
          ...(c.confidence != null ? { confidence: c.confidence } : {}),
        }));
      const note =
        view.scan.status === 'idle'
          ? 'This repo has never been scanned — run a conventions scan in the DevDigest studio first.'
          : undefined;
      return jsonResult({
        repo: resolved.full_name,
        scan: { status: view.scan.status, ...(view.scan.reason ? { reason: view.scan.reason } : {}) },
        conventions: items,
        ...(note ? { note } : {}),
      });
    }),
  );
}
