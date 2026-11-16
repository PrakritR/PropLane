import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFinanceFakeDb } from "../helpers/finance-fake-db";

vi.mock("server-only", () => ({}));
const send = vi.hoisted(() => vi.fn());
const notify = vi.hoisted(() => vi.fn());
vi.mock("@/lib/vendor-dispatch/send.server", () => ({ sendVendorDispatchText: send }));
vi.mock("@/lib/agent-notify.server", () => ({ notifyManagerFromAgent: notify }));
vi.mock("@/lib/communication/manager-assistant-workspace.server", () => ({
  resolveManagerAssistantWorkspace: vi.fn(async () => ({ workspaceId: "ws-1" })),
  userDefaultWorkspaceId: vi.fn(async () => "ws-default"),
}));

import { checkInSendDates, classifyCheckInReplyIntent, isOptOutText, normalizeVendorCheckIn, renderCheckInQuestion, cadenceLabel, VENDOR_CHECK_IN_CADENCE_OPTIONS } from "@/lib/vendor-check-ins";
import { handleVendorCheckInReply, sweepVendorCheckIns } from "@/lib/vendor-check-ins.server";

const OWNER = "11111111-1111-4111-8111-111111111111";
const QUESTION = "Hi {vendor}, when are you coming to clean next? Reply with the day and time.";

function checkIn(overrides: Record<string, unknown> = {}) {
  return {
    id: "ci_1", question: QUESTION, cadence: { monthDays: [1, 14] }, weekday: 1, hour: 10, minute: 0, channel: "sms",
    enabled: true, onNoOrSilent: "inbox", anchorDate: "2026-11-01", createdAt: "2026-11-01T00:00:00Z", log: [], ...overrides,
  };
}

function seed(rowOverrides: Record<string, unknown> = {}, ci: Record<string, unknown> = {}) {
  return createFinanceFakeDb({
    manager_vendor_records: [
      {
        id: "vendor-cleaner", manager_user_id: OWNER, updated_at: "2026-11-01T00:00:00Z",
        row_data: { id: "vendor-cleaner", name: "Rosa Test", phone: "(206) 555-0142", active: true, propertyIds: ["prop-1"], checkIns: [checkIn(ci)], ...rowOverrides },
      },
    ],
  });
}

const log = (db: ReturnType<typeof seed>) => ((db.table("manager_vendor_records")[0]!.row_data as { checkIns: Array<{ log: Array<Record<string, unknown>> }> }).checkIns[0]!.log);

// 10:05 Pacific (PST, UTC-8) on Nov 14 2026
const NOV14_1005 = new Date("2026-11-14T18:05:00Z");

beforeEach(() => {
  send.mockReset().mockResolvedValue({ ok: true, outboxId: "o1" });
  notify.mockReset().mockResolvedValue({ delivered: true, suppressed: false });
});

describe("cadence: the 1st and 14th of the month", () => {
  it("fires on the 1st and 14th, clamps a 31st to the month's last day, and is offered in the UI options", () => {
    const base = normalizeVendorCheckIn(checkIn())!;
    expect(checkInSendDates(base, "2026-11-01", 30)).toEqual(["2026-11-01", "2026-11-14"]);
    const thirtyFirst = normalizeVendorCheckIn(checkIn({ cadence: { monthDays: [31] } }))!;
    expect(checkInSendDates(thirtyFirst, "2026-02-01", 28)).toEqual(["2026-02-28"]);
    expect(VENDOR_CHECK_IN_CADENCE_OPTIONS.some((o) => o.id === "monthdays-1-14")).toBe(true);
    expect(cadenceLabel({ monthDays: [1, 14] })).toBe("1st and 14th of the month");
  });

  it("normalizes a stored cadence and drops bad days", () => {
    expect(normalizeVendorCheckIn(checkIn({ cadence: { monthDays: [14, 1, 99, "x", 1] } }))!.cadence).toEqual({ monthDays: [1, 14] });
  });
});

