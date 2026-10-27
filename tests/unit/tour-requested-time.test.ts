/**
 * Tour request any time: a house with NO open slot accepts a requested time (8:00 AM-7:30 PM Pacific, 30-minute
 * steps, tomorrow or later, signed-in only), stored pending with `requestKind: "requested_time"`. The mode is
 * decided on the server: open slots, an unresolved house, an off-grid or out-of-hours time, and a signed-out
 * caller are all refused, and a slot booking is unchanged. Runs under a UTC process zone, as production does.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const originalTz = process.env.TZ;

const hasPublishedSlot = vi.fn(async () => true);
const listOpenTourSlots = vi.fn();
const notifyManagerTourRequest = vi.fn(async () => undefined);

vi.mock("@/lib/sms-consent", () => ({ recordOptIn: async () => undefined }));
vi.mock("@/lib/public-tour-booking-guard", () => ({
  adminHasPublishedSlot: async () => true,
  managerHasPublishedSlot: (...args: unknown[]) => hasPublishedSlot(...(args as [])),
  managerMayHostPropertyTour: async () => true,
}));
vi.mock("@/lib/tour-host-enumeration.server", () => ({
  listPropertyTourHostUserIds: async () => ["owner-1", "co-1"],
}));
vi.mock("@/lib/tour-availability.server", () => ({
  listOpenTourSlots: (...args: unknown[]) => listOpenTourSlots(...(args as [])),
}));
vi.mock("@/lib/tour-notification-delivery.server", () => ({
  notifyManagerTourRequest: (...args: unknown[]) => notifyManagerTourRequest(...(args as [])),
  notifyTenantTourRequestReceived: async () => undefined,
}));
vi.mock("@/lib/payment-automation-settings", () => ({
  loadManagerAutomationSettings: async () => ({ proposeTourConfirmations: false }),
}));
vi.mock("@/lib/tour-proposal.server", () => ({ proposeTourConfirmation: async () => undefined }));
vi.mock("@/lib/manager-default-tasks.server", () => ({ createApproveTourRequestTask: async () => undefined }));

import { createTourInquiry, INQUIRY_EVENT_RECORD_TYPE } from "@/lib/tour-inquiry-create.server";
import {
  REQUESTED_TOUR_KIND,
  formatRequestedTourWhen,
  requestedTourCaption,
  requestedTourDates,
  requestedTourSlotIndices,
  resolveRequestedTourWindow,
} from "@/lib/tour-request-time";

/** Tue Oct 27 2026, 1:00 PM Pacific (PDT, UTC-7). */
const NOW = Date.parse("2026-10-27T20:00:00.000Z");
/** Thu Oct 29 2026, 4:00 PM Pacific. */
const THU_4PM = "2026-10-29T23:00:00.000Z";

let upserts: Record<string, unknown>[][];

function fakeDb() {
  const rows = { data: [], error: null };
  const builder = {
    select: () => builder,
    eq: () => builder,
    maybeSingle: async () => ({ data: { manager_user_id: "owner-1" }, error: null }),
    then(resolve: (v: typeof rows) => unknown) {
      return Promise.resolve(rows).then(resolve);
    },
  };
  return {
    from: () => ({
      ...builder,
      upsert: async (records: Record<string, unknown>[]) => {
        upserts.push(records);
        return { error: null };
      },
    }),
  } as never;
}

function requested(startIso: string, over: Record<string, unknown> = {}) {
  const startMs = Date.parse(startIso);
  const end = Number.isFinite(startMs) ? new Date(startMs + 30 * 60 * 1000).toISOString() : "later";
  return {
    kind: "tour",
    requestKind: REQUESTED_TOUR_KIND,
    name: "Prakrit Ramachandran",
    email: "prakrit@example.com",
    phone: "2065550123",
    propertyId: "prop-1",
    propertyTitle: "2412 Clifford St",
    requestedWindows: [{ start: startIso, end }],
    proposedStart: startIso,
    proposedEnd: end,
    ...over,
  };
}

const create = (incoming: Record<string, unknown>, verified: string | null = "prakrit@example.com") =>
  createTourInquiry(fakeDb(), { incoming, verifiedApplicantEmail: verified });

beforeEach(() => {
  process.env.TZ = "UTC";
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  upserts = [];
  hasPublishedSlot.mockClear();
  notifyManagerTourRequest.mockClear();
  listOpenTourSlots.mockReset();
  listOpenTourSlots.mockResolvedValue({ ok: true, slotHosts: {}, resolution: "resolved" });
});

afterEach(() => {
  vi.useRealTimers();
  process.env.TZ = originalTz;
});

