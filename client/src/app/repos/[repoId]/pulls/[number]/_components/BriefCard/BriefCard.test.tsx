/**
 * SPEC-02 — the brief card.
 *
 * Mocked at the FETCH boundary, with a real QueryClient, so the polling
 * behaviour (AC-34) is the shipped one rather than a stub's. Note for the
 * record: an RTL suite that stubs `fetch` cannot see a server-side join go
 * wrong — which is why `brief.it.test.ts` is not redundant, and why SPEC-02's
 * Non-goal of an e2e flow leaves a STATED gap rather than an unnoticed one.
 *
 * The card is rendered in isolation with an explicit next-intl provider rather
 * than by mounting the page shell: wrapping in `RepoProvider` makes the shell
 * fetch more, and one non-array stub blanks the whole render.
 */
import React from "react";
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, screen, cleanup, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { PrBriefRecord } from "@devdigest/shared";
import prReview from "../../../../../../../../messages/en/prReview.json";
import { BriefCard, truncatePath } from "./BriefCard";
import { BRIEF_RISK_DISPLAY_CAP, DERIVE_TIMEOUT_MS } from "./constants";

const HEAD = "abc1234";

const RISK = {
  kind: "concurrency",
  title: "The limiter store is process-local",
  explanation: "With more than one API instance the effective limit is N times the configured one.",
  severity: "WARNING" as const,
  file: "src/config.ts",
  start_line: 12,
  end_line: 12,
};

function record(over: Partial<PrBriefRecord> = {}): PrBriefRecord {
  return {
    pr_id: "pr-1",
    why: { summary: "Public endpoints have no throttle.", sources: ["pr-title"] },
    risks: [RISK],
    focus: {
      entries: [
        { file: "src/config.ts", start_line: 12, end_line: 12, reason: "Check the window." },
      ],
    },
    grounding: { kept: 2, dropped: 0 },
    omitted_files: [],
    provider: "openai",
    model: "gpt-4.1",
    tokens_in: 1200,
    tokens_out: 300,
    cost_usd: 0.0642,
    head_sha: HEAD,
    created_at: "2026-08-28T10:00:00.000Z",
    ...over,
  };
}

/** Fetch stub: `GET` answers from the queue (or the last entry), `POST` 202s. */
let getResponses: (PrBriefRecord | null)[] = [];
let getCalls = 0;
let postCalls = 0;
let failGet = false;

function installFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === "POST") {
        postCalls += 1;
        return new Response(JSON.stringify({ status: "accepted", jobId: "job-1" }), {
          status: 202,
          headers: { "content-type": "application/json" },
        });
      }
      getCalls += 1;
      if (failGet) {
        return new Response(
          JSON.stringify({ error: { code: "internal_error", message: "Boom" } }),
          { status: 500, headers: { "content-type": "application/json" } },
        );
      }
      const next = getResponses.length > 1 ? getResponses.shift()! : (getResponses[0] ?? null);
      return new Response(JSON.stringify(next), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }),
  );
}

function renderCard(
  props: Partial<React.ComponentProps<typeof BriefCard>> = {},
) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });
  const onRevealLocation = props.onRevealLocation ?? vi.fn();
  render(
    <QueryClientProvider client={qc}>
      <NextIntlClientProvider locale="en" messages={{ prReview }}>
        <BriefCard
          prId="pr-1"
          headSha={HEAD}
          {...props}
          onRevealLocation={onRevealLocation}
        />
      </NextIntlClientProvider>
    </QueryClientProvider>,
  );
  return { onRevealLocation };
}

