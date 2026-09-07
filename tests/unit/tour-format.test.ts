/**
 * A tour is held in person or virtually, and whoever schedules it says which.
 *
 * The value is normalized on the SERVER at every write, so a reader never has
 * to guess: an inquiry filed from the public form, a manually scheduled tour,
 * and the planned event a confirmation mints all carry exactly "in_person" or
 * "virtual". Rows written before the field existed carry nothing and read as
 * in person, which is what every one of them was.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const originalTz = process.env.TZ;

vi.mock("@/lib/sms-consent", () => ({ recordOptIn: async () => undefined }));
vi.mock("@/lib/public-tour-booking-guard", () => ({
  adminHasPublishedSlot: async () => true,
  managerHasPublishedSlot: async () => true,
  managerMayHostPropertyTour: async () => true,
}));
vi.mock("@/lib/tour-notification-delivery.server", () => ({
  notifyManagerTourRequest: async () => undefined,
  notifyTenantTourRequestReceived: async () => undefined,
}));
vi.mock("@/lib/payment-automation-settings", () => ({
  loadManagerAutomationSettings: async () => ({ proposeTourConfirmations: false }),
}));
vi.mock("@/lib/tour-proposal.server", () => ({ proposeTourConfirmation: async () => undefined }));
vi.mock("@/lib/manager-default-tasks.server", () => ({ createApproveTourRequestTask: async () => undefined }));
vi.mock("@/lib/google-calendar/sync.server", () => ({ syncPlannedTourToGoogleCalendar: async () => undefined }));
vi.mock("@/lib/manager-property-share-access", () => ({
  getShareablePropertyForUser: async () => ({ address: "1 Main St, Seattle", buildingName: "Lakeview", title: "Lakeview" }),
}));
vi.mock("@/lib/auth/admin-preview", () => ({ isAdminUser: async () => false }));
vi.mock("@/lib/co-manager-calendar", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/co-manager-calendar")>()),
  listPropertyCalendarPeers: () => [],
  tourInquiryVisibleToViewer: () => true,
  plannedTourVisibleToViewer: () => true,
}));
vi.mock("@/lib/demo-admin-scheduling", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/demo-admin-scheduling")>()),
  readPartnerInquiries: () => [
    {
      id: "inq-1",
      kind: "tour",
      name: "Virtual Guest",
      email: "v@example.com",
      phone: "2065550123",
      notes: "",
      managerUserId: "mgr-1",
      propertyId: "p-1",
      propertyTitle: "Lakeview",
      tourFormat: "virtual",
      requestedWindows: [{ start: "2999-01-01T18:00:00.000Z", end: "2999-01-01T18:30:00.000Z", adminUserId: "mgr-1" }],
      proposedStart: "2999-01-01T18:00:00.000Z",
      proposedEnd: "2999-01-01T18:30:00.000Z",
      status: "pending",
      createdAt: "2026-09-07T00:00:00.000Z",
    },
  ],
  readAllPlannedEvents: () => [
    {
      id: "ev-1",
      title: "Tour · Legacy",
      kind: "tour",
      managerUserId: "mgr-1",
      propertyId: "p-1",
      propertyTitle: "Lakeview",
      attendeeName: "Legacy Guest",
      start: "2999-01-02T18:00:00.000Z",
      end: "2999-01-02T18:30:00.000Z",
    },
  ],
}));

import {
  DEFAULT_TOUR_FORMAT,
  TOUR_FORMAT_OPTIONS,
  isVirtualTour,
  normalizeTourFormat,
  tourFormatDescription,
  tourFormatLabel,
} from "@/lib/tour-format";
import { createTourInquiry } from "@/lib/tour-inquiry-create.server";
import { createManualPlannedTour } from "@/lib/manual-planned-tour.server";
import { buildManagerTourRows } from "@/lib/manager-tour-list";
import {
  buildTourConfirmedTenantBody,
  buildTourNotificationContext,
  buildTourRequestManagerBody,
  buildTourRequestTenantBody,
} from "@/lib/tour-notifications";

const SLOT_KEY = "2026-09-07:18";
const SLOT_START_ISO = "2026-09-07T16:00:00.000Z";
const SLOT_END_ISO = "2026-09-07T16:30:00.000Z";

let upserts: Record<string, unknown>[];

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
      upsert: async (records: Record<string, unknown> | Record<string, unknown>[]) => {
        upserts.push(...(Array.isArray(records) ? records : [records]));
        return { error: null };
      },
    }),
  } as never;
}

function tourRequest(over: Record<string, unknown> = {}) {
  return {
    kind: "tour",
    name: "Prospect",
    email: "guest@example.com",
    phone: "2065550123",
    managerUserId: "mgr-1",
    propertyId: "mgr-demo-lakeview",
    requestedWindows: [{ start: SLOT_START_ISO, end: SLOT_END_ISO, adminUserId: "mgr-1", slotKey: SLOT_KEY }],
    proposedStart: SLOT_START_ISO,
    proposedEnd: SLOT_END_ISO,
    ...over,
  };
}

beforeEach(() => {
  process.env.TZ = "UTC";
  upserts = [];
});

afterEach(() => {
  process.env.TZ = originalTz;
});

describe("normalizeTourFormat", () => {
  it("accepts the two formats and nothing else", () => {
    expect(normalizeTourFormat("virtual")).toBe("virtual");
    expect(normalizeTourFormat("in_person")).toBe("in_person");
    expect(normalizeTourFormat(" Virtual ")).toBe("virtual");
    expect(normalizeTourFormat("in-person")).toBe("in_person");
    expect(normalizeTourFormat("hybrid")).toBe("in_person");
    expect(normalizeTourFormat(undefined)).toBe("in_person");
    expect(normalizeTourFormat(null)).toBe("in_person");
    expect(normalizeTourFormat(42)).toBe("in_person");
    expect(DEFAULT_TOUR_FORMAT).toBe("in_person");
  });

  it("labels both formats and offers exactly those two options", () => {
    expect(TOUR_FORMAT_OPTIONS.map((o) => o.value)).toEqual(["in_person", "virtual"]);
    expect(tourFormatLabel("virtual")).toBe("Virtual");
    expect(tourFormatLabel(undefined)).toBe("In person");
    expect(isVirtualTour("virtual")).toBe(true);
    expect(isVirtualTour("")).toBe(false);
    expect(tourFormatDescription("virtual")).toMatch(/virtual/i);
    expect(tourFormatDescription("in_person")).toMatch(/in-person/i);
  });
});

describe("createTourInquiry stores a normalized tour format", () => {
  it("keeps a virtual request virtual", async () => {
    const result = await createTourInquiry(fakeDb(), { incoming: tourRequest({ tourFormat: "virtual" }) });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.row.tourFormat).toBe("virtual");
  });

  it("defaults an older client that sends nothing to in person", async () => {
    const result = await createTourInquiry(fakeDb(), { incoming: tourRequest() });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.row.tourFormat).toBe("in_person");
  });

  it("never stores a value outside the two formats", async () => {
    const result = await createTourInquiry(fakeDb(), { incoming: tourRequest({ tourFormat: "<script>" }) });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.row.tourFormat).toBe("in_person");
  });
});

describe("createManualPlannedTour stores a normalized tour format", () => {
  const base = {
    propertyId: "mgr-demo-lakeview",
    guestName: "Guest",
    start: "2026-09-08T17:00:00.000Z",
    end: "2026-09-08T18:00:00.000Z",
  };

  it("writes the manager's virtual choice onto the planned event", async () => {
    const result = await createManualPlannedTour(fakeDb(), "mgr-1", { ...base, tourFormat: "virtual" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plannedEvent.tourFormat).toBe("virtual");
    const stored = upserts.find((r) => r.record_type === "axis_admin_planned_events_v1");
    const payload = (stored?.row_data as { payload: Record<string, unknown>[] }).payload;
    expect(payload.at(-1)?.tourFormat).toBe("virtual");
  });

  it("defaults to in person when the format is omitted", async () => {
    const result = await createManualPlannedTour(fakeDb(), "mgr-1", base);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plannedEvent.tourFormat).toBe("in_person");
  });
});

describe("manager Tours rows carry the format", () => {
  it("reads virtual from a pending inquiry and in person from a legacy planned event", () => {
    const rows = buildManagerTourRows({ viewerUserId: "mgr-1", propertyIds: ["p-1"] });
    const byGuest = Object.fromEntries(rows.map((r) => [r.guestName, r.tourFormat]));
    expect(byGuest["Virtual Guest"]).toBe("virtual");
    expect(byGuest["Legacy Guest"]).toBe("in_person");
  });
});

describe("tour notifications say how the tour is held", () => {
  const ctx = (tourFormat?: string) =>
    buildTourNotificationContext({
      origin: "https://example.com",
      guestName: "Alex",
      guestEmail: "alex@example.com",
      propertyId: "p-1",
      propertyTitle: "Lakeview",
      tourStartIso: SLOT_START_ISO,
      tourEndIso: SLOT_END_ISO,
      tourFormat,
    });

  it("tells the manager and the guest a virtual tour is virtual", () => {
    expect(buildTourRequestManagerBody(ctx("virtual"))).toContain("Format: Virtual tour");
    expect(buildTourRequestTenantBody(ctx("virtual"))).toContain("Format: Virtual tour");
    expect(buildTourConfirmedTenantBody(ctx("virtual"))).toContain("Format: Virtual tour");
  });

  it("says in person when nothing was chosen", () => {
    expect(ctx(undefined).tourFormat).toBe("in_person");
    expect(buildTourConfirmedTenantBody(ctx(undefined))).toContain("Format: In-person tour");
  });
});
