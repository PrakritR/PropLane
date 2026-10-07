import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

/**
 * The residentVisibleAt stamp in `POST /api/portal/send-payment-reminder` is a row_data-only write.
 * The household-charges incremental resync keys on `updated_at`, so the stamp must bump it. Source
 * guard (the route's behaviour is covered end to end by tests/integration/portal/send-payment-reminder).
 */
describe("send-payment-reminder residentVisibleAt stamp", () => {
  it("writes updated_at together with row_data", () => {
    const src = readFileSync("src/app/api/portal/send-payment-reminder/route.ts", "utf8");
    const stamp = src.match(/\.update\(\{ row_data: \{ \.\.\.current, residentVisibleAt \}[^)]*\)/);
    expect(stamp?.[0]).toBeTruthy();
    expect(stamp![0]).toContain("updated_at");
  });
});
