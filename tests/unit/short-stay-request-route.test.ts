import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const emitActionEvent = vi.fn(async (..._args: unknown[]) => ({}));
vi.mock("@/lib/action-events.server", () => ({ emitActionEvent: (...args: unknown[]) => emitActionEvent(...args) }));
const enqueueOwnerSms = vi.fn(async (..._args: unknown[]) => ({ ok: true }));
vi.mock("@/lib/sms/owner-sms-dispatcher.server", () => ({ enqueueOwnerSms: (...args: unknown[]) => enqueueOwnerSms(...args) }));
vi.mock("@/lib/resend-delivery.server", () => ({ postResendEmail: vi.fn(async () => new Response("{}", { status: 200 })) }));
vi.mock("@/lib/manager-outbound-identity.server", () => ({ managerOutboundFromHeader: async () => "PropLane <work@proplane.test>" }));
const availability = vi.fn();
vi.mock("@/lib/room-availability-range.server", () => ({ roomAvailabilityForRange: (...args: unknown[]) => availability(...args) }));
vi.mock("@/lib/rate-limit", () => ({ clientIpFrom: () => "1.2.3.4", rateLimit: async () => ({ ok: true }) }));

import { submitShortStayRequest } from "@/lib/short-stay-request.server";

const TODAY = "2026-10-12";
const OWNER = "owner-1";

function makeDb(opts: { propertyStatus?: string; upsertError?: { code: string } | null } = {}) {
  const upserts: unknown[] = [];
  const property = {
    id: "prop-1",
    manager_user_id: OWNER,
    status: opts.propertyStatus ?? "live",
    property_data: {
      buildingName: "5257 Brooklyn Ave",
      listingSubmission: {
        v: 1,
        shortTermRentalsAllowed: true,
        shortTermDailyCost: "55",
        rooms: [{ id: "r3", name: "Room 3", occupancyCapacity: 1, monthlyRent: 900 }],
      },
    },
  };
  const db = {
    from(table: string) {
      const chain: Record<string, unknown> = {};
      chain.select = () => chain;
      chain.eq = () => chain;
      chain.is = () => chain;
      chain.maybeSingle = async () =>
        table === "manager_property_records" ? { data: property } : { data: { email: "owner@proplane.test", full_name: "Ambika Mago" } };
      chain.upsert = async (row: unknown) => {
        upserts.push(row);
        return { error: opts.upsertError ?? null };
      };
      return chain;
    },
  };
  return { db: db as never, upserts };
}

const valid = {
  propertyId: "prop-1",
  roomId: "r3",
  checkIn: "2026-10-20",
  checkOut: "2026-10-24",
  guests: 1,
  name: "Priya Shah",
  phone: "+12065550142",
  email: "priya@example.com",
  honeypot: "",
};

beforeEach(() => {
  vi.clearAllMocks();
  availability.mockResolvedValue({ ok: true, rooms: [{ roomId: "r3", available: true }] });
});

describe("submitShortStayRequest", () => {
  it("creates the hold, texts the guest from the work number path and emits the manager event", async () => {
    const { db, upserts } = makeDb();
    const result = await submitShortStayRequest(db, valid, { today: TODAY });
    expect(result).toEqual({ ok: true });
    expect(upserts).toHaveLength(1);
    const row = upserts[0] as { manager_user_id: string; record_type: string; row_data: Record<string, unknown> };
    expect(row.manager_user_id).toBe(OWNER);
    expect(row.record_type).toBe("room_date_block");
    expect(row.row_data).toMatchObject({ bookingStatus: "hold", rate: 55, rateBasis: "daily", quotedNights: 4, quotedTotal: 220, residentName: "Priya Shah", residentPhone: "+12065550142", checkIn: "2026-10-20", checkOut: "2026-10-24" });
    const sms = enqueueOwnerSms.mock.calls[0]![0] as { body: string; recipientPhone: string; managerUserId: string };
    expect(sms.recipientPhone).toBe("+12065550142");
    expect(sms.managerUserId).toBe(OWNER);
    expect(sms.body).toBe("Got it, Priya — Room 3 at 5257 Brooklyn Ave, Oct 20–24 ($220). Ambika will confirm shortly. Reply here with questions.");
    const event = emitActionEvent.mock.calls[0]![1] as { event: string; domain: string; recipients: { audience: string }[]; templateContext: { url: string } };
    expect(event).toMatchObject({ event: "short_stay_requested", domain: "channel_booking" });
    expect(event.recipients[0]!.audience).toBe("manager");
    expect(event.templateContext.url).toContain("/portal/bookings/block%3A");
  });

  it("refuses bad dates with a 400 and creates nothing", async () => {
    const { db, upserts } = makeDb();
    for (const dates of [
      { checkIn: "2026-10-24", checkOut: "2026-10-20" },
      { checkIn: "2026-10-01", checkOut: "2026-10-03" },
      { checkIn: "2027-05-01", checkOut: "2027-05-03" },
      { checkIn: "2026-10-20", checkOut: "2026-12-01" },
      { checkIn: "garbage", checkOut: "2026-10-24" },
    ]) {
      const result = await submitShortStayRequest(db, { ...valid, ...dates }, { today: TODAY });
      expect(result).toMatchObject({ ok: false, status: 400 });
    }
    expect(upserts).toHaveLength(0);
  });

  it("refuses a bad phone, a missing name and too many guests", async () => {
    const { db } = makeDb();
    expect(await submitShortStayRequest(db, { ...valid, phone: "123" }, { today: TODAY })).toMatchObject({ ok: false, status: 400 });
    expect(await submitShortStayRequest(db, { ...valid, name: " " }, { today: TODAY })).toMatchObject({ ok: false, status: 400 });
    expect(await submitShortStayRequest(db, { ...valid, guests: 2 }, { today: TODAY })).toMatchObject({ ok: false, status: 400 });
  });

  it("answers a filled honeypot with success and does nothing", async () => {
    const { db, upserts } = makeDb();
    expect(await submitShortStayRequest(db, { ...valid, honeypot: "http://spam" }, { today: TODAY })).toEqual({ ok: true });
    expect(upserts).toHaveLength(0);
    expect(enqueueOwnerSms).not.toHaveBeenCalled();
    expect(emitActionEvent).not.toHaveBeenCalled();
  });

  it("returns 409 when the room is not free, and when the database refuses the last bed", async () => {
    availability.mockResolvedValue({ ok: true, rooms: [{ roomId: "r3", available: false }] });
    const taken = makeDb();
    expect(await submitShortStayRequest(taken.db, valid, { today: TODAY })).toMatchObject({ ok: false, status: 409 });
    expect(taken.upserts).toHaveLength(0);

    availability.mockResolvedValue({ ok: true, rooms: [{ roomId: "r3", available: true }] });
    const raced = makeDb({ upsertError: { code: "P4001" } });
    expect(await submitShortStayRequest(raced.db, valid, { today: TODAY })).toMatchObject({ ok: false, status: 409 });
    expect(enqueueOwnerSms).not.toHaveBeenCalled();
  });

  it("does not claim availability it could not verify", async () => {
    availability.mockResolvedValue({ ok: true, rooms: [{ roomId: "r3", available: null }] });
    const { db, upserts } = makeDb();
    expect(await submitShortStayRequest(db, valid, { today: TODAY })).toMatchObject({ ok: false, status: 503 });
    expect(upserts).toHaveLength(0);
  });

  it("404s a listing that is not live", async () => {
    const { db } = makeDb({ propertyStatus: "draft" });
    expect(await submitShortStayRequest(db, valid, { today: TODAY })).toMatchObject({ ok: false, status: 404 });
  });
});
