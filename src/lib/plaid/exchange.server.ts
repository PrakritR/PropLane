import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { AccountType, type PlaidApi } from "plaid";
import type { PlaidPurpose } from "@/lib/plaid/client.server";
import type { CreatePlaidItemInput, PlaidItemRow } from "@/lib/plaid/items.server";

export type ExchangeDeps = {
  db: SupabaseClient;
  client: Pick<PlaidApi, "itemPublicTokenExchange" | "accountsGet" | "institutionsGetById">;
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
  }

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
  return { ok: true, item };
}
