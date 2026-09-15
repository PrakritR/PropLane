// @vitest-environment jsdom
//
// The import's Upload step sits BEFORE Basics on the rail — and Add property,
// which passes no leading step, renders its six steps exactly as before.
import { afterEach, describe, expect, it, vi } from "vitest";
import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

vi.mock("@/lib/demo-admin-property-inventory", () => ({
  publishManagerPropertyDraftToServer: vi.fn(),
  saveManagerPropertyDraftToServer: vi.fn(),
}));
vi.mock("@/lib/demo-property-pipeline", () => ({ submitManagerPendingPropertyToServer: vi.fn() }));

import { ListingEditorV2, LISTING_V2_STEPS } from "@/components/portal/listing-wizard-v2/listing-editor";
import { PortalAssistantConfigProvider } from "@/lib/axis-assistant/portal-assistant-context";
import { createDefaultListingSubmission } from "@/lib/manager-listing-submission";

function mount(leading?: { onOpen: () => void }) {
  render(
    <PortalAssistantConfigProvider endpoint="/api/agent/chat" managerName={null}>
      <ListingEditorV2
        title="400 Pike Street"
        submission={{ ...createDefaultListingSubmission(), address: "400 Pike Street" }}
        onChange={() => {}}
        onClose={() => {}}
        onPublish={() => {}}
        leadingStep={leading ? { id: "upload", label: "Upload", summary: "Copy of Sales.xlsx · 6 found", onOpen: leading.onOpen } : undefined}
        headerCenter={leading ? <span data-testid="switcher">1 of 6 · 400 Pike St</span> : undefined}
      />
    </PortalAssistantConfigProvider>,
  );
}

const railButtons = () =>
  Array.from(screen.getByRole("navigation", { name: "Listing sections" }).querySelectorAll("button[data-attr^='listing-v2-rail-']"))
    .filter((b) => b.getAttribute("data-attr") !== "listing-v2-rail-finish" && b.getAttribute("data-attr") !== "listing-v2-rail-add-photos");

afterEach(() => cleanup());

describe("ListingEditorV2 without a leading step (Add property)", () => {
  it("draws the six listing steps, Basics first, Back disabled, and no header slot", () => {
    mount();
    const labels = railButtons().map((b) => b.getAttribute("data-attr"));
    expect(labels).toEqual(LISTING_V2_STEPS.map((s) => `listing-v2-rail-${s.id}`));
    expect(screen.getByRole("button", { name: "Back" })).toBeDisabled();
    expect(screen.queryByTestId("switcher")).toBeNull();
    expect(screen.getByText(/Step 1 of \d/).textContent).toMatch(/^Step 1 of /);
  });
});

describe("ListingEditorV2 with the import's Upload step", () => {
  it("puts Upload first, Basics second, counts it in the footer, and shows the switcher in the header", () => {
    mount({ onOpen: vi.fn() });
    const labels = railButtons().map((b) => b.getAttribute("data-attr"));
    expect(labels[0]).toBe("listing-v2-rail-upload");
    expect(labels[1]).toBe("listing-v2-rail-basics");
    expect(labels).toHaveLength(LISTING_V2_STEPS.length + 1);
    expect(screen.getByRole("navigation", { name: "Listing sections" }).textContent).toContain("Copy of Sales.xlsx · 6 found");
    expect(document.querySelector("[data-attr='listing-v2-rail-basics']")?.getAttribute("aria-current")).toBe("step");
    expect(screen.getByText(/^Step 2 of /)).toBeInTheDocument();
    expect(screen.getByTestId("switcher")).toBeInTheDocument();
  });

  it("hands control back to the caller from the rail and from Back on Basics", () => {
    const onOpen = vi.fn();
    mount({ onOpen });
    fireEvent.click(document.querySelector("[data-attr='listing-v2-rail-upload']")!);
    expect(onOpen).toHaveBeenCalledTimes(1);
    const back = screen.getByRole("button", { name: "Back" });
    expect(back).not.toBeDisabled();
    fireEvent.click(back);
    expect(onOpen).toHaveBeenCalledTimes(2);
    // The listing steps still work as before: jumping to Pricing lands on Pricing.
    fireEvent.click(document.querySelector("[data-attr='listing-v2-rail-pricing']")!);
    expect(document.querySelector("[data-attr='listing-v2-rail-pricing']")?.getAttribute("aria-current")).toBe("step");
  });
});
