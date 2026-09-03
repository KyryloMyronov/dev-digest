import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import type { FindingRecord } from "@devdigest/shared";
import messages from "../../../../../../../../messages/en/prReview.json";
import shellMessages from "../../../../../../../../messages/en/shell.json";
import { FindingCard } from "./FindingCard";
import { FileCard } from "@/components/diff-viewer/FileCard/FileCard";

/** One changed file whose new-side line 11 exists, matching FINDING's anchor. */
const PATCH = [
  "@@ -9,2 +9,3 @@",
  " const port = 3000;",
  '+const stripeKey = "sk_live_xxx";',
  " const redisUrl = x;",
].join("\n");

afterEach(cleanup);

const FINDING: FindingRecord = {
  id: "f1",
  severity: "CRITICAL",
  category: "security",
  title: "Hardcoded Stripe secret key",
  file: "src/config.ts",
  start_line: 11,
  end_line: 11,
  rationale: "A **live** Stripe key is committed in source.",
  suggestion: "Move the key to an environment variable.",
  confidence: 0.95,
  kind: "finding",
  trifecta_components: null,
  evidence: null,
  review_id: "r1",
  accepted_at: null,
  dismissed_at: null,
};

function renderWithIntl(ui: React.ReactElement) {
  return render(
    <NextIntlClientProvider locale="en" messages={{ prReview: messages }}>
      {ui}
    </NextIntlClientProvider>,
  );
}

describe("FindingCard (smoke, both themes)", () => {
  (["dark", "light"] as const).forEach((theme) => {
    it(`renders severity + file:line + rationale in ${theme}`, () => {
      renderWithIntl(
        <div data-theme={theme}>
          <FindingCard f={FINDING} defaultExpanded onAction={() => {}} />
        </div>,
      );
      expect(screen.getByText("Hardcoded Stripe secret key")).toBeInTheDocument();
      expect(screen.getByText("src/config.ts:11")).toBeInTheDocument();
      // category label is shown alongside the severity badge
      expect(screen.getByText("security")).toBeInTheDocument();
    });
  });

  it("fires accept/dismiss actions", () => {
    const onAction = vi.fn();
    renderWithIntl(<FindingCard f={FINDING} defaultExpanded onAction={onAction} />);
    fireEvent.click(screen.getByText("Accept"));
    expect(onAction).toHaveBeenCalledWith("accept");
    fireEvent.click(screen.getByText("Dismiss"));
    expect(onAction).toHaveBeenCalledWith("dismiss");
  });
});

/**
 * SPEC-02 AC-50 / D-7 — REGRESSION ASSERTIONS for a deliberate change to
 * SHIPPED behaviour. `FileCard`'s reveal now moves KEYBOARD FOCUS to the
 * revealed card, unconditionally, for every caller — which includes the
 * findings tab's own jump-to-diff. Written in this existing suite, not only in
 * BriefCard.test.tsx, so the change is visible in a diff.
 *
 * The card itself only raises `onJumpToDiff`; `page.tsx` turns that into a
 * `DiffReveal`. Both halves are asserted here: the request the card emits, and
 * where focus lands once the diff viewer serves it.
 */
describe("FindingCard · jump to diff (SPEC-02 AC-50)", () => {
  it("raises onJumpToDiff when the view-in-diff control is activated", () => {
    const onJumpToDiff = vi.fn();
    renderWithIntl(<FindingCard f={FINDING} defaultExpanded onJumpToDiff={onJumpToDiff} />);
    fireEvent.click(screen.getByText("View in diff"));
    expect(onJumpToDiff).toHaveBeenCalledTimes(1);
  });

  it("leaves keyboard focus on the revealed file card once the reveal is served", async () => {
    const scrollSpy = vi.fn();
    window.HTMLElement.prototype.scrollIntoView = scrollSpy;

    // The reveal `page.tsx#jumpToFinding` builds from this finding.
    const reveal = { path: FINDING.file, line: FINDING.start_line, token: 1 };
    render(
      <NextIntlClientProvider locale="en" messages={{ prReview: messages, shell: shellMessages }}>
        <FileCard
          file={{ path: FINDING.file, additions: 1, deletions: 0, patch: PATCH }}
          reveal={{ line: reveal.line, token: reveal.token }}
        />
      </NextIntlClientProvider>,
    );

    await waitFor(() => expect(scrollSpy).toHaveBeenCalled());
    await waitFor(() => {
      const focused = document.activeElement as HTMLElement;
      expect(focused).not.toBe(document.body);
      expect(focused.getAttribute("tabindex")).toBe("-1");
      expect(focused.textContent).toContain("src/config.ts");
    });
  });
});

