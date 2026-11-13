import { describe, expect, it, vi } from "vitest";
import {
  QUICK_ADD_CSV_COLUMNS,
  QUICK_ADD_MAX_ROWS,
  parseCsv,
  parseQuickAddDate,
  parseQuickAddMoney,
  previewQuickAddCsv,
  quickAddCsvTemplate,
  quickAddFormPatch,
  quickAddRowProblems,
  validateQuickAdd,
  type QuickAddCatalog,
  type QuickAddRaw,
} from "@/lib/resident-quick-add/model";
import { createChargesForResidents } from "@/lib/manager-charge-batch";

const catalog: QuickAddCatalog = {
  houses: [
    { id: "prop-maple", label: "Maple House", rooms: [{ id: "r1", name: "Room 1" }, { id: "r2", name: "Room 2" }] },
    { id: "prop-oak", label: "Oak Cottage", rooms: [] },
  ],
};

const good: QuickAddRaw = {
  name: "Jordan Example",
  email: "Jordan@Example.com",
  phone: "(206) 555-0101",
  house: "Maple House",
  room: "room 1",
  moveIn: "2026-12-01",
  leaseEnd: "2027-11-30",
  rent: "$1,450",
  deposit: "1450",
};

describe("quick add validation", () => {
  it("accepts a full row and normalizes it", () => {
    const r = validateQuickAdd(good, catalog);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toMatchObject({ name: "Jordan Example", email: "jordan@example.com", phone: "+12065550101", propertyId: "prop-maple", roomId: "r1", moveInDate: "2026-12-01", leaseEnd: "2027-11-30", monthToMonth: false, rent: 1450, deposit: 1450 });
  });

  it("blank lease end is month-to-month; a house with no rooms takes no room", () => {
    const r = validateQuickAdd({ ...good, house: "Oak Cottage", room: "", leaseEnd: "" }, catalog);
    expect(r.ok && r.value.monthToMonth && r.value.roomId === "").toBe(true);
    const bad = validateQuickAdd({ ...good, house: "Oak Cottage", room: "Room 9" }, catalog);
    expect(bad.ok).toBe(false);
  });

  it("names every problem on its own field", () => {
    const r = validateQuickAdd({ ...good, name: "J", email: "nope", phone: "12", house: "Elsewhere", moveIn: "12/45/2026", rent: "", deposit: "abc" }, catalog);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(Object.keys(r.errors).sort()).toEqual(["deposit", "email", "house", "moveIn", "name", "phone", "rent"]);
  });

  it("needs a room in a house that has rooms, refuses a room that is not in it, refuses an end before move-in", () => {
    expect(validateQuickAdd({ ...good, room: "" }, catalog)).toMatchObject({ ok: false, errors: { room: expect.any(String) } });
    expect(validateQuickAdd({ ...good, room: "Room 7" }, catalog)).toMatchObject({ ok: false, errors: { room: expect.any(String) } });
    expect(validateQuickAdd({ ...good, leaseEnd: "2026-11-30" }, catalog)).toMatchObject({ ok: false, errors: { leaseEnd: expect.any(String) } });
  });

  it("a house named twice is refused, not guessed", () => {
    const dup: QuickAddCatalog = { houses: [catalog.houses[0]!, { ...catalog.houses[0]!, id: "prop-other" }] };
    expect(validateQuickAdd(good, dup)).toMatchObject({ ok: false, errors: { house: expect.stringContaining("id") } });
    expect(validateQuickAdd({ ...good, house: "prop-other" }, dup).ok).toBe(true);
  });

  it("one-time charges need a name and a positive amount, up to five", () => {
    expect(validateQuickAdd({ ...good, oneTimeCharges: [{ label: "Pet fee", amount: "$75" }] }, catalog)).toMatchObject({ ok: true, value: { oneTimeCharges: [{ label: "Pet fee", amount: 75 }] } });
    expect(validateQuickAdd({ ...good, oneTimeCharges: [{ label: "", amount: "75" }] }, catalog).ok).toBe(false);
    expect(validateQuickAdd({ ...good, oneTimeCharges: Array.from({ length: 6 }, () => ({ label: "x", amount: "1" })) }, catalog).ok).toBe(false);
  });

  it("parses dates and money strictly", () => {
    expect(parseQuickAddDate("3/9/2027")).toBe("2027-03-09");
    expect(parseQuickAddDate("2027-02-30")).toBeNull();
    expect(parseQuickAddMoney("$1,234.5")).toBe(1234.5);
    expect(parseQuickAddMoney("")).toBeNull();
    expect(parseQuickAddMoney("12abc")).toBeNaN();
  });
});

