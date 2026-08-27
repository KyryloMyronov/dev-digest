import type { ContextDocSource } from "@/lib/types";

/** Skeleton rows shown while the first list read is in flight (AC-9). */
export const SKELETON_ROWS = 6;

/** Height of one skeleton row — roughly a real row with its path and chips. */
export const SKELETON_ROW_HEIGHT = 44;

/** Width of the document list column; the preview takes the rest. */
export const LIST_WIDTH = 420;

/**
 * The source-kind chips.
 *
 * NFR-9 requires ≥ 4.5:1 contrast in BOTH themes, so the label colour is
 * `--text-primary` on every chip — the one foreground guaranteed to pass
 * against any of these tinted backgrounds in either theme (a per-source
 * foreground like `--ok` on `--ok-bg` measures 3.3:1 in the light theme and
 * would fail). The source identity is carried by the background tint AND a
 * distinct icon, so it never rests on colour alone (WCAG 1.4.1 as well as
 * 1.4.3), and every value is an existing CSS variable rather than a new colour
 * literal.
 */
export const SOURCE_CHIP: Record<ContextDocSource, { bg: string; icon: "FileText" | "Folder" | "Lightbulb" }> = {
  specs: { bg: "var(--accent-bg)", icon: "FileText" },
  docs: { bg: "var(--ok-bg)", icon: "Folder" },
  insights: { bg: "var(--warn-bg)", icon: "Lightbulb" },
};

export const CHIP_FG = "var(--text-primary)";

/**
 * Characters of a path kept visible when a row must truncate.
 *
 * AC-14 truncates at the HEAD and keeps the basename visible, and AC-13 needs
 * the row's accessible name to stay the full, unmodified path — so this affects
 * the rendered text only, never `aria-label`.
 */
export const PATH_MAX_CHARS = 46;