describe("question + reply rules (pure)", () => {
  it("renders {vendor} from config and never invents a name", () => {
    expect(renderCheckInQuestion(QUESTION, { vendor: "Rosa" })).toBe("Hi Rosa, when are you coming to clean next? Reply with the day and time.");
    expect(renderCheckInQuestion("Hi {vendor}, ok?", { vendor: "" })).toBe("Hi, ok?");
  });
  it("pay and schedule-change replies escalate; a day and time does not", () => {
    expect(classifyCheckInReplyIntent("Tuesday at 2pm")).toBe("routine");
    expect(classifyCheckInReplyIntent("yes I'll be there")).toBe("routine");
    expect(classifyCheckInReplyIntent("Can you pay me $120 for last time?")).toBe("escalate");
    expect(classifyCheckInReplyIntent("my rate is going up")).toBe("escalate");
    expect(classifyCheckInReplyIntent("I need to reschedule, can't make Tuesday")).toBe("escalate");
    expect(classifyCheckInReplyIntent("tengo que cancelar")).toBe("escalate");
    expect(isOptOutText("STOP")).toBe(true);
    expect(isOptOutText("stop by Tuesday")).toBe(false);
  });
});

describe("sweepVendorCheckIns", () => {
  it("texts the cleaner on the 14th from the vendor record's own config, once, and logs the send", async () => {
    const db = seed();
    const first = await sweepVendorCheckIns(db as never, NOV14_1005);
    expect(first).toMatchObject({ vendors: 1, due: 1, sent: 1, failed: 0, errors: [] });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]![1]).toMatchObject({
      ownerUserId: OWNER, workspaceId: "ws-1", vendorDirectoryId: "vendor-cleaner", phone: "+12065550142",
      text: "Hi Rosa, when are you coming to clean next? Reply with the day and time.",
      idempotencyKey: "vendor_checkin:vendor-cleaner:ci_1:2026-11-14",
    });
    expect(log(db)).toHaveLength(1);
    const again = await sweepVendorCheckIns(db as never, new Date(NOV14_1005.getTime() + 600_000));
    expect(again.sent).toBe(0);
    expect(send).toHaveBeenCalledTimes(1);
    expect(log(db)).toHaveLength(1);
  });

  it("does not send before the fire time, on other days, or when the check-in is off", async () => {
    const db = seed();
    expect((await sweepVendorCheckIns(db as never, new Date("2026-11-14T17:55:00Z"))).sent).toBe(0); // 9:55 Pacific
    expect((await sweepVendorCheckIns(db as never, new Date("2026-11-13T18:05:00Z"))).sent).toBe(0);
    expect((await sweepVendorCheckIns(db as never, new Date("2026-11-15T07:00:00Z"))).sent).toBe(0); // 11pm Pacific Nov 14, 13h late: past the grace window
    const off = seed({}, { enabled: false });
    expect((await sweepVendorCheckIns(off as never, NOV14_1005)).sent).toBe(0);
    expect(send).not.toHaveBeenCalled();
  });

  it("catches up inside the grace window (a missed tick) and sends again on the 1st", async () => {
    const db = seed();
    expect((await sweepVendorCheckIns(db as never, new Date("2026-11-14T22:00:00Z"))).sent).toBe(1); // 2pm Pacific
    expect((await sweepVendorCheckIns(db as never, new Date("2026-12-01T18:30:00Z"))).sent).toBe(1);
    expect(log(db)).toHaveLength(2);
  });

  it("a vendor with no phone closes the occurrence with a reason instead of retrying every tick", async () => {
    const db = seed({ phone: "" });
    const summary = await sweepVendorCheckIns(db as never, NOV14_1005);
    expect(summary).toMatchObject({ sent: 0, failed: 1 });
    expect(log(db)[0]).toMatchObject({ failure: "no_phone" });
    await sweepVendorCheckIns(db as never, new Date(NOV14_1005.getTime() + 600_000));
    expect(log(db)).toHaveLength(1);
    expect(send).not.toHaveBeenCalled();
  });

  it("a send the consent ledger refuses (STOP) is logged as failed and never retried", async () => {
    send.mockResolvedValue({ ok: false, reason: "vendor_opted_out" });
    const db = seed();
    expect((await sweepVendorCheckIns(db as never, NOV14_1005)).failed).toBe(1);
    expect(log(db)[0]).toMatchObject({ failure: "vendor_opted_out" });
    await sweepVendorCheckIns(db as never, new Date(NOV14_1005.getTime() + 600_000));
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("silence after 24 hours raises one notice to the owner (rule 'inbox'), and only one", async () => {
    const db = seed({}, { log: [{ sentAt: "2026-11-14T18:05:00.000Z", reminderId: "vendor_checkin:vendor-cleaner:ci_1:2026-11-14", channel: "sms" }] });
    const later = new Date("2026-11-15T19:00:00Z");
    expect((await sweepVendorCheckIns(db as never, later)).rules).toBe(1);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0]![1]).toMatchObject({ landlordId: OWNER, subject: "No reply from Rosa" });
    await sweepVendorCheckIns(db as never, new Date(later.getTime() + 600_000));
    expect(notify).toHaveBeenCalledTimes(1);
  });
});

