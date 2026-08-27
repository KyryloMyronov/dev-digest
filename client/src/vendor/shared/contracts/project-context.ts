import { z } from 'zod';

/**
 * Project Context contracts (SPEC-01).
 *
 *   GET /repos/:id/context            → ContextDocList
 *   GET /repos/:id/context/doc?path=… → ContextDocContent
 *   GET/POST/PUT/DELETE /agents/:id/context-docs → AgentContextDoc[]
 *   GET/POST/DELETE     /skills/:id/context-docs → SkillContextDoc[]
 *
 * These are a NEW family, not an extension of `SpecFile`
 * (`contracts/platform.ts`). `SpecFile` describes one editable spec file and
 * cannot carry a list envelope; it is deliberately left untouched for a future
 * file browser (D-Q1). Nothing consumed these types before, so the family is
 * compatible by construction.
 *
 * The names avoid anything `ContextStatus`-shaped on purpose: `IndexStatus`
 * already exists twice in this tree (`contracts/platform.ts`, and repo-intel's
 * own `types.ts`), and a third same-shaped name is how those two got confused.
 */

// ---- Which configured root a document was found under ----
/**
 * The three configured directory roots, matched at ANY depth of the
 * clone-relative path. The tag is the LEFTMOST matching segment, so
 * `docs/specs/x.md` is `docs` (AC-2 / D-Q6a).
 */
export const ContextDocSource = z.enum(['specs', 'docs', 'insights']);
export type ContextDocSource = z.infer<typeof ContextDocSource>;

// ---- One discovered Markdown document ----
export const ContextDoc = z.object({
  /** Repository-relative path, forward slashes. The join key everywhere. */
  path: z.string(),
  source: ContextDocSource,
  /**
   * Persisted token count, or `null` when the token-count job has not counted
   * this document yet (AC-30, AC-34).
   *
   * `.nullable()`, NOT `.nullish()` — required-but-nullable. `null` is a
   * meaningful value the studio branches on to render a pending indicator
   * (AC-35), so an *absent* key would let a serialization bug masquerade as
   * "pending". The root `insights.md` rule that a new field must be
   * `.nullish()` is specifically about `PrMeta`'s triple duty (list payload +
   * adapter return type + `PrDetail` base); this is a new single-purpose DTO
   * served by exactly one route, so that rule does not apply here.
   */
  tokens: z.number().int().nullable(),
  /** How many agents in this workspace currently attach this path (AC-15). */
  attached_agents: z.number().int(),
  /** Size on disk in bytes; null when the file could not be stat'd. */
  size: z.number().int().nullable(),
});
export type ContextDoc = z.infer<typeof ContextDoc>;

// ---- The list envelope ----
export const ContextDocList = z.object({
  /** At most MAX_CONTEXT_DOCUMENTS items, in path order. */
  files: z.array(ContextDoc),
  /** Documents discovered BEFORE the cap was applied (AC-6). */
  total: z.number().int(),
  /** `total - files.length` — what the cap cut, reported rather than swallowed. */
  omitted: z.number().int(),
  /**
   * When the token scan last ran for this repository (AC-16), or null when it
   * never has. The document *list* is a live walk; this timestamp is the
   * persisted token scan, which is the only "scan" with a recorded time.
   */
  scanned_at: z.string().nullable(),
});
export type ContextDocList = z.infer<typeof ContextDocList>;

// ---- One document's text ----
export const ContextDocContent = z.object({
  path: z.string(),
  content: z.string(),
  size: z.number().int(),
});
export type ContextDocContent = z.infer<typeof ContextDocContent>;

// ---- Attachment links (SPEC-01, Cut 2) ----
/**
 * One document attached to an agent (`agent_context_docs`).
 *
 * `doc` inlines the discovered document, modelled on `AgentSkillDetail`
 * (`contracts/knowledge.ts`): the Context tab renders a whole agent's ordered
 * list from one response, so inlining saves an N+1.
 *
 * `doc` is `.nullish()` ON PURPOSE — an attachment can outlive the file it
 * names, because `path` is a join key and not a foreign key. That unresolved
 * row is AC-29: it must be visible and removable, never silently omitted.
 */
export const AgentContextDoc = z.object({
  agent_id: z.string(),
  path: z.string(),
  /** Prompt order (AC-21). There is no second sort key. */
  order: z.number().int(),
  doc: ContextDoc.nullish(),
  /**
   * The name of the skill this attachment was inherited from, or null/absent
   * when the agent attached it directly (AC-23). Inheritance is read through
   * `container.agentsRepo.linkedSkills`, so both `enabled` switches gate it.
   */
  inherited_from: z.string().nullish(),
});
export type AgentContextDoc = z.infer<typeof AgentContextDoc>;

/** One document attached to a skill (`skill_context_docs`). Same shape, no
    inheritance — a skill is where inheritance starts. */
export const SkillContextDoc = z.object({
  skill_id: z.string(),
  path: z.string(),
  order: z.number().int(),
  doc: ContextDoc.nullish(),
});
export type SkillContextDoc = z.infer<typeof SkillContextDoc>;

/**
 * Attach one document. A document path contains `/`, so it cannot ride in a
 * single path parameter — it travels in the body.
 *
 * `repo_id` is REQUIRED, and that is a security requirement rather than a
 * convenience: before persisting an attachment the API validates the submitted
 * path against that repository's discovered document set, and it cannot do so
 * without knowing which repository to ask. The run-start resolver reads
 * persisted paths directly, so this door is where an unknown path is stopped.
 */
export const ContextDocAttach = z.object({
  repo_id: z.string().uuid(),
  path: z.string().min(1),
});
export type ContextDocAttach = z.infer<typeof ContextDocAttach>;

/**
 * The reorder body: the FULL ordered list, as `useSetAgentSkills` sends it
 * (AC-19). Order is the array index, so the client never computes an `order`
 * integer. `repo_id` carries the same validation duty as above; a path that is
 * neither discovered nor already attached is rejected, so the reorder endpoint
 * is not a back door around the attach check.
 */
export const ContextDocOrder = z.object({
  repo_id: z.string().uuid(),
  paths: z.array(z.string()),
});
export type ContextDocOrder = z.infer<typeof ContextDocOrder>;
