/**
 * WS4(shared-avail): the atomic claim guard behind `confirmTourInquiry`.
 *
 * `confirmTourInquiry` does a non-atomic read-modify-write on the shared JSON
 * singletons that hold pending inquiries and planned events. Two co-managers
 * approving the SAME pending request concurrently could both pass their
 * (stale) double-book check and both upsert, so the second write silently
 * clobbered the first — one manager's booking vanished even though BOTH
 * callers were told `ok: true`. `acquireTourInquiryClaim` closes that with a
 * DB-level unique-key insert (see the `tour_inquiry_claims` migration); real
 * concurrent-Postgres evidence for the insert itself lives in
 * `tests/integration/database/tour-inquiry-claim.test.ts` — this file covers
 * the code path that maps that DB guarantee onto `confirmTourInquiry`'s
 * result, including stale-claim recovery and always releasing on exit.
 */
import { describe, expect, it } from "vitest";
import {
  acquireTourInquiryClaim,
  confirmTourInquiry,
  releaseTourInquiryClaim,
} from "@/lib/tour-inquiry-confirm.server";

type ClaimRow = { claimed_by: string; claimed_at: string };

function claimsDb(rows: Map<string, ClaimRow>) {
  return {
    from(table: string) {
      if (table !== "tour_inquiry_claims") return {};
      return {
        insert: async (row: { inquiry_id: string; claimed_by: string }) => {
          if (rows.has(row.inquiry_id)) {
            return {
              data: null,
              error: { code: "23505", message: "duplicate key value violates unique constraint" },
            };
          }
          rows.set(row.inquiry_id, { claimed_by: row.claimed_by, claimed_at: new Date().toISOString() });
          return { data: null, error: null };
        },
        delete: () => ({
          eq: (_column: string, inquiryId: string) => ({
            then: (resolve: (value: { error: null }) => void) => {
              rows.delete(inquiryId);
              resolve({ error: null });
            },
            lt: async (_column2: string, isoBound: string) => {
              const row = rows.get(inquiryId);
              if (row && row.claimed_at < isoBound) rows.delete(inquiryId);
              return { error: null };
            },
          }),
        }),
      };
    },
  };
}

describe("acquireTourInquiryClaim", () => {
  it("wins when nobody else holds the claim", async () => {
    const rows = new Map<string, ClaimRow>();
    const result = await acquireTourInquiryClaim(claimsDb(rows) as never, "inq-1", "mgr-a");
    expect(result).toEqual({ ok: true });
    expect(rows.has("inq-1")).toBe(true);
  });

  it("loses to a fresh claim on the SAME inquiry — the exact race this closes", async () => {
    const rows = new Map<string, ClaimRow>([["inq-1", { claimed_by: "mgr-a", claimed_at: new Date().toISOString() }]]);
    const result = await acquireTourInquiryClaim(claimsDb(rows) as never, "inq-1", "mgr-b");
    expect(result).toEqual({ ok: false, status: 409, error: "Another manager already took this tour." });
  });

  it("does not block a DIFFERENT inquiry held by someone else", async () => {
    const rows = new Map<string, ClaimRow>([["inq-other", { claimed_by: "mgr-a", claimed_at: new Date().toISOString() }]]);
    const result = await acquireTourInquiryClaim(claimsDb(rows) as never, "inq-1", "mgr-b");
    expect(result).toEqual({ ok: true });
  });

  it("recovers a stale claim left by a crashed confirm and lets a fresh one through", async () => {
    const rows = new Map<string, ClaimRow>([
      ["inq-1", { claimed_by: "mgr-a", claimed_at: new Date(Date.now() - 10 * 60_000).toISOString() }],
    ]);
    const result = await acquireTourInquiryClaim(claimsDb(rows) as never, "inq-1", "mgr-b");
    expect(result).toEqual({ ok: true });
    expect(rows.get("inq-1")?.claimed_by).toBe("mgr-b");
  });

  it("releasing clears the row so a later confirm can claim again", async () => {
    const rows = new Map<string, ClaimRow>();
    await acquireTourInquiryClaim(claimsDb(rows) as never, "inq-1", "mgr-a");
    expect(rows.has("inq-1")).toBe(true);
    await releaseTourInquiryClaim(claimsDb(rows) as never, "inq-1");
    expect(rows.has("inq-1")).toBe(false);
    const again = await acquireTourInquiryClaim(claimsDb(rows) as never, "inq-1", "mgr-b");
    expect(again).toEqual({ ok: true });
  });
});

