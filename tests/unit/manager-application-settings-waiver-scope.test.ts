/**
 * Who may read and rewrite a property's application-fee promo code.
 *
 * Two ways this surface handed authority away that nobody granted:
 *
 * 1. It resolved co-manager access through `assertCoManagerModuleAccess`, which
 *    still carries the retired "empty permission map means full access"
 *    sentinel. A co-manager assigned the property with `{}` could read the
 *    owner's active code and overwrite it under the owner's id.
 * 2. A property-scoped co-manager typing the owner's PORTFOLIO-wide code pinned
 *    that code to their one property, silently charging the full application fee
 *    on every other listing it used to waive.
 * 3. A mixed PATCH wrote the fee settings BEFORE authorizing the waiver portion,
 *    so a refused request still left part of itself behind.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const requireManagerRouteUser = vi.fn();
const listApplicationFeeWaiverCodes = vi.fn();
const previewApplicationFeeWaiverCodeWrite = vi.fn();
const saveManagerApplicationSettings = vi.fn();
const saveApplicationAutomationForProperty = vi.fn();
const upsertPropertyApplicationFeeWaiverCode = vi.fn();
const setPrimaryApplicationFeeWaiverCode = vi.fn();
const pickPrimaryApplicationFeeWaiverCode = vi.fn();
const pickPortfolioApplicationFeeWaiverCode = vi.fn();

vi.mock("@/lib/manager-route-guard.server", () => ({
  requireManagerRouteUser: () => requireManagerRouteUser(),
}));
vi.mock("@/lib/manager-application-settings", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/manager-application-settings")>();
  return {
    ...actual,
    loadManagerApplicationSettings: async () => SETTINGS,
    saveManagerApplicationSettings: (...a: unknown[]) => saveManagerApplicationSettings(...a),
  };
});
vi.mock("@/lib/manager-application-settings.server", () => ({
  suggestedManagerApplicationFeeCents: async () => null,
}));
vi.mock("@/lib/application-automation-preferences", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/application-automation-preferences")>();
  return {
    ...actual,
    loadApplicationAutomation: async () => actual.DEFAULT_APPLICATION_AUTOMATION,
    loadApplicationAutomationState: async () => ({
      portfolio: actual.DEFAULT_APPLICATION_AUTOMATION,
      byPropertyId: {},
    }),
    saveApplicationAutomation: async () => actual.DEFAULT_APPLICATION_AUTOMATION,
    saveApplicationAutomationForProperty: (...a: unknown[]) => saveApplicationAutomationForProperty(...a),
  };
});
vi.mock("@/lib/task-automation-preferences", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/task-automation-preferences")>();
  return { ...actual, loadTaskAutomation: async () => ({}), saveTaskAutomation: async () => ({}) };
});
vi.mock("@/lib/manager-landlord-profile", () => ({
  loadManagerLandlordLegalNameFromProfile: async () => "Doe Holdings LLC",
}));
vi.mock("@/lib/application-fee-waiver", () => ({
  listApplicationFeeWaiverCodes: (...a: unknown[]) => listApplicationFeeWaiverCodes(...a),
  previewApplicationFeeWaiverCodeWrite: (...a: unknown[]) => previewApplicationFeeWaiverCodeWrite(...a),
  upsertPropertyApplicationFeeWaiverCode: (...a: unknown[]) => upsertPropertyApplicationFeeWaiverCode(...a),
  setPrimaryApplicationFeeWaiverCode: (...a: unknown[]) => setPrimaryApplicationFeeWaiverCode(...a),
  pickPrimaryApplicationFeeWaiverCode: (...a: unknown[]) => pickPrimaryApplicationFeeWaiverCode(...a),
  pickPortfolioApplicationFeeWaiverCode: (...a: unknown[]) => pickPortfolioApplicationFeeWaiverCode(...a),
  listingWaiverLabel: (id: string) => `listing:${id}`,
}));

const route = await import("@/app/api/portal/manager-application-settings/route");

const SETTINGS = {
  applicationFeeCents: 5000,
  applicationFeeChargePolicy: "first_only" as const,
  applicationFeeOtherEnabled: false,
  applicationFeeOtherInstructions: "",
};

const OWNER = "owner-1";
const CO_MANAGER = "co-1";
const PROPERTY = "prop-1";

type LinkRow = {
  inviter_user_id: string;
  invitee_user_id?: string;
  assigned_property_ids: string[];
  property_co_manager_permissions?: unknown;
  co_manager_permissions?: unknown;
};

/**
 * Enough of the PostgREST builder for the real permission resolver to run: it
 * is the resolver's own answer these tests are about, so mocking it out would
 * test nothing.
 */
function makeDb(linkRows: LinkRow[]) {
  return {
    from(table: string) {
      const result =
        table === "manager_property_records"
          ? { data: { manager_user_id: OWNER } }
          : table === "account_link_invites"
            ? { data: linkRows, error: null }
            : { data: { id: CO_MANAGER, email: "co@example.com" } };
      const builder: Record<string, unknown> = {
        select: () => builder,
        eq: () => builder,
        in: () =>
          Promise.resolve({
            data: [
              { id: OWNER, email: "owner@example.com" },
              { id: CO_MANAGER, email: "co@example.com" },
            ],
          }),
        maybeSingle: async () => result,
        then: (resolve: (v: unknown) => unknown) => Promise.resolve(result).then(resolve),
      };
      return builder;
    },
  };
}

function get(propertyId: string): Request {
  return new Request(
    `http://localhost/api/portal/manager-application-settings?propertyId=${encodeURIComponent(propertyId)}`,
  );
}

