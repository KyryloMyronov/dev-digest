import { beforeAll, describe, expect, it } from 'vitest';

// Keep the suite hermetic: never talk to a dev API that happens to be running.
beforeAll(() => {
  process.env.DEVDIGEST_API_URL = 'http://127.0.0.1:9';
});
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildServer } from '../src/server.js';

async function connectedClient() {
  const server = buildServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

describe('devdigest MCP server', () => {
  it('exposes exactly the five tools', async () => {
    const client = await connectedClient();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      'get_blast_radius',
      'get_conventions',
      'get_findings',
      'list_agents',
      'run_agent_on_pull_request',
    ]);
  });

  it('keeps the tools/list payload token-lean', async () => {
    const client = await connectedClient();
    const { tools } = await client.listTools();
    // The whole tool surface is what every chat pays for at session start.
    expect(JSON.stringify(tools).length).toBeLessThan(4000);
    for (const tool of tools) {
      expect((tool.description ?? '').length).toBeLessThan(200);
    }
  });

  it('get_blast_radius answers with the not_implemented stub', async () => {
    const client = await connectedClient();
    const res = await client.callTool({
      name: 'get_blast_radius',
      arguments: { repo: 'acme/web', files: ['a.ts'] },
    });
    const text = (res.content as { type: string; text: string }[])[0].text;
    expect(res.isError).toBeFalsy();
    expect(JSON.parse(text).status).toBe('not_implemented');
  });

  it('surfaces an unreachable API as an actionable isError result', async () => {
    const client = await connectedClient();
    const res = await client.callTool({ name: 'list_agents', arguments: {} });
    // No API is running on the test port — the tool must degrade, not crash.
    expect(res.isError).toBe(true);
    const text = (res.content as { type: string; text: string }[])[0].text;
    expect(text).toContain('not reachable');
  });
});
