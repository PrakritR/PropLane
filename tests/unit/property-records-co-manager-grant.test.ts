/**
 * `POST /api/property-records` was the remaining door onto the empty-grant
 * sentinel.
 *
 * The Settings route now denies an assignment carrying no checked permissions,
 * but this route still resolved through `assertCoManagerModuleAccess` →
 * `managerHasCoManagerPermissionForProperty`, which reads `{}` as full access at
 * every level (the rule PRP-199 retired). That is not just a listing edit: an
 * accepted write also sets or clears the property's application-fee promo code
 * under the OWNER's id, so a delegate granted nothing could waive — or stop
 * waiving — an owner's application fees.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const getUser = vi.fn();
const isAdminUser = vi.fn();
const upsertPropertyApplicationFeeWaiverCode = vi.fn();
const previewApplicationFeeWaiverCodeWrite = vi.fn();

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: async () => ({ auth: { getUser: () => getUser() } }),
}));
vi.mock("@/lib/supabase/service", () => ({
  createSupabaseServiceRoleClient: () => makeDb(),
}));
vi.mock("@/lib/auth/admin-preview", () => ({ isAdminUser: (...a: unknown[]) => isAdminUser(...a) }));
vi.mock("@/lib/analytics/posthog", () => ({ track: () => undefined }));
vi.mock("@/lib/manager-property-quota.server", () => ({
  assertManagerPropertyListingQuota: async () => ({ ok: true }),
}));
vi.mock("@/lib/auth/clear-property-housing-access", () => ({
  clearHousingAccessForDeletedProperty: async () => undefined,
}));
vi.mock("@/lib/application-fee-waiver", () => ({
  upsertPropertyApplicationFeeWaiverCode: (...a: unknown[]) => upsertPropertyApplicationFeeWaiverCode(...a),
  previewApplicationFeeWaiverCodeWrite: (...a: unknown[]) => previewApplicationFeeWaiverCodeWrite(...a),
  sameApplicationFeeWaiverCodeText: (a: string | null | undefined, b: string | null | undefined) =>
    (a ?? "").trim().toUpperCase() === (b ?? "").trim().toUpperCase(),
}));

const route = await import("@/app/api/property-records/route");

const OWNER = "owner-1";
const DELEGATE = "delegate-1";
const PROPERTY = "prop-1";

type LinkRow = {
  inviter_user_id: string;
  invitee_user_id: string;
  assigned_property_ids: string[];
  property_co_manager_permissions?: unknown;
};

let linkRows: LinkRow[] = [];
let recordUpserts: Record<string, unknown>[] = [];
let recordDeletes = 0;

function makeDb() {
  return {
    from(table: string) {
      const filters: Record<string, string> = {};
      const settle = () => {
        if (table === "manager_property_records") {
          return { data: { id: PROPERTY, manager_user_id: OWNER, status: "live" }, error: null };
        }
        if (table === "account_link_invites") return { data: linkRows, error: null };
        return { data: { id: DELEGATE, email: "delegate@example.com" }, error: null };
      };
      const builder: Record<string, unknown> = {
        select: () => builder,
        eq: (column: string, value: string) => {
          filters[column] = value;
          return builder;
        },
        in: async () =>
          ({
            data: [
              { id: OWNER, email: "owner@example.com" },
              { id: DELEGATE, email: "delegate@example.com" },
            ],
          }),
        maybeSingle: async () => settle(),
        upsert: async (values: Record<string, unknown>) => {
          recordUpserts.push(values);
          return { data: null, error: null };
        },
        delete: () => {
          recordDeletes += 1;
          return builder;
        },
        then: (resolve: (v: unknown) => unknown) => Promise.resolve(settle()).then(resolve),
      };
      return builder;
    },
  };
}

function post(body: Record<string, unknown>) {
  return route.POST(
    new Request("http://localhost/api/property-records", {
      method: "POST",
      body: JSON.stringify({ action: "upsert", id: PROPERTY, status: "live", ...body }),
    }),
  );
}

const LISTING_WITH_CODE = {
  rowData: { submission: { applicationFeeWaiverCode: "WELCOME50" } },
};

function grant(permissions: unknown, propertyIds: string[] = [PROPERTY]): LinkRow[] {
  return [
    {
      inviter_user_id: OWNER,
      invitee_user_id: DELEGATE,
      assigned_property_ids: propertyIds,
      property_co_manager_permissions: permissions,
    },
  ];
}

beforeEach(() => {
  vi.clearAllMocks();
  linkRows = [];
  recordUpserts = [];
  recordDeletes = 0;
  isAdminUser.mockResolvedValue(false);
  previewApplicationFeeWaiverCodeWrite.mockResolvedValue({ ok: true });
  upsertPropertyApplicationFeeWaiverCode.mockResolvedValue({ ok: true, code: null });
  getUser.mockResolvedValue({ data: { user: { id: DELEGATE } } });
});

describe("a delegate whose grant confers nothing", () => {
  it("cannot save the listing or its promo code with an EMPTY permission map", async () => {
    linkRows = grant({ [PROPERTY]: {} });

    const res = await post(LISTING_WITH_CODE);

    expect(res.status).toBe(403);
    expect(recordUpserts).toHaveLength(0);
    expect(previewApplicationFeeWaiverCodeWrite).not.toHaveBeenCalled();
    expect(upsertPropertyApplicationFeeWaiverCode).not.toHaveBeenCalled();
  });

  it("cannot save with a READ-ONLY properties grant", async () => {
    linkRows = grant({ [PROPERTY]: { properties: { read: true } } });

    const res = await post(LISTING_WITH_CODE);

    expect(res.status).toBe(403);
    expect(recordUpserts).toHaveLength(0);
    expect(upsertPropertyApplicationFeeWaiverCode).not.toHaveBeenCalled();
  });

  it("cannot save when the grant names a DIFFERENT property", async () => {
    linkRows = grant({ "prop-other": { properties: { read: true, edit: true } } }, ["prop-other"]);

    const res = await post(LISTING_WITH_CODE);

    expect(res.status).toBe(403);
    expect(recordUpserts).toHaveLength(0);
    expect(upsertPropertyApplicationFeeWaiverCode).not.toHaveBeenCalled();
  });

  it("cannot delete the listing with an empty map either", async () => {
    linkRows = grant({ [PROPERTY]: {} });

    const res = await post({ action: "delete" });

    expect(res.status).toBe(403);
    expect(recordDeletes).toBe(0);
  });
});

describe("an explicitly granted delegate still works", () => {
  beforeEach(() => {
    linkRows = grant({ [PROPERTY]: { properties: { read: true, edit: true } } });
  });

  it("saves the listing under the owner and writes the promo code", async () => {
    const res = await post(LISTING_WITH_CODE);

    expect(res.status).toBe(200);
    expect(recordUpserts).toHaveLength(1);
    expect(recordUpserts[0]).toMatchObject({ manager_user_id: OWNER });
    expect(upsertPropertyApplicationFeeWaiverCode).toHaveBeenCalledWith(
      expect.anything(),
      OWNER,
      PROPERTY,
      "WELCOME50",
      { allowPortfolioConversion: false },
    );
  });
});

describe("the owner", () => {
  beforeEach(() => {
    getUser.mockResolvedValue({ data: { user: { id: OWNER } } });
  });

  it("saves and may convert their own portfolio code", async () => {
    const res = await post(LISTING_WITH_CODE);

    expect(res.status).toBe(200);
    expect(upsertPropertyApplicationFeeWaiverCode).toHaveBeenCalledWith(
      expect.anything(),
      OWNER,
      PROPERTY,
      "WELCOME50",
      { allowPortfolioConversion: true },
    );
  });

  it("refuses a known promo-code conflict BEFORE the listing is written", async () => {
    previewApplicationFeeWaiverCodeWrite.mockResolvedValue({
      ok: false,
      error: "That code is already in use on another property. Give this one its own code.",
    });

    const res = await post(LISTING_WITH_CODE);

    expect(res.status).toBe(400);
    // The listing must not be live while the manager is told the save failed.
    expect(recordUpserts).toHaveLength(0);
    expect(upsertPropertyApplicationFeeWaiverCode).not.toHaveBeenCalled();
    const body = (await res.json()) as { error?: string };
    expect(body.error).toContain("already in use on another property");
  });

  it("leaves a DRAFT save unvalidated, so a half-typed code still saves", async () => {
    const res = await post({ ...LISTING_WITH_CODE, status: "draft" });

    expect(res.status).toBe(200);
    expect(previewApplicationFeeWaiverCodeWrite).not.toHaveBeenCalled();
    expect(upsertPropertyApplicationFeeWaiverCode).not.toHaveBeenCalled();
    expect(recordUpserts).toHaveLength(1);
  });
});
