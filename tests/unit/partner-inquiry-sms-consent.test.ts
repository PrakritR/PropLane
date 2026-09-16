import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Persistence side of the tours-contact SMS opt-in.
 *
 * The public partner-inquiries route must:
 *  - persist `smsConsent` (a strict boolean) + `smsConsentAt` on the inquiry
 *    record so the decision is provable later, and
 *  - record the opt-in into the sms_consent ledger ONLY when the box was
 *    checked and a phone was given — an unchecked box records nothing.
 */

const recordOptIn = vi.fn(async () => undefined);
vi.mock("@/lib/sms-consent", () => ({
  recordOptIn: (...args: unknown[]) => recordOptIn(...(args as [])),
}));

const upsertCalls: unknown[][] = [];
let existingInquiryPayload: Record<string, unknown>[] = [];
function makeDb() {
  const chain: Record<string, unknown> = {
    select: () => chain,
    eq: () => chain,
    or: () => chain,
    limit: () => Promise.resolve({ data: [], error: null }),
    maybeSingle: () => Promise.resolve({
      data: existingInquiryPayload.length > 0 ? { row_data: { payload: existingInquiryPayload } } : null,
      error: null,
    }),
    upsert: (records: unknown) => {
      upsertCalls.push(records as unknown[]);
      return Promise.resolve({ data: null, error: null });
    },
    // Makes `await db.from(...).select(...).eq(...).eq(...)` resolve.
    then: (resolve: (v: { data: unknown[]; error: null }) => unknown) =>
      resolve({ data: [], error: null }),
  };
  return { from: () => chain };
}

vi.mock("@/lib/supabase/service", () => ({
  createSupabaseServiceRoleClient: () => makeDb(),
}));

vi.mock("@/lib/public-tour-booking-guard", () => ({
  managerMayHostPropertyTour: vi.fn(async () => true),
  managerHasPublishedSlot: vi.fn(async () => true),
  adminHasPublishedSlot: vi.fn(async () => true),
}));

vi.mock("@/lib/tour-notification-delivery.server", () => ({
  notifyManagerTourRequest: vi.fn(async () => ({ ok: true })),
  notifyTenantTourRequestReceived: vi.fn(async () => ({ ok: true })),
}));

vi.mock("@/lib/payment-automation-settings", () => ({
  loadManagerAutomationSettings: vi.fn(async () => ({ proposeTourConfirmations: false })),
}));

vi.mock("@/lib/tour-proposal.server", () => ({
  proposeTourConfirmation: vi.fn(async () => undefined),
}));

vi.mock("@/lib/auth/portal-access", () => ({
  getPortalAccessContext: vi.fn(),
  hasRole: vi.fn(),
}));

const ensureSignedInResidentAccount = vi.fn(async () => ({
  ok: true,
  createdResidentRole: false,
  email: "resident@example.com",
}));
vi.mock("@/lib/auth/ensure-signed-in-resident.server", () => ({
  ensureSignedInResidentAccount: (...args: unknown[]) => ensureSignedInResidentAccount(...(args as [])),
}));

const linkTourInquiryToResident = vi.fn(async () => ({ ok: true, linked: true, inquiryId: "inq-1" }));
vi.mock("@/lib/tour-resident-link.server", () => ({
  linkTourInquiryToResident: (...args: unknown[]) => linkTourInquiryToResident(...(args as [])),
}));

import { getPortalAccessContext, hasRole } from "@/lib/auth/portal-access";
import { POST } from "@/app/api/public/partner-inquiries/route";

function makeRow(overrides: Record<string, unknown>) {
  return {
    id: "inq-1",
    name: "Jordan Guest",
    email: "guest@example.com",
    phone: "+12065550100",
    kind: "tour",
    managerUserId: "admin-1",
    propertyId: "maple-house",
    propertyTitle: "Maple House",
    requestedWindows: [
      {
        start: "2026-07-22T18:00:00.000Z",
        end: "2026-07-22T18:30:00.000Z",
        adminUserId: "admin-1",
        slotKey: "2026-07-22:12",
      },
    ],
    proposedStart: "2026-07-22T18:00:00.000Z",
    proposedEnd: "2026-07-22T18:30:00.000Z",
    ...overrides,
  };
}

function postWith(row: Record<string, unknown>) {
  return POST(
    new Request("http://localhost:3100/api/public/partner-inquiries", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-forwarded-for": `10.0.0.${Math.floor(Math.random() * 250) + 1}` },
      body: JSON.stringify({ row }),
    }),
  );
}

function lastPersistedInquiry(): Record<string, unknown> {
  const records = upsertCalls.at(-1) as Record<string, unknown>[];
  const singleton = records.find((r) => r.record_type === "axis_admin_partner_inquiries_v1");
  const rowData = singleton?.row_data as { payload: Record<string, unknown>[] };
  return rowData.payload[0]!;
}

