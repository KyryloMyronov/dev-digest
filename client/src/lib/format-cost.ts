/**
 * USD cost formatting, shared by the PR list, the run timeline and the trace
 * drawer.
 *
 * Precision follows magnitude. A chunked review on a cheap OpenRouter model
 * costs a fraction of a cent, so a flat `toFixed(2)` — what this did before it
 * was removed — rendered nearly every real run as "$0.00".
 *
 * `null` is not formatted here: it renders as the caller's placeholder, because
 * only the call site knows whether it means "nothing has run yet" (—) or "the
 * model isn't in the price table" (n/a). Zero is NOT null — some models really
 * are free, and that has to stay distinguishable from unknown.
 */
export function formatCost(usd: number | null | undefined, fallback: string): string {
  if (usd == null) return fallback;
  if (usd === 0) return "$0.00";
  if (usd < 0.0001) return "<$0.0001";
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}