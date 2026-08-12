import { describe, it, expect } from 'vitest';
import type { ModelInfo } from '@devdigest/shared';
import { ModelCatalog } from '../src/platform/model-catalog.js';

const MODELS: ModelInfo[] = [
  {
    id: 'deepseek/deepseek-v4-flash',
    provider: 'openrouter',
    pricing: { promptPerM: 0.14, completionPerM: 0.28 },
    contextLength: 1_000_000,
    supportedParameters: ['response_format', 'structured_outputs', 'tools'],
  },
];

describe('ModelCatalog — pricing (cost attribution)', () => {
  it('uses the fallback until the cache is warm, then live OpenRouter prices', async () => {
    const t = 0;
    // Fallback only knows the static deepseek price; live price will differ.
    const fallback = (m: string) => (m === 'deepseek/deepseek-v4-flash' ? 0.999 : null);
    const pb = new ModelCatalog(async () => MODELS, fallback, 1000, () => t);

    // Cold cache → fallback value.
    expect(pb.estimate('deepseek/deepseek-v4-flash', 1_000_000, 1_000_000)).toBe(0.999);

    await pb.refresh();
    // Warm: 1e6 * 0.14 (in) + 1e6 * 0.28 (out) = 0.42.
    expect(pb.estimate('deepseek/deepseek-v4-flash', 1_000_000, 1_000_000)).toBeCloseTo(0.42, 9);
  });

  it('falls back for models the OpenRouter list does not price, and returns null when neither knows it', async () => {
    const pb = new ModelCatalog(async () => MODELS, (m) => (m === 'gpt-4.1' ? 12.34 : null));
    await pb.refresh();
    expect(pb.estimate('gpt-4.1', 0, 0)).toBe(12.34); // not an OR model → static fallback
    expect(pb.estimate('mystery/model', 0, 0)).toBe(null); // unknown everywhere
  });

  it('never throws when the model list fetch fails (stays on the fallback)', async () => {
    const pb = new ModelCatalog(
      async () => {
        throw new Error('network down');
      },
      (m) => (m === 'deepseek/deepseek-v4-flash' ? 0.5 : null),
    );
    await pb.refresh(); // swallows the error
    expect(pb.estimate('deepseek/deepseek-v4-flash', 0, 0)).toBe(0.5);
  });
});

/**
 * The capability half. `null` is the load-bearing value here: it means "the
 * catalogue does not know", and the conventions preflight is required to let a
 * scan proceed on it. A bug that turns an unknown into `false` would block every
 * scan the moment OpenRouter is unreachable.
 */
describe('ModelCatalog — structured-output capability', () => {
  const free = (id: string, params: string[] | null): ModelInfo => ({
    id,
    provider: 'openrouter',
    // Free models: no usable price. Capabilities must survive that.
    pricing: null,
    contextLength: 262_144,
    supportedParameters: params,
  });

  it('reports true / false from supported_parameters, for models with no price', async () => {
    const cat = new ModelCatalog(
      async () => [
        free('google/gemma-4-26b-a4b-it:free', ['response_format', 'structured_outputs']),
        free('google/gemma-4-31b-it:free', ['response_format', 'tools']),
      ],
      () => null,
    );

    expect(await cat.supportsStructuredOutputs('google/gemma-4-26b-a4b-it:free')).toBe(true);
    // The real case this guard exists for: advertises response_format, but NOT
    // strict json_schema — which is what the conventions scan actually needs.
    expect(await cat.supportsStructuredOutputs('google/gemma-4-31b-it:free')).toBe(false);
  });

  it('returns null — not false — for a model the catalogue has never heard of', async () => {
    const cat = new ModelCatalog(async () => MODELS, () => null);
    expect(await cat.supportsStructuredOutputs('mystery/model')).toBe(null);
  });

  it('returns null when the list has no capability data for the model', async () => {
    const cat = new ModelCatalog(async () => [free('some/model', null)], () => null);
    expect(await cat.supportsStructuredOutputs('some/model')).toBe(null);
  });

  it('returns null when the fetch fails, so an unreachable catalogue never blocks a caller', async () => {
    const cat = new ModelCatalog(async () => {
      throw new Error('network down');
    }, () => null);
    expect(await cat.supportsStructuredOutputs('google/gemma-4-26b-a4b-it:free')).toBe(null);
  });

  it('warms the cache on demand — no explicit refresh() needed', async () => {
    let fetches = 0;
    const cat = new ModelCatalog(
      async () => {
        fetches++;
        return MODELS;
      },
      () => null,
      1000,
      () => 0,
    );

    expect(await cat.supportsStructuredOutputs('deepseek/deepseek-v4-flash')).toBe(true);
    expect(fetches).toBe(1);
    // Second lookup is served from the warm cache within the TTL.
    expect(await cat.supportsStructuredOutputs('deepseek/deepseek-v4-flash')).toBe(true);
    expect(fetches).toBe(1);
  });
});
