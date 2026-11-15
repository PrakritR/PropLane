import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeSupabaseClient, type Row } from "./helpers/fake-supabase-tables";

vi.mock("server-only", () => ({}));
const notify = vi.fn(async () => undefined);
vi.mock("@/lib/domain-action-events.server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/domain-action-events.server")>()),
  emitHoldingDepositExpired: (...args: unknown[]) => notify(...args),
}));

import { expireHoldingDeposits } from "@/lib/holding-deposit-expiry.server";
import { holdRoomBlockId, reserveRoomForHold } from "@/lib/holding-room-block.server";
import { roomDateBlockNameError } from "@/lib/channel-calendar/room-block-name-rule";
import {
  DEFAULT_HOLD_FEE_CENTS,
  holdCreditCents,
  holdDeadlineLabel,
  holdExpiresAtFor,
  holdState,
  resolveHoldFeeCents,
} from "@/lib/holding-hold";
import { renderPaymentActionEvent } from "@/lib/domain-action-events.server";

const MANAGER = "11111111-1111-4111-8111-111111111111";
const PAID_AT = "2026-11-01T12:00:00.000Z";
const DAY = 86_400_000;

describe("hold fee rules", () => {
  it("defaults to $100 when the listing's holding fee is blank", () => {
    expect(DEFAULT_HOLD_FEE_CENTS).toBe(10_000);
    for (const blank of ["", "  ", null, undefined, "$0", "abc"]) expect(resolveHoldFeeCents(blank)).toBe(10_000);
    expect(resolveHoldFeeCents("$250")).toBe(25_000);
  });

  it("expires 7 days after the PAID time", () => {
    expect(holdExpiresAtFor(PAID_AT)).toBe("2026-11-08T12:00:00.000Z");
    expect(holdExpiresAtFor("nope")).toBeNull();
  });

  it("is active inside the window, expired after it, and shows the deadline", () => {
    const hold = { kind: "holding_deposit", status: "paid", paidAt: PAID_AT };
    expect(holdState(hold, new Date(Date.parse(PAID_AT) + 6 * DAY))).toBe("active");
    expect(holdState(hold, new Date(Date.parse(PAID_AT) + 7 * DAY))).toBe("expired");
    expect(holdDeadlineLabel(hold, new Date(Date.parse(PAID_AT) + DAY))).toBe("Hold expires Nov 8, 2026");
    expect(holdDeadlineLabel({ ...hold, holdExpiredAt: "2026-11-08T13:00:00.000Z" })).toBe("Hold expired Nov 8, 2026");
    expect(holdState({ kind: "rent", status: "paid", paidAt: PAID_AT })).toBe("none");
    expect(holdState({ ...hold, status: "pending" })).toBe("none");
  });

  it("credits the $100 toward the $250 deposit ($150 left) only while the hold stands", () => {
    const hold = { kind: "holding_deposit", status: "paid", paidAt: PAID_AT, amountLabel: "$100.00" };
    const inside = new Date(Date.parse(PAID_AT) + 3 * DAY);
    const credit = holdCreditCents(hold, 25_000, inside);
    expect(credit).toBe(10_000);
    expect(25_000 - credit).toBe(15_000);
    expect(holdCreditCents(hold, 25_000, new Date(Date.parse(PAID_AT) + 8 * DAY))).toBe(0);
    expect(holdCreditCents(hold, 5_000, inside)).toBe(5_000);
  });

  it("tells the manager the room is released and the money is kept", () => {
    const text = renderPaymentActionEvent("hold_expired", "manager", { title: "Holding deposit", amountLabel: "$100.00" })?.text ?? "";
    expect(text).toMatch(/available again/);
    expect(text).toMatch(/nothing was refunded/);
  });
});

