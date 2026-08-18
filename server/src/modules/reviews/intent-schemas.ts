import { z } from 'zod';
import { IntentChangeType } from '@devdigest/shared';

/**
 * The intent classifier's structured output. Module-private on purpose: this is
 * MODEL I/O, never served to a client, so putting it in `@devdigest/shared`
 * would force a client mirror sync for text the UI never sees. Same reasoning as
 * `modules/conventions/schemas.ts`.
 *
 * `.describe()` carries every field's MEANING to the model — `toJsonSchema`
 * propagates it into the JSON Schema `description`, which is why these are
 * wordier than a normal Zod schema's: per `docs/agent-prompts/README.md` the
 * prompt file must not restate the output shape.
 *
 * Strict `json_schema` mode forbids `.optional()` and ignores `.max()` on arrays
 * and strings, so every field is required and the caps are enforced in code
 * (see `clampIntent` in `intent-sources.ts`).
 */
export const IntentExtractionSchema = z.object({
  intent: z
    .string()
    .describe(
      'Why this pull request exists, in one to three sentences: the problem it addresses or the capability it adds, in the terms the author would use. Describe the motivation, not a summary of the diff.',
    ),
  // The vocabulary is the SHARED enum, never a second literal list. The read
  // path is `IntentChangeType.safeParse(row.changeType).data ?? null`
  // (`repository/pull.repo.ts`), so a value this schema allowed and the shared
  // enum did not would be coerced to null on read — silently, with no throw and
  // no log, and the UI badge would just stop rendering. Only the SCHEMA stays
  // module-private (it is model I/O); the vocabulary is a wire type.
  change_type: IntentChangeType
    .describe(
      'The single best-fitting category for the change as a whole. Use "other" when the evidence genuinely does not settle it rather than guessing at a specific one.',
    ),
  in_scope: z
    .array(z.string())
    .describe(
      'What the author says this change covers, one short item each. These are the AUTHOR’S claims, not verified facts. May be empty.',
    ),
  out_of_scope: z
    .array(z.string())
    .describe(
      'What the author explicitly says is NOT part of this change (deferred, follow-up, intentionally unchanged). Only what is actually stated — never inferred from absence. May be empty.',
    ),
  confidence: z
    .number()
    .min(0)
    .max(1)
    .describe(
      'How well the evidence provided supports this reading, from 0 to 1. A written description, a linked ticket or a linked plan can support a high number. A title, a branch name and a file list alone cannot: cap that at 0.4.',
    ),
  evidence: z
    .array(z.string())
    .describe(
      'The source labels of the blocks this reading actually rests on, copied verbatim from the labels provided (e.g. "pr-body", "ticket", "spec:docs/plan.md"). Empty if you relied on nothing in particular.',
    ),
});
export type IntentExtraction = z.infer<typeof IntentExtractionSchema>;
