import { describe, expect, it } from "vitest";
import {
  selectVendorInvoicesWithinBalance,
  vendorInvoiceShortfallCents,
} from "@/lib/vendor-invoice-bulk-pay";

describe("selectVendorInvoicesWithinBalance (C260 bulk Pay vendors math)", () => {
  it("takes every invoice when the balance covers all of them", () => {
    const ids = selectVendorInvoicesWithinBalance(
      [
        { id: "a", totalCents: 10_000 },
        { id: "b", totalCents: 5_000 },
      ],
      20_000,
    );
    expect(ids).toEqual(["a", "b"]);
  });

  it("skips an invoice that doesn't fit but keeps checking smaller ones later in the list", () => {
    const ids = selectVendorInvoicesWithinBalance(
      [
        { id: "big", totalCents: 15_000 },
        { id: "small", totalCents: 3_000 },
      ],
      10_000,
    );
    // "big" doesn't fit in 10,000 — skipped, not a stop. "small" still fits.
    expect(ids).toEqual(["small"]);
  });

  it("reserves each taken invoice's amount against the running balance in list order", () => {
    const ids = selectVendorInvoicesWithinBalance(
      [
        { id: "first", totalCents: 6_000 },
        { id: "second", totalCents: 6_000 },
      ],
      10_000,
    );
    // "first" fits (10,000 -> 4,000 left); "second" no longer fits.
    expect(ids).toEqual(["first"]);
  });

  it("takes an invoice that exactly exhausts the balance", () => {
    const ids = selectVendorInvoicesWithinBalance([{ id: "exact", totalCents: 10_000 }], 10_000);
    expect(ids).toEqual(["exact"]);
  });

  it("selects nothing when the balance is zero or negative", () => {
    expect(selectVendorInvoicesWithinBalance([{ id: "a", totalCents: 100 }], 0)).toEqual([]);
    expect(selectVendorInvoicesWithinBalance([{ id: "a", totalCents: 100 }], -500)).toEqual([]);
  });

  it("never selects a zero or negative invoice total", () => {
    const ids = selectVendorInvoicesWithinBalance(
      [
        { id: "zero", totalCents: 0 },
        { id: "negative", totalCents: -100 },
        { id: "real", totalCents: 500 },
      ],
      10_000,
    );
    expect(ids).toEqual(["real"]);
  });

  it("returns an empty list for an empty input", () => {
    expect(selectVendorInvoicesWithinBalance([], 50_000)).toEqual([]);
  });
});

describe("vendorInvoiceShortfallCents", () => {
  it("is zero when the balance already covers the invoice", () => {
    expect(vendorInvoiceShortfallCents(5_000, 5_000)).toBe(0);
    expect(vendorInvoiceShortfallCents(4_000, 5_000)).toBe(0);
  });

  it("is the exact gap when the balance falls short", () => {
    expect(vendorInvoiceShortfallCents(10_000, 6_500)).toBe(3_500);
  });

  it("never goes negative against a balance far larger than the invoice", () => {
    expect(vendorInvoiceShortfallCents(100, 1_000_000)).toBe(0);
  });
});
