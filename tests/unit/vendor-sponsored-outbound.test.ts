import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { aggregateVendorSponsoredDelivery } from "@/lib/vendor-sponsored-delivery-state";
import { commitInboxThreadReply, deliverPortalMessageThreadSide } from "@/lib/portal-inbox-delivery";

type Row = { id: string; scope: string; owner_user_id: string | null; participant_email: string | null; thread_type: string; updated_at: string; row_data: Record<string, unknown> };
function inboxDb(initial: Row | null) {
  let row = initial;
  const writes: Row[] = [];
  const q: Record<string, unknown> = {};
  q.select = () => q; q.eq = () => q; q.order = () => q; q.limit = () => q;
  q.maybeSingle = async () => ({ data: row, error: null });
  q.then = (resolve: (value: unknown) => unknown) => resolve({ data: row ? [row] : [], error: null });
  q.upsert = vi.fn(async (next: Row) => { writes.push(next); row = next; return { error: null }; });
  return { db: { from: () => q } as unknown as SupabaseClient, writes };
}
const side = { scope: "axis_portal_inbox_vendor_v1", folder: "sent" as const, ownerUserId: "vendor-1", participantEmail: null, otherPartyEmail: "manager@example.test", fallbackId: "thread-1", fromName: "Vendor", subject: "Service update", body: "The vendor reply", preview: "The vendor reply", when: "Sep 20, 9:00 AM", unread: false, outbound: true, messageId: "vendor-sponsored:send-1" };

describe("vendor sponsored logical delivery", () => {
  it("keeps a sent email bubble sent when SMS later fails or reconciles", () => {
    expect(aggregateVendorSponsoredDelivery(["sent", "failed"])).toBe("sent");
    expect(aggregateVendorSponsoredDelivery(["sending"], "sent")).toBe("sent");
  });
  it("is sending for an authorized uncertain channel and failed only when all fail", () => {
    expect(aggregateVendorSponsoredDelivery(["failed", "sending"])).toBe("sending");
    expect(aggregateVendorSponsoredDelivery(["failed", "failed"])).toBe("failed");
  });

  it("does not downgrade a durable sent root when SMS later fails", async () => {
    const { db, writes } = inboxDb({ id: "thread-1", scope: side.scope, owner_user_id: "vendor-1", participant_email: null, thread_type: "portal_message", updated_at: "2026-09-20T00:00:00Z", row_data: { folder: "sent", email: side.otherPartyEmail, rootMessageId: side.messageId, rootDelivery: "sent" } });
    const result = await deliverPortalMessageThreadSide(db, { ...side, channel: "sms", delivery: "failed" });
    expect(result).toMatchObject({ action: "skipped", delivery: "sent" });
    expect(writes).toHaveLength(0);
  });

  it("does not downgrade a durable sent reply turn when SMS later fails", async () => {
    const { db, writes } = inboxDb({ id: "thread-1", scope: side.scope, owner_user_id: "vendor-1", participant_email: null, thread_type: "portal_message", updated_at: "2026-09-20T00:00:00Z", row_data: { messages: [{ id: side.messageId, delivery: "sent", body: side.body }] } });
    const result = await commitInboxThreadReply(db, { threadId: "thread-1", scope: side.scope, ownerUserId: "vendor-1", participantEmail: null, threadType: "portal_message", rowData: {} }, { fromName: "Vendor", text: side.body, messageId: side.messageId, channel: "sms", delivery: "failed" });
    expect(result).toBe("sent");
    expect(writes).toHaveLength(0);
  });

  it("projects authorized failure and ambiguity as durable Failed and Sending bubbles", async () => {
    const failed = inboxDb(null);
    expect((await deliverPortalMessageThreadSide(failed.db, { ...side, delivery: "failed" })).delivery).toBe("failed");
    expect(failed.writes[0]?.row_data.rootDelivery).toBe("failed");
    const pending = inboxDb(null);
    expect((await deliverPortalMessageThreadSide(pending.db, { ...side, fallbackId: "thread-2", delivery: "sending" })).delivery).toBe("sending");
    expect(pending.writes[0]?.row_data.rootDelivery).toBe("sending");
  });
});
