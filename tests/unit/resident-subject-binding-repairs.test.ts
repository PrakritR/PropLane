/**
 * Review-round repairs to the 2026-10-30 auth release, around the one rule the release turns on:
 * a resident row names an Auth subject the server proved, never an email.
 *
 * Each case here is a path the release left closed that should not be:
 *  - a manager's portfolio import / sales migration must still create the tenancy rows while the
 *    resident has no account yet (`invitation_required` is the expected answer, not a failure);
 *  - a manager who files a service FOR a resident off their own roster gets the row bound, so the
 *    resident can actually see and cancel it — and the trigger makes that binding insert-only;
 *  - an application that records its house only in the nested payload still counts as a residency.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { createMemoryDb } from "./support/memory-supabase";
import { provisionApprovedResidentAccount } from "@/lib/auth/provision-approved-resident";
import {
  boundResidentSubjectForManagerHouse,
  residentSubjectHasHouse,
} from "@/lib/auth/resident-subject-evidence.server";

const MANAGER = "11111111-1111-4111-8111-111111111111";
const RESIDENT = "22222222-2222-4222-8222-222222222222";
const OTHER = "33333333-3333-4333-8333-333333333333";

describe("provisionApprovedResidentAccount refuses with a reason the importers expect", () => {
  it("names invitation_required for an approved row, so a caller can tell it from a failure", async () => {
    const db = createMemoryDb({});
    const result = await provisionApprovedResidentAccount(
      db as never,
      { id: "PROPLANE-1", bucket: "approved", email: "resident@example.test" } as never,
      { mode: "silent_migration" },
    );
    expect(result).toMatchObject({ ok: false, reason: "invitation_required" });
  });

  it("still has no reason for a row that is not eligible at all", async () => {
    const db = createMemoryDb({});
    const notApproved = await provisionApprovedResidentAccount(
      db as never,
      { id: "PROPLANE-2", bucket: "pending", email: "resident@example.test" } as never,
    );
    expect(notApproved).toEqual({ ok: false, error: "Application is not approved." });
    const noEmail = await provisionApprovedResidentAccount(
      db as never,
      { id: "PROPLANE-3", bucket: "approved", email: "" } as never,
    );
    expect(noEmail).toMatchObject({ ok: false });
    expect((noEmail as { reason?: string }).reason).toBeUndefined();
  });

  /**
   * `executeSalesMigration` has no unit harness (it drives `previewSalesMigration`, the per-step
   * audit log and a revision-pinned relink), so its half of the repair is pinned statically. The
   * portfolio-import half is exercised end to end in `portfolio-import-create.test.ts`.
   */
  it("the sales migration accepts invitation_required and still writes the tenancy", () => {
    const source = readFileSync("src/lib/sales-migration/server.ts", "utf8");
    expect(source).toMatch(/!provisioned\.ok && provisioned\.reason !== "invitation_required"/);
    expect(source).not.toMatch(/if \(!provisioned\.ok\) throw/);
    // The application insert and the lease onboarding still run after the refusal.
    const step = source.slice(source.indexOf("provisionApprovedResidentAccount"));
    expect(step.indexOf('.from("manager_application_records").insert(')).toBeGreaterThan(-1);
    expect(step.indexOf("runExistingResidentOnboarding")).toBeGreaterThan(-1);
    // An unbound tenancy carries no subject rather than `undefined` masquerading as one.
    expect(source).toContain("...(residentUserId ? { residentUserId } : {})");
  });

  it("the portfolio import accepts invitation_required and reports no account", () => {
    const source = readFileSync("src/lib/portfolio-import/create.server.ts", "utf8");
    expect(source).toMatch(/!provision\.ok && provision\.reason !== "invitation_required"/);
    expect(source).not.toMatch(/if \(!provision\.ok\) throw/);
    expect(source).toContain("const residentUserId = provision.ok ? provision.userId : null;");
  });
});

