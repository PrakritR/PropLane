// Who gets the AI on a vendor's number: clients and residents, never a manager's line, never another
// vendor's number, never a PropLane manager texting from a personal phone, never a retried webhook.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createFakeDb, type FakeDb, type Row } from "../helpers/fake-table-db";

const mocks = vi.hoisted(() => ({
  thread: vi.fn(),
  bind: vi.fn(),
  deliver: vi.fn(),
  owned: vi.fn(),
  ai: vi.fn(),
}));
vi.mock("@/lib/portal-inbox-delivery", () => ({ deliverPortalMessageThreadSide: mocks.thread, scopeForRole: () => "vendor" }));
vi.mock("@/lib/vendor-sponsored-outbound.server", () => ({ bindVendorReplyTarget: mocks.bind }));
vi.mock("@/lib/sms/resolve-owned-work-number.server", () => ({ resolveOwnedWorkNumber: mocks.owned }));
vi.mock("@/lib/vendor-work-identity-delivery.server", () => ({
  createVendorWorkIdentityDeliveryProvider: () => ({ configured: () => true, email: vi.fn(), sms: vi.fn() }),
  deliverVendorWorkIdentity: mocks.deliver,
}));
vi.mock("@/lib/agent/vendor-number-ai.server", () => ({ runVendorNumberAiReply: mocks.ai }));

import { ingestVendorWorkIdentitySms } from "@/lib/vendor-work-identity-inbound.server";

const NOW = new Date("2026-10-08T18:00:00Z");
const VENDOR_NUMBER = "+14255550177";
const VENDOR_PHONE = "+12065550142";
const ALDER_LINE = "+12065550101";
const CLIENT = "+12065550199";

function seed(extra: Record<string, Row[]> = {}): FakeDb {
  return createFakeDb({
    vendor_work_identities: [{
      id: "identity-1", vendor_user_id: "vendor-1", phone_number: VENDOR_NUMBER, sms_state: "ready", sms_receive_ready: true,
      sms_send_ready: true, attachment_state: "attached", forward_to_phone: true,
    }],
    profiles: [{ id: "vendor-1", phone: VENDOR_PHONE, phone_verified_at: "2026-10-01T00:00:00Z" }],
    profile_roles: [],
    portal_workspaces: [{ id: "ws-alder", name: "Alder Property Co" }],
    vendor_work_identity_usage_events: [],
    vendor_work_number_conversations: [],
    ...extra,
  });
}
const ingest = (db: FakeDb, from: string, sid: string, text = "what are your hours?") =>
  ingestVendorWorkIdentitySms(db as unknown as SupabaseClient, { toPhone: VENDOR_NUMBER, fromPhone: from, text, messageSid: sid }, { now: NOW });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.thread.mockResolvedValue({ threadId: "thread-1", action: "created" });
  mocks.deliver.mockResolvedValue({ ok: true, sent: true });
  mocks.ai.mockResolvedValue("replied");
  mocks.owned.mockImplementation(async (_db: unknown, phone: string) =>
    phone === ALDER_LINE ? { managerId: "mgr-alder", workspaceId: "ws-alder", messagingServiceSid: "MG1" } : null);
});

