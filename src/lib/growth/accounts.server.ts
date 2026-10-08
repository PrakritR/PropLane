import "server-only";

import { growthDb, mapAccount, must, type GrowthDb } from "./db.server";
import type { GrowthAccount, GrowthPlatform, GrowthPublisherId } from "./types";

export async function listAccounts(db: GrowthDb = growthDb()): Promise<GrowthAccount[]> {
  const rows = must(await db.from("growth_accounts").select("*").order("created_at"), "list accounts");
  return (rows as Record<string, unknown>[]).map(mapAccount);
}

export async function createAccount(
  input: { platform: GrowthPlatform; handle: string; publisher: GrowthPublisherId; vendorAccountId?: string | null },
  db: GrowthDb = growthDb(),
): Promise<GrowthAccount> {
  const row = must(
    await db
      .from("growth_accounts")
      .insert({ platform: input.platform, handle: input.handle, publisher: input.publisher, vendor_account_id: input.vendorAccountId ?? null })
      .select("*")
      .single(),
    "create account",
  );
  return mapAccount(row as Record<string, unknown>);
}

export async function patchAccount(
  id: string,
  patch: { status?: GrowthAccount["status"]; handle?: string; vendorAccountId?: string | null; publisher?: GrowthPublisherId },
  db: GrowthDb = growthDb(),
): Promise<GrowthAccount> {
  const row: Record<string, unknown> = {};
  if (patch.status !== undefined) row.status = patch.status;
  if (patch.handle !== undefined) row.handle = patch.handle;
  if (patch.vendorAccountId !== undefined) row.vendor_account_id = patch.vendorAccountId;
  if (patch.publisher !== undefined) row.publisher = patch.publisher;
  const data = must(await db.from("growth_accounts").update(row).eq("id", id).select("*").maybeSingle(), "patch account");
  if (!data) throw new Error("Account not found");
  return mapAccount(data as Record<string, unknown>);
}
