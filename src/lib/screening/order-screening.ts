import { openApplicantRow, sealApplicantRow } from "@/lib/security/applicant-identity";
import type { DemoApplicantRow } from "@/data/demo-portal";
import { screeningCostCents, screeningConfigured } from "@/lib/screening/config";
import { chargeManagerForScreening } from "@/lib/screening/charge-manager";
import { backgroundCheckStatusFromScreening } from "@/lib/screening/map-background-status";
import { managerScreeningAllowedForTier } from "@/lib/manager-access";
import { getManagerSubscriptionTier } from "@/lib/manager-access-server";
import { getScreeningProvider } from "@/lib/screening/providers";
import { buildScreeningRecommendation } from "@/lib/screening/recommendation";
import { getManagerScreeningSettings } from "@/lib/screening/settings";
import type { ApplicationScreeningReport, ScreeningProviderReport } from "@/lib/screening/types";
import type { SupabaseClient } from "@supabase/supabase-js";

export type OrderScreeningResult =
  | { ok: true; row: DemoApplicantRow; screening: ApplicationScreeningReport }
  | { ok: false; status: number; error: string; code?: string };

function monthlyRentCentsFromRow(row: DemoApplicantRow): number | null {
  if (typeof row.signedMonthlyRent === "number" && row.signedMonthlyRent > 0) {
    return Math.round(row.signedMonthlyRent * 100);
  }
  const override = row.application?.managerRentOverride?.trim().replace(/[$,]/g, "") ?? "";
  const parsed = Number(override);
  if (Number.isFinite(parsed) && parsed > 0) return Math.round(parsed * 100);
  return null;
}

function mergeVendorIntoScreening(
  existing: ApplicationScreeningReport | undefined,
  vendor: ScreeningProviderReport,
  row: DemoApplicantRow,
  costCents: number,
): ApplicationScreeningReport {
  const recommendation = buildScreeningRecommendation({
    vendor,
    application: row.application ?? null,
    monthlyRentCents: monthlyRentCentsFromRow(row),
  });

  return {
    provider: existing?.provider ?? "certn",
    externalOrderId: vendor.externalOrderId,
    status: vendor.status,
    orderedAt: existing?.orderedAt ?? new Date().toISOString(),
    completedAt: vendor.status === "complete" ? new Date().toISOString() : existing?.completedAt,
    costCents: existing?.costCents ?? costCents,
    creditScore: vendor.creditScore ?? existing?.creditScore ?? null,
    creditRating: recommendation.creditRating,
    criminalFlags: vendor.criminalFlags ?? existing?.criminalFlags ?? 0,
    evictionFlags: vendor.evictionFlags ?? existing?.evictionFlags ?? 0,
    incomeVerified: vendor.incomeVerified ?? existing?.incomeVerified ?? false,
    recommendation: recommendation.recommendation,
    pros: recommendation.pros,
    cons: recommendation.cons,
    summary: recommendation.summary,
    reportUrl: vendor.reportUrl ?? existing?.reportUrl,
    adverseActionRequired: recommendation.adverseActionRequired,
    stripePaymentIntentId: existing?.stripePaymentIntentId,
  };
}

async function loadApplicationRow(db: SupabaseClient, applicationId: string, expectedManagerId?: string): Promise<DemoApplicantRow | null> {
  const { data, error } = await db
    .from("manager_application_records")
    .select("id, manager_user_id, row_data")
    .eq("id", applicationId)
    .maybeSingle();
  if (error || !data?.row_data) return null;
  const raw = data.row_data as DemoApplicantRow;
  const owner = String(data.manager_user_id ?? "").trim();
  if (expectedManagerId && owner !== expectedManagerId) throw new Error("Application access denied.");
  const row = expectedManagerId ? openApplicantRow(raw, String(data.id ?? applicationId)) : raw;
  return { ...row, id: String(data.id ?? applicationId), managerUserId: owner };
}

async function persistApplicationRow(db: SupabaseClient, row: DemoApplicantRow): Promise<void> {
  const { error } = await db.from("manager_application_records").upsert(
    {
      id: row.id,
      manager_user_id: row.managerUserId || null,
      resident_email: row.email?.trim().toLowerCase() || null,
      property_id: row.propertyId || row.application?.propertyId || null,
      assigned_property_id: row.assignedPropertyId || null,
      row_data: sealApplicantRow(row, row.id, row.managerUserId),
      updated_at: new Date().toISOString(),
    },
    { onConflict: "id" },
  );
  if (error) throw new Error(error.message);
}

async function upsertScreeningOrderRecord(
  db: SupabaseClient,
  row: DemoApplicantRow,
  screening: ApplicationScreeningReport,
): Promise<void> {
  const { error } = await db.from("screening_orders").upsert(
    {
      application_id: row.id,
      manager_user_id: row.managerUserId || null,
      provider: screening.provider,
      external_order_id: screening.externalOrderId,
      status: screening.status,
      row_data: screening,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "provider,external_order_id" },
  );
  if (error) throw new Error(error.message);
}

export async function applyScreeningReportToApplication(
  db: SupabaseClient,
  applicationId: string,
  vendor: ScreeningProviderReport,
): Promise<DemoApplicantRow | null> {
  const row = await loadApplicationRow(db, applicationId);
  if (!row) return null;
  const screening = mergeVendorIntoScreening(row.screening, vendor, row, row.screening?.costCents ?? screeningCostCents());
  const nextRow: DemoApplicantRow = {
    ...row,
    screening,
    backgroundCheckStatus: backgroundCheckStatusFromScreening(screening),
  };
  await persistApplicationRow(db, nextRow);
  await upsertScreeningOrderRecord(db, nextRow, screening);
  return nextRow;
}

