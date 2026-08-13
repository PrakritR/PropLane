// @vitest-environment jsdom
/**
 * The seed list offers the PropLane defaults a property does not carry yet.
 *
 * It deliberately does NOT own an "add a custom lease" control any more: the
 * Lease tab renders the shared `PortalListAddRow` for that, so it reads the
 * same as the Requests and Application tabs. Asserting the custom button here
 * again would re-couple the two.
 */
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { PropertyLeaseTemplateSuggestions } from "@/components/portal/property-lease-template-suggestions";

describe("PropertyLeaseTemplateSuggestions", () => {
  it("renders seed rows and wires + to onAddSeed", () => {
    const onAddSeed = vi.fn();

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
      />,
    );

    expect(screen.getByText("Add a lease")).toBeTruthy();
    fireEvent.click(screen.getByLabelText("Add Long-term lease"));
    expect(onAddSeed).toHaveBeenCalledWith("primary");
  });

  it("renders nothing when the property already carries every default", () => {
    const { container } = render(
      <PropertyLeaseTemplateSuggestions seeds={[]} onAddSeed={vi.fn()} />,
    );
    expect(container.textContent?.trim()).toBe("");
  });
});
