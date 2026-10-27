/**
 * Requested-time tours are an open door for a signed-in account, so two ceilings sit behind the time checks: ONE open
 * (pending) request per account email and home, and 5 requests per account per hour. A second request for the same home is
 * a clear 409 the form shows; the rate ceiling is a 429. Runs under a UTC process zone, as production does.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const originalTz = process.env.TZ;

const mocks = vi.hoisted(() => ({ rateLimit: vi.fn(), inquiries: [] as Record<string, unknown>[] }));

vi.mock("@/lib/rate-limit", () => ({ rateLimit: mocks.rateLimit, clientIpFrom: () => "test" }));
vi.mock("@/lib/sms-consent", () => ({ recordOptIn: async () => undefined }));
vi.mock("@/lib/public-tour-booking-guard", () => ({
  adminHasPublishedSlot: async () => true,
  managerHasPublishedSlot: async () => true,
  managerMayHostPropertyTour: async () => true,
}));
vi.mock("@/lib/tour-host-enumeration.server", () => ({ listPropertyTourHostUserIds: async () => ["owner-1"] }));
vi.mock("@/lib/tour-availability.server", () => ({
  listOpenTourSlots: async () => ({ ok: true, slotHosts: {}, resolution: "resolved" }),
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

import { createTourInquiry } from "@/lib/tour-inquiry-create.server";
import { REQUESTED_TOUR_KIND } from "@/lib/tour-request-time";

/** Tue Oct 27 2026, 1:00 PM Pacific. */
const NOW = Date.parse("2026-10-27T20:00:00.000Z");
const THU_4PM = "2026-10-29T23:00:00.000Z";
const ME = "prakrit@example.com";

let upserts: Record<string, unknown>[][];

function fakeDb() {
  const builder = {
    select: () => builder,
    eq: (_col: string, value: unknown) => {
      builder.table = String(value);
      return builder;
    },
    table: "",
    maybeSingle: async () =>
      builder.table === "axis_admin_partner_inquiries_v1"
        ? { data: { row_data: { payload: mocks.inquiries } }, error: null }
        : { data: { manager_user_id: "owner-1" }, error: null },
    then(resolve: (v: unknown) => unknown) {
      return Promise.resolve({ data: [], error: null }).then(resolve);
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

function requested(over: Record<string, unknown> = {}) {
  const end = new Date(Date.parse(THU_4PM) + 30 * 60 * 1000).toISOString();
  return {
    kind: "tour",
    requestKind: REQUESTED_TOUR_KIND,
    name: "Prakrit Ramachandran",
    email: ME,
    phone: "2065550123",
    propertyId: "prop-1",
    propertyTitle: "2412 Clifford St",
    requestedWindows: [{ start: THU_4PM, end }],
    proposedStart: THU_4PM,
    proposedEnd: end,
    ...over,
  };
}

const open = (over: Record<string, unknown> = {}) => ({
  id: "t-old",
  kind: "tour",
  requestKind: REQUESTED_TOUR_KIND,
  status: "pending",
  propertyId: "prop-1",
  email: ME,
  ...over,
});

const create = (incoming: Record<string, unknown>, verified: string | null = ME) =>
  createTourInquiry(fakeDb(), { incoming, verifiedApplicantEmail: verified });

beforeEach(() => {
  process.env.TZ = "UTC";
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  upserts = [];
  mocks.inquiries = [];
  mocks.rateLimit.mockReset();
  mocks.rateLimit.mockResolvedValue({ ok: true });
});

afterEach(() => {
  vi.useRealTimers();
  process.env.TZ = originalTz;
});

describe("one open requested-time tour per account and home", () => {
  it("refuses a second request for the same home while the first is pending, with a clear message", async () => {
    mocks.inquiries = [open()];
    const result = await create(requested());
    expect(result).toEqual({ ok: false, reason: "duplicate_request", error: "You already have a tour request for this home." });
    expect(upserts).toHaveLength(0);
    expect(mocks.rateLimit).not.toHaveBeenCalled();
  });

  it("matches the account email case-insensitively", async () => {
    mocks.inquiries = [open({ email: "Prakrit@Example.com" })];
    expect(await create(requested())).toMatchObject({ ok: false, reason: "duplicate_request" });
  });

  it.each([
    ["another home", { propertyId: "prop-2" }],
    ["another account", { email: "someone@example.com" }],
    ["a request already confirmed", { status: "confirmed" }],
    ["a request already declined", { status: "declined" }],
    ["a published-slot booking", { requestKind: undefined }],
  ])("does not count %s", async (_label, over) => {
    mocks.inquiries = [open(over)];
    expect((await create(requested())).ok).toBe(true);
    expect(upserts).toHaveLength(1);
  });

  it("answers the failed read of the inquiries record closed", async () => {
    const db = {
      from: () => {
        const builder: Record<string, unknown> = {
          select: () => builder,
          eq: () => builder,
          maybeSingle: async () => ({ data: null, error: { message: "boom" } }),
        };
        return builder;
      },
    } as never;
    const result = await createTourInquiry(db, { incoming: requested(), verifiedApplicantEmail: ME });
    expect(result.ok).toBe(false);
  });
});

describe("5 requested-time requests per account per hour", () => {
  it("keys the limiter on the account, 5 per hour", async () => {
    await create(requested());
    expect(mocks.rateLimit).toHaveBeenCalledWith(`tour-requested-time:${ME}`, 5, 60 * 60 * 1000);
  });

  it("refuses the request the limiter denies and files nothing", async () => {
    mocks.rateLimit.mockResolvedValue({ ok: false });
    const result = await create(requested());
    expect(result).toMatchObject({ ok: false, reason: "rate_limited" });
    expect(upserts).toHaveLength(0);
  });

  it("does not limit a published-slot booking", async () => {
    const slot = requested({
      requestKind: undefined,
      managerUserId: "owner-1",
      requestedWindows: [{ start: THU_4PM, end: "2026-10-29T23:30:00.000Z", adminUserId: "owner-1", slotKey: "2026-10-29:32" }],
    });
    expect((await create(slot)).ok).toBe(true);
    expect(mocks.rateLimit).not.toHaveBeenCalled();
  });
});
