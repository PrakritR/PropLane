/**
 * The `/demo` sandbox has TWO data sources: the static snapshot in
 * `demo-guided-data.ts` (now empty) and the `/api/demo/portal-snapshot` mirror
 * of the canonical `@test.proplane.local` accounts' real DB rows. Emptying only the
 * first would still leave a deployed `/demo` showing whatever those accounts
 * hold, so `DEMO_PORTAL_MIRROR_ENABLED` turns the mirror off.
 *
 * These are the two invariants that keep the sandbox clean and safe but cannot
 * be observed from the running app without live Supabase credentials:
 *
 * 1. With the flag off, both mirror readers return `null` WITHOUT touching the
 *    database — so the route falls through to the empty static snapshot in every
 *    environment, regardless of what the canonical accounts contain.
 * 2. Seeding the (now empty) idle snapshot writes NOTHING — in particular it must
 *    not upsert the two deployment-wide schedule singletons with an empty
 *    payload, which would delete real prospect tour requests in production.
 */
import { describe, expect, it, vi } from "vitest";

const { createServiceRoleClient } = vi.hoisted(() => ({
  createServiceRoleClient: vi.fn(() => {
    throw new Error("createSupabaseServiceRoleClient() must not be called while the demo mirror is off");
  }),
}));

vi.mock("@/lib/supabase/service", () => ({
  createSupabaseServiceRoleClient: createServiceRoleClient,
}));

import { DEMO_PORTAL_MIRROR_ENABLED } from "@/lib/demo/demo-mirror-flag";
import {
  buildStaticDemoPortalSnapshot,
  fetchDemoGuidedMirrorSnapshot,
  fetchDemoPortalMirrorSnapshot,
} from "@/lib/demo/demo-portal-mirror.server";
import { seedCanonicalDemoPortfolio } from "@/lib/demo/canonical-demo-portfolio-db";
import { CANONICAL_DEMO_RESIDENT_EMAIL, CANONICAL_DEMO_VENDOR_EMAIL } from "@/lib/demo/demo-canonical-accounts";

describe("demo portal mirror flag", () => {
  it("is off, so the sandbox cannot serve the canonical accounts' rows", () => {
    expect(DEMO_PORTAL_MIRROR_ENABLED).toBe(false);
  });

  it("returns null from both mirror readers without opening a database client", async () => {
    await expect(fetchDemoPortalMirrorSnapshot()).resolves.toBeNull();
    await expect(fetchDemoGuidedMirrorSnapshot()).resolves.toBeNull();
    expect(createServiceRoleClient).not.toHaveBeenCalled();
  });

  it("falls through to a static snapshot with no records in any bucket", () => {
    const snapshot = buildStaticDemoPortalSnapshot();
    const rowCounts = Object.entries(snapshot).flatMap(([key, value]) =>
      Array.isArray(value) ? [[key, value.length] as const] : [],
    );
    expect(rowCounts.length).toBeGreaterThan(10);
    expect(rowCounts.filter(([, count]) => count > 0)).toEqual([]);
    expect(snapshot.schedule.plannedEvents).toEqual([]);
    expect(snapshot.schedule.partnerInquiries).toEqual([]);
  });
});

/**
 * Minimal recording stub. Every seeder WRITE funnels through `.upsert()`; the
 * only READ is the AXIS-id reclaim (PRP-357), which looks for another profile
 * holding the resident's axis id. This stub answers "nobody else holds it"
 * (`data: null`), the case that must still write exactly one `profiles` row.
 *
 * `reads` is asserted below so a future seeder read cannot silently pass
 * through a stub that does not model it — that is how this double last drifted.
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

describe("seeding the empty demo portfolio", () => {
  const ctx = {
    managerUserId: "00000000-0000-4000-8000-00000000mgr1".slice(0, 36),
    residentUserId: "00000000-0000-4000-8000-000000000res",
    vendorUserId: "00000000-0000-4000-8000-000000000ven",
    residentEmail: CANONICAL_DEMO_RESIDENT_EMAIL,
    vendorEmail: CANONICAL_DEMO_VENDOR_EMAIL,
    residentAxisId: "AXIS-TESTRSID",
  };

  it("writes only the account profile rows — no portfolio records", async () => {
    const { db, upserts, reads } = recordingDb();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await seedCanonicalDemoPortfolio(db as any, ctx);
    expect(upserts.map((u) => u.table)).toEqual(["profiles"]);
    // The one read the seeder makes: the AXIS-id reclaim (PRP-357).
    expect(reads).toEqual(["profiles(id, email)"]);
  });

  it("never upserts the deployment-wide schedule singletons with an empty payload", async () => {
    const { db, upserts } = recordingDb();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await seedCanonicalDemoPortfolio(db as any, ctx);
    const scheduleWrites = upserts.filter((u) => u.table === "portal_schedule_records");
    expect(scheduleWrites).toEqual([]);
  });
});
