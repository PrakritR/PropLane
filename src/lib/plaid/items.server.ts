import "server-only";

import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { decryptSensitiveValue, encryptSensitiveValue } from "@/lib/security/data-encryption";
import { getPlaidClient, plaidFailure, type PlaidPurpose } from "@/lib/plaid/client.server";

export type PlaidItemStatus = "active" | "login_required" | "error" | "revoked";

/** The row as the server reads it. `access_token_enc` never leaves this module's callers. */
export type PlaidItemRow = {
  id: string;
  owner_user_id: string;
  workspace_id: string | null;
  purpose: PlaidPurpose;
  item_id: string;
  access_token_enc: string;
  institution_name: string | null;
  account_mask: string | null;
  account_name: string | null;
  plaid_account_id: string | null;
  bank_account_id: string | null;
  transactions_cursor: string | null;
  status: PlaidItemStatus;
  last_error: string | null;
  last_synced_at: string | null;
};

/** What a client may see: no token, no cursor, no Plaid ids. */
export type PlaidItemView = {
  id: string;
  purpose: PlaidPurpose;
  institutionName: string | null;
  accountMask: string | null;
  accountName: string | null;
  bankAccountId: string | null;
  status: PlaidItemStatus;
  lastSyncedAt: string | null;
};

const ITEM_SELECT =
  "id, owner_user_id, workspace_id, purpose, item_id, access_token_enc, institution_name, account_mask, account_name, plaid_account_id, bank_account_id, transactions_cursor, status, last_error, last_synced_at";

/** AAD binds the ciphertext to its owner and row: a copied token fails closed anywhere else. */
function tokenContext(ownerId: string, rowId: string) {
  return { purpose: "plaid", ownerId, recordId: rowId, field: "access_token" };
}

export function toPlaidItemView(row: PlaidItemRow): PlaidItemView {
  return {
    id: row.id,
    purpose: row.purpose,
    institutionName: row.institution_name,
    accountMask: row.account_mask,
    accountName: row.account_name,
    bankAccountId: row.bank_account_id,
    status: row.status,
    lastSyncedAt: row.last_synced_at,
  };
}

/** Last four characters only; anything else is dropped before it can be stored. */
export function maskLastFour(value: unknown): string | null {
  const text = typeof value === "string" ? value.replace(/[^0-9A-Za-z]/g, "") : "";
  return text ? text.slice(-4) : null;
}

export type CreatePlaidItemInput = {
  /** Always the session user, never a request body field. */
  ownerUserId: string;
  purpose: PlaidPurpose;
  workspaceId?: string | null;
  itemId: string;
  accessToken: string;
  institutionName?: string | null;
  accountMask?: string | null;
  accountName?: string | null;
  plaidAccountId?: string | null;
  bankAccountId?: string | null;
};

/**
 * A refusal, not a failure: this bank login is already held for someone else or for another purpose.
 * Carries the status the caller answers with, so it never falls into a route's "couldn't reach your
 * bank" catch-all the way a bare `Error` would.
 */
export class PlaidItemConflictError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "PlaidItemConflictError";
    this.status = status;
  }
}

export async function createPlaidItem(db: SupabaseClient, input: CreatePlaidItemInput): Promise<PlaidItemRow> {
  if (!input.ownerUserId) throw new Error("Owner is required.");
  const now = new Date().toISOString();

  const { data: existing, error: readError } = await db
    .from("plaid_items")
    .select("id, owner_user_id, purpose, bank_account_id")
    .eq("item_id", input.itemId)
    .maybeSingle();
  if (readError) throw new Error(readError.message);
  if (existing && existing.owner_user_id !== input.ownerUserId) {
    throw new PlaidItemConflictError("This bank connection belongs to another account.", 403);
  }
  // A row's purpose is fixed for its life: re-exchanging the same Plaid item under another purpose would
  // reclassify a manager's bank feed (and orphan the statements bound to it) while its cursor stayed behind.
  if (existing && existing.purpose && existing.purpose !== input.purpose) {
    throw new PlaidItemConflictError("This bank login is already connected for something else. Unlink it first.", 409);
  }

  const id = existing?.id ? String(existing.id) : randomUUID();
  // Reconnect (update mode) sends no bank account: keep the one the feed is already bound to.
  const bankAccountId = input.bankAccountId ?? (existing?.bank_account_id ? String(existing.bank_account_id) : null);
  const fields = {
    owner_user_id: input.ownerUserId,
    workspace_id: input.workspaceId ?? null,
    purpose: input.purpose,
    item_id: input.itemId,
    access_token_enc: encryptSensitiveValue(input.accessToken, tokenContext(input.ownerUserId, id)),
    institution_name: input.institutionName?.trim().slice(0, 120) || null,
    account_mask: maskLastFour(input.accountMask),
    account_name: input.accountName?.trim().slice(0, 120) || null,
    plaid_account_id: input.plaidAccountId ?? null,
    bank_account_id: bankAccountId,
    status: "active",
    last_error: null,
    updated_at: now,
  };
  const query = existing
    ? db.from("plaid_items").update(fields).eq("id", id).eq("owner_user_id", input.ownerUserId)
    : db.from("plaid_items").insert({ id, ...fields });
  const { data, error } = await query.select(ITEM_SELECT).single();
  if (error || !data) throw new Error(error?.message ?? "Could not save the bank connection.");
  return data as unknown as PlaidItemRow;
}

