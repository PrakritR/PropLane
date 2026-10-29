import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { loadAccountPurchaseRows } from "@/lib/manager-purchase-account-rows.server";

const USER = "11111111-2222-4333-8444-555555555555";

function fakeDb(email: string) {
  const calls: { ilike?: [string, string]; or?: string[] } = { or: [] };
  const purchases = () => {
    const q = {
      select: () => q,
      eq: () => Promise.resolve({ data: [], error: null }),
      ilike: (col: string, value: string) => {
        calls.ilike = [col, value];
        return q;
      },
      or: (filter: string) => {
        calls.or!.push(filter);
        return Promise.resolve({ data: [], error: null });
      },
    };
    return q;
  };
  const profiles = {
    select: () => profiles,
    eq: () => profiles,
    maybeSingle: () => Promise.resolve({ data: { email }, error: null }),
  };
  const db = { from: (table: string) => (table === "profiles" ? profiles : purchases()) };
  return { db: db as never, calls };
}

describe("loadAccountPurchaseRows email match", () => {
  it("escapes LIKE wildcards so a_b@x.com never matches a.b@x.com", async () => {
    const { db, calls } = fakeDb("A_b%c@x.com");
    await loadAccountPurchaseRows(db, USER, "id");
    expect(calls.ilike).toEqual(["email", "a\\_b\\%c@x.com"]);
  });

  it("only takes by-email rows that are unclaimed or already this account's", async () => {
    const { db, calls } = fakeDb("a@x.com");
    await loadAccountPurchaseRows(db, USER, "id");
    expect(calls.or).toEqual([`user_id.is.null,user_id.eq.${USER}`]);
  });

  it("re-checks the address in JS, so a pattern match never takes another signup's row", async () => {
    // PostgREST reads `*` in a LIKE pattern as `%` whatever the escaping, so the read can come back
    // wider than the address asked for; only an exactly equal email is this account's.
    const purchases = () => {
      const q = {
        select: () => q,
        eq: () => Promise.resolve({ data: [], error: null }),
        ilike: () => q,
        or: () =>
          Promise.resolve({
            data: [
              { id: "mine", email: "A*b@x.com" },
              { id: "theirs", email: "aXb@x.com" },
            ],
            error: null,
          }),
      };
      return q;
    };
    const profiles = {
      select: () => profiles,
      eq: () => profiles,
      maybeSingle: () => Promise.resolve({ data: { email: "a*b@x.com" }, error: null }),
    };
    const db = { from: (table: string) => (table === "profiles" ? profiles : purchases()) } as never;
    const { rows, readFailed } = await loadAccountPurchaseRows<{ id: string }>(db, USER, "id");
    expect(rows.map((r) => r.id)).toEqual(["mine"]);
    expect(readFailed).toBe(false);
  });

  it("never interpolates a non-uuid account id: only the parameterized user_id read runs", async () => {
    const { db, calls } = fakeDb("a@x.com");
    await expect(loadAccountPurchaseRows(db, "x,user_id.not.is.null", "id")).resolves.toEqual({ rows: [], readFailed: false, error: null });
    expect(calls.or).toEqual([]);
    expect(calls.ilike).toBeUndefined();
  });
});
