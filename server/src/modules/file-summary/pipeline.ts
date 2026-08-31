import { randomUUID } from 'node:crypto';
import type { PrFileSummary } from '@devdigest/shared';
import type { Container } from '../../platform/container.js';
import type { RunLogger } from '../../platform/run-logger.js';
import type { PullRow } from '../../db/rows.js';
import type * as schema from '../../db/schema.js';
import { renderPrompt } from '../../platform/prompts.js';
import { logPromptAssembly } from '../../platform/prompt-log.js';
import {
  apportion,
  assembleFileSummaryPrompt,
  selectFiles,
  type AdmittedFile,
} from './selection.js';
import { FileSummaryExtractionSchema } from './schemas.js';
import { clampSummary, toWire } from './helpers.js';
import type { FileSummaryRepository, InsertFileSummary } from './repository.js';
import type { DeriveFileSummariesOutcome } from './types.js';
import {
  FILE_SUMMARY_LLM_MAX_RETRIES,
  FILE_SUMMARY_MAX_OUTPUT_TOKENS,
  FILE_SUMMARY_SCHEMA_NAME,
} from './constants.js';

/** The repo row, referenced through the schema rather than through another
 *  module's repository — `no-cross-module-internals` forbids importing that
 *  type, and `modules/brief/pipeline.ts` reaches it the same way. */
type RepoRow = typeof schema.repos.$inferSelect;

/**
 * SPEC-03 — the file-summary derivation: ONE structured model call over the
 * selected files of a PR, persisted one row per file against the PR's head SHA.
 *
 * A standalone function over (container, repository, args) rather than a service
 * method, mirroring `modules/brief/pipeline.ts` and `reviews/intent-pipeline.ts`,
 * so the whole flow is drivable in a hermetic unit test with stubs: no Docker, no
 * model, no clone.
 *
 * NEVER THROWS (AC-15). Every exit path returns an outcome. `JobRunner` retries a
 * REJECTED handler twice, so a deterministic throw here would be THREE billed
 * derivations for one broken model config. The corollary: a swallowed failure
 * that reports nowhere is invisible, so every exit logs EXACTLY ONCE (NFR-11) and
 * every FAILURE exit logs at `error` — the only level that reaches the user as a
 * toast.
 *
 * NFR-11 also bounds what may be logged: names, provenance and sizes only. NO
 * PATCH TEXT AND NO SUMMARY TEXT in any log line, ever.
 *
 * A FAILED derivation writes NOTHING. A failure row would not overwrite a good
 * one here (the PK includes `head_sha`) but it would still be SERVED as a summary.
 */

export interface DeriveFileSummariesArgs {
  workspaceId: string;
  pull: PullRow;
  repo: RepoRow;
  runLog: RunLogger;
  /** AC-12 — derive only this file. Absent ⇒ a PR-level derivation (AC-13). */
  path?: string;
  /** AC-17 — ignore stored rows for the requested files and re-derive. */
  force?: boolean;
  /** Ties this derivation's log lines together (NFR-11). */
  correlationId?: string;
}

