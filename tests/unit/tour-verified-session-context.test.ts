import { beforeEach, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  user: { id: "resident", email: "r@example.test", email_confirmed_at: "2026-01-01T00:00:00Z" as string | null, __viewAs: null as unknown },
  profileEmail: "r@example.test",
  decision: vi.fn(async () => ({ required: false, hasApplication: false, applicationStatus: null, blocked: null })),
  create: vi.fn(async () => ({ ok: true, row: { kind: "tour" }, inquiryId: "inquiry" })),
}));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => undefined }), headers: async () => ({ get: () => null }) }));
vi.mock("next/navigation", () => ({ redirect: () => { throw new Error("unexpected redirect"); } }));
vi.mock("@/lib/auth/phone-auth.server", () => ({ needsPhoneVerification: async () => false }));
vi.mock("@/lib/rate-limit", () => ({ clientIpFrom: () => "test", rateLimit: async () => ({ ok: true }) }));
vi.mock("@/lib/application-before-tour.server", () => ({ resolveApplicationBeforeTour: state.decision }));
vi.mock("@/lib/tour-inquiry-create.server", () => ({ createTourInquiry: state.create, textValue: (value: unknown) => typeof value === "string" ? value : "" }));
vi.mock("@/lib/listing-channels/lead-source.server", () => ({ readListingSource: async () => null }));
vi.mock("@/lib/auth/ensure-signed-in-resident.server", () => ({ ensureSignedInResidentAccount: async () => undefined }));
vi.mock("@/lib/tour-resident-link.server", () => ({ linkTourInquiryToResident: async () => undefined }));
vi.mock("@/lib/supabase/server", () => ({ createSupabaseServerClient: async () => ({
  auth: { getUser: async () => ({ data: { user: state.user }, error: null }) },
  from: (table: string) => ({ select: () => ({ eq: () => table === "profiles"
    ? { maybeSingle: async () => ({ data: { id: state.user.id, email: state.profileEmail, role: "resident" }, error: null }) }
    : Promise.resolve({ data: [{ role: "resident" }], error: null }) }) }),
}) }));
vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceRoleClient: () => ({ from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { id: state.user.id, email: state.profileEmail, role: "resident" }, error: null }) }) }) }) }) }));

import { GET } from "@/app/api/public/tour-application-gate/route";
import { POST } from "@/app/api/public/partner-inquiries/route";

beforeEach(() => {
  state.user = { id: "resident", email: "r@example.test", email_confirmed_at: "2026-01-01T00:00:00Z", __viewAs: null };
  state.profileEmail = "r@example.test";
  state.decision.mockClear();
  state.create.mockClear();
});

it("allows a verified session to reach tour creation with the authoritative mailbox", async () => {
  const response = await POST(new Request("http://localhost/api/public/partner-inquiries", { method: "POST", body: JSON.stringify({ row: { kind: "tour", email: "forged@example.test" } }) }));
  expect(response.status).toBe(200);
  expect(state.create).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ incoming: expect.objectContaining({ email: "r@example.test" }), verifiedApplicantEmail: "r@example.test", verifiedApplicantUserId: "resident" }));
});

it.each(["unconfirmed", "mismatch", "view-as"])("refuses a %s tour before creation", async (kind) => {
  if (kind === "unconfirmed") state.user.email_confirmed_at = null;
  if (kind === "mismatch") state.profileEmail = "other@example.test";
  if (kind === "view-as") state.user.__viewAs = { portal: "resident", target: { roles: ["resident"] } };
  const response = await POST(new Request("http://localhost/api/public/partner-inquiries", { method: "POST", body: JSON.stringify({ row: { kind: "tour", email: "r@example.test" } }) }));
  expect(response.status).toBe(401);
  expect(state.create).not.toHaveBeenCalled();
});

it("passes the authoritative verified Auth email through the real portal context to the tour gate", async () => {
  expect((await GET(new Request("http://localhost/api/public/tour-application-gate?propertyId=house"))).status).toBe(200);
  expect(state.decision).toHaveBeenCalledWith(expect.anything(), { propertyId: "house", verifiedEmail: "r@example.test" });
});

it.each(["unconfirmed", "missing", "mismatch", "view-as"])("does not prove a %s mailbox", async (kind) => {
  if (kind === "unconfirmed") state.user.email_confirmed_at = null;
  if (kind === "missing") state.user.email = "";
  if (kind === "mismatch") state.profileEmail = "other@example.test";
  if (kind === "view-as") state.user.__viewAs = { portal: "resident", target: { roles: ["resident"] } };
  expect((await GET(new Request("http://localhost/api/public/tour-application-gate?propertyId=house"))).status).toBe(200);
  expect(state.decision).toHaveBeenCalledWith(expect.anything(), { propertyId: "house", verifiedEmail: null });
});