export async function listPlaidItemsForOwner(
  db: SupabaseClient,
  ownerUserId: string,
  purpose: PlaidPurpose,
): Promise<PlaidItemRow[]> {
  const { data, error } = await db
    .from("plaid_items")
    .select(ITEM_SELECT)
    .eq("owner_user_id", ownerUserId)
    .eq("purpose", purpose)
    .neq("status", "revoked")
    .order("created_at", { ascending: true })
    .limit(50);
  if (error) throw new Error(error.message);
  return (data ?? []) as unknown as PlaidItemRow[];
}

export async function getPlaidItemForOwner(
  db: SupabaseClient,
  ownerUserId: string,
  id: string,
): Promise<PlaidItemRow | null> {
  const { data, error } = await db
    .from("plaid_items")
    .select(ITEM_SELECT)
    .eq("id", id)
    .eq("owner_user_id", ownerUserId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return (data as unknown as PlaidItemRow | null) ?? null;
}

/** Webhook path: Plaid names the item by its own id. */
export async function getPlaidItemByPlaidItemId(db: SupabaseClient, itemId: string): Promise<PlaidItemRow | null> {
  const { data, error } = await db.from("plaid_items").select(ITEM_SELECT).eq("item_id", itemId).maybeSingle();
  if (error) throw new Error(error.message);
  return (data as unknown as PlaidItemRow | null) ?? null;
}

export function readPlaidAccessToken(row: Pick<PlaidItemRow, "id" | "owner_user_id" | "access_token_enc">): string {
  return decryptSensitiveValue(row.access_token_enc, tokenContext(row.owner_user_id, row.id));
}

export type PlaidItemPatch = Partial<{
  status: PlaidItemStatus;
  last_error: string | null;
  last_synced_at: string | null;
  transactions_cursor: string | null;
}>;

export async function updatePlaidItem(db: SupabaseClient, id: string, patch: PlaidItemPatch): Promise<void> {
  const { error } = await db
    .from("plaid_items")
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq("id", id);
  if (error) throw new Error(error.message);
}

/** A short single-flight claim so a webhook and the cron never sync one item at once. */
export async function claimPlaidSync(db: SupabaseClient, id: string, holdSeconds = 120): Promise<boolean> {
  const now = new Date();
  const until = new Date(now.getTime() + holdSeconds * 1000).toISOString();
  const { data, error } = await db
    .from("plaid_items")
    .update({ sync_lock_until: until })
    .eq("id", id)
    .or(`sync_lock_until.is.null,sync_lock_until.lt.${now.toISOString()}`)
    .select("id");
  if (error) throw new Error(error.message);
  return (data ?? []).length > 0;
}

export async function releasePlaidSync(db: SupabaseClient, id: string): Promise<void> {
  await db.from("plaid_items").update({ sync_lock_until: null }).eq("id", id);
}

/**
 * Best-effort /item/remove for an owner's items, run before the rows are purged. A Plaid
 * failure never blocks account deletion. `purposes` limits it to one portal's items.
 */
export async function removePlaidItemsForOwner(
  db: SupabaseClient,
  ownerUserId: string,
  purposes?: readonly PlaidPurpose[],
): Promise<void> {
  if (!ownerUserId) return;
  // An explicit empty list means this portal owns no Plaid purpose: nothing to revoke.
  if (purposes && purposes.length === 0) return;
  try {
    let query = db.from("plaid_items").select(ITEM_SELECT).eq("owner_user_id", ownerUserId);
    if (purposes) query = query.in("purpose", [...purposes]);
    const { data } = await query.limit(200);
    for (const row of (data ?? []) as unknown as PlaidItemRow[]) {
      try {
        await getPlaidClient().itemRemove({ access_token: readPlaidAccessToken(row) });
      } catch (error) {
        console.warn("[plaid] item remove failed", plaidFailure(error).code);
      }
    }
  } catch {
    /* Plaid disabled or unreadable: the manifest still deletes the rows. */
  }
}
