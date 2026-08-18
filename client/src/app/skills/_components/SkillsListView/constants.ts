import type { SkillType } from "@devdigest/shared";

/** Constants for the Skills library view. */

/** Card grid template — narrower than the agents grid; a skill card is smaller. */
export const CARD_GRID_COLS = "repeat(auto-fill, minmax(260px, 1fr))";

/** Width of the preview panel that opens beside the grid. */
export const PREVIEW_WIDTH = 460;

/** Chip colour per skill type. Mirrors the type badges in the Agent Skills tab. */
export const TYPE_COLOR: Record<SkillType, string> = {
  rubric: "var(--info)",
  convention: "var(--ok, var(--text-secondary))",
  security: "var(--crit)",
  custom: "var(--text-secondary)",
};

/** The types offered in the editor's dropdown, in the order they are shown. */
export const TYPE_OPTIONS: SkillType[] = ["rubric", "convention", "security", "custom"];

/** Files the import picker accepts. Anything else is rejected before parsing. */
export const IMPORT_ACCEPT = ".md,.mdx,.zip";
