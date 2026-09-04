import { describe, expect, it } from "vitest";

import { claimVendorInvite, releaseVendorInvite } from "@/lib/auth/provision-vendor-account";

/**
 * The invite was flipped to `accepted` at the very END of provisioning, so two
 * concurrent redemptions of the same token both passed the `status = "pending"`
 * read and both proceeded — single-use by convention only (PRP-256). The claim
 * is now a compare-and-swap with the status predicate in the WHERE clause.
 */
type Row = { id: string; status: string; accepted_user_id: string | null; accepted_at: string | null };

/** Minimal Supabase double whose update() honours the `.eq()` predicates. */
function fakeDb(rows: Row[]) {
  return {
    from() {
      const filters: Array<[string, unknown]> = [];
      let patch: Partial<Row> = {};
      const builder = {
        update(values: Partial<Row>) {
          patch = values;
          return builder;
        },
        eq(column: string, value: unknown) {
          filters.push([column, value]);
          return builder;
        },
        select() {
          return builder;
        },
        async maybeSingle() {
          const hit = rows.find((row) =>
            filters.every(([column, value]) => (row as unknown as Record<string, unknown>)[column] === value),
          );
          if (!hit) return { data: null, error: null };
          Object.assign(hit, patch);
          return { data: { id: hit.id }, error: null };
        },
        then(resolve: (v: unknown) => unknown) {
          return builder.maybeSingle().then(resolve);
        },
      };
      return builder;
    },
  };
}

describe("vendor invite claim", () => {
  it("lets exactly one of two concurrent redemptions win", async () => {
    const rows: Row[] = [{ id: "inv-1", status: "pending", accepted_user_id: null, accepted_at: null }];
    const db = fakeDb(rows);
    const [first, second] = await Promise.all([
      claimVendorInvite(db as never, "inv-1", "user-a"),
      claimVendorInvite(db as never, "inv-1", "user-b"),
    ]);
    expect([first, second].filter(Boolean)).toHaveLength(1);
    expect(rows[0]!.status).toBe("accepted");
  });

  it("refuses a token that was already redeemed", async () => {
    const rows: Row[] = [{ id: "inv-1", status: "accepted", accepted_user_id: "user-a", accepted_at: "now" }];
    await expect(claimVendorInvite(fakeDb(rows) as never, "inv-1", "user-b")).resolves.toBe(false);
  });

  it("hands the invite back when provisioning failed, so a retry is not locked out", async () => {
    const rows: Row[] = [{ id: "inv-1", status: "pending", accepted_user_id: null, accepted_at: null }];
    const db = fakeDb(rows);
    expect(await claimVendorInvite(db as never, "inv-1", "user-a")).toBe(true);
    await releaseVendorInvite(db as never, "inv-1");
    expect(rows[0]!.status).toBe("pending");
    expect(rows[0]!.accepted_user_id).toBeNull();
    // …and the released invite can be claimed again.
    expect(await claimVendorInvite(db as never, "inv-1", "user-b")).toBe(true);
  });

  it("never resurrects an invite that is not currently accepted", async () => {
    const rows: Row[] = [{ id: "inv-1", status: "revoked", accepted_user_id: null, accepted_at: null }];
    await releaseVendorInvite(fakeDb(rows) as never, "inv-1");
    expect(rows[0]!.status).toBe("revoked");
  });
});
