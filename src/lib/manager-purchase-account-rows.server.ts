import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * The `manager_purchases` rows that belong to ONE account.
 *
 * A row is the account's when it carries the account's `user_id` OR the account's email: the pre-auth
 * signup path writes the waiver row with `email` / `manager_id` and no `user_id` yet, so a `user_id`-only
 * read silently misses the row the plan resolver is reading. Anything that decides, shows or ends an
 * account's plan goes through here so the two can never disagree.
 *
 * `readFailed` separates "this account has no row" from "we could not find out" - they look identical
 * (zero rows) and mean opposite things to a quota or a refusal. A failed `profiles` read counts: it blanks
 * the email and silently drops the by-email half.
 */
export async function loadAccountPurchaseRows<T extends { id: string }>(
  db: SupabaseClient,
  userId: string,
  /** PostgREST select list; it MUST include `id`, which is how the two halves are merged. */
  select: string,
): Promise<{ rows: T[]; readFailed: boolean }> {
  const id = userId.trim();
  if (!id) return { rows: [], readFailed: false };

  const { data: profile, error: profileError } = await db
    .from("profiles")
    .select("email")
    .eq("id", id)
    .maybeSingle();
  const email = String((profile as { email?: unknown } | null)?.email ?? "").trim().toLowerCase();

  const [byUserId, byEmail] = await Promise.all([
    db.from("manager_purchases").select(select).eq("user_id", id),
    email
      ? db.from("manager_purchases").select(select).ilike("email", email)
      : Promise.resolve({ data: [] as unknown[], error: null }),
  ]);

  const merged = new Map<string, T>();
  for (const row of [...(byUserId.data ?? []), ...(byEmail.data ?? [])]) {
    merged.set(String((row as { id?: unknown }).id), row as T);
  }
  return {
    rows: [...merged.values()],
    readFailed: Boolean(profileError) || Boolean(byUserId.error) || Boolean(byEmail.error),
  };
}
