// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ExpenseTaxStatusToggle } from "@/components/portal/expense-tax-status-toggle";

describe("ExpenseTaxStatusToggle", () => {
  it("renders two separate buttons and reports the pressed choice", () => {
    const onChange = vi.fn();
    const { container } = render(<ExpenseTaxStatusToggle deductible onChange={onChange} />);
    const deductible = screen.getByRole("button", { name: "Deductible" });
    const nonDeductible = screen.getByRole("button", { name: "Non-deductible" });
    expect(deductible).toHaveAttribute("aria-pressed", "true");
    expect(nonDeductible).toHaveAttribute("aria-pressed", "false");
    expect(container.firstElementChild?.className).toContain("gap-2");
    expect(container.firstElementChild?.className).not.toContain("rounded-full");
    fireEvent.click(nonDeductible);
    expect(onChange).toHaveBeenCalledWith(false);
  });
});
