import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { normalizeE164 } from "@/lib/twilio";
import { resolveOwnVendorRecords } from "@/lib/vendor-own-record";

export type VendorBusinessProfile = {
  businessName: string;
  contactName: string;
  workEmail: string;
  workPhone: string;
  serviceArea: string;
  notifyNewOffers: boolean;
  notifyScheduleChanges: boolean;
  notifyPayments: boolean;
};

export type VendorWorkspaceAccess = {
  managerUserId: string;
  managerName: string;
  managerEmail: string;
  directoryId: string;
  propertyIds: string[];
  active: boolean;
};

const EMPTY: VendorBusinessProfile = {
  businessName: "",
  contactName: "",
  workEmail: "",
  workPhone: "",
  serviceArea: "",
  notifyNewOffers: true,
  notifyScheduleChanges: true,
  notifyPayments: true,
};

type Row = {
  business_name: string | null;
  contact_name: string | null;
  work_email: string | null;
  work_phone: string | null;
  service_area: string | null;
  notify_new_offers: boolean | null;
  notify_schedule_changes: boolean | null;
  notify_payments: boolean | null;
};

function fromRow(row: Row | null): VendorBusinessProfile {
  if (!row) return EMPTY;
  return {
    businessName: row.business_name ?? "",
    contactName: row.contact_name ?? "",
    workEmail: row.work_email ?? "",
    workPhone: row.work_phone ?? "",
    serviceArea: row.service_area ?? "",
    notifyNewOffers: row.notify_new_offers ?? true,
    notifyScheduleChanges: row.notify_schedule_changes ?? true,
    notifyPayments: row.notify_payments ?? true,
  };
}

/** The vendor's own business record; an unsaved vendor reads back the empty shape. */
export async function loadVendorBusinessProfile(db: SupabaseClient, userId: string): Promise<VendorBusinessProfile> {
  const { data, error } = await db
    .from("vendor_business_profiles")
    .select("business_name, contact_name, work_email, work_phone, service_area, notify_new_offers, notify_schedule_changes, notify_payments")
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return fromRow((data as Row | null) ?? null);
}

export type SaveVendorBusinessProfileResult =
  | { ok: true; profile: VendorBusinessProfile }
  | { ok: false; status: 400 | 500; error: string };

/**
 * Save the vendor's own record, then mirror the fields managers already see
 * (business name, work phone, work email) into every linked directory row so
 * the manager's view never lags the vendor's.
 */
export async function saveVendorBusinessProfile(
  db: SupabaseClient,
  userId: string,
  patch: Partial<VendorBusinessProfile>,
): Promise<SaveVendorBusinessProfileResult> {
  const current = await loadVendorBusinessProfile(db, userId);
  const next: VendorBusinessProfile = { ...current };
  if (patch.businessName !== undefined) next.businessName = patch.businessName.trim().slice(0, 120);
  if (patch.contactName !== undefined) next.contactName = patch.contactName.trim().slice(0, 120);
  if (patch.serviceArea !== undefined) next.serviceArea = patch.serviceArea.trim().slice(0, 200);
  if (patch.workEmail !== undefined) {
    const email = patch.workEmail.trim().toLowerCase();
    if (email && !/^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)+$/.test(email)) {
      return { ok: false, status: 400, error: "That work email doesn't look valid." };
    }
    next.workEmail = email;
  }
  if (patch.workPhone !== undefined) {
    const raw = patch.workPhone.trim();
    const normalized = raw ? normalizeE164(raw) : "";
    if (raw && !normalized) {
      return { ok: false, status: 400, error: "That work number doesn't look valid. Include your area code." };
    }
    next.workPhone = normalized ?? "";
  }
  for (const key of ["notifyNewOffers", "notifyScheduleChanges", "notifyPayments"] as const) {
    if (typeof patch[key] === "boolean") next[key] = patch[key] as boolean;
  }

  const nowIso = new Date().toISOString();
  const { error } = await db.from("vendor_business_profiles").upsert(
    {
      user_id: userId,
      business_name: next.businessName,
      contact_name: next.contactName,
      work_email: next.workEmail,
      work_phone: next.workPhone,
      service_area: next.serviceArea,
      notify_new_offers: next.notifyNewOffers,
      notify_schedule_changes: next.notifyScheduleChanges,
      notify_payments: next.notifyPayments,
      updated_at: nowIso,
    },
    { onConflict: "user_id" },
  );
  if (error) return { ok: false, status: 500, error: error.message };

  // Mirror into the directory rows managers read. Only the fields a manager
  // sees as "the vendor's business" — never the vendor's private preferences.
  const mirrored = patch.businessName !== undefined || patch.workEmail !== undefined || patch.workPhone !== undefined;
  if (mirrored) {
    const records = await resolveOwnVendorRecords(db, userId);
    for (const record of records) {
      const rowData = {
        ...record.row,
        ...(next.businessName ? { name: next.businessName } : {}),
        ...(next.workEmail ? { email: next.workEmail } : {}),
        ...(next.workPhone ? { phone: next.workPhone } : {}),
        updatedAt: nowIso,
      };
      await db.from("manager_vendor_records").update({ row_data: rowData, updated_at: nowIso }).eq("id", record.id);
    }
  }

  return { ok: true, profile: next };
}

/** Every manager workspace this vendor is linked into, and the houses each one assigned. */
export async function loadVendorWorkspaceAccess(db: SupabaseClient, userId: string): Promise<VendorWorkspaceAccess[]> {
  const records = await resolveOwnVendorRecords(db, userId);
  if (records.length === 0) return [];
  const managerIds = [...new Set(records.map((r) => r.managerUserId))];
  const { data: profiles } = await db.from("profiles").select("id, full_name, email").in("id", managerIds);
  const byId = new Map((profiles ?? []).map((p) => [p.id as string, p]));
  return records.map((record) => {
    const profile = byId.get(record.managerUserId);
    return {
      managerUserId: record.managerUserId,
      managerName: String(profile?.full_name ?? "").trim() || String(profile?.email ?? "").trim() || "Property manager",
      managerEmail: String(profile?.email ?? "").trim(),
      directoryId: record.id,
      propertyIds: Array.isArray(record.row.propertyIds) ? record.row.propertyIds.filter((id): id is string => typeof id === "string") : [],
      active: record.row.active !== false,
    };
  });
}
