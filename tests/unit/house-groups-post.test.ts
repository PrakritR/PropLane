// postToHouseGroup: the one door for a group post. Gated on the shared line AND the workspace switch; quiet hours;
// the daily cap; one wallet reservation per member and segment, handed back when nothing went out; idempotent.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeDb, fakeGateway, HOUSE, MIDNIGHT, NOON, noShield, WS } from "../helpers/house-group-fixtures";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceRoleClient: vi.fn() }));
const credit = vi.hoisted(() => ({
  reserveCommsCredit: vi.fn(),
  finishCommsCredit: vi.fn(),
}));
vi.mock("@/lib/comms-billing/wallet.server", () => credit);

import { postToHouseGroup } from "@/lib/house-groups/post.server";

const groupRows = () => ({
  house_group_conversations: [
    { id: "g1", workspace_id: WS, property_id: HOUSE, conversation_sid: "CH" + "1".repeat(32), status: "active", member_hash: "h" },
  ],
  house_group_members: [
    { id: "m1", group_id: "g1", phone_key: "2065550101", phone_e164: "+12065550101", first_name: "Maya", room_label: "Room 1", left_at: null },
    { id: "m2", group_id: "g1", phone_key: "2065550102", phone_e164: "+12065550102", first_name: "Sam", room_label: "Room 2", left_at: null },
    { id: "m3", group_id: "g1", phone_key: "2065550103", phone_e164: "+12065550103", first_name: "Lee", room_label: "Room 3", left_at: null },
  ],
});

const post = (over: Record<string, unknown> = {}) => ({
  workspaceId: WS,
  propertyId: HOUSE,
  text: "Water is off Tuesday 9 to 12.",
  kind: "announcement",
  idempotencyKey: "k1",
  ...over,
});

beforeEach(() => {
  credit.reserveCommsCredit.mockReset().mockResolvedValue({ allowed: true, duplicate: false, state: "reserved" });
  credit.finishCommsCredit.mockReset().mockResolvedValue(undefined);
});

