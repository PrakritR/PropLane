import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

import {
  DEFAULT_MANAGER_APPLICATION_SETTINGS,
  LEGACY_DEFAULT_APPLICATION_FEE_CENTS,
  effectiveApplicationFeeCents,
  loadManagerApplicationSettings,
  normalizeManagerApplicationSettings,
  validateManagerApplicationFeeCents,
} from "@/lib/manager-application-settings";

vi.mock("@/lib/stripe-axis-ach-checkout", async () => {
  const actual = await vi.importActual<typeof import("@/lib/stripe-axis-ach-checkout")>(
    "@/lib/stripe-axis-ach-checkout",
  );
  return { ...actual, createAxisAchCheckoutSession: vi.fn() };
});

vi.mock("@/lib/manager-route-guard.server", () => ({
  requireManagerRouteUser: vi.fn().mockResolvedValue({ db: {} as SupabaseClient, userId: "mgr_A" }),
}));

vi.mock("@/lib/manager-application-settings.server", () => ({
  suggestedManagerApplicationFeeCents: vi.fn().mockResolvedValue(null),
}));

vi.mock("@/lib/manager-application-settings", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/manager-application-settings")>();
  return {
    ...actual,
    loadManagerApplicationSettings: vi.fn(
      async (...args: Parameters<typeof actual.loadManagerApplicationSettings>) =>
        actual.loadManagerApplicationSettings(...args),
    ),
    saveManagerApplicationSettings: vi.fn(
      async (_db: SupabaseClient, _userId: string, settings: Parameters<typeof actual.normalizeManagerApplicationSettings>[0]) =>
        actual.normalizeManagerApplicationSettings(settings),
    ),
  };
});

import { resolveApplicationFeeProperty } from "@/lib/application-fee-checkout.server";
import { PATCH } from "@/app/api/portal/manager-application-settings/route";

describe("normalizeManagerApplicationSettings", () => {
  it("keeps a valid cents value", () => {
    expect(normalizeManagerApplicationSettings({ applicationFeeCents: 7500 })).toEqual({
      ...DEFAULT_MANAGER_APPLICATION_SETTINGS,
      applicationFeeCents: 7500,
    });
  });
  it("treats a missing/non-number value as unconfigured (null)", () => {
    expect(normalizeManagerApplicationSettings({})).toEqual(DEFAULT_MANAGER_APPLICATION_SETTINGS);
    expect(normalizeManagerApplicationSettings({ applicationFeeCents: "50" })).toEqual({
      ...DEFAULT_MANAGER_APPLICATION_SETTINGS,
      applicationFeeCents: null,
    });
    expect(normalizeManagerApplicationSettings(null)).toEqual(DEFAULT_MANAGER_APPLICATION_SETTINGS);
  });
  it("preserves an explicit 0 (free applications) distinct from null", () => {
    expect(normalizeManagerApplicationSettings({ applicationFeeCents: 0 })).toEqual({
      ...DEFAULT_MANAGER_APPLICATION_SETTINGS,
      applicationFeeCents: 0,
    });
  });
  it("treats a stored un-chargeable value (negative or non-zero sub-$1) as unconfigured, never free", () => {
    expect(normalizeManagerApplicationSettings({ applicationFeeCents: -5 })).toEqual({
      ...DEFAULT_MANAGER_APPLICATION_SETTINGS,
      applicationFeeCents: null,
    });
    expect(normalizeManagerApplicationSettings({ applicationFeeCents: 50 })).toEqual({
      ...DEFAULT_MANAGER_APPLICATION_SETTINGS,
      applicationFeeCents: null,
    });
  });
  it("clamps an over-cap value", () => {
    expect(normalizeManagerApplicationSettings({ applicationFeeCents: 5_000_000 })).toEqual({
      ...DEFAULT_MANAGER_APPLICATION_SETTINGS,
      applicationFeeCents: 100_000,
    });
  });
});

describe("validateManagerApplicationFeeCents — write-path rejection, never silent coercion", () => {
  it("rejects a non-zero sub-$1 fee with a clear message", () => {
    const res = validateManagerApplicationFeeCents(50);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/at least \$1/);
  });
  it("rejects a negative fee", () => {
    const res = validateManagerApplicationFeeCents(-100);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/negative/);
  });
  it("accepts $0 as the explicit free-applications value", () => {
    expect(validateManagerApplicationFeeCents(0)).toEqual({ ok: true, applicationFeeCents: 0 });
  });
  it("accepts a valid >= $1 fee", () => {
    expect(validateManagerApplicationFeeCents(7500)).toEqual({ ok: true, applicationFeeCents: 7500 });
  });
  it("accepts null as clearing the setting", () => {
    expect(validateManagerApplicationFeeCents(null)).toEqual({ ok: true, applicationFeeCents: null });
  });
  it("rejects a non-numeric value", () => {
    expect(validateManagerApplicationFeeCents("50").ok).toBe(false);
    expect(validateManagerApplicationFeeCents(Number.NaN).ok).toBe(false);
  });
  it("rejects an over-cap fee", () => {
    expect(validateManagerApplicationFeeCents(5_000_000).ok).toBe(false);
  });
});

