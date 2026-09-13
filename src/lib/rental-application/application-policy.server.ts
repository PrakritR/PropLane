import type { SupabaseClient } from "@supabase/supabase-js";
import type { DemoApplicantRow } from "@/data/demo-portal";
import {
  type ApplicationFeeChargePolicy,
  loadManagerApplicationSettings,
} from "@/lib/manager-application-settings";
import { isDraftShapedApplicationRow } from "@/lib/rental-application/draft-shape";
import { isWithdrawnApplicationRow } from "@/lib/rental-application/resident-application-list";

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function rowIsSubmittedApplication(row: DemoApplicantRow): boolean {
  if (isWithdrawnApplicationRow(row)) return false;
  if (isDraftShapedApplicationRow(row)) return false;
  return true;
}

export async function residentHasPriorApplicationServer(
  db: SupabaseClient,
  email: string,
  managerUserId: string,
): Promise<boolean> {
  const e = normalizeEmail(email);
  const managerId = managerUserId.trim();
  if (!e || !managerId) return false;
  const { data, error } = await db
    .from("manager_application_records")
    .select("row_data, manager_user_id")
    .eq("resident_email", e)
    .eq("manager_user_id", managerId)
    .order("updated_at", { ascending: false })
    .limit(25);
  if (error) throw error;
  return (data ?? []).some((row) => rowIsSubmittedApplication((row.row_data ?? {}) as DemoApplicantRow));
}

export async function residentHasPaidApplicationFeeServer(
  db: SupabaseClient,
  email: string,
  managerUserId: string,
  residentUserId?: string | null,
): Promise<boolean> {
  const e = normalizeEmail(email);
  const managerId = managerUserId.trim();
  if (!e || !managerId) return false;
  let query = db
    .from("portal_household_charge_records")
    .select("row_data, manager_user_id")
    .eq("resident_email", e)
    .eq("manager_user_id", managerId);
  if (residentUserId?.trim()) {
    query = query.or(`resident_user_id.eq.${residentUserId.trim()},resident_user_id.is.null`);
  }
  const { data, error } = await query.limit(100);
  if (error) throw error;
  return (data ?? []).some((row) => {
    const charge = (row.row_data ?? {}) as { kind?: string; status?: string };
    return charge.kind === "application_fee" && charge.status === "paid";
  });
}

export async function shouldWaiveApplicationFeeForResidentServer(
  db: SupabaseClient,
  input: {
    managerUserId: string;
    residentEmail: string;
    residentUserId?: string | null;
    chargePolicy?: ApplicationFeeChargePolicy;
  },
): Promise<boolean> {
  const managerUserId = input.managerUserId.trim();
  const email = normalizeEmail(input.residentEmail);
  if (!managerUserId || !email) return false;

  const settings = await loadManagerApplicationSettings(db, managerUserId);
  const policy = input.chargePolicy ?? settings.applicationFeeChargePolicy;
  if (policy === "every_time") return false;

  const [priorApp, paidFee] = await Promise.all([
    residentHasPriorApplicationServer(db, email, managerUserId),
    residentHasPaidApplicationFeeServer(db, email, managerUserId, input.residentUserId),
  ]);
  return priorApp || paidFee;
}
