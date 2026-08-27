/* Per-PR persistence of the diff view mode (Standard vs Smart).
   localStorage rather than the DB or the URL: it is a private reading
   preference, not shareable state — and unlike the session fold store it is
   MEANT to survive a reload ("the choice persists per PR"). */

export type DiffViewMode = "standard" | "smart";

const keyOf = (prId: string) => `devdigest:diff-view:${prId}`;

/** The persisted choice, or null (first visit, SSR, or storage unavailable). */
export function storedViewMode(prId: string | null): DiffViewMode | null {
  if (!prId || typeof window === "undefined") return null;
  try {
    const v = window.localStorage.getItem(keyOf(prId));
    return v === "standard" || v === "smart" ? v : null;
  } catch {
    return null;
  }
}

export function storeViewMode(prId: string | null, mode: DiffViewMode): void {
  if (!prId || typeof window === "undefined") return;
  try {
    window.localStorage.setItem(keyOf(prId), mode);
  } catch {
    // Private mode etc. — the toggle still works, it just won't survive reload.
  }
}