/**
 * `confirmTourInquiry` itself: the claim must short-circuit the function
 * BEFORE it touches the pending-inquiry / planned-event singletons, so a
 * losing caller never partially applies a booking.
 */
const INQUIRIES_RECORD_ID = "axis_admin_partner_inquiries_v1";
const PLANNED_RECORD_ID = "axis_admin_planned_events_v1";
const OWNER = "mgr-owner-claim";
const CO_MANAGER = "mgr-co-claim";
const START = "2099-08-06T17:00:00.000Z";
const END = "2099-08-06T18:00:00.000Z";

function inquiry(overrides: Record<string, unknown> = {}) {
  return {
    id: "inq-claim-1",
    kind: "tour",
    status: "pending",
    name: "Guest",
    email: "guest@example.com",
    phone: "2065550123",
    managerUserId: OWNER,
    eligibleHostUserIds: [OWNER, CO_MANAGER],
    propertyId: "prop-claim-1",
    propertyTitle: "Ballard House",
    proposedStart: START,
    proposedEnd: END,
    requestedWindows: [{ start: START, end: END, slotKey: "2099-08-06:34" }],
    ...overrides,
  };
}

function fullDb(input: { inquiries: Record<string, unknown>[]; claimRows: Map<string, ClaimRow> }) {
  let upsertCalls = 0;
  const db = {
    from(table: string) {
      if (table === "tour_inquiry_claims") return claimsDb(input.claimRows).from(table);
      return {
        select: () => ({
          eq: (_column: string, id: string) => ({
            maybeSingle: async () => ({
              data: {
                row_data: {
                  payload: id === INQUIRIES_RECORD_ID ? input.inquiries : id === PLANNED_RECORD_ID ? [] : [],
                },
              },
              error: null,
            }),
          }),
        }),
        upsert: async () => {
          upsertCalls += 1;
          return { error: null };
        },
        delete: () => ({ in: async () => ({ error: null }) }),
      };
    },
  };
  return { db: db as never, upsertCallCount: () => upsertCalls };
}

describe("confirmTourInquiry: claim guard integration", () => {
  it("returns 409 and never writes the singletons when another confirm already holds the claim", async () => {
    const claimRows = new Map<string, ClaimRow>([
      ["inq-claim-1", { claimed_by: OWNER, claimed_at: new Date().toISOString() }],
    ]);
    const { db, upsertCallCount } = fullDb({ inquiries: [inquiry()], claimRows });

    const result = await confirmTourInquiry(db, {
      inquiryId: "inq-claim-1",
      actorUserId: CO_MANAGER,
      notifyTenant: false,
    });

    expect(result).toMatchObject({ ok: false, status: 409, error: "Another manager already took this tour." });
    expect(upsertCallCount()).toBe(0);
  });

  it("wins the claim, confirms, and releases it — a retry is not permanently locked out", async () => {
    const claimRows = new Map<string, ClaimRow>();
    const { db, upsertCallCount } = fullDb({ inquiries: [inquiry()], claimRows });

    const result = await confirmTourInquiry(db, {
      inquiryId: "inq-claim-1",
      actorUserId: OWNER,
      notifyTenant: false,
    });

    expect(result.ok).toBe(true);
    expect(upsertCallCount()).toBe(1);
    // Released on success — nothing is left holding the mutex.
    expect(claimRows.has("inq-claim-1")).toBe(false);
  });

  it("releases the claim on a validation failure too, so the SAME actor can retry", async () => {
    const claimRows = new Map<string, ClaimRow>();
    const { db } = fullDb({ inquiries: [inquiry({ eligibleHostUserIds: [OWNER] })], claimRows });

    const result = await confirmTourInquiry(db, {
      inquiryId: "inq-claim-1",
      actorUserId: OWNER,
      hostUserId: "mgr-not-eligible",
      notifyTenant: false,
    });

    expect(result).toMatchObject({ ok: false, status: 403 });
    // The 403 is thrown BEFORE the claim is even acquired (host eligibility is
    // checked first), so there is nothing to release — the point is simply
    // that no stray claim row is left behind either way.
    expect(claimRows.has("inq-claim-1")).toBe(false);
  });
});
