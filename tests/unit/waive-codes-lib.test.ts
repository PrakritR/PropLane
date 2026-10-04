/**
 * MONEY (library half): waive codes that cover the lease fee or several properties never disturb the single
 * Application promo-code field, and a manager edits only their own active codes within the rules the redeem
 * enforces.
 */
import { describe, expect, it } from "vitest";
import {
  createApplicationFeeWaiverCode,
  lookupWaiverCodeForFee,
  pickPortfolioApplicationFeeWaiverCode,
  pickPrimaryApplicationFeeWaiverCode,
  previewApplicationFeeWaiverCode,
  setPrimaryApplicationFeeWaiverCode,
  updateApplicationFeeWaiverCode,
  upsertPropertyApplicationFeeWaiverCode,
  waiverCodeAppliesToFee,
  waiverCodeCoversProperty,
} from "@/lib/application-fee-waiver";
import { fakeSupabaseClient, type Row } from "./helpers/fake-supabase-tables";

const MANAGER = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";

let n = 0;
function codeRow(over: Record<string, unknown>): Row {
  n += 1;
  return {
    id: `code-${n}`,
    manager_user_id: MANAGER,
    code: "X",
    code_normalized: "X",
    label: null,
    property_id: null,
    property_ids: null,
    applies_to: "application",
    status: "active",
    max_uses: null,
    used_count: 0,
    expires_at: null,
    created_at: `2026-10-0${Math.min(n, 9)}T00:00:00.000Z`,
    revoked_at: null,
    ...over,
  };
}

function setup(rows: Row[]) {
  const tables: Record<string, Row[]> = { manager_application_fee_waiver_codes: rows };
  return { tables, db: fakeSupabaseClient(tables) as never };
}
const statusOf = (tables: Record<string, Row[]>, code: string) =>
  tables.manager_application_fee_waiver_codes!.find((r) => r.code === code)!.status;

describe("the pure rules the SQL functions mirror", () => {
  it("applies_to: an old row with no value is an application code", () => {
    expect(waiverCodeAppliesToFee(undefined, "application")).toBe(true);
    expect(waiverCodeAppliesToFee(undefined, "lease")).toBe(false);
    expect(waiverCodeAppliesToFee("lease", "application")).toBe(false);
    expect(waiverCodeAppliesToFee("lease", "lease")).toBe(true);
    expect(waiverCodeAppliesToFee("both", "application")).toBe(true);
    expect(waiverCodeAppliesToFee("both", "lease")).toBe(true);
    expect(waiverCodeAppliesToFee("nonsense", "lease")).toBe(false);
  });

  it("properties: the list, else the legacy pin, else everywhere", () => {
    expect(waiverCodeCoversProperty({ propertyIds: ["a", "b"], propertyId: "old" }, "b")).toBe(true);
    expect(waiverCodeCoversProperty({ propertyIds: ["a", "b"], propertyId: "old" }, "old")).toBe(false);
    expect(waiverCodeCoversProperty({ propertyIds: [], propertyId: "old" }, "old")).toBe(true);
    expect(waiverCodeCoversProperty({ propertyIds: [], propertyId: "old" }, "new")).toBe(false);
    expect(waiverCodeCoversProperty({ propertyIds: null, propertyId: null }, "anything")).toBe(true);
  });
});

