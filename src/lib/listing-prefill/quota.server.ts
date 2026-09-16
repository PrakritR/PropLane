import "server-only";

/**
 * The 30-day address cache and the per-plan lookup quota.
 *
 * Both tables are service-role only (`supabase/migrations/*_listing_prefill.sql`).
 * The cache holds provider answers keyed by normalized address and no account
 * data, so it survives an account purge; usage is per manager per month and
 * purges with the account.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { ManagerSkuTier } from "@/lib/manager-access";
import { getEffectiveManagerSkuTier } from "@/lib/manager-access-server";
import type { AddressFacts, RentEstimate } from "./types";

export const PREFILL_CACHE_DAYS = 30;
/** Lookups a Free workspace gets each calendar month; Pro and Business are uncapped. */
export const FREE_PLAN_MONTHLY_LOOKUPS = 3;

export type CachedPrefill = {
  facts: AddressFacts | null;
  rent: RentEstimate | null;
  source: "rentcast" | "fixture";
};

/**
 * A cached answer counts only when it came from the provider in use: a fixture
 * row must never stand in for RentCast (made-up facts on a real lookup), and a
 * RentCast row is not replayed by the fixture either.
 */
export async function readPrefillCache(db: SupabaseClient, addressKey: string, source: "rentcast" | "fixture"): Promise<CachedPrefill | null> {
  const since = new Date(Date.now() - PREFILL_CACHE_DAYS * 86_400_000).toISOString();
  const { data, error } = await db
    .from("listing_prefill_cache")
    .select("facts, rent, source, fetched_at")
    .eq("address_key", addressKey)
    .eq("source", source)
    .gte("fetched_at", since)
    .maybeSingle();
  if (error || !data) return null;
  return {
    facts: (data.facts as AddressFacts | null) ?? null,
    rent: (data.rent as RentEstimate | null) ?? null,
    source: data.source === "fixture" ? "fixture" : "rentcast",
  };
}

export async function writePrefillCache(db: SupabaseClient, addressKey: string, value: CachedPrefill): Promise<void> {
  await db.from("listing_prefill_cache").upsert(
    {
      address_key: addressKey,
      facts: value.facts,
      rent: value.rent,
      source: value.source,
      fetched_at: new Date().toISOString(),
    },
    { onConflict: "address_key" },
  );
}

export function monthKey(now = new Date()): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
}

export function monthlyLookupLimitForTier(tier: ManagerSkuTier | null): number | null {
  return tier === "pro" || tier === "business" ? null : FREE_PLAN_MONTHLY_LOOKUPS;
}

export type LookupQuotaVerdict =
  | { ok: true; left: number | null }
  | { ok: false; reason: "quota"; left: 0 }
  | { ok: false; reason: "unreadable"; error: string };

/**
 * Spend one lookup for this manager this month, or refuse.
 *
 * The plan read fails closed: an unreadable plan is reported, never treated as
 * Free (which would refuse a paying manager) nor as unlimited.
 */
export async function consumeLookup(db: SupabaseClient, userId: string, now = new Date()): Promise<LookupQuotaVerdict> {
  const tier = await getEffectiveManagerSkuTier(userId);
  if (!tier.ok) return { ok: false, reason: "unreadable", error: tier.error };
  const limit = monthlyLookupLimitForTier(tier.tier);
  const month = monthKey(now);
  const { data, error } = await db
    .from("listing_prefill_usage")
    .select("count")
    .eq("manager_user_id", userId)
    .eq("month", month)
    .maybeSingle();
  if (error) return { ok: false, reason: "unreadable", error: error.message };
  const used = typeof data?.count === "number" ? data.count : 0;
  if (limit != null && used >= limit) return { ok: false, reason: "quota", left: 0 };
  const { error: writeError } = await db
    .from("listing_prefill_usage")
    .upsert({ manager_user_id: userId, month, count: used + 1, updated_at: new Date().toISOString() }, { onConflict: "manager_user_id,month" });
  if (writeError) return { ok: false, reason: "unreadable", error: writeError.message };
  return { ok: true, left: limit == null ? null : Math.max(0, limit - used - 1) };
}
