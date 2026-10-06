/** @vitest-environment jsdom */
// Round 2 of the property redesign. Each block pins one fix from the captain's review.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { ListingDetailSections } from "@/components/marketing/listing-detail-sections";
import { PropertyPricingPanel } from "@/components/portal/property-pricing-panel";
import { MoveInFormChooser } from "@/components/portal/move-in-forms/move-in-form-chooser";
import { PropertyMoveInFormsPanel } from "@/components/portal/move-in-forms/property-move-in-forms-panel";
import { recordSections } from "@/lib/portals/record-sections";
import { PROPERTY_DETAIL_TABS, PROPERTY_DETAIL_TOP_TAB_LABELS, parsePropertyDetailTab } from "@/lib/portal-detail-routes";
import { ServiceOfferingEditModal } from "@/components/portal/service-offering-edit-modal";
import { PropertyAiInfoEditorModal } from "@/components/portal/property-ai-info-editor-modal";
import { displayPropertyTitle } from "@/lib/property-title";
import { createDefaultListingSubmission, normalizeManagerListingSubmissionV1 } from "@/lib/manager-listing-submission";
import type { MockProperty } from "@/data/types";
import type { ListingRichContent } from "@/data/listing-rich-content";

vi.mock("next/navigation", () => ({
  usePathname: () => "/portal/properties/listed/p1/preview",
  useRouter: () => ({ push: () => {}, replace: () => {}, prefetch: () => {} }),
  useSearchParams: () => new URLSearchParams(""),
}));
vi.mock("@/components/marketing/listing-location-block", () => ({ ListingLocationBlock: () => null }));
vi.mock("@/hooks/use-prospect-contact-autofill", () => ({
  useProspectContactAutofill: () => ({ contact: null, loading: false }),
}));
vi.mock("@/lib/portal-mobile-top-chrome", () => ({
  getPortalScrollRoot: () => null,
  syncPortalDetailDestinationOffset: () => 0,
  syncPortalMobileTopChrome: () => 0,
}));