describe("lookup: which code a resident typed, for which fee, on which property", () => {
  it("answers per fee and per property, and names why a real code cannot be spent", async () => {
    const { db } = setup([
      codeRow({ code: "LEASEONLY", code_normalized: "LEASEONLY", applies_to: "lease" }),
      codeRow({ code: "HOUSEAB", code_normalized: "HOUSEAB", applies_to: "both", property_ids: ["a", "b"] }),
      codeRow({ code: "OLDAPP", code_normalized: "OLDAPP" }),
      codeRow({ code: "GONE", code_normalized: "GONE", applies_to: "lease", status: "revoked" }),
      codeRow({ code: "FULL", code_normalized: "FULL", applies_to: "lease", max_uses: 2, used_count: 2 }),
    ]);
    const look = (code: string, propertyId: string, fee: "application" | "lease") =>
      lookupWaiverCodeForFee(db, { managerUserId: MANAGER, code, propertyId, fee });

    expect(await look("leaseonly", "a", "lease")).toMatchObject({ ok: true });
    expect(await look("LEASEONLY", "a", "application")).toMatchObject({ ok: false, reason: "NOT_FOUND" });
    expect(await look("HOUSEAB", "b", "application")).toMatchObject({ ok: true });
    expect(await look("HOUSEAB", "b", "lease")).toMatchObject({ ok: true });
    expect(await look("HOUSEAB", "c", "lease")).toMatchObject({ ok: false, reason: "NOT_FOUND" });
    expect(await look("OLDAPP", "a", "application")).toMatchObject({ ok: true });
    expect(await look("OLDAPP", "a", "lease")).toMatchObject({ ok: false, reason: "NOT_FOUND" });
    expect(await look("GONE", "a", "lease")).toMatchObject({ ok: false, reason: "REVOKED" });
    expect(await look("FULL", "a", "lease")).toMatchObject({ ok: false, reason: "EXHAUSTED" });
    // Another manager's text never resolves.
    expect(await lookupWaiverCodeForFee(db, { managerUserId: OTHER, code: "LEASEONLY", propertyId: "a", fee: "lease" })).toMatchObject({
      ok: false,
      reason: "NOT_FOUND",
    });
  });

  it("the application preview stays application-only", async () => {
    const { db } = setup([codeRow({ code: "LEASEONLY", code_normalized: "LEASEONLY", applies_to: "lease" })]);
    expect(await previewApplicationFeeWaiverCode(db, MANAGER, "LEASEONLY", "a")).toMatchObject({ ok: false, reason: "NOT_FOUND" });
  });

  it("a lookup the database could not answer is UNAVAILABLE, never 'not found'", async () => {
    const broken = {
      from: () => ({
        select: () => ({ eq: () => ({ eq: async () => ({ data: null, error: { message: "boom" } }) }) }),
      }),
    } as never;
    expect(await lookupWaiverCodeForFee(broken, { managerUserId: MANAGER, code: "ANYCODE", propertyId: "a", fee: "lease" })).toMatchObject({
      ok: false,
      reason: "UNAVAILABLE",
    });
  });
});

