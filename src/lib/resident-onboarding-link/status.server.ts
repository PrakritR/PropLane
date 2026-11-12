import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { managerHasCoManagerPermissionForProperty } from "@/lib/auth/manager-lease-scope";
import { proplaneIdLookupVariants } from "@/lib/manager-id";
import { ONBOARDING_TARGET_TYPE, onboardingTargetId } from "./model";
import { deriveOnboardingProgress, type OnboardingProgress } from "./status";

type Row = Record<string, unknown>;
const str = (v: unknown): string => (typeof v === "string" ? v.trim() : v == null ? "" : String(v).trim());
const rec = (v: unknown): Row => (v && typeof v === "object" && !Array.isArray(v) ? (v as Row) : {});

export type OnboardingStatusResult =
  | { ok: true; applicationId: string; name: string; progress: OnboardingProgress; hasPhone: boolean; hasEmail: boolean }
  | { ok: false; reason: "not_found" | "unreadable" };

/**
 * The onboarding progress of ONE manager-added resident, for the manager who owns the record (or holds Residents
 * on its house). The record is re-read here; a request names only its id, and a miss is "not found", never a reason
 * to read anything else.
 */
export async function loadOnboardingStatus(db: SupabaseClient, input: { userId: string; applicationId: string }): Promise<OnboardingStatusResult> {
  const { data, error } = await db
    .from("manager_application_records")
    .select("id, resident_email, manager_user_id, row_data")
    .in("id", proplaneIdLookupVariants(input.applicationId))
    .limit(1)
    .maybeSingle();
  if (error) return { ok: false, reason: "unreadable" };
  if (!data) return { ok: false, reason: "not_found" };
  const record = data as Row;
  const row = rec(record.row_data);
  const application = rec(row.application);
  const details = rec(row.manualResidentDetails);
  const propertyId = str(row.assignedPropertyId) || str(row.propertyId) || str(application.propertyId);
  const ownerId = str(record.manager_user_id);
  const allowed =
    ownerId === input.userId ||
    (Boolean(propertyId) && (await managerHasCoManagerPermissionForProperty(db, input.userId, propertyId, "residents", "read").catch(() => false)));
  if (!allowed) return { ok: false, reason: "not_found" };

  const id = str(record.id);
  const email = (str(record.resident_email) || str(row.email)).toLowerCase();
  const axis = id.replace(/^(AXIS|PROPLANE)-/i, "");
  const [linkRes, leaseRes, chargeRes] = await Promise.all([
    db
      .from("phone_bound_links")
      .select("created_at, open_count, used_at")
      .eq("target_type", ONBOARDING_TARGET_TYPE)
      .eq("target_id", onboardingTargetId("application", id))
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
    db.from("portal_lease_pipeline_records").select("status, row_data").eq("id", `lease_app_${id}`).maybeSingle(),
    email
      ? db.from("portal_household_charge_records").select("status, row_data").eq("manager_user_id", ownerId).ilike("resident_email", email).eq("status", "paid")
      : Promise.resolve({ data: [], error: null }),
  ]);
  void axis;
  if (linkRes.error || leaseRes.error || chargeRes.error) return { ok: false, reason: "unreadable" };

  const link = linkRes.data as Row | null;
  const lease = rec((leaseRes.data as Row | null)?.row_data);
  const leaseSignedAt = str(lease.fullySignedAt) || (str(lease.residentSignedAt) && str(lease.managerSignedAt) ? str(lease.residentSignedAt) : "") || (str(lease.bucket) === "signed" ? str(lease.updatedAtIso) : "");
  // The resident's OWN payment: a checkout they completed. A month the manager marked paid while adding them is history.
  const residentPaidAts = ((chargeRes.data ?? []) as Row[])
    .map((c) => rec(c.row_data))
    .filter((c) => str(c.stripeCheckoutSessionId))
    .map((c) => str(c.paidAt) || null);

  return {
    ok: true,
    applicationId: id,
    name: str(row.name) || str(application.fullLegalName),
    hasPhone: Boolean(str(details.phone) || str(application.phone)),
    hasEmail: Boolean(email),
    progress: deriveOnboardingProgress({
      emailSentAt: str(details.onboardingWelcomeSentAt) || null,
      textLink: link ? { createdAt: str(link.created_at), openCount: Number(link.open_count) || 0, usedAt: str(link.used_at) || null } : null,
      residentUserId: str(row.residentUserId) || null,
      leaseSignedAt: leaseSignedAt || null,
      residentPaidAts,
    }),
  };
}