describe("requested time: accepted only when the house has no open slot", () => {
  it("files a pending request with requestKind, a derived slotKey, the owner as host, and no published slot needed", async () => {
    const result = await create(requested(THU_4PM));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.row).toMatchObject({
      status: "pending",
      requestKind: "requested_time",
      managerUserId: "owner-1",
      proposedStart: THU_4PM,
    });
    expect((result.row.requestedWindows as { slotKey: string }[])[0]!.slotKey).toBe("2026-10-29:32");
    expect(result.row.eligibleHostUserIds).toEqual(expect.arrayContaining(["owner-1", "co-1"]));
    expect(hasPublishedSlot).not.toHaveBeenCalled();
    const event = upserts[0]!.find((r) => r.record_type === INQUIRY_EVENT_RECORD_TYPE)!;
    expect(event.starts_at).toBe(THU_4PM);
    expect(event.manager_user_id).toBe("owner-1");
  });

  it("derives the slotKey from the time, ignoring a client-supplied one", async () => {
    const incoming = requested(THU_4PM);
    (incoming.requestedWindows[0] as Record<string, unknown>).slotKey = "2026-10-29:18";
    const result = await create(incoming);
    expect(result.ok).toBe(true);
    if (result.ok) expect((result.row.requestedWindows as { slotKey: string }[])[0]!.slotKey).toBe("2026-10-29:32");
  });

  it("refuses when the house has any open slot (the client's claim is not trusted)", async () => {
    listOpenTourSlots.mockResolvedValue({ ok: true, slotHosts: { "2026-10-30:20": [{ userId: "owner-1" }] }, resolution: "resolved" });
    const result = await create(requested(THU_4PM));
    expect(result).toMatchObject({ ok: false, reason: "slot_unavailable" });
    expect(upserts).toHaveLength(0);
  });

  it("refuses an unresolved house and fails closed when the availability read fails", async () => {
    listOpenTourSlots.mockResolvedValue({ ok: true, slotHosts: {}, resolution: "unavailable" });
    expect(await create(requested(THU_4PM))).toMatchObject({ ok: false, reason: "slot_unavailable" });
    listOpenTourSlots.mockResolvedValue({ ok: false, error: "boom" });
    expect(await create(requested(THU_4PM))).toMatchObject({ ok: false, reason: "write_failed" });
    expect(upserts).toHaveLength(0);
  });

  it("requires a signed-in account", async () => {
    expect(await create(requested(THU_4PM), null)).toMatchObject({ ok: false, reason: "sign_in_required" });
    expect(upserts).toHaveLength(0);
  });

  it.each([
    ["off the half hour (4:15 PM)", "2026-10-29T23:15:00.000Z"],
    ["before 8 AM (7:30 AM)", "2026-10-29T14:30:00.000Z"],
    ["8:00 PM", "2026-10-30T03:00:00.000Z"],
    ["today", "2026-10-27T23:00:00.000Z"],
    ["in the past", "2026-10-20T23:00:00.000Z"],
    ["beyond 60 days", "2027-02-01T23:00:00.000Z"],
    ["not a time", "soon"],
  ])("rejects a time %s", async (_label, start) => {
    const result = await create(requested(start));
    expect(result).toMatchObject({ ok: false, reason: "slot_unavailable" });
    expect(upserts).toHaveLength(0);
  });

  it("accepts the 8:00 AM and 7:30 PM edges tomorrow", async () => {
    expect((await create(requested("2026-10-28T15:00:00.000Z"))).ok).toBe(true);
    expect((await create(requested("2026-10-29T02:30:00.000Z"))).ok).toBe(true);
  });
});

describe("slot mode is unchanged", () => {
  it("never stores a requestKind on a published-slot booking, whatever the body says", async () => {
    const slotBooking = {
      kind: "tour",
      name: "Guest",
      email: "guest@example.com",
      phone: "2065550123",
      managerUserId: "owner-1",
      propertyId: "prop-1",
      requestKind: "bogus",
      requestedWindows: [{ start: THU_4PM, end: "2026-10-29T23:30:00.000Z", adminUserId: "owner-1", slotKey: "2026-10-29:32" }],
      proposedStart: THU_4PM,
      proposedEnd: "2026-10-29T23:30:00.000Z",
    };
    const result = await create(slotBooking);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.row.requestKind).toBeUndefined();
    expect(hasPublishedSlot).toHaveBeenCalled();
    expect(listOpenTourSlots).not.toHaveBeenCalled();
  });

  it("still requires a published slot for a normal request", async () => {
    hasPublishedSlot.mockResolvedValueOnce(false);
    const result = await create({
      kind: "tour",
      name: "Guest",
      email: "guest@example.com",
      phone: "2065550123",
      managerUserId: "owner-1",
      propertyId: "prop-1",
      requestedWindows: [{ start: THU_4PM, end: "2026-10-29T23:30:00.000Z", adminUserId: "owner-1", slotKey: "2026-10-29:32" }],
      proposedStart: THU_4PM,
      proposedEnd: "2026-10-29T23:30:00.000Z",
    });
    expect(result).toMatchObject({ ok: false, reason: "slot_unavailable" });
  });
});

describe("tour-request-time rules", () => {
  it("offers 24 half hours from 8:00 AM to 7:30 PM and 60 days starting tomorrow", () => {
    const slots = requestedTourSlotIndices();
    expect(slots).toHaveLength(24);
    expect(slots[0]).toBe(16);
    expect(slots[slots.length - 1]).toBe(39);
    const dates = requestedTourDates(NOW);
    expect(dates).toHaveLength(60);
    expect(dates[0]).toBe("2026-10-28");
  });

  it("captions the pick and resolves a window on the Pacific wall clock", () => {
    expect(requestedTourCaption("2026-10-29", 32)).toBe("Thu, Oct 29 at 4:00 PM · request");
    expect(formatRequestedTourWhen(THU_4PM)).toBe("Thu, Oct 29 at 4:00 PM");
    expect(resolveRequestedTourWindow(THU_4PM, NOW)).toMatchObject({ ok: true, window: { slotKey: "2026-10-29:32" } });
  });
});