beforeAll(() => {
  window.HTMLElement.prototype.scrollIntoView ??= () => {};
});
beforeEach(() => {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: query.includes("pointer: fine"),
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => true,
  }));
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} unobserve() {} });
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({}) })));
});
afterEach(async () => {
  cleanup();
  await act(async () => {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  });
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

/* 1 ─ the Preview tab's big title */
describe("the Preview tab heading reads the property name once", () => {
  const rich = {
    heroTagline: "",
    heroOverview: "",
    heroHousePhotoUrls: [],
    priceRangeLabel: "From $1,300/mo",
    startingRentLabel: "$1,300/mo",
    pricingBreakdown: [],
    floorPlans: [],
    bathrooms: [],
    sharedSpaces: [],
    leaseBasics: [],
    amenities: [],
    bundlesText: "",
    bundleCards: [],
    quickFacts: [],
  } as unknown as ListingRichContent;

  // A property saved before composePropertyTitle existed carries the doubled title in its stored `title`.
  const stored = {
    id: "prop-magnolia",
    title: "Magnolia House — 5 rooms · 5 rooms",
    buildingName: "Magnolia House — 5 rooms",
    unitLabel: "5 rooms",
    address: "1 Main St",
    neighborhood: "U District",
  } as unknown as MockProperty;

  it("composes the displayed title from the building name and unit label, not the stored one", () => {
    expect(displayPropertyTitle(stored)).toBe("Magnolia House — 5 rooms");
    expect(displayPropertyTitle({ title: "Sample listing" })).toBe("Sample listing");
    expect(displayPropertyTitle({ title: "x", buildingName: "Magnolia House", unitLabel: "Unit 4" })).toBe("Magnolia House · Unit 4");
  });

  it("renders 'Magnolia House — 5 rooms' exactly once in the embedded preview heading", () => {
    render(<ListingDetailSections property={stored} rich={rich} portalEmbedded managerPreviewChrome hidePortalSubnav />);
    const heading = screen.getByRole("heading", { level: 1 });
    expect(heading.textContent).toBe("Magnolia House — 5 rooms");
    expect((heading.textContent?.match(/5 rooms/g) ?? []).length).toBe(1);
  });
});

/* 2 ─ the stuck loading state: see tests/unit/property-route-never-stuck.test.tsx */

/* 3 ─ the new move-in form popup is compact */
describe("the New move-in form chooser is a compact dialog", () => {
  it("is content-sized, not the full popup frame, and keeps Copy from another property", async () => {
    render(
      <MoveInFormChooser
        open
        onClose={() => {}}
        onPick={() => {}}
        copySources={[{ propertyId: "other", label: "Other house", templates: [{ id: "t1", name: "Intake" } as never] }]}
      />,
    );
    const dialog = await screen.findByRole("dialog");
    expect(dialog.className).toContain("!h-auto");
    expect(within(dialog).getByText("Build a form")).toBeTruthy();
    expect(within(dialog).getByText("Upload a PDF")).toBeTruthy();
    expect(within(dialog).getByText("Start from a template")).toBeTruthy();
    expect(within(dialog).getByText("Copy from another property")).toBeTruthy();
  });
});

/* 4 ─ Move-in → Forms empty state has no in-card button */
describe("Move-in → Forms empty state", () => {
  it("says there are no forms and offers no button inside the card; the round + is the only add", () => {
    const sub = normalizeManagerListingSubmissionV1({ ...createDefaultListingSubmission(), moveInFormTemplates: [] });
    render(
      <PropertyMoveInFormsPanel
        sub={sub}
        saveTarget={{ mode: "listing", saveId: "p1" }}
        managerUserId="m1"
        canEdit
        propertyLabel="Magnolia House"
        onUpdated={() => {}}
        showToast={() => {}}
        chooserOpen={false}
        onChooserOpenChange={() => {}}
        stay="long_term"
      />,
    );
    expect(screen.getByText("No long-term move-in forms")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /new form/i })).toBeNull();
    expect(document.querySelector('[data-attr="property-move-in-forms-empty-new"]')).toBeNull();
  });
});

/* 5 ─ Pricing rows all carry a tile */
describe("every Pricing row has an icon tile", () => {
  const sub = normalizeManagerListingSubmissionV1({
    ...createDefaultListingSubmission(),
    rooms: [
      { ...createDefaultListingSubmission().rooms[0]!, id: "r1", name: "Room 1", monthlyRent: 900 },
      { ...createDefaultListingSubmission().rooms[0]!, id: "r2", name: "Room 2", monthlyRent: 900 },
    ],
    bundles: [{ id: "b1", label: "Both", price: "$1,700", includedRoomIds: ["r1", "r2"], roomsLine: "" } as never],
    entireHomeOffered: true,
    entireHomeMonthlyRent: 1700,
  });

  function renderPanel() {
    return render(
      <PropertyPricingPanel
        submission={sub}
        saveTarget={{ mode: "listing", saveId: "p1" } as never}
        managerUserId="mgr-1"
        propertyLabel="Magnolia House"
        onUpdated={() => {}}
        showToast={() => {}}
        workspacePricingDefaults={{ currency: "usd" } as never}
      />,
    );
  }

  it("a room bundle row draws the same square tile as a room row", () => {
    renderPanel();
    const roomRow = document.querySelector('[data-attr="property-pricing-room-row"]')!.closest(".portal-property-row")!;
    expect(roomRow.querySelector("svg")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Room bundles/ }));
    const bundleRow = document.querySelector('[data-attr="property-pricing-bundle-row"]')!.closest(".portal-property-row")!;
    const tile = bundleRow.querySelector("span.bg-accent svg");
    expect(tile).toBeTruthy();
  });

  it("the Whole house row has one too", () => {
    renderPanel();
    fireEvent.click(screen.getByRole("button", { name: /Whole house/ }));
    const row = document.querySelector('[data-attr="property-pricing-whole-row"]')!.closest(".portal-property-row")!;
    expect(row.querySelector("span.bg-accent svg")).toBeTruthy();
  });
});

