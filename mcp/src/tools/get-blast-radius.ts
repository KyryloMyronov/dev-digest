import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { jsonResult } from '../format.js';

/**
 * Stub. The server-side capability already exists behind the RepoIntel facade
 * (server/src/modules/repo-intel — getBlastRadius); wiring it up later means
 * adding one REST route and replacing this handler with a real call.
 */
export function registerGetBlastRadius(server: McpServer) {
  server.registerTool(
    'get_blast_radius',
    {
      title: 'Get blast radius',
      description: 'Estimate which code is impacted by changes to the given files. Not implemented yet.',
      inputSchema: {
        repo: z.string().describe('Repo name, e.g. "owner/name"'),
        files: z.array(z.string()).describe('Changed file paths, repo-relative'),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () =>
      jsonResult({
        status: 'not_implemented',
        message: 'Blast-radius analysis is not available yet. Do not retry — it will fail until a later release.',
      }),
  );
}
