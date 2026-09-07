/**
 * PRP-368 — a tour request's `slotKey` and its ISO `start` must agree.
 *
 * The public booking client turns the chosen slot into an instant with the
 * PROSPECT's browser zone, so an out-of-region guest sent a `slotKey` naming
 * 9:00 Pacific alongside a `proposedStart` of 6:00 PM Pacific, and the server
 * stored both without complaint. Blocking matched on the key, so the calendar
 * looked consistent — while the manager's events list, the resident's tour
 * panel, and the confirmation email and SMS all read the ISO and told both
 * people a time nobody had held.
 *
 * The slot key is what the server published and what blocking trusts, so it is
 * the authority: `createTourInquiry` rewrites every window's `start`/`end`, the
 * row's `proposedStart`/`proposedEnd`, and the stored event record's
 * `starts_at`/`ends_at` to the slot's Pacific instant. These run under a UTC
 * process zone, as production does, so a Pacific dev box cannot mask a wrong
 * anchor.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const originalTz = process.env.TZ;

const notifyManagerTourRequest = vi.fn(async () => undefined);
const notifyTenantTourRequestReceived = vi.fn(async () => undefined);

vi.mock("@/lib/sms-consent", () => ({ recordOptIn: async () => undefined }));
vi.mock("@/lib/public-tour-booking-guard", () => ({
  adminHasPublishedSlot: async () => true,
  managerHasPublishedSlot: async () => true,
  managerMayHostPropertyTour: async () => true,
}));
vi.mock("@/lib/tour-notification-delivery.server", () => ({
  notifyManagerTourRequest: (...args: unknown[]) => notifyManagerTourRequest(...(args as [])),
  notifyTenantTourRequestReceived: (...args: unknown[]) => notifyTenantTourRequestReceived(...(args as [])),
}));
vi.mock("@/lib/payment-automation-settings", () => ({
  loadManagerAutomationSettings: async () => ({ proposeTourConfirmations: false }),
}));
vi.mock("@/lib/tour-proposal.server", () => ({ proposeTourConfirmation: async () => undefined }));
vi.mock("@/lib/manager-default-tasks.server", () => ({ createApproveTourRequestTask: async () => undefined }));

import { anchorTourWindowToSlotKey, TOUR_SLOT_DURATION_MS } from "@/lib/tour-slot-math";
import { createTourInquiry, INQUIRY_EVENT_RECORD_TYPE } from "@/lib/tour-inquiry-create.server";

/** The ticket's row: slot 18 on Sep 7 2026 is 09:00 Pacific (PDT, UTC-7). */
const SLOT_KEY = "2026-09-07:18";
const SLOT_START_ISO = "2026-09-07T16:00:00.000Z";
const SLOT_END_ISO = "2026-09-07T16:30:00.000Z";
/** What the out-of-region guest actually sent: 6:00 PM Pacific the same day. */
const WRONG_START_ISO = "2026-09-08T01:00:00.000Z";
const WRONG_END_ISO = "2026-09-08T01:30:00.000Z";

let upserts: Record<string, unknown>[][];

