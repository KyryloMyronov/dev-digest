/**
 * SPEC-04 — the routed eval case editor: AC-76, AC-77, AC-78, AC-79, AC-112.
 *
 * AC-78 and AC-79 are two DIFFERENT validity states and both are asserted here:
 * malformed text is a syntax badge the client raises live; a schema-invalid
 * expectation is a 422 the server raises at save. Text that parses but has the
 * wrong shape hits the second and not the first, which is exactly the case a
 * single combined badge would hide.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import type { EvalCase } from "@devdigest/shared";
import evalMessages from "../../../../../../../../messages/en/eval.json";
import { ApiError } from "../../../../../../../lib/api";
import { EXPECTATION_OPTIONS } from "./constants";
import { zodPathsFrom } from "./helpers";

const push = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push, replace: vi.fn() }),
  usePathname: () => "/eval/agents/ag1/cases/new",
  useSearchParams: () => new URLSearchParams(),
  useParams: () => ({ agentId: "ag1" }),
}));

vi.mock("../../../../../../../components/app-shell", () => ({
  AppShell: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

const state = {
  existing: undefined as EvalCase | undefined,
  isLoading: false,
  isError: false,
  createError: undefined as unknown,
};
const createMutate = vi.fn();
const updateMutate = vi.fn();
const runMutate = vi.fn();

vi.mock("../../../../../../../lib/hooks/eval", () => ({
  useEvalCase: () => ({
    data: state.existing,
    isLoading: state.isLoading,
    isError: state.isError,
    error: new Error("boom"),
    refetch: vi.fn(),
  }),
  useCreateEvalCase: () => ({
    mutate: createMutate,
    isPending: false,
    error: state.createError,
  }),
  useUpdateEvalCase: () => ({ mutate: updateMutate, isPending: false, error: undefined }),
  useRunEvalCase: () => ({ mutate: runMutate, isPending: false }),
}));

const { EvalCaseEditor } = await import("./EvalCaseEditor");

const CASE: EvalCase = {
  id: "c1",
  owner_kind: "agent",
  owner_id: "ag1",
  name: "stripe-key-leak",
  input_diff: "diff --git a/src/config.ts b/src/config.ts\n+const k = 1;",
  input_files: null,
  input_meta: null,
  expected_output: [{ file: "src/config.ts", start_line: 12, end_line: 12 }],
  expectation: "must_find",
  notes: null,
};

function renderEditor(caseId?: string) {
  return render(
    <NextIntlClientProvider locale="en" messages={{ eval: evalMessages }}>
      <EvalCaseEditor agentId="ag1" caseId={caseId} />
    </NextIntlClientProvider>,
  );
}

beforeEach(() => {
  state.existing = undefined;
  state.isLoading = false;
  state.isError = false;
  state.createError = undefined;
  push.mockClear();
  createMutate.mockClear();
  updateMutate.mockClear();
  runMutate.mockClear();
});
afterEach(cleanup);

describe("AC-76 — the `new` route", () => {
  it("renders an EMPTY editor", () => {
    renderEditor();
    expect(screen.getByText("New eval case")).toBeInTheDocument();
    expect(screen.getByLabelText("Name")).toHaveValue("");
    // Save is disabled until there is something to save.
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  });

  it("offers no `Run case` control before the case exists", () => {
    renderEditor();
    expect(screen.queryByRole("button", { name: "Run case" })).not.toBeInTheDocument();
  });

  it("hydrates from the existing case on the `:caseId` route", () => {
    state.existing = CASE;
    renderEditor("c1");
    expect(screen.getByLabelText("Name")).toHaveValue("stripe-key-leak");
  });
});

describe("AC-77 — the two-option expectation control", () => {
  it("is queryable by role with BOTH options", () => {
    renderEditor();
    const group = screen.getByRole("radiogroup", { name: "Expectation" });
    expect(group).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "must find" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "must not flag" })).toBeInTheDocument();
  });

  it("selects one at a time", () => {
    renderEditor();
    const notFlag = screen.getByRole("radio", { name: "must not flag" });
    expect(notFlag).toHaveAttribute("aria-checked", "false");
    fireEvent.click(notFlag);
    expect(notFlag).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("radio", { name: "must find" })).toHaveAttribute(
      "aria-checked",
      "false",
    );
  });

  it("D-19 — the options are a LOCAL literal array, not an imported Zod enum", () => {
    // A value import from `@devdigest/shared` breaks the browser build while
    // typecheck and vitest both stay green (`client/insights.md` 2026-08-11).
    expect(EXPECTATION_OPTIONS).toEqual(["must_find", "must_not_flag"]);
  });
});

describe("AC-78 — the invalidJson badge is SYNTAX, and live", () => {
  it("shows `invalid JSON` for malformed text and `valid JSON` once it parses", () => {
    renderEditor();
    const editor = screen.getByPlaceholderText(/start_line/);
    fireEvent.change(editor, { target: { value: "[{" } });
    expect(screen.getByText("invalid JSON")).toBeInTheDocument();
    fireEvent.change(editor, { target: { value: "[]" } });
    expect(screen.getByText("valid JSON")).toBeInTheDocument();
  });

  it("disables Save while the text does not parse", () => {
    renderEditor();
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "a-case" } });
    expect(screen.getByRole("button", { name: "Save" })).not.toBeDisabled();
    fireEvent.change(screen.getByPlaceholderText(/start_line/), {
      target: { value: "not json" },
    });
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  });

  it("valid JSON of the WRONG SHAPE is not a syntax error — the two states differ", () => {
    renderEditor();
    fireEvent.change(screen.getByPlaceholderText(/start_line/), {
      target: { value: '[{"nope": 1}]' },
    });
    // Syntactically fine; the schema failure is the server's to report (AC-79).
    expect(screen.getByText("valid JSON")).toBeInTheDocument();
  });
});

describe("AC-79 — the Zod path from the server's 422", () => {
  it("renders the failing path returned in error.details", () => {
    state.createError = new ApiError("Request validation failed", 422, "validation_error", [
      { path: ["expected_output", 0, "start_line"], message: "Expected number" },
    ]);
    renderEditor();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "expected_output.0.start_line: Expected number",
    );
  });

  it("tolerates Fastify's instancePath form as well as ZodError.issues", () => {
    expect(
      zodPathsFrom([{ instancePath: "/expected_output/0/file", message: "Required" }]),
    ).toEqual(["expected_output.0.file: Required"]);
    expect(zodPathsFrom(undefined)).toEqual([]);
    expect(zodPathsFrom("not an array")).toEqual([]);
  });
});

describe("AC-112 — the diff renders as text content", () => {
  it("renders the raw diff verbatim with no HTML sink on the path", () => {
    state.existing = { ...CASE, input_diff: "<script>alert(1)</script>\n+ok" };
    const { container } = renderEditor("c1");
    fireEvent.click(screen.getByText("PR meta"));
    const pane = container.querySelector("pre")!;
    expect(pane.textContent).toBe("<script>alert(1)</script>\n+ok");
    expect(container.querySelector("script")).toBeNull();
  });
});

describe("saving", () => {
  it("sends the named fields and routes back to the Evals tab", () => {
    renderEditor();
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "a-case" } });
    fireEvent.change(screen.getByPlaceholderText(/start_line/), {
      target: { value: '[{"file":"a.ts","start_line":1}]' },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(createMutate).toHaveBeenCalledTimes(1);
    expect(createMutate.mock.calls[0]![0]).toMatchObject({
      owner_kind: "agent",
      owner_id: "ag1",
      name: "a-case",
      expectation: "must_find",
    });
  });

  it("OQ-2 — `Run on save` is client state and is persisted nowhere", () => {
    renderEditor();
    fireEvent.click(screen.getByLabelText("Run on save"));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "a-case" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(Object.keys(createMutate.mock.calls[0]![0])).not.toContain("run_on_save");
  });
});

describe("the Files tab is a Non-goal", () => {
  it("offers only `diff` and `prMeta`", () => {
    renderEditor();
    expect(screen.getByText("Diff")).toBeInTheDocument();
    expect(screen.getByText("PR meta")).toBeInTheDocument();
    expect(screen.queryByText(/^Files$/)).not.toBeInTheDocument();
  });
});