function patch(body: unknown): Request {
  return new Request("http://localhost/api/portal/manager-application-settings", {
    method: "PATCH",
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  listApplicationFeeWaiverCodes.mockResolvedValue([]);
  pickPrimaryApplicationFeeWaiverCode.mockReturnValue(null);
  pickPortfolioApplicationFeeWaiverCode.mockReturnValue(null);
  previewApplicationFeeWaiverCodeWrite.mockResolvedValue({ ok: true });
  upsertPropertyApplicationFeeWaiverCode.mockResolvedValue({ ok: true, code: { code: "X" } });
  saveManagerApplicationSettings.mockResolvedValue(SETTINGS);
  saveApplicationAutomationForProperty.mockResolvedValue({});
});

describe("a co-manager with an EMPTY permission map gets nothing", () => {
  const emptyPerms: LinkRow[] = [
    {
      inviter_user_id: OWNER,
      invitee_user_id: CO_MANAGER,
      assigned_property_ids: [PROPERTY],
      property_co_manager_permissions: { [PROPERTY]: {} },
    },
  ];

  beforeEach(() => {
    requireManagerRouteUser.mockResolvedValue({ db: makeDb(emptyPerms), userId: CO_MANAGER });
  });

  it("403s the GET instead of returning the owner's code", async () => {
    const res = await route.GET(get(PROPERTY));
    expect(res.status).toBe(403);
    expect(listApplicationFeeWaiverCodes).not.toHaveBeenCalled();
  });

  it("403s the PATCH instead of rewriting the owner's code", async () => {
    const res = await route.PATCH(patch({ propertyId: PROPERTY, waiverCode: "TAKEOVER" }));
    expect(res.status).toBe(403);
    expect(upsertPropertyApplicationFeeWaiverCode).not.toHaveBeenCalled();
  });

  it("writes NOTHING when the same PATCH also carries fee settings and automation", async () => {
    const res = await route.PATCH(
      patch({
        propertyId: PROPERTY,
        applicationFeeCents: 12345,
        automation: { autoApprove: true },
        waiverCode: "TAKEOVER",
      }),
    );
    expect(res.status).toBe(403);
    expect(saveManagerApplicationSettings).not.toHaveBeenCalled();
    expect(saveApplicationAutomationForProperty).not.toHaveBeenCalled();
    expect(upsertPropertyApplicationFeeWaiverCode).not.toHaveBeenCalled();
  });
});

describe("a co-manager granted `applications` keeps working", () => {
  const grantedPerms: LinkRow[] = [
    {
      inviter_user_id: OWNER,
      invitee_user_id: CO_MANAGER,
      assigned_property_ids: [PROPERTY],
      property_co_manager_permissions: {
        [PROPERTY]: { applications: { read: true, edit: true } },
      },
    },
  ];

  beforeEach(() => {
    requireManagerRouteUser.mockResolvedValue({ db: makeDb(grantedPerms), userId: CO_MANAGER });
  });

  it("reads the OWNER's codes, not its own", async () => {
    const res = await route.GET(get(PROPERTY));
    expect(res.status).toBe(200);
    expect(listApplicationFeeWaiverCodes).toHaveBeenCalledWith(expect.anything(), OWNER);
  });

  it("writes under the owner but may NOT convert a portfolio code", async () => {
    const res = await route.PATCH(patch({ propertyId: PROPERTY, waiverCode: "FREE100" }));
    expect(res.status).toBe(200);
    expect(upsertPropertyApplicationFeeWaiverCode).toHaveBeenCalledWith(
      expect.anything(),
      OWNER,
      PROPERTY,
      "FREE100",
      { allowPortfolioConversion: false },
    );
  });

  it("leaves the fee settings alone when the code itself is refused", async () => {
    // A collision the precheck can answer (the text belongs to a retired code)
    // must not commit the fee half of the same request.
    previewApplicationFeeWaiverCodeWrite.mockResolvedValue({ ok: false, error: "has been retired" });
    const res = await route.PATCH(patch({ propertyId: PROPERTY, applicationFeeCents: 7500, waiverCode: "SPRING" }));
    expect(res.status).toBe(400);
    expect(saveManagerApplicationSettings).not.toHaveBeenCalled();
    expect(upsertPropertyApplicationFeeWaiverCode).not.toHaveBeenCalled();
  });

  it("never reports a portfolio code it cannot act on", async () => {
    pickPortfolioApplicationFeeWaiverCode.mockReturnValue({ code: "FREE100" });
    const res = await route.GET(get(PROPERTY));
    expect(await res.json()).toMatchObject({ portfolioWaiverCode: null });
  });
});

describe("the owner", () => {
  beforeEach(() => {
    requireManagerRouteUser.mockResolvedValue({ db: makeDb([]), userId: OWNER });
  });

  it("may convert their own portfolio code", async () => {
    const res = await route.PATCH(patch({ propertyId: PROPERTY, waiverCode: "FREE100" }));
    expect(res.status).toBe(200);
    expect(upsertPropertyApplicationFeeWaiverCode).toHaveBeenCalledWith(
      expect.anything(),
      OWNER,
      PROPERTY,
      "FREE100",
      { allowPortfolioConversion: true },
    );
  });

  it("is told a legacy portfolio code still waives the fee on this property", async () => {
    // The property-scoped field is empty here, which used to read as "no waiver
    // is active" while the portfolio code kept waiving the fee.
    pickPortfolioApplicationFeeWaiverCode.mockReturnValue({ code: "FREE100" });
    const res = await route.GET(get(PROPERTY));
    expect(await res.json()).toMatchObject({ waiverCode: null, portfolioWaiverCode: "FREE100" });
  });
});
