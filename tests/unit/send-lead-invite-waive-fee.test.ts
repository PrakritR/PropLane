import { beforeEach, describe, expect, it, vi } from "vitest";

const mint = vi.hoisted(() => vi.fn());
const revoke = vi.hoisted(() => vi.fn());
const getShareable = vi.hoisted(() => vi.fn());
const postEmail = vi.hoisted(() => vi.fn());
const ownerRow = vi.hoisted(() => ({ value: { manager_user_id: "owner-1" } as { manager_user_id: string } | null }));

vi.mock("@/lib/analytics/posthog", () => ({ track: vi.fn() }));
vi.mock("@/lib/application-fee-waiver", () => ({
  createApplicationFeeWaiverCode: mint,
  revokeApplicationFeeWaiverCode: revoke,
}));
vi.mock("@/lib/manager-property-share-access", () => ({ getShareablePropertyForUser: getShareable }));
vi.mock("@/lib/auth/manager-lease-scope", () => ({ managerMayFileLeaseUnderProperty: vi.fn() }));
vi.mock("@/lib/proplane-sms-transport.server", () => ({ sendFromManagerWorkNumber: vi.fn() }));
vi.mock("@/lib/manager-communication-access.server", () => ({
  assertManagerCommunicationAllowedForWorkspace: vi.fn(async () => ({ allowed: true })),
  MANAGER_COMMUNICATION_UNREADABLE_MESSAGE: "unreadable",
}));
vi.mock("@/lib/workspaces/active.server", () => ({ resolveActiveWorkspaceFromRequest: vi.fn(async () => ({ id: "ws-1" })) }));
vi.mock("@/lib/tour-notification-delivery.server", () => ({ recordResidentProspectInboxMessage: vi.fn() }));
vi.mock("@/lib/manager-outbound-identity.server", () => ({
  fromHeaderAddress: () => "pm@example.com",
  fromHeaderDisplayName: () => "PM",
  managerOutboundFromHeader: async () => "PM <pm@example.com>",
}));
vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: async () => ({ auth: { getUser: async () => ({ data: { user: { id: "mgr-1" } } }) } }),
}));
vi.mock("@/lib/supabase/service", () => ({
  createSupabaseServiceRoleClient: () => ({
    from: (table: string) => ({
      select() { return this; },
      eq() { return this; },
      maybeSingle: async () =>
        table === "manager_property_records"
          ? { data: ownerRow.value, error: null }
          : { data: { role: "manager" }, error: null },
    }),
  }),
}));
vi.mock("@/lib/app-url", () => ({ resolveEmailLinkBaseUrl: () => "https://proplane.test" }));
vi.mock("@/lib/resend-delivery.server", () => ({ postResendEmail: postEmail }));
vi.mock("@/lib/twilio-provisioning", () => ({ resolveManagerWorkNumber: vi.fn(async () => null) }));
vi.mock("@/lib/test-workspaces/index.server", () => ({ resolveAuthenticatedBusinessAccess: async () => ({ kind: "allowed" }) }));

import { POST } from "@/app/api/portal/send-lead-invite/route";

function post(body: Record<string, unknown>) {
  return POST(new Request("http://localhost/api/portal/send-lead-invite", {
    method: "POST",
    body: JSON.stringify({ kind: "apply", to: "p@example.com", propertyId: "prop-1", propertyIds: ["prop-1"], ...body }),
  }));
}

describe("send application: Waive application fee", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.RESEND_API_KEY = "test";
    getShareable.mockImplementation(async (_u: string, id: string) =>
      id === "prop-1" ? { title: "House", listingSubmission: {} } : null);
    ownerRow.value = { manager_user_id: "owner-1" };
    mint.mockResolvedValue({ ok: true, code: { id: "code-1", code: "WAIVED-AB12" } });
    postEmail.mockResolvedValue({ ok: true, json: async () => ({ id: "e1" }) });
  });

  it("mints a single-use, house-scoped, application-only code and puts it in the link", async () => {
    const res = await post({ waiveFee: true });
    const data = await res.json();
    expect(res.status).toBe(200);
    expect(mint).toHaveBeenCalledTimes(1);
    expect(mint.mock.calls[0][1]).toBe("owner-1");
    expect(mint.mock.calls[0][2]).toMatchObject({ maxUses: 1, propertyIds: ["prop-1"], appliesTo: "application", label: "Waived on send" });
    expect(data.linkUrl).toContain("code=WAIVED-AB12");
    expect(postEmail.mock.calls[0][0].payload.text).toContain("code=WAIVED-AB12");
  });

  it("mints nothing when the box is unchecked", async () => {
    const res = await post({});
    expect(mint).not.toHaveBeenCalled();
    expect((await res.json()).linkUrl).not.toContain("code=");
  });

  it("fails the send when the code cannot be minted", async () => {
    mint.mockResolvedValue({ ok: false, error: "boom" });
    const res = await post({ waiveFee: true });
    expect(res.status).toBe(500);
    expect(postEmail).not.toHaveBeenCalled();
  });

  it("never mints for a property the manager cannot share", async () => {
    const res = await post({ waiveFee: true, propertyId: "other", propertyIds: ["other"] });
    expect(res.status).toBe(403);
    expect(mint).not.toHaveBeenCalled();
  });

  it("refuses to waive on a multi-home link", async () => {
    getShareable.mockResolvedValue({ title: "H", listingSubmission: {} });
    const res = await post({ waiveFee: true, propertyIds: ["prop-1", "prop-2"] });
    expect(res.status).toBe(400);
    expect(mint).not.toHaveBeenCalled();
  });

  it("linkOnly returns the waived link without sending", async () => {
    const res = await post({ waiveFee: true, linkOnly: true, to: "" });
    const data = await res.json();
    expect(data.linkUrl).toContain("code=WAIVED-AB12");
    expect(postEmail).not.toHaveBeenCalled();
  });

  it("mints under the property owner, not a co-manager sender", async () => {
    ownerRow.value = { manager_user_id: "actual-owner" };
    await post({ waiveFee: true });
    expect(mint.mock.calls[0][1]).toBe("actual-owner");
  });

  it("fails the send when the owner cannot be read, never falling back to the sender", async () => {
    ownerRow.value = null;
    const res = await post({ waiveFee: true });
    expect(res.status).toBe(500);
    expect(mint).not.toHaveBeenCalled();
    expect(postEmail).not.toHaveBeenCalled();
  });

  it("keeps the code live when delivery fails and a mailto fallback carries the link", async () => {
    postEmail.mockResolvedValue({ ok: false, statusText: "bad", json: async () => ({}) });
    const res = await post({ waiveFee: true });
    const data = await res.json();
    expect(res.status).toBe(502);
    expect(decodeURIComponent(data.mailtoHref)).toContain("code=WAIVED-AB12");
    expect(revoke).not.toHaveBeenCalled();
  });

  it("revokes under the owner when nothing usable goes back (SMS without a work number)", async () => {
    const res = await post({ waiveFee: true, viaEmail: false, viaSms: true, phone: "2065550100" });
    expect(res.status).toBe(400);
    expect(revoke).toHaveBeenCalledWith(expect.anything(), "owner-1", "code-1");
  });
});
