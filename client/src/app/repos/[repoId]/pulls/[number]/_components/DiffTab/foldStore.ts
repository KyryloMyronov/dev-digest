/* Session-scoped fold memory for the diff view (L03 · Smart Diff).
   A module-level map is exactly "the rest of the session": it survives tab
   switches and view-mode toggles, and resets on a full page load — at which
   point the role defaults (boilerplate collapsed, the rest open) apply again.
   Deliberately NOT persisted to storage: the defaults are the feature, the
   override is a courtesy. */

const folds = new Map<string, boolean>();

const keyOf = (prId: string, kind: "file" | "group", id: string) => `${prId}:${kind}:${id}`;

/** The user's manual fold/unfold for a file this session, if any. */
export function fileFold(prId: string | null, path: string): boolean | undefined {
  return prId ? folds.get(keyOf(prId, "file", path)) : undefined;
}

export function setFileFold(prId: string | null, path: string, open: boolean): void {
  if (prId) folds.set(keyOf(prId, "file", path), open);
}

/** The user's manual fold/unfold for a role group this session, if any. */
export function groupFold(prId: string | null, role: string): boolean | undefined {
  return prId ? folds.get(keyOf(prId, "group", role)) : undefined;
}

export function setGroupFold(prId: string | null, role: string, open: boolean): void {
  if (prId) folds.set(keyOf(prId, "group", role), open);
}

/** Tests only — vitest keeps the module (and so the map) alive across cases. */
export function resetFolds(): void {
  folds.clear();
}
