import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { get, type AgentDto } from '../api.js';
import { guarded, jsonResult } from '../format.js';

export function registerListAgents(server: McpServer) {
  server.registerTool(
    'list_agents',
    {
      title: 'List reviewer agents',
      description: 'List the configured DevDigest reviewer agents.',
      inputSchema: {
        enabled_only: z.boolean().optional().describe('Return only agents that can run'),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    guarded(async ({ enabled_only }) => {
      const agents = await get<AgentDto[]>('/agents');
      const rows = (enabled_only ? agents.filter((a) => a.enabled) : agents).map((a) => ({
        // Deliberately excludes system_prompt/output_schema — they are large
        // and useless to a caller deciding which agent to run.
        id: a.id,
        name: a.name,
        description: a.description,
        provider: a.provider,
        model: a.model,
        strategy: a.strategy,
        enabled: a.enabled,
      }));
      return jsonResult({ agents: rows });
    }),
  );
}
