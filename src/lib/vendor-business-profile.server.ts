import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { normalizeE164 } from "@/lib/twilio";
import { resolveOwnVendorRecords } from "@/lib/vendor-own-record";
import { VENDOR_TRADE_OPTIONS } from "@/lib/work-order-taxonomy";

export type VendorBusinessProfile = {
  businessName: string;
  contactName: string;
  workEmail: string;
  workPhone: string;
  serviceArea: string;
  notifyNewOffers: boolean;
  notifyScheduleChanges: boolean;
  notifyPayments: boolean;
  /** Self-selected work capabilities, set at onboarding — independent of any manager-owned roster row. */
  trades: string[];
  serviceAreaZips: string[];
  serviceRadiusMiles: number | null;
  licenseNumber: string;
  /** Private storage path (vendor-documents bucket) — never returned to a manager, only the owning vendor. */
  licenseDocPath: string | null;
  insuranceProvider: string;
  insurancePolicyNumber: string;
  /** ISO date (yyyy-mm-dd) the vendor's insurance coverage expires. */
  insuranceExpiresAt: string | null;
  insuranceDocPath: string | null;
  /** When true (and onboarding is complete), this vendor is discoverable in the manager-facing directory. */
  directoryListed: boolean;
  onboardingCompletedAt: string | null;
};

/**
 * Whether a vendor's insurance is currently valid: an uploaded certificate,
 * and — when an expiry date is recorded — that date hasn't passed. Shared by
 * the manager-facing directory eligibility filter
 * (`vendor-directory.server.ts`'s "verified-only" directory, C083/C198) and
 * any other surface that needs the same "insured right now" bar.
 */
export function vendorInsuranceIsCurrent(
  profile: Pick<VendorBusinessProfile, "insuranceDocPath" | "insuranceExpiresAt">,
): boolean {
  if (!profile.insuranceDocPath) return false;
  if (!profile.insuranceExpiresAt) return true;
  return profile.insuranceExpiresAt >= new Date().toISOString().slice(0, 10);
}

/**
 * N007: whether this vendor's insurance is KNOWN to have lapsed — true only
 * when they recorded an expiry date and it has passed. A vendor who never
 * recorded insurance at all (most manually-added roster vendors, who have no
 * `vendor_business_profiles` row) is never blocked by this check — only a
 * vendor who once had a tracked expiry that is now in the past. This is
 * intentionally narrower than `vendorInsuranceIsCurrent` (which also requires
 * an uploaded certificate to count as "insured" for directory listing) so
 * that assigning/paying a vendor who simply never provided insurance data —
 * the common case for a manually-added vendor — is never blocked by this gate.
 */
export function vendorInsuranceHasExpired(
  profile: Pick<VendorBusinessProfile, "insuranceExpiresAt"> | null | undefined,
): boolean {
  const expiresAt = profile?.insuranceExpiresAt?.trim();
  if (!expiresAt) return false;
  return expiresAt < new Date().toISOString().slice(0, 10);
}

/** Loads just the vendor's insurance-expiry status by their auth user id — the shape `assignVendorTool` and `payoutVendorForWorkOrder` need for the N007 gate. */
export async function loadVendorInsuranceExpiryStatus(
  db: SupabaseClient,
  vendorUserId: string,
): Promise<{ expired: boolean; insuranceExpiresAt: string | null }> {
  const { data } = await db
    .from("vendor_business_profiles")
    .select("insurance_expires_at")
    .eq("user_id", vendorUserId)
    .maybeSingle();
  const insuranceExpiresAt = ((data as { insurance_expires_at: string | null } | null)?.insurance_expires_at ?? null);
  return { expired: vendorInsuranceHasExpired({ insuranceExpiresAt }), insuranceExpiresAt };
}

/** Minimum fields a self-serve vendor must fill before the onboarding checklist item counts as done. */
export function vendorOnboardingRequiredFieldsFilled(profile: Pick<VendorBusinessProfile, "businessName" | "trades" | "serviceArea" | "serviceAreaZips" | "serviceRadiusMiles">): boolean {
  const hasArea = profile.serviceArea.trim().length > 0 || profile.serviceAreaZips.length > 0 || profile.serviceRadiusMiles != null;
  return profile.businessName.trim().length > 0 && profile.trades.length > 0 && hasArea;
}

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
  trades: [],
  serviceAreaZips: [],
  serviceRadiusMiles: null,
  licenseNumber: "",
  licenseDocPath: null,
  insuranceProvider: "",
  insurancePolicyNumber: "",
  insuranceExpiresAt: null,
  insuranceDocPath: null,
  directoryListed: false,
  onboardingCompletedAt: null,
};

const PROFILE_COLUMNS =
  "business_name, contact_name, work_email, work_phone, service_area, notify_new_offers, notify_schedule_changes, notify_payments, trades, service_area_zips, service_radius_miles, license_number, license_doc_path, insurance_provider, insurance_policy_number, insurance_expires_at, insurance_doc_path, directory_listed, onboarding_completed_at";

