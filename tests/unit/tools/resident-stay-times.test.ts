import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import type { ResidentAgentContext } from "@/lib/tools/resident-context";
import { buildResidentRegistry, residentAgentRegistry } from "@/lib/tools/resident-index";
import { getMyStayTimesTool } from "@/lib/tools/domains/resident/stay-times";
import { toAnthropicTools } from "@/lib/tools/registry";
import { stayAddOnChargeId } from "@/lib/short-stay/stay-add-ons";
import { GUEST, OWNER, PROPERTY, seedShortStayDb } from "../../helpers/short-stay-seed";

const BLOCK = "axis_room_block_owner-1_stay-1";

function stayRow(id: string, userId: string, checkIn: string, checkOut: string, details: Record<string, unknown> = {}, over: Record<string, unknown> = {}) {
  return {
    id,
    manager_user_id: OWNER,
    property_id: PROPERTY,
    record_type: "room_date_block",
    starts_at: `${checkIn}T22:00:00.000Z`,
    ends_at: `${checkOut}T18:00:00.000Z`,
    updated_at: "2026-10-14T10:00:00.000Z",
    row_data: {
      id,
      propertyId: PROPERTY,
      roomId: "r1",
      checkIn,
      checkOut,
      checkInTime: "15:00",
      checkOutTime: "11:00",
      bookingStatus: "confirmed",
      quotedNights: 3,
      quotedTotal: 420,
      rate: 140,
      guests: 1,
      residentUserId: userId,
      stayDetails: { source: "guest_portal", guests: 1, ...details },
      ...over,
    },
  };
}

function ctxFor(db: ReturnType<typeof seedShortStayDb>, channel: "portal" | "sms" = "sms"): ResidentAgentContext {
  return { kind: "resident", userId: GUEST, email: "priya@example.com", managerIds: [OWNER], phase: "application", managerTier: "paid", landlordId: GUEST, channel, db } as unknown as ResidentAgentContext;
}

