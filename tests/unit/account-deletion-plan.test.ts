import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  DELETE_ORDER,
  EMAIL_COLUMNS,
  ID_COLUMNS,
  ownershipFilter,
  targetFromUrl,
  // @ts-expect-error - plain .mjs helper shared with the CLI script
} from "../../scripts/lib/account-deletion.mjs";

/**
 * PRP-192 — what `scripts/delete-account.mjs` will delete, tested without a database.
 *
 * The dangerous half (issuing the deletes) stays behind the script's target guard. What is
 * worth pinning here is the part that decides WHAT gets deleted, because both ways of getting
 * it wrong are silent: a missed scoping column leaves orphaned rows in a "clean" environment,
 * and a wrong table order fails on a foreign key mid-run.
 */

describe("delete target parsing", () => {
  it("reads the project ref out of a hosted url", () => {
    expect(targetFromUrl("https://abcdefgh.supabase.co")).toBe("abcdefgh");
  });

  it("keeps host:port for a local stack, so it can never match a hosted ref", () => {
    expect(targetFromUrl("http://127.0.0.1:54321")).toBe("127.0.0.1:54321");
  });

  it("returns empty for an unparseable url, which the script treats as a refusal", () => {
    expect(targetFromUrl("not a url")).toBe("");
    expect(targetFromUrl("")).toBe("");
  });
});

describe("ownership filter", () => {
  const account = { userId: "user-1", email: "person@example.test" };

  it("matches email columns on the address and id columns on the id", () => {
    const filter = ownershipFilter(["manager_user_id", "resident_email"], account);

    expect(filter).toContain("manager_user_id.eq.user-1");
    expect(filter).toContain("resident_email.eq.person@example.test");
  });

  it("still cleans email-keyed rows when the auth user is already gone", () => {
    // `resident_email` is a STRING, not a foreign key, so those rows outlive the user row.
    const filter = ownershipFilter(["resident_email"], { userId: null, email: account.email });

    expect(filter).toBe("or=(resident_email.eq.person@example.test)");
  });

  it("returns null for a table with no recognised scoping column", () => {
    // The caller must SKIP such a table. A null that got treated as "no filter" would delete
    // the whole table.
    expect(ownershipFilter(["created_at", "row_data"], account)).toBeNull();
  });

  it("returns null when neither an id nor an email is known", () => {
    expect(ownershipFilter(["manager_user_id"], { userId: null, email: "" })).toBeNull();
  });

  it("covers every scoping column the ticket named", () => {
    for (const col of ["manager_user_id", "resident_user_id", "vendor_user_id", "owner_user_id", "landlord_id"]) {
      expect(ID_COLUMNS).toContain(col);
    }
    expect(EMAIL_COLUMNS).toContain("resident_email");
  });
});

describe("delete order", () => {
  const before = (a: string, b: string) => {
    const ia = DELETE_ORDER.indexOf(a);
    const ib = DELETE_ORDER.indexOf(b);
    expect(ia, `${a} missing`).toBeGreaterThan(-1);
    expect(ib, `${b} missing`).toBeGreaterThan(-1);
    return ia < ib;
  };

  it("clears the GL chain first", () => {
    // Otherwise deleting the user fails on `ledger_entries_gl_journal_entry_id_fkey`.
    expect(before("gl_journal_lines", "gl_journal_entries")).toBe(true);
    expect(before("ledger_entries", "gl_journal_entries")).toBe(true);
    expect(before("security_deposit_ledger", "gl_journal_entries")).toBe(true);
  });

  it("clears the whole vendor chain before the work orders it references", () => {
    for (const t of [
      "work_order_bids",
      "work_order_vendor_offers",
      "vendor_invoices",
      "vendor_payouts",
      "manager_vendor_records",
    ]) {
      expect(before(t, "portal_work_order_records"), t).toBe(true);
    }
  });

  it("deletes properties last, because nearly everything references one", () => {
    expect(DELETE_ORDER[DELETE_ORDER.length - 1]).toBe("manager_property_records");
  });

  it("names each table once", () => {
    expect(new Set(DELETE_ORDER).size).toBe(DELETE_ORDER.length);
  });
});

describe("the script's safety rails", () => {
  const source = readFileSync("scripts/delete-account.mjs", "utf8");

  it("refuses to run without an explicit target opt-in", () => {
    expect(source).toContain("ALLOW_DELETE_TARGET");
    expect(source).toContain("allowed !== target");
  });

  it("writes nothing unless --yes is passed", () => {
    // Dry run is the default: printing a plan must never be one flag away from deleting.
    expect(source).toContain('args.includes("--yes")');
    expect(source).toContain("if (!apply)");
  });

  it("re-counts after deleting instead of trusting the deletes it issued", () => {
    expect(source).toContain("STILL reference this account");
  });
});