beforeEach(() => {
  getResponses = [null];
  getCalls = 0;
  postCalls = 0;
  failGet = false;
  installFetch();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

// -------------------------------------------------------------- AC-30 / 47

describe("sections", () => {
  it("AC-30 renders three sections in the order why → risks → review focus", async () => {
    getResponses = [record()];
    renderCard();

    await screen.findByText("Why this change");
    const labels = ["Why this change", "Risk areas", "Review focus"].map(
      (text) => screen.getByText(text),
    );
    // Document order, not merely presence.
    expect(labels[0]!.compareDocumentPosition(labels[1]!)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    expect(labels[1]!.compareDocumentPosition(labels[2]!)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
  });

  it("AC-47 renders the surviving sections when one is absent", async () => {
    getResponses = [record({ why: null })];
    renderCard();

    // The absent section renders its OWN empty state…
    expect(
      await screen.findByText("No motivation was derived for this pull request."),
    ).toBeInTheDocument();
    // …and its siblings keep rendering.
    expect(screen.getByText(RISK.title)).toBeInTheDocument();
    expect(screen.getByText("Check the window.")).toBeInTheDocument();
  });
});

// --------------------------------------------------------- AC-31 / 32 / 33

describe("states", () => {
  it("AC-32 renders skeleton placeholders while the read is pending", () => {
    // Never resolve the GET, so the query stays pending.
    vi.stubGlobal("fetch", vi.fn(() => new Promise(() => undefined)));
    const { container } = render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <NextIntlClientProvider locale="en" messages={{ prReview }}>
          <BriefCard prId="pr-1" headSha={HEAD} />
        </NextIntlClientProvider>
      </QueryClientProvider>,
    );
    expect(container.querySelectorAll(".skeleton").length).toBeGreaterThan(0);
  });

  it("AC-33 renders an error state with a retry control in the accessibility tree", async () => {
    failGet = true;
    renderCard();

    const alert = await screen.findByRole("alert");
    expect(within(alert).getByText("Could not load the risk brief")).toBeInTheDocument();
    expect(within(alert).getByRole("button", { name: /retry/i })).toBeInTheDocument();
  });

  it("AC-31 renders the empty state and its derivation control when no brief exists", async () => {
    getResponses = [null];
    renderCard();

    expect(
      await screen.findByRole("button", { name: "Derive brief" }),
    ).toBeInTheDocument();
    // No brief derived ≠ no risks found ≠ everything dropped.
    expect(screen.queryByText("No risks were found in this diff.")).toBeNull();
  });

  it("AC-31/AC-29 distinguishes ‘all dropped’ from ‘genuinely no risks’", async () => {
    getResponses = [record({ risks: [], grounding: { kept: 0, dropped: 3 } })];
    renderCard();
    expect(
      await screen.findByText(/Every stated risk cited code that is not in this diff/),
    ).toBeInTheDocument();

    cleanup();
    getResponses = [record({ risks: [], grounding: { kept: 0, dropped: 0 } })];
    renderCard();
    expect(
      await screen.findByText("No risks were found in this diff."),
    ).toBeInTheDocument();
  });
});

// -------------------------------------------------------------------- AC-36

describe("AC-36 staleness", () => {
  it("renders the staleness badge AND keeps the content visible", async () => {
    getResponses = [record({ head_sha: "0000000" })];
    renderCard();

    const badge = await screen.findByText("Stale — the head moved");
    expect(badge).toBeInTheDocument();
    // A stale brief is still information.
    const why = screen.getByText("Public endpoints have no throttle.");
    expect(why).toBeInTheDocument();
    expect(badge.compareDocumentPosition(why)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  });
});

// ------------------------------------------------------------- AC-37/38/39/65

describe("risks", () => {
  it("AC-37 renders each severity with an icon AND a mixed-case text label", async () => {
    getResponses = [
      record({
        risks: [
          { ...RISK, severity: "CRITICAL", title: "Crit" },
          { ...RISK, severity: "WARNING", title: "Warn" },
          { ...RISK, severity: "SUGGESTION", title: "Sugg" },
        ],
      }),
    ];
    const { container } = render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <NextIntlClientProvider locale="en" messages={{ prReview }}>
          <BriefCard prId="pr-1" headSha={HEAD} />
        </NextIntlClientProvider>
      </QueryClientProvider>,
    );

    // MIXED CASE on purpose: the all-caps look is `textTransform: uppercase`,
    // a CSS effect that never reaches the DOM. `SeverityBadge` is rendered
    // WITHOUT `compact`, which would drop the label and leave colour + icon
    // carrying the meaning — the WCAG 1.4.1 failure NFR-5 forbids.
    expect(await screen.findByText("Critical")).toBeInTheDocument();
    expect(screen.getByText("Warning")).toBeInTheDocument();
    expect(screen.getByText("Suggestion")).toBeInTheDocument();
    // NFR-5 / 1.4.1: an icon accompanies each label, so colour is never alone.
    expect(container.querySelectorAll("svg.lucide").length).toBeGreaterThanOrEqual(3);
  });

  it("NFR-5 (1.4.3 / 1.4.11) paints each severity with its own token, not a shared colour", async () => {
    // With `css: false` no stylesheet loads and no `var(--x)` resolves, so the
    // honest assertion is the TOKEN the component paints, read off the inline
    // style jsdom preserves verbatim. The contrast arithmetic for these tokens
    // lives in `DocRow.test.tsx`; duplicating it here would add a second copy of
    // the token table without adding coverage.
    getResponses = [
      record({
        risks: [
          { ...RISK, severity: "CRITICAL", title: "Crit" },
          { ...RISK, severity: "WARNING", title: "Warn" },
          { ...RISK, severity: "SUGGESTION", title: "Sugg" },
        ],
      }),
    ];
    renderCard();

    // `getByText` lands on the badge span itself — the label is a direct child
    // text node of the element carrying the inline colour.
    const crit = (await screen.findByText("Critical")) as HTMLElement;
    expect(crit.style.color).toBe("var(--crit)");
    expect((screen.getByText("Warning") as HTMLElement).style.color).toBe("var(--warn)");
    expect((screen.getByText("Suggestion") as HTMLElement).style.color).toBe("var(--sugg)");
  });

  it("AC-38 orders a shuffled list CRITICAL → WARNING → SUGGESTION", async () => {
    getResponses = [
      record({
        risks: [
          { ...RISK, severity: "SUGGESTION", title: "third" },
          { ...RISK, severity: "CRITICAL", title: "first" },
          { ...RISK, severity: "WARNING", title: "second" },
        ],
      }),
    ];
    renderCard();

    await screen.findByText("first");
    const a = screen.getByText("first");
    const b = screen.getByText("second");
    const c = screen.getByText("third");
    expect(a.compareDocumentPosition(b)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(b.compareDocumentPosition(c)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  });

  it("AC-65 / AC-39 renders at most ten risks and says how many of how many", async () => {
    const many = Array.from({ length: 20 }, (_, i) => ({
      ...RISK,
      title: `risk number ${i}`,
    }));
    getResponses = [record({ risks: many })];
    renderCard();

    await screen.findByText("risk number 0");
    const rendered = many.filter((r) => screen.queryByText(r.title) !== null);
    expect(rendered).toHaveLength(BRIEF_RISK_DISPLAY_CAP);
    expect(screen.getByText("Showing 10 of 20 risks.")).toBeInTheDocument();
  });
});

// ------------------------------------------------------------ AC-40/58/59

describe("review focus", () => {
  it("AC-58 renders entries in the order the brief lists them — NOT sorted", async () => {
    getResponses = [
      record({
        focus: {
          entries: [
            { file: "z/last.ts", start_line: 1, end_line: 1, reason: "open this first" },
            { file: "a/first.ts", start_line: 2, end_line: 2, reason: "then this" },
          ],
        },
      }),
    ];
    renderCard();

    const first = await screen.findByText("open this first");
    const second = screen.getByText("then this");
    expect(first.compareDocumentPosition(second)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  });

  it("AC-40 / AC-59 renders at most five entries, each with its reason", async () => {
    getResponses = [
      record({
        focus: {
          entries: Array.from({ length: 8 }, (_, i) => ({
            file: `src/f${i}.ts`,
            start_line: i + 1,
            end_line: i + 1,
            reason: `reason ${i}`,
          })),
        },
      }),
    ];
    renderCard();

    await screen.findByText("reason 0");
    const shown = Array.from({ length: 8 }, (_, i) => `reason ${i}`).filter(
      (r) => screen.queryByText(r) !== null,
    );
    expect(shown).toEqual(["reason 0", "reason 1", "reason 2", "reason 3", "reason 4"]);
  });
});

// ---------------------------------------------------------- AC-41/42/43/49/66

describe("the location control", () => {
  it("AC-41 emits a reveal for the risk's file and line", async () => {
    const user = userEvent.setup();
    getResponses = [record()];
    const { onRevealLocation } = renderCard();

    await screen.findByText(RISK.title);
    await user.click(screen.getAllByRole("button", { name: /Open this location/ })[0]!);

    expect(onRevealLocation).toHaveBeenCalledWith("src/config.ts", 12);
  });

  it("AC-43 emits a reveal for a review-focus entry", async () => {
    const user = userEvent.setup();
    getResponses = [
      record({
        risks: [],
        grounding: { kept: 1, dropped: 0 },
        focus: {
          entries: [{ file: "src/api.ts", start_line: null, end_line: null, reason: "start" }],
        },
      }),
    ];
    const { onRevealLocation } = renderCard();

    await screen.findByText("start");
    await user.click(screen.getByRole("button", { name: /Open this location/ }));

    expect(onRevealLocation).toHaveBeenCalledWith("src/api.ts", null);
  });

  it("AC-42 / AC-66 marks an unresolvable citation and reveals it with a NULL line", async () => {
    const user = userEvent.setup();
    getResponses = [record({ focus: { entries: [] } })];
    const onRevealLocation = vi.fn();
    renderCard({ onRevealLocation, citationInDiff: () => false });

    await screen.findByText(RISK.title);
    // The not-in-diff mark is in the accessibility tree, not colour-only.
    expect(
      screen.getByLabelText("This location is not in the diff the studio loaded."),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /Open this location/ }));
    expect(onRevealLocation).toHaveBeenCalledWith("src/config.ts", null);
  });

  it("AC-49 performs the same reveal on Enter and on Space", async () => {
    const user = userEvent.setup();
    getResponses = [record({ focus: { entries: [] } })];
    const onRevealLocation = vi.fn();
    renderCard({ onRevealLocation });

    await screen.findByText(RISK.title);
    const control = screen.getByRole("button", { name: /Open this location/ });

    control.focus();
    await user.keyboard("{Enter}");
    expect(onRevealLocation).toHaveBeenLastCalledWith("src/config.ts", 12);

    onRevealLocation.mockClear();
    control.focus();
    await user.keyboard(" ");
    expect(onRevealLocation).toHaveBeenLastCalledWith("src/config.ts", 12);
  });
});

// ---------------------------------------------------------------- AC-45 / 46

describe("untrusted strings", () => {
  const LONG_PATH =
    "packages/services/payments/src/infrastructure/adapters/http/middleware/rate-limit.ts";

  /** `.` and `-` are the live metacharacters in a path; escape the lot anyway. */
  const escapeRegex = (v: string) => v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  it("AC-45 truncates a long path visually and keeps the full value as the accessible name", async () => {
    getResponses = [record({ risks: [{ ...RISK, file: LONG_PATH }], focus: { entries: [] } })];
    renderCard();

    await screen.findByText(RISK.title);
    // Located THROUGH the accessibility tree by the untruncated value. `aria-label`
    // wins the accessible-name computation over `title`, so this query — not the
    // `title` assertion below — is what fails if the full path never reaches the
    // name. Querying by the generic action string would pass either way.
    const control = screen.getByRole("button", {
      name: new RegExp(escapeRegex(`${LONG_PATH}:12`)),
    });
    // The name carries the action too, so the control is still announced as
    // something a screen-reader user can act on rather than as a bare path.
    expect(control).toHaveAccessibleName(
      `${LONG_PATH}:12 — Open this location in the Files changed tab`,
    );
    // The rendered label IS truncated…
    expect(control.textContent).not.toContain(LONG_PATH);
    expect(control.textContent).toContain("…");
    expect(control.textContent).toBe(`${truncatePath(LONG_PATH)}:12`);
    // …while the untruncated value stays reachable on hover as well.
    expect(control).toHaveAttribute("title", `${LONG_PATH}:12`);
  });

  it("AC-45 keeps a 400-character risk title as its element's accessible name", async () => {
    const longTitle = `Retry loop can spin forever ${"x".repeat(380)}`;
    getResponses = [record({ risks: [{ ...RISK, title: longTitle }] })];
    renderCard();

    const el = await screen.findByLabelText(longTitle);
    expect(el).toHaveAttribute("title", longTitle);
    expect(el.textContent).toBe(longTitle);
  });

  it("AC-46 renders markup and a javascript: URL as literal text, producing no anchor", async () => {
    const hostile = '<b>bold</b> javascript:alert(1)';
    getResponses = [record({ risks: [{ ...RISK, title: hostile }] })];
    const { container } = render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <NextIntlClientProvider locale="en" messages={{ prReview }}>
          <BriefCard prId="pr-1" headSha={HEAD} />
        </NextIntlClientProvider>
      </QueryClientProvider>,
    );

    expect(await screen.findByText(hostile)).toBeInTheDocument();
    expect(container.querySelector("b")).toBeNull();
    expect(screen.queryByRole("link")).toBeNull();
  });
});

// -------------------------------------------------------------------- AC-44

describe("AC-44 cost", () => {
  it.each([
    [null, "Cost n/a"],
    [0, "Cost $0.00"],
    [0.0042, "Cost $0.0042"],
  ])("renders %s through the shared formatter as %s", async (cost, expected) => {
    getResponses = [record({ cost_usd: cost as number | null })];
    renderCard();
    expect(await screen.findByText(expected)).toBeInTheDocument();
    cleanup();
  });
});

// ------------------------------------------------------------ AC-34/35/48

describe("the derivation flow", () => {
  it("AC-34 keeps re-reading while the stored head lags, and stops once it matches", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    // Stale, stale, then fresh; every later read reuses the fresh one.
    getResponses = [
      record({ head_sha: "old" }),
      record({ head_sha: "old" }),
      record({ head_sha: HEAD }),
    ];
    renderCard();

    await screen.findByText("Re-derive");
    await user.click(screen.getByRole("button", { name: "Re-derive" }));
    await waitFor(() => expect(postCalls).toBe(1));

    // Poll until the server's own state says fresh.
    await waitFor(() => expect(screen.queryByText("Stale — the head moved")).toBeNull(), {
      timeout: 10_000,
    });
    const settled = getCalls;

    // …and no further reads once it matches.
    await vi.advanceTimersByTimeAsync(8_000);
    expect(getCalls).toBe(settled);
  }, 20_000);

  it("AC-35 / AC-48 returns the control to idle after the bounded wait, and announces it", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    // Never becomes fresh: a stuck derivation writes NO row, so only the
    // client-side bound can end this wait.
    getResponses = [record({ head_sha: "old" })];
    renderCard();

    await screen.findByText("Re-derive");
    await user.click(screen.getByRole("button", { name: "Re-derive" }));

    // AC-48 — the status region announces the new state.
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent("Deriving the risk brief…"),
    );

    await vi.advanceTimersByTimeAsync(DERIVE_TIMEOUT_MS + 1_000);

    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent(
        "The derivation did not finish in time. Try again.",
      ),
    );
    // The control is back to its idle accessible name, not a permanent spinner.
    expect(screen.getByRole("button", { name: "Re-derive" })).toBeEnabled();
  }, 20_000);

  it("AC-48 announces readiness once the brief lands", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    getResponses = [null, record()];
    renderCard();

    await screen.findByRole("button", { name: "Derive brief" });
    await user.click(screen.getByRole("button", { name: "Derive brief" }));

    await waitFor(
      () => expect(screen.getByRole("status")).toHaveTextContent("The risk brief is ready."),
      { timeout: 10_000 },
    );
  }, 20_000);
});
