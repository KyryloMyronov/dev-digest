import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { PrIntentRecord } from "@devdigest/shared";
import prReviewMessages from "../../../../../../../../messages/en/prReview.json";
import { IntentCard } from "./IntentCard";

/**
 * The card exists to make two things visible that the intent text alone hides:
 * that a reading came from indirect signals rather than documentation, and that
 * it may describe code the PR has since moved past. Both are asserted here —
 * they are the difference between "a confident sentence" and an honest one.
 */

const DOCUMENTED: PrIntentRecord = {
  pr_id: "pr-1",
  intent: "The nightly sync dies whenever upstream rate-limits; make it retry instead.",
  in_scope: ["retry with backoff on 429"],
  out_of_scope: ["changing the sync schedule"],
  change_type: "bugfix",
  confidence: 0.9,
  sources: ["title", "pr_body"],
  derived_from: "documented",
  provider: "openrouter",
  model: "deepseek/deepseek-v4-flash",
  cost_usd: 0.00008,
  head_sha: "abc1234",
  created_at: "2026-08-17T08:00:00.000Z",
};

let record: PrIntentRecord | null;
let getStatus: number;
let sent: { method: string; url: string }[];

beforeEach(() => {
  record = DOCUMENTED;
  getStatus = 200;
  sent = [];

  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (method !== "GET") sent.push({ method, url });
      const json = (data: unknown, status = 200) =>
        new Response(JSON.stringify(data), {
          status,
          headers: { "content-type": "application/json" },
        });
      if (String(url).includes("/intent")) {
        if (method === "POST") return json(DOCUMENTED);
        if (getStatus !== 200) {
          return json({ error: { code: "boom", message: "intent lookup failed" } }, getStatus);
        }
        return json(record);
      }
      return json({ ok: true });
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function renderCard(headSha: string | null = "abc1234") {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <NextIntlClientProvider locale="en" messages={{ prReview: prReviewMessages }}>
        <IntentCard prId="pr-1" headSha={headSha} />
      </NextIntlClientProvider>
    </QueryClientProvider>,
  );
}

describe("IntentCard", () => {
  it("renders the intent, its category and its scope claims", async () => {
    renderCard();
    expect(await screen.findByText(/nightly sync dies/i)).toBeInTheDocument();
    expect(screen.getByText("Bug fix")).toBeInTheDocument();
    expect(screen.getByText("retry with backoff on 429")).toBeInTheDocument();
    expect(screen.getByText("changing the sync schedule")).toBeInTheDocument();
    // Scope is presented as a claim, never as a limit on the review.
    expect(screen.getByText(/not a limit on what the review checks/i)).toBeInTheDocument();
  });

  it("warns when the reading came from indirect signals only", async () => {
    record = {
      ...DOCUMENTED,
      derived_from: "indirect",
      confidence: 0.45,
      sources: ["title", "branch", "files"],
    };
    renderCard();
    expect(await screen.findByText(/Derived from indirect signals/i)).toBeInTheDocument();
    expect(screen.getByText("45% conf")).toBeInTheDocument();
  });

  it("does NOT warn when the reading is documented", async () => {
    renderCard();
    await screen.findByText(/nightly sync dies/i);
    expect(screen.queryByText(/Derived from indirect signals/i)).not.toBeInTheDocument();
  });

  it("flags a derivation whose head has moved on", async () => {
    renderCard("NEWSHA");
    expect(await screen.findByText(/Stale/i)).toBeInTheDocument();
  });

  it("offers to derive when nothing has been derived yet, and POSTs on click", async () => {
    record = null;
    renderCard();
    const btn = await screen.findByRole("button", { name: /Derive intent/i });
    await userEvent.click(btn);
    await waitFor(() => expect(sent.some((r) => r.method === "POST")).toBe(true));
  });

  it("shows a retryable error state when the lookup fails", async () => {
    getStatus = 500;
    renderCard();
    expect(await screen.findByText(/Could not load the PR intent/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /retry/i })).toBeInTheDocument();
  });

  it("never spends a model call just by rendering", async () => {
    renderCard();
    await screen.findByText(/nightly sync dies/i);
    expect(sent).toHaveLength(0);
  });
});
