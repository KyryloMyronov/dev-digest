import type { PromptSectionMetric } from '@devdigest/reviewer-core';
import type { PinoLike } from './run-logger.js';

/**
 * Structured logging of prompt ASSEMBLY — what went into a model call, never
 * what it said.
 *
 * ## The safety property
 *
 * This module is safe by CONSTRUCTION, not by redaction. It accepts
 * `PromptSectionMetric[]`, a type with no field that can hold text: a name, a
 * provenance label, a boolean and two numbers. There is nothing here to redact,
 * so there is no redaction pass that can be forgotten, mis-ordered, or defeated
 * by a new section type added later.
 *
 * What is therefore IMPOSSIBLE to leak through this path:
 *   - the diff, in whole or in part
 *   - the PR description or a linked ticket's body
 *   - project-context / spec chunks (`## Project context` is private content —
 *     only its size is recorded)
 *   - skill bodies, memory items, the repo map, the derived intent text
 *   - any secret: API keys never enter a prompt section in the first place, and
 *     `SecretsProvider` is the only component that reads them at all
 *
 * What IS recorded: section name, provenance, trusted/untrusted, size, the model
 * and provider actually used, and a correlation id.
 *
 * ## Do not "improve" this by adding a preview
 *
 * A truncated sample, a first line, or a "just the headings" excerpt all
 * reintroduce exactly the leak this shape exists to prevent — the first 200
 * characters of a spec chunk are still private content. If prompt CONTENT is
 * genuinely needed for debugging, it is already persisted per run in
 * `run_traces.prompt_assembly` behind the API's workspace scoping, which is the
 * right place for it: access-controlled storage, not a log stream that ships to
 * stdout and onward to whatever collects it.
 */

/** Which model call this prompt belongs to. */
export interface PromptLogContext {
  /**
   * Ties every line of one logical operation together: the shared pre-work
   * (diff load, intent derivation) and each agent's own review call all carry
   * the same id, so one PR review fan-out is greppable as a unit.
   */
  correlationId: string;
  /** The pipeline stage: 'review' | 'intent' | … */
  stage: string;
  provider: string;
  model: string;
  runId?: string;
  prId?: string;
}

export interface PromptLogOptions {
  /**
   * Per-section breakdown. Local only — `loadConfig` refuses to set this under
   * NODE_ENV=production. Off → one summary line.
   */
  verbose: boolean;
}

/** Total characters, and how many of them are untrusted external data. */
function totals(sections: PromptSectionMetric[]): {
  chars: number;
  untrustedChars: number;
  tokens?: number;
} {
  let chars = 0;
  let untrustedChars = 0;
  let tokens = 0;
  let haveTokens = false;
  for (const s of sections) {
    chars += s.chars;
    if (s.untrusted) untrustedChars += s.chars;
    if (s.tokens != null) {
      tokens += s.tokens;
      haveTokens = true;
    }
  }
  return haveTokens ? { chars, untrustedChars, tokens } : { chars, untrustedChars };
}

/**
 * Emit the assembly record.
 *
 * Always: ONE summary line at `info` — enough to answer "which model, how big,
 * how much of it was untrusted, and which operation was this part of" without
 * turning on anything.
 *
 * Verbose: one `debug` line per section on top of that. `debug` on purpose —
 * the default `LOG_LEVEL=info` means switching the flag on still produces
 * nothing until the level is lowered too, so a stray flag in a shared
 * environment cannot start writing per-section detail on its own.
 */
export function logPromptAssembly(
  log: PinoLike | undefined,
  ctx: PromptLogContext,
  sections: PromptSectionMetric[],
  opts: PromptLogOptions,
): void {
  if (!log) return;

  const t = totals(sections);
  log.info(
    {
      event: 'prompt_assembly',
      ...ctx,
      sections: sections.length,
      ...t,
      // Which optional slots were present, by name only — the single most
      // useful field when a review behaves differently between two runs.
      slots: sections.map((s) => s.source),
    },
    `prompt assembled — ${sections.length} section(s), ${t.chars} chars` +
      (t.tokens != null ? `, ~${t.tokens} tokens` : ''),
  );

  if (!opts.verbose) return;
  for (const s of sections) {
    log.debug(
      {
        event: 'prompt_section',
        correlationId: ctx.correlationId,
        stage: ctx.stage,
        ...(ctx.runId ? { runId: ctx.runId } : {}),
        name: s.name,
        source: s.source,
        untrusted: s.untrusted,
        chars: s.chars,
        ...(s.tokens != null ? { tokens: s.tokens } : {}),
      },
      `  ${s.name} — ${s.source}${s.untrusted ? ' (untrusted)' : ''}: ${s.chars} chars`,
    );
  }
}
