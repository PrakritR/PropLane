/**
 * "Application before a tour" at the HTTP edge: the booking route hands the session's email (and
 * only that) to the rule and maps its refusal to a 403 with the message; the page's check route
 * answers from the caller's own session.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const createTourInquiry = vi.fn();
vi.mock("@/lib/tour-inquiry-create.server", () => ({
  createTourInquiry: (...a: unknown[]) => createTourInquiry(...a),
  textValue: (v: unknown) => (typeof v === "string" ? v.trim() : ""),
}));
vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceRoleClient: () => ({}) }));
vi.mock("@/lib/auth/portal-access", () => ({ getPortalAccessContext: vi.fn(), hasRole: vi.fn() }));
vi.mock("@/lib/auth/ensure-signed-in-resident.server", () => ({ ensureSignedInResidentAccount: vi.fn(async () => ({ ok: true })) }));
vi.mock("@/lib/tour-resident-link.server", () => ({ linkTourInquiryToResident: vi.fn(async () => ({ ok: true })) }));
const resolveApplicationBeforeTour = vi.fn();
vi.mock("@/lib/application-before-tour.server", () => ({
  resolveApplicationBeforeTour: (...a: unknown[]) => resolveApplicationBeforeTour(...a),
}));

import { getPortalAccessContext } from "@/lib/auth/portal-access";
import { POST } from "@/app/api/public/partner-inquiries/route";
import { GET } from "@/app/api/public/tour-application-gate/route";

let ipCounter = 1;
const ip = () => `10.9.${Math.floor(ipCounter / 250)}.${(ipCounter++ % 250) + 1}`;

function post(row: Record<string, unknown>) {
  return POST(
    new Request("http://localhost/api/public/partner-inquiries", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-forwarded-for": ip() },
      body: JSON.stringify({ row }),
    }),
  );
}
const get = (propertyId: string) =>
  GET(new Request(`http://localhost/api/public/tour-application-gate?propertyId=${propertyId}`, { headers: { "x-forwarded-for": ip() } }));

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getPortalAccessContext).mockResolvedValue({ user: null, profile: null, roles: [], effectiveRole: null } as never);
});

describe("POST /api/public/partner-inquiries — Application before a tour", () => {
  it("passes no verified email for an anonymous caller, whatever email the body carries", async () => {
    createTourInquiry.mockResolvedValue({ ok: false, reason: "application_required", error: "Apply first." });
    const res = await post({ kind: "tour", propertyId: "prop-1", email: "claimed@example.com" });
    expect(createTourInquiry.mock.calls[0]![1].verifiedApplicantEmail).toBeNull();
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "Apply first." });
  });

  it("passes the SESSION's email for a signed-in caller, not the body's", async () => {
    vi.mocked(getPortalAccessContext).mockResolvedValue({
      user: { id: "user-1", email: "account@example.com" },
      profile: { email: "account@example.com" },
      roles: ["resident"],
      effectiveRole: "resident",
    } as never);
    createTourInquiry.mockResolvedValue({ ok: true, row: { kind: "tour" }, inquiryId: "inq-1" });
    const res = await post({ kind: "tour", propertyId: "prop-1", email: "someone-else@example.com" });
    expect(res.status).toBe(200);
    expect(createTourInquiry.mock.calls[0]![1].verifiedApplicantEmail).toBe("account@example.com");
  });
});

describe("GET /api/public/tour-application-gate", () => {
  it("answers required/hasApplication from the caller's own session", async () => {
    vi.mocked(getPortalAccessContext).mockResolvedValue({
      user: { id: "user-1", email: "Account@Example.com" },
      profile: null,
      roles: ["resident"],
      effectiveRole: "resident",
    } as never);
    resolveApplicationBeforeTour.mockResolvedValue({
      required: true,
      hasApplication: false,
      applicationStatus: "none",
      blocked: "apply_first",
      ownerUserId: "owner-1",
    });
    const res = await get("prop-1");
    expect(await res.json()).toEqual({
      required: true,
      hasApplication: false,
      applicationStatus: "none",
      allowed: false,
      reason: "apply_first",
      signedIn: true,
    });
    expect(resolveApplicationBeforeTour.mock.calls[0]![1]).toEqual({ propertyId: "prop-1", verifiedEmail: "account@example.com" });
  });

  it("reads not required for a workspace that does not ask, and never leaks the owner", async () => {
    resolveApplicationBeforeTour.mockResolvedValue({
      required: false,
      hasApplication: false,
      applicationStatus: "none",
      blocked: null,
      ownerUserId: null,
    });
    const res = await get("prop-1");
    const body = await res.json();
    expect(body).toEqual({
      required: false,
      hasApplication: false,
      applicationStatus: "none",
      allowed: true,
      reason: null,
      signedIn: false,
    });
    expect(resolveApplicationBeforeTour.mock.calls[0]![1]).toEqual({ propertyId: "prop-1", verifiedEmail: null });
  });

  it("needs a property", async () => {
    const res = await GET(new Request("http://localhost/api/public/tour-application-gate", { headers: { "x-forwarded-for": ip() } }));
    expect(res.status).toBe(400);
  });
});
