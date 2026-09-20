import { NextResponse } from "next/server";

import {
  loadManagerManualPaymentSettings,
  managerManualPaymentSettingsPublic,
  normalizeManagerManualPaymentSettings,
  resolveSavedServiceFeeSelection,
  saveManagerManualPaymentSettings,
} from "@/lib/manager-manual-payment-settings";
import {
  applyPropertyServiceFeePayersToListings,
  loadPropertyServiceFeePayers,
} from "@/lib/manager-manual-payment-settings.server";
import { getManagerPurchaseSku } from "@/lib/manager-access-server";
import {
  LISTING_PROCESSING_FEE_WAIVER_CODE_INVALID,
  normalizeListingPaymentWaiverCode,
  type ServiceFeePayer,
} from "@/lib/payment-policy";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import {
  listingPaymentWaiverCodeMatchesServer,
  waiverGrantedFromPromoCodeServer,
} from "@/lib/payment-policy.server";
import {
  loadWorkspacePaymentSettings,
  loadWorkspaceServiceFeePayerForProperty,
  saveWorkspacePaymentSettings,
} from "@/lib/workspace-payment-settings.server";
import { assertManualPaymentSettingsCoManagerAccess } from "@/lib/auth/manager-settings-module-access.server";
import {
  assertSettingsScopeOwned,
  resolveSettingsScopeParams,
  trackSettingsScopeChanged,
} from "@/lib/scope/settings-scope";

const ANALYTICS_MODULE = "manual_payments";

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
 * What the browser gets to see of each workspace's payment setup: the choice,
 * never the code it was applied with. The modal only needs to show which
 * answer is in force, and a code the manager typed once does not need to come
 * back down in every read.
 */
async function workspacePaymentSettingsPublic(
  db: ReturnType<typeof createSupabaseServiceRoleClient>,
  userId: string,
): Promise<Record<string, { serviceFeePayer: ServiceFeePayer | null }>> {
  const all = await loadWorkspacePaymentSettings(db, userId);
  return Object.fromEntries(
    Object.entries(all).map(([id, value]) => [id, { serviceFeePayer: value.serviceFeePayer }]),
  );
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
  return waiverGrantedFromPromoCodeServer(purchase.promoCode);
}

