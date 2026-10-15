import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/action-events.server", () => ({ emitActionEvent: vi.fn(async () => ({})) }));
vi.mock("@/lib/sms/owner-sms-dispatcher.server", () => ({ enqueueOwnerSms: vi.fn(async () => ({ ok: true })) }));
vi.mock("@/lib/resend-delivery.server", () => ({ postResendEmail: vi.fn(async () => new Response("{}", { status: 200 })) }));
vi.mock("@/lib/manager-outbound-identity.server", () => ({ managerOutboundFromHeader: async () => "PropLane <work@proplane.test>" }));
vi.mock("@/lib/rate-limit", () => ({ clientIpFrom: () => "1.2.3.4", rateLimit: async () => ({ ok: true }) }));
vi.mock("@/lib/short-stay/guest-login.server", () => ({ ensureGuestLogin: async () => null }));
const availability = vi.fn();
vi.mock("@/lib/room-availability-range.server", () => ({ roomAvailabilityForRange: (...args: unknown[]) => availability(...args) }));

import { createShortStayRows, loadShortStayListing, submitShortStayRequest } from "@/lib/short-stay-request.server";
import { GUEST, PROPERTY, TODAY, seedShortStayDb } from "../helpers/short-stay-seed";

/**
 * The capacity trigger (`enforce_short_stay_room_date_block`) weighs a stay by `stayDetails.guests` and
 * sweeps the weights over the room's holds and confirmed stays. This is that arithmetic, so a test can
 * prove what the trigger would have said about the rows the writers produce.
 */
function peakGuests(rows: Array<{ checkIn: string; checkOut: string; row: Record<string, unknown> }>): number {
  const events = rows.flatMap(({ checkIn, checkOut, row }) => {
    const raw = Number((row.stayDetails as { guests?: unknown } | undefined)?.guests);
    const weight = Number.isFinite(raw) ? Math.max(1, raw) : 1;
    return [{ day: checkIn, n: weight }, { day: checkOut, n: -weight }];
  });
  const byDay = new Map<string, number>();
  for (const e of events) byDay.set(e.day, (byDay.get(e.day) ?? 0) + e.n);
  let running = 0;
  let peak = 0;
  for (const day of [...byDay.keys()].sort()) {
    running += byDay.get(day)!;
    peak = Math.max(peak, running);
  }
  return peak;
}

beforeEach(() => {
  vi.clearAllMocks();
  availability.mockImplementation(async (input: { roomId: string }) => ({ ok: true, rooms: [{ roomId: input.roomId, available: true }] }));
});

describe("a stay counts every guest on a shared room (the bug: it counted one)", () => {
  it("the trigger reads stayDetails.guests, not a top-level guests", () => {
    const sql = readFileSync(join(process.cwd(), "supabase/migrations/20261003153000_short_stay_room_date_block_capacity.sql"), "utf8");
    expect(sql).toContain("row_data#>>'{stayDetails,guests}'");
    expect(sql).not.toMatch(/row_data->>'guests'/);
  });

  it("the shared core writes stayDetails.guests for a guest-portal stay", async () => {
    const db = seedShortStayDb();
    const loaded = await loadShortStayListing(db as never, { propertyId: PROPERTY, roomId: "r4", guests: 3 });
    if (!loaded.ok) throw new Error("listing should load");
    const [row] = await createShortStayRows(db as never, {
      actor: { source: "guest_portal", name: "Priya", phone: "+12065550142", email: "p@example.com", residentUserId: GUEST },
      listing: loaded.listing,
      guests: 3,
      ranges: [{ checkIn: "2026-10-20", checkOut: "2026-10-23", nights: 3 }],
      status: "hold",
    });
    expect(row).toMatchObject({ ok: true });
    const stored = db.tables.portal_schedule_records!.at(-1)!.row_data as { guests: number; stayDetails: { guests: number }; residentUserId: string };
    expect(stored.stayDetails.guests).toBe(3);
    expect(stored.guests).toBe(3);
    expect(stored.residentUserId).toBe(GUEST);
  });

  it("the public card's request writes it too", async () => {
    const db = seedShortStayDb();
    const result = await submitShortStayRequest(
      db as never,
      { propertyId: PROPERTY, roomId: "r4", checkIn: "2026-10-20", checkOut: "2026-10-23", guests: 3, name: "Priya Shah", phone: "+12065550199", email: "", honeypot: "" },
      { today: TODAY },
    );
    expect(result).toEqual({ ok: true });
    const stored = db.tables.portal_schedule_records!.at(-1)!.row_data as { stayDetails: { guests: number; source: string; holdExpiresAt: string } };
    expect(stored.stayDetails).toMatchObject({ guests: 3, source: "public_short_stay_request" });
    expect(stored.stayDetails.holdExpiresAt).toBeTruthy();
  });

  it("on a 4-bed room a 3-guest stay plus a 2-guest stay on the same nights overfills it; the old shape hid that", async () => {
    const db = seedShortStayDb();
    const loaded = await loadShortStayListing(db as never, { propertyId: PROPERTY, roomId: "r4", guests: 2 });
    if (!loaded.ok) throw new Error("listing should load");
    const actor = { source: "guest_portal" as const, name: "Priya", phone: "+12065550142", email: "", residentUserId: GUEST };
    for (const guests of [3, 2]) {
      await createShortStayRows(db as never, { actor, listing: loaded.listing, guests, ranges: [{ checkIn: "2026-10-20", checkOut: "2026-10-23", nights: 3 }], status: "hold" });
    }
    const stays = db.tables.portal_schedule_records!.map((r) => ({
      checkIn: String((r.row_data as { checkIn: string }).checkIn),
      checkOut: String((r.row_data as { checkOut: string }).checkOut),
      row: r.row_data as Record<string, unknown>,
    }));
    expect(peakGuests(stays)).toBe(5); // > 4 beds: the database refuses the second one
    // The shape the bug wrote (guests at the top level only) weighed each stay as one guest.
    const legacy = stays.map((s) => ({ ...s, row: { ...s.row, stayDetails: { source: "public_short_stay_request" } } }));
    expect(peakGuests(legacy)).toBe(2);
  });

  it("a room that sleeps fewer than the party is refused before anything is written", async () => {
    const db = seedShortStayDb();
    expect(await loadShortStayListing(db as never, { propertyId: PROPERTY, roomId: "r1", guests: 2 })).toEqual({
      ok: false,
      status: 400,
      error: "That's more guests than the room sleeps.",
    });
  });
});
