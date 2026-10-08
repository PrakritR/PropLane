import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { isNumberSubscriptionEnabled, NUMBER_LAPSED_RELEASE_DAYS } from "@/lib/number-subscription/constants";
import { numberServiceEntitled } from "@/lib/number-subscription/subscription.server";

/**
 * PropLane Number (flag on): a resident whose subscription has been `canceled` or `incomplete` for more
 * than 30 days loses their number. Mirrors `releaseLapsedVendorWorkNumbers`, with two differences:
 *
 *  - Role-agnostic. One subscription per user funds the resident number whichever role it was first
 *    bought as (Settings provisions a resident number off any entitled subscription), so a lapse of any
 *    role's row releases it.
 *  - The scan starts from the NUMBERS, not the lapsed subscriptions, so a pile of old lapsed rows that
 *    own no number can never crowd a real one out of the batch.
 *
 * The provider remove rides the existing release queue and its cron worker
 * (`queue_resident_agent_number_release` writes the queue row and disables the number in one step). The
 * resident_agent_numbers row is then deleted: it would otherwise sit `disabled` forever and make a later
 * re-subscription skip provisioning, while the queue row carries the provider ids on its own.
 * Re-checks entitlement right before queuing, so a resident who just re-subscribed keeps the number.
 * While lapsed the agent never answers (`runResidentPersonalAgentReply` checks `numberServiceEntitled`).
 */
export async function releaseLapsedResidentAgentNumbers(
  db: SupabaseClient,
  options: { now?: Date; days?: number; limit?: number; scan?: number } = {},
): Promise<{ released: number; failed: number; kept: number }> {
  if (!isNumberSubscriptionEnabled()) return { released: 0, failed: 0, kept: 0 };
  const now = options.now ?? new Date();
  const cutoff = new Date(now.getTime() - (options.days ?? NUMBER_LAPSED_RELEASE_DAYS) * 86_400_000).toISOString();
  const maxReleases = Math.max(1, Math.min(options.limit ?? 20, 50));

  const { data: numbers, error } = await db
    .from("resident_agent_numbers")
    .select("id,resident_user_id")
    // `disabled` = queued by an earlier run whose row delete failed: queuing is idempotent, so the delete is simply retried.
    .in("state", ["ready", "reconciling", "blocked", "disabled"])
    .not("phone_number_sid", "is", null)
    .order("updated_at", { ascending: true })
    .limit(Math.max(1, Math.min(options.scan ?? 500, 1000)));
  if (error) {
    // An environment without the resident-number migration has nothing to release.
    if (error.code === "42P01" || error.code === "PGRST205") return { released: 0, failed: 0, kept: 0 };
    throw new Error(error.message);
  }
  const rows = (numbers ?? []) as { id: string; resident_user_id: string }[];
  if (rows.length === 0) return { released: 0, failed: 0, kept: 0 };

  const { data: lapsed, error: lapsedError } = await db
    .from("number_subscriptions")
    .select("owner_user_id")
    .in("owner_user_id", rows.map((row) => row.resident_user_id))
    .in("status", ["canceled", "incomplete"])
    .lt("updated_at", cutoff);
  if (lapsedError) throw new Error(lapsedError.message);
  const lapsedOwners = new Set(((lapsed ?? []) as { owner_user_id: string }[]).map((row) => row.owner_user_id));

  let released = 0;
  let failed = 0;
  let kept = 0;
  for (const row of rows) {
    if (released + failed >= maxReleases) break;
    if (!lapsedOwners.has(row.resident_user_id)) continue;
    try {
      if (await numberServiceEntitled(row.resident_user_id, db)) {
        kept += 1;
        continue;
      }
      const { error: queueError } = await db.rpc("queue_resident_agent_number_release", { p_user_id: row.resident_user_id });
      if (queueError) throw new Error(queueError.message);
      // Queued: the provider ids now live on the release queue. Free the row so a re-subscription provisions afresh.
      const { error: deleteError } = await db.from("resident_agent_numbers").delete().eq("id", row.id).eq("state", "disabled");
      if (deleteError) throw new Error(deleteError.message);
      released += 1;
    } catch (cause) {
      failed += 1;
      console.error("[resident number] lapsed release failed", cause instanceof Error ? cause.message : "unknown");
    }
  }
  return { released, failed, kept };
}