describe("postToHouseGroup", () => {
  it("posts into the house's conversation and bills members x segments to the workspace", async () => {
    const { db, rows } = fakeDb(groupRows());
    const gateway = fakeGateway();
    const result = await postToHouseGroup(db, post(), { gateway, now: () => NOON, shielded: noShield });
    expect(result).toMatchObject({ ok: true });
    expect(gateway.posted).toEqual([{ conversationSid: "CH" + "1".repeat(32), body: "Water is off Tuesday 9 to 12." }]);
    expect(credit.reserveCommsCredit).toHaveBeenCalledWith(
      db,
      expect.objectContaining({ managerUserId: "owner-1", workspaceId: WS, meter: "sms_outbound_segment", quantity: 3 }),
    );
    expect(credit.finishCommsCredit).toHaveBeenCalledWith(db, "owner-1", expect.stringContaining("house-group:g1:k1"));
    expect(rows.house_group_messages).toHaveLength(1);
    expect(rows.house_group_messages[0]).toMatchObject({ direction: "outbound", kind: "announcement", message_sid: expect.stringMatching(/^IM/) });
  });

  it("reserves one segment per member per segment of text", async () => {
    const { db } = fakeDb(groupRows());
    await postToHouseGroup(db, post({ text: "x".repeat(200) }), { gateway: fakeGateway(), now: () => NOON, shielded: noShield });
    expect(credit.reserveCommsCredit).toHaveBeenCalledWith(db, expect.objectContaining({ quantity: 6 }));
  });

  it("is off while the line is per-workspace, the workspace is not on the pilot, or the switch is off", async () => {
    const gateway = fakeGateway();
    const perWorkspace = fakeDb({ ...groupRows(), sms_runtime_config: [{ singleton: true, line_mode: "per_workspace" }] });
    expect(await postToHouseGroup(perWorkspace.db, post(), { gateway, now: () => NOON, shielded: noShield })).toEqual({ ok: false, reason: "not_enabled" });
    const pilot = fakeDb({
      ...groupRows(),
      sms_runtime_config: [{ singleton: true, line_mode: "shared", shared_number_e164: "+12065550100", shared_pilot_workspace_ids: ["other-ws"] }],
    });
    expect(await postToHouseGroup(pilot.db, post(), { gateway, now: () => NOON, shielded: noShield })).toEqual({ ok: false, reason: "not_enabled" });
    const off = fakeDb({ ...groupRows(), house_group_settings: [{ workspace_id: WS, enabled: false, max_posts_per_day: 4 }] });
    expect(await postToHouseGroup(off.db, post(), { gateway, now: () => NOON, shielded: noShield })).toEqual({ ok: false, reason: "not_enabled" });
    const noSettings = fakeDb({ ...groupRows(), house_group_settings: [] });
    expect(await postToHouseGroup(noSettings.db, post(), { gateway, now: () => NOON, shielded: noShield })).toEqual({ ok: false, reason: "not_enabled" });
    expect(gateway.posted).toEqual([]);
    expect(credit.reserveCommsCredit).not.toHaveBeenCalled();
  });

  it("reads a house with no active group, or another workspace's group, as no_group", async () => {
    const gateway = fakeGateway();
    const none = fakeDb();
    expect(await postToHouseGroup(none.db, post(), { gateway, now: () => NOON, shielded: noShield })).toEqual({ ok: false, reason: "no_group" });
    const rows = groupRows();
    rows.house_group_conversations[0].workspace_id = "someone-elses";
    const other = fakeDb(rows);
    expect(await postToHouseGroup(other.db, post(), { gateway, now: () => NOON, shielded: noShield })).toEqual({ ok: false, reason: "no_group" });
    const retired = groupRows();
    retired.house_group_conversations[0].status = "retired";
    expect(await postToHouseGroup(fakeDb(retired).db, post(), { gateway, now: () => NOON, shielded: noShield })).toEqual({ ok: false, reason: "no_group" });
    expect(gateway.posted).toEqual([]);
  });

  it("posts nothing between 10 pm and 8 am except an emergency", async () => {
    const { db } = fakeDb(groupRows());
    const gateway = fakeGateway();
    expect(await postToHouseGroup(db, post({ kind: "reminder" }), { gateway, now: () => MIDNIGHT, shielded: noShield })).toEqual({ ok: false, reason: "quiet_hours" });
    expect(await postToHouseGroup(db, post({ kind: "announcement", idempotencyKey: "k2" }), { gateway, now: () => MIDNIGHT, shielded: noShield })).toEqual({ ok: false, reason: "quiet_hours" });
    expect(gateway.posted).toHaveLength(0);
    const emergency = await postToHouseGroup(db, post({ kind: "emergency", text: "Call 911.", idempotencyKey: "k3" }), { gateway, now: () => MIDNIGHT, shielded: noShield });
    expect(emergency.ok).toBe(true);
    expect(gateway.posted).toHaveLength(1);
  });

  it("stops at the daily cap, except announcements, emergencies and the intro", async () => {
    const { db } = fakeDb(groupRows());
    const gateway = fakeGateway();
    const deps = { gateway, now: () => NOON, shielded: noShield };
    for (let i = 0; i < 4; i += 1) {
      expect((await postToHouseGroup(db, post({ kind: "reminder", idempotencyKey: `r${i}`, text: `Reminder ${i}` }), deps)).ok).toBe(true);
    }
    expect(await postToHouseGroup(db, post({ kind: "reminder", idempotencyKey: "r4" }), deps)).toEqual({ ok: false, reason: "rate_limited" });
    expect(await postToHouseGroup(db, post({ kind: "answer", idempotencyKey: "a1" }), deps)).toEqual({ ok: false, reason: "rate_limited" });
    expect((await postToHouseGroup(db, post({ kind: "announcement", idempotencyKey: "n1" }), deps)).ok).toBe(true);
    expect((await postToHouseGroup(db, post({ kind: "emergency", idempotencyKey: "e1" }), deps)).ok).toBe(true);
    expect((await postToHouseGroup(db, post({ kind: "intro", idempotencyKey: "i1" }), deps)).ok).toBe(true);
  });

  it("returns the first send on a retry with the same key and bills once", async () => {
    const { db, rows } = fakeDb(groupRows());
    const gateway = fakeGateway();
    const deps = { gateway, now: () => NOON, shielded: noShield };
    const first = await postToHouseGroup(db, post(), deps);
    const again = await postToHouseGroup(db, post(), deps);
    expect(again).toEqual(first);
    expect(gateway.posted).toHaveLength(1);
    expect(credit.reserveCommsCredit).toHaveBeenCalledTimes(1);
    expect(rows.house_group_messages).toHaveLength(1);
  });

  it("refuses when the wallet refuses, and leaves no message behind", async () => {
    credit.reserveCommsCredit.mockResolvedValue({ allowed: false, reason: "insufficient_credit" });
    const { db, rows } = fakeDb(groupRows());
    const gateway = fakeGateway();
    const result = await postToHouseGroup(db, post(), { gateway, now: () => NOON, shielded: noShield });
    expect(result).toEqual({ ok: false, reason: "provider_error", detail: "budget" });
    expect(gateway.posted).toHaveLength(0);
    expect(rows.house_group_messages ?? []).toHaveLength(0);
  });

  it("hands the credit back and leaves no message when Twilio fails, so a retry can post", async () => {
    const { db, rows } = fakeDb(groupRows());
    const failing = fakeGateway({ fail: "postMessage" });
    const result = await postToHouseGroup(db, post(), { gateway: failing, now: () => NOON, shielded: noShield });
    expect(result).toMatchObject({ ok: false, reason: "provider_error" });
    expect(credit.finishCommsCredit).toHaveBeenCalledWith(db, "owner-1", expect.any(String), true);
    expect(rows.house_group_messages ?? []).toHaveLength(0);
    const retry = await postToHouseGroup(db, post(), { gateway: fakeGateway(), now: () => NOON, shielded: noShield });
    expect(retry.ok).toBe(true);
  });

  it("never posts into a group that holds a protected account's phone (outside production)", async () => {
    const { db } = fakeDb(groupRows());
    const gateway = fakeGateway();
    const result = await postToHouseGroup(db, post(), { gateway, now: () => NOON, shielded: async (phone) => phone === "+12065550102" });
    expect(result).toEqual({ ok: false, reason: "provider_error", detail: "protected_account_shielded" });
    expect(gateway.posted).toHaveLength(0);
  });

  it("fails without Twilio configured", async () => {
    const { db } = fakeDb(groupRows());
    const result = await postToHouseGroup(db, post(), { gateway: null, now: () => NOON, shielded: noShield });
    expect(result).toMatchObject({ ok: false, reason: "provider_error", detail: "twilio_not_configured" });
  });
});
