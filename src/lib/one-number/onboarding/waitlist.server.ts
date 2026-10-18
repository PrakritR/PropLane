import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { countFinishedLandlordSetups, type SetupLink } from "@/lib/one-number/onboarding/setup-links.server";

/**
 * Optional design-partner cap (`ONE_NUMBER_WAITLIST`, default OFF). With the flag off there is no gate
 * at all and nothing here reads the database. With it on, a NEW landlord finishing setup by text is
 * admitted only while fewer than `ONE_NUMBER_WAITLIST_CAP` landlords have finished that way; the rest
 * are marked waitlisted (the link stays valid and is re-checked on the next visit). A link minted by an
 * existing manager's `invite` skips the cap. An unreadable count fails closed to the waitlist.
 */
export const DEFAULT_WAITLIST_CAP = 10;

export function waitlistConfig(env: NodeJS.ProcessEnv = process.env): { enabled: boolean; cap: number } {
  const flag = (env.ONE_NUMBER_WAITLIST ?? "").trim().toLowerCase();
  const enabled = flag === "1" || flag === "true" || flag === "on";
  const cap = Number.parseInt(env.ONE_NUMBER_WAITLIST_CAP ?? "", 10);
  return { enabled, cap: Number.isFinite(cap) && cap >= 0 ? cap : DEFAULT_WAITLIST_CAP };
}

export type WaitlistDecision = { admit: true } | { admit: false; reason: "cap_reached" | "unreadable" };

export async function decideWaitlist(db: SupabaseClient, link: Pick<SetupLink, "kind" | "invitedByWorkspaceId">, env: NodeJS.ProcessEnv = process.env): Promise<WaitlistDecision> {
  const { enabled, cap } = waitlistConfig(env);
  if (!enabled || link.kind !== "landlord" || link.invitedByWorkspaceId) return { admit: true };
  const finished = await countFinishedLandlordSetups(db);
  if (finished === null) return { admit: false, reason: "unreadable" };
  return finished < cap ? { admit: true } : { admit: false, reason: "cap_reached" };
}
