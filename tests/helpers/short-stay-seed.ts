import { createFakeDb, type FakeDbOptions, type Row } from "./fake-table-db";

export const OWNER = "owner-1";
export const GUEST = "guest-1";
export const PROPERTY = "prop-1";
export const TODAY = "2026-10-14";

export type SeedOptions = {
  /** Past stays this guest already has on the listing. */
  history?: Array<Partial<Row> & { row_data: Row; record_type?: string }>;
  submission?: Record<string, unknown>;
  guestPhone?: string | null;
  failWrite?: FakeDbOptions["failWrite"];
};

export function seedShortStayDb(opts: SeedOptions = {}) {
  const submission = {
    v: 1,
    shortTermRentalsAllowed: true,
    shortTermDailyCost: "140",
    rooms: [
      { id: "r1", name: "Attic Nook", occupancyCapacity: 1 },
      { id: "r4", name: "Garden Suite", occupancyCapacity: 4 },
    ],
    ...opts.submission,
  };
  const db = createFakeDb(
    {
      manager_property_records: [
        {
          id: PROPERTY,
          manager_user_id: OWNER,
          status: "live",
          test_workspace_id: null,
          property_data: { buildingName: "Cedar Court", listingSubmission: submission },
        },
      ],
      profiles: [
        { id: OWNER, email: "owner@proplane.test", full_name: "Ambika Mago" },
        {
          id: GUEST,
          email: "priya@example.com",
          full_name: "Priya Natarajan",
          phone: opts.guestPhone === undefined ? "+12065550142" : opts.guestPhone,
          role: "resident",
        },
      ],
      portal_schedule_records: (opts.history ?? []).map((row, index) => ({
        id: `history-${index}`,
        manager_user_id: OWNER,
        property_id: PROPERTY,
        record_type: "room_date_block",
        starts_at: "2026-09-01T00:00:00",
        ends_at: "2026-09-02T00:00:00",
        ...row,
      })),
      portal_household_charge_records: [],
    },
    { failWrite: opts.failWrite },
  );
  return db;
}

/** A finished, confirmed stay of GUEST on the listing: what makes them "returning". */
export function completedStay(overrides: Row = {}): { row_data: Row } {
  return {
    row_data: {
      bookingStatus: "confirmed",
      propertyId: PROPERTY,
      roomId: "r1",
      checkIn: "2026-09-01",
      checkOut: "2026-09-02",
      residentUserId: GUEST,
      stayDetails: { source: "guest_portal", guests: 1 },
      ...overrides,
    },
  };
}