describe("boundResidentSubjectForManagerHouse", () => {
  const application = (overrides: Record<string, unknown>) => ({
    id: "PROPLANE-A",
    manager_user_id: MANAGER,
    resident_email: "resident@example.test",
    property_id: "prop-1",
    assigned_property_id: "prop-1",
    row_data: { residentUserId: RESIDENT, bucket: "approved" },
    ...overrides,
  });

  it("returns the subject the manager's own application row already binds", async () => {
    const db = createMemoryDb({ manager_application_records: [application({})], portal_lease_pipeline_records: [] });
    await expect(
      boundResidentSubjectForManagerHouse(db as never, {
        managerUserId: MANAGER,
        propertyId: "prop-1",
        residentEmail: "Resident@Example.test",
      }),
    ).resolves.toBe(RESIDENT);
  });

  it("binds nothing for a resident of another manager's house", async () => {
    const db = createMemoryDb({
      manager_application_records: [application({ manager_user_id: OTHER })],
      portal_lease_pipeline_records: [],
    });
    await expect(
      boundResidentSubjectForManagerHouse(db as never, {
        managerUserId: MANAGER,
        propertyId: "prop-1",
        residentEmail: "resident@example.test",
      }),
    ).resolves.toBeNull();
  });

  it("binds nothing for a different house under the same manager", async () => {
    const db = createMemoryDb({ manager_application_records: [application({})], portal_lease_pipeline_records: [] });
    await expect(
      boundResidentSubjectForManagerHouse(db as never, {
        managerUserId: MANAGER,
        propertyId: "prop-2",
        residentEmail: "resident@example.test",
      }),
    ).resolves.toBeNull();
  });

  it("binds nothing from an application that carries no proven subject", async () => {
    const db = createMemoryDb({
      manager_application_records: [application({ row_data: { bucket: "approved" } })],
      portal_lease_pipeline_records: [],
    });
    await expect(
      boundResidentSubjectForManagerHouse(db as never, {
        managerUserId: MANAGER,
        propertyId: "prop-1",
        residentEmail: "resident@example.test",
      }),
    ).resolves.toBeNull();
  });

  it("binds nothing from a withdrawn or rejected residency", async () => {
    for (const row_data of [
      { residentUserId: RESIDENT, bucket: "approved", withdrawnAt: "2026-10-01T00:00:00Z" },
      { residentUserId: RESIDENT, bucket: "rejected" },
    ]) {
      const db = createMemoryDb({
        manager_application_records: [application({ row_data })],
        portal_lease_pipeline_records: [],
      });
      await expect(
        boundResidentSubjectForManagerHouse(db as never, {
          managerUserId: MANAGER,
          propertyId: "prop-1",
          residentEmail: "resident@example.test",
        }),
      ).resolves.toBeNull();
    }
  });

  it("falls back to a lease that already carries the subject", async () => {
    const db = createMemoryDb({
      manager_application_records: [],
      portal_lease_pipeline_records: [
        {
          id: "lease-1",
          manager_user_id: MANAGER,
          property_id: "prop-1",
          resident_email: "resident@example.test",
          resident_user_id: RESIDENT,
        },
      ],
    });
    await expect(
      boundResidentSubjectForManagerHouse(db as never, {
        managerUserId: MANAGER,
        propertyId: "prop-1",
        residentEmail: "resident@example.test",
      }),
    ).resolves.toBe(RESIDENT);
  });

  /**
   * `resident_email` is stored as the writer received it — `manager_application_records` carries a
   * plain index on the raw column and `portal_lease_pipeline_records` carries a `lower(...)` one
   * precisely because mixed case exists. An equality match on a lowercased needle therefore found
   * nothing for those residents, and the row was persisted unbound and unbindable forever.
   */
  it("matches a stored address whatever its case, on the application", async () => {
    const db = createMemoryDb({
      manager_application_records: [application({ resident_email: "John@Example.TEST" })],
      portal_lease_pipeline_records: [],
    });
    for (const typed of ["john@example.test", "John@Example.TEST", "  JOHN@EXAMPLE.test  "]) {
      await expect(
        boundResidentSubjectForManagerHouse(db as never, { managerUserId: MANAGER, propertyId: "prop-1", residentEmail: typed }),
      ).resolves.toBe(RESIDENT);
    }
  });

  it("matches a stored address whatever its case, on the lease", async () => {
    const db = createMemoryDb({
      manager_application_records: [],
      portal_lease_pipeline_records: [
        {
          id: "lease-1",
          manager_user_id: MANAGER,
          property_id: "prop-1",
          resident_email: "John@Example.TEST",
          resident_user_id: RESIDENT,
        },
      ],
    });
    await expect(
      boundResidentSubjectForManagerHouse(db as never, { managerUserId: MANAGER, propertyId: "prop-1", residentEmail: "john@example.test" }),
    ).resolves.toBe(RESIDENT);
  });

  it("does not let a wildcard in the typed address match another resident", async () => {
    // ONE other residency, so an unescaped `_` / `%` would match it alone and bind OTHER — the
    // ambiguity guard would not save us. Escaped, the pattern is a literal address that matches
    // nothing, and the row stays manager-only.
    const db = createMemoryDb({
      manager_application_records: [
        application({ id: "PROPLANE-B", resident_email: "b@example.test", row_data: { residentUserId: OTHER, bucket: "approved" } }),
      ],
      portal_lease_pipeline_records: [],
    });
    for (const typed of ["_@example.test", "%@example.test"]) {
      await expect(
        boundResidentSubjectForManagerHouse(db as never, { managerUserId: MANAGER, propertyId: "prop-1", residentEmail: typed }),
      ).resolves.toBeNull();
    }
    // The same store still binds the exact address, so the refusal above is the escape, not the fixture.
    await expect(
      boundResidentSubjectForManagerHouse(db as never, { managerUserId: MANAGER, propertyId: "prop-1", residentEmail: "B@Example.test" }),
    ).resolves.toBe(OTHER);
  });

  it("refuses to pick when two subjects answer to the same address", async () => {
    const db = createMemoryDb({
      manager_application_records: [
        application({}),
        application({ id: "PROPLANE-B", resident_email: "RESIDENT@example.test", row_data: { residentUserId: OTHER, bucket: "approved" } }),
      ],
      portal_lease_pipeline_records: [],
    });
    await expect(
      boundResidentSubjectForManagerHouse(db as never, {
        managerUserId: MANAGER,
        propertyId: "prop-1",
        residentEmail: "resident@example.test",
      }),
    ).resolves.toBeNull();
  });
});

