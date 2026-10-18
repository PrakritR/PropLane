import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { isMissingSchemaError } from "@/lib/one-number/config.server";
import type { HouseHints, OnboardingRole } from "@/lib/one-number/onboarding/role-detect";

/**
 * What an unknown number has told us about itself (`sms_onboarding_state`): its role, whether we
 * already asked, and the house details a landlord volunteered. Every read treats a missing table as
 * "nothing there" so code can ship before the migration.
 */
export type OnboardingState = {
  phoneKey: string;
  role: OnboardingRole | null;
  askedAt: string | null;
  hints: HouseHints;
};

type Row = Record<string, unknown>;

function toState(row: Row): OnboardingState {
  const hintsRaw = row.hints && typeof row.hints === "object" && !Array.isArray(row.hints) ? (row.hints as Row) : {};
  const hints: HouseHints = {};
  if (typeof hintsRaw.address === "string" && hintsRaw.address) hints.address = hintsRaw.address;
  if (typeof hintsRaw.rooms === "number") hints.rooms = hintsRaw.rooms;
  if (typeof hintsRaw.rent === "number") hints.rent = hintsRaw.rent;
  const role = row.role === "searcher" || row.role === "landlord" || row.role === "vendor" ? row.role : null;
  return { phoneKey: String(row.phone_key ?? ""), role, askedAt: row.asked_at ? String(row.asked_at) : null, hints };
}

export async function loadOnboardingState(db: SupabaseClient, phoneKey: string): Promise<OnboardingState | null> {
  const { data, error } = await db.from("sms_onboarding_state").select("phone_key, role, asked_at, hints").eq("phone_key", phoneKey).maybeSingle();
  if (error || !data) return null;
  return toState(data as Row);
}

/** Merge a patch into the phone's row, creating it. Returns false when nothing could be stored. */
export async function saveOnboardingState(
  db: SupabaseClient,
  phoneKey: string,
  patch: { role?: OnboardingRole | null; askedAt?: string | null; hints?: HouseHints },
  now: Date = new Date(),
): Promise<boolean> {
  const current = await loadOnboardingState(db, phoneKey);
  const row = {
    phone_key: phoneKey,
    role: patch.role !== undefined ? patch.role : (current?.role ?? null),
    asked_at: patch.askedAt !== undefined ? patch.askedAt : (current?.askedAt ?? null),
    hints: { ...(current?.hints ?? {}), ...(patch.hints ?? {}) },
    updated_at: now.toISOString(),
  };
  const { error } = await db.from("sms_onboarding_state").upsert(row, { onConflict: "phone_key" });
  if (error && !isMissingSchemaError(error)) console.error("onboarding state write failed", error.code ?? "unknown");
  return !error;
}
