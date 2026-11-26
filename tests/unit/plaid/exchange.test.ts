import { describe, expect, it, vi } from "vitest";
import { exchangePublicToken } from "@/lib/plaid/exchange.server";
import { PlaidItemConflictError } from "@/lib/plaid/items.server";
import { createFakeDb } from "./fake-db";

function client() {
  return {
    itemPublicTokenExchange: vi.fn(async () => ({ data: { access_token: "access-sandbox-xyz", item_id: "plaid-item-1" } })),
    accountsGet: vi.fn(async () => ({
      data: {
        item: { institution_id: "ins_109508" },
        accounts: [
          { account_id: "acc-credit", type: "credit", mask: "1111", name: "Card" },
          { account_id: "acc-1", type: "depository", mask: "0000", name: "Plaid Checking" },
        ],
      },
    })),
    institutionsGetById: vi.fn(async () => ({ data: { institution: { name: "First Platypus Bank" } } })),
    itemRemove: vi.fn(async () => ({ data: { request_id: "req-1" } })),
  };
}

describe("exchangePublicToken", () => {
  it("stores the item under the session user, last four only", async () => {
    const { db, tables } = createFakeDb({ manager_bank_accounts: [{ id: "ba-1", manager_user_id: "user-1" }] });
    const createItem = vi.fn(async (_db: unknown, input: Record<string, unknown>) => ({ id: "row-1", institution_name: input.institutionName, account_mask: input.accountMask, account_name: input.accountName }) as never);
    const result = await exchangePublicToken(
      { db, client: client() as never, createItem: createItem as never },
      { ownerUserId: "user-1", purpose: "bank_feed", publicToken: "public-sandbox-1", bankAccountId: "ba-1", preferredPlaidAccountId: null },
    );
    expect(result.ok).toBe(true);
    const input = createItem.mock.calls[0]![1];
    expect(input.ownerUserId).toBe("user-1");
    expect(input.plaidAccountId).toBe("acc-1");
    expect(input.accountMask).toBe("0000");
    expect(input.institutionName).toBe("First Platypus Bank");
    expect(JSON.stringify(input)).not.toMatch(/routing|account_number/i);
    expect(tables.plaid_items).toHaveLength(0);
  });

  it("refuses another manager's bank account before touching Plaid", async () => {
    const { db } = createFakeDb({ manager_bank_accounts: [{ id: "ba-1", manager_user_id: "someone-else" }] });
    const c = client();
    const result = await exchangePublicToken(
      { db, client: c as never, createItem: vi.fn() as never },
      { ownerUserId: "user-1", purpose: "bank_feed", publicToken: "p", bankAccountId: "ba-1", preferredPlaidAccountId: null },
    );
    expect(result).toMatchObject({ ok: false, status: 404 });
    expect(c.itemPublicTokenExchange).not.toHaveBeenCalled();
  });

  it("requires a bank account for a bank feed", async () => {
    const { db } = createFakeDb();
    const result = await exchangePublicToken(
      { db, client: client() as never, createItem: vi.fn() as never },
      { ownerUserId: "user-1", purpose: "bank_feed", publicToken: "p", bankAccountId: null, preferredPlaidAccountId: null },
    );
    expect(result).toMatchObject({ ok: false, status: 400 });
  });

  it("answers an item conflict as its own refusal, never as 'couldn't reach your bank'", async () => {
    const { db } = createFakeDb({ manager_bank_accounts: [{ id: "ba-1", manager_user_id: "user-1" }] });
    const createItem = vi.fn(async () => {
      throw new PlaidItemConflictError("This bank login is already connected for something else. Unlink it first.", 409);
    });
    const result = await exchangePublicToken(
      { db, client: client() as never, createItem: createItem as never },
      { ownerUserId: "user-1", purpose: "bank_feed", publicToken: "p", bankAccountId: "ba-1", preferredPlaidAccountId: null },
    );
    expect(result).toMatchObject({ ok: false, status: 409 });
    expect(result.ok === false && result.error).toMatch(/already connected/);
  });

  // An access token this call does not STORE is the only copy there will ever be: the Item has to be removed at
  // Plaid before the refusal is returned, or the user's bank keeps a live PropLane connection no later code can
  // reach - `removePlaidItemsForOwner` (even on account deletion) walks stored rows only. Oracle: Plaid's
  // /item/remove contract plus the sibling exchange path `computeIncomeFromPublicToken`, which removes the Item
  // in a `finally` "so a failure at any step still leaves no access token behind". Plausible wrong behaviour this
  // rejects: returning the refusal (or rethrowing) with the Item still live, as every retry adds another.
  it("removes the Item at Plaid on every exit that does not store it, and logs no token", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      for (const failure of [
        new PlaidItemConflictError("This bank login can't be connected here.", 403),
        new PlaidItemConflictError("This bank account is already connected. Reconnect that connection instead.", 409),
        new Error("DATA_ENCRYPTION_ACTIVE_KEY_ID is not set"),
      ]) {
        const { db } = createFakeDb({ manager_bank_accounts: [{ id: "ba-1", manager_user_id: "user-1" }] });
        const c = client();
        const createItem = vi.fn(async () => {
          throw failure;
        });
        const run = exchangePublicToken(
          { db, client: c as never, createItem: createItem as never },
          { ownerUserId: "user-1", purpose: "bank_feed", publicToken: "p", bankAccountId: "ba-1", preferredPlaidAccountId: null },
        );
        if (failure instanceof PlaidItemConflictError) await expect(run).resolves.toMatchObject({ ok: false });
        else await expect(run).rejects.toThrow(/DATA_ENCRYPTION/);
        expect(c.itemRemove.mock.calls).toEqual([[{ access_token: "access-sandbox-xyz" }]]);
      }

      // A bank that shares no usable account is the same situation: nothing was stored.
      const { db } = createFakeDb({ manager_bank_accounts: [{ id: "ba-1", manager_user_id: "user-1" }] });
      const empty = client();
      empty.accountsGet = vi.fn(async () => ({ data: { item: { institution_id: null }, accounts: [] } })) as never;
      const refused = await exchangePublicToken(
        { db, client: empty as never, createItem: vi.fn() as never },
        { ownerUserId: "user-1", purpose: "bank_feed", publicToken: "p", bankAccountId: "ba-1", preferredPlaidAccountId: null },
      );
      expect(refused).toMatchObject({ ok: false, status: 422 });
      expect(empty.itemRemove).toHaveBeenCalledTimes(1);

      // A revoke that itself fails still reports the original refusal, and never prints the token.
      const { db: db2 } = createFakeDb({ manager_bank_accounts: [{ id: "ba-1", manager_user_id: "user-1" }] });
      const broken = client();
      broken.itemRemove = vi.fn(async () => {
        throw { response: { data: { error_code: "ITEM_NOT_FOUND", error_type: "ITEM_ERROR", error_message: "x" }, status: 400 } };
      }) as never;
      const stillRefused = await exchangePublicToken(
        { db: db2, client: broken as never, createItem: vi.fn(async () => { throw new PlaidItemConflictError("Nope.", 409); }) as never },
        { ownerUserId: "user-1", purpose: "bank_feed", publicToken: "p", bankAccountId: "ba-1", preferredPlaidAccountId: null },
      );
      expect(stillRefused).toMatchObject({ ok: false, status: 409 });
      expect(JSON.stringify(warn.mock.calls)).not.toContain("access-sandbox-xyz");
      expect(JSON.stringify(warn.mock.calls)).toContain("ITEM_NOT_FOUND");
    } finally {
      warn.mockRestore();
    }
  });

  it("keeps the stored item's login: a connection that succeeded is never removed", async () => {
    const { db } = createFakeDb({ manager_bank_accounts: [{ id: "ba-1", manager_user_id: "user-1" }] });
    const c = client();
    const result = await exchangePublicToken(
      { db, client: c as never, createItem: vi.fn(async () => ({ id: "row-1" }) as never) as never },
      { ownerUserId: "user-1", purpose: "bank_feed", publicToken: "p", bankAccountId: "ba-1", preferredPlaidAccountId: null },
    );
    expect(result.ok).toBe(true);
    expect(c.itemRemove).not.toHaveBeenCalled();
  });

  it("leaves no empty bank account behind when the item is refused", async () => {
    const { db, tables } = createFakeDb();
    const createBankAccount = vi.fn(async () => {
      tables.manager_bank_accounts!.push({ id: "ba-new", manager_user_id: "user-1" });
      return { id: "ba-new" };
    });
    const createItem = vi.fn(async () => {
      throw new PlaidItemConflictError("This bank login can't be connected here.", 403);
    });
    const result = await exchangePublicToken(
      { db, client: client() as never, createItem: createItem as never, createBankAccount },
      { ownerUserId: "user-1", purpose: "bank_feed", publicToken: "p", bankAccountId: null, preferredPlaidAccountId: null },
    );
    expect(result).toMatchObject({ ok: false, status: 403 });
    expect(tables.manager_bank_accounts).toHaveLength(0);
  });

  it("keeps the bank account the manager picked themselves when the item is refused", async () => {
    const { db, tables } = createFakeDb({ manager_bank_accounts: [{ id: "ba-1", manager_user_id: "user-1" }] });
    const createItem = vi.fn(async () => {
      throw new PlaidItemConflictError("This bank account is already connected. Reconnect that connection instead.", 409);
    });
    const result = await exchangePublicToken(
      { db, client: client() as never, createItem: createItem as never },
      { ownerUserId: "user-1", purpose: "bank_feed", publicToken: "p", bankAccountId: "ba-1", preferredPlaidAccountId: null },
    );
    expect(result).toMatchObject({ ok: false, status: 409 });
    expect(tables.manager_bank_accounts).toHaveLength(1);
  });

  it("makes the manager's operating account from the linked account when none was picked", async () => {
    const { db } = createFakeDb();
    const createItem = vi.fn(async (_db: unknown, input: Record<string, unknown>) => ({ id: "row-2", bank_account_id: input.bankAccountId }) as never);
    const createBankAccount = vi.fn(async () => ({ id: "ba-new" }));
    const result = await exchangePublicToken(
      { db, client: client() as never, createItem: createItem as never, createBankAccount },
      { ownerUserId: "user-1", purpose: "bank_feed", publicToken: "p", bankAccountId: null, preferredPlaidAccountId: null },
    );
    expect(result.ok).toBe(true);
    expect(createBankAccount).toHaveBeenCalledWith(db, { managerUserId: "user-1", name: "First Platypus Bank Plaid Checking", accountType: "operating", lastFour: "0000" });
    expect(createItem.mock.calls[0]![1].bankAccountId).toBe("ba-new");
  });
});
