import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ContextDoc, ContextDocList } from "@devdigest/shared";
import contextMessages from "../../../../../../../messages/en/context.json";
import shellMessages from "../../../../../../../messages/en/shell.json";
import commonMessages from "../../../../../../../messages/en/common.json";
import { RepoProvider } from "@/lib/repo-context";
import { ProjectContextView } from "./ProjectContextView";

/**
 * The Project Context screen, through the accessibility tree.
 *
 * Covers the six states the plan's step 14 names, plus the AC-13/AC-14 pair —
 * the row's accessible name must be the FULL path while its rendered text is
 * head-truncated. Those two pull in opposite directions, so they are asserted
 * separately against the same row.
 *
 * Mocked at the `fetch` boundary. Worth remembering why the `e2e` suite still
 * exists: a stubbed `fetch` cannot see a server-side join go wrong, which is
 * exactly the class of bug the browser flows catch.
 */

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/repos/r1/context",
  useSearchParams: () => new URLSearchParams(),
  useParams: () => ({ repoId: "r1" }),
}));

const REPO = {
  id: "r1",
  owner: "acme",
  name: "payments-api",
  full_name: "acme/payments-api",
  default_branch: "main",
  last_polled_at: null,
  indexed: true,
};

function doc(over: Partial<ContextDoc> = {}): ContextDoc {
  return {
    path: "specs/public-api.md",
    source: "specs",
    tokens: 412,
    attached_agents: 0,
    size: 2048,
    ...over,
  };
}

const LONG_PATH =
  "packages/services/billing/internal/docs/architecture/decisions/0042-use-idempotency-keys.md";

let list: ContextDocList;
/** Status for GET /repos/:id/context — 200, or a failure branch. */
let listStatus: number;
let listErrorCode: string;
/** Status for GET /repos/:id/context/doc. */
let docStatus: number;
let docBody: string;

beforeEach(() => {
  list = {
    files: [
      doc(),
      doc({ path: "docs/guide/setup.md", source: "docs", tokens: null, attached_agents: 2, size: 900 }),
      doc({ path: LONG_PATH, source: "docs", tokens: 88, size: 400 }),
    ],
    total: 3,
    omitted: 0,
    scanned_at: "2026-08-27T09:30:00.000Z",
  };
  listStatus = 200;
  listErrorCode = "internal_error";
  docStatus = 200;
  docBody = "# Public API\n\nAuth is **required** on every route.\n";

  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      const json = (data: unknown, status = 200) =>
        new Response(JSON.stringify(data), {
          status,
          headers: { "content-type": "application/json" },
        });

      // The shell resolves the active repo from here; without it
      // useRepoNotFound renders RepoNotFound instead of the page.
      if (method === "GET" && url.endsWith("/repos")) return json([REPO]);
      // The shell reads the repo's PRs for the sidebar badge and calls
      // .filter() on the result — a non-array would throw during render and
      // blank the whole tree (client/insights.md).
      if (method === "GET" && url.endsWith("/pulls")) return json([]);

      if (method === "GET" && url.includes("/context/doc")) {
        if (docStatus !== 200) {
          return json(
            { error: { code: "doc_not_found", message: "Document is gone" } },
            docStatus,
          );
        }
        const path = decodeURIComponent(new URL(url, "http://x").searchParams.get("path") ?? "");
        return json({ path, content: docBody, size: docBody.length });
      }

      if (method === "GET" && url.endsWith("/context")) {
        if (listStatus !== 200) {
          return json(
            { error: { code: listErrorCode, message: "Server exploded" } },
            listStatus,
          );
        }
        return json(list);
      }

      if (method === "POST" && url.endsWith("/context/reindex")) {
        return json({ status: "parsing", pct: 0 }, 202);
      }

      return json({ ok: true });
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function renderView() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <NextIntlClientProvider
        locale="en"
        messages={{ context: contextMessages, shell: shellMessages, common: commonMessages }}
      >
        <RepoProvider>
          <ProjectContextView />
        </RepoProvider>
      </NextIntlClientProvider>
    </QueryClientProvider>,
  );
}