function fakeDb() {
  const rows = { data: [], error: null };
  const builder = {
    select: () => builder,
    eq: () => builder,
    maybeSingle: async () => ({ data: null, error: null }),
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

function tourRequest(over: Record<string, unknown> = {}) {
  return {
    kind: "tour",
    name: "Out-of-region Guest",
    email: "guest@example.com",
    phone: "2065550123",
    managerUserId: "mgr-1",
    propertyId: "mgr-demo-lakeview",
    requestedWindows: [
      { start: WRONG_START_ISO, end: WRONG_END_ISO, adminUserId: "mgr-1", slotKey: SLOT_KEY },
    ],
    proposedStart: WRONG_START_ISO,
    proposedEnd: WRONG_END_ISO,
    ...over,
  };
}

beforeEach(() => {
  process.env.TZ = "UTC";
  upserts = [];
  notifyManagerTourRequest.mockClear();
  notifyTenantTourRequestReceived.mockClear();
});

afterEach(() => {
  process.env.TZ = originalTz;
});

describe("anchorTourWindowToSlotKey", () => {
  it("rewrites a start that disagrees with its slot to the slot's Pacific instant", () => {
    const out = anchorTourWindowToSlotKey({ start: WRONG_START_ISO, end: WRONG_END_ISO, slotKey: SLOT_KEY });
    expect(out).toEqual({
      start: SLOT_START_ISO,
      end: SLOT_END_ISO,
      slotKey: SLOT_KEY,
      anchored: true,
    });
  });

  it("leaves a window alone when its start already falls inside the slot", () => {
    const out = anchorTourWindowToSlotKey({ start: SLOT_START_ISO, end: SLOT_END_ISO, slotKey: SLOT_KEY });
    expect(out).toMatchObject({ start: SLOT_START_ISO, end: SLOT_END_ISO, anchored: false });
  });

  it("keeps the requested duration when it moves the window", () => {
    const hourLater = new Date(Date.parse(WRONG_START_ISO) + 60 * 60 * 1000).toISOString();
    const out = anchorTourWindowToSlotKey({ start: WRONG_START_ISO, end: hourLater, slotKey: SLOT_KEY });
    expect(out?.start).toBe(SLOT_START_ISO);
    expect(Date.parse(out!.end) - Date.parse(out!.start)).toBe(60 * 60 * 1000);
  });

  it("collapses a nonsensical duration to one slot", () => {
    const out = anchorTourWindowToSlotKey({ start: WRONG_START_ISO, end: "not-a-date", slotKey: SLOT_KEY });
    expect(Date.parse(out!.end) - Date.parse(out!.start)).toBe(TOUR_SLOT_DURATION_MS);
  });

  it("passes a window with no slot key through untouched", () => {
    const out = anchorTourWindowToSlotKey({ start: WRONG_START_ISO, end: WRONG_END_ISO });
    expect(out).toMatchObject({ start: WRONG_START_ISO, end: WRONG_END_ISO, anchored: false });
  });

  it("returns null for a key that names no slot", () => {
    expect(anchorTourWindowToSlotKey({ start: WRONG_START_ISO, end: WRONG_END_ISO, slotKey: "garbage" })).toBeNull();
    expect(anchorTourWindowToSlotKey({ start: WRONG_START_ISO, end: WRONG_END_ISO, slotKey: "2026-09-07:48" })).toBeNull();
  });
});

describe("createTourInquiry anchors the stored window to the slot key", () => {
  it("stores, records, and notifies the slot's time — never the client's", async () => {
    const result = await createTourInquiry(fakeDb(), { incoming: tourRequest() });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // The row every UI and notification reads.
    expect(result.row.proposedStart).toBe(SLOT_START_ISO);
    expect(result.row.proposedEnd).toBe(SLOT_END_ISO);
    expect(result.row.requestedWindows).toEqual([
      { start: SLOT_START_ISO, end: SLOT_END_ISO, adminUserId: "mgr-1", slotKey: SLOT_KEY },
    ]);

    // The schedule records the calendar queries by time.
    const records = upserts.flat();
    const event = records.find((r) => String(r.id).startsWith(`${INQUIRY_EVENT_RECORD_TYPE}_`));
    expect(event).toMatchObject({ starts_at: SLOT_START_ISO, ends_at: SLOT_END_ISO });
    const inquiries = records.find((r) => r.record_type === "axis_admin_partner_inquiries_v1");
    expect(inquiries).toMatchObject({ starts_at: SLOT_START_ISO, ends_at: SLOT_END_ISO });

    // The manager and the guest are told the same, correct time.
    await vi.waitFor(() => expect(notifyManagerTourRequest).toHaveBeenCalled());
    const [, , notifiedRow, notifiedWindow] = notifyManagerTourRequest.mock.calls[0] as unknown[];
    expect((notifiedRow as { proposedStart: string }).proposedStart).toBe(SLOT_START_ISO);
    expect(notifiedWindow).toMatchObject({ start: SLOT_START_ISO, end: SLOT_END_ISO });
  });

  it("anchors the legacy shape that carries only proposedStart + slotKey", async () => {
    const result = await createTourInquiry(fakeDb(), {
      incoming: tourRequest({ requestedWindows: undefined, slotKey: SLOT_KEY }),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.row.proposedStart).toBe(SLOT_START_ISO);
    expect(result.row.proposedEnd).toBe(SLOT_END_ISO);
  });

  it("refuses a key that names no slot instead of storing the client's time", async () => {
    const result = await createTourInquiry(fakeDb(), {
      incoming: tourRequest({
        requestedWindows: [{ start: WRONG_START_ISO, end: WRONG_END_ISO, adminUserId: "mgr-1", slotKey: "garbage" }],
      }),
    });

    expect(result).toMatchObject({ ok: false, reason: "slot_unavailable" });
    expect(upserts).toEqual([]);
  });

  it("keeps a window that already agrees with its slot byte-for-byte", async () => {
    const result = await createTourInquiry(fakeDb(), {
      incoming: tourRequest({
        requestedWindows: [{ start: SLOT_START_ISO, end: SLOT_END_ISO, adminUserId: "mgr-1", slotKey: SLOT_KEY }],
        proposedStart: SLOT_START_ISO,
        proposedEnd: SLOT_END_ISO,
      }),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.row.proposedStart).toBe(SLOT_START_ISO);
    expect(result.row.requestedWindows).toEqual([
      { start: SLOT_START_ISO, end: SLOT_END_ISO, adminUserId: "mgr-1", slotKey: SLOT_KEY },
    ]);
  });
});