describe("quick add CSV", () => {
  it("reads quotes, doubled quotes, CRLF and a BOM", () => {
    expect(parseCsv('﻿a,b\r\n"x, y","he said ""hi"""\r\n\r\n')).toEqual([["a", "b"], ["x, y", 'he said "hi"']]);
  });

  it("the downloadable template is itself a valid file", () => {
    const text = quickAddCsvTemplate(catalog);
    expect(text.split("\n")[0]).toBe(QUICK_ADD_CSV_COLUMNS.join(","));
    const p = previewQuickAddCsv(text, catalog);
    expect(p.fileError).toBeNull();
    expect(p.okCount).toBe(1);
  });

  const header = QUICK_ADD_CSV_COLUMNS.join(",");
  it("previews every row with its own errors, never skipping silently", () => {
    const text = [
      header,
      "Jordan Example,j@example.com,206-555-0101,Maple House,Room 1,2026-12-01,2027-11-30,1450,1450",
      "Sam Bad,not-an-email,206-555-0102,Maple House,Room 2,2026-12-01,,1200,",
      "Pat Nohouse,p@example.com,206-555-0103,Nowhere,,2026-12-01,,900,",
    ].join("\n");
    const p = previewQuickAddCsv(text, catalog);
    expect(p.rows).toHaveLength(3);
    expect(p.okCount).toBe(1);
    expect(p.errorCount).toBe(2);
    expect(p.rows.map((r) => r.line)).toEqual([2, 3, 4]);
    expect(quickAddRowProblems(p.rows[1]!)).toEqual([expect.stringContaining("email")]);
    expect(quickAddRowProblems(p.rows[2]!)).toEqual([expect.stringContaining("house")]);
    expect(p.rows[0]!.value?.roomId).toBe("r1");
  });

  it("flags a duplicate email or phone inside the file on the later row", () => {
    const text = [
      header,
      "A One,same@example.com,206-555-0101,Maple House,Room 1,2026-12-01,,1000,",
      "B Two,SAME@example.com,206-555-0102,Maple House,Room 2,2026-12-01,,1000,",
      "C Three,c@example.com,(206) 555-0101,Oak Cottage,,2026-12-01,,1000,",
    ].join("\n");
    const p = previewQuickAddCsv(text, catalog);
    expect(p.rows.map((r) => Boolean(r.value))).toEqual([true, false, false]);
    expect(p.rows[1]!.rowError).toContain("line 2");
    expect(p.rows[2]!.rowError).toContain("phone");
  });

  it("refuses a file with a missing column, no rows, or too many rows, with a file-level reason", () => {
    expect(previewQuickAddCsv("name,email\nA,b", catalog).fileError).toContain("Missing");
    expect(previewQuickAddCsv(`${header}\n`, catalog).fileError).toContain("no residents");
    expect(previewQuickAddCsv("", catalog).fileError).toBeTruthy();
    const many = [header, ...Array.from({ length: QUICK_ADD_MAX_ROWS + 1 }, (_, i) => `N${i} Name,n${i}@example.com,206-555-${String(1000 + i)},Oak Cottage,,2026-12-01,,1,`)].join("\n");
    expect(previewQuickAddCsv(many, catalog).fileError).toContain("Too many");
  });

  it("accepts the headers people actually type", () => {
    const text = ["Full Name,Email,Phone,Property,Room,Move In,Lease End,Monthly Rent,Security Deposit", "A One,a@example.com,206-555-0101,Oak Cottage,,2026-12-01,,1000,500"].join("\n");
    expect(previewQuickAddCsv(text, catalog).okCount).toBe(1);
  });
});

describe("quick add maps onto the one Add resident form", () => {
  const value = (() => {
    const r = validateQuickAdd(good, catalog);
    if (!r.ok) throw new Error("setup");
    return r.value;
  })();

  it("turns Lease + Payments on and leaves the deposit and move-in fee DUE (never marked paid)", () => {
    const patch = quickAddFormPatch(value, { choice: "none", file: null, dataUrl: "" });
    expect(patch).toMatchObject({ kind: "resident", alsoCreate: ["lease", "payments"], depositPaid: false, moveInFeePaid: false, rent: "1450", securityDeposit: "1450", moveOutDate: "2027-11-30", leaseDocument: "later" });
  });

  it("month-to-month uses the custom Month-to-Month term and no end date", () => {
    const m2m = validateQuickAdd({ ...good, leaseEnd: "" }, catalog);
    if (!m2m.ok) throw new Error("setup");
    expect(quickAddFormPatch(m2m.value, { choice: "none", file: null, dataUrl: "" })).toMatchObject({ leaseTerm: "Month-to-Month", leaseTermCustomMode: true, moveOutDate: "" });
  });

  it("a signed PDF files as signed; without the PDF's bytes it falls back to no filing", () => {
    const file = new File(["%PDF"], "lease.pdf", { type: "application/pdf" });
    expect(quickAddFormPatch(value, { choice: "signed", file, dataUrl: "data:application/pdf;base64,AAAA" })).toMatchObject({ leaseDocument: "signed", leaseFileName: "lease.pdf" });
    expect(quickAddFormPatch(value, { choice: "signed", file, dataUrl: "" })).toMatchObject({ leaseDocument: "later", leaseDataUrl: "" });
  });
});

describe("one-time charges are idempotent", () => {
  it("the same base id on a retry is the same charge id (the server upserts on it)", () => {
    const seen: string[] = [];
    const create = vi.fn((input: { id?: string }) => {
      seen.push(String(input.id));
      return { id: input.id } as never;
    });
    const resident = { applicationId: "PROPLANE-AB12", residentName: "A", residentEmail: "a@example.com", propertyId: "p", propertyLabel: "P", title: "Pet fee" };
    const terms = { managerUserId: "m", amount: 75, dueDateLabel: "2026-12-01", initialStatus: "pending" as const, baseId: "hc_qa_PROPLANE-AB12_pet-fee" };
    createChargesForResidents([resident], terms, create);
    createChargesForResidents([resident], terms, create);
    expect(seen).toEqual(["hc_qa_PROPLANE-AB12_pet-fee", "hc_qa_PROPLANE-AB12_pet-fee"]);
  });
});
