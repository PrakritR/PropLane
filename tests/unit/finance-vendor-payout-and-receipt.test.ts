import { describe, expect, it, vi } from "vitest";
import { createFinanceFakeDb } from "../helpers/finance-fake-db";

vi.mock("server-only", () => ({}));

import { maskConnectAccountRef, normalizeVendorPayoutFields, payoutSummary, visitRatePrefill } from "@/lib/vendor-payout";
import { PAYMENT_METHOD_LABELS } from "@/lib/finance/payment-fields";
import { vendorCatalogProjection } from "@/lib/vendor-catalog-projection";
import { attachExpenseReceipt, signedReceiptUrl } from "@/lib/finance/expense-receipt.server";

const MGR = "11111111-1111-4111-8111-111111111111";
const OPEN = { propertyIds: null, includeUntagged: true };

describe("vendor payout fields", () => {
  it("keeps a generic method label, a four-digit tail and a per-visit rate; drops everything else", () => {
    expect(normalizeVendorPayoutFields({ payoutMethod: "p2p_transfer", payoutLast4: "4821", visitRateCents: 12000 })).toEqual({
      payoutMethod: "p2p_transfer", payoutLast4: "4821", payoutConnectAccountRef: undefined, visitRateCents: 12000,
    });
    const bad = normalizeVendorPayoutFields({ payoutMethod: "carrier pigeon", payoutLast4: "123456789", visitRateCents: -5 });
    expect(bad).toEqual({ payoutMethod: undefined, payoutLast4: undefined, payoutConnectAccountRef: undefined, visitRateCents: undefined });
  });

  it("never stores a bank or routing number: only exactly four digits survive", () => {
    for (const value of ["021000021", "0000-1234-5678", "12345", "123", "abcd", "12 34"]) {
      expect(normalizeVendorPayoutFields({ payoutLast4: value }).payoutLast4).toBeUndefined();
    }
    expect(normalizeVendorPayoutFields({ payoutLast4: " 0042 " }).payoutLast4).toBe("0042");
  });

  it("the Connect reference is server-owned: a client value is dropped, and it is masked when the server sets it", () => {
    expect(normalizeVendorPayoutFields({ payoutConnectAccountRef: "acct_1NxFAKEFAKE9" }).payoutConnectAccountRef).toBeUndefined();
    expect(maskConnectAccountRef("acct_1NxFAKEFAKE9")).toBe("acct_...AKE9");
    expect(maskConnectAccountRef("not-an-account")).toBeUndefined();
    expect(maskConnectAccountRef(null)).toBeUndefined();
  });

  it("prefills Record payment from the per-visit rate and summarizes the payout without a number", () => {
    expect(visitRatePrefill({ visitRateCents: 12000 })).toBe("120.00");
    expect(visitRatePrefill({})).toBe("");
    expect(payoutSummary({ payoutMethod: "p2p_transfer", payoutLast4: "4821" }, PAYMENT_METHOD_LABELS)).toBe("Bank app / P2P transfer · ••4821");
  });

  it("payout details never leave the owner through the shared-catalog projection", () => {
    const projected = vendorCatalogProjection(
      { id: "v1", managerUserId: MGR, name: "Rosa", trade: "Cleaning", phone: "", email: "", notes: "", active: true, payoutMethod: "ach", payoutLast4: "4821", visitRateCents: 12000 } as never,
      MGR,
    ) as Record<string, unknown>;
    expect(projected.payoutMethod).toBeUndefined();
    expect(projected.payoutLast4).toBeUndefined();
    expect(projected.visitRateCents).toBeUndefined();
  });
});

function withStorage(db: ReturnType<typeof createFinanceFakeDb>) {
  const objects = new Map<string, Buffer>();
  const storage = {
    from: (bucket: string) => ({
      upload: vi.fn(async (path: string, bytes: Buffer) => { objects.set(`${bucket}/${path}`, bytes); return { error: null }; }),
      remove: vi.fn(async (paths: string[]) => { for (const p of paths) objects.delete(`${bucket}/${p}`); return { error: null }; }),
      createSignedUrl: vi.fn(async (path: string, ttl: number) => ({ data: { signedUrl: `https://storage.test/sign/${bucket}/${path}?ttl=${ttl}` }, error: null })),
    }),
  };
  return { db: { ...db, storage } as never, objects };
}

