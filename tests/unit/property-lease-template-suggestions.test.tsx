// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { PropertyLeaseTemplateSuggestions } from "@/components/portal/property-lease-template-suggestions";

describe("PropertyLeaseTemplateSuggestions", () => {
  it("renders seed rows and wires + to onAddSeed", () => {
    const onAddSeed = vi.fn();
    const onAddCustom = vi.fn();

    render(
      <PropertyLeaseTemplateSuggestions
        seeds={[
          {
            seedKey: "primary",
            kind: "long-term",
            label: "Long-term lease",
            applicationLeaseTerms: ["12-Month"],
          },
        ]}
        onAddSeed={onAddSeed}
        onAddCustom={onAddCustom}
      />,
    );

    expect(screen.getByText("Add a lease")).toBeTruthy();
    fireEvent.click(screen.getByLabelText("Add Long-term lease"));
    expect(onAddSeed).toHaveBeenCalledWith("primary");

    fireEvent.click(screen.getByText("Add custom lease"));
    expect(onAddCustom).toHaveBeenCalledOnce();
  });
});
