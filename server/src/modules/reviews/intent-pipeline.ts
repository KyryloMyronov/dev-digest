import type { PrIntentRecord, RepoRef, UnifiedDiff } from '@devdigest/shared';
import { randomUUID } from 'node:crypto';
import type { Container } from '../../platform/container.js';
import type { RunLogger } from '../../platform/run-logger.js';
import { renderPrompt } from '../../platform/prompts.js';
import { wrapUntrusted } from '../../platform/prompt.js';
import { logPromptAssembly } from '../../platform/prompt-log.js';
import type * as schema from '../../db/schema.js';
import type { PullRow, ReviewRepository } from './repository.js';
import { INTENT_SCHEMA_NAME, MAX_SPEC_BYTES, MAX_SPEC_FILES } from './constants.js';
import { IntentExtractionSchema } from './intent-schemas.js';
import {
  applyConfidenceRule,
  clampIntent,
  isDocumentedBody,
  parseIssueRefs,
  parseSpecPaths,
  summariseCommits,
  summariseDiffFiles,
} from './intent-sources.js';

/**
 * L03 — the intent layer: what this PR is FOR, derived once before the review.
 *
 * A standalone function over (container, repository, args) rather than a service
 * method, mirroring `modules/conventions/pipeline.ts`, so the whole flow can be
 * driven in a hermetic unit test with stubs — no Docker, no model, no clone.
 *
 * NEVER THROWS. Every failure returns `{ record: undefined, reason }` and the
 * review proceeds with a prompt byte-identical to the pre-L03 one. Failing an
 * expensive review because a cheap enrichment call broke is strictly worse than
 * reviewing without the enrichment. The corollary, learned the hard way from the
 * conventions scan (server/insights.md 2026-08-11): a swallowed failure that
 * reports nowhere is invisible, so every exit logs — and the failure exits log at
 * `error`, which is the only level that reaches the user as a toast.
 *
 * A failed derivation writes NO row: `pr_intent`'s PK is `pr_id`, so a failure
 * row would overwrite a good earlier derivation and poison the cache.
 */

/** Why a derivation produced nothing. Mirrors the conventions scan's vocabulary. */
export type IntentSkipReason =
  | 'no_signals'
  | 'llm_unavailable'
  | 'model_unsupported'
  | 'cancelled'
  | 'llm_failed';

export interface DeriveIntentArgs {
  workspaceId: string;
  pull: PullRow;
  repo: typeof schema.repos.$inferSelect;
  diff: UnifiedDiff;
  runLog: RunLogger;
  /** True when every run this derivation would serve has been cancelled. */
  isCancelled?: () => boolean;
  /** Ignore the cached row and re-derive (the manual re-derive endpoint). */
  force?: boolean;
  /** Ties this derivation's log lines to the review fan-out that triggered it. */
  correlationId?: string;
}

export interface DeriveIntentOutcome {
  /** Echoed back so the caller's later log lines share this operation's id. */
  correlationId: string;
  record?: PrIntentRecord;
  reason?: IntentSkipReason;
  /** True when the record came from `pr_intent` and no model call was made. */
  cached?: boolean;
}

/** One gathered signal: a labelled, untrusted block plus its source id. */
interface Signal {
  /** `wrapUntrusted` label — also what the model cites in `evidence`. */
  label: string;
  /** The id recorded in `pr_intent.sources`. */
  source: string;
  text: string;
}

