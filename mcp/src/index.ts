import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { buildServer } from './server.js';

// stdio carries JSON-RPC on stdout — diagnostics MUST go to stderr.
const server = buildServer();
await server.connect(new StdioServerTransport());
console.error('devdigest MCP server listening on stdio');
