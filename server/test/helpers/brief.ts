import { MockLLMProvider } from '../../src/adapters/mocks.js';
import { BRIEF_SCHEMA_NAME } from '../../src/modules/brief/constants.js';

/**
 * The brief extractor's stand-in for integration tests.
 *
 * MANDATORY in any test that triggers a brief derivation. `risk_brief` resolves
 * to **openai** by default — the SAME provider an agent review uses — and
 * `reviews.it.test.ts` already stubs `openai` with `{ structured: REVIEW_FIXTURE }`.
 * A brief derivation reaching that harness would therefore be handed a *review*
 * fixture and fail against a schema it was never meant to satisfy.
 * `structuredBySchema` is exactly what prevents it, which is why this helper
 * keys on `BRIEF_SCHEMA_NAME` rather than setting `structured`.
 *
 * The general rule from server/insights.md applies here too: override EVERY
 * provider the code will resolve, not just the agent's. The tell that you hit a
 * live, billable model is an assertion failing against a value that exists in a
 * PROMPT FILE rather than in your fixture.
 */
export const BRIEF_FIXTURE = {
  why_summary:
    'Public endpoints have no throttle, so a single client can exhaust the worker pool; this adds a per-route limiter.',
  why_sources: ['pr-title', 'pr-body'],
  risks: [
    {
      kind: 'concurrency',
      title: 'The limiter store is process-local',
      explanation:
        'With more than one API instance the effective limit is N times the configured one.',
      severity: 'WARNING',
      file: 'src/config.ts',
      start_line: 12,
      end_line: 12,
    },
  ],
  focus: [
    {
      file: 'src/config.ts',
      start_line: 12,
      end_line: 12,
      reason: 'Check the limiter window against the documented quota.',
    },
  ],
};

/** A mock provider that answers only the brief schema. */
export function briefLlm(fixture: unknown = BRIEF_FIXTURE): MockLLMProvider {
  return new MockLLMProvider('openai', {
    structuredBySchema: { [BRIEF_SCHEMA_NAME]: fixture },
  });
}
