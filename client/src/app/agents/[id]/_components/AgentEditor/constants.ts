import type { IconName } from "@devdigest/ui";

/** Editor tab descriptor. `labelKey` resolves under the `agents` namespace. */
export interface EditorTab {
  key: string;
  labelKey: string;
  icon: IconName;
}

/** Editor tabs. Evals/Stats/CI arrive with their own lessons. */
export const TABS: readonly EditorTab[] = [
  { key: "config", labelKey: "editor.tabs.config", icon: "Settings" },
  { key: "skills", labelKey: "editor.tabs.skills", icon: "Sparkles" },
];

/**
 * The tab keys `?tab=` may hold. Derived from TABS so adding a tab cannot leave
 * the URL whitelist behind — a `?tab=` value that is not here falls back to
 * `config` rather than rendering an empty editor body.
 */
export const TAB_KEYS: readonly string[] = TABS.map((tb) => tb.key);
