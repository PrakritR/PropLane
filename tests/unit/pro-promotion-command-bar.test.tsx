// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ManagerPromotion } from "@/components/portal/pro-promotion";
import { createFlyerEntry, type ManagerPromotionRow } from "@/lib/promotion-flyer";
import { composeFallbackPromotionText, createPromotionTextEntry } from "@/lib/promotion-text";

const { searchParamsRef, promoRows } = vi.hoisted(() => ({
  searchParamsRef: { current: new URLSearchParams() },
  promoRows: { current: [] as ManagerPromotionRow[] },
}));

vi.mock("next/navigation", () => ({
  usePathname: () => "/portal/promotion",
  useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => {} }),
  useSearchParams: () => searchParamsRef.current,
}));
vi.mock("@/hooks/use-manager-user-id", () => ({
  useManagerUserId: () => ({ userId: "mgr-1", email: "mgr@example.com", ready: true }),
}));
vi.mock("@/components/providers/app-ui-provider", () => ({
  useAppUi: () => ({ showToast: () => {} }),
  useConfirm: () => () => Promise.resolve(true),
}));
vi.mock("@/lib/manager-promotions-storage", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/manager-promotions-storage")>();
  return {
    ...actual,
    readManagerPromotionRows: () => promoRows.current,
    syncManagerPromotionsFromServer: () => Promise.resolve(promoRows.current),
  };
});
vi.mock("@/lib/demo-property-pipeline", () => ({
  PROPERTY_PIPELINE_EVENT: "axis:property-pipeline",
  syncPropertyPipelineFromServer: () => Promise.resolve(true),
}));
vi.mock("@/lib/manager-property-links", () => ({
  buildManagerPromotionPropertyOptions: () => [],
}));
vi.mock("@/lib/manager-portfolio-access", () => ({
  buildManagerPropertyFilterOptions: () => [],
  samePropertyId: (a: string | null | undefined, b: string | null | undefined) => a === b,
}));
vi.mock("@/lib/demo/demo-session", () => ({
  isDemoModeActive: () => false,
}));
vi.mock("@/lib/analytics/track-client", () => ({ track: () => {} }));
vi.mock("@/components/portal/promotion-new-modal", () => ({
  PromotionNewModal: ({
    open,
    initialKind,
  }: {
    open: boolean;
    initialKind?: string;
  }) => (open ? <div data-attr="promotion-new-kind">{initialKind ?? "flyer"}</div> : null),
}));
vi.mock("@/components/portal/promotion-text-generate-modal", () => ({
  PromotionTextGenerateModal: () => null,
}));
vi.mock("@/components/portal/promotion-asset-view-modal", () => ({
  PromotionAssetViewModal: () => null,
}));

const inputs = {
  headline: "Bright loft living",
  sellingPoints: "Rooftop deck",
  price: "$2,400/mo",
  promo: "",
  cta: "Book a tour",
  contact: "leasing@example.com",
  tone: "Warm & welcoming",
  address: "123 Main St",
  customDetails: "",
};

function seedRow(): ManagerPromotionRow {
  const now = "2026-06-01T12:00:00.000Z";
  const flyer = createFlyerEntry(
    {
      title: "Open house flyer",
      copy: {
        headline: "Now leasing",
        subheadline: "",
        sellingPoints: [],
        promoLine: "",
        ctaText: "",
        closingLine: "",
      },
      template: "showcase",
      theme: "cobalt",
      flyerSize: "letter",
      inputs,
    },
    "2026-06-02T12:00:00.000Z",
  );
  const text = createPromotionTextEntry(
    composeFallbackPromotionText(inputs, "Cedar Lane", "listing_blurb"),
    "Cedar Lane — Instagram caption",
    "2026-06-03T12:00:00.000Z",
  );
  return {
    id: "promo-1",
    managerUserId: "mgr-1",
    propertyId: "listing-a",
    propertyLabel: "Cedar Lane Duplex",
    title: "Cedar push",
    theme: "cobalt",
    flyerSize: "letter",
    template: "showcase",
    status: "generated",
    inputs,
    copy: null,
    textCopy: null,
    createdAt: now,
    updatedAt: now,
    flyerCopies: [flyer],
    textCopies: [text],
  };
}

describe("Promotion command bar", () => {
  afterEach(() => {
    cleanup();
    searchParamsRef.current = new URLSearchParams();
    promoRows.current = [];
  });

  it("renders All / Text / Image, search, and both kinds on All", () => {
    promoRows.current = [seedRow()];
    render(<ManagerPromotion />);
    expect(document.querySelector('[data-attr="promotion-kind-all"]')).toBeTruthy();
    expect(document.querySelector('[data-attr="promotion-kind-text"]')).toBeTruthy();
    expect(document.querySelector('[data-attr="promotion-kind-image"]')).toBeTruthy();
    expect(screen.getByPlaceholderText("Search promotions")).toBeTruthy();
    expect(screen.getByText("Cedar Lane — Instagram caption")).toBeTruthy();
    expect(screen.getByText("Open house flyer")).toBeTruthy();
  });

  it("hides flyers on Text and shows the section empty when only images exist", () => {
    const row = seedRow();
    promoRows.current = [{ ...row, textCopies: [] }];
    searchParamsRef.current = new URLSearchParams("kind=text");
    render(<ManagerPromotion />);
    expect(screen.getByText("No text promotions yet")).toBeTruthy();
    expect(screen.queryByText("Open house flyer")).toBeNull();
  });

  it("filters the visible section by search and clears a miss", () => {
    promoRows.current = [seedRow()];
    render(<ManagerPromotion />);
    fireEvent.change(screen.getByPlaceholderText("Search promotions"), { target: { value: "paseo" } });
    expect(screen.getByText("No promotions match “paseo”")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Clear search" }));
    expect(screen.getByText("Open house flyer")).toBeTruthy();
  });

  it("defaults New promotion to text on the Text section", () => {
    promoRows.current = [seedRow()];
    searchParamsRef.current = new URLSearchParams("kind=text");
    render(<ManagerPromotion />);
    fireEvent.click(screen.getByRole("button", { name: "New promotion" }));
    expect(screen.getByText("text")).toBeTruthy();
  });
});
