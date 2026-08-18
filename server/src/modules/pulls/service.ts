import type {
  GitHubClient,
  PrCommentInput,
  PrDetail,
  PrMeta,
  PrReviewComment,
  SmartDiffResponse,
} from '@devdigest/shared';
import type { Container } from '../../platform/container.js';
import type { Logger } from '../../platform/logger.js';
import { AppError, NotFoundError } from '../../platform/errors.js';
import { PullsRepository, type PullRow, type RepoRow } from './repository.js';
import { prRowToDetail, prRowToMeta } from './helpers.js';
import { buildSmartDiff, latestReviewPerAgent } from './smart-diff.js';
import { DIFF_STAT_BACKFILL_LIMIT } from './constants.js';

/**
 * F1 — pulls service (extracted from routes.ts; no behaviour change).
 *
 * PR import via the GitHubClient adapter (list + per-PR detail) and the
 * inline-review-comment proxy.
 *
 * LOCAL-FIRST is the rule that shapes every method here: GitHub is an optional
 * enrichment, never a hard dependency of a read. When no token is configured or
 * the network is down, every GET still serves what was previously imported or
 * seeded. Only the comment POST fails loudly — it has nothing to fall back on.
 *
 * No HTTP and no SQL live here: persistence goes through PullsRepository, pure
 * transforms through helpers.ts, literals through constants.ts.
 */
export class PullsService {
  private repo: PullsRepository;

  constructor(
    private container: Container,
    private log: Logger,
  ) {
    this.repo = new PullsRepository(container.db);
  }

  /**
   * Resolve the GitHub client, or `null` when unavailable (no token / offline).
   * Callers on a read path degrade; the write path throws instead.
   */
  private async githubOrNull(msg: string): Promise<GitHubClient | null> {
    try {
      return await this.container.github();
    } catch (err) {
      this.log.warn({ err }, msg);
      return null;
    }
  }

  // ===========================================================================
  // GET /repos/:id/pulls
  // ===========================================================================

  /**
   * List a repo's PRs: sync from GitHub when possible, then serve from the DB
   * with the score / cost / findings rollups the list renders.
   */
  async listForRepo(workspaceId: string, repoId: string): Promise<PrMeta[]> {
    const repo = await this.repo.findRepo(workspaceId, repoId);
    if (!repo) throw new NotFoundError('Repo not found');

    const gh = await this.githubOrNull(
      'GitHub client unavailable (no token / offline); serving persisted PRs',
    );
    if (gh) await this.syncFromGitHub(workspaceId, repo, gh);

    const rows = await this.repo.listByRepo(repo.id);
    if (gh) await this.backfillDiffStats(rows, repo, gh);

    const prIds = rows.map((r) => r.id);
    const [scores, costs, findings] = await Promise.all([
      this.repo.latestReviewScoreByPr(prIds),
      this.repo.latestSettledRunCostByPr(prIds),
      this.repo.findingCountsByPr(prIds),
    ]);

    const now = Date.now();
    return rows.map((r) =>
      prRowToMeta(
        r,
        { score: scores.get(r.id), costUsd: costs.get(r.id), findings: findings.get(r.id) },
        now,
      ),
    );
  }

  /** Import/refresh the repo's PRs. Never throws — a failed sync just serves stale. */
  private async syncFromGitHub(
    workspaceId: string,
    repo: RepoRow,
    gh: GitHubClient,
  ): Promise<void> {
    try {
      const pulls = await gh.listPullRequests({ owner: repo.owner, name: repo.name });
      for (const pr of pulls) {
        await this.repo.upsertPull({
          workspaceId,
          repoId: repo.id,
          number: pr.number,
          title: pr.title,
          author: pr.author,
          branch: pr.branch,
          base: pr.base,
          headSha: pr.head_sha,
          additions: pr.additions,
          deletions: pr.deletions,
          filesCount: pr.files_count,
          status: pr.status,
          openedAt: pr.opened_at ? new Date(pr.opened_at) : null,
          updatedAt: pr.updated_at ? new Date(pr.updated_at) : null,
        });
      }
    } catch (err) {
      this.log.warn({ err }, 'GitHub PR sync skipped (no token / offline); serving persisted PRs');
    }
  }

  /**
   * Fill in diff stats for PRs that landed with zeroes (GitHub's list payload
   * omits them). Mutates `rows` in place so the response reflects the backfill
   * without a re-read. Capped per request; the periodic refetch does the rest.
   */
  private async backfillDiffStats(
    rows: PullRow[],
    repo: RepoRow,
    gh: GitHubClient,
  ): Promise<void> {
    const needStats = rows
      .filter((r) => r.additions === 0 && r.deletions === 0 && r.filesCount === 0)
      .slice(0, DIFF_STAT_BACKFILL_LIMIT);
    for (const r of needStats) {
      try {
        const detail = await gh.getPullRequest({ owner: repo.owner, name: repo.name }, r.number);
        await this.repo.updateDiffStats(r.id, {
          additions: detail.additions,
          deletions: detail.deletions,
          filesCount: detail.files_count,
        });
        r.additions = detail.additions;
        r.deletions = detail.deletions;
        r.filesCount = detail.files_count;
      } catch (err) {
        this.log.warn({ err, number: r.number }, 'PR diff-stat backfill skipped');
      }
    }
  }

  // ===========================================================================
  // GET /pulls/:id
  // ===========================================================================

