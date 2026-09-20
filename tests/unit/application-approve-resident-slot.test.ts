/**
 * Route-level regression for the approval pick on a room priced per resident
 * (PLAN-0920-0631): `POST /api/manager-applications` with `{ action: "upsert" }`
 * transitioning an application into `approved`.
 *
 * The server NEVER trusts the client's own rent/utilities/deposit for a
 * per-resident room — it re-derives the slot's price from the listing itself,
 * the same `openResidentSlots` decision the approval picker previews, inside
 * the SAME write that takes the bed. This drives the real route handler
 * end-to-end, mirroring the withdraw/resident-submit tests' Supabase stub.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DemoApplicantRow } from "@/data/demo-portal";
import { createDefaultListingSubmission, emptyRoom } from "@/lib/manager-listing-submission";
import { createInitialRentalWizardState } from "@/lib/rental-application/state";

const getUser = vi.fn();
let PROFILE: { role: string; email: string } | null = null;
let PROPERTY_RECORDS: Record<string, { row_data: { listingSubmission: unknown }; manager_user_id?: string }> = {};
let PROPERTY_READ_ERROR = false;
let SIBLING_READ_ERROR = false;
let STORED_ROWS: {
  id: string;
  row_data: DemoApplicantRow;
  manager_user_id?: string | null;
  resident_email?: string | null;
  property_id?: string | null;
  assigned_property_id?: string | null;
}[] = [];
let UPSERTS: { id: string; manager_user_id: string | null; row_data: DemoApplicantRow }[] = [];

vi.mock("@/lib/auth/admin-preview", () => ({ isAdminUser: vi.fn(async () => IS_ADMIN) }));
let IS_ADMIN = false;
vi.mock("@/lib/auth/provision-approved-resident", () => ({
  provisionApprovedResidentAccount: vi.fn(async () => ({ ok: true })),
}));
vi.mock("@/lib/screening/order-screening", () => ({ tryAutoOrderScreening: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: async () => ({ auth: { getUser } }),
}));
vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceRoleClient: () => makeDb() }));

/** Chainable Supabase stub, extended with the two reads `resolveApprovedResidentSlot` makes. */
function makeDb() {
  return {
    from(table: string) {
      const state: {
        ids: string[] | null;
        eqId: string | null;
        eqManagerUserId: string | null;
        eqBucket: string | null;
      } = { ids: null, eqId: null, eqManagerUserId: null, eqBucket: null };
      const builder: Record<string, unknown> = {
        select: () => builder,
        update: () => builder,
        insert: () => Promise.resolve({ error: null }),
        upsert(values: { id: string; manager_user_id: string | null; row_data: DemoApplicantRow }) {
          if (table === "manager_application_records") UPSERTS.push(values);
          return Promise.resolve({ error: null });
        },
        delete: () => builder,
        eq(column: string, value: string) {
          if (column === "id") state.eqId = value;
          if (column === "manager_user_id") state.eqManagerUserId = value;
          if (column === "row_data->>bucket") state.eqBucket = value;
          return builder;
        },
        ilike: () => builder,
        in(column: string, values: string[]) {
          if (column === "id") state.ids = values;
          return builder;
        },
        order: () => builder,
        limit: () => builder,
        maybeSingle() {
          if (table === "profiles") return Promise.resolve({ data: PROFILE, error: null });
          if (table === "manager_property_records") {
            if (PROPERTY_READ_ERROR) {
              return Promise.resolve({ data: null, error: { message: "read failed" } });
            }
            const record = state.eqId ? PROPERTY_RECORDS[state.eqId] : null;
            // Scoped exactly like the real query: `.eq("id", …).eq("manager_user_id", …)`
            // — a record whose owner does not match the acting manager reads as not found.
            const ownerMatches = !record || (record.manager_user_id ?? OWNER) === state.eqManagerUserId;
            return Promise.resolve({ data: ownerMatches ? record : null, error: null });
          }
          return Promise.resolve({ data: null, error: null });
        },
        then(resolve: (v: { data: unknown; error: unknown }) => unknown) {
          if (table === "manager_application_records") {
            if (state.eqBucket && SIBLING_READ_ERROR) {
              return Promise.resolve({ data: null, error: { message: "read failed" } }).then(resolve);
            }
            let out = STORED_ROWS;
            if (state.ids) out = out.filter((r) => state.ids?.includes(r.id));
            if (state.eqManagerUserId) out = out.filter((r) => r.manager_user_id === state.eqManagerUserId);
            if (state.eqBucket) out = out.filter((r) => r.row_data.bucket === state.eqBucket);
            return Promise.resolve({ data: out, error: null }).then(resolve);
          }
          return Promise.resolve({ data: null, error: null }).then(resolve);
        },
      };
      return builder;
    },
  };
}

