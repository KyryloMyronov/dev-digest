import { and, eq } from 'drizzle-orm';
import type { RunTrace } from '@devdigest/shared';
import type { Db } from './client.js';
import * as t from './schema.js';

/**
 * One demo agent run and its trace, with a non-null project-context block
 * (SPEC-01 AC-56).
 *
 * WHY THIS FIXTURE EXISTS AT ALL: `seed.ts` never inserts into `agent_runs` or
 * `run_traces`. The sample review is written straight to `reviews` with `run_id`
 * unset, and `RunSummary` comes only from `agent_runs` — so on a fresh
 * `./scripts/dev.sh` the PR page's trace button never renders and the `?trace=`
 * parameter that mounts the drawer is never set. The whole run-trace half of
 * SPEC-01 is unreachable in a seeded stack without this.
 *
 * It is cheap and needs no LLM call: `run_traces.trace` is unvalidated `jsonb`
 * and `getRunTrace` type-asserts rather than parses, so a known
 * `prompt_assembly.specs` is just a string.
 *
 * THREE THINGS THAT MATTER AND ARE EASY TO MISS:
 *
 *  1. **The `agent_runs` row goes in FIRST** — `run_traces.run_id` is an FK to it.
 *  2. **The seeded review's `run_id` is set to this run.** The drawer resolves
 *     its findings and the agent's name with `runs.find(r => r.run_id ===
 *     traceRunId)` over *reviews*, so without the link it opens with zero
 *     findings and a null agent name.
 *  3. **Idempotency is by `(pr_id, agent_id, model)`**, with a marker model
 *     string. `pnpm db:seed` runs repeatedly on the same database and must not
 *     accumulate runs.
 *
 * Scope note: this seeds a run TRACE, not attachments. The demo repo has
 * `clone_path: null` (D-Q6g), so there is no document set to attach against and
 * a seeded `agent_context_docs` row would render as AC-29's unresolved row
 * everywhere — a misleading demo rather than a helpful one.
 */

/** Marker model, and the idempotency key's third component. */
const SEED_RUN_MODEL = 'seed-trace';

/**
 * The distinctive phrase inside the seeded project-context block.
 *
 * Exported because `e2e/specs/11-project-context.flow.json` waits on it after
 * opening the block — if this string changes, that flow's `wait --text` must
 * change with it.
 */
export const SEED_CONTEXT_PHRASE = 'Every public endpoint must document its rate limit';

const SEED_DOC_PATH = 'specs/public-api.md';

/** The fenced block, exactly as `reviewer-core` would have emitted it (AC-60). */
const SPECS_BLOCK = `<untrusted source="${SEED_DOC_PATH}">
# Public API

${SEED_CONTEXT_PHRASE}, and the limit belongs in the response headers.
Unauthenticated clients are limited per IP; authenticated clients per token.
</untrusted>`;

export async function seedProjectContext(
  db: Db,
  workspaceId: string,
  repoId: string,
): Promise<void> {
  const [pr] = await db
    .select()
    .from(t.pullRequests)
    .where(and(eq(t.pullRequests.repoId, repoId), eq(t.pullRequests.number, 482)));
  if (!pr) return; // No demo PR → nothing to hang a run off. Not an error.

  const [agent] = await db
    .select()
    .from(t.agents)
    .where(and(eq(t.agents.workspaceId, workspaceId), eq(t.agents.name, 'Security Reviewer')));
  if (!agent) return; // Agents are seeded before this; a missing one is skipped, not retried.

  // ---- the run (idempotent on pr + agent + the marker model) ----
  let [run] = await db
    .select()
    .from(t.agentRuns)
    .where(
      and(
        eq(t.agentRuns.prId, pr.id),
        eq(t.agentRuns.agentId, agent.id),
        eq(t.agentRuns.model, SEED_RUN_MODEL),
      ),
    );
  if (!run) {
    [run] = await db
      .insert(t.agentRuns)
      .values({
        workspaceId,
        agentId: agent.id,
        prId: pr.id,
        provider: agent.provider,
        model: SEED_RUN_MODEL,
        durationMs: 8200,
        tokensIn: 12_400,
        tokensOut: 1_480,
        costUsd: 0.0062,
        status: 'done',
        source: 'local',
        findingsCount: 2,
        grounding: '2/2 passed',
        score: 61,
        blockers: 1,
      })
      .returning();
  }
  const runId = run!.id;

  // ---- the trace document ----
  const trace: RunTrace = {
    config: {
      agent: agent.name,
      version: String(agent.version),
      provider: agent.provider,
      model: agent.model,
      pr: pr.number,
      source: 'local',
    },
    stats: {
      duration_ms: 8200,
      tokens_in: 12_400,
      tokens_out: 1_480,
      cost_usd: 0.0062,
      findings: 2,
      grounding: '2/2 passed',
    },
    prompt_assembly: {
      system: agent.systemPrompt,
      skills: null,
      memory: null,
      // AC-56 — non-null, and labelled with the document's path.
      specs: SPECS_BLOCK,
      callers: null,
      repo_map: null,
      pr_description: pr.body,
      intent: null,
      user: `## Project context\n${SPECS_BLOCK}\n\n## Diff to review\n<untrusted source="diff">\n(seeded)\n</untrusted>`,
    },
    tool_calls: [{ tool: 'review_file', args: 'src/config.ts', meta: 'single-pass', ms: 4100 }],
    raw_output: '{"verdict":"request_changes","score":61}',
    memory_pulled: [],
    specs_read: [SEED_DOC_PATH],
    // Nothing was dropped in this run — an empty array, not null: null would
    // claim the resolution never ran.
    specs_skipped: [],
    log: [
      { t: '00.10', kind: 'info', msg: `Starting review with agent "${agent.name}"` },
      { t: '00.35', kind: 'info', msg: `Project context attached (1): ${SEED_DOC_PATH}` },
      { t: '08.10', kind: 'result', msg: 'Citation grounding: 2/2 passed' },
    ],
  };

  await db
    .insert(t.runTraces)
    .values({ runId, trace })
    .onConflictDoUpdate({ target: t.runTraces.runId, set: { trace } });

  // ---- link the existing seeded review to this run (see note 2) ----
  await db
    .update(t.reviews)
    .set({ runId, agentId: agent.id })
    .where(and(eq(t.reviews.prId, pr.id), eq(t.reviews.model, 'seed')));
}
