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

  // The listing keeps its own per-listing switch; the pointer text to Payments → Settings
  // was struck by the captain (PRP-463) because it repeated on every listing. The account
  // switch still gates automatic late fees — that is what the first test above pins — so
  // what is left to protect here is the per-listing control, not the sentence beside it.
  it("keeps the per-listing automatic late fee switch", () => {
    const src = readFileSync(
      `${process.cwd()}/src/components/portal/pro-add-listing-form.tsx`,
      "utf8",
    );
    expect(src).toContain('data-attr="listing-late-fee-enabled"');
    expect(src).toContain("sub.lateFeeEnabled !== false");
  });
});