const OWNER = "mgr-owner-of-the-magnolia";
const MANAGER_EMAIL = "manager@example.com";
const LISTING = "mgr-magnolia-shared-room";
const ROOM_ID = "room-shared-1";
const ROOM_CHOICE = `${LISTING}::${ROOM_ID}`;

function sharedRoomListing() {
  const room = {
    ...emptyRoom(0),
    id: ROOM_ID,
    monthlyRent: 1000,
    utilitiesEstimate: "75",
    securityDeposit: "250",
    occupancyCapacity: 2,
    residentPricing: "per_resident" as const,
    residentPrices: [{ monthlyRent: 900 }, { monthlyRent: 800 }],
  };
  return { ...createDefaultListingSubmission(), rooms: [room] };
}

function applicationRow(
  id: string,
  over: Partial<DemoApplicantRow> = {},
  appOver: Record<string, unknown> = {},
): DemoApplicantRow {
  return {
    id,
    name: id,
    email: `${id.toLowerCase()}@example.com`,
    property: "The Magnolia",
    propertyId: LISTING,
    bucket: "pending",
    stage: "Submitted",
    detail: "",
    managerUserId: OWNER,
    assignedPropertyId: LISTING,
    assignedRoomChoice: ROOM_CHOICE,
    application: {
      ...createInitialRentalWizardState(),
      propertyId: LISTING,
      roomChoice1: ROOM_CHOICE,
      leaseTerm: "12-Month",
      leaseStart: "2026-09-01",
      leaseEnd: "",
      ...appOver,
    },
    ...over,
  } as unknown as DemoApplicantRow;
}

async function upsert(row: DemoApplicantRow) {
  const { POST } = await import("@/app/api/manager-applications/route");
  const res = await POST(
    new Request("http://localhost/api/manager-applications", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "upsert", row }),
    }),
  );
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

beforeEach(() => {
  vi.clearAllMocks();
  PROFILE = { role: "manager", email: MANAGER_EMAIL };
  getUser.mockResolvedValue({
    data: { user: { id: OWNER, email: MANAGER_EMAIL, user_metadata: {} } },
    error: null,
  });
  PROPERTY_RECORDS = { [LISTING]: { row_data: { listingSubmission: sharedRoomListing() } } };
  PROPERTY_READ_ERROR = false;
  SIBLING_READ_ERROR = false;
  UPSERTS = [];
  IS_ADMIN = false;
});

