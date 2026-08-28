import { randomUUID } from 'node:crypto';
import type { FocusEntry, PrBriefRecord, Risk } from '@devdigest/shared';
import { groundCitations } from '@devdigest/reviewer-core';
import type { Container } from '../../platform/container.js';
import type { RunLogger } from '../../platform/run-logger.js';
import type { PullRow } from '../../db/rows.js';
import type * as schema from '../../db/schema.js';
import { renderPrompt } from '../../platform/prompts.js';
import { logPromptAssembly } from '../../platform/prompt-log.js';
import { loadBriefDiff } from './diff.js';
import { assembleBriefPrompt, gatherBriefSignals } from './sources.js';
import { BriefExtractionSchema, type BriefExtraction } from './schemas.js';
import type { BriefRepository } from './repository.js';
import type { BriefBlob, DeriveBriefOutcome } from './types.js';
import {
  BRIEF_LLM_MAX_RETRIES,
  BRIEF_MAX_OUTPUT_TOKENS,
  BRIEF_SCHEMA_NAME,
  MAX_BRIEF_RISKS,
  MAX_FOCUS_ENTRIES,
  MAX_FOCUS_REASON_CHARS,
  MAX_RISK_EXPLANATION_CHARS,
  MAX_RISK_TITLE_CHARS,
  MAX_WHY_SUMMARY_CHARS,
} from './constants.js';

/** The repo row, referenced through the schema rather than through another
 *  module's repository — `no-cross-module-internals` forbids importing that
 *  type, and `intent-pipeline.ts` reaches it the same way. */
type RepoRow = typeof schema.repos.$inferSelect;

/**
 * SPEC-02 — the brief derivation: why + risks + review focus, derived once and
 * persisted against the PR's head SHA.
 *
 * A standalone function over (container, repository, args) rather than a
 * service method, mirroring `reviews/intent-pipeline.ts`, so the whole flow is
 * drivable in a hermetic unit test with stubs: no Docker, no model, no clone.
 *
 * NEVER THROWS (AC-10). Every exit path returns an outcome. `JobRunner` retries
 * a REJECTED handler twice, so a deterministic throw here would be THREE billed
 * derivations for one broken model config. The corollary, learned the hard way
 * from the conventions scan: a swallowed failure that reports nowhere is
 * invisible, so every exit logs exactly once (NFR-6) and every FAILURE exit logs
 * at `error` — the only level that reaches the user as a toast.
 *
 * A failed derivation writes NO row (AC-11): `pr_brief`'s PK is `pr_id`, so a
 * failure row would overwrite a good earlier derivation and poison the cache.
 */

export interface DeriveBriefArgs {
  workspaceId: string;
  pull: PullRow;
  repo: RepoRow;
  runLog: RunLogger;
  /** Ignore the cached row and re-derive (AC-13). */
  force?: boolean;
  /** Ties this derivation's log lines together (NFR-6). */
  correlationId?: string;
}

