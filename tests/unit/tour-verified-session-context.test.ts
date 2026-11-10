import { beforeEach, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  user: { id: "resident", email: "r@example.test", email_confirmed_at: "2026-01-01T00:00:00Z" as string | null, __viewAs: null as unknown },
  profileEmail: "r@example.test",
  create: vi.fn(async () => ({ ok: true, row: { kind: "tour" }, inquiryId: "inquiry" })),
  ensure: vi.fn(async () => ({ ok: true })),
  link: vi.fn(async () => undefined),
}));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => undefined }), headers: async () => ({ get: () => null }) }));
vi.mock("next/navigation", () => ({ redirect: () => { throw new Error("unexpected redirect"); } }));
vi.mock("@/lib/auth/phone-auth.server", () => ({ needsPhoneVerification: async () => false }));
vi.mock("@/lib/rate-limit", () => ({ clientIpFrom: () => "test", rateLimit: async () => ({ ok: true }) }));
vi.mock("@/lib/tour-inquiry-create.server", () => ({ createTourInquiry: state.create, textValue: (value: unknown) => typeof value === "string" ? value : "" }));
vi.mock("@/lib/listing-channels/lead-source.server", () => ({ readListingSource: async () => null }));
vi.mock("@/lib/auth/ensure-signed-in-resident.server", () => ({ ensureSignedInResidentAccount: state.ensure }));
vi.mock("@/lib/tour-resident-link.server", () => ({ linkTourInquiryToResident: state.link }));
vi.mock("@/lib/supabase/server", () => ({ createSupabaseServerClient: async () => ({
  auth: { getUser: async () => ({ data: { user: state.user }, error: null }) },
  from: (table: string) => ({ select: () => ({ eq: () => table === "profiles"
    ? { maybeSingle: async () => ({ data: { id: state.user.id, email: state.profileEmail, role: "resident" }, error: null }) }
    : Promise.resolve({ data: [{ role: "resident" }], error: null }) }) }),
}) }));
vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceRoleClient: () => ({ from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { id: state.user.id, email: state.profileEmail, role: "resident" }, error: null }) }) }) }) }) }));

import { POST } from "@/app/api/public/partner-inquiries/route";

beforeEach(() => {
  state.user = { id: "resident", email: "r@example.test", email_confirmed_at: "2026-01-01T00:00:00Z", __viewAs: null };
  state.profileEmail = "r@example.test";
  state.create.mockClear();
  state.ensure.mockClear();
  state.link.mockClear();
});

it("allows a verified session to reach tour creation with the authoritative mailbox", async () => {
  const response = await POST(new Request("http://localhost/api/public/partner-inquiries", { method: "POST", body: JSON.stringify({ row: { kind: "tour", email: "forged@example.test" } }) }));
  expect(response.status).toBe(200);
  expect(state.create).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ incoming: expect.objectContaining({ email: "r@example.test" }), verifiedApplicantEmail: "r@example.test", verifiedApplicantUserId: "resident" }));
  const args = (state.create.mock.calls as unknown as unknown[][])[0]![1] as { beforeTourNotifications: (created: { row: Record<string, unknown>; inquiryId: string }) => Promise<void> };
  await args.beforeTourNotifications({ row: { kind: "tour" }, inquiryId: "exact-inquiry" });
  expect(state.ensure).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ id: "resident" }));
  expect(state.link).toHaveBeenCalledWith(expect.anything(), { userId: "resident", inquiryId: "exact-inquiry", email: "r@example.test" });
});

it("does not link when ensuring resident access fails", async () => {
  state.ensure.mockResolvedValueOnce({ ok: false });
  const response = await POST(new Request("http://localhost/api/public/partner-inquiries", { method: "POST", body: JSON.stringify({ row: { kind: "tour" } }) }));
  expect(response.status).toBe(200);
  const args = (state.create.mock.calls as unknown as unknown[][])[0]![1] as { beforeTourNotifications: (created: { row: Record<string, unknown>; inquiryId: string }) => Promise<void> };
  await args.beforeTourNotifications({ row: { kind: "tour" }, inquiryId: "exact-inquiry" });
  expect(state.link).not.toHaveBeenCalled();
});

it.each(["unconfirmed", "missing", "mismatch", "view-as"])("refuses a %s tour before creation", async (kind) => {
  if (kind === "unconfirmed") state.user.email_confirmed_at = null;
  if (kind === "missing") state.user.email = "";
  if (kind === "mismatch") state.profileEmail = "other@example.test";
  if (kind === "view-as") state.user.__viewAs = { portal: "resident", target: { roles: ["resident"] } };
  const response = await POST(new Request("http://localhost/api/public/partner-inquiries", { method: "POST", body: JSON.stringify({ row: { kind: "tour", email: "r@example.test" } }) }));
  expect(response.status).toBe(401);
  expect(state.create).not.toHaveBeenCalled();
});
