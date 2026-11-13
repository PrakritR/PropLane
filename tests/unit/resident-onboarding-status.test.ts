import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const permission = vi.fn(async () => false);
vi.mock("@/lib/auth/manager-lease-scope", () => ({ managerHasCoManagerPermissionForProperty: (...a: unknown[]) => permission(...(a as [])) }));

import { deriveOnboardingProgress } from "@/lib/resident-onboarding-link/status";
import { loadOnboardingStatus } from "@/lib/resident-onboarding-link/status.server";

const done = (p: ReturnType<typeof deriveOnboardingProgress>) => p.steps.filter((s) => s.done).map((s) => s.id);

describe("onboarding progress", () => {
  it("nothing sent yet: nothing done", () => {
    expect(done(deriveOnboardingProgress({}))).toEqual([]);
  });

  it("link sent by email only, then by text, then opened, account, lease, payment", () => {
    expect(done(deriveOnboardingProgress({ emailSentAt: "2026-11-12T10:00:00Z" }))).toEqual(["sent"]);
    expect(done(deriveOnboardingProgress({ textLink: { createdAt: "2026-11-12T10:00:00Z", openCount: 0, usedAt: null } }))).toEqual(["sent"]);
    expect(done(deriveOnboardingProgress({ textLink: { createdAt: "2026-11-12T10:00:00Z", openCount: 2, usedAt: null } }))).toEqual(["sent", "opened"]);
    expect(done(deriveOnboardingProgress({ textLink: { createdAt: "2026-11-12T10:00:00Z", openCount: 1, usedAt: "2026-11-12T11:00:00Z" } }))).toEqual(["sent", "opened", "account"]);
    expect(done(deriveOnboardingProgress({ emailSentAt: "2026-11-12T10:00:00Z", residentUserId: "u1", leaseSignedAt: "2026-11-13T10:00:00Z", residentPaidAts: ["2026-11-14T10:00:00Z", "2026-11-20T10:00:00Z"] }))).toEqual(["sent", "opened", "account", "lease", "payment"]);
  });

  it("the first payment is the earliest one", () => {
    const p = deriveOnboardingProgress({ residentPaidAts: ["2026-12-01T00:00:00Z", "2026-11-14T00:00:00Z", null] });
    expect(p.steps.find((s) => s.id === "payment")?.at).toBe("2026-11-14T00:00:00Z");
  });
});

type Table = Record<string, unknown>;
function fakeDb(tables: Record<string, Table | null>) {
  const builder = (name: string) => {
    const result = { data: tables[name] ?? null, error: null as null };
    const chain: Record<string, unknown> = {};
    for (const m of ["select", "in", "eq", "ilike", "order", "limit"]) chain[m] = () => chain;
    chain.maybeSingle = async () => result;
    chain.then = (resolve: (v: unknown) => unknown) => resolve({ data: Array.isArray(tables[name]) ? tables[name] : [], error: null });
    return chain;
  };
  return { from: (name: string) => builder(name) } as never;
}

const app = (manager: string) => ({
  id: "PROPLANE-AB12CD34",
  resident_email: "j@example.com",
  manager_user_id: manager,
  row_data: { name: "Jordan", assignedPropertyId: "prop-1", manualResidentDetails: { phone: "+12065550101", onboardingWelcomeSentAt: "2026-11-12T10:00:00Z" }, residentUserId: "u1" },
});

describe("onboarding status is read in the caller's own scope", () => {
  it("the record's owner reads it", async () => {
    const r = await loadOnboardingStatus(fakeDb({ manager_application_records: app("mgr-1"), phone_bound_links: null, portal_lease_pipeline_records: null }), { userId: "mgr-1", applicationId: "PROPLANE-AB12CD34" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.progress.steps.filter((s) => s.done).map((s) => s.id)).toEqual(["sent", "opened", "account"]);
  });

  it("another manager with no Residents grant on the house gets 'not found', never the record", async () => {
    permission.mockResolvedValueOnce(false);
    const r = await loadOnboardingStatus(fakeDb({ manager_application_records: app("mgr-1") }), { userId: "mgr-2", applicationId: "PROPLANE-AB12CD34" });
    expect(r).toEqual({ ok: false, reason: "not_found" });
  });

  it("a co-manager with Residents on the house may read it", async () => {
    permission.mockResolvedValueOnce(true);
    const r = await loadOnboardingStatus(fakeDb({ manager_application_records: app("mgr-1"), phone_bound_links: null, portal_lease_pipeline_records: null }), { userId: "mgr-2", applicationId: "PROPLANE-AB12CD34" });
    expect(r.ok).toBe(true);
  });

  it("an unknown id is not found", async () => {
    const r = await loadOnboardingStatus(fakeDb({ manager_application_records: null }), { userId: "mgr-1", applicationId: "PROPLANE-NOPE" });
    expect(r).toEqual({ ok: false, reason: "not_found" });
  });
});
