import 'dotenv/config';
import { z } from 'zod';
import { homedir } from 'node:os';
import { join, isAbsolute, resolve } from 'node:path';

/**
 * Central, zod-validated environment config. Loaded once at startup.
 *
 * NOTE: secret keys (OPENAI/ANTHROPIC/OPENROUTER/GITHUB_TOKEN) are deliberately
 * NOT in this schema. Feature code must access secrets through SecretsProvider,
 * never via process.env or AppConfig — the SecretsProvider is the one chokepoint
 * that reads process.env directly (see adapters/secrets/local.ts). Listing them
 * here would be dead config that never reaches AppConfig.
 */
const EnvSchema = z.object({
  DATABASE_URL: z
    .string()
    .default('postgres://devdigest:devdigest@localhost:5432/devdigest'),
  // Memory/RAG embeddings run on OpenAI (text-embedding-3-small, 1536-dim — the
  // pgvector columns are locked to that). Default OFF so the app makes ZERO
  // OpenAI requests; set EMBEDDINGS_ENABLED=true to turn memory retrieval on.
  EMBEDDINGS_ENABLED: z.string().optional(),
  // repo-intel facade (Tier 1). Default ON — reviews get repo skeleton +
  // callers context. Set REPO_INTEL_ENABLED=false to opt out, in which case
  // every consumer degrades to ripgrep-identical behavior (acceptance #10).
  // Note: even when on, sections only populate once the repo is indexed; an
  // unindexed repo degrades gracefully. Per-agent override: agents.repo_intel.
  REPO_INTEL_ENABLED: z.string().optional(),
  // Per-section prompt logging (name / source / size, NEVER content). The
  // summary line is always emitted; this adds the per-section breakdown and
  // token counts. LOCAL ONLY — `loadConfig` refuses to honour it under
  // NODE_ENV=production, because prompt shape is operational detail that has no
  // business in a production log stream.
  PROMPT_LOG_VERBOSE: z.string().optional(),
  // Completion cap (`max_tokens`) for LLM calls that don't set their own.
  // Without an explicit cap OpenRouter reserves the model's FULL output window
  // against the account balance and 402s low-credit accounts pre-flight.
  // Lower this if runs still fail with "requires more credits, or fewer
  // max_tokens"; raise it if reviews come back truncated.
  LLM_MAX_OUTPUT_TOKENS: z.coerce.number().int().positive().default(8192),
  // SPEC-04 NFR-2 — the absolute dollar ceiling on ONE eval batch. Checked
  // before each case against the running mean of that batch's completed, priced
  // cases (AC-41); an unpriced model reports null cost, so the ceiling simply
  // never binds there and EVAL_BATCH_MAX_MS is the only limit that does.
  EVAL_BATCH_MAX_USD: z.coerce.number().positive().default(0.5),
  // SPEC-04 NFR-6 / AC-110 — the wall clock on ONE eval batch. This is
  // CONFIGURABLE rather than a literal for a specific reason: it is what makes
  // AC-110 testable in seconds instead of fifteen minutes. Build the app with
  // EVAL_BATCH_MAX_MS=2000 and a slow stub provider, and the partial-batch path
  // is a two-second test. Inline the 900_000 and that criterion becomes
  // unprovable. Default 15 minutes.
  EVAL_BATCH_MAX_MS: z.coerce.number().int().positive().default(900_000),
  API_PORT: z.coerce.number().int().default(3001),
  WEB_PORT: z.coerce.number().int().default(3000),
  DEVDIGEST_CLONE_DIR: z.string().optional(),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  // `.env` (and .env.example) ship `LOG_LEVEL=` empty; an empty string is not a
  // valid enum member, so coerce '' → undefined to fall through to the default.
  LOG_LEVEL: z.preprocess(
    (v) => (v === '' ? undefined : v),
    z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).optional(),
  ),
});

export type AppConfig = {
  databaseUrl: string;
  apiPort: number;
  webPort: number;
  /** Absolute path where repos are cloned (~/.devdigest/workspace by default). */
  cloneDir: string;
  /** Absolute path to the writable secrets store (BYO keys from the UI). */
  secretsPath: string;
  /** Default `max_tokens` for LLM calls that don't set their own. */
  llmMaxOutputTokens: number;
  /** SPEC-04 AC-41 / NFR-2 — dollar ceiling for one eval batch. */
  evalBatchMaxUsd: number;
  /**
   * SPEC-04 AC-110 / NFR-6 — wall-clock ceiling for one eval batch, in ms.
   * Configurable so the partial-batch path is testable in seconds.
   */
  evalBatchMaxMs: number;
  nodeEnv: 'development' | 'test' | 'production';
  logLevel: string;
  /** Allowed CORS origin for the Next.js dev server. */
  webOrigin: string;
  /** Whether memory/RAG embeddings (OpenAI) are enabled. Default false. */
  embeddingsEnabled: boolean;
  /**
   * Whether the repo-intel facade (Tier 1: phantom-gate, callers-in-prompt) is
   * active. Default ON — set REPO_INTEL_ENABLED=false to opt out, in which case
   * every facade method returns its degraded result (`[]`) so consumers behave
   * EXACTLY like the ripgrep-only baseline.
   */
  repoIntelEnabled: boolean;
  /**
   * Per-section prompt logging. EFFECTIVE value: true only when the flag is set
   * AND this is not production. Never logs prompt content either way — see
   * `platform/prompt-log.ts`.
   */
  promptLogVerbose: boolean;
  /**
   * True when the flag was asked for but refused because this is production.
   * Surfaced as a warning at boot: a flag that silently does nothing is the
   * failure mode that costs an hour of "why is there no output".
   */
  promptLogVerboseSuppressed: boolean;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = EnvSchema.parse(env);
  const cloneDirRaw =
    parsed.DEVDIGEST_CLONE_DIR ?? join(homedir(), '.devdigest', 'workspace');
  const cloneDir = isAbsolute(cloneDirRaw) ? cloneDirRaw : resolve(process.cwd(), cloneDirRaw);
  return {
    databaseUrl: parsed.DATABASE_URL,
    apiPort: parsed.API_PORT,
    webPort: parsed.WEB_PORT,
    cloneDir,
    secretsPath: join(homedir(), '.devdigest', 'secrets.json'),
    llmMaxOutputTokens: parsed.LLM_MAX_OUTPUT_TOKENS,
    evalBatchMaxUsd: parsed.EVAL_BATCH_MAX_USD,
    evalBatchMaxMs: parsed.EVAL_BATCH_MAX_MS,
    nodeEnv: parsed.NODE_ENV,
    logLevel: parsed.LOG_LEVEL ?? (parsed.NODE_ENV === 'test' ? 'silent' : 'info'),
    webOrigin: `http://localhost:${parsed.WEB_PORT}`,
    embeddingsEnabled: parsed.EMBEDDINGS_ENABLED === 'true',
    repoIntelEnabled: parsed.REPO_INTEL_ENABLED !== 'false',
    promptLogVerbose:
      parsed.PROMPT_LOG_VERBOSE === 'true' && parsed.NODE_ENV !== 'production',
    promptLogVerboseSuppressed:
      parsed.PROMPT_LOG_VERBOSE === 'true' && parsed.NODE_ENV === 'production',
  };
}
