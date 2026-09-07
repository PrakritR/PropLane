// A tour request belongs to NOBODY until someone approves it.
//
// The public booking flow used to file one inquiry per eligible host — the same
// guest, the same hour, N rows — and whoever clicked Approve first won a race
// the others could not see. One hostless request replaces that, and the act of
// approving is the act of claiming: the tour lands on the approver's calendar
// unless they deliberately hand it to a peer, who must be eligible AND free.
import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("@/lib/tour-notifications", () => ({
  notifyTenantTourConfirmed: vi.fn(async () => ({ ok: true })),
}));
vi.mock("@/lib/google-calendar/sync.server", () => ({
  syncPlannedTourToGoogleCalendar: vi.fn(async () => undefined),
}));
vi.mock("@/lib/manager-tasks.server", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createPrepareForTourTask: vi.fn(async () => undefined),
}));

import { confirmTourInquiry } from "@/lib/tour-inquiry-confirm.server";

const INQUIRIES_RECORD_ID = "axis_admin_partner_inquiries_v1";
const PLANNED_RECORD_ID = "axis_admin_planned_events_v1";

const OWNER = "mgr-owner";
const CO_MANAGER = "mgr-co";
const OUTSIDER = "mgr-outsider";

const START = "2099-08-06T17:00:00.000Z";
const END = "2099-08-06T18:00:00.000Z";

function inquiry(over: Record<string, unknown> = {}) {
  return {
    id: "inq-1",
    kind: "tour",
    status: "pending",
    name: "Guest",
    email: "guest@example.com",
    phone: "2065550123",
    managerUserId: OWNER,
    eligibleHostUserIds: [OWNER, CO_MANAGER],
    propertyId: "prop-1",
    propertyTitle: "Ballard House",
    proposedStart: START,
    proposedEnd: END,
    requestedWindows: [{ start: START, end: END, slotKey: "2099-08-06:34" }],
    ...over,
  };
}

type Written = { planned: Record<string, unknown>[] };

function makeDb(input: { inquiries: Record<string, unknown>[]; planned?: Record<string, unknown>[] }) {
  const written: Written = { planned: [] };
  const db = {
    from: () => ({
      select: () => ({
        eq: (_column: string, id: string) => ({
          maybeSingle: async () => ({
            data: {
              row_data: {
                payload:
                  id === INQUIRIES_RECORD_ID
                    ? input.inquiries
                    : id === PLANNED_RECORD_ID
                      ? (input.planned ?? [])
                      : [],
              },
            },
            error: null,
          }),
        }),
      }),
      upsert: async (rows: Record<string, unknown>[]) => {
        for (const row of rows) {
          if (row.id !== PLANNED_RECORD_ID) continue;
          const data = row.row_data as { payload?: Record<string, unknown>[] };
          written.planned = data.payload ?? [];
        }
        return { error: null };
      },
      delete: () => ({ in: async () => ({ error: null }) }),
    }),
  };
  return { db: db as never, written };
}

/** A tour already on someone's calendar in the same window. */
function plannedTourFor(managerUserId: string) {
  return {
    id: "planned-existing",
    kind: "tour",
    managerUserId,
    start: START,
    end: END,
  };
}

function hostOf(written: Written): string | undefined {
  const event = written.planned.at(-1);
  return typeof event?.managerUserId === "string" ? event.managerUserId : undefined;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("approving a tour claims it", () => {
  it("assigns the tour to the approver, not to whoever it was filed under", async () => {
    const { db, written } = makeDb({ inquiries: [inquiry()] });
    const result = await confirmTourInquiry(db, {
      inquiryId: "inq-1",
      actorUserId: CO_MANAGER,
      notifyTenant: false,
    });
    expect(result.ok).toBe(true);
    expect(hostOf(written)).toBe(CO_MANAGER);
  });

  it("still works for the manager it was filed under", async () => {
    const { db, written } = makeDb({ inquiries: [inquiry()] });
    const result = await confirmTourInquiry(db, {
      inquiryId: "inq-1",
      actorUserId: OWNER,
      notifyTenant: false,
    });
    expect(result.ok).toBe(true);
    expect(hostOf(written)).toBe(OWNER);
  });

  it("refuses a manager who was never an eligible host", async () => {
    const { db } = makeDb({ inquiries: [inquiry()] });
    const result = await confirmTourInquiry(db, {
      inquiryId: "inq-1",
      actorUserId: OUTSIDER,
      notifyTenant: false,
    });
    expect(result).toMatchObject({ ok: false, status: 403 });
  });

  it("treats a request booked before this shipped as belonging to its filed manager", async () => {
    // No `eligibleHostUserIds` at all — the row must not become unapprovable.
    const { db, written } = makeDb({ inquiries: [inquiry({ eligibleHostUserIds: undefined })] });
    const result = await confirmTourInquiry(db, {
      inquiryId: "inq-1",
      actorUserId: OWNER,
      notifyTenant: false,
    });
    expect(result.ok).toBe(true);
    expect(hostOf(written)).toBe(OWNER);
  });
});

describe("handing a tour to somebody else", () => {
  it("assigns the named host instead of the approver", async () => {
    const { db, written } = makeDb({ inquiries: [inquiry()] });
    const result = await confirmTourInquiry(db, {
      inquiryId: "inq-1",
      actorUserId: OWNER,
      hostUserId: CO_MANAGER,
      notifyTenant: false,
    });
    expect(result.ok).toBe(true);
    expect(hostOf(written)).toBe(CO_MANAGER);
  });

  it("refuses a host who is not free at that hour", async () => {
    // The captain's rule: a tour may only be approved onto a manager who is
    // actually free then. A request can sit in Pending for days, so the check
    // belongs at approval, not at booking.
    const { db } = makeDb({
      inquiries: [inquiry()],
      planned: [plannedTourFor(CO_MANAGER)],
    });
    const result = await confirmTourInquiry(db, {
      inquiryId: "inq-1",
      actorUserId: OWNER,
      hostUserId: CO_MANAGER,
      notifyTenant: false,
    });
    expect(result).toMatchObject({ ok: false, status: 409 });
    expect(result.ok ? "" : result.error).toContain("host");
  });

  it("refuses a host the property never made eligible", async () => {
    const { db } = makeDb({ inquiries: [inquiry()] });
    const result = await confirmTourInquiry(db, {
      inquiryId: "inq-1",
      actorUserId: OWNER,
      hostUserId: OUTSIDER,
      notifyTenant: false,
    });
    expect(result).toMatchObject({ ok: false, status: 403 });
  });

  it("leaves claiming your own busy hour alone — that override is the manager's to make", async () => {
    // Deliberate asymmetry: overriding your own calendar has always been
    // allowed on the manual route; overriding a peer's never was.
    const { db, written } = makeDb({
      inquiries: [inquiry()],
      planned: [plannedTourFor(OWNER)],
    });
    const result = await confirmTourInquiry(db, {
      inquiryId: "inq-1",
      actorUserId: OWNER,
      notifyTenant: false,
    });
    expect(result.ok).toBe(true);
    expect(hostOf(written)).toBe(OWNER);
  });
});
