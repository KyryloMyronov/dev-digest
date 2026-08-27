import type { AgentContextDoc, ContextDoc } from "@/lib/types";

/** Pure helpers for the agent Context tab. */

/**
 * Case-insensitive substring match on the path (AC-24).
 *
 * Deliberately not fuzzy and not on the basename only: AC-24 says "rows whose
 * path contains the typed text", and a fuzzy matcher would make "specs/a" match
 * rows a reviewer did not ask for.
 */
export function matchesFilter(path: string, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (q === "") return true;
  return path.toLowerCase().includes(q);
}

/**
 * Move one item to a new index, returning a NEW array.
 *
 * A second copy of `SkillsTab/helpers.ts`'s `moveItem` on purpose: it is twelve
 * pure lines, and importing across two sibling feature folders would couple two
 * routes' `_components/` trees to each other — which is the coupling
 * colocation exists to prevent. Promote to `src/lib/` if a third caller appears.
 */
export function moveItem<T>(items: readonly T[], from: number, to: number): T[] {
  if (from === to) return [...items];
  if (from < 0 || from >= items.length || to < 0 || to >= items.length) return [...items];
  const next = [...items];
  const [moved] = next.splice(from, 1) as [T];
  next.splice(to, 0, moved);
  return next;
}

/**
 * AC-32 — the summed token count of the ATTACHED documents only, plus how many
 * of them have no count yet.
 *
 * A `null` count contributes 0 and is reported separately: treating "not counted
 * yet" as zero would render a freshly-cloned repository as comfortably under
 * budget when nobody knows what it costs. Inherited rows are included — they
 * reach the prompt too.
 */
export function tokenTotals(rows: readonly AgentContextDoc[]): {
  tokens: number;
  pendingCount: number;
} {
  let tokens = 0;
  let pendingCount = 0;
  for (const row of rows) {
    const value = row.doc?.tokens;
    if (value === null || value === undefined) pendingCount += 1;
    else tokens += value;
  }
  return { tokens, pendingCount };
}

/** The discovered documents this owner has NOT attached (the attach list). */
export function availableDocs(
  discovered: readonly ContextDoc[],
  attachedPaths: ReadonlySet<string>,
): ContextDoc[] {
  return discovered.filter((d) => !attachedPaths.has(d.path));
}
