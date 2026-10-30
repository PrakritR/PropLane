import { describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ create: vi.fn(), getUser: vi.fn(async () => ({ data: { user: null } })) }));
vi.mock("@/lib/supabase/server", () => ({ createSupabaseServerClient: async () => ({ auth: { getUser: mocks.getUser } }) }));
vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceRoleClient: mocks.create }));
vi.mock("@/lib/rate-limit", () => ({ rateLimit: async () => ({ ok: true }), clientIpFrom: () => "test" }));
import { POST as confirm } from "@/app/api/auth/confirm-resident-email/route";
import { POST as signup } from "@/app/api/auth/signup/route";
import { POST as resident } from "@/app/api/auth/resident-register/route";
import { POST as tour } from "@/app/api/auth/tour-resident-register/route";
import { POST as manager } from "@/app/api/auth/manager-register/route";
import { POST as activate } from "@/app/api/auth/manager-activate/route";
import { POST as paid } from "@/app/api/auth/manager-signup/route";
const request = (body: unknown) => new Request("http://localhost", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const person = { email: "victim@example.test", password: "attacker-selected", fullName: "Victim", phone: "2065550142" };
describe("email ownership boundary", () => {
  it("rejects unauthenticated arbitrary email confirmation and account creation", async () => {
    mocks.create.mockClear();
    expect((await confirm()).status).toBe(403);
    for (const [handler, body] of [[signup, person], [resident, person], [tour, { ...person, handoff: "message" }], [manager, person], [activate, { ...person, managerId: "manager" }], [paid, { sessionId: "session", password: person.password }]] as const) {
      expect((await handler(request(body))).status).toBe(403);
    }
    expect(mocks.create).not.toHaveBeenCalled();
  });
});