/* 6 ─ the pricing popup is one screen: see tests/unit/property-room-pricing-fee-rows.test.tsx */

/* 7 ─ Add service popup */
describe("the Add service popup", () => {
  function renderModal() {
    const sub = normalizeManagerListingSubmissionV1(createDefaultListingSubmission());
    return render(
      <ServiceOfferingEditModal
        open
        offering={null}
        isNew
        sub={sub}
        saveTarget={{ mode: "pending", saveId: "t" } as never}
        managerUserId="mgr"
        onClose={() => {}}
        onSaved={() => {}}
        showToast={() => {}}
      />,
    );
  }

  it("does not mark the required Name 'Optional'", () => {
    renderModal();
    const nameRow = screen.getAllByText("Name")[0]!.closest("div.flex")!;
    expect(nameRow.querySelector("[data-field-optional]")).toBeNull();
    // A field that really is optional still says so.
    const descriptionRow = screen.getAllByText("Description")[0]!.closest("div.flex")!;
    expect(descriptionRow.querySelector("[data-field-optional]")).toBeTruthy();
  });

  it("section headings are sentence case, not ALL-CAPS", () => {
    renderModal();
    for (const heading of ["Service", "Pricing", "Requests"]) {
      const el = screen.getAllByText(heading).find((node) => node.tagName === "P" && node.className.includes("font-bold"));
      expect(el, heading).toBeTruthy();
      expect(el!.className).not.toContain("uppercase");
    }
  });

  it("a single-step dialog shows no 'Step 1 of 1' and no 'Complete Service' in the footer", () => {
    renderModal();
    // The footer counter (the phone step picker is the wizard primitives' own control).
    expect(
      screen.queryAllByText(/Step \d+ of \d+/).filter((node) => !node.closest('[data-attr="workspace-step-picker"]')),
    ).toHaveLength(0);
    expect(screen.queryByText(/Complete Service/)).toBeNull();
  });
});

/* 8 ─ AI info add popup */
describe("the 'Add to what the assistant knows' popup", () => {
  it("labels the picker 'Category' in sentence case like Title", async () => {
    render(
      <PropertyAiInfoEditorModal
        open
        target={{ kind: "custom", isNew: true, title: "", sampleQuestion: "Is there parking?" } as never}
        value=""
        onChange={() => {}}
        onClose={() => {}}
        onSave={() => {}}
        showCustomTitle
        customTitle=""
        onCustomTitleChange={() => {}}
        group="home"
        onGroupChange={() => {}}
      />,
    );
    const dialog = await screen.findByRole("dialog");
    const label = within(dialog).getAllByText("Category").find((node) => node.tagName === "LABEL")!;
    expect(label).toBeTruthy();
    expect(label.className).not.toContain("uppercase");
    expect(label.className).toContain("font-semibold");
  });
});

/* 9 ─ Activity left the property rail */
describe("a property has no Activity page", () => {
  it("the property rail has no Activity item", () => {
    const sections = recordSections("manager", "property", { basePath: "/portal" });
    const ids = sections.groups.flatMap((group) => group.items.map((item) => item.id));
    expect(ids).not.toContain("activity");
  });

  it("no property tab list names Activity", () => {
    expect((PROPERTY_DETAIL_TABS as readonly string[]).includes("activity")).toBe(false);
    expect(Object.keys(PROPERTY_DETAIL_TOP_TAB_LABELS)).not.toContain("activity");
  });

  it("an old .../activity URL opens Preview", () => {
    expect(parsePropertyDetailTab("activity")).toBe("preview");
    expect(parsePropertyDetailTab("not-a-tab")).toBe("preview");
    expect(parsePropertyDetailTab("lease")).toBe("lease");
  });
});

void waitFor;
