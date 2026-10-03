// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, within } from "@testing-library/react";
import { FinancesDataTable } from "@/components/portal/pro-finances-panel";

afterEach(cleanup);
it("uses the shared phone tile and keeps report facts, tax edits, and actions", () => {
  const tax = vi.fn();
  const { container } = render(<FinancesDataTable report={{ id: "expenses", title: "Expenses", columns: [
    { key: "category", label: "Category" }, { key: "property", label: "Property" }, { key: "amount", label: "Amount", format: "money" }, { key: "memo", label: "Description" }, { key: "taxStatus", label: "Tax status" },
  ], rows: [{ id: "expense-1", category: "Repair", property: "Cedar House", amount: "$180", memo: "Replaced kitchen tap", taxDeductible: true }] }} sortKey="category" sortDir="asc" onHeaderSort={() => {}} onTaxStatusChange={tax} onEditExpense={() => {}} onDeleteExpense={() => {}} />);
  const mobile = container.querySelector('[data-attr="finances-mobile-rows"]')! as HTMLElement;
  expect(mobile.querySelector(".portal-property-row")).toBeTruthy();
  expect(mobile.querySelector(".w-14.h-12")).toBeTruthy();
  expect(within(mobile).getByText("Cedar House")).toBeTruthy();
  expect(within(mobile).getAllByText("$180").length).toBeGreaterThan(0);
  expect(within(mobile).getByText("Replaced kitchen tap")).toBeTruthy();
  expect(within(mobile).getByRole("button", { name: "Expense actions" })).toBeTruthy();
  fireEvent.click(within(mobile).getByRole("button", { name: "Non-deductible" }));
  expect(tax).toHaveBeenCalledWith("expense-1", false);
});