describe("handleVendorCheckInReply", () => {
  const openLog = [{ sentAt: "2026-11-14T18:05:00.000Z", reminderId: "k", channel: "sms" }];
  const reply = (db: ReturnType<typeof seed>, body: string, extra: Record<string, unknown> = {}) =>
    handleVendorCheckInReply(db as never, { ownerUserId: OWNER, workspaceId: "ws-1", phoneE164: "+12065550142", body, messageSid: `SM${Math.random().toString(36).slice(2)}`, now: new Date("2026-11-14T20:00:00Z"), ...extra });

  it("a routine reply is attached to the check-in, acknowledged, and handled (so it lands in the vendor thread)", async () => {
    const db = seed({}, { log: openLog });
    const result = await reply(db, "Tuesday at 2pm");
    expect(result).toEqual({ handled: true, vendorUserId: null, escalated: false });
    expect(log(db)[0]!.reply).toMatchObject({ text: "Tuesday at 2pm" });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]![1].text).toBe("Thanks Rosa, noted.");
    expect(notify).not.toHaveBeenCalled();
  });

  it("a pay message escalates to the owner and tells the vendor the owner will answer", async () => {
    const db = seed({}, { log: openLog });
    const result = await reply(db, "Can you pay me $120 for last time?");
    expect(result).toMatchObject({ handled: true, escalated: true });
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0]![1]).toMatchObject({ landlordId: OWNER, subject: "Rosa needs you: pay or schedule" });
    expect(notify.mock.calls[0]![1].text).toContain("$120");
    expect(send.mock.calls[0]![1].text).toContain("passed that to the owner");
  });

  it("a schedule-change message escalates too", async () => {
    const db = seed({}, { log: openLog });
    expect(await reply(db, "I need to reschedule, can't make Tuesday")).toMatchObject({ escalated: true });
  });

  it("is not ours: STOP, an unknown phone, a different owner, an already-answered check-in, or no open check-in", async () => {
    const db = seed({}, { log: openLog });
    expect(await reply(db, "STOP")).toEqual({ handled: false });
    expect(await reply(db, "hello", { phoneE164: "+12065550199" })).toEqual({ handled: false });
    expect(await reply(db, "hello", { ownerUserId: "someone-else" })).toEqual({ handled: false });
    expect(await reply(db, "hello", { now: new Date("2026-11-20T00:00:00Z") })).toEqual({ handled: false });
    expect(await reply(seed(), "hello")).toEqual({ handled: false });
    await reply(db, "Tuesday");
    expect(await reply(db, "also Wednesday")).toEqual({ handled: false });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("never answers a send that failed (no live question to answer)", async () => {
    const db = seed({}, { log: [{ ...openLog[0], failure: "no_phone", ruleRanAt: "2026-11-14T18:05:00.000Z" }] });
    expect(await reply(db, "Tuesday")).toEqual({ handled: false });
  });
});
