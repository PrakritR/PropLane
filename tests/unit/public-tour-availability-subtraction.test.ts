/**
 * The public booking grid's one rule:
 *
 *     offered = published availability MINUS calendar-busy MINUS already-booked
 *
 * The implicit 9-5 default was REMOVED in 09af3348 ("Remove implicit default
 * tour availability"), so a property whose manager has published nothing now
 * offers nothing. The tests that asserted the default went with it; what
 * remains is the subtraction half, which is what stops the same half hour
 * being sold to three prospects.
 *
 * The subtraction half is what stops the same half hour being sold to three
 * prospects. A confirmed tour left its own slot on offer, and the manager's
 * linked-calendar busy time was never read at all even though the product's own
 * copy promises "only the blocked time is shown here so tour availability stays
 * accurate". The default half is intended product behaviour: a property whose
 * manager has not opened a calendar still offers a 9-5 day.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A fresh manager id per test. The route caches Google busy windows per manager
 * for 60s so a public, uncached endpoint cannot be used to drive unbounded
 * Google API calls; a shared id would serve one test's busy list to the next.
 */
let MANAGER = "mgr-1";
let managerCounter = 0;
const PROPERTY_ID = "mgr-demo-ballard";

/** The requested property's listing status; only `live` may offer the default grid. */
let PROPERTY_STATUS = "live";

let PROPERTY_AVAILABILITY_SLOTS: string[] | null;
let GLOBAL_AVAILABILITY_SLOTS: string[] | null;
let PENDING_INQUIRIES: Record<string, unknown>[];
let PLANNED_EVENTS: Record<string, unknown>[];
let GOOGLE_BUSY: {
  id: string;
  summary: string;
  start: string;
  end: string;
  transparency?: "opaque" | "transparent";
  declinedBySelf?: boolean;
  allDay?: boolean;
}[];
let GOOGLE_THROWS: boolean;
/** Columns the property-availability reads were scoped on, in call order. */
let PROPERTY_AVAILABILITY_QUERY_FILTERS: string[] = [];

vi.mock("@/lib/supabase/service", () => ({
  createSupabaseServiceRoleClient: () => makeServiceClient(),
}));
/** The `timeMax` the route asked Google for, per call. */
let GOOGLE_TIME_MAX: string[] = [];

/** Set to throw the permanent not-linked sentinel instead of a transient error. */
let GOOGLE_THROWS_NOT_LINKED = false;

class FakeNotLinkedError extends Error {}

vi.mock("@/lib/google-calendar/api.server", () => ({
  GOOGLE_CALENDAR_OPERATION_TIMEOUT_MS: 9_000,
  isGoogleCalendarNotLinkedError: (e: unknown) => e instanceof FakeNotLinkedError,
  listGoogleCalendarEvents: vi.fn(async (_db: unknown, _id: string, _min: string, max: string) => {
    GOOGLE_TIME_MAX.push(max);
    if (GOOGLE_THROWS_NOT_LINKED) throw new FakeNotLinkedError("Google Calendar is not connected.");
    if (GOOGLE_THROWS) throw new Error("Google Calendar did not respond in time.");
    return GOOGLE_BUSY;
  }),
}));
vi.mock("@/lib/public-host-label", () => ({
  publicSchedulingHostLabel: () => "Test Manager",
}));

import { GET as getAvailability } from "@/app/api/public/property-tour-availability/route";
import { slotStartMs } from "@/lib/tour-slot-math";

function availabilityRow(recordType: string, slots: string[]) {
  return {
    id: `${recordType}_${MANAGER}_prop_${PROPERTY_ID}`,
    manager_user_id: MANAGER,
    property_id: recordType === "manager_property_availability" ? PROPERTY_ID : null,
    record_type: recordType,
    row_data: { payload: slots },
  };
}