describe("partner-inquiries route SMS consent persistence", () => {
  beforeEach(() => {
    recordOptIn.mockClear();
    upsertCalls.length = 0;
    existingInquiryPayload = [];
    linkTourInquiryToResident.mockClear();
    vi.mocked(getPortalAccessContext).mockResolvedValue({
      user: null,
      profile: null,
      roles: [],
      effectiveRole: null,
    } as never);
    vi.mocked(hasRole).mockReturnValue(false);
  });

  it("persists consent + a server-stamped timestamp and records opt-in when the box is checked", async () => {
    const res = await postWith(makeRow({ smsConsent: true, smsConsentAt: "1999-01-01T00:00:00.000Z" }));
    expect(res.status).toBe(200);

    const persisted = lastPersistedInquiry();
    expect(persisted.smsConsent).toBe(true);
    expect(typeof persisted.smsConsentAt).toBe("string");
    expect(persisted.smsConsentAt).not.toBe("1999-01-01T00:00:00.000Z");
    expect(Number.isNaN(Date.parse(persisted.smsConsentAt as string))).toBe(false);

    expect(recordOptIn).toHaveBeenCalledTimes(1);
    const [, phone, , source] = recordOptIn.mock.calls[0] as [unknown, string, unknown, string];
    expect(phone).toBe("+12065550100");
    expect(source).toBe("tours-contact");
  });

  it("persists smsConsent:false and records NO opt-in when the box is unchecked", async () => {
    const res = await postWith(makeRow({ smsConsent: false }));
    expect(res.status).toBe(200);

    const persisted = lastPersistedInquiry();
    expect(persisted.smsConsent).toBe(false);
    expect(persisted.smsConsentAt).toBeUndefined();

    expect(recordOptIn).not.toHaveBeenCalled();
  });

  it("strips a client-supplied smsConsentAt when consent is withheld", async () => {
    const res = await postWith(makeRow({ smsConsent: false, smsConsentAt: "2026-07-25T00:00:00.000Z" }));
    expect(res.status).toBe(200);

    const persisted = lastPersistedInquiry();
    expect(persisted.smsConsent).toBe(false);
    expect(persisted.smsConsentAt).toBeUndefined();
    expect(recordOptIn).not.toHaveBeenCalled();
  });

  it("treats an absent consent flag as no consent (unchecked)", async () => {
    const res = await postWith(makeRow({}));
    expect(res.status).toBe(200);

    const persisted = lastPersistedInquiry();
    expect(persisted.smsConsent).toBe(false);
    expect(recordOptIn).not.toHaveBeenCalled();
  });

  it("stamps a timestamp when consent is granted without one supplied", async () => {
    const res = await postWith(makeRow({ smsConsent: true }));
    expect(res.status).toBe(200);
    const persisted = lastPersistedInquiry();
    expect(persisted.smsConsent).toBe(true);
    expect(typeof persisted.smsConsentAt).toBe("string");
    expect(Number.isNaN(Date.parse(persisted.smsConsentAt as string))).toBe(false);
  });
});

describe("partner-inquiries route resident tour linking", () => {
  beforeEach(() => {
    recordOptIn.mockClear();
    upsertCalls.length = 0;
    linkTourInquiryToResident.mockClear();
    vi.mocked(getPortalAccessContext).mockResolvedValue({
      user: { id: "res-1", email: "resident@example.com" },
      profile: { email: "resident@example.com" },
      roles: ["resident"],
      effectiveRole: "resident",
    } as never);
    vi.mocked(hasRole).mockImplementation((_ctx, role) => role === "resident");
  });

  it("pins the account email and links the inquiry for a signed-in resident", async () => {
    const res = await postWith(makeRow({ email: "other@example.com" }));
    expect(res.status).toBe(200);

    const persisted = lastPersistedInquiry();
    expect(persisted.email).toBe("resident@example.com");

    expect(ensureSignedInResidentAccount).toHaveBeenCalled();
    expect(linkTourInquiryToResident).toHaveBeenCalledWith(expect.anything(), {
      userId: "res-1",
      inquiryId: "inq-1",
      email: "resident@example.com",
    });
  });

  it("preserves both existing owner inquiries when a signed-in resident books publicly", async () => {
    existingInquiryPayload = [
      { id: "owner-a-inquiry", managerUserId: "owner-a", propertyId: "property-a" },
      { id: "owner-b-inquiry", managerUserId: "owner-b", propertyId: "property-b" },
    ];
    const res = await postWith(makeRow({ email: "other@example.com" }));
    expect(res.status).toBe(200);

    const records = upsertCalls.at(-1) as Record<string, unknown>[];
    const singleton = records.find((record) => record.record_type === "axis_admin_partner_inquiries_v1");
    const payload = (singleton?.row_data as { payload?: Record<string, unknown>[] } | undefined)?.payload ?? [];
    expect(payload.map((row) => row.id)).toEqual(["inq-1", "owner-a-inquiry", "owner-b-inquiry"]);
  });

  it("links tours for signed-in managers who book through a property link", async () => {
    vi.mocked(getPortalAccessContext).mockResolvedValue({
      user: { id: "mgr-1", email: "mgr@example.com" },
      profile: { email: "mgr@example.com" },
      roles: ["manager"],
      effectiveRole: "manager",
    } as never);
    vi.mocked(hasRole).mockReturnValue(false);

    const res = await postWith(makeRow({ email: "other@example.com" }));
    expect(res.status).toBe(200);
    const persisted = lastPersistedInquiry();
    expect(persisted.email).toBe("mgr@example.com");
    expect(ensureSignedInResidentAccount).toHaveBeenCalledWith(expect.anything(), {
      id: "mgr-1",
      email: "mgr@example.com",
    });
    expect(linkTourInquiryToResident).toHaveBeenCalled();
  });
});
