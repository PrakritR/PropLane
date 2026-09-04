/** @vitest-environment jsdom */
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { ListingRoomDetailTabToggle } from "@/components/portal/pro-listing-room-detail-tabs";

describe("ListingRoomDetailTabToggle", () => {
  it("renders Preview then Move-in details and switches on click", () => {
    const onChange = vi.fn();
    render(<ListingRoomDetailTabToggle value="preview" onChange={onChange} />);

    const tabs = screen.getAllByRole("tab");
    expect(tabs.map((t) => t.textContent)).toEqual(["Preview", "Move-in details"]);
    expect(tabs[0]).toHaveAttribute("aria-selected", "true");

    fireEvent.click(screen.getByRole("tab", { name: "Move-in details" }));
    expect(onChange).toHaveBeenCalledWith("move-in-details");
  });
});
