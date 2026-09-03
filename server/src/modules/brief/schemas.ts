import { z } from 'zod';
import { Severity } from '@devdigest/shared';

/**
 * SPEC-02 — the brief extractor's structured output.
 *
 * MODULE-PRIVATE ON PURPOSE: this is MODEL I/O, never served to a client, so
 * putting it in `@devdigest/shared` would force a client mirror sync for a
 * shape the UI never sees. Same reasoning as `reviews/intent-schemas.ts`.
 *
 * ONE structured call carries why + risks + focus TOGETHER (D-3 / AC-14):
 * three sections from three calls could contradict each other and would cost
 * three times as much.
 *
 * `.describe()` carries every field's MEANING to the model — `toJsonSchema`
 * propagates it into the JSON Schema `description`, which is why these are
 * wordier than a normal Zod schema's: per `docs/agent-prompts/README.md` the
 * prompt file must not restate the output shape.
 *
 * Strict `json_schema` mode forbids `.optional()` and IGNORES `.max()` on
 * arrays and strings, so every field is required and every cap is enforced in
 * code (`clampBrief` below, AC-16).
 */

const BriefRiskSchema = z.object({
  kind: z
    .string()
    .describe(
      'A short lowercase category for this risk, e.g. "concurrency", "migration", "auth", "error_handling". Free text — a hint for the reader, nothing more.',
    ),
  title: z
    .string()
    .describe('The risk in one line, specific to this diff. Plain text: no Markdown, no HTML.'),
  explanation: z
    .string()
    .describe(
      'Two or three sentences: what could go wrong, under what conditions, and what a reviewer should check. Plain text.',
    ),
  severity: Severity.describe(
    'CRITICAL for a correctness, security or data-loss problem that must be resolved before merging; WARNING for a real problem that does not by itself block the merge; SUGGESTION for something worth raising that may reasonably be ignored.',
  ),
  file: z
    .string()
    .describe(
      'The path of ONE changed file you were shown, copied exactly. A file you were not shown may not be cited.',
    ),
  start_line: z
    .number()
    .int()
    .describe(
      'First line of the NEW side of the diff this risk is about. Must fall inside a hunk you were shown; a deleted line has no new-side number and cannot be cited.',
    ),
  end_line: z
    .number()
    .int()
    .describe('Last line of the new-side range. Equal to start_line for a single line.'),
});

const BriefFocusSchema = z.object({
  file: z
    .string()
    .describe('The path of ONE changed file you were shown, copied exactly.'),
  start_line: z
    .number()
    .int()
    .describe(
      'First new-side line to open at, or 0 when the whole file is the point. 0 means "no particular line".',
    ),
  end_line: z
    .number()
    .int()
    .describe('Last new-side line of the range, or 0 when start_line is 0.'),
  reason: z
    .string()
    .describe(
      'One line: what a reviewer should check here. Not that it changed — what to look for. Plain text.',
    ),
});

export const BriefExtractionSchema = z.object({
  why_summary: z
    .string()
    .describe(
      'One short paragraph: why this change exists, in the terms its author would use. The motivation, not a summary of the diff. If nothing states a motivation, say so plainly rather than inventing one.',
    ),
  why_sources: z
    .array(z.string())
    .describe(
      'The source labels you actually relied on, copied verbatim from the labels provided (e.g. "pr-title", "pr-body", "commits", "diff:src/api.ts"). Empty if you relied on nothing in particular.',
    ),
  risks: z
    .array(BriefRiskSchema)
    .describe(
      'At most 20 specific, checkable risks in the changed code, most important first. An empty list is a real answer when the diff genuinely carries no risk you can point at.',
    ),
  focus: z
    .array(BriefFocusSchema)
    .describe(
      'At most 5 entries, ordered so the first is where a reviewer should open the diff. The order is preserved exactly as given.',
    ),
});
export type BriefExtraction = z.infer<typeof BriefExtractionSchema>;
