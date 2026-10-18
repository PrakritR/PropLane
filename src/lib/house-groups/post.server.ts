import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * The one door every automated or announced post to a house group chat goes through. W10 (house
 * groups) implements it; this stub keeps the signature fixed so the preset spine can call it today.
 * `not_enabled` = groups are not live for this house, which the automations treat as "no group".
 */
export type HouseGroupPostResult =
  | { ok: true; messageSid: string }
  | { ok: false; reason: "no_group" | "not_enabled" | "quiet_hours" | "rate_limited" | "provider_error" };

export async function postToHouseGroup(
  _db: SupabaseClient,
  _input: { workspaceId: string; propertyId: string; text: string; kind: string; idempotencyKey: string },
): Promise<HouseGroupPostResult> {
  return { ok: false, reason: "not_enabled" };
}
