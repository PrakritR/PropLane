import { describe, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({ recovery: vi.fn(), roles: vi.fn(), inbox: vi.fn() }));
vi.mock("@/lib/auth/account-recovery.server", () => ({ pendingAccountRecovery: m.recovery }));
vi.mock("@/lib/auth/profile-role-row", () => ({ ensureProfileRoleRow: m.roles }));
vi.mock("@/lib/tour-resident-link.server", () => ({ attachInboxThreadsToResident: m.inbox }));
import { provisionVerifiedResidentHandoff } from "@/lib/auth/verified-resident-handoff.server";
describe("verified resident handoff", () => {
  it("never overwrites existing profile fields or copies stale approval", async () => {
    m.recovery.mockResolvedValue(null);
    const upsert = vi.fn().mockResolvedValue({ error: null });
    const chain = { eq: vi.fn().mockReturnThis(), is: vi.fn().mockReturnThis(), then: (resolve: (value: unknown) => void) => resolve({ error: null }) };
    const is = chain.is;
    const update = vi.fn().mockReturnValue(chain);
    const db = { auth: { admin: { getUserById: async () => ({ data: { user: { email: "owner@example.com", email_confirmed_at: "2026-01-01" } }, error: null }) } }, from: (table: string) => table === "profiles" ? { upsert, update } : { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { resident_email: "owner@example.com", row_data: { bucket: "approved", name: "Applicant", application: { phone: "+12065550100" } } }, error: null }) }) }) } };
    expect(await provisionVerifiedResidentHandoff(db as never, { userId: "user", email: "owner@example.com", applicationId: "app" })).toBe(true);
    expect(upsert).toHaveBeenCalledWith(expect.objectContaining({ application_approved: false, full_name: "Applicant", phone: "+12065550100" }), { onConflict: "id", ignoreDuplicates: true });
    expect(update).toHaveBeenCalledWith({ manager_id: "app" });
    expect(update).toHaveBeenCalledTimes(1);
    expect(chain.eq).toHaveBeenCalledWith("role", "resident");
    expect(is).toHaveBeenCalledWith("manager_id", null);
  });
});
