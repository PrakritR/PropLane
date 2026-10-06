/**
 * Closing the listing editor on a listing whose stored `allowedLeaseTerms` is legacy free text ("12 months") or
 * empty used to answer 400 "Choose at least one lease term" while Basics showed Long term on. The route now
 * reads legacy values as the lease type they stand for and an empty set as Long term, so the saved payload and
 * the screen agree.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { jsonRequest } from "../helpers/api-request";

const getUser = vi.fn();
let UPSERTS: Record<string, unknown>[] = [];

vi.mock("@/lib/auth/admin-preview", () => ({ isAdminUser: async () => false }));
vi.mock("@/lib/auth/co-manager-access", () => ({
  assertCoManagerModuleAccess: async () => ({ ok: false, error: "Forbidden.", status: 403 }),
}));
vi.mock("@/lib/auth/clear-property-housing-access", () => ({
  clearHousingAccessForDeletedProperty: async () => {},
}));
vi.mock("@/lib/analytics/posthog", () => ({ track: () => {} }));
vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: async () => ({ auth: { getUser } }),
}));
vi.mock("@/lib/test-workspaces/index.server", () => ({
  resolveAuthenticatedBusinessAccess: async () => ({ kind: "normal" }),
}));
vi.mock("@/lib/manager-access-server", () => ({
  getEffectiveManagerSkuTier: async () => ({ ok: true, tier: "pro" }),
}));
vi.mock("@/lib/application-fee-waiver", () => ({
  sameApplicationFeeWaiverCodeText: () => true,
  previewApplicationFeeWaiverCodeWrite: async () => ({ ok: true }),
  upsertPropertyApplicationFeeWaiverCode: async () => ({ ok: true }),
}));
vi.mock("@/lib/supabase/service", () => ({
  createSupabaseServiceRoleClient: () => ({
    from: (table: string) => {
      if (table === "portal_workspaces") {
        return { select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }) }) };
      }
      return {
        select: (_cols: string, opts?: { count?: string }) => {
          if (!opts?.count) return { eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) };
          const builder = {
            eq: () => builder,
            in: () => builder,
            neq: () => builder,
            then(resolve: (v: { count: number | null; error: unknown }) => unknown) {
              return Promise.resolve({ count: 0, error: null }).then(resolve);
            },
          };
          return builder;
        },
        upsert: async (row: Record<string, unknown>) => {
          UPSERTS.push(row);
          return { error: null };
        },
      };
    },
  }),
}));

import { POST as postPropertyRecord } from "@/app/api/property-records/route";

const MANAGER = "mgr-legacy-terms-1";

function post(submission: Record<string, unknown>, status = "live") {
  return postPropertyRecord(
    jsonRequest("http://localhost/api/property-records", {
      method: "POST",
      body: {
        action: "upsert",
        id: "mgr-legacy-terms-house",
        managerUserId: MANAGER,
        status,
        rowData: { submission: { buildingName: "Ravenna Craftsman", ...submission } },
      },
    }),
  );
}

function storedTerms(): unknown {
  const rowData = UPSERTS[0]?.row_data as { submission?: { allowedLeaseTerms?: unknown } } | undefined;
  return rowData?.submission?.allowedLeaseTerms;
}

beforeEach(() => {
  vi.clearAllMocks();
  UPSERTS = [];
  getUser.mockResolvedValue({ data: { user: { id: MANAGER } } });
});

describe("POST /api/property-records — legacy lease terms", () => {
  it("saves a listing whose stored terms are legacy text, as Long-term", async () => {
    const res = await post({ allowedLeaseTerms: ["12 months"], shortTermRentalsAllowed: false });
    expect(res.status).toBe(200);
    expect(storedTerms()).toEqual(["Long-term"]);
  });

  it("maps month-to-month, custom and the short-stay words onto their lease types", async () => {
    const res = await post({ allowedLeaseTerms: ["6 months", "month-to-month", "custom", "nightly"], shortTermRentalsAllowed: true });
    expect(res.status).toBe(200);
    expect(storedTerms()).toEqual(["Long-term", "Short-Term Stay"]);
  });

  it("refuses an empty set rather than quietly saving Long term", async () => {
    // Normalizing an EMPTY list to Long term silenced the one refusal that tells the manager their
    // save did not do what they asked; the editor already refuses turning the last stay off.
    const res = await post({ allowedLeaseTerms: [], shortTermRentalsAllowed: false });
    expect(res.status).toBe(400);
    expect(UPSERTS).toHaveLength(0);
  });

  it("leaves current terms exactly as sent, and a submission that names no terms alone", async () => {
    const current = await post({ allowedLeaseTerms: ["Long-term", "Month-to-Month"], shortTermRentalsAllowed: false });
    expect(current.status).toBe(200);
    expect(storedTerms()).toEqual(["Long-term", "Month-to-Month"]);
    UPSERTS = [];
    const legacyRow = await post({});
    expect(legacyRow.status).toBe(200);
    expect(storedTerms()).toBeUndefined();
  });
});
