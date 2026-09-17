// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HouseDetailsExpandable } from "@/components/portal/house-info-sections";

describe("HouseDetailsExpandable", () => {
  it("puts the expand mark after the count and swaps it when opened", async () => {
    const user = userEvent.setup();
    render(
      <HouseDetailsExpandable title="Getting in" count={{ filled: 1, total: 5 }}>
        <p>Front door code</p>
      </HouseDetailsExpandable>,
    );

    const summary = screen.getByText("Getting in").closest("summary");
    expect(summary).toBeTruthy();
    expect(summary!.textContent).toMatch(/Getting in.*1 of 5/);
    expect(summary!.querySelector("svg.lucide-chevron-right")).toBeTruthy();
    expect(summary!.querySelector("svg.lucide-chevron-down")).toBeNull();

    await user.click(summary!);
    expect(screen.getByText("Front door code")).toBeVisible();
    expect(summary!.querySelector("svg.lucide-chevron-down")).toBeTruthy();
    expect(summary!.querySelector("svg.lucide-chevron-right")).toBeNull();
  });
});
