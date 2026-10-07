import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createFakeDb, type FakeDb, type Row } from "../helpers/fake-table-db";

const mocks = vi.hoisted(() => ({
  thread: vi.fn(),
  bind: vi.fn(),
  deliver: vi.fn(),
  owned: vi.fn(),
}));
vi.mock("@/lib/portal-inbox-delivery", () => ({
  deliverPortalMessageThreadSide: mocks.thread,
  scopeForRole: () => "vendor",
}));
vi.mock("@/lib/vendor-sponsored-outbound.server", () => ({ bindVendorReplyTarget: mocks.bind }));
vi.mock("@/lib/sms/resolve-owned-work-number.server", () => ({ resolveOwnedWorkNumber: mocks.owned }));
vi.mock("@/lib/vendor-work-identity-delivery.server", () => ({
  createVendorWorkIdentityDeliveryProvider: () => ({ configured: () => true, email: vi.fn(), sms: vi.fn() }),
  deliverVendorWorkIdentity: mocks.deliver,
}));

import { ingestVendorWorkIdentitySms } from "@/lib/vendor-work-identity-inbound.server";

const NOW = new Date("2026-10-06T18:00:00Z");
const HOUR = 3_600_000;
const VENDOR_NUMBER = "+14255550177";
const VENDOR_PHONE = "+12065550142";
const ALDER_LINE = "+12065550101";
const GREEN_LINE = "+12065550102";

function seed(extra: Record<string, Row[]> = {}, identity: Row = {}): FakeDb {
  return createFakeDb({
    vendor_work_identities: [{
      id: "identity-1", vendor_user_id: "vendor-1", phone_number: VENDOR_NUMBER, sms_state: "ready", sms_receive_ready: true,
      sms_send_ready: true, attachment_state: "attached", forward_to_phone: true, ...identity,
    }],
    profiles: [{ id: "vendor-1", phone: "(206) 555-0142", phone_verified_at: "2026-10-01T00:00:00Z" }],
    portal_workspaces: [{ id: "ws-alder", name: "Alder Property Co" }, { id: "ws-green", name: "Green Lake Rentals" }],
    vendor_work_identity_usage_events: [],
    vendor_work_number_conversations: [],
    ...extra,
  });
}

const run = (db: FakeDb, input: { from: string; text: string; sid: string; to?: string }) =>
  ingestVendorWorkIdentitySms(db as unknown as SupabaseClient, { toPhone: input.to ?? VENDOR_NUMBER, fromPhone: input.from, text: input.text, messageSid: input.sid }, { now: NOW });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.thread.mockResolvedValue({ threadId: "thread-1", action: "created" });
  mocks.deliver.mockResolvedValue({ ok: true, sent: true, providerMessageId: "SM1" });
  mocks.owned.mockImplementation(async (_db: unknown, phone: string) =>
    phone === ALDER_LINE ? { managerId: "mgr-alder", workspaceId: "ws-alder", messagingServiceSid: "MG1" }
      : phone === GREEN_LINE ? { managerId: "mgr-green", workspaceId: "ws-green", messagingServiceSid: "MG1" } : null);
});

describe("a manager's text to the vendor's PropLane number", () => {
  it("is stored in PropLane under the workspace's name and forwarded to the verified phone as [Workspace] text", async () => {
    const db = seed();
    const result = await run(db, { from: ALDER_LINE, text: "Can you look at the kitchen sink at Green Lake this week?", sid: "SM100" });
    expect(result).toEqual({ handled: true, idempotent: false });
    expect(mocks.thread).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      ownerUserId: "vendor-1", fromName: "Alder Property Co", outbound: false, channel: "sms", conversation: { otherPartyPhone: ALDER_LINE },
    }));
    expect(mocks.deliver).toHaveBeenCalledTimes(1);
    expect(mocks.deliver.mock.calls[0]![1]).toMatchObject({
      vendorUserId: "vendor-1", channel: "sms", recipient: VENDOR_PHONE,
      text: "[Alder Property Co] Can you look at the kitchen sink at Green Lake this week?", idempotencyKey: "vendor-fwd:SM100",
    });
    expect(db.tables.vendor_work_number_conversations![0]).toMatchObject({ identity_id: "identity-1", counterpart_phone: ALDER_LINE, workspace_name: "Alder Property Co", manager_user_id: "mgr-alder" });
    expect(db.tables.vendor_work_identity_usage_events![0]).toMatchObject({ meter: "inbound_sms", idempotency_key: "vendor-inbound-sms:SM100" });
  });

  it("is still stored but not forwarded when forwarding is off", async () => {
    const db = seed({}, { forward_to_phone: false });
    await run(db, { from: ALDER_LINE, text: "hello", sid: "SM101" });
    expect(mocks.thread).toHaveBeenCalledTimes(1);
    expect(mocks.deliver).not.toHaveBeenCalled();
  });

  it("is not forwarded to an unverified phone", async () => {
    const db = seed({ profiles: [{ id: "vendor-1", phone: "(206) 555-0142", phone_verified_at: null }] });
    await run(db, { from: ALDER_LINE, text: "hello", sid: "SM102" });
    expect(mocks.thread).toHaveBeenCalledTimes(1);
    expect(mocks.deliver).not.toHaveBeenCalled();
  });

  it("a redelivered webhook is idempotent: stored once, forwarded once", async () => {
    mocks.thread.mockResolvedValueOnce({ threadId: "thread-1", action: "skipped" });
    const result = await run(seed(), { from: ALDER_LINE, text: "hello", sid: "SM103" });
    expect(result).toEqual({ handled: true, idempotent: true });
    expect(mocks.deliver).not.toHaveBeenCalled();
  });

  it("a paused forward (STOP, or the fair-use cap) never loses the text: it is in PropLane", async () => {
    mocks.deliver.mockResolvedValue({ ok: false, reason: "platform_cap_reached" });
    const result = await run(seed(), { from: ALDER_LINE, text: "hello", sid: "SM104" });
    expect(result.handled).toBe(true);
    expect(mocks.thread).toHaveBeenCalledTimes(1);
  });

  it("a text from a number that is not a manager line is stored, never forwarded", async () => {
    const db = seed();
    await run(db, { from: "+13605550000", text: "who dis", sid: "SM105" });
    expect(mocks.thread).toHaveBeenCalledTimes(1);
    expect(mocks.deliver).not.toHaveBeenCalled();
    expect(db.tables.vendor_work_number_conversations).toHaveLength(0);
  });

  it("is ignored when the dialed number is not an active vendor number", async () => {
    expect(await run(seed(), { from: ALDER_LINE, text: "hi", sid: "SM106", to: "+14255550999" })).toEqual({ handled: false });
    expect(await run(seed({}, { sms_state: "disabled" }), { from: ALDER_LINE, text: "hi", sid: "SM107" })).toEqual({ handled: false });
    expect(mocks.thread).not.toHaveBeenCalled();
  });
});

