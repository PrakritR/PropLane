import { describe, expect, it } from "vitest";
import {
  form1099StatusLabel,
  maskTin,
  summarizeVendorTaxYears,
  threshold1099Cents,
  validateVendorW9Input,
} from "@/lib/vendor-banking/tax";

const valid = {
  legalName: "Dima Handyman LLC",
  entityType: "single_member_llc",
  addressLine1: "12 Oak St",
  city: "Seattle",
  state: "wa",
  zip: "98101",
  tinType: "ein",
  tin: "12-3454821",
  attested: true,
};

describe("validateVendorW9Input", () => {
  it("accepts a complete W-9, normalizing state and TIN", () => {
    const result = validateVendorW9Input(valid, { hasTinOnFile: false });
    expect(result).toMatchObject({ ok: true, value: { state: "WA", tin: "123454821", tinType: "ein", attested: true } });
  });

  it("requires the certification", () => {
    expect(validateVendorW9Input({ ...valid, attested: false }, { hasTinOnFile: false })).toMatchObject({ ok: false });
  });

  it.each([
    [{ legalName: " " }, "legal name"],
    [{ entityType: "wizard" }, "entity type"],
    [{ addressLine1: "" }, "street address"],
    [{ state: "Washington" }, "state"],
    [{ zip: "9810" }, "ZIP"],
    [{ tinType: "itin" }, "SSN or EIN"],
    [{ tin: "12345" }, "nine digits"],
  ])("rejects %j", (patch, fragment) => {
    const result = validateVendorW9Input({ ...valid, ...patch }, { hasTinOnFile: false });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.toLowerCase()).toContain(String(fragment).toLowerCase());
  });

  it("needs a TIN the first time but not when one is already on file", () => {
    const { tin: _tin, ...withoutTin } = valid;
    void _tin;
    expect(validateVendorW9Input(withoutTin, { hasTinOnFile: false })).toMatchObject({ ok: false });
    expect(validateVendorW9Input(withoutTin, { hasTinOnFile: true })).toMatchObject({ ok: true, value: { tin: null } });
  });

  it("never echoes the TIN in an error", () => {
    const result = validateVendorW9Input({ ...valid, tin: "123-45-678X" }, { hasTinOnFile: false });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).not.toMatch(/678/);
  });
});

describe("maskTin", () => {
  it("shows only the last four", () => {
    expect(maskTin("ein", "4821")).toBe("••-•••4821");
    expect(maskTin("ssn", "4821")).toBe("•••-••-4821");
    expect(maskTin("ein", null)).toBe("—");
  });
});

describe("tax years", () => {
  it("summarizes earnings, fees and refunds per Pacific year, newest first", () => {
    const years = summarizeVendorTaxYears([
      { kind: "charge", source: "invoice", amountCents: 200_000, createdAt: "2026-03-01T00:00:00.000Z" },
      { kind: "platform_fee", source: "invoice", amountCents: -6_000, createdAt: "2026-03-01T00:00:01.000Z" },
      { kind: "platform_fee", source: "withdrawal", amountCents: -300, createdAt: "2026-04-01T00:00:00.000Z" },
      { kind: "refund", source: "refund", amountCents: -5_000, createdAt: "2026-05-01T00:00:00.000Z" },
      { kind: "withdrawal", source: "withdrawal", amountCents: -100_000, createdAt: "2026-06-01T00:00:00.000Z" },
      { kind: "charge", source: "invoice", amountCents: 50_000, createdAt: "2025-12-31T23:59:59.000Z" },
    ]);
    expect(years.map((y) => y.year)).toEqual([2026, 2025]);
    expect(years[0]).toMatchObject({ earningsCents: 200_000, feesCents: 6_300, refundsCents: 5_000, reportableCents: 195_000 });
    expect(years[1]).toMatchObject({ earningsCents: 50_000, overThreshold: false });
  });

  it("books a payment settled Dec 31 after 4pm PT in THAT tax year, not the next one", () => {
    const years = summarizeVendorTaxYears([
      // 2027-01-01T00:00Z is Dec 31 2026, 4pm PT — a 2026 payment on the clock the vendor saw.
      { kind: "charge", source: "invoice", amountCents: 300_000, createdAt: "2027-01-01T00:00:00.000Z" },
      { kind: "charge", source: "invoice", amountCents: 100_000, createdAt: "2027-01-01T08:00:00.000Z" },
    ]);
    expect(years.map((y) => [y.year, y.earningsCents])).toEqual([
      [2027, 100_000],
      [2026, 300_000],
    ]);
  });

  it("uses $600 before 2026 and $2,000 from 2026", () => {
    expect(threshold1099Cents(2025)).toBe(60_000);
    expect(threshold1099Cents(2026)).toBe(200_000);
  });

  it("is over the threshold only on reportable earnings (earnings less refunds)", () => {
    const [year] = summarizeVendorTaxYears([
      { kind: "charge", source: "invoice", amountCents: 200_500, createdAt: "2026-03-01T00:00:00.000Z" },
      { kind: "refund", source: "refund", amountCents: -1_000, createdAt: "2026-03-02T00:00:00.000Z" },
    ]);
    expect(year!.overThreshold).toBe(false);
  });

  it("says what happens for the 1099", () => {
    const over = { year: 2026, earningsCents: 241_000, feesCents: 0, refundsCents: 0, reportableCents: 241_000, thresholdCents: 200_000, overThreshold: true };
    expect(form1099StatusLabel(over, { hasW9: true, currentYear: 2026 })).toBe("We'll file your 1099 for 2026");
    expect(form1099StatusLabel(over, { hasW9: false, currentYear: 2026 })).toBe("Add your W-9 so we can file your 1099");
    expect(form1099StatusLabel({ ...over, year: 2025, thresholdCents: 60_000 }, { hasW9: true, currentYear: 2026 })).toBe("1099 filed by PropLane in Jan 2026");
    expect(form1099StatusLabel({ ...over, overThreshold: false }, { hasW9: true, currentYear: 2026 })).toContain("No 1099 needed");
  });
});

