/**
 * OpenRouterProvider — the wire request of completeStructured.
 *
 * Pins the max_tokens default: a request without an explicit cap must still
 * send one. Without it, OpenRouter reserves the model's full output window
 * (e.g. 65 536 tokens) against the account balance in its pre-flight credit
 * check, and a small balance fails every review with
 * 402 "requires more credits, or fewer max_tokens".
 */
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { OpenRouterProvider } from '../src/llm/openrouter.js';

const SCHEMA = z.object({ ok: z.boolean() });

/** Stub the OpenAI client with one that records the create() body. */
function providerWithCapture() {
  const provider = new OpenRouterProvider('test-key');
  const bodies: Array<Record<string, unknown>> = [];
  const stub = {
    chat: {
      completions: {
        create: async (body: Record<string, unknown>) => {
          bodies.push(body);
          return {
            choices: [{ message: { content: '{"ok":true}' } }],
            usage: { prompt_tokens: 1, completion_tokens: 1 },
          };
        },
      },
    },
  };
  (provider as unknown as { client: typeof stub }).client = stub;
  return { provider, bodies };
}

const REQUEST = {
  model: 'test/model',
  schema: SCHEMA,
  schemaName: 'Ok',
  messages: [{ role: 'user' as const, content: 'hi' }],
};

describe('OpenRouterProvider.completeStructured — max_tokens', () => {
  it('sends the default cap when the request sets none', async () => {
    const { provider, bodies } = providerWithCapture();
    await provider.completeStructured(REQUEST);
    expect(bodies[0]!.max_tokens).toBe(8_192);
  });

  it('lets an explicit request cap win over the default', async () => {
    const { provider, bodies } = providerWithCapture();
    await provider.completeStructured({ ...REQUEST, maxTokens: 2_048 });
    expect(bodies[0]!.max_tokens).toBe(2_048);
  });
});
