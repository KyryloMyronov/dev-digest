import { MockLLMProvider } from '../../src/adapters/mocks.js';
import { INTENT_SCHEMA_NAME } from '../../src/modules/reviews/constants.js';

/**
 * The intent classifier's stand-in for integration tests.
 *
 * MANDATORY in any test that triggers a review. Since L03 every review run
 * derives the PR's intent first, through the `review_intent` feature model —
 * which defaults to **openrouter**, a different provider from the one an agent
 * uses. A test that overrides only `openai` therefore leaves the intent call to
 * resolve a REAL provider: with no key it degrades harmlessly, but on a machine
 * that has `OPENROUTER_API_KEY` configured the suite quietly makes a live,
 * billable API call, and the assertions then depend on what a real model said.
 *
 * So: override BOTH. `intentLlm()` is the openrouter half.
 */
export const INTENT_FIXTURE = {
  intent: 'The nightly sync dies whenever upstream rate-limits; make it retry instead.',
  change_type: 'bugfix',
  in_scope: ['retry with backoff on 429'],
  out_of_scope: ['changing the sync schedule'],
  confidence: 0.95,
  evidence: ['pr-body'],
};

/** A mock provider that answers only the intent schema. */
export function intentLlm(fixture: unknown = INTENT_FIXTURE): MockLLMProvider {
  return new MockLLMProvider('openai', {
    structuredBySchema: { [INTENT_SCHEMA_NAME]: fixture },
  });
}
