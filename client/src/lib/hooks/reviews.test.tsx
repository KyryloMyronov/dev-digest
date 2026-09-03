/**
 * useFindingAction — Accept / Dismiss must update the card WITHOUT a reload.
 *
 * Mocked at the FETCH boundary with a real QueryClient: the cached reviews list
 * is what FindingsTab renders, so the assertion is on that cache — the server's
 * finding lands in it the moment the POST resolves, and the list is then
 * refetched so anything else derived from it (the Smart Diff overlay) follows.
 * The refetch is left pending on purpose (see `fetchMock`).
 */
import React from "react";
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReviewRecord } from "@devdigest/shared";
import { useFindingAction } from "./reviews";
import { reviewKeys } from "./keys";

const PR = "pr-1";

const FINDING: ReviewRecord["findings"][number] = {
  id: "f1",
  severity: "WARNING",
  category: "bug",
  title: "Retry loop has no maximum attempt ceiling",
  file: "src/queue.ts",
  start_line: 10,
  end_line: 12,
  rationale: "r",
  suggestion: null,
  confidence: 0.9,
  kind: "finding",
  trifecta_components: null,
  evidence: null,
  review_id: "r1",
  accepted_at: null,
  dismissed_at: null,
};

const REVIEWS: ReviewRecord[] = [
  {
    id: "r1",
    pr_id: PR,
    agent_id: "a1",
    agent_name: "Security Reviewer",
    summary: "s",
    verdict: "needs_work",
    created_at: "2026-09-03T00:00:00.000Z",
    findings: [FINDING],
  } as unknown as ReviewRecord,
];

const ACCEPTED = { ...FINDING, accepted_at: "2026-09-03T18:43:32.350Z" };

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === "POST" && url.endsWith("/findings/f1/accept")) {
      return new Response(JSON.stringify({ finding: ACCEPTED }), { status: 200 });
    }
    // The refetch NEVER resolves here, so the only way `accepted_at` can reach
    // the cache is the direct patch — this is what makes the tests below fail
    // on the invalidate-only version of the hook.
    if (url.endsWith(`/pulls/${PR}/reviews`)) {
      return new Promise<Response>(() => {});
    }
    return new Response("[]", { status: 200 });
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => vi.unstubAllGlobals());

function setup() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: 30_000 } },
  });
  qc.setQueryData(reviewKeys.byPr(PR), REVIEWS);
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  return { qc, ...renderHook(() => useFindingAction(), { wrapper }) };
}

describe("useFindingAction", () => {
  it("writes the server's finding into the cached reviews list as soon as the POST resolves", async () => {
    const { qc, result } = setup();

    result.current.mutate({ findingId: "f1", action: "accept", prId: PR });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    const cached = qc.getQueryData<ReviewRecord[]>(reviewKeys.byPr(PR));
    expect(cached?.[0]?.findings[0]?.accepted_at).toBe(ACCEPTED.accepted_at);
  });

  it("still invalidates the PR's reviews so the list is refetched, not only patched", async () => {
    const { qc, result } = setup();

    result.current.mutate({ findingId: "f1", action: "accept", prId: PR });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(qc.getQueryState(reviewKeys.byPr(PR))?.isInvalidated).toBe(true);
  });

  it("patches every cached reviews list when the caller passes no prId", async () => {
    const { qc, result } = setup();

    result.current.mutate({ findingId: "f1", action: "accept" });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    const cached = qc.getQueryData<ReviewRecord[]>(reviewKeys.byPr(PR));
    expect(cached?.[0]?.findings[0]?.accepted_at).toBe(ACCEPTED.accepted_at);
  });
});
