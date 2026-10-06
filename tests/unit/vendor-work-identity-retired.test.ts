import { existsSync, readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Decide #2 (Oct 6): vendors never own a text number. The vendor work identity's
 * number side is retired - no provisioning, no UI, no inbound routing branch -
 * while stored `vendor_work_identities` rows (and the email identity) stay as they are.
 */
const mocks = vi.hoisted(() => ({ actor: vi.fn(), setup: vi.fn(), get: vi.fn() }));
vi.mock("@/lib/auth/vendor-api-access", () => ({ resolveVendorPortalUserId: mocks.actor }));
vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceRoleClient: () => ({}) }));
vi.mock("@/lib/vendor-work-identity.server", () => ({
  getVendorWorkIdentity: mocks.get,
  setupVendorWorkIdentity: mocks.setup,
}));

import { POST } from "@/app/api/vendor/work-identity/route";

const post = (body: unknown) =>
  POST(new Request("http://test/api/vendor/work-identity", { method: "POST", body: JSON.stringify(body) }));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.actor.mockResolvedValue({ ok: true, userId: "vendor-1" });
  mocks.setup.mockResolvedValue({ email: { state: "ready" } });
});

describe("the vendor work-number provisioning is gone", () => {
  it("POST channel=sms is refused (410) and nothing is set up", async () => {
    const res = await post({ channel: "sms", idempotencyKey: "11111111-1111-4111-8111-111111111111", phoneNumber: "+12065550142", claimToken: "x" });
    expect(res.status).toBe(410);
    expect(mocks.setup).not.toHaveBeenCalled();
  });

  it("the email channel still sets up the sponsored inbox", async () => {
    const res = await post({ channel: "email", idempotencyKey: "11111111-1111-4111-8111-111111111111" });
    expect(res.status).toBe(200);
    expect(mocks.setup).toHaveBeenCalledWith({}, "vendor-1", "11111111-1111-4111-8111-111111111111");
  });

  it("the number search and the signed claim token no longer exist", () => {
    expect(existsSync("src/app/api/vendor/work-identity/candidates/route.ts")).toBe(false);
    expect(existsSync("src/lib/vendor-work-number-claim-token.server.ts")).toBe(false);
    expect(readFileSync("src/lib/vendor-work-identity.server.ts", "utf8")).not.toMatch(/searchVendorWorkNumberCandidates|purchaseSms\(\{ operationId/);
  });
});

describe("the inbound webhook no longer routes by a vendor-owned number", () => {
  it("has no vendor work-identity SMS branch and no ingest function", async () => {
    const route = readFileSync("src/app/api/twilio/inbound/route.ts", "utf8");
    expect(route).not.toContain("ingestVendorWorkIdentitySms");
    expect(route).not.toContain("vendor-work-identity-inbound");
    const inbound = await import("@/lib/vendor-work-identity-inbound.server");
    expect(Object.keys(inbound)).toEqual(["ingestVendorWorkIdentityEmail"]);
  });
});

describe("the vendor UI shows no PropLane number", () => {
  it("the Communication card is the work EMAIL only and Settings has no number claim", () => {
    const card = readFileSync("src/components/portal/vendor-work-number-card.tsx", "utf8");
    expect(card).not.toContain("Your work number");
    expect(card).not.toContain("vendor-business-work-number");
    const settings = readFileSync("src/components/portal/vendor-business-settings.tsx", "utf8");
    expect(settings).not.toContain("VendorWorkNumberClaim");
    expect(settings).not.toContain("/api/vendor/work-identity/candidates");
    expect(settings).not.toContain("VendorWorkNumberStatusNote");
  });

  it("the portal-wide notice asks the vendor to verify a phone, not to set up a number", () => {
    const banner = readFileSync("src/components/portal/vendor-messaging-setup-banner.tsx", "utf8");
    expect(banner).toContain("Verify your phone");
    expect(banner).not.toContain("/api/vendor/work-identity");
    expect(banner).toContain("/vendor/profile?tab=messaging");
  });
});