describe("the vendor texting their number from their verified phone", () => {
  const convo = (phone: string, name: string, agoMs: number, mgr: string): Row => ({
    id: `c-${phone}`, identity_id: "identity-1", counterpart_phone: phone, workspace_name: name, manager_user_id: mgr,
    last_activity_at: new Date(NOW.getTime() - agoMs).toISOString(),
  });

  it("goes to the manager they last talked to", async () => {
    const db = seed({ vendor_work_number_conversations: [convo(ALDER_LINE, "Alder Property Co", 2 * HOUR, "mgr-alder")] });
    await run(db, { from: VENDOR_PHONE, text: "Yes, Thursday 10am", sid: "SM200" });
    expect(mocks.deliver).toHaveBeenCalledTimes(1);
    expect(mocks.deliver.mock.calls[0]![1]).toMatchObject({ channel: "sms", recipient: ALDER_LINE, text: "Yes, Thursday 10am", idempotencyKey: "vendor-route:SM200" });
    // Remembered as the newest outbound activity, and shown in the vendor's inbox as their own text.
    expect(db.tables.vendor_work_number_conversations![0]).toMatchObject({ last_outbound_at: NOW.toISOString() });
    expect(mocks.thread).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ outbound: true, body: "Yes, Thursday 10am", unread: false }));
  });

  it("asks which manager when two are active, and sends nothing to either", async () => {
    const db = seed({ vendor_work_number_conversations: [
      convo(ALDER_LINE, "Alder Property Co", 2 * HOUR, "mgr-alder"), convo(GREEN_LINE, "Green Lake Rentals", 5 * HOUR, "mgr-green"),
    ] });
    await run(db, { from: VENDOR_PHONE, text: "Thursday works", sid: "SM201" });
    expect(mocks.deliver).toHaveBeenCalledTimes(1);
    expect(mocks.deliver.mock.calls[0]![1]).toMatchObject({
      recipient: VENDOR_PHONE,
      text: "Reply to: 1) Alder Property Co 2) Green Lake Rentals — reply with the number first.",
      idempotencyKey: "vendor-route-prompt:SM201",
    });
    expect(mocks.thread).not.toHaveBeenCalled();
  });

  it("a numbered reply goes to that manager with the number stripped", async () => {
    const db = seed({ vendor_work_number_conversations: [
      convo(ALDER_LINE, "Alder Property Co", 2 * HOUR, "mgr-alder"), convo(GREEN_LINE, "Green Lake Rentals", 5 * HOUR, "mgr-green"),
    ] });
    await run(db, { from: VENDOR_PHONE, text: "2 Thursday works", sid: "SM202" });
    expect(mocks.deliver.mock.calls[0]![1]).toMatchObject({ recipient: GREEN_LINE, text: "Thursday works" });
  });

  it("asks when no conversation is recent", async () => {
    const db = seed({ vendor_work_number_conversations: [convo(ALDER_LINE, "Alder Property Co", 50 * HOUR, "mgr-alder")] });
    await run(db, { from: VENDOR_PHONE, text: "hello?", sid: "SM203" });
    expect(mocks.deliver.mock.calls[0]![1]).toMatchObject({ recipient: VENDOR_PHONE, text: expect.stringContaining("Reply to: 1) Alder Property Co") });
  });

  it("tells a vendor nobody has texted them yet instead of dropping the text silently", async () => {
    await run(seed(), { from: VENDOR_PHONE, text: "hello?", sid: "SM204" });
    expect(mocks.deliver.mock.calls[0]![1]).toMatchObject({ recipient: VENDOR_PHONE, text: expect.stringContaining("no manager has texted this number yet") });
  });

  it("a capped reply is not delivered and is not recorded as sent", async () => {
    mocks.deliver.mockResolvedValue({ ok: false, reason: "platform_cap_reached" });
    const db = seed({ vendor_work_number_conversations: [convo(ALDER_LINE, "Alder Property Co", 2 * HOUR, "mgr-alder")] });
    await run(db, { from: VENDOR_PHONE, text: "Yes", sid: "SM205" });
    expect(db.tables.vendor_work_number_conversations![0]!.last_outbound_at).toBeUndefined();
    expect(mocks.thread).not.toHaveBeenCalled();
  });
});
