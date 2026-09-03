import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerListAgents } from './tools/list-agents.js';
import { registerRunAgent } from './tools/run-agent.js';
import { registerGetFindings } from './tools/get-findings.js';
import { registerGetConventions } from './tools/get-conventions.js';
import { registerGetBlastRadius } from './tools/get-blast-radius.js';
import { registerGetPrBrief } from './tools/get-pr-brief.js';

export function buildServer(): McpServer {
  // No `instructions`: the field is advisory, some clients ignore it, and
  // everything a caller needs is in the (short) tool descriptions.
  const server = new McpServer({ name: 'devdigest', version: '0.0.0' });
  registerListAgents(server);
  registerRunAgent(server);
  registerGetFindings(server);
  registerGetConventions(server);
  registerGetBlastRadius(server);
  registerGetPrBrief(server);
  return server;
}
