import { z } from 'zod';

/**
 * The two structured-output schemas of the conventions scan. Module-private on
 * purpose: these are MODEL I/O, never served to a client, so putting them in
 * `@devdigest/shared` would force a client mirror sync for text the UI never sees.
 *
 * `.describe()` carries every field's MEANING to the model — `toJsonSchema`
 * propagates it into the JSON Schema `description`. Per
 * `docs/agent-prompts/README.md` the prompt files must not restate the shape;
 * that is why these descriptions are wordier than a normal Zod schema's.
 *
 * Strict `json_schema` mode forbids `.optional()` and ignores `.max()` on arrays,
 * so every field is required and the caps are enforced in code.
 */

export const ConventionFileSelectionSchema = z.object({
  files: z
    .array(
      z.object({
        path: z
          .string()
          .describe('Repo-relative path, copied verbatim from the provided list.'),
        reason: z
          .string()
          .describe(
            'One short line on what this file is expected to demonstrate. Shown to a human reading the scan; not stored as a convention.',
          ),
      }),
    )
    .describe(
      'The files to read, most informative first. Only paths from the provided list; anything else is dropped.',
    ),
});
export type ConventionFileSelection = z.infer<typeof ConventionFileSelectionSchema>;

export const ConventionExtractionSchema = z.object({
  conventions: z
    .array(
      z.object({
        rule: z
          .string()
          .describe(
            'The convention as a directive a reviewer can check a diff against, in one or two sentences.',
          ),
        evidence_path: z
          .string()
          .describe(
            'The one provided file that best demonstrates the rule, path copied verbatim.',
          ),
        evidence_snippet: z
          .string()
          .describe(
            'A short excerpt copied exactly from that file, showing the rule being followed.',
          ),
        confidence: z
          .number()
          .min(0)
          .max(1)
          .describe('How strongly the sample supports the rule, from 0 to 1.'),
      }),
    )
    .describe('The conventions this codebase follows. May be empty.'),
});
export type ConventionExtraction = z.infer<typeof ConventionExtractionSchema>;
