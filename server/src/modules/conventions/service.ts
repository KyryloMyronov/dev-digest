import type {
  ConventionCandidate,
  ConventionSkillDraft,
  ConventionStatus,
  ConventionsView,
} from '@devdigest/shared';
import type { Container } from '../../platform/container.js';
import { NotFoundError, ValidationError } from '../../platform/errors.js';
import { ConventionsRepository } from './repository.js';
import { runConventionScan, type ScanOutcome, type ScanPayload } from './pipeline.js';
import {
  CONVENTIONS_SCAN_JOB_KIND,
  DRAFT_SKILL_SOURCE,
  DRAFT_SKILL_TYPE,
} from './constants.js';
import {
  buildSkillDraftBody,
  draftSkillName,
  evidenceFilesOf,
  idleScan,
  toConventionDto,
  toScanDto,
} from './helpers.js';

/**
 * Conventions service — derive a repo's house rules from its own source, review
 * them, and compose the accepted ones into a Skill.
 *
 * The compose step deliberately stops at a DRAFT. It does not write a skill:
 * `SkillsService.create` stays the only writer of the `skills` table, so its
 * source/type policy cannot be bypassed, and the user edits every field before
 * saving through `POST /skills` — which means cancelling leaves nothing behind.
 */

export interface UpdateConventionInput {
  status?: ConventionStatus;
  rule?: string;
  evidence_snippet?: string;
}

export class ConventionsService {
  private repo: ConventionsRepository;

  constructor(private container: Container) {
    this.repo = new ConventionsRepository(container.db);
  }

  /** Register the scan handler. Called once, from the routes plugin, at boot. */
  registerScanJobHandler(): void {
    this.container.jobs.register(CONVENTIONS_SCAN_JOB_KIND, async (payload, ctx) => {
      const { workspaceId, repoId } = payload as ScanPayload;
      await runConventionScan(this.container, this.repo, {
        workspaceId,
        repoId,
        jobId: ctx.jobId,
      });
    });
  }

  /**
   * The screen in one read. A repo that has never been scanned gets a synthesised
   * `idle` scan rather than a 404, so the client has one shape to branch on.
   */
  async list(workspaceId: string, repoId: string): Promise<ConventionsView> {
    await this.requireRepo(workspaceId, repoId);
    const [rows, scan] = await Promise.all([
      this.repo.listByRepo(workspaceId, repoId),
      this.repo.getScan(workspaceId, repoId),
    ]);
    return {
      scan: scan ? toScanDto(scan) : idleScan(repoId),
      items: rows.map(toConventionDto),
    };
  }

  /**
   * Queue a scan. The scan row is marked `queued` BEFORE the enqueue so the UI
   * shows "Scanning…" immediately, rather than only once a worker picks the job
   * up — with a busy queue that gap is seconds of a button that looks broken.
   */
  async enqueueScan(workspaceId: string, repoId: string): Promise<string | null> {
    await this.requireRepo(workspaceId, repoId);
    await this.repo.upsertScan({
      repoId,
      workspaceId,
      status: 'queued',
      reason: null,
      error: null,
      startedAt: null,
      finishedAt: null,
    });
    try {
      const job = await this.container.jobs.enqueue(workspaceId, CONVENTIONS_SCAN_JOB_KIND, {
        workspaceId,
        repoId,
      } satisfies ScanPayload);
      return job.id;
    } catch {
      // Degraded path — the route still answers 202 and the UI still polls. The
      // real outcome is whatever ends up on the scan row.
      return null;
    }
  }

  /** Run a scan inline. Used by tests and by any future synchronous caller. */
  async runScan(workspaceId: string, repoId: string): Promise<ScanOutcome> {
    return runConventionScan(this.container, this.repo, { workspaceId, repoId });
  }

  /**
   * Accept, reject, or rewrite one insight.
   *
   * Rewriting the rule or snippet sets `edited`, which is what stops a later scan
   * from overwriting the user's wording with the model's.
   */
  async updateCandidate(
    workspaceId: string,
    repoId: string,
    id: string,
    input: UpdateConventionInput,
  ): Promise<ConventionCandidate> {
    await this.requireRepo(workspaceId, repoId);
    const existing = await this.repo.getById(workspaceId, repoId, id);
    if (!existing) throw new NotFoundError('Convention not found');

    const rewrote =
      (input.rule !== undefined && input.rule !== existing.rule) ||
      (input.evidence_snippet !== undefined &&
        input.evidence_snippet !== (existing.evidenceSnippet ?? ''));

    const row = await this.repo.update(workspaceId, repoId, id, {
      ...(input.status !== undefined ? { status: input.status } : {}),
      ...(input.rule !== undefined ? { rule: input.rule } : {}),
      ...(input.evidence_snippet !== undefined
        ? { evidenceSnippet: input.evidence_snippet }
        : {}),
      ...(rewrote ? { edited: true } : {}),
    });
    if (!row) throw new NotFoundError('Convention not found');
    return toConventionDto(row);
  }

  /**
   * Set the status of several insights at once — what "Deselect all" is.
   *
   * One round trip rather than N: every mutation error raises its own toast in
   * the studio, so N parallel requests turn one partial failure into N alerts.
   */
  async setStatusMany(
    workspaceId: string,
    repoId: string,
    ids: string[],
    status: ConventionStatus,
  ): Promise<ConventionCandidate[]> {
    await this.requireRepo(workspaceId, repoId);
    const found = await this.repo.findManyByIds(workspaceId, repoId, ids);
    if (found.length !== ids.length) {
      throw new ValidationError('One or more conventions do not belong to this repo');
    }
    const rows = await this.repo.setStatusMany(workspaceId, repoId, ids, status);
    return rows.map(toConventionDto);
  }

  /**
   * Compose — but do not save — a skill from every accepted convention.
   *
   * Read-only. The client renders this in an editable form and then saves it
   * through `POST /skills`.
   */
  async buildSkillDraft(workspaceId: string, repoId: string): Promise<ConventionSkillDraft> {
    const target = await this.requireRepo(workspaceId, repoId);
    const rows = await this.repo.listByStatus(workspaceId, repoId, 'accepted');
    if (rows.length === 0) {
      throw new ValidationError('Accept at least one convention before creating a skill');
    }

    const scan = await this.repo.getScan(workspaceId, repoId);
    const body = buildSkillDraftBody(target.fullName, rows, scan?.sampleFiles ?? 0);

    return {
      name: draftSkillName(target.fullName),
      description: `${rows.length} house convention${rows.length === 1 ? '' : 's'} extracted from ${target.fullName.split('/').pop()}`,
      type: DRAFT_SKILL_TYPE,
      source: DRAFT_SKILL_SOURCE,
      body,
      evidence_files: evidenceFilesOf(rows),
      tokens: this.countTokens(body),
      convention_count: rows.length,
    };
  }

  /**
   * Token count for the body, so the editor can show what this skill would cost
   * a prompt. Degrades to a character estimate — a tokenizer failure must not
   * take down the whole draft.
   */
  private countTokens(body: string): number {
    try {
      return this.container.tokenizer.count(body);
    } catch {
      return Math.ceil(body.length / 4);
    }
  }

  /** 404 for an unknown OR foreign repo — never leak that the id exists elsewhere. */
  private async requireRepo(workspaceId: string, repoId: string) {
    const target = await this.repo.findRepo(workspaceId, repoId);
    if (!target) throw new NotFoundError('Repo not found');
    return target;
  }
}
