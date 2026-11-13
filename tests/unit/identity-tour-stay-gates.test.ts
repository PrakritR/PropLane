import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { createTourInquiry } from "@/lib/tour-inquiry-create.server";
import { bookGuestStays } from "@/lib/short-stay/guest-stays.server";
import { confirmProspectSmsTourOffer } from "@/lib/tour-schedule-persistence.server";
const env = { ...process.env };
afterEach(() => { process.env = { ...env }; });
function enable() { process.env.RESIDENT_IDENTITY_ENABLED = "true"; process.env.RESIDENT_IDENTITY_PROVIDER = "persona"; process.env.PERSONA_API_KEY = "key"; process.env.PERSONA_TEMPLATE_ID = "template"; process.env.PERSONA_WEBHOOK_SECRET = "secret"; }
describe("identity-protected new actions", () => {
  it("does not accept an anonymous tour even with a claimed email or user ID in the body", async () => {
    enable();
    const db = { from: vi.fn() };
    const result = await createTourInquiry(db as never, { incoming: { kind: "tour", propertyId: "home", residentUserId: "victim", email: "victim@example.test" } });
    expect(result).toMatchObject({ ok: false, reason: "identity_required" });
    expect(db.from).not.toHaveBeenCalled();
  });
  it("refuses an unverified stay before any booking write", async () => {
    enable();
    const upsert = vi.fn();
    const db = { from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }), upsert }) };
    const result = await bookGuestStays(db as never, { userId: "resident", body: { propertyId: "home", roomId: "r1", guests: 1, ranges: [] } });
    expect(result).toMatchObject({ ok: false, status: 403 }); expect(upsert).not.toHaveBeenCalled();
  });
  it("does not confirm an anonymous SMS tour", async () => {
    enable(); const rpc = vi.fn();
    const result = await confirmProspectSmsTourOffer({ rpc } as never, {} as never);
    expect(result.ok).toBe(false); expect(rpc).not.toHaveBeenCalled();
    if (!result.ok) expect(result.reason).toContain("/auth/sign-in?");
  });
});
