// @vitest-environment jsdom
//
// M016 — sortable table with row-travel (FLIP) on admin's Plan-credit table,
// the one place AGENTS.md still allows a raw <table>. Clicking a header
// sorts client-side (on the last-saved values, not an in-progress edit) and
// sets aria-sort + a live sort announcement; row-travel itself is asserted
// separately via useFlipRows's own contract (flip-rows respects reduced
// motion and only transforms a row whose measured position actually moved).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { PlanCreditRulesSection } from "@/components/portal/admin-billing-client";

const RULES = [
  { tier: "free", includedCents: 0, sharedAcrossWorkspaces: false, rollsOver: false, updatedAt: "2026-01-01T00:00:00.000Z" },
  { tier: "pro", includedCents: 500, sharedAcrossWorkspaces: true, rollsOver: true, updatedAt: "2026-01-01T00:00:00.000Z" },
  { tier: "business", includedCents: 2000, sharedAcrossWorkspaces: true, rollsOver: true, updatedAt: "2026-01-01T00:00:00.000Z" },
];

function jsonResponse(body: unknown): Response {
  return { ok: true, json: async () => body } as Response;
}

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => jsonResponse({ rules: RULES })),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function rowOrder() {
  return Array.from(document.querySelectorAll("tbody tr td:first-child")).map((td) => td.textContent);
}

describe("PlanCreditRulesSection — M016 sortable table", () => {
  it("renders unsorted in API order with no aria-sort set", async () => {
    render(<PlanCreditRulesSection />);
    await screen.findByText("Free");
    expect(rowOrder()).toEqual(["Free", "Pro", "Business"]);
    expect(screen.getByRole("columnheader", { name: /Plan/ })).toHaveAttribute("aria-sort", "none");
  });

  it("sorts ascending then descending on the Plan header, and announces it", async () => {
    render(<PlanCreditRulesSection />);
    await screen.findByText("Free");

    const planHeader = screen.getByRole("columnheader", { name: /Plan/ });
    fireEvent.click(planHeader);
    expect(planHeader).toHaveAttribute("aria-sort", "ascending");
    expect(rowOrder()).toEqual(["Business", "Free", "Pro"]);
    expect(screen.getByRole("status")).toHaveTextContent("Sorted by Plan, ascending");

    fireEvent.click(planHeader);
    expect(planHeader).toHaveAttribute("aria-sort", "descending");
    expect(rowOrder()).toEqual(["Pro", "Free", "Business"]);
  });

  it("sorts numerically on Included/mo, not lexically", async () => {
    render(<PlanCreditRulesSection />);
    await screen.findByText("Free");
    fireEvent.click(screen.getByRole("columnheader", { name: /Included\/mo/ }));
    expect(rowOrder()).toEqual(["Free", "Pro", "Business"]);
  });

  it("sorts on the last-saved value, not an unsaved in-progress edit", async () => {
    render(<PlanCreditRulesSection />);
    await screen.findByText("Free");
    const freeIncludedInput = screen.getByLabelText("Free included credit in dollars");
    fireEvent.change(freeIncludedInput, { target: { value: "999" } });

    fireEvent.click(screen.getByRole("columnheader", { name: /Included\/mo/ }));
    // Free's real (saved) includedCents is still 0 — the unsaved "999" draft
    // must not have jumped it to the top.
    expect(rowOrder()).toEqual(["Free", "Pro", "Business"]);
    // The draft itself is untouched by the sort/re-render.
    expect((freeIncludedInput as HTMLInputElement).value).toBe("999");
  });

  it("is keyboard-operable — Enter on a header sorts the same as a click", async () => {
    render(<PlanCreditRulesSection />);
    await screen.findByText("Free");
    const planHeader = screen.getByRole("columnheader", { name: /Plan/ });
    fireEvent.keyDown(planHeader, { key: "Enter" });
    expect(planHeader).toHaveAttribute("aria-sort", "ascending");
    expect(rowOrder()).toEqual(["Business", "Free", "Pro"]);
  });
});
