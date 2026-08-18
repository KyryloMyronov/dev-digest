import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Container } from '../../platform/container.js';
import { renderPrompt } from '../../platform/prompts.js';
import { wrapUntrusted } from '../../platform/prompt.js';
import {
  CONVENTIONS_SCAN_JOB_KIND,
  EXTRACTION_SCHEMA_NAME,
  MAX_FILE_BYTES,
  MAX_SELECTED_FILES,
  SAMPLE_FILE_COUNT,
  SELECTION_SCHEMA_NAME,
} from './constants.js';
import { groundCandidates, matchKey, pickSelectedPaths } from './helpers.js';
import { ConventionExtractionSchema, ConventionFileSelectionSchema } from './schemas.js';
import type { ConventionsRepository, InsertConvention } from './repository.js';

/**
 * The conventions scan.
 *
 * A standalone function over (container, repository) rather than a service
 * method, mirroring `repo-intel/pipeline/full.ts`, so the whole LLM flow can be
 * driven in a hermetic unit test with a tmpdir clone and a stub repository —
 * the alternative is a Docker-gated test for the one part of this feature most
 * worth testing.
 *
 * Two model calls, by design:
 *   1. `ConventionFileSelection` — sees PATHS ONLY and picks what to read.
 *   2. `ConventionExtraction`    — sees the ~12 chosen files and states the rules.
 * Sending 80 whole files to one call would cost an order of magnitude more for a
 * worse result, since most of them are near-duplicates of each other.
 *
 * NEVER THROWS. Every failure and every can't-run is persisted on the scan row
 * and returned. JobRunner retries a rejected handler twice (`platform/jobs.ts`),
 * which for a deterministic failure — no API key, no clone — would mean three
 * full scans for one broken config.
 */

export interface ScanPayload {
  workspaceId: string;
  repoId: string;
}

export interface ScanArgs extends ScanPayload {
  jobId?: string | null;
}

/** What the caller (and the tests) can assert on without re-reading the DB. */
export interface ScanOutcome {
  status: 'done' | 'failed' | 'degraded';
  reason?: string;
  sampleFiles: number;
  selectedFiles: number;
  candidatesFound: number;
  newCandidates: number;
}

export { CONVENTIONS_SCAN_JOB_KIND };