describe("the single Application promo field leaves lease and limited codes alone", () => {
  const rows = () => [
    codeRow({ code: "PROMO", code_normalized: "PROMO" }),
    codeRow({ code: "LEASEONLY", code_normalized: "LEASEONLY", applies_to: "lease" }),
    codeRow({ code: "BOTH", code_normalized: "BOTH", applies_to: "both" }),
    codeRow({ code: "LIMITED", code_normalized: "LIMITED", property_ids: ["a", "b"] }),
  ];

  it("clearing the field revokes only the application promo", async () => {
    const { db, tables } = setup(rows());
    const result = await setPrimaryApplicationFeeWaiverCode(db, MANAGER, "");
    expect(result).toEqual({ ok: true, code: null });
    expect(statusOf(tables, "PROMO")).toBe("revoked");
    expect(statusOf(tables, "LEASEONLY")).toBe("active");
    expect(statusOf(tables, "BOTH")).toBe("active");
    expect(statusOf(tables, "LIMITED")).toBe("active");
  });

  it("the field never lists them as its code", () => {
    const codes = rows().map((r) => ({
      id: String(r.id),
      managerUserId: MANAGER,
      code: String(r.code),
      label: null,
      propertyId: null,
      propertyIds: (r.property_ids as string[] | null) ?? [],
      appliesTo: r.applies_to as "application" | "lease" | "both",
      status: "active" as const,
      maxUses: null,
      usedCount: 0,
      expiresAt: null,
      createdAt: String(r.created_at),
      revokedAt: null,
    }));
    expect(pickPrimaryApplicationFeeWaiverCode(codes)?.code).toBe("PROMO");
    expect(pickPortfolioApplicationFeeWaiverCode(codes)?.code).toBe("PROMO");
    expect(pickPrimaryApplicationFeeWaiverCode(codes.filter((c) => c.code !== "PROMO"))).toBeNull();
  });

  it("typing a lease or limited code's text into the field is refused, and nothing is taken over", async () => {
    for (const text of ["LEASEONLY", "BOTH", "LIMITED"]) {
      const { db, tables } = setup(rows());
      const result = await setPrimaryApplicationFeeWaiverCode(db, MANAGER, text);
      expect(result.ok).toBe(false);
      expect(statusOf(tables, "PROMO")).toBe("active");
      const row = tables.manager_application_fee_waiver_codes!.find((r) => r.code === text)!;
      expect(row.applies_to).toBe({ LEASEONLY: "lease", BOTH: "both", LIMITED: "application" }[text]);
      expect(row.property_ids).toEqual(text === "LIMITED" ? ["a", "b"] : null);
    }
  });

  it("a per-property promo write never touches a lease code, even one limited to that property", async () => {
    const { db, tables } = setup([
      codeRow({ code: "LEASEHOUSE", code_normalized: "LEASEHOUSE", applies_to: "lease", property_ids: ["prop-1"] }),
    ]);
    const result = await upsertPropertyApplicationFeeWaiverCode(db, MANAGER, "prop-1", "NEWPROMO");
    expect(result.ok).toBe(true);
    expect(statusOf(tables, "LEASEHOUSE")).toBe("active");
    const cleared = await upsertPropertyApplicationFeeWaiverCode(db, MANAGER, "prop-1", "");
    expect(cleared.ok).toBe(true);
    expect(statusOf(tables, "LEASEHOUSE")).toBe("active");
  });
});

describe("creating a code", () => {
  it("defaults to the application fee and every property, so an old caller is unchanged", async () => {
    const { db, tables } = setup([]);
    const result = await createApplicationFeeWaiverCode(db, MANAGER, { code: "plain-one" });
    expect(result.ok && result.code).toMatchObject({ code: "PLAIN-ONE", appliesTo: "application", propertyIds: [] });
    expect(tables.manager_application_fee_waiver_codes![0]).toMatchObject({ applies_to: "application", property_ids: null });
  });

  it("stores what it applies to and a de-duplicated property list", async () => {
    const { db, tables } = setup([]);
    const result = await createApplicationFeeWaiverCode(db, MANAGER, {
      code: "LEASE-DEAL",
      appliesTo: "both",
      propertyIds: [" prop-1 ", "prop-2", "prop-1", ""],
      maxUses: 20,
    });
    expect(result.ok && result.code).toMatchObject({ appliesTo: "both", propertyIds: ["prop-1", "prop-2"], maxUses: 20 });
    expect(tables.manager_application_fee_waiver_codes![0]).toMatchObject({ applies_to: "both", property_ids: ["prop-1", "prop-2"] });
  });

  it("refuses an unknown applies_to and a malformed property list, writing nothing", async () => {
    const { db, tables } = setup([]);
    expect(await createApplicationFeeWaiverCode(db, MANAGER, { code: "BAD-KIND", appliesTo: "deposit" as never })).toMatchObject({ ok: false });
    expect(await createApplicationFeeWaiverCode(db, MANAGER, { code: "BAD-LIST", propertyIds: "prop-1" as never })).toMatchObject({ ok: false });
    expect(await createApplicationFeeWaiverCode(db, MANAGER, { code: "BAD-ITEM", propertyIds: [5] as never })).toMatchObject({ ok: false });
    expect(tables.manager_application_fee_waiver_codes).toHaveLength(0);
  });
});

