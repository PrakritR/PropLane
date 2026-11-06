import { beforeEach, describe, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({ user: { id: "resident", email: "same@example.test", user_metadata: { role: "resident" } }, roles: [] as string[], roleError: false, app: { manager_user_id: "manager", resident_email: "same@example.test", row_data: { residentUserId: "resident" } }, managerAccess: vi.fn(async () => false) }));
vi.mock("@/lib/supabase/server", () => ({ createSupabaseServerClient: async () => ({ auth: { getUser: async () => ({ data: { user: m.user } }) } }) }));
vi.mock("@/lib/auth/admin-preview", () => ({ isAdminUser: async () => false }));
vi.mock("@/lib/auth/manager-application-access", () => ({ managerCanAccessApplicationRecord: m.managerAccess }));
vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceRoleClient: () => ({ from: (table: string) => {
  if (table === "manager_application_records") return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: m.app, error: null }) }) }) };
  if (table === "profile_roles") return { select: () => ({ eq: async () => ({ data: m.roles.map(role => ({ role })), error: m.roleError ? { message: "unavailable" } : null }) }) };
  if (table === "cosigner_submission_records") return { select: () => ({ eq: () => ({ order: async () => ({ data: [], error: null }) }) }) };
  throw new Error("Unexpected table");
} }) }));
import { GET } from "@/app/api/cosigner-submissions/route";
const request = () => new Request("http://localhost/api/cosigner-submissions?signerAppId=PROPLANE-APP1");
beforeEach(() => { m.roles = []; m.roleError = false; m.app.row_data.residentUserId = "resident"; m.managerAccess.mockResolvedValue(false); });
describe("co-signer read authority", () => {
  it("rejects metadata-only resident and a reused email on another subject", async () => {
    expect((await GET(request())).status).toBe(403);
    m.roles = ["resident"]; m.app.row_data.residentUserId = "former-subject";
    expect((await GET(request())).status).toBe(403);
  });
  it("permits the exact subject, including a phone-only account", async () => {
    m.roles = ["manager", "resident"]; m.user.email = "phone@phone.proplane.invalid";
    expect((await GET(request())).status).toBe(200);
  });
  it("fails closed on unreadable role rows", async () => {
    m.roles = ["resident"]; m.roleError = true;
    expect((await GET(request())).status).toBe(403);
  });
});
