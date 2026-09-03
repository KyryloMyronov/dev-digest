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
