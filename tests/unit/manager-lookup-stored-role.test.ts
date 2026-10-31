import { beforeEach, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({ caller: true, callerError: false, target: [] as string[], targetError: false }));
vi.mock("@/lib/rate-limit", () => ({ clientIpFrom: () => "test", rateLimit: async () => ({ ok: true }) }));
vi.mock("@/lib/supabase/server", () => ({ createSupabaseServerClient: async () => ({ auth: { getUser: async () => ({ data: { user: { id: "caller", user_metadata: { role: "manager" } } } }) } }) }));
vi.mock("@/lib/property-owner/route-auth.server", () => ({ refuseOwnerOnly: async () => null }));
vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceRoleClient: () => ({ from: (table: string) => {
  let id = "";
  const q = { select: () => q, eq: (key: string, value: string) => { if (key === "user_id") id = value; return q; }, in: () => q, ilike: () => q, limit: () => q,
    maybeSingle: async () => table === "profiles" ? { data: { id: "target", full_name: "Person", manager_id: "AXIS-1", role: "manager" }, error: null } : { data: state.caller ? { role: "manager" } : null, error: state.callerError ? { message: "down" } : null },
    then: (resolve: (value: unknown) => unknown) => Promise.resolve({ data: state.target.map((role) => ({ role })), error: state.targetError ? { message: "down" } : null }).then(resolve),
  }; void id; return q;
} }) }));
import { GET } from "@/app/api/pro/lookup-axis-id/route";
const request = () => new Request("https://example.test?axisId=AXIS-1");
beforeEach(() => { state.caller = true; state.callerError = false; state.target = []; state.targetError = false; });
it("rejects forged caller authority and unreadable caller role", async () => {
  state.caller = false; expect((await GET(request())).status).toBe(403);
  state.caller = true; state.callerError = true; expect((await GET(request())).status).toBe(403);
});
it("requires target stored role despite legacy manager profile", async () => {
  expect((await GET(request())).status).toBe(400);
  state.target = ["manager"]; expect((await GET(request())).status).toBe(200);
  state.targetError = true; expect((await GET(request())).status).toBe(400);
});
