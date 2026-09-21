import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

const deliver = vi.hoisted(() => vi.fn());
const deliverThread = vi.hoisted(() => vi.fn());
vi.mock("@/lib/vendor-work-identity-delivery.server", () => ({
  createVendorWorkIdentityDeliveryProvider: () => ({}),
  deliverVendorWorkIdentity: deliver,
}));
vi.mock("@/lib/inbox-recipient-scope", () => ({
  filterRecipientsBySenderScope: () => Promise.resolve({ allowed: [{}] }),
}));
vi.mock("@/lib/portal-inbox-delivery", () => ({
  scopeForRole: (role: string) => role,
  resolveInboxThreadReplyTarget: () => Promise.resolve(null),
  commitInboxThreadReply: vi.fn(),
  deliverPortalMessageThreadSide: deliverThread,
}));
import { bindVendorReplyTarget, sendVendorSponsoredOutbound } from "@/lib/vendor-sponsored-outbound.server";

function dbForBinding(existing?: { recipient: string; recipient_user_id: string | null }) {
  const inserts: unknown[] = [];
  const from = vi.fn((table: string) => {
    const q: Record<string, unknown> = {};
    q.select = () => q; q.eq = () => q;
    q.maybeSingle = async () => table === "vendor_work_identities"
      ? { data: { id: "identity-1" }, error: null }
      : { data: existing ?? null, error: null };
    q.insert = (row: unknown) => { inserts.push(row); return Promise.resolve({ error: existing ? { code: "23505" } : null }); };
    return q;
  });
  return { db: { from } as unknown as SupabaseClient, inserts };
}

describe("vendor work identity reply bindings", () => {
  it("records a service-role destination once and accepts an exact replay", async () => {
    const first = dbForBinding();
    await expect(bindVendorReplyTarget(first.db, { vendorUserId: "vendor-1", threadId: "thread-1", channel: "email", recipient: "manager@example.test", recipientUserId: "manager-1", messageId: "inbound-1" })).resolves.toBeUndefined();
    expect(first.inserts[0]).toMatchObject({ recipient: "manager@example.test", recipient_user_id: "manager-1" });
    const replay = dbForBinding({ recipient: "manager@example.test", recipient_user_id: "manager-1" });
    await expect(bindVendorReplyTarget(replay.db, { vendorUserId: "vendor-1", threadId: "thread-1", channel: "email", recipient: "manager@example.test", recipientUserId: "manager-1", messageId: "inbound-1" })).resolves.toBeUndefined();
  });

  it("stores a mailbox-only admin recipient as null, never an invalid UUID", async () => {
    const first = dbForBinding();
    await bindVendorReplyTarget(first.db, { vendorUserId: "vendor-1", threadId: "thread-admin", channel: "email", recipient: "support@proplane.com", recipientUserId: null, messageId: "admin-1" });
    expect(first.inserts[0]).toMatchObject({ recipient: "support@proplane.com", recipient_user_id: null });
  });

  it("fails closed when a replay attempts to retarget a thread", async () => {
    const db = dbForBinding({ recipient: "manager@example.test", recipient_user_id: "manager-1" });
    await expect(bindVendorReplyTarget(db.db, { vendorUserId: "vendor-1", threadId: "thread-1", channel: "email", recipient: "attacker@example.test", recipientUserId: "manager-2", messageId: "inbound-2" })).rejects.toThrow("binding conflict");
  });

  it("uses bindings for every reply and never synthesizes an SMS email address", () => {
    const outbound = readFileSync("src/lib/vendor-sponsored-outbound.server.ts", "utf8");
    const inbound = readFileSync("src/lib/vendor-work-identity-inbound.server.ts", "utf8");
    expect(outbound).toContain("binding?.recipient_user_id");
    expect(outbound).not.toContain("@sms.proplane.local");
    expect(inbound).not.toContain("row_data: { ...");
  });

  it("uses the profile phone as the one SMS destination for preflight, delivery, and binding", async () => {
    vi.clearAllMocks();
    deliver.mockResolvedValue({ ok: true, authorized: true, sent: true, providerMessageId: "sms-1" });
    deliverThread.mockResolvedValue({ threadId: "thread-sms", delivery: "sent" });
    const inserts: unknown[] = [];
    const from = vi.fn((table: string) => {
      const q: Record<string, unknown> = {};
      q.select = () => q; q.eq = () => q;
      q.maybeSingle = async () => table === "profiles"
        ? { data: { id: "manager-1", email: "manager@test.proplane", role: "manager", phone: "+12065550144" }, error: null }
        : table === "vendor_work_identities"
          ? { data: { id: "identity-1" }, error: null }
          : { data: null, error: null };
      q.insert = (row: unknown) => { inserts.push(row); return Promise.resolve({ error: null }); };
      q.then = (resolve: (value: unknown) => unknown) => resolve({ data: table === "manager_vendor_records" ? [{ manager_user_id: "manager-1" }] : [], error: null });
      return q;
    });
    const db = { from } as unknown as SupabaseClient;
    const actor = { userId: "vendor-1", email: "vendor@test.proplane", name: "Vendor" };
    const request = { channel: "sms" as const, subject: "Update", text: "Body", sendId: "send-1", recipientUserId: "manager-1" };
    await expect(sendVendorSponsoredOutbound(db, actor, { ...request, preflight: true })).resolves.toMatchObject({ ok: true, delivery: "sending" });
    expect(deliver).not.toHaveBeenCalled();
    await expect(sendVendorSponsoredOutbound(db, actor, request)).resolves.toMatchObject({ ok: true, delivery: "sent" });
    expect(deliver).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ channel: "sms", recipient: "+12065550144" }), expect.anything());
    expect(inserts).toContainEqual(expect.objectContaining({ recipient: "+12065550144", recipient_user_id: "manager-1" }));
  });

  it("resolves the primary admin profile before allowing a new SMS compose", async () => {
    vi.clearAllMocks();
    deliver.mockResolvedValue({ ok: true, authorized: true, sent: true, providerMessageId: "sms-1" });
    deliverThread.mockResolvedValue({ threadId: "thread-admin", delivery: "sent" });
    const from = vi.fn((table: string) => {
      const q: Record<string, unknown> = {};
      q.select = () => q; q.eq = () => q;
      q.maybeSingle = async () => table === "profiles"
        ? { data: { id: "admin-1", email: "support@proplane.com", role: "admin", phone: "+12065550155" }, error: null }
        : table === "vendor_work_identities"
          ? { data: { id: "identity-1" }, error: null }
          : { data: null, error: null };
      q.insert = () => Promise.resolve({ error: null });
      q.then = (resolve: (value: unknown) => unknown) => resolve({ data: [], error: null });
      return q;
    });
    const result = await sendVendorSponsoredOutbound(
      { from } as unknown as SupabaseClient,
      { userId: "vendor-1", email: "vendor@test.proplane", name: "Vendor" },
      { channel: "sms", subject: "Need help", text: "Body", sendId: "send-admin", recipientAdmin: true, preflight: true },
    );
    expect(result).toMatchObject({ ok: true, delivery: "sending" });
    expect(deliver).not.toHaveBeenCalled();
  });
});
