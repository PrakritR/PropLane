import { NextResponse } from "next/server";

import {
  loadManagerManualPaymentSettings,
  managerManualPaymentSettingsPublic,
  isValidZelleContact,
  normalizeManagerManualPaymentSettings,
  resolveSavedServiceFeeSelection,
  saveManagerManualPaymentSettings,
} from "@/lib/manager-manual-payment-settings";
import {
  applyManagerManualPaymentsToListings,
  applyPropertyServiceFeePayersToListings,
  loadPropertyServiceFeePayers,
} from "@/lib/manager-manual-payment-settings.server";
import { getManagerPurchaseSku } from "@/lib/manager-access-server";
import {
  LISTING_PROCESSING_FEE_WAIVER_CODE_INVALID,
  type ServiceFeePayer,
  waiverGrantedFromPromoCode,
} from "@/lib/payment-policy";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";

export const runtime = "nodejs";

async function requireManager() {
  const supabaseAuth = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabaseAuth.auth.getUser();
  if (!user?.id) return null;

  const db = createSupabaseServiceRoleClient();
  const [{ data: profile }, { data: roles }] = await Promise.all([
    db.from("profiles").select("role").eq("id", user.id).maybeSingle(),
    db.from("profile_roles").select("role").eq("user_id", user.id),
  ]);
  const roleList = (roles ?? []).map((r) => String(r.role).toLowerCase());
  const legacy = String(profile?.role ?? user.user_metadata?.role ?? "").toLowerCase();
  const isManager = roleList.includes("manager") || legacy === "manager" || legacy === "admin";
  if (!isManager) return null;
  return { db, userId: user.id };
}

function parsePropertyIdsQuery(req: Request): string[] {
  const raw = new URL(req.url).searchParams.get("propertyIds");
  if (!raw?.trim()) return [];
  return [...new Set(raw.split(",").map((id) => id.trim()).filter(Boolean))];
}

function parsePropertyServiceFeePayerUpdates(
  value: unknown,
): Array<{ propertyId: string; serviceFeePayer: ServiceFeePayer | null }> {
  if (!Array.isArray(value)) return [];
  const out: Array<{ propertyId: string; serviceFeePayer: ServiceFeePayer | null }> = [];
  for (const row of value) {
    if (!row || typeof row !== "object") continue;
    const propertyId = String((row as { propertyId?: unknown }).propertyId ?? "").trim();
    if (!propertyId) continue;
    const payer = (row as { serviceFeePayer?: unknown }).serviceFeePayer;
    if (payer === null || payer === undefined) {
      out.push({ propertyId, serviceFeePayer: null });
      continue;
    }
    if (payer === "resident" || payer === "manager" || payer === "proplane") {
      out.push({ propertyId, serviceFeePayer: payer });
    }
  }
  return out;
}

/**
 * Whether something already on the account lets PropLane cover the fee: staff approval,
 * or the account's own promo grant (`manager_purchases.promo_code`, written only by
 * server-side flows that validated it). A failed purchase read throws rather than
 * answering "no": that would silently move Stripe's cost onto a granted account's
 * residents while the route answered 200.
 */
async function accountWaiverGranted(
  db: ReturnType<typeof createSupabaseServiceRoleClient>,
  userId: string,
  settings?: Awaited<ReturnType<typeof loadManagerManualPaymentSettings>>,
) {
  const stored = settings ?? (await loadManagerManualPaymentSettings(db, userId));
  if (stored.adminServiceFeeOverride === "proplane") return true;
  const purchase = await getManagerPurchaseSku(userId);
  if (purchase.readFailed) {
    throw new Error("Could not read account promo status.");
  }
  return waiverGrantedFromPromoCode(purchase.promoCode);
}

export async function GET(req: Request) {
  try {
    const ctx = await requireManager();
    if (!ctx) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    const settings = await loadManagerManualPaymentSettings(ctx.db, ctx.userId);
    const propertyIds = parsePropertyIdsQuery(req);
    const propertyServiceFeePayers =
      propertyIds.length > 0
        ? await loadPropertyServiceFeePayers(ctx.db, ctx.userId, propertyIds)
        : undefined;
    return NextResponse.json({
      settings: managerManualPaymentSettingsPublic(settings),
      ...(propertyServiceFeePayers ? { propertyServiceFeePayers } : {}),
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function PATCH(req: Request) {
  try {
    const ctx = await requireManager();
    if (!ctx) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    const body = (await req.json()) as Record<string, unknown>;
    const { propertyIds, propertyServiceFeePayers, ...rest } = body;
    const feePayerUpdates = parsePropertyServiceFeePayerUpdates(propertyServiceFeePayers);
    const hasSettingsPatch = Object.keys(rest).length > 0;
    let settings = await loadManagerManualPaymentSettings(ctx.db, ctx.userId);
    if (hasSettingsPatch) {
      const normalized = normalizeManagerManualPaymentSettings({ ...settings, ...rest });
      if (normalized.zellePaymentsEnabled && !isValidZelleContact(normalized.zelleContact)) {
        return NextResponse.json({ error: "Enter a valid Zelle phone number or email address." }, { status: 400 });
      }
      // Only look the grant up when the answer can change the save: a `proplane`
      // selection needs one, and everything else is stored as typed.
      const grant = rest.serviceFeePayer === "proplane" ? await accountWaiverGranted(ctx.db, ctx.userId, settings) : false;
      if (
        rest.serviceFeePayer === "proplane" &&
        resolveSavedServiceFeeSelection(normalized, settings, grant).serviceFeePayer !== "proplane"
      ) {
        return NextResponse.json({ error: LISTING_PROCESSING_FEE_WAIVER_CODE_INVALID }, { status: 400 });
      }
      settings = await saveManagerManualPaymentSettings(ctx.db, ctx.userId, normalized, {
        accountWaiverGranted: grant,
      });
    }
    const requestedPropertyIds = Array.isArray(propertyIds)
      ? propertyIds.filter((id): id is string => typeof id === "string")
      : undefined;
    if (requestedPropertyIds?.length === 0) {
      return NextResponse.json({ error: "Select at least one property." }, { status: 400 });
    }
    const propagation = requestedPropertyIds
      ? await applyManagerManualPaymentsToListings(ctx.db, ctx.userId, settings, requestedPropertyIds)
      : { listingsUpdated: 0, chargesUpdated: 0 };
    const feePayerPropagation =
      feePayerUpdates.length > 0
        ? await applyPropertyServiceFeePayersToListings(
            ctx.db,
            ctx.userId,
            feePayerUpdates,
            await accountWaiverGranted(ctx.db, ctx.userId),
          )
        : { listingsUpdated: 0 };
    return NextResponse.json({
      settings: managerManualPaymentSettingsPublic(settings),
      listingsUpdated: propagation.listingsUpdated + feePayerPropagation.listingsUpdated,
      chargesUpdated: propagation.chargesUpdated,
      ...(feePayerUpdates.length > 0
        ? {
            propertyServiceFeePayers: await loadPropertyServiceFeePayers(
              ctx.db,
              ctx.userId,
              feePayerUpdates.map((row) => row.propertyId),
            ),
          }
        : {}),
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
