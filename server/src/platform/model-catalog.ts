import type { ModelInfo } from '@devdigest/shared';

type Estimator = (model: string, tokensIn: number, tokensOut: number) => number | null;

const SIX_HOURS_MS = 6 * 60 * 60 * 1000;

/**
 * The cached OpenRouter model catalogue — what a model COSTS and what it CAN DO.
 *
 * OpenRouter's `/models` endpoint returns both facts in one payload, so one
 * cache (with one TTL and one stampede guard) serves both. Two callers:
 *
 *   - `estimate` — cost attribution, injected into the OpenRouter provider's
 *     per-call cost hook. SYNCHRONOUS by necessity: that hook cannot await. The
 *     first call after a cold start returns the fallback while a refresh runs in
 *     the background; later calls use the live prices.
 *   - `supportsStructuredOutputs` — the conventions scan's preflight. ASYNC, and
 *     free to await, because it runs once before any model call.
 *
 * For non-OpenRouter models (whose APIs don't expose prices) and a cold or
 * failed cache, `estimate` falls back to the static table.
 */
export class ModelCatalog {
  private prices = new Map<string, { in: number; out: number }>();
  /** Model id → OpenRouter `supported_parameters`. Absent = we were never told. */
  private capabilities = new Map<string, string[]>();
  private expires = 0;
  private refreshing = false;

  constructor(
    private listOpenRouterModels: () => Promise<ModelInfo[]>,
    private fallback: Estimator,
    private ttlMs = SIX_HOURS_MS,
    private now: () => number = () => Date.now(),
  ) {}

  /** Synchronous cost in USD: live OpenRouter price if cached, else the fallback table. */
  estimate(model: string, tokensIn: number, tokensOut: number): number | null {
    this.maybeRefresh();
    const p = this.prices.get(model);
    if (p) return (tokensIn * p.in + tokensOut * p.out) / 1_000_000;
    return this.fallback(model, tokensIn, tokensOut);
  }

  /**
   * Can this model be driven with a strict JSON-schema `response_format`?
   *
   * `true`/`false` when the catalogue knows; **`null` when it does not** — a cold
   * or failed fetch, no `OPENROUTER_API_KEY`, or a model absent from the list.
   * Callers MUST treat `null` as "go ahead and try": an unreachable catalogue is
   * our ignorance, not the model's limitation, and must never block a scan.
   *
   * Only meaningful for OpenRouter. OpenAI and Anthropic do not publish an
   * equivalent list, so their models are always `null` here.
   */
  async supportsStructuredOutputs(model: string): Promise<boolean | null> {
    if (this.capabilities.size === 0 || this.now() >= this.expires) {
      await this.refresh();
    }
    const params = this.capabilities.get(model);
    if (!params) return null;
    return params.includes('structured_outputs');
  }

  /** Force a synchronous-await refresh (e.g. to warm the cache). Never throws. */
  async refresh(): Promise<void> {
    try {
      this.ingest(await this.listOpenRouterModels());
      this.expires = this.now() + this.ttlMs;
    } catch {
      this.expires = 0;
    }
  }

  private ingest(models: ModelInfo[]): void {
    for (const m of models) {
      if (m.pricing) {
        this.prices.set(m.id, { in: m.pricing.promptPerM, out: m.pricing.completionPerM });
      }
      // Deliberately NOT nested under the pricing guard: a model can be listed
      // with capabilities and no usable price (and vice versa), and conflating
      // the two would make every unpriced model look incapable.
      if (m.supportedParameters) {
        this.capabilities.set(m.id, m.supportedParameters);
      }
    }
  }

  private maybeRefresh(): void {
    if (this.refreshing) return;
    if (this.now() < this.expires && this.prices.size > 0) return;
    this.refreshing = true;
    this.expires = this.now() + this.ttlMs; // set early so concurrent calls don't stampede
    this.listOpenRouterModels()
      .then((models) => this.ingest(models))
      .catch(() => {
        this.expires = 0; // allow a retry on the next call
      })
      .finally(() => {
        this.refreshing = false;
      });
  }
}