export async function deriveFileSummaries(
  container: Container,
  repository: FileSummaryRepository,
  args: DeriveFileSummariesArgs,
): Promise<DeriveFileSummariesOutcome> {
  const { workspaceId, pull, repo, runLog } = args;
  const correlationId = args.correlationId ?? randomUUID();
  const verbose = container.config.promptLogVerbose;

  try {
    // 1. Files — through `container.pullsRepo`, the sanctioned cross-module
    //    seam; `no-cross-module-internals` forbids importing `modules/pulls`.
    const files = await container.pullsRepo.listFiles(pull.id).catch(() => []);
    if (files.length === 0) {
      runLog.error(
        'File summaries unavailable (no_files) — the PR has no persisted changed files',
      );
      return { correlationId, reason: 'no_files' };
    }

    // 2. Select (AC-12, AC-13, AC-18, AC-19, AC-22). An empty selection exits
    //    with NO model request.
    let selection = selectFiles(files, { path: args.path });
    if (selection.length === 0) {
      runLog.error(
        `File summaries unavailable (no_files) — nothing selectable${
          args.path ? ` for ${args.path}` : ''
        } (no patch, or excluded as boilerplate)`,
      );
      return { correlationId, reason: 'no_files' };
    }

    // 3. Cache (AC-16 / AC-17). Keyed on (pr_id, path, head_sha), not pr_id
    //    alone: a force-push means a stored summary describes code that no
    //    longer exists. With `force`, skipped entirely.
    let cachedRows: PrFileSummary[] = [];
    if (!args.force) {
      const stored = await repository
        .listSummariesAtHead(workspaceId, pull.id, pull.headSha)
        .catch(() => []);
      const selected = new Set(selection.map((f) => f.path));
      cachedRows = stored.filter((r) => selected.has(r.path)).map(toWire);
      const fresh = new Set(cachedRows.map((r) => r.path));
      selection = selection.filter((f) => !fresh.has(f.path));
      if (selection.length === 0) {
        runLog.info(
          `File summaries: ${cachedRows.length} already stored for ${pull.headSha.slice(0, 7)} — no model call`,
        );
        return { correlationId, summaries: cachedRows, omitted: [], cached: true };
      }
    }

    // 4. Model resolution (AC-31). The id string is the criterion.
    const choice = await container.featureModel(workspaceId, 'file_summary');

    // 5. Provider (AC-32). A missing key throws `ConfigError` from `buildLlm` —
    //    and this is Goal 6's exit: the diff, its order and its groups are
    //    untouched by a derivation that cannot run.
    let llm;
    try {
      llm = await container.llm(choice.provider);
    } catch (err) {
      runLog.error(
        `File summaries unavailable (llm_unavailable): ${(err as Error).message}`,
      );
      return { correlationId, reason: 'llm_unavailable' };
    }

    // 6. Preflight (AC-29 / AC-30) — ONLY on openrouter, because only OpenRouter
    //    publishes the capability list. Only an explicit `false` blocks: `null`
    //    means the catalogue could not tell us, and our ignorance is not the
    //    model's limitation.
    if (choice.provider === 'openrouter') {
      const supported = await container.modelCatalog
        .supportsStructuredOutputs(choice.model)
        .catch(() => null);
      if (supported === false) {
        runLog.error(
          `File summaries unavailable (model_unsupported) — ${choice.model} cannot serve structured outputs. Pick another model in Settings → Models.`,
        );
        return { correlationId, reason: 'model_unsupported' };
      }
    }

    // 7. Assemble, then log what went into the call — names, provenance and
    //    sizes only. NO PATCH TEXT REACHES THE LOG (NFR-11).
    const systemPrompt = await renderPrompt('file-summary.system.md', {});
    const task =
      `Summarise each changed file of pull request #${pull.number} in ${repo.fullName}. ` +
      'Return one summary per file path you were given.';
    const assembled = assembleFileSummaryPrompt(container, {
      selection,
      systemPrompt,
      task,
    });
    if (assembled.admitted.length === 0) {
      // Every selected file was individually larger than the whole budget.
      runLog.error(
        `File summaries unavailable (no_files) — all ${assembled.omitted.length} selected file(s) exceed the prompt token cap`,
      );
      return { correlationId, reason: 'no_files', omitted: assembled.omitted };
    }
    if (assembled.omitted.length > 0) {
      runLog.info(
        `File summaries: ${assembled.omitted.length} selected file(s) omitted by the prompt token cap`,
      );
    }

    const patchChars = new Map(selection.map((f) => [f.path, f.patch?.length ?? 0]));
    logPromptAssembly(
      runLog.stdout,
      {
        correlationId,
        // `PromptLogContext.stage` is an untyped string, so this needs no
        // contract change.
        stage: 'file-summary',
        provider: choice.provider,
        model: choice.model,
        prId: pull.id,
      },
      [
        {
          name: 'system',
          source: 'agent',
          untrusted: false,
          chars: systemPrompt.length,
          ...(verbose ? { tokens: container.tokenizer.count(systemPrompt) } : {}),
        },
        // One metric per admitted file: its path, its provenance, its SIZE.
        // `PromptSectionMetric` has no field that can hold text, which is what
        // makes this path safe by construction rather than by redaction.
        ...assembled.admitted.map((a) => ({
          name: `file:${a.path}`,
          source: `file:${a.path}`,
          untrusted: true,
          chars: patchChars.get(a.path) ?? 0,
          ...(verbose ? { tokens: a.tokens } : {}),
        })),
      ],
      { verbose },
    );

    // 8. ONE call (AC-24, NFR-2). `maxRetries: 0` makes that literally true: the
    //    provider loops `maxRetries + 1` times, so any other value would turn
    //    NFR-1's ceiling into a per-attempt figure. `maxTokens` is AC-23.
    let extraction;
    try {
      extraction = await llm.completeStructured({
        model: choice.model,
        schema: FileSummaryExtractionSchema,
        schemaName: FILE_SUMMARY_SCHEMA_NAME,
        maxRetries: FILE_SUMMARY_LLM_MAX_RETRIES,
        maxTokens: FILE_SUMMARY_MAX_OUTPUT_TOKENS,
        sessionId: `${repo.owner}/${repo.name}#${pull.number}:file-summary`,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: assembled.message },
        ],
      });
    } catch (err) {
      // AC-39 — abandoned, NEVER re-issued.
      runLog.error(`File summaries unavailable (llm_failed): ${(err as Error).message}`);
      return { correlationId, reason: 'llm_failed' };
    }

    // 9. Parse (AC-27). Re-validated here rather than trusted from the adapter,
    //    so a provider returning a shape the schema rejects is a recorded parse
    //    failure that PERSISTS NOTHING, not an opaque throw.
    const parsed = FileSummaryExtractionSchema.safeParse(extraction.data);
    if (!parsed.success) {
      runLog.error(
        `File summaries unavailable (parse_failed): ${parsed.error.issues[0]?.message ?? 'schema mismatch'}`,
      );
      return { correlationId, reason: 'parse_failed' };
    }

    // 10. Path-gate (AC-37, AC-38) — discard every returned path that was not in
    //     THIS derivation's own admitted set. That is the stronger of the two
    //     checks: AC-38 says "not a changed file of the PR", AC-37 says "only a
    //     path that was in that derivation's own selection", and gating on the
    //     admitted set satisfies both — it is also what stops the model
    //     attaching a summary to a boilerplate file it was told to skip, or to a
    //     file the token cap dropped.
    //
    //     A duplicate path keeps the FIRST answer, so the row count can never
    //     exceed the admitted count and the weight vector stays aligned.
    const admittedByPath = new Map<string, AdmittedFile>(
      assembled.admitted.map((a) => [a.path, a]),
    );
    const kept: { path: string; summary: string; weight: number }[] = [];
    const seen = new Set<string>();
    const discarded: string[] = [];
    for (const item of parsed.data.summaries) {
      const admitted = admittedByPath.get(item.path);
      if (!admitted || seen.has(item.path)) {
        discarded.push(item.path);
        continue;
      }
      seen.add(item.path);
      // 11. Clamp IN CODE (AC-28, AC-74) — strict `json_schema` ignores
      //     `.max()`. AC-74's direction: truncate and KEEP, never reject.
      kept.push({
        path: item.path,
        summary: clampSummary(item.summary),
        weight: admitted.tokens,
      });
    }
    if (discarded.length > 0) {
      // AC-38's "with a recorded reason". Paths only — never the summary text.
      runLog.info(
        `File summaries: discarded ${discarded.length} summar(y|ies) for path(s) absent from this derivation's selection: ${discarded.join(', ')}`,
      );
    }
    if (kept.length === 0) {
      runLog.error(
        'File summaries unavailable (parse_failed) — every returned path was absent from this derivation\'s selection',
      );
      return { correlationId, reason: 'parse_failed' };
    }

    // 12. Apportion (AC-33, AC-34, plan D-1) — ONE call's usage split across the
    //     rows it produced, in proportion to each file's prompt tokens, so
    //     SUM(cost_usd) over the derivation's rows is EXACTLY the call's cost.
    //     `extraction.costUsd` is `estimateCost(model, in, out)`: `null` for a
    //     model absent from the price table, a real `0` for one priced at zero.
    //     NEVER COALESCE THE TWO.
    const weights = kept.map((k) => k.weight);
    const costShares = apportion(extraction.costUsd, weights);
    const tokensInShares = apportion(extraction.tokensIn, weights, { integer: true });
    const tokensOutShares = apportion(extraction.tokensOut, weights, { integer: true });

    const model = extraction.model || choice.model;
    const createdAt = new Date().toISOString();
    const rows: InsertFileSummary[] = kept.map((k, i) => ({
      prId: pull.id,
      path: k.path,
      headSha: pull.headSha,
      summary: k.summary,
      provider: choice.provider,
      model,
      tokensIn: tokensInShares[i] ?? null,
      tokensOut: tokensOutShares[i] ?? null,
      costUsd: costShares[i] ?? null,
    }));

    const summaries: PrFileSummary[] = rows.map((r) => ({
      path: r.path,
      summary: r.summary,
      head_sha: r.headSha,
      provider: r.provider,
      model: r.model,
      tokens_in: r.tokensIn,
      tokens_out: r.tokensOut,
      cost_usd: r.costUsd,
      created_at: createdAt,
    }));

    // 13. Persist (AC-33). A rejection is caught and logged and the derived
    //     summaries are STILL returned (AC-35): a write failure must not lose
    //     the derivation we already paid for — it just will not be cached.
    await repository.upsertSummaries(rows).catch((err: unknown) => {
      runLog.info(`File summaries: derived but not persisted — ${(err as Error).message}`);
    });

    runLog.result(
      `File summaries: ${summaries.length} file(s) summarised, ${assembled.omitted.length} omitted by the token cap`,
    );
    return {
      correlationId,
      summaries: [...cachedRows, ...summaries],
      omitted: assembled.omitted,
    };
  } catch (err) {
    // The catch-all exists so this function's contract — NEVER THROWS — holds
    // even if something above is refactored into a throwing path.
    runLog.error(`File summaries unavailable: ${(err as Error).message}`);
    return { correlationId, reason: 'llm_failed' };
  }
}