/**
 * SPEC-04 AC-5 / AC-6 — "Turn into eval case".
 *
 * EVERY test here EXPANDS THE CARD FIRST. The action row renders only inside
 * `{expanded && …}`, so an "the action is absent" assertion on a collapsed card
 * passes in every code state, including a completely broken one (plan D-20).
 * The `defaultExpanded` prop is what makes that explicit rather than incidental.
 *
 * Assertions go through the ACCESSIBILITY TREE, never through `title`:
 * `aria-label` beats `title` in the accessible-name computation, so a test
 * asserting `toHaveAttribute("title", …)` cannot fail on a broken accessible
 * name (`client/insights.md` 2026-08-28).
 */
describe("SPEC-04 — Turn into eval case", () => {
  const judged = (over: Partial<FindingRecord> = {}): FindingRecord => ({
    ...FINDING,
    accepted_at: "2026-09-01T00:00:00.000Z",
    ...over,
  });

  const renderCard = (f: FindingRecord, onTurn = vi.fn()) => {
    renderWithIntl(<FindingCard f={f} defaultExpanded onTurnIntoEvalCase={onTurn} />);
    return onTurn;
  };

  it("the card really is expanded — the action row is on screen", () => {
    // Guards every "absent" assertion below: if this fails, they prove nothing.
    renderCard(judged());
    expect(screen.getByRole("button", { name: "Accept" })).toBeInTheDocument();
  });

  it.each(["secret_leak", "phantom", "hook", "lethal_trifecta"] as const)(
    "AC-5 — the action is ABSENT for kind %s",
    (kind) => {
      renderCard(judged({ kind }));
      expect(screen.getByRole("button", { name: "Accept" })).toBeInTheDocument();
      expect(
        screen.queryByRole("button", { name: /eval case/i }),
      ).not.toBeInTheDocument();
    },
  );

  it("AC-6 — present but DISABLED with neither timestamp, carrying the hint", () => {
    renderCard({ ...FINDING, accepted_at: null, dismissed_at: null });
    const btn = screen.getByRole("button", { name: "Accept or dismiss this finding first" });
    expect(btn).toBeDisabled();
    expect(btn).toHaveAccessibleName("Accept or dismiss this finding first");
  });

  it("is enabled once the finding is accepted, and calls back", () => {
    const onTurn = renderCard(judged());
    const btn = screen.getByRole("button", { name: "Turn into eval case" });
    expect(btn).not.toBeDisabled();
    fireEvent.click(btn);
    expect(onTurn).toHaveBeenCalledTimes(1);
  });

  it("is enabled once the finding is dismissed", () => {
    renderCard({ ...FINDING, accepted_at: null, dismissed_at: "2026-09-01T00:00:00.000Z" });
    expect(screen.getByRole("button", { name: "Turn into eval case" })).not.toBeDisabled();
  });

  it("omission and disablement stay DIFFERENT states", () => {
    // An excluded kind with no timestamps: omitted, not disabled-with-a-hint.
    renderCard({ ...FINDING, kind: "secret_leak", accepted_at: null, dismissed_at: null });
    expect(
      screen.queryByRole("button", { name: "Accept or dismiss this finding first" }),
    ).not.toBeInTheDocument();
  });

  it("the card ships THREE actions — learn and replyToAuthor stay unbuilt (OQ-4)", () => {
    renderCard(judged());
    expect(screen.queryByRole("button", { name: "Learn" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Reply to author" })).not.toBeInTheDocument();
  });
});
