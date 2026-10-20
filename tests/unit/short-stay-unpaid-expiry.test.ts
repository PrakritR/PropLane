import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const emitActionEvent = vi.fn(async (..._args: unknown[]) => ({}));
vi.mock("@/lib/action-events.server", () => ({ emitActionEvent: (...args: unknown[]) => emitActionEvent(...args) }));
const enqueueOwnerSms = vi.fn(async (..._args: unknown[]) => ({ ok: true }));
vi.mock("@/lib/sms/owner-sms-dispatcher.server", () => ({ enqueueOwnerSms: (...args: unknown[]) => enqueueOwnerSms(...args) }));
vi.mock("@/lib/resend-delivery.server", () => ({ postResendEmail: vi.fn(async () => new Response("{}", { status: 200 })) }));
vi.mock("@/lib/manager-outbound-identity.server", () => ({ managerOutboundFromHeader: async () => "PropLane <work@proplane.test>" }));

import { releaseUnpaidConfirmedStays, unpaidConfirmationDue } from "@/lib/short-stay/unpaid-expiry.server";
import { guestStayChargeId } from "@/lib/short-stay/stay-charge.server";
import { GUEST, OWNER, PROPERTY, seedShortStayDb } from "../helpers/short-stay-seed";

const NOW = new Date("2026-10-20T20:00:00Z");
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000).toISOString();

function confirmedRow(id: string, over: Record<string, unknown> = {}, details: Record<string, unknown> = {}) {
  return {
    id,
    manager_user_id: OWNER,
    property_id: PROPERTY,
    record_type: "room_date_block",
    starts_at: "2026-10-28T00:00:00",
    ends_at: "2026-10-31T00:00:00",
    row_data: {
      id, recordType: "room_date_block", propertyId: PROPERTY, roomId: "r1", checkIn: "2026-10-28", checkOut: "2026-10-31",
      bookingStatus: "confirmed", rate: 140, rateBasis: "daily", quotedNights: 3, quotedTotal: 420, guests: 1,
      residentName: "Priya", residentPhone: "+12065550142", residentUserId: GUEST,
      stayDetails: { source: "sms_short_stay", guests: 1, confirmedAt: hoursAgo(25), ...details },
      ...over,
    },
  };
}
const charge = (blockId: string, status: string) => ({
  id: guestStayChargeId(blockId), status, manager_user_id: OWNER, resident_user_id: GUEST,
  row_data: { id: guestStayChargeId(blockId), kind: "stay_total", status, amountLabel: "$420.00" },
});

function seeded(rows: ReturnType<typeof confirmedRow>[], charges: ReturnType<typeof charge>[]) {
  const db = seedShortStayDb();
  db.tables.portal_schedule_records!.push(...rows);
  db.tables.portal_household_charge_records!.push(...charges);
  db.tables.phone_bound_links = [{ id: "l1", target_type: "charge", target_id: charges[0]?.id ?? "", purpose: "rent", revoked_at: null }];
  return db;
}

beforeEach(() => vi.clearAllMocks());

describe("a confirmed stay left unpaid for 24 hours", () => {
  it("is due only for a guest's own confirmed request, 24h+ after confirmation, with check-in ahead", () => {
    const row = confirmedRow("b").row_data;
    expect(unpaidConfirmationDue(row, NOW, "2026-10-20")).toBe(true);
    expect(unpaidConfirmationDue({ ...row, stayDetails: { ...row.stayDetails, confirmedAt: hoursAgo(23) } }, NOW, "2026-10-20")).toBe(false);
    expect(unpaidConfirmationDue({ ...row, stayDetails: { ...row.stayDetails, source: "Direct" } }, NOW, "2026-10-20")).toBe(false);
    expect(unpaidConfirmationDue({ ...row, checkIn: "2026-10-20" }, NOW, "2026-10-20")).toBe(false);
    expect(unpaidConfirmationDue({ ...row, bookingStatus: "hold" }, NOW, "2026-10-20")).toBe(false);
  });

  it("releases the nights, cancels the charge, ends the pay link, texts the guest and tells the team - once", async () => {
    const db = seeded([confirmedRow("blk-1")], [charge("blk-1", "pending")]);
    const result = await releaseUnpaidConfirmedStays(db as never, NOW);
    expect(result).toMatchObject({ checked: 1, released: 1, kept: 0, failed: 0 });
    const stored = db.tables.portal_schedule_records!.find((r) => r.id === "blk-1")!;
    expect(stored.record_type).toBe("cancelled_room_date_block");
    expect(stored.row_data).toMatchObject({ bookingStatus: "cancelled", reason: "Unpaid stay released", stayDetails: { decision: "unpaid_expired" } });
    expect(db.tables.portal_household_charge_records!.find((c) => c.id === guestStayChargeId("blk-1"))).toMatchObject({ status: "cancelled" });
    expect(db.tables.phone_bound_links![0]!.revoked_at).toBeTruthy();
    const sms = enqueueOwnerSms.mock.calls[0]![0] as { recipientPhone: string; body: string; purpose: string };
    expect(sms).toMatchObject({ recipientPhone: "+12065550142", purpose: "short_stay_unpaid_expired" });
    expect(sms.body).toContain("within 24 hours, so those nights are free again");
    expect(emitActionEvent.mock.calls.map((c) => (c[1] as { event: string }).event)).toEqual(["short_stay_unpaid_expired"]);

    // Idempotent: the next cron run finds nothing to do.
    const again = await releaseUnpaidConfirmedStays(db as never, NOW);
    expect(again).toMatchObject({ checked: 0, released: 0 });
    expect(enqueueOwnerSms).toHaveBeenCalledTimes(1);
    expect(emitActionEvent).toHaveBeenCalledTimes(1);
  });

  it("keeps a stay that is paid, clearing (processing), has no charge, or is not the guest's request", async () => {
    const db = seeded(
      [confirmedRow("paid"), confirmedRow("clearing"), confirmedRow("nocharge"), confirmedRow("manager", {}, { source: "Direct" }), confirmedRow("fresh", {}, { confirmedAt: hoursAgo(3) })],
      [charge("paid", "paid"), charge("clearing", "processing"), charge("manager", "pending"), charge("fresh", "pending")],
    );
    const result = await releaseUnpaidConfirmedStays(db as never, NOW);
    expect(result).toMatchObject({ released: 0, failed: 0 });
    expect(db.tables.portal_schedule_records!.filter((r) => r.record_type === "room_date_block")).toHaveLength(5);
    expect(enqueueOwnerSms).not.toHaveBeenCalled();
  });
});
