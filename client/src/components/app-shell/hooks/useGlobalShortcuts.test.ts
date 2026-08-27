/**
 * useGlobalShortcuts — the `g`-chord navigation (AC-57, AC-58).
 *
 * This is AC-58's PRIMARY and guaranteed proof. The chord is a plain `keydown`
 * listener on `window`, so jsdom can dispatch `g` then `x` for real and assert
 * `router.push`'s argument — no browser, no flake. Step 32's `e2e` row is
 * additional coverage and carries an unretired unknown about whether
 * `agent-browser` exposes a key-press primitive at all.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, cleanup } from "@testing-library/react";
import { NAV, SHORTCUTS } from "@devdigest/ui";
import navShellMessages from "../../../../messages/en/shell.json";

const push = vi.fn();
const ACTIVE_REPO = "repo-42";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push, replace: vi.fn() }),
  usePathname: () => `/repos/${ACTIVE_REPO}/pulls`,
}));

vi.mock("../../../lib/repo-context", () => ({
  useActiveRepo: () => ({
    repoId: ACTIVE_REPO,
    setRepoId: vi.fn(),
    repos: [],
    activeRepo: null,
    reposLoaded: true,
  }),
}));

// Imported after the mocks so the hook resolves them.
const { useGlobalShortcuts } = await import("./useGlobalShortcuts");

function mount() {
  return renderHook(() =>
    useGlobalShortcuts({ onOpenPalette: vi.fn(), onOpenHelp: vi.fn() }),
  );
}

function press(key: string) {
  window.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
}

describe("the g-chord for Project Context", () => {
  beforeEach(() => push.mockClear());
  afterEach(() => cleanup());

  // AC-58 — `g` then `x` navigates to the ACTIVE repository's context page.
  it("navigates to the active repository's Project Context page on g then x", () => {
    mount();

    press("g");
    press("x");

    expect(push).toHaveBeenCalledTimes(1);
    expect(push).toHaveBeenCalledWith(`/repos/${ACTIVE_REPO}/context`);
  });

  it("does not navigate on a bare x with no preceding g", () => {
    mount();
    press("x");
    expect(push).not.toHaveBeenCalled();
  });

  it("leaves the other chords working", () => {
    mount();
    press("g");
    press("p");
    expect(push).toHaveBeenCalledWith(`/repos/${ACTIVE_REPO}/pulls`);
  });
});

describe("the Project Context nav registration (AC-57)", () => {
  it("sits in the WORKSPACE group with the g-x chord and a real route template", () => {
    const workspace = NAV.find((g) => g.section === "WORKSPACE");
    const item = workspace?.items.find((i) => i.key === "context");

    expect(item).toBeDefined();
    expect(item).toMatchObject({
      label: "Project Context",
      href: "/repos/:repoId/context",
      gKey: "x",
      icon: "FileText",
    });
  });

  /**
   * `nav.ts` requires the sidebar's literal label and the palette's translated
   * label to be byte-identical, because the sidebar renders `item.label` while
   * `useShellCommands` renders `t("nav.<key>")`. Nothing else checks that, and a
   * mismatch shows up only as two surfaces disagreeing in front of a user.
   */
  it("keeps the nav label byte-identical to shell.nav.context", () => {
    const item = NAV.flatMap((g) => g.items).find((i) => i.key === "context")!;
    expect(item.label).toBe((navShellMessages as { nav: Record<string, string> }).nav.context);
  });

  it("publishes the chord in the shortcuts registry", () => {
    expect(SHORTCUTS).toEqual(
      expect.arrayContaining([
        { keys: "g x", label: "Go to Project Context", group: "Navigation" },
      ]),
    );
  });

  it("gives every WORKSPACE item a distinct g-key", () => {
    const keys = NAV.flatMap((g) => g.items)
      .map((i) => i.gKey)
      .filter((k): k is string => !!k);
    expect(new Set(keys).size).toBe(keys.length);
  });
});
