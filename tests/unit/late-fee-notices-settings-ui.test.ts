import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("late fee notices in Payments settings (PRP-319)", () => {
  it("exposes the account-wide lateFeeNoticeEnabled switch in the compact payments settings UI", () => {
    const src = readFileSync(
      `${process.cwd()}/src/components/portal/payment-schedule-ui.tsx`,
      "utf8",
    );
    expect(src).toContain('data-attr="payment-late-fee-notices"');
    expect(src).toContain("lateFeeNoticeEnabled");
    // Compact payments branch must include the control (not only the non-compact layout).
    const compactIdx = src.indexOf("compact && variant === \"payments\"");
    const attrIdx = src.indexOf('data-attr="payment-late-fee-notices"');
    expect(compactIdx).toBeGreaterThan(-1);
    expect(attrIdx).toBeGreaterThan(compactIdx);
  });

  it("points listing Pricing late fees at Payments → Settings", () => {
    const src = readFileSync(
      `${process.cwd()}/src/components/portal/pro-add-listing-form.tsx`,
      "utf8",
    );
    expect(src).toContain('data-attr="listing-late-fee-enabled"');
    expect(src).toMatch(/Payments → Settings/);
  });
});