/** The few query-builder calls saveVendorW9 makes, over plain arrays. */
function w9Db() {
  const tables: Record<string, Array<Record<string, unknown>>> = {};
  const from = (table: string) => {
    const rows = (tables[table] ??= []);
    const filters: Array<[string, unknown]> = [];
    let pendingUpsert: Record<string, unknown> | null = null;
    const matched = () => rows.filter((r) => filters.every(([c, v]) => r[c] === v));
    const builder = {
      upsert(row: Record<string, unknown>, opts?: { onConflict?: string }) {
        const keys = (opts?.onConflict ?? "").split(",");
        const existing = rows.find((r) => keys.every((k) => r[k] === row[k]));
        if (existing) Object.assign(existing, row);
        else rows.push({ ...row });
        pendingUpsert = existing ?? row;
        return builder;
      },
      select: () => builder,
      order: () => builder,
      eq(col: string, val: unknown) {
        filters.push([col, val]);
        return builder;
      },
      single: async () => ({ data: pendingUpsert ? rows.find((r) => r.vendor_user_id === pendingUpsert!.vendor_user_id) : null, error: null }),
      maybeSingle: async () => ({ data: matched()[0] ?? null, error: null }),
      then: (resolve: (v: unknown) => unknown) => Promise.resolve({ data: matched(), error: null }).then(resolve),
    };
    return builder;
  };
  return { tables, from };
}

describe("saveVendorW9 (server)", () => {
  it("stores only ciphertext + last four, never the plaintext TIN, and returns no ciphertext", async () => {
    process.env.FINANCIALS_TIN_ENCRYPTION_KEY = "test-key-for-w9";
    const { saveVendorW9 } = await import("@/lib/vendor-banking/tax.server");
    const db = w9Db();
    db.tables.manager_vendor_records = [{ id: "mv1", manager_user_id: "mgr1", vendor_user_id: "vendor_1", row_data: {} }];
    const result = validateVendorW9Input(valid, { hasTinOnFile: false });
    if (!result.ok) throw new Error("fixture invalid");
    const profile = await saveVendorW9(db as never, "vendor_1", result.value);
    expect(profile.tinLast4).toBe("4821");
    expect(JSON.stringify(profile)).not.toMatch(/ciphertext|123454821/);
    const stored = db.tables.vendor_account_tax_profiles![0]!;
    expect(stored.vendor_user_id).toBe("vendor_1");
    expect(stored.tin_ciphertext).toBeTruthy();
    expect(JSON.stringify(stored)).not.toContain("123454821");
    // the legacy per-manager row the manager's 1099 export reads is kept in step, from the same ciphertext
    const legacy = db.tables.vendor_tax_profiles![0]!;
    expect(legacy).toMatchObject({ vendor_id: "mv1", manager_user_id: "mgr1", tin_last4: "4821", entity_type: "business" });
    expect(legacy.tin_ciphertext).toBe(stored.tin_ciphertext);
  });

  it("keeps the stored TIN when an edit omits it", async () => {
    process.env.FINANCIALS_TIN_ENCRYPTION_KEY = "test-key-for-w9";
    const { saveVendorW9 } = await import("@/lib/vendor-banking/tax.server");
    const db = w9Db();
    const first = validateVendorW9Input(valid, { hasTinOnFile: false });
    if (!first.ok) throw new Error("fixture invalid");
    await saveVendorW9(db as never, "vendor_1", first.value);
    const cipher = db.tables.vendor_account_tax_profiles![0]!.tin_ciphertext;
    const { tin: _tin, ...rest } = valid;
    void _tin;
    const edit = validateVendorW9Input({ ...rest, city: "Tacoma" }, { hasTinOnFile: true });
    if (!edit.ok) throw new Error("fixture invalid");
    const profile = await saveVendorW9(db as never, "vendor_1", edit.value);
    expect(profile.city).toBe("Tacoma");
    expect(profile.tinLast4).toBe("4821");
    expect(db.tables.vendor_account_tax_profiles![0]!.tin_ciphertext).toBe(cipher);
  });

  it("fails closed without the encryption key", async () => {
    const saved = process.env.FINANCIALS_TIN_ENCRYPTION_KEY;
    delete process.env.FINANCIALS_TIN_ENCRYPTION_KEY;
    try {
      const { saveVendorW9 } = await import("@/lib/vendor-banking/tax.server");
      const db = w9Db();
      const result = validateVendorW9Input(valid, { hasTinOnFile: false });
      if (!result.ok) throw new Error("fixture invalid");
      await expect(saveVendorW9(db as never, "vendor_1", result.value)).rejects.toThrow(/FINANCIALS_TIN_ENCRYPTION_KEY/);
      expect(db.tables.vendor_account_tax_profiles ?? []).toHaveLength(0);
    } finally {
      if (saved !== undefined) process.env.FINANCIALS_TIN_ENCRYPTION_KEY = saved;
    }
  });
});
