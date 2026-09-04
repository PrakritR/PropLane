import { beforeEach, describe, expect, it, vi } from "vitest";
import { jsonRequest } from "../helpers/api-request";

/**
 * PRP-230. The route used to fall back to a client-supplied `row` when its
 * manager-scoped application lookup missed, and the write that followed was
 * unscoped. Manager A could therefore name manager B's application id, supply
 * their own row, and rewrite B's applicant record — including
 * `resident_email`, the column every resident-facing read is scoped on.
 *
 * These tests pin both halves: the miss is a 404 that writes nothing, and the
 * write that DOES happen carries the caller's manager id.
 */

const { getUser, runExistingResidentOnboarding } = vi.hoisted(() => ({
  getUser: vi.fn(),
  runExistingResidentOnboarding: vi.fn(),
}));

/** Applications this manager actually owns, keyed by id. */
let OWNED_APPLICATIONS: Record<string, Record<string, unknown>>;
/** Every `(column, value)` pair the application select was filtered on. */
let SELECT_FILTERS: Array<[string, unknown]>;

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: async () => ({ auth: { getUser } }),
}));
vi.mock("@/lib/supabase/service", () => ({
  createSupabaseServiceRoleClient: () => makeServiceClient(),
}));
vi.mock("@/lib/existing-resident-onboarding.server", () => ({ runExistingResidentOnboarding }));

import { POST as onboardExistingResident } from "@/app/api/portal/onboard-existing-resident/route";

function makeServiceClient() {
  return {
    from(table: string) {
      if (table === "profiles") {
        return {
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          maybeSingle: vi.fn().mockResolvedValue({
            data: { role: "manager", full_name: "Alex Manager" },
            error: null,
          }),
        };
      }
      if (table === "manager_application_records") {
        let requestedIds: string[] = [];
        const builder: Record<string, unknown> = {
          select: vi.fn().mockReturnThis(),
          in: vi.fn().mockImplementation((_column: string, values: string[]) => {
            requestedIds = values;
            return builder;
          }),
          eq: vi.fn().mockImplementation((column: string, value: unknown) => {
            SELECT_FILTERS.push([column, value]);
            return builder;
          }),
          limit: vi.fn().mockImplementation(() => {
            const owned = requestedIds
              .map((id) => OWNED_APPLICATIONS[id])
              .filter((rowData): rowData is Record<string, unknown> => Boolean(rowData))
              .map((rowData) => ({ id: rowData.id, row_data: rowData }));
            return Promise.resolve({ data: owned, error: null });
          }),
        };
        return builder;
      }
      return {};
    },
  };
}

describe("POST /api/portal/onboard-existing-resident", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    SELECT_FILTERS = [];
    OWNED_APPLICATIONS = {
      "PROPLANE-MINE01": {
        id: "PROPLANE-MINE01",
        name: "Own Resident",
        email: "own.resident@test.proplane.local",
        property: "Ballard House",
      },
    };
    getUser.mockResolvedValue({
      data: { user: { id: "mgr-attacker", email: "attacker@test.proplane.local" } },
    });
    runExistingResidentOnboarding.mockResolvedValue({
      ok: true,
      axisId: "PROPLANE-MINE01",
      leaseId: "lease-1",
      welcomeEmailSent: true,
    });
  });

  it("refuses an application the caller does not own, even when a row is supplied", async () => {
    const res = await onboardExistingResident(
      jsonRequest("http://localhost/api/portal/onboard-existing-resident", {
        method: "POST",
        body: {
          applicationId: "PROPLANE-VICTIM1",
          row: {
            id: "PROPLANE-VICTIM1",
            name: "Victim Resident",
            email: "attacker@example.com",
            property: "Victim House",
          },
        },
      }),
    );

    expect(res.status).toBe(404);
    expect(runExistingResidentOnboarding).not.toHaveBeenCalled();
  });

  it("scopes the application lookup to the calling manager", async () => {
    await onboardExistingResident(
      jsonRequest("http://localhost/api/portal/onboard-existing-resident", {
        method: "POST",
        body: { applicationId: "PROPLANE-MINE01" },
      }),
    );

    expect(SELECT_FILTERS).toContainEqual(["manager_user_id", "mgr-attacker"]);
  });

  it("onboards an application the caller does own", async () => {
    const res = await onboardExistingResident(
      jsonRequest("http://localhost/api/portal/onboard-existing-resident", {
        method: "POST",
        body: { applicationId: "PROPLANE-MINE01" },
      }),
    );

    expect(res.status).toBe(200);
    expect(runExistingResidentOnboarding).toHaveBeenCalledTimes(1);
    const row = runExistingResidentOnboarding.mock.calls[0]?.[2] as { id?: string };
    expect(row.id).toBe("PROPLANE-MINE01");
  });
});
