import { describe, expect, it } from "vitest";
import { isMarketingPath } from "@/components/general/general-assistant";

/**
 * A listing page carries its own Quick chat in the bottom-right corner; the site-wide "Ask PropLane"
 * bubble used to sit on top of it (captain, Nov 26). The bubble's one path decision keeps it off listings.
 */
describe("site-wide assistant bubble on listing pages", () => {
  it("is not drawn on a listing page, which has its own chat", () => {
    expect(isMarketingPath("/rent/listings/5257-brooklyn-ave")).toBe(true);
    expect(isMarketingPath("/rent/listings")).toBe(true);
  });

  it("still appears on other public rent pages without their own chat", () => {
    expect(isMarketingPath("/rent/browse")).toBe(false);
    expect(isMarketingPath("/rent/tours")).toBe(false);
    expect(isMarketingPath("/rent/listings-guide")).toBe(false);
  });
});