  /**
   * Full PR detail. Refreshes files/commits/body from GitHub when reachable and
   * persists the result; otherwise serves what is already stored.
   */
  async getDetail(workspaceId: string, prId: string): Promise<PrDetail> {
    const { pr, repo } = await this.resolvePrAndRepo(workspaceId, prId);

    try {
      const gh = await this.container.github();
      const detail = await gh.getPullRequest({ owner: repo.owner, name: repo.name }, pr.number);

      await this.repo.replaceFiles(
        pr.id,
        detail.files.map((f) => ({
          path: f.path,
          additions: f.additions,
          deletions: f.deletions,
          patch: f.patch ?? null,
        })),
      );
      await this.repo.replaceCommits(
        pr.id,
        detail.commits.map((c) => ({
          sha: c.sha,
          message: c.message,
          author: c.author,
          committedAt: c.committed_at ? new Date(c.committed_at) : null,
        })),
      );
      await this.repo.updateDetail(pr.id, {
        body: detail.body ?? null,
        // Diff stats aren't on GitHub's PR-list payload — backfill them from the
        // detail fetch so the Pull Requests list shows real size/files.
        additions: detail.additions,
        deletions: detail.deletions,
        filesCount: detail.files_count,
      });

      return { ...detail, id: pr.id };
    } catch (err) {
      this.log.warn(
        { err },
        'GitHub PR detail refresh skipped (no token / offline); serving persisted detail',
      );
      const [files, commits] = await Promise.all([
        this.repo.listFiles(pr.id),
        this.repo.listCommits(pr.id),
      ]);
      return prRowToDetail(pr, files, commits);
    }
  }

  // ===========================================================================
  // GET /pulls/:id/smart-diff  (L03)
  // ===========================================================================

  /**
   * The PR's changed files grouped by review role, plus a split suggestion.
   *
   * Reads the SAME two facts the studio already has endpoints for — the
   * persisted changed files (`GET /pulls/:id`) and the PR's findings
   * (`GET /pulls/:id/reviews`) — and turns them into the grouping with a pure,
   * deterministic classifier. No model call: see `smart-diff.ts` for why.
   *
   * Only each agent's CURRENT review counts: a superseded pass must not keep
   * highlighting lines the re-review no longer flags. `latestReviewPerAgent`
   * owns that rule, and owns it per agent rather than per PR because one
   * "run all agents" request writes several reviews at once.
   *
   * Files are read from the DB rather than refetched, because the diff view has
   * already called `GET /pulls/:id` by the time it asks for this and that call
   * persists them; a second GitHub round-trip per page view would buy nothing.
   * The one case that would surprise a caller is a PR whose detail was never
   * fetched, so that single case falls back to a full detail import.
   */
  async getSmartDiff(workspaceId: string, prId: string): Promise<SmartDiffResponse> {
    const pr = await this.repo.findPull(workspaceId, prId);
    if (!pr) throw new NotFoundError('Pull request not found');

    let files = await this.repo.listFiles(pr.id);
    if (files.length === 0) {
      // Never imported (or a genuinely empty PR). getDetail imports and
      // persists when GitHub is reachable, and degrades quietly when it is not.
      await this.getDetail(workspaceId, prId);
      files = await this.repo.listFiles(pr.id);
    }

    const findings = await this.repo.findingsWithReviewByPr(pr.id);
    return buildSmartDiff(files, latestReviewPerAgent(findings));
  }

  // ===========================================================================
  // Inline review comments (Files changed tab)
  // ===========================================================================
  // Proxied live to GitHub with no local persistence: GET reflects existing PR
  // comments, POST creates one immediately. Keeps the tab in lock-step with
  // GitHub and avoids a stale local mirror.

  async listComments(workspaceId: string, prId: string): Promise<PrReviewComment[]> {
    const { pr, repo } = await this.resolvePrAndRepo(workspaceId, prId);
    const gh = await this.githubOrNull('GitHub client unavailable; serving no PR comments');
    if (!gh) return [];
    try {
      return await gh.listReviewComments({ owner: repo.owner, name: repo.name }, pr.number);
    } catch (err) {
      this.log.warn({ err }, 'GitHub review-comments fetch skipped (offline / error)');
      return [];
    }
  }

  async createComment(
    workspaceId: string,
    prId: string,
    input: PrCommentInput,
  ): Promise<PrReviewComment> {
    const { pr, repo } = await this.resolvePrAndRepo(workspaceId, prId);

    let gh: GitHubClient;
    try {
      gh = await this.container.github();
    } catch {
      throw new AppError('github_unavailable', 'Connect a GitHub token to post comments.', 400);
    }

    try {
      return await gh.createReviewComment({ owner: repo.owner, name: repo.name }, pr.number, {
        commitId: pr.headSha,
        path: input.path,
        line: input.line,
        ...(input.side ? { side: input.side } : {}),
        body: input.body,
        ...(input.in_reply_to != null ? { inReplyTo: input.in_reply_to } : {}),
      });
    } catch (err) {
      // GitHub rejects comments on lines outside the diff / on closed PRs (422).
      const msg = err instanceof Error ? err.message : 'Failed to post the comment to GitHub.';
      throw new AppError('github_comment_failed', msg, 400, { cause: String(err) });
    }
  }

  private async resolvePrAndRepo(
    workspaceId: string,
    prId: string,
  ): Promise<{ pr: PullRow; repo: RepoRow }> {
    const pr = await this.repo.findPull(workspaceId, prId);
    if (!pr) throw new NotFoundError('Pull request not found');
    const repo = await this.repo.findRepoById(pr.repoId);
    if (!repo) throw new NotFoundError('Repo not found');
    return { pr, repo };
  }
}