describe("the AI after the text is stored", () => {
  it("is scheduled for a client, with the stored thread, and runs only after the webhook responds", async () => {
    const db = seed();
    const result = await ingest(db, CLIENT, "SM1");
    expect(result.handled).toBe(true);
    expect(mocks.thread).toHaveBeenCalledTimes(1); // the text is stored first
    expect(mocks.ai).not.toHaveBeenCalled(); // nothing yet: the route runs it after the response
    await result.afterResponse!();
    expect(mocks.ai).toHaveBeenCalledWith(
      db,
      expect.objectContaining({ from: CLIENT, text: "what are your hours?", messageSid: "SM1", threadId: "thread-1", number: expect.objectContaining({ vendorUserId: "vendor-1" }) }),
      expect.objectContaining({ provider: expect.anything() }),
    );
  });

  it("never runs for a manager's work line: the text is delivered to the vendor as before", async () => {
    const result = await ingest(seed(), ALDER_LINE, "SM2", "Can you look at the sink at Green Lake?");
    expect(result.handled).toBe(true);
    expect(result.afterResponse).toBeUndefined();
    expect(mocks.ai).not.toHaveBeenCalled();
    // Delivered as today: forwarded to the vendor's verified phone as [Workspace] text.
    expect(mocks.deliver).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ recipient: VENDOR_PHONE }), expect.anything());
  });

  it("never runs for a PropLane manager or admin texting from a personal phone", async () => {
    const db = seed({
      profiles: [
        { id: "vendor-1", phone: VENDOR_PHONE, phone_verified_at: "2026-10-01T00:00:00Z" },
        { id: "mgr-1", phone: CLIENT },
      ],
      profile_roles: [{ user_id: "mgr-1", role: "manager" }],
    });
    expect((await ingest(db, CLIENT, "SM3")).afterResponse).toBeUndefined();
  });

  it("recognizes a manager whose stored phone is not E.164 (bare 10 digits, or 1 + 10)", async () => {
    for (const [i, stored] of ["2065550199", "12065550199"].entries()) {
      const db = seed({
        profiles: [
          { id: "vendor-1", phone: VENDOR_PHONE, phone_verified_at: "2026-10-01T00:00:00Z" },
          { id: "mgr-1", phone: stored },
        ],
        profile_roles: [{ user_id: "mgr-1", role: "manager" }],
      });
      expect((await ingest(db, CLIENT, `SM3-${i}`)).afterResponse).toBeUndefined();
    }
  });

  it("runs for a resident account (a PropLane user who is not a manager)", async () => {
    const db = seed({
      profiles: [
        { id: "vendor-1", phone: VENDOR_PHONE, phone_verified_at: "2026-10-01T00:00:00Z" },
        { id: "res-1", phone: CLIENT },
      ],
      profile_roles: [{ user_id: "res-1", role: "resident" }],
    });
    expect((await ingest(db, CLIENT, "SM4")).afterResponse).toBeDefined();
  });

  it("never runs for another vendor's PropLane number (two AIs would loop)", async () => {
    const db = seed();
    db.tables.vendor_work_identities!.push({ id: "identity-2", vendor_user_id: "vendor-2", phone_number: CLIENT, sms_state: "ready" });
    expect((await ingest(db, CLIENT, "SM5")).afterResponse).toBeUndefined();
  });

  it("never runs when the account lookup is unreadable", async () => {
    const db = seed();
    const original = db.from.bind(db);
    db.from = ((table: string) => {
      if (table === "profile_roles") throw new Error("down");
      return original(table);
    }) as typeof db.from;
    db.tables.profiles!.push({ id: "res-1", phone: CLIENT });
    expect((await ingest(db, CLIENT, "SM6")).afterResponse).toBeUndefined();
  });

  it("never runs twice for a retried webhook, or for an empty (media-only) text", async () => {
    mocks.thread.mockResolvedValue({ threadId: "thread-1", action: "skipped" });
    expect((await ingest(seed(), CLIENT, "SM7")).afterResponse).toBeUndefined();
    mocks.thread.mockResolvedValue({ threadId: "thread-1", action: "created" });
    expect((await ingest(seed(), CLIENT, "SM8", "   ")).afterResponse).toBeUndefined();
  });

  it("never runs for the vendor's own phone texting their number", async () => {
    const result = await ingest(seed({ vendor_work_number_conversations: [] }), VENDOR_PHONE, "SM9", "ok");
    expect(result.afterResponse).toBeUndefined();
  });

  it("a failing AI turn never breaks the webhook's follow-up", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.ai.mockRejectedValue(new Error("boom"));
    const result = await ingest(seed(), CLIENT, "SM10");
    await expect(result.afterResponse!()).resolves.toBeUndefined();
  });
});
