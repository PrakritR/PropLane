import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

const deliver = vi.hoisted(() => vi.fn());
const deliverThread = vi.hoisted(() => vi.fn());
const commit = vi.hoisted(() => vi.fn());
const resolveTarget = vi.hoisted(() => vi.fn());
vi.mock("@/lib/vendor-work-identity-delivery.server", () => ({
  createVendorWorkIdentityDeliveryProvider: () => ({}),
  deliverVendorWorkIdentity: deliver,
}));
vi.mock("@/lib/inbox-recipient-scope", () => ({
  filterRecipientsBySenderScope: (_db: unknown, _s: unknown, recipients: unknown[]) => Promise.resolve({ allowed: recipients }),
}));
vi.mock("@/lib/portal-inbox-delivery", () => ({
  scopeForRole: (role: string) => role,
  resolveInboxThreadReplyTarget: resolveTarget,
  commitInboxThreadReply: commit,
  deliverPortalMessageThreadSide: deliverThread,
}));
import { sendVendorSponsoredOutbound } from "@/lib/vendor-sponsored-outbound.server";
import { vendorNumberRefusalMessage } from "@/lib/number-subscription/vendor-number.server";

const actor = { userId: "vendor-1", email: "vendor@test.proplane", name: "Vendor" };
const MANAGER = { id: "manager-1", email: "manager@test.proplane", role: "manager", phone: null };

type Tables = {
  profiles?: Record<string, unknown>[];
  links?: string[];
  binding?: { recipient: string; recipient_user_id: string | null } | null;
  workOrder?: Record<string, unknown> | null;
  offer?: boolean;
};
function makeDb(t: Tables) {
  const from = vi.fn((table: string) => {
    const filters: Record<string, unknown> = {};
    const q: Record<string, unknown> = {};
    q.select = () => q;
    q.eq = (col: string, value: unknown) => { filters[col] = value; return q; };
    q.in = () => q;
    q.maybeSingle = async () => {
      if (table === "profiles") {
        const rows = t.profiles ?? [];
        const hit = rows.find((r) => (filters.id ? r.id === filters.id : r.email === filters.email));
        return { data: hit ?? null, error: null };
      }
      if (table === "vendor_work_identity_reply_bindings") return { data: t.binding ?? null, error: null };
      if (table === "portal_work_order_records") return { data: t.workOrder ?? null, error: null };
      if (table === "work_order_vendor_offers") return { data: t.offer ? { id: "offer-1" } : null, error: null };
      return { data: null, error: null };
    };
    q.then = (resolve: (value: unknown) => unknown) => resolve({
      data: table === "manager_vendor_records" ? (t.links ?? []).map((id) => ({ manager_user_id: id })) : [],
      error: null,
    });
    return q;
  });
  return { from } as unknown as SupabaseClient;
}
const threadTarget = (rowData: Record<string, unknown>) => ({
  threadId: "thread-1", scope: "vendor", ownerUserId: "vendor-1", participantEmail: "vendor@test.proplane", threadType: "portal_message", rowData,
});
const reply = { channel: "email" as const, subject: "Re: Leak", text: "On my way", sendId: "send-1", threadId: "thread-1" };

beforeEach(() => {
  vi.clearAllMocks();
  deliver.mockResolvedValue({ ok: true, authorized: true, sent: true, providerMessageId: "m1" });
  deliverThread.mockResolvedValue({ threadId: "thread-1", delivery: "sent" });
});

