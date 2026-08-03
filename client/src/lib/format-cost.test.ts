import { describe, it, expect } from "vitest";
import { formatCost } from "./format-cost";

describe("formatCost", () => {
  it("renders the caller's placeholder for null and undefined", () => {
    expect(formatCost(null, "—")).toBe("—");
    expect(formatCost(undefined, "n/a")).toBe("n/a");
  });

  it("keeps a genuinely free model distinct from an unpriced one", () => {
    // z-ai/glm-4.7-flash is priced at 0 — that is a fact, not a missing value.
    expect(formatCost(0, "n/a")).toBe("$0.00");
  });

  it("floors at the precision it actually renders", () => {
    expect(formatCost(0.0000042, "—")).toBe("<$0.0001");
  });

  it("uses 4 decimals below one cent", () => {
    expect(formatCost(0.0042, "—")).toBe("$0.0042");
    expect(formatCost(0.0001, "—")).toBe("$0.0001");
  });

  it("uses 2 decimals at or above one cent", () => {
    expect(formatCost(0.01, "—")).toBe("$0.01");
    expect(formatCost(0.42, "—")).toBe("$0.42");
    expect(formatCost(12.5, "—")).toBe("$12.50");
  });
});