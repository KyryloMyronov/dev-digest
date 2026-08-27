import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  ApiError,
  get,
  post,
  resolvePull,
  type AgentDto,
  type ReviewRecord,
  type ReviewRunTarget,
} from '../api.js';
import { guarded, jsonResult } from '../format.js';

async function resolveAgentId(ref: string): Promise<string> {
  const agents = await get<AgentDto[]>('/agents');
  const byId = agents.find((a) => a.id === ref);
  if (byId) return byId.id;
  const byName = agents.filter((a) => a.name.toLowerCase() === ref.toLowerCase());
  if (byName.length === 1) return byName[0].id;
  const known = agents.map((a) => a.name).join(', ') || '(none configured)';
  throw new ApiError(
    byName.length === 0
      ? `Agent "${ref}" not found. Known agents: ${known}`
      : `Agent name "${ref}" is ambiguous — call list_agents and pass the agent id.`,
  );
}

export function registerRunAgent(server: McpServer) {
  server.registerTool(
    'run_agent_on_pull_request',
    {
      title: 'Run a review on a PR',
      description:
        'Start a review run of an agent on a pull request. Asynchronous: returns run ids immediately — poll get_findings for the results.',
      inputSchema: {
        repo: z.string().describe('Repo name, e.g. "owner/name"'),
        pr_number: z.number().int(),
        agent: z.string().optional().describe('Agent id or name'),
        all: z.boolean().optional().describe('Run every enabled agent instead of one'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    guarded(async ({ repo, pr_number, agent, all }) => {
      if (!agent && !all) throw new ApiError('Pass either "agent" or "all: true".');
      const { pr } = await resolvePull(repo, pr_number);
      const body = all ? { all: true } : { agentId: await resolveAgentId(agent!) };
      const res = await post<{ runs: ReviewRunTarget[]; reviews: ReviewRecord[] }>(
        `/pulls/${pr.id}/review`,
        body,
      );
      return jsonResult({
        pr: `${repo}#${pr_number}`,
        runs: res.runs.map((r) => ({ run_id: r.run_id, agent: r.agent_name, status: 'running' })),
        next: 'Poll get_findings with the same repo/pr_number (and optionally a run_id).',
      });
    }),
  );
}