describe("vendor to manager is in-app", () => {
  it("replies to a manager-started thread with no binding and no work identity, writing the manager side", async () => {
    resolveTarget.mockResolvedValue(threadTarget({ email: MANAGER.email }));
    const db = makeDb({ profiles: [MANAGER], links: ["manager-1"] });
    const result = await sendVendorSponsoredOutbound(db, actor, { ...reply, attachmentUrls: [] });
    expect(result).toMatchObject({ ok: true, delivery: "sent" });
    expect(deliver).not.toHaveBeenCalled();
    expect(deliverThread).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      folder: "inbox", ownerUserId: "manager-1", participantEmail: MANAGER.email, unread: true, outbound: false, messageId: "vendor-sponsored:send-1", channel: "proplane",
    }));
    expect(commit).toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.objectContaining({ messageId: "vendor-sponsored:send-1", outbound: true, delivery: "sent" }));
  });

  it("does not email even when the vendor also has a ready work identity (binding to a manager)", async () => {
    resolveTarget.mockResolvedValue(threadTarget({}));
    const db = makeDb({ profiles: [MANAGER], links: ["manager-1"], binding: { recipient: MANAGER.email, recipient_user_id: "manager-1" } });
    await sendVendorSponsoredOutbound(db, actor, reply);
    expect(deliver).not.toHaveBeenCalled();
    expect(deliverThread).toHaveBeenCalledTimes(1);
  });

  it("keeps attachments on the manager's copy so they can read them", async () => {
    resolveTarget.mockResolvedValue(threadTarget({ email: MANAGER.email }));
    const path = "vendor-1/photo.png";
    await sendVendorSponsoredOutbound(makeDb({ profiles: [MANAGER], links: ["manager-1"] }), actor, { ...reply, attachmentUrls: [`/api/portal/inbox-attachments/${path}`] });
    const call = deliverThread.mock.calls[0]![1] as { attachments: { url: string }[]; body: string };
    expect(call.attachments).toHaveLength(1);
    expect(call.body).toBe("On my way");
  });

  it("refuses a thread the vendor does not participate in", async () => {
    resolveTarget.mockResolvedValue(null);
    const result = await sendVendorSponsoredOutbound(makeDb({ profiles: [MANAGER], links: ["manager-1"] }), actor, reply);
    expect(result).toEqual({ ok: false, error: "conversation_unavailable" });
    expect(deliverThread).not.toHaveBeenCalled();
  });

  it("refuses a thread whose named account the vendor is not linked to (row_data cannot widen reach)", async () => {
    resolveTarget.mockResolvedValue(threadTarget({ email: MANAGER.email }));
    const result = await sendVendorSponsoredOutbound(makeDb({ profiles: [MANAGER], links: ["someone-else"] }), actor, reply);
    expect(result).toEqual({ ok: false, error: "recipient_unlinked" });
    expect(deliverThread).not.toHaveBeenCalled();
    expect(deliver).not.toHaveBeenCalled();
  });

  it("refuses a new compose to an unlinked manager", async () => {
    const result = await sendVendorSponsoredOutbound(makeDb({ profiles: [MANAGER], links: [] }), actor, { channel: "email", subject: "Hi", text: "Body", sendId: "s", recipientUserId: "manager-1" });
    expect(result).toEqual({ ok: false, error: "recipient_unlinked" });
    expect(deliverThread).not.toHaveBeenCalled();
  });

  it("a retry with the same sendId reuses the same message id on both sides (no duplicate turn)", async () => {
    resolveTarget.mockResolvedValue(threadTarget({ email: MANAGER.email }));
    const db = makeDb({ profiles: [MANAGER], links: ["manager-1"] });
    await sendVendorSponsoredOutbound(db, actor, reply);
    await sendVendorSponsoredOutbound(db, actor, reply);
    const ids = deliverThread.mock.calls.map((c) => (c[1] as { messageId: string }).messageId);
    expect(new Set(ids)).toEqual(new Set(["vendor-sponsored:send-1"]));
    expect(commit.mock.calls.map((c) => (c[2] as { messageId: string }).messageId)).toEqual(["vendor-sponsored:send-1", "vendor-sponsored:send-1"]);
  });

  it("still uses the work identity for an outside contact with no profile", async () => {
    resolveTarget.mockResolvedValue(threadTarget({}));
    const db = makeDb({ profiles: [], binding: { recipient: "customer@outside.test", recipient_user_id: null } });
    const result = await sendVendorSponsoredOutbound(db, actor, reply);
    expect(result).toMatchObject({ ok: true });
    expect(deliver).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ recipient: "customer@outside.test" }), expect.anything());
    expect(deliverThread).not.toHaveBeenCalled();
  });

  it("composes a new message to a linked manager in-app on both sides, with no binding write", async () => {
    const db = makeDb({ profiles: [MANAGER], links: ["manager-1"] });
    const result = await sendVendorSponsoredOutbound(db, actor, { channel: "email", subject: "Hi", text: "Body", sendId: "s2", recipientUserId: "manager-1" });
    expect(result).toMatchObject({ ok: true, delivery: "sent" });
    expect(deliver).not.toHaveBeenCalled();
    expect(deliverThread.mock.calls.map((c) => (c[1] as { folder: string }).folder).sort()).toEqual(["inbox", "sent"]);
  });
});

describe("job recordRef", () => {
  const ref = { kind: "service" as const, id: "wo-1", label: "Leak" };
  const compose = { channel: "email" as const, subject: "Hi", text: "Body", sendId: "s3", recipientUserId: "manager-1", recordRef: ref };

  it("stamps a job the vendor is assigned to and places the manager copy by the job's property", async () => {
    const db = makeDb({ profiles: [MANAGER], links: ["manager-1"], workOrder: { manager_user_id: "manager-1", vendor_user_id: "vendor-1", row_data: { propertyId: "prop-9" } } });
    await sendVendorSponsoredOutbound(db, actor, compose);
    const inbox = deliverThread.mock.calls.map((c) => c[1] as { folder: string; recordRef?: unknown; conversation?: { propertyId?: string | null } }).find((c) => c.folder === "inbox")!;
    expect(inbox.recordRef).toEqual(ref);
    expect(inbox.conversation?.propertyId).toBe("prop-9");
  });

  it("accepts a live offer", async () => {
    const db = makeDb({ profiles: [MANAGER], links: ["manager-1"], offer: true, workOrder: { manager_user_id: "manager-1", vendor_user_id: null, row_data: {} } });
    await sendVendorSponsoredOutbound(db, actor, compose);
    expect((deliverThread.mock.calls[0]![1] as { recordRef?: unknown }).recordRef).toEqual(ref);
  });

  it("drops a job the vendor is not on, without failing the send", async () => {
    const db = makeDb({ profiles: [MANAGER], links: ["manager-1"], workOrder: { manager_user_id: "manager-1", vendor_user_id: "vendor-2", row_data: {} } });
    const result = await sendVendorSponsoredOutbound(db, actor, compose);
    expect(result).toMatchObject({ ok: true });
    for (const call of deliverThread.mock.calls) expect((call[1] as { recordRef?: unknown }).recordRef).toBeUndefined();
  });

  it("drops a job that belongs to a different manager", async () => {
    const db = makeDb({ profiles: [MANAGER], links: ["manager-1"], workOrder: { manager_user_id: "manager-2", vendor_user_id: "vendor-1", row_data: {} } });
    await sendVendorSponsoredOutbound(db, actor, compose);
    for (const call of deliverThread.mock.calls) expect((call[1] as { recordRef?: unknown }).recordRef).toBeUndefined();
  });
});

describe("refusal copy", () => {
  it("never shows a raw token", () => {
    expect(vendorNumberRefusalMessage("identity_not_ready")).toBe("Your work email isn't set up yet, so this contact can't be reached.");
    expect(vendorNumberRefusalMessage("some_new_token")).toBe("Couldn't send. Try again.");
    expect(vendorNumberRefusalMessage("Out of credit. Buy credit in Settings to text from your number.")).toContain("Out of credit");
  });
});