describe("residentSubjectHasHouse reads every place an application records the house", () => {
  it("accepts a residency whose house is only in the nested application payload", async () => {
    const db = createMemoryDb({
      manager_application_records: [
        {
          id: "PROPLANE-NESTED",
          manager_user_id: MANAGER,
          resident_email: "resident@example.test",
          property_id: null,
          assigned_property_id: null,
          row_data: { residentUserId: RESIDENT, bucket: "approved", application: { propertyId: "prop-1" } },
        },
      ],
      portal_household_charge_records: [],
      portal_lease_pipeline_records: [],
    });
    await expect(
      residentSubjectHasHouse(db as never, RESIDENT, "resident@example.test", MANAGER, "prop-1"),
    ).resolves.toBe(true);
  });

  it("accepts a residency whose house is only in row_data.assignedPropertyId", async () => {
    const db = createMemoryDb({
      manager_application_records: [
        {
          id: "PROPLANE-ASSIGNED",
          manager_user_id: MANAGER,
          resident_email: "resident@example.test",
          property_id: null,
          assigned_property_id: null,
          row_data: { residentUserId: RESIDENT, bucket: "approved", assignedPropertyId: "prop-1" },
        },
      ],
      portal_household_charge_records: [],
      portal_lease_pipeline_records: [],
    });
    await expect(
      residentSubjectHasHouse(db as never, RESIDENT, "resident@example.test", MANAGER, "prop-1"),
    ).resolves.toBe(true);
  });

  it("still refuses a house the residency does not name", async () => {
    const db = createMemoryDb({
      manager_application_records: [
        {
          id: "PROPLANE-ELSEWHERE",
          manager_user_id: MANAGER,
          resident_email: "resident@example.test",
          property_id: "prop-9",
          assigned_property_id: null,
          row_data: { residentUserId: RESIDENT, bucket: "approved" },
        },
      ],
      portal_household_charge_records: [],
      portal_lease_pipeline_records: [],
    });
    await expect(
      residentSubjectHasHouse(db as never, RESIDENT, "resident@example.test", MANAGER, "prop-1"),
    ).resolves.toBe(false);
  });
});

describe("the service routes bind a manager-filed row at INSERT only", () => {
  const read = (path: string) => readFileSync(path, "utf8");

  it("derives the subject from a residency, never from the request", () => {
    for (const path of [
      "src/app/api/portal-work-orders/route.ts",
      "src/app/api/portal-service-requests/route.ts",
    ]) {
      const source = read(path);
      expect(source, path).toContain("boundResidentSubjectForManagerHouse");
      // The subject is only ever resolved for a row with no existing record: 20261030144600's
      // trigger raises 'Existing service subject cannot be assigned' on any later assignment.
      expect(source, path).toMatch(/if \(existing[^)]*\) return null;/);
    }
  });

  it("keeps an existing row's stored subject and the resident's own id untouched", () => {
    const workOrders = read("src/app/api/portal-work-orders/route.ts");
    expect(workOrders).toContain('actor.role === "resident" && !actor.admin\n      ? actor.userId');
    expect(workOrders).toContain("previous.resident_user_id ?? null");
  });
});
