/**
 * The `/demo` sandbox has TWO data sources: the static "Seattle Homes"
 * snapshot in `demo-guided-data.ts` and the `/api/demo/portal-snapshot`
 * mirror of the canonical `@test.proplane.local` accounts' real DB rows
 * (captain 2026-09-25 — both back on, see `demo-mirror-flag.ts`).
 *
 * Despite the filename (kept so history/blame stays attached), this file now
 * asserts the OPPOSITE of "off": the mirror flag is on, the static fallback
 * is populated, and seeding the canonical portfolio writes real rows — with
 * one invariant unchanged and still the point of the file: seeding that
 * portfolio must never upsert the two deployment-wide schedule singletons
 * unless a caller opts in, because those singletons hold every OTHER
 * account's real prospect tour requests too.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase/service", () => ({
  createSupabaseServiceRoleClient: vi.fn(() => {
    throw new Error("this test never opens a real database client");
  }),
}));

import { DEMO_PORTAL_MIRROR_ENABLED } from "@/lib/demo/demo-mirror-flag";
import { buildStaticDemoPortalSnapshot } from "@/lib/demo/demo-portal-mirror.server";
import { buildDemoIdleSnapshot } from "@/lib/demo/demo-guided-data";
import { seedCanonicalDemoPortfolio } from "@/lib/demo/canonical-demo-portfolio-db";
import { CANONICAL_DEMO_RESIDENT_EMAIL, CANONICAL_DEMO_VENDOR_EMAIL } from "@/lib/demo/demo-canonical-accounts";

describe("demo portal mirror flag", () => {
  it("is on, so the sandbox may serve the canonical accounts' real rows", () => {
    expect(DEMO_PORTAL_MIRROR_ENABLED).toBe(true);
  });

  it("falls through to the Seattle Homes static snapshot, not an empty one", () => {
    const snapshot = buildStaticDemoPortalSnapshot();
    expect(snapshot.properties.length).toBeGreaterThan(0);
    expect(snapshot.properties.map((p) => p.title)).toEqual(
      expect.arrayContaining(["Alder House", "Maple Duplex", "Fremont Studio"]),
    );
    expect(snapshot.leases.length).toBeGreaterThan(0);
    expect(snapshot.charges.length).toBeGreaterThan(0);
    expect(snapshot.applications.length).toBeGreaterThan(0);
    // Same source as buildDemoIdleSnapshot() (a thin passthrough) — compare
    // property ids rather than the whole object: both build their charge/lease
    // timestamps from `Date.now()`, so two independent calls are not
    // guaranteed byte-identical across a millisecond boundary.
    const idle = buildDemoIdleSnapshot();
    expect(idle.properties.map((p) => p.id).sort()).toEqual(snapshot.properties.map((p) => p.id).sort());
  });
});

/**
 * Minimal recording stub. Every seeder WRITE funnels through `.upsert()`; the
 * only READ is the AXIS-id reclaim (PRP-357), which looks for another profile
 * holding the resident's axis id. This stub answers "nobody else holds it"
 * (`data: null`), the case that must still write exactly one `profiles` row.
 */
function recordingDb() {
  const upserts: { table: string; rows: unknown[] }[] = [];
  const reads: string[] = [];
  const db = {
    from(table: string) {
      const rowQuery = {
        eq: () => rowQuery,
        neq: () => rowQuery,
        maybeSingle: () => Promise.resolve({ data: null, error: null }),
        then: (resolve: (value: { data: null; error: null }) => unknown) =>
          Promise.resolve({ data: null, error: null }).then(resolve),
      };
      return {
        upsert(rows: unknown[]) {
          upserts.push({ table, rows: Array.isArray(rows) ? rows : [rows] });
          return Promise.resolve({ data: null, error: null });
        },
        select(columns: string) {
          reads.push(`${table}(${columns})`);
          return rowQuery;
        },
        update() {
          return rowQuery;
        },
      };
    },
  };
  return { db, upserts, reads };
}

describe("seeding the Seattle Homes demo portfolio", () => {
  const ctx = {
    managerUserId: "00000000-0000-4000-8000-00000000mgr1".slice(0, 36),
    residentUserId: "00000000-0000-4000-8000-000000000res",
    vendorUserId: "00000000-0000-4000-8000-000000000ven",
    residentEmail: CANONICAL_DEMO_RESIDENT_EMAIL,
    vendorEmail: CANONICAL_DEMO_VENDOR_EMAIL,
    residentAxisId: "AXIS-TESTRSID",
  };

  it("writes real portfolio rows, not just the account profiles", async () => {
    const { db, upserts } = recordingDb();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await seedCanonicalDemoPortfolio(db as any, ctx, { skipGlobalScheduleSingletons: true });
    const tables = new Set(upserts.map((u) => u.table));
    expect(tables.has("profiles")).toBe(true);
    expect(tables.has("manager_property_records")).toBe(true);
    expect(tables.has("portal_lease_pipeline_records")).toBe(true);
    expect(tables.has("portal_household_charge_records")).toBe(true);
    expect(tables.has("manager_application_records")).toBe(true);
  });

  it("never upserts the deployment-wide schedule singletons when asked to skip them", async () => {
    const { db, upserts } = recordingDb();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await seedCanonicalDemoPortfolio(db as any, ctx, { skipGlobalScheduleSingletons: true });
    const scheduleWrites = upserts.filter((u) => u.table === "portal_schedule_records").flatMap((u) => u.rows);
    const singletonIds = new Set(["axis_admin_planned_events_v1", "axis_admin_partner_inquiries_v1"]);
    expect(scheduleWrites.some((row) => singletonIds.has((row as { id?: string }).id ?? ""))).toBe(false);
    // The one real tour still lands as its own row.
    expect(scheduleWrites.length).toBeGreaterThan(0);
  });
});
