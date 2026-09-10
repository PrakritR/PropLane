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
 * 3. Only a field this request CHANGES is a waiver write. Applications settings
 *    rewrites the codes table without touching the listing's stored submission,
 *    so replaying that stale text used to re-point the code away from the newer
 *    settings value — and, once the old text was retired, refused listing edits
 *    that had nothing to do with the promo code.
 * 4. FIRST PUBLICATION is the exception: because (1) means a draft save never
 *    wrote the code, the draft -> listing transition must apply the submitted
 *    code even though the text matches what the draft stored. Skipping it
 *    published a listing advertising a code with no row to redeem.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { jsonRequest } from "../helpers/api-request";

const getUser = vi.fn();
let EXISTING: Record<string, unknown> | null = null;
let RETIRED: string[] = [];
let UPSERTS: Record<string, unknown>[] = [];
let WAIVER_CALLS: Array<{ propertyId: string; code: string | null | undefined }> = [];
let PREVIEW_CALLS: Array<{ propertyId: string; code: string | null | undefined }> = [];

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
const validateWaiverCode = (code: string | null | undefined) => {
  const text = (code ?? "").trim().toUpperCase();
  // An empty field is a CLEAR, which the real planner accepts.
  if (!text) return { ok: true } as const;
  if (RETIRED.includes(text)) {
    return {
      ok: false,
      error: "That code was used before and has been retired, so it cannot be brought back. Pick different text.",
    } as const;
  }
  return (code ?? "").length >= 4
    ? ({ ok: true } as const)
    : ({ ok: false, error: "Codes must be 4-32 letters, numbers, or hyphens." } as const);
};

