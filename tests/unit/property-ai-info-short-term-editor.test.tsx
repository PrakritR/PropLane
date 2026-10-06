/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { createDefaultListingSubmission } from "@/lib/manager-listing-submission";

const state = vi.hoisted(() => ({ sub: null as unknown, saved: [] as unknown[] }));

vi.mock("@/lib/manager-property-save-target", () => ({
  resolveManagerListingSubmissionForPropertyId: () => ({ sub: state.sub, saveTarget: { kind: "test" } }),
  persistManagerListingSubmissionOnServer: async (_t: unknown, _u: unknown, next: unknown) => {
    state.saved.push(next);
    return true;
  },
}));

import { ManagerPropertyAiInfoPanel } from "@/components/portal/pro-property-ai-info-panel";

beforeEach(() => {
  state.saved = [];
  state.sub = {
    ...createDefaultListingSubmission(),
    allowedLeaseTerms: ["Long-Term", "Short-Term Stay"],
    marketingNotes: "A quiet craftsman.",
    aiCommunicationInfo: { tours: "", rules: "", pricing: "$1,200 a month.", neighborhood: "" },
    aiCommunicationInfoShortTerm: { pricing: "$95 a night." },
    aiCommunicationCustom: [
      { id: "l1", title: "Lease break", text: "60 days.", group: "leasing", appliesTo: "long_term" },
      { id: "s1", title: "Linen", text: "Weekly.", group: "home", appliesTo: "short_term" },
    ],
  };
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: query.includes("pointer: fine"),
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => true,
  }));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const titles = (c: HTMLElement) =>
  [...c.querySelectorAll(".portal-property-row")].map((r) => r.querySelector("p")?.textContent ?? "");

describe("AI info: Long term / Short term", () => {
  it("shared rows show in both tabs; a one-stay custom row only in its own; the short-term text shows in Short term", () => {
    const { container } = render(<ManagerPropertyAiInfoPanel propertyId="p1" managerUserId="m1" showToast={() => {}} />);
    expect(titles(container)).toContain("About this home");
    expect(titles(container)).toContain("Lease break");
    expect(titles(container)).not.toContain("Linen");
    const pricingLong = container.querySelector('[data-attr="property-ai-info-row-pricing"]')!;
    expect(pricingLong.textContent).toContain("Shared");
    expect(pricingLong.textContent).toContain("$1,200 a month.".length + " chars");

    fireEvent.click(within(container).getByRole("button", { name: /^Short term/ }));
    expect(titles(container)).toContain("About this home");
    expect(titles(container)).toContain("Linen");
    expect(titles(container)).not.toContain("Lease break");
    const pricingShort = container.querySelector('[data-attr="property-ai-info-row-pricing"]')!;
    expect(pricingShort.textContent).toContain("Short term");
    expect(pricingShort.textContent).toContain("$95 a night.".length + " chars");
  });

  it("the editor's 'Different for short term' switch saves the second text; switching it off clears it", async () => {
    const { container } = render(<ManagerPropertyAiInfoPanel propertyId="p1" managerUserId="m1" showToast={() => {}} />);
    fireEvent.click(within(container).getAllByRole("button", { name: /Tours & showings/ })[0]!);
    const dialog = await screen.findByRole("dialog");
    expect(dialog.querySelector('[data-attr="property-ai-info-text-short-term"]')).toBeNull();
    fireEvent.click(dialog.querySelector('[data-attr="property-ai-info-short-term-toggle"]') as HTMLElement);
    fireEvent.change(dialog.querySelector('[data-attr="property-ai-info-text-short-term"]') as HTMLTextAreaElement, {
      target: { value: "Self check-in with a lockbox." },
    });
    fireEvent.click(dialog.querySelector('[data-attr="property-ai-info-save"]') as HTMLElement);
    await vi.waitFor(() => expect(state.saved).toHaveLength(1));
    expect((state.saved[0] as { aiCommunicationInfoShortTerm: unknown }).aiCommunicationInfoShortTerm).toEqual({
      pricing: "$95 a night.",
      tours: "Self check-in with a lockbox.",
    });
  });
});
