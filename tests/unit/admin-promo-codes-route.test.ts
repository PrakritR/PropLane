/**
 * A promo code's record lives at /admin/promo-codes/<id>: the section renderer passes the decoded
 * segment as `detailId`, and the panel opens that record and links its rows back to the same path
 * (never a `?code=` query the renderer does not route).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

describe("admin promo code record route", () => {
  const panel = read("src/components/portal/admin-promo-codes-panel.tsx");

  it("the renderer routes /admin/promo-codes/<id> into the panel as detailId", () => {
    const renderer = read("src/lib/render-portal-section.tsx");
    expect(renderer).toContain("<AdminPromoCodesPanel detailId={detailId} />");
  });

  it("the panel opens the record for detailId and navigates rows to the same path", () => {
    expect(panel).toContain("AdminPromoCodesPanel({ detailId }");
    expect(panel).toContain("detailId ? <PromoCodeRecord id={detailId} />");
    expect(panel).toContain("navigate(promoCodeHref(code.id))");
    expect(panel).toContain('backHref={PROMO_CODES_PATH}');
    expect(panel).not.toContain("?code=");
    expect(panel).not.toContain("useSearchParams");
  });
});
