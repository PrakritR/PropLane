// Night build (night/vendor-signup): the manager-facing vendor directory
// must never leak private vendor fields (email, phone, policy number, doc
// paths), onboarding save must validate/derive server-side, and "Add to my
// vendors" must be idempotent per manager+vendor pair.
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  resolveOwnVendorRecords: vi.fn(async () => [] as unknown[]),
  isAdminUser: vi.fn(async () => false),
  rosterState: { existingRosterRow: null as Record<string, unknown> | null, inserted: [] as Record<string, unknown>[] },
}));

vi.mock("@/lib/vendor-own-record", () => ({ resolveOwnVendorRecords: mocks.resolveOwnVendorRecords }));
vi.mock("@/lib/auth/admin-preview", () => ({ isAdminUser: mocks.isAdminUser }));
vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: async () => ({
    auth: { getUser: async () => ({ data: { user: { id: "manager-1" } } }) },
  }),
}));
vi.mock("@/lib/supabase/service", () => ({
  createSupabaseServiceRoleClient: () => ({
    from: (table: string) => {
      if (table === "profiles") {
        return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { role: "manager" } }) }) }) };
      }
      if (table === "manager_vendor_records") {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({ maybeSingle: async () => ({ data: mocks.rosterState.existingRosterRow, error: null }) }),
            }),
          }),
          insert: (row: Record<string, unknown>) => {
            mocks.rosterState.inserted.push(row);
            return Promise.resolve({ error: null });
          },
        };
      }
      if (table === "vendor_business_profiles") {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({
                data: {
                  business_name: "Apex Plumbing",
                  work_email: "apex@example.test",
                  work_phone: "+12065550100",
                  trades: ["Plumbing"],
                  directory_listed: true,
                  onboarding_completed_at: "2026-09-25T00:00:00.000Z",
                },
                error: null,
              }),
            }),
          }),
        };
      }
      throw new Error(`unexpected table ${table}`);
    },
  }),
}));

// ── A tiny chainable query-builder fake for vendor_business_profiles-style tables. ──
type ListHandler = () => { data: unknown[]; error: null };

function fakeListDb(list: ListHandler) {
  return {
    from: () => {
      const builder: Record<string, unknown> = {};
      for (const name of ["select", "eq", "not", "order", "limit", "contains"]) {
        builder[name] = () => builder;
      }
      builder.then = (resolve: (v: unknown) => unknown) => Promise.resolve(list()).then(resolve);
      return builder;
    },
  } as never;
}

describe("vendor directory projection — never leaks private fields", () => {
  it("returns only business-safe fields even when the row carries private ones", async () => {
    const { loadDirectoryListedVendors } = await import("@/lib/vendor-directory.server");
    const row = {
      user_id: "vendor-1",
      business_name: "Apex Plumbing LLC",
      service_area: "Seattle, WA",
      service_area_zips: ["98101"],
      trades: ["Plumbing", "HVAC"],
      license_number: "WA-12345",
      insurance_expires_at: "2099-01-01",
      insurance_doc_path: "vendor-documents/vendor-1/onboarding-insurance-1.pdf",
      // Fields that must NEVER reach a manager, even if a future query
      // accidentally over-selects them.
      work_email: "owner@apexplumbing.example",
      work_phone: "+12065550100",
      insurance_policy_number: "POLICY-SECRET-999",
      license_doc_path: "vendor-documents/vendor-1/onboarding-license-1.pdf",
    };
    const db = fakeListDb(() => ({ data: [row], error: null }));

    const rows = await loadDirectoryListedVendors(db);
    expect(rows).toHaveLength(1);
    const projected = rows[0]!;
    expect(projected.name).toBe("Apex Plumbing LLC");
    expect(projected.trades).toEqual(["Plumbing", "HVAC"]);
    expect(projected.licensed).toBe(true);
    expect(projected.insured).toBe(true);
    expect(projected.directoryVendorUserId).toBe("vendor-1");

    const serialized = JSON.stringify(projected);
    for (const secret of ["owner@apexplumbing.example", "+12065550100", "POLICY-SECRET-999", "license_doc_path", "onboarding-insurance-1.pdf"]) {
      expect(serialized).not.toContain(secret);
    }
    expect(projected.email).toBe("");
    expect(projected.phone).toBe("");
    expect(projected).not.toHaveProperty("insurancePolicyNumber");
    expect(projected).not.toHaveProperty("licenseDocPath");
  });

  it("marks a vendor un-insured once their certificate has expired", async () => {
    const { loadDirectoryListedVendors } = await import("@/lib/vendor-directory.server");
    const row = {
      user_id: "vendor-2",
      business_name: "Late Cert Co",
      service_area: "Tacoma, WA",
      service_area_zips: [],
      trades: ["Electrical"],
      license_number: "",
      insurance_expires_at: "2000-01-01",
      insurance_doc_path: "vendor-documents/vendor-2/onboarding-insurance-1.pdf",
    };
    const db = fakeListDb(() => ({ data: [row], error: null }));
    const rows = await loadDirectoryListedVendors(db);
    expect(rows[0]!.insured).toBe(false);
    expect(rows[0]!.licensed).toBe(false);
  });
});