vi.mock("@/lib/application-fee-waiver", () => ({
  sameApplicationFeeWaiverCodeText: (a: string | null | undefined, b: string | null | undefined) =>
    (a ?? "").trim().toUpperCase() === (b ?? "").trim().toUpperCase(),
  previewApplicationFeeWaiverCodeWrite: async (
    _db: unknown,
    _managerUserId: string,
    propertyId: string,
    code: string | null | undefined,
  ) => {
    PREVIEW_CALLS.push({ propertyId, code });
    return validateWaiverCode(code);
  },
  upsertPropertyApplicationFeeWaiverCode: async (
    _db: unknown,
    _managerUserId: string,
    propertyId: string,
    code: string | null | undefined,
  ) => {
    WAIVER_CALLS.push({ propertyId, code });
    const result = validateWaiverCode(code);
    return result.ok ? { ok: true, code } : result;
  },
}));
vi.mock("@/lib/supabase/service", () => ({
  createSupabaseServiceRoleClient: () => ({
    from: () => ({
      select: (_cols: string, opts?: { count?: string }) => {
        if (!opts?.count) {
          return { eq: () => ({ maybeSingle: async () => ({ data: EXISTING, error: null }) }) };
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
  EXISTING = null;
  RETIRED = [];
  UPSERTS = [];
  WAIVER_CALLS = [];
  PREVIEW_CALLS = [];
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
    expect(PREVIEW_CALLS).toEqual([]);
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
    expect(PREVIEW_CALLS).toEqual([]);
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
    expect(PREVIEW_CALLS).toEqual([{ propertyId: "mgr-ravenna-draft", code: "AB" }]);
    // The refusal is now answered from a read, BEFORE the listing row lands, so
    // the manager is not told the save failed on a listing that went live.
    expect(UPSERTS).toEqual([]);
    expect(WAIVER_CALLS).toEqual([]);
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
    expect(PREVIEW_CALLS).toEqual([{ propertyId: "mgr-ravenna-draft", code: "SPRING25" }]);
    expect(WAIVER_CALLS).toEqual([{ propertyId: "mgr-ravenna-draft", code: "SPRING25" }]);
  });
});

describe("POST /api/property-records — an untouched promo-code field is not a write", () => {
  /** The listing row as the wizard last stored it. */
  function storedListing(applicationFeeWaiverCode: string | null) {
    return {
      manager_user_id: MANAGER,
      status: "live",
      row_data:
        applicationFeeWaiverCode == null
          ? { submission: { buildingName: "Ravenna Craftsman" } }
          : draftRowData(applicationFeeWaiverCode),
      property_data: null,
    };
  }

  it("saves an unrelated edit after Applications settings replaced the code", async () => {
    // Wizard stored SPRING; settings then moved the account to SUMMER, which
    // retired SPRING. The listing payload still carries the stale SPRING.
    EXISTING = storedListing("SPRING");
    RETIRED = ["SPRING"];

    const res = await post({
      action: "upsert",
      id: "mgr-ravenna-draft",
      managerUserId: MANAGER,
      status: "live",
      rowData: { submission: { buildingName: "Ravenna Craftsman II", applicationFeeWaiverCode: "SPRING" } },
    });

    expect(res.status).toBe(200);
    expect(UPSERTS).toHaveLength(1);
    // Nothing consulted or rewrote the codes table, so SUMMER is still the
    // property's active code.
    expect(PREVIEW_CALLS).toEqual([]);
    expect(WAIVER_CALLS).toEqual([]);
  });

  it("treats a re-cased or padded field as the same code", async () => {
    EXISTING = storedListing("SPRING25");

    const res = await post({
      action: "upsert",
      id: "mgr-ravenna-draft",
      managerUserId: MANAGER,
      status: "live",
      rowData: draftRowData(" spring25 "),
    });

    expect(res.status).toBe(200);
    expect(PREVIEW_CALLS).toEqual([]);
    expect(WAIVER_CALLS).toEqual([]);
  });

  it("never revokes a settings-set code when the listing field was always empty", async () => {
    EXISTING = storedListing(null);

    const res = await post({
      action: "upsert",
      id: "mgr-ravenna-draft",
      managerUserId: MANAGER,
      status: "live",
      rowData: draftRowData(""),
    });

    expect(res.status).toBe(200);
    expect(PREVIEW_CALLS).toEqual([]);
    expect(WAIVER_CALLS).toEqual([]);
  });

  it("still refuses a DELIBERATE edit back to retired text, writing nothing", async () => {
    EXISTING = storedListing("SUMMER");
    RETIRED = ["SPRING"];

    const res = await post({
      action: "upsert",
      id: "mgr-ravenna-draft",
      managerUserId: MANAGER,
      status: "live",
      rowData: draftRowData("SPRING"),
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/retired/i);
    expect(UPSERTS).toEqual([]);
    expect(WAIVER_CALLS).toEqual([]);
    expect(PREVIEW_CALLS).toEqual([{ propertyId: "mgr-ravenna-draft", code: "SPRING" }]);
  });

  it("still applies a deliberate change to a fresh code", async () => {
    EXISTING = storedListing("SPRING25");

    const res = await post({
      action: "upsert",
      id: "mgr-ravenna-draft",
      managerUserId: MANAGER,
      status: "live",
      rowData: draftRowData("AUTUMN25"),
    });

    expect(res.status).toBe(200);
    expect(PREVIEW_CALLS).toEqual([{ propertyId: "mgr-ravenna-draft", code: "AUTUMN25" }]);
    expect(WAIVER_CALLS).toEqual([{ propertyId: "mgr-ravenna-draft", code: "AUTUMN25" }]);
  });

  it("still applies a deliberate CLEAR of the field", async () => {
    EXISTING = storedListing("SPRING25");

    const res = await post({
      action: "upsert",
      id: "mgr-ravenna-draft",
      managerUserId: MANAGER,
      status: "live",
      rowData: draftRowData(""),
    });

    expect(res.status).toBe(200);
    expect(PREVIEW_CALLS).toEqual([{ propertyId: "mgr-ravenna-draft", code: "" }]);
    expect(WAIVER_CALLS).toEqual([{ propertyId: "mgr-ravenna-draft", code: "" }]);
  });
});

describe("POST /api/property-records — publishing a draft applies its promo code", () => {
  /**
   * The real shapes: a draft row keeps the submission under `row_data.submission`
   * (`submissionToDraftAdminRow`), while `publishManagerListingSubmissionToServer`
   * sends the same submission under `propertyData.listingSubmission` and a
   * `rowData` that carries no submission at all.
   */
  function storedDraft(applicationFeeWaiverCode: string) {
    return {
      manager_user_id: MANAGER,
      status: "draft",
      row_data: draftRowData(applicationFeeWaiverCode),
      property_data: null,
    };
  }

  function publish(applicationFeeWaiverCode: string) {
    return post({
      action: "upsert",
      id: "mgr-ravenna-draft",
      managerUserId: MANAGER,
      status: "live",
      rowData: { adminRefId: "mgr-ravenna-draft", listingId: "mgr-ravenna-draft", managerUserId: MANAGER },
      propertyData: {
        listingSubmission: { buildingName: "Ravenna Craftsman", applicationFeeWaiverCode },
      },
    });
  }

  it("creates the code the draft carried, even though the text did not change", async () => {
    EXISTING = storedDraft("SPRING25");

    const res = await publish("SPRING25");

    expect(res.status).toBe(200);
    expect(UPSERTS).toHaveLength(1);
    expect(UPSERTS[0]).toMatchObject({ status: "live" });
    expect(PREVIEW_CALLS).toEqual([{ propertyId: "mgr-ravenna-draft", code: "SPRING25" }]);
    expect(WAIVER_CALLS).toEqual([{ propertyId: "mgr-ravenna-draft", code: "SPRING25" }]);
  });

  it("refuses retired text on first publication without writing the listing", async () => {
    EXISTING = storedDraft("SPRING");
    RETIRED = ["SPRING"];

    const res = await publish("SPRING");

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/retired/i);
    expect(UPSERTS).toEqual([]);
    expect(WAIVER_CALLS).toEqual([]);
  });

  it("refuses a half-typed code on first publication without writing the listing", async () => {
    EXISTING = storedDraft("AB");

    const res = await publish("AB");

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/4-32/);
    expect(UPSERTS).toEqual([]);
    expect(WAIVER_CALLS).toEqual([]);
  });

  it("never revokes a settings-set code when the published draft carried none", async () => {
    EXISTING = storedDraft("");

    const res = await publish("");

    expect(res.status).toBe(200);
    expect(PREVIEW_CALLS).toEqual([]);
    expect(WAIVER_CALLS).toEqual([]);
  });

  it("goes back to the unchanged-field rule once the listing is published", async () => {
    // Same payload, but the row is already live: Applications settings owns the
    // code from here, so replaying the stale text must not touch it.
    EXISTING = { manager_user_id: MANAGER, status: "live", row_data: draftRowData("SPRING"), property_data: null };
    RETIRED = ["SPRING"];

    const res = await publish("SPRING");

    expect(res.status).toBe(200);
    expect(PREVIEW_CALLS).toEqual([]);
    expect(WAIVER_CALLS).toEqual([]);
  });
});
