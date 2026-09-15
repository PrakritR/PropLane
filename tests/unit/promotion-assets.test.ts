import { describe, expect, it } from "vitest";
import {
  countPromotionAssetsBySection,
  flattenPromotionAssets,
  makePromotionAssetId,
  promotionAssetListTitle,
  promotionAssetMatchesKind,
  promotionAssetMatchesQuery,
  promotionNewKindForSection,
  sortPromotionAssets,
} from "@/lib/promotion-assets";
import { createFlyerEntry, type ManagerPromotionRow } from "@/lib/promotion-flyer";
import { composeFallbackPromotionText, createPromotionTextEntry } from "@/lib/promotion-text";

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

function baseRow(overrides: Partial<ManagerPromotionRow> = {}): ManagerPromotionRow {
  const now = "2026-06-01T12:00:00.000Z";
  return {
    id: "promo-1",
    managerUserId: "mgr-1",
    propertyId: "listing-a",
    propertyLabel: "Alpha Lofts — Downtown",
    title: "Alpha push",
    theme: "cobalt",
    flyerSize: "letter",
    template: "showcase",
    status: "generated",
    inputs,
    copy: null,
    textCopy: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe("promotion-assets", () => {
  it("flattens flyer and text entries into separate assets", () => {
    const flyer = createFlyerEntry(
      {
        title: "Flyer 1",
        copy: {
          headline: "Now leasing",
          subheadline: "Downtown",
          sellingPoints: [],
          promoLine: "",
          ctaText: "Tour",
          closingLine: "Call us",
        },
        template: "showcase",
        theme: "cobalt",
        flyerSize: "letter",
        inputs,
      },
      "2026-06-02T12:00:00.000Z",
    );
    const text = createPromotionTextEntry(
      composeFallbackPromotionText(inputs, "Alpha Lofts", "listing_blurb"),
      "Text 1",
      "2026-06-03T12:00:00.000Z",
    );
    const assets = flattenPromotionAssets([baseRow({ flyerCopies: [flyer], textCopies: [text] })]);
    expect(assets).toHaveLength(2);
    expect(assets.map((a) => a.kind).sort()).toEqual(["flyer", "text"]);
    expect(assets[0]?.id).toBe(makePromotionAssetId("promo-1", "flyer", flyer.id));
  });

  it("sorts by property name then newest within property", () => {
    const flyerA = createFlyerEntry(
      {
        title: "Flyer",
        copy: {
          headline: "A old",
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
      "2026-06-01T12:00:00.000Z",
    );
    const flyerANew = createFlyerEntry(
      {
        title: "Flyer 2",
        copy: {
          headline: "A new",
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
      "2026-06-05T12:00:00.000Z",
    );
    const flyerB = createFlyerEntry(
      {
        title: "Flyer",
        copy: {
          headline: "B",
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
      "2026-06-04T12:00:00.000Z",
    );

    const assets = sortPromotionAssets(
      flattenPromotionAssets([
        baseRow({ id: "a", propertyLabel: "Alpha Lofts", flyerCopies: [flyerANew, flyerA] }),
        baseRow({ id: "b", propertyId: "listing-b", propertyLabel: "Beta Homes", flyerCopies: [flyerB] }),
      ]),
    );

    expect(assets.map((a) => a.subtitle)).toEqual(["A new", "A old", "B"]);
  });

  it("uses asset title on property portal cards", () => {
    const flyer = createFlyerEntry(
      {
        title: "Spring flyer",
        copy: {
          headline: "Headline",
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
      "2026-06-01T12:00:00.000Z",
    );
    const asset = flattenPromotionAssets([baseRow({ flyerCopies: [flyer] })])[0]!;
    expect(promotionAssetListTitle(asset, 0)).toBe("Spring flyer");
  });

  it("numbers assets globally by kind in list order", () => {
    const flyer = createFlyerEntry(
      {
        title: "",
        copy: {
          headline: "Flyer headline",
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
      composeFallbackPromotionText(inputs, "Alpha Lofts", "listing_blurb"),
      "",
      "2026-06-03T12:00:00.000Z",
    );
    const assets = sortPromotionAssets(
      flattenPromotionAssets([baseRow({ flyerCopies: [flyer], textCopies: [text] })]),
      "newest",
    );
    expect(promotionAssetListTitle(assets[0]!, 0)).toMatch(/^Text /);
    expect(promotionAssetListTitle(assets[1]!, 0)).toBe("Flyer 1");
  });

  it("buckets text vs image (flyer + upload, including PDF)", () => {
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
      composeFallbackPromotionText(inputs, "Alpha Lofts", "listing_blurb"),
      "Instagram caption",
      "2026-06-03T12:00:00.000Z",
    );
    const assets = flattenPromotionAssets([
      baseRow({
        flyerCopies: [flyer],
        textCopies: [text],
        uploadCopies: [
          {
            id: "up-1",
            title: "Kitchen photo",
            kind: "image",
            fileUrl: "data:image/png;base64,xx",
            fileName: "kitchen.png",
            mimeType: "image/png",
            createdAt: "2026-06-04T12:00:00.000Z",
            updatedAt: "2026-06-04T12:00:00.000Z",
          },
          {
            id: "up-2",
            title: "Lease flyer PDF",
            kind: "pdf",
            fileUrl: "data:application/pdf;base64,xx",
            fileName: "flyer.pdf",
            mimeType: "application/pdf",
            createdAt: "2026-06-05T12:00:00.000Z",
            updatedAt: "2026-06-05T12:00:00.000Z",
          },
        ],
      }),
    ]);
    expect(countPromotionAssetsBySection(assets)).toEqual({ all: 4, text: 1, image: 3 });
    expect(assets.filter((a) => promotionAssetMatchesKind(a, "text"))).toHaveLength(1);
    expect(assets.filter((a) => promotionAssetMatchesKind(a, "image")).map((a) => a.kind).sort()).toEqual([
      "flyer",
      "upload",
      "upload",
    ]);
    expect(promotionAssetMatchesQuery(assets.find((a) => a.kind === "text")!, "instagram")).toBe(true);
    expect(promotionAssetMatchesQuery(assets.find((a) => a.kind === "flyer")!, "alpha")).toBe(true);
    expect(promotionAssetMatchesQuery(assets[0]!, "paseo")).toBe(false);
    expect(promotionNewKindForSection("text")).toBe("text");
    expect(promotionNewKindForSection("image")).toBe("flyer");
    expect(promotionNewKindForSection("all")).toBe("flyer");
  });
});
