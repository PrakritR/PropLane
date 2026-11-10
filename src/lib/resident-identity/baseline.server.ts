import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { personaEnabled } from "@/lib/resident-identity/persona.server";

export type BaselineIdentityDecision = "disabled" | "verified" | "required" | "unavailable";

/** userId must come from a verified authenticated principal, not request data. */
export async function resolveBaselineResidentIdentity(db: SupabaseClient, userId: string | null): Promise<BaselineIdentityDecision> {
  if (process.env.RESIDENT_IDENTITY_ENABLED !== "true") return "disabled";
  if (!userId) return personaEnabled() ? "required" : "unavailable";
  try {
    const { data, error } = await db.from("resident_identity_subjects").select("status, provider_decision, verified_at").eq("resident_user_id", userId).maybeSingle();
    if (error) return "unavailable";
    if (data?.status === "approved" && data.provider_decision === "approved" && data.verified_at && Number.isFinite(Date.parse(data.verified_at)) && Date.parse(data.verified_at) <= Date.now()) return "verified";
    return personaEnabled() ? "required" : "unavailable";
  } catch { return "unavailable"; }
}
