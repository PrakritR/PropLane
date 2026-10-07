import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryDb } from "./support/memory-supabase";
import { createConsentLedger } from "./support/consent-ledger-fake";

/**
 * Send to phone on a service goes through the SAME vendor-texting path the manager compose uses: the
 * number joins the Vendors list, the first text needs the "I work with this vendor" attestation, the
 * message carries the identification + STOP line, the consent evidence is stored, and the text is a
 * `vendor_conversation` send (which is what projects it into the manager's vendor thread).
 */
const h = vi.hoisted(() => ({
  user: { id: "mgr-1" } as { id: string } | null,
  db: null as unknown,
  enqueue: vi.fn(),
  dispatch: vi.fn(),
  ledger: null as null | ReturnType<typeof import("./support/consent-ledger-fake").createConsentLedger>,
}));

vi.mock("@/lib/supabase/server", () => ({ createSupabaseServerClient: async () => ({ auth: { getUser: async () => ({ data: { user: h.user } }) } }) }));
vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceRoleClient: () => h.db }));
vi.mock("@/lib/test-workspaces/index.server", () => ({
  resolveTestWorkspaceClassification: vi.fn(async () => ({ kind: "normal" })),
  lookupRecordTestWorkspaceId: vi.fn(async () => null),
  resolveAuthenticatedBusinessAccess: vi.fn(async () => ({ kind: "normal" })),
}));
vi.mock("@/lib/app-url", () => ({ resolveEmailLinkBaseUrl: () => "https://proplane.test" }));
vi.mock("@/lib/manager-sms-messages.server", () => ({
  fetchManagerSmsConversations: vi.fn(async () => ({ residents: [] })),
  resolveSmsScopeManagerIds: vi.fn(async () => ["mgr-1"]),
}));
vi.mock("@/lib/sms/owner-sms-dispatcher.server", () => ({ enqueueOwnerSms: h.enqueue, dispatchOwnerSmsOutbox: h.dispatch }));
vi.mock("@/lib/sms/manager-workspace-role.server", () => ({
  resolveConversationSendLine: vi.fn(async () => ({ ok: true, numberId: "line-1", phoneNumber: "+12065550142", via: "only" })),
}));
vi.mock("@/lib/analytics/posthog", () => ({ track: vi.fn() }));
vi.mock("@/lib/sms-consent", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/sms-consent")>()),
  normalizeConsentPhone: (phone: string) => h.ledger!.module.normalizeConsentPhone(phone),
  readSmsSuppressionState: (_db: unknown, phone: string) => h.ledger!.module.readSmsSuppressionState(phone),
  readScopedSmsConsentState: (_db: unknown, ...a: Parameters<ReturnType<typeof createConsentLedger>["module"]["readScopedSmsConsentState"]>) =>
    h.ledger!.module.readScopedSmsConsentState(...a),
  recordScopedSmsConsent: (_db: unknown, ...a: Parameters<ReturnType<typeof createConsentLedger>["module"]["recordScopedSmsConsent"]>) =>
    h.ledger!.module.recordScopedSmsConsent(...a),
}));

// The link minting is covered by service-share-routes.test.ts; here only that it is minted, texted or revoked.
vi.mock("@/lib/service-share-links.server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/service-share-links.server")>()),
  consumeServiceShareSmsAllowance: async () => true,
  createServiceShareLink: async (db: { from: (t: string) => { insert: (r: unknown) => Promise<unknown> } }, input: { workOrderId: string }) => {
    await db.from("service_share_links").insert({ id: `link-${Math.random()}`, work_order_id: input.workOrderId, revoked_at: null, texted_at: null });
    const rows = (db as unknown as { __tables: Record<string, Record<string, unknown>[]> }).__tables.service_share_links!;
    return { link: { id: rows.at(-1)!.id as string, expiresAt: "2099-01-01T00:00:00Z" }, token: "T".repeat(32) };
  },
  markServiceShareLinkTexted: async (db: { from: (t: string) => { update: (r: unknown) => { eq: (c: string, v: string) => Promise<unknown> } } }, id: string) => {
    await db.from("service_share_links").update({ texted_at: "now" }).eq("id", id);
  },
}));

import { POST as sendRoute } from "@/app/api/portal/service-share-link/send/route";
import { GET as consentRoute } from "@/app/api/manager/vendor-text-consent/route";

vi.mock("@/lib/auth/portal-access", () => ({
  getPortalAccessContext: async () => ({ user: h.user, profile: null }),
  hasRole: () => true,
  hasAdminRole: () => false,
}));

const PHONE = "+14252240508";
const FOOTER = "— Sam at Alder Property Co via PropLane. Reply STOP to opt out.";
const body = { workOrderId: "wo-1", phone: "(425) 224-0508", recipientName: "Dima Handyman", sharePhotos: false };
const post = (extra: Record<string, unknown> = {}) =>
  sendRoute(new Request("http://localhost/x", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...body, ...extra }) }));