describe("editing a code", () => {
  const future = new Date(Date.now() + 30 * 86_400_000).toISOString();

  it("changes what it applies to, its property limit, cap and expiry", async () => {
    const { db, tables } = setup([codeRow({ id: "c1", code: "EDITME", code_normalized: "EDITME", property_id: "legacy-pin", used_count: 2 })]);
    const result = await updateApplicationFeeWaiverCode(db, MANAGER, "c1", {
      appliesTo: "both",
      propertyIds: ["prop-1", "prop-2"],
      maxUses: 10,
      expiresAt: future,
    });
    expect(result.ok && result.code).toMatchObject({ appliesTo: "both", propertyIds: ["prop-1", "prop-2"], maxUses: 10, propertyId: null });
    expect(tables.manager_application_fee_waiver_codes![0]).toMatchObject({ applies_to: "both", property_id: null, max_uses: 10 });
  });

  it("an empty list opens a limited code up to every property; null clears the cap and expiry", async () => {
    const { db } = setup([
      codeRow({ id: "c1", code: "OPENUP", code_normalized: "OPENUP", property_ids: ["a"], max_uses: 3, expires_at: future }),
    ]);
    const result = await updateApplicationFeeWaiverCode(db, MANAGER, "c1", { propertyIds: [], maxUses: null, expiresAt: null });
    expect(result.ok && result.code).toMatchObject({ propertyIds: [], maxUses: null, expiresAt: null });
  });

  it("the cap cannot drop below the uses already spent", async () => {
    const { db, tables } = setup([codeRow({ id: "c1", code: "SPENT", code_normalized: "SPENT", used_count: 4, max_uses: 10 })]);
    const result = await updateApplicationFeeWaiverCode(db, MANAGER, "c1", { maxUses: 3 });
    expect(result).toMatchObject({ ok: false, status: 400 });
    expect(tables.manager_application_fee_waiver_codes![0]!.max_uses).toBe(10);
    expect(await updateApplicationFeeWaiverCode(db, MANAGER, "c1", { maxUses: 4 })).toMatchObject({ ok: true });
  });

  it("refuses a past expiry, an unknown applies_to, and a zero cap", async () => {
    const { db } = setup([codeRow({ id: "c1", code: "RULES", code_normalized: "RULES" })]);
    expect(await updateApplicationFeeWaiverCode(db, MANAGER, "c1", { expiresAt: "2020-01-01T00:00:00Z" })).toMatchObject({ ok: false, status: 400 });
    expect(await updateApplicationFeeWaiverCode(db, MANAGER, "c1", { appliesTo: "deposit" as never })).toMatchObject({ ok: false, status: 400 });
    expect(await updateApplicationFeeWaiverCode(db, MANAGER, "c1", { maxUses: 0 })).toMatchObject({ ok: false, status: 400 });
  });

  it("never edits a revoked code, another manager's code, or the code text", async () => {
    const { db, tables } = setup([
      codeRow({ id: "gone", code: "GONE", code_normalized: "GONE", status: "revoked" }),
      codeRow({ id: "mine", code: "MINE", code_normalized: "MINE" }),
    ]);
    expect(await updateApplicationFeeWaiverCode(db, MANAGER, "gone", { appliesTo: "both" })).toMatchObject({ ok: false, status: 409 });
    expect(await updateApplicationFeeWaiverCode(db, OTHER, "mine", { appliesTo: "both" })).toMatchObject({ ok: false, status: 404 });
    expect(tables.manager_application_fee_waiver_codes!.find((r) => r.id === "mine")!.applies_to).toBe("application");
    await updateApplicationFeeWaiverCode(db, MANAGER, "mine", { label: "Spring" });
    expect(tables.manager_application_fee_waiver_codes!.find((r) => r.id === "mine")!.code).toBe("MINE");
  });
});
