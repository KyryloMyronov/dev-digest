/**
 * project-context service — SPEC-01.
 *
 * Discovery, listing, single-document content, the attachment surface and the
 * `ProjectContext` facade the review path resolves through. No HTTP types here: the route
 * parses and delegates, and the Zod schemas it declares serve both validation
 * and serialization.
 *
 * Cost model, because NFR-3 gives the list endpoint 800 ms p95 over 500
 * documents: `list()` is ONE clone walk plus exactly THREE set-based queries
 * (cached token counts, attach counts, last scan time). Token counts are served
 * from `context_doc_tokens` and never computed here — computing them is the
 * job's business.
 */
import { stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import type {
  AgentContextDoc,
  ContextDoc,
  ContextDocContent,
  ContextDocList,
  SkillContextDoc,
} from '@devdigest/shared';
import type { Container } from '../../platform/container.js';
import { AppError, NotFoundError } from '../../platform/errors.js';
import { approxTokens } from '../../adapters/tokenizer/index.js';
import { ProjectContextRepository } from './repository.js';
import { walkContextDocs, type WalkedDoc } from './walk.js';
import { planContextDocs, resolveContextForRun } from './resolver.js';
import type { ProjectContext, ResolvedContext } from './types.js';
import {
  MAX_CONTEXT_DOCUMENT_BYTES,
  TOKEN_COUNT_JOB_KIND,
  TOKEN_JOB_BUDGET_MS,
} from './constants.js';

/** Payload enqueued for (and consumed by) the token-count job. */
export interface TokenCountJobPayload {
  repoId: string;
}

/** What one token-count pass did — returned for tests and observability. */
export interface TokenCountResult {
  /** Documents whose count was (re)computed and persisted. */
  counted: number;
  /** Documents skipped because the stored `content_hash` still matched. */
  unchanged: number;
  /** Documents left uncounted because the time budget ran out (AC-38). */
  remaining: number;
  /** Total bytes read, so a caller can report throughput (NFR-4). */
  bytes: number;
}

export class ProjectContextService implements ProjectContext {
  private repo: ProjectContextRepository;

  /**
   * `repo` is injectable so the hermetic unit tests can drive the job, the list
   * and the run-start resolver against an in-memory stub instead of Postgres.
   * Production never passes it; the container's `db` is the default.
   *
   * **This is a NEW seam, not one modelled on an existing service.** An earlier
   * version of this comment cited `conventions` as local precedent; that is
   * wrong in shape and the claim was withdrawn at review. `ConventionsService`'s
   * constructor takes only `container` (`conventions/service.ts`), and
   * `runConventionScan` is a free function in `conventions/pipeline.ts` that
   * takes its repository at the CALL SITE. Of the twelve services under
   * `src/modules`, this is the only one with a constructor-level repository
   * override. It is optional, production never passes it, and `lint:arch` is
   * clean on it — but do not cite it as "how this repo does it".
   */
  constructor(private container: Container, repo?: ProjectContextRepository) {
    this.repo = repo ?? new ProjectContextRepository(container.db);
  }

  /**
   * AC-1/2/3/6, AC-15, AC-16, AC-30, AC-34 — the document list for one repo.
   *
   * The list itself is a LIVE walk of the clone (AC-1 says "found … in that
   * repository's clone"), joined in memory against persisted counts.
   */
  async list(workspaceId: string, repoId: string): Promise<ContextDocList> {
    const { clonePath } = await this.requireClonedRepo(workspaceId, repoId);

    const walked = await walkContextDocs(clonePath);

    const [tokens, attachCounts, scannedAt] = await Promise.all([
      this.repo.tokensForRepo(workspaceId, repoId),
      this.repo.agentCountsByPath(workspaceId),
      this.repo.lastScanAt(workspaceId, repoId),
    ]);

    const files: ContextDoc[] = walked.files.map((d) => ({
      path: d.path,
      source: d.source,
      // AC-34 — no cached row means `null`, which the studio renders as pending.
      // Deliberately "no row for this path", not a per-request hash comparison:
      // hashing up to 500 documents of up to 400 KB per request would break
      // NFR-3 outright, and `content_hash` is the JOB's mechanism for skipping
      // recomputation. A count can therefore be stale between reindexes.
      tokens: tokens.get(d.path) ?? null,
      attached_agents: attachCounts.get(d.path) ?? 0,
      size: d.size,
    }));

    return {
      files,
      total: walked.total,
      omitted: walked.omitted,
      scanned_at: scannedAt ? scannedAt.toISOString() : null,
    };
  }

  /**
   * AC-11 (server half) — one document's text.
   *
   * Membership is checked against the walk rather than trusting the request
   * parameter, which makes `SimpleGitClient.readFile`'s containment guard
   * (AC-61/62) a SECOND line of defence rather than the only one.
   */
  async readDoc(workspaceId: string, repoId: string, path: string): Promise<ContextDocContent> {
    const repo = await this.requireClonedRepo(workspaceId, repoId);

    const walked = await walkContextDocs(repo.clonePath);
    const doc = walked.files.find((d) => d.path === path);
    if (!doc) {
      throw new AppError('doc_not_found', `No project-context document at '${path}'`, 404);
    }

    const size = await this.sizeOf(repo.clonePath, doc);
    if (size === null) {
      throw new AppError('doc_not_found', `Document '${path}' could not be read`, 404);
    }
    if (size > MAX_CONTEXT_DOCUMENT_BYTES) {
      throw new AppError(
        'doc_too_large',
        `Document '${path}' is ${size} bytes, over the ${MAX_CONTEXT_DOCUMENT_BYTES}-byte limit`,
        413,
      );
    }

    // Read through the port so the containment guard applies.
    const content = await this.container.git.readFile(
      { owner: repo.owner, name: repo.name },
      doc.path,
    );
    return { path: doc.path, content, size };
  }

  // ---------------------------------------------------- token-count job -----

  /**
   * Register the token-count handler once, at module load. Follows
   * `RepoService.registerCloneJobHandler()`'s shape — `JobRunner` stores the
   * closure, not the service instance.
   */
  registerTokenCountJobHandler(): void {
    this.container.jobs.register(TOKEN_COUNT_JOB_KIND, async (payload) => {
      await this.runTokenCountJob(payload as TokenCountJobPayload);
    });
  }

  /**
   * AC-36/37/38 — count and persist one token count per document.
   *
   * Skips a document whose stored `contentHash` still matches the freshly
   * hashed body: that is what `content_hash` is for and why a re-scan is cheap.
   *
   * `opts` exists so the two ceiling behaviours are testable at all — a clipped
   * `budgetMs` is the only way to observe AC-38, and injecting the clock keeps
   * that test from depending on wall-clock timing.
   */
  async runTokenCountJob(
    payload: TokenCountJobPayload,
    opts: { budgetMs?: number; now?: () => number } = {},
  ): Promise<TokenCountResult> {
    const budgetMs = opts.budgetMs ?? TOKEN_JOB_BUDGET_MS;
    const now = opts.now ?? (() => Date.now());
    const startedAt = now();

    const result: TokenCountResult = { counted: 0, unchanged: 0, remaining: 0, bytes: 0 };

    const repo = await this.repo.repoForJob(payload.repoId);
    if (!repo?.clonePath || !(await this.dirExists(repo.clonePath))) return result;

    const walked = await walkContextDocs(repo.clonePath);
    const cached = await this.repo.cachedTokenRows(repo.workspaceId, payload.repoId);
    const ref = { owner: repo.owner, name: repo.name };

    for (let i = 0; i < walked.files.length; i += 1) {
      const doc = walked.files[i]!;

      // AC-38 — check the budget BETWEEN documents and stop, leaving what is
      // already persisted intact. Soft self-watch, well under `JobRunner`'s
      // hard timeout, the same posture as `INDEX_SOFT_BUDGET_MS`.
      if (now() - startedAt >= budgetMs) {
        result.remaining = walked.files.length - i;
        break;
      }

      // A document that can never be injected (AC-49) is not worth counting.
      if (doc.size !== null && doc.size > MAX_CONTEXT_DOCUMENT_BYTES) continue;

      let text: string;
      try {
        text = await this.container.git.readFile(ref, doc.path);
      } catch {
        // Unreadable or escaping path — leave it uncounted; the list endpoint
        // serves `tokens: null` for it, which is an honest "not counted".
        continue;
      }

      const contentHash = createHash('sha256').update(text).digest('hex');
      if (cached.get(doc.path)?.contentHash === contentHash) {
        result.unchanged += 1;
        continue;
      }

      result.bytes += Buffer.byteLength(text);
      result.counted += 1;
      await this.repo.upsertTokenCount({
        workspaceId: repo.workspaceId,
        repoId: payload.repoId,
        path: doc.path,
        contentHash,
        tokens: this.countTokens(text),
      });
    }

    return result;
  }

  /**
   * AC-37 — a throwing tokenizer must not lose the document.
   *
   * This try/catch is needed EVEN THOUGH `TiktokenTokenizer.count` already
   * catches internally and returns `approxTokens`: the criterion is a
   * requirement on this job, not on the default adapter, and an injected
   * tokenizer (a different implementation, or a test mock) has made no such
   * promise. `approxTokens` is reused rather than re-deriving `ceil(chars/4)`,
   * so the fallback here and the adapter's cannot drift.
   */
  private countTokens(text: string): number {
    try {
      return this.container.tokenizer.count(text);
    } catch {
      return approxTokens(text);
    }
  }


  // ------------------------------------------------- attachments (Cut 2) -----

  /**
   * AC-17/23/29 — the agent's resolved attachment list, in prompt order.
   *
   * Built from `planContextDocs`, the SAME function the run-start resolver
   * uses, so the tab cannot show an order or a dedupe outcome a run would not
   * reproduce. Inherited rows carry the originating skill's name (AC-23).
   *
   * `doc` is the discovered document, or `null` when the path no longer resolves
   * in `repoId` — the unresolved row of AC-29, which must be visible and
   * removable rather than omitted. `repoId` is optional and a failure to
   * discover degrades to "every `doc` is null": the tab must render even while
   * the repository is still cloning.
   */
  async agentDocs(
    workspaceId: string,
    agentId: string,
    repoId?: string,
  ): Promise<AgentContextDoc[]> {
    const [planned, discovered] = await Promise.all([
      planContextDocs({ links: this.repo, agents: this.container.agentsRepo }, { workspaceId, agentId }),
      this.discoveredDocs(workspaceId, repoId),
    ]);
    return planned.map((p, i) => ({
      agent_id: agentId,
      path: p.path,
      order: i,
      doc: discovered.get(p.path) ?? null,
      inherited_from: p.inheritedFrom ?? null,
    }));
  }

  /** AC-18 — attach one path to an agent, after the two checks below. */
  async attachAgentDoc(
    workspaceId: string,
    agentId: string,
    repoId: string,
    path: string,
  ): Promise<AgentContextDoc[]> {
    await this.assertOwnAgent(workspaceId, agentId);
    await this.assertDiscovered(workspaceId, repoId, [path]);
    await this.repo.attachAgentDoc(workspaceId, agentId, path);
    return this.agentDocs(workspaceId, agentId, repoId);
  }

  /**
   * AC-19 — persist a new order for the agent's whole list.
   *
   * A submitted path is accepted when it is EITHER discovered now OR already
   * attached to this agent. The second clause is what keeps AC-29 workable: an
   * attachment whose file was deleted still renders as a row, so a reorder that
   * includes it must not be rejected wholesale — while a path that is neither
   * discovered nor already attached cannot be smuggled in through the reorder
   * endpoint, which would otherwise be a back door around the attach check.
   */
  async setAgentDocs(
    workspaceId: string,
    agentId: string,
    repoId: string,
    paths: string[],
  ): Promise<AgentContextDoc[]> {
    await this.assertOwnAgent(workspaceId, agentId);
    const existing = new Set((await this.repo.agentDocs(workspaceId, agentId)).map((d) => d.path));
    await this.assertDiscovered(
      workspaceId,
      repoId,
      paths.filter((p) => !existing.has(p)),
    );
    await this.repo.setAgentDocs(workspaceId, agentId, paths);
    return this.agentDocs(workspaceId, agentId, repoId);
  }

  /** AC-18 — detach. No DOCUMENT membership check: removing a row is always
      safe, and an unresolved row (AC-29) must stay removable. The AGENT still
      has to be the caller's, as on every other write. */
  async detachAgentDoc(
    workspaceId: string,
    agentId: string,
    path: string,
    repoId?: string,
  ): Promise<AgentContextDoc[]> {
    await this.assertOwnAgent(workspaceId, agentId);
    await this.repo.detachAgentDoc(workspaceId, agentId, path);
    return this.agentDocs(workspaceId, agentId, repoId);
  }

  /** AC-20 — a skill's own attachments. No inheritance: a skill is where
      inheritance starts. */
  async skillDocs(
    workspaceId: string,
    skillId: string,
    repoId?: string,
  ): Promise<SkillContextDoc[]> {
    const [rows, discovered] = await Promise.all([
      this.repo.skillDocs(workspaceId, skillId),
      this.discoveredDocs(workspaceId, repoId),
    ]);
    return rows.map((r, i) => ({
      skill_id: skillId,
      path: r.path,
      order: i,
      doc: discovered.get(r.path) ?? null,
    }));
  }

  /** AC-20 — attach one path to a skill, after the two checks below. */
  async attachSkillDoc(
    workspaceId: string,
    skillId: string,
    repoId: string,
    path: string,
  ): Promise<SkillContextDoc[]> {
    await this.assertOwnSkill(workspaceId, skillId);
    await this.assertDiscovered(workspaceId, repoId, [path]);
    await this.repo.attachSkillDoc(workspaceId, skillId, path);
    return this.skillDocs(workspaceId, skillId, repoId);
  }

  /** AC-20 — detach one path from a skill. No DOCUMENT membership check, for
      `detachAgentDoc`'s reason: removing a row is always safe and an unresolved
      row must stay removable. The SKILL still has to be the caller's. */
  async detachSkillDoc(
    workspaceId: string,
    skillId: string,
    path: string,
    repoId?: string,
  ): Promise<SkillContextDoc[]> {
    await this.assertOwnSkill(workspaceId, skillId);
    await this.repo.detachSkillDoc(workspaceId, skillId, path);
    return this.skillDocs(workspaceId, skillId, repoId);
  }

  // --------------------------------------------- the run-start facade -------

  /**
   * AC-39/40/43/45/47/48/49 — `container.projectContext`'s only method.
   *
   * Delegates to `resolver.ts`, which never throws. The extra try/catch here is
   * for the ONE thing the resolver cannot absorb: a synchronous failure while
   * assembling its dependencies (a container getter that throws). The contract
   * with `run-executor` is absolute — this method resolves, always.
   */
  async resolveForRun(input: {
    workspaceId: string;
    agentId: string;
    repoOwner: string;
    repoName: string;
    onLog?: (msg: string) => void;
  }): Promise<ResolvedContext> {
    try {
      return await resolveContextForRun(
        {
          links: this.repo,
          agents: this.container.agentsRepo,
          git: this.container.git,
          countTokens: (text) => this.countTokens(text),
          ...(input.onLog ? { onLog: input.onLog } : {}),
        },
        input,
      );
    } catch (err) {
      input.onLog?.(
        `project context: unavailable, reviewing without it — ${(err as Error).message}`,
      );
      return { texts: [], injected: [], skipped: [] };
    }
  }

  // ------------------------------------------------------------- helpers ----

  /**
   * THE PARENT-OWNERSHIP CHECK every write needs (review requirement, Cut 2).
   *
   * The repository scopes each row by `workspace_id` AND `agent_id`, so a
   * foreign agent id exposes nothing: neither tenant can read the other's row.
   * What it does not prevent is the CASCADE —
   * `agent_context_docs.agent_id references agents(id) on delete cascade`
   * (`db/schema/project-context.ts`) — so a row written under workspace A
   * against workspace B's agent is destroyed the moment B deletes that agent, by
   * an action A never took and cannot see.
   *
   * `container.agentsRepo` is the sanctioned seam for reading another module's
   * aggregate (`agents/repository.ts` is private to that module), and this is
   * the same `getById(workspaceId, id)`-then-404 the siblings pay for before
   * mutating a link table (`agents/service.ts:170,183,205,218`). `NotFoundError`
   * rather than a bespoke code, for the same reason those routes use it: an
   * agent that is not this workspace's is indistinguishable from one that does
   * not exist.
   */
  private async assertOwnAgent(workspaceId: string, agentId: string): Promise<void> {
    const agent = await this.container.agentsRepo.getById(workspaceId, agentId);
    if (!agent) throw new NotFoundError('Agent not found');
  }

  /**
   * The same check for the two skill writes, and the same cascade to prevent:
   * `skill_context_docs.skill_id` is `on delete cascade`, so a row written under
   * one workspace against another's skill dies when that workspace deletes it.
   *
   * Reached through `this.repo.skillForContext` rather than a skills-module
   * repository or a new container getter — the reasoning, and the accepted cost
   * of `project-context` becoming a second reader of `skills`, is recorded at
   * that method. Not asymmetric with `assertOwnAgent` by preference: `agents`
   * has a container seam (`container.agentsRepo`) and `skills` does not.
   */
  private async assertOwnSkill(workspaceId: string, skillId: string): Promise<void> {
    const skill = await this.repo.skillForContext(workspaceId, skillId);
    if (!skill) throw new NotFoundError('Skill not found');
  }

  /**
   * THE MEMBERSHIP CHECK the attach routes rely on (review requirement, Cut 2).
   *
   * `SimpleGitClient.readFile`'s containment guard is LEXICAL, so a symlink
   * inside the clone that points outside it is "contained" and would be
   * followed. In Cut 1 that was unreachable because `walk.ts` never emits a
   * symlink AND `readDoc` reads `doc.path` (the walk's own value) rather than
   * the request parameter. Cut 2's resolver reads PERSISTED paths, which removes
   * that second layer — so the filtering moves here, to the door, and is paid
   * once per attach instead of once per document per run.
   *
   * Consequence worth knowing: the discovered set is `list()`'s, which is capped
   * at `MAX_CONTEXT_DOCUMENTS`, so a document past the cap cannot be attached.
   * The studio cannot show it either, so nothing is reachable-but-unattachable.
   */
  private async assertDiscovered(
    workspaceId: string,
    repoId: string,
    paths: string[],
  ): Promise<void> {
    if (paths.length === 0) return;
    // Deliberately NOT degrading: a repo with no clone cannot answer "is this
    // path one of yours?", and guessing "yes" is the failure mode this check
    // exists to prevent. `list()` throws 409 `repo_not_cloned` (AC-4).
    const listed = await this.list(workspaceId, repoId);
    const known = new Set(listed.files.map((f) => f.path));
    const unknown = paths.filter((p) => !known.has(p));
    if (unknown.length > 0) {
      throw new AppError(
        'doc_not_found',
        `Not a discovered project-context document: ${unknown.join(', ')}`,
        404,
      );
    }
  }

  /**
   * `path → ContextDoc` for one repository, or an EMPTY map when no repository
   * was supplied or its clone is not ready. Used only to inline `doc` on
   * attachment rows, where "unknown" is a legitimate answer (AC-29).
   */
  private async discoveredDocs(
    workspaceId: string,
    repoId?: string,
  ): Promise<Map<string, ContextDoc>> {
    if (!repoId) return new Map();
    try {
      const listed = await this.list(workspaceId, repoId);
      return new Map(listed.files.map((f) => [f.path, f]));
    } catch {
      return new Map();
    }
  }

  /**
   * The repo row plus a clone that actually exists on disk.
   *
   * AC-4 — a repo with no clone is `409 repo_not_cloned`. 409 is not the default
   * of any `AppError` subclass, and both the code and the status are specified,
   * so `AppError` is constructed directly rather than inventing a subclass for
   * one call site. A repo id that does not resolve in this workspace is the same
   * answer as one that does not exist — tenancy leaks nothing (AC-3).
   */
  private async requireClonedRepo(
    workspaceId: string,
    repoId: string,
  ): Promise<{ owner: string; name: string; fullName: string; clonePath: string }> {
    const repo = await this.repo.repoForContext(workspaceId, repoId);
    if (!repo) throw new AppError('repo_not_found', 'Repo not found', 404);
    if (!repo.clonePath || !(await this.dirExists(repo.clonePath))) {
      throw new AppError(
        'repo_not_cloned',
        `Repository ${repo.fullName} has not finished cloning yet`,
        409,
      );
    }
    return { ...repo, clonePath: repo.clonePath };
  }

  private async dirExists(path: string): Promise<boolean> {
    try {
      return (await stat(path)).isDirectory();
    } catch {
      return false;
    }
  }

  /** The walk already stat'd; only re-stat when that failed. */
  private async sizeOf(root: string, doc: WalkedDoc): Promise<number | null> {
    if (doc.size !== null) return doc.size;
    try {
      return (await stat(`${root}/${doc.path}`)).size;
    } catch {
      return null;
    }
  }
}
