import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  ApiError,
  get,
  resolvePull,
  type FindingRecord,
  type ReviewRecord,
  type RunSummary,
} from '../api.js';
import { guarded, jsonResult, truncate } from '../format.js';

const NARROW_HINT = 'narrow with run_id, severity, or a smaller limit';

function formatFinding(f: FindingRecord) {
  return {
    severity: f.severity,
    category: f.category,
    title: f.title,
    file: f.file,
    lines: f.start_line === f.end_line ? `${f.start_line}` : `${f.start_line}-${f.end_line}`,
    rationale: truncate(f.rationale, 700),
    ...(f.suggestion ? { suggestion: truncate(f.suggestion, 400) } : {}),
    ...(f.dismissed_at ? { dismissed: true } : {}),
    ...(f.accepted_at ? { accepted: true } : {}),
  };
}

export function registerGetFindings(server: McpServer) {
  server.registerTool(
    'get_findings',
    {
      title: 'Get review findings',
      description:
        'Get the reviews and findings for a pull request, optionally for one run. Also reports run status, so use it to poll a run started with run_agent_on_pull_request.',
      inputSchema: {
        repo: z.string().describe('Repo name, e.g. "owner/name"'),
        pr_number: z.number().int(),
        run_id: z.string().optional().describe('Only this run (from run_agent_on_pull_request)'),
        severity: z.enum(['CRITICAL', 'WARNING', 'SUGGESTION']).optional(),
        limit: z.number().int().positive().optional().describe('Max findings returned, default 50'),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    guarded(async ({ repo, pr_number, run_id, severity, limit }) => {
      const { pr } = await resolvePull(repo, pr_number);
      const [runs, reviews] = await Promise.all([
        get<RunSummary[]>(`/pulls/${pr.id}/runs`),
        get<ReviewRecord[]>(`/pulls/${pr.id}/reviews`),
      ]);

      let targetRuns = runs;
      if (run_id) {
        targetRuns = runs.filter((r) => r.run_id === run_id);
        if (targetRuns.length === 0) {
          const known = runs.map((r) => r.run_id).join(', ') || '(no runs yet)';
          throw new ApiError(`Run "${run_id}" not found on ${repo}#${pr_number}. Known runs: ${known}`);
        }
      }

      const wanted = run_id ? reviews.filter((r) => r.run_id === run_id) : reviews;
      const max = limit ?? 50;
      let remaining = max;
      let total = 0;

      const reviewRows = wanted.map((review) => {
        let findings = review.findings;
        if (severity) findings = findings.filter((f) => f.severity === severity);
        total += findings.length;
        const shown = findings.slice(0, Math.max(remaining, 0));
        remaining -= shown.length;
        return {
          run_id: review.run_id,
          agent: review.agent_name ?? null,
          verdict: review.verdict,
          score: review.score,
          summary: review.summary ? truncate(review.summary, 500) : null,
          findings_total: findings.length,
          findings: shown.map(formatFinding),
        };
      });

      const runRows = targetRuns.map((r) => ({
        run_id: r.run_id,
        agent: r.agent_name,
        status: r.status,
        ...(r.error ? { error: r.error } : {}),
      }));

      // The executor marks a run terminal BEFORE persisting its review and
      // findings (server/insights.md), so "done with no review yet" means
      // finalizing — never "no findings".
      const doneWithoutReview = targetRuns.filter(
        (r) => r.status === 'done' && !reviews.some((rev) => rev.run_id === r.run_id),
      );
      const notes: string[] = [];
      if (targetRuns.some((r) => r.status === 'running')) notes.push('A run is still in progress — poll again.');
      if (doneWithoutReview.length > 0) notes.push('A run just finished and its review is still being persisted — retry in a moment.');
      if (total > max) notes.push(`Showing ${max} of ${total} findings — ${NARROW_HINT}.`);

      return jsonResult(
        {
          pr: `${repo}#${pr_number}`,
          runs: runRows,
          reviews: reviewRows,
          ...(notes.length > 0 ? { note: notes.join(' ') } : {}),
        },
        NARROW_HINT,
      );
    }),
  );
}
