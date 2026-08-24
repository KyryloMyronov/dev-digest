/* Per-PR persistence of the blast view mode (Tree vs Graph). Same rationale as
   DiffTab/viewMode.ts: a private reading preference, meant to survive reload —
   localStorage, never the URL or the DB. */

export type BlastViewMode = "tree" | "graph";

const keyOf = (prId: string) => `devdigest:blast-view:${prId}`;

/** The persisted choice, or null (first visit, SSR, or storage unavailable). */
export function storedBlastView(prId: string | null): BlastViewMode | null {
  if (!prId || typeof window === "undefined") return null;
  try {
    const v = window.localStorage.getItem(keyOf(prId));
    return v === "tree" || v === "graph" ? v : null;
  } catch {
    return null;
  }
}

export function storeBlastView(prId: string | null, mode: BlastViewMode): void {
  if (!prId || typeof window === "undefined") return;
  try {
    window.localStorage.setItem(keyOf(prId), mode);
  } catch {
    // Private mode etc. — the toggle still works, it just won't survive reload.
  }
}