const PDF = { name: "spu-oct.pdf", mime: "application/pdf", bytes: Buffer.from("%PDF-1.4 test") };

describe("expense receipts (private bucket, signed URLs only)", () => {
  const seed = () => createFinanceFakeDb({
    manager_expense_entries: [
      { id: "exp-1", manager_user_id: MGR, property_id: "p1", vendor_id: null, memo: "SPU Oct", receipt_document_id: null },
      { id: "exp-other", manager_user_id: "someone-else", property_id: "p1", vendor_id: null, memo: "x", receipt_document_id: null },
    ],
  });

  it("uploads into the manager's private folder, files it in the Library and links the entry by id", async () => {
    const fake = seed();
    const { db, objects } = withStorage(fake);
    const result = await attachExpenseReceipt(db, MGR, "exp-1", OPEN, PDF);
    expect(result.ok).toBe(true);
    const doc = fake.table("manager_documents")[0]!;
    expect(doc).toMatchObject({ manager_user_id: MGR, category: "invoice", visibility: "manager", mime_type: "application/pdf" });
    expect(String(doc.storage_path)).toMatch(new RegExp(`^manager/${MGR}/receipt-`));
    expect([...objects.keys()][0]).toMatch(/^manager-documents\/manager\//);
    expect(fake.table("manager_expense_entries")[0]!.receipt_document_id).toBe(doc.id);
    expect(JSON.stringify(fake.table("manager_expense_entries")[0])).not.toContain("storage.test");
  });

  it("mints a signed URL for the owner only; a foreign, missing or out-of-workspace entry is the same 404", async () => {
    const fake = seed();
    const { db } = withStorage(fake);
    await attachExpenseReceipt(db, MGR, "exp-1", OPEN, PDF);
    const signed = await signedReceiptUrl(db, MGR, "exp-1", OPEN, false);
    expect(signed).toMatchObject({ ok: true });
    if (signed.ok) expect(signed.value.url).toContain("storage.test/sign/manager-documents/manager/");
    expect(await signedReceiptUrl(db, "someone-else", "exp-1", OPEN, false)).toMatchObject({ ok: false, status: 404 });
    expect(await signedReceiptUrl(db, MGR, "exp-other", OPEN, false)).toMatchObject({ ok: false, status: 404 });
    expect(await signedReceiptUrl(db, MGR, "exp-1", { propertyIds: ["p2"], includeUntagged: false }, false)).toMatchObject({ ok: false, status: 404 });
    expect(await attachExpenseReceipt(db, MGR, "exp-other", OPEN, PDF)).toMatchObject({ ok: false, status: 404 });
  });

  it("refuses an unsupported type, an empty file and an oversize file; an entry with no receipt is a 404", async () => {
    const fake = seed();
    const { db } = withStorage(fake);
    expect(await attachExpenseReceipt(db, MGR, "exp-1", OPEN, { ...PDF, mime: "application/x-msdownload" })).toMatchObject({ ok: false, status: 415 });
    expect(await attachExpenseReceipt(db, MGR, "exp-1", OPEN, { ...PDF, bytes: Buffer.alloc(0) })).toMatchObject({ ok: false, status: 400 });
    expect(await attachExpenseReceipt(db, MGR, "exp-1", OPEN, { ...PDF, bytes: Buffer.alloc(26_214_401) })).toMatchObject({ ok: false, status: 413 });
    expect(await signedReceiptUrl(db, MGR, "exp-1", OPEN, false)).toMatchObject({ ok: false, status: 404 });
  });

  it("leaves no orphan file or document when linking the entry fails", async () => {
    const fake = seed();
    const { db, objects } = withStorage(fake);
    fake.failOn("manager_expense_entries", "update", "link failed");
    expect(await attachExpenseReceipt(db, MGR, "exp-1", OPEN, PDF)).toMatchObject({ ok: false, status: 500 });
    expect(objects.size).toBe(0);
    expect(fake.table("manager_documents")).toHaveLength(0);
  });
});