export async function deriveBrief(
  container: Container,
  repository: BriefRepository,
  args: DeriveBriefArgs,
): Promise<DeriveBriefOutcome> {
  const { workspaceId, pull, repo, runLog } = args;
  const correlationId = args.correlationId ?? randomUUID();
  const verbose = container.config.promptLogVerbose;

  try {
    // 1. Cache (AC-12 / AC-13). Keyed on (pr_id, head_sha), not pr_id alone: a
    //    force-push means the brief describes code that no longer exists.
    if (!args.force) {
      const cached = await repository.getBrief(workspaceId, pull.id).catch(() => undefined);
      if (cached && cached.head_sha === pull.headSha) {
        runLog.info(
          `Brief: cached for ${pull.headSha.slice(0, 7)} (${cached.risks.length} risk(s)) — no model call`,
        );
        return { correlationId, record: cached, cached: true };
      }
      if (cached) runLog.info('Brief: cached copy is stale (head moved) — re-deriving');
    }

    // 2. Diff. Nothing to ground against ⇒ nothing worth deriving.
    const diff = await loadBriefDiff(container, pull, repo).catch(() => ({ raw: '', files: [] }));
    if (diff.files.length === 0) {
      runLog.error('Brief derivation unavailable (no_diff) — the PR has no readable changed files');
      return { correlationId, reason: 'no_diff' };
    }

    // 3. Model resolution (AC-64). The `risk_brief` id is already registered in
    //    both mirrors, so no feature-model registry edit is needed — which
    //    matters, because that registry is the one client mirror
    //    `check-contracts.sh` cannot see.
    const choice = await container.featureModel(workspaceId, 'risk_brief');

    // 4. Provider (AC-18). A missing key throws ConfigError from `buildLlm`.
    let llm;
    try {
      llm = await container.llm(choice.provider);
    } catch (err) {
      runLog.error(
        `Brief derivation unavailable (llm_unavailable): ${(err as Error).message}`,
      );
      return { correlationId, reason: 'llm_unavailable' };
    }

    // 5. Preflight (AC-17 / AC-61). Only an explicit `false` blocks: `null`
    //    means the catalogue could not tell us, and our ignorance is not the
    //    model's limitation.
    if (choice.provider === 'openrouter') {
      const supported = await container.modelCatalog
        .supportsStructuredOutputs(choice.model)
        .catch(() => null);
      if (supported === false) {
        runLog.error(
          `Brief derivation unavailable (model_unsupported) — ${choice.model} cannot serve structured outputs. Pick another model in Settings → Models.`,
        );
        return { correlationId, reason: 'model_unsupported' };
      }
    }

    // 6. Assemble, then log what went into the call — names, provenance and
    //    sizes only. The PR body and the diff text NEVER reach the log (NFR-9).
    const systemPrompt = await renderPrompt('risk-brief.system.md', {});
    const signals = await gatherBriefSignals(container, { pull, runLog });
    const assembled = assembleBriefPrompt(container, {
      pull,
      repo,
      diff,
      systemPrompt,
      signals,
    });
    if (assembled.omitted.length > 0) {
      runLog.info(
        `Brief: ${assembled.omitted.length} changed file(s) omitted by the prompt token cap`,
      );
    }

    logPromptAssembly(
      runLog.stdout,
      {
        correlationId,
        // `PromptLogContext.stage` is an untyped string, so this needs no
        // contract change.
        stage: 'brief',
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
        ...assembled.signals.map((sig) => ({
          name: sig.label,
          source: sig.source,
          untrusted: true,
          chars: sig.text.length,
          ...(verbose ? { tokens: container.tokenizer.count(sig.text) } : {}),
        })),
      ],
      { verbose },
    );

    // 7. ONE call (AC-14). `maxRetries: 0` makes that literally true: the
    //    provider loops `maxRetries + 1` times, so any other value would turn
    //    NFR-4's $0.07 ceiling into a per-attempt figure.
    let extraction;
    try {
      extraction = await llm.completeStructured({
        model: choice.model,
        schema: BriefExtractionSchema,
        schemaName: BRIEF_SCHEMA_NAME,
        maxRetries: BRIEF_LLM_MAX_RETRIES,
        maxTokens: BRIEF_MAX_OUTPUT_TOKENS,
        sessionId: `${repo.owner}/${repo.name}#${pull.number}:brief`,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: assembled.message },
        ],
      });
    } catch (err) {
      runLog.error(`Brief derivation unavailable (llm_failed): ${(err as Error).message}`);
      return { correlationId, reason: 'llm_failed' };
    }

    // 8. Parse (AC-15). Re-validated here rather than trusted from the adapter,
    //    so a provider that returns a shape the schema rejects is a recorded
    //    parse failure that PERSISTS NOTHING, not an opaque throw.
    const parsed = BriefExtractionSchema.safeParse(extraction.data);
    if (!parsed.success) {
      runLog.error(
        `Brief derivation unavailable (parse_failed): ${parsed.error.issues[0]?.message ?? 'schema mismatch'}`,
      );
      return { correlationId, reason: 'parse_failed' };
    }

    // 9. Clamp IN CODE (AC-16) — strict `json_schema` ignores `.max()`. Done
    //    BEFORE grounding, so the gate never runs on items that were going to
    //    be discarded anyway.
    const clamped = clampBrief(parsed.data);

    // 10. Ground (AC-24–AC-29).
    const grounded = groundBrief(clamped.risks, clamped.focus, diff);

    const blob: BriefBlob = {
      why: { summary: clamped.why_summary, sources: clamped.why_sources },
      risks: grounded.risks,
      focus: { entries: grounded.focus },
      // AC-28 / AC-29: the gate's own counts. An all-dropped derivation
      // persists an EMPTY risk list with a NON-ZERO dropped count — which is
      // exactly what distinguishes "everything was hallucinated" from
      // "genuinely no risks found".
      grounding: { kept: grounded.kept, dropped: grounded.dropped },
      omitted_files: assembled.omitted,
    };

    const record: PrBriefRecord = {
      pr_id: pull.id,
      why: blob.why,
      risks: blob.risks,
      focus: blob.focus,
      grounding: blob.grounding,
      omitted_files: blob.omitted_files,
      provider: choice.provider,
      model: extraction.model || choice.model,
      tokens_in: extraction.tokensIn,
      tokens_out: extraction.tokensOut,
      // AC-20: `estimateCost` returns null for a model absent from the price
      // table and a real 0 for one priced at zero. NEVER coalesce the two.
      cost_usd: extraction.costUsd,
      head_sha: pull.headSha,
      created_at: new Date().toISOString(),
    };

    // 11. Persist (AC-19). A rejection is caught and logged and the derived
    //     record is STILL returned (AC-21): a write failure must not lose the
    //     derivation we already paid for — it just will not be cached.
    await repository
      .upsertBrief(pull.id, {
        json: blob,
        provider: record.provider ?? null,
        model: record.model ?? null,
        tokensIn: extraction.tokensIn,
        tokensOut: extraction.tokensOut,
        costUsd: extraction.costUsd,
        headSha: pull.headSha,
      })
      .catch((err: unknown) => {
        runLog.info(`Brief: derived but not persisted — ${(err as Error).message}`);
      });

    runLog.result(
      `Brief: ${grounded.risks.length} risk(s), ${grounded.focus.length} focus entr(y|ies), ${grounded.dropped} citation(s) dropped`,
    );
    return { correlationId, record };
  } catch (err) {
    // The catch-all exists so this function's contract — NEVER THROWS — holds
    // even if something above is refactored into a throwing path.
    runLog.error(`Brief derivation unavailable: ${(err as Error).message}`);
    return { correlationId, reason: 'llm_failed' };
  }
}

