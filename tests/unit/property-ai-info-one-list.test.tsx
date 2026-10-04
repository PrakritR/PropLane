/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createDefaultListingSubmission } from "@/lib/manager-listing-submission";

vi.mock("@/lib/manager-property-save-target", () => ({
  resolveManagerListingSubmissionForPropertyId: () => ({
    sub: {
      ...createDefaultListingSubmission(),
      marketingNotes: "A quiet craftsman near the park.",
      aiCommunicationCustom: [{ id: "c1", title: "Parking", text: "", group: "area" }],
    },
    saveTarget: { kind: "test" },
  }),
  persistManagerListingSubmissionOnServer: async () => true,
}));

import { ManagerPropertyAiInfoPanel } from "@/components/portal/pro-property-ai-info-panel";

beforeEach(() => {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: query.includes("pointer: fine"),
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => true,
  }));
});
afterEach(async () => {
  cleanup();
  await act(async () => {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  });
  vi.unstubAllGlobals();
});

function renderPanel() {
  return render(<ManagerPropertyAiInfoPanel propertyId="p1" managerUserId="m1" showToast={() => {}} />);
}

/** studio-redesign(property-tabs) round 1: AI info is ONE flat list, not four sub-tabs. */
describe("ManagerPropertyAiInfoPanel", () => {
  it("renders one list with no tablist: header count, search, round +, one row per entry", () => {
    const { container } = renderPanel();
    expect(screen.queryByRole("tablist")).toBeNull();
    expect(container.querySelectorAll('[data-slot="local-destination-nav"] button')).toHaveLength(1);
    expect(container.querySelector('[data-slot="local-destination-nav"]')!.textContent).toContain("What the assistant knows");
    expect(container.querySelector('[data-slot="local-destination-nav"]')!.textContent).toContain("6");
    expect(screen.getByRole("button", { name: "Add to what the assistant knows" })).toBeTruthy();
    expect(container.querySelector('[data-attr="property-ai-info-search"]')).toBeTruthy();
    expect(container.querySelector('[data-attr="property-ai-info-tab-home"]')).toBeNull();
    expect(container.querySelectorAll(".portal-property-row")).toHaveLength(6);
  });

  it("orders rows Home, Leasing, Rules, Area and states one fact line each", () => {
    const { container } = renderPanel();
    const rows = Array.from(container.querySelectorAll(".portal-property-row"));
    const categories = rows.map((row) => {
      const text = row.querySelector('[data-attr="record-row-facts"]')!.textContent ?? "";
      return ["Home", "Leasing", "Rules", "Area"].find((c) => text.includes(c));
    });
    expect(categories).toEqual(["Home", "Leasing", "Leasing", "Rules", "Area", "Area"]);
    expect(rows[0]!.textContent).toContain("About this home");
    expect(rows[0]!.textContent).toMatch(/\d+ chars/);
    expect(rows[1]!.textContent).toContain("Not filled in yet");
    rows.forEach((row) => expect(row.querySelectorAll('button[aria-label^="Actions for"]')).toHaveLength(1));
  });

  it("search narrows the one list", () => {
    const { container } = renderPanel();
    fireEvent.change(container.querySelector('[data-attr="property-ai-info-search"]') as HTMLInputElement, {
      target: { value: "parking" },
    });
    expect(container.querySelectorAll(".portal-property-row")).toHaveLength(1);
  });

  it("the add popup has no context column, and the answer mock is its preview (no duplicate field snapshot)", async () => {
    renderPanel();
    fireEvent.click(screen.getByRole("button", { name: "Add to what the assistant knows" }));
    const dialog = await screen.findByRole("dialog", { name: "Add to what the assistant knows" });
    expect(dialog.querySelector("[data-popup-context]")).toBeNull();
    const preview = dialog.querySelector("[data-popup-preview]")!;
    expect(preview).toBeTruthy();
    expect(preview.querySelector('[data-attr="property-ai-info-sample-preview"]')).toBeTruthy();
    expect(preview.textContent).toContain("How the assistant answers");
    expect(preview.textContent).not.toContain("Not set");
    expect(dialog.textContent).toContain("Category");
  });
});
