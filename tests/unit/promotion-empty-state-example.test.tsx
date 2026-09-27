// @vitest-environment jsdom
//
// C241: Promotion's empty state showed only "No promotions yet" with no
// preview of what pressing "+" generates. This locks in the added static
// example card — clearly a placeholder (no photo, an obviously fake
// address), never shown once a real asset exists.
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { PromotionAssetStack } from "@/components/portal/promotion-asset-list";
import type { PromotionAsset } from "@/lib/promotion-assets";

afterEach(() => cleanup());

describe("PromotionAssetStack empty state", () => {
  it("shows a static example preview alongside the empty message", () => {
    render(<PromotionAssetStack assets={[]} emptyMessage="No promotions yet." />);
    expect(screen.getByText("No promotions yet.")).toBeInTheDocument();
    const example = document.querySelector('[data-attr="promotion-empty-example"]');
    expect(example).toBeTruthy();
    expect(example?.getAttribute("aria-hidden")).toBe("true");
    expect(example?.textContent).toContain("Sample flyer");
  });

  it("never renders the example once a real asset exists", () => {
    const asset = {
      id: "a1",
      kind: "flyer",
      row: {} as PromotionAsset["row"],
      propertyLabel: "123 Real St",
      propertyId: "p1",
      subtitle: "",
      createdAt: new Date().toISOString(),
    } as PromotionAsset;
    render(<PromotionAssetStack assets={[asset]} />);
    expect(document.querySelector('[data-attr="promotion-empty-example"]')).toBeNull();
  });

  it("renders nothing at all when a caller opts out with an empty message", () => {
    render(<PromotionAssetStack assets={[]} emptyMessage="" />);
    expect(document.querySelector('[data-attr="promotion-empty-example"]')).toBeNull();
  });
});
