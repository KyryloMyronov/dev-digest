import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { get, resolvePull, type BlastRadiusView } from '../api.js';
import { guarded, jsonResult } from '../format.js';

const NARROW_HINT = 'the PR may simply be large — read impacts per symbol';

/**
 * Fronts GET /pulls/:id/blast (a pure repo-intel index read on the server —
 * no LLM). `status`/`reason` are data, not errors: 'partial'/'degraded' means
 * the index couldn't fully answer, and the reason says why.
 */
export function registerGetBlastRadius(server: McpServer) {
  server.registerTool(
    'get_blast_radius',
    {
      title: 'Get blast radius',
      description:
        "How a PR's diff impacts the project: changed symbols, their callers, and the endpoints reachable through the import graph. status!=full means the index is incomplete — see reason.",
      inputSchema: {
        repo: z.string().describe('Repo name, e.g. "owner/name"'),
        pr_number: z.number().int(),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    guarded(async ({ repo, pr_number }) => {
      const { pr } = await resolvePull(repo, pr_number);
      const blast = await get<BlastRadiusView>(`/pulls/${pr.id}/blast`);
      return jsonResult(
        {
          pr: `${repo}#${pr_number}`,
          status: blast.status,
          ...(blast.reason ? { reason: blast.reason } : {}),
          changed_files: blast.changed_files,
          impacts: blast.impacts,
          endpoints: blast.endpoints,
        },
        NARROW_HINT,
      );
    }),
  );
}
