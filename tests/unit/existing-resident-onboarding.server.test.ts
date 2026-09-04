import { describe, expect, it, vi, beforeEach } from "vitest";
import type { DemoApplicantRow } from "@/data/demo-portal";

const { deliverExistingResidentWelcome } = vi.hoisted(() => ({
  deliverExistingResidentWelcome: vi.fn(),
}));

vi.mock("@/lib/resident-welcome.server", () => ({
  deliverExistingResidentWelcome,
  RESIDENT_WELCOME_EMAIL_RE: /^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)+$/,
}));

import { runExistingResidentOnboarding } from "@/lib/existing-resident-onboarding.server";

/** `existingLease` is what the lease row already stored under this id, if any. */
function mockDb(existingLease: { id: string; manager_user_id: string | null } | null = null) {
  const upsert = vi.fn().mockResolvedValue({ error: null });
  /** Every `(column, value)` pair the application update was filtered on. */
  const updateFilters: Array<[string, unknown]> = [];
  return {
    from: vi.fn(() => ({
      upsert,
      select: vi.fn(() => ({
        eq: vi.fn(() => ({
          maybeSingle: vi.fn().mockResolvedValue({ data: existingLease, error: null }),
        })),
      })),
      update: vi.fn(() => {
        const builder: Record<string, unknown> = {
          eq: vi.fn((column: string, value: unknown) => {
            updateFilters.push([column, value]);
            return builder;
          }),
          then: (resolve: (v: unknown) => unknown) => Promise.resolve({ error: null }).then(resolve),
        };
        return builder;
      }),
    })),
    _upsert: upsert,
    _updateFilters: updateFilters,
  };
}

describe("runExistingResidentOnboarding", () => {
  beforeEach(() => {
    deliverExistingResidentWelcome.mockReset();
    deliverExistingResidentWelcome.mockResolvedValue({ ok: true, id: "email-1", skipped: false });
  });

  it("creates manager-review lease without welcome when no off-platform PDF is attached", async () => {
    const db = mockDb();
    const row: DemoApplicantRow = {
      id: "PROPLANE-TEST01",
      name: "Jane Smith",
      email: "jane.onboard@test.proplane.local",
      property: "Ballard House",
      stage: "Active",
      bucket: "approved",
      detail: "",
      manuallyAdded: true,
      manualResidentDetails: {
        monthlyUtilities: 175,
        securityDeposit: 875,
      },
    };

    const result = await runExistingResidentOnboarding(
      db as never,
      { userId: "mgr-1", email: "manager@test.proplane.local", managerName: "Alex Manager" },
      row,
      { sendWelcomeEmail: false },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(db._upsert).toHaveBeenCalled();
    const upsertPayload = db._upsert.mock.calls[0]?.[0] as { row_data?: { bucket?: string; externallySignedLease?: boolean } };
    expect(upsertPayload.row_data?.bucket).toBe("manager");
    expect(upsertPayload.row_data?.externallySignedLease).not.toBe(true);
  });

  it("creates fully signed lease when an off-platform PDF is attached", async () => {
    const db = mockDb();
    const row: DemoApplicantRow = {
      id: "PROPLANE-TEST02",
      name: "Jane Smith",
      email: "jane.onboard@test.proplane.local",
      property: "Ballard House",
      stage: "Active",
      bucket: "approved",
      detail: "",
      manuallyAdded: true,
      manualResidentDetails: {
        signedLeaseDataUrl: "data:application/pdf;base64,abc",
        signedLeaseFileName: "lease.pdf",
      },
    };

    const result = await runExistingResidentOnboarding(
      db as never,
      { userId: "mgr-1", email: "manager@test.proplane.local", managerName: "Alex Manager" },
      row,
      { sendWelcomeEmail: true },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.leaseId).toBe("lease_app_PROPLANE-TEST02");
    expect(result.welcomeEmailSent).toBe(true);
    expect(db._upsert).toHaveBeenCalled();
    expect(deliverExistingResidentWelcome).toHaveBeenCalled();
    const upsertPayload = db._upsert.mock.calls[0]?.[0] as { row_data?: { bucket?: string } };
    expect(upsertPayload.row_data?.bucket).toBe("signed");
    const welcomeArgs = deliverExistingResidentWelcome.mock.calls[0]?.[2] as { axisId?: string };
    expect(welcomeArgs?.axisId).toBe("PROPLANE-TEST02");
  });

  it("refuses to upsert onto a lease record another manager owns", async () => {
    // `leaseId` is derived from the application axis id, the same id space real
    // approved-application leases use, and the route falls back to a
    // client-supplied `row`. Without this check a colliding id would replace
    // another manager's executed lease and re-parent it to the caller.
    const db = mockDb({ id: "lease_app_PROPLANE-TEST01", manager_user_id: "mgr-victim" });

    const result = await runExistingResidentOnboarding(
      db as never,
      { userId: "mgr-attacker", email: "attacker@test.proplane.local", managerName: "Mal" },
      {
        id: "PROPLANE-TEST01",
        name: "Jane Smith",
        email: "jane.onboard@test.proplane.local",
        property: "Ballard House",
        stage: "Active",
        bucket: "approved",
        detail: "",
        manuallyAdded: true,
      },
      { sendWelcomeEmail: false },
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(409);
    expect(db._upsert).not.toHaveBeenCalled();
  });

  it("rejects non-manual residents", async () => {
    const db = mockDb();
    const result = await runExistingResidentOnboarding(
      db as never,
      { userId: "mgr-1", email: "manager@test.proplane.local" },
      {
        id: "PROPLANE-X",
        name: "Applicant",
        email: "a@test.proplane.local",
        property: "P",
        stage: "Pending",
        bucket: "pending",
        detail: "",
      },
    );
    expect(result.ok).toBe(false);
  });

  // PRP-230. The route hands this module a row it read back under the caller's
  // own manager id, but the write must not be able to reach another manager's
  // application even if that ever changes — an unscoped update here is what
  // let one manager rewrite another's `resident_email`.
  it("scopes the application write to the acting manager", async () => {
    const db = mockDb();
    const row: DemoApplicantRow = {
      id: "PROPLANE-TEST99",
      name: "Jane Smith",
      email: "jane.scope@test.proplane.local",
      property: "Ballard House",
      stage: "Active",
      bucket: "approved",
      detail: "",
      manuallyAdded: true,
      manualResidentDetails: { monthlyUtilities: 100, securityDeposit: 500 },
    };

    const result = await runExistingResidentOnboarding(
      db as never,
      { userId: "mgr-1", email: "manager@test.proplane.local", managerName: "Alex Manager" },
      row,
      { sendWelcomeEmail: true },
    );

    expect(result.ok).toBe(true);
    expect(db._updateFilters).toContainEqual(["id", "PROPLANE-TEST99"]);
    expect(db._updateFilters).toContainEqual(["manager_user_id", "mgr-1"]);
  });
});
