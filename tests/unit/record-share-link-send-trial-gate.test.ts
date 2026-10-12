/**
 * `/api/portal/record-share-link/send` emails and texts a public view link. A live signup trial
 * has no Communication until it pays, judged by the record's workspace OWNER - so the route
 * refuses with 402 before a link is minted, an email is posted or a text is sent.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  access: { allowed: true } as
    | { allowed: true }
    | { allowed: false; reason: "trial"; status: 402; message: string },
  forOwner: vi.fn(),
  authorize: vi.fn(),
  mint: vi.fn(),
  sms: vi.fn(),
  email: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: async () => ({ auth: { getUser: async () => ({ data: { user: { id: "mate-1" } } }) } }),
}));
vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceRoleClient: () => ({ tag: "db" }) }));
vi.mock("@/lib/test-workspaces/index.server", () => ({
  resolveAuthenticatedBusinessAccess: async () => ({ kind: "normal" }),
}));
vi.mock("@/lib/manager-communication-access.server", () => ({
  assertManagerCommunicationAllowed: async (...args: unknown[]) => {
    mocks.forOwner(...args);
    return mocks.access;
  },
}));
vi.mock("@/lib/portal-record-share-authorize.server", () => ({ authorizePortalRecordShare: mocks.authorize }));
vi.mock("@/lib/portal-record-share-links.server", () => ({
  createPortalRecordShareLink: mocks.mint,
  buildPortalRecordShareUrl: () => "https://proplane.test/share/tok",
}));
vi.mock("@/lib/proplane-sms-transport.server", () => ({ sendFromManagerWorkNumber: mocks.sms }));
vi.mock("@/lib/resend-delivery.server", () => ({ postResendEmail: mocks.email }));
vi.mock("@/lib/twilio-provisioning", () => ({ resolveManagerWorkNumber: async () => "+12065550100" }));
vi.mock("@/lib/manager-outbound-identity.server", () => ({
  managerOutboundFromHeader: async () => "PropLane <x@proplane.test>",
  fromHeaderAddress: () => "x@proplane.test",
  fromHeaderDisplayName: () => "PropLane",
}));
vi.mock("@/lib/tour-notification-delivery.server", () => ({ recordResidentProspectInboxMessage: vi.fn() }));

const { POST } = await import("@/app/api/portal/record-share-link/send/route");

function post(body: unknown) {
  return POST(
    new Request("https://prop-lane.space/api/portal/record-share-link/send", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  );
}

beforeEach(() => {
  vi.stubEnv("RESEND_API_KEY", "re_test_key");
  mocks.access = { allowed: true };
  for (const fn of [mocks.forOwner, mocks.authorize, mocks.mint, mocks.sms, mocks.email]) fn.mockReset();
  mocks.authorize.mockResolvedValue({
    ok: true,
    canonicalRecordId: "lease-1",
    recordTitle: "Lease",
    recordOwnerUserId: "owner-1",
  });
  mocks.mint.mockResolvedValue({ shareToken: "tok" });
  mocks.sms.mockResolvedValue({ ok: true });
  mocks.email.mockResolvedValue(new Response(JSON.stringify({ id: "e1" }), { status: 200 }));
});

describe("POST /api/portal/record-share-link/send - trial gate", () => {
  it.each([
    ["email", { to: "tenant@example.com" }],
    ["sms", { viaEmail: false, viaSms: true, phone: "+12065551212" }],
  ])("refuses a trial workspace owner with 402 before any %s send", async (_channel, extra) => {
    mocks.access = {
      allowed: false,
      reason: "trial",
      status: 402,
      message: "Communication is available on a paid plan.",
    };
    const res = await post({ kind: "lease", recordId: "lease-1", ...extra });
    expect(res.status).toBe(402);
    expect(await res.json()).toMatchObject({
      error: "Communication is available on a paid plan.",
      code: "communication_trial",
    });
    // The record owner's plan is asked about, not the acting teammate's own.
    expect(mocks.forOwner).toHaveBeenCalledWith("owner-1");
    expect(mocks.mint).not.toHaveBeenCalled();
    expect(mocks.email).not.toHaveBeenCalled();
    expect(mocks.sms).not.toHaveBeenCalled();
  });

  it("still sends for a paid owner", async () => {
    const res = await post({ kind: "lease", recordId: "lease-1", to: "tenant@example.com" });
    expect(res.status).toBe(200);
    expect(mocks.email).toHaveBeenCalledTimes(1);
  });
});
