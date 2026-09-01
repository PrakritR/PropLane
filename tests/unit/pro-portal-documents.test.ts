import { describe, expect, it } from "vitest";
import { FREE_SUBSCRIPTION_SECTIONS, managerSectionAllowedForTier } from "@/lib/manager-access";
import { proPortal } from "@/lib/portals/pro";

describe("pro portal documents section", () => {
  it("includes documents and finances nav sections", () => {
    const sections = proPortal.sections.map((s) => s.section);
    expect(sections).toContain("documents");
    expect(sections).toContain("financials");
  });

  it("documents tabs include library, templates, applications, leases, income/expense docs, occupancy, 1099, and tax summary", () => {
    const documents = proPortal.sections.find((s) => s.section === "documents");
    expect(documents?.tabs.map((t) => t.id)).toEqual([
      "library",
      "templates",
      "applications",
      "leases",
      "income-documents",
      "expense-documents",
      "occupancy",
      "1099",
      "tax-summary",
    ]);
  });

  it("finances tabs are income and expenses", () => {
    const financials = proPortal.sections.find((s) => s.section === "financials");
    expect(financials?.label).toBe("Finances");
    expect(financials?.tabs.map((t) => t.id)).toEqual([
      "income",
      "expenses",
      "trial-balance",
      "balance-sheet",
      "general-ledger",
      "cash-flow-statement",
      "payout-history",
      "trust-account-balance",
      "security-deposits",
      "financial-diagnostics",
      "ap-aging",
      "bills",
      "budget-vs-actual",
      "bank-reconciliation",
      "owner-statement",
      "owner-distributions",
    ]);
  });

  it("orders leasing → tenancy → operations → marketing → team → finances, then feedback before profile", () => {
    const sections = proPortal.sections.map((s) => s.section);
    expect(sections.indexOf("properties")).toBeLessThan(sections.indexOf("applications"));
    expect(sections.indexOf("applications")).toBeLessThan(sections.indexOf("leases"));
    expect(sections.indexOf("leases")).toBeLessThan(sections.indexOf("residents"));
    expect(sections.indexOf("residents")).toBeLessThan(sections.indexOf("payments"));
    expect(sections.indexOf("payments")).toBeLessThan(sections.indexOf("services"));
    expect(sections.indexOf("services")).toBeLessThan(sections.indexOf("tasks"));
    expect(sections.indexOf("tasks")).toBeLessThan(sections.indexOf("communication"));
    expect(sections.indexOf("communication")).toBeLessThan(sections.indexOf("teams"));
    expect(sections.indexOf("teams")).toBeLessThan(sections.indexOf("promotion"));
    expect(sections.indexOf("promotion")).toBeLessThan(sections.indexOf("financials"));
    expect(sections.indexOf("financials")).toBeLessThan(sections.indexOf("documents"));
    expect(sections.indexOf("documents")).toBeLessThan(sections.indexOf("bugs-feedback"));
    expect(sections.indexOf("teams")).toBeLessThan(sections.indexOf("bugs-feedback"));
    // Feedback comes before profile — that is the ordering rule this case is
    // named for. It is deliberately NOT an adjacency check: the "app" section
    // now sits between them, and a new tail section landing there is a normal
    // addition, not a regression in the order.
    expect(sections.indexOf("bugs-feedback")).toBeLessThan(sections.indexOf("profile"));
    expect(sections).not.toContain("plan");
  });

  it("services is one list, with vendors its own section under Team", () => {
    // The Requests / Work orders split became the `kind` on each row, and Vendors moved to Team.
    const services = proPortal.sections.find((s) => s.section === "services");
    expect(services?.tabs.map((t) => t.id)).toEqual([]);
    const teams = proPortal.sections.find((s) => s.section === "teams");
    expect(teams?.tabs.find((tab) => tab.id === "vendors")?.label).toBe("Vendors");
  });

  it("locks documents and financials for free tier", () => {
    expect(managerSectionAllowedForTier("documents", "free")).toBe(false);
    expect(managerSectionAllowedForTier("financials", "free")).toBe(false);
    expect(managerSectionAllowedForTier("documents", "paid")).toBe(true);
    expect(managerSectionAllowedForTier("financials", "paid")).toBe(true);
  });

  it("marks paid-only sections tierLocked for free users", () => {
    const locked = proPortal.sections
      .filter((s) => !FREE_SUBSCRIPTION_SECTIONS.has(s.section))
      .map((s) => s.section);
    expect(locked).toContain("documents");
    expect(locked).toContain("financials");
    expect(locked).not.toContain("properties");
  });
});
