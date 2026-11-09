import { beforeEach, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  user: { id: "resident", email: "r@example.test", email_confirmed_at: "2026-01-01T00:00:00Z" as string | null, __viewAs: null as unknown },
  profileEmail: "r@example.test",
  decision: vi.fn(async () => ({ required: false, hasApplication: false, applicationStatus: null, blocked: null })),
}));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => undefined }), headers: async () => ({ get: () => null }) }));
vi.mock("next/navigation", () => ({ redirect: () => { throw new Error("unexpected redirect"); } }));
vi.mock("@/lib/auth/phone-auth.server", () => ({ needsPhoneVerification: async () => false }));
vi.mock("@/lib/rate-limit", () => ({ clientIpFrom: () => "test", rateLimit: async () => ({ ok: true }) }));
vi.mock("@/lib/application-before-tour.server", () => ({ resolveApplicationBeforeTour: state.decision }));
vi.mock("@/lib/supabase/server", () => ({ createSupabaseServerClient: async () => ({
  auth: { getUser: async () => ({ data: { user: state.user }, error: null }) },
  from: (table: string) => ({ select: () => ({ eq: () => table === "profiles"
    ? { maybeSingle: async () => ({ data: { id: state.user.id, email: state.profileEmail, role: "resident" }, error: null }) }
    : Promise.resolve({ data: [{ role: "resident" }], error: null }) }) }),
}) }));
vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceRoleClient: () => ({ from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { id: state.user.id, email: state.profileEmail, role: "resident" }, error: null }) }) }) }) }) }));

import { GET } from "@/app/api/public/tour-application-gate/route";

beforeEach(() => {
  state.user = { id: "resident", email: "r@example.test", email_confirmed_at: "2026-01-01T00:00:00Z", __viewAs: null };
  state.profileEmail = "r@example.test";
  state.decision.mockClear();
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
