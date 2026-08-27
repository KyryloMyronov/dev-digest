/* DiffTab constants — the presentation of the three Smart Diff roles. */
import type { IconName } from "@devdigest/ui";
import type { SmartDiffRole } from "@/lib/types";

interface RoleMeta {
  icon: IconName;
  /** Keys under the `prReview.smartDiff` namespace. */
  labelKey: string;
  hintKey: string;
  /** Colour of the role badge — core is the one you must not skip. */
  color: string;
  bg: string;
  /** Whether the whole group starts expanded. */
  openByDefault: boolean;
}

/**
 * Ordered core → wiring → boilerplate, matching the order the server emits and
 * the order a reviewer should read: logic first, generated output last (and
 * collapsed, because nobody reviews a lock file line by line).
 */
export const ROLE_META: Record<SmartDiffRole, RoleMeta> = {
  core: {
    icon: "Code",
    labelKey: "smartDiff.coreLabel",
    hintKey: "smartDiff.coreHint",
    color: "var(--accent-text)",
    bg: "var(--accent-bg)",
    openByDefault: true,
  },
  wiring: {
    icon: "Wrench",
    labelKey: "smartDiff.wiringLabel",
    hintKey: "smartDiff.wiringHint",
    color: "var(--text-secondary)",
    bg: "var(--bg-hover)",
    openByDefault: true,
  },
  boilerplate: {
    icon: "Boxes",
    labelKey: "smartDiff.boilerplateLabel",
    hintKey: "smartDiff.boilerplateHint",
    color: "var(--text-muted)",
    bg: "var(--bg-hover)",
    openByDefault: false,
  },
};
