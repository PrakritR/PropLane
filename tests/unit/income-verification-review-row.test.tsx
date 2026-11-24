// @vitest-environment jsdom
//
// The manager's application review draws the Plaid income fact as one plain label/value row. AGENTS.md § Portal UI
// system: "No pills on rows" — a status chip is never how a fact is shown.
import { afterEach, describe, expect, it } from "vitest";
import React from "react";
import { cleanup, render, screen } from "@testing-library/react";

import { ManagerApplicationReadonlyReview } from "@/components/portal/pro-application-readonly-review";
import type { IncomeVerification } from "@/lib/screening/income-verification";

afterEach(() => cleanup());

const verified: IncomeVerification = {
  source: "plaid",
  monthlyIncomeCents: 485000,
  months: 3,
  depositCount: 6,
  historyDays: 90,
  verifiedAt: "2026-11-18T00:00:00.000Z",
};

describe("manager application review: the income fact", () => {
  it("renders stated vs verified as the Income row's value, with no pill around it", () => {
    render(
      <ManagerApplicationReadonlyReview
        partial={{ monthlyIncome: "4800" }}
        incomeVerification={verified}
        omitSections={["group", "cosigner", "placement", "housing", "property", "personal", "address", "references", "additional", "custom", "consent"]}
      />,
    );
    const value = screen.getByText("$4,800/mo stated · ✓ $4,850/mo avg of payroll deposits, last 90 days (6 deposits)");
    // The row is a <dt>/<dd> pair of the Employment card, and nothing in its chain is a rounded chip.
    expect(value.closest("dd")).not.toBeNull();
    expect(value.closest("dd")!.previousElementSibling?.textContent).toBe("Income");
    expect(value.closest("dd")!.querySelector(".rounded-full")).toBeNull();
    expect(value.className).not.toMatch(/rounded-full/);
  });

  it("draws no Income row at all without a verification", () => {
    render(
      <ManagerApplicationReadonlyReview
        partial={{ monthlyIncome: "4800" }}
        omitSections={["group", "cosigner", "placement", "housing", "property", "personal", "address", "references", "additional", "custom", "consent"]}
      />,
    );
    expect(screen.queryByText(/avg of payroll deposits/)).toBeNull();
    expect(screen.queryByText("Income")).toBeNull();
  });
});
