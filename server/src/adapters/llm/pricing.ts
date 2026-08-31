/**
 * cost discipline — per-provider/model pricing table (USD per 1M tokens).
 * Unknown models return null cost (explicitly flagged), per spec.
 */
interface Price {
  in: number;
  out: number;
}

const PRICING: Record<string, Price> = {
  // OpenAI (approximate public list prices, USD / 1M tokens)
  'gpt-5.5': { in: 5.0, out: 30.0 },
  'gpt-5.4': { in: 2.5, out: 15.0 },
  'gpt-5.4-mini': { in: 0.75, out: 4.5 },
  'gpt-5.4-nano': { in: 0.2, out: 1.25 },
  'gpt-5.1': { in: 1.25, out: 10.0 },
  'gpt-5': { in: 1.25, out: 10.0 },
  'gpt-4.1': { in: 2.0, out: 8.0 },
  'gpt-4.1-mini': { in: 0.4, out: 1.6 },
  'gpt-4o': { in: 2.5, out: 10.0 },
  'gpt-4o-mini': { in: 0.15, out: 0.6 },
  'text-embedding-3-small': { in: 0.02, out: 0 },
  // Anthropic
  'claude-3-5-sonnet-latest': { in: 3.0, out: 15.0 },
  'claude-3-5-haiku-latest': { in: 0.8, out: 4.0 },
  'claude-3-opus-latest': { in: 15.0, out: 75.0 },
  // OpenRouter (CI runner, cheap models). Slugs + prices are APPROXIMATE and
  // must be confirmed against openrouter.ai/models before relying on cost.
  // Unknown slugs fall through to null cost (explicitly flagged), which is safe.
  'z-ai/glm-4.7-flash': { in: 0, out: 0 }, // free baseline for evals
  // Confirmed against openrouter.ai/api/v1/models on 2026-08-28 (SPEC-03):
  // prompt 0.000000088606 / completion 0.000000177212 per token. The 2026-08-17
  // figures this entry used to carry (0.077 / 0.154) were 15.1% LOW.
  //
  // BLAST RADIUS, stated because it is wider than the feature that changed it:
  // `review_intent`, `onboarding` and `file_summary` all default to this same
  // slug (`contracts/platform.ts`), so their persisted `cost_usd` moves too —
  // in the MORE ACCURATE direction. Author-accepted (SPEC-03 plan D-5).
  //
  // Do NOT substitute a neighbouring slug: `~-latest` is 0.03/0.10, `-0731` is
  // 0.07/0.14, `-vision-exp` is 0.22/0.66. The repo keys on the bare slug and
  // that is correct — the floating alias is what the feature models resolve.
  'deepseek/deepseek-v4-flash': { in: 0.088606, out: 0.177212 },
  'z-ai/glm-4.7-flashx': { in: 0.15, out: 0.4 },
  'minimax/minimax-m2.5': { in: 0.3, out: 1.2 },
  'z-ai/glm-5.1': { in: 0.6, out: 2.2 },
};

export function estimateCost(model: string, tokensIn: number, tokensOut: number): number | null {
  const p = PRICING[model];
  if (!p) return null;
  return (tokensIn * p.in + tokensOut * p.out) / 1_000_000;
}