describe("vendor onboarding save — server-side validation and derivation", () => {
  function fakeProfileDb(initial: Record<string, unknown> | null) {
    let stored: Record<string, unknown> | null = initial;
    const db = {
      from: (table: string) => {
        if (table !== "vendor_business_profiles") throw new Error(`unexpected table ${table}`);
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({ data: stored, error: null }),
            }),
          }),
          upsert: (payload: Record<string, unknown>) => {
            stored = { ...(stored ?? {}), ...payload };
            return Promise.resolve({ error: null });
          },
        };
      },
    };
    return { db: db as never, get: () => stored };
  }

  beforeEach(() => {
    mocks.resolveOwnVendorRecords.mockClear();
  });

  it("rejects a service radius outside 1-500 and never writes it", async () => {
    const { saveVendorBusinessProfile } = await import("@/lib/vendor-business-profile.server");
    const { db } = fakeProfileDb(null);
    const result = await saveVendorBusinessProfile(db, "vendor-1", { serviceRadiusMiles: 5000 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(400);
  });

  it("drops a trade outside the allowed VENDOR_TRADE_OPTIONS list", async () => {
    const { saveVendorBusinessProfile } = await import("@/lib/vendor-business-profile.server");
    const { db } = fakeProfileDb(null);
    const result = await saveVendorBusinessProfile(db, "vendor-1", { trades: ["Plumbing", "Not A Real Trade"] });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.profile.trades).toEqual(["Plumbing"]);
  });

  it("filters malformed ZIPs and dedupes", async () => {
    const { saveVendorBusinessProfile } = await import("@/lib/vendor-business-profile.server");
    const { db } = fakeProfileDb(null);
    const result = await saveVendorBusinessProfile(db, "vendor-1", {
      serviceAreaZips: ["98101", "98101", "not-a-zip", "123"],
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.profile.serviceAreaZips).toEqual(["98101"]);
  });

  it("sets onboardingCompletedAt once the checklist minimum is met, server-derived not client-trusted", async () => {
    const { saveVendorBusinessProfile } = await import("@/lib/vendor-business-profile.server");
    const { db } = fakeProfileDb(null);
    const partial = await saveVendorBusinessProfile(db, "vendor-1", { businessName: "Apex" });
    expect(partial.ok).toBe(true);
    if (partial.ok) expect(partial.profile.onboardingCompletedAt).toBeNull();

    const complete = await saveVendorBusinessProfile(db, "vendor-1", {
      trades: ["Plumbing"],
      serviceArea: "Seattle, WA",
    });
    expect(complete.ok).toBe(true);
    if (complete.ok) expect(complete.profile.onboardingCompletedAt).not.toBeNull();
  });

  it("never un-completes onboarding once set, even if a required field is later cleared", async () => {
    const { saveVendorBusinessProfile } = await import("@/lib/vendor-business-profile.server");
    const { db, get } = fakeProfileDb({
      business_name: "Apex",
      trades: ["Plumbing"],
      service_area: "Seattle, WA",
      onboarding_completed_at: "2026-09-25T00:00:00.000Z",
    });
    const result = await saveVendorBusinessProfile(db, "vendor-1", { businessName: "" });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.profile.onboardingCompletedAt).toBe("2026-09-25T00:00:00.000Z");
    expect((get() as Record<string, unknown>).onboarding_completed_at).toBe("2026-09-25T00:00:00.000Z");
  });
});

describe("vendor directory add-to-roster — idempotent per manager+vendor pair", () => {
  beforeEach(() => {
    mocks.isAdminUser.mockClear();
    mocks.rosterState.existingRosterRow = null;
    mocks.rosterState.inserted = [];
  });

  it("inserts a linked roster row on the first call, and returns it unchanged (no duplicate insert) on the second", async () => {
    const { POST } = await import("@/app/api/manager/vendor-directory/add/route");

    const req1 = new Request("http://localhost/api/manager/vendor-directory/add", {
      method: "POST",
      body: JSON.stringify({ vendorUserId: "vendor-1" }),
    });
    const res1 = await POST(req1);
    const body1 = await res1.json();
    expect(res1.status).toBe(200);
    expect(body1.existing).toBe(false);
    expect(body1.row.vendorUserId).toBe("vendor-1");
    expect(mocks.rosterState.inserted).toHaveLength(1);

    // Simulate the row now existing for the idempotency check.
    mocks.rosterState.existingRosterRow = { id: body1.row.id, row_data: body1.row };

    const req2 = new Request("http://localhost/api/manager/vendor-directory/add", {
      method: "POST",
      body: JSON.stringify({ vendorUserId: "vendor-1" }),
    });
    const res2 = await POST(req2);
    const body2 = await res2.json();
    expect(res2.status).toBe(200);
    expect(body2.existing).toBe(true);
    expect(mocks.rosterState.inserted).toHaveLength(1); // still just the one insert
  });
});
