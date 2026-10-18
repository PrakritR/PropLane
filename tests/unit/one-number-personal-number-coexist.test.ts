import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { isSharedLineNumber } from "@/lib/one-number/config.server";

/**
 * Vendors and residents keep their personal-number subscription (own number, own channel). It coexists
 * with the shared line: their number is never the shared one, so the shared-line seam never engages on it
 * and the vendor / resident number ingest keeps its own inbound path.
 */
const config = { mode: "shared" as const, sharedNumber: "+12065550100", messagingServiceSid: null, pilotWorkspaceIds: [], dedicatedWorkspaceIds: [] };

describe("personal numbers beside the shared line", () => {
  it("a vendor's or resident's own number is not the shared line", () => {
    expect(isSharedLineNumber(config, "+12065550177")).toBe(false);
    expect(isSharedLineNumber(config, "+12065550100")).toBe(true);
  });

  it("the inbound route gates the shared-line seam on the shared number and still runs both personal-number ingests", () => {
    const route = readFileSync("src/app/api/twilio/inbound/route.ts", "utf8");
    expect(route).toMatch(/lineConfig\.mode === "shared" && messageSid && isSharedLineNumber\(lineConfig, toPhone\)/);
    expect(route).toContain("ingestVendorWorkIdentitySms(db, { toPhone");
    expect(route).toContain("ingestResidentAgentNumberSms(db, { toPhone");
    // The seam returns "handled" only for the shared number; a personal number reaches the ingests below it.
    expect(route.indexOf("isSharedLineNumber(lineConfig, toPhone)")).toBeLessThan(route.indexOf("ingestVendorWorkIdentitySms(db"));
  });
});