type Row = {
  business_name: string | null;
  contact_name: string | null;
  work_email: string | null;
  work_phone: string | null;
  service_area: string | null;
  notify_new_offers: boolean | null;
  notify_schedule_changes: boolean | null;
  notify_payments: boolean | null;
  trades: string[] | null;
  service_area_zips: string[] | null;
  service_radius_miles: number | null;
  license_number: string | null;
  license_doc_path: string | null;
  insurance_provider: string | null;
  insurance_policy_number: string | null;
  insurance_expires_at: string | null;
  insurance_doc_path: string | null;
  directory_listed: boolean | null;
  onboarding_completed_at: string | null;
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
    trades: Array.isArray(row.trades) ? row.trades.filter((t): t is string => typeof t === "string") : [],
    serviceAreaZips: Array.isArray(row.service_area_zips) ? row.service_area_zips.filter((z): z is string => typeof z === "string") : [],
    serviceRadiusMiles: typeof row.service_radius_miles === "number" ? row.service_radius_miles : null,
    licenseNumber: row.license_number ?? "",
    licenseDocPath: row.license_doc_path ?? null,
    insuranceProvider: row.insurance_provider ?? "",
    insurancePolicyNumber: row.insurance_policy_number ?? "",
    insuranceExpiresAt: row.insurance_expires_at ?? null,
    insuranceDocPath: row.insurance_doc_path ?? null,
    directoryListed: row.directory_listed ?? false,
    onboardingCompletedAt: row.onboarding_completed_at ?? null,
  };
}

/** The vendor's own business record; an unsaved vendor reads back the empty shape. */
export async function loadVendorBusinessProfile(db: SupabaseClient, userId: string): Promise<VendorBusinessProfile> {
  const { data, error } = await db
    .from("vendor_business_profiles")
    .select(PROFILE_COLUMNS)
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
  for (const key of ["notifyNewOffers", "notifyScheduleChanges", "notifyPayments", "directoryListed"] as const) {
    if (typeof patch[key] === "boolean") next[key] = patch[key] as boolean;
  }
  if (patch.trades !== undefined) {
    const allowed = new Set<string>(VENDOR_TRADE_OPTIONS);
    next.trades = [...new Set(patch.trades.filter((t) => allowed.has(t)))];
  }
  if (patch.serviceAreaZips !== undefined) {
    next.serviceAreaZips = [...new Set(patch.serviceAreaZips.map((z) => z.trim()).filter((z) => /^\d{5}$/.test(z)))];
  }
  if (patch.serviceRadiusMiles !== undefined) {
    const n = patch.serviceRadiusMiles;
    if (n === null) next.serviceRadiusMiles = null;
    else if (Number.isFinite(n) && n > 0 && n <= 500) next.serviceRadiusMiles = Math.round(n);
    else return { ok: false, status: 400, error: "Service radius must be between 1 and 500 miles." };
  }
  if (patch.licenseNumber !== undefined) next.licenseNumber = patch.licenseNumber.trim().slice(0, 80);
  if (patch.insuranceProvider !== undefined) next.insuranceProvider = patch.insuranceProvider.trim().slice(0, 120);
  if (patch.insurancePolicyNumber !== undefined) next.insurancePolicyNumber = patch.insurancePolicyNumber.trim().slice(0, 80);
  if (patch.insuranceExpiresAt !== undefined) {
    const raw = patch.insuranceExpiresAt?.trim() ?? "";
    if (!raw) next.insuranceExpiresAt = null;
    else if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) next.insuranceExpiresAt = raw;
    else return { ok: false, status: 400, error: "Insurance expiration must be a valid date." };
  }

  // Server-derived, never client-trusted: once the checklist minimum is met it
  // stays met, even if the vendor later clears a field (PLAN-0925 onboarding).
  const onboardingCompletedAt =
    current.onboardingCompletedAt ?? (vendorOnboardingRequiredFieldsFilled(next) ? new Date().toISOString() : null);

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
      trades: next.trades,
      service_area_zips: next.serviceAreaZips,
      service_radius_miles: next.serviceRadiusMiles,
      license_number: next.licenseNumber,
      insurance_provider: next.insuranceProvider,
      insurance_policy_number: next.insurancePolicyNumber,
      insurance_expires_at: next.insuranceExpiresAt,
      directory_listed: next.directoryListed,
      onboarding_completed_at: onboardingCompletedAt,
      updated_at: nowIso,
    },
    { onConflict: "user_id" },
  );
  if (error) return { ok: false, status: 500, error: error.message };
  next.onboardingCompletedAt = onboardingCompletedAt;

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

/**
 * Record an onboarding document's private storage path on the vendor's own
 * profile — never gated on a manager link (unlike the existing manager-linked
 * `vendor_documents` upload, which requires `manager_vendor_records`).
 */
export async function attachVendorOnboardingDocument(
  db: SupabaseClient,
  userId: string,
  kind: "license" | "insurance",
  storagePath: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const column = kind === "license" ? "license_doc_path" : "insurance_doc_path";
  const { error } = await db
    .from("vendor_business_profiles")
    .upsert({ user_id: userId, [column]: storagePath, updated_at: new Date().toISOString() }, { onConflict: "user_id" });
  if (error) return { ok: false, error: error.message };
  return { ok: true };
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
