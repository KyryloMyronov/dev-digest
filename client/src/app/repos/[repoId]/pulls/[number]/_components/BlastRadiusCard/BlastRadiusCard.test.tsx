/**
 * BlastRadiusCard — the load-bearing behaviours:
 *  - a caller's file:line links to the PR head sha on github (the "opens the
 *    right place in code" contract),
 *  - a non-full status renders the reason banner instead of masking gaps,
 *  - empty-but-full renders the honest "no downstream callers" note.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import type { BlastResponse } from "@devdigest/shared";
import messages from "../../../../../../../../messages/en/blast.json";

const blastQuery = vi.fn();
vi.mock("@/lib/hooks/blast", () => ({
  useBlastRadius: () => blastQuery(),
}));

import { BlastRadiusCard } from "./BlastRadiusCard";

afterEach(() => {
  cleanup();
  blastQuery.mockReset();
});

function response(o: Partial<BlastResponse>): BlastResponse {
  return {
    status: "full",
    reason: null,
    changed_files: ["src/middleware/rate-limit.ts"],
    impacts: [],
    endpoints: [],
    ...o,
  };
}

const IMPACT = {
  symbol: "rateLimit",
  file: "src/middleware/rate-limit.ts",
  kind: "function",
  callers: [
    { file: "src/api/public/index.ts", symbol: "buildRouter", line: 23, rank: 0.9 },
    { file: "src/server.ts", symbol: "main", line: 88, rank: 0.4 },
  ],
  callers_truncated: false,
  endpoints_affected: ["GET /api/public/items"],
  crons_affected: ["reset-rate-buckets (hourly)"],
};

function renderTab(data: BlastResponse, onRevealFile = vi.fn()) {
  render(
    <NextIntlClientProvider locale="en" messages={{ blast: messages }}>
      <BlastRadiusCard
        prId="pr-1"
        repoFullName="acme/payments-api"
        headSha="a1b2c3d"
        onRevealFile={onRevealFile}
      />
    </NextIntlClientProvider>,
  );
  return { onRevealFile };
}

function query(data: BlastResponse) {
  blastQuery.mockReturnValue({ data, isPending: false, isError: false, refetch: vi.fn() });
}

describe("BlastRadiusCard", () => {
  it("links a caller's file:line to the PR head sha on github", () => {
    query(response({ impacts: [IMPACT] }));
    renderTab(response({ impacts: [IMPACT] }));

    // Symbol rows start collapsed — expand rateLimit().
    fireEvent.click(screen.getByText("rateLimit()"));

    expect(screen.getByText("src/api/public/index.ts:23").closest("a")).toHaveAttribute(
      "href",
      "https://github.com/acme/payments-api/blob/a1b2c3d/src/api/public/index.ts#L23",
    );
    expect(screen.getByText("src/server.ts:88").closest("a")).toHaveAttribute(
      "href",
      "https://github.com/acme/payments-api/blob/a1b2c3d/src/server.ts#L88",
    );
  });

  it("jumps in-app for the changed symbol's own file (it is in the diff)", () => {
    query(response({ impacts: [IMPACT] }));
    const { onRevealFile } = renderTab(response({ impacts: [IMPACT] }));

    fireEvent.click(screen.getByText("rateLimit()"));
    fireEvent.click(screen.getByText("src/middleware/rate-limit.ts"));

    expect(onRevealFile).toHaveBeenCalledWith("src/middleware/rate-limit.ts");
  });

  it("renders the reason banner when the index is not full", () => {
    query(
      response({
        status: "degraded",
        reason: "the repository has not been indexed yet",
      }),
    );
    renderTab(response({}));

    expect(screen.getByRole("status")).toHaveTextContent("Degraded");
    expect(screen.getByRole("status")).toHaveTextContent(
      "the repository has not been indexed yet",
    );
  });

  it("says 'no downstream callers' instead of showing an empty list", () => {
    const impact = { ...IMPACT, callers: [], endpoints_affected: [], crons_affected: [] };
    query(response({ impacts: [impact] }));
    renderTab(response({ impacts: [impact] }));

    expect(
      screen.getByText("1 changed symbol(s), no downstream callers found."),
    ).toBeInTheDocument();
  });

  it("lists reverse-import endpoints with their chain", () => {
    query(
      response({
        impacts: [IMPACT],
        endpoints: [
          {
            endpoint: "POST /api/public/webhooks",
            file: "src/api/public/webhooks.ts",
            chain: ["src/middleware/rate-limit.ts", "src/api/public/webhooks.ts"],
          },
        ],
      }),
    );
    renderTab(response({}));

    // The endpoint list lives behind the collapsible bar at the card's bottom.
    fireEvent.click(screen.getByText("Potentially affected endpoints"));

    expect(screen.getByText("POST /api/public/webhooks")).toBeInTheDocument();
    expect(
      screen.getByText("src/middleware/rate-limit.ts → src/api/public/webhooks.ts"),
    ).toBeInTheDocument();
  });
});