export async function orderScreeningForApplication(opts: {
  db: SupabaseClient;
  applicationId: string;
  managerUserId: string;
  skipBilling?: boolean;
}): Promise<OrderScreeningResult> {
  if (!screeningConfigured()) {
    return { ok: false, status: 503, error: "Screening is not configured. Add CERTN_API_KEY.", code: "not_configured" };
  }

  const tier = await getManagerSubscriptionTier(opts.managerUserId);
  if (!managerScreeningAllowedForTier(tier)) {
    return {
      ok: false,
      status: 403,
      error: "Applicant screening requires Pro or Business. Upgrade your plan to run screenings.",
      code: "upgrade_required",
    };
  }

  const settings = await getManagerScreeningSettings(opts.db, opts.managerUserId);
  if (settings.mode === "off") {
    return { ok: false, status: 400, error: "Screening is turned off in Applications settings.", code: "disabled" };
  }

  const row = await loadApplicationRow(opts.db, opts.applicationId, opts.managerUserId);
  if (!row) return { ok: false, status: 404, error: "Application not found." };
  if (!row.application) return { ok: false, status: 400, error: "This record has no rental application to screen." };
  if (!row.application.consentCredit) {
    return { ok: false, status: 400, error: "Applicant did not authorize credit/background screening." };
  }
  if (row.screening?.status === "in_progress" || row.screening?.status === "queued") {
    return { ok: false, status: 409, error: "Screening is already in progress for this applicant." };
  }

  const costCents = screeningCostCents();
  let paymentIntentId: string | undefined;
  if (!opts.skipBilling) {
    const charge = await chargeManagerForScreening({
      managerUserId: opts.managerUserId,
      applicationId: row.id,
      amountCents: costCents,
    });
    if (!charge.ok) {
      return { ok: false, status: 402, error: charge.message, code: charge.code };
    }
    paymentIntentId = charge.paymentIntentId;
  }

  const provider = getScreeningProvider();
  let order;
  try {
    order = await provider.createOrder({
      applicationId: row.id,
      managerUserId: opts.managerUserId,
      application: row.application,
      monthlyRentCents: monthlyRentCentsFromRow(row),
    });
  } catch (e) {
    return {
      ok: false,
      status: 502,
      error: e instanceof Error ? e.message : "Screening provider order failed.",
      code: "provider_error",
    };
  }

  const screening: ApplicationScreeningReport = {
    provider: provider.id,
    externalOrderId: order.externalOrderId,
    status: order.status,
    orderedAt: new Date().toISOString(),
    costCents,
    recommendation: "not_available",
    pros: [],
    cons: [],
    summary: "Screening ordered — results will appear when the vendor report completes.",
    reportUrl: order.reportUrl,
    stripePaymentIntentId: paymentIntentId,
  };

  const nextRow: DemoApplicantRow = {
    ...row,
    screening,
    backgroundCheckStatus: backgroundCheckStatusFromScreening(screening),
  };
  await persistApplicationRow(opts.db, nextRow);
  await upsertScreeningOrderRecord(opts.db, nextRow, screening);

  if (order.status === "complete") {
    const vendor = await provider.fetchReport(order.externalOrderId);
    if (vendor) {
      const completed = await applyScreeningReportToApplication(opts.db, row.id, vendor);
      if (completed) {
        return { ok: true, row: openApplicantRow(completed, row.id), screening: completed.screening! };
      }
    }
  }

  return { ok: true, row: nextRow, screening };
}

export async function tryAutoOrderScreening(db: SupabaseClient, row: DemoApplicantRow): Promise<void> {
  if (row.bucket !== "pending" || !row.application?.consentCredit) return;
  if (row.screening?.status && row.screening.status !== "failed") return;
  const managerUserId = row.managerUserId?.trim();
  if (!managerUserId) return;
  const settings = await getManagerScreeningSettings(db, managerUserId);
  if (settings.mode !== "auto_on_submit") return;
  await orderScreeningForApplication({ db, applicationId: row.id, managerUserId }).catch((error) => {
    console.error("Auto screening order failed:", {
      applicationId: row.id,
      error: error instanceof Error ? error.message : error,
    });
  });
}

export async function findApplicationIdByExternalOrder(
  db: SupabaseClient,
  provider: string,
  externalOrderId: string,
): Promise<string | null> {
  const { data } = await db
    .from("screening_orders")
    .select("application_id")
    .eq("provider", provider)
    .eq("external_order_id", externalOrderId)
    .maybeSingle();
  if (data?.application_id) return data.application_id;

  const { data: records } = await db
    .from("manager_application_records")
    .select("id, row_data")
    .limit(500);
  for (const record of records ?? []) {
    const row = record.row_data as DemoApplicantRow | null;
    if (!row) continue;
    if (row.screening?.externalOrderId === externalOrderId) return row.id;
    if (row.id === externalOrderId) return row.id;
  }
  return null;
}

export async function findApplicationIdFromCertnPayload(
  db: SupabaseClient,
  payload: Record<string, unknown>,
): Promise<string | null> {
  const externalOrderId = typeof payload.id === "string" ? payload.id : null;
  if (externalOrderId) {
    const fromOrder = await findApplicationIdByExternalOrder(db, "certn", externalOrderId);
    if (fromOrder) return fromOrder;
  }
  const tag = typeof payload.tag === "string" ? payload.tag.trim() : "";
  if (tag) {
    const row = await loadApplicationRow(db, tag);
    if (row) return row.id;
  }
  return null;
}