function patchRequest(body: unknown): Request {
  return new Request("http://localhost/api/portal/manager-application-settings", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("PATCH /api/portal/manager-application-settings — invalid fees 400, never save as free", () => {
  beforeEach(() => {
    vi.mocked(loadManagerApplicationSettings).mockResolvedValue(DEFAULT_MANAGER_APPLICATION_SETTINGS);
  });

  it("rejects a non-zero sub-$1 fee with 400", async () => {
    const res = await PATCH(patchRequest({ applicationFeeCents: 50 }));
    expect(res.status).toBe(400);
    const data = (await res.json()) as { error?: string };
    expect(data.error).toMatch(/at least \$1/);
  });
  it("rejects a negative fee with 400", async () => {
    const res = await PATCH(patchRequest({ applicationFeeCents: -100 }));
    expect(res.status).toBe(400);
  });
  it("accepts an explicit $0 (free applications)", async () => {
    const res = await PATCH(patchRequest({ applicationFeeCents: 0 }));
    expect(res.status).toBe(200);
    const data = (await res.json()) as { settings?: { applicationFeeCents: number | null } };
    expect(data.settings).toEqual({ ...DEFAULT_MANAGER_APPLICATION_SETTINGS, applicationFeeCents: 0 });
  });
  it("accepts a valid >= $1 fee", async () => {
    const res = await PATCH(patchRequest({ applicationFeeCents: 7500 }));
    expect(res.status).toBe(200);
    const data = (await res.json()) as { settings?: { applicationFeeCents: number | null } };
    expect(data.settings).toEqual({ ...DEFAULT_MANAGER_APPLICATION_SETTINGS, applicationFeeCents: 7500 });
  });
  it("clears the setting when applicationFeeCents is null", async () => {
    const res = await PATCH(patchRequest({ applicationFeeCents: null }));
    expect(res.status).toBe(200);
    const data = (await res.json()) as { settings?: { applicationFeeCents: number | null } };
    expect(data.settings).toEqual({ ...DEFAULT_MANAGER_APPLICATION_SETTINGS, applicationFeeCents: null });
  });
});

describe("effectiveApplicationFeeCents — per-listing authoritative (option B)", () => {
  it("the listing's own fee WINS over a configured account-wide fee", () => {
    expect(effectiveApplicationFeeCents({ managerFeeCents: 7500, listingFeeCents: 3000 })).toBe(3000);
  });
  it("a per-listing 0 means FREE and does NOT fall through to a non-zero account-wide fee", () => {
    // The load-bearing case: a deliberate per-listing $0 must never reintroduce a charge.
    expect(effectiveApplicationFeeCents({ managerFeeCents: 7500, listingFeeCents: 0 })).toBe(0);
  });
  it("falls back to the account-wide fee (a default) when the listing sets nothing", () => {
    expect(effectiveApplicationFeeCents({ managerFeeCents: 7500, listingFeeCents: null })).toBe(7500);
  });
  it("an account-wide 0 default applies only when the listing is unset", () => {
    expect(effectiveApplicationFeeCents({ managerFeeCents: 0, listingFeeCents: null })).toBe(0);
  });
  it("falls back to the legacy default when neither is set", () => {
    expect(effectiveApplicationFeeCents({ managerFeeCents: null, listingFeeCents: null })).toBe(
      LEGACY_DEFAULT_APPLICATION_FEE_CENTS,
    );
  });
});

function makeDb(opts: { listingFee: string; managerFeeCents: number | null }): SupabaseClient {
  const from = (table: string) => {
    const chain: Record<string, unknown> = {};
    chain.select = () => chain;
    chain.eq = () => chain;
    chain.maybeSingle = async () => {
      if (table === "manager_property_records") {
        return {
          data: {
            manager_user_id: "mgr_A",
            property_data: {
              listingSubmission: { v: 1, applicationFee: opts.listingFee, axisPaymentsEnabled: true, rooms: [], bathrooms: [] },
            },
          },
          error: null,
        };
      }
      if (table === "manager_automation_settings") {
        return {
          data:
            opts.managerFeeCents === null
              ? { row_data: {} }
              : { row_data: { applicationSettings: { applicationFeeCents: opts.managerFeeCents } } },
          error: null,
        };
      }
      return { data: null, error: null };
    };
    return chain;
  };
  return { from } as unknown as SupabaseClient;
}

describe("resolveApplicationFeeProperty — the listing's own fee is authoritative (option B)", () => {
  beforeEach(async () => {
    const actual = await vi.importActual<typeof import("@/lib/manager-application-settings")>(
      "@/lib/manager-application-settings",
    );
    vi.mocked(loadManagerApplicationSettings).mockImplementation(actual.loadManagerApplicationSettings);
  });

  it("charges the LISTING's fee, not the account-wide fee, when the listing sets one", async () => {
    const db = makeDb({ listingFee: "$30", managerFeeCents: 7500 });
    const res = await resolveApplicationFeeProperty(db, { propertyId: "prop_1", managerUserId: "mgr_A" });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value.applicationFeeCents).toBe(3000);
  });

  it("uses the account-wide fee as a default only when the listing sets nothing", async () => {
    const db = makeDb({ listingFee: "", managerFeeCents: 7500 });
    const res = await resolveApplicationFeeProperty(db, { propertyId: "prop_1", managerUserId: "mgr_A" });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value.applicationFeeCents).toBe(7500);
  });

  it("a per-listing $0 is FREE — it rejects rather than falling through to the account-wide fee", async () => {
    const db = makeDb({ listingFee: "$0", managerFeeCents: 7500 });
    const res = await resolveApplicationFeeProperty(db, { propertyId: "prop_1", managerUserId: "mgr_A" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe("NO_APPLICATION_FEE");
  });
});