export async function GET(req: Request) {
  try {
    const ctx = await requireManager();
    if (!ctx) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    const access = await assertManualPaymentSettingsCoManagerAccess(ctx.db, ctx.userId, "read");
    if (!access.ok) return NextResponse.json({ error: access.error }, { status: access.status });
    // `?propertyId=`/`?workspaceId=` (singular) narrow which rung's answer the
    // `source` field describes — the fee-payer resolution itself already ran
    // property → workspace → account for years, via `loadPropertyServiceFeePayers`
    // / `loadWorkspaceServiceFeePayerForProperty` (this route's own resolver,
    // predating and separate from `scope-resolver.server.ts`'s generic one).
    const scope = resolveSettingsScopeParams(req.url);
    const scopeAccess = await assertSettingsScopeOwned(ctx.db, ctx.userId, scope);
    if (!scopeAccess.ok) return NextResponse.json({ error: scopeAccess.error }, { status: scopeAccess.status });
    const { propertyId, workspaceId } = scopeAccess;
    const settings = await loadManagerManualPaymentSettings(ctx.db, ctx.userId);
    const propertyIds = new Set(parsePropertyIdsQuery(req));
    if (propertyId) propertyIds.add(propertyId);
    const propertyServiceFeePayers =
      propertyIds.size > 0
        ? await loadPropertyServiceFeePayers(ctx.db, ctx.userId, [...propertyIds])
        : undefined;
    let source: "property" | "workspace" | "account" | undefined;
    if (propertyId) {
      source = propertyServiceFeePayers?.[propertyId] != null ? "property" : "workspace";
      if (source === "workspace" && (await loadWorkspaceServiceFeePayerForProperty(ctx.db, ctx.userId, propertyId)) == null) {
        source = "account";
      }
    } else if (workspaceId) {
      const workspaceSettings = await loadWorkspacePaymentSettings(ctx.db, ctx.userId);
      source = workspaceSettings[workspaceId]?.serviceFeePayer != null ? "workspace" : "account";
    }
    return NextResponse.json({
      settings: managerManualPaymentSettingsPublic(settings),
      /* Payment setup is answered per workspace; the modal reads this to show
         which workspace it is editing and what that workspace currently says. */
      workspacePaymentSettings: await workspacePaymentSettingsPublic(ctx.db, ctx.userId),
      ...(propertyServiceFeePayers ? { propertyServiceFeePayers } : {}),
      ...(source ? { source } : {}),
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
    const access = await assertManualPaymentSettingsCoManagerAccess(ctx.db, ctx.userId, "edit");
    if (!access.ok) return NextResponse.json({ error: access.error }, { status: access.status });
    const body = (await req.json()) as Record<string, unknown>;
    const {
      propertyServiceFeePayers,
      workspaceId,
      workspaceServiceFeePayer,
      workspaceServiceFeeWaiverCode,
      ...rest
    } = body;
    const feePayerUpdates = parsePropertyServiceFeePayerUpdates(propertyServiceFeePayers);
    const hasSettingsPatch = Object.keys(rest).length > 0;
    let settings = await loadManagerManualPaymentSettings(ctx.db, ctx.userId);
    if (hasSettingsPatch) {
      const normalized = normalizeManagerManualPaymentSettings({ ...settings, ...rest });
      // Only look the grant up when the answer can change the save: a `proplane`
      // selection needs one, and everything else is stored as typed.
      const grant = rest.serviceFeePayer === "proplane" ? await accountWaiverGranted(ctx.db, ctx.userId, settings) : false;
      /* The code is checked HERE, against the server-only list — the browser
         cannot see the codes and its claim is never taken as the answer. */
      const codeMatches = listingPaymentWaiverCodeMatchesServer(normalized.serviceFeeWaiverCode);
      if (
        rest.serviceFeePayer === "proplane" &&
        resolveSavedServiceFeeSelection(normalized, settings, grant, codeMatches).serviceFeePayer !== "proplane"
      ) {
        return NextResponse.json({ error: LISTING_PROCESSING_FEE_WAIVER_CODE_INVALID }, { status: 400 });
      }
      settings = await saveManagerManualPaymentSettings(ctx.db, ctx.userId, normalized, {
        accountWaiverGranted: grant,
        codeMatches,
      });
    }
    /*
     * A workspace-scoped save. The id is re-checked against the signed-in
     * owner inside `saveWorkspacePaymentSettings`, so an id from the body can
     * never reach another account's workspace — ids in a request are not
     * authorization, as everywhere else in this route.
     */
    let workspaceSaved = false;
    if (typeof workspaceId === "string" && workspaceId.trim()) {
      const scopeAccess = await assertSettingsScopeOwned(ctx.db, ctx.userId, { workspaceId: workspaceId.trim() });
      if (!scopeAccess.ok) return NextResponse.json({ error: scopeAccess.error }, { status: scopeAccess.status });
      const choice =
        workspaceServiceFeePayer === "resident" ||
        workspaceServiceFeePayer === "manager" ||
        workspaceServiceFeePayer === "proplane"
          ? (workspaceServiceFeePayer as ServiceFeePayer)
          : null;
      /*
       * PropLane pays is applied only by a code at the moment it is chosen
       * (captain, 2026-09-14). A standing grant on the account used to flip a
       * workspace on with nothing asked; now the code travels with this save
       * and is checked here, against the server-only list. Staff choosing to
       * absorb (`adminServiceFeeOverride`) is the one thing that still needs no
       * code — that is the whole point of that control.
       */
      const workspaceCode =
        typeof workspaceServiceFeeWaiverCode === "string"
          ? normalizeListingPaymentWaiverCode(workspaceServiceFeeWaiverCode)
          : "";
      const workspaceCodeMatches = choice === "proplane" && listingPaymentWaiverCodeMatchesServer(workspaceCode);
      if (choice === "proplane" && !workspaceCodeMatches && settings.adminServiceFeeOverride !== "proplane") {
        return NextResponse.json({ error: LISTING_PROCESSING_FEE_WAIVER_CODE_INVALID }, { status: 400 });
      }
      /* The code is kept with the workspace so checkout can re-validate it —
         the same way a listing keeps its own. A `proplane` the staff override
         backs is stored codeless; the override answers first at checkout. */
      const result = await saveWorkspacePaymentSettings(ctx.db, ctx.userId, workspaceId.trim(), {
        serviceFeePayer: choice,
        ...(workspaceCodeMatches ? { serviceFeeWaiverCode: workspaceCode } : {}),
      });
      if (!result.saved) {
        return NextResponse.json({ error: "That workspace is not available." }, { status: 404 });
      }
      workspaceSaved = true;
      await trackSettingsScopeChanged(ctx.db, ctx.userId, {
        module: ANALYTICS_MODULE,
        rung: "workspace",
        ownerUserId: ctx.userId,
        workspaceId: workspaceId.trim(),
      });
    }

    if (feePayerUpdates.length > 0) {
      for (const update of feePayerUpdates) {
        const scopeAccess = await assertSettingsScopeOwned(ctx.db, ctx.userId, { propertyId: update.propertyId });
        if (!scopeAccess.ok) return NextResponse.json({ error: scopeAccess.error }, { status: scopeAccess.status });
      }
    }
    const feePayerPropagation =
      feePayerUpdates.length > 0
        ? await applyPropertyServiceFeePayersToListings(
            ctx.db,
            ctx.userId,
            feePayerUpdates,
            await accountWaiverGranted(ctx.db, ctx.userId),
          )
        : { listingsUpdated: 0 };
    if (feePayerUpdates.length > 0) {
      await trackSettingsScopeChanged(ctx.db, ctx.userId, {
        module: ANALYTICS_MODULE,
        rung: "property",
        ownerUserId: ctx.userId,
        workspaceId: null,
        count: feePayerUpdates.length,
      });
    }
    return NextResponse.json({
      settings: managerManualPaymentSettingsPublic(settings),
      ...(workspaceSaved
        ? { workspacePaymentSettings: await workspacePaymentSettingsPublic(ctx.db, ctx.userId) }
        : {}),
      listingsUpdated: feePayerPropagation.listingsUpdated,
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
