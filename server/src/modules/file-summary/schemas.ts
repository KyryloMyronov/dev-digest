import { z } from 'zod';

/**
 * SPEC-03 — the file-summary extractor's structured output.
 *
 * MODULE-PRIVATE ON PURPOSE: this is MODEL I/O, never served to a client, so
 * putting it in `@devdigest/shared` would force a client mirror sync for a shape
 * the UI never sees. Same reasoning as `reviews/intent-schemas.ts` and
 * `modules/brief/schemas.ts`.
 *
 * THE ROOT IS AN OBJECT, NOT A BARE ARRAY — `{ summaries: [{path, summary}] }`.
 * Strict `json_schema` requires an object root. SPEC-03's *Model & prompt*
 * section says "an array of `{path, summary}`"; this is the one place the plan
 * reads the spec differently, and the plan wins (it is a provider constraint,
 * not a design choice).
 *
 * `.describe()` carries every field's MEANING to the model — `toJsonSchema`
 * propagates it into the JSON Schema `description`, which is why these are
 * wordier than a normal Zod schema's: per `docs/agent-prompts/README.md` the
 * prompt file must not restate the output shape.
 *
 * Strict `json_schema` mode forbids `.optional()` and IGNORES `.max()` on arrays
 * and strings, so every field is required and the length cap is enforced in code
 * (`clampSummary` in `helpers.ts`, called from `pipeline.ts`, AC-28 / AC-74).
 */
export const FileSummaryExtractionSchema = z.object({
  summaries: z
    .array(
      z.object({
        path: z
          .string()
          .describe(
            'The path of ONE file you were given, copied EXACTLY as it appeared in that block\'s source label. A path you were not given is discarded.',
          ),
        summary: z
          .string()
          .describe(
            'One sentence, under 240 characters, plain text: what the change in that file DOES, naming the concrete identifiers visible in its patch. Not what the file is for.',
          ),
      }),
    )
    .describe(
      'Exactly one entry per file you were given, in any order. Do not add entries for files you were not shown.',
    ),
});
export type FileSummaryExtraction = z.infer<typeof FileSummaryExtractionSchema>;
