import { beforeAll, describe, expect, it } from 'vitest';

// Keep the suite hermetic: never talk to a dev API that happens to be running.
beforeAll(() => {
  process.env.DEVDIGEST_API_URL = 'http://127.0.0.1:9';
});
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildServer } from '../src/server.js';
import type { PrBriefView } from '../src/api.js';
import { CHARACTER_LIMIT } from '../src/format.js';

/**
 * Replace `fetch` with a path→payload table for one test. Returns the restore
 * function; the suite is otherwise hermetic against a dead port.
 */
function stubApi(paths: string[], table: Record<string, unknown>) {
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL) => {
    const path = new URL(String(url)).pathname;
    paths.push(path);
    if (!(path in table)) {
      return new Response('{"error":{"code":"not_found","message":"no stub"}}', { status: 404 });
    }
    return new Response(JSON.stringify(table[path]), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

async function connectedClient() {
  const server = buildServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

describe('devdigest MCP server', () => {
  it('exposes exactly the six tools', async () => {
    const client = await connectedClient();
    const { tools } = await client.listTools();
    // SPEC-02 added `get_pr_brief` (AC-51). This assertion failing is the
    // INTENDED signal that the tool surface changed — NFR-11 names it as the
    // one real break the contract change causes.
    expect(tools.map((t) => t.name).sort()).toEqual([
      'get_blast_radius',
      'get_conventions',
      'get_findings',
      'get_pr_brief',
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

  it('get_blast_radius degrades to an actionable isError when the API is down', async () => {
    const client = await connectedClient();
    const res = await client.callTool({
      name: 'get_blast_radius',
      arguments: { repo: 'acme/web', pr_number: 1 },
    });
    // The tool fronts GET /pulls/:id/blast; no API runs on the test port, so
    // the guarded handler must surface the reachability error, not crash.
    expect(res.isError).toBe(true);
    const text = (res.content as { type: string; text: string }[])[0].text;
    expect(text).toContain('not reachable');
  });

  // ---------------------------------------------------------- SPEC-02 brief

  it('AC-52 resolves the PR and reads GET /pulls/:id/brief against a stubbed API', async () => {
    const paths: string[] = [];
    const brief: PrBriefView = {
      pr_id: 'pr-uuid',
      why: { summary: 'Public endpoints have no throttle.', sources: ['pr-title'] },
      risks: [
        {
          kind: 'concurrency',
          title: 'The limiter store is process-local',
          explanation: 'With N instances the effective limit is N times the configured one.',
          severity: 'WARNING',
          file: 'src/config.ts',
          start_line: 12,
          end_line: 12,
        },
      ],
      focus: {
        entries: [
          { file: 'src/config.ts', start_line: 12, end_line: 12, reason: 'check the window' },
        ],
      },
      grounding: { kept: 2, dropped: 1 },
      omitted_files: ['src/huge.ts'],
      model: 'gpt-4.1',
      cost_usd: null,
      head_sha: 'a1b2c3d',
    };
    const restore = stubApi(paths, {
      '/repos': [{ id: 'repo-1', owner: 'acme', name: 'web', full_name: 'acme/web' }],
      '/repos/repo-1/pulls': [{ id: 'pr-uuid', number: 7, title: 't', status: 'open' }],
      '/pulls/pr-uuid/brief': brief,
    });
    try {
      const client = await connectedClient();
      const res = await client.callTool({
        name: 'get_pr_brief',
        arguments: { repo: 'acme/web', pr_number: 7 },
      });
      expect(res.isError).toBeFalsy();
      expect(paths).toContain('/pulls/pr-uuid/brief');
      const payload = JSON.parse((res.content as { text: string }[])[0].text);
      expect(payload.pr).toBe('acme/web#7');
      expect(payload.risks[0].file).toBe('src/config.ts');
      expect(payload.focus[0].reason).toBe('check the window');
      expect(payload.grounding).toEqual({ kept: 2, dropped: 1 });
      // `null` (unpriced or cached) is preserved, never coalesced to 0.
      expect(payload.cost_usd).toBeNull();
    } finally {
      restore();
    }
  });

  it('AC-54 returns a NON-error result stating no brief exists when the API answers null', async () => {
    const restore = stubApi([], {
      '/repos': [{ id: 'repo-1', owner: 'acme', name: 'web', full_name: 'acme/web' }],
      '/repos/repo-1/pulls': [{ id: 'pr-uuid', number: 7, title: 't', status: 'open' }],
      '/pulls/pr-uuid/brief': null,
    });
    try {
      const client = await connectedClient();
      const res = await client.callTool({
        name: 'get_pr_brief',
        arguments: { repo: 'acme/web', pr_number: 7 },
      });
      // `guarded` will not do this branch for you — a null payload is a
      // successful read, not a failure.
      expect(res.isError).toBeFalsy();
      const text = (res.content as { text: string }[])[0].text;
      expect(text).toContain('No brief has been computed');
    } finally {
      restore();
    }
  });

  it('AC-53 degrades to an actionable isError when the API is unreachable', async () => {
    const client = await connectedClient();
    const res = await client.callTool({
      name: 'get_pr_brief',
      arguments: { repo: 'acme/web', pr_number: 1 },
    });
    expect(res.isError).toBe(true);
    expect((res.content as { text: string }[])[0].text).toContain('not reachable');
  });

  it('AC-55 keeps the get_pr_brief description under 200 characters', async () => {
    const client = await connectedClient();
    const { tools } = await client.listTools();
    const tool = tools.find((t) => t.name === 'get_pr_brief')!;
    // The shipped assertion is `toBeLessThan(200)`, so exactly 200 fails.
    expect((tool.description ?? '').length).toBeLessThan(200);
  });

  it('AC-56 / NFR-8 truncates an oversized brief and appends a narrowing hint', async () => {
    const huge: PrBriefView = {
      pr_id: 'pr-uuid',
      why: { summary: 'x'.repeat(40_000), sources: [] },
      risks: [],
      focus: { entries: [] },
      grounding: { kept: 0, dropped: 0 },
      omitted_files: [],
    };
    const restore = stubApi([], {
      '/repos': [{ id: 'repo-1', owner: 'acme', name: 'web', full_name: 'acme/web' }],
      '/repos/repo-1/pulls': [{ id: 'pr-uuid', number: 7, title: 't', status: 'open' }],
      '/pulls/pr-uuid/brief': huge,
    });
    try {
      const client = await connectedClient();
      const res = await client.callTool({
        name: 'get_pr_brief',
        arguments: { repo: 'acme/web', pr_number: 7 },
      });
      const text = (res.content as { text: string }[])[0].text;
      // `jsonResult` already owns this — assert it, do not reimplement it.
      expect(text).toContain(`truncated at ${CHARACTER_LIMIT} chars`);
      expect(text).toContain('read the risks first');
    } finally {
      restore();
    }
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
