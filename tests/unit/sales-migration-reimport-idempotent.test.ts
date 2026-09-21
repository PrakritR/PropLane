/**
 * Financial-fact ids (income/expense facts and `importCharge` rows) used to derive from
 * `migrationRecordId(owner, workbookId, propertyId, "financial", recordKey)` — including
 * the workbook id. A workbook re-imported after a correction (same owner, same property,
 * same source cell, but a NEW workbook id) therefore generated a brand-new id for every
 * fact and reimported it a second time, duplicating charges/ledger rows.
 *
 * `resolveFinancialFactId` (src/lib/sales-migration/server.ts) is the pure id-choice
 * helper: workbook-independent for a fresh fact, but still landing on the OLD
 * workbook-scoped id when one already exists there (an in-progress import stays on the
 * id it started with).
 */
import { describe, expect, it } from "vitest";
import { migrationRecordId, resolveFinancialFactId } from "@/lib/sales-migration/server";

const OWNER = "mgr-migration-1";
const PROPERTY_ID = "prop-migration-1";
const RECORD_KEY = "Sheet1!A5";

describe("resolveFinancialFactId", () => {
  it("is workbook-independent for a fact with no legacy row", () => {
    const idFromWorkbookA = resolveFinancialFactId(OWNER, "workbook-a", PROPERTY_ID, RECORD_KEY, false);
    const idFromWorkbookB = resolveFinancialFactId(OWNER, "workbook-b", PROPERTY_ID, RECORD_KEY, false);
    expect(idFromWorkbookA).toBe(idFromWorkbookB);
    expect(idFromWorkbookA).toBe(migrationRecordId(OWNER, PROPERTY_ID, "financial", RECORD_KEY));
  });

  it("reuses the legacy workbook-scoped id when one already exists", () => {
    const legacyId = resolveFinancialFactId(OWNER, "workbook-a", PROPERTY_ID, RECORD_KEY, true);
    expect(legacyId).toBe(migrationRecordId(OWNER, "workbook-a", PROPERTY_ID, "financial", RECORD_KEY));
    // The legacy formula is workbook-scoped, so a different workbook id resolves to a
    // different legacy id — matching the pre-fix behavior for an in-progress import.
    const legacyIdOtherWorkbook = resolveFinancialFactId(OWNER, "workbook-b", PROPERTY_ID, RECORD_KEY, true);
    expect(legacyIdOtherWorkbook).not.toBe(legacyId);
  });

  it("the legacy and new ids for the same fact differ", () => {
    const legacyId = resolveFinancialFactId(OWNER, "workbook-a", PROPERTY_ID, RECORD_KEY, true);
    const newId = resolveFinancialFactId(OWNER, "workbook-a", PROPERTY_ID, RECORD_KEY, false);
    expect(legacyId).not.toBe(newId);
  });

  it("stays scoped to owner, property and record key", () => {
    const base = resolveFinancialFactId(OWNER, "workbook-a", PROPERTY_ID, RECORD_KEY, false);
    expect(resolveFinancialFactId("other-owner", "workbook-a", PROPERTY_ID, RECORD_KEY, false)).not.toBe(base);
    expect(resolveFinancialFactId(OWNER, "workbook-a", "other-property", RECORD_KEY, false)).not.toBe(base);
    expect(resolveFinancialFactId(OWNER, "workbook-a", PROPERTY_ID, "Sheet1!A6", false)).not.toBe(base);
  });
});
