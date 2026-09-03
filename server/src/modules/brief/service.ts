import type { PrBriefRecord } from '@devdigest/shared';
import type { Container } from '../../platform/container.js';
import { AppError, NotFoundError } from '../../platform/errors.js';
import { RunLogger, type PinoLike } from '../../platform/run-logger.js';
import { BriefRepository } from './repository.js';
import { deriveBrief } from './pipeline.js';
import { BRIEF_DERIVE_JOB_KIND } from './constants.js';
import type { BriefJobPayload } from './types.js';

/**
 * SPEC-02 — brief service. Orchestration only: no SQL (that is
 * `repository.ts`), no HTTP types (that is `routes.ts`), and no reach into
 * another module's internals — `container.pullsRepo` is the sanctioned
 * cross-module seam for `pull_requests` / `repos`.
 *
 * Shaped after `ReviewService`'s intent quartet, for the same reasons it gives.
 */
export class BriefService {
  private repo: BriefRepository;

  constructor(private container: Container) {
    this.repo = new BriefRepository(container.db);
  }

  /**
   * The PR's persisted brief, or null when nothing has been derived yet.
   * DELIBERATELY NEVER DERIVES: a GET must not spend a model call — the intent
   * route refuses this explicitly and this module follows it.
   */
  async getBrief(workspaceId: string, prId: string): Promise<PrBriefRecord | null> {
    const pull = await this.container.pullsRepo.findPull(workspaceId, prId);
    if (!pull) throw new NotFoundError('Pull request not found');
    return (await this.repo.getBrief(workspaceId, prId)) ?? null;
  }

  /** Register the brief-derivation handler. Called once, from the routes plugin. */
  registerBriefJobHandler(): void {
    this.container.jobs.register(BRIEF_DERIVE_JOB_KIND, async (payload) => {
      const { workspaceId, prId, force } = payload as BriefJobPayload;
      // DELIBERATELY SWALLOWS: `runBriefDerivation` throws `AppError` when the
      // derivation yields nothing, and a REJECTED handler is retried twice by
      // JobRunner — three billed derivations for one broken model config. The
      // pipeline has already persisted (or deliberately not persisted) its own
      // outcome and logged the reason by the time we get here.
      await this.runBriefDerivation(workspaceId, prId, { force }).catch(() => undefined);
    });
  }

  /**
   * Queue a derivation (the card's "Derive" / "Re-derive" control). Returns the
   * job id, or NULL when the enqueue itself failed — `JobRunner.enqueue` throws
   * when no handler is registered for the kind, and that is the path AC-8
   * describes. The route answers 202 either way so the studio has ONE path:
   * poll the brief until it is fresh for the current head.
   *
   * The PR is validated HERE rather than in the handler, so an unknown id still
   * 404s instead of being accepted and silently discarded.
   */
  async enqueueBriefDerivation(
    workspaceId: string,
    prId: string,
    force?: boolean,
  ): Promise<string | null> {
    const pull = await this.container.pullsRepo.findPull(workspaceId, prId);
    if (!pull) throw new NotFoundError('Pull request not found');
    try {
      const job = await this.container.jobs.enqueue(workspaceId, BRIEF_DERIVE_JOB_KIND, {
        workspaceId,
        prId,
        force,
      } satisfies BriefJobPayload);
      return job.id;
    } catch {
      return null;
    }
  }

  /**
   * Run a derivation inline. Used by the job handler and by tests; NOT reachable
   * from a route — the model call over the whole diff belongs on `JobRunner`,
   * not in a request.
   *
   * Throws `AppError` when the derivation yields nothing, so the one caller that
   * wants a hard failure (a test) gets one. The job handler catches it.
   *
   * `opts.force` is part of the signature because AC-12 and AC-13 are asserted
   * through THIS path — the cache decision belongs to the pipeline, and the job
   * payload is what carries the user's `force` down to it.
   */
  async runBriefDerivation(
    workspaceId: string,
    prId: string,
    opts: { force?: boolean; logger?: PinoLike } = {},
  ): Promise<PrBriefRecord> {
    const pull = await this.container.pullsRepo.findPull(workspaceId, prId);
    if (!pull) throw new NotFoundError('Pull request not found');
    const repo = await this.container.pullsRepo.findRepoById(pull.repoId);
    if (!repo) throw new NotFoundError('Repository not found');

    // No runIds: this is not a review run, so the events mirror to pino only.
    const runLog = new RunLogger(this.container.runBus, [], opts.logger, { prId });
    const outcome = await deriveBrief(this.container, this.repo, {
      workspaceId,
      pull,
      repo,
      runLog,
      force: opts.force,
    });
    if (!outcome.record) {
      throw new AppError(
        'brief_unavailable',
        `Could not derive a brief for this pull request (${outcome.reason ?? 'unknown'}).`,
        400,
      );
    }
    return outcome.record;
  }
}
