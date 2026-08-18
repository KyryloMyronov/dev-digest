/* Pure helpers for the Smart Diff view. No React, no fetching — the two server
   payloads (`GET /pulls/:id` for the patches, `GET /pulls/:id/smart-diff` for
   the grouping, `GET /pulls/:id/reviews` for the findings) in, render-ready
   groups out. */
import { parsePatch, type DiffAnnotation, type DiffAnnotations } from "@/components/diff-viewer";
import type { FindingRecord, ReviewRecord } from "@devdigest/shared";
import type { PrFile, Severity, SmartDiff, SmartDiffRole } from "@/lib/types";

/** One Smart Diff group, resolved against the PR detail's actual patch text. */
export interface ResolvedGroup {
  role: SmartDiffRole;
  files: PrFile[];
  /** Changed lines across the group — what the group header reports. */
  lines: number;
  /** How many highlighted lines the group's findings account for. */
  findingLines: number;
}

/**
 * Join the grouping onto the diff.
 *
 * The smart-diff payload carries no patch text (the detail endpoint already
 * served it), so each group's paths are resolved back to the `PrFile` the
 * viewer needs. A path the detail doesn't know is dropped rather than rendered
 * as an empty card: the two payloads are fetched separately, so a PR that gains
 * a commit between the two calls can legitimately disagree for one render.
 */
export function resolveGroups(smart: SmartDiff, files: PrFile[]): ResolvedGroup[] {
  const byPath = new Map(files.map((f) => [f.path, f]));
  return smart.groups
    .map((g) => {
      const resolved = g.files.flatMap((f) => {
        const file = byPath.get(f.path);
        return file ? [file] : [];
      });
      return {
        role: g.role,
        files: resolved,
        lines: resolved.reduce((n, f) => n + f.additions + f.deletions, 0),
        findingLines: g.files.reduce((n, f) => n + f.finding_lines.length, 0),
      };
    })
    .filter((g) => g.files.length > 0);
}

/**
 * The findings of each agent's CURRENT review — the latest review per agent,
 * mirroring what `GET /pulls/:id/smart-diff` counts server-side.
 *
 * The two must agree: the highlighted LINES come from the server, the severity
 * BADGES from these reviews, so if one side counted a superseded pass a file
 * would show a badge with no highlighted line under it. Per agent rather than
 * per PR because one "run all agents" request writes several reviews at once,
 * and the newest row alone would drop all but one agent's findings.
 *
 * Reviews arrive newest-first from the API; this does not rely on that.
 */
export function currentFindings(reviews: ReviewRecord[]): FindingRecord[] {
  const current = new Map<string, ReviewRecord>();
  for (const review of reviews) {
    const key = review.agent_id ?? "no-agent";
    const held = current.get(key);
    // Ties on created_at are real (a fan-out writes N reviews at once) — break
    // them on id, arbitrary but stable, so the badges don't flicker.
    if (
      !held ||
      review.created_at > held.created_at ||
      (review.created_at === held.created_at && review.id > held.id)
    ) {
      current.set(key, review);
    }
  }
  return [...current.values()].flatMap((r) => r.findings);
}

/**
 * The per-file overlay the viewer renders: which lines to highlight, which
 * severity badge to show, and whether the card starts open.
 *
 * The highlighted lines come from the server (it holds the findings' anchor
 * ranges); the severities come from `currentFindings` above, so the two are
 * always the same set of reviews. Dismissed findings are excluded on both sides.
 * The Findings tab may legitimately show more than the badges do — it is the run
 * history, and it renders superseded passes on purpose.
 *
 * `defaultOpen` is only forced where the size rule gets it wrong: boilerplate
 * stays shut however small it is, and a file with findings opens however big it
 * is — the reason to be on this tab is to look at those lines.
 */
export function buildAnnotations(smart: SmartDiff, findings: FindingRecord[]): DiffAnnotations {
  const severitiesByPath = new Map<string, Severity[]>();
  for (const f of findings) {
    if (f.dismissed_at) continue;
    const list = severitiesByPath.get(f.file);
    if (list) list.push(f.severity);
    else severitiesByPath.set(f.file, [f.severity]);
  }

  const out: Record<string, DiffAnnotations[string]> = {};
  for (const group of smart.groups) {
    for (const file of group.files) {
      const hasFindings = file.finding_lines.length > 0;
      out[file.path] = {
        findingLines: file.finding_lines,
        severities: severitiesByPath.get(file.path) ?? [],
        ...(group.role === "boilerplate"
          ? { defaultOpen: false }
          : hasFindings
            ? { defaultOpen: true }
            : {}),
      };
    }
  }
  return out;
}

/**
 * Fold the session's manual fold/unfolds into the annotations' `defaultOpen`.
 *
 * The override wins over everything — role default and size rule alike — but
 * only takes effect when a card (re)mounts, which is exactly when defaults
 * would otherwise re-apply: tab switches and view-mode toggles. `foldOf` is a
 * lookup rather than the store itself so this stays pure and unit-testable.
 */
export function withFoldOverrides(
  annotations: DiffAnnotations,
  files: PrFile[],
  foldOf: (path: string) => boolean | undefined,
): DiffAnnotations {
  const out: Record<string, DiffAnnotation> = { ...annotations };
  for (const f of files) {
    const open = foldOf(f.path);
    if (open !== undefined) out[f.path] = { ...out[f.path], defaultOpen: open };
  }
  return out;
}

/**
 * Stamp each file's annotation with its group's tag, so a collapsed file
 * header still says which group it belongs to. `tagFor` resolves the role to
 * a rendered label/colour (i18n lives with the caller, not here).
 */
export function withRoleTags(
  annotations: DiffAnnotations,
  smart: SmartDiff,
  tagFor: (role: SmartDiffRole) => { label: string; color: string; bg: string },
): DiffAnnotations {
  const out: Record<string, DiffAnnotation> = { ...annotations };
  for (const group of smart.groups) {
    const tag = tagFor(group.role);
    for (const file of group.files) out[file.path] = { ...out[file.path], tag };
  }
  return out;
}

/**
 * New-side line numbers actually present in each file's patch — what "click a
 * finding, land on the line" can honestly promise. A finding outside this
 * index gets the attention mark instead of a broken scroll.
 */
export function diffLineIndex(files: PrFile[]): Map<string, Set<number>> {
  const out = new Map<string, Set<number>>();
  for (const f of files) {
    const lines = new Set<number>();
    for (const ln of parsePatch(f.patch)) if (ln.newNo != null) lines.add(ln.newNo);
    out.set(f.path, lines);
  }
  return out;
}

/**
 * Whether the finding's anchor is visible in the diff. A file-level finding
 * (no start line) counts as visible when its file is; a line-level one needs
 * the line itself, since findings may cite context far outside the hunks.
 */
export function findingInDiff(
  f: Pick<FindingRecord, "file" | "start_line">,
  index: Map<string, Set<number>>,
): boolean {
  const lines = index.get(f.file);
  if (!lines) return false;
  return f.start_line == null || lines.has(f.start_line);
}
