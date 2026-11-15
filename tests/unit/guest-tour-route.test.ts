import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A renter from Facebook / Zillow / Roomies books a tour with NO account (captain, Nov 14; overrides the Nov 3 sign-in
 * wall). The route re-derives the home, rate-limits per IP and phone, files through the one `createTourInquiry`, and
 * records the prospect on the spine. It never reads an owner or a status from the body.
 */

const createTourInquiry = vi.fn();
vi.mock("@/lib/tour-inquiry-create.server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/tour-inquiry-create.server")>();
  return { ...actual, createTourInquiry: (...args: unknown[]) => createTourInquiry(...(args as [])) };
});

const loadGuestTourListing = vi.fn();
const recordGuestTourProspect = vi.fn(async () => true);
vi.mock("@/lib/tour-guest-prospect.server", () => ({
  loadGuestTourListing: (...args: unknown[]) => loadGuestTourListing(...(args as [])),
  recordGuestTourProspect: (...args: unknown[]) => recordGuestTourProspect(...(args as [])),
}));

const rateLimit = vi.fn(async (..._args: unknown[]) => ({ ok: true }));
vi.mock("@/lib/rate-limit", () => ({
  rateLimit: (...args: unknown[]) => rateLimit(...args),
  clientIpFrom: () => "203.0.113.9",
}));
vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceRoleClient: () => ({}) }));
vi.mock("@/lib/listing-channels/lead-source.server", () => ({ readListingSource: vi.fn(async () => "zillow") }));
vi.mock("@/lib/auth/ensure-signed-in-resident.server", () => ({ ensureSignedInResidentAccount: vi.fn() }));
vi.mock("@/lib/tour-resident-link.server", () => ({ linkTourInquiryToResident: vi.fn() }));
vi.mock("@/lib/auth/portal-access", () => ({ getPortalAccessContext: vi.fn(async () => ({ user: null, profile: null })) }));

import { getPortalAccessContext } from "@/lib/auth/portal-access";
import { POST } from "@/app/api/public/partner-inquiries/route";

const listing = { propertyId: "prop-1", workspaceId: "ws-1", ownerUserId: "owner-1", propertyLabel: "Maple House", roomId: null, roomLabel: null };

function tourRow(overrides: Record<string, unknown> = {}) {
  return {
    kind: "tour",
    name: "Jordan Guest",
    email: "jordan@example.test",
    phone: "(206) 555-0142",
    propertyId: "prop-1",
    propertyTitle: "Maple House",
    managerUserId: "attacker-chosen-owner",
    requestedWindows: [{ start: "2026-11-20T18:00:00.000Z", end: "2026-11-20T18:30:00.000Z", slotKey: "2026-11-20:4" }],
    proposedStart: "2026-11-20T18:00:00.000Z",
    proposedEnd: "2026-11-20T18:30:00.000Z",
    ...overrides,
  };
}

function post(row: Record<string, unknown>) {
  return POST(new Request("http://localhost/api/public/partner-inquiries", { method: "POST", body: JSON.stringify({ row }), headers: { "content-type": "application/json" } }));
}

beforeEach(() => {
  createTourInquiry.mockReset();
  createTourInquiry.mockImplementation(async (_db: unknown, args: { incoming: Record<string, unknown> }) => ({ ok: true, inquiryId: "inq-1", row: { ...args.incoming, id: "inq-1" } }));
  loadGuestTourListing.mockReset();
  loadGuestTourListing.mockResolvedValue(listing);
  recordGuestTourProspect.mockClear();
  rateLimit.mockReset();
  rateLimit.mockResolvedValue({ ok: true });
  vi.mocked(getPortalAccessContext).mockResolvedValue({ user: null, profile: null } as never);
});

describe("guest tour booking (no account)", () => {
  it("files an anonymous tour as a guest instead of refusing with sign_in_required", async () => {
    const res = await post(tourRow());
    expect(res.status).toBe(200);
    const [, args] = createTourInquiry.mock.calls[0] as [unknown, Record<string, unknown>];
    expect(args.guestApplicant).toBe(true);
    // A guest is answered by email and a text, never by a /resident link they cannot open.
    expect(args.noticeChannel).toBe("sms");
    expect(args.verifiedApplicantEmail).toBeNull();
    expect(args.verifiedApplicantUserId).toBeNull();
  });

  it("re-derives the home from the database and never trusts a status from the body", async () => {
    await post(tourRow({ propertyId: " prop-1 ", status: "confirmed", id: "attacker-id" }));
    expect(loadGuestTourListing).toHaveBeenCalledWith({}, "prop-1");
    const [, args] = createTourInquiry.mock.calls[0] as [unknown, { incoming: Record<string, unknown> }];
    expect(args.incoming.propertyId).toBe("prop-1");
    expect(args.incoming.status).toBeUndefined();
    expect(args.incoming.id).toBeUndefined();
  });

  it("refuses a listing that is not live (404) before anything is filed", async () => {
    loadGuestTourListing.mockResolvedValueOnce(null);
    const res = await post(tourRow());
    expect(res.status).toBe(404);
    expect(createTourInquiry).not.toHaveBeenCalled();
  });

  it("validates the phone before touching the database", async () => {
    const res = await post(tourRow({ phone: "12" }));
    expect(res.status).toBe(400);
    expect(loadGuestTourListing).not.toHaveBeenCalled();
    expect(createTourInquiry).not.toHaveBeenCalled();
  });

  it("rate-limits per IP and per phone (429) and files nothing", async () => {
    rateLimit.mockImplementation(async (key: unknown) => ({ ok: !String(key).startsWith("guest-tour-phone:") }));
    const byPhone = await post(tourRow());
    expect(byPhone.status).toBe(429);
    rateLimit.mockImplementation(async (key: unknown) => ({ ok: !String(key).startsWith("guest-tour-ip:") }));
    const byIp = await post(tourRow());
    expect(byIp.status).toBe(429);
    expect(createTourInquiry).not.toHaveBeenCalled();
  });

  it("records the prospect on the spine after the request is filed", async () => {
    await post(tourRow());
    expect(recordGuestTourProspect).toHaveBeenCalledTimes(1);
    const [, input] = recordGuestTourProspect.mock.calls[0] as unknown as [unknown, Record<string, unknown>];
    expect(input.inquiryId).toBe("inq-1");
    expect(input.listing).toEqual(listing);
  });

  it("does not record the prospect when the request was refused (slot taken)", async () => {
    createTourInquiry.mockResolvedValueOnce({ ok: false, reason: "conflict", error: "taken" });
    const res = await post(tourRow());
    expect(res.status).toBe(409);
    expect(recordGuestTourProspect).not.toHaveBeenCalled();
  });

  it("keeps the signed-in path: a session email is the verified applicant and the guest path is skipped", async () => {
    vi.mocked(getPortalAccessContext).mockResolvedValue({ user: { id: "u1", email: "res@example.test", email_confirmed_at: "2026-01-01" }, profile: { email: "res@example.test" } } as never);
    await post(tourRow());
    const [, args] = createTourInquiry.mock.calls[0] as [unknown, Record<string, unknown>];
    expect(args.verifiedApplicantUserId).toBe("u1");
    expect(args.guestApplicant).toBeUndefined();
    expect(loadGuestTourListing).not.toHaveBeenCalled();
  });
});
