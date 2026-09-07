/**
 * A draft is saved on every wizard step and on close, with whatever the
 * manager has typed so far — it is unvalidated by contract
 * (docs/agents/property-drafts.md). `POST /api/property-records` nevertheless
 * ran the application-fee promo code through `upsertPropertyApplicationFeeWaiverCode`
 * on EVERY write, so a half-typed code ("AB") answered 400 for the draft save.
 * Worse, the record upsert had already landed by then, so the wizard reported a
 * failure for a draft that was in fact saved, and — because a failed close-save
 * keeps the wizard open — the manager could not close it.
 *
 * Pinned here:
 *
 * 1. A DRAFT write never consults the waiver validator, whatever the code says.
 * 2. A LISTING write still does, and a bad code is still refused with a message
 *    that names the field.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { jsonRequest } from "../helpers/api-request";

const getUser = vi.fn();
let UPSERTS: Record<string, unknown>[] = [];
let WAIVER_CALLS: Array<{ propertyId: string; code: string | null | undefined }> = [];

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
vi.mock("@/lib/manager-access-server", () => ({
  getEffectiveManagerSkuTier: async () => ({ ok: true, tier: "pro" }),
}));
vi.mock("@/lib/application-fee-waiver", () => ({
  upsertPropertyApplicationFeeWaiverCode: async (
    _db: unknown,
    _managerUserId: string,
    propertyId: string,
    code: string | null | undefined,
  ) => {
    WAIVER_CALLS.push({ propertyId, code });
    return (code ?? "").length >= 4
      ? { ok: true, code }
      : { ok: false, error: "Codes must be 4-32 letters, numbers, or hyphens." };
  },
}));
vi.mock("@/lib/supabase/service", () => ({
  createSupabaseServiceRoleClient: () => ({
    from: () => ({
      select: (_cols: string, opts?: { count?: string }) => {
        if (!opts?.count) {
          return { eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) };
        }
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
    }),
  }),
}));

import { POST as postPropertyRecord } from "@/app/api/property-records/route";

const MANAGER = "mgr-draft-waiver-1";

function post(body: Record<string, unknown>) {
  return postPropertyRecord(
    jsonRequest("http://localhost/api/property-records", { method: "POST", body }),
  );
}

/** The wizard's draft row shape: the submission rides inside `rowData.submission`. */
function draftRowData(applicationFeeWaiverCode: string) {
  return { submission: { buildingName: "Ravenna Craftsman", applicationFeeWaiverCode } };
}

beforeEach(() => {
  vi.clearAllMocks();
  UPSERTS = [];
  WAIVER_CALLS = [];
  getUser.mockResolvedValue({ data: { user: { id: MANAGER } } });
});

describe("POST /api/property-records — drafts are unvalidated", () => {
  it("saves a draft carrying a half-typed promo code without consulting the validator", async () => {
    const res = await post({
      action: "upsert",
      id: "mgr-ravenna-draft",
      managerUserId: MANAGER,
      status: "draft",
      rowData: draftRowData("AB"),
    });

    expect(res.status).toBe(200);
    expect(UPSERTS).toHaveLength(1);
    expect(UPSERTS[0]).toMatchObject({ id: "mgr-ravenna-draft", status: "draft" });
    expect(WAIVER_CALLS).toEqual([]);
  });

  it("does not apply a VALID code for a draft either — that happens on publish", async () => {
    const res = await post({
      action: "upsert",
      id: "mgr-ravenna-draft",
      managerUserId: MANAGER,
      status: "draft",
      rowData: draftRowData("SPRING25"),
    });

    expect(res.status).toBe(200);
    expect(WAIVER_CALLS).toEqual([]);
  });

  it("still validates the code when the same row is published, and names the field", async () => {
    const res = await post({
      action: "upsert",
      id: "mgr-ravenna-draft",
      managerUserId: MANAGER,
      status: "live",
      rowData: draftRowData("AB"),
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/promo code/i);
    expect(body.error).toMatch(/4-32/);
    expect(WAIVER_CALLS).toEqual([{ propertyId: "mgr-ravenna-draft", code: "AB" }]);
  });

  it("applies a valid code on publish", async () => {
    const res = await post({
      action: "upsert",
      id: "mgr-ravenna-draft",
      managerUserId: MANAGER,
      status: "live",
      rowData: draftRowData("SPRING25"),
    });

    expect(res.status).toBe(200);
    expect(WAIVER_CALLS).toEqual([{ propertyId: "mgr-ravenna-draft", code: "SPRING25" }]);
  });
});