// ------------------------------------------------------------------- clamps

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n);
}

/** AC-16 — every array and every string clamped to its declared limit. */
export function clampBrief(data: BriefExtraction): BriefExtraction {
  return {
    why_summary: truncate(data.why_summary, MAX_WHY_SUMMARY_CHARS),
    why_sources: data.why_sources,
    risks: data.risks.slice(0, MAX_BRIEF_RISKS).map((r) => ({
      ...r,
      title: truncate(r.title, MAX_RISK_TITLE_CHARS),
      explanation: truncate(r.explanation, MAX_RISK_EXPLANATION_CHARS),
    })),
    focus: data.focus.slice(0, MAX_FOCUS_ENTRIES).map((f) => ({
      ...f,
      reason: truncate(f.reason, MAX_FOCUS_REASON_CHARS),
    })),
  };
}

// ----------------------------------------------------------------- grounding

interface GroundedBrief {
  risks: Risk[];
  focus: FocusEntry[];
  kept: number;
  dropped: number;
}

/**
 * The citation gate, in two passes.
 *
 * D-8 / REC-1 — `kind` is model-authored FREE TEXT. reviewer-core's
 * FULL_FILE_KINDS (grounding.ts:16) exempts {secret_leak, lethal_trifecta,
 * phantom, hook} from line anchoring, so a risk claiming kind:"phantom"
 * would BYPASS AC-24/AC-26 entirely. Never spread a risk into this literal.
 *
 * The citation objects are therefore FRESH literals carrying only the three
 * geometry fields plus an index used to re-associate the survivors.
 */
export function groundBrief(
  risks: BriefExtraction['risks'],
  focus: BriefExtraction['focus'],
  diff: Parameters<typeof groundCitations>[1],
): GroundedBrief {
  const gatedRisks = groundCitations(
    risks.map((r, i) => ({ file: r.file, start_line: r.start_line, end_line: r.end_line, i })),
    diff,
  );

  // Focus entries are gated in a SECOND pass with `fullFile: () => true`, so an
  // entry naming a file present in the diff is kept whether or not it carries
  // lines (AC-27). The intent is explicit at the call site rather than encoded
  // in magic zeros — note the file-presence check still runs first, so an entry
  // naming an absent file is dropped either way.
  const gatedFocus = groundCitations(
    focus.map((f, i) => ({ file: f.file, start_line: f.start_line, end_line: f.end_line, i })),
    diff,
    { fullFile: () => true },
  );

  const keptRisks: Risk[] = gatedRisks.kept.map((c) => {
    const r = risks[c.i]!;
    return {
      kind: r.kind,
      title: r.title,
      explanation: r.explanation,
      severity: r.severity,
      file: r.file,
      start_line: r.start_line,
      end_line: r.end_line,
    };
  });

  const keptFocus: FocusEntry[] = gatedFocus.kept.map((c) => {
    const f = focus[c.i]!;
    return {
      file: f.file,
      // 0 is the schema's "no particular line" (strict json_schema forbids an
      // optional field), and it becomes a genuine absence on the wire.
      start_line: f.start_line > 0 ? f.start_line : null,
      end_line: f.end_line > 0 ? f.end_line : null,
      reason: f.reason,
    };
  });

  return {
    risks: keptRisks,
    focus: keptFocus,
    kept: gatedRisks.kept.length + gatedFocus.kept.length,
    dropped: gatedRisks.dropped.length + gatedFocus.dropped.length,
  };
}