describe("hold expiry sweep", () => {
  let tables: Record<string, Row[]>;
  const hold = (over: Record<string, unknown> = {}): Row => ({
    id: "hold-1", manager_user_id: MANAGER, resident_email: "tenant@example.test", kind: "holding_deposit", status: "paid",
    row_data: {
      id: "hold-1", kind: "holding_deposit", status: "paid", residentEmail: "tenant@example.test", amountLabel: "$100.00",
      paidAt: PAID_AT, roomHoldBlockId: "block-1", managerUserId: MANAGER, title: "Holding deposit", ...over,
    },
  });
  beforeEach(() => {
    notify.mockClear();
    tables = {
      portal_household_charge_records: [hold()],
      portal_lease_pipeline_records: [],
      portal_schedule_records: [{ id: "block-1", manager_user_id: MANAGER, record_type: "room_date_block", row_data: { bookingStatus: "hold" } }],
    };
  });
  const run = (daysAfterPaid: number) => expireHoldingDeposits(fakeSupabaseClient(tables) as never, new Date(Date.parse(PAID_AT) + daysAfterPaid * DAY));

  it("does nothing inside the 7 days", async () => {
    expect(await run(6)).toMatchObject({ checked: 0, expired: 0 });
    expect(tables.portal_schedule_records[0]!.record_type).toBe("room_date_block");
  });

  it("expires an unsigned hold: room released, manager told, money kept (never refunded)", async () => {
    const result = await run(8);
    expect(result).toMatchObject({ checked: 1, expired: 1, failed: 0 });
    const charge = tables.portal_household_charge_records[0]!;
    expect(charge.status).toBe("paid");
    expect(charge.row_data).toMatchObject({ holdExpiredAt: expect.any(String), holdExpiresAt: "2026-11-08T12:00:00.000Z" });
    expect(tables.portal_schedule_records[0]).toMatchObject({ record_type: "cancelled_room_date_block", row_data: { bookingStatus: "cancelled", reason: "Hold fee expired" } });
    expect(notify).toHaveBeenCalledTimes(1);
    // A second run is a no-op.
    expect(await run(9)).toMatchObject({ checked: 0, expired: 0 });
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it("leaves a hold alone when the lease was signed inside the window (the deposit credit stands)", async () => {
    tables.portal_lease_pipeline_records.push({
      id: "lease-1", manager_user_id: MANAGER, resident_email: "tenant@example.test",
      row_data: { residentSignature: { name: "Tenant", signedAtIso: "2026-11-04T09:00:00.000Z" } },
    });
    const result = await run(8);
    expect(result).toMatchObject({ expired: 0, creditedOnSign: 1 });
    expect(tables.portal_household_charge_records[0]!.row_data).toMatchObject({ holdCreditedAt: expect.any(String) });
    expect(tables.portal_household_charge_records[0]!.row_data).not.toHaveProperty("holdExpiredAt");
    // The lease booking takes the room over, so the hold's own block is removed.
    expect(tables.portal_schedule_records[0]!.record_type).toBe("cancelled_room_date_block");
  });

  it("a lease signed AFTER the window does not save the hold", async () => {
    tables.portal_lease_pipeline_records.push({
      id: "lease-1", manager_user_id: MANAGER, resident_email: "tenant@example.test",
      row_data: { residentSignature: { name: "Tenant", signedAtIso: "2026-11-20T09:00:00.000Z" } },
    });
    expect(await run(8)).toMatchObject({ expired: 1, creditedOnSign: 0 });
  });
});

describe("a paid hold reserves the room", () => {
  const PROP = "prop-1";
  const charge = {
    id: "hold-1", kind: "holding_deposit", status: "paid", applicationId: "app-1", residentEmail: "tenant@example.test",
    residentName: "Tia Tenant", propertyId: PROP, amountLabel: "$100.00", paidAt: PAID_AT, managerUserId: MANAGER, title: "Holding deposit",
  } as never;
  let tables: Record<string, Row[]>;
  beforeEach(() => {
    tables = {
      manager_application_records: [{ id: "app-1", row_data: { assignedRoomChoice: `${PROP}::room-a`, name: "Tia Tenant" } }],
      manager_property_records: [{ id: PROP, manager_user_id: MANAGER, row_data: {}, property_data: {} }],
      portal_schedule_records: [],
      portal_household_charge_records: [{ id: "hold-1", status: "paid", row_data: {} }],
    };
  });
  const db = () => fakeSupabaseClient(tables) as never;

  it("writes one NAMED hold booking from the paid date to the deadline and stamps the charge", async () => {
    const id = await reserveRoomForHold(db(), MANAGER, charge);
    expect(id).toBe(holdRoomBlockId(MANAGER, "hold-1"));
    const block = tables.portal_schedule_records[0]!;
    expect(block).toMatchObject({ id, record_type: "room_date_block", property_id: PROP });
    expect(block.row_data).toMatchObject({ roomId: "room-a", residentName: "Hold — Tia Tenant", checkIn: "2026-11-01", checkOut: "2026-11-08", bookingStatus: "hold" });
    expect(roomDateBlockNameError({ residentName: (block.row_data as { residentName: string }).residentName })).toBeNull();
    expect(tables.portal_household_charge_records[0]!.row_data).toMatchObject({ roomHoldBlockId: id });
    // Idempotent on the charge id.
    await reserveRoomForHold(db(), MANAGER, charge);
    expect(tables.portal_schedule_records).toHaveLength(1);
  });

  it("does nothing without a named room, or when the nights are already taken", async () => {
    tables.manager_application_records[0]!.row_data = { name: "Tia" };
    expect(await reserveRoomForHold(db(), MANAGER, charge)).toBeNull();
    tables.manager_application_records[0]!.row_data = { assignedRoomChoice: `${PROP}::room-a` };
    tables.portal_schedule_records.push({ id: "other", property_id: PROP, record_type: "room_date_block", row_data: { roomId: "room-a", checkIn: "2026-11-05", checkOut: "2026-11-20", bookingStatus: "confirmed" } });
    expect(await reserveRoomForHold(db(), MANAGER, charge)).toBeNull();
    expect(tables.portal_schedule_records).toHaveLength(1);
  });

  it("a signed lease inside the window removes the hold block now; expiry cancels it otherwise", async () => {
    const id = (await reserveRoomForHold(db(), MANAGER, charge))!;
    tables.portal_household_charge_records[0] = { id: "hold-1", manager_user_id: MANAGER, resident_email: "tenant@example.test", kind: "holding_deposit", status: "paid", row_data: { ...(charge as object), roomHoldBlockId: id } };
    tables.portal_lease_pipeline_records = [{ id: "l1", manager_user_id: MANAGER, resident_email: "tenant@example.test", row_data: { residentSignature: { name: "T", signedAtIso: "2026-11-03T09:00:00.000Z" } } }];
    const result = await expireHoldingDeposits(db(), new Date(Date.parse(PAID_AT) + 4 * DAY));
    expect(result).toMatchObject({ creditedOnSign: 1, expired: 0 });
    expect(tables.portal_schedule_records[0]).toMatchObject({ record_type: "cancelled_room_date_block", row_data: { reason: "Lease signed" } });
  });
});
