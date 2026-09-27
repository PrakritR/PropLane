// @vitest-environment jsdom
//
// Promotions renders card rows now (like Leases/Residents), not checkbox
// two-line rows: one card per promotion, facts derived from the row data, no
// pills, no table, and a ⋯ per row (Edit, Delete) since selecting one asset
// at a time is this list's shared selection mode.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
    deleteManagerPromotionRow: vi.fn(),
    upsertManagerPromotion: vi.fn(),
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
  DEMO_MANAGER_USER_ID: "demo-manager",
}));
vi.mock("@/lib/analytics/track-client", () => ({ track: () => {} }));
vi.mock("@/components/portal/promotion-new-modal", () => ({
  PromotionNewModal: ({ open }: { open: boolean }) => (open ? <div data-attr="promotion-new-kind" /> : null),
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

describe("Promotions card rows", () => {
  afterEach(() => {
    cleanup();
    searchParamsRef.current = new URLSearchParams();
    promoRows.current = [];
  });

  it("renders one card per promotion with a place line and no table markup", () => {
    promoRows.current = [seedRow()];
    render(<ManagerPromotion />);
    expect(screen.getByText("Open house flyer")).toBeTruthy();
    expect(screen.getByText("Cedar Lane — Instagram caption")).toBeTruthy();
    expect(document.querySelectorAll("table").length).toBe(0);
    // The row's selection box always morphs into the ⋯ trigger (shared list
    // primitive); no visible/accessible checkbox is ever offered on a row.
    expect(screen.queryAllByRole("checkbox").length).toBe(0);
    const rows = document.querySelectorAll('[data-attr="promotion-list-rows"] > *');
    expect(rows.length).toBe(2);
  });

  it("shows the kind fact and the specific text format instead of the generic label", () => {
    promoRows.current = [seedRow()];
    render(<ManagerPromotion />);
    expect(screen.getByText("Flyer")).toBeTruthy();
    expect(screen.getByText("Listing blurb")).toBeTruthy();
  });

  it("opens a ⋯ menu with Edit before Delete", async () => {
    promoRows.current = [seedRow()];
    render(<ManagerPromotion />);
    fireEvent.keyDown(screen.getByRole("button", { name: /Actions for Open house flyer/i }), { key: "ArrowDown" });
    const menu = await screen.findByRole("menu");
    const labels = Array.from(menu.querySelectorAll('[role="menuitem"]')).map((el) => el.textContent);
    expect(labels).toEqual(["Edit", "Delete"]);
  });

  it("deletes a promotion from its own ⋯ menu after confirming", async () => {
    const { upsertManagerPromotion } = await import("@/lib/manager-promotions-storage");
    promoRows.current = [seedRow()];
    render(<ManagerPromotion />);
    fireEvent.keyDown(screen.getByRole("button", { name: /Actions for Cedar Lane — Instagram caption/i }), {
      key: "ArrowDown",
    });
    fireEvent.click(await screen.findByRole("menuitem", { name: "Delete" }));
    // The row keeps its flyer entry, so deleting the text entry updates the
    // row rather than removing it outright.
    await waitFor(() => {
      expect(upsertManagerPromotion).toHaveBeenCalled();
    });
  });

  it("shows the shared empty card when a section has no rows", () => {
    searchParamsRef.current = new URLSearchParams("kind=text");
    promoRows.current = [{ ...seedRow(), textCopies: [] }];
    render(<ManagerPromotion />);
    expect(screen.getByText("No text promotions yet")).toBeTruthy();
  });
});