const table = (name: string) => (h.db as { __tables: Record<string, Record<string, unknown>[]> }).__tables[name]!;

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("SERVICE_LINK_SMS_SANDBOX", "");
  vi.stubEnv("TWILIO_MESSAGING_SERVICE_SID", "MGtest");
  h.user = { id: "mgr-1" };
  h.enqueue.mockResolvedValue({ ok: true, outboxId: "outbox-1", status: "queued" });
  h.dispatch.mockResolvedValue({ submitted: 1, unknown: 0 });
  const db = createMemoryDb({
    portal_work_order_records: [
      {
        id: "wo-1",
        manager_user_id: "mgr-1",
        vendor_user_id: null,
        test_workspace_id: null,
        row_data: { id: "wo-1", title: "Kitchen sink leak", category: "plumbing", propertyAddress: "1420 Alder St, Seattle, WA 98115", status: "Open", bucket: "pending" },
      },
    ],
    profiles: [{ id: "mgr-1", full_name: "Sam Rivera" }],
    manager_vendor_records: [],
    vendor_business_profiles: [],
    manager_sms_numbers: [{ id: "line-1", workspace_id: "ws-1", phone_number: "+12065550142" }],
    portal_workspaces: [{ id: "ws-1", name: "Alder Property Co", owner_user_id: "mgr-1" }],
    service_share_links: [],
    sms_outbox: [],
    sms_projection_conversations: [],
    inbound_sms_log: [],
    work_order_vendor_offers: [],
    work_order_bids: [],
  });
  h.db = db;
  h.ledger = createConsentLedger(db);
});

describe("Send to phone uses vendor texting", () => {
  it("the first text without the attestation is refused, mints nothing and sends nothing", async () => {
    const res = await post();
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: "vendor_attestation_required" });
    expect(table("service_share_links")).toHaveLength(0);
    expect(h.enqueue).not.toHaveBeenCalled();
    expect(h.ledger!.events).toHaveLength(0);
  });

  it("with the attestation it sends as a vendor_conversation, records consent, adds the vendor and carries the footer", async () => {
    const res = await post({ attestWorksWithVendor: true });
    expect(res.status).toBe(200);
    expect(h.enqueue).toHaveBeenCalledOnce();
    const call = h.enqueue.mock.calls[0]![0];
    expect(call).toMatchObject({
      managerUserId: "mgr-1",
      selectedWorkLineId: "line-1",
      recipientPhone: PHONE,
      purpose: "vendor_conversation",
      counterpartyRole: "vendor",
      conversationKey: `mgr-1:vendor:${PHONE}`,
    });
    expect(call.body).toMatch(/Details and bid: https:\/\/proplane\.test\/s\/[A-Za-z0-9_-]{32} /);
    expect(call.body.endsWith(FOOTER)).toBe(true);
    expect(call.body).not.toMatch(/1420|Alder St|98115/);
    expect(h.ledger!.events).toHaveLength(1);
    expect(h.ledger!.events[0]).toMatchObject({ purpose: "vendor_conversation", eventType: "granted", source: "manager_attested_vendor_relationship" });
    const vendors = table("manager_vendor_records");
    expect(vendors).toHaveLength(1);
    expect(vendors[0]!.row_data).toMatchObject({ name: "Dima Handyman", trade: "Plumbing", phone: PHONE });
    expect(table("service_share_links")[0]!.texted_at).toBeTruthy();
  });

  it("the status route says the box is needed before the first text and not after", async () => {
    const ask = () => consentRoute(new Request(`http://localhost/x?phone=${encodeURIComponent(PHONE)}`));
    expect(await (await ask()).json()).toMatchObject({ needsAttestation: true, optedOut: false });
    await post({ attestWorksWithVendor: true });
    expect(await (await ask()).json()).toMatchObject({ needsAttestation: false });
  });

  it("a later text to the same number needs no attestation and reuses the vendor row", async () => {
    await post({ attestWorksWithVendor: true });
    table("service_share_links").length = 0;
    table("sms_outbox").push({
      manager_user_id: "mgr-1", recipient_phone: PHONE, purpose: "vendor_conversation", dedupe_key: "manager:first", status: "submitted",
    });
    h.enqueue.mockClear();
    const res = await post();
    expect(res.status).toBe(200);
    expect(table("manager_vendor_records")).toHaveLength(1);
    expect(h.enqueue.mock.calls[0]![0].body).not.toContain("via PropLane");
  });

  it("STOP is refused and the attestation never overrides it", async () => {
    h.ledger!.stop(PHONE);
    const res = await post({ attestWorksWithVendor: true });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "That number has opted out of texts." });
    expect(h.enqueue).not.toHaveBeenCalled();
    expect(table("service_share_links")).toHaveLength(0);
  });

  it("a send that fails revokes the minted link", async () => {
    h.enqueue.mockResolvedValue({ ok: false, error: "comms_billing_insufficient_credit" });
    const res = await post({ attestWorksWithVendor: true });
    expect(res.status).toBe(503);
    expect(table("service_share_links")[0]!.revoked_at).toBeTruthy();
  });

  it("sandbox: the text is queued for real (so it reaches the vendor thread) and only the carrier hand-off is captured", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("SERVICE_LINK_SMS_SANDBOX", "1");
    const res = await post({ attestWorksWithVendor: true });
    const out = (await res.json()) as { sandbox?: { to: string; text: string } };
    expect(res.status).toBe(200);
    expect(out.sandbox?.to).toBe(PHONE);
    expect(h.enqueue).toHaveBeenCalledOnce();
    expect(h.enqueue.mock.calls[0]![0]).toMatchObject({ purpose: "vendor_conversation", counterpartyRole: "vendor" });
    expect(h.dispatch).toHaveBeenCalledOnce();
  });

  it("sandbox: an account with no ready work line falls back to capturing the whole send", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("SERVICE_LINK_SMS_SANDBOX", "1");
    h.enqueue.mockResolvedValueOnce({ ok: false, error: "number_not_ready" });
    const res = await post({ attestWorksWithVendor: true });
    expect(res.status).toBe(200);
    expect(h.enqueue).toHaveBeenCalledTimes(2);
  });
});