export async function deriveIntent(
  container: Container,
  repository: ReviewRepository,
  args: DeriveIntentArgs,
): Promise<DeriveIntentOutcome> {
  const { workspaceId, pull, repo, diff, runLog } = args;
  // Inherited from the review fan-out when there is one, so the classifier call
  // and the review calls it precedes share an id; standalone (the re-derive job)
  // it gets its own.
  const correlationId = args.correlationId ?? randomUUID();
  const verbose = container.config.promptLogVerbose;

  try {
    // 1. Cache. Keyed on (pr_id, head_sha), not pr_id alone: a force-push means
    //    the intent describes code that no longer exists.
    if (!args.force) {
      const cached = await repository.getIntent(pull.id).catch(() => undefined);
      if (cached && cached.head_sha === pull.headSha) {
        runLog.info(
          `Intent: cached for ${pull.headSha.slice(0, 7)} (${describeConfidence(cached)}) — no model call`,
        );
        return { correlationId, record: cached, cached: true };
      }
      if (cached) runLog.info(`Intent: cached copy is stale (head moved) — re-deriving`);
    }

    // 2. Cancellation. A single structured call is not chunkable, so this is the
    //    one checkpoint; each agent's own checkCancelled still fires downstream.
    if (args.isCancelled?.()) {
      runLog.info('Intent: all runs cancelled before derivation — skipping');
      return { correlationId, reason: 'cancelled' };
    }

    // 3. Gather. Each signal is independently best-effort.
    const signals = await gatherSignals(container, { pull, repo, diff, runLog });
    if (signals.length === 0) {
      runLog.error('Intent derivation unavailable (no_signals) — reviewing without it');
      return { correlationId, reason: 'no_signals' };
    }
    runLog.info(`Intent sources: ${signals.map((s) => s.source).join(', ')}`);

    // 4. Resolve the cheap classifier model. A missing key throws ConfigError.
    const choice = await container.featureModel(workspaceId, 'review_intent');
    let llm;
    try {
      llm = await container.llm(choice.provider);
    } catch (err) {
      runLog.error(
        `Intent derivation unavailable (llm_unavailable) — reviewing without it: ${(err as Error).message}`,
      );
      return { correlationId, reason: 'llm_unavailable' };
    }

    // 5. Preflight. Only `false` blocks: `null` means the catalogue could not
    //    tell us, and our ignorance is not the model's limitation.
    if (choice.provider === 'openrouter') {
      const supported = await container.modelCatalog
        .supportsStructuredOutputs(choice.model)
        .catch(() => null);
      if (supported === false) {
        runLog.error(
          `Intent derivation unavailable (model_unsupported) — ${choice.model} cannot serve structured outputs. Pick another model in Settings → Models.`,
        );
        return { correlationId, reason: 'model_unsupported' };
      }
    }

    // 6. One call. Log what goes into it first — names, provenance and sizes
    //    only; the ticket body and the plan/spec text never reach the log.
    const systemPrompt = await renderPrompt('review-intent.system.md', {});
    const userMessage = [
      `Recover the motivation behind pull request #${pull.number} in ${repo.fullName}.`,
      ...signals.map((s) => wrapUntrusted(s.label, s.text)),
    ].join('\n\n');

    logPromptAssembly(
      runLog.stdout,
      {
        correlationId,
        stage: 'intent',
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
        ...signals.map((sig) => ({
          name: sig.label,
          source: sig.source,
          untrusted: true,
          chars: sig.text.length,
          ...(verbose ? { tokens: container.tokenizer.count(sig.text) } : {}),
        })),
      ],
      { verbose },
    );

    let extraction;
    try {
      extraction = await llm.completeStructured({
        model: choice.model,
        schema: IntentExtractionSchema,
        schemaName: INTENT_SCHEMA_NAME,
        maxRetries: 1,
        sessionId: `${repo.owner}/${repo.name}#${pull.number}:intent`,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userMessage },
        ],
      });
    } catch (err) {
      runLog.error(
        `Intent derivation unavailable (llm_failed) — reviewing without it: ${(err as Error).message}`,
      );
      return { correlationId, reason: 'llm_failed' };
    }

    // 7. Clamp + apply the confidence rule. The model's own number is a ceiling.
    const data = clampIntent(extraction.data);
    const sources = signals.map((s) => s.source);
    const { confidence, derivedFrom } = applyConfidenceRule(sources, data.confidence);

    const record: PrIntentRecord = {
      pr_id: pull.id,
      intent: data.intent,
      in_scope: data.in_scope,
      out_of_scope: data.out_of_scope,
      change_type: data.change_type,
      confidence,
      sources,
      derived_from: derivedFrom,
      provider: choice.provider,
      model: extraction.model || choice.model,
      cost_usd: extraction.costUsd,
      head_sha: pull.headSha,
      created_at: new Date().toISOString(),
    };

    // 8. Persist. A write failure must not lose the derivation we already paid
    //    for — the review still gets it, it just will not be cached.
    await repository
      .upsertIntent(pull.id, {
        intent: record.intent,
        in_scope: record.in_scope,
        out_of_scope: record.out_of_scope,
        changeType: record.change_type ?? null,
        confidence: record.confidence ?? null,
        sources: record.sources,
        provider: record.provider ?? null,
        model: record.model ?? null,
        tokensIn: extraction.tokensIn,
        tokensOut: extraction.tokensOut,
        costUsd: extraction.costUsd,
        headSha: pull.headSha,
      })
      .catch((err: unknown) => {
        runLog.info(`Intent: derived but not persisted — ${(err as Error).message}`);
      });

    runLog.result(
      `Intent: ${truncate(record.intent, 120)} (${describeConfidence(record)}, ${record.change_type ?? 'uncategorised'})`,
    );
    return { correlationId, record };
  } catch (err) {
    // The catch-all exists so this function's contract — never throws — holds
    // even if something above is refactored into a throwing path.
    runLog.error(`Intent derivation unavailable — reviewing without it: ${(err as Error).message}`);
    return { correlationId, reason: 'llm_failed' };
  }
}

