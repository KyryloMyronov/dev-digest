import type { FileSummaryDeriveInput, PrFileSummariesResponse } from '@devdigest/shared';
import type { Container } from '../../platform/container.js';
import { AppError, NotFoundError, ValidationError } from '../../platform/errors.js';
import { RunLogger, type PinoLike } from '../../platform/run-logger.js';
import { FileSummaryRepository } from './repository.js';
import { deriveFileSummaries } from './pipeline.js';
import { toWire } from './helpers.js';
import { eligibleFor, selectFiles } from './selection.js';
import { FILE_SUMMARY_DERIVE_JOB_KIND } from './constants.js';
import type { DeriveFileSummariesOutcome, FileSummaryJobPayload } from './types.js';

/**
 * SPEC-03 — file-summary service. Orchestration only: no SQL (that is
 * `repository.ts`), no HTTP types (that is `routes.ts`), and no reach into
 * another module's internals — `container.pullsRepo` is the sanctioned
 * cross-module seam for `pull_requests` / `pr_files`.
 *
 * Shaped after `BriefService`, which itself copies `ReviewService`'s intent
 * quartet, for the same reasons those give.
 *
 * This file may NOT import `src/db/schema` (`no-db-schema-above-repository`). It
 * MAY import `../_shared/classify-path.js` (indirectly, through
 * `selection.ts`) — that is the whole point of the SPEC-03 promotion.
 */
export class FileSummaryService {
  private repo: FileSummaryRepository;

  constructor(private container: Container) {
    this.repo = new FileSummaryRepository(container.db);
  }

  /**
   * The PR's summaries plus the AC-60 counts. DELIBERATELY NEVER DERIVES (AC-7):
   * a GET must not spend a model call — the intent route refuses this explicitly
   * and both siblings follow it.
   *
   * THIS METHOD COMPLETES PLAN D-2's READ-TIME PROJECTION. The repository has
   * already reduced the accumulated per-head-SHA rows to ONE ROW PER PATH; the
   * counts on top of them are business logic and belong here, not in SQL:
   *
   *   total          = the derivation-ELIGIBLE files (non-boilerplate, patch
   *                    non-null). A boilerplate file is never in the denominator
   *                    because AC-18 means it is never a candidate.
   *   selected       = eligible paths WITH a row at the PR's CURRENT head.
   *   omitted_files  = eligible paths WITHOUT one, in `selectFiles`' own AC-19
   *                    order so the list is stable and testable.
   *
   * `omitted_files` therefore means "eligible but not summarised" — NOT "dropped
   * by one derivation's token cap". The table has no column for that, and AC-51's
   * per-file control is what tells "never derived" from "cap-omitted" on screen.
   *
   * The response is composed to be EXACTLY `PrFileSummariesResponse`: the route's
   * response schema strips unknown keys, so an extra field here would silently
   * stop being sent rather than erroring.
   */
  async getSummaries(workspaceId: string, prId: string): Promise<PrFileSummariesResponse> {
    const pull = await this.container.pullsRepo.findPull(workspaceId, prId);
    if (!pull) throw new NotFoundError('Pull request not found');

    const [rows, files] = await Promise.all([
      this.repo.listSummaries(workspaceId, prId),
      this.container.pullsRepo.listFiles(prId),
    ]);

    const freshPaths = new Set(rows.filter((r) => r.headSha === pull.headSha).map((r) => r.path));
    // `selectFiles(files)` with no `path` IS `eligibleFor(files)` in AC-19 order,
    // by construction — the same predicate, one sorted. `total` reads off the
    // set, `omitted_files` off the ordering, so the two can never disagree.
    const eligible = eligibleFor(files);
    const ordered = selectFiles(files);

    return {
      summaries: rows.map(toWire),
      omitted_files: ordered.filter((f) => !freshPaths.has(f.path)).map((f) => f.path),
      selected: eligible.filter((f) => freshPaths.has(f.path)).length,
      total: eligible.length,
    };
  }

