import { MockLLMProvider } from '../../src/adapters/mocks.js';
import { FILE_SUMMARY_SCHEMA_NAME } from '../../src/modules/file-summary/constants.js';

/**
 * SPEC-03 — the file-summary extractor's stand-in for integration tests.
 *
 * MANDATORY in any test that triggers a file-summary derivation. `file_summary`
 * resolves to **openrouter** by default — the SAME provider `review_intent`
 * uses — and `reviews.it.test.ts` / `intent.it.test.ts` already stub `openrouter`
 * with the INTENT fixture. A file-summary derivation reaching one of those
 * harnesses would therefore be handed an *intent* fixture and fail against a
 * schema it was never meant to satisfy. `structuredBySchema` is exactly what
 * prevents it, which is why this helper keys on `FILE_SUMMARY_SCHEMA_NAME`
 * rather than setting `structured`.
 *
 * The general rule from server/insights.md 2026-08-17 applies here too: override
 * EVERY provider the code will resolve, not just the one you are testing. The
 * tell that you hit a live, billable model is an assertion failing against a
 * value that exists in a PROMPT FILE rather than in your fixture.
 *
 * NOTE ON THE PROVIDER ID ARGUMENT: `MockLLMProvider`'s constructor accepts only
 * `'openai' | 'anthropic'` (`src/adapters/mocks.ts`), so this passes `'openai'`
 * exactly as `test/helpers/intent.ts` does for its own openrouter-defaulting
 * feature model. The id is cosmetic here — what selects the mock is the KEY it
 * is registered under in `ContainerOverrides.llm`, which must be `openrouter`.
 */
export const FILE_SUMMARY_FIXTURE = {
  summaries: [
    {
      path: 'src/config.ts',
      summary: 'Adds a stripeKey entry read from the environment alongside the existing port and redisUrl settings.',
    },
  ],
};

/** A mock provider that answers only the file-summary schema. */
export function fileSummaryLlm(fixture: unknown = FILE_SUMMARY_FIXTURE): MockLLMProvider {
  return new MockLLMProvider('openai', {
    structuredBySchema: { [FILE_SUMMARY_SCHEMA_NAME]: fixture },
  });
}

/**
 * The same mock, with the USAGE fields of the structured result overridden.
 *
 * `MockLLMProvider` hard-codes `costUsd: 0.001`, so AC-34's two live cases — an
 * UNPRICED model (`null`) and a genuinely FREE one (`0`) — are unreachable
 * through it. They are different facts and must never be coalesced (root
 * `insights.md` 2026-08-02), which is exactly what AC-34 asks the database to
 * prove, so the seam has to exist somewhere. It is here rather than inline in a
 * test because `ContainerOverrides` is the only sanctioned way to inject a
 * provider, and a second hand-rolled provider in a test file would drift from
 * this one's `structuredBySchema` guard.
 */
export class UsageOverridingLlm extends MockLLMProvider {
  constructor(
    private usage: { costUsd?: number | null; tokensIn?: number; tokensOut?: number },
    fixture: unknown = FILE_SUMMARY_FIXTURE,
  ) {
    super('openai', { structuredBySchema: { [FILE_SUMMARY_SCHEMA_NAME]: fixture } });
  }

  override async completeStructured<T>(
    req: Parameters<MockLLMProvider['completeStructured']>[0] & { schema: unknown },
  ): Promise<Awaited<ReturnType<MockLLMProvider['completeStructured']>>> {
    const result = await super.completeStructured(req as never);
    return { ...result, ...this.usage } as never;
  }
}