export async function runConventionScan(
  container: Container,
  repo: ConventionsRepository,
  args: ScanArgs,
): Promise<ScanOutcome> {
  const { workspaceId, repoId } = args;
  const jobId = args.jobId ?? null;

  const target = await repo.findRepo(workspaceId, repoId);
  if (!target) {
    // A stale job payload (the repo was deleted between enqueue and run), not
    // something a user did wrong.
    return finish(repo, { workspaceId, repoId, jobId }, { status: 'failed', reason: 'no_repo' });
  }

  await repo.upsertScan({
    repoId,
    workspaceId,
    status: 'running',
    startedAt: new Date(),
    error: null,
    reason: null,
    jobId,
  });

  try {
    // 1. Sample. `[]` means repo-intel is disabled or this repo was never
    //    indexed. Per the facade's contract that is "no enrichment", not an
    //    error — and it must cost ZERO model calls.
    const samples = await container.repoIntel.getConventionSamples(repoId, SAMPLE_FILE_COUNT);
    if (samples.length === 0) {
      return finish(
        repo,
        { workspaceId, repoId, jobId },
        { status: 'degraded', reason: 'not_indexed' },
      );
    }

    if (!target.clonePath) {
      return finish(
        repo,
        { workspaceId, repoId, jobId },
        { status: 'degraded', reason: 'no_clone', sampleFiles: samples.length },
      );
    }

    // 2. Resolve the model. Missing key throws ConfigError from the container.
    const choice = await container.featureModel(workspaceId, 'conventions');
    let llm;
    try {
      llm = await container.llm(choice.provider);
    } catch (err) {
      return finish(
        repo,
        { workspaceId, repoId, jobId },
        {
          status: 'failed',
          reason: 'llm_unavailable',
          sampleFiles: samples.length,
          error: (err as Error).message,
          provider: choice.provider,
          model: choice.model,
        },
      );
    }

    // 2b. Preflight: both calls below demand a STRICT json_schema response
    //     format, and not every OpenRouter model can serve one — the `:free`
    //     variant of a model often drops `structured_outputs` while keeping
    //     `response_format`. Without this check that shows up as an opaque
    //     upstream 429 or a schema-validation failure, after paying for a call.
    //
    //     Only `false` blocks. `null` means the catalogue could not tell us
    //     (no key, cold fetch, unknown id) — our ignorance is not the model's
    //     limitation, so we try anyway. Providers other than OpenRouter publish
    //     no such list and are never gated here.
    if (choice.provider === 'openrouter') {
      const supported = await container.modelCatalog.supportsStructuredOutputs(choice.model);
      if (supported === false) {
        return finish(
          repo,
          { workspaceId, repoId, jobId },
          {
            status: 'failed',
            reason: 'model_unsupported',
            sampleFiles: samples.length,
            provider: choice.provider,
            model: choice.model,
            error: `${choice.model} does not support structured outputs, which this scan requires. Choose a model that does.`,
          },
        );
      }
    }

    // 3. Step one — choose the files, from paths alone.
    const selection = await llm.completeStructured({
      model: choice.model,
      schema: ConventionFileSelectionSchema,
      schemaName: SELECTION_SCHEMA_NAME,
      maxRetries: 1,
      messages: [
        {
          role: 'system',
          content: await renderPrompt('conventions.select.system.md', {
            max_files: String(MAX_SELECTED_FILES),
          }),
        },
        {
          role: 'user',
          content: [
            `Choose from these ${samples.length} files in ${target.fullName}.`,
            wrapUntrusted('repo_files', samples.join('\n')),
          ].join('\n\n'),
        },
      ],
    });

    const selected = pickSelectedPaths(
      selection.data.files.map((f) => f.path),
      samples,
      MAX_SELECTED_FILES,
    );

    // 4. Read them. A path that vanished since indexing is skipped, not fatal.
    const files: { path: string; text: string }[] = [];
    for (const path of selected) {
      const text = await readClone(target.clonePath, path);
      if (text !== null) files.push({ path, text: text.slice(0, MAX_FILE_BYTES) });
    }
    if (files.length === 0) {
      return finish(
        repo,
        { workspaceId, repoId, jobId },
        {
          status: 'degraded',
          reason: 'no_clone',
          sampleFiles: samples.length,
          provider: choice.provider,
          model: choice.model,
        },
      );
    }

    // 5. Step two — derive the rules from what we actually read.
    const extraction = await llm.completeStructured({
      model: choice.model,
      schema: ConventionExtractionSchema,
      schemaName: EXTRACTION_SCHEMA_NAME,
      messages: [
        {
          role: 'system',
          content: await renderPrompt('conventions.extract.system.md', {}),
        },
        {
          role: 'user',
          content: [
            `These ${files.length} files are a sample of ${target.fullName}.`,
            // One block per file, each labelled with its path so the model can
            // answer `evidence_path` at all.
            ...files.map((f) => wrapUntrusted('repo_file', `path: ${f.path}\n\n${f.text}`)),
          ].join('\n\n'),
        },
      ],
    });

    // 6. Ground against the files we actually sent, not the ones we offered.
    const grounded = groundCandidates(
      extraction.data.conventions,
      new Set(files.map((f) => f.path)),
    );

    // 7. Persist, preserving every decision already made.
    const seenAt = new Date();
    const existing = new Set(
      (await repo.existingSourceRules(workspaceId, repoId)).map((r) => matchKey(r)),
    );

    const fresh: InsertConvention[] = [];
    for (const c of grounded) {
      if (existing.has(matchKey(c.sourceRule))) {
        await repo.refreshSeen(workspaceId, repoId, c.sourceRule, {
          confidence: c.confidence,
          evidencePath: c.evidencePath,
          evidenceSnippet: c.evidenceSnippet,
          at: seenAt,
        });
        continue;
      }
      fresh.push({
        workspaceId,
        repoId,
        sourceRule: c.sourceRule,
        rule: c.rule,
        evidencePath: c.evidencePath,
        evidenceSnippet: c.evidenceSnippet,
        confidence: c.confidence,
        lastSeenAt: seenAt,
      });
    }

    const inserted = await repo.insertMany(fresh);

    return finish(
      repo,
      { workspaceId, repoId, jobId },
      {
        status: 'done',
        ...(grounded.length === 0 ? { reason: 'no_candidates' } : {}),
        sampleFiles: samples.length,
        selectedFiles: files.length,
        candidatesFound: grounded.length,
        newCandidates: inserted.length,
        provider: choice.provider,
        model: choice.model,
      },
    );
  } catch (err) {
    return finish(
      repo,
      { workspaceId, repoId, jobId },
      { status: 'failed', error: (err as Error).message },
    );
  }
}

interface FinishScope {
  workspaceId: string;
  repoId: string;
  jobId: string | null;
}

interface FinishValues {
  status: 'done' | 'failed' | 'degraded';
  reason?: string;
  sampleFiles?: number;
  selectedFiles?: number;
  candidatesFound?: number;
  newCandidates?: number;
  provider?: string;
  model?: string;
  error?: string;
}

/** Stamp the terminal scan row and shape the outcome. The single exit point. */
async function finish(
  repo: ConventionsRepository,
  scope: FinishScope,
  values: FinishValues,
): Promise<ScanOutcome> {
  const outcome: ScanOutcome = {
    status: values.status,
    ...(values.reason ? { reason: values.reason } : {}),
    sampleFiles: values.sampleFiles ?? 0,
    selectedFiles: values.selectedFiles ?? 0,
    candidatesFound: values.candidatesFound ?? 0,
    newCandidates: values.newCandidates ?? 0,
  };

  await repo.upsertScan({
    repoId: scope.repoId,
    workspaceId: scope.workspaceId,
    status: values.status,
    reason: values.reason ?? null,
    sampleFiles: outcome.sampleFiles,
    selectedFiles: outcome.selectedFiles,
    candidatesFound: outcome.candidatesFound,
    newCandidates: outcome.newCandidates,
    provider: values.provider ?? null,
    model: values.model ?? null,
    jobId: scope.jobId,
    finishedAt: new Date(),
    // Truncated: a provider can return a page of HTML as its message, and this
    // column is rendered inline in the UI.
    error: values.error ? values.error.slice(0, 500) : null,
  });

  return outcome;
}

/**
 * This module's own clone read. `repo-intel` has an identical three-liner but it
 * is module-private, and reaching across for it would be a boundary violation
 * for the sake of one line.
 */
async function readClone(clonePath: string, file: string): Promise<string | null> {
  return readFile(join(clonePath, file), 'utf8').catch(() => null);
}