function makeServiceClient() {
  return {
    from(table: string) {
      if (table === "profiles") {
        return {
          select: () => ({ in: async () => ({ data: [{ id: MANAGER, email: "m@x.com", full_name: "Test" }] }) }),
        };
      }
      if (table === "manager_property_records") {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({
                data: {
                  manager_user_id: MANAGER,
                  status: PROPERTY_STATUS,
                  property_data: { id: PROPERTY_ID, buildingName: "Ballard House", address: "1 Ballard Ave" },
                },
                error: null,
              }),
            }),
          }),
        };
      }
      if (table === "portal_schedule_records") {
        let recordType = "";
        const builder: Record<string, unknown> = {
          select: () => builder,
          eq: (column: string, value: string) => {
            if (column === "record_type") recordType = value;
            if (column === "id" && value === "axis_admin_planned_events_v1") {
              builder.maybeSingle = async () => ({
                data: { row_data: { payload: PLANNED_EVENTS } },
                error: null,
              });
            }
            return builder;
          },
          // Every read of this table is now SCOPED — the property-availability
          // select used to be a full-table scan, which a `no-store` route pays
          // for on every public booking-page view. Filter here so the fixture
          // proves the scoping, rather than handing back rows regardless.
          in: async (column: string, values: string[]) => {
            if (recordType === "manager_property_availability") {
              const rows = PROPERTY_AVAILABILITY_SLOTS
                ? [availabilityRow("manager_property_availability", PROPERTY_AVAILABILITY_SLOTS)]
                : [];
              PROPERTY_AVAILABILITY_QUERY_FILTERS.push(column);
              return {
                data: rows.filter((row) =>
                  column === "manager_user_id"
                    ? values.includes(row.manager_user_id)
                    : values.includes(row.property_id ?? ""),
                ),
                error: null,
              };
            }
            if (recordType === "manager_availability") {
              return {
                data: GLOBAL_AVAILABILITY_SLOTS
                  ? [availabilityRow("manager_availability", GLOBAL_AVAILABILITY_SLOTS)]
                  : [],
                error: null,
              };
            }
            if (recordType === "partner_inquiry_request") {
              return {
                data: PENDING_INQUIRIES.map((payload) => ({
                  manager_user_id: MANAGER,
                  row_data: { payload },
                })),
                error: null,
              };
            }
            return { data: [], error: null };
          },
          maybeSingle: async () => ({ data: null, error: null }),
        };
        return builder;
      }
      return {};
    },
  };
}

/**
 * The route rate-limits per client IP, and the limiter's buckets are
 * module-global, so a shared IP would let one test's requests spend another's
 * budget. `managerCounter` already gives every test a distinct identity — reuse
 * it here so each gets its own bucket.
 */
function availabilityRequest(ip: string = `10.0.0.${managerCounter}`): Request {
  return new Request(`https://x.test/api/public/property-tour-availability?propertyId=${PROPERTY_ID}`, {
    headers: { "x-forwarded-for": ip },
  });
}

async function offeredSlots(): Promise<Set<string>> {
  const res = await getAvailability(availabilityRequest());
  const body = (await res.json()) as { slotHosts?: Record<string, unknown[]> };
  return new Set(Object.keys(body.slotHosts ?? {}));
}

/**
 * A FIXED clock for the TTL tests, half past the hour on purpose.
 *
 * The busy window end is `now + horizon`, rounded UP to the hour so successive
 * requests ask Google for the same `timeMax`. Offsetting the LIVE clock by a few
 * seconds can therefore straddle an hour boundary, move the window, and make the
 * cache-coverage check miss — a rare flake that reads as "the cache did not
 * hold". A base at :30:00 keeps every offset used here inside one hour.
 */
const PINNED_NOW = Date.parse("2026-08-03T12:30:00.000Z");

/** Pin `Date.now` so every clock read in one test agrees. */
function pinNow(ms: number): void {
  if (vi.isMockFunction(Date.now)) {
    vi.mocked(Date.now).mockReturnValue(ms);
    return;
  }
  vi.spyOn(Date, "now").mockReturnValue(ms);
}

