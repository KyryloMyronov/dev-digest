import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { get, resolvePull, type PrBriefView } from '../api.js';
import { guarded, jsonResult } from '../format.js';

const NARROW_HINT = 'read the risks first, then the review focus';

/**
 * Fronts GET /pulls/:id/brief — the SAME brief the studio shows, so an agent
 * never has to re-derive one to answer a question about a PR.
 *
 * The endpoint NEVER derives on read: a GET must not spend a model call. A PR
 * with nothing derived yet answers `null`, which is a fact rather than a
 * failure — hence the explicit non-error branch below.
 */
export function registerGetPrBrief(server: McpServer) {
  server.registerTool(
    'get_pr_brief',
    {
      title: 'Get PR brief',
      description:
        "A PR's derived brief: why the change exists, its risks with severity and a diff line each, and where to start reading. Read-only — never derives.",
      inputSchema: {
        repo: z.string().describe('Repo name, e.g. "owner/name"'),
        pr_number: z.number().int(),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    guarded(async ({ repo, pr_number }) => {
      const { pr } = await resolvePull(repo, pr_number);
      const brief = await get<PrBriefView | null>(`/pulls/${pr.id}/brief`);
      // `guarded` will NOT do this for you: a null payload is a successful
      // read of "nothing derived yet", so it must be a non-error result whose
      // text says so, not an isError.
      if (!brief) {
        return jsonResult({
          pr: `${repo}#${pr_number}`,
          brief: null,
          note: 'No brief has been computed for this pull request yet. Derive one in the studio (Overview → Risk brief).',
        });
      }
      return jsonResult(
        {
          pr: `${repo}#${pr_number}`,
          head_sha: brief.head_sha ?? null,
          why: brief.why ?? null,
          risks: brief.risks,
          focus: brief.focus?.entries ?? [],
          grounding: brief.grounding ?? null,
          omitted_files: brief.omitted_files,
          model: brief.model ?? null,
          cost_usd: brief.cost_usd ?? null,
        },
        NARROW_HINT,
      );
    }),
  );
}
