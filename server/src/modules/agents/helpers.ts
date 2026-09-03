import type { Agent, AgentVersion, CiFailOn, Provider, ReviewStrategy } from '@devdigest/shared';
import { AgentVersionConfig } from '@devdigest/shared';
import type { AgentRow, AgentVersionRow } from './repository.js';
import type { EvalTriggerField } from '../eval/types.js';

/**
 * Pure helpers for the agents module — DB row ⇄ DTO mapping and the
 * config-version-bump rule. No I/O; behaviour-identical to the previous inline
 * implementations.
 */

/** Map a persisted agent row to the public `Agent` DTO. */
export function toAgentDto(row: AgentRow): Agent {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    provider: row.provider as Provider,
    model: row.model,
    system_prompt: row.systemPrompt,
    output_schema: row.outputSchema ?? null,
    enabled: row.enabled,
    version: row.version,
    strategy: row.strategy as ReviewStrategy,
    ci_fail_on: row.ciFailOn as CiFailOn,
    repo_intel: row.repoIntel,
    auto_eval: row.autoEval,
  };
}

/**
 * Map a persisted `agent_versions` row to the public `AgentVersion` DTO. The
 * stored `config_json` is untyped jsonb (a snapshot from an older config shape
 * could drift), so it is parsed through `AgentVersionConfig` — a malformed
 * snapshot throws here rather than leaking an unvalidated blob to the client.
 */
export function toAgentVersionDto(row: AgentVersionRow): AgentVersion {
  return {
    agent_id: row.agentId,
    version: row.version,
    config: AgentVersionConfig.parse(row.configJson),
    created_at: row.createdAt.toISOString(),
  };
}

/** Fields whose change bumps the agent's config version (anything but `enabled`). */
export interface ConfigChangePatch {
  name?: string;
  description?: string;
  provider?: Provider;
  model?: string;
  systemPrompt?: string;
  outputSchema?: unknown;
  strategy?: ReviewStrategy;
  ciFailOn?: CiFailOn;
  repoIntel?: boolean;
}

/**
 * True when a patch changes config (vs. just toggling `enabled`) relative to the
 * existing row — a config change bumps the version and snapshots agent_versions.
 */
export function isConfigChange(
  existing: Pick<
    AgentRow,
    | 'name'
    | 'description'
    | 'provider'
    | 'model'
    | 'systemPrompt'
    | 'strategy'
    | 'ciFailOn'
    | 'repoIntel'
  >,
  patch: ConfigChangePatch,
): boolean {
  return (
    (patch.name !== undefined && patch.name !== existing.name) ||
    (patch.description !== undefined && patch.description !== existing.description) ||
    (patch.provider !== undefined && patch.provider !== existing.provider) ||
    (patch.model !== undefined && patch.model !== existing.model) ||
    (patch.systemPrompt !== undefined && patch.systemPrompt !== existing.systemPrompt) ||
    (patch.strategy !== undefined && patch.strategy !== existing.strategy) ||
    (patch.ciFailOn !== undefined && patch.ciFailOn !== existing.ciFailOn) ||
    (patch.repoIntel !== undefined && patch.repoIntel !== existing.repoIntel) ||
    patch.outputSchema !== undefined
  );
}


/**
 * SPEC-04 AC-85 — which ALLOW-LISTED config fields a patch actually changed.
 *
 * The list is exhaustive and is the whole rule (plan D-13): a bump that touched
 * only `ci_fail_on`, `repo_intel`, `name` or `description` still bumps the
 * version and is still snapshotted (AC-84) — it just returns `[]` here and
 * therefore enqueues nothing. `auto_eval` is absent on purpose too: it is an
 * operational switch, and including it would make turning auto-eval ON its own
 * first trigger.
 *
 * Pure, and deliberately separate from `isConfigChange`, which answers a
 * different question (did the version bump at all).
 */
export function changedTriggerFields(
  existing: Pick<AgentRow, 'provider' | 'model' | 'systemPrompt' | 'strategy' | 'outputSchema'>,
  patch: ConfigChangePatch,
): EvalTriggerField[] {
  const changed: EvalTriggerField[] = [];
  if (patch.systemPrompt !== undefined && patch.systemPrompt !== existing.systemPrompt)
    changed.push('system_prompt');
  if (patch.model !== undefined && patch.model !== existing.model) changed.push('model');
  if (patch.provider !== undefined && patch.provider !== existing.provider)
    changed.push('provider');
  if (patch.strategy !== undefined && patch.strategy !== existing.strategy)
    changed.push('strategy');
  if (
    patch.outputSchema !== undefined &&
    JSON.stringify(patch.outputSchema ?? null) !== JSON.stringify(existing.outputSchema ?? null)
  )
    changed.push('output_schema');
  return changed;
}
