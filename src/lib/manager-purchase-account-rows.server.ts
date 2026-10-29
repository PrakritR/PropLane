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
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, "\\$&");
}

export async function loadAccountPurchaseRows<T extends { id: string }>(
  db: SupabaseClient,
  userId: string,
  /** PostgREST select list; it MUST include `id`, which is how the two halves are merged. */
  select: string,
): Promise<{ rows: T[]; readFailed: boolean }> {
  const id = userId.trim();
  if (!id) return { rows: [], readFailed: false };
  // `id` is interpolated into a PostgREST `or` filter below, so only a real auth uuid is accepted.
  if (!UUID_PATTERN.test(id)) return { rows: [], readFailed: true };

  const { data: profile, error: profileError } = await db
    .from("profiles")
    .select("email")
    .eq("id", id)
    .maybeSingle();
  const email = String((profile as { email?: unknown } | null)?.email ?? "").trim().toLowerCase();

  const [byUserId, byEmail] = await Promise.all([
    db.from("manager_purchases").select(select).eq("user_id", id),
    email
      ? db
          .from("manager_purchases")
          .select(select)
          // Exact, case-insensitive match: `_` and `%` in an address are LIKE wildcards, so they are
          // escaped or `a_b@x.com` would pull in `a.b@x.com`'s rows. A by-email row already claimed by a
          // DIFFERENT account is never this account's.
          .ilike("email", escapeLikePattern(email))
          .or(`user_id.is.null,user_id.eq.${id}`)
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