describe("ProjectContextView", () => {
  // AC-9 — skeleton rows while the list read is in flight.
  it("renders skeleton rows while the document list is pending (AC-9)", async () => {
    renderView();

    // The list region announces itself busy before any row exists.
    const busy = await screen.findByLabelText("Loading documents");
    expect(busy).toHaveAttribute("aria-busy", "true");
    expect(screen.queryByRole("list", { name: "Discovered documents" })).not.toBeInTheDocument();

    // …and is replaced by the real list once the read settles.
    expect(await screen.findByRole("list", { name: "Discovered documents" })).toBeInTheDocument();
  });

  /**
   * AC-13 and AC-14 together, on the same row.
   *
   * AC-13: the accessible name EQUALS the full repository-relative path — no
   * transformation at all, which is what makes unicode / emoji / RTL paths safe.
   * AC-14: the visible text is head-truncated but still contains the basename.
   */
  it("names each row by its full path while truncating the visible text (AC-13, AC-14)", async () => {
    renderView();

    // AC-13 — an exact-name role query only matches if the name is byte-equal.
    const row = await screen.findByRole("button", { name: LONG_PATH });
    expect(row).toHaveAccessibleName(LONG_PATH);

    // AC-14 — the rendered text is shortened, head-first, basename intact.
    const rendered = row.textContent ?? "";
    expect(rendered).not.toContain(LONG_PATH);
    expect(rendered).toContain("…");
    expect(rendered).toContain("0042-use-idempotency-keys.md");
  });

  it("keeps a non-ASCII path byte-identical in the accessible name (AC-13)", async () => {
    const unicodePath = "docs/spécifications/加密/🔐-secrets.md";
    list = { ...list, files: [doc({ path: unicodePath, source: "docs" })], total: 1 };
    renderView();

    expect(await screen.findByRole("button", { name: unicodePath })).toHaveAccessibleName(
      unicodePath,
    );
  });

  // AC-11 + AC-12's happy half: select a row, read rendered Markdown, no editor.
  it("renders a selected document as read-only Markdown with no editing control (AC-11)", async () => {
    const user = userEvent.setup();
    renderView();

    await user.click(await screen.findByRole("button", { name: "specs/public-api.md" }));

    // Rendered, not raw: the heading became an <h1> and the bold became <strong>.
    expect(await screen.findByRole("heading", { name: "Public API" })).toBeInTheDocument();
    expect(screen.getByText("required").tagName).toBe("STRONG");
    expect(screen.queryByText("# Public API")).not.toBeInTheDocument();

    // Read-only: no textbox, and no save/edit/delete/upload affordance anywhere.
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    for (const label of [/save/i, /edit/i, /delete/i, /upload/i, /new document/i]) {
      expect(screen.queryByRole("button", { name: label })).not.toBeInTheDocument();
    }
  });

  // AC-12 — the preview fails alone; the list stays interactive.
  it("shows an inline preview error while the list stays usable (AC-12)", async () => {
    const user = userEvent.setup();
    docStatus = 404;
    renderView();

    await user.click(await screen.findByRole("button", { name: "specs/public-api.md" }));

    expect(await screen.findByText("Couldn’t load this document")).toBeInTheDocument();
    // The list is still there, and a DIFFERENT row is still clickable.
    const other = screen.getByRole("button", { name: "docs/guide/setup.md" });
    expect(other).toBeEnabled();
    await user.click(other);
    expect(await screen.findByRole("button", { name: "docs/guide/setup.md" })).toHaveAttribute(
      "aria-current",
      "true",
    );
  });

  // AC-10 — an error state with a retry control, in the accessibility tree.
  it("renders an error state with a working retry control (AC-10)", async () => {
    const user = userEvent.setup();
    listStatus = 500;
    renderView();

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Couldn’t load this repository’s documents");
    const retry = screen.getByRole("button", { name: /retry/i });

    // Retry actually re-reads: flip the stub to success and click.
    listStatus = 200;
    await user.click(retry);
    expect(await screen.findByRole("list", { name: "Discovered documents" })).toBeInTheDocument();
  });

  // AC-8 — the empty state names all three roots.
  it("renders an empty state naming specs/, docs/ and insights/ (AC-8)", async () => {
    list = { files: [], total: 0, omitted: 0, scanned_at: null };
    renderView();

    expect(await screen.findByText("No documents found")).toBeInTheDocument();
    const body = screen.getByText(/DevDigest reads Markdown/);
    for (const root of ["specs/", "docs/", "insights/"]) {
      expect(body).toHaveTextContent(root);
    }
    // The old copy pointed at `.devdigest/specs/`, which was wrong on every
    // count — pin that it is gone.
    expect(body).not.toHaveTextContent(".devdigest");
  });

  /**
   * AC-5 — a distinct state from AC-8, not a variant of it. The list read fails
   * with 409 `repo_not_cloned`, and the copy names the repository.
   */
  it("renders a still-cloning state naming the repository on 409 (AC-5)", async () => {
    listStatus = 409;
    listErrorCode = "repo_not_cloned";
    renderView();

    expect(await screen.findByText("This repository is still cloning")).toBeInTheDocument();
    // Scoped to the state's own copy: the shell's repo switcher renders the same
    // full name, so an unscoped text query matches two nodes and proves nothing
    // about THIS message naming the repository.
    expect(screen.getByText(/has not finished cloning acme\/payments-api yet/)).toBeInTheDocument();
    // NOT the empty state, and not the generic load error.
    expect(screen.queryByText("No documents found")).not.toBeInTheDocument();
    expect(
      screen.queryByText("Couldn’t load this repository’s documents"),
    ).not.toBeInTheDocument();
  });

  // AC-7 — the cap is reported above the list.
  it("renders a “showing N of M” line when documents were omitted (AC-7)", async () => {
    list = { ...list, total: 612, omitted: 609 };
    renderView();

    expect(await screen.findByText("Showing 3 of 612 documents.")).toBeInTheDocument();
  });

  it("omits the showing-of line when nothing was capped", async () => {
    renderView();
    await screen.findByRole("list", { name: "Discovered documents" });
    expect(screen.queryByText(/Showing \d+ of/)).not.toBeInTheDocument();
  });

  // AC-16 — the footer carries the discovered count and the scan time.
  it("renders the discovered count and the scan time in the footer (AC-16)", async () => {
    renderView();

    expect(await screen.findByText("3 documents discovered")).toBeInTheDocument();
    expect(screen.getByText(/Tokens last counted/)).toBeInTheDocument();
    // Not a chunk count — `code_chunks` is unwritten and out of scope.
    expect(screen.queryByText(/chunks/i)).not.toBeInTheDocument();
  });

  it("says tokens were never counted rather than leaving the slot empty (AC-16)", async () => {
    list = { ...list, scanned_at: null };
    renderView();

    expect(await screen.findByText("Tokens not counted yet")).toBeInTheDocument();
  });

  // AC-35's row half: `null` tokens are pending, not zero.
  it("shows a pending indicator instead of a number for an uncounted document", async () => {
    renderView();

    const uncounted = await screen.findByRole("button", { name: "docs/guide/setup.md" });
    expect(uncounted).toHaveTextContent("counting…");
    expect(uncounted).not.toHaveTextContent("0 tok");
    expect(
      screen.getByRole("button", { name: "specs/public-api.md" }),
    ).toHaveTextContent("412 tok");
  });

  // AC-15's UI half — the detail header names how many agents attach it.
  it("shows the attaching-agent count in the selected document’s header (AC-15)", async () => {
    const user = userEvent.setup();
    renderView();

    await user.click(await screen.findByRole("button", { name: "docs/guide/setup.md" }));
    expect(await screen.findByText("2 agents")).toBeInTheDocument();
  });

  /**
   * NFR-6 — every control on this screen is operable from the keyboard alone.
   * Tabbing reaches a document row and Enter selects it, with no pointer event
   * involved. (This screen has no reorder control; the accepted NFR-6 conflict
   * recorded in the plan is about the Cut-2 attach surface's drag handles.)
   */
  it("selects a document by keyboard alone (NFR-6)", async () => {
    const user = userEvent.setup();
    renderView();
    const row = await screen.findByRole("button", { name: "specs/public-api.md" });

    row.focus();
    expect(row).toHaveFocus();
    await user.keyboard("{Enter}");

    expect(await screen.findByRole("heading", { name: "Public API" })).toBeInTheDocument();
  });

  /**
   * NFR-7 — the focus indicator.
   *
   * Asserted as the MECHANISM, not as a resolved colour: the ring comes from
   * `:focus-visible` in `src/vendor/ui/styles.css`, and vitest's jsdom neither
   * loads that stylesheet (`css: false` in vitest.config.ts) nor implements
   * `:focus-visible`, so `getComputedStyle(...).outline` is empty for every
   * element regardless of correctness. What IS checkable here, and what actually
   * breaks focus in practice, is that the control is a real focusable element
   * rather than a div with an onClick — a div would have no focus indicator to
   * style at all.
   */
  it("makes every list control a natively focusable element (NFR-7)", async () => {
    renderView();
    await screen.findByRole("list", { name: "Discovered documents" });

    for (const row of screen.getAllByRole("button", { name: /\.md$/ })) {
      expect(row.tagName).toBe("BUTTON");
      expect(row).not.toHaveAttribute("tabindex", "-1");
      row.focus();
      expect(row).toHaveFocus();
    }
  });

  it("triggers a reindex from the header control", async () => {
    const user = userEvent.setup();
    renderView();
    await screen.findByRole("list", { name: "Discovered documents" });

    await user.click(screen.getByRole("button", { name: /re-index/i }));

    await waitFor(() => {
      const calls = (globalThis.fetch as unknown as { mock: { calls: [string, RequestInit?][] } })
        .mock.calls;
      expect(
        calls.some(([url, init]) => url.endsWith("/context/reindex") && init?.method === "POST"),
      ).toBe(true);
    });
  });
});