/** A far-future date so `slotIsBookable` never filters the fixture out. */
const DAY = "2099-08-06";
/** 10:00-10:30 am Pacific on {@link DAY}. */
const TEN_AM = `${DAY}:20`;
/** A published slot on a DIFFERENT day, to prove one blocked day is not all of them. */
const OTHER_DAY_SLOT = "2099-08-07:20";
const TEN_AM_START = "2099-08-06T17:00:00.000Z";
const TEN_AM_END = "2099-08-06T17:30:00.000Z";

describe("public tour availability subtracts what is already taken", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    managerCounter += 1;
    MANAGER = `mgr-${managerCounter}`;
    PROPERTY_AVAILABILITY_SLOTS = [`${DAY}:18`, `${DAY}:19`, TEN_AM, `${DAY}:21`];
    GLOBAL_AVAILABILITY_SLOTS = null;
    PENDING_INQUIRIES = [];
    PLANNED_EVENTS = [];
    GOOGLE_BUSY = [];
    GOOGLE_THROWS = false;
    GOOGLE_THROWS_NOT_LINKED = false;
    GOOGLE_TIME_MAX = [];
    PROPERTY_AVAILABILITY_QUERY_FILTERS = [];
    PROPERTY_STATUS = "live";
    if (vi.isMockFunction(Date.now)) vi.mocked(Date.now).mockRestore();
  });

  it("offers published availability when nothing is taken", async () => {
    const slots = await offeredSlots();
    expect(slots.has(TEN_AM)).toBe(true);
    expect([...slots].filter((slot) => slot.startsWith(`${DAY}:`)).length).toBe(4);
    // Exactly the four published slots: there is no implicit default to pad it.
    expect(slots.size).toBe(4);
  });

  it("offers a live property's global availability when it has published none of its own", async () => {
    PROPERTY_AVAILABILITY_SLOTS = null;
    GLOBAL_AVAILABILITY_SLOTS = [TEN_AM, `${DAY}:21`];
    const slots = await offeredSlots();
    expect(slots.has(TEN_AM)).toBe(true);
    expect([...slots].filter((slot) => slot.startsWith(`${DAY}:`)).length).toBe(2);
    expect(slots.size).toBe(2);
  });

  it.each(["draft", "pending", "review", "unlisted"])(
    "publishes nothing for a %s property whose manager HAS global availability",
    async (status) => {
      // `manager_availability` rows are GLOBAL to the manager and are the normal
      // state for anyone using the portfolio calendar, so gating only the 9-5
      // default left this wide open: anyone holding a non-live property's id got
      // the manager's real published calendar for it.
      PROPERTY_STATUS = status;
      PROPERTY_AVAILABILITY_SLOTS = null;
      GLOBAL_AVAILABILITY_SLOTS = [TEN_AM, `${DAY}:21`];
      const slots = await offeredSlots();
      expect(slots.size).toBe(0);
      expect(GOOGLE_TIME_MAX).toHaveLength(0);
    },
  );

  it("publishes nothing for a non-live property with property-scoped availability", async () => {
    PROPERTY_STATUS = "unlisted";
    const slots = await offeredSlots();
    expect(slots.size).toBe(0);
  });

  it("removes a confirmed tour's own slot", async () => {
    PLANNED_EVENTS = [
      {
        id: "planned-1",
        kind: "tour",
        managerUserId: MANAGER,
        start: TEN_AM_START,
        end: TEN_AM_END,
        slotKey: TEN_AM,
      },
    ];
    const slots = await offeredSlots();
    expect(slots.has(TEN_AM)).toBe(false);
    expect(slots.has(`${DAY}:21`)).toBe(true);
  });

  it("never reads property availability unscoped", async () => {
    // This route is `no-store`, so a full-table `manager_property_availability`
    // select is paid on every public booking-page view. Both reads must carry a
    // filter: the property's own managers, and the requested property's id.
    await offeredSlots();
    expect(PROPERTY_AVAILABILITY_QUERY_FILTERS).toContain("manager_user_id");
    expect(PROPERTY_AVAILABILITY_QUERY_FILTERS).toContain("property_id");
    expect(PROPERTY_AVAILABILITY_QUERY_FILTERS.length).toBe(2);
  });

  it("removes a confirmed tour's slot even when the event carries no slotKey", async () => {
    // A tour confirmed with a custom duration, or moved by a reschedule, has no
    // slotKey to match on — only the time-range overlap can catch it.
    PLANNED_EVENTS = [
      { id: "planned-2", kind: "tour", managerUserId: MANAGER, start: TEN_AM_START, end: TEN_AM_END },
    ];
    const slots = await offeredSlots();
    expect(slots.has(TEN_AM)).toBe(false);
  });

  it("removes every half hour a longer confirmed tour spans", async () => {
    PLANNED_EVENTS = [
      {
        id: "planned-3",
        kind: "tour",
        managerUserId: MANAGER,
        start: TEN_AM_START,
        end: "2099-08-06T18:30:00.000Z", // a 90-minute tour
      },
    ];
    const slots = await offeredSlots();
    expect(slots.has(TEN_AM)).toBe(false);
    expect(slots.has(`${DAY}:21`)).toBe(false);
  });

  it("removes calendar-busy time from the manager's linked calendar", async () => {
    GOOGLE_BUSY = [
      { id: "g1", summary: "Busy", start: "2099-08-06T14:30:00.000Z", end: "2099-08-06T17:00:00.000Z" },
    ];
    const slots = await offeredSlots();
    expect(slots.has(`${DAY}:18`)).toBe(false); // 9:00 am, inside busy
    expect(slots.has(`${DAY}:19`)).toBe(false); // 9:30 am, inside busy
    expect(slots.has(TEN_AM)).toBe(true); // 10:00 am, busy has ended
  });

  it("ignores an event the manager marked Free", async () => {
    // `transparency: "transparent"` is Google's "show me as available". Treating
    // it as busy deletes tour slots the manager never blocked.
    GOOGLE_BUSY = [
      {
        id: "g-free",
        summary: "Focus time",
        start: "2099-08-06T14:30:00.000Z",
        end: "2099-08-06T18:00:00.000Z",
        transparency: "transparent",
      },
    ];
    const slots = await offeredSlots();
    expect([...slots].filter((slot) => slot.startsWith(`${DAY}:`)).length).toBe(4);
    // Exactly the four published slots: there is no implicit default to pad it.
    expect(slots.size).toBe(4);
  });

  it("ignores an invite the manager declined", async () => {
    GOOGLE_BUSY = [
      {
        id: "g-declined",
        summary: "Someone else's meeting",
        start: "2099-08-06T14:30:00.000Z",
        end: "2099-08-06T18:00:00.000Z",
        declinedBySelf: true,
      },
    ];
    const slots = await offeredSlots();
    expect([...slots].filter((slot) => slot.startsWith(`${DAY}:`)).length).toBe(4);
    // Exactly the four published slots: there is no implicit default to pad it.
    expect(slots.size).toBe(4);
  });

  it("still blocks an all-day entry — a trip is exactly when a manager cannot host", async () => {
    PROPERTY_AVAILABILITY_SLOTS = [...(PROPERTY_AVAILABILITY_SLOTS ?? []), OTHER_DAY_SLOT];
    GOOGLE_BUSY = [
      { id: "g-allday", summary: "Out of town", start: `${DAY}T00:00:00`, end: `${DAY}T23:59:59`, allDay: true },
    ];
    const slots = await offeredSlots();
    expect([...slots].some((slot) => slot.startsWith(`${DAY}:`))).toBe(false);
    // The blocked day is gone but a day the manager published elsewhere
    // survives: an all-day block must not blank the whole grid.
    expect(slots.has(OTHER_DAY_SLOT)).toBe(true);
  });

  it("blocks an all-day entry even though Google reports it Free", async () => {
    // Google Calendar DEFAULTS all-day events to Free, so honouring transparency
    // ahead of the all-day flag would quietly un-block every trip and holiday.
    PROPERTY_AVAILABILITY_SLOTS = [...(PROPERTY_AVAILABILITY_SLOTS ?? []), OTHER_DAY_SLOT];
    GOOGLE_BUSY = [
      {
        id: "g-allday-free",
        summary: "Out of town",
        start: `${DAY}T00:00:00`,
        end: `${DAY}T23:59:59`,
        allDay: true,
        transparency: "transparent",
      },
    ];
    const slots = await offeredSlots();
    expect([...slots].some((slot) => slot.startsWith(`${DAY}:`))).toBe(false);
    // The blocked day is gone but a day the manager published elsewhere
    // survives: an all-day block must not blank the whole grid.
    expect(slots.has(OTHER_DAY_SLOT)).toBe(true);
  });

  it("does not block an all-day invite the manager declined", async () => {
    GOOGLE_BUSY = [
      {
        id: "g-allday-declined",
        summary: "Someone else's offsite",
        start: `${DAY}T00:00:00`,
        end: `${DAY}T23:59:59`,
        allDay: true,
        declinedBySelf: true,
      },
    ];
    const slots = await offeredSlots();
    expect([...slots].filter((slot) => slot.startsWith(`${DAY}:`)).length).toBe(4);
    // Exactly the four published slots: there is no implicit default to pad it.
    expect(slots.size).toBe(4);
  });

  it("reads busy time across the ENTIRE range it can offer, not the default horizon", async () => {
    // A manager who paints a week two months out is well past
    // `DEFAULT_TOUR_HORIZON_DAYS`. Bounding the busy read by that constant left
    // their Google-busy morning bookable again past day 21 — the same
    // double-booking defect, merely moved later.
    const twoMonthsOut = new Date(Date.now() + 60 * 24 * 60 * 60 * 1000);
    const pad = (n: number) => String(n).padStart(2, "0");
    const farDay = `${twoMonthsOut.getFullYear()}-${pad(twoMonthsOut.getMonth() + 1)}-${pad(twoMonthsOut.getDate())}`;
    const farSlot = `${farDay}:20`;
    PROPERTY_AVAILABILITY_SLOTS = [farSlot];

    await offeredSlots();
    expect(GOOGLE_TIME_MAX).toHaveLength(1);
    expect(Date.parse(GOOGLE_TIME_MAX[0]!)).toBeGreaterThanOrEqual(slotStartMs(farSlot)! + 30 * 60 * 1000);
  });

  it("subtracts busy time from a published slot well past the default horizon", async () => {
    GOOGLE_BUSY = [
      { id: "g-far", summary: "Busy", start: TEN_AM_START, end: TEN_AM_END },
    ];
    const slots = await offeredSlots();
    expect(slots.has(TEN_AM)).toBe(false);
  });

  it("clamps the busy window so one far-future slotKey cannot stretch it by decades", async () => {
    PROPERTY_AVAILABILITY_SLOTS = [`${DAY}:18`, "9999-01-01:20"];
    await offeredSlots();
    // A year past the default horizon is the ceiling; the malformed-looking
    // far-future key must not turn into a multi-millennium Google query.
    const twoYearsOut = Date.now() + 2 * 365 * 24 * 60 * 60 * 1000;
    expect(Date.parse(GOOGLE_TIME_MAX[0]!)).toBeLessThan(twoYearsOut);
  });

  it("retries a failed busy read within seconds instead of caching the blank for a minute", async () => {
    // A failed read caches an EMPTY busy list, which is fail-OPEN. Holding that
    // for the full success TTL un-subtracts a manager's whole calendar for a
    // minute on the one route whose purpose is preventing a double book.
    GOOGLE_THROWS = true;
    pinNow(PINNED_NOW);
    await offeredSlots();
    expect(GOOGLE_TIME_MAX).toHaveLength(1);

    GOOGLE_THROWS = false;
    GOOGLE_BUSY = [{ id: "g1", summary: "Busy", start: TEN_AM_START, end: TEN_AM_END }];
    pinNow(PINNED_NOW + 6_000);
    const slots = await offeredSlots();
    expect(GOOGLE_TIME_MAX).toHaveLength(2);
    expect(slots.has(TEN_AM)).toBe(false);
  });

  it("does not re-ask Google for a manager who simply has no calendar", async () => {
    // Not-linked is PERMANENT and is the common case, so it keeps the full
    // success TTL. Re-asking every few seconds would turn each request on this
    // public no-store route into a fresh connection read from Supabase.
    GOOGLE_THROWS_NOT_LINKED = true;
    pinNow(PINNED_NOW);
    await offeredSlots();
    expect(GOOGLE_TIME_MAX).toHaveLength(1);

    pinNow(PINNED_NOW + 6_000);
    await offeredSlots();
    expect(GOOGLE_TIME_MAX).toHaveLength(1);
  });

  it("still serves availability when the calendar link is broken", async () => {
    GOOGLE_THROWS = true;
    const slots = await offeredSlots();
    expect([...slots].filter((slot) => slot.startsWith(`${DAY}:`)).length).toBe(4);
    // Exactly the four published slots: there is no implicit default to pad it.
    expect(slots.size).toBe(4);
  });

  it("removes a slot a pending request already holds", async () => {
    PENDING_INQUIRIES = [
      {
        id: "inq-1",
        kind: "tour",
        status: "pending",
        proposedStart: TEN_AM_START,
        proposedEnd: TEN_AM_END,
        slotKey: TEN_AM,
      },
    ];
    const slots = await offeredSlots();
    expect(slots.has(TEN_AM)).toBe(false);
  });

  it("is never edge-cached — a booked slot must not linger at the CDN", async () => {
    const res = await getAvailability(availabilityRequest());
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  it("rate-limits one IP rather than fanning out to Google on every request", async () => {
    // Public, unauthenticated and `no-store`: each request reads Google
    // Calendar once per host manager, and that read can refresh and write back
    // the manager's OAuth token. The per-instance busy cache is not a throttle
    // on a serverless platform, so the request itself has to be capped.
    const ip = "198.51.100.7";
    let limited: Response | null = null;
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const res = await getAvailability(availabilityRequest(ip));
      if (res.status === 429) {
        limited = res;
        break;
      }
      expect(res.status).toBe(200);
    }
    expect(limited).not.toBeNull();
    expect(await limited!.json()).toMatchObject({ error: expect.stringContaining("Too many requests") });
  });
});

