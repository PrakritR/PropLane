/** /api/admin/service-vendors and /api/admin/service-manager: the admin gate runs on every verb, before any read or write. */
import { beforeEach, describe, expect, it, vi } from "vitest";

const OWNER = "11111111-1111-4111-8111-111111111111";
const ADMIN = "22222222-2222-4222-8222-222222222222";
const MANAGER = "44444444-4444-4444-8444-444444444444";

let signedIn: string | null = null;
const calls = vi.hoisted(() => ({ lib: [] as string[] }));

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: async () => ({ auth: { getUser: async () => ({ data: { user: signedIn ? { id: signedIn } : null } }) } }),
}));
vi.mock("@/lib/auth/admin-preview", () => ({ isAdminUser: async (id: string) => id === "22222222-2222-4222-8222-222222222222" }));
vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceRoleClient: () => ({}) }));
vi.mock("@/lib/service/service-vendors.server", () => ({
  listServiceVendors: async () => { calls.lib.push("list"); return { ok: true, configured: true, vendors: [] }; },
  addServiceVendor: async (_db: unknown, admin: string) => { calls.lib.push(`add:${admin}`); return { ok: true, vendor: { id: "svcv-1" }, intro: "sent" }; },
  updateServiceVendor: async (_db: unknown, admin: string, id: string) => { calls.lib.push(`update:${admin}:${id}`); return { ok: true, vendor: { id } }; },
  removeServiceVendor: async (_db: unknown, admin: string, id: string) => { calls.lib.push(`remove:${admin}:${id}`); return { ok: true }; },
}));
vi.mock("@/lib/service/service-manager.server", () => ({
  readServiceManagerView: async () => { calls.lib.push("view"); return { configured: true, phone: null, verified: false, verifiedAt: null }; },
  requestServiceManagerPhoneCode: async () => { calls.lib.push("send-code"); return { ok: true }; },
  verifyServiceManagerPhone: async () => { calls.lib.push("verify"); return { ok: true, view: { configured: true, phone: "+15103098345", verified: true, verifiedAt: "x" } }; },
  clearServiceManagerPhone: async () => { calls.lib.push("clear"); return { ok: true, view: { configured: true, phone: null, verified: false, verifiedAt: null } }; },
}));

const vendors = await import("@/app/api/admin/service-vendors/route");
const manager = await import("@/app/api/admin/service-manager/route");

const req = (method: string, body?: unknown) => new Request("https://prop-lane.space/api/admin/x", { method, body: body === undefined ? undefined : JSON.stringify(body) });

beforeEach(() => {
  calls.lib = [];
  signedIn = ADMIN;
});

const vendorVerbs = () => [
  () => vendors.GET(),
  () => vendors.POST(req("POST", { name: "A", phone: "+12065550101", trades: ["plumber"] })),
  () => vendors.PATCH(req("PATCH", { id: "svcv-1", paused: true })),
  () => vendors.DELETE(req("DELETE", { id: "svcv-1" })),
];
const managerVerbs = () => [
  () => manager.GET(),
  () => manager.POST(req("POST", { action: "send-code", phone: "5103098345" })),
  () => manager.POST(req("POST", { action: "verify", phone: "5103098345", code: "123456" })),
  () => manager.POST(req("POST", { action: "clear" })),
];

describe("the admin gate on the vendor roster and manager phone", () => {
  it("answers 401 signed out on every verb and runs nothing", async () => {
    signedIn = null;
    for (const verb of [...vendorVerbs(), ...managerVerbs()]) expect((await verb()).status).toBe(401);
    expect(calls.lib).toEqual([]);
  });

  it("answers 403 to a signed-in non-admin on every verb and runs nothing", async () => {
    signedIn = MANAGER;
    for (const verb of [...vendorVerbs(), ...managerVerbs()]) expect((await verb()).status).toBe(403);
    signedIn = OWNER;
    for (const verb of [...vendorVerbs(), ...managerVerbs()]) expect((await verb()).status).toBe(403);
    expect(calls.lib).toEqual([]);
  });

  it("an admin reaches the roster layer with their own id, never one from the body", async () => {
    for (const verb of vendorVerbs()) expect((await verb()).status).toBeLessThan(300);
    expect(calls.lib).toEqual(["list", `add:${ADMIN}`, `update:${ADMIN}:svcv-1`, `remove:${ADMIN}:svcv-1`]);
  });

  it("an admin drives the manager phone: view, send a code, verify, clear", async () => {
    for (const verb of managerVerbs()) expect((await verb()).status).toBe(200);
    expect(calls.lib).toEqual(["view", "send-code", "verify", "clear"]);
    expect((await manager.POST(req("POST", { action: "nope" }))).status).toBe(400);
    expect((await vendors.PATCH(req("PATCH", {}))).status).toBe(400);
  });
});