const run = (ctx: ResidentAgentContext) => getMyStayTimesTool.handler(ctx, {}) as Promise<{ stays: Array<Record<string, unknown> & { addOns: Array<Record<string, unknown>> }> }>;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-14T18:00:00Z"));
  vi.stubEnv("NEXT_PUBLIC_CANONICAL_APP_URL", "https://proplane.test");
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("get_my_stay_times", () => {
  it("answers the stay's times, the add-on's price, the pay link and the reply the assistant may send", async () => {
    const db = seedShortStayDb();
    db.tables.portal_schedule_records!.push(stayRow(BLOCK, GUEST, "2026-10-20", "2026-10-23", { estimatedArrival: "13:00" }));
    const { stays } = await run(ctxFor(db));
    expect(stays).toHaveLength(1);
    const stay = stays[0]!;
    expect(stay).toMatchObject({
      stayId: BLOCK,
      property: "Cedar Court",
      room: "Attic Nook",
      confirmed: true,
      checkIn: "Oct 20, 3:00 pm",
      checkOut: "Oct 23, 11:00 am",
      standardCheckIn: "Oct 20, 3:00 pm",
      standardCheckOut: "Oct 23, 11:00 am",
      estimatedArrival: "13:00",
    });
    const early = stay.addOns.find((a) => a.kind === "early_check_in")!;
    const link = `https://proplane.test/resident/stays/upcoming?stay=${BLOCK}&addOn=early_check_in&time=12:00`;
    expect(early).toMatchObject({
      status: "available",
      time: "12:00",
      price: "$25",
      priceCents: 2500,
      payLink: link,
      suggestedReply: `Yes, early check-in at 12 pm is $25. Pay here: ${link}. I'll confirm as soon as it goes through.`,
    });
    expect(stay.addOns.find((a) => a.kind === "late_check_out")).toMatchObject({ status: "available", time: "14:00" });
  });

  it("says plainly when an add-on is unavailable and offers no link for it", async () => {
    const db = seedShortStayDb();
    db.tables.portal_schedule_records!.push(
      stayRow(BLOCK, GUEST, "2026-10-20", "2026-10-23"),
      stayRow("prev", "someone-else", "2026-10-17", "2026-10-20", {}, { roomId: "r1" }),
    );
    const { stays } = await run(ctxFor(db));
    const early = stays.find((s) => s.stayId === BLOCK)!.addOns.find((a) => a.kind === "early_check_in")!;
    expect(early).toEqual({ kind: "early_check_in", label: "Early check-in", status: "unavailable", message: "Early check-in isn't available that day." });
  });

  it("reports a paid add-on as added, with the moved time, and offers no second link", async () => {
    const db = seedShortStayDb();
    db.tables.portal_schedule_records!.push(
      stayRow(BLOCK, GUEST, "2026-10-20", "2026-10-23", { addOns: { early_check_in: { time: "12:00", priceCents: 2500, status: "paid", chargeId: stayAddOnChargeId(BLOCK, "early_check_in") } } }, { checkInTime: "12:00" }),
    );
    const { stays } = await run(ctxFor(db));
    const stay = stays[0]!;
    expect(stay).toMatchObject({ checkIn: "Oct 20, 12:00 pm", standardCheckIn: "Oct 20, 3:00 pm" });
    const early = stay.addOns.find((a) => a.kind === "early_check_in")!;
    expect(early).toMatchObject({ status: "paid", message: "Early check-in at 12:00 pm is already added." });
    expect(early.payLink).toBeUndefined();
  });

  it("a pending add-on answers with the time and price its CHARGE carries, not the property's current ones", async () => {
    const db = seedShortStayDb();
    db.tables.portal_schedule_records!.push(
      stayRow(BLOCK, GUEST, "2026-10-20", "2026-10-23", { addOns: { early_check_in: { time: "13:00", priceCents: 3000, status: "pending", chargeId: stayAddOnChargeId(BLOCK, "early_check_in") } } }),
    );
    const { stays } = await run(ctxFor(db));
    const early = stays[0]!.addOns.find((a) => a.kind === "early_check_in")!;
    const link = `https://proplane.test/resident/stays/upcoming?stay=${BLOCK}&addOn=early_check_in&time=13:00`;
    expect(early).toMatchObject({
      status: "pending",
      time: "13:00",
      price: "$30",
      priceCents: 3000,
      payLink: link,
      suggestedReply: `Yes, early check-in at 1 pm is $30. Pay here: ${link}. I'll confirm as soon as it goes through.`,
    });
  });

  it("never names another guest's stay, a past stay, or a cancelled one", async () => {
    const db = seedShortStayDb();
    db.tables.portal_schedule_records!.push(
      stayRow("theirs", "someone-else", "2026-10-20", "2026-10-23"),
      stayRow("past", GUEST, "2026-09-01", "2026-09-03"),
      { ...stayRow("cancelled", GUEST, "2026-10-26", "2026-10-28"), record_type: "cancelled_room_date_block" },
    );
    const { stays } = await run(ctxFor(db));
    expect(stays).toEqual([]);
  });

  it("is read-only, takes no identity, and is on every resident surface including SMS", () => {
    expect(getMyStayTimesTool.kind).toBe("read");
    expect(getMyStayTimesTool.inputSchema.safeParse({}).success).toBe(true);
    expect(getMyStayTimesTool.inputSchema.safeParse({ userId: "someone-else" }).success).toBe(false);
    expect(residentAgentRegistry.has("get_my_stay_times")).toBe(true);
    for (const channel of ["portal", "sms"] as const) {
      const registry = buildResidentRegistry(ctxFor(seedShortStayDb(), channel));
      expect(registry.has("get_my_stay_times")).toBe(true);
      expect(toAnthropicTools(registry, { readOnly: true }).map((tool) => tool.name)).toContain("get_my_stay_times");
    }
    expect(getMyStayTimesTool.description).toMatch(/what time is check-in/i);
  });
});