describe("a property with no published availability offers nothing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    managerCounter += 1;
    MANAGER = `mgr-${managerCounter}`;
    PROPERTY_AVAILABILITY_SLOTS = null;
    GLOBAL_AVAILABILITY_SLOTS = null;
    PENDING_INQUIRIES = [];
    PLANNED_EVENTS = [];
    GOOGLE_BUSY = [];
    GOOGLE_THROWS = false;
    GOOGLE_THROWS_NOT_LINKED = false;
    GOOGLE_TIME_MAX = [];
    PROPERTY_AVAILABILITY_QUERY_FILTERS = [];
    PROPERTY_STATUS = "live";
    if (vi.isMockFunction(Date.now)) vi.mocked(Date.now).mockRestore();
  });

  it("offers nothing at all — the implicit default was removed", async () => {
    // 09af3348 removed implicit default tour availability. A manager who has
    // published nothing now offers nothing, rather than ~336 half hours nobody
    // opted into. `resolveDefaultTourAvailabilityConfig` reflects this: `enabled`
    // is false unless a caller explicitly turns it on.
    const slots = await offeredSlots();
    expect(slots.size).toBe(0);
  });

  it.each(["draft", "pending", "review", "unlisted", ""])(
    "offers nothing for a %s property — the default is for LIVE listings only",
    async (status) => {
      // The direct-id lookup accepts any status so a manager can resolve their
      // own unpublished record. Before the default grid that meant such a
      // property offered nothing unless availability had been painted by hand;
      // it must not now hand ~336 bookable half hours to anyone with the id.
      PROPERTY_STATUS = status;
      const slots = await offeredSlots();
      expect(slots.size).toBe(0);
    },
  );

  it("never reads Google for a property that is not live", async () => {
    PROPERTY_STATUS = "pending";
    await offeredSlots();
    expect(GOOGLE_TIME_MAX).toHaveLength(0);
  });
});