describe("POST /api/manager-applications — approving a per-resident room's slot pick", () => {
  it("writes the four fields from the SERVER's own resolved price, ignoring the client's tampered rent", async () => {
    // Aaron already holds slot 1 ($900) since Sep 1.
    const aaron = applicationRow("AXIS-AARON", { bucket: "approved" }, { residentSlot: 1, managerRentOverride: "900" });
    // Grace is pending, being approved now. She (or a stale/tampered client)
    // asks for slot 2 but sends fabricated $1 figures — the server must never
    // trust these.
    const grace = applicationRow("AXIS-GRACE", {}, { leaseStart: "2026-09-05" });
    STORED_ROWS = [
      { id: aaron.id, row_data: aaron, manager_user_id: OWNER },
      { id: grace.id, row_data: grace, manager_user_id: OWNER },
    ];

    const approvingRow: DemoApplicantRow = {
      ...grace,
      bucket: "approved",
      application: {
        ...grace.application!,
        residentSlot: 2,
        managerRentOverride: "1",
        managerUtilitiesOverride: "1",
        managerSecurityDepositOverride: "1",
      },
    };
    const res = await upsert(approvingRow);

    expect(res.status).toBe(200);
    expect(UPSERTS).toHaveLength(1);
    const written = UPSERTS[0]!.row_data.application!;
    expect(written.residentSlot).toBe(2);
    expect(written.managerRentOverride).toBe("800");
    expect(written.managerUtilitiesOverride).toBe("75");
    expect(written.managerSecurityDepositOverride).toBe("250");
  });

  it("refuses a slot already held by another approved resident — the existing capacity 409 shape", async () => {
    const aaron = applicationRow("AXIS-AARON", { bucket: "approved" }, { residentSlot: 1, managerRentOverride: "900" });
    const grace = applicationRow("AXIS-GRACE", {}, { leaseStart: "2026-09-05" });
    STORED_ROWS = [
      { id: aaron.id, row_data: aaron, manager_user_id: OWNER },
      { id: grace.id, row_data: grace, manager_user_id: OWNER },
    ];

    const approvingRow: DemoApplicantRow = {
      ...grace,
      bucket: "approved",
      application: { ...grace.application!, residentSlot: 1 }, // Aaron's slot — stale/tampered pick
    };
    const res = await upsert(approvingRow);

    expect(res.status).toBe(409);
    expect(res.body.blocked).toBe("capacity");
    expect(UPSERTS).toHaveLength(0);
  });

  it("still approves normally when the room does NOT price per resident", async () => {
    PROPERTY_RECORDS = {
      [LISTING]: {
        row_data: {
          listingSubmission: {
            ...createDefaultListingSubmission(),
            rooms: [{ ...emptyRoom(0), id: ROOM_ID, monthlyRent: 1000 }],
          },
        },
      },
    };
    const solo = applicationRow("AXIS-SOLO");
    STORED_ROWS = [{ id: solo.id, row_data: solo, manager_user_id: OWNER }];

    const res = await upsert({ ...solo, bucket: "approved" });

    expect(res.status).toBe(200);
    expect(UPSERTS).toHaveLength(1);
    // No slot fields invented for a room that isn't priced per resident.
    expect(UPSERTS[0]!.row_data.application!.residentSlot).toBeUndefined();
  });

  it("never reads or prices a room on a property owned by a DIFFERENT manager", async () => {
    // The room choice names a real per-resident room, but it belongs to
    // another manager entirely — the lookup must not resolve it, so this
    // guard treats it as inapplicable rather than pricing off a stranger's room.
    PROPERTY_RECORDS = {
      [LISTING]: { row_data: { listingSubmission: sharedRoomListing() }, manager_user_id: "mgr-someone-else" },
    };
    const grace = applicationRow("AXIS-GRACE");
    STORED_ROWS = [{ id: grace.id, row_data: grace, manager_user_id: OWNER }];

    const approvingRow: DemoApplicantRow = {
      ...grace,
      bucket: "approved",
      application: { ...grace.application!, residentSlot: 2, managerRentOverride: "1" },
    };
    const res = await upsert(approvingRow);

    expect(res.status).toBe(200);
    expect(UPSERTS).toHaveLength(1);
    // Falls through untouched — the same as a nonexistent property id — never
    // the other manager's real slot price.
    expect(UPSERTS[0]!.row_data.application!.managerRentOverride).toBe("1");
  });

  it("fails CLOSED (refuses the approval) when the property lookup errors, instead of keeping the client's override", async () => {
    PROPERTY_READ_ERROR = true;
    const grace = applicationRow("AXIS-GRACE");
    STORED_ROWS = [{ id: grace.id, row_data: grace, manager_user_id: OWNER }];

    const approvingRow: DemoApplicantRow = {
      ...grace,
      bucket: "approved",
      application: { ...grace.application!, residentSlot: 2, managerRentOverride: "1" },
    };
    const res = await upsert(approvingRow);

    expect(res.status).toBe(409);
    expect(res.body.blocked).toBe("capacity");
    expect(UPSERTS).toHaveLength(0);
  });

  it("fails CLOSED (refuses the approval) when the row's managerUserId is blank, instead of keeping the client's override", async () => {
    // Only an ADMIN caller skips the manager write-owner resolution that
    // would otherwise overwrite `row.managerUserId` — so a blank id here
    // reaches `resolveApprovedResidentSlot` exactly as the client sent it.
    // A blank manager id means the property lookup right after this (scoped
    // by `manager_user_id`) can never be verified, and this must refuse
    // exactly like the DB-error paths above, not fall through as
    // "inapplicable" and let the client's unverified override land.
    IS_ADMIN = true;
    const grace = applicationRow("AXIS-GRACE", { managerUserId: "" });
    STORED_ROWS = [{ id: grace.id, row_data: grace, manager_user_id: OWNER }];

    const approvingRow: DemoApplicantRow = {
      ...grace,
      bucket: "approved",
      managerUserId: "",
      application: { ...grace.application!, residentSlot: 2, managerRentOverride: "1" },
    };
    const res = await upsert(approvingRow);

    expect(res.status).toBe(409);
    expect(res.body.blocked).toBe("capacity");
    expect(UPSERTS).toHaveLength(0);
  });

  it("fails CLOSED (refuses the approval) when the sibling-slot lookup errors", async () => {
    SIBLING_READ_ERROR = true;
    const grace = applicationRow("AXIS-GRACE");
    STORED_ROWS = [{ id: grace.id, row_data: grace, manager_user_id: OWNER }];

    const approvingRow: DemoApplicantRow = {
      ...grace,
      bucket: "approved",
      application: { ...grace.application!, residentSlot: 2, managerRentOverride: "1" },
    };
    const res = await upsert(approvingRow);

    expect(res.status).toBe(409);
    expect(res.body.blocked).toBe("capacity");
    expect(UPSERTS).toHaveLength(0);
  });
});