// ------------------------------------------------------------------ signals

async function gatherSignals(
  container: Container,
  args: {
    pull: PullRow;
    repo: typeof schema.repos.$inferSelect;
    diff: UnifiedDiff;
    runLog: RunLogger;
  },
): Promise<Signal[]> {
  const { pull, repo, diff, runLog } = args;
  const ref: RepoRef = { owner: repo.owner, name: repo.name };
  const signals: Signal[] = [];

  // 1. Title — NOT NULL, always present.
  signals.push({ label: 'pr-title', source: 'title', text: pull.title });

  // 2. Body. Sent whatever its length; only `isDocumentedBody` decides whether it
  //    lifts the confidence cap, because a short body can still state a reason.
  if (pull.body && pull.body.trim().length > 0) {
    const documented = isDocumentedBody(pull.body);
    signals.push({
      label: 'pr-body',
      // An undocumented stub is still evidence, but not DOCUMENTATION — record it
      // under a source id that classifySources does not count.
      source: documented ? 'pr_body' : 'pr_body_stub',
      text: pull.body.slice(0, 8000),
    });
    if (!documented) runLog.info('Intent: PR description is too short to count as documentation');
  } else {
    runLog.info('Intent: PR has no description — falling back to indirect signals');
  }

  // 3. Branch.
  signals.push({ label: 'branch', source: 'branch', text: pull.branch });

  // 4. Commit subjects.
  try {
    const commits = await container.pullsRepo.listCommits(pull.id);
    const text = summariseCommits(commits.map((c) => c.message ?? ''));
    if (text.length > 0) signals.push({ label: 'commits', source: 'commits', text });
  } catch (err) {
    runLog.info(`Intent: could not read commits — ${(err as Error).message}`);
  }

  // 5. Changed files — from the diff the executor ALREADY loaded. Paths and
  //    counts only: sending the diff body would make the cheap model cost like
  //    the review it precedes.
  if (diff.files.length > 0) {
    signals.push({ label: 'changed-files', source: 'files', text: summariseDiffFiles(diff) });
  }

  // 6. Linked GitHub issue.
  const refs = parseIssueRefs(pull.body);
  if (refs.issues.length > 0) {
    try {
      const github = await container.github();
      const issue = await github.getIssue(ref, refs.issues[0]!);
      signals.push({
        label: 'ticket',
        source: 'ticket',
        text: `#${issue.number} ${issue.title}\n\n${(issue.body ?? '').slice(0, 6000)}`,
      });
      runLog.info(`Intent: linked issue #${issue.number} resolved`);
    } catch (err) {
      runLog.info(`Intent: linked issue #${refs.issues[0]} not resolved — ${(err as Error).message}`);
    }
  }

  // 7. Jira-style key: detected only. This repo has no issue-tracker adapter, so
  //    the key proves a ticket exists and says nothing about its contents — it
  //    must never lift the confidence cap.
  if (refs.ticketKeys.length > 0) {
    signals.push({
      label: 'ticket-key-unresolved',
      source: 'ticket_key_unresolved',
      text: `${refs.ticketKeys.join(', ')} — referenced by the author; no issue tracker is connected, so the ticket's contents are unavailable.`,
    });
    runLog.info(
      `Intent: ticket key ${refs.ticketKeys.join(', ')} found but no tracker is configured`,
    );
  }

  // 8. Linked plan / spec, read from the clone.
  const specPaths = parseSpecPaths(pull.body);
  if (specPaths.length > 0) {
    for (const path of specPaths.slice(0, MAX_SPEC_FILES)) {
      try {
        const text = await container.git.readFile(ref, path);
        if (text.trim().length === 0) continue;
        signals.push({
          label: `spec:${path}`,
          source: `spec:${path}`,
          text: `path: ${path}\n\n${text.slice(0, MAX_SPEC_BYTES)}`,
        });
        runLog.info(`Intent: read plan/spec ${path} (${Math.round(text.length / 1024)} KB)`);
      } catch (err) {
        runLog.info(`Intent: plan/spec ${path} not readable — ${(err as Error).message}`);
      }
    }
  }

  return signals;
}

// ------------------------------------------------------------------ helpers

function describeConfidence(record: PrIntentRecord): string {
  if (record.confidence == null) return 'confidence unrecorded';
  return `confidence ${record.confidence.toFixed(2)}, ${record.derived_from ?? 'unknown'}`;
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n - 1)}…`;
}
