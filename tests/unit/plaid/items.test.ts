import { describe, expect, it, beforeAll } from "vitest";
import { randomBytes } from "node:crypto";
import { createPlaidItem, PlaidItemConflictError, readPlaidAccessToken, toPlaidItemView, maskLastFour } from "@/lib/plaid/items.server";
import { createFakeDb } from "./fake-db";

beforeAll(() => {
  process.env.DATA_ENCRYPTION_ACTIVE_KEY_ID = "test";
  process.env.DATA_ENCRYPTION_KEYS_JSON = JSON.stringify({ test: randomBytes(32).toString("base64") });
});

describe("plaid items", () => {
  it("encrypts the token bound to owner and row, and never exposes it in the view", async () => {
    const { db, tables } = createFakeDb();
    const row = await createPlaidItem(db, { ownerUserId: "u1", purpose: "bank_feed", itemId: "i1", accessToken: "access-sandbox-secret", accountMask: "123456" });
    const stored = tables.plaid_items![0]!;
    expect(String(stored.access_token_enc)).not.toContain("access-sandbox-secret");
    expect(stored.account_mask).toBe("3456");
    expect(readPlaidAccessToken(row)).toBe("access-sandbox-secret");
    expect(JSON.stringify(toPlaidItemView(row))).not.toMatch(/access|enc|cursor/i);
    expect(() => readPlaidAccessToken({ ...row, owner_user_id: "u2" })).toThrow();
    expect(() => readPlaidAccessToken({ ...row, id: "other" })).toThrow();
  });

  it("refuses to take over an item another account holds", async () => {
    const { db } = createFakeDb();
    await createPlaidItem(db, { ownerUserId: "u1", purpose: "bank_feed", itemId: "i1", accessToken: "t" });
    await expect(createPlaidItem(db, { ownerUserId: "u2", purpose: "bank_feed", itemId: "i1", accessToken: "t" })).rejects.toThrow(/another account/);
    await createPlaidItem(db, { ownerUserId: "u1", purpose: "bank_feed", itemId: "i2", accessToken: "t" });
    const refusal = await createPlaidItem(db, { ownerUserId: "u2", purpose: "bank_feed", itemId: "i2", accessToken: "t" }).catch((e) => e);
    expect(refusal).toBeInstanceOf(PlaidItemConflictError);
    expect(refusal.status).toBe(403);
  });

  it("refuses to reclassify an item under another purpose and keeps its bank binding", async () => {
    const { db, tables } = createFakeDb();
    await createPlaidItem(db, { ownerUserId: "u1", purpose: "bank_feed", itemId: "i1", accessToken: "t", bankAccountId: "ba-1" });
    const refusal = await createPlaidItem(db, { ownerUserId: "u1", purpose: "resident_pay", itemId: "i1", accessToken: "t" }).catch((e) => e);
    expect(refusal).toBeInstanceOf(PlaidItemConflictError);
    expect(refusal.status).toBe(409);
    // A reconnect names no bank account: the feed's binding survives.
    await createPlaidItem(db, { ownerUserId: "u1", purpose: "bank_feed", itemId: "i1", accessToken: "t2" });
    expect(tables.plaid_items).toHaveLength(1);
    expect(tables.plaid_items![0]).toMatchObject({ purpose: "bank_feed", bank_account_id: "ba-1" });
  });

  it("keeps only the last four of a mask", () => {
    expect(maskLastFour("0000-1234")).toBe("1234");
    expect(maskLastFour(null)).toBeNull();
  });
});
