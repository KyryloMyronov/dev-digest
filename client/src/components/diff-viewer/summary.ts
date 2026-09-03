/* SPEC-03 — file-summary support for the DiffViewer (Files changed tab).
   The API shape the viewer needs to OFFER a derivation; the summary DATA itself
   rides on `DiffAnnotation` (plan D-8).

   Why the callback lives here and not on the annotation: `annotations.ts` calls
   itself "pure data + helpers" and stays true to that. `DiffCommentApi` in
   `comments.ts` is the shipped precedent for a callback reaching `FileCard`, and
   this is its sibling. */

/** What the viewer needs to request and reflect a per-file derivation. */
export interface DiffSummaryApi {
  /** Request a derivation for ONE file (AC-51). */
  onDerive: (path: string) => void;
  /** AC-63 — a PR-level derivation is in flight; every per-file control disabled. */
  prLevelPending: boolean;
  /** Paths whose own per-file derivation is in flight. */
  pending: ReadonlySet<string>;
  /**
   * AC-54 — the file-summaries read is still pending, so each card renders a
   * SKELETON where its summary line will be. The flag lives here rather than on
   * the annotation because it is a property of the QUERY, not of the file.
   */
  loading: boolean;
  /**
   * RESOLVED LABELS — strings, never message keys.
   *
   * `derive` MUST state that activating the control spends a model call
   * (AC-53); `noPatch` is the disabled reason (AC-52); `deriving` is the
   * in-flight name, and AC-57 returning the control to idle is observable as
   * this name changing back.
   *
   * A genuinely shared component takes label props rather than calling
   * `useTranslations` itself — one that resolves its own namespace crashes any
   * screen whose catalogue lacks it (client insights.md 2026-08-27).
   */
  labels: { derive: string; deriving: string; noPatch: string };
}
