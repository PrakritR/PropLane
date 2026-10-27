// An admin answering an Unassigned lead from the PropLane line: who sent it is on the turn, a send that went out but was
// not saved is reported as exactly that, and quiet hours are skipped only while the lead's last text is recent.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { leadFakeDb, type LeadFakeDb } from "../helpers/lead-fake-db";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceRoleClient: vi.fn() }));
vi.mock("@/lib/seo/public-catalog.server", () => ({ getCrawlPublicListings: vi.fn(async () => []) }));
vi.mock("@/lib/one-number/lead-extract.server", () => ({ extractLeadFieldsWithModel: vi.fn(async () => null) }));
vi.mock("@/lib/manager-sms-messages.server", () => ({ logManagerSmsMessage: vi.fn(async () => true) }));
vi.mock("@/lib/sms/manager-sms-contacts.server", () => ({ upsertManagerSmsContact: vi.fn(async () => ({ ok: true })) }));
vi.mock("@/lib/one-number/team-alerts.server", () => ({ alertWorkspaceTeam: vi.fn(async () => ({ sent: true })) }));

import { ADMIN_LEAD_REPLY_NOT_SAVED_ERROR, sendAdminLeadReply } from "@/lib/one-number/admin-lead-reply.server";

const LEAD_ID = "lead-1";
const ADMIN = "admin-prakrit";
const NOW = new Date("2026-10-27T20:00:00Z");
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000).toISOString();

let world: LeadFakeDb;
const send = vi.fn();

function seed(lastInboundAt: string | null, options: Parameters<typeof leadFakeDb>[1] = {}) {
  world = leadFakeDb(
    { sms_unassigned_leads: [{ id: LEAD_ID, phone_key: "2065550142", status: "open", last_inbound_at: lastInboundAt }], sms_unassigned_lead_turns: [] },
    options,
  );
}
const reply = (over: Record<string, unknown> = {}) =>
  sendAdminLeadReply(world.db, { leadId: LEAD_ID, text: "Hi, the room is still open.", adminUserId: ADMIN, now: NOW, ...over }, { send: send as never });

beforeEach(() => {
  send.mockReset();
  send.mockResolvedValue({ ok: true, sid: "SM123" });
});

describe("an admin's reply to a lead", () => {
  it("is saved in the thread with the admin who sent it", async () => {
    seed(hoursAgo(1));
    expect(await reply()).toEqual({ ok: true, sid: "SM123" });
    expect(world.rows.sms_unassigned_lead_turns).toHaveLength(1);
    expect(world.rows.sms_unassigned_lead_turns![0]).toMatchObject({
      lead_id: LEAD_ID,
      direction: "outbound",
      message_sid: "reply:admin:SM123",
      media: { sentBy: ADMIN },
    });
  });

  it("is reported as sent-but-not-saved when the thread insert fails, never silently dropped", async () => {
    seed(hoursAgo(1), { failing: ["sms_unassigned_lead_turns"] });
    const result = await reply();
    expect(send).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ ok: false, status: 502, error: ADMIN_LEAD_REPLY_NOT_SAVED_ERROR, sent: true });
    expect(ADMIN_LEAD_REPLY_NOT_SAVED_ERROR).toBe("Sent, but not saved to the thread.");
  });

  it("is saved nowhere when the text itself was refused", async () => {
    seed(hoursAgo(1));
    send.mockResolvedValue({ ok: false, reason: "opted_out" });
    expect(await reply()).toMatchObject({ ok: false, status: 409 });
    expect(world.rows.sms_unassigned_lead_turns).toHaveLength(0);
  });
});

describe("quiet hours", () => {
  it("are skipped as a reply only while the lead's last inbound text is within 24 hours", async () => {
    seed(hoursAgo(23));
    await reply();
    expect(send.mock.calls[0]![1]).toMatchObject({ inboundReply: true });

    send.mockClear();
    seed(hoursAgo(25));
    await reply();
    expect(send.mock.calls[0]![1]).toMatchObject({ inboundReply: false });
  });

  it("a lead with no recorded inbound text is not being answered", async () => {
    seed(null);
    await reply();
    expect(send.mock.calls[0]![1]).toMatchObject({ inboundReply: false });
  });

  it("a stale lead texted overnight is held, and nothing is saved", async () => {
    seed(hoursAgo(72));
    send.mockResolvedValue({ ok: false, reason: "quiet_hours" });
    expect(await reply()).toMatchObject({ ok: false, status: 409, error: "Texts to this number are paused until morning." });
    expect(world.rows.sms_unassigned_lead_turns).toHaveLength(0);
  });
});
