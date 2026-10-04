import { describe, expect, it } from "vitest";
import {
  maskAccountReference,
  payeeCategoryCode,
  payeeFromRow,
  validatePayeeInput,
  PAYEE_TYPES,
  type ManagerPayee,
} from "@/lib/manager-payees";
import {
  buildManagerOutgoingPaymentRows,
  buildPayeePaymentRows,
  OUTGOING_PAYMENT_CATEGORY_CODES,
  outgoingPayeeDetails,
  type ManagerExpenseSnapshot,
} from "@/lib/manager-outgoing-payments";

const CHASE: ManagerPayee = {
  id: "payee-1",
  kind: "other",
  payeeType: "mortgage",
  name: "Chase Home Lending",
  accountReference: "0000 1234 4821",
  email: null,
  phone: "(800) 848-9136",
  address: null,
  payMethod: "online",
  notes: null,
  vendorDirectoryId: null,
  teammateUserId: null,
  archivedAt: null,
};

const EXPENSE: ManagerExpenseSnapshot = {
  id: "e1",
  propertyId: "p1",
  categoryCode: "mortgage",
  categoryLabel: "Mortgage",
  amountCents: 214000,
  expenseDate: "2026-10-01",
  memo: "October payment",
  payeeId: "payee-1",
};

describe("payee category auto-map", () => {
  it("maps each payee type to a chart account the modal offers", () => {
    expect(payeeCategoryCode("other", "mortgage")).toBe("mortgage");
    expect(payeeCategoryCode("other", "utility")).toBe("utilities");
    expect(payeeCategoryCode("other", "insurance")).toBe("insurance");
    expect(payeeCategoryCode("other", "tax")).toBe("property_tax");
    expect(payeeCategoryCode("other", "hoa")).toBe("other_expense");
    expect(payeeCategoryCode("other", "owner")).toBe("other_expense");
    expect(payeeCategoryCode("other", null)).toBe("other_expense");
    expect(payeeCategoryCode("teammate", null)).toBe("management");
    for (const type of PAYEE_TYPES) {
      expect(OUTGOING_PAYMENT_CATEGORY_CODES).toContain(payeeCategoryCode("other", type));
    }
  });
});

describe("account reference masking", () => {
  it("shows only the last four characters", () => {
    expect(maskAccountReference("0000 1234 4821")).toBe("••4821");
    expect(maskAccountReference("")).toBe("");
    expect(maskAccountReference(null)).toBe("");
  });
});

describe("validatePayeeInput", () => {
  const ok = { kind: "other", payeeType: "mortgage", name: "  Chase  ", accountReference: " 4821 ", payMethod: "online" };

  it("trims text and accepts the closed enums", () => {
    const result = validatePayeeInput(ok, { partial: false });
    expect(result).toEqual({ ok: true, value: expect.objectContaining({ name: "Chase", account_reference: "4821", pay_method: "online", payee_type: "mortgage", kind: "other" }) });
  });

  it("refuses an unknown kind, type or method", () => {
    expect(validatePayeeInput({ ...ok, kind: "bank" }, { partial: false })).toMatchObject({ ok: false });
    expect(validatePayeeInput({ ...ok, payeeType: "casino" }, { partial: false })).toMatchObject({ ok: false });
    expect(validatePayeeInput({ ...ok, payMethod: "crypto" }, { partial: false })).toMatchObject({ ok: false });
  });

  it("requires a name and, for someone else, a type", () => {
    expect(validatePayeeInput({ ...ok, name: "   " }, { partial: false })).toMatchObject({ ok: false });
    expect(validatePayeeInput({ kind: "other", name: "X" }, { partial: false })).toMatchObject({ ok: false });
  });

  it("caps lengths and rejects non-string fields", () => {
    expect(validatePayeeInput({ ...ok, name: "x".repeat(121) }, { partial: false })).toMatchObject({ ok: false });
    expect(validatePayeeInput({ ...ok, notes: "x".repeat(1001) }, { partial: false })).toMatchObject({ ok: false });
    expect(validatePayeeInput({ ...ok, accountReference: 4821 }, { partial: false })).toMatchObject({ ok: false });
    expect(validatePayeeInput({ ...ok, email: "not-an-email" }, { partial: false })).toMatchObject({ ok: false });
  });

  it("has no bank account or routing column to write", () => {
    const result = validatePayeeInput({ ...ok, routingNumber: "021000021", bankAccount: "123" } as never, { partial: false });
    expect(result.ok && Object.keys(result.value).join(",")).not.toMatch(/routing|bank_account/);
  });
});

describe("payee rows in the outgoing list", () => {
  it("titles an expense by its payee with the type and the masked reference", () => {
    const rows = buildManagerOutgoingPaymentRows({
      managerUserId: "m1",
      expenses: [EXPENSE],
      workOrders: [],
      propertyLabelById: new Map([["p1", "1200 Cascade Ave"]]),
      payeeById: new Map([[CHASE.id, CHASE]]),
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      payeeLabel: "Chase Home Lending",
      payeeId: "payee-1",
      payeeTypeLabel: "Mortgage",
      payeeReferenceLabel: "Loan ••4821",
      propertyName: "1200 Cascade Ave",
    });
    expect(JSON.stringify(rows[0])).not.toContain("1234");
  });

  it("falls back to the old derivation when the payee is unknown", () => {
    const rows = buildManagerOutgoingPaymentRows({ managerUserId: "m1", expenses: [EXPENSE], workOrders: [] });
    expect(rows[0]!.payeeLabel).toBe("—");
    expect(rows[0]!.payeeTypeLabel).toBeUndefined();
  });

  it("labels a teammate payee and a utility reference as an account", () => {
    expect(outgoingPayeeDetails({ ...CHASE, kind: "teammate", payeeType: "management", accountReference: null }).typeLabel).toBe("Teammate");
    expect(outgoingPayeeDetails({ ...CHASE, payeeType: "utility" }).referenceLabel).toBe("Account ••4821");
  });

  it("lists only payee payments, newest first", () => {
    const rows = buildPayeePaymentRows(
      [EXPENSE, { ...EXPENSE, id: "e2", expenseDate: "2026-11-01" }, { ...EXPENSE, id: "e3", payeeId: null }],
      new Map([[CHASE.id, CHASE]]),
    );
    expect(rows.map((row) => row.id)).toEqual(["payee-payment-e2", "payee-payment-e1"]);
  });

  it("reads a database row into a payee", () => {
    expect(payeeFromRow({ id: "x", kind: "other", payee_type: "tax", name: "County", account_reference: " ", pay_method: "check" })).toMatchObject({ payeeType: "tax", accountReference: null, payMethod: "check" });
  });
});