  /** Register the derivation handler. Called once, from the routes plugin. */
  registerJobHandler(): void {
    this.container.jobs.register(FILE_SUMMARY_DERIVE_JOB_KIND, async (payload) => {
      const { workspaceId, prId, path, force } = payload as FileSummaryJobPayload;
      // DELIBERATELY SWALLOWS: `runDerivation` throws `AppError` when the
      // derivation yields nothing, and a REJECTED handler is retried twice by
      // JobRunner — three billed derivations for one broken model config. The
      // pipeline has already persisted (or deliberately not persisted) its own
      // outcome and logged the reason by the time we get here.
      await this.runDerivation(workspaceId, prId, { path, force }).catch(() => undefined);
    });
  }

  /**
   * Queue a derivation. Returns the job id, or NULL when the enqueue itself
   * failed — `JobRunner.enqueue` throws when no handler is registered for the
   * kind, and that is the path AC-10 describes. The route answers 202 either way
   * so the studio has ONE path: poll until fresh.
   *
   * The PR is validated HERE rather than in the handler, so an unknown id still
   * 404s instead of being accepted and silently discarded.
   *
   * AC-14 ALSO LIVES HERE: a body naming a `path` that is not a changed file of
   * this PR is a 422 BEFORE anything is enqueued — "without enqueuing a job" is
   * half the criterion, so the test asserts the job count is zero.
   */
  async enqueueDerivation(
    workspaceId: string,
    prId: string,
    input: FileSummaryDeriveInput = {},
  ): Promise<string | null> {
    const pull = await this.container.pullsRepo.findPull(workspaceId, prId);
    if (!pull) throw new NotFoundError('Pull request not found');

    if (input.path !== undefined) {
      const files = await this.container.pullsRepo.listFiles(prId);
      if (!files.some((f) => f.path === input.path)) {
        throw new ValidationError(`'${input.path}' is not a changed file of this pull request`);
      }
    }

    try {
      const job = await this.container.jobs.enqueue(workspaceId, FILE_SUMMARY_DERIVE_JOB_KIND, {
        workspaceId,
        prId,
        path: input.path,
        force: input.force,
      } satisfies FileSummaryJobPayload);
      return job.id;
    } catch {
      return null;
    }
  }

  /**
   * Run a derivation inline. Used by the job handler and by tests; NOT reachable
   * from a route — the model call belongs on `JobRunner`, not in a request
   * (AC-9), and the runner's own defaults are what AC-36 / NFR-10 rest on
   * (concurrency 3, timeout 120 000 ms, two retries — `platform/jobs.ts`,
   * constructed with no options at `platform/container.ts`).
   *
   * Throws `AppError` when the derivation yields nothing, so the one caller that
   * wants a hard failure (a test) gets one. The job handler catches it.
   */
  async runDerivation(
    workspaceId: string,
    prId: string,
    opts: { path?: string; force?: boolean; logger?: PinoLike } = {},
  ): Promise<DeriveFileSummariesOutcome> {
    const pull = await this.container.pullsRepo.findPull(workspaceId, prId);
    if (!pull) throw new NotFoundError('Pull request not found');
    const repo = await this.container.pullsRepo.findRepoById(pull.repoId);
    if (!repo) throw new NotFoundError('Repository not found');

    // No runIds: this is not a review run, so the events mirror to pino only.
    const runLog = new RunLogger(this.container.runBus, [], opts.logger, { prId });
    const outcome = await deriveFileSummaries(this.container, this.repo, {
      workspaceId,
      pull,
      repo,
      runLog,
      path: opts.path,
      force: opts.force,
    });
    if (!outcome.summaries) {
      throw new AppError(
        'file_summaries_unavailable',
        `Could not derive file summaries for this pull request (${outcome.reason ?? 'unknown'}).`,
        400,
      );
    }
    return outcome;
  }
}
