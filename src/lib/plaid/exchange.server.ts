import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { AccountType, type PlaidApi } from "plaid";
import { plaidFailure, type PlaidPurpose } from "@/lib/plaid/client.server";
import { PlaidItemConflictError, type CreatePlaidItemInput, type PlaidItemRow } from "@/lib/plaid/items.server";

export type ExchangeDeps = {
  db: SupabaseClient;
  client: Pick<PlaidApi, "itemPublicTokenExchange" | "accountsGet" | "institutionsGetById" | "itemRemove">;
  createItem: (db: SupabaseClient, input: CreatePlaidItemInput) => Promise<PlaidItemRow>;
  /** Makes the manager's bank account from the linked account when none was picked first. */
  createBankAccount?: (
    db: SupabaseClient,
    input: { managerUserId: string; name: string; accountType: "operating"; lastFour: string | null },
  ) => Promise<{ id: string }>;
};

export type ExchangeInput = {
  /** The session user. Never taken from a request body. */
  ownerUserId: string;
  purpose: PlaidPurpose;
  publicToken: string;
  bankAccountId: string | null;
  preferredPlaidAccountId: string | null;
};

export type ExchangeResult =
  | { ok: true; item: PlaidItemRow }
  | { ok: false; status: number; error: string };

/**
 * Exchange, read the one account the feed follows (a depository account, the one the user
 * picked when Plaid reports it), and store the item for `ownerUserId`. Account and routing
 * numbers are never requested; only the last four digits (mask) are kept.
 *
 * The exchanged access token lives only in this call until `createItem` stores it encrypted, so every way out
 * of here that does NOT store it removes the Item at Plaid first: a refusal (no account shared, a foreign
 * owner, a purpose change, the one-live-feed race), a failed bank-account or row write, and an unreadable key
 * store alike. Otherwise the user's bank keeps a live PropLane connection nothing on our side can reach or
 * revoke - not even deleting the account, which walks stored rows.
 */
export async function exchangePublicToken(deps: ExchangeDeps, input: ExchangeInput): Promise<ExchangeResult> {
  if (input.purpose === "bank_feed" && !input.bankAccountId && !deps.createBankAccount) {
    return { ok: false, status: 400, error: "Choose a bank account first." };
  }
  if (input.purpose === "bank_feed" && input.bankAccountId) {
    const { data: account, error } = await deps.db
      .from("manager_bank_accounts")
      .select("id")
      .eq("id", input.bankAccountId)
      .eq("manager_user_id", input.ownerUserId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!account) return { ok: false, status: 404, error: "Bank account not found." };
  }

  const exchanged = await deps.client.itemPublicTokenExchange({ public_token: input.publicToken });
  const accessToken = exchanged.data.access_token;
  const plaidItemId = exchanged.data.item_id;

  let stored = false;
  try {
    const accountsRes = await deps.client.accountsGet({ access_token: accessToken });
    const accounts = accountsRes.data.accounts;
    const depository = accounts.filter((a) => a.type === AccountType.Depository);
    const pool = depository.length > 0 ? depository : accounts;
    const chosen = pool.find((a) => a.account_id === input.preferredPlaidAccountId) ?? pool[0];
    if (!chosen) return { ok: false, status: 422, error: "No account was shared." };

    let institutionName: string | null = null;
    const institutionId = accountsRes.data.item.institution_id;
    if (institutionId) {
      try {
        const inst = await deps.client.institutionsGetById({ institution_id: institutionId, country_codes: ["US" as never] });
        institutionName = inst.data.institution.name;
      } catch {
        institutionName = null;
      }
    }

    let bankAccountId = input.purpose === "bank_feed" ? input.bankAccountId : null;
    /** The account this exchange made itself, so a refused item never leaves an empty one behind. */
    let createdBankAccountId: string | null = null;
    if (input.purpose === "bank_feed" && !bankAccountId) {
      // No account picked yet (an empty Bank rec): the linked account becomes the manager's operating account.
      const label = [institutionName, chosen.name ?? chosen.official_name].filter(Boolean).join(" ").trim() || "Bank account";
      const created = await deps.createBankAccount!(deps.db, {
        managerUserId: input.ownerUserId,
        name: label,
        accountType: "operating",
        lastFour: chosen.mask ?? null,
      });
      bankAccountId = created.id;
      createdBankAccountId = created.id;
    }

    try {
      const item = await deps.createItem(deps.db, {
        ownerUserId: input.ownerUserId,
        purpose: input.purpose,
        itemId: plaidItemId,
        accessToken,
        institutionName,
        accountMask: chosen.mask ?? null,
        accountName: chosen.name ?? chosen.official_name ?? null,
        plaidAccountId: chosen.account_id,
        bankAccountId,
      });
      stored = true;
      return { ok: true, item };
    } catch (error) {
      // The item is what the account was made for. A refusal (a foreign owner, a purpose change, the race the
      // unique index catches) is retried by the manager, so an account left behind here becomes one more empty
      // row per attempt. It was created moments ago by this request alone and nothing else can reference it yet.
      await rollBackCreatedBankAccount(deps, input.ownerUserId, createdBankAccountId);
      if (error instanceof PlaidItemConflictError) return { ok: false, status: error.status, error: error.message };
      throw error;
    }
  } finally {
    if (!stored) await revokeExchangedItem(deps, accessToken);
  }
}

/** Best effort, like the account rollback: a failed revoke must not replace what the caller has to report. */
async function revokeExchangedItem(deps: ExchangeDeps, accessToken: string): Promise<void> {
  try {
    await deps.client.itemRemove({ access_token: accessToken });
  } catch (error) {
    console.warn("[plaid] item remove failed", plaidFailure(error).code);
  }
}

/** Best effort: a rollback that fails must not replace the refusal the caller has to report. */
async function rollBackCreatedBankAccount(deps: ExchangeDeps, ownerUserId: string, bankAccountId: string | null): Promise<void> {
  if (!bankAccountId) return;
  try {
    const { error } = await deps.db
      .from("manager_bank_accounts")
      .delete()
      .eq("id", bankAccountId)
      .eq("manager_user_id", ownerUserId);
    if (error) throw new Error(error.message);
  } catch (cleanupError) {
    console.warn("[plaid] bank account rollback failed", cleanupError instanceof Error ? cleanupError.message.slice(0, 300) : "unknown");
  }
}
